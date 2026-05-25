import { afterEach, describe, expect, it, vi } from "vitest";

const redisMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    status: string;
    connect: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    pexpire: ReturnType<typeof vi.fn>;
    pttl: ReturnType<typeof vi.fn>;
  }>,
  connectError: undefined as Error | undefined,
}));

vi.mock("ioredis", () => {
  class Redis {
    status = "wait";
    private readyListeners = new Set<() => void>();
    private errorListeners = new Set<(error: Error) => void>();

    connect = vi.fn(async () => {
      if (redisMockState.connectError) {
        this.status = "end";
        for (const listener of this.errorListeners) {
          listener(redisMockState.connectError);
        }
        throw redisMockState.connectError;
      }

      this.status = "ready";
      for (const listener of this.readyListeners) {
        listener();
      }
    });

    incr = vi.fn(async () => 1);
    pexpire = vi.fn(async () => 1);
    pttl = vi.fn(async () => 60_000);

    constructor() {
      redisMockState.instances.push(this);
    }

    on() {
      return this;
    }

    once(event: "ready" | "error", listener: (() => void) | ((error: Error) => void)) {
      if (event === "ready") {
        this.readyListeners.add(listener as () => void);
      } else {
        this.errorListeners.add(listener as (error: Error) => void);
      }
      return this;
    }

    off(event: "ready" | "error", listener: (() => void) | ((error: Error) => void)) {
      if (event === "ready") {
        this.readyListeners.delete(listener as () => void);
      } else {
        this.errorListeners.delete(listener as (error: Error) => void);
      }
      return this;
    }
  }

  return { Redis };
});

function stubProductionEnv(overrides: Record<string, string> = {}) {
  const env = {
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://pintpath.au",
    GOOGLE_MAPS_API_KEY: "test-browser-maps-key",
    SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
    DEMO_BILLING_MODE: "false",
    REDIS_URL: "redis://default:password@redis.railway.internal:6379",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    ...overrides,
  };

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

async function loadRateLimiter() {
  vi.resetModules();
  return import("../src/middleware/rate-limit.js");
}

async function runLimiter(limiter: ReturnType<typeof import("../src/middleware/rate-limit.js").createRateLimiter>) {
  const headers = new Map<string, string>();

  const error = await new Promise<unknown>((resolve) => {
    limiter(
      {
        ip: "203.0.113.10",
        socket: { remoteAddress: "203.0.113.10" },
      } as never,
      {
        setHeader(name: string, value: string) {
          headers.set(name, value);
        },
      } as never,
      (nextError?: unknown) => resolve(nextError),
    );
  });

  return { error, headers };
}

describe("Redis-backed rate limiting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    redisMockState.instances.length = 0;
    redisMockState.connectError = undefined;
  });

  it("connects the lazy Redis client before writing rate-limit keys", async () => {
    stubProductionEnv();

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({
      keyPrefix: "business:test",
      windowMs: 60_000,
      max: 2,
    });

    const { error, headers } = await runLimiter(limiter);
    const redis = redisMockState.instances[0];

    expect(error).toBeUndefined();
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^business:test:/));
    expect(redis.connect.mock.invocationCallOrder[0]).toBeLessThan(redis.incr.mock.invocationCallOrder[0]);
    expect(headers.get("RateLimit-Remaining")).toBe("1");
  });

  it("fails closed when Redis cannot connect and memory fallback is disabled", async () => {
    stubProductionEnv();
    redisMockState.connectError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({
      keyPrefix: "business:test",
      windowMs: 60_000,
      max: 2,
    });

    const { error } = await runLimiter(limiter);

    expect(error).toEqual(expect.objectContaining({
      message: "Rate limiter unavailable. Please try again shortly.",
      statusCode: 503,
    }));
  });
});
