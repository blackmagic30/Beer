export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly expose: boolean;

  constructor(message: string, statusCode = 500, details?: unknown, expose = true) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
    this.expose = expose;
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, details?: unknown, statusCode = 502) {
    super(message, statusCode, details, true);
    this.name = "ExternalServiceError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError ||
    (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number" &&
      "expose" in error &&
      typeof (error as { expose?: unknown }).expose === "boolean" &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    );
}
