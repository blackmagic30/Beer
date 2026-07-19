import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateVerifiedRestoreRuntime,
  buildRestoreRuntimeAttestation,
  RESTORE_RUNTIME_ATTESTATION_FILE,
  serializeRestoreRuntimeAttestation,
  verifyRestoreRuntimeAttestation,
  writeRestoreRuntimeAttestation,
} from "../src/lib/restore-rehearsal.js";

const temporaryDirectories: string[] = [];
const BACKUP_ID = "pint-path-2026-07-19T00-00-00-000Z";
const SOURCE_DATABASE_SHA256 = "a".repeat(64);
const DELETION_LEDGER_SHA256 = "b".repeat(64);
const DELETION_LEDGER_GENESIS_SHA256 = "c".repeat(64);
const DELETION_LEDGER_CHECKPOINT_SHA256 = "d".repeat(64);

interface Fixture {
  root: string;
  restoreRoot: string;
  databasePath: string;
  evidencePath: string;
  storageEvidencePath: string;
  sourceManifestPath: string;
  sourceManifestSha256: string;
  backupId: string;
}

interface FixtureInput {
  restoreState?: "succeeded" | "failed";
  foreignKeyViolation?: boolean;
  evidenceFileCount?: number;
  storageEvidenceFileCount?: number;
  evidenceFilesPurged?: number;
  stateEvidenceFileCount?: number;
  stateStorageEvidenceFileCount?: number;
  stateBackupId?: string;
  stateSourceDatabaseSha256?: string;
  databaseStorageContentType?: string;
  runtimeDirectoryName?: string;
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-restore-attestation-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function createFixture(input: FixtureInput = {}): Fixture {
  const root = makeTemporaryDirectory();
  const restoreRoot = path.join(root, input.runtimeDirectoryName ?? "restore");
  const databasePath = path.join(restoreRoot, "pint-path.sqlite");
  const evidencePath = path.join(restoreRoot, "source-evidence");
  const storageEvidencePath = path.join(restoreRoot, "supabase-source-evidence");
  const sourceRoot = path.join(root, "source");
  const sourceManifestPath = path.join(sourceRoot, "manifest.json");
  fs.mkdirSync(evidencePath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storageEvidencePath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });

  const evidenceFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (let index = 0; index < (input.evidenceFileCount ?? 2); index += 1) {
    const relativePath = `evidence/2026-07/menu-${index + 1}.jpg`;
    const contents = Buffer.from(`verified-menu-${index + 1}`);
    const absolutePath = path.join(evidencePath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolutePath, contents, { mode: 0o600 });
    evidenceFiles.push({ path: relativePath, bytes: contents.length, sha256: sha256(contents) });
  }

  const storageFiles: Array<{
    path: string;
    bytes: number;
    sha256: string;
    contentType: string;
  }> = [];
  for (let index = 0; index < (input.storageEvidenceFileCount ?? 0); index += 1) {
    const relativePath = `storage-owner/menu-${index + 1}.pdf`;
    const contents = Buffer.from(`verified-storage-menu-${index + 1}`);
    const absolutePath = path.join(storageEvidencePath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolutePath, contents, { mode: 0o600 });
    storageFiles.push({
      path: relativePath,
      bytes: contents.length,
      sha256: sha256(contents),
      contentType: "application/pdf",
    });
  }

  const sourceDatabaseBytes = 8192;
  const sourceManifest = {
    version: 2,
    createdAt: "2026-07-18T23:59:00.000Z",
    database: {
      path: "pint-path.sqlite",
      bytes: sourceDatabaseBytes,
      sha256: SOURCE_DATABASE_SHA256,
    },
    evidence: {
      path: "source-evidence",
      fileCount: evidenceFiles.length,
      bytes: evidenceFiles.reduce((total, file) => total + file.bytes, 0),
      files: evidenceFiles,
      databaseReferenceCount: evidenceFiles.length,
      orphanPaths: [],
    },
    storageEvidence: {
      provider: "supabase",
      bucket: "beermap-source-evidence",
      path: "supabase-source-evidence",
      fileCount: storageFiles.length,
      bytes: storageFiles.reduce((total, file) => total + file.bytes, 0),
      files: storageFiles,
      databaseReferenceCount: storageFiles.length,
      orphanPaths: [],
      reconciliationAttempts: 1,
    },
  };
  const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  fs.writeFileSync(sourceManifestPath, sourceManifestBytes, { mode: 0o600 });
  const sourceManifestSha256 = sha256(sourceManifestBytes);

