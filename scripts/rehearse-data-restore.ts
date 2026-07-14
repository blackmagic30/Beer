import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import dotenv from "dotenv";

import { rehearseDataRestore } from "../src/lib/data-backup.js";
import { fetchVerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";

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
const tombstoneArgument = argumentValue("--tombstones");
const tombstoneShaArgument = argumentValue("--tombstone-sha256")?.trim().toLowerCase() ?? null;
const genesisArgument = argumentValue("--tombstone-genesis");
const genesisShaArgument = argumentValue("--tombstone-genesis-sha256")?.trim().toLowerCase() ?? null;
const checkpointArgument = argumentValue("--tombstone-checkpoint");
const checkpointShaArgument = argumentValue("--tombstone-checkpoint-sha256")?.trim().toLowerCase() ?? null;

const explicitOutput = argumentValue("--output");
const restoreRoot = explicitOutput
  ? path.resolve(explicitOutput)
  : fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-restore-rehearsal-"));
const ledgerTemporaryRoot = tombstoneArgument
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-restore-ledger-"));
const startedAt = new Date().toISOString();
recordRestoreState({ state: "running", startedAt });

try {
  let deletionTombstonePath: string;
  let expectedDeletionTombstoneSha256: string;
  let deletionLedgerGenesisPath: string | null = null;
  let expectedDeletionLedgerGenesisSha256: string | null = null;
  let deletionLedgerCheckpointPath: string | null = null;
  let expectedDeletionLedgerCheckpointSha256: string | null = null;
  if (tombstoneArgument) {
    if (!tombstoneShaArgument) {
      throw new Error("Offline/manual restore requires --tombstone-sha256=<trusted-out-of-band-sha256>.");
    }
    deletionTombstonePath = path.resolve(tombstoneArgument);
    expectedDeletionTombstoneSha256 = tombstoneShaArgument;
    const authorityArguments = [
      genesisArgument,
      genesisShaArgument,
      checkpointArgument,
      checkpointShaArgument,
    ];
    if (authorityArguments.some(Boolean) && !authorityArguments.every(Boolean)) {
      throw new Error(
        "Offline empty-ledger authority requires genesis/checkpoint paths and both trusted SHA-256 values.",
      );
    }
    if (genesisArgument && genesisShaArgument && checkpointArgument && checkpointShaArgument) {
      deletionLedgerGenesisPath = path.resolve(genesisArgument);
      expectedDeletionLedgerGenesisSha256 = genesisShaArgument;
      deletionLedgerCheckpointPath = path.resolve(checkpointArgument);
      expectedDeletionLedgerCheckpointSha256 = checkpointShaArgument;
    }
  } else {
    const sourceSupabaseUrl = process.env.SUPABASE_URL?.trim();
    const destinationSupabaseUrl = process.env.OFFSITE_BACKUP_SUPABASE_URL?.trim();
    const destinationServiceRoleKey = process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY?.trim();
    if (!sourceSupabaseUrl || !destinationSupabaseUrl || !destinationServiceRoleKey) {
      throw new Error("Online restore requires SUPABASE_URL, OFFSITE_BACKUP_SUPABASE_URL, and OFFSITE_BACKUP_SERVICE_ROLE_KEY.");
    }
    const verified = await fetchVerifiedAccountDeletionLedger({
      sourceSupabaseUrl,
      destinationSupabaseUrl,
      destinationServiceRoleKey,
      bucketName: process.env.OFFSITE_BACKUP_BUCKET?.trim() || "pintpath-backups",
    });
    deletionTombstonePath = path.join(ledgerTemporaryRoot!, "account-deletion-tombstones.json");
    deletionLedgerGenesisPath = path.join(ledgerTemporaryRoot!, "account-deletion-ledger-genesis.json");
    deletionLedgerCheckpointPath = path.join(ledgerTemporaryRoot!, "account-deletion-ledger-checkpoint.json");
    await fs.promises.writeFile(deletionTombstonePath, verified.bytes, { mode: 0o600 });
    await fs.promises.writeFile(deletionLedgerGenesisPath, verified.genesisBytes, { mode: 0o600 });
    await fs.promises.writeFile(deletionLedgerCheckpointPath, verified.checkpointBytes, { mode: 0o600 });
    expectedDeletionTombstoneSha256 = verified.sha256;
    expectedDeletionLedgerGenesisSha256 = verified.genesisSha256;
    expectedDeletionLedgerCheckpointSha256 = verified.checkpointSha256;
  }
  const result = await rehearseDataRestore({
    backupPath: path.resolve(backupArgument),
    restoreRoot,
    deletionTombstonePath,
    expectedDeletionTombstoneSha256,
    ...(deletionLedgerGenesisPath &&
      expectedDeletionLedgerGenesisSha256 &&
      deletionLedgerCheckpointPath &&
      expectedDeletionLedgerCheckpointSha256
      ? {
        deletionLedgerGenesisPath,
        expectedDeletionLedgerGenesisSha256,
        deletionLedgerCheckpointPath,
        expectedDeletionLedgerCheckpointSha256,
      }
      : {}),
  });
  const completedAt = new Date().toISOString();
  recordRestoreState({
    state: "succeeded",
    startedAt,
    completedAt,
    databaseBytes: result.manifest.database.bytes,
    evidenceFileCount: result.manifest.evidence.fileCount,
    storageEvidenceFileCount: result.manifest.storageEvidence?.fileCount ?? 0,
    tombstonesApplied: result.tombstonesApplied,
    evidenceFilesPurged: result.evidenceFilesPurged,
  });
  console.log(JSON.stringify({
    ok: true,
    completedAt,
    restoreRoot,
    database: result.databasePath,
    evidenceFiles: result.manifest.evidence.fileCount,
    storageEvidenceFiles: result.manifest.storageEvidence?.fileCount ?? 0,
    tombstonesApplied: result.tombstonesApplied,
    evidenceFilesPurged: result.evidenceFilesPurged,
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
} finally {
  if (ledgerTemporaryRoot) {
    await fs.promises.rm(ledgerTemporaryRoot, { recursive: true, force: true });
  }
}
