import type { NextFunction, Request, Response } from "express";

import { AppError, isAppError } from "../lib/errors.js";
import { failure } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const fallbackError = new AppError("Internal server error", 500, undefined, false);
  const appError = isAppError(error) ? error : fallbackError;
  const isProduction = process.env.NODE_ENV === "production";

  logger.error("Request failed", {
    method: req.method,
    path: req.originalUrl,
    statusCode: appError.statusCode,
    error: error instanceof Error ? redactSecrets(error.message) : "Unknown error",
    details: redactSecrets(appError.details),
    ...(isProduction ? {} : { stack: error instanceof Error ? redactSecrets(error.stack) : undefined }),
  });

  res.status(appError.statusCode).json(
    failure(
      appError.expose ? appError.message : "Internal server error",
      isProduction ? undefined : redactSecrets(appError.details),
    ),
  );
}
