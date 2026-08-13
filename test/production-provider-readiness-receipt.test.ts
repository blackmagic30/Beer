import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseProductionProviderReadinessEnvelope,
  productionProviderReadinessReceiptInternals,
  runProductionProviderReadinessReceiptVerification,
} from "../scripts/verify-production-provider-readiness-receipt.mjs";

const CANDIDATE = "a".repeat(40);
const DEPLOYED = "b".repeat(40);
const OBSERVED_AT = "2026-08-13T00:00:00.000Z";
const temporaryDirectories: string[] = [];

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture(): { envelope: string; readiness: Record<string, unknown> } {
  const checks = productionProviderReadinessReceiptInternals.REQUIRED_CHECK_IDS
    .map((id) => ({
      id,
      label: `Passing ${id}`,
      status: "pass",
      action: null,
    }));
  const readiness = {
    ok: true,
    environment: "production",
    readinessProfile: "production_free_launch",
    strictLaunchCheck: true,
    summary: {
      passed: checks.length,
      warnings: 0,
      blockingWarnings: 0,
      failures: 0,
    },
    postgresAuthority: {
      schemaVersion: "pintpath-postgres-runtime-authority-readiness/v1",
      applicationUrlSha256: "1".repeat(64),
      maintenanceUrlSha256: "2".repeat(64),
      rootCaPemSha256: "3".repeat(64),
      rootCaDerSha256: "4".repeat(64),
      applicationUrlExact: true,
      maintenanceUrlExact: true,
      sameDatabaseTarget: true,
      distinctLoginRoles: true,
      rootCaExact: true,
    },
    checks,
  };
  const readinessSource = productionProviderReadinessReceiptInternals
    .canonicalJson(readiness);
  const envelope = productionProviderReadinessReceiptInternals.canonicalJson({
    schemaVersion: "pintpath-production-provider-readiness-envelope/v2",
    candidateSha: CANDIDATE,
    observedAt: OBSERVED_AT,
    observedProductionDeploymentSha: DEPLOYED,
    readinessSha256: sha256(readinessSource),
    readiness,
  });
  return { envelope, readiness };
}

