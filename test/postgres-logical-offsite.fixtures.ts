import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
  postgresLogicalBackupManifestBindingSha256,
  type PostgresLogicalBackupManifest,
} from "../src/lib/postgres-logical-backup.js";
import {
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateInventory,
} from "../src/lib/postgres-logical-state.js";

export const LOGICAL_OFFSITE_ARCHIVE_BYTES = Buffer.from(
  "PGDMP-pintpath-offsite-attestation-test-archive",
);

export const LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY = Object.freeze({
  systemIdentifier: "7568999345281279000",
  databaseOid: "16655",
  databaseName: "pintpath",
  serverVersionNum: "170006",
});

export const LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256 =
  sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-source-database",
    version: 1,
    ...LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY,
  });

export function sha256Fixture(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function metadataRows(): readonly [string, string][] {
  return [
    ["import_state", "ready"],
    ["migration_candidate_sha", "c".repeat(40)],
    ["migration_contract_sha256", sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)],
    ["migration_manifest_sha256", "1".repeat(64)],
    ["migration_plan_sha256", "2".repeat(64)],
    ["migration_run_sha256", "3".repeat(64)],
    ["schema_version", "1"],
    ["source_schema_fingerprint", POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint],
    ["source_schema_sha256", "4".repeat(64)],
    ["source_schema_version", String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion)],
    ["source_snapshot_sha256", "5".repeat(64)],
    ["target_ddl_sha256", "6".repeat(64)],
  ];
}

function stateInventory(): PostgresLogicalStateInventory {
  const tables = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
    tableName: table.name,
    columnCount: table.columns.length,
    rowCount: table.name === "system_state" ? "1" : "0",
    transformedSha256: sha256Fixture(`table:${table.name}`),
    firstPrimaryKeySha256: table.name === "system_state"
      ? sha256Fixture("state-key")
      : null,
    lastPrimaryKeySha256: table.name === "system_state"
      ? sha256Fixture("state-key")
      : null,
  }));
  const withoutOverall = {
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    authoritativeRowCount: "1",
    nonEmptyAuthoritativeTableCount: 1,
    zeroRowAuthoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables - 1,
    migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSchemaSha256: "4".repeat(64),
    sourceSnapshotSha256: "5".repeat(64),
    targetDdlSha256: "6".repeat(64),
    schemaMetadataSha256: sha256CanonicalPostgresLogicalState(metadataRows()),
    tableSetSha256: "7".repeat(64),
    transformedDataSha256: "8".repeat(64),
    keyRangesSha256: "9".repeat(64),
    stateTotalsSha256: "a".repeat(64),
    archivedControlTableCount: 3,
    archivedControlRowCount: "14",
    archivedControlTableSetSha256: "d".repeat(64),
    archivedControlDataSha256: "e".repeat(64),
    archivedControlKeyRangesSha256: "f".repeat(64),
    tables,
    archivedControlTables: [
      {
        tableName: "pintpath_app.schema_metadata",
        columnCount: 3,
        rowCount: "12",
        transformedSha256: sha256Fixture("metadata"),
        firstPrimaryKeySha256: sha256Fixture("import_state"),
        lastPrimaryKeySha256: sha256Fixture("target_ddl_sha256"),
      },
      {
        tableName: "pintpath_ops.migration_chunks",
        columnCount: 7,
        rowCount: "1",
        transformedSha256: sha256Fixture("chunks"),
        firstPrimaryKeySha256: sha256Fixture("chunk-key"),
        lastPrimaryKeySha256: sha256Fixture("chunk-key"),
      },
      {
        tableName: "pintpath_ops.migration_runs",
        columnCount: 18,
        rowCount: "1",
        transformedSha256: sha256Fixture("runs"),
        firstPrimaryKeySha256: sha256Fixture("run-key"),
        lastPrimaryKeySha256: sha256Fixture("run-key"),
      },
    ],
  };
  return {
    ...withoutOverall,
    overallStateSha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-inventory",
      version: 1,
      ...withoutOverall,
    }),
  };
}

