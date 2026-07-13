import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createDataBackup, rehearseDataRestore, verifyDataBackup } from "../src/lib/data-backup.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
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

    const database = new BetterSqlite3(databasePath);
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

    const database = new BetterSqlite3(databasePath);
    database.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run("record-1", "restored");
    database.close();

    await createDataBackup({ sourceDatabase: databasePath, sourceEvidence: evidencePath, backupRoot: backupPath });
    const restored = await rehearseDataRestore({ backupPath, restoreRoot: restorePath });

    expect(restored.manifest.evidence.fileCount).toBe(1);
    expect(fs.readFileSync(path.join(restored.evidencePath, "menu.png"), "utf8")).toBe("restorable-image");
    const restoredDatabase = new BetterSqlite3(restored.databasePath, { readonly: true, fileMustExist: true });
    expect(restoredDatabase.prepare("SELECT value FROM records WHERE id = ?").pluck().get("record-1")).toBe("restored");
    restoredDatabase.close();
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
