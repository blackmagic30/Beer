import crypto from "node:crypto";

import type { Request, RequestHandler } from "express";
import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

type RateLimiterOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyGenerator?: (req: Request) => string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let redisClient: Redis | null | undefined;
let warnedMemoryFallback = false;

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

async function incrementRedisBucket(key: string, windowMs: number, now: number): Promise<Bucket | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  const count = await client.incr(key);
  if (count === 1) {
    await client.pexpire(key, windowMs);
  }

  const ttl = await client.pttl(key);
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
    const rawIdentity = options.keyGenerator?.(req) ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    const key = `${options.keyPrefix}:${hashKey(rawIdentity)}`;
    let bucket: Bucket;

    try {
      if (env.NODE_ENV === "production" && !env.REDIS_URL && !env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION) {
        next(new AppError("Rate limiter unavailable. Please try again shortly.", 503));
        return;
      }

      if (env.NODE_ENV === "production" && !env.REDIS_URL) {
        warnMemoryFallback("missing_redis_url");
      }

      bucket = await incrementRedisBucket(key, options.windowMs, now)
        ?? incrementMemoryBucket(key, options.windowMs, now);
    } catch {
      if (env.NODE_ENV === "production" && !env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION) {
        next(new AppError("Rate limiter unavailable. Please try again shortly.", 503));
        return;
      }

      warnMemoryFallback("redis_unavailable");
      bucket = incrementMemoryBucket(key, options.windowMs, now);
    }

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (env.NODE_ENV === "production" && (!env.REDIS_URL || env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION)) {
      res.setHeader("RateLimit-Policy", env.REDIS_URL ? "redis-with-memory-fallback" : "memory-fallback");
    }

    if (bucket.count > options.max) {
      next(new AppError("Too many requests. Please wait a moment and try again.", 429));
      return;
    }

    next();
  };
}
