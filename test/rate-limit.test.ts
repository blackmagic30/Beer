import { afterEach, describe, expect, it, vi } from "vitest";

const redisMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    status: string;
    connect: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    pexpire: ReturnType<typeof vi.fn>;
    pttl: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  connectError: undefined as Error | undefined,
  evalNeverResolves: false,
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
    eval = vi.fn(async (script: string, _keyCount: number, key: string, windowMs: number) => {
      if (redisMockState.evalNeverResolves) {
        return await new Promise<never>(() => undefined);
      }
      const count = await this.incr(key);
      let ttl = await this.pttl(key);
      if (ttl < 0 && script.includes("if ttl < 0")) {
        await this.pexpire(key, windowMs);
        ttl = windowMs;
      }
      return [count, ttl];
    });
    ping = vi.fn(async () => "PONG");
    quit = vi.fn(async () => {
      this.status = "end";
      return "OK";
    });
    disconnect = vi.fn(() => {
      this.status = "end";
    });

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
    GOOGLE_MAPS_MAP_ID: "test-vector-map-id",
    GOOGLE_PLACES_API_KEY: "test-google-places-api-key",
    OPENAI_API_KEY: "test-openai-api-key", // security-scan allow: synthetic production-env fixture only
    STRIPE_SECRET_KEY: "test-stripe-secret-key", // security-scan allow: synthetic production-env fixture only
    STRIPE_WEBHOOK_SECRET: "test-stripe-webhook-secret", // security-scan allow: synthetic production-env fixture only
    STRIPE_PRICE_MONTHLY: "test-stripe-monthly-price",
    STRIPE_PRICE_YEARLY: "test-stripe-yearly-price",
    STRIPE_PRO_PRICE_ID: "test-stripe-pro-price",
    SUPABASE_URL: "https://test-primary.supabase.co",
    SUPABASE_ANON_KEY: "test-supabase-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-role-key",
    OFFSITE_BACKUP_SUPABASE_URL: "https://test-offsite.supabase.co",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "test-offsite-service-role-key",
    SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
    POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    redisMockState.instances.length = 0;
    redisMockState.connectError = undefined;
    redisMockState.evalNeverResolves = false;
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
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('PTTL'"),
      1,
      expect.stringMatching(/^business:test:/),
      60_000,
    );
    expect(redis.connect.mock.invocationCallOrder[0]).toBeLessThan(redis.eval.mock.invocationCallOrder[0]);
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

  it("fails closed within the Redis deadline when the atomic increment never resolves", async () => {
    vi.useFakeTimers();
    stubProductionEnv();
    redisMockState.evalNeverResolves = true;

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({
      keyPrefix: "business:stalled",
      windowMs: 60_000,
      max: 2,
    });

    const pending = runLimiter(limiter);
    await vi.advanceTimersByTimeAsync(1_501);

    await expect(pending).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({
        message: "Rate limiter unavailable. Please try again shortly.",
        statusCode: 503,
      }),
    }));
  });

  it("atomically repairs a counter left without a TTL by an earlier partial failure", async () => {
    stubProductionEnv();
    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "business:repair", windowMs: 60_000, max: 5 });
    const first = await runLimiter(limiter);
    const redis = redisMockState.instances[0]!;
    redis.pttl.mockResolvedValueOnce(-1);

    const repaired = await runLimiter(limiter);

    expect(first.error).toBeUndefined();
    expect(repaired.error).toBeUndefined();
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("if ttl < 0"),
      1,
      expect.stringMatching(/^business:repair:/),
      60_000,
    );
    expect(redis.pexpire).toHaveBeenCalledWith(expect.stringMatching(/^business:repair:/), 60_000);
  });

  it("probes Redis once per readiness cache window and closes the lazy client on shutdown", async () => {
    stubProductionEnv();

    const { probeRateLimitRedis, shutdownRateLimitRedis } = await loadRateLimiter();
    await expect(probeRateLimitRedis()).resolves.toEqual({
      status: "ok",
      configured: true,
      required: true,
      ready: true,
    });
    await expect(probeRateLimitRedis()).resolves.toEqual(expect.objectContaining({ status: "ok", ready: true }));

    const redis = redisMockState.instances[0]!;
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
    await shutdownRateLimitRedis();
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it("reports dependency-specific Redis readiness failures without connection secrets", async () => {
    stubProductionEnv();
    redisMockState.connectError = Object.assign(
      new Error("redis://default:password@redis.railway.internal failed"),
      { code: "ECONNREFUSED" },
    );

    const { probeRateLimitRedis } = await loadRateLimiter();
    const readiness = await probeRateLimitRedis();

    expect(readiness).toEqual({
      status: "failed",
      configured: true,
      required: true,
      ready: false,
      error: "ECONNREFUSED",
    });
    expect(JSON.stringify(readiness)).not.toContain("password");
    expect(JSON.stringify(readiness)).not.toContain("railway.internal");
  });

  it("marks a missing required production Redis URL not ready", async () => {
    stubProductionEnv({ REDIS_URL: "" });

    const { probeRateLimitRedis } = await loadRateLimiter();

    await expect(probeRateLimitRedis()).resolves.toEqual({
      status: "required_unconfigured",
      configured: false,
      required: true,
      ready: false,
    });
    expect(redisMockState.instances).toHaveLength(0);
  });
});
