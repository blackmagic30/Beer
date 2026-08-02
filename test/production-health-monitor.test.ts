import { describe, expect, it, vi } from "vitest";

import { runProductionHealthCheck } from "../scripts/production-health-check.mjs";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function healthyPayload(status: "ok" | "ready") {
  return {
    ok: true,
    data: {
      status,
      deployment: { commitSha: "52622fad3330d2f1591425e34b465252831001eb" },
      ...(status === "ready"
        ? { dependencies: { supabaseDatabase: { status: "ok", required: true, liveProbe: true } } }
        : {}),
    },
  };
}

describe("production health monitor", () => {
  it("waits through transient deep-readiness failures and preserves safe diagnostics", async () => {
    let readinessAttempts = 0;
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") return jsonResponse(200, healthyPayload("ok"));
      readinessAttempts += 1;
      if (readinessAttempts < 3) {
        return jsonResponse(503, {
          ok: true,
          data: {
            status: "not_ready",
            deployment: { commitSha: "52622fad3330d2f1591425e34b465252831001eb" },
            dependencies: {
              supabaseDatabase: {
                status: "failed",
                required: true,
                liveProbe: true,
                error: "timeout",
              },
            },
          },
        });
      }
      return jsonResponse(200, healthyPayload("ready"));
    });
    const sleep = vi.fn(async () => undefined);
    const logs: string[] = [];

    const result = await runProductionHealthCheck({
      baseUrl: "https://pintpath.test",
      healthAttempts: 1,
      readinessAttempts: 3,
      healthRetryDelayMs: 0,
      readinessRetryDelayMs: 15_000,
      requestTimeoutMs: 100,
      fetchImplementation,
      sleep,
      log: (line: string) => logs.push(line),
    });

    expect(result.health.passed).toBe(true);
    expect(result.readiness).toMatchObject({ passed: true, attempt: 3, check: "/ready" });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 15_000);
    expect(logs.some((line) => line.includes('"error":"timeout"'))).toBe(true);
    expect(logs.some((line) => line.includes('"check":"/ready"'))).toBe(true);
  });

  it("fails a persistent readiness outage with the path and final dependency code", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/health"
        ? jsonResponse(200, healthyPayload("ok"))
        : jsonResponse(503, {
            ok: true,
            data: {
              status: "not_ready",
              dependencies: {
                rateLimiterRedis: {
                  status: "failed",
                  configured: true,
                  required: true,
                  ready: false,
                  error: "RedisProbeFailed",
                },
              },
            },
          });
    });

    await expect(runProductionHealthCheck({
      baseUrl: "https://pintpath.test",
      healthAttempts: 1,
      readinessAttempts: 2,
      healthRetryDelayMs: 0,
      readinessRetryDelayMs: 0,
      requestTimeoutMs: 100,
      fetchImplementation,
      sleep: async () => undefined,
      log: () => undefined,
    })).rejects.toThrow(/\/ready[\s\S]*RedisProbeFailed/);
  });

  it("does not print an unexpected non-JSON response body", async () => {
    const unexpectedBody = "proxy diagnostic with detail that must stay private";
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/health"
        ? jsonResponse(200, healthyPayload("ok"))
        : new Response(unexpectedBody, { status: 503 });
    });
    const logs: string[] = [];

    await expect(runProductionHealthCheck({
      baseUrl: "https://pintpath.test",
      healthAttempts: 1,
      readinessAttempts: 1,
      healthRetryDelayMs: 0,
      readinessRetryDelayMs: 0,
      requestTimeoutMs: 100,
      fetchImplementation,
      sleep: async () => undefined,
      log: (line: string) => logs.push(line),
    })).rejects.toThrow("/ready did not return HTTP 200");

    expect(logs.join("\n")).not.toContain(unexpectedBody);
    expect(logs.at(-1)).toContain(`"bodyLength":${Buffer.byteLength(unexpectedBody)}`);
  });
});