export function writeLogicalOffsiteFixture(
  root: string,
  createdAt = "2026-08-09T01:00:00.000Z",
): {
  readonly backupDirectory: string;
  readonly manifest: PostgresLogicalBackupManifest;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly receiptSha256: string;
} {
  const backupDirectory = path.join(root, "logical-backup");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const archiveSha256 = sha256Fixture(LOGICAL_OFFSITE_ARCHIVE_BYTES);
  const inventory = stateInventory();
  const provisional: PostgresLogicalBackupManifest = {
    schemaVersion: 2,
    kind: "pintpath-postgres-logical-backup",
    createdAt,
    archive: {
      file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      format: "custom",
      bytes: LOGICAL_OFFSITE_ARCHIVE_BYTES.length,
      sha256: archiveSha256,
      schemas: ["pintpath_app", "pintpath_ops"],
      aclStatementsIncluded: false,
      requiredRestoreOptions: ["--no-owner", "--no-acl"],
    },
    tools: {
      pgDump: { name: "pg_dump", version: "17.10 (Homebrew)", major: 17 },
      pgRestore: { name: "pg_restore", version: "17.10 (Homebrew)", major: 17 },
    },
    validation: {
      method: "pg_restore --list",
      tocEntries: 4,
      listedEntries: 4,
      listingSha256: "b".repeat(64),
      dumpedFromDatabaseVersion: "17.6",
      dumpedByPgDumpVersion: "17.10 (Homebrew)",
    },
    state: {
      receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      receiptSha256: "0".repeat(64),
      manifestBindingSha256: "0".repeat(64),
      sourceDatabaseIdentitySha256: LOGICAL_OFFSITE_SOURCE_DATABASE_IDENTITY_SHA256,
      sourceUrlSha256: "d".repeat(64),
      snapshotBindingSha256: "e".repeat(64),
      migrationContractSha256: inventory.migrationContractSha256,
      schemaMetadataSha256: inventory.schemaMetadataSha256,
      targetDdlSha256: inventory.targetDdlSha256,
      authoritativeTableCount: inventory.authoritativeTableCount,
      authoritativeRowCount: inventory.authoritativeRowCount,
      tableSetSha256: inventory.tableSetSha256,
      transformedDataSha256: inventory.transformedDataSha256,
      stateTotalsSha256: inventory.stateTotalsSha256,
      keyRangesSha256: inventory.keyRangesSha256,
      archivedControlTableCount: inventory.archivedControlTableCount,
      archivedControlRowCount: inventory.archivedControlRowCount,
      archivedControlTableSetSha256: inventory.archivedControlTableSetSha256,
      archivedControlDataSha256: inventory.archivedControlDataSha256,
      archivedControlKeyRangesSha256: inventory.archivedControlKeyRangesSha256,
      overallStateSha256: inventory.overallStateSha256,
    },
  };
  const bindingSha256 = postgresLogicalBackupManifestBindingSha256(provisional);
  const receipt = buildPostgresLogicalSourceStateReceipt({
    capturedAt: createdAt,
    databaseIdentitySha256: provisional.state.sourceDatabaseIdentitySha256,
    sourceUrlSha256: provisional.state.sourceUrlSha256,
    snapshotBindingSha256: provisional.state.snapshotBindingSha256,
    archiveBytes: LOGICAL_OFFSITE_ARCHIVE_BYTES.length,
    archiveSha256,
    archiveListingSha256: provisional.validation.listingSha256,
    manifestBindingSha256: bindingSha256,
    state: inventory,
  });
  const receiptBytes = canonicalPostgresLogicalStateJson(receipt);
  const receiptSha256 = sha256Fixture(receiptBytes);
  const manifest: PostgresLogicalBackupManifest = {
    ...provisional,
    state: {
      ...provisional.state,
      receiptSha256,
      manifestBindingSha256: bindingSha256,
    },
  };
  const manifestBytes = canonicalPostgresBackupJson(manifest);
  const files = [
    [POSTGRES_LOGICAL_BACKUP_ARCHIVE, LOGICAL_OFFSITE_ARCHIVE_BYTES],
    [POSTGRES_LOGICAL_BACKUP_MANIFEST, manifestBytes],
    [POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT, receiptBytes],
  ] as const;
  for (const [filename, bytes] of files) {
    const filePath = path.join(backupDirectory, filename);
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }
  return {
    backupDirectory,
    manifest,
    manifestSha256: sha256Fixture(manifestBytes),
    archiveSha256,
    receiptSha256,
  };
}
