import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPostgresLogicalBackupCli,
  type PostgresLogicalBackupCliDependencies,
} from "../scripts/backup-postgres-logical.js";
import {
  canonicalPostgresBackupJson,
  createPostgresLogicalBackup,
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  PostgresLogicalBackupError,
  postgresLogicalBackupManifestBindingSha256,
  type CreatePostgresLogicalBackupOptions,
  type PostgresLogicalBackupDependencies,
  type PostgresLogicalBackupManifest,
  type PostgresLogicalBackupManifestV2,
  type PostgresLogicalBackupManifestV3,
  type ProcessInvocation,
  type ProcessResult,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import type { PostgresLogicalStateInventory } from "../src/lib/postgres-logical-state.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const temporaryDirectories: string[] = [];
const connectionSecret = "logical-backup-secret";
const backupDatabaseOid = "16655";
const backupRole = `pintpath_logical_backup_d${backupDatabaseOid}`;
const backupLogin = `${backupRole}_v20260808`;
const sourceHostname = "postgres-staging.railway.internal";
const directTlsUrl = `postgresql://${backupLogin}:${connectionSecret}@${sourceHostname}:5432/pintpath?sslmode=verify-full`;
const testResolvedAddress = "fd12:3456:789a::10";
const testRootCaDerSha256 = "a".repeat(64);
const testRootCaPem = "test-only-public-root-ca\n";
const requiredTransportOptions = Object.freeze({
  transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  rootCaFile: "/private/railway-root-ca.pem",
  expectedRootCaDerSha256: testRootCaDerSha256,
});

interface TransportTestControl {
  assertions?: number;
  failAssertionAt?: number;
  closeFails?: boolean;
  events?: string[];
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-postgres-backup-test-"));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

async function openTestTransport(
  options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  control: TransportTestControl = {},
): Promise<PostgresRailwayStockLocalhostCaTransport> {
  control.events?.push("transport.open");
  expect(options).toEqual({
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile: path.resolve(requiredTransportOptions.rootCaFile),
    expectedRootCaDerSha256: testRootCaDerSha256,
    expectedUid: process.getuid?.() ?? -1,
    sourceUrlAuthority: { hostname: sourceHostname, port: 5_432 },
  });
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "pintpath-railway-stock-localhost-ca-test-",
  ));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const rootCaPath = path.join(directory, "railway-root-ca.pem");
  fs.writeFileSync(rootCaPath, testRootCaPem, { mode: 0o600 });
  fs.chmodSync(rootCaPath, 0o600);
  const directoryStat = fs.statSync(directory);
  const rootCaStat = fs.statSync(rootCaPath);
  let state: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | null = null;

  const transport: PostgresRailwayStockLocalhostCaTransport = {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaDerSha256: testRootCaDerSha256,
    sourceUrlAuthority: Object.freeze({ ...options.sourceUrlAuthority }),
    resolvedAddress: testResolvedAddress,
    temporaryDirectory: directory,
    passwordFileDirectory: directory,
    passwordFileHost: "localhost",
    nodeConnection: Object.freeze({
      host: testResolvedAddress,
      port: 5_432,
      ssl: Object.freeze({
        ca: testRootCaPem,
        servername: "localhost",
        rejectUnauthorized: true as const,
        minVersion: "TLSv1.2" as const,
        checkServerIdentity: () => undefined,
      }),
    }),
    libpqEnvironment: Object.freeze({
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: rootCaPath,
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    }),
    assertExact: async () => {
      control.events?.push("transport.assert");
      control.assertions = (control.assertions ?? 0) + 1;
      if (control.failAssertionAt === control.assertions) {
        throw new PostgresRailwayStockLocalhostCaError("transport_drift");
      }
      try {
        const currentDirectory = fs.lstatSync(directory);
        const currentRootCa = fs.lstatSync(rootCaPath);
        const entries = fs.readdirSync(directory).sort();
        if (
          state !== "open"
          || !currentDirectory.isDirectory()
          || currentDirectory.dev !== directoryStat.dev
          || currentDirectory.ino !== directoryStat.ino
          || (currentDirectory.mode & 0o7777) !== 0o700
          || !currentRootCa.isFile()
          || currentRootCa.dev !== rootCaStat.dev
          || currentRootCa.ino !== rootCaStat.ino
          || currentRootCa.nlink !== 1
          || (currentRootCa.mode & 0o7777) !== 0o600
          || fs.readFileSync(rootCaPath, "utf8") !== testRootCaPem
          || entries.some((entry) => !["pgpass", "railway-root-ca.pem"].includes(entry))
        ) throw new Error("drift");
      } catch {
        throw new PostgresRailwayStockLocalhostCaError("transport_drift");
      }
    },
    close: () => {
      if (closePromise) return closePromise;
      state = "closing";
      closePromise = (async () => {
        control.events?.push("transport.close");
        let exact = true;
        try {
          const current = fs.lstatSync(rootCaPath);
          if (
            !current.isFile()
            || current.dev !== rootCaStat.dev
            || current.ino !== rootCaStat.ino
          ) {
            exact = false;
          } else {
            if (
              current.nlink !== 1
              || (current.mode & 0o7777) !== 0o600
              || fs.readFileSync(rootCaPath, "utf8") !== testRootCaPem
            ) exact = false;
            fs.unlinkSync(rootCaPath);
          }
        } catch {
          exact = false;
        }
        try {
          if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
          else exact = false;
        } catch {
          exact = false;
        }
        state = "closed";
        if (!exact || control.closeFails) {
          throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
        }
      })();
      return closePromise;
    },
  };
  await transport.assertExact();
  return transport;
}

function createTestPostgresLogicalBackup(
  options: Omit<CreatePostgresLogicalBackupOptions,
    "transportProfile" | "rootCaFile" | "expectedRootCaDerSha256">,
  overrides: Partial<PostgresLogicalBackupDependencies> = {},
) {
  return createPostgresLogicalBackup({ ...requiredTransportOptions, ...options }, overrides);
}

