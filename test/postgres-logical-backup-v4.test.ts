import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  buildPostgresLogicalBackupManifestV4,
  canonicalPostgresLogicalBackupManifestV4,
  parsePostgresLogicalBackupManifestV4,
  POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_CAPABILITY,
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE,
  POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES,
  POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  postgresLogicalBackupManifestV4BindingSha256,
  type PostgresLogicalBackupManifestV4,
} from "../src/lib/postgres-logical-backup-v4.js";
import {
  canonicalPostgresLogicalStateJson,
  POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256,
  postgresLogicalStateInternals,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateCaptureV2,
  type PostgresLogicalStateTableReceipt,
} from "../src/lib/postgres-logical-state.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256 as LEAF_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS as LEAF_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256 as LEAF_TABLE_SET_SHA256,
} from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
} from "../src/lib/postgres-reviewed-price-promotion-kernel.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractSha256 = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);

const controls = [
  ["pintpath_app.schema_metadata", ["key", "value", "updated_at"]],
  ["pintpath_ops.migration_chunks", [
    "run_id", "table_name", "chunk_ordinal", "row_count",
    "source_transformed_sha256", "target_sha256", "completed_at",
  ]],
  ["pintpath_ops.migration_runs", [
    "run_id", "source_snapshot_sha256", "source_schema_fingerprint", "contract_sha256",
    "manifest_sha256", "target_ddl_sha256", "source_schema_version", "candidate_commit_sha",
    "target_binding_sha256", "expected_environment", "approval_reference_sha256",
    "operator_id_sha256", "verifier_id_sha256", "status", "started_at", "completed_at",
    "receipt_sha256", "failure_code",
  ]],
  ["pintpath_ops.reviewed_price_promotion_operations", [
    "operation_id", "operation_kind", "source_apply_operation_id", "candidate_sha",
    "expected_environment", "authority_bundle_sha256", "plan_candidate_sha256",
    "review_packet_candidate_sha256", "target_physical_identity_sha256",
    "source_snapshot_sha256", "request_sha256", "requested_row_count", "committed_at",
    "result_state_sha256", "receipt_sha256",
  ]],
  ["pintpath_ops.reviewed_price_promotion_rows", [
    "operation_id", "row_ordinal", "source_ingestion_id", "venue_id", "price_record_id",
    "venue_beer_id", "normalized_beer_id", "row_request_sha256", "before_state_sha256",
    "after_state_sha256", "row_receipt_sha256",
  ]],
] as const;

function update(hash: crypto.Hash, value: string): void {
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function framedSha(values: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const value of values) update(hash, value);
  return hash.digest("hex");
}

function emptyTable(name: string, columns: readonly string[]): string {
  return framedSha([
    "pint-path-postgres-transformed-table-v2", contractSha256, name, ...columns,
  ]);
}

function emptyControl(name: string, columns: readonly string[]): string {
  return framedSha([
    "pintpath-postgres-logical-control-table-v2", contractSha256, name, ...columns,
  ]);
}

function primaryKey(value: string): string {
  return framedSha(["pint-path-source-primary-key-v2", `T${value}`]);
}

function aggregates(
  receipts: readonly PostgresLogicalStateTableReceipt[],
  domains: readonly [string, string, string],
) {
  const set = crypto.createHash("sha256");
  const data = crypto.createHash("sha256");
  const ranges = crypto.createHash("sha256");
  update(set, domains[0]);
  update(data, domains[1]);
  update(ranges, domains[2]);
  for (const receipt of receipts) {
    update(set, receipt.tableName);
    update(set, receipt.rowCount);
    update(data, receipt.tableName);
    update(data, receipt.transformedSha256);
    update(ranges, receipt.tableName);
    update(ranges, receipt.rowCount);
    update(ranges, receipt.firstPrimaryKeySha256 ?? "");
    update(ranges, receipt.lastPrimaryKeySha256 ?? "");
  }
  return [set.digest("hex"), data.digest("hex"), ranges.digest("hex")] as const;
}

