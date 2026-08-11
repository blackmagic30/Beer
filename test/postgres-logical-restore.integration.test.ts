import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import {
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  createPostgresLogicalBackup,
  runPostgresBackupProcess,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
  inspectPostgresLogicalRestoreTarget,
  restorePostgresLogicalBackup,
} from "../src/lib/postgres-logical-restore.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  openPostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_REQUIRED";
const ROOT_CA_FILE_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_ROOT_CA_FILE";
const ROOT_CA_DER_SHA256_ENV =
  "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_ROOT_CA_DER_SHA256";
const RESOLVED_ADDRESS_ENV =
  "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_RESOLVED_ADDRESS";
const PG_DUMP_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_DUMP";
const PG_RESTORE_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_RESTORE";
const CONFIGURATION_ERROR = "invalid_postgres_logical_restore_test_configuration";
const BACKUP_SOURCE_HOSTNAME = "pintpath-logical-restore.railway.internal";
const EXPECTED_POSTGRES_TOOL_VERSION = "17.10 (Ubuntu 17.10-1.pgdg24.04+1)";
const UNIQUE_SUFFIX = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const SOURCE_DATABASE = `pintpath_lr_source_${UNIQUE_SUFFIX}`;
const SIBLING_DATABASE = `pintpath_lr_sibling_${UNIQUE_SUFFIX}`;
const TARGET_DATABASE = `pintpath_lr_target_${UNIQUE_SUFFIX}`;
const NON_SUPERUSER_DATABASE = `pintpath_lr_policy_only_${UNIQUE_SUFFIX}`;
const NON_SUPERUSER_ROLE = `pintpath_lr_creator_${UNIQUE_SUFFIX}`;
const AUTO_MEMBERSHIP_PROBE_ROLE = `pintpath_lr_auto_edge_${UNIQUE_SUFFIX}`;
const BACKUP_VERSION = `${Date.now()}${process.pid}`.slice(0, 20);
const BACKUP_PASSWORD = `PintpathLogicalReceipt_${UNIQUE_SUFFIX}`;
const SCHEMA_PATH = path.resolve("src/db/postgres-schema.sql");
const FORWARD_MIGRATION_PATH = path.resolve(
  "supabase/migrations/20260810003612_add_pintpath_logical_backup_role.sql",
);
const LOGICAL_BACKUP_POLICY_EXPRESSION = `(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))`;

interface LogicalRestoreTestConfiguration {
  readonly adminUrl: string;
  readonly rootCaFile: string;
  readonly rootCaDerSha256: string;
  readonly resolvedAddress: string;
  readonly pgDumpCommand: string;
  readonly pgRestoreCommand: string;
}

function configurationError(): Error {
  return new Error(CONFIGURATION_ERROR);
}

function readExactEnvironment(name: string): string {
  const value = process.env[name];
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\0")
  ) throw configurationError();
  return value;
}

function validateExactFilePath(
  value: string,
  expectedBasename: string | null,
  kind: "root-ca" | "postgres-tool",
): string {
  if (
    !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
    || (expectedBasename !== null && path.basename(value) !== expectedBasename)
  ) throw configurationError();
  try {
    const stat = fs.lstatSync(value);
    const currentUid = process.getuid?.();
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || fs.realpathSync(value) !== value
      || !Number.isInteger(currentUid)
    ) throw configurationError();
    if (kind === "root-ca") {
      if (
        stat.uid !== currentUid
        || (stat.mode & 0o7777) !== 0o600
        || stat.size < 1
        || stat.size > 64 * 1024
      ) throw configurationError();
    } else if (
      (stat.uid !== 0 && stat.uid !== currentUid)
      || (stat.mode & 0o111) === 0
      || (stat.mode & 0o022) !== 0
      || (stat.mode & 0o6000) !== 0
    ) throw configurationError();
    if (kind === "postgres-tool") fs.accessSync(value, fs.constants.X_OK);
  } catch {
    throw configurationError();
  }
  return value;
}

