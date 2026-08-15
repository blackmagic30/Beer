import crypto from "node:crypto";
import fs, {
  closeSync as nativeCloseSync,
  readSync as nativeReadSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
  PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION,
  protectedProductionPostgresSourcePinInternals,
  runProtectedProductionPostgresSourcePin,
} from "../scripts/execute-protected-production-postgres-source-pin.js";

const CANDIDATE = "a".repeat(40);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const RECOVERY = path.join(REPOSITORY_ROOT, ".missing-source-pin-recovery.json");
const EVIDENCE = path.join(REPOSITORY_ROOT, ".missing-source-pin-evidence");
const DATABASE_URL = path.join(REPOSITORY_ROOT, ".missing-source-pin-db-url");
const ROOT_CA = path.join(REPOSITORY_ROOT, ".missing-source-pin-root-ca.pem");

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function recoveryAuthority(now = Date.parse("2026-08-15T01:00:00.000Z")) {
  const runId = "12345";
  const payload = {
    schemaVersion: "pintpath-production-postgres-source-pin-recovery-authority/v1",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    workflowPath: ".github/workflows/production-logical-backup.yml",
    workflowRunId: runId,
    workflowRunAttempt: 1,
    workflowRunStartedAt: new Date(now - 60 * 60_000).toISOString(),
    workflowRunCompletedAt: new Date(now - 20 * 60_000).toISOString(),
    backupArtifact: {
      id: 101,
      name: `production-logical-backup-receipts-${runId}-1`,
      digest: `sha256:${"1".repeat(64)}`,
      sizeBytes: 1024,
      receiptSetSha256: "1".repeat(64),
    },
    restoreArtifact: {
      id: 102,
      name: `production-restore-drill-receipts-${runId}-1`,
      digest: `sha256:${"2".repeat(64)}`,
      sizeBytes: 2048,
      receiptSetSha256: "2".repeat(64),
    },
    recovery: {
      backupCreatedAt: new Date(now - 55 * 60_000).toISOString(),
      completedAt: new Date(now - 50 * 60_000).toISOString(),
      manifestSha256: "3".repeat(64),
      archiveSha256: "4".repeat(64),
      stateReceiptSha256: "5".repeat(64),
      overallStateSha256: "6".repeat(64),
      sourceDatabaseIdentitySha256: "7".repeat(64),
      successStateSha256: "8".repeat(64),
      wormReceiptSha256: "9".repeat(64),
      minimumRetainUntil: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
      retrievedAt: new Date(now - 40 * 60_000).toISOString(),
      restoredAt: new Date(now - 30 * 60_000).toISOString(),
      restoreReceiptSha256: "a".repeat(64),
      restoreTargetIdentitySha256: "b".repeat(64),
      receiptFilesSha256: "c".repeat(64),
    },
    checks: {
      exactCandidateRun: true,
      exactBackupArtifact: true,
      exactRestoreArtifact: true,
      crossCopyBindingsExact: true,
      databaseIdentityBound: true,
      restoreDrillExact: true,
      freshnessExact: true,
      wormRetentionExact: true,
    },
  };
  return {
    ...payload,
    authoritySha256: hash(canonical(payload)),
  };
}

