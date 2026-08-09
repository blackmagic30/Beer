import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
const directTlsUrl = `postgresql://backup_user:${connectionSecret}@db.example.invalid:5432/pintpath?sslmode=verify-full`;

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
}

function createProcessHarness(options: ProcessHarnessOptions = {}) {
  const invocations: ProcessInvocation[] = [];
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
  return { invocations, runner };
}

function dependencies(
  runner: PostgresLogicalBackupDependencies["runProcess"],
): Partial<PostgresLogicalBackupDependencies> {
  const connection = {
    query: async <Row extends Record<string, unknown>>(text: string) => {
      if (text.includes("source-identity")) return {
        rows: [{
          systemIdentifier: "7568999345281279000",
          databaseOid: "16655",
          databaseName: "pintpath",
          serverVersionNum: "170006",
          roleName: "backup_user",
          canLogin: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          canSetMigrator: true,
          transactionReadOnly: false,
          inRecovery: false,
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("effective-role")) return {
        rows: [{
          effectiveRole: "pintpath_migrator",
          sessionRole: "backup_user",
          transactionIsolation: "repeatable read",
          transactionReadOnly: true,
          canLogin: false,
          inheritsPrivileges: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
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
      { connectionFile, outputDirectory },
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
    const receiptBytes = fs.readFileSync(result.stateReceiptPath, "utf8");
    expect(sha256(receiptBytes)).toBe(result.stateReceiptSha256);
    expect(receiptBytes).not.toContain(connectionSecret);
    expect(receiptBytes).not.toContain("db.example.invalid");
    expect(receiptBytes).not.toContain("backup_user");
  });

  it("passes credentials only through a scoped pg_dump environment", async () => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();
    const result = await createPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      outputDirectory: path.join(root, "backup"),
    }, dependencies(harness.runner));

    const dump = harness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    const restoreList = harness.invocations.find((invocation) => invocation.args.includes("--list"))!;
    const versionInvocations = harness.invocations.filter((invocation) => invocation.args[0] === "--version");
    expect(dump.args).toEqual([
      "--format=custom",
      `--file=${result.archivePath}`,
      "--snapshot=00000003-0000001B-1",
      "--role=pintpath_migrator",
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
      PGUSER: "backup_user",
      PGPASSWORD: connectionSecret,
      PGSSLMODE: "verify-full",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
    });
    expect(dump.env.DATABASE_URL).toBeUndefined();
    expect(dump.env.PGOPTIONS).toBeUndefined();
    expect(dump.env.PGPASSFILE).toBeUndefined();
    expect(dump.env.PGSERVICEFILE).toBeUndefined();
    expect(dump.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(dump.env.PGPASSWORD).not.toBe("inherited-password-must-not-leak");
    expect(restoreList.args).toEqual(["--list", "--format=custom", result.archivePath]);
    expect(restoreList.env.PGPASSWORD).toBeUndefined();
    expect(restoreList.env.DATABASE_URL).toBeUndefined();
    expect(versionInvocations).toHaveLength(2);
    expect(versionInvocations.every((invocation) => invocation.env.PGPASSWORD === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => invocation.env.DATABASE_URL === undefined)).toBe(true);
  });

  it.each([
    "not-a-url",
    "https://backup_user:secret@db.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/pintpath",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=disable",
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
  ])("rejects an unsafe or pooled connection before invoking tools: %s", async (url) => {
    const root = makeTemporaryDirectory();
    const harness = createProcessHarness();

    const error = await createPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
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
      outputDirectory: path.join(root, "backup-mode"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(worldReadableError, "unsafe_connection_file");

    fs.rmSync(worldReadable);
    const target = writeConnectionFile(root);
    const symbolicLink = path.join(root, "postgres-url-link");
    fs.symlinkSync(target, symbolicLink);
    const symbolicLinkError = await createPostgresLogicalBackup({
      connectionFile: symbolicLink,
      outputDirectory: path.join(root, "backup-link"),
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);
    expectBackupError(symbolicLinkError, "unsafe_connection_file");

    const uid = process.getuid?.() ?? 0;
    const wrongOwnerError = await createPostgresLogicalBackup({
      connectionFile: target,
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
      outputDirectory,
    }, dependencies(harness.runner)).catch((caught: unknown) => caught);

    expectBackupError(error, "dump_failed");
    expect(fs.existsSync(outputDirectory)).toBe(false);
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
    const cliDependencies: Partial<PostgresLogicalBackupCliDependencies> = {
      createBackup: async () => ({
        schemaVersion: 2,
        ok: true,
        outputDirectory: "/Users/operator/private/release-id/postgres-logical",
        archivePath: "/Users/operator/private/release-id/postgres-logical/pintpath-postgres.dump",
        manifestPath: "/Users/operator/private/release-id/postgres-logical/manifest.json",
        stateReceiptPath: "/Users/operator/private/release-id/postgres-logical/state-receipt.json",
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        stateReceiptSha256: "c".repeat(64),
        authoritativeRowCount: "42",
        overallStateSha256: "d".repeat(64),
      }),
      writeOutput: (value) => output.push(value),
    };

    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      `{"archiveSha256":"${"a".repeat(64)}","authoritativeRowCount":"42","manifestSha256":"${"b".repeat(64)}","ok":true,"overallStateSha256":"${"d".repeat(64)}","schemaVersion":2,"stateReceiptSha256":"${"c".repeat(64)}"}\n`,
    ]);
    expect(output[0]).not.toContain("/Users/operator");
    expect(output[0]).not.toContain("release-id");
  });
});
