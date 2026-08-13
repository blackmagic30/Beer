import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runPostgresBackupProcess } from "../src/lib/postgres-logical-backup.js";
import { POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS } from "../src/lib/postgres-logical-backup-v4.js";
import { POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS } from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";
import { parsePostgresLogicalBackupV4TocListing } from "../src/lib/postgres-logical-backup-v4-toc.js";
import { openPostgresToolAuthority } from "../src/lib/postgres-tool-authority.js";

const PG_BIN_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_BIN";
const MODE_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_MODE";
const REQUIRED_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_REQUIRED";
const PG_DUMP_VERSION_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_DUMP_VERSION";
const PG_DUMP_SHA256_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_DUMP_SHA256";
const PG_RESTORE_VERSION_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_RESTORE_VERSION";
const PG_RESTORE_SHA256_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_RESTORE_SHA256";
const ADMIN_URL_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ADMIN_URL";
const CONTAINER_ENV = "PINTPATH_CI_POSTGRES_CONTAINER_ID";
const DATABASE_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_DATABASE";
const ROLE_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ROLE";
const EXPECTED_SERVER_VERSION_NUM = "170006";
const PASSWORD = "pintpath-v4-scram-integration-password";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^pintpath_v4_(?:tool|backup)_[a-f0-9]{12}$/;
const CONTAINER_PATTERN = /^[a-f0-9]{12,64}$/;
const PROCESS_TIMEOUT_MS = 30_000;

type Mode = "isolated" | "service" | "disabled";
const configuredRequired = process.env[REQUIRED_ENV] ?? "";
const configuredMode = process.env[MODE_ENV] ?? "";
if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredMode !== "" && configuredMode !== "isolated" && configuredMode !== "service") {
  throw new Error(`${MODE_ENV} must be isolated or service when set.`);
}
if (configuredRequired === "true" && configuredMode === "") {
  throw new Error(`${MODE_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}
const mode: Mode = configuredMode === "isolated" || configuredMode === "service"
  ? configuredMode
  : "disabled";
if (mode !== "disabled" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when ${MODE_ENV} is set.`);
}

function requiredEnvironment(name: string): string {
  const raw = process.env[name] ?? "";
  if (!raw) throw new Error(`${name} is mandatory when ${REQUIRED_ENV}=true.`);
  if (raw.trim() !== raw || /\0|\r|\n/.test(raw)) throw new Error(`${name} is unsafe.`);
  return raw;
}

function optionalEnvironment(name: string): string {
  const raw = process.env[name] ?? "";
  if (raw.trim() !== raw || /\0|\r|\n/.test(raw)) throw new Error(`${name} is unsafe.`);
  return raw;
}

const configuredPgBin = optionalEnvironment(PG_BIN_ENV);
if (configuredRequired === "true" && !configuredPgBin) requiredEnvironment(PG_BIN_ENV);
if (configuredPgBin && (!path.isAbsolute(configuredPgBin)
  || path.normalize(configuredPgBin) !== configuredPgBin
  || path.resolve(configuredPgBin) !== configuredPgBin
  || fs.realpathSync.native(configuredPgBin) !== configuredPgBin)) {
  throw new Error(`${PG_BIN_ENV} must be a canonical absolute PostgreSQL 17 bin directory.`);
}

const expectedPgDumpVersion = optionalEnvironment(PG_DUMP_VERSION_ENV);
const expectedPgDumpSha256 = optionalEnvironment(PG_DUMP_SHA256_ENV);
const expectedPgRestoreVersion = optionalEnvironment(PG_RESTORE_VERSION_ENV);
const expectedPgRestoreSha256 = optionalEnvironment(PG_RESTORE_SHA256_ENV);
if (configuredRequired === "true" && mode === "service") {
  for (const [name, value] of [
    [PG_DUMP_VERSION_ENV, expectedPgDumpVersion],
    [PG_RESTORE_VERSION_ENV, expectedPgRestoreVersion],
  ]) {
    if (!value) throw new Error(`${name} is mandatory when ${REQUIRED_ENV}=true.`);
    if (!/^17\.[^\r\n]{1,120}$/.test(value)) throw new Error(`${name} is unsafe.`);
  }
  for (const [name, value] of [
    [PG_DUMP_SHA256_ENV, expectedPgDumpSha256],
    [PG_RESTORE_SHA256_ENV, expectedPgRestoreSha256],
  ]) {
    if (!value) throw new Error(`${name} is mandatory when ${REQUIRED_ENV}=true.`);
    if (!SHA256_PATTERN.test(value)) throw new Error(`${name} is unsafe.`);
  }
}

