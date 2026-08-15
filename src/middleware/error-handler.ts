import type { NextFunction, Request, Response } from "express";

import { AppError, isAppError } from "../lib/errors.js";
import { failure } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";

const SAFE_BILLING_ERROR_CODES = new Set([
  "BILLING_CUSTOMER_UNLINKED",
  "BILLING_CUSTOMER_NOT_FOUND_OR_MODE_MISMATCH",
  "BILLING_PORTAL_NOT_CONFIGURED",
  "BILLING_PORTAL_UNAVAILABLE",
]);
const SAFE_AUTH_ERROR_CODES = new Set([
  "PROVIDER_GLOBAL_REVOCATION_PENDING",
  "MFA_STEP_UP_REQUIRED",
  "EMAIL_REAUTHENTICATION_REQUIRED",
]);

function safeRequestPath(req: Request): string {
  return req.path || req.originalUrl?.split("?")[0] || "";
}

function safePublicErrorMetadata(details: unknown): {
  code: string;
  recovery?: {
    eligible: boolean;
    endpoint: string;
    consumer: boolean;
    venues: Array<{ venueId: string; venueName: string }>;
  };
} | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = details as Record<string, unknown>;
  if (typeof value.publicCode === "string" && SAFE_AUTH_ERROR_CODES.has(value.publicCode)) {
    return { code: value.publicCode };
  }
  if (typeof value.publicCode === "string" && SAFE_BILLING_ERROR_CODES.has(value.publicCode)) {
    return { code: value.publicCode };
  }
  if (
    value.publicCode !== "ACCOUNT_SUSPENDED_BILLING_RECOVERY" &&
    value.publicCode !== "BILLING_RECOVERY_VENUE_SELECTION_REQUIRED" &&
    value.publicCode !== "ACCOUNT_SUSPENDED"
  ) return undefined;
  const venues = Array.isArray(value.billingRecoveryVenues)
    ? value.billingRecoveryVenues.flatMap((venue) => {
        if (!venue || typeof venue !== "object" || Array.isArray(venue)) return [];
        const candidate = venue as Record<string, unknown>;
        return typeof candidate.venueId === "string" && typeof candidate.venueName === "string"
          ? [{ venueId: candidate.venueId.slice(0, 200), venueName: candidate.venueName.slice(0, 200) }]
          : [];
      }).slice(0, 20)
    : [];
  return {
    code: value.publicCode,
    ...(value.publicCode === "ACCOUNT_SUSPENDED" ? {} : {
      recovery: {
        eligible: value.billingRecoveryEligible === true,
        endpoint: "/api/business/billing/recovery-portal",
        consumer: value.billingRecoveryConsumer === true,
        venues,
      },
    }),
  };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const fallbackError = new AppError("Internal server error", 500, undefined, false);
  const appError = isAppError(error) ? error : fallbackError;
  const isProduction = process.env.NODE_ENV === "production";
  const isServerError = appError.statusCode >= 500;

  const logMeta = {
    method: req.method,
    path: safeRequestPath(req),
    statusCode: appError.statusCode,
    error: error instanceof Error ? redactSecrets(error.message) : "Unknown error",
    details: redactSecrets(appError.details),
    ...(!isProduction && isServerError ? { stack: error instanceof Error ? redactSecrets(error.stack) : undefined } : {}),
  };

  if (isServerError) {
    logger.error("Request failed", logMeta);
  } else {
    logger.warn("Request rejected", logMeta);
  }

  res.status(appError.statusCode).json(
    failure(
      appError.expose ? appError.message : "Internal server error",
      isProduction ? undefined : redactSecrets(appError.details),
      safePublicErrorMetadata(appError.details),
    ),
  );
}
