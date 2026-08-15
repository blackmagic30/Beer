import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  productionPostgresSourcePinRecoveryInternals,
  runProductionPostgresSourcePinRecoveryMaterializer,
} from "../scripts/materialize-production-postgres-source-pin-recovery-authority.mjs";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";

const RUN_START = Date.parse("2026-08-15T00:00:00.000Z");
const RUN_COMPLETE = Date.parse("2026-08-15T00:40:00.000Z");
const NOW = Date.parse("2026-08-15T00:45:00.000Z");
const CANDIDATE = "a".repeat(40);
const BACKUP_RUN_ID = "12345";

afterEach(() => {
  vi.restoreAllMocks();
});

function digest(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function digestBytes(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalPostgresBackupJson(value), "utf8");
}

function recoveryFixture() {
  const archiveSha256 = digest("archive");
  const manifestSha256 = digest("manifest");
  const stateReceiptSha256 = digest("state-receipt");
  const overallStateSha256 = digest("overall-state");
  const sourceDatabaseIdentitySha256 = digest("source-database");
  const backupIdSha256 = digest("backup-id");
  const successStateSha256 = digest("success-state");
  const targetIdentitySha256 = digest("disposable-target");
  const backupCreatedAt = "2026-08-15T00:01:00.000Z";
  const offsiteCompletedAt = "2026-08-15T00:10:00.000Z";
  const wormCompletedAt = "2026-08-15T00:11:00.000Z";
  const retrievedAt = "2026-08-15T00:20:00.000Z";
  const restoredAt = "2026-08-15T00:30:00.000Z";
  const minimumRetainUntil = "2026-09-14T00:45:00.000Z";
  const backup = {
    schemaVersion: 3,
    ok: true,
    archiveSha256,
    manifestSha256,
    stateReceiptSha256,
    authoritativeRowCount: "42",
    overallStateSha256,
  };
  const offsite = {
    schemaVersion: 1,
    ok: true,
    backupCreatedAt,
    completedAt: offsiteCompletedAt,
    archiveSha256,
    manifestSha256,
    stateReceiptSha256,
    overallStateSha256,
    sourceDatabaseIdentitySha256,
    remoteObjectSetSha256: digest("remote-object-set"),
    attestationSha256: digest("offsite-attestation"),
    latestPointerSha256: digest("latest-pointer"),
    backupIdSha256,
    successStateSha256,
  };
  const worm = {
    schemaVersion: 1,
    ok: true,
    backupCreatedAt,
    completedAt: wormCompletedAt,
    archiveSha256,
    manifestSha256,
    stateReceiptSha256,
    overallStateSha256,
    backupIdSha256,
    recoveryAccountIdSha256: digest("recovery-account"),
    bucketNameSha256: digest("worm-bucket"),
    writerPrincipalArnSha256: digest("worm-writer"),
    readerPrincipalArnSha256: digest("worm-reader"),
    immutableObjectSetSha256: digest("immutable-object-set"),
    writerDenialSetSha256: digest("writer-denial-set"),
    receiptSha256: digest("worm-receipt"),
    receiptObjectKeySha256: digest("worm-receipt-object-key"),
    receiptVersionIdSha256: digest("worm-receipt-version"),
    receiptDenialSetSha256: digest("receipt-denial-set"),
    minimumRetainUntil,
  };
  const retrieval = {
    schemaVersion: 1,
    kind: "pintpath-postgres-logical-offsite-retrieval",
    ok: true,
    retrievedAt,
    successStateSha256,
    backupCreatedAt,
    backupIdSha256,
    latestPointerSha256: offsite.latestPointerSha256,
    attestationSha256: offsite.attestationSha256,
    remoteObjectSetSha256: offsite.remoteObjectSetSha256,
    archiveSha256,
    manifestSha256,
    stateReceiptSha256,
    sourceDatabaseIdentitySha256,
    overallStateSha256,
    archiveBytes: 1_024,
    manifestBytes: 512,
    stateReceiptBytes: 256,
    localArtifactSetSha256: digest("local-artifact-set"),
  };
  const target = {
    schemaVersion: 1,
    ok: true,
    command: "inspect-target",
    targetIdentitySha256,
    disposableTarget: true,
    privateSchemasAbsent: true,
  };
  const restoreReceipt = {
    kind: "pintpath-postgres-logical-restore-rehearsal",
    version: 1,
    status: "verified",
    restoredAt,
    backupManifestSha256: manifestSha256,
    backupArchiveSha256: archiveSha256,
    targetIdentitySha256,
    targetUrlSha256: digest("target-url"),
    authoritativeTableCount: 12,
    authoritativeColumnCount: 84,
    foreignKeyCount: 20,
    authoritativeRowCount: backup.authoritativeRowCount,
    nonEmptyAuthoritativeTableCount: 9,
    authoritativeCountInventorySha256: digest("authoritative-count-inventory"),
    controlCountInventorySha256: digest("control-count-inventory"),
    schemaMetadataSha256: digest("schema-metadata"),
    rowSecurityTableCount: 12,
    aclContractSha256: digest("acl-contract"),
    apiRolesIsolated: true,
    runtimeApplicationAccessRestored: true,
    migratorReconciliationAccessVerified: true,
    runtimeOperationsIsolated: true,
    promotionReconciliationReady: true,
    sourceStateBindingStatus: "exact-match",
    expectedSourceStateReceiptSha256: stateReceiptSha256,
    sourceSnapshotBindingSha256: digest("source-snapshot-binding"),
    expectedSourceTableSetSha256: digest("source-table-set"),
    expectedSourceDataSha256: digest("source-data"),
    expectedSourceStateTotalsSha256: digest("source-state-totals"),
    expectedSourceKeyRangesSha256: digest("source-key-ranges"),
    expectedArchivedControlTableSetSha256: digest("archived-control-table-set"),
    expectedArchivedControlDataSha256: digest("archived-control-data"),
    expectedArchivedControlKeyRangesSha256: digest("archived-control-key-ranges"),
    expectedSourceOverallStateSha256: overallStateSha256,
    restoredOverallStateSha256: overallStateSha256,
    exactDataReconciliation: "canonical-contract-exact",
  };
  const restoreReceiptBytes = canonicalBytes(restoreReceipt);
  const restore = {
    schemaVersion: 1,
    ok: true,
    command: "restore",
    receiptSha256: crypto.createHash("sha256").update(restoreReceiptBytes).digest("hex"),
    backupManifestSha256: manifestSha256,
    backupArchiveSha256: archiveSha256,
    targetIdentitySha256,
    authoritativeRowCount: backup.authoritativeRowCount,
    nonEmptyAuthoritativeTableCount: restoreReceipt.nonEmptyAuthoritativeTableCount,
    authoritativeCountInventorySha256:
      restoreReceipt.authoritativeCountInventorySha256,
    overallStateSha256,
    promotionReconciliationReady: true,
    sourceStateBindingStatus: "exact-match",
  };
  return {
    backupEntries: new Map<string, Buffer>([
      ["logical-backup-result.json", canonicalBytes(backup)],
      ["logical-offsite-result.json", canonicalBytes(offsite)],
      ["logical-worm-result.json", canonicalBytes(worm)],
    ]),
    restoreEntries: new Map<string, Buffer>([
      ["retrieval-result.json", canonicalBytes(retrieval)],
      ["target-inspection.json", canonicalBytes(target)],
      ["restore-receipt.json", restoreReceiptBytes],
      ["restore-result.json", canonicalBytes(restore)],
    ]),
  };
}