const PG_BIN = configuredPgBin;
const INITDB = `${PG_BIN}/initdb`;
const PG_CTL = `${PG_BIN}/pg_ctl`;
const PSQL = `${PG_BIN}/psql`;
const PG_DUMP = `${PG_BIN}/pg_dump`;
const PG_RESTORE = `${PG_BIN}/pg_restore`;
const HBA_FIXTURE = path.resolve("scripts/ci/postgres-tool-authority-v4-hba-fixture");

if (configuredRequired === "true" && mode === "service") {
  const adminUrl = requiredEnvironment(ADMIN_URL_ENV);
  const containerId = requiredEnvironment(CONTAINER_ENV);
  const database = requiredEnvironment(DATABASE_ENV);
  const role = requiredEnvironment(ROLE_ENV);
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} is unsafe.`);
  }
  if (parsed.protocol !== "postgresql:" || parsed.username !== "postgres"
    || parsed.password !== "postgres" || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "5432" || parsed.pathname !== "/postgres"
    || parsed.search !== "?sslmode=disable" || parsed.hash !== "") {
    throw new Error(`${ADMIN_URL_ENV} is unsafe.`);
  }
  if (!CONTAINER_PATTERN.test(containerId)) throw new Error(`${CONTAINER_ENV} is unsafe.`);
  if (!SAFE_NAME_PATTERN.test(database) || !database.startsWith("pintpath_v4_tool_")) {
    throw new Error(`${DATABASE_ENV} is unsafe.`);
  }
  if (!SAFE_NAME_PATTERN.test(role) || !role.startsWith("pintpath_v4_backup_")) {
    throw new Error(`${ROLE_ENV} is unsafe.`);
  }
  const runnerTemp = requiredEnvironment("RUNNER_TEMP");
  requiredEnvironment("PATH");
  if (!path.isAbsolute(runnerTemp) || path.normalize(runnerTemp) !== runnerTemp
    || path.resolve(runnerTemp) !== runnerTemp
    || fs.realpathSync.native(runnerTemp) !== runnerTemp
    || !fs.statSync(runnerTemp).isDirectory() || fs.lstatSync(runnerTemp).isSymbolicLink()) {
    throw new Error("RUNNER_TEMP is unsafe.");
  }
}

function databaseAdminUrl(database: string): string {
  if (!SAFE_NAME_PATTERN.test(database) || !database.startsWith("pintpath_v4_tool_")) {
    throw new Error("service_database_name_unsafe");
  }
  const parsed = new URL(requiredEnvironment(ADMIN_URL_ENV));
  parsed.pathname = `/${database}`;
  return parsed.href.replace(/\/$/, "");
}

function executable(file: string): string {
  const resolved = fs.realpathSync.native(file);
  if (resolved !== file) throw new Error("reviewed_pg17_tool_unavailable");
  const stat = fs.statSync(resolved);
  const permissions = stat.mode & 0o777;
  if (!stat.isFile() || (permissions !== 0o555 && permissions !== 0o755)
    || (permissions & 0o022) !== 0) throw new Error("reviewed_pg17_tool_unavailable");
  return resolved;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(file: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    env: { LC_ALL: "C", ...env },
    killSignal: "SIGKILL",
    timeout: PROCESS_TIMEOUT_MS,
  });
}

function spawnBounded(
  file: string,
  args: readonly string[],
  env: Record<string, string> = {},
) {
  return spawnSync(file, [...args], {
    encoding: "utf8",
    env: { LC_ALL: "C", ...env },
    killSignal: "SIGKILL",
    timeout: PROCESS_TIMEOUT_MS,
  });
}

interface ReviewedToolEvidence {
  readonly pgDumpVersion: string;
  readonly pgDumpSha256: string;
  readonly pgRestoreVersion: string;
  readonly pgRestoreSha256: string;
}

function assertReviewedTools(): ReviewedToolEvidence {
  const pgDump = executable(PG_DUMP);
  const pgRestore = executable(PG_RESTORE);
  const dumpVersionLine = run(pgDump, ["--version"]).trim();
  const restoreVersionLine = run(pgRestore, ["--version"]).trim();
  const dumpVersion = dumpVersionLine.slice("pg_dump (PostgreSQL) ".length);
  const restoreVersion = restoreVersionLine.slice("pg_restore (PostgreSQL) ".length);
  expect(dumpVersionLine).toBe(`pg_dump (PostgreSQL) ${dumpVersion}`);
  expect(restoreVersionLine).toBe(`pg_restore (PostgreSQL) ${restoreVersion}`);
  expect(dumpVersion).toMatch(/^17\.[^\r\n]{1,120}$/);
  expect(restoreVersion).toMatch(/^17\.[^\r\n]{1,120}$/);
  const dumpSha256 = sha256File(pgDump);
  const restoreSha256 = sha256File(pgRestore);
  if (mode === "service") {
    expect(dumpVersion).toBe(expectedPgDumpVersion);
    expect(restoreVersion).toBe(expectedPgRestoreVersion);
    expect(dumpSha256).toBe(expectedPgDumpSha256);
    expect(restoreSha256).toBe(expectedPgRestoreSha256);
  }
  return Object.freeze({
    pgDumpVersion: dumpVersion,
    pgDumpSha256: dumpSha256,
    pgRestoreVersion: restoreVersion,
    pgRestoreSha256: restoreSha256,
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selected = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 65_535) {
    throw new Error("loopback_port_unavailable");
  }
  return selected;
}

function createSchemaSql(role: string): string {
  return [
    `CREATE SCHEMA pintpath_app AUTHORIZATION ${role}`,
    `CREATE SCHEMA pintpath_ops AUTHORIZATION ${role}`,
    ...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map((entry) => (
      `CREATE TABLE ${entry.schemaName}.${entry.tableName} (probe integer)`
    )),
    ...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map((entry) => (
      `ALTER TABLE ${entry.schemaName}.${entry.tableName} OWNER TO ${role}`
    )),
  ].join("; ");
}

function dumpEnvironment(options: {
  host: string;
  port: string;
  database: string;
  role: string;
  pgpass: string;
}): Record<string, string> {
  return {
    PGHOST: options.host,
    PGHOSTADDR: options.host,
    PGPORT: options.port,
    PGDATABASE: options.database,
    PGUSER: options.role,
    PGSSLMODE: "disable",
    PGSSLROOTCERT: "/dev/null",
    PGSSLMINPROTOCOLVERSION: "TLSv1.2",
    PGSSLSNI: "0",
    PGGSSENCMODE: "disable",
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "pintpath-v4-tool-authority-integration",
    PGPASSFILE: options.pgpass,
    PGREQUIREAUTH: "scram-sha-256",
  };
}

async function proveRawListing(
  archivePath: string,
  evidence: ReviewedToolEvidence,
): Promise<void> {
  const pgRestore = executable(PG_RESTORE);
  fs.chmodSync(archivePath, 0o600);
  const descriptor = fs.openSync(archivePath, "r");
  try {
    const authority = await openPostgresToolAuthority({
      purpose: "list-v4",
      executableFile: pgRestore,
      expectedSha256: evidence.pgRestoreSha256,
    }, runPostgresBackupProcess);
    try {
      await authority.version();
      const observation = await authority.listV4(descriptor);
      const parsed = parsePostgresLogicalBackupV4TocListing(observation.listingBytes);
      expect(parsed.listingSha256).toBe(observation.listingSha256);
      expect(observation.listingByteLength).toBe(observation.listingBytes.length);
      expect(observation.pgRestoreVersion).toBe(evidence.pgRestoreVersion);
      expect(observation.configuredExecutableSha256).toBe(evidence.pgRestoreSha256);
      expect(parsed.unauthenticatedListingProjectionOnly.observedTableDataShape.observedEntries)
        .toHaveLength(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.length);
    } finally {
      await authority.close();
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function runReviewedDump(
  archivePath: string,
  environment: Record<string, string>,
  evidence: ReviewedToolEvidence,
): ReturnType<typeof spawnSync> {
  const pgDump = executable(PG_DUMP);
  expect(sha256File(pgDump)).toBe(evidence.pgDumpSha256);
  expect(run(pgDump, ["--version"]).trim()).toBe(
    `pg_dump (PostgreSQL) ${evidence.pgDumpVersion}`,
  );
  const result = spawnBounded(pgDump, [
    ...POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
    `--file=${archivePath}`,
  ], environment);
  expect(sha256File(pgDump)).toBe(evidence.pgDumpSha256);
  return result;
}

const describeIntegration = mode === "disabled" ? describe.skip : describe;

// Observation only: executable hashes and behavior cannot supply the native
// runtime-closure evidence required by the operational V4 source authority.
describeIntegration("PostgreSQL 17 V4 authentication and raw-list behavior observation", () => {
  it("observes SCRAM enforcement and byte-preserving raw listing in one owned lifecycle", async () => {
    const toolEvidence = assertReviewedTools();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pintpath-v4-tool-pg17-")));
    fs.chmodSync(root, 0o700);
    let dataDirectory = "";
    let isolatedStartAttempted = false;
    let isolatedStarted = false;
    let isolatedHbaBaseline: Buffer | null = null;
    let databaseCreationAttempted = false;
    let roleCreationAttempted = false;
    const archivePath = path.join(root, "probe.dump");
    const refusedArchivePath = path.join(root, "refused.dump");
    const pgpassPath = path.join(root, "pgpass");
    const suffix = crypto.randomBytes(6).toString("hex");
    const serviceDatabase = mode === "service" ? requiredEnvironment(DATABASE_ENV) : "";
    const serviceRole = mode === "service" ? requiredEnvironment(ROLE_ENV) : "";
    const database = mode === "service" ? serviceDatabase : `pintpath_v4_tool_${suffix}`;
    const role = mode === "service" ? serviceRole : `pintpath_v4_backup_${suffix}`;
    let host = "127.0.0.1";
    let port = "5432";
    const fixtureEnvironment = {
      PATH: optionalEnvironment("PATH"),
      PINTPATH_CI_POSTGRES_CONTAINER_ID: optionalEnvironment(CONTAINER_ENV),
      PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_BIN: configuredPgBin,
      PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_DATABASE: database,
      PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ROLE: role,
      RUNNER_TEMP: optionalEnvironment("RUNNER_TEMP"),
    };
    let primaryFailure: unknown = null;
    try {
      expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS).toHaveLength(59);
      if (mode === "isolated") {
        for (const file of [INITDB, PG_CTL, PSQL]) executable(file);
        dataDirectory = path.join(root, "data");
        port = String(await allocateLoopbackPort());
        run(executable(INITDB), [
          "--no-locale", "--encoding=UTF8", "--username=postgres",
          "--auth-local=trust", "--auth-host=trust", "--pgdata", dataDirectory,
        ]);
        fs.writeFileSync(path.join(dataDirectory, "pg_hba.conf"), [
          "local all all trust",
          "host all all 127.0.0.1/32 scram-sha-256",
          "host all all ::1/128 scram-sha-256",
          "",
        ].join("\n"));
        fs.appendFileSync(path.join(dataDirectory, "postgresql.conf"), [
          "listen_addresses = '127.0.0.1'", `port = ${port}`,
          "fsync = on", "synchronous_commit = on", "full_page_writes = on", "max_connections = 20", "",
        ].join("\n"));
        isolatedStartAttempted = true;
        run(executable(PG_CTL), ["-D", dataDirectory, "-l", path.join(root, "postgres.log"), "-w", "start"]);
        isolatedStarted = true;
      } else {
        expect(run(executable(PSQL), [
          requiredEnvironment(ADMIN_URL_ENV), "-X", "-q", "-A", "-t", "--no-password",
          "--set=ON_ERROR_STOP=1", "--command=SHOW server_version_num",
        ])).toBe(`${EXPECTED_SERVER_VERSION_NUM}\n`);
      }

      fs.writeFileSync(pgpassPath, [`${host}:${port}:${database}:${role}:${PASSWORD}`, ""].join("\n"), { mode: 0o600 });
      const adminTarget = mode === "service" ? requiredEnvironment(ADMIN_URL_ENV) : "postgres";
      const adminPrefix = mode === "service"
        ? [adminTarget]
        : ["-h", "/tmp", "-p", port, "-U", "postgres", "-d", "postgres"];
      roleCreationAttempted = true;
      run(executable(PSQL), [
        ...adminPrefix, "-X", "-v", "ON_ERROR_STOP=1",
        "-c", `CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`,
      ]);
      databaseCreationAttempted = true;
      run(executable(PSQL), [
        ...adminPrefix, "-X", "-v", "ON_ERROR_STOP=1",
        "-c", `CREATE DATABASE ${database} OWNER ${role}`,
      ]);
      const databaseAdminPrefix = mode === "service"
        ? [databaseAdminUrl(database)]
        : ["-h", "/tmp", "-p", port, "-U", "postgres", "-d", database];
      run(executable(PSQL), [
        ...databaseAdminPrefix, "-X", "-v", "ON_ERROR_STOP=1", "-c", createSchemaSql(role),
      ]);
      expect(run(executable(PSQL), [
        ...databaseAdminPrefix, "-X", "-q", "-A", "-t", "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--command=SELECT pg_catalog.count(*) FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname IN ('pintpath_app', 'pintpath_ops') AND relation.relkind = 'r'",
      ])).toBe(`${POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.length}\n`);

      const environment = dumpEnvironment({ host, port, database, role, pgpass: pgpassPath });
      const first = runReviewedDump(archivePath, environment, toolEvidence);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe("");
      expect(first.stderr).toBe("");
      expect(fs.statSync(archivePath).size).toBeGreaterThan(0);

      if (mode === "isolated") {
        const hba = path.join(dataDirectory, "pg_hba.conf");
        const baseline = fs.readFileSync(hba);
        isolatedHbaBaseline = Buffer.from(baseline);
        fs.writeFileSync(hba, Buffer.concat([
          Buffer.from(`hostnossl ${database} ${role} 127.0.0.1/32 trust\n`, "utf8"), baseline,
        ]));
        run(executable(PG_CTL), ["-D", dataDirectory, "reload"]);
      } else {
        // Arm recovery before activation because a partial helper failure may
        // already have replaced the exact HBA path.
        run(HBA_FIXTURE, ["activate"], fixtureEnvironment);
      }
      const hbaAdminPrefix = mode === "service"
        ? [requiredEnvironment(ADMIN_URL_ENV)]
        : ["-h", "/tmp", "-p", port, "-U", "postgres", "-d", "postgres"];
      const expectedHbaAddress = mode === "service"
        ? run(executable(PSQL), [
          ...hbaAdminPrefix, "-X", "-q", "-A", "-t", "--no-password",
          "--set=ON_ERROR_STOP=1", "--command=SELECT pg_catalog.inet_client_addr()::text",
        ]).trim()
        : "127.0.0.1";
      expect(net.isIPv4(expectedHbaAddress)).toBe(true);
      expect(run(executable(PSQL), [
        ...hbaAdminPrefix, "-X", "-q", "-A", "-t", "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--command=SELECT type, database[1], user_name[1], address, netmask, auth_method FROM pg_catalog.pg_hba_file_rules WHERE line_number = 1",
      ])).toBe(`hostnossl|${database}|${role}|${expectedHbaAddress}|255.255.255.255|trust\n`);
      const refused = runReviewedDump(refusedArchivePath, environment, toolEvidence);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("authentication method requirement");
      expect(refused.stderr).toContain("server did not complete authentication");

      if (mode === "isolated") {
        const hba = path.join(dataDirectory, "pg_hba.conf");
        if (isolatedHbaBaseline === null) throw new Error("isolated_hba_baseline_missing");
        fs.writeFileSync(hba, isolatedHbaBaseline);
        run(executable(PG_CTL), ["-D", dataDirectory, "reload"]);
      } else {
        run(HBA_FIXTURE, ["restore"], fixtureEnvironment);
      }
      expect(run(executable(PSQL), [
        ...hbaAdminPrefix, "-X", "-q", "-A", "-t", "--no-password",
        "--set=ON_ERROR_STOP=1",
        `--command=SELECT pg_catalog.count(*) FROM pg_catalog.pg_hba_file_rules WHERE type = 'hostnossl' AND database[1] = '${database}' AND user_name[1] = '${role}' AND address = '${expectedHbaAddress}' AND netmask = '255.255.255.255' AND auth_method = 'trust'`,
      ])).toBe("0\n");
      const afterRestorePath = path.join(root, "after-restore.dump");
      const afterRestore = runReviewedDump(afterRestorePath, environment, toolEvidence);
      expect(afterRestore.status, afterRestore.stderr).toBe(0);
      expect(afterRestore.stdout).toBe("");
      expect(afterRestore.stderr).toBe("");
      await proveRawListing(archivePath, toolEvidence);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      let cleanupFailure: unknown = null;
      try {
        if (mode === "service") {
          const restore = spawnBounded(HBA_FIXTURE, ["restore"], fixtureEnvironment);
          if (restore.status !== 0) throw new Error("service_hba_restore_failed");
        } else if (isolatedStarted && isolatedHbaBaseline !== null) {
          fs.writeFileSync(path.join(dataDirectory, "pg_hba.conf"), isolatedHbaBaseline);
          run(executable(PG_CTL), ["-D", dataDirectory, "reload"]);
        }
      } catch (error) {
        cleanupFailure = error;
      }
      try {
        if (databaseCreationAttempted || roleCreationAttempted) {
          const adminPrefix = mode === "service"
            ? [requiredEnvironment(ADMIN_URL_ENV)]
            : ["-h", "/tmp", "-p", port, "-U", "postgres", "-d", "postgres"];
          if (databaseCreationAttempted) {
            spawnBounded(executable(PSQL), [
              ...adminPrefix, "-X", "-v", "ON_ERROR_STOP=1",
              "-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
            ]);
          }
          if (roleCreationAttempted) {
            spawnBounded(executable(PSQL), [
              ...adminPrefix, "-X", "-v", "ON_ERROR_STOP=1",
              "-c", `DROP ROLE IF EXISTS ${role}`,
            ]);
          }
          const remainingObjects = spawnBounded(executable(PSQL), [
            ...adminPrefix, "-X", "-q", "-A", "-t", "--no-password",
            "--set=ON_ERROR_STOP=1",
            `--command=SELECT (SELECT pg_catalog.count(*) FROM pg_catalog.pg_database WHERE datname = '${database}'), (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname = '${role}')`,
          ]);
          if (remainingObjects.status !== 0 || remainingObjects.signal !== null
            || remainingObjects.error !== undefined || remainingObjects.stdout !== "0|0\n") {
            cleanupFailure ??= new Error("service_objects_cleanup_incomplete");
          }
        }
      } catch (error) {
        cleanupFailure ??= error;
      }
      let isolatedServerQuiescent = !isolatedStartAttempted;
      try {
        if (isolatedStartAttempted) {
          const pgCtl = executable(PG_CTL);
          const status = spawnBounded(pgCtl, ["-D", dataDirectory, "status"]);
          if (status.status !== 3) {
            spawnBounded(pgCtl, ["-D", dataDirectory, "-m", "immediate", "-w", "stop"]);
          }
          const finalStatus = spawnBounded(pgCtl, ["-D", dataDirectory, "status"]);
          isolatedServerQuiescent = finalStatus.status === 3
            && finalStatus.signal === null && finalStatus.error === undefined;
          if (!isolatedServerQuiescent) throw new Error("isolated_postgres_stop_failed");
        }
      } catch (error) {
        cleanupFailure ??= error;
      }
      if (isolatedServerQuiescent) {
        fs.rmSync(root, { recursive: true, force: true });
      }
      if (primaryFailure === null && cleanupFailure !== null) throw cleanupFailure;
    }
  }, 120_000);
});
