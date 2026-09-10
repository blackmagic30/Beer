import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalProtectedSourceArchiveManifest,
  loadProtectedSourceArchiveRuntime,
  parseProtectedSourceArchiveManifest,
  parseProtectedSourceArchiveRuntimeResponse,
  protectedSourceArchivePackageRoot,
  PROTECTED_SOURCE_ARCHIVE_FILENAME,
  readProtectedSourceArchiveManifest,
  type ProtectedSourceArchiveManifest,
} from "../src/lib/protected-source-archive.js";
import { railwayDeploymentIdentityHashes } from "../src/lib/railway-deployment-identity.js";

const manifest: ProtectedSourceArchiveManifest = {
  schemaVersion: "protected-source-archive/v1",
  candidateSha: "1".repeat(40),
  treeSha: "2".repeat(40),
  sourceArchiveSha256: "3".repeat(64),
  sourceBaseManifestSha256: "4".repeat(64),
  uploadNonce: "5".repeat(64),
};
const canonical = canonicalProtectedSourceArchiveManifest(manifest);
const identity = {
  ...manifest,
  sourceIdentitySha256: crypto.createHash("sha256").update(canonical).digest("hex"),
};
const scope = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  RAILWAY_DEPLOYMENT_ID: "77b0d060-8438-47bd-97ed-068416afc81e",
  RAILWAY_REPLICA_ID: "archive-runtime-replica",
  PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: manifest.candidateSha,
};
const roots: string[] = [];
function fixture(source: string | null = canonical): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-identity-")));
  roots.push(root);
  if (source !== null) fs.writeFileSync(path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME), source, { mode: 0o444 });
  return root;
}

