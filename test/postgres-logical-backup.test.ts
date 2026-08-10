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
  type PostgresLogicalBackupDependencies,
  type PostgresLogicalBackupManifest,
  type ProcessInvocation,
  type ProcessResult,
} from "../src/lib/postgres-logical-backup.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import type { PostgresLogicalStateInventory } from "../src/lib/postgres-logical-state.js";

const temporaryDirectories: string[] = [];
const connectionSecret = "logical-backup-secret";
const backupDatabaseOid = "16655";
const backupRole = `pintpath_logical_backup_d${backupDatabaseOid}`;
const backupLogin = `${backupRole}_v20260808`;
const directTlsUrl = `postgresql://${backupLogin}:${connectionSecret}@db.example.invalid:5432/pintpath?sslmode=verify-full`;

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-postgres-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConnectionFile(root: string, value = directTlsUrl, mode = 0o600): string {
  const filePath = path.join(root, "postgres-url");
  fs.writeFileSync(filePath, `${value}\n`, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function pgpassTemporaryEntries(): string[] {
  return fs.readdirSync(fs.realpathSync(os.tmpdir()))
    .filter((entry) => entry.startsWith("pintpath-logical-backup-pgpass-"))
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
      const name = invocation.command.includes("restore") ? "pg_restore" : "pg_dump";
      const version = name === "pg_restore"
        ? options.pgRestoreVersion ?? "17.10 (Homebrew)"
        : options.pgDumpVersion ?? "17.10 (Homebrew)";
      return { exitCode: 0, stdout: `${name} (PostgreSQL) ${version}\n`, stderr: "" };
    }
    if (invocation.command.includes("dump")) {
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
    close: async () => undefined,
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
    connect: async () => connection,
    computeState: async () => fakeStateInventory(),
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

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectBackupError(error: unknown, code: PostgresLogicalBackupError["code"]): void {
  expect(error).toBeInstanceOf(PostgresLogicalBackupError);
  expect((error as PostgresLogicalBackupError).code).toBe(code);
  expect(String((error as Error).message)).toBe(code);
  expect(String((error as Error).message)).not.toContain(connectionSecret);
  expect(String((error as Error).message)).not.toContain("db.example.invalid");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres logical backup foundation", () => {
  it("creates and validates a private custom archive with a canonical SHA manifest", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "logical-backup");
    const canonicalOutputDirectory = path.join(fs.realpathSync(root), "logical-backup");
    const harness = createProcessHarness();

    const result = await createPostgresLogicalBackup(
      {
        connectionFile,
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      },
      dependencies(harness.runner),
    );

    expect(result).toEqual({
      schemaVersion: 2,
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
      schemaVersion: 2,
      kind: "pintpath-postgres-logical-backup",
      createdAt: "2026-08-08T01:02:03.000Z",
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
    expect(manifestBytes).not.toContain("db.example.invalid");
    expect(manifestBytes).not.toContain("backup_user");
    expect(manifestBytes).not.toContain(backupLogin);
    const receiptBytes = fs.readFileSync(result.stateReceiptPath, "utf8");
    expect(sha256(receiptBytes)).toBe(result.stateReceiptSha256);
    expect(receiptBytes).not.toContain(connectionSecret);
    expect(receiptBytes).not.toContain("db.example.invalid");
    expect(receiptBytes).not.toContain("backup_user");
    expect(receiptBytes).not.toContain(backupLogin);
  });

  it("passes credentials only through a scoped pg_dump environment", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const queries: string[] = [];
    const result = await createPostgresLogicalBackup({
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
    expect(JSON.stringify(dump.args)).not.toContain("db.example.invalid");
    expect(JSON.stringify(dump.args)).not.toContain("backup_user");
    expect(dump.env).toMatchObject({
      PATH: "/safe/bin",
      LC_ALL: "C",
      PGHOST: "db.example.invalid",
      PGPORT: "5432",
      PGDATABASE: "pintpath",
      PGUSER: backupLogin,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
    });
    expect(dump.env.DATABASE_URL).toBeUndefined();
    expect(dump.env.PGOPTIONS).toBeUndefined();
    expect(dump.env.PGPASSFILE).toMatch(
      /\/pintpath-logical-backup-pgpass-[^/]+\/pgpass$/,
    );
    expect(dump.env.PGSERVICEFILE).toBeUndefined();
    expect(dump.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(dump.env.PGPASSWORD).toBeUndefined();
    expect(harness.pgpassObservations).toEqual([{
      path: dump.env.PGPASSFILE,
      contents: `db.example.invalid:5432:pintpath:${backupLogin}:${connectionSecret}\n`,
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

    const mismatch = await createPostgresLogicalBackup({
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
      const malformed = await createPostgresLogicalBackup({
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

    await createPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "trimmed-url"),
    }, dependencies(harness.runner));

    expect(harness.invocations.some((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))).toBe(true);
  });

  it("uses verify-full with the system root store and keeps the loopback disable seam test-only", async () => {
    const root = makeTemporaryDirectory();
    const strictHarness = createProcessHarness();
    const strictBase = dependencies(strictHarness.runner);
    const strictDelegate = await strictBase.connect!({} as never);
    let strictConfig: Parameters<NonNullable<PostgresLogicalBackupDependencies["connect"]>>[0] | null = null;
    await createPostgresLogicalBackup({
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
    expect(strictConfig?.ssl).toEqual({ rejectUnauthorized: true });
    const strictDump = strictHarness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(strictDump.env).toMatchObject({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
    });

    const loopbackUrl = `postgresql://${backupLogin}:${connectionSecret}@127.0.0.1:5432/pintpath?sslmode=disable`;
    const loopbackHarness = createProcessHarness();
    const loopbackBase = dependencies(loopbackHarness.runner);
    const loopbackDelegate = await loopbackBase.connect!({} as never);
    let loopbackConfig: Parameters<NonNullable<PostgresLogicalBackupDependencies["connect"]>>[0] | null = null;
    await createPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, loopbackUrl),
      expectedSourceUrlSha256: sha256(loopbackUrl),
      outputDirectory: path.join(root, "loopback-test-seam"),
    }, {
      ...loopbackBase,
      env: { ...loopbackBase.env, NODE_ENV: "test" },
      allowInsecureLoopbackForTests: true,
      connect: async (config) => {
        loopbackConfig = config;
        return loopbackDelegate;
      },
    });
    expect(loopbackConfig?.ssl).toBe(false);
    const loopbackDump = loopbackHarness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(loopbackDump.env.PGSSLMODE).toBe("disable");
    expect(loopbackDump.env.PGSSLROOTCERT).toBeUndefined();
  });

  it("escapes IPv6, database, and password pgpass fields without exposing the secret in argv", async () => {
    const root = makeTemporaryDirectory();
    const database = "pint:path";
    const password = "secret:with\\backslash";
    const url = `postgresql://${backupLogin}:${encodeURIComponent(password)}@[::1]:5432/${encodeURIComponent(database)}?sslmode=verify-full`;
    const harness = createProcessHarness();

    await createPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
      expectedSourceUrlSha256: sha256(url),
      outputDirectory: path.join(root, "escaped-pgpass"),
    }, dependencies(harness.runner));

    expect(harness.pgpassObservations[0]?.contents).toBe(
      `\\:\\:1:5432:pint\\:path:${backupLogin}:secret\\:with\\\\backslash\n`,
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

    const error = await createPostgresLogicalBackup({
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
    const worldReadableError = await createPostgresLogicalBackup({
      connectionFile: worldReadable,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-mode"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(worldReadableError, "unsafe_connection_file");

    fs.rmSync(worldReadable);
    const target = writeConnectionFile(root);
    const symbolicLink = path.join(root, "postgres-url-link");
    fs.symlinkSync(target, symbolicLink);
    const symbolicLinkError = await createPostgresLogicalBackup({
      connectionFile: symbolicLink,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-link"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(symbolicLinkError, "unsafe_connection_file");

    const uid = process.getuid?.() ?? 0;
    const wrongOwnerError = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

      const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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
      error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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

    const error = await createPostgresLogicalBackup({
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
    const error = await createPostgresLogicalBackup({
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
    const error = await createPostgresLogicalBackup({
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
    const error = await createPostgresLogicalBackup({
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
    const error = await createPostgresLogicalBackup({
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
    const error = await createPostgresLogicalBackup({
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
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
    expect(output[0]).not.toContain(connectionSecret);
    expect(output[0]).not.toContain("db.example.invalid");
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
          schemaVersion: 2,
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
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      connectionFile: "/private/connection-file",
      expectedSourceUrlSha256: "e".repeat(64),
      outputDirectory: "/private/output",
    });
    expect(output).toEqual([
      `{"archiveSha256":"${"a".repeat(64)}","authoritativeRowCount":"42","manifestSha256":"${"b".repeat(64)}","ok":true,"overallStateSha256":"${"d".repeat(64)}","schemaVersion":2,"stateReceiptSha256":"${"c".repeat(64)}"}\n`,
    ]);
    expect(output[0]).not.toContain("/Users/operator");
    expect(output[0]).not.toContain("release-id");
  });

  it("requires the expected source URL hash CLI flag before invoking the backup", async () => {
    const output: string[] = [];
    let invoked = false;
    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
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