function privateFiles(envelope: string): {
  directory: string;
  receipt: string;
  output: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ready-"));
  temporaryDirectories.push(directory);
  fs.chmodSync(directory, 0o700);
  const receipt = path.join(directory, "receipt.json");
  const output = path.join(directory, "verified.json");
  fs.writeFileSync(receipt, envelope, { mode: 0o600 });
  fs.chmodSync(receipt, 0o600);
  return { directory, receipt, output };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("production provider-readiness envelope", () => {
  it("accepts only canonical all-pass strict production readiness", () => {
    const { envelope } = fixture();
    expect(parseProductionProviderReadinessEnvelope(envelope)).not.toBeNull();
    expect(parseProductionProviderReadinessEnvelope(envelope.trimEnd())).toBeNull();
    expect(parseProductionProviderReadinessEnvelope(`${envelope}\n`)).toBeNull();
    expect(parseProductionProviderReadinessEnvelope(
      envelope.replace('"strictLaunchCheck": true', '"strictLaunchCheck": false'),
    )).toBeNull();
    expect(parseProductionProviderReadinessEnvelope(
      envelope.replace('"status": "pass"', '"status": "fail"'),
    )).toBeNull();
    expect(parseProductionProviderReadinessEnvelope(
      envelope.replace('"id": "RAILWAY_DEPLOYED_READINESS_CONTEXT"',
        '"id": "MISSING_REQUIRED_CONTEXT"'),
    )).toBeNull();
    expect(parseProductionProviderReadinessEnvelope(
      envelope.replace(
        '"schemaVersion": "pintpath-production-provider-readiness-envelope/v2"',
        '"schemaVersion": "pintpath-production-provider-readiness-envelope/v1"',
      ),
    )).toBeNull();
  });

  it("requires hash-only exact application, maintenance, and root-CA authority", () => {
    const { envelope } = fixture();
    const value = JSON.parse(envelope) as {
      readiness: {
        postgresAuthority: Record<string, unknown>;
      };
      readinessSha256: string;
    };
    value.readiness.postgresAuthority.rootCaExact = false;
    value.readinessSha256 = sha256(
      productionProviderReadinessReceiptInternals.canonicalJson(value.readiness),
    );
    expect(parseProductionProviderReadinessEnvelope(
      productionProviderReadinessReceiptInternals.canonicalJson(value),
    )).toBeNull();

    const aliased = JSON.parse(envelope) as typeof value;
    aliased.readiness.postgresAuthority.maintenanceUrlSha256 =
      aliased.readiness.postgresAuthority.applicationUrlSha256;
    aliased.readinessSha256 = sha256(
      productionProviderReadinessReceiptInternals.canonicalJson(aliased.readiness),
    );
    expect(parseProductionProviderReadinessEnvelope(
      productionProviderReadinessReceiptInternals.canonicalJson(aliased),
    )).toBeNull();
    expect(envelope).not.toContain("postgresql://");
    expect(envelope).not.toContain("BEGIN CERTIFICATE");
  });

  it("writes a hash-only verification bound to a fresh candidate", async () => {
    const { envelope } = fixture();
    const files = privateFiles(envelope);
    let summary = "";
    const code = await runProductionProviderReadinessReceiptVerification([
      "--receipt", files.receipt,
      "--expected-sha256", sha256(envelope),
      "--candidate-sha", CANDIDATE,
      "--output", files.output,
    ], {
      now: () => new Date("2026-08-13T01:00:00.000Z"),
      writeOutput: (value: string) => { summary += value; },
    });
    expect(code).toBe(0);
    expect(JSON.parse(summary)).toMatchObject({ ok: true, candidateSha: CANDIDATE });
    expect(fs.statSync(files.output).mode & 0o777).toBe(0o600);
    const verified = JSON.parse(fs.readFileSync(files.output, "utf8"));
    expect(verified).toMatchObject({
      schemaVersion: "pintpath-production-provider-readiness-verification/v2",
      candidateSha: CANDIDATE,
      observedProductionDeploymentSha: DEPLOYED,
      envelopeSha256: sha256(envelope),
      postgresAuthority: {
        schemaVersion: "pintpath-postgres-runtime-authority-readiness/v1",
        applicationUrlSha256: "1".repeat(64),
        maintenanceUrlSha256: "2".repeat(64),
        rootCaPemSha256: "3".repeat(64),
        rootCaDerSha256: "4".repeat(64),
        applicationUrlExact: true,
        maintenanceUrlExact: true,
        sameDatabaseTarget: true,
        distinctLoginRoles: true,
        rootCaExact: true,
      },
      strictProductionProviderReadinessExact: true,
    });
    expect(JSON.stringify(verified)).not.toContain("Passing");
  });

  it("fails closed for a stale, wrong-candidate, wrong-hash, or unsafe input", async () => {
    const { envelope } = fixture();
    for (const [label, overrides] of [
      ["stale", { now: "2026-08-15T00:00:00.001Z" }],
      ["candidate", { candidate: "c".repeat(40) }],
      ["hash", { hash: "d".repeat(64) }],
    ] as const) {
      const files = privateFiles(envelope);
      const code = await runProductionProviderReadinessReceiptVerification([
        "--receipt", files.receipt,
        "--expected-sha256", overrides.hash ?? sha256(envelope),
        "--candidate-sha", overrides.candidate ?? CANDIDATE,
        "--output", files.output,
      ], {
        now: () => new Date(overrides.now ?? "2026-08-13T01:00:00.000Z"),
        writeOutput: () => undefined,
      });
      expect(code, label).toBe(1);
      expect(fs.existsSync(files.output), label).toBe(false);
    }
    const unsafe = privateFiles(envelope);
    fs.chmodSync(unsafe.receipt, 0o644);
    const code = await runProductionProviderReadinessReceiptVerification([
      "--receipt", unsafe.receipt,
      "--expected-sha256", sha256(envelope),
      "--candidate-sha", CANDIDATE,
      "--output", unsafe.output,
    ], { writeOutput: () => undefined });
    expect(code).toBe(1);
  });
});
