import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPostgresLogicalRestoreCli,
  type PostgresLogicalRestoreCliDependencies,
} from "../scripts/restore-postgres-logical.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  canonicalPostgresBackupJson,
  postgresLogicalBackupManifestBindingSha256,
  type PostgresLogicalBackupManifest,
  type ProcessInvocation,
  type ProcessResult,
} from "../src/lib/postgres-logical-backup.js";
import {
  PostgresToolAuthorityError,
  type PostgresRestoreOperationInput,
  type PostgresRestoreToolAuthority,
  type PostgresToolProcessResult,
} from "../src/lib/postgres-tool-authority.js";
import {
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateInventory,
} from "../src/lib/postgres-logical-state.js";
import {
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
  PostgresLogicalRestoreError,
  inspectPostgresLogicalRestoreTarget,
  parsePostgresLogicalBackupManifest,
  restorePostgresLogicalBackup,
  type PostgresLogicalRestoreConnection,
  type PostgresLogicalRestoreConnectionConfig,
  type PostgresLogicalRestoreDependencies,
  type PostgresLogicalRestoreQueryResult,
} from "../src/lib/postgres-logical-restore.js";

const roots: string[] = [];
const secret = "restore-target-super-secret";
const targetUrl = `postgresql://restore_admin:${secret}@db.example.invalid:5432/pintpath_restore?sslmode=verify-full`;
const archiveBytes = Buffer.from("PGDMP-restore-test-archive", "utf8");
const now = "2026-08-08T06:00:00.000Z";
const rootCaCertificateSha256 = "f".repeat(64);
const testPgRestoreFile = "/reviewed/postgresql/17/bin/pg_restore";
const testPgRestoreSha256 = crypto.createHash("sha256")
  .update("reviewed-test-pg-restore", "utf8")
  .digest("hex");

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-restore-test-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function archiveListing(): string {
  return [
    ";",
    ";     TOC Entries: 4",
    ";     Dumped from database version: 17.6",
    ";     Dumped by pg_dump version: 17.10 (Homebrew)",
    ";",
    "2; 2615 100 SCHEMA - pintpath_app restore_admin",
    "3; 2615 101 SCHEMA - pintpath_ops restore_admin",
    "4; 1259 102 TABLE pintpath_app system_state restore_admin",
    "5; 0 102 TABLE DATA pintpath_app system_state restore_admin",
    "",
  ].join("\n");
}

function stateInventory(): PostgresLogicalStateInventory {
  const tables = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
    tableName: table.name,
    columnCount: table.columns.length,
    rowCount: table.name === "system_state" ? "1" : "0",
    transformedSha256: sha256(`table:${table.name}`),
    firstPrimaryKeySha256: table.name === "system_state" ? sha256("state-key") : null,
    lastPrimaryKeySha256: table.name === "system_state" ? sha256("state-key") : null,
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
    schemaMetadataSha256: sha256CanonicalPostgresLogicalState(
      metadataRows().map((row) => [row.key, row.value]),
    ),
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
        tableName: "pintpath_app.schema_metadata", columnCount: 3, rowCount: "12",
        transformedSha256: sha256("metadata"), firstPrimaryKeySha256: sha256("import_state"),
        lastPrimaryKeySha256: sha256("target_ddl_sha256"),
      },
      {
        tableName: "pintpath_ops.migration_chunks", columnCount: 7, rowCount: "1",
        transformedSha256: sha256("chunks"), firstPrimaryKeySha256: sha256("chunk-key"),
        lastPrimaryKeySha256: sha256("chunk-key"),
      },
      {
        tableName: "pintpath_ops.migration_runs", columnCount: 18, rowCount: "1",
        transformedSha256: sha256("runs"), firstPrimaryKeySha256: sha256("run-key"),
        lastPrimaryKeySha256: sha256("run-key"),
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

function makeArtifacts(
  listing = archiveListing(),
  manifestSchemaVersion: 2 | 3 = 3,
): {
  manifest: PostgresLogicalBackupManifest;
  receiptBytes: string;
} {
  const state = stateInventory();
  const common = {
    kind: "pintpath-postgres-logical-backup",
    createdAt: "2026-08-08T05:00:00.000Z",
    archive: {
      file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      format: "custom",
      bytes: archiveBytes.length,
      sha256: sha256(archiveBytes),
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
      listingSha256: sha256(listing),
      dumpedFromDatabaseVersion: "17.6",
      dumpedByPgDumpVersion: "17.10 (Homebrew)",
    },
    state: {
      receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      receiptSha256: "0".repeat(64),
      manifestBindingSha256: "0".repeat(64),
      sourceDatabaseIdentitySha256: "b".repeat(64),
      sourceUrlSha256: "c".repeat(64),
      snapshotBindingSha256: "d".repeat(64),
      migrationContractSha256: state.migrationContractSha256,
      schemaMetadataSha256: state.schemaMetadataSha256,
      targetDdlSha256: state.targetDdlSha256,
      authoritativeTableCount: state.authoritativeTableCount,
      authoritativeRowCount: state.authoritativeRowCount,
      tableSetSha256: state.tableSetSha256,
      transformedDataSha256: state.transformedDataSha256,
      stateTotalsSha256: state.stateTotalsSha256,
      keyRangesSha256: state.keyRangesSha256,
      archivedControlTableCount: state.archivedControlTableCount,
      archivedControlRowCount: state.archivedControlRowCount,
      archivedControlTableSetSha256: state.archivedControlTableSetSha256,
      archivedControlDataSha256: state.archivedControlDataSha256,
      archivedControlKeyRangesSha256: state.archivedControlKeyRangesSha256,
      overallStateSha256: state.overallStateSha256,
    },
  } as const;
  const provisional: PostgresLogicalBackupManifest = manifestSchemaVersion === 2
    ? { schemaVersion: 2, ...common }
    : {
      schemaVersion: 3,
      ...common,
      transport: {
        profile: "railway-stock-localhost-ca-v1",
        rootCaCertificateSha256,
      },
    };
  const binding = postgresLogicalBackupManifestBindingSha256(provisional);
  const receipt = buildPostgresLogicalSourceStateReceipt({
    capturedAt: provisional.createdAt,
    databaseIdentitySha256: provisional.state.sourceDatabaseIdentitySha256,
    sourceUrlSha256: provisional.state.sourceUrlSha256,
    snapshotBindingSha256: provisional.state.snapshotBindingSha256,
    archiveBytes: archiveBytes.length,
    archiveSha256: sha256(archiveBytes),
    archiveListingSha256: sha256(listing),
    manifestBindingSha256: binding,
    state,
  });
  const receiptBytes = canonicalPostgresLogicalStateJson(receipt);
  return {
    receiptBytes,
    manifest: {
      ...provisional,
      state: {
        ...provisional.state,
        receiptSha256: sha256(receiptBytes),
        manifestBindingSha256: binding,
      },
    },
  };
}

function writeFixture(root: string, manifestSchemaVersion: 2 | 3 = 3): {
  backupDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  targetUrlFile: string;
  receiptFile: string;
} {
  const backupDirectory = path.join(root, "backup");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const archivePath = path.join(backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  const manifestPath = path.join(backupDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST);
  const stateReceiptPath = path.join(backupDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT);
  fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
  fs.chmodSync(archivePath, 0o600);
  const artifacts = makeArtifacts(archiveListing(), manifestSchemaVersion);
  const manifestBytes = canonicalPostgresBackupJson(artifacts.manifest);
  fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(stateReceiptPath, artifacts.receiptBytes, { mode: 0o600 });
  fs.chmodSync(stateReceiptPath, 0o600);
  const credentialDirectory = path.join(root, "credentials");
  const evidenceDirectory = path.join(root, "evidence");
  fs.mkdirSync(credentialDirectory, { mode: 0o700 });
  fs.chmodSync(credentialDirectory, 0o700);
  fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  fs.chmodSync(evidenceDirectory, 0o700);
  const targetUrlFile = path.join(credentialDirectory, "target-url");
  fs.writeFileSync(targetUrlFile, `${targetUrl}\n`, { mode: 0o600 });
  fs.chmodSync(targetUrlFile, 0o600);
  return {
    backupDirectory,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    targetUrlFile,
    receiptFile: path.join(evidenceDirectory, "restore-receipt.json"),
  };
}

const identity = {
  systemIdentifier: "7568999345281279000",
  databaseOid: "16655",
  databaseName: "pintpath_restore",
  serverVersionNum: "170006",
  targetClass: "disposable-rehearsal",
  transactionReadOnly: false,
  inRecovery: false,
  databaseIsTemplate: false,
  databaseAllowsConnections: true,
  hasCreatePrivilege: true,
  sameEffectiveRole: true,
};

function identitySha256(): string {
  return sha256(canonicalPostgresBackupJson({
    kind: "pintpath-postgres-logical-restore-target",
    version: 1,
    systemIdentifier: identity.systemIdentifier,
    databaseOid: identity.databaseOid,
    databaseName: identity.databaseName,
    serverVersionNum: identity.serverVersionNum,
    targetClass: identity.targetClass,
  }));
}

function metadataRows(): { key: string; value: string }[] {
  const values: Record<string, string> = {
    import_state: "ready",
    migration_candidate_sha: "c".repeat(40),
    migration_contract_sha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    migration_manifest_sha256: "1".repeat(64),
    migration_plan_sha256: "2".repeat(64),
    migration_run_sha256: "3".repeat(64),
    schema_version: "1",
    source_schema_fingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    source_schema_sha256: "4".repeat(64),
    source_schema_version: String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
    source_snapshot_sha256: "5".repeat(64),
    target_ddl_sha256: "6".repeat(64),
  };
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

interface HarnessOptions {
  apiRoles?: readonly string[];
  initiallyNonEmpty?: boolean;
  restoreResult?: ProcessResult;
  leavePartialSchemasOnFailure?: boolean;
  unsafeApiAccess?: boolean;
  wrongMetadata?: boolean;
  wrongState?: boolean;
  toolOpenError?: unknown;
  toolVersionError?: unknown;
  toolVersionResult?: PostgresToolProcessResult;
  toolListError?: unknown;
  toolListResult?: PostgresToolProcessResult;
  toolAssertExactErrorAt?: number;
  toolAssertExactError?: unknown;
  toolRestoreError?: unknown;
  toolCloseError?: unknown;
  clientBackendCounts?: readonly string[];
  clientBackendQueryErrorAt?: number;
  connectionCloseError?: unknown;
}

interface ProcessArchiveInput {
  readonly phase: "list" | "restore";
  readonly fileDescriptor: number;
  readonly dev: number;
  readonly ino: number;
  readonly bytes: Buffer;
}

interface RestoreAuthorityOpenObservation {
  readonly executableFile: string;
  readonly expectedSha256: string;
}

interface RestoreAuthorityLifecycle {
  opened: number;
  versionCalls: number;
  listCalls: number;
  assertExactCalls: number;
  restoreCalls: number;
  closeCalls: number;
  operatedWhileOpen: boolean;
  closed: boolean;
}

interface RestoreAuthorityHooks {
  version?: () => Promise<PostgresToolProcessResult>;
  list?: (archiveInputFileDescriptor: number) => Promise<PostgresToolProcessResult>;
  assertExact?: () => Promise<void>;
  restore?: (input: PostgresRestoreOperationInput) => Promise<PostgresToolProcessResult>;
  close?: () => Promise<void>;
}

const restoreEnvironmentKeys = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSSLMODE",
  "PGGSSENCMODE",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
] as const;

function closedRestoreProcessEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  result.LC_ALL = "C";
  for (const key of restoreEnvironmentKeys) {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.length < 1) {
      throw new Error("test restore authority received an incomplete environment");
    }
    result[key] = candidate;
  }
  return Object.freeze(result);
}