function writeConnectionFile(root: string, value = directTlsUrl, mode = 0o600): string {
  const filePath = path.join(root, "postgres-url");
  fs.writeFileSync(filePath, `${value}\n`, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function pgpassTemporaryEntries(): string[] {
  return fs.readdirSync(fs.realpathSync(os.tmpdir()))
    .filter((entry) => entry.startsWith("pintpath-railway-stock-localhost-ca-test-"))
    .sort();
}

function validArchiveListing(): string {
  return [
    ";",
    "; Archive created at 2026-08-08 01:02:03 UTC",
    ";     TOC Entries: 4",
    ";     Compression: gzip",
    ";     Dump Version: 1.16-0",
    ";     Format: CUSTOM",
    ";     Integer: 4 bytes",
    ";     Offset: 8 bytes",
    ";     Dumped from database version: 17.6",
    ";     Dumped by pg_dump version: 17.10 (Homebrew)",
    ";",
    "2; 2615 100 SCHEMA - pintpath_app backup_user",
    "3; 2615 101 SCHEMA - pintpath_ops backup_user",
    "4; 1259 102 TABLE pintpath_app accounts backup_user",
    "5; 0 102 TABLE DATA pintpath_app accounts backup_user",
    "",
  ].join("\n");
}

interface ProcessHarnessOptions {
  dumpResult?: ProcessResult;
  listingResult?: ProcessResult;
  listing?: string;
  tamperDuringListing?: boolean;
  pgDumpVersion?: string;
  pgRestoreVersion?: string;
  throwOnDump?: boolean;
  events?: string[];
  pgpassMutation?:
    | "same-inode-content"
    | "same-inode-mode"
    | "replacement"
    | "extra-sibling"
    | "hardlink"
    | "missing";
}

interface PgpassObservation {
  path: string;
  contents: string;
  fileMode: number;
  directoryMode: number;
}

function createProcessHarness(options: ProcessHarnessOptions = {}) {
  const invocations: ProcessInvocation[] = [];
  const pgpassObservations: PgpassObservation[] = [];
  const runner = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    invocations.push(invocation);
    if (invocation.args.length === 1 && invocation.args[0] === "--version") {
      options.events?.push("process.version");
      const name = invocation.command.includes("restore") ? "pg_restore" : "pg_dump";
      const version = name === "pg_restore"
        ? options.pgRestoreVersion ?? "17.10 (Homebrew)"
        : options.pgDumpVersion ?? "17.10 (Homebrew)";
      return { exitCode: 0, stdout: `${name} (PostgreSQL) ${version}\n`, stderr: "" };
    }
    if (invocation.command.includes("dump")) {
      options.events?.push("process.dump");
      if (options.throwOnDump) throw new Error(`could not connect to ${directTlsUrl}`);
      const pgpassPath = invocation.env.PGPASSFILE;
      if (!pgpassPath) throw new Error("test dump invocation omitted PGPASSFILE");
      pgpassObservations.push({
        path: pgpassPath,
        contents: fs.readFileSync(pgpassPath, "utf8"),
        fileMode: fs.statSync(pgpassPath).mode & 0o7777,
        directoryMode: fs.statSync(path.dirname(pgpassPath)).mode & 0o7777,
      });
      if (options.pgpassMutation === "same-inode-content") {
        fs.writeFileSync(pgpassPath, "tampered-in-place\n", { mode: 0o600 });
      } else if (options.pgpassMutation === "same-inode-mode") {
        fs.chmodSync(pgpassPath, 0o400);
      } else if (options.pgpassMutation === "replacement") {
        fs.unlinkSync(pgpassPath);
        fs.writeFileSync(pgpassPath, "untrusted-replacement\n", { mode: 0o600 });
      } else if (options.pgpassMutation === "extra-sibling") {
        fs.writeFileSync(path.join(path.dirname(pgpassPath), "unexpected"), "keep");
      } else if (options.pgpassMutation === "hardlink") {
        fs.linkSync(pgpassPath, path.join(path.dirname(pgpassPath), "retained-hardlink"));
      } else if (options.pgpassMutation === "missing") {
        fs.unlinkSync(pgpassPath);
      }
      const outputArgument = invocation.args.find((argument) => argument.startsWith("--file="));
      if (!outputArgument) throw new Error("test dump invocation omitted --file");
      const archivePath = outputArgument.slice("--file=".length);
      fs.writeFileSync(archivePath, Buffer.from("PGDMP-test-archive"));
      return options.dumpResult ?? { exitCode: 0, stdout: "", stderr: "" };
    }
    if (invocation.command.includes("restore")) {
      options.events?.push("process.list");
      if (options.tamperDuringListing) {
        const archivePath = invocation.args.at(-1)!;
        fs.appendFileSync(archivePath, "tampered");
      }
      return options.listingResult ?? {
        exitCode: 0,
        stdout: options.listing ?? validArchiveListing(),
        stderr: "",
      };
    }
    throw new Error("unexpected test process");
  };
  return { invocations, pgpassObservations, runner };
}

function dependencies(
  runner: PostgresLogicalBackupDependencies["runProcess"],
  queries: string[] = [],
  transportControl: TransportTestControl = {},
): Partial<PostgresLogicalBackupDependencies> {
  const connection = {
    query: async <Row extends Record<string, unknown>>(text: string) => {
      queries.push(text);
      if (text.includes("source-identity")) return {
        rows: [{
          systemIdentifier: "7568999345281279000",
          databaseOid: "16655",
          databaseName: "pintpath",
          backupRoleName: backupRole,
          serverVersionNum: "170006",
          roleName: backupLogin,
          canLogin: true,
          inheritsPrivileges: false,
          connectionLimit: 2,
          validUntilIsNull: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          membershipCount: 1,
          childMembershipCount: 0,
          hasExactLogicalBackupMembership: true,
          canSetLogicalBackup: true,
          canSetMigrator: false,
          canSetRuntime: false,
          canSetSiblingLogicalBackup: false,
          directDatabasePrivilegeCount: 1,
          hasDirectDatabaseConnect: true,
          directFunctionPrivilegeCount: 1,
          hasDirectControlSystemExecute: true,
          directPrivateObjectPrivilegeCount: 0,
          ownedPrivateObjectCount: 0,
          roleSettingCount: 0,
          sharedDependencyCount: 2,
          exactSharedDependencyCount: 2,
          transactionReadOnly: false,
          inRecovery: false,
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("effective-role")) return {
        rows: [{
          effectiveRole: backupRole,
          sessionRole: backupLogin,
          transactionIsolation: "repeatable read",
          transactionReadOnly: true,
          canLogin: false,
          inheritsPrivileges: false,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          membershipCount: 0,
          childMembershipCount: 1,
          exactSessionLoginChildCount: 1,
          directDatabasePrivilegeCount: 0,
          directFunctionPrivilegeCount: 0,
          roleSettingCount: 0,
          ownedCurrentDatabaseObjectCount: 0,
          sharedDependencyCount: 61,
          exactSharedDependencyCount: 61,
          privateSchemaCount: 2,
          directSchemaPrivilegeCount: 2,
          selectOnlySchemaCount: 2,
          privateRelationCount: 59,
          forceRlsRelationCount: 59,
          directRelationPrivilegeCount: 59,
          selectOnlyRelationCount: 59,
          privateSequenceCount: 0,
          selectOnlySequenceCount: 0,
          directColumnPrivilegeCount: 0,
          executablePrivateFunctionCount: 0,
          privatePolicyCount: 236,
          exactBasePolicyCount: 177,
          publicPrivatePolicyCount: 59,
          exactLogicalBackupSelectPolicyCount: 59,
          unsafePublicPrivatePolicyCount: 0,
          unsafeReservedPolicyNameCount: 0,
          directScopedPolicyCount: 0,
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("export-snapshot")) return {
        rows: [{ snapshotIdentifier: "00000003-0000001B-1" } as unknown as Row],
        rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
    close: async () => { transportControl.events?.push("connection.close"); },
  };
  return {
    env: {
      PATH: "/safe/bin",
      LANG: "en_AU.UTF-8",
      DATABASE_URL: "postgresql://inherited:must-not-leak@inherited.invalid/db",
      PGPASSWORD: "inherited-password-must-not-leak",
      PGOPTIONS: "-c search_path=attacker",
      PGPASSFILE: "/tmp/inherited-pgpass-must-not-leak",
      PGSERVICEFILE: "/tmp/inherited-service-must-not-leak",
      AWS_SECRET_ACCESS_KEY: "unrelated-secret-must-not-leak",
    },
    now: () => new Date("2026-08-08T01:02:03.000Z"),
    pgDumpCommand: "/safe/bin/pg_dump",
    pgRestoreCommand: "/safe/bin/pg_restore",
    runProcess: runner,
    connect: async () => {
      transportControl.events?.push("connection.open");
      return connection;
    },
    computeState: async () => fakeStateInventory(),
    openTransport: (options) => openTestTransport(options, transportControl),
  };
}

function fakeStateInventory(): PostgresLogicalStateInventory {
  const tables = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
    tableName: table.name,
    columnCount: table.columns.length,
    rowCount: table.name === "system_state" ? "1" : "0",
    transformedSha256: sha256(`table:${table.name}`),
    firstPrimaryKeySha256: table.name === "system_state" ? sha256("first") : null,
    lastPrimaryKeySha256: table.name === "system_state" ? sha256("last") : null,
  }));
  return {
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    authoritativeRowCount: "1",
    nonEmptyAuthoritativeTableCount: 1,
    zeroRowAuthoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables - 1,
    migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSchemaSha256: "1".repeat(64),
    sourceSnapshotSha256: "2".repeat(64),
    targetDdlSha256: "3".repeat(64),
    schemaMetadataSha256: "4".repeat(64),
    tableSetSha256: "5".repeat(64),
    transformedDataSha256: "6".repeat(64),
    keyRangesSha256: "7".repeat(64),
    stateTotalsSha256: "8".repeat(64),
    archivedControlTableCount: 3,
    archivedControlRowCount: "12",
    archivedControlTableSetSha256: "a".repeat(64),
    archivedControlDataSha256: "b".repeat(64),
    archivedControlKeyRangesSha256: "c".repeat(64),
    overallStateSha256: "9".repeat(64),
    tables,
    archivedControlTables: [
      {
        tableName: "pintpath_app.schema_metadata", columnCount: 3, rowCount: "12",
        transformedSha256: "d".repeat(64), firstPrimaryKeySha256: "e".repeat(64),
        lastPrimaryKeySha256: "f".repeat(64),
      },
      {
        tableName: "pintpath_ops.migration_chunks", columnCount: 7, rowCount: "0",
        transformedSha256: "1".repeat(64), firstPrimaryKeySha256: null,
        lastPrimaryKeySha256: null,
      },
      {
        tableName: "pintpath_ops.migration_runs", columnCount: 18, rowCount: "0",
        transformedSha256: "2".repeat(64), firstPrimaryKeySha256: null,
        lastPrimaryKeySha256: null,
      },
    ],
  };
}

function historicalV2Manifest(): PostgresLogicalBackupManifestV2 {
  return {
    schemaVersion: 2,
    kind: "pintpath-postgres-logical-backup",
    createdAt: "2026-08-08T01:02:03.000Z",
    archive: {
      file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      format: "custom",
      bytes: 123,
      sha256: "1".repeat(64),
      schemas: ["pintpath_app", "pintpath_ops"],
      aclStatementsIncluded: false,
      requiredRestoreOptions: ["--no-owner", "--no-acl"],
    },
    tools: {
      pgDump: { name: "pg_dump", version: "17.10", major: 17 },
      pgRestore: { name: "pg_restore", version: "17.10", major: 17 },
    },
    validation: {
      method: "pg_restore --list",
      tocEntries: 4,
      listedEntries: 4,
      listingSha256: "2".repeat(64),
      dumpedFromDatabaseVersion: "17.6",
      dumpedByPgDumpVersion: "17.10",
    },
    state: {
      receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      receiptSha256: "3".repeat(64),
      manifestBindingSha256: "4".repeat(64),
      sourceDatabaseIdentitySha256: "5".repeat(64),
      sourceUrlSha256: "6".repeat(64),
      snapshotBindingSha256: "7".repeat(64),
      migrationContractSha256: "8".repeat(64),
      schemaMetadataSha256: "9".repeat(64),
      targetDdlSha256: "a".repeat(64),
      authoritativeTableCount: 56,
      authoritativeRowCount: "1234",
      tableSetSha256: "b".repeat(64),
      transformedDataSha256: "c".repeat(64),
      stateTotalsSha256: "d".repeat(64),
      keyRangesSha256: "e".repeat(64),
      archivedControlTableCount: 3,
      archivedControlRowCount: "12",
      archivedControlTableSetSha256: "f".repeat(64),
      archivedControlDataSha256: "0".repeat(64),
      archivedControlKeyRangesSha256: "1".repeat(64),
      overallStateSha256: "2".repeat(64),
    },
  };
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectBackupError(error: unknown, code: PostgresLogicalBackupError["code"]): void {
  expect(error).toBeInstanceOf(PostgresLogicalBackupError);
  expect((error as PostgresLogicalBackupError).code).toBe(code);
  expect(String((error as Error).message)).toBe(code);
  expect(String((error as Error).message)).not.toContain(connectionSecret);
  expect(String((error as Error).message)).not.toContain(sourceHostname);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres logical backup foundation", () => {
  it("preserves the historical v2 binding domain and binds v3 transport under domain v2", () => {
    const v2 = historicalV2Manifest();
    expect(postgresLogicalBackupManifestBindingSha256(v2)).toBe(
      "a8fda0d78a15ac3345bc1d63e30d9b58f673620cfcb6e7e404767e15600a32ab",
    );
    const { schemaVersion: _historicalSchemaVersion, ...shared } = v2;
    const v3: PostgresLogicalBackupManifestV3 = {
      ...shared,
      schemaVersion: 3,
      transport: {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaCertificateSha256: testRootCaDerSha256,
      },
    };
    expect(postgresLogicalBackupManifestBindingSha256(v3)).toBe(
      "c825dcd06172799d1ebbd89d807e2a9611abe0a5396c1e039a3e378d020831fe",
    );
    expect(postgresLogicalBackupManifestBindingSha256({
      ...v3,
      transport: { ...v3.transport, rootCaCertificateSha256: "b".repeat(64) },
    })).not.toBe(postgresLogicalBackupManifestBindingSha256(v3));
  });

  it("keeps the exact frozen HEAD v2 offsite binding, receipt, and manifest hashes", () => {
    const root = makeTemporaryDirectory();
    const fixture = writeLogicalOffsiteFixture(
      root,
      "2026-08-09T01:00:00.000Z",
      2,
    );
    expect(fixture.manifest.schemaVersion).toBe(2);
    expect("transport" in fixture.manifest).toBe(false);
    expect(fixture.manifest.state.manifestBindingSha256).toBe(
      "a2f0cf1fd96f8f079b4de541e64476df4eb0c8f851e52a34e2e5fbb385892a0f",
    );
    expect(fixture.receiptSha256).toBe(
      "06712c88385f51501e64d8bc21a7bad327b41f494824467e36acfb3d3fbe351f",
    );
    expect(fixture.manifestSha256).toBe(
      "d6d4ce365aea2360da298c6bdd8f88d00f26c188b04c64a26cfc181690f20405",
    );
  });

  it("creates and validates a private custom archive with a canonical SHA manifest", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "logical-backup");
    const canonicalOutputDirectory = path.join(fs.realpathSync(root), "logical-backup");
    const harness = createProcessHarness();

    const result = await createTestPostgresLogicalBackup(
      {
        connectionFile,
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      },
      dependencies(harness.runner),
    );

    expect(result).toEqual({
      schemaVersion: 3,
      ok: true,
      outputDirectory: canonicalOutputDirectory,
      archivePath: path.join(canonicalOutputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      manifestPath: path.join(canonicalOutputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      stateReceiptPath: path.join(
        canonicalOutputDirectory,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ),
      archiveSha256: sha256("PGDMP-test-archive"),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stateReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      authoritativeRowCount: "1",
      overallStateSha256: "9".repeat(64),
    });
    expect(fs.statSync(outputDirectory).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(result.archivePath).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(result.manifestPath).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(result.stateReceiptPath).mode & 0o7777).toBe(0o600);
    expect(sha256(fs.readFileSync(result.manifestPath))).toBe(result.manifestSha256);

    const manifestBytes = fs.readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes) as PostgresLogicalBackupManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      kind: "pintpath-postgres-logical-backup",
      createdAt: "2026-08-08T01:02:03.000Z",
      transport: {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaCertificateSha256: testRootCaDerSha256,
      },
      archive: {
        file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        format: "custom",
        bytes: Buffer.byteLength("PGDMP-test-archive"),
        sha256: sha256("PGDMP-test-archive"),
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
        listingSha256: sha256(validArchiveListing()),
        dumpedFromDatabaseVersion: "17.6",
        dumpedByPgDumpVersion: "17.10 (Homebrew)",
      },
      state: {
        receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
        receiptSha256: result.stateReceiptSha256,
        manifestBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceDatabaseIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceUrlSha256: sha256(directTlsUrl),
        snapshotBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
        schemaMetadataSha256: "4".repeat(64),
        targetDdlSha256: "3".repeat(64),
        authoritativeTableCount: 56,
        authoritativeRowCount: "1",
        tableSetSha256: "5".repeat(64),
        transformedDataSha256: "6".repeat(64),
        stateTotalsSha256: "8".repeat(64),
        keyRangesSha256: "7".repeat(64),
        archivedControlTableCount: 3,
        archivedControlRowCount: "12",
        archivedControlTableSetSha256: "a".repeat(64),
        archivedControlDataSha256: "b".repeat(64),
        archivedControlKeyRangesSha256: "c".repeat(64),
        overallStateSha256: "9".repeat(64),
      },
    });
    expect(manifestBytes).toBe(canonicalPostgresBackupJson(manifest));
    expect(manifestBytes).not.toContain(connectionSecret);
    expect(manifestBytes).not.toContain(sourceHostname);
    expect(manifestBytes).not.toContain("backup_user");
    expect(manifestBytes).not.toContain(backupLogin);
    const receiptBytes = fs.readFileSync(result.stateReceiptPath, "utf8");
    expect(sha256(receiptBytes)).toBe(result.stateReceiptSha256);
    expect(receiptBytes).not.toContain(connectionSecret);
    expect(receiptBytes).not.toContain(sourceHostname);
    expect(receiptBytes).not.toContain("backup_user");
    expect(receiptBytes).not.toContain(backupLogin);
  });

  it.each([
    ["wrong profile", { transportProfile: "railway-stock-localhost-ca-v2" }],
    ["missing root CA file", { rootCaFile: "" }],
    ["noncanonical DER pin", { expectedRootCaDerSha256: testRootCaDerSha256.toUpperCase() }],
  ])("rejects the required transport input %s before reading runtime authority", async (_label, change) => {
    const root = makeTemporaryDirectory();
    let uidRead = false;
    const error = await createPostgresLogicalBackup({
      ...requiredTransportOptions,
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "invalid-transport-input"),
      ...change,
    } as CreatePostgresLogicalBackupOptions, {
      ...dependencies(createProcessHarness().runner),
      getUid: () => {
        uidRead = true;
        return process.getuid?.() ?? 0;
      },
    }).catch((caught: unknown) => caught);
    expectBackupError(error, "invalid_arguments");
    expect(uidRead).toBe(false);
  });

  it("rejects noncanonical or overlapping authority paths before any asynchronous authority read", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "canonical-output");
    const cases: Array<Partial<CreatePostgresLogicalBackupOptions>> = [
      { connectionFile: "relative/source-url" },
      { rootCaFile: "relative/root-ca.pem" },
      { outputDirectory: "relative/output" },
      { rootCaFile: `/private/root-ca.pem\0suffix` },
      { rootCaFile: connectionFile },
      { outputDirectory: connectionFile },
      { outputDirectory: path.dirname(connectionFile) },
    ];
    for (const change of cases) {
      let uidRead = false;
      const error = await createPostgresLogicalBackup({
        ...requiredTransportOptions,
        connectionFile,
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
        ...change,
      }, {
        ...dependencies(createProcessHarness().runner),
        getUid: () => {
          uidRead = true;
          return process.getuid?.() ?? 0;
        },
      }).catch((caught: unknown) => caught);
      expectBackupError(error, "invalid_arguments");
      expect(uidRead).toBe(false);
    }
  });

  it.each([
    ["profile", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      profile: "railway-stock-localhost-ca-v2",
    })],
    ["DER pin", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      rootCaDerSha256: "b".repeat(64),
    })],
    ["hostname", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: "changed.railway.internal", port: 5_432 },
    })],
    ["port", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: sourceHostname, port: 6_543 },
    })],
    ["authority shape", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: sourceHostname, port: 5_432, extra: true },
    })],
  ])("rejects a returned transport with mismatched %s before tools or connection", async (_label, mutate) => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "mismatched-returned-transport");
    const events: string[] = [];
    const control: TransportTestControl = { events };
    const harness = createProcessHarness({ events });
    let connected = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, {
      ...dependencies(harness.runner, [], control),
      openTransport: async (transportOptions) => mutate(
        await openTestTransport(transportOptions, control)
      ) as unknown as PostgresRailwayStockLocalhostCaTransport,
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(harness.invocations).toEqual([]);
    expect(connected).toBe(false);
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(events).toContain("transport.close");
  });

  it("gives cleanup failure precedence when rejecting a mismatched returned transport", async () => {
    const root = makeTemporaryDirectory();
    const control: TransportTestControl = { closeFails: true };
    const harness = createProcessHarness();
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "mismatch-close-failure"),
    }, {
      ...dependencies(harness.runner),
      openTransport: async (transportOptions) => ({
        ...await openTestTransport(transportOptions, control),
        rootCaDerSha256: "b".repeat(64),
      }) as PostgresRailwayStockLocalhostCaTransport,
    }).catch((caught: unknown) => caught);
    expectBackupError(error, "cleanup_failed");
    expect(harness.invocations).toEqual([]);
  });

  it("opens and pins the transport before tools or database access and closes it last", async () => {
    const root = makeTemporaryDirectory();
    const events: string[] = [];
    const control: TransportTestControl = { events };
    const harness = createProcessHarness({ events });
    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "ordered-lifecycle"),
    }, dependencies(harness.runner, [], control));

    expect(control.assertions).toBe(11);
    expect(events.indexOf("transport.open")).toBeLessThan(events.indexOf("process.version"));
    expect(events.lastIndexOf("process.version")).toBeLessThan(events.indexOf("connection.open"));
    expect(events.indexOf("connection.open")).toBeLessThan(events.indexOf("process.dump"));
    expect(events.indexOf("process.dump")).toBeLessThan(events.indexOf("process.list"));
    expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
    expect(events.at(-1)).toBe("transport.close");
  });

  it.each([
    ["exported snapshot", 5],
    ["pg_dump completion", 9],
    ["manifest finalization", 11],
  ])("fails closed on transport drift at the %s boundary", async (_label, failAssertionAt) => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, `transport-drift-${failAssertionAt}`);
    const events: string[] = [];
    const control: TransportTestControl = { events, failAssertionAt };
    const harness = createProcessHarness({ events });
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner, [], control)).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
  });

  it("gives transport cleanup failure precedence over a pg_dump failure", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "transport-close-dominance");
    const events: string[] = [];
    const control: TransportTestControl = { events, closeFails: true };
    const harness = createProcessHarness({
      events,
      dumpResult: { exitCode: 1, stdout: "", stderr: "test-only failure" },
    });
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner, [], control)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
  });

  it("contains transport-open failures before tools, connection, or output creation", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "transport-open-failure");
    const harness = createProcessHarness();
    let connected = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, {
      ...dependencies(harness.runner),
      openTransport: async () => {
        throw new PostgresRailwayStockLocalhostCaError("root_ca_pin_mismatch");
      },
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(harness.invocations).toEqual([]);
    expect(connected).toBe(false);
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("snapshots URL, CA, profile, and output authorities before asynchronous work", async () => {
    const root = makeTemporaryDirectory();
    const originalOutput = path.join(root, "snapshotted-options");
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    const supplied: CreatePostgresLogicalBackupOptions = {
      ...requiredTransportOptions,
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: originalOutput,
    };
    const result = await createPostgresLogicalBackup(supplied, {
      ...base,
      openTransport: async (transportOptions) => {
        const mutable = supplied as unknown as Record<string, unknown>;
        mutable.expectedSourceUrlSha256 = "b".repeat(64);
        mutable.expectedRootCaDerSha256 = "c".repeat(64);
        mutable.transportProfile = "railway-stock-localhost-ca-v2";
        mutable.rootCaFile = "/private/replaced-root-ca.pem";
        mutable.outputDirectory = path.join(root, "mutated-output");
        return base.openTransport!(transportOptions);
      },
    });
    expect(result.outputDirectory).toBe(fs.realpathSync(originalOutput));
    expect(fs.existsSync(path.join(root, "mutated-output"))).toBe(false);
  });

  it("passes credentials only through a scoped pg_dump environment", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const queries: string[] = [];
    const result = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup"),
    }, dependencies(harness.runner, queries));

    const dump = harness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    const restoreList = harness.invocations.find((invocation) => invocation.args.includes("--list"))!;
    const versionInvocations = harness.invocations.filter((invocation) => invocation.args[0] === "--version");
    expect(dump.args).toEqual([
      "--format=custom",
      `--file=${result.archivePath}`,
      "--snapshot=00000003-0000001B-1",
      `--role=${backupRole}`,
      "--no-owner",
      "--no-acl",
      "--enable-row-security",
      "--strict-names",
      "--lock-wait-timeout=30s",
      "--no-password",
      "--schema=pintpath_app",
      "--schema=pintpath_ops",
    ]);
    expect(JSON.stringify(dump.args)).not.toContain(connectionSecret);
    expect(JSON.stringify(dump.args)).not.toContain(sourceHostname);
    expect(JSON.stringify(dump.args)).not.toContain("backup_user");
    expect(dump.env).toMatchObject({
      PATH: "/safe/bin",
      LC_ALL: "C",
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGPORT: "5432",
      PGDATABASE: "pintpath",
      PGUSER: backupLogin,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: path.join(path.dirname(dump.env.PGPASSFILE), "railway-root-ca.pem"),
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
    });
    expect(dump.env.DATABASE_URL).toBeUndefined();
    expect(dump.env.PGOPTIONS).toBeUndefined();
    expect(dump.env.PGPASSFILE).toMatch(
      /\/pintpath-railway-stock-localhost-ca-test-[^/]+\/pgpass$/,
    );
    expect(dump.env.PGSERVICEFILE).toBeUndefined();
    expect(dump.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(dump.env.PGPASSWORD).toBeUndefined();
    expect(harness.pgpassObservations).toEqual([{
      path: dump.env.PGPASSFILE,
      contents: `localhost:5432:pintpath:${backupLogin}:${connectionSecret}\n`,
      fileMode: 0o600,
      directoryMode: 0o700,
    }]);
    expect(path.dirname(path.dirname(dump.env.PGPASSFILE))).toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.existsSync(dump.env.PGPASSFILE)).toBe(false);
    expect(fs.existsSync(path.dirname(dump.env.PGPASSFILE))).toBe(false);
    expect(restoreList.args).toEqual(["--list", "--format=custom", result.archivePath]);
    expect(restoreList.env.PGPASSWORD).toBeUndefined();
    expect(restoreList.env.PGPASSFILE).toBeUndefined();
    expect(restoreList.env.DATABASE_URL).toBeUndefined();
    expect(versionInvocations).toHaveLength(2);
    expect(versionInvocations.every((invocation) => invocation.env.PGPASSWORD === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => invocation.env.PGPASSFILE === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => invocation.env.DATABASE_URL === undefined)).toBe(true);
    expect(queries.filter((query) => query.includes("logical-backup:set-role"))).toEqual([
      `/* pintpath:logical-backup:set-role */ SET ROLE ${backupRole}`,
    ]);
    expect(queries.some((query) => query.includes("SET ROLE pintpath_migrator"))).toBe(false);
    const identityQuery = queries.find((query) => query.includes("logical-backup:source-identity"))!;
    expect(identityQuery).toContain("NOT membership.admin_option");
    expect(identityQuery).toContain("NOT membership.inherit_option");
    expect(identityQuery).toContain("membership.set_option");
    expect(identityQuery).toContain("hasDirectDatabaseConnect");
    expect(identityQuery).toContain("hasDirectControlSystemExecute");
    expect(identityQuery).toContain(
      "pg_has_role(session_user, 'pintpath_runtime', 'SET') AS \"canSetRuntime\"",
    );
  });

  it("pins the exact trimmed source URL before tools, connection, output, or pgpass creation", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "hash-mismatch");
    const harness = createProcessHarness();
    const beforePgpassEntries = pgpassTemporaryEntries();
    let connected = false;
    const base = dependencies(harness.runner);

    const mismatch = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: "f".repeat(64),
      outputDirectory,
    }, {
      ...base,
      connect: async (config) => {
        connected = true;
        return base.connect!(config);
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(mismatch, "unsafe_connection_url");
    expect(connected).toBe(false);
    expect(harness.invocations).toEqual([]);
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);

    for (const invalidHash of ["A".repeat(64), "a".repeat(63), ` ${"a".repeat(64)}`]) {
      let uidRead = false;
      const malformed = await createTestPostgresLogicalBackup({
        connectionFile,
        expectedSourceUrlSha256: invalidHash,
        outputDirectory,
      }, {
        ...base,
        getUid: () => {
          uidRead = true;
          return process.getuid?.() ?? 0;
        },
      }).catch((caught: unknown) => caught);
      expectBackupError(malformed, "invalid_arguments");
      expect(uidRead).toBe(false);
    }
    expect(harness.invocations).toEqual([]);
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);
  });

  it("hashes the logical trimmed URL rather than connection-file whitespace", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = path.join(root, "postgres-url");
    fs.writeFileSync(connectionFile, ` \t${directTlsUrl}\n`, { mode: 0o600 });
    fs.chmodSync(connectionFile, 0o600);
    const harness = createProcessHarness();

    await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "trimmed-url"),
    }, dependencies(harness.runner));

    expect(harness.invocations.some((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))).toBe(true);
  });

  it("uses only the pinned localhost-CA projection and rejects the old loopback fallback", async () => {
    const root = makeTemporaryDirectory();
    const strictHarness = createProcessHarness();
    const strictBase = dependencies(strictHarness.runner);
    const strictDelegate = await strictBase.connect!({} as never);
    let strictConfig: Parameters<NonNullable<PostgresLogicalBackupDependencies["connect"]>>[0] | null = null;
    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "strict-tls"),
    }, {
      ...strictBase,
      connect: async (config) => {
        strictConfig = config;
        return strictDelegate;
      },
    });
    expect(strictConfig).toMatchObject({
      host: testResolvedAddress,
      port: 5_432,
      database: "pintpath",
      user: backupLogin,
      ssl: {
        ca: testRootCaPem,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    });
    expect(strictConfig?.ssl.checkServerIdentity).toBeTypeOf("function");
    const strictDump = strictHarness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(strictDump.env).toMatchObject({
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGSSLMODE: "verify-full",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    });
    expect(strictDump.env.PGSSLROOTCERT).not.toBe("system");

    const loopbackUrl = `postgresql://${backupLogin}:${connectionSecret}@127.0.0.1:5432/pintpath?sslmode=disable`;
    const loopbackHarness = createProcessHarness();
    const loopbackError = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, loopbackUrl),
      expectedSourceUrlSha256: sha256(loopbackUrl),
      outputDirectory: path.join(root, "loopback-test-seam"),
    }, dependencies(loopbackHarness.runner)).catch((error: unknown) => error);
    expectBackupError(loopbackError, "unsafe_connection_url");
    expect(loopbackHarness.invocations).toEqual([]);
  });

  it("escapes database and password pgpass fields without exposing the secret in argv", async () => {
    const root = makeTemporaryDirectory();
    const database = "pint:path";
    const password = "secret:with\\backslash";
    const url = `postgresql://${backupLogin}:${encodeURIComponent(password)}@${sourceHostname}:5432/${encodeURIComponent(database)}?sslmode=verify-full`;
    const harness = createProcessHarness();

    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
      expectedSourceUrlSha256: sha256(url),
      outputDirectory: path.join(root, "escaped-pgpass"),
    }, dependencies(harness.runner));

    expect(harness.pgpassObservations[0]?.contents).toBe(
      `localhost:5432:pint\\:path:${backupLogin}:secret\\:with\\\\backslash\n`,
    );
    const dump = harness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(JSON.stringify(dump.args)).not.toContain(password);
    expect(dump.env.PGPASSWORD).toBeUndefined();
  });

  it.each([
    "not-a-url",
    "https://backup_user:secret@db.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/pintpath",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=disable",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=verify-ca",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&sslmode=verify-full",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&SSLMODE=require",
    "postgresql://backup_user:secret@pooler.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@pgbouncer.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid:6543/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require#fragment",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&options=-c%20role%3Dpostgres",
    "postgresql://backup_user@db.example.invalid/pintpath?sslmode=require",
    "postgresql://:secret@db.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/?sslmode=require",
    "postgresql://backup_user*:secret@db.example.invalid/pintpath?sslmode=verify-full",
    "postgresql://backup_user:secret@*.example.invalid/pintpath?sslmode=verify-full",
    "postgresql://backup_user:secret@db.example.invalid/pintpath*?sslmode=verify-full",
  ])("rejects an unsafe or pooled connection before invoking tools: %s", async (url) => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
      expectedSourceUrlSha256: sha256(url),
      outputDirectory: path.join(root, "backup"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_connection_url");
    expect(harness.invocations).toEqual([]);
    expect(fs.existsSync(path.join(root, "backup"))).toBe(false);
  });

  it("requires a current-user-owned regular mode-600 connection file", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const worldReadable = writeConnectionFile(root, directTlsUrl, 0o644);
    const worldReadableError = await createTestPostgresLogicalBackup({
      connectionFile: worldReadable,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-mode"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(worldReadableError, "unsafe_connection_file");

    fs.rmSync(worldReadable);
    const target = writeConnectionFile(root);
    const symbolicLink = path.join(root, "postgres-url-link");
    fs.symlinkSync(target, symbolicLink);
    const symbolicLinkError = await createTestPostgresLogicalBackup({
      connectionFile: symbolicLink,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-link"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(symbolicLinkError, "unsafe_connection_file");

    const uid = process.getuid?.() ?? 0;
    const wrongOwnerError = await createTestPostgresLogicalBackup({
      connectionFile: target,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-owner"),
    }, {
      ...dependencies(harness.runner),
      getUid: () => uid + 1,
    }).catch((caught: unknown) => caught);
    expectBackupError(wrongOwnerError, "unsafe_connection_file");
    expect(harness.invocations).toEqual([]);
  });

  it("refuses an existing output directory without deleting it", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "existing-backup");
    fs.mkdirSync(outputDirectory);
    const sentinel = path.join(outputDirectory, "belongs-to-operator.txt");
    fs.writeFileSync(sentinel, "preserve me");
    const harness = createProcessHarness();

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_output_path");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it("removes a partial output directory when pg_dump fails and redacts its diagnostics", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "failed-dump");
    const harness = createProcessHarness({
      dumpResult: {
        exitCode: 1,
        stdout: "",
        stderr: `connection failed for ${directTlsUrl}`,
      },
    });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "dump_failed");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("cleans up when the injected process runner throws a credential-bearing error", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "thrown-dump-error");
    const harness = createProcessHarness({ throwOnDump: true });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "dump_failed");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it.each(["same-inode-content", "same-inode-mode"] as const)(
    "unlinks a %s pgpass drift, removes its directory, and fails cleanup closed",
    async (pgpassMutation) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(root, "pgpass-content-drift");
      const harness = createProcessHarness({ pgpassMutation });

      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness.runner)).catch((caught: unknown) => caught);

      expectBackupError(error, "cleanup_failed");
      const pgpassPath = harness.pgpassObservations[0]!.path;
      expect(fs.existsSync(pgpassPath)).toBe(false);
      expect(fs.existsSync(path.dirname(pgpassPath))).toBe(false);
      expect(fs.existsSync(outputDirectory)).toBe(false);
    },
  );

  it("never deletes a replacement pgpass pathname and still fails cleanup closed", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "pgpass-replacement");
    const harness = createProcessHarness({ pgpassMutation: "replacement" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    expect(fs.readFileSync(pgpassPath, "utf8")).toBe("untrusted-replacement\n");
    expect(fs.existsSync(outputDirectory)).toBe(false);
    fs.unlinkSync(pgpassPath);
    fs.rmdirSync(path.dirname(pgpassPath));
  });

  it("removes only the trusted pgpass when an unexpected sibling blocks nonrecursive cleanup", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness({ pgpassMutation: "extra-sibling" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-extra-sibling"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    const sibling = path.join(path.dirname(pgpassPath), "unexpected");
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("keep");
    fs.unlinkSync(sibling);
    fs.rmdirSync(path.dirname(pgpassPath));
  });

  it("unlinks the exact pgpass pathname but retains a post-spawn hardlink", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness({ pgpassMutation: "hardlink" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-hardlink"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    const retained = path.join(path.dirname(pgpassPath), "retained-hardlink");
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.readFileSync(retained, "utf8")).toContain(connectionSecret);
    fs.unlinkSync(retained);
    fs.rmdirSync(path.dirname(pgpassPath));
  });

  it("removes an empty exact pgpass directory when the leaf disappears", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness({ pgpassMutation: "missing" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-missing"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.existsSync(path.dirname(pgpassPath))).toBe(false);
  });

  it("identity-safely removes a partial pgpass when writing fails before its full snapshot", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const beforePgpassEntries = pgpassTemporaryEntries();
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (originalOpen as (...values: unknown[]) => Promise<fs.promises.FileHandle>)(
        ...args,
      );
      if (path.basename(String(args[0])) === "pgpass") {
        Object.defineProperty(handle, "writeFile", {
          configurable: true,
          value: async () => { throw new Error("injected pgpass write failure"); },
        });
      }
      return handle;
    }) as typeof fs.promises.open);
    let error: unknown;
    try {
      error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory: path.join(root, "pgpass-partial-write"),
      }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    } finally {
      openSpy.mockRestore();
    }

    expectBackupError(error, "cleanup_failed");
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);
    expect(harness.invocations.some((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))).toBe(false);
  });

  it("rejects and cleans an archive that pg_restore cannot validate", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "invalid-archive");
    const harness = createProcessHarness({
      listingResult: {
        exitCode: 1,
        stdout: "",
        stderr: `archive from ${directTlsUrl} is corrupt`,
      },
    });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "archive_invalid");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("detects archive tampering during pg_restore validation and cleans the output", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "tampered-archive");
    const harness = createProcessHarness({ tamperDuringListing: true });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "archive_tampered");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("rejects a listing that does not prove both private schemas are present", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "missing-schema");
    const harness = createProcessHarness({
      listing: validArchiveListing().replace(
        "3; 2615 101 SCHEMA - pintpath_ops backup_user\n",
        "",
      ),
    });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "archive_invalid");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("rejects mismatched pg_dump and pg_restore majors before creating output", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "mismatched-tools");
    const harness = createProcessHarness({ pgRestoreVersion: "16.8" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "tool_unavailable_or_unsupported");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("fails closed for a privileged source login before creating an archive", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    let closed = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-role"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(text: string) => {
          if (!text.includes("source-identity")) throw new Error("unexpected query");
          return {
            rows: [{
              systemIdentifier: "1", databaseOid: "2", databaseName: "pintpath",
              serverVersionNum: "170006", roleName: "privileged_backup", canLogin: true,
              superuser: true, createDatabase: false, createRole: false,
              replication: false, bypassRls: false, canSetMigrator: true,
              transactionReadOnly: false, inRecovery: false,
            } as unknown as Row],
            rowCount: 1,
          };
        },
        close: async () => { closed = true; },
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(closed).toBe(true);
    expect(fs.existsSync(path.join(root, "unsafe-role"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it.each([
    ["an unversioned login", { roleName: "backup_user" }],
    ["a login bound to another database OID", {
      roleName: "pintpath_logical_backup_d16656_v1",
    }],
    ["a mismatched derived backup role", {
      backupRoleName: "pintpath_logical_backup_d16656",
    }],
    ["an inheriting login", { inheritsPrivileges: true }],
    ["an unbounded connection limit", { connectionLimit: -1 }],
    ["a VALID UNTIL boundary", { validUntilIsNull: false }],
    ["a second membership", { membershipCount: 2 }],
    ["a child membership", { childMembershipCount: 1 }],
    ["an inherited backup membership", { hasExactLogicalBackupMembership: false }],
    ["missing SET authority for the backup group", { canSetLogicalBackup: false }],
    ["migrator SET authority", { canSetMigrator: true }],
    ["runtime SET authority", { canSetRuntime: true }],
    ["sibling scoped-role SET authority", { canSetSiblingLogicalBackup: true }],
    ["grantable or extra database authority", { directDatabasePrivilegeCount: 2 }],
    ["missing direct database CONNECT", { hasDirectDatabaseConnect: false }],
    ["extra function authority", { directFunctionPrivilegeCount: 2 }],
    ["missing direct control-system EXECUTE", { hasDirectControlSystemExecute: false }],
    ["a direct private-object grant", { directPrivateObjectPrivilegeCount: 1 }],
    ["a privately owned object", { ownedPrivateObjectCount: 1 }],
    ["a role setting", { roleSettingCount: 1 }],
    ["an extra shared dependency", { sharedDependencyCount: 3 }],
    ["a wrong shared dependency", { exactSharedDependencyCount: 1 }],
  ])("rejects %s before creating an archive", async (_description, override) => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-login-contract"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await delegate.query<Row>(text, values);
          if (!text.includes("source-identity")) return result;
          return {
            ...result,
            rows: result.rows.map((row) => ({ ...row, ...override } as Row)),
          };
        },
        close: async () => delegate.close(),
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(fs.existsSync(path.join(root, "unsafe-login-contract"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it.each([
    ["a parent membership", { membershipCount: 1 }],
    ["a second child", { childMembershipCount: 2 }],
    ["a non-session child", { exactSessionLoginChildCount: 0 }],
    ["a direct database ACL", { directDatabasePrivilegeCount: 1 }],
    ["a direct function ACL", { directFunctionPrivilegeCount: 1 }],
    ["a role setting", { roleSettingCount: 1 }],
    ["current-database ownership", { ownedCurrentDatabaseObjectCount: 1 }],
    ["an unexpected shared dependency", { sharedDependencyCount: 62 }],
    ["a non-allowlisted shared dependency", { exactSharedDependencyCount: 60 }],
    ["an extra schema ACL", { directSchemaPrivilegeCount: 3 }],
    ["a missing private schema", { privateSchemaCount: 1 }],
    ["an unsafe schema ACL", { selectOnlySchemaCount: 1 }],
    ["a write-capable table grant", { selectOnlyRelationCount: 58 }],
    ["an extra relation ACL", { directRelationPrivilegeCount: 60 }],
    ["a missing private relation", { privateRelationCount: 58 }],
    ["a table without forced RLS", { forceRlsRelationCount: 58 }],
    ["an unexpected sequence", { privateSequenceCount: 1, selectOnlySequenceCount: 1 }],
    ["a private function grant", { executablePrivateFunctionCount: 1 }],
    ["a direct column grant", { directColumnPrivilegeCount: 1 }],
    ["an extra arbitrary named-role policy", { privatePolicyCount: 237 }],
    ["a malformed canonical base policy", { exactBasePolicyCount: 176 }],
    ["a missing RLS policy", { publicPrivatePolicyCount: 58 }],
    ["a malformed backup RLS policy", { exactLogicalBackupSelectPolicyCount: 58 }],
    ["an unsafe PUBLIC policy", { unsafePublicPrivatePolicyCount: 1 }],
    ["an unsafe reserved policy name", { unsafeReservedPolicyNameCount: 1 }],
    ["a policy naming the scoped role", { directScopedPolicyCount: 1 }],
  ])("rejects the effective backup group with %s", async (_description, override) => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-group-contract"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await delegate.query<Row>(text, values);
          if (!text.includes("effective-role")) return result;
          return {
            ...result,
            rows: result.rows.map((row) => ({ ...row, ...override } as Row)),
          };
        },
        close: async () => delegate.close(),
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(fs.existsSync(path.join(root, "unsafe-group-contract"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it("rolls back, resets the role, closes, and removes artifacts on state failure", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    const queries: string[] = [];
    let closed = false;
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "state-failure"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          queries.push(text);
          return delegate.query<Row>(text, values);
        },
        close: async () => { closed = true; },
      }),
      computeState: async () => { throw new Error(`raw state failure ${directTlsUrl}`); },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_contract_invalid");
    expect(queries.some((query) => query.includes("rollback-snapshot"))).toBe(true);
    expect(queries.some((query) => query.includes("reset-role"))).toBe(true);
    expect(closed).toBe(true);
    expect(fs.existsSync(path.join(root, "state-failure"))).toBe(false);
  });

  it("detects a connection-file identity change before pg_dump", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const harness = createProcessHarness();
    const base = dependencies(harness.runner);
    const error = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "connection-swap"),
    }, {
      ...base,
      computeState: async () => {
        fs.writeFileSync(
          connectionFile,
          "postgresql://other:replacement@other.invalid/db?sslmode=require\n",
          { mode: 0o600 },
        );
        fs.chmodSync(connectionFile, 0o600);
        return fakeStateInventory();
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_connection_file");
    expect(fs.existsSync(path.join(root, "connection-swap"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it("emits one canonical, secret-free JSON failure from the CLI", async () => {
    const output: string[] = [];
    const cliDependencies: Partial<PostgresLogicalBackupCliDependencies> = {
      createBackup: async () => {
        throw new Error(`raw child error exposed ${directTlsUrl}`);
      },
      writeOutput: (value) => output.push(value),
    };

    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
    expect(output[0]).not.toContain(connectionSecret);
    expect(output[0]).not.toContain(sourceHostname);
    expect(output[0]).not.toContain("backup_user");
  });

  it("emits only hashes, not local paths, after a successful CLI backup", async () => {
    const output: string[] = [];
    let receivedOptions:
      | Parameters<PostgresLogicalBackupCliDependencies["createBackup"]>[0]
      | null = null;
    const cliDependencies: Partial<PostgresLogicalBackupCliDependencies> = {
      createBackup: async (options) => {
        receivedOptions = options;
        return {
          schemaVersion: 3,
          ok: true,
          outputDirectory: "/Users/operator/private/release-id/postgres-logical",
          archivePath: "/Users/operator/private/release-id/postgres-logical/pintpath-postgres.dump",
          manifestPath: "/Users/operator/private/release-id/postgres-logical/manifest.json",
          stateReceiptPath:
            "/Users/operator/private/release-id/postgres-logical/state-receipt.json",
          archiveSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          stateReceiptSha256: "c".repeat(64),
          authoritativeRowCount: "42",
          overallStateSha256: "d".repeat(64),
        };
      },
      writeOutput: (value) => output.push(value),
    };

    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      connectionFile: "/private/connection-file",
      expectedSourceUrlSha256: "e".repeat(64),
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: "/private/railway-root-ca.pem",
      expectedRootCaDerSha256: testRootCaDerSha256,
      outputDirectory: "/private/output",
    });
    expect(output).toEqual([
      `{"archiveSha256":"${"a".repeat(64)}","authoritativeRowCount":"42","manifestSha256":"${"b".repeat(64)}","ok":true,"overallStateSha256":"${"d".repeat(64)}","schemaVersion":3,"stateReceiptSha256":"${"c".repeat(64)}"}\n`,
    ]);
    expect(output[0]).not.toContain("/Users/operator");
    expect(output[0]).not.toContain("release-id");
  });

  it.each([
    "--expected-source-url-sha256",
    "--transport-profile",
    "--root-ca-file",
    "--expected-root-ca-der-sha256",
  ])("requires the %s CLI flag before invoking the backup", async (missingFlag) => {
    const output: string[] = [];
    let invoked = false;
    const completeArguments = [
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--output", "/private/output",
    ];
    const missingIndex = completeArguments.indexOf(missingFlag);
    completeArguments.splice(missingIndex, 2);
    const exitCode = await runPostgresLogicalBackupCli(completeArguments, {
      createBackup: async () => {
        invoked = true;
        throw new Error("must not run");
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(invoked).toBe(false);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
  });

  it("rejects a non-exact transport profile in the CLI before invoking backup", async () => {
    let invoked = false;
    const output: string[] = [];
    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", "railway-stock-localhost-ca-v2",
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--output", "/private/output",
    ], {
      createBackup: async () => {
        invoked = true;
        throw new Error("must not run");
      },
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(invoked).toBe(false);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
  });
});
