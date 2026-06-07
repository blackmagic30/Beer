import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error-handler.js";

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
