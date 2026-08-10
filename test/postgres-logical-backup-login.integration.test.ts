import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, type ClientConfig, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT,
  POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV,
  POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
  POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV,
  POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV,
  managePostgresLogicalBackupLogin,
  postgresLogicalBackupLoginMutationArm,
  type PostgresLogicalBackupLoginConnection,
  type PostgresLogicalBackupLoginDependencies,
  type PostgresLogicalBackupLoginManagerOptions,
} from "../src/lib/postgres-logical-backup-login.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_TEST_ADMIN_URL";
const SERVER_LOG_ENV = "PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_TEST_SERVER_LOG";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredServerLog = process.env[SERVER_LOG_ENV]?.trim() ?? "";
const uniqueSuffix = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const databaseName = `pintpath_login_manager_${uniqueSuffix}`;
const loginVersion = `${Date.now()}${process.pid}`.slice(0, 20);
const headSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const schemaPath = path.resolve("src/db/postgres-schema.sql");
const uid = process.getuid?.() ?? 501;
const logProbe = `pintpath_backup_login_log_probe_${uniqueSuffix}`;

interface ServerLogBinding {
  readonly canonicalPath: string;
  readonly dataDirectory: string;
  readonly relativePath: string;
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly startOffset: bigint;
}

interface ServerLogSettingsRow extends QueryResultRow {
  readonly loggingCollector: string;
  readonly logDestination: string;
  readonly logStatement: string;
  readonly logMinDurationStatement: string;
  readonly logMinErrorStatement: string;
  readonly logParameterMaxLength: string;
  readonly logParameterMaxLengthOnError: string;
  readonly dataDirectory: string;
  readonly currentLogFile: string | null;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
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
  ) throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
  return url;
}

function withDatabase(url: URL, database: string): URL {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result;
}

function verifyingAuthorityUrl(actual: URL, database: string): string {
  const result = withDatabase(actual, database);
  result.search = "?sslmode=verify-full";
  return result.toString();
}

async function readServerLogSettings(client: Client): Promise<ServerLogSettingsRow> {
  const result = await client.query<ServerLogSettingsRow>(`SELECT
    pg_catalog.current_setting('logging_collector') AS "loggingCollector",
    pg_catalog.current_setting('log_destination') AS "logDestination",
    pg_catalog.current_setting('log_statement') AS "logStatement",
    pg_catalog.current_setting('log_min_duration_statement') AS "logMinDurationStatement",
    pg_catalog.current_setting('log_min_error_statement') AS "logMinErrorStatement",
    pg_catalog.current_setting('log_parameter_max_length') AS "logParameterMaxLength",
    pg_catalog.current_setting('log_parameter_max_length_on_error')
      AS "logParameterMaxLengthOnError",
    pg_catalog.current_setting('data_directory') AS "dataDirectory",
    pg_catalog.pg_current_logfile('stderr') AS "currentLogFile"`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw new Error("server_log_settings_unavailable");
  if (
    row.loggingCollector !== "on"
    || row.logDestination !== "stderr"
    || row.logStatement !== "all"
    || row.logMinDurationStatement !== "0"
    || row.logMinErrorStatement !== "error"
    || row.logParameterMaxLength !== "-1"
    || row.logParameterMaxLengthOnError !== "-1"
    || !path.isAbsolute(row.dataDirectory)
    || !row.currentLogFile
  ) throw new Error("server_log_settings_not_adversarial");
  return row;
}

function resolveReportedServerLog(settings: ServerLogSettingsRow): string {
  if (!settings.currentLogFile) throw new Error("server_log_path_unavailable");
  return path.isAbsolute(settings.currentLogFile)
    ? path.normalize(settings.currentLogFile)
    : path.resolve(settings.dataDirectory, settings.currentLogFile);
}

function assertRegularOwnedLogFile(stat: fs.BigIntStats): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== BigInt(uid)
    || stat.nlink !== 1n
    || (stat.mode & 0o077n) !== 0n
  ) throw new Error("server_log_file_untrusted");
}