function resignRecovery(value: Record<string, unknown>): string {
  const { authoritySha256: _discarded, ...payload } = value;
  return canonical({ ...payload, authoritySha256: hash(canonical(payload)) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function environment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_RUN_ID: "12345",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_PIN_CONFIRMATION:
      "PIN_PRODUCTION_POSTGRES_SOURCE_TO_OBSERVED_DIGEST",
  };
}

async function blockedRun(overrides: Parameters<
  typeof runProtectedProductionPostgresSourcePin
>[0] = {}) {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const runBoundary = vi.fn(async () => ({ exact: true, receiptSha256: "b".repeat(64) }));
  let output = "";
  const code = await runProtectedProductionPostgresSourcePin({
    argv: [
      "--candidate-sha",
      CANDIDATE,
      "--recovery-authority",
      RECOVERY,
      "--expected-recovery-authority-file-sha256",
      "c".repeat(64),
      "--expected-prepared-artifact-id",
      "123",
      "--expected-prepared-artifact-digest",
      `sha256:${"d".repeat(64)}`,
      "--evidence-dir",
      EVIDENCE,
      "--database-url-file",
      DATABASE_URL,
      "--root-ca-file",
      ROOT_CA,
    ],
    cwd: REPOSITORY_ROOT,
    env: environment(),
    fetchImpl,
    runBoundary,
    writeOutput: (source) => {
      output += source;
    },
    ...overrides,
  });
  return {
    code,
    fetchImpl,
    runBoundary,
    receipt: JSON.parse(output) as Record<string, unknown>,
  };
}

describe("protected production Postgres source pin", () => {
  it("hard-stops the checked-in blocked policy before every provider call", async () => {
    const verifyCompatibility = vi.fn(() => true);
    const result = await blockedRun({ verifyCompatibility });

    expect(result.code).toBe(1);
    expect(result.fetchImpl).not.toHaveBeenCalled();
    expect(result.runBoundary).not.toHaveBeenCalled();
    expect(verifyCompatibility).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        policyExact: true,
        policyActivationExact: false,
        compatibilityAuthorityExact: false,
      },
    });
  });

  it("hard-stops an absent compatibility proof before provider calls", async () => {
    const result = await blockedRun({ verifyPolicyActivation: () => true });

    expect(result.code).toBe(1);
    expect(result.fetchImpl).not.toHaveBeenCalled();
    expect(result.runBoundary).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      attempts: 0,
      checks: {
        policyActivationExact: true,
        compatibilityAuthorityExact: false,
      },
    });
  });

  it("hard-stops a missing exact recovery authority before provider calls", async () => {
    const result = await blockedRun({
      verifyPolicyActivation: () => true,
      verifyCompatibility: () => true,
    });

    expect(result.code).toBe(1);
    expect(result.fetchImpl).not.toHaveBeenCalled();
    expect(result.runBoundary).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      attempts: 0,
      checks: {
        policyActivationExact: true,
        compatibilityAuthorityExact: true,
        recoveryAuthorityExact: false,
      },
    });
  });

  it("requires both independent activation flags", () => {
    const policy = protectedProductionPostgresSourcePinInternals.readPolicy(
      REPOSITORY_ROOT,
    );
    expect(policy).not.toBeNull();
    const active = {
      activationState: "ACTIVE_PINNED_AUTHORITIES",
      compatibilityAuthority: {
        ...policy!.compatibilityAuthority,
        state: "PROVEN_PINNED",
        productionMutationAllowed: true,
      },
      databaseIdentityAuthority: {
        ...policy!.databaseIdentityAuthority,
        state: "ACTIVE_PINNED_READ_ONLY_PRE_POST_INSPECTOR",
        productionMutationAllowed: true,
      },
      durabilityAuthority: {
        ...policy!.durabilityAuthority,
        state: "ACTIVE_PINNED_DURABILITY",
        productionMutationAllowed: true,
      },
    };
    expect(
      protectedProductionPostgresSourcePinInternals.defaultPolicyActivation(active),
    ).toBe(true);
    const compatibilityBlocked = {
      ...active,
      compatibilityAuthority: {
        ...active.compatibilityAuthority,
        productionMutationAllowed: false,
      },
    };
    expect(
      protectedProductionPostgresSourcePinInternals.defaultPolicyActivation(
        compatibilityBlocked,
      ),
    ).toBe(false);
    const identityBlocked = {
      ...active,
      databaseIdentityAuthority: {
        ...active.databaseIdentityAuthority,
        productionMutationAllowed: false,
      },
    };
    expect(
      protectedProductionPostgresSourcePinInternals.defaultPolicyActivation(
        identityBlocked,
      ),
    ).toBe(false);
    const durabilityBlocked = {
      ...active,
      durabilityAuthority: {
        ...active.durabilityAuthority,
        productionMutationAllowed: false,
      },
    };
    expect(
      protectedProductionPostgresSourcePinInternals.defaultPolicyActivation(
        durabilityBlocked,
      ),
    ).toBe(false);
  });

  it("keeps the checked policy blocked without human approval until both machine authorities exist", () => {
    const policy = protectedProductionPostgresSourcePinInternals.readPolicy(
      REPOSITORY_ROOT,
    );
    expect(policy).not.toBeNull();
    expect(policy!.compatibilityAuthority).toMatchObject({
      state: "UNPROVEN_BLOCKED",
      productionMutationAllowed: false,
    });
    expect(policy!.durabilityAuthority).toMatchObject({
      state: "BLOCKED_PENDING_IMMUTABLE_OFF_RUNNER_INTENT_AND_RECONCILER",
      productionMutationAllowed: false,
    });
    expect(
      protectedProductionPostgresSourcePinInternals.defaultPolicyActivation(
        policy!,
      ),
    ).toBe(false);
  });

  it("accepts only the exact full canonical recovery authority schema", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-schema-"));
    const filename = path.join(root, "recovery-authority.json");
    const now = Date.parse("2026-08-15T01:00:00.000Z");
    fs.chmodSync(root, 0o700);
    try {
      const valid = recoveryAuthority(now);
      fs.writeFileSync(filename, canonical(valid), { mode: 0o600 });
      expect(
        protectedProductionPostgresSourcePinInternals.readRecoveryAuthority(
          filename,
          CANDIDATE,
          now,
        ),
      ).toMatchObject({
        sourceDatabaseIdentitySha256: "7".repeat(64),
        workflowRunId: "12345",
      });

      const adversarial = [
        { ...valid, checks: {} },
        { ...valid, unexpected: true },
        {
          ...valid,
          recovery: Object.fromEntries(
            Object.entries(valid.recovery).filter(([key]) => key !== "archiveSha256"),
          ),
        },
      ];
      for (const value of adversarial) {
        fs.writeFileSync(filename, resignRecovery(value), { mode: 0o600 });
        expect(
          protectedProductionPostgresSourcePinInternals.readRecoveryAuthority(
            filename,
            CANDIDATE,
            now,
          ),
        ).toBeNull();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a locally substituted recovery file against the independent producer hash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-binding-"));
    const filename = path.join(root, "recovery-authority.json");
    const now = Date.parse("2026-08-15T01:00:00.000Z");
    fs.chmodSync(root, 0o700);
    try {
      const originalSource = canonical(recoveryAuthority(now));
      fs.writeFileSync(filename, originalSource, { mode: 0o600 });
      const substituted = recoveryAuthority(now);
      substituted.backupArtifact.id = 777;
      const substitutedSource = resignRecovery(substituted);
      fs.writeFileSync(filename, substitutedSource, { mode: 0o600 });
      const parsedRecovery = protectedProductionPostgresSourcePinInternals
        .readRecoveryAuthority(filename, CANDIDATE, now);
      expect(parsedRecovery).not.toBeNull();
      const args = protectedProductionPostgresSourcePinInternals.parseArgs([
        "--candidate-sha",
        CANDIDATE,
        "--recovery-authority",
        filename,
        "--expected-recovery-authority-file-sha256",
        hash(originalSource),
        "--expected-prepared-artifact-id",
        "123",
        "--expected-prepared-artifact-digest",
        `sha256:${"d".repeat(64)}`,
        "--evidence-dir",
        path.join(root, "evidence"),
        "--database-url-file",
        path.join(root, "database-url"),
        "--root-ca-file",
        path.join(root, "root-ca.pem"),
      ]);
      expect(args).not.toBeNull();
      expect(
        protectedProductionPostgresSourcePinInternals.readPreparedAuthority(
          args!,
          parsedRecovery!,
        ),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recomputes phase-bound database observation hashes internally", () => {
    const observation = {
      identitySha256: "d".repeat(64),
      inRecovery: false as const,
    };
    const pre = protectedProductionPostgresSourcePinInternals
      .databaseObservationSha256("prewrite", CANDIDATE, observation);
    const post = protectedProductionPostgresSourcePinInternals
      .databaseObservationSha256("postflight", CANDIDATE, observation);

    expect(pre).toMatch(/^[a-f0-9]{64}$/);
    expect(post).toMatch(/^[a-f0-9]{64}$/);
    expect(pre).not.toBe(post);
  });

  it("contains one exact no-retry atomic source patch and inventories all deployments", () => {
    expect(PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION).toContain(
      "environmentPatchCommit",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION.match(/mutation\s+/g)).toHaveLength(1);
    expect(PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION).not.toMatch(/retry|idempotency/i);
    expect(PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY).toContain(
      "deployments(\n    input: {\n      projectId: $projectId\n      environmentId: $environmentId\n    }",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY).not.toContain(
      "serviceId: $serviceId",
    );
  });

  it("opens filesystem authorities before pathname metadata validation", () => {
    const moduleSource = fs.readFileSync(
      path.join(
        REPOSITORY_ROOT,
        "scripts/execute-protected-production-postgres-source-pin.ts",
      ),
      "utf8",
    );
    for (const source of [
      moduleSource.slice(
        moduleSource.indexOf("function privateFile("),
        moduleSource.indexOf("function readRecoveryAuthority("),
      ),
      moduleSource.slice(
        moduleSource.indexOf("function openEvidenceCustody("),
        moduleSource.indexOf(
          "export async function runProtectedProductionPostgresSourcePin(",
        ),
      ),
    ]) {
      expect(source.indexOf("fs.openSync(")).toBeGreaterThanOrEqual(0);
      expect(source.indexOf("fs.openSync(")).toBeLessThan(
        source.indexOf("fs.lstatSync("),
      );
      expect(source).toContain("fs.constants.O_NOFOLLOW");
      expect(source).toContain("fs.constants.O_NONBLOCK");
    }
  });

  it("reads recovery authority through one descriptor and rejects unsafe modes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-reader-"));
    const filename = path.join(root, "authority.json");
    try {
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(filename, "{}", { mode: 0o600 });
      let closeCalls = 0;
      vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
        closeCalls += 1;
        nativeCloseSync(descriptor);
      });

      expect(
        protectedProductionPostgresSourcePinInternals.privateFile(filename, 32),
      ).toEqual(Buffer.from("{}"));
      expect(closeCalls).toBe(1);

      fs.chmodSync(filename, 0o644);
      expect(
        protectedProductionPostgresSourcePinInternals.privateFile(filename, 32),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks and a pathname swap after descriptor open", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-swap-"));
    const filename = path.join(root, "authority.json");
    const symlink = path.join(root, "authority-link.json");
    try {
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(filename, "{}", { mode: 0o600 });
      fs.symlinkSync(filename, symlink);
      expect(
        protectedProductionPostgresSourcePinInternals.privateFile(symlink, 32),
      ).toBeNull();

      let swapped = false;
      vi.spyOn(fs, "readSync").mockImplementation((...arguments_) => {
        const count = nativeReadSync(...arguments_);
        if (!swapped && count > 0) {
          swapped = true;
          fs.renameSync(filename, `${filename}.opened`);
          fs.writeFileSync(filename, "{}", { mode: 0o600 });
        }
        return count;
      });
      expect(
        protectedProductionPostgresSourcePinInternals.privateFile(filename, 32),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when descriptor cleanup fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-close-"));
    const filename = path.join(root, "authority.json");
    try {
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(filename, "{}", { mode: 0o600 });
      vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
        nativeCloseSync(descriptor);
        throw new Error("synthetic-close-failure");
      });

      expect(
        protectedProductionPostgresSourcePinInternals.privateFile(filename, 32),
      ).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