function validCapture(): PostgresLogicalStateCaptureV2 {
  const tables = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
    tableName: table.name,
    columnCount: table.columns.length,
    rowCount: "0",
    transformedSha256: emptyTable(table.name, table.columns.map((column) => column[0])),
    firstPrimaryKeySha256: null,
    lastPrimaryKeySha256: null,
  }));
  const controlTables: PostgresLogicalStateTableReceipt[] = controls.map(([name, columns], index) => (
    index === 0
      ? {
        tableName: name,
        columnCount: columns.length,
        rowCount: "12",
        transformedSha256: "a".repeat(64),
        firstPrimaryKeySha256: primaryKey("import_state"),
        lastPrimaryKeySha256: primaryKey("target_ddl_sha256"),
      }
      : {
        tableName: name,
        columnCount: columns.length,
        rowCount: "0",
        transformedSha256: emptyControl(name, columns),
        firstPrimaryKeySha256: null,
        lastPrimaryKeySha256: null,
      }
  ));
  const [tableSetSha256, transformedDataSha256, keyRangesSha256] = aggregates(tables, [
    "pint-path-postgres-table-set-v2",
    "pint-path-postgres-transformed-data-v2",
    "pint-path-postgres-logical-key-ranges-v2",
  ]);
  const [controlTableSetSha256, controlDataSha256, controlKeyRangesSha256] = aggregates(
    controlTables,
    [
      "pintpath-postgres-logical-control-table-set-v2",
      "pintpath-postgres-logical-control-data-v2",
      "pintpath-postgres-logical-control-key-ranges-v2",
    ],
  );
  const withoutOverall = {
    authoritativeTableCount: 56,
    authoritativeColumnCount: 717,
    authoritativeRowCount: "0",
    nonEmptyAuthoritativeTableCount: 0,
    zeroRowAuthoritativeTableCount: 56,
    migrationContractSha256: contractSha256,
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSchemaSha256: "1".repeat(64),
    sourceSnapshotSha256: "2".repeat(64),
    targetDdlSha256: POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256,
    schemaMetadataSha256: "3".repeat(64),
    tableSetSha256,
    transformedDataSha256,
    keyRangesSha256,
    stateTotalsSha256: framedSha(["pint-path-postgres-state-totals-v2"]),
    kernelContractSha256: POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256,
    kernelMigrationSha256: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
    sourceReadBoundarySha256: POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256,
    controlTableCount: 5 as const,
    controlRowCount: "12",
    controlTableSetSha256,
    controlDataSha256,
    controlKeyRangesSha256,
    tables,
    controlTables,
  };
  return {
    inventory: {
      ...withoutOverall,
      overallStateSha256: sha256CanonicalPostgresLogicalState({
        kind: "pintpath-postgres-logical-state-inventory",
        version: 2,
        ...withoutOverall,
      }),
    },
    sourceDatabaseOid: "12345",
    sourcePhysicalReadBoundarySha256: "5".repeat(64),
  };
}

function rebindCaptureAggregates(capture: PostgresLogicalStateCaptureV2): void {
  const authoritative = aggregates(capture.inventory.tables, [
    "pint-path-postgres-table-set-v2",
    "pint-path-postgres-transformed-data-v2",
    "pint-path-postgres-logical-key-ranges-v2",
  ]);
  const control = aggregates(capture.inventory.controlTables, [
    "pintpath-postgres-logical-control-table-set-v2",
    "pintpath-postgres-logical-control-data-v2",
    "pintpath-postgres-logical-control-key-ranges-v2",
  ]);
  const authoritativeRowCount = capture.inventory.tables.reduce(
    (sum, table) => sum + BigInt(table.rowCount), 0n,
  );
  const nonEmpty = capture.inventory.tables.filter((table) => table.rowCount !== "0").length;
  capture.inventory.authoritativeRowCount = authoritativeRowCount.toString();
  capture.inventory.nonEmptyAuthoritativeTableCount = nonEmpty;
  capture.inventory.zeroRowAuthoritativeTableCount = 56 - nonEmpty;
  capture.inventory.tableSetSha256 = authoritative[0];
  capture.inventory.transformedDataSha256 = authoritative[1];
  capture.inventory.keyRangesSha256 = authoritative[2];
  capture.inventory.controlRowCount = capture.inventory.controlTables.reduce(
    (sum, table) => sum + BigInt(table.rowCount), 0n,
  ).toString();
  capture.inventory.controlTableSetSha256 = control[0];
  capture.inventory.controlDataSha256 = control[1];
  capture.inventory.controlKeyRangesSha256 = control[2];
  const { overallStateSha256: _ignored, ...withoutOverall } = capture.inventory;
  capture.inventory.overallStateSha256 = sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-state-inventory", version: 2, ...withoutOverall,
  });
}

