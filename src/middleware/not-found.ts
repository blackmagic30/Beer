import path from "node:path";

import type { Request, Response } from "express";

import { failure } from "../lib/http.js";

export function notFoundHandler(req: Request, res: Response): void {
  const acceptsHtml = req.accepts?.(["html", "json"]) === "html";
  const isHtmlPageRequest = (req.method === "GET" || req.method === "HEAD")
    && acceptsHtml
    && !req.path.startsWith("/api/");

  if (isHtmlPageRequest) {
    res.status(404).sendFile(path.resolve(process.cwd(), "viewer", "404.html"));
    return;
  }

  const message = process.env.NODE_ENV === "production"
    ? "Route not found."
    : `Route not found: ${req.method} ${req.path || req.originalUrl?.split("?")[0] || ""}`;

  res.status(404).json(failure(message));
}
