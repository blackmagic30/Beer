import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPostgresMigrationSourceCli } from "../scripts/postgres-migration.js";
import { createDatabase } from "../src/db/database.js";
import { writePostgresMigrationLedgerAuthority } from "../src/db/postgres-migration-ledger.js";
import {
  POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
  PostgresMigrationSourceError,
  createPostgresMigrationSnapshot,
  verifyPostgresMigrationSnapshotEvidence,
} from "../src/db/postgres-migration-source.js";
import { sha256Bytes } from "../src/lib/data-backup.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";

const temporaryDirectories: string[] = [];
const now = "2026-08-08T00:00:00.000Z";

function makeTemporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-snapshot-test-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function migrationLedgerFixture(): VerifiedAccountDeletionLedger {
  const current = Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt: now,
    tombstones: [],
  }, null, 2)}\n`);
  const genesis = Buffer.from(`${JSON.stringify({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: now,
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  }, null, 2)}\n`);
  const checkpoint = {
    version: 2 as const,
    generatedAt: now,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256Bytes(genesis),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256Bytes(current),
    immutableObjectCount: 0,
    immutableSetSha256: "a".repeat(64),
    tombstoneCount: 0,
    latestCompletedAt: null,
  };
  const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
  return {
    bytes: current,
    sha256: sha256Bytes(current),
    genesisBytes: genesis,
    genesisSha256: sha256Bytes(genesis),
    checkpointBytes,
    checkpointSha256: sha256Bytes(checkpointBytes),
    tombstones: [],
    checkpoint,
  };
}

async function seedMigrationSource(root: string): Promise<{
  databasePath: string;
  evidencePath: string;
  ledgerAuthorityDirectory: string;
  ledgerAuthorityManifestPath: string;
  ciphertext: Buffer;
}> {
  const databasePath = path.join(root, "live.sqlite");
  const evidencePath = path.join(root, "source-evidence");
  fs.mkdirSync(path.join(evidencePath, "submission-proof"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(evidencePath, "submission-proof", "private-proof.bin"),
    "PRIVATE_EVIDENCE_MARKER_SHOULD_NOT_APPEAR_IN_MANIFEST",
    { mode: 0o600 },
  );

  const database = createDatabase(databasePath);
  database.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, display_name, is_over_18_verified, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run("private-account-id", "private-account@example.test", "private-password-hash", "Private Account", now, now);
  database.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("private-request-id", "private-account-id", now, "2026-08-15T00:00:00.000Z", now, now);
  database.prepare(
    `INSERT INTO account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status, created_at, updated_at
     ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
  ).run("private-request-id", "private-idempotency-key", now, now);
  const ciphertext = Buffer.from("UNSANITIZED_RECIPIENT_CIPHERTEXT_MARKER", "utf8");
  database.prepare(
    `INSERT INTO account_deletion_notice_recipient_secrets (
       request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "private-request-id",
    "private-key-id",
    Buffer.alloc(12, 1),
    ciphertext,
    Buffer.alloc(16, 2),
    now,
    "2026-10-07T00:00:00.000Z",
  );
  database.close();
  const ledgerAuthorityDirectory = path.join(root, "deletion-ledger-authority");
  const ledgerAuthority = await writePostgresMigrationLedgerAuthority({
    sourceSupabaseUrl: "https://production-project.supabase.co",
    destinationSupabaseUrl: "https://independent-backup.supabase.co",
    bucketName: "pintpath-backups",
    outputDirectory: ledgerAuthorityDirectory,
    verified: migrationLedgerFixture(),
  });
  return {
    databasePath,
    evidencePath,
    ledgerAuthorityDirectory,
    ledgerAuthorityManifestPath: ledgerAuthority.manifestPath,
    ciphertext,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("sealed SQLite-to-Postgres source snapshots", () => {
  it("creates an exact private snapshot without sanitizing recipient ciphertext", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const outputDirectory = path.join(root, "postgres-migration-artifacts", "snapshot-001");
    fs.mkdirSync(path.dirname(outputDirectory), { mode: 0o700 });

    const result = await createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
      outputDirectory,
      candidateSha: "a".repeat(40),
      operatorId: "migration-operator-001",
      maintenanceReference: "approved-change-reference-001",
      maintenanceConfirmed: true,
      capturedAt: now,
    });

    expect(result.manifest.schema.counts).toMatchObject({
      tables: 56,
      columns: 717,
      foreignKeys: 76,
      explicitIndexes: 185,
      automaticIndexes: 74,
      triggers: 9,
    });
    expect(fs.statSync(outputDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(result.databasePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.databasePath).nlink).toBe(1);
    expect(fs.existsSync(`${result.databasePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${result.databasePath}-shm`)).toBe(false);
    const copiedEvidenceDirectory = path.join(
      outputDirectory,
      POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
    );
    const sourceEvidenceFile = path.join(source.evidencePath, "submission-proof", "private-proof.bin");
    const copiedEvidenceFile = path.join(copiedEvidenceDirectory, "submission-proof", "private-proof.bin");
    expect(fs.statSync(copiedEvidenceDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(copiedEvidenceFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(copiedEvidenceFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(copiedEvidenceFile).nlink).toBe(1);
    expect(fs.statSync(copiedEvidenceFile).ino).not.toBe(fs.statSync(sourceEvidenceFile).ino);
    expect(fs.readFileSync(copiedEvidenceFile)).toEqual(fs.readFileSync(sourceEvidenceFile));
    await expect(verifyPostgresMigrationSnapshotEvidence(
      outputDirectory,
      result.manifest.evidence,
    )).resolves.toEqual(result.manifest.evidence);
    const copiedLedgerDirectory = path.join(outputDirectory, "account-deletion-ledger-authority");
    expect(fs.statSync(copiedLedgerDirectory).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(copiedLedgerDirectory).sort()).toEqual([
      "account-deletion-ledger-checkpoint.json",
      "account-deletion-ledger-genesis.json",
      "account-deletion-tombstones.json",
      "authority-manifest.json",
    ]);
    for (const fileName of fs.readdirSync(copiedLedgerDirectory)) {
      const stat = fs.statSync(path.join(copiedLedgerDirectory, fileName));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    expect(result.manifest.deletionLedger).toMatchObject({
      tombstoneCount: 0,
      immutableObjectCount: 0,
      latestCompletedAt: null,
    });

    const snapshot = new BetterSqlite3(result.databasePath, { readonly: true, fileMustExist: true });
    const secret = snapshot.prepare(
      "SELECT nonce, ciphertext, auth_tag FROM account_deletion_notice_recipient_secrets WHERE request_id = ?",
    ).get("private-request-id") as { nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
    snapshot.close();
    expect(secret.nonce).toEqual(Buffer.alloc(12, 1));
    expect(secret.ciphertext).toEqual(source.ciphertext);
    expect(secret.auth_tag).toEqual(Buffer.alloc(16, 2));

    const manifestText = fs.readFileSync(result.manifestPath, "utf8");
    expect(manifestText).not.toContain(root);
    expect(manifestText).not.toContain("migration-operator-001");
    expect(manifestText).not.toContain("approved-change-reference-001");
    expect(manifestText).not.toContain("private-account@example.test");
    expect(manifestText).not.toContain("private-user-id");
    expect(manifestText).not.toContain(source.ciphertext.toString("utf8"));
    expect(manifestText).not.toContain("PRIVATE_EVIDENCE_MARKER");
  });

  it("retains ambiguous output without deleting an untracked inode after snapshot failure", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const parent = path.join(root, "postgres-migration-artifacts");
    const outputDirectory = path.join(parent, "ambiguous-cleanup");
    const injectedPath = path.join(outputDirectory, "operator-sentinel.txt");
    fs.mkdirSync(parent, { mode: 0o700 });
    const chmod = fs.promises.chmod.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === path.join(outputDirectory, "pint-path.sqlite") && mode === 0o600) {
        fs.writeFileSync(injectedPath, "DO_NOT_DELETE_UNOWNED_INODE", { mode: 0o600 });
        throw new Error("forced snapshot failure after foreign inode injection");
      }
      return chmod(target, mode);
    });
    try {
      await expect(createPostgresMigrationSnapshot({
        sourceSqlite: source.databasePath,
        sourceEvidence: source.evidencePath,
        deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
        outputDirectory,
        candidateSha: "f".repeat(40),
        operatorId: "migration-operator-cleanup",
        maintenanceReference: "approved-cleanup-reference",
        maintenanceConfirmed: true,
        capturedAt: now,
      })).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("retained for operator review"),
      });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(injectedPath, "utf8")).toBe("DO_NOT_DELETE_UNOWNED_INODE");
    expect(fs.existsSync(path.join(outputDirectory, "pint-path.sqlite"))).toBe(true);
  });

  it("does not follow a replacement output pathname during failure cleanup", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const parent = path.join(root, "postgres-migration-artifacts");
    const outputDirectory = path.join(parent, "replaced-cleanup");
    const movedInvocationDirectory = `${outputDirectory}.invocation-owned`;
    const replacementSentinel = path.join(outputDirectory, "replacement-sentinel.txt");
    fs.mkdirSync(parent, { mode: 0o700 });
    const chmod = fs.promises.chmod.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === path.join(outputDirectory, "pint-path.sqlite") && mode === 0o600) {
        fs.renameSync(outputDirectory, movedInvocationDirectory);
        fs.mkdirSync(outputDirectory, { mode: 0o700 });
        fs.writeFileSync(replacementSentinel, "REPLACEMENT_MUST_SURVIVE", { mode: 0o600 });
        throw new Error("forced snapshot failure after output pathname replacement");
      }
      return chmod(target, mode);
    });
    try {
      await expect(createPostgresMigrationSnapshot({
        sourceSqlite: source.databasePath,
        sourceEvidence: source.evidencePath,
        deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
        outputDirectory,
        candidateSha: "1".repeat(40),
        operatorId: "migration-operator-replacement",
        maintenanceReference: "approved-replacement-reference",
        maintenanceConfirmed: true,
        capturedAt: now,
      })).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("retained for operator review"),
      });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(replacementSentinel, "utf8")).toBe("REPLACEMENT_MUST_SURVIVE");
    expect(fs.existsSync(path.join(movedInvocationDirectory, "pint-path.sqlite"))).toBe(true);
  });

  it("removes only its exact tracked output after an ordinary capture failure", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const parent = path.join(root, "postgres-migration-artifacts");
    const outputDirectory = path.join(parent, "exact-cleanup");
    fs.mkdirSync(parent, { mode: 0o700 });
    const chmod = fs.promises.chmod.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === path.join(outputDirectory, "pint-path.sqlite") && mode === 0o600) {
        throw new Error("forced failure with an exact invocation-owned inventory");
      }
      return chmod(target, mode);
    });
    try {
      await expect(createPostgresMigrationSnapshot({
        sourceSqlite: source.databasePath,
        sourceEvidence: source.evidencePath,
        deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
        outputDirectory,
        candidateSha: "2".repeat(40),
        operatorId: "migration-operator-exact-cleanup",
        maintenanceReference: "approved-exact-cleanup-reference",
        maintenanceConfirmed: true,
        capturedAt: now,
      })).rejects.toThrow("forced failure with an exact invocation-owned inventory");
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("fails closed without maintenance confirmation and rejects schema drift", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const parent = path.join(root, "postgres-migration-artifacts");
    fs.mkdirSync(parent, { mode: 0o700 });
    const withoutMaintenance = path.join(parent, "without-maintenance");
    await expect(createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
      outputDirectory: withoutMaintenance,
      candidateSha: "b".repeat(40),
      operatorId: "migration-operator-002",
      maintenanceReference: "approved-change-reference-002",
      maintenanceConfirmed: false,
      capturedAt: now,
    })).rejects.toMatchObject({ code: "MAINTENANCE_REQUIRED" });
    expect(fs.existsSync(withoutMaintenance)).toBe(false);

    const oldVersion = new BetterSqlite3(source.databasePath);
    oldVersion.pragma("user_version = 14");
    oldVersion.close();
    const oldVersionOutput = path.join(parent, "old-version-source");
    await expect(createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
      outputDirectory: oldVersionOutput,
      candidateSha: "b".repeat(40),
      operatorId: "migration-operator-002",
      maintenanceReference: "approved-change-reference-002",
      maintenanceConfirmed: true,
      capturedAt: now,
    })).rejects.toMatchObject({ code: "SOURCE_SCHEMA_MISMATCH" });
    expect(fs.existsSync(oldVersionOutput)).toBe(false);

    const changed = new BetterSqlite3(source.databasePath);
    changed.pragma("user_version = 15");
    changed.exec("CREATE TABLE unexpected_source_table (id TEXT PRIMARY KEY)");
    changed.close();
    const driftedOutput = path.join(parent, "drifted-source");
    await expect(createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
      outputDirectory: driftedOutput,
      candidateSha: "b".repeat(40),
      operatorId: "migration-operator-002",
      maintenanceReference: "approved-change-reference-002",
      maintenanceConfirmed: true,
      capturedAt: now,
    })).rejects.toMatchObject({ code: "SOURCE_SCHEMA_MISMATCH" });
    expect(fs.existsSync(driftedOutput)).toBe(false);
  });

  it("rejects linked inputs and unsupported CLI arguments", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const linkedLedgerDirectory = path.join(root, "linked-ledger-authority");
    fs.mkdirSync(linkedLedgerDirectory, { mode: 0o700 });
    for (const fileName of fs.readdirSync(source.ledgerAuthorityDirectory)) {
      const sourcePath = path.join(source.ledgerAuthorityDirectory, fileName);
      const destinationPath = path.join(linkedLedgerDirectory, fileName);
      if (fileName === "authority-manifest.json") fs.linkSync(sourcePath, destinationPath);
      else fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, 0o600);
    }
    const linkedLedger = path.join(linkedLedgerDirectory, "authority-manifest.json");
    const parent = path.join(root, "postgres-migration-artifacts");
    fs.mkdirSync(parent, { mode: 0o700 });
    await expect(createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: linkedLedger,
      outputDirectory: path.join(parent, "linked-input"),
      candidateSha: "c".repeat(40),
      operatorId: "migration-operator-003",
      maintenanceReference: "approved-change-reference-003",
      maintenanceConfirmed: true,
      capturedAt: now,
    })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });

    await expect(runPostgresMigrationSourceCli([
      "snapshot",
      "--unsupported",
      "value",
    ], { PINTPATH_SQLITE_WRITE_MAINTENANCE: "confirmed" })).rejects.toThrow("Unsupported argument");
    await expect(runPostgresMigrationSourceCli([
      "plan",
      "--snapshot-manifest",
      path.join(root, "missing-manifest.json"),
      "--snapshot-manifest-sha256",
      "d".repeat(64),
      "--output-plan",
      path.join(root, "missing-plan.json"),
      "--chunk-rows",
      "1e3",
    ])).rejects.toThrow("base-10 integer");
    expect(PostgresMigrationSourceError).toBeDefined();
  });

  it("rejects a source with foreign-key violations before copying it", async () => {
    const root = makeTemporaryDirectory();
    const source = await seedMigrationSource(root);
    const damaged = new BetterSqlite3(source.databasePath);
    damaged.pragma("foreign_keys = OFF");
    damaged.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run("orphan-session", "missing-account", now, "2026-08-09T00:00:00.000Z");
    damaged.close();
    const parent = path.join(root, "postgres-migration-artifacts");
    fs.mkdirSync(parent, { mode: 0o700 });
    const output = path.join(parent, "foreign-key-violation");
    await expect(createPostgresMigrationSnapshot({
      sourceSqlite: source.databasePath,
      sourceEvidence: source.evidencePath,
      deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
      outputDirectory: output,
      candidateSha: "e".repeat(40),
      operatorId: "migration-operator-004",
      maintenanceReference: "approved-change-reference-004",
      maintenanceConfirmed: true,
      capturedAt: now,
    })).rejects.toMatchObject({ code: "SOURCE_INTEGRITY_FAILED" });
    expect(fs.existsSync(output)).toBe(false);
  });
});
