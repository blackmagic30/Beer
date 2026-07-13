import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import dotenv from "dotenv";

import { rehearseDataRestore } from "../src/lib/data-backup.js";

dotenv.config();

function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function recordRestoreState(value: Record<string, unknown>): void {
  const sourceDatabase = path.resolve(process.env.DATABASE_PATH || "./data/pint-path.sqlite");
  if (!fs.existsSync(sourceDatabase)) return;
  const database = new BetterSqlite3(sourceDatabase);
  try {
    const stateTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_state'")
      .get();
    if (!stateTable) return;
    const updatedAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO system_state (key, value_json, updated_at)
       VALUES ('job:restore_rehearsal', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(value), updatedAt);
  } finally {
    database.close();
  }
}

const backupArgument = argumentValue("--backup") || process.argv[2];
if (!backupArgument) {
  throw new Error("Pass the backup directory with --backup=/path/to/backup.");
}

const explicitOutput = argumentValue("--output");
const restoreRoot = explicitOutput
  ? path.resolve(explicitOutput)
  : fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-restore-rehearsal-"));
const startedAt = new Date().toISOString();
recordRestoreState({ state: "running", startedAt });

try {
  const result = await rehearseDataRestore({
    backupPath: path.resolve(backupArgument),
    restoreRoot,
  });
  const completedAt = new Date().toISOString();
  recordRestoreState({
    state: "succeeded",
    startedAt,
    completedAt,
    databaseBytes: result.manifest.database.bytes,
    evidenceFileCount: result.manifest.evidence.fileCount,
  });
  console.log(JSON.stringify({
    ok: true,
    completedAt,
    restoreRoot,
    database: result.databasePath,
    evidenceFiles: result.manifest.evidence.fileCount,
    temporary: !explicitOutput,
  }, null, 2));
} catch (error) {
  const completedAt = new Date().toISOString();
  recordRestoreState({
    state: "failed",
    startedAt,
    completedAt,
    error: error instanceof Error ? error.message.slice(0, 300) : "Restore rehearsal failed",
  });
  throw error;
}