function validate(
  backupEntries: Map<string, Buffer>,
  restoreEntries: Map<string, Buffer>,
) {
  return productionPostgresSourcePinRecoveryInternals.validateReceipts(
    backupEntries,
    restoreEntries,
    NOW,
    { createdAt: RUN_START, startedAt: RUN_START, completedAt: RUN_COMPLETE },
  );
}

describe("production Postgres source-pin recovery authority", () => {
  it("materializes one exact authority in the workflow-equivalent empty custody root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-recovery-"));
    const outputRoot = path.join(root, "recovery-output");
    const output = path.join(outputRoot, "recovery-authority.json");
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    const fixture = recoveryFixture();
    const backupArchive = Buffer.from("synthetic-backup-artifact", "utf8");
    const restoreArchive = Buffer.from("synthetic-restore-artifact", "utf8");
    const backupDigest = `sha256:${crypto.createHash("sha256").update(backupArchive).digest("hex")}`;
    const restoreDigest = `sha256:${crypto.createHash("sha256").update(restoreArchive).digest("hex")}`;
    const backupName = `production-logical-backup-receipts-${BACKUP_RUN_ID}-1`;
    const restoreName = `production-restore-drill-receipts-${BACKUP_RUN_ID}-1`;
    const artifacts = [
      {
        id: 101,
        name: backupName,
        size_in_bytes: backupArchive.length,
        digest: backupDigest,
        expired: false,
        workflow_run: { id: Number(BACKUP_RUN_ID), head_sha: CANDIDATE },
      },
      {
        id: 102,
        name: restoreName,
        size_in_bytes: restoreArchive.length,
        digest: restoreDigest,
        expired: false,
        workflow_run: { id: Number(BACKUP_RUN_ID), head_sha: CANDIDATE },
      },
    ];
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/actions/runs/${BACKUP_RUN_ID}`)) {
        return json({
          id: Number(BACKUP_RUN_ID),
          repository: { full_name: "blackmagic30/Beer" },
          head_repository: { full_name: "blackmagic30/Beer" },
          head_sha: CANDIDATE,
          head_branch: "main",
          path: ".github/workflows/production-logical-backup.yml",
          event: "workflow_dispatch",
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          created_at: "2026-08-15T00:00:00.000Z",
          run_started_at: "2026-08-15T00:00:00.000Z",
          updated_at: "2026-08-15T00:40:00.000Z",
        });
      }
      if (url.includes(`/actions/runs/${BACKUP_RUN_ID}/artifacts?`)) {
        return json({ total_count: 2, artifacts });
      }
      for (const [artifact, bytes] of [
        [artifacts[0]!, backupArchive],
        [artifacts[1]!, restoreArchive],
      ] as const) {
        if (url.endsWith(`/actions/artifacts/${artifact.id}`)) {
          return json({
            ...artifact,
            archive_download_url:
              `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${artifact.id}/zip`,
          });
        }
        if (url.endsWith(`/actions/artifacts/${artifact.id}/zip`)) {
          return new Response(bytes, { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    let stdout = "";
    try {
      const code = await runProductionPostgresSourcePinRecoveryMaterializer(
        [
          "--candidate-sha",
          CANDIDATE,
          "--backup-run-id",
          BACKUP_RUN_ID,
          "--output",
          output,
        ],
        {
          env: {
            GITHUB_ACTIONS: "true",
            GITHUB_REF: "refs/heads/main",
            GITHUB_REPOSITORY: "blackmagic30/Beer",
            GITHUB_SHA: CANDIDATE,
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_TOKEN: "synthetic-github-token-long-enough", // security-scan allow: synthetic test fixture
          },
          fetchImpl,
          now: () => NOW,
          extractEntries: (_archive: Buffer, _custody: unknown, expected: readonly string[], id: number) => {
            const source = id === 101 ? fixture.backupEntries : fixture.restoreEntries;
            expect([...source.keys()]).toEqual(expected);
            return source;
          },
          writeOutput: (value: string) => {
            stdout += value;
          },
        },
      );
      expect(code).toBe(0);
      expect(fs.readdirSync(outputRoot)).toEqual(["recovery-authority.json"]);
      const receipt = JSON.parse(stdout);
      const bytes = fs.readFileSync(output);
      expect(receipt).toMatchObject({ ok: true, outputSha256: digestBytes(bytes) });
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
        candidateSha: CANDIDATE,
        workflowRunId: BACKUP_RUN_ID,
        checks: { restoreDrillExact: true },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects in-place archive mutation across the descriptor-bound unzip boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-zip-race-"));
    const output = path.join(root, "recovery-authority.json");
    fs.chmodSync(root, 0o700);
    const custody = productionPostgresSourcePinRecoveryInternals
      .holdPrivateParent(output);
    try {
      const archive = Buffer.from("same-length-archive-authority", "utf8");
      const spawnArchive = vi.fn((
        _command: string,
        _arguments: readonly string[],
        _options: { stdio: readonly unknown[] },
      ) => {
        const archivePath = path.join(
          root,
          ".production-source-pin-recovery-777.zip",
        );
        const writer = fs.openSync(archivePath, fs.constants.O_WRONLY);
        try {
          fs.writeSync(writer, Buffer.from("X"), 0, 1, 0);
          fs.fsyncSync(writer);
        } finally {
          fs.closeSync(writer);
        }
        return {
          status: 0,
          signal: null,
          error: undefined,
          stdout: "receipt.json\n",
        };
      });

      expect(() =>
        productionPostgresSourcePinRecoveryInternals.defaultExtractEntries(
          archive,
          custody,
          ["receipt.json"],
          777,
          spawnArchive,
        )
      ).toThrow("production_postgres_source_pin_recovery_artifact_archive_invalid");
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      custody.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on held-parent pollution and replacement", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-pin-parent-"));
    const root = path.join(outer, "authority");
    const moved = path.join(outer, "authority-held");
    fs.mkdirSync(root, { mode: 0o700 });
    const output = path.join(root, "recovery-authority.json");
    const custody = productionPostgresSourcePinRecoveryInternals
      .holdPrivateParent(output);
    try {
      fs.writeFileSync(path.join(root, "pollution"), "x", { mode: 0o600 });
      expect(() =>
        productionPostgresSourcePinRecoveryInternals.writeExclusive(
          output,
          "{}\n",
          custody,
        )
      ).toThrow("production_postgres_source_pin_recovery_output_unsafe");
      fs.unlinkSync(path.join(root, "pollution"));
      fs.renameSync(root, moved);
      fs.mkdirSync(root, { mode: 0o700 });
      expect(() => custody.assertExact()).toThrow(
        "production_postgres_source_pin_recovery_output_unsafe",
      );
      expect(() => custody.close()).toThrow(
        "production_postgres_source_pin_recovery_output_cleanup_failed",
      );
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("accepts the seven exact canonical producer receipts and full bindings", () => {
    const fixture = recoveryFixture();

    expect(validate(fixture.backupEntries, fixture.restoreEntries)).toMatchObject({
      sourceDatabaseIdentitySha256: digest("source-database"),
      restoreTargetIdentitySha256: digest("disposable-target"),
      overallStateSha256: digest("overall-state"),
    });
  });

  it("rejects unknown receipt keys instead of spot-checking a subset", () => {
    const fixture = recoveryFixture();
    const source = fixture.restoreEntries.get("restore-receipt.json")!;
    const value = { ...JSON.parse(source.toString("utf8")), unchecked: true };
    fixture.restoreEntries.set("restore-receipt.json", canonicalBytes(value));

    expect(() => validate(fixture.backupEntries, fixture.restoreEntries)).toThrow(
      "production_postgres_source_pin_recovery_receipt_invalid",
    );
  });

  it("rejects non-canonical JSON before accepting parsed semantics", () => {
    const fixture = recoveryFixture();
    const source = fixture.backupEntries.get("logical-backup-result.json")!;
    fixture.backupEntries.set(
      "logical-backup-result.json",
      Buffer.from(` ${source.toString("utf8")}`, "utf8"),
    );

    expect(() => validate(fixture.backupEntries, fixture.restoreEntries)).toThrow(
      "production_postgres_source_pin_recovery_receipt_invalid",
    );
  });

  it("rejects ACL and role evidence that is not exactly verified", () => {
    const fixture = recoveryFixture();
    const source = fixture.restoreEntries.get("restore-receipt.json")!;
    const value = JSON.parse(source.toString("utf8"));
    value.apiRolesIsolated = false;
    fixture.restoreEntries.set("restore-receipt.json", canonicalBytes(value));

    expect(() => validate(fixture.backupEntries, fixture.restoreEntries)).toThrow(
      "production_postgres_source_pin_recovery_receipt_invalid",
    );
  });

  it("rejects a restore outside the exact successful workflow chronology", () => {
    const fixture = recoveryFixture();
    const source = fixture.restoreEntries.get("restore-receipt.json")!;
    const value = JSON.parse(source.toString("utf8"));
    value.restoredAt = "2026-08-15T00:41:00.000Z";
    const receipt = canonicalBytes(value);
    fixture.restoreEntries.set("restore-receipt.json", receipt);
    const result = JSON.parse(
      fixture.restoreEntries.get("restore-result.json")!.toString("utf8"),
    );
    result.receiptSha256 = crypto.createHash("sha256").update(receipt).digest("hex");
    fixture.restoreEntries.set("restore-result.json", canonicalBytes(result));

    expect(() => validate(fixture.backupEntries, fixture.restoreEntries)).toThrow(
      "production_postgres_source_pin_recovery_receipt_stale",
    );
  });
});
