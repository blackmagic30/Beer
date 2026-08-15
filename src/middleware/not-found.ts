import { fileURLToPath } from "node:url";

import type { Request, Response } from "express";

import { failure } from "../lib/http.js";

const BRANDED_NOT_FOUND_PAGE_PATH = fileURLToPath(
  new URL("../../viewer/404.html", import.meta.url),
);

function isPublicPageRequest(req: Request): boolean {
  return (req.method === "GET" || req.method === "HEAD")
    && !req.path.startsWith("/api/");
}

export function isHtmlPageRequest(req: Request): boolean {
  const acceptsHtml = req.accepts?.(["html", "json"]) === "html";
  return isPublicPageRequest(req) && acceptsHtml;
}

export function prepareNotFoundResponse(req: Request, res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  if (isPublicPageRequest(req)) {
    res.vary("Accept");
  }
}

export function sendBrandedNotFoundPage(res: Response): void {
  res.status(404).sendFile(BRANDED_NOT_FOUND_PAGE_PATH);
}

export function notFoundHandler(req: Request, res: Response): void {
  prepareNotFoundResponse(req, res);
  if (isHtmlPageRequest(req)) {
    sendBrandedNotFoundPage(res);
    return;
  }

  const message = process.env.NODE_ENV === "production"
    ? "Route not found."
    : `Route not found: ${req.method} ${req.path || req.originalUrl?.split("?")[0] || ""}`;

  res.status(404).json(failure(message));
}
