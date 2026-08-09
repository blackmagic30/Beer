import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { createDatabase } from "../src/db/database.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { createDataBackup, rehearseDataRestore, verifyDataBackup } from "../src/lib/data-backup.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDeletionLedger(
  root: string,
  tombstones: Array<{ requestId: string; userId: string; completedAt: string }> = [],
): {
  path: string;
  sha256: string;
  restoreArguments: {
    deletionTombstonePath: string;
    expectedDeletionTombstoneSha256: string;
    deletionLedgerGenesisPath: string;
    expectedDeletionLedgerGenesisSha256: string;
    deletionLedgerCheckpointPath: string;
    expectedDeletionLedgerCheckpointSha256: string;
  };
} {
  const ledgerPath = path.join(root, `deletion-ledger-${Math.random().toString(16).slice(2)}.json`);
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt: "2026-07-14T12:00:00.000Z",
    tombstones,
  }, null, 2)}\n`);
  fs.writeFileSync(ledgerPath, bytes);
  const ledgerSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const nonce = Math.random().toString(16).slice(2);
  const genesisPath = path.join(root, `deletion-ledger-genesis-${nonce}.json`);
  const genesisBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-07-14T12:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  }, null, 2)}\n`);
  fs.writeFileSync(genesisPath, genesisBytes);
  const genesisSha256 = crypto.createHash("sha256").update(genesisBytes).digest("hex");
  const latestCompletedAt = tombstones.reduce<string | null>((latest, tombstone) => (
    latest === null || Date.parse(tombstone.completedAt) > Date.parse(latest)
      ? tombstone.completedAt
      : latest
  ), null);
  const checkpointPath = path.join(root, `deletion-ledger-checkpoint-${nonce}.json`);
  const checkpointBytes = Buffer.from(`${JSON.stringify({
    version: 2,
    generatedAt: "2026-07-14T12:00:00.000Z",
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256,
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: ledgerSha256,
    immutableObjectCount: tombstones.length,
    immutableSetSha256: crypto.createHash("sha256").update(JSON.stringify(tombstones)).digest("hex"),
    tombstoneCount: tombstones.length,
    latestCompletedAt,
  }, null, 2)}\n`);
  fs.writeFileSync(checkpointPath, checkpointBytes);
  const checkpointSha256 = crypto.createHash("sha256").update(checkpointBytes).digest("hex");
  return {
    path: ledgerPath,
    sha256: ledgerSha256,
    restoreArguments: {
      deletionTombstonePath: ledgerPath,
      expectedDeletionTombstoneSha256: ledgerSha256,
      deletionLedgerGenesisPath: genesisPath,
      expectedDeletionLedgerGenesisSha256: genesisSha256,
      deletionLedgerCheckpointPath: checkpointPath,
      expectedDeletionLedgerCheckpointSha256: checkpointSha256,
    },
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("production data backups", () => {
  it("creates and verifies a consistent SQLite and evidence backup", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const evidencePath = path.join(root, "source-evidence");
    const backupPath = path.join(root, "backup");
    fs.mkdirSync(path.join(evidencePath, "submission-1"), { recursive: true });
    fs.writeFileSync(path.join(evidencePath, "submission-1", "menu.jpg"), "menu-image");

    const database = createDatabase(databasePath);
    database.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run("record-1", "verified");
    database.close();

    const manifest = await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: evidencePath,
      backupRoot: backupPath,
    });
    const verified = await verifyDataBackup(backupPath);

    expect(verified).toEqual(manifest);
    expect(manifest.evidence.fileCount).toBe(1);
    expect(manifest.evidence.bytes).toBe(Buffer.byteLength("menu-image"));
    expect(fs.existsSync(path.join(backupPath, `${manifest.database.path}-wal`))).toBe(false);
    expect(fs.existsSync(path.join(backupPath, `${manifest.database.path}-shm`))).toBe(false);

    const restored = new BetterSqlite3(path.join(backupPath, manifest.database.path), {
      readonly: true,
      fileMustExist: true,
    });
    expect(restored.prepare("SELECT value FROM records WHERE id = ?").pluck().get("record-1")).toBe("verified");
    restored.close();
  });

  it("crypto-shreds deletion-notice recipient ciphertext from the backup artifact", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const backupPath = path.join(root, "backup");
    const evidencePath = path.join(root, "source-evidence");
    fs.mkdirSync(evidencePath, { recursive: true });
    const database = createDatabase(databasePath);
    const repository = new BusinessRepository(database);
    const queueRepository = new AccountDeletionQueueRepository(asAsyncSqliteDatabase(database));
    const now = "2026-08-03T10:00:00.000Z";
    const account = repository.createAccount({
      id: "backup-secret-account",
      email: "backup-secret@example.com",
      passwordHash: "test-password-hash",
      role: "user",
      subscriptionStatus: "free",
      now,
    });
    await queueRepository.createAccountDeletionRequest({
      id: "backup-secret-request",
      userId: account.id,
      userMessage: null,
      requestedAt: now,
      executeAfter: "2026-08-10T10:00:00.000Z",
    });
    database.prepare(
      `INSERT INTO account_deletion_completion_outbox (
         request_id, template_version, idempotency_key, status, created_at, updated_at
       ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
    ).run("backup-secret-request", "pintpath-account-deletion/backup-secret-request", now, now);
    const ciphertextMarker = Buffer.from("PINTPATH_BACKUP_ONLY_CIPHERTEXT_MARKER_20260803", "utf8");
    database.prepare(
      `INSERT INTO account_deletion_notice_recipient_secrets (
         request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "backup-secret-request",
      "backup-key",
      Buffer.alloc(12, 1),
      ciphertextMarker,
      Buffer.alloc(16, 2),
      now,
      "2026-10-02T10:00:00.000Z",
    );
    database.close();

    const manifest = await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: evidencePath,
      backupRoot: backupPath,
    });
    const backupDatabasePath = path.join(backupPath, manifest.database.path);
    const backupDatabase = new BetterSqlite3(backupDatabasePath, { readonly: true, fileMustExist: true });
    expect(backupDatabase.prepare(
      "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets",
    ).get()).toEqual({ count: 0 });
    expect(backupDatabase.prepare(
      "SELECT status FROM account_deletion_completion_outbox WHERE request_id = ?",
    ).get("backup-secret-request")).toEqual({ status: "purged" });
    backupDatabase.close();
    expect(fs.readFileSync(backupDatabasePath).includes(ciphertextMarker)).toBe(false);

    const liveDatabase = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    expect(liveDatabase.prepare(
      "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets",
    ).get()).toEqual({ count: 1 });
    liveDatabase.close();
  });

  it("rejects a backup whose evidence no longer matches its manifest", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const evidencePath = path.join(root, "source-evidence");
    const backupPath = path.join(root, "backup");
    fs.mkdirSync(evidencePath, { recursive: true });
    fs.writeFileSync(path.join(evidencePath, "menu.png"), "original-image");

    const database = new BetterSqlite3(databasePath);
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    database.close();

    await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: evidencePath,
      backupRoot: backupPath,
    });
    fs.writeFileSync(path.join(backupPath, "source-evidence", "menu.png"), "tampered-image");

    await expect(verifyDataBackup(backupPath)).rejects.toThrow("Backup checksum mismatch");
  });

  it("rehearses a clean restore and verifies the restored database and evidence", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const evidencePath = path.join(root, "source-evidence");
    const backupPath = path.join(root, "backup");
    const restorePath = path.join(root, "restore");
    fs.mkdirSync(evidencePath, { recursive: true });
    fs.writeFileSync(path.join(evidencePath, "menu.png"), "restorable-image");

    const database = createDatabase(databasePath);
    database.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run("record-1", "restored");
    database.close();

    await createDataBackup({ sourceDatabase: databasePath, sourceEvidence: evidencePath, backupRoot: backupPath });
    const ledger = writeDeletionLedger(root, [{
      requestId: "unrelated-deletion",
      userId: "user-not-in-this-backup",
      completedAt: "2026-07-14T10:00:00.000Z",
    }]);
    const restored = await rehearseDataRestore({
      backupPath,
      restoreRoot: restorePath,
      ...ledger.restoreArguments,
    });

    expect(restored.manifest.evidence.fileCount).toBe(1);
    expect(fs.readFileSync(path.join(restored.evidencePath, "menu.png"), "utf8")).toBe("restorable-image");
    const restoredDatabase = new BetterSqlite3(restored.databasePath, { readonly: true, fileMustExist: true });
    expect(restoredDatabase.prepare("SELECT value FROM records WHERE id = ?").pluck().get("record-1")).toBe("restored");
    restoredDatabase.close();
  });

  it("fails closed when the independent deletion ledger is unavailable", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const backupPath = path.join(root, "backup");
    const database = new BetterSqlite3(databasePath);
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    database.close();
    await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: path.join(root, "evidence"),
      backupRoot: backupPath,
    });

    await expect(rehearseDataRestore({
      backupPath,
      restoreRoot: path.join(root, "restore"),
    } as unknown as Parameters<typeof rehearseDataRestore>[0])).rejects.toThrow(
      "independent account-deletion tombstone ledger is required",
    );
  });

  it("applies a later deletion tombstone when rehearsing an older backup", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const evidencePath = path.join(root, "source-evidence");
    const backupPath = path.join(root, "backup-before-deletion");
    const restorePath = path.join(root, "restore");
    const completedAt = "2026-07-14T10:00:00.000Z";
    const database = createDatabase(databasePath);
    const repository = new BusinessRepository(database);
    repository.createAccount({
      id: "later-deleted-user",
      email: "identity-that-must-not-return@example.com",
      passwordHash: "test-password-hash",
      role: "user",
      subscriptionStatus: "free",
      now: "2026-07-01T00:00:00.000Z",
    });
    database.prepare(
      `INSERT INTO source_evidence_objects (
         id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
         data_base64, external_url, retention_expires_at, deleted_at, created_at
       ) VALUES (?, ?, 'filesystem_private', ?, 'application/pdf', 12, NULL, NULL, ?, NULL, ?)`,
    ).run(
      "later-deleted-evidence",
      "later-deleted-user",
      "later-deleted-user/menu.pdf",
      "2026-10-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    );
    database.close();
    fs.mkdirSync(path.join(evidencePath, "later-deleted-user"), { recursive: true });
    fs.writeFileSync(path.join(evidencePath, "later-deleted-user", "menu.pdf"), "private-menu");
    await createDataBackup({ sourceDatabase: databasePath, sourceEvidence: evidencePath, backupRoot: backupPath });

    const restored = await rehearseDataRestore({
      backupPath,
      restoreRoot: restorePath,
      ...(() => {
        const ledger = writeDeletionLedger(root, [{
        requestId: "deletion-after-backup",
        userId: "later-deleted-user",
        completedAt,
        }]);
        return ledger.restoreArguments;
      })(),
    });

    const restoredDatabase = new BetterSqlite3(restored.databasePath, { readonly: true });
    const account = restoredDatabase.prepare(
      "SELECT email, display_name AS displayName, auth_provider AS authProvider FROM accounts WHERE id = ?",
    ).get("later-deleted-user") as { email: string; displayName: string | null; authProvider: string };
    const evidence = restoredDatabase.prepare(
      "SELECT owner_user_id AS ownerUserId, byte_size AS byteSize, deleted_at AS deletedAt FROM source_evidence_objects WHERE id = ?",
    ).get("later-deleted-evidence") as { ownerUserId: string | null; byteSize: number | null; deletedAt: string | null };
    restoredDatabase.close();
    expect(account.email).toBe("deleted-later-deleted-user@invalid.pintpath.local");
    expect(account.displayName).toBeNull();
    expect(account.authProvider).toBe("deleted");
    expect(evidence).toEqual({ ownerUserId: null, byteSize: null, deletedAt: completedAt });
    expect(fs.existsSync(path.join(restored.evidencePath, "later-deleted-user", "menu.pdf"))).toBe(false);
    expect(restored.tombstonesApplied).toBe(1);
    expect(restored.evidenceFilesPurged).toBe(1);
  });

  it("rejects tampered and unauthenticated empty offline deletion ledgers", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const backupPath = path.join(root, "backup");
    const database = new BetterSqlite3(databasePath);
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    database.close();
    await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: path.join(root, "evidence"),
      backupRoot: backupPath,
    });
    const trusted = writeDeletionLedger(root, [{
      requestId: "trusted-deletion",
      userId: "deleted-user",
      completedAt: "2026-07-14T10:00:00.000Z",
    }]);
    fs.appendFileSync(trusted.path, " ");
    await expect(rehearseDataRestore({
      backupPath,
      restoreRoot: path.join(root, "tampered-restore"),
      ...trusted.restoreArguments,
    })).rejects.toThrow("does not match its trusted SHA-256 checkpoint");

    const empty = writeDeletionLedger(root);
    await expect(rehearseDataRestore({
      backupPath,
      restoreRoot: path.join(root, "empty-restore"),
      deletionTombstonePath: empty.path,
      expectedDeletionTombstoneSha256: empty.sha256,
    } as unknown as Parameters<typeof rehearseDataRestore>[0])).rejects.toThrow(
      "Trusted SHA-256 checkpoints are required for deletion-ledger genesis and checkpoint records",
    );
  });

  it("rejects unlisted evidence and refuses to overwrite a backup directory", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = path.join(root, "live.sqlite");
    const evidencePath = path.join(root, "source-evidence");
    const backupPath = path.join(root, "backup");
    fs.mkdirSync(evidencePath, { recursive: true });
    const database = new BetterSqlite3(databasePath);
    database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
    database.close();

    await createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: evidencePath,
      backupRoot: backupPath,
    });
    fs.mkdirSync(path.join(backupPath, "source-evidence"), { recursive: true });
    fs.writeFileSync(path.join(backupPath, "source-evidence", "unlisted.jpg"), "unexpected");

    await expect(verifyDataBackup(backupPath)).rejects.toThrow("contents do not match");
    await expect(createDataBackup({
      sourceDatabase: databasePath,
      sourceEvidence: evidencePath,
      backupRoot: backupPath,
    })).rejects.toThrow("Backup destination is not empty");
  });
});
