import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const RESTORE_RAILWAY_ENVIRONMENT_ID = "fixture-restore-environment";
const RESTORE_RAILWAY_PROJECT_ID = "fixture-restore-project";
const RESTORE_RAILWAY_APP_SERVICE_ID = "fixture-restore-app-service";
const RESTORE_RAILWAY_PUBLIC_DOMAIN = "restore-staging-fixture.up.railway.app";
const RESTORE_REDIS_SERVICE_ID = "fixture-restore-redis-service";
const RESTORE_SUPABASE_URL = "https://restoreref0000000001.supabase.co";
const PRODUCTION_SUPABASE_URL = "https://productionref0000001.supabase.co";
const BACKUP_SUPABASE_URL = "https://backupref00000000001.supabase.co";
const RATE_LIMIT_DATABASE_URL =
  "postgresql://pintpath_app:fixture-password@postgres.railway.internal:5432/pintpath?sslmode=require";
const RATE_LIMIT_REDIS_URL = "redis://default:password@redis.railway.internal:6379";
const STAGING_DATABASE_DIGEST = sha256("postgresql://staging.invalid/pintpath?sslmode=require");
const STAGING_REDIS_DIGEST = sha256("redis://staging.invalid:6379");
const PRODUCTION_DATABASE_RESOURCE = "provider-prod-postgres-71b26d90";
const STAGING_DATABASE_RESOURCE = "provider-staging-postgres-40e62ca1";
const RESTORE_DATABASE_RESOURCE = "provider-restore-postgres-5a821e3c";
const PRODUCTION_REDIS_RESOURCE = "provider-prod-redis-71b26d90";
const STAGING_REDIS_RESOURCE = "provider-staging-redis-40e62ca1";
const RESTORE_REDIS_RESOURCE = "provider-restore-redis-5a821e3c";
const RESTORE_REDIS_NAMESPACE = `pint-path:restore:${RESTORE_RAILWAY_ENVIRONMENT_ID}:pint-path-test-backup`;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function legacySupabaseJwt(
  role: "anon" | "service_role",
  signatureByte: number,
): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8")
      .toString("base64url"),
    Buffer.from(JSON.stringify({
      iss: "supabase",
      ref: `rate-limit-${signatureByte}`,
      role,
      iat: 1_700_000_000,
      exp: 2_000_000_000,
    }), "utf8").toString("base64url"),
    Buffer.alloc(32, signatureByte).toString("base64url"),
  ].join(".");
}

const productionLegacyAnonKey = legacySupabaseJwt("anon", 1);
const productionLegacyServiceRoleKey = legacySupabaseJwt("service_role", 2);
const productionLegacyOffsiteServiceRoleKey = legacySupabaseJwt("service_role", 3);
const restoreLegacyAnonKey = legacySupabaseJwt("anon", 4);
const restoreLegacyServiceRoleKey = legacySupabaseJwt("service_role", 5);

const redisMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    status: string;
    connect: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
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
  counters: new Map<string, number>(),
  strings: new Map<string, string>(),
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

    get = vi.fn(async (key: string) => redisMockState.strings.get(key) ?? null);
    incr = vi.fn(async (key: string) => {
      const count = (redisMockState.counters.get(key) ?? 0) + 1;
      redisMockState.counters.set(key, count);
      return count;
    });
    pexpire = vi.fn(async () => 1);
    pttl = vi.fn(async () => 60_000);
    eval = vi.fn(async (script: string, _keyCount: number, key: string, ...args: Array<string | number>) => {
      if (redisMockState.evalNeverResolves) {
        return await new Promise<never>(() => undefined);
      }
      let windowMs: number;
      if (script.includes("local identity = redis.call('GET', KEYS[2])")) {
        const [identityKey, rawWindowMs, expectedSentinel] = args;
        if (redisMockState.strings.get(String(identityKey)) !== String(expectedSentinel)) {
          return [-1, -1];
        }
        windowMs = Number(rawWindowMs);
      } else {
        windowMs = Number(args[0]);
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
    DATABASE_URL: RATE_LIMIT_DATABASE_URL,
    DATABASE_PATH: "",
    PINTPATH_IDENTITY_REGISTRY_PHASE: "complete",
    PINTPATH_DATABASE_RESOURCE_ID: PRODUCTION_DATABASE_RESOURCE,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: PRODUCTION_DATABASE_RESOURCE,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${STAGING_DATABASE_RESOURCE},${RESTORE_DATABASE_RESOURCE}`,
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: sha256(RATE_LIMIT_DATABASE_URL),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${STAGING_DATABASE_DIGEST},${sha256("restore-database")}`,
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: STAGING_DATABASE_RESOURCE,
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: STAGING_DATABASE_DIGEST,
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
    SUPABASE_ANON_KEY: productionLegacyAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: productionLegacyServiceRoleKey,
    OFFSITE_BACKUP_SUPABASE_URL: "https://test-offsite.supabase.co",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: productionLegacyOffsiteServiceRoleKey,
    SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
    POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
    DEMO_BILLING_MODE: "false",
    REDIS_URL: RATE_LIMIT_REDIS_URL,
    PINTPATH_REDIS_RESOURCE_ID: PRODUCTION_REDIS_RESOURCE,
    PINTPATH_EXPECTED_REDIS_RESOURCE_ID: PRODUCTION_REDIS_RESOURCE,
    PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS: `${STAGING_REDIS_RESOURCE},${RESTORE_REDIS_RESOURCE}`,
    PINTPATH_EXPECTED_REDIS_URL_SHA256: sha256(RATE_LIMIT_REDIS_URL),
    PINTPATH_FORBIDDEN_REDIS_URL_SHA256S: `${STAGING_REDIS_DIGEST},${sha256("restore-redis")}`,
    PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID: STAGING_REDIS_RESOURCE,
    PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256: STAGING_REDIS_DIGEST,
    REDIS_KEY_NAMESPACE: "",
    RESTORE_REHEARSAL_MODE: "false",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: "",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: "",
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: "",
    RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: "",
    RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: "",
    RESTORE_REHEARSAL_REDIS_SENTINEL: "",
    REQUIRE_REDIS_RATE_LIMITING: "false",
    ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
    RAILWAY_ENVIRONMENT_ID: "",
    RAILWAY_ENVIRONMENT_NAME: "",
    RAILWAY_REPLICA_ID: "",
    ...overrides,
  };

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

function restoreRehearsalOverrides(namespace: string, sentinel: string): Record<string, string> {
  return {
    NODE_ENV: "production",
    RESTORE_REHEARSAL_MODE: "true",
    RESTORE_REHEARSAL_PHASE: "active",
    RESTORE_REHEARSAL_BACKUP_ID: "pint-path-test-backup",
    RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256: "a".repeat(64),
    RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256: "b".repeat(64),
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: RESTORE_RAILWAY_ENVIRONMENT_ID,
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: RESTORE_RAILWAY_PROJECT_ID,
    RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: RESTORE_RAILWAY_APP_SERVICE_ID,
    RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL: RESTORE_SUPABASE_URL,
    RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID: RESTORE_REDIS_SERVICE_ID,
    RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    RESTORE_REHEARSAL_BACKUP_SUPABASE_URL: BACKUP_SUPABASE_URL,
    RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
    RESTORE_REHEARSAL_ACCESS_PASSWORD: "restore-access-password-with-enough-entropy",
    RAILWAY_ENVIRONMENT_ID: RESTORE_RAILWAY_ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_PROJECT_ID: RESTORE_RAILWAY_PROJECT_ID,
    RAILWAY_SERVICE_ID: RESTORE_RAILWAY_APP_SERVICE_ID,
    RAILWAY_VOLUME_MOUNT_PATH: "/app/data",
    RAILWAY_PUBLIC_DOMAIN: RESTORE_RAILWAY_PUBLIC_DOMAIN,
    PUBLIC_BASE_URL: `https://${RESTORE_RAILWAY_PUBLIC_DOMAIN}`,
    DATABASE_PATH: "/app/data/restore-pint-path-test-backup/pint-path.sqlite",
    SOURCE_EVIDENCE_STORAGE_DIR: "/app/data/restore-pint-path-test-backup/source-evidence",
    SUPABASE_URL: RESTORE_SUPABASE_URL,
    SUPABASE_ANON_KEY: restoreLegacyAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: restoreLegacyServiceRoleKey,
    SUPABASE_OAUTH_PROVIDERS: "",
    GOOGLE_MAPS_API_KEY: "restore-browser-map-key",
    GOOGLE_MAPS_MAP_ID: "restore-map-id",
    GOOGLE_PLACES_API_KEY: "",
    OPENAI_API_KEY: "",
    OFFSITE_BACKUP_SUPABASE_URL: "",
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
    REPORT_EMAIL_MODE: "disabled",
    REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
    RESEND_API_KEY: "",
    REPORT_EMAIL_FROM: "",
    REPORT_EMAIL_REPLY_TO: "",
    DEMO_BILLING_MODE: "false",
    ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRICE_MONTHLY: "",
    STRIPE_PRICE_YEARLY: "",
    STRIPE_PRO_PRICE_ID: "",
    POS_WEBHOOK_SIGNING_SECRET: "",
    SOURCE_EVIDENCE_SIGNING_SECRET: "restore-source-signing-secret-with-enough-entropy",
    ADMIN_SHARED_SECRET: "",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "",
    REQUIRE_REDIS_RATE_LIMITING: "true",
    REDIS_KEY_NAMESPACE: namespace,
    RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID: RESTORE_RAILWAY_ENVIRONMENT_ID,
    RESTORE_REHEARSAL_REDIS_SERVICE_ID: RESTORE_REDIS_SERVICE_ID,
    RESTORE_REHEARSAL_REDIS_SENTINEL: sentinel,
    REDIS_URL: "redis://default:fixture-password@redis.railway.internal:6379",
  };
}

async function loadRateLimiter() {
  vi.resetModules();
  return import("../src/middleware/rate-limit.js");
}

async function runLimiter(
  limiter: ReturnType<typeof import("../src/middleware/rate-limit.js").createRateLimiter>,
  request: { ip?: string; remoteAddress?: string; realIp?: string } = {},
) {
  const headers = new Map<string, string>();

  const error = await new Promise<unknown>((resolve) => {
    limiter(
      {
        ip: request.ip ?? "203.0.113.10",
        socket: { remoteAddress: request.remoteAddress ?? "203.0.113.10" },
        get(name: string) {
          return name.toLowerCase() === "x-real-ip" ? request.realIp : undefined;
        },
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
    redisMockState.counters.clear();
    redisMockState.strings.clear();
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

  it("prefixes every Redis rate-limit key with the configured namespace", async () => {
    stubProductionEnv({ REDIS_KEY_NAMESPACE: "production:pint-path" });

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({
      keyPrefix: "business:test",
      windowMs: 60_000,
      max: 2,
    });

    const { error } = await runLimiter(limiter);
    const redis = redisMockState.instances[0]!;

    expect(error).toBeUndefined();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^production:pint-path:business:test:/),
      60_000,
    );
  });

  it("verifies the restore Redis identity atomically with every write", async () => {
    const namespace = RESTORE_REDIS_NAMESPACE;
    const sentinel = "restore-redis-sentinel-with-enough-entropy-2026";
    stubProductionEnv(restoreRehearsalOverrides(namespace, sentinel));
    redisMockState.strings.set(`${namespace}:identity`, sentinel);

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "restore:test", windowMs: 60_000, max: 2 });

    const first = await runLimiter(limiter);
    const second = await runLimiter(limiter);
    const redis = redisMockState.instances[0]!;

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("local identity = redis.call('GET', KEYS[2])"),
      2,
      expect.stringMatching(/^pint-path:restore:fixture-restore-environment:pint-path-test-backup:restore:test:/),
      `${namespace}:identity`,
      60_000,
      sentinel,
    );
  });

  it("fails closed without writing when the restore Redis identity does not match", async () => {
    const namespace = RESTORE_REDIS_NAMESPACE;
    stubProductionEnv(restoreRehearsalOverrides(
      namespace,
      "expected-restore-redis-sentinel-with-entropy",
    ));
    redisMockState.strings.set(`${namespace}:identity`, "wrong-environment-sentinel");

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "restore:test", windowMs: 60_000, max: 2 });

    const { error } = await runLimiter(limiter);
    const redis = redisMockState.instances[0]!;

    expect(error).toEqual(expect.objectContaining({
      message: "Rate limiter unavailable. Please try again shortly.",
      statusCode: 503,
    }));
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("local identity = redis.call('GET', KEYS[2])"),
      2,
      expect.any(String),
      `${namespace}:identity`,
      60_000,
      "expected-restore-redis-sentinel-with-entropy",
    );
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("fails the next write if the staging identity sentinel changes", async () => {
    const namespace = RESTORE_REDIS_NAMESPACE;
    const sentinel = "expected-restore-redis-sentinel-with-entropy";
    stubProductionEnv(restoreRehearsalOverrides(namespace, sentinel));
    redisMockState.strings.set(`${namespace}:identity`, sentinel);
    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "restore:test", windowMs: 60_000, max: 3 });

    expect((await runLimiter(limiter)).error).toBeUndefined();
    redisMockState.strings.delete(`${namespace}:identity`);
    const second = await runLimiter(limiter);

    expect(second.error).toEqual(expect.objectContaining({ statusCode: 503 }));
    expect(redisMockState.instances[0]!.incr).toHaveBeenCalledTimes(1);
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

  it("shares one Railway client bucket across changing proxy hops and limiter instances", async () => {
    stubProductionEnv({ RAILWAY_REPLICA_ID: "replica-a" });
    const firstModule = await loadRateLimiter();
    const limiterA = firstModule.createRateLimiter({
      keyPrefix: "business:multi-replica",
      windowMs: 60_000,
      max: 2,
    });
    const secondModule = await loadRateLimiter();
    const limiterB = secondModule.createRateLimiter({
      keyPrefix: "business:multi-replica",
      windowMs: 60_000,
      max: 2,
    });

    const first = await runLimiter(limiterA, {
      realIp: "198.51.100.77",
      ip: "100.64.0.11",
      remoteAddress: "100.64.0.21",
    });
    const second = await runLimiter(limiterB, {
      realIp: "198.51.100.77",
      ip: "100.64.0.12",
      remoteAddress: "100.64.0.22",
    });
    const third = await runLimiter(limiterA, {
      realIp: "198.51.100.77",
      ip: "100.64.0.13",
      remoteAddress: "100.64.0.23",
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(third.error).toEqual(expect.objectContaining({ statusCode: 429 }));
    expect(third.headers.get("RateLimit-Remaining")).toBe("0");
    expect(redisMockState.instances).toHaveLength(2);
    expect([...redisMockState.counters.values()]).toEqual([3]);
  });

  it("fails closed before Redis when Railway does not supply one valid client IP", async () => {
    stubProductionEnv({ RAILWAY_REPLICA_ID: "replica-a" });
    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "business:identity", windowMs: 60_000, max: 2 });

    const missing = await runLimiter(limiter, { ip: "100.64.0.11", remoteAddress: "100.64.0.21" });
    const malformed = await runLimiter(limiter, {
      realIp: "198.51.100.77, 100.64.0.1",
      ip: "100.64.0.12",
      remoteAddress: "100.64.0.22",
    });

    expect(missing.error).toEqual(expect.objectContaining({ statusCode: 503 }));
    expect(malformed.error).toEqual(expect.objectContaining({ statusCode: 503 }));
    expect(redisMockState.instances).toHaveLength(0);
    expect(redisMockState.counters.size).toBe(0);
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

  it("reports verified restore Redis identity in readiness without exposing the sentinel", async () => {
    const namespace = RESTORE_REDIS_NAMESPACE;
    const sentinel = "restore-readiness-sentinel-with-enough-entropy";
    stubProductionEnv(restoreRehearsalOverrides(namespace, sentinel));
    redisMockState.strings.set(`${namespace}:identity`, sentinel);

    const { probeRateLimitRedis } = await loadRateLimiter();
    const readiness = await probeRateLimitRedis();

    expect(readiness).toEqual({
      status: "ok",
      configured: true,
      required: true,
      ready: true,
      identity: { required: true, verified: true },
    });
    expect(JSON.stringify(readiness)).not.toContain(sentinel);
  });

  it("reports a failed restore Redis identity probe without writing or leaking sentinels", async () => {
    const namespace = RESTORE_REDIS_NAMESPACE;
    const sentinel = "expected-restore-readiness-sentinel-with-entropy";
    stubProductionEnv(restoreRehearsalOverrides(namespace, sentinel));
    redisMockState.strings.set(`${namespace}:identity`, "other-environment");

    const { probeRateLimitRedis } = await loadRateLimiter();
    const readiness = await probeRateLimitRedis();
    const redis = redisMockState.instances[0]!;

    expect(readiness).toEqual({
      status: "failed",
      configured: true,
      required: true,
      ready: false,
      error: "RestoreRedisIdentityMismatch",
      identity: { required: true, verified: false },
    });
    expect(redis.eval).not.toHaveBeenCalled();
    expect(JSON.stringify(readiness)).not.toContain(sentinel);
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

  it("can require fail-closed Redis limiting in a non-production staging runtime", async () => {
    stubProductionEnv({
      NODE_ENV: "development",
      REDIS_URL: "",
      REQUIRE_REDIS_RATE_LIMITING: "true",
    });

    const { createRateLimiter, probeRateLimitRedis } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "staging:required", windowMs: 60_000, max: 2 });

    await expect(probeRateLimitRedis()).resolves.toEqual({
      status: "required_unconfigured",
      configured: false,
      required: true,
      ready: false,
    });
    await expect(runLimiter(limiter)).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ statusCode: 503 }),
    }));
  });

  it("reports and enforces an unreachable required Redis dependency in staging", async () => {
    stubProductionEnv({
      NODE_ENV: "development",
      REQUIRE_REDIS_RATE_LIMITING: "true",
    });
    redisMockState.connectError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });

    const { createRateLimiter, probeRateLimitRedis } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "staging:unreachable", windowMs: 60_000, max: 2 });

    await expect(probeRateLimitRedis()).resolves.toEqual({
      status: "failed",
      configured: true,
      required: true,
      ready: false,
      error: "ECONNREFUSED",
    });
    await expect(runLimiter(limiter)).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ statusCode: 503 }),
    }));
  });

  it("does not let the production memory override weaken an explicit Redis requirement", async () => {
    stubProductionEnv({
      REQUIRE_REDIS_RATE_LIMITING: "true",
      ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "true",
    });
    redisMockState.connectError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });

    const { createRateLimiter } = await loadRateLimiter();
    const limiter = createRateLimiter({ keyPrefix: "production:required", windowMs: 60_000, max: 2 });

    await expect(runLimiter(limiter)).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ statusCode: 503 }),
    }));
  });
});