function readProcessArchiveInput(fileDescriptor: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(16 * 1024);
  while (true) {
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

function createHarness(options: HarnessOptions = {}) {
  const invocations: ProcessInvocation[] = [];
  const archiveInputs: ProcessArchiveInput[] = [];
  const authorityOpens: RestoreAuthorityOpenObservation[] = [];
  const authorityLifecycle: RestoreAuthorityLifecycle = {
    opened: 0,
    versionCalls: 0,
    listCalls: 0,
    assertExactCalls: 0,
    restoreCalls: 0,
    closeCalls: 0,
    operatedWhileOpen: false,
    closed: false,
  };
  const authorityHooks: RestoreAuthorityHooks = {};
  const restoreInputs: PostgresRestoreOperationInput[] = [];
  const queries: string[] = [];
  const connectionConfigs: PostgresLogicalRestoreConnectionConfig[] = [];
  const events: string[] = [];
  let restored = options.initiallyNonEmpty ?? false;
  let connectCount = 0;
  let clientBackendQueryCount = 0;
  let connectionCloseCount = 0;
  const query = async <Row extends Record<string, unknown>>(
    text: string,
  ): Promise<PostgresLogicalRestoreQueryResult<Row>> => {
    queries.push(text);
    if (text.includes("logical-restore:client-backend-quiescence")) {
      clientBackendQueryCount += 1;
      events.push(`client-backend-quiescence.${clientBackendQueryCount}`);
      if (options.clientBackendQueryErrorAt === clientBackendQueryCount) {
        throw new Error("simulated client backend quiescence query failure");
      }
      return {
        rows: [{
          otherClientBackendCount:
            options.clientBackendCounts?.[clientBackendQueryCount - 1] ?? "0",
        } as unknown as Row],
        rowCount: 1,
      };
    }
    if (text.includes("target-identity")) return { rows: [identity as unknown as Row], rowCount: 1 };
    if (text.includes("required-roles")) return {
      rows: [
        {
          roleName: "pintpath_migrator", canLogin: false, superuser: false,
          inheritsPrivileges: true,
          createDatabase: false, createRole: false, replication: false, bypassRls: false,
        },
        {
          roleName: "pintpath_runtime", canLogin: false, superuser: false,
          inheritsPrivileges: true,
          createDatabase: false, createRole: false, replication: false, bypassRls: false,
        },
      ] as unknown as Row[],
      rowCount: 2,
    };
    if (text.includes("private-schemas-before")) return {
      rows: restored ? [
        { schemaName: "pintpath_app" },
        { schemaName: "pintpath_ops" },
      ] as unknown as Row[] : [],
      rowCount: restored ? 2 : 0,
    };
    if (text.includes("logical-restore:lock")) {
      events.push("target.lock");
      return { rows: [{ acquired: true } as unknown as Row], rowCount: 1 };
    }
    if (text.includes("logical-restore:api-roles")) return {
      rows: (options.apiRoles ?? []).map((roleName) => ({ roleName })) as unknown as Row[],
      rowCount: options.apiRoles?.length ?? 0,
    };
    if (text.includes("logical-restore:privileges-")) {
      if (text.includes("privileges-begin")) events.push("privileges.begin");
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("private-schemas-after")) return {
      rows: [
        { schemaName: "pintpath_app" },
        { schemaName: "pintpath_ops" },
      ] as unknown as Row[],
      rowCount: 2,
    };
    if (text.includes("table-set")) return {
      rows: [
        ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
          schemaName: "pintpath_app", tableName: table.name,
        })),
        { schemaName: "pintpath_app", tableName: "schema_metadata" },
        { schemaName: "pintpath_ops", tableName: "migration_chunks" },
        { schemaName: "pintpath_ops", tableName: "migration_runs" },
      ] as unknown as Row[],
      rowCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3,
    };
    if (text.includes("authoritative-columns")) return {
      rows: [{ value: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns) } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("foreign-keys")) return {
      rows: [{ value: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys) } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("row-security")) return {
      rows: [{ value: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3) } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("schema-metadata")) return {
      rows: (options.wrongMetadata
        ? metadataRows().map((row) => row.key === "import_state" ? { ...row, value: "empty" } : row)
        : metadataRows()) as unknown as Row[],
      rowCount: 12,
    };
    if (text.includes("authoritative-count-inventory")) return {
      rows: POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
        tableName: table.name,
        rowCount: table.name === "system_state" ? "1" : "0",
      })) as unknown as Row[],
      rowCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    };
    if (text.includes("control-count-inventory")) return {
      rows: [
        { tableName: "migration_chunks", rowCount: "1" },
        { tableName: "migration_runs", rowCount: "1" },
      ] as unknown as Row[],
      rowCount: 2,
    };
    if (text.includes("api-isolation")) return {
      rows: [{ unsafe: options.unsafeApiAccess ?? false } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("runtime-application-access")) return {
      rows: [{ unsafe: false } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("migrator-reconciliation-access")) return {
      rows: [{ unsafe: false } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("runtime-operations-isolation")) return {
      rows: [{ unsafe: false } as unknown as Row],
      rowCount: 1,
    };
    if (text.includes("logical-restore:state-")) return { rows: [], rowCount: 0 };
    throw new Error("unexpected query");
  };
  const connection: PostgresLogicalRestoreConnection = {
    query,
    close: async () => {
      connectionCloseCount += 1;
      events.push("connection.close");
      if (options.connectionCloseError !== undefined) throw options.connectionCloseError;
    },
  };
  const defaultVersion = async (): Promise<PostgresToolProcessResult> => {
    events.push("process.version");
    invocations.push({
      command: testPgRestoreFile,
      args: ["--version"],
      env: Object.freeze({ LC_ALL: "C" }),
      timeoutMs: 15_000,
      maxStdoutBytes: 4 * 1_024,
      maxStderrBytes: 4 * 1_024,
    });
    if (options.toolVersionError !== undefined) throw options.toolVersionError;
    return options.toolVersionResult ?? {
      exitCode: 0,
      stdout: "pg_restore (PostgreSQL) 17.10 (Homebrew)\n",
      stderr: "",
    };
  };
  const defaultList = async (
    archiveInputFileDescriptor: number,
  ): Promise<PostgresToolProcessResult> => {
    events.push("process.list");
    invocations.push({
      command: testPgRestoreFile,
      args: ["--list", "--format=custom"],
      env: Object.freeze({ LC_ALL: "C" }),
      timeoutMs: 5 * 60 * 1_000,
      maxStdoutBytes: 64 * 1_024 * 1_024,
      maxStderrBytes: 1 * 1_024 * 1_024,
      stdinFileDescriptor: archiveInputFileDescriptor,
    });
    const archiveStat = fs.fstatSync(archiveInputFileDescriptor);
    archiveInputs.push({
      phase: "list",
      fileDescriptor: archiveInputFileDescriptor,
      dev: archiveStat.dev,
      ino: archiveStat.ino,
      bytes: readProcessArchiveInput(archiveInputFileDescriptor),
    });
    events.push("archive-validated");
    if (options.toolListError !== undefined) throw options.toolListError;
    return options.toolListResult ?? { exitCode: 0, stdout: archiveListing(), stderr: "" };
  };
  const defaultAssertExact = async (): Promise<void> => {
    if (
      options.toolAssertExactErrorAt === authorityLifecycle.assertExactCalls
    ) throw options.toolAssertExactError ?? new PostgresToolAuthorityError("tool_drift");
  };
  const defaultRestore = async (
    input: PostgresRestoreOperationInput,
  ): Promise<PostgresToolProcessResult> => {
    restoreInputs.push(input);
    events.push("process.restore");
    invocations.push({
      command: testPgRestoreFile,
      args: [
        "--format=custom",
        "--dbname=",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
      ],
      env: closedRestoreProcessEnvironment(input.environment),
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxStdoutBytes: 1 * 1_024 * 1_024,
      maxStderrBytes: 1 * 1_024 * 1_024,
      stdinFileDescriptor: input.archiveInputFileDescriptor,
    });
    const archiveStat = fs.fstatSync(input.archiveInputFileDescriptor);
    archiveInputs.push({
      phase: "restore",
      fileDescriptor: input.archiveInputFileDescriptor,
      dev: archiveStat.dev,
      ino: archiveStat.ino,
      bytes: readProcessArchiveInput(input.archiveInputFileDescriptor),
    });
    events.push("restore-started");
    if (options.toolRestoreError !== undefined) throw options.toolRestoreError;
    const result = options.restoreResult ?? { exitCode: 0, stdout: "", stderr: "" };
    if (result.exitCode === 0 && !result.stdout.trim() && !result.stderr.trim()) restored = true;
    if (result.exitCode !== 0 && options.leavePartialSchemasOnFailure) restored = true;
    return result;
  };
  const openRestoreAuthority: PostgresLogicalRestoreDependencies["openRestoreAuthority"] = async (
    openOptions,
  ) => {
    events.push("authority.open");
    authorityOpens.push(openOptions);
    authorityLifecycle.opened += 1;
    if (options.toolOpenError !== undefined) throw options.toolOpenError;
    let closePromise: Promise<void> | null = null;
    const authority = Object.assign(Object.create(null), {
      version: Object.freeze(async () => {
        if (authorityLifecycle.closed) throw new Error("test restore authority version after close");
        authorityLifecycle.versionCalls += 1;
        events.push("authority.version");
        return (authorityHooks.version ?? defaultVersion)();
      }),
      list: Object.freeze(async (archiveInputFileDescriptor: number) => {
        if (authorityLifecycle.closed) throw new Error("test restore authority list after close");
        authorityLifecycle.listCalls += 1;
        authorityLifecycle.operatedWhileOpen = true;
        events.push("authority.list");
        return (authorityHooks.list ?? defaultList)(archiveInputFileDescriptor);
      }),
      assertExact: Object.freeze(async () => {
        if (authorityLifecycle.closed) throw new Error("test restore authority assertion after close");
        authorityLifecycle.assertExactCalls += 1;
        events.push("authority.assert-exact");
        return (authorityHooks.assertExact ?? defaultAssertExact)();
      }),
      restore: Object.freeze(async (input: PostgresRestoreOperationInput) => {
        if (authorityLifecycle.closed) throw new Error("test restore authority operation after close");
        authorityLifecycle.restoreCalls += 1;
        authorityLifecycle.operatedWhileOpen = true;
        events.push("authority.restore");
        return (authorityHooks.restore ?? defaultRestore)(input);
      }),
      close: Object.freeze(() => {
        authorityLifecycle.closeCalls += 1;
        if (closePromise) return closePromise;
        authorityLifecycle.closed = true;
        events.push("authority.close");
        closePromise = authorityHooks.close
          ? authorityHooks.close()
          : options.toolCloseError !== undefined
            ? Promise.reject(options.toolCloseError)
            : Promise.resolve();
        return closePromise;
      }),
    }) as PostgresRestoreToolAuthority;
    return Object.freeze(authority);
  };
  const dependencies: Partial<PostgresLogicalRestoreDependencies> = {
    env: {
      NODE_ENV: "test",
      PATH: "/safe/bin",
      DATABASE_URL: "postgresql://inherited:leak@unsafe.invalid/db",
      PGPASSWORD: "inherited-secret",
      PGOPTIONS: "-c search_path=attacker",
      AWS_SECRET_ACCESS_KEY: "unrelated-secret",
    },
    getUid: () => process.getuid?.() ?? 0,
    now: () => new Date(now),
    openRestoreAuthority,
    connect: async (config) => {
      events.push("connected");
      connectCount += 1;
      connectionConfigs.push(config);
      return connection;
    },
    computeState: async () => {
      const state = stateInventory();
      return options.wrongState
        ? { ...state, transformedDataSha256: "f".repeat(64) }
        : state;
    },
  };
  return {
    dependencies,
    authorityHooks,
    authorityLifecycle,
    authorityOpens,
    defaultAssertExact,
    defaultList,
    defaultRestore,
    defaultVersion,
    restoreInputs,
    archiveInputs,
    events,
    invocations,
    queries,
    connectionConfigs,
    get connectCount() { return connectCount; },
    get clientBackendQueryCount() { return clientBackendQueryCount; },
    get connectionCloseCount() { return connectionCloseCount; },
  };
}

function restoreOptions(fixture: ReturnType<typeof writeFixture>) {
  return {
    backupDirectory: fixture.backupDirectory,
    expectedBackupManifestSha256: fixture.manifestSha256,
    pgRestoreFile: testPgRestoreFile,
    expectedPgRestoreSha256: testPgRestoreSha256,
    targetUrlFile: fixture.targetUrlFile,
    expectedTargetIdentitySha256: identitySha256(),
    receiptFile: fixture.receiptFile,
    confirmation: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
  };
}

function expectRestoreError(error: unknown, code: PostgresLogicalRestoreError["code"]): void {
  expect(error).toBeInstanceOf(PostgresLogicalRestoreError);
  expect((error as PostgresLogicalRestoreError).code).toBe(code);
  expect(String((error as Error).message)).toBe(code);
  expect(String((error as Error).message)).not.toContain(secret);
  expect(String((error as Error).message)).not.toContain("restore_admin");
  expect(String((error as Error).message)).not.toContain("db.example.invalid");
}

function failArchiveHandleClose(
  archivePath: string,
  archiveOpenOrdinal: 2 | 3,
): {
  readonly openedFileDescriptors: number[];
  readonly closeCallCount: () => number;
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openedFileDescriptors: number[] = [];
  let matchingOpenCount = 0;
  let closeCallCount = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== archivePath) return handle;
    matchingOpenCount += 1;
    if (matchingOpenCount === 2 || matchingOpenCount === 3) {
      openedFileDescriptors.push(handle.fd);
    }
    if (matchingOpenCount === archiveOpenOrdinal) {
      const close = handle.close.bind(handle);
      let failedOnce = false;
      Object.defineProperty(handle, "close", {
        configurable: true,
        value: async () => {
          closeCallCount += 1;
          if (!failedOnce) {
            failedOnce = true;
            await close();
            throw new Error("simulated archive close failure");
          }
          await close();
        },
      });
    }
    return handle;
  });
  return { openedFileDescriptors, closeCallCount: () => closeCallCount };
}