function validManifest(): PostgresLogicalBackupManifestV4 {
  return buildPostgresLogicalBackupManifestV4({
    createdAt: "2026-08-12T08:00:00.000Z",
    archiveBytes: 12345,
    archiveSha256: "6".repeat(64),
    archiveListingSha256: "7".repeat(64),
    toc: {
      tocEntries: 63,
      listedEntries: 59,
      tableDataEntries: 59,
      tableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
      entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
    },
    pgDump: {
      name: "pg_dump", version: "17.10", major: 17, executableSha256: "8".repeat(64),
    },
    pgRestore: {
      name: "pg_restore", version: "17.10", major: 17, executableSha256: "9".repeat(64),
    },
    rootCaCertificateSha256: "b".repeat(64),
    databaseIdentitySha256: "c".repeat(64),
    sourceUrlSha256: "d".repeat(64),
    exportedSnapshotBindingSha256: "e".repeat(64),
    sourceAuthorityReceiptSha256: "f".repeat(64),
    sourceCapture: validCapture(),
  });
}

function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalPostgresLogicalStateJson(value));
}

function rebind(manifest: PostgresLogicalBackupManifestV4): PostgresLogicalBackupManifestV4 {
  return {
    ...manifest,
    manifestBindingSha256: postgresLogicalBackupManifestV4BindingSha256(manifest),
  };
}