  const startedAt = "2026-07-19T00:00:00.000Z";
  const completedAt = "2026-07-19T00:00:02.000Z";
  const updatedAt = "2026-07-19T00:00:02.001Z";
  const database = new BetterSqlite3(databasePath);
  database.pragma("journal_mode = DELETE");
  database.pragma("foreign_keys = OFF");
  database.exec(`
    CREATE TABLE system_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE source_evidence_objects (
      id TEXT PRIMARY KEY,
      storage_provider TEXT NOT NULL,
      object_path TEXT NOT NULL,
      mime_type TEXT,
      byte_size INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE parent_records (id TEXT PRIMARY KEY);
    CREATE TABLE child_records (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES parent_records(id)
    );
  `);
  for (const [index, file] of evidenceFiles.entries()) {
    database.prepare(
      `INSERT INTO source_evidence_objects (
         id, storage_provider, object_path, mime_type, byte_size, deleted_at
       ) VALUES (?, 'filesystem_private', ?, 'image/jpeg', ?, NULL)`,
    ).run(`evidence-${index + 1}`, file.path, file.bytes);
  }
  for (const [index, file] of storageFiles.entries()) {
    database.prepare(
      `INSERT INTO source_evidence_objects (
         id, storage_provider, object_path, mime_type, byte_size, deleted_at
       ) VALUES (?, 'supabase_private', ?, ?, ?, NULL)`,
    ).run(
      `storage-evidence-${index + 1}`,
      file.path,
      input.databaseStorageContentType ?? file.contentType,
      file.bytes,
    );
  }
  if (input.foreignKeyViolation) {
    database.prepare("INSERT INTO child_records (id, parent_id) VALUES ('child', 'missing')").run();
  }
  database.prepare(
    "INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)",
  ).run("job:restore_rehearsal", JSON.stringify({
    state: input.restoreState ?? "succeeded",
    startedAt,
    completedAt,
    backupId: input.stateBackupId ?? BACKUP_ID,
    sourceManifestSha256,
    sourceDatabaseSha256: input.stateSourceDatabaseSha256 ?? SOURCE_DATABASE_SHA256,
    deletionLedgerSha256: DELETION_LEDGER_SHA256,
    deletionLedgerGenesisSha256: DELETION_LEDGER_GENESIS_SHA256,
    deletionLedgerCheckpointSha256: DELETION_LEDGER_CHECKPOINT_SHA256,
    databaseBytes: sourceDatabaseBytes,
    evidenceFileCount: input.stateEvidenceFileCount ?? evidenceFiles.length,
    storageEvidenceFileCount: input.stateStorageEvidenceFileCount ?? storageFiles.length,
    tombstonesApplied: 0,
    evidenceFilesPurged: input.evidenceFilesPurged ?? 0,
    evidencePurgedPathSha256s: [],
  }), updatedAt);
  database.close();

  return {
    root,
    restoreRoot,
    databasePath,
    evidencePath,
    storageEvidencePath,
    sourceManifestPath,
    sourceManifestSha256,
    backupId: BACKUP_ID,
  };
}

function buildInput(fixture: Fixture) {
  return {
    restoreRoot: fixture.restoreRoot,
    backupId: fixture.backupId,
    sourceManifestPath: fixture.sourceManifestPath,
    expectedSourceManifestSha256: fixture.sourceManifestSha256,
    expectedDeletionLedgerSha256: DELETION_LEDGER_SHA256,
    expectedDeletionLedgerGenesisSha256: DELETION_LEDGER_GENESIS_SHA256,
    expectedDeletionLedgerCheckpointSha256: DELETION_LEDGER_CHECKPOINT_SHA256,
  };
}

