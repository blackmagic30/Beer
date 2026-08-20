import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";

import {
  createApp,
  createRestoreRehearsalAccessGate,
  getPublicRestoreRuntimeReadiness,
  getStaticAssetCacheControl,
  isPostgresRecoveryRehearsalMutationAllowed,
  isRestoreRehearsalMutationAllowed,
  LARGE_JSON_BODY_LIMIT_BYTES,
  shouldRunAutomaticMaintenance,
} from "../src/app.js";

async function withHttpServer(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function postHeadersOnly(url: string, contentLength: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(contentLength),
        connection: "close",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("large JSON upload pre-parser containment", () => {
  it("rejects oversized anonymous upload envelopes before parsing or service initialization", async () => {
    const initializeSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const paths = [
      "/api/business/submissions",
      "/api/admin/captures/menu-photo-ocr",
      "/api/admin/ingestions/queue",
    ];

    await withHttpServer(async (baseUrl) => {
      for (const pathname of paths) {
        const response = await postHeadersOnly(`${baseUrl}${pathname}`, LARGE_JSON_BODY_LIMIT_BYTES + 1);
        expect(response.status).toBe(413);
        expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ message: "Request body is too large." }),
        }));
      }
    });

    expect(initializeSpy).not.toHaveBeenCalledWith("Initializing backend services...");
  });

  it("rejects malformed unauthenticated upload JSON before the JSON parser", async () => {
    const initializeSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Authentication required." }),
      }));
    });

    expect(initializeSpy).not.toHaveBeenCalledWith("Initializing backend services...");
  });
});

