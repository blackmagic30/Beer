import type { Request, Response } from "express";

import { failure } from "../lib/http.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    failure(`Route not found: ${req.method} ${req.originalUrl}`),
  );
}
