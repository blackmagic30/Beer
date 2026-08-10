import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  const targetUrlFile = path.join(root, "target-url");
  fs.writeFileSync(targetUrlFile, `${targetUrl}\n`, { mode: 0o600 });
  fs.chmodSync(targetUrlFile, 0o600);
  return {
    backupDirectory,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    targetUrlFile,
    receiptFile: path.join(root, "restore-receipt.json"),
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
}

function createHarness(options: HarnessOptions = {}) {
  const invocations: ProcessInvocation[] = [];
  const queries: string[] = [];
  const connectionConfigs: PostgresLogicalRestoreConnectionConfig[] = [];
  const events: string[] = [];
  let restored = options.initiallyNonEmpty ?? false;
  let connectCount = 0;
  const query = async <Row extends Record<string, unknown>>(
    text: string,
  ): Promise<PostgresLogicalRestoreQueryResult<Row>> => {
    queries.push(text);
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
      return { rows: [{ acquired: true } as unknown as Row], rowCount: 1 };
    }
    if (text.includes("logical-restore:unlock")) return { rows: [], rowCount: 1 };
    if (text.includes("logical-restore:api-roles")) return {
      rows: (options.apiRoles ?? []).map((roleName) => ({ roleName })) as unknown as Row[],
      rowCount: options.apiRoles?.length ?? 0,
    };
    if (text.includes("logical-restore:privileges-")) return { rows: [], rowCount: 0 };
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
    close: async () => undefined,
  };
  const runProcess = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    invocations.push(invocation);
    if (invocation.args[0] === "--version") {
      return { exitCode: 0, stdout: "pg_restore (PostgreSQL) 17.10 (Homebrew)\n", stderr: "" };
    }
    if (invocation.args[0] === "--list") {
      events.push("archive-validated");
      return { exitCode: 0, stdout: archiveListing(), stderr: "" };
    }
    events.push("restore-started");
    const result = options.restoreResult ?? { exitCode: 0, stdout: "", stderr: "" };
    if (result.exitCode === 0 && !result.stdout.trim() && !result.stderr.trim()) restored = true;
    if (result.exitCode !== 0 && options.leavePartialSchemasOnFailure) restored = true;
    return result;
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
    pgRestoreCommand: "/safe/bin/pg_restore",
    runProcess,
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
    events,
    invocations,
    queries,
    connectionConfigs,
    get connectCount() { return connectCount; },
  };
}

function restoreOptions(fixture: ReturnType<typeof writeFixture>) {
  return {
    backupDirectory: fixture.backupDirectory,
    expectedBackupManifestSha256: fixture.manifestSha256,
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

afterEach(() => {
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
  });

  it("restores with single-transaction safety and writes a private hash-only receipt", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const harness = createHarness({ apiRoles: ["anon", "authenticated", "service_role"] });
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
    expect(harness.events.indexOf("archive-validated")).toBeLessThan(harness.events.indexOf("connected"));
    const apiDenyIndexes = harness.queries
      .map((query, index) => query.includes("privileges-api-deny") ? index : -1)
      .filter((index) => index >= 0);
    const grantIndex = harness.queries.findIndex((query) => query.includes("privileges-grant"));
    expect(apiDenyIndexes).toHaveLength(3);
    expect(apiDenyIndexes.every((index) => index < grantIndex)).toBe(true);
    const restoreInvocation = harness.invocations.find((invocation) => (
      invocation.args.includes("--single-transaction")
    ))!;
    expect(restoreInvocation.args).toEqual([
      "--format=custom",
      "--dbname=",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--single-transaction",
      "--no-password",
      path.join(fixture.backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
    ]);
    expect(JSON.stringify(restoreInvocation.args)).not.toContain(secret);
    expect(restoreInvocation.env).toMatchObject({
      PATH: "/safe/bin",
      LC_ALL: "C",
      PGHOST: "db.example.invalid",
      PGPORT: "5432",
      PGDATABASE: "pintpath_restore",
      PGUSER: "restore_admin",
      PGPASSWORD: secret,
      PGSSLMODE: "verify-full",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-restore-rehearsal",
    });
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

    const nonemptyHarness = createHarness({ initiallyNonEmpty: true });
    const nonemptyError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      nonemptyHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(nonemptyError, "target_not_empty");
    expect(nonemptyHarness.invocations.some((item) => item.args.includes("--single-transaction"))).toBe(false);
  });

  it("relies on pg_restore single-transaction rollback and requires disposal if rollback cannot be proven", async () => {
    const root = temporaryRoot();
    const fixture = writeFixture(root);
    const rolledBackHarness = createHarness({
      restoreResult: {
        exitCode: 1,
        stdout: "",
        stderr: `raw connection failure ${targetUrl}`,
      },
    });
    const rolledBackError = await restorePostgresLogicalBackup(
      restoreOptions(fixture),
      rolledBackHarness.dependencies,
    ).catch((caught: unknown) => caught);
    expectRestoreError(rolledBackError, "restore_failed");
    expect(fs.existsSync(fixture.receiptFile)).toBe(false);
    expect(rolledBackHarness.invocations.find((item) => item.args.includes("--single-transaction"))?.args)
      .toContain("--exit-on-error");

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
    const rawFailureDependencies: Partial<PostgresLogicalRestoreCliDependencies> = {
      assertMutationAllowed: () => undefined,
      restoreBackup: async () => {
        throw new Error(`raw ${targetUrl} at ${root}`);
      },
      writeOutput: (value) => output.push(value),
    };
    const argv = [
      "restore",
      "--backup-directory", fixture.backupDirectory,
      "--backup-manifest-sha256", fixture.manifestSha256,
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
});
