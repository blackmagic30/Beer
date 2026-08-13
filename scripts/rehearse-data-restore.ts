import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import dotenv from "dotenv";

import { rehearseDataRestore, sha256File } from "../src/lib/data-backup.js";
import { fetchVerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";
import { redactKnownSecretValues } from "../src/lib/redact.js";
import {
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

dotenv.config({ quiet: true });

const allowedArguments = new Set([
  "--backup",
  "--backup-id",
  "--source-manifest-sha256",
  "--tombstones",
  "--tombstone-sha256",
  "--tombstone-genesis",
  "--tombstone-genesis-sha256",
  "--tombstone-checkpoint",
  "--tombstone-checkpoint-sha256",
  "--output",
]);
const argumentsByName = parseStrictArguments(process.argv.slice(2), {
  allowed: allowedArguments,
  positionalName: "--backup",
});
const argumentValue = (name: string): string | null => argumentsByName.get(name) ?? null;

function recordRestoreState(databasePath: string, value: Record<string, unknown>): void {
  if (!fs.existsSync(databasePath)) return;
  const database = new BetterSqlite3(databasePath);
  try {
    const stateTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_state'")
      .get();
    if (!stateTable) return;
    const updatedAt = new Date().toISOString();
    const revision = `${updatedAt}#restore-rehearsal`;
    database.prepare(
      `INSERT INTO system_state (key, value_json, updated_at, revision)
       VALUES ('job:restore_rehearsal', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         revision = excluded.revision`,
    ).run(JSON.stringify(value), updatedAt, revision);
  } finally {
    database.close();
  }
}

const backupArgument = argumentValue("--backup");
if (!backupArgument) {
  throw new Error("Pass the backup directory with --backup=/path/to/backup.");
}
const backupPath = path.resolve(backupArgument);
const backupId = (argumentValue("--backup-id") || process.env.BACKUP_ID || "").trim();
if (!/^pint-path-[A-Za-z0-9][A-Za-z0-9._-]{8,120}$/.test(backupId)) {
  throw new Error("Pass the trusted off-site backup ID with --backup-id or BACKUP_ID.");
}
const expectedSourceManifestSha256 = (
  argumentValue("--source-manifest-sha256") || process.env.EXPECTED_MANIFEST_SHA256 || ""
).trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expectedSourceManifestSha256)) {
  throw new Error(
    "Pass the trusted source manifest SHA-256 with --source-manifest-sha256 or EXPECTED_MANIFEST_SHA256.",
  );
}
const actualSourceManifestSha256 = await sha256File(path.join(backupPath, "manifest.json"));
if (actualSourceManifestSha256 !== expectedSourceManifestSha256) {
  throw new Error("The source manifest does not match its trusted SHA-256 value.");
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
const restoreDatabasePath = path.join(restoreRoot, "pint-path.sqlite");
const ledgerTemporaryRoot = tombstoneArgument
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-restore-ledger-"));
const startedAt = new Date().toISOString();
recordRestoreState(restoreDatabasePath, { state: "running", startedAt });
let loadedDestinationServiceRoleKey: string | null = null;

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
    if (!authorityArguments.every(Boolean)) {
      throw new Error(
        "Offline restore requires genesis/checkpoint paths and both trusted SHA-256 values.",
      );
    }
    if (genesisArgument && genesisShaArgument && checkpointArgument && checkpointShaArgument) {
      deletionLedgerGenesisPath = path.resolve(genesisArgument);
      expectedDeletionLedgerGenesisSha256 = genesisShaArgument;
      deletionLedgerCheckpointPath = path.resolve(checkpointArgument);
      expectedDeletionLedgerCheckpointSha256 = checkpointShaArgument;
    }
  } else {
    const sourceSupabaseUrl = process.env.SUPABASE_URL;
    const destinationSupabaseUrl = process.env.OFFSITE_BACKUP_SUPABASE_URL;
    const destinationServiceRoleKey = process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY;
    if (!sourceSupabaseUrl || !destinationSupabaseUrl || !destinationServiceRoleKey) {
      throw new Error("Online restore requires SUPABASE_URL, OFFSITE_BACKUP_SUPABASE_URL, and OFFSITE_BACKUP_SERVICE_ROLE_KEY.");
    }
    assertExactSupabaseOrigin(sourceSupabaseUrl, "https://auth.pintpath.au", "SUPABASE_URL");
    assertExactSupabaseOrigin(
      destinationSupabaseUrl,
      "https://hfbmhdxrwtihukmixxta.supabase.co",
      "OFFSITE_BACKUP_SUPABASE_URL",
    );
    assertSupabaseServerApiKey(
      destinationServiceRoleKey,
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    );
    loadedDestinationServiceRoleKey = destinationServiceRoleKey;
    const verified = await fetchVerifiedAccountDeletionLedger({
      sourceSupabaseUrl,
      destinationSupabaseUrl,
      destinationServiceRoleKey,
      bucketName: resolveExactOperationalOffsiteBackupBucket(
        process.env.OFFSITE_BACKUP_BUCKET,
      ),
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
    backupPath,
    restoreRoot,
    deletionTombstonePath,
    expectedDeletionTombstoneSha256,
    deletionLedgerGenesisPath: deletionLedgerGenesisPath!,
    expectedDeletionLedgerGenesisSha256: expectedDeletionLedgerGenesisSha256!,
    deletionLedgerCheckpointPath: deletionLedgerCheckpointPath!,
    expectedDeletionLedgerCheckpointSha256: expectedDeletionLedgerCheckpointSha256!,
  });
  if (result.authority.sourceManifestSha256 !== expectedSourceManifestSha256) {
    throw new Error("The source manifest changed during restore rehearsal.");
  }
  const completedAt = new Date().toISOString();
  recordRestoreState(result.databasePath, {
    state: "succeeded",
    startedAt,
    completedAt,
    backupId,
    sourceManifestSha256: result.authority.sourceManifestSha256,
    sourceDatabaseSha256: result.authority.sourceDatabaseSha256,
    deletionLedgerSha256: result.authority.deletionLedgerSha256,
    deletionLedgerGenesisSha256: result.authority.deletionLedgerGenesisSha256,
    deletionLedgerCheckpointSha256: result.authority.deletionLedgerCheckpointSha256,
    databaseBytes: result.manifest.database.bytes,
    evidenceFileCount: result.manifest.evidence.fileCount,
    storageEvidenceFileCount: result.manifest.storageEvidence?.fileCount ?? 0,
    tombstonesApplied: result.tombstonesApplied,
    evidenceFilesPurged: result.evidenceFilesPurged,
    evidencePurgedPathSha256s: result.evidencePurgedPathSha256s,
  });
  console.log(JSON.stringify({
    ok: true,
    completedAt,
    backupId,
    sourceManifestSha256: result.authority.sourceManifestSha256,
    sourceDatabaseSha256: result.authority.sourceDatabaseSha256,
    deletionLedgerSha256: result.authority.deletionLedgerSha256,
    deletionLedgerGenesisSha256: result.authority.deletionLedgerGenesisSha256,
    deletionLedgerCheckpointSha256: result.authority.deletionLedgerCheckpointSha256,
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
  const safeError = error instanceof Error
    ? redactKnownSecretValues(
        error.message,
        [loadedDestinationServiceRoleKey],
      ).slice(0, 300)
    : "Restore rehearsal failed";
  recordRestoreState(restoreDatabasePath, {
    state: "failed",
    startedAt,
    completedAt,
    error: safeError,
  });
  loadedDestinationServiceRoleKey = null;
  throw new Error("Restore rehearsal failed.");
} finally {
  loadedDestinationServiceRoleKey = null;
  if (ledgerTemporaryRoot) {
    await fs.promises.rm(ledgerTemporaryRoot, { recursive: true, force: true });
  }
}
