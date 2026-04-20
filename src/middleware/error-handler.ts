import type { NextFunction, Request, Response } from "express";

import { AppError, isAppError } from "../lib/errors.js";
import { failure } from "../lib/http.js";
import { logger } from "../lib/logger.js";

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const fallbackError = new AppError("Internal server error", 500, undefined, false);
  const appError = isAppError(error) ? error : fallbackError;

  logger.error("Request failed", {
    method: req.method,
    path: req.originalUrl,
    statusCode: appError.statusCode,
    error: error instanceof Error ? error.message : "Unknown error",
    details: appError.details,
  });

  res.status(appError.statusCode).json(
    failure(appError.expose ? appError.message : "Internal server error", appError.details),
  );
}