function verifyInput(fixture: Fixture, attestationSha256: string) {
  return {
    restoreRoot: fixture.restoreRoot,
    expectedAttestationSha256: attestationSha256,
    expectedBackupId: fixture.backupId,
    expectedSourceManifestSha256: fixture.sourceManifestSha256,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("restore runtime attestation", () => {
  it("writes a deterministic v2 attestation for empty filesystem and Storage sets", async () => {
    const fixture = createFixture({ evidenceFileCount: 0 });
    const first = await buildRestoreRuntimeAttestation(buildInput(fixture));
    const second = await buildRestoreRuntimeAttestation(buildInput(fixture));
    expect(serializeRestoreRuntimeAttestation(first)).toEqual(
      serializeRestoreRuntimeAttestation(second),
    );

    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    expect(written.attestation).toEqual(first);
    expect(written.attestation.version).toBe(2);
    expect(written.attestation.evidence).toMatchObject({ fileCount: 0, bytes: 0, files: [] });
    expect(written.attestation.storageEvidence).toMatchObject({
      provider: "supabase",
      bucket: "beermap-source-evidence",
      path: "supabase-source-evidence",
      fileCount: 0,
      bytes: 0,
      files: [],
    });
    expect(written.attestation.restoreRehearsal).toMatchObject({
      backupId: fixture.backupId,
      sourceManifestSha256: fixture.sourceManifestSha256,
      sourceDatabaseSha256: SOURCE_DATABASE_SHA256,
      deletionLedgerSha256: DELETION_LEDGER_SHA256,
      deletionLedgerGenesisSha256: DELETION_LEDGER_GENESIS_SHA256,
      deletionLedgerCheckpointSha256: DELETION_LEDGER_CHECKPOINT_SHA256,
    });
    expect(fs.statSync(written.attestationPath).mode & 0o777).toBe(0o600);
    const verified = await verifyRestoreRuntimeAttestation(
      verifyInput(fixture, written.attestationSha256),
    );
    expect(verified.storageEvidencePath).toBe(fixture.storageEvidencePath);
    await expect(writeRestoreRuntimeAttestation(buildInput(fixture))).rejects.toThrow(
      "already exists",
    );
  });

  it("reconciles and verifies non-empty Supabase Storage evidence including MIME", async () => {
    const fixture = createFixture({ storageEvidenceFileCount: 2 });
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    expect(written.attestation.storageEvidence).toMatchObject({
      fileCount: 2,
      files: [
        { path: "storage-owner/menu-1.pdf", contentType: "application/pdf" },
        { path: "storage-owner/menu-2.pdf", contentType: "application/pdf" },
      ],
    });
    await expect(verifyRestoreRuntimeAttestation(
      verifyInput(fixture, written.attestationSha256),
    )).resolves.toMatchObject({ attestationSha256: written.attestationSha256 });

    fs.writeFileSync(
      path.join(fixture.storageEvidencePath, "storage-owner/menu-1.pdf"),
      "tampered-storage-evidence",
    );
    await expect(verifyRestoreRuntimeAttestation(
      verifyInput(fixture, written.attestationSha256),
    )).rejects.toThrow("Storage-evidence contents do not match");
  });

  it("rejects a Storage MIME mismatch against the restored database", async () => {
    const fixture = createFixture({
      storageEvidenceFileCount: 1,
      databaseStorageContentType: "image/png",
    });
    await expect(buildRestoreRuntimeAttestation(buildInput(fixture))).rejects.toThrow(
      "Storage evidence MIME type is wrong",
    );
  });

  it("rejects dropped filesystem or Storage evidence references", async () => {
    const filesystemFixture = createFixture();
    const filesystemDatabase = new BetterSqlite3(filesystemFixture.databasePath);
    filesystemDatabase.prepare(
      "DELETE FROM source_evidence_objects WHERE storage_provider = 'filesystem_private'",
    ).run();
    filesystemDatabase.close();
    await expect(buildRestoreRuntimeAttestation(buildInput(filesystemFixture))).rejects.toThrow(
      "retained a file without its active database reference",
    );

    const storageFixture = createFixture({ storageEvidenceFileCount: 1 });
    const storageDatabase = new BetterSqlite3(storageFixture.databasePath);
    storageDatabase.prepare(
      "DELETE FROM source_evidence_objects WHERE storage_provider = 'supabase_private'",
    ).run();
    storageDatabase.close();
    await expect(buildRestoreRuntimeAttestation(buildInput(storageFixture))).rejects.toThrow(
      "retained a file without its active database reference",
    );
  });

  it("binds an authenticated purge to the exact provider and source path", async () => {
    const fixture = createFixture();
    const purgedPath = "evidence/2026-07/menu-1.jpg";
    fs.unlinkSync(path.join(fixture.evidencePath, ...purgedPath.split("/")));
    const purgeHash = sha256(`filesystem_private\0${purgedPath}`);
    const database = new BetterSqlite3(fixture.databasePath);
    database.prepare(
      "UPDATE source_evidence_objects SET deleted_at = ? WHERE object_path = ?",
    ).run("2026-07-19T00:00:01.000Z", purgedPath);
    const row = database.prepare(
      "SELECT value_json AS valueJson FROM system_state WHERE key = 'job:restore_rehearsal'",
    ).get() as { valueJson: string };
    const state = JSON.parse(row.valueJson) as Record<string, unknown>;
    state.evidenceFilesPurged = 1;
    state.evidencePurgedPathSha256s = [purgeHash];
    database.prepare(
      "UPDATE system_state SET value_json = ? WHERE key = 'job:restore_rehearsal'",
    ).run(JSON.stringify(state));
    database.close();

    await expect(buildRestoreRuntimeAttestation(buildInput(fixture))).resolves.toMatchObject({
      restoreRehearsal: {
        evidenceFilesPurged: 1,
        evidencePurgedPathSha256s: [purgeHash],
      },
    });

    const tamperedDatabase = new BetterSqlite3(fixture.databasePath);
    state.evidencePurgedPathSha256s = ["f".repeat(64)];
    tamperedDatabase.prepare(
      "UPDATE system_state SET value_json = ? WHERE key = 'job:restore_rehearsal'",
    ).run(JSON.stringify(state));
    tamperedDatabase.close();
    await expect(buildRestoreRuntimeAttestation(buildInput(fixture))).rejects.toThrow(
      "purge hashes do not match the exact removed evidence paths",
    );
  });

  it("rejects evidence or database mutation after attestation", async () => {
    const evidenceFixture = createFixture();
    const evidenceAttestation = await writeRestoreRuntimeAttestation(buildInput(evidenceFixture));
    fs.writeFileSync(
      path.join(evidenceFixture.evidencePath, "evidence/2026-07/menu-1.jpg"),
      "tampered-menu",
    );
    await expect(verifyRestoreRuntimeAttestation(
      verifyInput(evidenceFixture, evidenceAttestation.attestationSha256),
    )).rejects.toThrow("evidence contents do not match");

    const databaseFixture = createFixture();
    const databaseAttestation = await writeRestoreRuntimeAttestation(buildInput(databaseFixture));
    fs.appendFileSync(databaseFixture.databasePath, "tampered");
    await expect(verifyRestoreRuntimeAttestation(
      verifyInput(databaseFixture, databaseAttestation.attestationSha256),
    )).rejects.toThrow("database does not match");
  });

  it("rejects symlinks, unexpected files, and SQLite sidecars", async () => {
    const symlinkFixture = createFixture();
    fs.symlinkSync(
      symlinkFixture.sourceManifestPath,
      path.join(symlinkFixture.evidencePath, "linked-manifest.json"),
    );
    await expect(buildRestoreRuntimeAttestation(buildInput(symlinkFixture))).rejects.toThrow(
      "symbolic link",
    );

    const sidecarFixture = createFixture();
    fs.writeFileSync(`${sidecarFixture.databasePath}-wal`, "not-a-real-sidecar");
    await expect(buildRestoreRuntimeAttestation(buildInput(sidecarFixture))).rejects.toThrow(
      "unapproved file",
    );
  });

  it("rejects failed, count-mismatched, and source-identity-mismatched rehearsals", async () => {
    const failedFixture = createFixture({ restoreState: "failed" });
    await expect(buildRestoreRuntimeAttestation(buildInput(failedFixture))).rejects.toThrow(
      "not succeeded",
    );

    const countMismatchFixture = createFixture({ stateEvidenceFileCount: 3 });
    await expect(buildRestoreRuntimeAttestation(buildInput(countMismatchFixture))).rejects.toThrow(
      "trusted source manifest counts",
    );

    const backupMismatchFixture = createFixture({
      stateBackupId: "pint-path-2026-07-19T00-00-00-000Z-other",
    });
    await expect(buildRestoreRuntimeAttestation(buildInput(backupMismatchFixture))).rejects.toThrow(
      "different backup ID",
    );

    const databaseMismatchFixture = createFixture({ stateSourceDatabaseSha256: "e".repeat(64) });
    await expect(buildRestoreRuntimeAttestation(buildInput(databaseMismatchFixture))).rejects.toThrow(
      "source database does not match",
    );

    const deletionAuthorityFixture = createFixture();
    await expect(buildRestoreRuntimeAttestation({
      ...buildInput(deletionAuthorityFixture),
      expectedDeletionLedgerCheckpointSha256: "e".repeat(64),
    })).rejects.toThrow("deletion-ledger checkpoint does not match");
  });

  it("rejects foreign-key violations and requires out-of-band attestation identity", async () => {
    const foreignKeyFixture = createFixture({ foreignKeyViolation: true });
    await expect(buildRestoreRuntimeAttestation(buildInput(foreignKeyFixture))).rejects.toThrow(
      "foreign-key check failed",
    );

    const fixture = createFixture();
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    await expect(verifyRestoreRuntimeAttestation({
      ...verifyInput(fixture, "f".repeat(64)),
    })).rejects.toThrow("trusted SHA-256");
    expect(fs.existsSync(path.join(fixture.restoreRoot, RESTORE_RUNTIME_ATTESTATION_FILE))).toBe(true);
    expect(written.attestationSha256).not.toBe("f".repeat(64));
  });
});

describe("atomic restore activation", () => {
  it("verifies and atomically renames an incoming v2 runtime before returning hashes", async () => {
    const fixture = createFixture({
      storageEvidenceFileCount: 1,
      runtimeDirectoryName: `incoming-${BACKUP_ID}`,
    });
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    const finalRoot = path.join(fixture.root, `restore-${BACKUP_ID}`);
    const result = await activateVerifiedRestoreRuntime({
      incomingRoot: fixture.restoreRoot,
      finalRoot,
      expectedAttestationSha256: written.attestationSha256,
      expectedBackupId: BACKUP_ID,
      expectedSourceManifestSha256: fixture.sourceManifestSha256,
    });

    expect(result).toMatchObject({
      activated: true,
      activationLockCleanupRequired: false,
      backupId: BACKUP_ID,
      attestationSha256: written.attestationSha256,
      sourceManifestSha256: fixture.sourceManifestSha256,
      sourceDatabaseSha256: SOURCE_DATABASE_SHA256,
      evidenceFileCount: 2,
      storageEvidenceFileCount: 1,
    });
    expect(fs.existsSync(fixture.restoreRoot)).toBe(false);
    expect(fs.existsSync(finalRoot)).toBe(true);
    expect(fs.existsSync(path.join(fixture.root, ".pint-path-restore-activation.lock"))).toBe(false);
  });

  it("returns committed success with a cleanup warning if the activation lock cannot be removed", async () => {
    const fixture = createFixture({ runtimeDirectoryName: `incoming-${BACKUP_ID}` });
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    const finalRoot = path.join(fixture.root, `restore-${BACKUP_ID}`);
    const lockPath = path.join(fixture.root, ".pint-path-restore-activation.lock");
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    const unlink = vi.spyOn(fs.promises, "unlink").mockImplementation(async (target) => {
      if (path.resolve(String(target)) === lockPath) {
        throw Object.assign(new Error("simulated lock cleanup failure"), { code: "EACCES" });
      }
      return realUnlink(target);
    });

    try {
      await expect(activateVerifiedRestoreRuntime({
        incomingRoot: fixture.restoreRoot,
        finalRoot,
        expectedAttestationSha256: written.attestationSha256,
        expectedBackupId: BACKUP_ID,
        expectedSourceManifestSha256: fixture.sourceManifestSha256,
      })).resolves.toMatchObject({
        activated: true,
        activationLockCleanupRequired: true,
      });
    } finally {
      unlink.mockRestore();
    }

    expect(fs.existsSync(finalRoot)).toBe(true);
    expect(fs.existsSync(fixture.restoreRoot)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    await expect(verifyRestoreRuntimeAttestation({
      restoreRoot: finalRoot,
      expectedAttestationSha256: written.attestationSha256,
      expectedBackupId: BACKUP_ID,
      expectedSourceManifestSha256: fixture.sourceManifestSha256,
    })).resolves.toMatchObject({ attestationSha256: written.attestationSha256 });
  });

  it("refuses to overwrite a final runtime and leaves incoming data intact", async () => {
    const fixture = createFixture({ runtimeDirectoryName: `incoming-${BACKUP_ID}` });
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    const finalRoot = path.join(fixture.root, `restore-${BACKUP_ID}`);
    fs.mkdirSync(finalRoot);
    await expect(activateVerifiedRestoreRuntime({
      incomingRoot: fixture.restoreRoot,
      finalRoot,
      expectedAttestationSha256: written.attestationSha256,
      expectedBackupId: BACKUP_ID,
      expectedSourceManifestSha256: fixture.sourceManifestSha256,
    })).rejects.toThrow("already exists");
    expect(fs.existsSync(fixture.restoreRoot)).toBe(true);
  });

  it("does not rename a tampered incoming runtime", async () => {
    const fixture = createFixture({ runtimeDirectoryName: `incoming-${BACKUP_ID}` });
    const written = await writeRestoreRuntimeAttestation(buildInput(fixture));
    fs.writeFileSync(
      path.join(fixture.evidencePath, "evidence/2026-07/menu-1.jpg"),
      "tampered-before-activation",
    );
    const finalRoot = path.join(fixture.root, `restore-${BACKUP_ID}`);
    await expect(activateVerifiedRestoreRuntime({
      incomingRoot: fixture.restoreRoot,
      finalRoot,
      expectedAttestationSha256: written.attestationSha256,
      expectedBackupId: BACKUP_ID,
      expectedSourceManifestSha256: fixture.sourceManifestSha256,
    })).rejects.toThrow("evidence contents do not match");
    expect(fs.existsSync(fixture.restoreRoot)).toBe(true);
    expect(fs.existsSync(finalRoot)).toBe(false);
  });
});
