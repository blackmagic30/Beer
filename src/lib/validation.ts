import { ZodError, type ZodType } from "zod";

import { AppError } from "./errors.js";

export function parseWithSchema<TOutput>(schema: ZodType<TOutput>, payload: unknown, message = "Validation failed"): TOutput {
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, error.flatten());
    }

    throw error;
  }
}
