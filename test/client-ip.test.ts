import { afterEach, describe, expect, it, vi } from "vitest";

import { getClientIp, getRateLimitIdentity, normalizeIpAddress } from "../src/lib/client-ip.js";

function requestFixture(input: {
  ip?: string;
  remoteAddress?: string;
  realIp?: string;
}) {
  return {
    ip: input.ip,
    socket: { remoteAddress: input.remoteAddress },
    get(name: string) {
      return name.toLowerCase() === "x-real-ip" ? input.realIp : undefined;
    },
  } as never;
}

describe("client IP resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Railway's stable client header instead of a changing proxy hop", () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-a");
    const first = requestFixture({
      realIp: "198.51.100.77",
      ip: "100.64.0.11",
      remoteAddress: "100.64.0.21",
    });
    const second = requestFixture({
      realIp: "198.51.100.77",
      ip: "100.64.0.12",
      remoteAddress: "100.64.0.22",
    });

    expect(getClientIp(first)).toBe("198.51.100.77");
    expect(getRateLimitIdentity(first)).toBe(getRateLimitIdentity(second));
  });

  it("does not trust a caller-supplied Railway header outside Railway", () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
    const req = requestFixture({
      realIp: "198.51.100.77",
      ip: "203.0.113.10",
      remoteAddress: "203.0.113.11",
    });

    expect(getClientIp(req)).toBe("203.0.113.10");
  });

  it("rejects malformed or multi-value Railway headers without trusting proxy addresses", () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-a");

    expect(getClientIp(requestFixture({
      realIp: "198.51.100.77, 100.64.0.1",
      ip: "203.0.113.10",
      remoteAddress: "203.0.113.11",
    }))).toBeNull();
    expect(getClientIp(requestFixture({
      realIp: "not-an-ip",
      remoteAddress: "203.0.113.11",
    }))).toBeNull();
    expect(getRateLimitIdentity(requestFixture({
      remoteAddress: "100.64.0.21",
    }))).toBeNull();
    expect(getRateLimitIdentity(requestFixture({
      remoteAddress: "100.64.0.22",
    }))).toBeNull();
  });

  it("does not trust Railway headers during local railway run variable injection", () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "environment-id");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");

    expect(getClientIp(requestFixture({
      realIp: "198.51.100.77",
      ip: "203.0.113.10",
      remoteAddress: "203.0.113.11",
    }))).toBe("203.0.113.10");
  });

  it("canonicalizes equivalent IPv4 and IPv6 address forms", () => {
    expect(normalizeIpAddress(" ::ffff:203.0.113.10 ")).toBe("203.0.113.10");
    expect(normalizeIpAddress("[2001:0DB8:0:0:0:0:0:1]")).toBe("2001:db8::1");
    expect(normalizeIpAddress("fe80::1%en0")).toBe("fe80::1");
  });
});