function failReceiptHandleClose(receiptPath: string): {
  readonly openedFileDescriptors: number[];
  readonly openObservations: Array<{
    readonly flags: number;
    readonly mode: number | undefined;
  }>;
  readonly openCallCount: () => number;
  readonly closeCallCount: () => number;
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openedFileDescriptors: number[] = [];
  const openObservations: Array<{ flags: number; mode: number | undefined }> = [];
  let openCallCount = 0;
  let closeCallCount = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== receiptPath) return handle;
    openCallCount += 1;
    openedFileDescriptors.push(handle.fd);
    openObservations.push({
      flags: Number(args[1]),
      mode: args[2] === undefined ? undefined : Number(args[2]),
    });
    const close = handle.close.bind(handle);
    let failedOnce = false;
    Object.defineProperty(handle, "close", {
      configurable: true,
      value: async () => {
        closeCallCount += 1;
        await close();
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("simulated receipt close failure");
        }
      },
    });
    return handle;
  });
  return {
    openedFileDescriptors,
    openObservations,
    openCallCount: () => openCallCount,
    closeCallCount: () => closeCallCount,
  };
}

function failSnapshotHandleClose(
  filePath: string,
  matchingOpenOrdinal: number,
): {
  readonly closeCallCount: () => number;
  readonly openedFileDescriptors: number[];
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openedFileDescriptors: number[] = [];
  let matchingOpenCount = 0;
  let closeCallCount = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== filePath) return handle;
    matchingOpenCount += 1;
    if (matchingOpenCount !== matchingOpenOrdinal) return handle;
    openedFileDescriptors.push(handle.fd);
    const close = handle.close.bind(handle);
    Object.defineProperty(handle, "close", {
      configurable: true,
      value: async () => {
        closeCallCount += 1;
        await close();
        throw new Error("simulated snapshot close failure");
      },
    });
    return handle;
  });
  return { closeCallCount: () => closeCallCount, openedFileDescriptors };
}