async function bindServerLog(client: Client, configuredPath: string): Promise<ServerLogBinding> {
  if (
    !path.isAbsolute(configuredPath)
    || path.normalize(configuredPath) !== configuredPath
  ) throw new Error(`${SERVER_LOG_ENV} must be a canonical absolute PostgreSQL server-log path.`);
  const settings = await readServerLogSettings(client);
  const reportedPath = resolveReportedServerLog(settings);
  const configuredLstat = fs.lstatSync(configuredPath, { bigint: true });
  assertRegularOwnedLogFile(configuredLstat);
  const configuredCanonical = fs.realpathSync(configuredPath);
  const reportedCanonical = fs.realpathSync(reportedPath);
  if (
    configuredCanonical !== configuredPath
    || reportedCanonical !== configuredCanonical
  ) throw new Error("configured_server_log_is_not_current_logfile");

  const fd = fs.openSync(
    configuredPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const descriptorStat = fs.fstatSync(fd, { bigint: true });
    assertRegularOwnedLogFile(descriptorStat);
    if (
      configuredLstat.dev !== descriptorStat.dev
      || configuredLstat.ino !== descriptorStat.ino
    ) throw new Error("server_log_inode_changed_during_bind");
    return {
      canonicalPath: configuredCanonical,
      dataDirectory: fs.realpathSync(settings.dataDirectory),
      relativePath: settings.currentLogFile,
      fd,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      startOffset: descriptorStat.size,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertBoundServerLogInode(binding: ServerLogBinding): fs.BigIntStats {
  const descriptorStat = fs.fstatSync(binding.fd, { bigint: true });
  const pathStat = fs.lstatSync(binding.canonicalPath, { bigint: true });
  assertRegularOwnedLogFile(descriptorStat);
  assertRegularOwnedLogFile(pathStat);
  if (
    descriptorStat.dev !== binding.device
    || descriptorStat.ino !== binding.inode
    || pathStat.dev !== binding.device
    || pathStat.ino !== binding.inode
    || descriptorStat.size < binding.startOffset
  ) throw new Error("bound_server_log_inode_changed");
  return descriptorStat;
}

async function assertServerLogStillCurrent(
  client: Client,
  binding: ServerLogBinding,
): Promise<void> {
  const settings = await readServerLogSettings(client);
  if (
    fs.realpathSync(settings.dataDirectory) !== binding.dataDirectory
    || settings.currentLogFile !== binding.relativePath
    || fs.realpathSync(resolveReportedServerLog(settings)) !== binding.canonicalPath
  ) throw new Error("current_server_log_changed");
  assertBoundServerLogInode(binding);
}

function readBoundServerLog(binding: ServerLogBinding): string {
  const stat = assertBoundServerLogInode(binding);
  const byteLength = stat.size - binding.startOffset;
  if (byteLength > 128n * 1024n * 1024n || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("bound_server_log_too_large");
  }
  const output = Buffer.alloc(Number(byteLength));
  let read = 0;
  while (read < output.byteLength) {
    const count = fs.readSync(
      binding.fd,
      output,
      read,
      output.byteLength - read,
      Number(binding.startOffset) + read,
    );
    if (count === 0) throw new Error("bound_server_log_short_read");
    read += count;
  }
  return output.toString("utf8");
}

async function waitForBoundServerLogText(
  binding: ServerLogBinding,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  do {
    const log = readBoundServerLog(binding);
    if (log.includes(expected)) return log;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`bound_server_log_missing_${expected}`);
}

class TestConnection implements PostgresLogicalBackupLoginConnection {
  private method: "scram-sha-256" | "other" | "unknown" = "unknown";

  private constructor(
    private readonly client: Client,
    private readonly sensitiveValues: string[],
    private readonly forceVerifierBindFailure: boolean,
    private readonly onForcedVerifierBind: () => void,
    private readonly onCandidateOid: (roleName: string, oid: string) => void,
  ) {}

  static async connect(
    config: ClientConfig,
    actual: URL,
    sensitiveValues: string[],
    forceVerifierBindFailure: boolean,
    onForcedVerifierBind: () => void,
    onCandidateOid: (roleName: string, oid: string) => void,
  ): Promise<TestConnection> {
    const client = new Client({
      host: actual.hostname,
      port: Number(actual.port || "5432"),
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: false,
      application_name: config.application_name,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      query_timeout: config.query_timeout,
      statement_timeout: config.statement_timeout,
    });
    const result = new TestConnection(
      client,
      sensitiveValues,
      forceVerifierBindFailure,
      onForcedVerifierBind,
      onCandidateOid,
    );
    const wire = (client as unknown as {
      connection?: { on: (event: string, listener: () => void) => void };
    }).connection;
    wire?.on("authenticationSASL", () => { result.method = "scram-sha-256"; });
    wire?.on("authenticationSASLContinue", () => { result.method = "scram-sha-256"; });
    wire?.on("authenticationCleartextPassword", () => { result.method = "other"; });
    wire?.on("authenticationMD5Password", () => { result.method = "other"; });
    await client.connect();
    return result;
  }

  get authenticationMethod(): "scram-sha-256" | "other" | "unknown" {
    return this.method;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    let effectiveValues = [...values];
    if (text.includes("backup-login:bind-verifier")) {
      const verifier = values[2];
      if (typeof verifier === "string") this.sensitiveValues.push(verifier);
      if (this.forceVerifierBindFailure) {
        this.onForcedVerifierBind();
        effectiveValues = [values[0], "pintpath_forced_verifier_bind_failure", values[2]];
      }
    }
    const result = await this.client.query<Row>(text, effectiveValues);
    if (
      text.includes('role.oid::text AS "oid"')
      && values.length === 1
      && typeof values[0] === "string"
      && typeof result.rows[0]?.oid === "string"
      && /^[1-9][0-9]{0,9}$/.test(result.rows[0].oid)
    ) this.onCandidateOid(values[0], result.rows[0].oid);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

const integration = configuredAdminUrl ? describe : describe.skip;

integration("PostgreSQL 17 logical-backup LOGIN manager", () => {
  let maintenance: Client | undefined;
  let databaseAdmin: Client | undefined;
  let actualAdminUrl: URL;
  let root = "";
  let adminConnectionFile = "";
  let adminAuthorityUrl = "";
  let databaseIdentitySha256 = "";
  let databaseOid = "";
  let groupRole = "";
  let loginRole = "";
  let serverLogBinding: ServerLogBinding | undefined;
  let forceVerifierBindFailure = false;
  let forcedVerifierBindObserved = false;
  let schemaRoleOidsRecorded = false;
  const createdRoleOids = new Map<string, string>();
  const observedCandidateRoleOids = new Map<string, Set<string>>();
  const sensitiveValues: string[] = [];

  const connect: PostgresLogicalBackupLoginDependencies["connect"] = async (config) => {
    const password = config.password;
    if (typeof password === "string") sensitiveValues.push(password);
    return TestConnection.connect(
      config,
      actualAdminUrl,
      sensitiveValues,
      forceVerifierBindFailure,
      () => { forcedVerifierBindObserved = true; },
      (roleName, oid) => {
        const oids = observedCandidateRoleOids.get(roleName) ?? new Set<string>();
        oids.add(oid);
        observedCandidateRoleOids.set(roleName, oids);
      },
    );
  };

  function options(
    operation: "provision" | "retire",
    provisionReceiptSha256?: string,
  ): PostgresLogicalBackupLoginManagerOptions {
    const common: PostgresLogicalBackupLoginManagerOptions = {
      operation,
      adminConnectionFile,
      expectedAdminUrlSha256: sha256(adminAuthorityUrl),
      expectedDatabaseIdentitySha256: databaseIdentitySha256,
      expectedHeadSha: headSha,
      expectedTreeSha: treeSha,
      expectedUid: uid,
      expectedNodeVersion: process.version,
      expectedEnvironment: POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT,
      operationId: `${operation}-integration-${uniqueSuffix}`,
      approvalReference: `approval:integration:${operation}:${uniqueSuffix}`,
      loginVersion,
      escrowDirectory: path.join(root, "escrow"),
      receiptFile: path.join(root, `${operation}-receipt.json`),
      ...(operation === "retire" ? {
        provisionReceiptFile: path.join(root, "provision-receipt.json"),
        expectedProvisionReceiptSha256: provisionReceiptSha256,
      } : {}),
    };
    return common;
  }

  function dependencies(
    managerOptions: PostgresLogicalBackupLoginManagerOptions,
  ): Partial<PostgresLogicalBackupLoginDependencies> {
    return {
      env: {
        NODE_ENV: "production",
        [POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV]: managerOptions.expectedEnvironment,
        [POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV]: managerOptions.operation,
        [POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV]:
          postgresLogicalBackupLoginMutationArm(managerOptions),
      },
      getUid: () => uid,
      getEuid: () => uid,
      nodeVersion: process.version,
      repositoryRoot: process.cwd(),
      inspectRepository: async () => ({
        headSha,
        treeSha,
        upstreamSha: headSha,
        clean: true,
        root: fs.realpathSync(process.cwd()),
        coreRepositoryFormatVersion: "0",
        coreBare: "false",
        hooksPathAbsent: true,
        fsmonitorAbsentOrFalse: true,
      }),
      connect,
    };
  }

  beforeAll(async () => {
    actualAdminUrl = validateAdminUrl(configuredAdminUrl);
    if (!configuredServerLog || !path.isAbsolute(configuredServerLog)) {
      throw new Error(`${SERVER_LOG_ENV} must be an absolute PostgreSQL server-log path.`);
    }
    maintenance = new Client({ connectionString: actualAdminUrl.toString() });
    await maintenance.connect();

    const clusterOwner = await maintenance.query<{
      currentUser: string;
      sessionUser: string;
      superuser: boolean;
      ownsMaintenanceDatabase: boolean;
    }>(`SELECT
      CURRENT_USER AS "currentUser",
      SESSION_USER AS "sessionUser",
      role.rolsuper AS superuser,
      database.datdba = role.oid AS "ownsMaintenanceDatabase"
      FROM pg_catalog.pg_roles AS role
      CROSS JOIN pg_catalog.pg_database AS database
      WHERE role.rolname = CURRENT_USER
        AND database.datname = pg_catalog.current_database()`);
    const owner = clusterOwner.rows[0];
    if (
      clusterOwner.rows.length !== 1
      || !owner
      || owner.currentUser !== actualAdminUrl.username
      || owner.sessionUser !== owner.currentUser
      || !owner.superuser
      || !owner.ownsMaintenanceDatabase
    ) throw new Error("disposable_cluster_not_owned_by_test_principal");

    const databasePrestate = await maintenance.query<{ name: string }>(`SELECT datname AS name
      FROM pg_catalog.pg_database
      WHERE datallowconn AND NOT datistemplate
      ORDER BY datname`);
    if (
      databasePrestate.rows.length !== 1
      || databasePrestate.rows[0]?.name !== "postgres"
    ) throw new Error("disposable_cluster_database_prestate_not_empty");
    const rolePrestate = await maintenance.query<{ name: string }>(`SELECT rolname AS name
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('pintpath_runtime', 'pintpath_migrator')
        OR rolname LIKE 'pintpath_logical_backup_d%'
      ORDER BY rolname`);
    if (rolePrestate.rows.length !== 0) {
      throw new Error("disposable_cluster_role_prestate_not_empty");
    }

    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const createdDatabase = await maintenance.query<{ oid: string; owned: boolean }>(`SELECT
      database.oid::text AS oid,
      database.datdba = role.oid AS owned
      FROM pg_catalog.pg_database AS database
      CROSS JOIN pg_catalog.pg_roles AS role
      WHERE database.datname = $1
        AND role.rolname = CURRENT_USER`, [databaseName]);
    const createdDatabaseRow = createdDatabase.rows[0];
    if (
      createdDatabase.rows.length !== 1
      || !createdDatabaseRow
      || !/^[1-9][0-9]{0,9}$/.test(createdDatabaseRow.oid)
      || !createdDatabaseRow.owned
    ) throw new Error("created_database_identity_invalid");
    databaseOid = createdDatabaseRow.oid;

    databaseAdmin = new Client({ connectionString: withDatabase(actualAdminUrl, databaseName).toString() });
    await databaseAdmin.connect();
    const targetPrestate = await databaseAdmin.query<{ count: number }>(`SELECT count(*)::integer AS count
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND namespace.nspname NOT IN ('information_schema')`);
    if (targetPrestate.rows[0]?.count !== 0 || targetPrestate.rows.length !== 1) {
      throw new Error("created_database_object_prestate_not_empty");
    }
    await databaseAdmin.query(fs.readFileSync(schemaPath, "utf8"));
    const identity = await databaseAdmin.query<{
      systemIdentifier: string;
      databaseOid: string;
      databaseName: string;
      serverVersionNum: string;
    }>(`SELECT
      control.system_identifier::text AS "systemIdentifier",
      database.oid::text AS "databaseOid",
      pg_catalog.current_database() AS "databaseName",
      pg_catalog.current_setting('server_version_num') AS "serverVersionNum"
      FROM pg_catalog.pg_database AS database
      CROSS JOIN pg_catalog.pg_control_system() AS control
      WHERE database.datname = pg_catalog.current_database()`);
    const row = identity.rows[0];
    if (!row || identity.rows.length !== 1) throw new Error("test_identity_unavailable");
    if (row.databaseOid !== databaseOid) throw new Error("created_database_oid_changed");
    groupRole = `pintpath_logical_backup_d${databaseOid}`;
    loginRole = `${groupRole}_v${loginVersion}`;
    const schemaRoles = await databaseAdmin.query<{ name: string; oid: string }>(`SELECT
      role.rolname AS name,
      role.oid::text AS oid
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ANY($1::name[])
      ORDER BY role.rolname`, [["pintpath_runtime", "pintpath_migrator", groupRole]]);
    if (
      schemaRoles.rows.length !== 3
      || schemaRoles.rows.some((role) => !/^[1-9][0-9]{0,9}$/.test(role.oid))
      || new Set(schemaRoles.rows.map((role) => role.name)).size !== 3
    ) throw new Error("schema_created_role_identity_invalid");
    for (const role of schemaRoles.rows) createdRoleOids.set(role.name, role.oid);
    schemaRoleOidsRecorded = true;
    databaseIdentitySha256 = sha256(canonicalPostgresBackupJson({
      kind: "pintpath-postgres-logical-source-database",
      version: 1,
      systemIdentifier: row.systemIdentifier,
      databaseOid: row.databaseOid,
      databaseName: row.databaseName,
      serverVersionNum: row.serverVersionNum,
    }));
    root = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-backup-login-integration-"),
    ));
    fs.chmodSync(root, 0o700);
    adminAuthorityUrl = verifyingAuthorityUrl(actualAdminUrl, databaseName);
    adminConnectionFile = path.join(root, "admin-url.key");
    fs.writeFileSync(adminConnectionFile, `${adminAuthorityUrl}\n`, { mode: 0o600 });
    fs.chmodSync(adminConnectionFile, 0o600);
    sensitiveValues.push(
      configuredAdminUrl,
      actualAdminUrl.toString(),
      adminAuthorityUrl,
      actualAdminUrl.password,
      decodeURIComponent(actualAdminUrl.password),
    );
    serverLogBinding = await bindServerLog(databaseAdmin, configuredServerLog);
    await databaseAdmin.query(`/* ${logProbe} */ SELECT 1`);
  }, 120_000);

  async function dropCreatedDatabaseExact(client: Client): Promise<void> {
    if (!databaseOid) return;
    const current = await client.query<{ oid: string }>(`SELECT oid::text AS oid
      FROM pg_catalog.pg_database WHERE datname = $1`, [databaseName]);
    if (current.rows.length !== 1 || current.rows[0]?.oid !== databaseOid) {
      throw new Error("cleanup_database_identity_drift");
    }
    await client.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    const after = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1
    ) AS present`, [databaseName]);
    if (after.rows.length !== 1 || after.rows[0]?.present !== false) {
      throw new Error("cleanup_database_drop_unverified");
    }
  }

  async function dropCreatedRolesExact(client: Client): Promise<void> {
    const allowed = new Map<string, Set<string>>();
    for (const [name, oid] of createdRoleOids) allowed.set(name, new Set([oid]));
    if (loginRole) {
      const observed = observedCandidateRoleOids.get(loginRole);
      if (observed?.size) allowed.set(loginRole, new Set(observed));
    }
    const inventory = await client.query<{ name: string; oid: string }>(`SELECT
      rolname AS name, oid::text AS oid
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('pintpath_runtime', 'pintpath_migrator')
        OR rolname LIKE 'pintpath_logical_backup_d%'
      ORDER BY rolname`);
    for (const role of inventory.rows) {
      if (!allowed.get(role.name)?.has(role.oid)) {
        throw new Error("cleanup_role_identity_drift");
      }
    }
    if (schemaRoleOidsRecorded) {
      for (const name of ["pintpath_runtime", "pintpath_migrator", groupRole]) {
        const oid = createdRoleOids.get(name);
        if (!oid || !inventory.rows.some((role) => role.name === name && role.oid === oid)) {
          throw new Error("cleanup_created_role_missing");
        }
      }
    }
    const dropOrder = [
      ...inventory.rows.filter((role) => role.name === loginRole),
      ...inventory.rows.filter((role) => role.name === groupRole),
      ...inventory.rows.filter((role) => role.name === "pintpath_runtime"),
      ...inventory.rows.filter((role) => role.name === "pintpath_migrator"),
    ];
    if (dropOrder.length !== inventory.rows.length) {
      throw new Error("cleanup_role_inventory_unaccounted");
    }
    for (const role of dropOrder) {
      const current = await client.query<{ oid: string }>(`SELECT oid::text AS oid
        FROM pg_catalog.pg_roles WHERE rolname = $1`, [role.name]);
      if (current.rows.length !== 1 || current.rows[0]?.oid !== role.oid) {
        throw new Error("cleanup_role_identity_changed_before_drop");
      }
      await client.query(`DROP ROLE ${quoteIdentifier(role.name)}`);
    }
    const after = await client.query<{ count: number }>(`SELECT count(*)::integer AS count
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('pintpath_runtime', 'pintpath_migrator')
        OR rolname LIKE 'pintpath_logical_backup_d%'`);
    if (after.rows.length !== 1 || after.rows[0]?.count !== 0) {
      throw new Error("cleanup_role_drop_unverified");
    }
  }

  afterAll(async () => {
    const cleanupFailures: unknown[] = [];
    const capture = async (action: () => Promise<void> | void): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    await capture(async () => { await databaseAdmin?.end(); });
    if (maintenance) {
      await capture(async () => { await dropCreatedDatabaseExact(maintenance as Client); });
      await capture(async () => { await dropCreatedRolesExact(maintenance as Client); });
      await capture(async () => { await maintenance?.end(); });
    }
    if (serverLogBinding) {
      await capture(() => { fs.closeSync((serverLogBinding as ServerLogBinding).fd); });
    }
    if (root) {
      await capture(() => {
        if (fs.realpathSync(root) !== root || !path.basename(root).startsWith("pintpath-backup-login-integration-")) {
          throw new Error("cleanup_temp_root_identity_drift");
        }
        fs.rmSync(root, { recursive: true, force: false });
      });
    }
    if (cleanupFailures.length) {
      throw new AggregateError(cleanupFailures, "postgres_backup_login_integration_cleanup_failed");
    }
  }, 60_000);

  it("provisions with SCRAM, suppresses verifier logging, and retires by exact OID", async () => {
    if (!databaseAdmin || !serverLogBinding) throw new Error("integration_fixture_unavailable");
    const boundLog = serverLogBinding;
    const initialLog = await waitForBoundServerLogText(boundLog, logProbe);
    expect(initialLog.includes(logProbe)).toBe(true);

    const provision = options("provision");
    forceVerifierBindFailure = true;
    try {
      await expect(managePostgresLogicalBackupLogin(
        provision,
        dependencies(provision),
      )).rejects.toBeDefined();
    } finally {
      forceVerifierBindFailure = false;
    }
    expect(forcedVerifierBindObserved).toBe(true);
    const forcedFailureEscrowRaw = fs.readFileSync(path.join(
      provision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    ), "utf8").trim();
    const forcedFailureEscrowUrl = new URL(forcedFailureEscrowRaw);
    sensitiveValues.push(
      forcedFailureEscrowRaw,
      forcedFailureEscrowUrl.password,
      decodeURIComponent(forcedFailureEscrowUrl.password),
    );
    const rolledBack = await databaseAdmin.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present",
      [loginRole],
    );
    expect(rolledBack.rows).toEqual([{ present: false }]);
    await assertServerLogStillCurrent(databaseAdmin, boundLog);
    const forcedFailureLog = await waitForBoundServerLogText(
      boundLog,
      "pintpath:backup-login:logger-inventory",
    );
    expect(
      [...new Set(sensitiveValues)].filter(Boolean)
        .some((value) => forcedFailureLog.includes(value)),
    ).toBe(false);

    const provisioned = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision),
    );
    expect(provisioned.receipt).toMatchObject({
      operation: "provision",
      status: "provisioned",
      databaseOid,
      groupRole,
      loginRole,
      authorityPolicyCount: 236,
      authorityDependencyCount: 61,
      canary: { saslScramSha256: true, setRole: true, readOnly: true },
    });
    createdRoleOids.set(loginRole, provisioned.receipt.loginRoleOid);
    const active = await databaseAdmin.query<{
      oid: string;
      canLogin: boolean;
      validUntilIsNull: boolean;
      dependencyCount: number;
      membershipCount: number;
    }>(`SELECT
      role.oid::text AS oid,
      role.rolcanlogin AS "canLogin",
      (role.rolvaliduntil IS NULL) AS "validUntilIsNull",
      (SELECT count(*)::integer FROM pg_catalog.pg_shdepend AS dependency
        WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND dependency.refobjid = role.oid) AS "dependencyCount",
      (SELECT count(*)::integer FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = role.oid) AS "membershipCount"
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = $1`, [loginRole]);
    expect(active.rows).toEqual([{
      oid: provisioned.receipt.loginRoleOid,
      canLogin: true,
      validUntilIsNull: true,
      dependencyCount: 2,
      membershipCount: 1,
    }]);
    expect(fs.statSync(path.join(
      provision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    )).mode & 0o7777).toBe(0o600);

    const candidateConfig = [...sensitiveValues];
    const escrowUrl = new URL(fs.readFileSync(path.join(
      provision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    ), "utf8").trim());
    candidateConfig.push(
      escrowUrl.toString(),
      escrowUrl.password,
      decodeURIComponent(escrowUrl.password),
    );
    const liveCandidate = new Client({
      host: actualAdminUrl.hostname,
      port: Number(actualAdminUrl.port || "5432"),
      database: databaseName,
      user: loginRole,
      password: decodeURIComponent(escrowUrl.password),
      ssl: false,
    });
    let candidateTerminationObserved = false;
    liveCandidate.on("error", () => { candidateTerminationObserved = true; });
    await liveCandidate.connect();
    const retirement = options("retire", provisioned.receiptSha256);
    const retired = await managePostgresLogicalBackupLogin(
      retirement,
      dependencies(retirement),
    );
    await expect(liveCandidate.query("SELECT 1")).rejects.toBeDefined();
    expect(candidateTerminationObserved).toBe(true);
    await liveCandidate.end();
    expect(retired.receipt).toMatchObject({
      operation: "retire",
      status: "retired",
      loginRoleOid: provisioned.receipt.loginRoleOid,
      canary: { saslScramSha256: false, setRole: false, readOnly: false },
      provisionReceiptSha256: provisioned.receiptSha256,
    });
    const absent = await databaseAdmin.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present",
      [loginRole],
    );
    expect(absent.rows).toEqual([{ present: false }]);

    await assertServerLogStillCurrent(databaseAdmin, boundLog);
    await databaseAdmin.query(`/* ${logProbe}_complete */ SELECT 1`);
    const log = await waitForBoundServerLogText(boundLog, `${logProbe}_complete`);
    expect(log.includes("pintpath:backup-login:logger-inventory")).toBe(true);
    const leaked = [...new Set([...sensitiveValues, ...candidateConfig])]
      .filter(Boolean)
      .some((value) => log.includes(value));
    expect(leaked).toBe(false);
  }, 120_000);
});
