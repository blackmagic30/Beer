import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { describe, expect, it } from "vitest";

import { createCanonicalProductionHostGuard } from "../src/app.js";
import {
  buildCanonicalHostRedirectUrl,
  resolveCanonicalHostRequest,
  shouldEnforceCanonicalProductionHost,
  shouldRedirectToCanonicalHost,
} from "../src/lib/canonical-redirect.js";

const CANONICAL_ORIGIN = "https://pintpath.au";

async function requestThroughGuard(input: {
  enabled?: boolean;
  trustProxy?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const app = express();
  app.set("trust proxy", input.trustProxy ?? 1);
  app.use(createCanonicalProductionHostGuard({
    enabled: input.enabled ?? true,
    canonicalOrigin: CANONICAL_ORIGIN,
  }));
  app.use((_req, res) => res.status(204).end());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        method: input.method ?? "GET",
        path: input.path ?? "/",
        headers: input.headers,
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }));
      });
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe("canonical host redirects", () => {
  it.each([
    ["canonical Railway production", "production", "production", false, false, false, true],
    ["self-hosted production", "production", undefined, false, false, false, true],
    ["test", "test", undefined, false, false, false, false],
    ["development", "development", undefined, false, false, false, false],
    ["Railway staging", "production", "permanent-staging", false, false, false, false],
    ["restore rehearsal", "production", "production", true, false, false, false],
    ["Postgres recovery", "production", "production", false, true, false, false],
    ["account-deletion rehearsal", "production", "production", false, false, true, false],
  ])("enables the guard only for %s", (
    _label,
    nodeEnv,
    railwayEnvironmentName,
    restoreRehearsalMode,
    postgresRecoveryRehearsalMode,
    accountDeletionRehearsalEnabled,
    expected,
  ) => {
    expect(shouldEnforceCanonicalProductionHost({
      nodeEnv: String(nodeEnv),
      railwayEnvironmentName: railwayEnvironmentName === undefined
        ? undefined
        : String(railwayEnvironmentName),
      restoreRehearsalMode: Boolean(restoreRehearsalMode),
      postgresRecoveryRehearsalMode: Boolean(postgresRecoveryRehearsalMode),
      accountDeletionRehearsalEnabled: Boolean(accountDeletionRehearsalEnabled),
    })).toBe(expected);
  });

  it.each([
    "www.pintpath.au",
    "WWW.PINTPATH.AU",
    "pintpath.com.au",
    "www.pintpath.com.au",
  ])("redirects only the exact reviewed production alias %s", (requestHostname) => {
    expect(shouldRedirectToCanonicalHost("pintpath.au", requestHostname)).toBe(true);
  });

  it.each([
    "pintpath.au",
    "attacker.example",
    "pintpath.au.attacker.example",
    "www.pintpath.au.attacker.example",
    "www.pintpath.au.",
    " www.pintpath.au",
    "www.pintpath.au:443",
  ])("does not redirect the canonical or untrusted host %s", (requestHostname) => {
    expect(shouldRedirectToCanonicalHost("pintpath.au", requestHostname)).toBe(false);
  });

  it("does not apply production aliases to an isolated staging origin", () => {
    expect(shouldRedirectToCanonicalHost(
      "pintpath-permanent-staging.example.test",
      "www.pintpath-permanent-staging.example.test",
    )).toBe(false);
    expect(shouldRedirectToCanonicalHost(
      "pintpath-permanent-staging.example.test",
      "www.pintpath.au",
    )).toBe(false);
  });

  it("preserves the exact path, encoding, repeated parameters, and query order", () => {
    expect(buildCanonicalHostRedirectUrl(
      CANONICAL_ORIGIN,
      "/venues/bar%20name/menu?beer=stout&beer=ale&return=%2Fmap%3Fz%3D12",
    )).toBe(
      "https://pintpath.au/venues/bar%20name/menu?beer=stout&beer=ale&return=%2Fmap%3Fz%3D12",
    );
  });

  it.each([
    "//attacker.example/steal?code=oauth-code",
    "\\\\attacker.example\\steal?code=oauth-code",
  ])("keeps network-path references on the canonical origin", (requestTarget) => {
    const redirect = buildCanonicalHostRedirectUrl(
      CANONICAL_ORIGIN,
      requestTarget,
    );

    expect(new URL(redirect).origin).toBe(CANONICAL_ORIGIN);
    expect(redirect).toBe(
      "https://pintpath.au/attacker.example/steal?code=oauth-code",
    );
  });

  it.each(["http", "https"])(
    "uses one permanent HTTPS redirect behind an %s proxy",
    async (forwardedProto) => {
      const response = await requestThroughGuard({
        path: "/venues/abc?beer=stout&sort=price",
        headers: {
          host: "pint-path-production.up.railway.app",
          "x-forwarded-host": "www.pintpath.au",
          "x-forwarded-proto": forwardedProto,
        },
      });

      expect(response.status).toBe(308);
      expect(response.headers.location).toBe(
        "https://pintpath.au/venues/abc?beer=stout&sort=price",
      );
    },
  );

  it("ignores a forwarded host when no proxy hop is trusted", async () => {
    const response = await requestThroughGuard({
      trustProxy: 0,
      headers: {
        host: "pintpath.au",
        "x-forwarded-host": "www.pintpath.au",
        "x-forwarded-proto": "http",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.location).toBeUndefined();
  });

  it("redirects the direct alternate host and ignores its incoming port", async () => {
    const response = await requestThroughGuard({
      path: "/auth/callback?code=oauth-code",
      headers: { host: "www.pintpath.au:8443" },
    });

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe(
      "https://pintpath.au/auth/callback?code=oauth-code",
    );
  });

  it.each([
    { host: "pintpath.au", forwardedHost: undefined },
    { host: "pint-path-production.up.railway.app", forwardedHost: "pintpath.au" },
  ])("passes canonical traffic without a redirect", async ({ host, forwardedHost }) => {
    const response = await requestThroughGuard({
      headers: {
        host,
        ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.location).toBeUndefined();
  });

  it.each([
    "attacker.example",
    "pintpath.au.attacker.example",
    "www.pintpath.au.attacker.example",
    "www.pintpath.au@attacker.example",
  ])("rejects the unrecognized production host %s without reflecting it", async (host) => {
    const response = await requestThroughGuard({
      path: "/account.html?next=%2Fmap",
      headers: { host },
    });

    expect(response.status).toBe(421);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("Misdirected Request");
    expect(response.body).not.toContain(host);
  });

  it.each(["/health", "/ready", "/startup"])(
    "keeps the exact Railway GET/HEAD probe %s reachable on an internal host",
    async (path) => {
      for (const method of ["GET", "HEAD"]) {
        const response = await requestThroughGuard({
          method,
          path: `${path}?probe=railway`,
          headers: { host: "pint-path-production.railway.internal" },
        });
        expect(response.status).toBe(204);
        expect(response.headers.location).toBeUndefined();
      }
    },
  );

  it.each([
    ["GET", "/healthz"],
    ["POST", "/health"],
    ["GET", "/api/business/venues"],
  ])("does not turn a non-probe %s %s into a host-check bypass", async (method, path) => {
    const response = await requestThroughGuard({
      method,
      path,
      headers: { host: "pint-path-production.railway.internal" },
    });

    expect(response.status).toBe(421);
  });

  it("passes every host unchanged when the production guard is disabled", async () => {
    const response = await requestThroughGuard({
      enabled: false,
      path: "/auth/callback?code=local-test",
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": "www.pintpath.au",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.location).toBeUndefined();
  });

  it("fails closed for an invalid canonical production origin", () => {
    expect(resolveCanonicalHostRequest({
      enabled: true,
      canonicalOrigin: "http://pintpath.au",
      requestHostname: "www.pintpath.au",
      requestMethod: "GET",
      requestPath: "/",
      requestTarget: "/",
    })).toEqual({ action: "reject" });
  });
});
