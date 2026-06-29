import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { notFoundHandler } from "../src/middleware/not-found.js";

function mockResponse() {
  return {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("error handler logging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs exposed 4xx client errors as warnings without stack traces", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = mockResponse();

    errorHandler(
      new AppError("Login required.", 401),
      { method: "GET", originalUrl: "/api/business/account" } as never,
      response as never,
      (() => undefined) as never,
    );

    expect(response.statusCode).toBe(401);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] || "")).toContain('"message":"Request rejected"');
    expect(String(warn.mock.calls[0]?.[0] || "")).not.toContain("stack");
  });

  it("does not log query strings that may contain signed tokens", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = mockResponse();

    errorHandler(
      new AppError("Source evidence link has expired.", 403),
      {
        method: "GET",
        path: "/api/business/source-evidence/evidence-1",
        originalUrl: "/api/business/source-evidence/evidence-1?expires=1770000000&signature=abc123",
      } as never,
      response as never,
      (() => undefined) as never,
    );

    const logLine = String(warn.mock.calls[0]?.[0] || "");
    expect(logLine).toContain("/api/business/source-evidence/evidence-1");
    expect(logLine).not.toContain("signature=");
    expect(logLine).not.toContain("abc123");
  });

  it("keeps not-found responses path-only", () => {
    const response = mockResponse();

    notFoundHandler(
      {
        method: "GET",
        path: "/missing",
        originalUrl: "/missing?token=secret",
      } as never,
      response as never,
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.body)).toContain("GET /missing");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("logs server errors at error level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = mockResponse();

    errorHandler(
      new Error("Database exploded"),
      { method: "GET", originalUrl: "/api/business/config" } as never,
      response as never,
      (() => undefined) as never,
    );

    expect(response.statusCode).toBe(500);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0] || "")).toContain('"message":"Request failed"');
  });
});