function response(route: "/health" | "/startup" | "/ready") {
  return {
    ok: true,
    data: {
      service: "pint-path",
      status: route === "/health" ? "ok" : route === "/startup" ? "startup_ready" : "ready",
      deployment: {
        version: "0.1.0", commitSha: "unknown", environment: "production",
        ...railwayDeploymentIdentityHashes(scope), sourceArchive: { ...identity },
      },
      automaticMaintenance: { enabled: false, candidateBound: true },
      ...(route !== "/health" ? {
        dependencies: route === "/ready" ? {
          database: { status: "ok" },
          restoreRehearsal: {
            enabled: false, externalWritesAllowed: true, httpMutationRoutesAllowed: true,
            runtimeDatabase: "primary_runtime_database", remoteVenueDirectoryEnabled: true,
          },
        } : { database: { status: "ok" } },
      } : {}),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("protected source archive identity", () => {
  it("retains ordinary no-manifest deployments without requiring staging configuration", () => {
    expect(loadProtectedSourceArchiveRuntime({ NODE_ENV: "production" }, fixture(null))).toBeNull();
  });

  it("loads a frozen staging identity without manufacturing a Git commit environment variable", () => {
    const environment = { ...scope };
    expect(loadProtectedSourceArchiveRuntime(environment, fixture())).toEqual(identity);
    expect(Object.isFrozen(loadProtectedSourceArchiveRuntime(environment, fixture()))).toBe(true);
    expect(environment).not.toHaveProperty("RAILWAY_GIT_COMMIT_SHA");
  });

  it.each([
    canonical.trimEnd(), canonical.replace("\"candidateSha\":", "\"candidateSha\":\"000\",\"candidateSha\":"),
    canonical.replace("protected-source-archive/v1", "protected-source-archive/v2"),
    canonical.replace(manifest.uploadNonce, "0".repeat(63)),
    canonical.replace("}\n", ",\"extra\":true}\n"),
    "{}\n", " ".repeat(2049),
  ])("rejects noncanonical, malformed or ambiguous manifest bytes (%#)", (source) => {
    expect(parseProtectedSourceArchiveManifest(source)).toBeNull();
    expect(() => readProtectedSourceArchiveManifest(fixture(source))).toThrow();
  });

  it.each([
    ["NODE_ENV", "development"], ["RAILWAY_ENVIRONMENT_NAME", "production"],
    ["RAILWAY_PROJECT_ID", "other"], ["RAILWAY_ENVIRONMENT_ID", "13dab015-df74-45c6-b26f-69323daea99a"],
    ["RAILWAY_SERVICE_ID", "other"], ["PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA", "9".repeat(40)],
    ["RAILWAY_GIT_COMMIT_SHA", "9".repeat(40)], ["GITHUB_SHA", "9".repeat(40)],
    ["VERCEL_GIT_COMMIT_SHA", "invalid"], ["RESTORE_REHEARSAL_MODE", "true"],
    ["POSTGRES_RECOVERY_REHEARSAL_MODE", "true"],
  ])("rejects conflicting scope or identity: %s", (name, value) => {
    expect(() => loadProtectedSourceArchiveRuntime({ ...scope, [name]: value }, fixture())).toThrow();
  });

  it("allows corroborating real Git identity without changing the source provenance", () => {
    expect(loadProtectedSourceArchiveRuntime({ ...scope, RAILWAY_GIT_COMMIT_SHA: manifest.candidateSha }, fixture()))
      .toEqual(identity);
  });

  it("rejects symlinks, hard links, group-writable files and unsafe parent paths", () => {
    const root = fixture();
    const file = path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME);
    const other = fixture(null);
    fs.symlinkSync(file, path.join(other, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    expect(() => readProtectedSourceArchiveManifest(other)).toThrow();
    fs.unlinkSync(path.join(other, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    fs.linkSync(file, path.join(other, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    expect(() => readProtectedSourceArchiveManifest(root)).toThrow();
    fs.unlinkSync(path.join(other, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    fs.chmodSync(file, 0o664);
    expect(() => readProtectedSourceArchiveManifest(root)).toThrow();
    fs.chmodSync(file, 0o444);
    const linkedRoot = path.join(other, "linked");
    fs.symlinkSync(root, linkedRoot);
    expect(() => readProtectedSourceArchiveManifest(linkedRoot)).toThrow();
  });

  it("rejects a path exchanged after opening while reading only the original descriptor", () => {
    const root = fixture();
    const filename = path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME);
    const original = fs.openSync;
    const observedDescriptors: unknown[] = [];
    const originalRead = fs.readSync;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = original(...args);
      if (args[0] === filename) {
        fs.renameSync(filename, `${filename}.held`);
        fs.symlinkSync(`${filename}.held`, filename);
      }
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      observedDescriptors.push(args[0]);
      return originalRead(...args);
    }) as typeof fs.readSync);
    expect(() => readProtectedSourceArchiveManifest(root)).toThrow();
    expect(observedDescriptors.length).toBeGreaterThan(0);
    expect(observedDescriptors.every((value) => typeof value === "number")).toBe(true);
  });

  it("resolves source and compiled artifact roots independently of cwd", () => {
    expect(protectedSourceArchivePackageRoot("file:///app/src/lib/protected-source-archive.ts")).toBe("/app");
    expect(protectedSourceArchivePackageRoot("file:///app/dist/src/lib/protected-source-archive.js")).toBe("/app/dist");
  });

  it.each(["/health", "/startup", "/ready"] as const)("accepts actual %s archive shape including disabled restore state", (route) => {
    const source = JSON.stringify(response(route));
    const parsed = parseProtectedSourceArchiveRuntimeResponse(route, source);
    expect(parsed?.deployment.sourceArchive).toEqual(identity);
    expect(parsed?.deployment.commitSha).toBe("unknown");
    expect(parsed?.responseSha256).toBe(crypto.createHash("sha256").update(source).digest("hex"));
  });

  it.each([
    "wrong-candidate", "wrong-nonce", "wrong-identity-hash", "wrong-environment", "wrong-git", "invalid-git",
    "workers-enabled", "unbound", "wrong-status", "restore", "extra-deployment-field", "missing-replica",
  ])("rejects mismatched runtime evidence: %s", (mutation) => {
    const value = response("/ready");
    const deployment = value.data.deployment;
    if (mutation === "wrong-candidate") deployment.sourceArchive.candidateSha = "9".repeat(40);
    if (mutation === "wrong-nonce") deployment.sourceArchive.uploadNonce = "9".repeat(64);
    if (mutation === "wrong-identity-hash") deployment.sourceArchive.sourceIdentitySha256 = "9".repeat(64);
    if (mutation === "wrong-environment") deployment.environmentIdSha256 = "9".repeat(64);
    if (mutation === "wrong-git") deployment.commitSha = "9".repeat(40);
    if (mutation === "invalid-git") deployment.commitSha = "not-git";
    if (mutation === "workers-enabled") value.data.automaticMaintenance.enabled = true;
    if (mutation === "unbound") value.data.automaticMaintenance.candidateBound = false;
    if (mutation === "wrong-status") value.data.status = "not_ready";
    if (mutation === "restore") Object.assign(value.data, { restoreRehearsal: { enabled: true } });
    if (mutation === "extra-deployment-field") Object.assign(deployment, { verified: true });
    if (mutation === "missing-replica") delete deployment.replicaIdSha256;
    expect(parseProtectedSourceArchiveRuntimeResponse("/ready", JSON.stringify(value))).toBeNull();
  });

  it("copies the exact manifest into the compiled artifact and refuses stale or malformed identity", async () => {
    const root = fixture();
    const script = path.resolve("scripts/verify-production-artifact.mjs");
    const required = [
      "dist/src/server.js", "dist/src/db/schema.sql", "dist/src/db/postgres-schema.sql",
      ...["index.html", "404.html", "account.html", "admin.html", "auth/callback.html", "business.css",
        "business.js", "site.webmanifest", "venue-portal.html"].map((name) => `dist/viewer/${name}`),
    ];
    for (const name of required) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), "fixture");
    }
    execFileSync(process.execPath, [script], { cwd: root });
    expect(fs.readFileSync(path.join(root, "dist", PROTECTED_SOURCE_ARCHIVE_FILENAME), "utf8")).toBe(canonical);
    fs.mkdirSync(path.join(root, "dist/src/lib"), { recursive: true });
    for (const name of ["protected-source-archive.js", "railway-deployment-identity.js"]) {
      fs.copyFileSync(path.resolve("dist/src/lib", name), path.join(root, "dist/src/lib", name));
    }
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    const compiled = await import(pathToFileURL(path.join(root, "dist/src/lib/protected-source-archive.js")).href);
    expect(compiled.loadProtectedSourceArchiveRuntime(scope)).toEqual(identity);
    expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" })).not.toThrow();
    fs.unlinkSync(path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    fs.writeFileSync(path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME),
      canonicalProtectedSourceArchiveManifest({ ...manifest, uploadNonce: "9".repeat(64) }));
    expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" })).toThrow();
    fs.unlinkSync(path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME));
    expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" })).toThrow();
    fs.unlinkSync(path.join(root, "dist", PROTECTED_SOURCE_ARCHIVE_FILENAME));
    expect(() => execFileSync(process.execPath, [script], { cwd: root })).not.toThrow();
    fs.writeFileSync(path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME), "{}\n");
    expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" })).toThrow();
  });
});
