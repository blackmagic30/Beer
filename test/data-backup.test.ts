import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { createDatabase } from "../src/db/database.js";
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
): { path: string; sha256: string } {
  const ledgerPath = path.join(root, `deletion-ledger-${Math.random().toString(16).slice(2)}.json`);
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt: "2026-07-14T12:00:00.000Z",
    tombstones,
  }, null, 2)}\n`);
  fs.writeFileSync(ledgerPath, bytes);
  return {
    path: ledgerPath,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
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
      deletionTombstonePath: ledger.path,
      expectedDeletionTombstoneSha256: ledger.sha256,
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
    repository.createSourceEvidenceObject({
      id: "later-deleted-evidence",
      ownerUserId: "later-deleted-user",
      storageProvider: "filesystem_private",
      objectPath: "later-deleted-user/menu.pdf",
      mimeType: "application/pdf",
      byteSize: 12,
      dataBase64: null,
      externalUrl: null,
      retentionExpiresAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
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
        return {
          deletionTombstonePath: ledger.path,
          expectedDeletionTombstoneSha256: ledger.sha256,
        };
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
      deletionTombstonePath: trusted.path,
      expectedDeletionTombstoneSha256: trusted.sha256,
    })).rejects.toThrow("does not match its trusted SHA-256 checkpoint");

    const empty = writeDeletionLedger(root);
    await expect(rehearseDataRestore({
      backupPath,
      restoreRoot: path.join(root, "empty-restore"),
      deletionTombstonePath: empty.path,
      expectedDeletionTombstoneSha256: empty.sha256,
    })).rejects.toThrow("empty deletion ledger requires its authenticated independent genesis and checkpoint");
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