describe("restore rehearsal containment", () => {
  it("runs scheduled evidence retention through exactly one renewable global lease", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");
    expect(source).toContain(
      'const evidenceScheduler = scheduleMissionMaintenance({\n      run: runEvidenceRetention,',
    );
    expect(source).not.toMatch(
      /key: "lease:evidence_retention",[\s\S]{0,180}run: runEvidenceRetention/,
    );
  });

  it("keeps credential checks constant-time without request-path password stretching", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");
    expect(source).toContain("TIMING_SAFE_COMPARISON_MAX_BYTES");
    expect(source).toContain("crypto.timingSafeEqual(leftPadded, rightPadded)");
    expect(source).toContain("crypto.hkdfSync(");
    expect(source).not.toContain("crypto.scryptSync(");
  });

  it("gates restored data while leaving health probes available and preserving Bearer app auth", async () => {
    const app = express();
    app.use(createRestoreRehearsalAccessGate({
      RESTORE_REHEARSAL_MODE: true,
      RESTORE_REHEARSAL_ACCESS_USERNAME: "restore-operator",
      RESTORE_REHEARSAL_ACCESS_PASSWORD: "fixture-restore-access-password-32-bytes",
    }));
    app.get(["/health", "/ready", "/private"], (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);

      const denied = await fetch(`${baseUrl}/private`);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("Pint Path restore rehearsal");

      const basic = Buffer.from("restore-operator:fixture-restore-access-password-32-bytes").toString("base64");
      const admitted = await fetch(`${baseUrl}/private`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(admitted.status).toBe(200);
      const cookie = admitted.headers.get("set-cookie");
      expect(cookie).toContain("__Host-pint_path_restore_access=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");

      const bearerRequest = await fetch(`${baseUrl}/private`, {
        headers: {
          authorization: "Bearer restored-app-session-token",
          cookie: cookie!.split(";", 1)[0]!,
        },
      });
      expect(bearerRequest.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("allows only the exact public map reads in restore mode", () => {
    expect(isRestoreRehearsalMutationAllowed("GET", "/api/business/venues")).toBe(true);
    expect(isRestoreRehearsalMutationAllowed("GET", "/api/business/config")).toBe(true);
    expect(isRestoreRehearsalMutationAllowed("GET", "/api/business/access")).toBe(true);
    expect(isRestoreRehearsalMutationAllowed("GET", "/api/business/price-records")).toBe(true);
    expect(isRestoreRehearsalMutationAllowed("GET", "/API/business/venues")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("GET", "/Api/business/config")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("GET", "/api")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("GET", "/API")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("HEAD", "/api/business/venues")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("GET", "/api/business/auth/session")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("POST", "/api/business/auth/login")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("POST", "/api/business/auth/supabase-session")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("POST", "/api/business/events")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("POST", "/api/business/billing/checkout")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("DELETE", "/api/business/account/delete-request/id")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("POST", "/api/admin/venues")).toBe(false);
    expect(isRestoreRehearsalMutationAllowed("GET", "/pricing.html")).toBe(true);
    expect(shouldRunAutomaticMaintenance("production", true)).toBe(false);
    expect(shouldRunAutomaticMaintenance(
      "production",
      false,
      false,
      true,
      "a".repeat(40),
      "a".repeat(40),
    )).toBe(true);
    expect(shouldRunAutomaticMaintenance("production", false, true)).toBe(false);
    expect(shouldRunAutomaticMaintenance("production", false, false, false)).toBe(false);
    expect(shouldRunAutomaticMaintenance(
      "production",
      false,
      false,
      true,
      "a".repeat(40),
      "a".repeat(40),
    )).toBe(true);
    expect(shouldRunAutomaticMaintenance(
      "production",
      false,
      false,
      true,
      "a".repeat(40),
      "b".repeat(40),
    )).toBe(false);
    expect(isPostgresRecoveryRehearsalMutationAllowed(
      "POST",
      "/api/business/auth/supabase-session",
    )).toBe(true);
    expect(isPostgresRecoveryRehearsalMutationAllowed(
      "POST",
      "/api/business/auth/logout",
    )).toBe(true);
    expect(isPostgresRecoveryRehearsalMutationAllowed(
      "POST",
      "/api/business/account/delete-request",
    )).toBe(false);
    expect(isPostgresRecoveryRehearsalMutationAllowed(
      "POST",
      "/api/admin/venues",
    )).toBe(false);
  });

  it("keeps public restore readiness free of backup identifiers, hashes, paths, and counts", () => {
    const readiness = getPublicRestoreRuntimeReadiness(true);
    expect(readiness).toEqual({
      status: "verified",
      immutableBindingsVerified: true,
      databaseIntegrityVerified: true,
      evidenceIntegrityVerified: true,
      readOnly: true,
    });
    expect(JSON.stringify(readiness)).not.toMatch(
      /backup|sha256|hash|path|fileCount|object|credential|secret/i,
    );
    expect(getPublicRestoreRuntimeReadiness(false)).toEqual({ status: "not_verified" });
  });
});

describe("static response compression", () => {
  it("compresses large public pages without applying compression to API responses", async () => {
    await withHttpServer(async (baseUrl) => {
      const page = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
        http.get(`${baseUrl}/`, { headers: { "accept-encoding": "gzip" } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({
            encoding: response.headers["content-encoding"],
            body: Buffer.concat(chunks),
          }));
        }).on("error", reject);
      });
      expect(page.encoding).toBe("gzip");
      expect(gunzipSync(page.body).toString("utf8")).toContain("Pint Path");

      const health = await fetch(`${baseUrl}/health`, { headers: { "accept-encoding": "gzip" } });
      expect(health.headers.get("content-encoding")).toBeNull();
    });
  });

  it("forces unversioned JavaScript and CSS to revalidate after every deploy", () => {
    expect(getStaticAssetCacheControl("/app/viewer/business.js", "production"))
      .toBe("public, max-age=0, must-revalidate");
    expect(getStaticAssetCacheControl("/app/viewer/business.css", "production"))
      .toBe("public, max-age=0, must-revalidate");
    expect(getStaticAssetCacheControl("/app/viewer/account.html", "production")).toBe("no-store");
    expect(getStaticAssetCacheControl("/app/viewer/assets/logo.png", "production"))
      .toContain("max-age=86400");
    expect(getStaticAssetCacheControl("/app/viewer/assets/logo.png", "production", true)).toBe("no-store");
    expect(getStaticAssetCacheControl(
      "/app/viewer/assets/logo.png",
      "production",
      false,
      true,
    )).toBe("no-store");
  });

  it("prevents every Pint Path page from being embedded in another frame", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });
  });
});
