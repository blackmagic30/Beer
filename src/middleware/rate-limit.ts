import crypto from "node:crypto";

import type { Request, RequestHandler } from "express";

import { AppError } from "../lib/errors.js";

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

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    pruneExpiredBuckets(now);

    const rawIdentity = options.keyGenerator?.(req) ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    const key = `${options.keyPrefix}:${hashKey(rawIdentity)}`;
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      next(new AppError("Too many requests. Please wait a moment and try again.", 429));
      return;
    }

    next();
  };
}