function failReceiptParentOperation(
  parentPath: string,
  operation: "sync" | "close",
): {
  readonly operationCallCount: () => number;
  readonly openedFileDescriptors: number[];
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openedFileDescriptors: number[] = [];
  let operationCallCount = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== parentPath) return handle;
    openedFileDescriptors.push(handle.fd);
    const originalOperation = handle[operation].bind(handle);
    Object.defineProperty(handle, operation, {
      configurable: true,
      value: async () => {
        operationCallCount += 1;
        await originalOperation();
        throw new Error(`simulated receipt parent ${operation} failure`);
      },
    });
    return handle;
  });
  return { operationCallCount: () => operationCallCount, openedFileDescriptors };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Postgres logical restore rehearsal", () => {
  it("strictly parses canonical v3 and frozen v2 manifests", () => {
    const v3 = makeArtifacts().manifest;
    const v2 = makeArtifacts(archiveListing(), 2).manifest;
    if (v3.schemaVersion !== 3 || v2.schemaVersion !== 2) {
      throw new Error("fixture manifest version mismatch");
    }
    expect(parsePostgresLogicalBackupManifest(Buffer.from(
      canonicalPostgresBackupJson(v3),
      "utf8",
    ))).toEqual(v3);
    expect(parsePostgresLogicalBackupManifest(Buffer.from(
      canonicalPostgresBackupJson(v2),
      "utf8",
    ))).toEqual(v2);
    expect(v3).toMatchObject({
      schemaVersion: 3,
      transport: {
        profile: "railway-stock-localhost-ca-v1",
        rootCaCertificateSha256,
      },
    });
    expect(v2).not.toHaveProperty("transport");
  });

  it("rejects mixed version/transport shapes and binds the exact v3 transport", () => {
    const v3 = makeArtifacts().manifest;
    const v2 = makeArtifacts(archiveListing(), 2).manifest;
    if (v3.schemaVersion !== 3 || v2.schemaVersion !== 2) {
      throw new Error("fixture manifest version mismatch");
    }
    const candidates: unknown[] = [
      { ...v2, transport: v3.transport },
      Object.fromEntries(Object.entries(v3).filter(([key]) => key !== "transport")),
      { ...v3, unexpected: true },
      { ...v3, transport: { ...v3.transport, profile: "railway-stock-localhost-ca-v2" } },
      {
        ...v3,
        transport: {
          ...v3.transport,
          rootCaCertificateSha256: rootCaCertificateSha256.toUpperCase(),
        },
      },
      {
        ...v3,
        transport: {
          ...v3.transport,
          rootCaCertificateSha256: "e".repeat(64),
        },
      },
    ];
    for (const candidate of candidates) {
      expect(() => parsePostgresLogicalBackupManifest(Buffer.from(
        canonicalPostgresBackupJson(candidate),
        "utf8",
      ))).toThrowError(PostgresLogicalRestoreError);
    }
  });

  it("validates the disposable target and emits only its identity hash", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const result = await inspectPostgresLogicalRestoreTarget(
      { targetUrlFile: fixture.targetUrlFile },
      harness.dependencies,
    );
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      targetIdentitySha256: identitySha256(),
      disposableTarget: true,
      privateSchemasAbsent: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("pintpath_restore");
    expect(harness.authorityLifecycle.opened).toBe(0);
    expect(harness.authorityOpens).toEqual([]);
    expect(harness.connectionCloseCount).toBe(1);
  });

  it("does not publish an inspection when its target session cannot close", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({
      connectionCloseError: new Error("inspection connection close uncertainty"),
    });
    const error = await inspectPostgresLogicalRestoreTarget(
      { targetUrlFile: fixture.targetUrlFile },
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "target_not_disposable");
    expect(harness.connectionCloseCount).toBe(1);
    expect(harness.authorityLifecycle.opened).toBe(0);
  });

  it("wipes the retained connection copy when its snapshot descriptor cannot close", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const closeFailure = failSnapshotHandleClose(fixture.targetUrlFile, 1);
    const retainedConnectionCopies: Buffer[] = [];
    const originalConcat = Buffer.concat.bind(Buffer);
    vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
      const result = originalConcat(list, totalLength);
      if (result.includes(Buffer.from(secret, "utf8"))) retainedConnectionCopies.push(result);
      return result;
    });

    const error = await inspectPostgresLogicalRestoreTarget(
      { targetUrlFile: fixture.targetUrlFile },
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "unsafe_connection_file");
    expect(harness.connectCount).toBe(0);
    expect(closeFailure.closeCallCount()).toBe(1);
    expect(closeFailure.openedFileDescriptors).toHaveLength(1);
    expect(() => fs.fstatSync(closeFailure.openedFileDescriptors[0]!)).toThrow();
    expect(retainedConnectionCopies).toHaveLength(1);
    expect(retainedConnectionCopies[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it("restores with single-transaction safety and writes a private hash-only receipt", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({ apiRoles: ["anon", "authenticated", "service_role"] });
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === fixture.targetUrlFile) {
        harness.events.push("target-url-read");
      }
      if (path.resolve(String(args[0])) === fixture.receiptFile) {
        harness.events.push("receipt.open");
      }
      return originalOpen(...args);
    });
    const result = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      backupManifestSha256: fixture.manifestSha256,
      backupArchiveSha256: sha256(archiveBytes),
      targetIdentitySha256: identitySha256(),
      authoritativeRowCount: "1",
      nonEmptyAuthoritativeTableCount: 1,
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.events.indexOf("authority.open"))
      .toBeLessThan(harness.events.indexOf("authority.version"));
    expect(harness.events.indexOf("authority.version"))
      .toBeLessThan(harness.events.indexOf("authority.list"));
    expect(harness.events.indexOf("archive-validated"))
      .toBeLessThan(harness.events.indexOf("target-url-read"));
    expect(harness.events.indexOf("target-url-read"))
      .toBeLessThan(harness.events.indexOf("connected"));
    expect(harness.events.indexOf("authority.restore"))
      .toBeLessThan(harness.events.indexOf("authority.close"));
    expect(harness.events.indexOf("client-backend-quiescence.1"))
      .toBeLessThan(harness.events.indexOf("authority.restore"));
    expect(harness.events.indexOf("authority.close"))
      .toBeLessThan(harness.events.indexOf("client-backend-quiescence.2"));
    expect(harness.events.indexOf("client-backend-quiescence.2"))
      .toBeLessThan(harness.events.indexOf("privileges.begin"));
    expect(harness.events.indexOf("privileges.begin"))
      .toBeLessThan(harness.events.indexOf("client-backend-quiescence.3"));
    expect(harness.events.indexOf("client-backend-quiescence.3"))
      .toBeLessThan(harness.events.indexOf("connection.close"));
    expect(harness.events.indexOf("connection.close"))
      .toBeLessThan(harness.events.indexOf("receipt.open"));
    expect(harness.events).not.toContain("target.unlock");
    expect(harness.authorityOpens).toEqual([{
      executableFile: testPgRestoreFile,
      expectedSha256: testPgRestoreSha256,
    }]);
    expect(harness.authorityLifecycle).toEqual({
      opened: 1,
      versionCalls: 1,
      listCalls: 1,
      assertExactCalls: 3,
      restoreCalls: 1,
      closeCalls: 1,
      operatedWhileOpen: true,
      closed: true,
    });
    expect(harness.clientBackendQueryCount).toBe(3);
    expect(harness.connectionCloseCount).toBe(1);
    const quiescenceQueries = harness.queries.filter((query) => (
      query.includes("logical-restore:client-backend-quiescence")
    ));
    expect(quiescenceQueries).toHaveLength(3);
    for (const query of quiescenceQueries) {
      expect(query).toContain("datname = current_database()");
      expect(query).toContain("backend_type = 'client backend'");
      expect(query).toContain("pid <> pg_backend_pid()");
    }
    expect(harness.queries.some((query) => query.includes("logical-restore:unlock")))
      .toBe(false);
    expect(harness.dependencies).not.toHaveProperty("pgRestoreCommand");
    expect(harness.dependencies).not.toHaveProperty("runProcess");
    const apiDenyIndexes = harness.queries
      .map((query, index) => query.includes("privileges-api-deny") ? index : -1)
      .filter((index) => index >= 0);
    const grantIndex = harness.queries.findIndex((query) => query.includes("privileges-grant"));
    expect(apiDenyIndexes).toHaveLength(3);
    expect(apiDenyIndexes.every((index) => index < grantIndex)).toBe(true);
    const restoreInvocation = harness.invocations.find((invocation) => (
      invocation.args.includes("--single-transaction")
    ))!;
    const listingInvocation = harness.invocations.find((invocation) => (
      invocation.args[0] === "--list"
    ))!;
    const versionInvocation = harness.invocations.find((invocation) => (
      invocation.args[0] === "--version"
    ))!;
    const archivePath = path.join(
      fixture.backupDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    expect(versionInvocation.stdinFileDescriptor).toBeUndefined();
    expect(listingInvocation.args).toEqual(["--list", "--format=custom"]);
    expect(restoreInvocation.args).toEqual([
      "--format=custom",
      "--dbname=",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--single-transaction",
      "--no-password",
    ]);
    expect(listingInvocation.args).not.toContain("-");
    expect(restoreInvocation.args).not.toContain("-");
    expect(JSON.stringify(listingInvocation.args)).not.toContain(archivePath);
    expect(JSON.stringify(restoreInvocation.args)).not.toContain(archivePath);
    expect(harness.archiveInputs).toHaveLength(2);
    expect(harness.archiveInputs.map((input) => input.phase)).toEqual(["list", "restore"]);
    expect(harness.archiveInputs[0]?.fileDescriptor).not.toBe(
      harness.archiveInputs[1]?.fileDescriptor,
    );
    expect({
      dev: harness.archiveInputs[0]?.dev,
      ino: harness.archiveInputs[0]?.ino,
    }).toEqual({
      dev: harness.archiveInputs[1]?.dev,
      ino: harness.archiveInputs[1]?.ino,
    });
    expect(harness.archiveInputs.map((input) => input.bytes)).toEqual([
      archiveBytes,
      archiveBytes,
    ]);
    for (const input of harness.archiveInputs) {
      expect(() => fs.fstatSync(input.fileDescriptor)).toThrow();
    }
    expect(JSON.stringify(restoreInvocation.args)).not.toContain(secret);
    expect(restoreInvocation.env).toEqual({
      LC_ALL: "C",
      PGHOST: "db.example.invalid",
      PGPORT: "5432",
      PGDATABASE: "pintpath_restore",
      PGUSER: "restore_admin",
      PGPASSWORD: secret,
      PGSSLMODE: "verify-full",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-restore-worker",
    });
    expect(Object.getPrototypeOf(restoreInvocation.env)).toBeNull();
    expect(Object.isFrozen(restoreInvocation.env)).toBe(true);
    expect(harness.restoreInputs).toHaveLength(1);
    expect(Object.keys(harness.restoreInputs[0]!.environment).sort())
      .toEqual([...restoreEnvironmentKeys].sort());
    expect(Object.isFrozen(harness.restoreInputs[0]!.environment)).toBe(true);
    expect(harness.restoreInputs[0]!.environment.PGPASSWORD).toBe(secret);
    expect(harness.restoreInputs[0]!.environment.PATH).toBeUndefined();
    expect(JSON.stringify(harness.restoreInputs[0]!.environment)).not.toContain("inherited-secret");
    expect(JSON.stringify(harness.restoreInputs[0]!.environment)).not.toContain("unrelated-secret");
    expect(restoreInvocation.env.DATABASE_URL).toBeUndefined();
    expect(restoreInvocation.env.PGOPTIONS).toBeUndefined();
    expect(restoreInvocation.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(harness.connectionConfigs[0]).toMatchObject({
      host: "db.example.invalid", database: "pintpath_restore", user: "restore_admin",
      password: secret, ssl: { rejectUnauthorized: true },
    });

    const receiptStat = fs.statSync(fixture.receiptFile);
    expect(receiptStat.mode & 0o7777).toBe(0o600);
    const receiptBytes = fs.readFileSync(fixture.receiptFile, "utf8");
    expect(sha256(receiptBytes)).toBe(result.receiptSha256);
    expect(receiptBytes).not.toContain(secret);
    expect(receiptBytes).not.toContain(root);
    expect(receiptBytes).not.toContain("restore_admin");
    expect(receiptBytes).not.toContain("system_state");
    expect(JSON.parse(receiptBytes)).toMatchObject({
      aclContractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeApplicationAccessRestored: true,
      migratorReconciliationAccessVerified: true,
      runtimeOperationsIsolated: true,
      apiRolesIsolated: true,
      promotionReconciliationReady: true,
      sourceStateBindingStatus: "exact-match",
      expectedSourceStateReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedSourceTableSetSha256: stateInventory().tableSetSha256,
      expectedSourceDataSha256: stateInventory().transformedDataSha256,
      expectedSourceStateTotalsSha256: stateInventory().stateTotalsSha256,
      expectedSourceKeyRangesSha256: stateInventory().keyRangesSha256,
      expectedArchivedControlTableSetSha256: stateInventory().archivedControlTableSetSha256,
      expectedArchivedControlDataSha256: stateInventory().archivedControlDataSha256,
      expectedArchivedControlKeyRangesSha256: stateInventory().archivedControlKeyRangesSha256,
      expectedSourceOverallStateSha256: stateInventory().overallStateSha256,
      restoredOverallStateSha256: stateInventory().overallStateSha256,
      exactDataReconciliation: "canonical-contract-exact",
    });
    expect(receiptBytes).not.toContain("required-not-implemented");
  });

  it("contains authority open, version, and list failures before target access", async () => {
    const cases: readonly {
      readonly name: string;
      readonly harnessOptions: HarnessOptions;
      readonly expectedCode: PostgresLogicalRestoreError["code"];
      readonly expectedCloseCalls: number;
    }[] = [
      {
        name: "open",
        harnessOptions: {
          toolOpenError: new PostgresToolAuthorityError("unsafe_executable"),
        },
        expectedCode: "tool_unavailable_or_unsupported",
        expectedCloseCalls: 0,
      },
      {
        name: "version",
        harnessOptions: {
          toolVersionError: new PostgresToolAuthorityError("process_failed"),
        },
        expectedCode: "tool_unavailable_or_unsupported",
        expectedCloseCalls: 1,
      },
      {
        name: "generic-list",
        harnessOptions: { toolListError: new Error("generic list uncertainty") },
        expectedCode: "backup_manifest_invalid",
        expectedCloseCalls: 1,
      },
      {
        name: "archive-drift-list",
        harnessOptions: {
          toolListError: new PostgresToolAuthorityError("archive_drift"),
        },
        expectedCode: "backup_tampered",
        expectedCloseCalls: 1,
      },
      {
        name: "nonzero-list",
        harnessOptions: {
          toolListResult: { exitCode: 1, stdout: "", stderr: "invalid archive" },
        },
        expectedCode: "backup_manifest_invalid",
        expectedCloseCalls: 1,
      },
    ];
    for (const testCase of cases) {
      const root = temporaryRoot();
      const fixture = writeFixture(root);
      const harness = createHarness(testCase.harnessOptions);
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, testCase.expectedCode);
      expect(harness.connectCount, testCase.name).toBe(0);
      expect(harness.events, testCase.name).not.toContain("connected");
      expect(harness.authorityLifecycle.restoreCalls, testCase.name).toBe(0);
      expect(harness.authorityLifecycle.closeCalls, testCase.name)
        .toBe(testCase.expectedCloseCalls);
      expect(fs.existsSync(fixture.receiptFile), testCase.name).toBe(false);
    }
  });

  it("rejects noncanonical restore-tool paths and hashes before opening authority", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const valid = restoreOptions(fixture);
    const candidates: unknown[] = [
      { ...valid, pgRestoreFile: "pg_restore" },
      { ...valid, pgRestoreFile: "/reviewed/postgresql/17/../17/bin/pg_restore" },
      { ...valid, pgRestoreFile: "/reviewed/postgresql/17/bin/not-pg-restore" },
      { ...valid, pgRestoreFile: `${testPgRestoreFile}\0suffix` },
      { ...valid, expectedPgRestoreSha256: testPgRestoreSha256.toUpperCase() },
      { ...valid, expectedPgRestoreSha256: "f".repeat(63) },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "pgRestoreFile")),
      Object.fromEntries(Object.entries(valid).filter(
        ([key]) => key !== "expectedPgRestoreSha256",
      )),
    ];
    for (const candidate of candidates) {
      const harness = createHarness();
      const error = await restorePostgresLogicalBackup(
        candidate as Parameters<typeof restorePostgresLogicalBackup>[0],
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, "invalid_arguments");
      expect(harness.authorityLifecycle.opened).toBe(0);
      expect(harness.authorityOpens).toEqual([]);
      expect(harness.connectCount).toBe(0);
      expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    }
  });

  it("rejects a dangling receipt symlink before opening authority or target", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    fs.symlinkSync(path.join(root, "missing-receipt-target"), fixture.receiptFile);
    const harness = createHarness();
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "invalid_arguments");
    expect(harness.authorityLifecycle.opened).toBe(0);
    expect(harness.connectCount).toBe(0);
    expect(fs.lstatSync(fixture.receiptFile).isSymbolicLink()).toBe(true);
  });

  it.each([
    {
      name: "authenticated backup directory",
      receiptFile: (fixture: ReturnType<typeof writeFixture>) => path.join(
        fixture.backupDirectory,
        "restore-receipt.json",
      ),
    },
    {
      name: "target credential directory",
      receiptFile: (fixture: ReturnType<typeof writeFixture>) => path.join(
        path.dirname(fixture.targetUrlFile),
        "restore-receipt.json",
      ),
    },
  ])("rejects a receipt inside the $name before authority or target access", async ({
    receiptFile,
  }) => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const error = await restorePostgresLogicalBackup({
      ...restoreOptions(fixture),
      receiptFile: receiptFile(fixture),
    }, harness.dependencies).catch((caught: unknown) => caught);

    expectRestoreError(error, "invalid_arguments");
    expect(harness.authorityLifecycle.opened).toBe(0);
    expect(harness.connectCount).toBe(0);
  });

  it("rejects post-list tool drift without starting target mutation", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({ toolAssertExactErrorAt: 1 });
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "tool_unavailable_or_unsupported");
    expect(harness.connectCount).toBe(0);
    expect(harness.authorityLifecycle).toMatchObject({
      opened: 1,
      versionCalls: 1,
      listCalls: 1,
      assertExactCalls: 1,
      restoreCalls: 0,
      closeCalls: 1,
      closed: true,
    });
    expect(harness.events).not.toContain("restore-started");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
  });

  it("lets a pre-mutation authority close failure dominate a target mismatch", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({
      toolCloseError: new PostgresToolAuthorityError("cleanup_failed"),
    });
    const error = await restorePostgresLogicalBackup({
      ...restoreOptions(fixture),
      expectedTargetIdentitySha256: "e".repeat(64),
    }, harness.dependencies).catch((caught: unknown) => caught);

    expectRestoreError(error, "tool_unavailable_or_unsupported");
    expect(harness.connectCount).toBe(1);
    expect(harness.authorityLifecycle.restoreCalls).toBe(0);
    expect(harness.authorityLifecycle.closeCalls).toBe(1);
    expect(harness.events).not.toContain("restore-started");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
  });

  it("requires target disposal for every authority uncertainty after restore starts", async () => {
    const cases: readonly {
      readonly name: string;
      readonly harnessOptions: HarnessOptions;
      readonly expectedCode: PostgresLogicalRestoreError["code"];
    }[] = [
      {
        name: "process-failed",
        harnessOptions: {
          toolRestoreError: new PostgresToolAuthorityError("process_failed"),
        },
        expectedCode: "restore_rollback_unverified_target_disposal_required",
      },
      {
        name: "tool-drift",
        harnessOptions: {
          toolRestoreError: new PostgresToolAuthorityError("tool_drift"),
        },
        expectedCode: "verification_failed_target_disposal_required",
      },
      {
        name: "archive-drift",
        harnessOptions: {
          toolRestoreError: new PostgresToolAuthorityError("archive_drift"),
        },
        expectedCode: "verification_failed_target_disposal_required",
      },
      {
        name: "postflight-tool-drift",
        harnessOptions: { toolAssertExactErrorAt: 3 },
        expectedCode: "verification_failed_target_disposal_required",
      },
      {
        name: "post-mutation-close",
        harnessOptions: {
          toolCloseError: new PostgresToolAuthorityError("cleanup_failed"),
        },
        expectedCode: "verification_failed_target_disposal_required",
      },
    ];
    for (const testCase of cases) {
      const root = temporaryRoot();
      const fixture = writeFixture(root);
      const harness = createHarness(testCase.harnessOptions);
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, testCase.expectedCode);
      expect(harness.connectCount, testCase.name).toBe(1);
      expect(harness.authorityLifecycle.restoreCalls, testCase.name).toBe(1);
      expect(harness.authorityLifecycle.closeCalls, testCase.name).toBe(1);
      expect(fs.existsSync(fixture.receiptFile), testCase.name).toBe(false);
    }
  });

  it("requires client-backend quiescence before and after restore", async () => {
    const cases: readonly {
      readonly name: string;
      readonly harnessOptions: HarnessOptions;
      readonly expectedCode: PostgresLogicalRestoreError["code"];
      readonly expectedRestoreCalls: number;
      readonly expectedQuiescenceCalls: number;
    }[] = [
      {
        name: "preexisting-client",
        harnessOptions: { clientBackendCounts: ["1"] },
        expectedCode: "target_busy",
        expectedRestoreCalls: 0,
        expectedQuiescenceCalls: 1,
      },
      {
        name: "preflight-query-failure",
        harnessOptions: { clientBackendQueryErrorAt: 1 },
        expectedCode: "target_busy",
        expectedRestoreCalls: 0,
        expectedQuiescenceCalls: 1,
      },
      {
        name: "immediate-post-restore-client",
        harnessOptions: { clientBackendCounts: ["0", "1"] },
        expectedCode: "verification_failed_target_disposal_required",
        expectedRestoreCalls: 1,
        expectedQuiescenceCalls: 2,
      },
      {
        name: "immediate-post-restore-query-failure",
        harnessOptions: { clientBackendQueryErrorAt: 2 },
        expectedCode: "verification_failed_target_disposal_required",
        expectedRestoreCalls: 1,
        expectedQuiescenceCalls: 2,
      },
      {
        name: "final-client",
        harnessOptions: { clientBackendCounts: ["0", "0", "1"] },
        expectedCode: "verification_failed_target_disposal_required",
        expectedRestoreCalls: 1,
        expectedQuiescenceCalls: 3,
      },
      {
        name: "final-query-failure",
        harnessOptions: { clientBackendQueryErrorAt: 3 },
        expectedCode: "verification_failed_target_disposal_required",
        expectedRestoreCalls: 1,
        expectedQuiescenceCalls: 3,
      },
    ];
    for (const testCase of cases) {
      const root = temporaryRoot();
      const fixture = writeFixture(root);
      const harness = createHarness(testCase.harnessOptions);
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, testCase.expectedCode);
      expect(harness.authorityLifecycle.restoreCalls, testCase.name)
        .toBe(testCase.expectedRestoreCalls);
      expect(harness.clientBackendQueryCount, testCase.name)
        .toBe(testCase.expectedQuiescenceCalls);
      expect(harness.authorityLifecycle.closeCalls, testCase.name).toBe(1);
      expect(harness.connectionCloseCount, testCase.name).toBe(1);
      expect(fs.existsSync(fixture.receiptFile), testCase.name).toBe(false);
    }
  });

  it("requires target-session close while its advisory lock is still held", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({
      connectionCloseError: new Error("connection close uncertainty"),
    });
    const originalOpen = fs.promises.open.bind(fs.promises);
    let receiptOpenCount = 0;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === fixture.receiptFile) receiptOpenCount += 1;
      return originalOpen(...args);
    });
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "verification_failed_target_disposal_required");
    expect(harness.authorityLifecycle.restoreCalls).toBe(1);
    expect(harness.authorityLifecycle.closeCalls).toBe(1);
    expect(harness.connectionCloseCount).toBe(1);
    expect(harness.queries.some((query) => query.includes("logical-restore:unlock")))
      .toBe(false);
    expect(receiptOpenCount).toBe(0);
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
  });

  it("retains an unauthorized receipt leaf after a one-shot close failure", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const closeFailure = failReceiptHandleClose(fixture.receiptFile);
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "receipt_failed_target_disposal_required");
    expect(harness.authorityLifecycle.restoreCalls).toBe(1);
    expect(harness.authorityLifecycle.closeCalls).toBe(1);
    expect(harness.connectionCloseCount).toBe(1);
    expect(closeFailure.openCallCount()).toBe(1);
    expect(closeFailure.closeCallCount()).toBe(1);
    expect(closeFailure.openObservations).toEqual([{
      flags: fs.constants.O_RDWR
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      mode: 0o600,
    }]);
    expect(closeFailure.openedFileDescriptors).toHaveLength(1);
    expect(() => fs.fstatSync(closeFailure.openedFileDescriptors[0]!)).toThrow();
    const retainedReceipt = fs.readFileSync(fixture.receiptFile, "utf8");
    expect(JSON.parse(retainedReceipt)).toMatchObject({
      kind: "pintpath-postgres-logical-restore-rehearsal",
      status: "verified",
    });
    expect(retainedReceipt).not.toContain(secret);
  });

  it("detects a same-length receipt overwrite immediately after file fsync", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let receiptOpenCount = 0;
    let receiptSyncCount = 0;
    let corrupted = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) !== fixture.receiptFile) return handle;
      receiptOpenCount += 1;
      const sync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        configurable: true,
        value: async () => {
          receiptSyncCount += 1;
          await sync();
          if (!corrupted) {
            const stat = await handle.stat();
            const replacement = Buffer.alloc(stat.size, 0x58);
            let offset = 0;
            while (offset < replacement.length) {
              const bytesWritten = fs.writeSync(
                handle.fd,
                replacement,
                offset,
                replacement.length - offset,
                offset,
              );
              if (bytesWritten < 1) throw new Error("test receipt overwrite made no progress");
              offset += bytesWritten;
            }
            corrupted = true;
          }
        },
      });
      return handle;
    });

    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "receipt_failed_target_disposal_required");
    expect(receiptOpenCount).toBe(1);
    expect(receiptSyncCount).toBe(1);
    expect(corrupted).toBe(true);
    const retainedCorruption = fs.readFileSync(fixture.receiptFile);
    expect(retainedCorruption.length).toBeGreaterThan(0);
    expect(retainedCorruption.every((byte) => byte === 0x58)).toBe(true);
  });

  it.each(["sync", "close"] as const)(
    "retains an unauthorized receipt leaf when its parent-directory %s fails",
    async (operation) => {
      const root = temporaryRoot();
      const fixture = writeFixture(root);
      const harness = createHarness();
      const failure = failReceiptParentOperation(path.dirname(fixture.receiptFile), operation);
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, "receipt_failed_target_disposal_required");
      expect(failure.operationCallCount()).toBe(1);
      expect(failure.openedFileDescriptors).toHaveLength(1);
      expect(() => fs.fstatSync(failure.openedFileDescriptors[0]!)).toThrow();
      const retainedReceipt = fs.readFileSync(fixture.receiptFile, "utf8");
      expect(JSON.parse(retainedReceipt)).toMatchObject({
        kind: "pintpath-postgres-logical-restore-rehearsal",
        status: "verified",
      });
      expect(retainedReceipt).not.toContain(secret);
    },
  );

  it("contains a receipt-parent pathname ABA without deleting the replacement", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    const receiptParent = path.dirname(fixture.receiptFile);
    const parkedReceiptParent = `${receiptParent}-parked`;
    const replacementBytes = Buffer.from("operator replacement must survive", "utf8");
    const replacementSentinel = path.join(receiptParent, "replacement-sentinel");
    let parentOpenCount = 0;
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (!swapped && path.resolve(String(args[0])) === receiptParent) {
        parentOpenCount += 1;
        fs.renameSync(receiptParent, parkedReceiptParent);
        fs.mkdirSync(receiptParent, { mode: 0o700 });
        fs.chmodSync(receiptParent, 0o700);
        fs.writeFileSync(replacementSentinel, replacementBytes, { mode: 0o600 });
        swapped = true;
      }
      return handle;
    });

    try {
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, "receipt_failed_target_disposal_required");
      expect(parentOpenCount).toBe(1);
      expect(swapped).toBe(true);
      expect(fs.readFileSync(replacementSentinel)).toEqual(replacementBytes);
      expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    } finally {
      if (swapped) {
        fs.unlinkSync(replacementSentinel);
        fs.rmdirSync(receiptParent);
        fs.renameSync(parkedReceiptParent, receiptParent);
      }
    }
  });

  it("feeds the trusted listing descriptor through an ancestor-directory ABA", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const list = harness.defaultList;
    const parkedDirectory = path.join(root, "trusted-listing-backup-parked");
    let abaCompleted = false;
    harness.authorityHooks.list = async (archiveInputFileDescriptor) => {
      fs.renameSync(fixture.backupDirectory, parkedDirectory);
      fs.mkdirSync(fixture.backupDirectory, { mode: 0o700 });
      fs.chmodSync(fixture.backupDirectory, 0o700);
      fs.writeFileSync(
        path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
        Buffer.from("attacker-controlled-listing-archive", "utf8"),
        { mode: 0o600 },
      );
      try {
        return await list(archiveInputFileDescriptor);
      } finally {
        fs.rmSync(fixture.backupDirectory, { recursive: true, force: true });
        fs.renameSync(parkedDirectory, fixture.backupDirectory);
        abaCompleted = true;
      }
    };

    await expect(restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    )).resolves.toMatchObject({ ok: true, backupArchiveSha256: sha256(archiveBytes) });
    expect(abaCompleted).toBe(true);
    expect(harness.archiveInputs.map((input) => [input.phase, input.bytes])).toEqual([
      ["list", archiveBytes],
      ["restore", archiveBytes],
    ]);
  });

  it("feeds the retained restore descriptor through an ancestor-directory ABA", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const restore = harness.defaultRestore;
    const parkedDirectory = path.join(root, "trusted-backup-parked");
    let abaCompleted = false;
    harness.authorityHooks.restore = async (input) => {
      fs.renameSync(fixture.backupDirectory, parkedDirectory);
      fs.mkdirSync(fixture.backupDirectory, { mode: 0o700 });
      fs.chmodSync(fixture.backupDirectory, 0o700);
      fs.writeFileSync(
        path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
        Buffer.from("attacker-controlled-archive", "utf8"),
        { mode: 0o600 },
      );
      try {
        return await restore(input);
      } finally {
        fs.rmSync(fixture.backupDirectory, { recursive: true, force: true });
        fs.renameSync(parkedDirectory, fixture.backupDirectory);
        abaCompleted = true;
      }
    };

    await expect(restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    )).resolves.toMatchObject({ ok: true, backupArchiveSha256: sha256(archiveBytes) });
    expect(abaCompleted).toBe(true);
    expect(harness.archiveInputs.find((input) => input.phase === "restore")?.bytes)
      .toEqual(archiveBytes);
    expect(fs.readFileSync(
      path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
    )).toEqual(archiveBytes);
  });

  it("rejects custody-handle close failures before connecting or writing a receipt", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const archivePath = path.join(
      fixture.backupDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    const closeFailure = failArchiveHandleClose(archivePath, 2);
    const harness = createHarness();
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "backup_tampered");
    expect(harness.connectCount).toBe(0);
    expect(harness.authorityLifecycle.closeCalls).toBe(1);
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(closeFailure.closeCallCount()).toBe(1);
    expect(closeFailure.openedFileDescriptors).toHaveLength(2);
    for (const fileDescriptor of closeFailure.openedFileDescriptors) {
      expect(() => fs.fstatSync(fileDescriptor)).toThrow();
    }
  });

  it.each([
    {
      name: "initial-manifest",
      matchingOpenOrdinal: 1,
      expectedCode: "backup_manifest_invalid" as const,
      expectedConnectCount: 0,
      expectedRestoreCalls: 0,
    },
    {
      name: "post-session-manifest",
      matchingOpenOrdinal: 7,
      expectedCode: "verification_failed_target_disposal_required" as const,
      expectedConnectCount: 1,
      expectedRestoreCalls: 1,
    },
  ])(
    "fails closed when the $name snapshot descriptor cannot close",
    async ({
      matchingOpenOrdinal,
      expectedCode,
      expectedConnectCount,
      expectedRestoreCalls,
    }) => {
      const root = temporaryRoot();
      const fixture = writeFixture(root);
      const manifestPath = path.join(
        fixture.backupDirectory,
        POSTGRES_LOGICAL_BACKUP_MANIFEST,
      );
      const closeFailure = failSnapshotHandleClose(manifestPath, matchingOpenOrdinal);
      const harness = createHarness();
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, expectedCode);
      expect(harness.connectCount).toBe(expectedConnectCount);
      expect(harness.authorityLifecycle.restoreCalls).toBe(expectedRestoreCalls);
      expect(closeFailure.closeCallCount()).toBe(1);
      expect(closeFailure.openedFileDescriptors).toHaveLength(1);
      expect(() => fs.fstatSync(closeFailure.openedFileDescriptors[0]!)).toThrow();
      expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    },
  );

  it("requires target disposal when the mutation handle cannot close before receipt", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const archivePath = path.join(
      fixture.backupDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    const closeFailure = failArchiveHandleClose(archivePath, 3);
    const harness = createHarness();
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "verification_failed_target_disposal_required");
    expect(harness.connectCount).toBe(1);
    expect(harness.events).toContain("restore-started");
    expect(harness.authorityLifecycle.closeCalls).toBe(1);
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(closeFailure.closeCallCount()).toBe(1);
    expect(closeFailure.openedFileDescriptors).toHaveLength(2);
    for (const fileDescriptor of closeFailure.openedFileDescriptors) {
      expect(() => fs.fstatSync(fileDescriptor)).toThrow();
    }
  });

  it("retains descriptor custody until a deferred restore-runner rejection settles", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({
      restoreResult: { exitCode: 1, stdout: "", stderr: "deferred" },
    });
    const restore = harness.defaultRestore;
    let rejectRestore!: () => void;
    let restoreFileDescriptor = -1;
    let signalRestorePending!: () => void;
    const restorePending = new Promise<void>((resolve) => {
      signalRestorePending = resolve;
    });
    harness.authorityHooks.restore = async (input) => {
      await restore(input);
      restoreFileDescriptor = input.archiveInputFileDescriptor;
      return new Promise<ProcessResult>((_resolve, reject) => {
        rejectRestore = () => reject(new Error("deferred runner rejection"));
        signalRestorePending();
      });
    };

    const pendingRestore = restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    );
    await restorePending;
    expect(fs.fstatSync(restoreFileDescriptor).isFile()).toBe(true);
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    rejectRestore();
    const error = await pendingRestore.catch((caught: unknown) => caught);

    expectRestoreError(error, "restore_rollback_unverified_target_disposal_required");
    expect(() => fs.fstatSync(restoreFileDescriptor)).toThrow();
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(harness.queries.filter((query) => query.includes("private-schemas-before")))
      .toHaveLength(2);
  });

  it("detects a transient same-inode write-and-revert concealed before postflight", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const archivePath = path.join(
      fixture.backupDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    const archiveProbe = fs.openSync(
      archivePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stableTimestampSeconds = 1_700_000_000;
      fs.futimesSync(archiveProbe, stableTimestampSeconds, stableTimestampSeconds);
      const originalStat = fs.fstatSync(archiveProbe, { bigint: true });
      const attackerBytes = Buffer.alloc(archiveBytes.length, 0x59);
      const harness = createHarness();
      const restore = harness.defaultRestore;
      let revertedStat: fs.BigIntStats | null = null;
      harness.authorityHooks.restore = async (input) => {
        fs.writeFileSync(archivePath, attackerBytes, { mode: 0o600 });
        const result = await restore(input);
        fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
        fs.futimesSync(archiveProbe, stableTimestampSeconds, stableTimestampSeconds);
        revertedStat = fs.fstatSync(archiveProbe, { bigint: true });
        return result;
      };
      const error = await restorePostgresLogicalBackup(
        restoreOptions(fixture),
        harness.dependencies,
      ).catch((caught: unknown) => caught);

      expectRestoreError(error, "verification_failed_target_disposal_required");
      expect(harness.archiveInputs.find((input) => input.phase === "restore")?.bytes)
        .toEqual(attackerBytes);
      expect(fs.readFileSync(archiveProbe)).toEqual(archiveBytes);
      expect(revertedStat?.mtimeNs).toBe(originalStat.mtimeNs);
      expect(revertedStat?.ctimeNs).not.toBe(originalStat.ctimeNs);
      expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    } finally {
      fs.closeSync(archiveProbe);
    }
  });

  it("requires target disposal after same-inode archive drift during mutation", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const archivePath = path.join(
      fixture.backupDirectory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    const harness = createHarness();
    const restore = harness.defaultRestore;
    harness.authorityHooks.restore = async (input) => {
      const result = await restore(input);
      const replacement = Buffer.alloc(archiveBytes.length, 0x58);
      fs.writeFileSync(archivePath, replacement, { mode: 0o600 });
      fs.chmodSync(archivePath, 0o600);
      return result;
    };
    const error = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    ).catch((caught: unknown) => caught);

    expectRestoreError(error, "verification_failed_target_disposal_required");
    expect(harness.archiveInputs.find((input) => input.phase === "restore")?.bytes)
      .toEqual(archiveBytes);
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    for (const input of harness.archiveInputs) {
      expect(() => fs.fstatSync(input.fileDescriptor)).toThrow();
    }
  });

  it("restores a frozen schema-v2 manifest through the compatibility parser", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root, 2);
    const harness = createHarness();
    await expect(restorePostgresLogicalBackup(
      restoreOptions(fixture),
      harness.dependencies,
    )).resolves.toMatchObject({
      schemaVersion: 1,
      ok: true,
      backupManifestSha256: fixture.manifestSha256,
    });
    expect(harness.connectCount).toBe(1);
  });

  it("detects archive and canonical-manifest tampering before connecting", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    fs.appendFileSync(path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE), "tampered");
    const archiveHarness = createHarness();
    const archiveError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      archiveHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(archiveError, "backup_tampered");
    expect(archiveHarness.connectCount).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
    roots.pop();
    const secondRoot = temporaryRoot();
    const second = writeFixture(secondRoot);
    const nonCanonical = `${fs.readFileSync(second.manifestPath, "utf8").trim()}  \n`;
    fs.writeFileSync(second.manifestPath, nonCanonical, { mode: 0o600 });
    fs.chmodSync(second.manifestPath, 0o600);
    const manifestHarness = createHarness();
    const manifestError = await restorePostgresLogicalBackup({
      ...restoreOptions(second),
      expectedBackupManifestSha256: sha256(nonCanonical),
    }, manifestHarness.dependencies).catch((caught: unknown) => caught);
    expectRestoreError(manifestError, "backup_manifest_invalid");
    expect(manifestHarness.connectCount).toBe(0);

    fs.rmSync(secondRoot, { recursive: true, force: true });
    roots.pop();
    const thirdRoot = temporaryRoot();
    const third = writeFixture(thirdRoot);
    fs.appendFileSync(
      path.join(third.backupDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
      "tampered",
    );
    const receiptHarness = createHarness();
    const receiptError = await restorePostgresLogicalBackup(
      restoreOptions(third),
      receiptHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(receiptError, "backup_tampered");
    expect(receiptHarness.connectCount).toBe(0);

    fs.rmSync(thirdRoot, { recursive: true, force: true });
    roots.pop();
    const fourthRoot = temporaryRoot();
    const fourth = writeFixture(fourthRoot);
    const canonicalTamper = JSON.parse(fs.readFileSync(fourth.manifestPath, "utf8")) as
      PostgresLogicalBackupManifest;
    const tamperedManifestBytes = canonicalPostgresBackupJson({
      ...canonicalTamper,
      createdAt: "2026-08-08T05:00:01.000Z",
    });
    fs.writeFileSync(fourth.manifestPath, tamperedManifestBytes, { mode: 0o600 });
    fs.chmodSync(fourth.manifestPath, 0o600);
    const bindingHarness = createHarness();
    const bindingError = await restorePostgresLogicalBackup({
      ...restoreOptions(fourth),
      expectedBackupManifestSha256: sha256(tamperedManifestBytes),
    }, bindingHarness.dependencies).catch((caught: unknown) => caught);
    expectRestoreError(bindingError, "backup_manifest_invalid");
    expect(bindingHarness.connectCount).toBe(0);
  });

  it("rejects a wrong target identity and an existing private schema before pg_restore", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const wrongHarness = createHarness();
    const wrongIdentityError = await restorePostgresLogicalBackup({
      ...restoreOptions(fixture),
      expectedTargetIdentitySha256: "e".repeat(64),
    }, wrongHarness.dependencies).catch((caught: unknown) => caught);
    expectRestoreError(wrongIdentityError, "target_identity_mismatch");
    expect(wrongHarness.invocations.some((item) => item.args.includes("--single-transaction"))).toBe(false);
    expect(wrongHarness.authorityLifecycle.closeCalls).toBe(1);

    const nonemptyHarness = createHarness({ initiallyNonEmpty: true });
    const nonemptyError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      nonemptyHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(nonemptyError, "target_not_empty");
    expect(nonemptyHarness.invocations.some((item) => item.args.includes("--single-transaction"))).toBe(false);
    expect(nonemptyHarness.authorityLifecycle.closeCalls).toBe(1);
  });

  it("requires disposal for every abnormal pg_restore outcome without a rollback query", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const rolledBackHarness = createHarness({
      restoreResult: {
        exitCode: 0,
        stdout: `unexpected output ${targetUrl}`,
        stderr: "",
      },
    });
    const rolledBackError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      rolledBackHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(rolledBackError, "restore_rollback_unverified_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(rolledBackHarness.invocations.find((item) => item.args.includes("--single-transaction"))?.args)
      .toContain("--exit-on-error");
    expect(rolledBackHarness.queries.filter((query) => query.includes("private-schemas-before")))
      .toHaveLength(2);

    const partialHarness = createHarness({
      restoreResult: { exitCode: 1, stdout: "", stderr: "partial" },
      leavePartialSchemasOnFailure: true,
    });
    const partialError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      partialHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(partialError, "restore_rollback_unverified_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(partialHarness.queries.filter((query) => query.includes("private-schemas-before")))
      .toHaveLength(2);
  });

  it("requires private current-user files and a direct TLS non-pooler URL", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    fs.chmodSync(fixture.targetUrlFile, 0o644);
    const modeHarness = createHarness();
    const modeError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      modeHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(modeError, "unsafe_connection_file");

    fs.chmodSync(fixture.targetUrlFile, 0o600);
    fs.writeFileSync(
      fixture.targetUrlFile,
      "postgresql://restore_admin:secret@pooler.example.invalid:6543/db?sslmode=require\n",
      { mode: 0o600 },
    );
    fs.chmodSync(fixture.targetUrlFile, 0o600);
    const urlHarness = createHarness();
    const urlError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      urlHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(urlError, "unsafe_connection_url");
  });

  it("requires exact confirmation and converts a post-restore verification failure into disposal-required", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness();
    const confirmationError = await restorePostgresLogicalBackup({
      ...restoreOptions(fixture), confirmation: "yes",
    }, harness.dependencies).catch((caught: unknown) => caught);
    expectRestoreError(confirmationError, "confirmation_required");
    expect(harness.invocations).toEqual([]);
    expect(harness.authorityLifecycle.opened).toBe(0);

    const verificationHarness = createHarness({ wrongMetadata: true });
    const verificationError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      verificationHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(verificationError, "verification_failed_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);

    const stateHarness = createHarness({ wrongState: true });
    const stateError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      stateHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(stateError, "verification_failed_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);

    const targetSwapHarness = createHarness();
    const targetSwapError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      {
        ...targetSwapHarness.dependencies,
        computeState: async () => {
          fs.writeFileSync(
            fixture.targetUrlFile,
            "postgresql://other:replacement@other.invalid/db?sslmode=require\n",
            { mode: 0o600 },
          );
          fs.chmodSync(fixture.targetUrlFile, 0o600);
          return stateInventory();
        },
      },
    ).catch((caught: unknown) => caught);
    expectRestoreError(targetSwapError, "verification_failed_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);

    const backupSwapHarness = createHarness();
    const backupSwapError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      {
        ...backupSwapHarness.dependencies,
        computeState: async () => {
          fs.appendFileSync(
            path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
            "changed-after-target-scan",
          );
          return stateInventory();
        },
      },
    ).catch((caught: unknown) => caught);
    expectRestoreError(backupSwapError, "verification_failed_target_disposal_required");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
  });

  it("emits only canonical safe CLI output and enforces the operator guard separately", async () => {
    const output: string[] = [];
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    let receivedRestoreOptions:
      Parameters<PostgresLogicalRestoreCliDependencies["restoreBackup"]>[0] | null = null;
    const rawFailureDependencies: Partial<PostgresLogicalRestoreCliDependencies> = {
      assertMutationAllowed: () => undefined,
      restoreBackup: async (options) => {
        receivedRestoreOptions = options;
        throw new Error(`raw ${targetUrl} at ${root}`);
      },
      writeOutput: (value) => output.push(value),
    };
    const argv = [
      "restore",
      "--backup-directory", fixture.backupDirectory,
      "--backup-manifest-sha256", fixture.manifestSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--target-url-file", fixture.targetUrlFile,
      "--target-identity-sha256", identitySha256(),
      "--receipt", fixture.receiptFile,
    ];
    const exit = await runPostgresLogicalRestoreCli(argv, {
      [POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV]: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    }, rawFailureDependencies);
    expect(exit).toBe(1);
    expect(output).toEqual([
      "{\"failureCode\":\"unexpected_failure\",\"ok\":false,\"schemaVersion\":1,\"targetDisposalRequired\":false}\n",
    ]);
    expect(output[0]).not.toContain(secret);
    expect(output[0]).not.toContain(root);
    expect(receivedRestoreOptions).toMatchObject({
      pgRestoreFile: testPgRestoreFile,
      expectedPgRestoreSha256: testPgRestoreSha256,
    });

    for (const omittedFlag of [
      "--pg-restore-file",
      "--expected-pg-restore-sha256",
    ]) {
      output.length = 0;
      receivedRestoreOptions = null;
      const omittedIndex = argv.indexOf(omittedFlag);
      const incompleteArgv = argv.filter((_value, index) => (
        index !== omittedIndex && index !== omittedIndex + 1
      ));
      const incompleteExit = await runPostgresLogicalRestoreCli(incompleteArgv, {
        [POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV]: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
      }, rawFailureDependencies);
      expect(incompleteExit).toBe(1);
      expect(receivedRestoreOptions).toBeNull();
      expect(output).toEqual([
        "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1,\"targetDisposalRequired\":false}\n",
      ]);
    }

    output.length = 0;
    const guardExit = await runPostgresLogicalRestoreCli(argv, {
      [POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV]: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    }, {
      assertMutationAllowed: () => { throw new Error("restore containment"); },
      writeOutput: (value) => output.push(value),
    });
    expect(guardExit).toBe(1);
    expect(output[0]).toContain('"failureCode":"operator_guard_rejected"');
  });

  it("requires disposal when a successful restore digest cannot be published", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const argv = [
      "restore",
      "--backup-directory", fixture.backupDirectory,
      "--backup-manifest-sha256", fixture.manifestSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--target-url-file", fixture.targetUrlFile,
      "--target-identity-sha256", identitySha256(),
      "--receipt", fixture.receiptFile,
    ];
    const output: string[] = [];
    let outputCalls = 0;
    const exit = await runPostgresLogicalRestoreCli(argv, {
      [POSTGRES_LOGICAL_RESTORE_CONFIRMATION_ENV]: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    }, {
      assertMutationAllowed: () => undefined,
      restoreBackup: async () => ({
        schemaVersion: 1,
        ok: true,
        receiptSha256: "1".repeat(64),
        backupManifestSha256: fixture.manifestSha256,
        backupArchiveSha256: "2".repeat(64),
        targetIdentitySha256: identitySha256(),
        authoritativeRowCount: "1",
        nonEmptyAuthoritativeTableCount: 1,
        authoritativeCountInventorySha256: "3".repeat(64),
        promotionReconciliationReady: true,
        sourceStateBindingStatus: "exact-match",
        overallStateSha256: "4".repeat(64),
      }),
      writeOutput: (value) => {
        outputCalls += 1;
        if (outputCalls === 1) throw new Error("simulated output failure");
        output.push(value);
      },
    });
    expect(exit).toBe(1);
    expect(outputCalls).toBe(2);
    expect(JSON.parse(output[0]!)).toEqual({
      failureCode: "receipt_failed_target_disposal_required",
      ok: false,
      schemaVersion: 1,
      targetDisposalRequired: true,
    });
  });

  it("keeps inspect-target CLI tool-free and rejects restore-tool flags", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const output: string[] = [];
    const inspections: Array<{ readonly targetUrlFile: string }> = [];
    const dependencies: Partial<PostgresLogicalRestoreCliDependencies> = {
      inspectTarget: async (options) => {
        inspections.push(options);
        return {
          schemaVersion: 1,
          ok: true,
          targetIdentitySha256: identitySha256(),
          disposableTarget: true,
          privateSchemasAbsent: true,
        };
      },
      writeOutput: (value) => output.push(value),
    };
    const inspectArgv = ["inspect-target", "--target-url-file", fixture.targetUrlFile];
    const exit = await runPostgresLogicalRestoreCli(inspectArgv, {}, dependencies);
    expect(exit).toBe(0);
    expect(inspections).toEqual([{ targetUrlFile: fixture.targetUrlFile }]);
    expect(output).toEqual([
      `${canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: true,
        command: "inspect-target",
        targetIdentitySha256: identitySha256(),
        disposableTarget: true,
        privateSchemasAbsent: true,
      })}`,
    ]);

    output.length = 0;
    const invalidExit = await runPostgresLogicalRestoreCli([
      ...inspectArgv,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
    ], {}, dependencies);
    expect(invalidExit).toBe(1);
    expect(inspections).toHaveLength(1);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1,\"targetDisposalRequired\":false}\n",
    ]);
  });
});