function validateCanonicalFd12Address(value: string): string {
  if (value !== value.toLowerCase() || value.includes("%") || net.isIPv6(value) !== true) {
    throw configurationError();
  }
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    if (
      !hostname.startsWith("[")
      || !hostname.endsWith("]")
      || hostname.slice(1, -1) !== value
      || value.split(":", 1)[0] !== "fd12"
    ) throw configurationError();
  } catch {
    throw configurationError();
  }
  return value;
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a loopback PostgreSQL admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
  ) throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback maintenance database.`);
  return url;
}

function readTestConfiguration(): LogicalRestoreTestConfiguration | null {
  const required = process.env[REQUIRED_ENV] ?? "";
  if (required !== "" && required !== "true") throw configurationError();
  const adminUrl = process.env[ADMIN_URL_ENV] ?? "";
  const fixtureNames = [
    ROOT_CA_FILE_ENV,
    ROOT_CA_DER_SHA256_ENV,
    RESOLVED_ADDRESS_ENV,
    PG_DUMP_ENV,
    PG_RESTORE_ENV,
  ] as const;
  const fixtureConfigured = fixtureNames.some((name) => (process.env[name] ?? "") !== "");
  if (required === "" && adminUrl === "" && !fixtureConfigured) return null;
  if (!adminUrl || (required === "true" && !fixtureConfigured)) throw configurationError();
  try {
    validateAdminUrl(readExactEnvironment(ADMIN_URL_ENV));
  } catch {
    throw configurationError();
  }
  const rootCaFile = validateExactFilePath(
    readExactEnvironment(ROOT_CA_FILE_ENV), null, "root-ca",
  );
  const rootCaDerSha256 = readExactEnvironment(ROOT_CA_DER_SHA256_ENV);
  if (!/^[a-f0-9]{64}$/.test(rootCaDerSha256)) throw configurationError();
  const pgDumpCommand = validateExactFilePath(
    readExactEnvironment(PG_DUMP_ENV),
    "pg_dump",
    "postgres-tool",
  );
  const pgRestoreCommand = validateExactFilePath(
    readExactEnvironment(PG_RESTORE_ENV),
    "pg_restore",
    "postgres-tool",
  );
  if (path.dirname(pgDumpCommand) !== path.dirname(pgRestoreCommand)) {
    throw configurationError();
  }
  return Object.freeze({
    adminUrl,
    rootCaFile,
    rootCaDerSha256,
    resolvedAddress: validateCanonicalFd12Address(
      readExactEnvironment(RESOLVED_ADDRESS_ENV),
    ),
    pgDumpCommand,
    pgRestoreCommand,
  });
}

const testConfiguration = readTestConfiguration();
const configuredAdminUrl = testConfiguration?.adminUrl ?? "";

function activeTestConfiguration(): LogicalRestoreTestConfiguration {
  if (!testConfiguration) throw configurationError();
  return testConfiguration;
}

function withDatabase(url: URL, database: string): URL {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result;
}

function withCredentials(url: URL, username: string, password: string): URL {
  const result = new URL(url.toString());
  result.username = username;
  result.password = password;
  return result;
}

function asRailwayBackupSourceUrl(loopbackUrl: URL): URL {
  const result = new URL(loopbackUrl.toString());
  result.hostname = BACKUP_SOURCE_HOSTNAME;
  result.port = "5432";
  result.search = "";
  result.searchParams.set("sslmode", "verify-full");
  return result;
}

function escapePgpassField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function expectedPgpassRecord(url: URL): string {
  return `${[
    "localhost",
    url.port || "5432",
    decodeURIComponent(url.pathname.slice(1)),
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ].map(escapePgpassField).join(":")}\n`;
}

function scopedBackupRole(databaseOid: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) throw new Error("invalid_test_database_oid");
  const value = BigInt(databaseOid);
  if (value > 4_294_967_295n) throw new Error("invalid_test_database_oid");
  return `pintpath_logical_backup_d${databaseOid}`;
}

async function currentDatabaseOid(connection: Client): Promise<string> {
  const result = await connection.query<{ oid: string }>(`SELECT database.oid::text AS oid
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = pg_catalog.current_database()`);
  const oid = result.rows[0]?.oid;
  if (result.rows.length !== 1 || !oid) throw new Error("test_database_oid_unavailable");
  return oid;
}

async function expectSqlState(
  connection: Client,
  sql: string,
  code = "42501",
): Promise<void> {
  const error = await connection.query(sql).catch((value: unknown) => value as { code?: string });
  expect(error).toMatchObject({ code });
}

async function createLogicalBackup(
  sourceUrl: URL,
  sourceAdminUrl: URL,
  root: string,
): Promise<{
  directory: string;
  manifestSha256: string;
  processObservations: readonly string[];
}> {
  const configuration = activeTestConfiguration();
  const directory = path.join(root, "backup");
  const archivePath = path.join(directory, POSTGRES_LOGICAL_BACKUP_ARCHIVE);
  const sourceUrlFile = path.join(root, "source-url");
  fs.writeFileSync(sourceUrlFile, `${sourceUrl.toString()}\n`, { mode: 0o600 });
  fs.chmodSync(sourceUrlFile, 0o600);
  let concurrentWriteCommitted = false;
  let pgpassPath = "";
  let transportDirectory = "";
  let transportRootCaFile = "";
  let dumpArchiveFileDescriptor: number | undefined;
  let listingArchiveFileDescriptor: number | undefined;
  let dumpArchiveIdentity: { dev: number; ino: number } | undefined;
  const processObservationState = {
    pgDumpVersion: null as string | null,
    pgRestoreVersion: null as string | null,
    pgDump: null as string | null,
    pgRestoreList: null as string | null,
  };

  const recordProcessObservation = (
    phase: keyof typeof processObservationState,
    observation: string,
  ): void => {
    if (processObservationState[phase] !== null) {
      throw new Error("duplicate_backup_process_integration_invocation");
    }
    processObservationState[phase] = observation;
  };

  const inspectArchiveDescriptor = (
    value: number | undefined,
    expectedSize: "empty" | "non-empty",
  ): fs.Stats => {
    if (
      value === undefined
      || !Number.isSafeInteger(value)
      || value < 0
      || value > 0x7fff_ffff
    ) throw new Error("invalid_backup_archive_file_descriptor");
    const descriptorStat = fs.fstatSync(value);
    const currentUid = process.getuid?.();
    if (!Number.isInteger(currentUid)) throw configurationError();
    expect(descriptorStat.isFile()).toBe(true);
    expect({
      mode: descriptorStat.mode & 0o7777,
      nlink: descriptorStat.nlink,
      uid: descriptorStat.uid,
    }).toEqual({ mode: 0o600, nlink: 1, uid: currentUid });
    if (expectedSize === "empty") {
      expect(descriptorStat.size).toBe(0);
    } else {
      expect(descriptorStat.size).toBeGreaterThan(0);
    }
    return descriptorStat;
  };
  try {
    const result = await createPostgresLogicalBackup({
      connectionFile: sourceUrlFile,
      expectedSourceUrlSha256: crypto.createHash("sha256")
        .update(sourceUrl.toString(), "utf8").digest("hex"),
      outputDirectory: directory,
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: configuration.rootCaFile,
      expectedRootCaDerSha256: configuration.rootCaDerSha256,
    }, {
      env: { ...process.env, NODE_ENV: "test" },
      pgDumpCommand: configuration.pgDumpCommand,
      pgRestoreCommand: configuration.pgRestoreCommand,
      openTransport: async (options) => {
        if (
          options.sourceUrlAuthority.hostname !== BACKUP_SOURCE_HOSTNAME
          || options.sourceUrlAuthority.port !== 5_432
        ) throw configurationError();
        const transport = await openPostgresRailwayStockLocalhostCaTransport(options, {
          resolve6: async (hostname, signal) => {
            if (hostname !== BACKUP_SOURCE_HOSTNAME || signal.aborted) {
              throw configurationError();
            }
            return Object.freeze([configuration.resolvedAddress]);
          },
        });
        transportDirectory = transport.temporaryDirectory;
        transportRootCaFile = transport.libpqEnvironment.PGSSLROOTCERT;
        try {
          if (
            transport.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
            || transport.rootCaDerSha256 !== configuration.rootCaDerSha256
            || transport.resolvedAddress !== configuration.resolvedAddress
            || transport.sourceUrlAuthority.hostname !== BACKUP_SOURCE_HOSTNAME
            || transport.sourceUrlAuthority.port !== 5_432
            || transport.passwordFileHost !== "localhost"
            || transportRootCaFile === configuration.rootCaFile
            || path.dirname(transportRootCaFile) !== transportDirectory
            || (fs.statSync(transportRootCaFile).mode & 0o7777) !== 0o600
            || !fs.readFileSync(transportRootCaFile).equals(
              fs.readFileSync(configuration.rootCaFile),
            )
          ) throw new Error("invalid_backup_transport_contract");
        } catch {
          await transport.close().catch(() => undefined);
          throw new Error("invalid_backup_transport_contract");
        }
        return transport;
      },
      runProcess: async (invocation) => {
        if (
          invocation.command !== configuration.pgDumpCommand
          && invocation.command !== configuration.pgRestoreCommand
        ) throw configurationError();

        const isPgDumpVersion = invocation.command === configuration.pgDumpCommand
          && invocation.args.length === 1
          && invocation.args[0] === "--version";
        const isPgRestoreVersion = invocation.command === configuration.pgRestoreCommand
          && invocation.args.length === 1
          && invocation.args[0] === "--version";
        const isPgDump = invocation.command === configuration.pgDumpCommand
          && invocation.args[0] !== "--version";
        const isPgRestoreList = invocation.command === configuration.pgRestoreCommand
          && invocation.args.length === 2
          && invocation.args[0] === "--list"
          && invocation.args[1] === "--format=custom";
        if (
          Number(isPgDumpVersion)
            + Number(isPgRestoreVersion)
            + Number(isPgDump)
            + Number(isPgRestoreList)
          !== 1
        ) throw new Error("unexpected_backup_process_integration_invocation");

        if (
          isPgDumpVersion
          || isPgRestoreVersion
          || invocation.command === configuration.pgRestoreCommand
        ) {
          expect(invocation.env.PGPASSFILE).toBeUndefined();
          if (invocation.env.PGPASSWORD !== undefined) {
            throw new Error("unsafe_backup_process_environment");
          }
          for (const name of [
            "PGHOST",
            "PGHOSTADDR",
            "PGPORT",
            "PGSSLMODE",
            "PGSSLROOTCERT",
            "PGSSLMINPROTOCOLVERSION",
            "PGSSLSNI",
          ]) expect(invocation.env[name]).toBeUndefined();
          if (invocation.command === configuration.pgRestoreCommand && pgpassPath) {
            expect(fs.existsSync(pgpassPath)).toBe(false);
          }
        }

        if (isPgDumpVersion || isPgRestoreVersion) {
          expect(invocation.stdinFileDescriptor).toBeUndefined();
          expect(invocation.stdoutFileDescriptor).toBeUndefined();
          const result = await runPostgresBackupProcess(invocation);
          recordProcessObservation(
            isPgDumpVersion ? "pgDumpVersion" : "pgRestoreVersion",
            `${isPgDumpVersion ? "pg-dump" : "pg-restore"}-version:no-stdin-or-stdout:${result.exitCode}`,
          );
          return result;
        }

        if (
          !concurrentWriteCommitted
          && isPgDump
        ) {
          pgpassPath = invocation.env.PGPASSFILE ?? "";
          expect(pgpassPath).not.toBe("");
          if (invocation.env.PGPASSWORD !== undefined) {
            throw new Error("unsafe_backup_process_environment");
          }
          expect(invocation.env).toMatchObject({
            PGHOST: "localhost",
            PGHOSTADDR: configuration.resolvedAddress,
            PGPORT: "5432",
            PGSSLMODE: "verify-full",
            PGSSLROOTCERT: transportRootCaFile,
            PGSSLMINPROTOCOLVERSION: "TLSv1.2",
            PGSSLSNI: "1",
            PGDATABASE: SOURCE_DATABASE,
            PGUSER: decodeURIComponent(sourceUrl.username),
            PGGSSENCMODE: "disable",
          });
          expect(fs.statSync(pgpassPath).mode & 0o7777).toBe(0o600);
          expect(fs.statSync(path.dirname(pgpassPath)).mode & 0o7777).toBe(0o700);
          expect(path.dirname(pgpassPath)).toBe(transportDirectory);
          const actualPgpass = fs.readFileSync(pgpassPath);
          const expectedPgpass = Buffer.from(expectedPgpassRecord(sourceUrl), "utf8");
          const pgpassMatches = actualPgpass.byteLength === expectedPgpass.byteLength
            && crypto.timingSafeEqual(actualPgpass, expectedPgpass);
          actualPgpass.fill(0);
          expectedPgpass.fill(0);
          if (!pgpassMatches) throw new Error("invalid_backup_password_file_contract");
          const writer = new Client({ connectionString: sourceAdminUrl.toString() });
          await writer.connect();
          try {
            await writer.query(`INSERT INTO pintpath_app.system_state
              (key, value_json, revision, updated_at)
              VALUES ('outside-exported-snapshot', '{"outside":true}'::jsonb,
                      'outside-snapshot', clock_timestamp())`);
            concurrentWriteCommitted = true;
          } finally {
            await writer.end();
          }
        }

        if (isPgDump) {
          expect(invocation.stdinFileDescriptor).toBeUndefined();
          expect(invocation.args.some((argument) => (
            argument === "--file" || argument.startsWith("--file=")
          ))).toBe(false);
          expect(invocation.args).not.toContain(archivePath);
          dumpArchiveFileDescriptor = invocation.stdoutFileDescriptor;
          const descriptorStat = inspectArchiveDescriptor(
            dumpArchiveFileDescriptor,
            "empty",
          );
          dumpArchiveIdentity = {
            dev: descriptorStat.dev,
            ino: descriptorStat.ino,
          };
        } else {
          expect(invocation.args).toEqual(["--list", "--format=custom"]);
          expect(invocation.args).not.toContain(archivePath);
          expect(invocation.args).not.toContain(POSTGRES_LOGICAL_BACKUP_ARCHIVE);
          expect(invocation.args).not.toContain("-");
          expect(invocation.args.every((argument) => !argument.includes(archivePath)))
            .toBe(true);
          expect(invocation.stdoutFileDescriptor).toBeUndefined();
          listingArchiveFileDescriptor = invocation.stdinFileDescriptor;
          const descriptorStat = inspectArchiveDescriptor(
            listingArchiveFileDescriptor,
            "non-empty",
          );
          expect(dumpArchiveFileDescriptor).toBeTypeOf("number");
          expect(listingArchiveFileDescriptor).not.toBe(dumpArchiveFileDescriptor);
          expect({ dev: descriptorStat.dev, ino: descriptorStat.ino })
            .toEqual(dumpArchiveIdentity);
        }

        const result = await runPostgresBackupProcess(invocation);
        recordProcessObservation(
          isPgDump ? "pgDump" : "pgRestoreList",
          `${isPgDump ? "pg-dump:trusted-archive-stdout" : "pg-restore-list:trusted-archive-stdin"}:${result.exitCode}`,
        );
        return result;
      },
    });
    if (!concurrentWriteCommitted) throw new Error("concurrent_snapshot_write_not_committed");
    expect(pgpassPath).not.toBe("");
    expect(dumpArchiveFileDescriptor).toBeTypeOf("number");
    expect(listingArchiveFileDescriptor).toBeTypeOf("number");
    expect(listingArchiveFileDescriptor).not.toBe(dumpArchiveFileDescriptor);
    const processObservations = [
      processObservationState.pgDumpVersion,
      processObservationState.pgRestoreVersion,
      processObservationState.pgDump,
      processObservationState.pgRestoreList,
    ];
    if (processObservations.some((observation) => observation === null)) {
      throw new Error("missing_backup_process_integration_invocation");
    }
    return {
      directory,
      manifestSha256: result.manifestSha256,
      processObservations: processObservations as readonly string[],
    };
  } finally {
    if (pgpassPath) expect(fs.existsSync(pgpassPath)).toBe(false);
    if (transportRootCaFile) expect(fs.existsSync(transportRootCaFile)).toBe(false);
    if (transportDirectory) expect(fs.existsSync(transportDirectory)).toBe(false);
  }
}

async function renderArchive(backupDirectory: string): Promise<string> {
  const configuration = activeTestConfiguration();
  const result = await runPostgresBackupProcess({
    command: configuration.pgRestoreCommand,
    args: [
      "--format=custom",
      "--file=-",
      "--no-owner",
      "--no-acl",
      path.join(backupDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
    ],
    env: {
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
    },
    timeoutMs: 60_000,
    maxStdoutBytes: 32 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

describe.skipIf(!configuredAdminUrl)("real PostgreSQL logical restore rehearsal", () => {
  let adminUrl: URL;
  let admin: Client;
  let adminConnected = false;
  let root = "";
  let rolesInspected = false;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;
  let sourceDatabaseOid = "";
  let siblingDatabaseOid = "";
  let targetDatabaseOid = "";
  let sourceBackupRole = "";
  let siblingBackupRole = "";
  let targetBackupRole = "";
  let nonSuperuserBackupRole = "";
  let backupLogin = "";
  let bootstrapProbeRole = "";
  let backupLoginCreated = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    adminConnected = true;
    const version = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
      throw new Error("The disposable logical restore integration requires PostgreSQL 17.");
    }
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    rolesInspected = true;
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");

    for (const database of [SOURCE_DATABASE, SIBLING_DATABASE]) {
      await admin.query(`CREATE DATABASE ${database}`);
    }
    root = fs.realpathSync(fs.mkdtempSync(path.join(
      os.tmpdir(),
      "pintpath-logical-restore-integration-",
    )));
    fs.chmodSync(root, 0o700);

    const source = new Client({
      connectionString: withDatabase(adminUrl, SOURCE_DATABASE).toString(),
    });
    const sibling = new Client({
      connectionString: withDatabase(adminUrl, SIBLING_DATABASE).toString(),
    });
    await source.connect();
    await sibling.connect();
    try {
      sourceDatabaseOid = await currentDatabaseOid(source);
      siblingDatabaseOid = await currentDatabaseOid(sibling);
      expect(sourceDatabaseOid).not.toBe(siblingDatabaseOid);
      sourceBackupRole = scopedBackupRole(sourceDatabaseOid);
      siblingBackupRole = scopedBackupRole(siblingDatabaseOid);
      backupLogin = `${sourceBackupRole}_v${BACKUP_VERSION}`;
      bootstrapProbeRole = `pintpath_backup_bootstrap_probe_${process.pid}`;
      const collisions = await admin.query<{ rolname: string }>(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
        [[sourceBackupRole, siblingBackupRole, backupLogin, bootstrapProbeRole]],
      );
      if (collisions.rows.length !== 0) throw new Error("disposable_role_name_collision");

      const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
      const forwardMigrationSql = fs.readFileSync(FORWARD_MIGRATION_PATH, "utf8");
      await source.query(`CREATE ROLE ${sourceBackupRole}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await source.query(`CREATE ROLE ${bootstrapProbeRole}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await source.query(`GRANT ${sourceBackupRole} TO ${bootstrapProbeRole}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await expectSqlState(source, schemaSql, "42501");
      await source.query("ROLLBACK");
      const rolledBackBootstrap = await source.query<{ absent: boolean }>(
        "SELECT pg_catalog.to_regnamespace('pintpath_app') IS NULL AS absent",
      );
      expect(rolledBackBootstrap.rows).toEqual([{ absent: true }]);
      await source.query(`REVOKE ${sourceBackupRole} FROM ${bootstrapProbeRole}`);
      await source.query(`DROP ROLE ${bootstrapProbeRole}`);
      bootstrapProbeRole = "";
      await source.query(`DROP ROLE ${sourceBackupRole}`);

      await source.query(schemaSql);
      await source.query(forwardMigrationSql);
      await sibling.query(schemaSql);
      await sibling.query(forwardMigrationSql);
      await source.query(`UPDATE pintpath_app.schema_metadata
        SET value = CASE key
          WHEN 'import_state' THEN 'ready'
          WHEN 'migration_candidate_sha' THEN $1
          WHEN 'migration_manifest_sha256' THEN $2
          WHEN 'migration_plan_sha256' THEN $3
          WHEN 'migration_run_sha256' THEN $4
          WHEN 'source_schema_fingerprint' THEN $5
          WHEN 'source_schema_version' THEN $6
          WHEN 'source_snapshot_sha256' THEN $7
          WHEN 'target_ddl_sha256' THEN $8
          ELSE value
        END`, [
        "c".repeat(40), "1".repeat(64), "2".repeat(64), "3".repeat(64),
        POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
        String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
        "4".repeat(64), "5".repeat(64),
      ]);
      await source.query(`INSERT INTO pintpath_app.system_state
        (key, value_json, revision, updated_at)
        VALUES ('restore-integration', '{"ok":true}'::jsonb,
                'integration-revision', clock_timestamp())`);

      await source.query(`CREATE ROLE ${backupLogin}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
        CONNECTION LIMIT 2
        PASSWORD '${BACKUP_PASSWORD}'`);
      backupLoginCreated = true;
      await source.query(`REVOKE ALL ON DATABASE ${SOURCE_DATABASE} FROM ${backupLogin}`);
      await source.query(`GRANT CONNECT ON DATABASE ${SOURCE_DATABASE} TO ${backupLogin}`);
      await source.query(`GRANT ${sourceBackupRole} TO ${backupLogin}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await source.query(
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${backupLogin}`,
      );
      const loginExpiry = await source.query<{ passwordNeverExpires: boolean }>(
        `SELECT role.rolvaliduntil IS NULL AS "passwordNeverExpires"
         FROM pg_catalog.pg_roles AS role WHERE role.rolname = $1`,
        [backupLogin],
      );
      expect(loginExpiry.rows).toEqual([{ passwordNeverExpires: true }]);
    } finally {
      await source.end();
      await sibling.end();
    }
  }, 60_000);

  afterAll(async () => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (admin && adminConnected) {
      for (const database of [
        SOURCE_DATABASE,
        SIBLING_DATABASE,
        TARGET_DATABASE,
        NON_SUPERUSER_DATABASE,
      ]) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        ).catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined);
      }
      if (backupLogin && backupLoginCreated) {
        await admin.query(`DROP ROLE IF EXISTS ${backupLogin}`).catch(() => undefined);
      }
      backupLoginCreated = false;
      if (bootstrapProbeRole) {
        await admin.query(`DROP ROLE IF EXISTS ${bootstrapProbeRole}`).catch(() => undefined);
      }
      for (const role of [
        sourceBackupRole,
        siblingBackupRole,
        targetBackupRole,
        nonSuperuserBackupRole,
        AUTO_MEMBERSHIP_PROBE_ROLE,
        NON_SUPERUSER_ROLE,
      ]) {
        if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      if (rolesInspected && !runtimeRoleExisted) {
        await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      }
      if (rolesInspected && !migratorRoleExisted) {
        await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
      adminConnected = false;
    }
  }, 60_000);

  it("keeps PG17 non-superuser CREATEROLE bootstrap policy-only and inert", async () => {
    const collisions = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [[NON_SUPERUSER_ROLE, AUTO_MEMBERSHIP_PROBE_ROLE]],
    );
    if (collisions.rows.length !== 0) throw new Error("disposable_role_name_collision");

    await admin.query(`CREATE ROLE ${NON_SUPERUSER_ROLE}
      NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE ${NON_SUPERUSER_DATABASE} OWNER ${NON_SUPERUSER_ROLE}`);
    const probeUrl = withDatabase(adminUrl, NON_SUPERUSER_DATABASE);
    const probe = new Client({ connectionString: probeUrl.toString() });
    await probe.connect();
    try {
      const databaseOid = await currentDatabaseOid(probe);
      nonSuperuserBackupRole = scopedBackupRole(databaseOid);
      await probe.query(`SET ROLE ${NON_SUPERUSER_ROLE}`);
      const executor = await probe.query<{
        currentRole: string;
        isSuperuser: boolean;
        canCreateRole: boolean;
      }>(`SELECT current_user AS "currentRole", role.rolsuper AS "isSuperuser",
                 role.rolcreaterole AS "canCreateRole"
          FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
      expect(executor.rows).toEqual([{
        currentRole: NON_SUPERUSER_ROLE,
        isSuperuser: false,
        canCreateRole: true,
      }]);

      await probe.query(`CREATE ROLE ${AUTO_MEMBERSHIP_PROBE_ROLE}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const automaticMembership = await probe.query<{
        memberRole: string;
        adminOption: boolean;
        inheritOption: boolean;
        setOption: boolean;
      }>(`SELECT member.rolname AS "memberRole",
                 membership.admin_option AS "adminOption",
                 membership.inherit_option AS "inheritOption",
                 membership.set_option AS "setOption"
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
          WHERE granted.rolname = $1`, [AUTO_MEMBERSHIP_PROBE_ROLE]);
      expect(automaticMembership.rows).toEqual([{
        memberRole: NON_SUPERUSER_ROLE,
        adminOption: true,
        inheritOption: false,
        setOption: false,
      }]);
      await probe.query("RESET ROLE");
      await probe.query(`DROP ROLE ${AUTO_MEMBERSHIP_PROBE_ROLE}`);
      await probe.query(`SET ROLE ${NON_SUPERUSER_ROLE}`);

      await probe.query(fs.readFileSync(SCHEMA_PATH, "utf8"));
      await probe.query(`DO $$
        DECLARE target record;
        BEGIN
          FOR target IN
            SELECT policy.polname, namespace.nspname, relation.relname
            FROM pg_catalog.pg_policy AS policy
            JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND policy.polname = (relation.relname || '_logical_backup_select')::name
          LOOP
            EXECUTE pg_catalog.format(
              'DROP POLICY %I ON %I.%I',
              target.polname,
              target.nspname,
              target.relname
            );
          END LOOP;
        END;
      $$`);
      const absentUpgradeState = await probe.query<{
        groupPresent: boolean;
        privatePolicyCount: number;
      }>(`SELECT
        pg_catalog.to_regrole($1) IS NOT NULL AS "groupPresent",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
          AS "privatePolicyCount"`, [nonSuperuserBackupRole]);
      expect(absentUpgradeState.rows).toEqual([{
        groupPresent: false,
        privatePolicyCount: 177,
      }]);

      const forwardMigrationSql = fs.readFileSync(FORWARD_MIGRATION_PATH, "utf8");
      await probe.query(forwardMigrationSql);
      await probe.query(forwardMigrationSql);
      const policyOnly = await probe.query<{
        groupPresent: boolean;
        reservedLoginCount: number;
        privatePolicyCount: number;
        exactPolicyCount: number;
      }>(`SELECT
        pg_catalog.to_regrole($1) IS NOT NULL AS "groupPresent",
        (SELECT count(*)::integer FROM pg_catalog.pg_roles AS role
         WHERE role.rolname LIKE ($1 || '\\_v%') ESCAPE '\\') AS "reservedLoginCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
          AS "privatePolicyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND policy.polname = (relation.relname || '_logical_backup_select')::name
           AND policy.polroles = ARRAY[0]::oid[]
           AND policy.polcmd = 'r'
           AND policy.polpermissive
           AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
           AND policy.polwithcheck IS NULL) AS "exactPolicyCount"`, [
        nonSuperuserBackupRole,
        LOGICAL_BACKUP_POLICY_EXPRESSION,
      ]);
      expect(policyOnly.rows).toEqual([{
        groupPresent: false,
        reservedLoginCount: 0,
        privatePolicyCount: 236,
        exactPolicyCount: 59,
      }]);
      await expectSqlState(probe, `SET ROLE ${nonSuperuserBackupRole}`, "22023");
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      await probe.query("RESET ROLE").catch(() => undefined);
      await probe.end().catch(() => undefined);
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [NON_SUPERUSER_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${NON_SUPERUSER_DATABASE}`).catch(() => undefined);
      for (const role of [
        nonSuperuserBackupRole,
        AUTO_MEMBERSHIP_PROBE_ROLE,
        NON_SUPERUSER_ROLE,
      ]) {
        if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      nonSuperuserBackupRole = "";
    }
  }, 120_000);

  it("restores a portable PG17 archive and reconstructs target-OID backup authority", async () => {
    const sourceAdminUrl = withDatabase(adminUrl, SOURCE_DATABASE);
    const sourceUrl = withCredentials(sourceAdminUrl, backupLogin, BACKUP_PASSWORD);
    const backupSourceUrl = asRailwayBackupSourceUrl(sourceUrl);
    expect(backupSourceUrl.hostname).toBe(BACKUP_SOURCE_HOSTNAME);
    expect(backupSourceUrl.port).toBe("5432");
    expect(backupSourceUrl.searchParams.get("sslmode")).toBe("verify-full");
    const restrictedSource = new Client({ connectionString: sourceUrl.toString() });
    await restrictedSource.connect();
    try {
      await expectSqlState(restrictedSource, "SET ROLE pintpath_migrator");
      await expectSqlState(restrictedSource, "SET ROLE pintpath_runtime");
      await expectSqlState(restrictedSource, `SET ROLE ${siblingBackupRole}`);
      await restrictedSource.query(`SET ROLE ${sourceBackupRole}`);
      const contract = await restrictedSource.query<{
        currentRole: string;
        tableCount: number;
        sequenceCount: number;
        executableFunctionCount: number;
      }>(`SELECT
        current_user AS "currentRole",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND relation.relkind IN ('r', 'p')
           AND pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')) AS "tableCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND relation.relkind = 'S') AS "sequenceCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE'))
          AS "executableFunctionCount"`);
      expect(contract.rows).toEqual([{
        currentRole: sourceBackupRole,
        tableCount: 59,
        sequenceCount: 0,
        executableFunctionCount: 0,
      }]);
      await expectSqlState(
        restrictedSource,
        "INSERT INTO pintpath_app.schema_metadata (key, value) VALUES ('forbidden', 'write')",
      );
      await expectSqlState(restrictedSource, "CREATE TABLE pintpath_app.forbidden_backup_ddl (id integer)");
      await expectSqlState(restrictedSource, "SELECT pintpath_app.json_valid('{}'::jsonb)");
    } finally {
      await restrictedSource.end();
    }

    const siblingUrl = withCredentials(
      withDatabase(adminUrl, SIBLING_DATABASE),
      backupLogin,
      BACKUP_PASSWORD,
    );
    const restrictedSibling = new Client({ connectionString: siblingUrl.toString() });
    await restrictedSibling.connect();
    try {
      await expectSqlState(restrictedSibling, `SET ROLE ${siblingBackupRole}`);
      await restrictedSibling.query(`SET ROLE ${sourceBackupRole}`);
      await expectSqlState(restrictedSibling, "SELECT count(*) FROM pintpath_app.accounts");
      await expectSqlState(
        restrictedSibling,
        "INSERT INTO pintpath_app.schema_metadata (key, value) VALUES ('forbidden', 'write')",
      );
    } finally {
      await restrictedSibling.end();
    }

    const sourcePolicyProbe = new Client({ connectionString: sourceAdminUrl.toString() });
    await sourcePolicyProbe.connect();
    try {
      await sourcePolicyProbe.query(`CREATE POLICY accounts_sibling_bypass
        ON pintpath_app.accounts AS PERMISSIVE FOR SELECT
        TO ${siblingBackupRole} USING (true)`);
    } finally {
      await sourcePolicyProbe.end();
    }
    const driftedBackup = await createLogicalBackup(backupSourceUrl, sourceAdminUrl, root)
      .catch((error: unknown) => error as { code?: string });
    expect(driftedBackup).toMatchObject({ code: "source_unreachable_or_unsafe" });
    expect(fs.existsSync(path.join(root, "backup"))).toBe(false);
    const sourcePolicyCleanup = new Client({ connectionString: sourceAdminUrl.toString() });
    await sourcePolicyCleanup.connect();
    try {
      await sourcePolicyCleanup.query(
        "DROP POLICY accounts_sibling_bypass ON pintpath_app.accounts",
      );
    } finally {
      await sourcePolicyCleanup.end();
    }

    const backup = await createLogicalBackup(backupSourceUrl, sourceAdminUrl, root);
    expect(backup.processObservations).toEqual([
      "pg-dump-version:no-stdin-or-stdout:0",
      "pg-restore-version:no-stdin-or-stdout:0",
      "pg-dump:trusted-archive-stdout:0",
      "pg-restore-list:trusted-archive-stdin:0",
    ]);
    const configuration = activeTestConfiguration();
    const manifestBytes = fs.readFileSync(
      path.join(backup.directory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      "utf8",
    );
    const manifest = JSON.parse(manifestBytes) as {
      schemaVersion: number;
      archive: { bytes: number; sha256: string };
      tools: {
        pgDump: { name: string; major: number; version: string };
        pgRestore: { name: string; major: number; version: string };
      };
      transport: { profile: string; rootCaCertificateSha256: string };
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.transport.profile).toBe(POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE);
    expect(manifest.transport.rootCaCertificateSha256).toBe(configuration.rootCaDerSha256);
    expect(manifest.tools.pgDump.name).toBe("pg_dump");
    expect(manifest.tools.pgDump.major).toBe(17);
    expect(manifest.tools.pgDump.version).toBe(EXPECTED_POSTGRES_TOOL_VERSION);
    expect(manifest.tools.pgRestore.name).toBe("pg_restore");
    expect(manifest.tools.pgRestore.major).toBe(17);
    expect(manifest.tools.pgRestore.version).toBe(EXPECTED_POSTGRES_TOOL_VERSION);
    if (
      manifestBytes.includes(BACKUP_SOURCE_HOSTNAME)
      || manifestBytes.includes(BACKUP_PASSWORD)
      || manifestBytes.includes(backupLogin)
    ) throw new Error("backup_manifest_contains_sensitive_authority");
    const archiveBytes = fs.readFileSync(
      path.join(backup.directory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
    );
    expect(archiveBytes.subarray(0, 5).toString("ascii")).toBe("PGDMP");
    expect(archiveBytes.byteLength).toBe(manifest.archive.bytes);
    expect(crypto.createHash("sha256").update(archiveBytes).digest("hex"))
      .toBe(manifest.archive.sha256);
    const renderedArchive = await renderArchive(backup.directory);
    const renderedBackupPolicies = renderedArchive.match(
      /^CREATE POLICY .*_logical_backup_select ON .* FOR SELECT USING \(\(CURRENT_USER =/gm,
    );
    expect(renderedBackupPolicies).toHaveLength(59);
    expect(renderedBackupPolicies?.every((statement) => !statement.includes(" TO "))).toBe(true);
    expect(renderedArchive).toContain("pintpath_logical_backup_d'::text");
    expect(renderedArchive).toContain("current_database()");
    expect(renderedArchive).not.toContain(sourceBackupRole);

    const source = new Client({ connectionString: sourceAdminUrl.toString() });
    await source.connect();
    try {
      await source.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${backupLogin}`);
      await source.query(`REVOKE CONNECT ON DATABASE ${SOURCE_DATABASE} FROM ${backupLogin}`);
      await source.query(`REVOKE ${sourceBackupRole} FROM ${backupLogin}`);
    } finally {
      await source.end();
    }
    await admin.query(`DROP ROLE ${backupLogin}`);
    backupLoginCreated = false;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [SOURCE_DATABASE],
    );
    await admin.query(`DROP DATABASE ${SOURCE_DATABASE}`);
    await admin.query(`DROP ROLE ${sourceBackupRole}`);
    const absentSourceRoles = await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [[sourceBackupRole, backupLogin]],
    );
    expect(absentSourceRoles.rows).toEqual([{ count: 0 }]);

    await admin.query(`CREATE DATABASE ${TARGET_DATABASE}`);
    await admin.query(
      `ALTER DATABASE ${TARGET_DATABASE} SET pintpath.logical_restore_target_class TO 'disposable-rehearsal'`,
    );
    const targetUrl = withDatabase(adminUrl, TARGET_DATABASE);
    const targetProbe = new Client({ connectionString: targetUrl.toString() });
    await targetProbe.connect();
    try {
      targetDatabaseOid = await currentDatabaseOid(targetProbe);
    } finally {
      await targetProbe.end();
    }
    expect(targetDatabaseOid).not.toBe(sourceDatabaseOid);
    targetBackupRole = scopedBackupRole(targetDatabaseOid);
    const targetRoleBeforeRestore = await admin.query<{ present: boolean }>(
      "SELECT pg_catalog.to_regrole($1) IS NOT NULL AS present",
      [targetBackupRole],
    );
    expect(targetRoleBeforeRestore.rows).toEqual([{ present: false }]);

    const targetUrlFile = path.join(root, "target-url");
    fs.writeFileSync(targetUrlFile, `${targetUrl.toString()}\n`, { mode: 0o600 });
    fs.chmodSync(targetUrlFile, 0o600);
    const backupArchivePath = path.join(
      backup.directory,
      POSTGRES_LOGICAL_BACKUP_ARCHIVE,
    );
    const pgRestoreProcessObservations: string[] = [];
    let listingArchiveFileDescriptor: number | undefined;
    let mutationArchiveFileDescriptor: number | undefined;
    const dependencyOverrides = {
      env: { ...process.env, NODE_ENV: "test" },
      allowInsecureLoopbackForTests: true,
      pgRestoreCommand: configuration.pgRestoreCommand,
      runProcess: async (invocation: Parameters<typeof runPostgresBackupProcess>[0]) => {
        if (invocation.command !== configuration.pgRestoreCommand) {
          throw configurationError();
        }
        const isVersionProbe = invocation.args.length === 1
          && invocation.args[0] === "--version";
        const isArchiveListing = invocation.args.length === 2
          && invocation.args[0] === "--list"
          && invocation.args[1] === "--format=custom";
        const isArchiveMutation = invocation.args.includes("--single-transaction");
        if (
          Number(isVersionProbe)
            + Number(isArchiveListing)
            + Number(isArchiveMutation)
          !== 1
        ) throw new Error("unexpected_pg_restore_integration_invocation");

        if (isVersionProbe) {
          expect(invocation.stdinFileDescriptor).toBeUndefined();
          expect(invocation.stdoutFileDescriptor).toBeUndefined();
          const result = await runPostgresBackupProcess(invocation);
          pgRestoreProcessObservations.push(
            `version:no-stdin-or-stdout:${result.exitCode}`,
          );
          return result;
        }

        expect(invocation.args).not.toContain(backupArchivePath);
        expect(invocation.args).not.toContain(POSTGRES_LOGICAL_BACKUP_ARCHIVE);
        expect(invocation.args).not.toContain("-");
        expect(invocation.args.every((argument) => !argument.includes(backupArchivePath)))
          .toBe(true);
        expect(invocation.stdoutFileDescriptor).toBeUndefined();
        const archiveFileDescriptor = invocation.stdinFileDescriptor;
        if (
          !Number.isSafeInteger(archiveFileDescriptor)
          || archiveFileDescriptor === undefined
          || archiveFileDescriptor < 0
        ) throw new Error("invalid_pg_restore_archive_file_descriptor");
        const descriptorStat = fs.fstatSync(archiveFileDescriptor);
        expect(descriptorStat.isFile()).toBe(true);
        expect({
          mode: descriptorStat.mode & 0o7777,
          nlink: descriptorStat.nlink,
          size: descriptorStat.size,
        }).toEqual({
          mode: 0o600,
          nlink: 1,
          size: manifest.archive.bytes,
        });

        const phase = isArchiveListing ? "list" : "mutation";
        if (isArchiveListing) {
          listingArchiveFileDescriptor = archiveFileDescriptor;
        } else {
          mutationArchiveFileDescriptor = archiveFileDescriptor;
          expect(mutationArchiveFileDescriptor).not.toBe(listingArchiveFileDescriptor);
        }
        const result = await runPostgresBackupProcess(invocation);
        pgRestoreProcessObservations.push(`${phase}:trusted-archive-stdin:${result.exitCode}`);
        return result;
      },
    } as const;
    const inspection = await inspectPostgresLogicalRestoreTarget(
      { targetUrlFile },
      dependencyOverrides,
    );
    const receiptFile = path.join(root, "restore-receipt.json");
    const restored = await restorePostgresLogicalBackup({
      backupDirectory: backup.directory,
      expectedBackupManifestSha256: backup.manifestSha256,
      targetUrlFile,
      expectedTargetIdentitySha256: inspection.targetIdentitySha256,
      receiptFile,
      confirmation: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    }, dependencyOverrides);
    expect(restored).toMatchObject({
      ok: true,
      authoritativeRowCount: "1",
      nonEmptyAuthoritativeTableCount: 1,
      promotionReconciliationReady: true,
      sourceStateBindingStatus: "exact-match",
    });
    expect(pgRestoreProcessObservations).toEqual([
      "version:no-stdin-or-stdout:0",
      "list:trusted-archive-stdin:0",
      "mutation:trusted-archive-stdin:0",
    ]);
    expect(listingArchiveFileDescriptor).toBeTypeOf("number");
    expect(mutationArchiveFileDescriptor).toBeTypeOf("number");
    expect(mutationArchiveFileDescriptor).not.toBe(listingArchiveFileDescriptor);

    const target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    try {
      const row = await target.query<{ value_json: { ok: boolean } }>(
        "SELECT value_json FROM pintpath_app.system_state WHERE key = 'restore-integration'",
      );
      expect(row.rows).toEqual([{ value_json: { ok: true } }]);
      const outside = await target.query<{ present: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pintpath_app.system_state WHERE key = 'outside-exported-snapshot'
      ) AS present`);
      expect(outside.rows).toEqual([{ present: false }]);

      const policyOnly = await target.query<{
        groupPresent: boolean;
        reservedLoginCount: number;
        privatePolicyCount: number;
        exactPolicyCount: number;
        publicPolicyCount: number;
        reservedPolicyCount: number;
        unsafePublicPolicyCount: number;
      }>(`SELECT
        pg_catalog.to_regrole($1) IS NOT NULL AS "groupPresent",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_roles AS role
         WHERE role.rolname LIKE ($1 || '\\_v%') ESCAPE '\\') AS "reservedLoginCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
          AS "privatePolicyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND policy.polname = (relation.relname || '_logical_backup_select')::name
           AND policy.polroles = ARRAY[0]::oid[]
           AND policy.polcmd = 'r'
           AND policy.polpermissive
           AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
           AND policy.polwithcheck IS NULL) AS "exactPolicyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND 0::oid = ANY(policy.polroles)) AS "publicPolicyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND policy.polname::text ~ '_logical_backup_select$') AS "reservedPolicyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND 0::oid = ANY(policy.polroles)
           AND NOT (
             policy.polname = (relation.relname || '_logical_backup_select')::name
             AND policy.polroles = ARRAY[0]::oid[]
             AND policy.polcmd = 'r'
             AND policy.polpermissive
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $2
             AND policy.polwithcheck IS NULL
           )) AS "unsafePublicPolicyCount"`, [
        targetBackupRole,
        LOGICAL_BACKUP_POLICY_EXPRESSION,
      ]);
      expect(policyOnly.rows).toEqual([{
        groupPresent: false,
        reservedLoginCount: 0,
        privatePolicyCount: 236,
        exactPolicyCount: 59,
        publicPolicyCount: 59,
        reservedPolicyCount: 59,
        unsafePublicPolicyCount: 0,
      }]);

      const targetForwardMigrationSql = fs.readFileSync(FORWARD_MIGRATION_PATH, "utf8");
      await target.query(`CREATE POLICY accounts_sibling_bypass
        ON pintpath_app.accounts AS PERMISSIVE FOR SELECT
        TO ${siblingBackupRole} USING (true)`);
      await expectSqlState(target, targetForwardMigrationSql, "55000");
      await target.query("ROLLBACK");
      await target.query("DROP POLICY accounts_sibling_bypass ON pintpath_app.accounts");

      await target.query(`ALTER POLICY accounts_runtime_all
        ON pintpath_app.accounts USING (false) WITH CHECK (true)`);
      await expectSqlState(target, targetForwardMigrationSql, "55000");
      await target.query("ROLLBACK");
      await target.query(`ALTER POLICY accounts_runtime_all
        ON pintpath_app.accounts USING (true) WITH CHECK (true)`);

      await target.query(
        "DROP POLICY accounts_logical_backup_select ON pintpath_app.accounts",
      );
      await expectSqlState(target, targetForwardMigrationSql, "55000");
      await target.query("ROLLBACK");
      await target.query(`CREATE POLICY accounts_logical_backup_select
        ON pintpath_app.accounts AS PERMISSIVE FOR SELECT TO PUBLIC
        USING (CURRENT_USER = ('pintpath_logical_backup_d' || (
          SELECT database.oid::text FROM pg_catalog.pg_database AS database
          WHERE database.datname = pg_catalog.current_database()
        )))`);

      await target.query(`CREATE POLICY accounts_unexpected_logical_backup_select
        ON pintpath_app.accounts AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)`);
      await expectSqlState(target, targetForwardMigrationSql, "55000");
      await target.query("ROLLBACK");
      await target.query(
        "DROP POLICY accounts_unexpected_logical_backup_select ON pintpath_app.accounts",
      );

      const orphanTargetLogin = `${targetBackupRole}_vprobe`;
      await target.query(`CREATE ROLE ${orphanTargetLogin}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await expectSqlState(target, targetForwardMigrationSql, "55000");
      await target.query("ROLLBACK");
      await target.query(`DROP ROLE ${orphanTargetLogin}`);
      const rejectedClassifierWrites = await target.query<{ groupPresent: boolean }>(
        "SELECT pg_catalog.to_regrole($1) IS NOT NULL AS \"groupPresent\"",
        [targetBackupRole],
      );
      expect(rejectedClassifierWrites.rows).toEqual([{ groupPresent: false }]);

      await target.query(targetForwardMigrationSql);
      const hardened = await target.query<{
        childCount: number;
        parentCount: number;
        dependencyCount: number;
        selectableTableCount: number;
      }>(`SELECT
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = role.oid) AS "childCount",
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = role.oid) AS "parentCount",
        (SELECT count(*)::integer FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = role.oid) AS "dependencyCount",
        (SELECT count(*)::integer
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
           AND relation.relkind IN ('r', 'p')
           AND pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT'))
          AS "selectableTableCount"
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = $1`, [targetBackupRole]);
      expect(hardened.rows).toEqual([{
        childCount: 0,
        parentCount: 0,
        dependencyCount: 61,
        selectableTableCount: 59,
      }]);

      await target.query(`SET ROLE ${targetBackupRole}`);
      try {
        const targetRead = await target.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pintpath_app.system_state",
        );
        expect(targetRead.rows).toEqual([{ count: 1 }]);
        await expectSqlState(
          target,
          "INSERT INTO pintpath_app.schema_metadata (key, value) VALUES ('forbidden', 'write')",
        );
        await expectSqlState(target, "CREATE TABLE pintpath_app.forbidden_target_ddl (id integer)");
        await expectSqlState(target, "SELECT pintpath_app.json_valid('{}'::jsonb)");
      } finally {
        await target.query("RESET ROLE");
      }

      await target.query(`CREATE ROLE ${sourceBackupRole}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await target.query(`CREATE ROLE ${backupLogin}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
        CONNECTION LIMIT 2
        PASSWORD '${BACKUP_PASSWORD}'`);
      backupLoginCreated = true;
      await target.query(`GRANT CONNECT ON DATABASE ${TARGET_DATABASE} TO ${backupLogin}`);
      await target.query(`GRANT ${sourceBackupRole} TO ${backupLogin}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await target.query(`GRANT USAGE ON SCHEMA pintpath_app, pintpath_ops TO ${sourceBackupRole}`);
      await target.query(`GRANT SELECT ON TABLE pintpath_app.system_state TO ${sourceBackupRole}`);
    } finally {
      await target.end();
    }

    const oldSourceUrl = withCredentials(targetUrl, backupLogin, BACKUP_PASSWORD);
    const oldSource = new Client({ connectionString: oldSourceUrl.toString() });
    await oldSource.connect();
    try {
      await expectSqlState(oldSource, `SET ROLE ${targetBackupRole}`);
      await expectSqlState(oldSource, "SET ROLE pintpath_migrator");
      await expectSqlState(oldSource, "SET ROLE pintpath_runtime");
      await oldSource.query(`SET ROLE ${sourceBackupRole}`);
      const hidden = await oldSource.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pintpath_app.system_state",
      );
      expect(hidden.rows).toEqual([{ count: 0 }]);
      await expectSqlState(
        oldSource,
        "INSERT INTO pintpath_app.system_state (key, value_json, revision, updated_at) VALUES ('forbidden', '{}'::jsonb, 'forbidden', clock_timestamp())",
      );
    } finally {
      await oldSource.end();
    }

    const cleanupTarget = new Client({ connectionString: targetUrl.toString() });
    await cleanupTarget.connect();
    try {
      await cleanupTarget.query(`REVOKE ${sourceBackupRole} FROM ${backupLogin}`);
      await cleanupTarget.query(`REVOKE CONNECT ON DATABASE ${TARGET_DATABASE} FROM ${backupLogin}`);
      await cleanupTarget.query(`REVOKE SELECT ON TABLE pintpath_app.system_state FROM ${sourceBackupRole}`);
      await cleanupTarget.query(`REVOKE USAGE ON SCHEMA pintpath_app, pintpath_ops FROM ${sourceBackupRole}`);
      await cleanupTarget.query(`DROP ROLE ${backupLogin}`);
      backupLoginCreated = false;
      await cleanupTarget.query(`DROP ROLE ${sourceBackupRole}`);
      await cleanupTarget.query(fs.readFileSync(FORWARD_MIGRATION_PATH, "utf8"));
    } finally {
      await cleanupTarget.end();
    }

    expect(fs.statSync(receiptFile).mode & 0o7777).toBe(0o600);
  }, 240_000);
});
