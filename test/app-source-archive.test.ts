import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/protected-source-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protected-source-archive.js")>();
  const crypto = await import("node:crypto");
  const manifest = {
    schemaVersion: "protected-source-archive/v1" as const,
    candidateSha: "1".repeat(40), treeSha: "2".repeat(40),
    sourceArchiveSha256: "3".repeat(64), sourceBaseManifestSha256: "4".repeat(64),
    uploadNonce: "5".repeat(64),
  };
  const identity = Object.freeze({
    ...manifest,
    sourceIdentitySha256: crypto.createHash("sha256")
      .update(actual.canonicalProtectedSourceArchiveManifest(manifest)).digest("hex"),
  });
  return { ...actual, loadProtectedSourceArchiveRuntime: () => identity };
});

import { createApp, shouldRunAutomaticMaintenance, shutdownAppServices } from "../src/app.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownAppServices();
});

it("exposes the same loaded archive on health/startup/ready without inventing Git metadata", async () => {
  for (const key of ["RAILWAY_GIT_COMMIT_SHA", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"]) vi.stubEnv(key, undefined);
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const responses = [];
    for (const route of ["/health", "/startup", "/ready"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json();
      expect(payload.data.deployment.commitSha).toBe("unknown");
      expect(payload.data.deployment.sourceArchive).toMatchObject({
        schemaVersion: "protected-source-archive/v1", candidateSha: "1".repeat(40), uploadNonce: "5".repeat(64),
      });
      expect(payload.data.automaticMaintenance).toEqual({ enabled: false, candidateBound: true });
      responses.push(payload.data.deployment.sourceArchive);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
    expect(process.env.RAILWAY_GIT_COMMIT_SHA).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("forces workers off for archive runtime even when a flag and matching genuine Git SHA would enable them", () => {
  const candidate = "1".repeat(40);
  expect(shouldRunAutomaticMaintenance("production", false, false, true, candidate, candidate)).toBe(false);
  expect(shouldRunAutomaticMaintenance("production", false, false, true, candidate, candidate, null)).toBe(true);
});


it("honors the protected worker activation phase for an already validated production archive", () => {
  const candidate = "1".repeat(40);
  const identity = {
    schemaVersion: "protected-source-archive/v2" as const, target: "production" as const,
    candidateSha: candidate, treeSha: "2".repeat(40), sourceArchiveSha256: "3".repeat(64),
    sourceBaseManifestSha256: "4".repeat(64), uploadNonce: "5".repeat(64), sourceIdentitySha256: "6".repeat(64),
  };
  expect(shouldRunAutomaticMaintenance("production", false, false, false, candidate, undefined, identity)).toBe(false);
  expect(shouldRunAutomaticMaintenance("production", false, false, true, candidate, undefined, identity)).toBe(true);
  expect(shouldRunAutomaticMaintenance("production", false, false, true, "9".repeat(40), undefined, identity)).toBe(false);
  expect(shouldRunAutomaticMaintenance("production", true, false, true, candidate, undefined, identity)).toBe(false);
  expect(shouldRunAutomaticMaintenance("production", false, true, true, candidate, undefined, identity)).toBe(false);
});