describe("offline PostgreSQL logical-backup V4 contract", () => {
  it("builds and strictly round-trips one inert 59-table data-only manifest", () => {
    const manifest = validManifest();
    const bytes = canonicalPostgresLogicalBackupManifestV4(manifest);
    expect(parsePostgresLogicalBackupManifestV4(bytes)).toEqual(manifest);
    expect(manifest.archive.toc).toMatchObject({
      tocEntries: 63, listedEntries: 59, tableDataEntries: 59,
    });
    expect(manifest.archive.archiveRowCount).toBe("12");
    expect(manifest.verificationRequirements.requiredForeignKeyIntegrity).toEqual({
      canonicalForeignKeyCount: 79,
      requiredViolationRowCount: 0,
    });
    expect(manifest.archive.requiredDynamicDumpArgumentBindings).toEqual({
      profile: "source-authority-receipt-bound-pg-dump-arguments-v1",
      roleArgument: "--role=pintpath_logical_backup_d12345",
      snapshotArgumentTemplate: "--snapshot=<authenticated-exported-snapshot>",
      exportedSnapshotBindingSha256: "e".repeat(64),
      requiresExactSnapshotArgumentReceiptVerification: true,
    });
    expect(manifest.verificationRequirements).toMatchObject({
      requiresExactTargetV2InventoryMatch: true,
      requiresFreshTargetPhysicalReadBoundaryVerification: true,
      requiredPreLoadTargetState: {
        requiredEmptyTableCount: 59,
        requiresSchemaMetadataSeedRemoval: true,
        requiresAllTableDataRelationsEmpty: true,
        requiresKernelLedgersEmpty: true,
        requiresPinnedSchemaAuthorityVerificationBeforeLoad: true,
        requiresEmptyStateReceiptAfterSeedRemoval: true,
      },
      requiredScratchRestoreAuthority: {
        requiresCurrentUserSuperuser: true,
        requiresDisposableTargetIdentityBinding: true,
        requiresIndependentReceiptVerification: true,
      },
    });
    expect(manifest.verificationRequirements.opaqueCaptureDigestsNotStandaloneAuthority)
      .toEqual([
        "schemaMetadataSha256",
        "sourceSchemaSha256",
        "sourceSnapshotSha256",
        "stateTotalsSha256",
        "sourcePhysicalReadBoundarySha256",
      ]);
    expect(POSTGRES_LOGICAL_BACKUP_V4_CAPABILITY).toMatchObject({
      implementationState: "OFFLINE_CONTRACT_ONLY",
      artifactEmissionImplemented: false,
      restoreImplemented: false,
    });
  });

  it("derives the exact sorted table set and excludes both inert kernel ledgers", () => {
    expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS)
      .toBe(LEAF_TABLE_DATA_DESCRIPTORS);
    expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256).toBe(LEAF_TABLE_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256)
      .toBe(LEAF_EXPECTED_TABLE_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS).toHaveLength(59);
    const names = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map(
      (entry) => `${entry.schemaName}.${entry.tableName}`,
    );
    expect(names).not.toContain("pintpath_ops.migration_verifier_authority");
    const expectedNames = [
      ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => `pintpath_app.${table.name}`),
      "pintpath_app.schema_metadata",
      "pintpath_ops.migration_chunks",
      "pintpath_ops.migration_runs",
    ].sort();
    expect(names).toEqual(expectedNames);
    expect(names).toContain("pintpath_app.schema_metadata");
    expect(names).toContain("pintpath_ops.migration_chunks");
    expect(names).toContain("pintpath_ops.migration_runs");
    expect(names.some((name) => name.includes("reviewed_price_promotion"))).toBe(false);
    expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256);
    expect(contractSha256).toBe(POSTGRES_LOGICAL_BACKUP_V4_MIGRATION_CONTRACT_SHA256);
    expect(POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_KERNEL_CONTRACT_SHA256);
    expect(sha256CanonicalPostgresLogicalState(
      postgresLogicalStateInternals.sourceReadBoundaryHashProjection(
        postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor("independent-owner"),
      ),
    )).toBe(POSTGRES_LOGICAL_BACKUP_V4_PORTABLE_BOUNDARY_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS).toHaveLength(68);
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS).toContain("--no-large-objects");
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS).toContain("--no-password");
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS)
      .toContain("--lock-wait-timeout=30s");
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS)
      .toContain("--disable-triggers");
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS)
      .toContain("--no-password");
  });

  it("pins the checked-in target DDL and remains structurally free of operational imports", () => {
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      path.join(repositoryRoot, "src/db/postgres-schema.sql"),
    )).digest("hex")).toBe(POSTGRES_LOGICAL_BACKUP_V4_BASE_DDL_SHA256);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256);
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      path.join(repositoryRoot, POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_FILE),
    )).digest("hex")).toBe(POSTGRES_LOGICAL_BACKUP_V4_KERNEL_MIGRATION_SHA256);
    const source = fs.readFileSync(
      path.join(repositoryRoot, "src/lib/postgres-logical-backup-v4.ts"), "utf8",
    );
    for (const forbidden of [
      "node:fs", "node:child_process", "from \"pg\"", "postgres-logical-backup.js",
      "process.env", "spawn(", "fetch(",
    ]) expect(source).not.toContain(forbidden);
  });

  it("rejects a self-rebound V2 aggregate forgery", () => {
    const capture = structuredClone(validCapture());
    capture.inventory.authoritativeRowCount = "1";
    const { overallStateSha256: _ignored, ...withoutOverall } = capture.inventory;
    capture.inventory.overallStateSha256 = sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-inventory", version: 2, ...withoutOverall,
    });
    expect(() => buildPostgresLogicalBackupManifestV4({
      ...validManifestInput(), sourceCapture: capture,
    })).toThrow("manifest_invalid");
  });

  it("rejects rebound empty-kernel, metadata-count, and noncanonical count captures", () => {
    for (const mutate of [
      (capture: PostgresLogicalStateCaptureV2) => {
        capture.inventory.controlTables[3]!.transformedSha256 = "c".repeat(64);
      },
      (capture: PostgresLogicalStateCaptureV2) => {
        capture.inventory.controlTables[0]!.rowCount = "11";
      },
      (capture: PostgresLogicalStateCaptureV2) => {
        capture.inventory.tables[0]!.rowCount = "00";
      },
    ]) {
      const capture = structuredClone(validCapture());
      mutate(capture);
      expect(() => buildPostgresLogicalBackupManifestV4({
        ...validManifestInput(), sourceCapture: capture,
      })).toThrow("manifest_invalid");
    }
  });

  it("rejects self-rebound impossible v2 receipt and empty-total shapes", () => {
    const candidates: PostgresLogicalStateCaptureV2[] = [];
    const splitSingleEndpoint = structuredClone(validCapture());
    Object.assign(splitSingleEndpoint.inventory.tables[0]!, {
      rowCount: "1",
      transformedSha256: "c".repeat(64),
      firstPrimaryKeySha256: "d".repeat(64),
      lastPrimaryKeySha256: "e".repeat(64),
    });
    rebindCaptureAggregates(splitSingleEndpoint);
    candidates.push(splitSingleEndpoint);

    const nonemptyWithEmptyDigest = structuredClone(validCapture());
    Object.assign(nonemptyWithEmptyDigest.inventory.tables[0]!, {
      rowCount: "1",
      firstPrimaryKeySha256: "d".repeat(64),
      lastPrimaryKeySha256: "d".repeat(64),
    });
    rebindCaptureAggregates(nonemptyWithEmptyDigest);
    candidates.push(nonemptyWithEmptyDigest);

    const forgedEmptyTotals = structuredClone(validCapture());
    forgedEmptyTotals.inventory.stateTotalsSha256 = "f".repeat(64);
    rebindCaptureAggregates(forgedEmptyTotals);
    candidates.push(forgedEmptyTotals);

    for (const sourceCapture of candidates) {
      expect(() => buildPostgresLogicalBackupManifestV4({
        ...validManifestInput(), sourceCapture,
      })).toThrow("manifest_invalid");
    }
  });

  it("rejects TOC, schema-authority, pairing, and kernel-entry rebinding", () => {
    const base = validManifest();
    const candidates: PostgresLogicalBackupManifestV4[] = [];
    const toc = structuredClone(base);
    toc.archive.toc.tocEntries = 59 as 63;
    candidates.push(rebind(toc));
    const ddl = structuredClone(base);
    ddl.schemaAuthority.baseDdlSha256 = "d".repeat(64);
    candidates.push(rebind(ddl));
    const pairing = structuredClone(base);
    pairing.pairing.archiveRowCount = "13";
    candidates.push(rebind(pairing));
    const entry = structuredClone(base);
    entry.archive.toc.entries[0]!.tableName = "reviewed_price_promotion_rows";
    candidates.push(rebind(entry));
    for (const candidate of candidates) {
      expect(() => parsePostgresLogicalBackupManifestV4(canonical(candidate)))
        .toThrow("manifest_invalid");
    }
    expect(() => buildPostgresLogicalBackupManifestV4({
      ...validManifestInput(),
      toc: { ...validManifestInput().toc, listedEntries: 58 as 59 },
    })).toThrow("manifest_invalid");
  });

  it("rejects noncanonical JSON, extra fields, malformed UTF-8, and unsafe numbers", () => {
    const manifest = validManifest();
    expect(() => parsePostgresLogicalBackupManifestV4(Buffer.from(
      `${canonicalPostgresLogicalStateJson(manifest).trim()}  \n`,
    ))).toThrow("manifest_invalid");
    expect(() => parsePostgresLogicalBackupManifestV4(canonical({
      ...manifest, unexpected: true,
    }))).toThrow("manifest_invalid");
    expect(() => parsePostgresLogicalBackupManifestV4(Buffer.from([0xff, 0xfe])))
      .toThrow("manifest_invalid");
    expect(() => parsePostgresLogicalBackupManifestV4(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), canonical(manifest),
    ]))).toThrow("manifest_invalid");
    expect(() => buildPostgresLogicalBackupManifestV4({
      ...validManifestInput(), archiveBytes: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow("manifest_invalid");
  });

  it("applies byte and pre-canonicalization tree bounds", () => {
    expect(() => parsePostgresLogicalBackupManifestV4(
      Buffer.alloc(POSTGRES_LOGICAL_BACKUP_V4_MAX_MANIFEST_BYTES + 1, 0x20),
    )).toThrow("manifest_invalid");
    let nested: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) nested = { nested };
    expect(() => parsePostgresLogicalBackupManifestV4(canonical(nested)))
      .toThrow("manifest_invalid");
  });

  it("rejects PostgreSQL tool identities outside exact version 17", () => {
    expect(() => buildPostgresLogicalBackupManifestV4({
      ...validManifestInput(),
      pgDump: {
        name: "pg_dump", version: "18.0", major: 17, executableSha256: "8".repeat(64),
      },
    })).toThrow("manifest_invalid");
    expect(() => buildPostgresLogicalBackupManifestV4({
      ...validManifestInput(),
      pgDump: {
        name: "pg_dump", version: `17.${"0".repeat(1024)}`, major: 17,
        executableSha256: "8".repeat(64),
      },
    })).toThrow("manifest_invalid");
  });

  it("rejects live migration-contract drift after taking its immutable V4 snapshot", () => {
    const expectedCounts = POSTGRES_MIGRATION_CONTRACT.expectedCounts as {
      tables: number;
    };
    const originalTableCount = expectedCounts.tables;
    try {
      expectedCounts.tables = originalTableCount - 1;
      expect(() => buildPostgresLogicalBackupManifestV4(validManifestInput()))
        .toThrow("manifest_invalid");
    } finally {
      expectedCounts.tables = originalTableCount;
    }
    expect(() => buildPostgresLogicalBackupManifestV4(validManifestInput())).not.toThrow();
  });

  it("snapshots builder inputs and rejects hostile in-process object surfaces", () => {
    const input = validManifestInput();
    const manifest = buildPostgresLogicalBackupManifestV4(input);
    input.sourceCapture.inventory.tables[0]!.rowCount = "1";
    expect(manifest.sourceCapture.capture.inventory.tables[0]!.rowCount).toBe("0");
    expect(() => parsePostgresLogicalBackupManifestV4(
      canonicalPostgresLogicalBackupManifestV4(manifest),
    )).not.toThrow();

    let getterCalled = false;
    const accessorInput = { ...validManifestInput() };
    Object.defineProperty(accessorInput, "createdAt", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("attacker_error");
      },
    });
    expect(() => buildPostgresLogicalBackupManifestV4(accessorInput))
      .toThrow("manifest_invalid");
    expect(getterCalled).toBe(false);
    expect(() => buildPostgresLogicalBackupManifestV4(new Proxy(validManifestInput(), {
      ownKeys() {
        throw new Error("attacker_error");
      },
    }))).toThrow("manifest_invalid");

    for (const target of [validManifestInput(), validManifestInput().sourceCapture.inventory]) {
      Object.defineProperty(target, "__proto__", {
        enumerable: true, configurable: true, value: null,
      });
      expect(() => buildPostgresLogicalBackupManifestV4(
        "sourceCapture" in target
          ? target as ReturnType<typeof validManifestInput>
          : { ...validManifestInput(), sourceCapture: {
            ...validManifestInput().sourceCapture,
            inventory: target as unknown as PostgresLogicalStateCaptureV2["inventory"],
          } },
      )).toThrow("manifest_invalid");
    }
    const sparseInput = validManifestInput();
    Object.defineProperty(sparseInput.sourceCapture.inventory.tables, "999", {
      enumerable: true, configurable: true, value: sparseInput.sourceCapture.inventory.tables[0],
    });
    expect(() => buildPostgresLogicalBackupManifestV4(sparseInput))
      .toThrow("manifest_invalid");
  });
});

function validManifestInput() {
  return {
    createdAt: "2026-08-12T08:00:00.000Z",
    archiveBytes: 12345,
    archiveSha256: "6".repeat(64),
    archiveListingSha256: "7".repeat(64),
    toc: {
      tocEntries: 63 as const,
      listedEntries: 59 as const,
      tableDataEntries: 59 as const,
      tableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
      entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
    },
    pgDump: {
      name: "pg_dump" as const,
      version: "17.10",
      major: 17 as const,
      executableSha256: "8".repeat(64),
    },
    pgRestore: {
      name: "pg_restore" as const,
      version: "17.10",
      major: 17 as const,
      executableSha256: "9".repeat(64),
    },
    rootCaCertificateSha256: "b".repeat(64),
    databaseIdentitySha256: "c".repeat(64),
    sourceUrlSha256: "d".repeat(64),
    exportedSnapshotBindingSha256: "e".repeat(64),
    sourceAuthorityReceiptSha256: "f".repeat(64),
    sourceCapture: validCapture(),
  };
}
