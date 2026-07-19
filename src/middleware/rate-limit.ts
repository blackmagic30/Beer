import crypto from "node:crypto";

import type { Request, RequestHandler } from "express";
import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { getRateLimitIdentity } from "../lib/client-ip.js";
import { logger } from "../lib/logger.js";

type RateLimiterOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyGenerator?: (req: Request) => string | null;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let redisClient: Redis | null | undefined;
let warnedMemoryFallback = false;
let lastRedisFailureLogAt = 0;
let redisReadinessCache: { expiresAt: number; value: RedisReadiness } | null = null;
let redisReadinessInFlight: Promise<RedisReadiness> | null = null;
let redisIdentityCache: {
  expiresAt: number;
  namespace: string;
  sentinelDigest: string;
} | null = null;
let redisIdentityInFlight: Promise<void> | null = null;
const REDIS_CONNECT_TIMEOUT_MS = 1_500;
const REDIS_FAILURE_LOG_INTERVAL_MS = 60_000;
const REDIS_READINESS_CACHE_MS = 15_000;
const REDIS_INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;
const REDIS_RESTORE_INCREMENT_SCRIPT = `
local identity = redis.call('GET', KEYS[2])
if not identity or identity ~= ARGV[2] then
  return { -1, -1 }
end
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

function isRedisRateLimitingRequired(): boolean {
  return env.REQUIRE_REDIS_RATE_LIMITING
    || (env.NODE_ENV === "production" && !env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION);
}

export type RedisReadiness = {
  status: "ok" | "failed" | "required_unconfigured" | "optional_unconfigured";
  configured: boolean;
  required: boolean;
  ready: boolean;
  error?: string;
  identity?: {
    required: true;
    verified: boolean;
  };
};

type RestoreRedisIdentitySettings = {
  namespace: string;
  sentinel: string;
  sentinelDigest: string;
};

class RestoreRedisIdentityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Restore rehearsal Redis identity verification failed");
    this.name = "RestoreRedisIdentityError";
    this.code = code;
  }
}

function getRedisKeyNamespace(): string | undefined {
  return process.env.REDIS_KEY_NAMESPACE?.trim() || undefined;
}

function getRestoreRedisIdentitySettings(): RestoreRedisIdentitySettings | null {
  if (!env.RESTORE_REHEARSAL_MODE) {
    return null;
  }

  const namespace = getRedisKeyNamespace();
  if (!namespace) {
    throw new RestoreRedisIdentityError("RestoreRedisNamespaceMissing");
  }

  const sentinel = process.env.RESTORE_REHEARSAL_REDIS_SENTINEL?.trim();
  if (!sentinel) {
    throw new RestoreRedisIdentityError("RestoreRedisSentinelMissing");
  }

  return {
    namespace,
    sentinel,
    sentinelDigest: crypto.createHash("sha256").update(sentinel).digest("hex"),
  };
}

function qualifyRedisRateLimitKey(key: string): string {
  const namespace = getRedisKeyNamespace();
  return namespace ? `${namespace}:${key}` : key;
}

function warnMemoryFallback(reason: string): void {
  if (warnedMemoryFallback || env.NODE_ENV !== "production") {
    return;
  }

  warnedMemoryFallback = true;
  logger.warn("Using in-memory rate limiting fallback in production", {
    reason,
    distributedRateLimitingConfigured: Boolean(env.REDIS_URL),
  });
}

function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function pruneExpiredBuckets(now: number): void {
  if (buckets.size < 5000) {
    return;
  }

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function clearRateLimitBucketsForTests(): void {
  buckets.clear();
}

function getRedisClient(): Redis | null {
  if (!env.REDIS_URL) {
    return null;
  }

  if (redisClient === undefined) {
    redisClient = new Redis(env.REDIS_URL, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    redisClient.on("error", () => {
      // Route handlers fail closed in production when Redis is unavailable.
      // Avoid logging connection payloads or URLs here.
    });
  }

  return redisClient;
}

function redisErrorMetadata(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownRedisError" };
  }

  const maybeCode = "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

  return {
    errorName: error.name,
    ...(maybeCode ? { errorCode: maybeCode } : {}),
  };
}

function logRedisFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastRedisFailureLogAt < REDIS_FAILURE_LOG_INTERVAL_MS) {
    return;
  }

  lastRedisFailureLogAt = now;
  logger.error("Redis-backed rate limiter unavailable", {
    redisStatus: redisClient?.status ?? "not_initialized",
    ...redisErrorMetadata(error),
  });
}

async function ensureRedisReady(client: Redis): Promise<void> {
  if (client.status === "ready") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const onReady = () => settle(resolve);
    const onError = (error: Error) => settle(() => reject(error));
    const timer = setTimeout(
      () => settle(() => reject(new Error("Redis connection timed out"))),
      REDIS_CONNECT_TIMEOUT_MS,
    );

    client.once("ready", onReady);
    client.once("error", onError);

    if (client.status === "wait" || client.status === "end" || client.status === "close") {
      client.connect().catch(onError);
    }
  });
}

async function withRedisTimeout<T>(operation: Promise<T>, timeoutMs = REDIS_CONNECT_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Redis operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function ensureRestoreRedisIdentity(client: Redis): Promise<void> {
  const settings = getRestoreRedisIdentitySettings();
  if (!settings) {
    return;
  }

  const now = Date.now();
  if (
    redisIdentityCache
    && redisIdentityCache.expiresAt > now
    && redisIdentityCache.namespace === settings.namespace
    && redisIdentityCache.sentinelDigest === settings.sentinelDigest
  ) {
    return;
  }

  if (redisIdentityInFlight) {
    return redisIdentityInFlight;
  }

  redisIdentityInFlight = (async () => {
    const identity = await withRedisTimeout(
      client.get(`${settings.namespace}:identity`),
      REDIS_CONNECT_TIMEOUT_MS,
    );
    if (typeof identity !== "string" || !timingSafeStringEqual(identity, settings.sentinel)) {
      redisIdentityCache = null;
      throw new RestoreRedisIdentityError("RestoreRedisIdentityMismatch");
    }

    redisIdentityCache = {
      expiresAt: Date.now() + REDIS_READINESS_CACHE_MS,
      namespace: settings.namespace,
      sentinelDigest: settings.sentinelDigest,
    };
  })();

  try {
    await redisIdentityInFlight;
  } finally {
    redisIdentityInFlight = null;
  }
}

export async function probeRateLimitRedis(): Promise<RedisReadiness> {
  const required = isRedisRateLimitingRequired();
  if (!env.REDIS_URL) {
    return {
      status: required ? "required_unconfigured" : "optional_unconfigured",
      configured: false,
      required,
      ready: !required,
    };
  }

  const now = Date.now();
  if (redisReadinessCache && redisReadinessCache.expiresAt > now) {
    return redisReadinessCache.value;
  }
  if (redisReadinessInFlight) {
    return redisReadinessInFlight;
  }

  redisReadinessInFlight = (async () => {
    const client = getRedisClient();
    if (!client) {
      return {
        status: required ? "required_unconfigured" : "optional_unconfigured",
        configured: false,
        required,
        ready: !required,
      } satisfies RedisReadiness;
    }
    try {
      await ensureRedisReady(client);
      await withRedisTimeout(client.ping(), REDIS_CONNECT_TIMEOUT_MS);
      await ensureRestoreRedisIdentity(client);
      return {
        status: "ok",
        configured: true,
        required,
        ready: true,
        ...(env.RESTORE_REHEARSAL_MODE
          ? { identity: { required: true as const, verified: true } }
          : {}),
      } satisfies RedisReadiness;
    } catch (error) {
      return {
        status: "failed",
        configured: true,
        required,
        ready: false,
        error: redisErrorMetadata(error).errorCode ?? redisErrorMetadata(error).errorName ?? "RedisProbeFailed",
        ...(env.RESTORE_REHEARSAL_MODE
          ? { identity: { required: true as const, verified: false } }
          : {}),
      } satisfies RedisReadiness;
    }
  })();

  try {
    const value = await redisReadinessInFlight;
    redisReadinessCache = { value, expiresAt: Date.now() + REDIS_READINESS_CACHE_MS };
    return value;
  } finally {
    redisReadinessInFlight = null;
  }
}

export async function shutdownRateLimitRedis(): Promise<void> {
  const client = redisClient;
  redisClient = undefined;
  redisReadinessCache = null;
  redisReadinessInFlight = null;
  redisIdentityCache = null;
  redisIdentityInFlight = null;
  if (!client) return;

  try {
    if (client.status !== "end") {
      await withRedisTimeout(client.quit(), REDIS_CONNECT_TIMEOUT_MS);
    }
  } catch {
    client.disconnect(false);
  }
}

async function incrementRedisBucket(key: string, windowMs: number, now: number): Promise<Bucket | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  await ensureRedisReady(client);
  const restoreIdentity = getRestoreRedisIdentitySettings();
  const result = await withRedisTimeout(
    restoreIdentity
      ? client.eval(
        REDIS_RESTORE_INCREMENT_SCRIPT,
        2,
        key,
        `${restoreIdentity.namespace}:identity`,
        windowMs,
        restoreIdentity.sentinel,
      )
      : client.eval(REDIS_INCREMENT_SCRIPT, 1, key, windowMs),
    REDIS_CONNECT_TIMEOUT_MS,
  ) as [number | string, number | string];
  const count = Number(result?.[0]);
  const ttl = Number(result?.[1]);
  if (restoreIdentity && count === -1 && ttl === -1) {
    redisIdentityCache = null;
    throw new RestoreRedisIdentityError("RestoreRedisIdentityMismatch");
  }
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
    throw new Error("Redis rate-limit script returned an invalid result");
  }
  return {
    count,
    resetAt: now + (ttl > 0 ? ttl : windowMs),
  };
}

function incrementMemoryBucket(key: string, windowMs: number, now: number): Bucket {
  pruneExpiredBuckets(now);

  const existing = buckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + windowMs };

  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return async (req, res, next) => {
    const now = Date.now();
    const rawIdentity = options.keyGenerator ? options.keyGenerator(req) : getRateLimitIdentity(req);
    if (!rawIdentity) {
      next(new AppError("Rate limiter could not verify the client identity. Please try again shortly.", 503));
      return;
    }
    const key = qualifyRedisRateLimitKey(`${options.keyPrefix}:${hashKey(rawIdentity)}`);
    let bucket: Bucket;
    const redisRequired = isRedisRateLimitingRequired();

    try {
      if (redisRequired && !env.REDIS_URL) {
        next(new AppError("Rate limiter unavailable. Please try again shortly.", 503));
        return;
      }

      if (env.NODE_ENV === "production" && !env.REDIS_URL) {
        warnMemoryFallback("missing_redis_url");
      }

      bucket = await incrementRedisBucket(key, options.windowMs, now)
        ?? incrementMemoryBucket(key, options.windowMs, now);
    } catch (error) {
      logRedisFailure(error);
      if (redisRequired) {
        next(new AppError("Rate limiter unavailable. Please try again shortly.", 503));
        return;
      }

      warnMemoryFallback("redis_unavailable");
      bucket = incrementMemoryBucket(key, options.windowMs, now);
    }

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (env.NODE_ENV === "production" && !redisRequired) {
      res.setHeader("RateLimit-Policy", env.REDIS_URL ? "redis-with-memory-fallback" : "memory-fallback");
    }

    if (bucket.count > options.max) {
      next(new AppError("Too many requests. Please wait a moment and try again.", 429));
      return;
    }

    next();
  };
}
