import type { NextFunction, Request, Response } from "express";

import { AppError, isAppError } from "../lib/errors.js";
import { failure } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const fallbackError = new AppError("Internal server error", 500, undefined, false);
  const appError = isAppError(error) ? error : fallbackError;
  const isProduction = process.env.NODE_ENV === "production";
  const isServerError = appError.statusCode >= 500;

  const logMeta = {
    method: req.method,
    path: req.originalUrl,
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
    ),
  );
}
