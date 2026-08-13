import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  buildPostgresLogicalBackupV4SnapshotHandoffBinding,
  buildPostgresLogicalBackupV4SourceAuthorityReceipt,
  buildPostgresLogicalBackupV4SourceCaptureBinding,
  canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson,
  parsePostgresLogicalBackupV4SourceAuthorityReceipt,
  POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
  postgresLogicalBackupV4SourceAuthorityReceiptSha256,
} from "../src/lib/postgres-logical-backup-v4-source-authority.js";
import { sha256PostgresDatabaseIdentity } from "../src/lib/postgres-database-identity.js";
import {
  capturePostgresLogicalStateV2,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateV2Connection,
} from "../src/lib/postgres-logical-state.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const databaseName = `pintpath_v4_authority_${suffix}`;
const schemaSql = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
const kernelSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
), "utf8");

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
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== 'postgres'
    || !url.username || !url.password
    || url.searchParams.get('sslmode') !== 'disable'
    || [...url.searchParams.keys()].some((key) => key !== 'sslmode')
    || url.hash || /[\r\n\0]/.test(value)) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function quoteLiteral(value: string): string {
  if (/[/\r\n\0]/.test(value)) throw new Error("unsafe_test_literal");
  return `'${value.replaceAll("'", "''")}'`;
}

function asV2Connection(client: Client): PostgresLogicalStateV2Connection {
  if (!Number.isSafeInteger(client.processID) || client.processID < 1) {
    throw new Error("test_backend_pid_unavailable");
  }
  return client as Client & PostgresLogicalStateV2Connection;
}

function hashBytes(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceHash(kind: string, value: unknown): string {
  return sha256CanonicalPostgresLogicalState({ kind, version: 1, value });
}

class AuthenticatedClient {
  readonly client: Client;
  private method: "scram-sha-256" | "other" | "unknown" = "unknown";
  private fatal = false;

  private constructor(config: ConstructorParameters<typeof Client>[0]) {
    this.client = new Client(config);
    this.client.on("error", () => { this.fatal = true; });
    const wire = (this.client as unknown as {
      connection?: { on: (event: string, listener: () => void) => void };
    }).connection;
    wire?.on("authenticationSASL", () => { this.method = "scram-sha-256"; });
    wire?.on("authenticationSASLContinue", () => { this.method = "scram-sha-256"; });
    wire?.on("authenticationCleartextPassword", () => { this.method = "other"; });
    wire?.on("authenticationMD5Password", () => { this.method = "other"; });
  }

  static async connect(config: ConstructorParameters<typeof Client>[0]): Promise<AuthenticatedClient> {
    const result = new AuthenticatedClient(config);
    await result.client.connect();
    return result;
  }

  get authenticationMethod(): "scram-sha-256" | "other" | "unknown" {
    return this.method;
  }

  get transportFailed(): boolean {
    return this.fatal;
  }
}

function now(): string {
  return new Date().toISOString();
}

async function waitForZeroActiveSessions(admin: Client, roleOid: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const active = await admin.query<{ activeSessionCount: number }>(
      `SELECT count(*)::integer AS "activeSessionCount"
       FROM pg_catalog.pg_stat_activity AS activity
       WHERE activity.usesysid = $1::oid
         AND activity.pid <> pg_catalog.pg_backend_pid()`,
      [roleOid],
    );
    if (active.rows[0]?.activeSessionCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("ephemeral_login_sessions_survived_termination");
}

function scopedRoleNames(databaseOid: string): readonly string[] {
  return [
    `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
    `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
    `pintpath_logical_backup_d${databaseOid}`,
  ];
}

async function configureReviewedMetadata(client: Client): Promise<void> {
  const values = {
    import_state: "ready",
    migration_candidate_sha: "a".repeat(40),
    migration_contract_sha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    migration_manifest_sha256: "b".repeat(64),
    migration_plan_sha256: "c".repeat(64),
    migration_run_sha256: "d".repeat(64),
    schema_version: "1",
    source_schema_fingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    source_schema_sha256: "e".repeat(64),
    source_schema_version: String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
    source_snapshot_sha256: "f".repeat(64),
    target_ddl_sha256: "1".repeat(64),
  } as const;
  for (const [key, value] of Object.entries(values)) {
    const updated = await client.query(
      `UPDATE pintpath_app.schema_metadata
       SET value = $2, updated_at = '2026-08-12T00:00:00.000Z'::pg_catalog.timestamptz
       WHERE key = $1`,
      [key, value],
    );
    if (updated.rowCount !== 1) throw new Error("reviewed_metadata_update_failed");
  }
}

interface MembershipObservation extends QueryResultRow {
  readonly backupGroupExists: boolean;
  readonly loginExists: boolean;
  readonly backupGroupChildMembershipCount: number;
  readonly loginParentMembershipCount: number;
  readonly exactSetOnlyMembershipCount: number;
  readonly inheritOptionTrueCount: number;
  readonly adminOptionTrueCount: number;
}

async function observeMembership(
  admin: Client,
  backupGroupRoleName: string,
  loginRoleName: string,
): Promise<MembershipObservation> {
  const result = await admin.query<MembershipObservation>(`SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.rolname = $1)
        AS "backupGroupExists",
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.rolname = $2)
        AS "loginExists",
      (SELECT count(*)::integer
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE parent.rolname = $1) AS "backupGroupChildMembershipCount",
      (SELECT count(*)::integer
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
       WHERE child.rolname = $2) AS "loginParentMembershipCount",
      (SELECT count(*)::integer
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
       WHERE parent.rolname = $1 AND child.rolname = $2
         AND membership.set_option
         AND NOT membership.inherit_option
         AND NOT membership.admin_option) AS "exactSetOnlyMembershipCount",
      (SELECT count(*)::integer
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
       WHERE parent.rolname = $1 AND child.rolname = $2
         AND membership.inherit_option) AS "inheritOptionTrueCount",
      (SELECT count(*)::integer
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
       WHERE parent.rolname = $1 AND child.rolname = $2
         AND membership.admin_option) AS "adminOptionTrueCount"`, [
    backupGroupRoleName,
    loginRoleName,
  ]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw new Error("membership_observation_unavailable");
  return row;
}

function expectMembership(
  observation: MembershipObservation,
  active: boolean,
  loginExists = true,
): void {
  expect(observation).toEqual({
    backupGroupExists: true,
    loginExists,
    backupGroupChildMembershipCount: active ? 1 : 0,
    loginParentMembershipCount: active ? 1 : 0,
    exactSetOnlyMembershipCount: active ? 1 : 0,
    inheritOptionTrueCount: 0,
    adminOptionTrueCount: 0,
  });
}

describe.skipIf(!configuredAdminUrl)(
  "logical-backup V4 source-authority ceremony on credential-free local PostgreSQL 17",
  () => {
    it("detaches V2 capture, exports once, imports on a second login connection, and cleans up", async () => {
      const adminUrl = validateAdminUrl(configuredAdminUrl);
      const maintenance = new Client({
        connectionString: adminUrl.toString(),
        application_name: "pintpath-v4-authority-admin",
      });
      let databaseAdmin: Client | null = null;
      let source: Client | null = null;
      let pgDump: Client | null = null;
      let databaseOid: string | null = null;
      let loginRoleName: string | null = null;
      let loginRoleOid: string | null = null;
      let backupGroupRoleName: string | null = null;
      let runtimeRoleExisted = true;
      let migratorRoleExisted = true;
      let sourceTransactionOpen = false;
      let pgDumpTransactionOpen = false;
      let receiptBuilt = false;
      maintenance.on("error", () => undefined);
      await maintenance.connect();
      try {
        const server = await maintenance.query<{
          serverVersionNum: string;
          superuser: boolean;
          serverNow: string;
        }>(`SELECT pg_catalog.current_setting('server_version_num') AS "serverVersionNum",
            pg_catalog.clock_timestamp()::text AS "serverNow",
            role.rolsuper AS superuser
           FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
        expect(server.rows[0]).toMatchObject({ superuser: true });
        expect(server.rows[0]?.serverVersionNum).toMatch(/^17\d{4}$/);

        const sharedRoles = await maintenance.query<{ rolname: string }>(
          "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [["pintpath_runtime", "pintpath_migrator"]],
        );
        runtimeRoleExisted = sharedRoles.rows.some((row) => row.rolname === "pintpath_runtime");
        migratorRoleExisted = sharedRoles.rows.some((row) => row.rolname === "pintpath_migrator");

        await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
        databaseAdmin = new Client({
          connectionString: withDatabase(adminUrl, databaseName),
          application_name: "pintpath-v4-authority-db-admin",
        });
        databaseAdmin.on("error", () => undefined);
        await databaseAdmin.connect();
        await databaseAdmin.query(schemaSql);
        await databaseAdmin.query(kernelSql);
        await configureReviewedMetadata(databaseAdmin);

        const identity = await databaseAdmin.query<{
          systemIdentifier: string;
          databaseOid: string;
          databaseName: string;
          serverVersionNum: string;
        }>(`SELECT control.system_identifier::text AS "systemIdentifier",
              database.oid::text AS "databaseOid",
              pg_catalog.current_database() AS "databaseName",
              pg_catalog.current_setting('server_version_num') AS "serverVersionNum"
             FROM pg_catalog.pg_database AS database
             CROSS JOIN pg_catalog.pg_control_system() AS control
             WHERE database.datname = pg_catalog.current_database()`);
        const databaseIdentity = identity.rows[0];
        if (identity.rows.length !== 1 || !databaseIdentity) {
          throw new Error("database_identity_unavailable");
        }
        databaseOid = databaseIdentity.databaseOid;
        expect(databaseOid).toMatch(/^[1-9][0-9]{0,9}$/);
        backupGroupRoleName = `pintpath_logical_backup_d${databaseOid}`;
        const loginVersion = `${Date.now()}${String(process.pid % 100_000).padStart(5, "0")}`;
        loginRoleName = `${backupGroupRoleName}_v${loginVersion}`;
        expect(Buffer.byteLength(loginRoleName)).toBeLessThanOrEqual(63);

        const clock = await maintenance.query<{ startedAt: string; expiresAt: string }>(
          `WITH clock AS MATERIALIZED (
             SELECT pg_catalog.clock_timestamp() AS observed_at
           )
           SELECT clock.observed_at::text AS "startedAt",
             (clock.observed_at + interval '600 seconds')::text AS "expiresAt"
           FROM clock`,
        );
        const startedAt = new Date(clock.rows[0]?.startedAt ?? "").toISOString();
        const expiresAt = new Date(clock.rows[0]?.expiresAt ?? "").toISOString();
        const password = crypto.randomBytes(32).toString("base64url");
        await maintenance.query("BEGIN");
        await maintenance.query("SET LOCAL password_encryption = 'scram-sha-256'");
        await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginRoleName)}
          LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
          CONNECTION LIMIT 2 PASSWORD ${quoteLiteral(password)} VALID UNTIL ${quoteLiteral(expiresAt)}`);
        await maintenance.query("COMMIT");
        await databaseAdmin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)}
          TO ${quoteIdentifier(loginRoleName)}`);
        await maintenance.query(`GRANT ${quoteIdentifier(backupGroupRoleName)}
          TO ${quoteIdentifier(loginRoleName)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
        const provisionClock = await maintenance.query<{
          loginProvisionedAt: string;
          validUntilFuture: boolean;
          validUntilWithinMaximum: boolean;
        }>(`WITH clock AS MATERIALIZED (
              SELECT pg_catalog.clock_timestamp() AS observed_at
            )
            SELECT clock.observed_at::text AS "loginProvisionedAt",
              role.rolvaliduntil > clock.observed_at AS "validUntilFuture",
              role.rolvaliduntil <= clock.observed_at + interval '600 seconds'
                AS "validUntilWithinMaximum"
            FROM pg_catalog.pg_roles AS role CROSS JOIN clock
            WHERE role.rolname = $1`, [loginRoleName]);
        expect(provisionClock.rows[0]).toMatchObject({
          validUntilFuture: true,
          validUntilWithinMaximum: true,
        });
        const loginProvisionedAt = new Date(
          provisionClock.rows[0]?.loginProvisionedAt ?? "",
        ).toISOString();
        const serverClockEvidenceSha256 = evidenceHash("pintpath-v4-server-clock", {
          startedAt,
          expiresAt,
          ...provisionClock.rows[0],
        });

        const groupCatalog = await databaseAdmin.query<Record<string, unknown> & QueryResultRow>(
          `SELECT role.oid::text AS "roleOid", role.rolcanlogin AS login,
             role.rolinherit AS inherit, role.rolsuper AS superuser,
             role.rolcreatedb AS "createDatabase", role.rolcreaterole AS "createRole",
             role.rolreplication AS replication, role.rolbypassrls AS "bypassRls"
           FROM pg_catalog.pg_roles AS role WHERE role.rolname = $1`,
          [backupGroupRoleName],
        );
        const groupCatalogRow = groupCatalog.rows[0];
        expect(groupCatalogRow).toMatchObject({
          login: false,
          inherit: false,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
        });
        expect(groupCatalogRow?.roleOid).toMatch(/^[1-9][0-9]{0,9}$/);

        const loginCatalog = await databaseAdmin.query<Record<string, unknown> & QueryResultRow>(
          `SELECT role.oid::text AS "roleOid", role.rolcanlogin AS login,
             role.rolinherit AS inherit, role.rolconnlimit AS "connectionLimit",
             (authentication.rolpassword ~
              '^SCRAM-SHA-256\\$4096:[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$')
                AS "scramSha256Verifier",
             floor(extract(epoch FROM role.rolvaliduntil) * 1000)::text
               AS "validUntilEpochMilliseconds",
             role.rolsuper AS superuser, role.rolcreatedb AS "createDatabase",
             role.rolcreaterole AS "createRole", role.rolreplication AS replication,
             role.rolbypassrls AS "bypassRls",
             (SELECT count(*)::integer FROM pg_catalog.pg_database AS database
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                database.datacl, pg_catalog.acldefault('d', database.datdba)
              )) AS privilege
              WHERE privilege.grantee = role.oid
                AND database.datname = pg_catalog.current_database()
                AND privilege.privilege_type = 'CONNECT'
                AND NOT privilege.is_grantable) AS "directTargetDatabaseConnectGrantCount",
             (SELECT count(*)::integer FROM pg_catalog.pg_proc AS routine
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                routine.proacl, pg_catalog.acldefault('f', routine.proowner)
              )) AS privilege WHERE privilege.grantee = role.oid)
                AS "directFunctionPrivilegeCount",
             ((SELECT count(*) FROM pg_catalog.pg_namespace AS namespace
               CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                 namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
               )) AS privilege
               WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                 AND privilege.grantee = role.oid)
              + (SELECT count(*) FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                 CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                   relation.relacl, pg_catalog.acldefault(
                     (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
                     relation.relowner
                   )
                 )) AS privilege
                 WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
                   AND privilege.grantee = role.oid))::integer AS "directPrivateObjectPrivilegeCount"
           FROM pg_catalog.pg_roles AS role
           JOIN pg_catalog.pg_authid AS authentication ON authentication.oid = role.oid
           WHERE role.rolname = $1`,
          [loginRoleName],
        );
        const loginCatalogRow = loginCatalog.rows[0];
        expect(loginCatalogRow).toMatchObject({
          login: true,
          inherit: false,
          connectionLimit: 2,
          scramSha256Verifier: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          directTargetDatabaseConnectGrantCount: 1,
          directFunctionPrivilegeCount: 0,
          directPrivateObjectPrivilegeCount: 0,
        });
        expect(loginCatalogRow?.roleOid).toMatch(/^[1-9][0-9]{0,9}$/);
        loginRoleOid = String(loginCatalogRow?.roleOid);
        expect(loginCatalogRow?.validUntilEpochMilliseconds).toBe(String(Date.parse(expiresAt)));

        const effectiveDatabases = await maintenance.query<{
          databaseOid: string;
          databaseName: string;
        }>(`SELECT database.oid::text AS "databaseOid",
              database.datname AS "databaseName"
            FROM pg_catalog.pg_database AS database
            WHERE database.datallowconn
              AND pg_catalog.has_database_privilege($1, database.oid, 'CONNECT')
            ORDER BY database.oid`, [loginRoleName]);
        expect(effectiveDatabases.rows).toContainEqual({ databaseOid, databaseName });
        expect(effectiveDatabases.rows.length).toBeGreaterThanOrEqual(1);
        const effectiveConnectableDatabaseCount = effectiveDatabases.rows.length;
        const effectiveDatabaseScopeEvidenceSha256 = evidenceHash(
          "pintpath-v4-effective-connectable-databases-observation",
          effectiveDatabases.rows,
        );

        const provisioned = await observeMembership(
          maintenance,
          backupGroupRoleName,
          loginRoleName,
        );
        expectMembership(provisioned, true);

        const sourceUrl = new URL(withDatabase(adminUrl, databaseName));
        sourceUrl.username = loginRoleName;
        sourceUrl.password = password;
        const sourceUrlValue = sourceUrl.toString();
        const sourceUrlSha256 = hashBytes(sourceUrlValue);
        const authenticatedSource = await AuthenticatedClient.connect({
          connectionString: sourceUrlValue,
          application_name: "pintpath-v4-authority-source",
        });
        expect(authenticatedSource.authenticationMethod).toBe("scram-sha-256");
        source = authenticatedSource.client;
        const sourceAuthenticationEvidenceSha256 = evidenceHash(
          "pintpath-v4-source-scram-authentication",
          { method: authenticatedSource.authenticationMethod, sessionUserRoleName: loginRoleName },
        );
        const sourceSessionIdentitySha256 = evidenceHash("pintpath-v4-source-session", {
          backendPid: source.processID,
          sessionUserRoleName: loginRoleName,
          sourceUrlSha256,
        });
        const independentAdminSessionIdentitySha256 = evidenceHash("pintpath-v4-admin-session", {
          backendPid: maintenance.processID,
          currentUser: (await maintenance.query<{ currentUser: string }>(
            "SELECT current_user AS \"currentUser\"",
          )).rows[0]?.currentUser,
          databaseOid,
        });

        await source.query(`SET ROLE ${quoteIdentifier(backupGroupRoleName)}`);
        await source.query("SET SESSION search_path = pg_catalog, pg_temp");
        await source.query(`SET SESSION statement_timeout = '${POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS}ms'`);
        await source.query(`SET SESSION idle_in_transaction_session_timeout = '${POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS}ms'`);
        await source.query(`SET SESSION idle_session_timeout = '${POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS}ms'`);
        await source.query(`SET SESSION transaction_timeout = '${POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS}ms'`);
        const sourceTimeouts = await source.query<Record<string, unknown> & QueryResultRow>(
          `SELECT pg_catalog.current_setting('statement_timeout') AS "statementTimeout",
             pg_catalog.current_setting('idle_in_transaction_session_timeout')
               AS "idleInTransactionSessionTimeout",
             pg_catalog.current_setting('idle_session_timeout') AS "idleSessionTimeout",
             pg_catalog.current_setting('transaction_timeout') AS "transactionTimeout"`,
        );
        expect(sourceTimeouts.rows[0]).toEqual({
          statementTimeout: "3min",
          idleInTransactionSessionTimeout: "8min",
          idleSessionTimeout: "8min",
          transactionTimeout: "8min",
        });
        const sourceSessionTimeoutEvidenceSha256 = evidenceHash(
          "pintpath-v4-source-session-timeouts",
          sourceTimeouts.rows[0],
        );
        const sourceRoleSetAt = now();
        await maintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}
          FROM ${quoteIdentifier(loginRoleName)}`);
        const membershipRevokedAt = now();
        const detached = await observeMembership(maintenance, backupGroupRoleName, loginRoleName);
        expectMembership(detached, false);
        const effectiveDetached = await source.query<{
          currentUser: string;
          sessionUser: string;
          canStillSetRole: boolean;
        }>(`SELECT current_user AS "currentUser", session_user AS "sessionUser",
          pg_catalog.pg_has_role(session_user, $1, 'SET') AS "canStillSetRole"`, [
          backupGroupRoleName,
        ]);
        expect(effectiveDetached.rows[0]).toEqual({
          currentUser: backupGroupRoleName,
          sessionUser: loginRoleName,
          canStillSetRole: false,
        });

        await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        sourceTransactionOpen = true;
        const sourceTransactionBeganAt = now();
        const capture = await capturePostgresLogicalStateV2(asV2Connection(source), { pageRows: 1 });
        const v2CaptureCompletedAt = now();
        const exported = await source.query<{ snapshotIdentifier: string }>(
          "SELECT pg_catalog.pg_export_snapshot() AS \"snapshotIdentifier\"",
        );
        expect(capture.sourceDatabaseOid).toBe(databaseOid);
        const snapshotIdentifier = exported.rows[0]?.snapshotIdentifier;
        expect(snapshotIdentifier).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/);
        if (!snapshotIdentifier) throw new Error("snapshot_identifier_unavailable");
        const snapshotExportedAt = now();
        const captureToExportSequenceEvidenceSha256 = evidenceHash(
          "pintpath-v4-immediate-capture-to-export-sequence",
          { captureSha256: sha256CanonicalPostgresLogicalState(capture), snapshotExportedAt },
        );
        const sourceTransactionEvidence = {
          currentUserRoleName: backupGroupRoleName,
          sessionUserRoleName: loginRoleName,
          isolation: "repeatable read",
          readOnly: true,
          backupGroupChildMembershipCount: 0,
          loginParentMembershipCount: 0,
        } as const;
        const databaseIdentitySha256 = sha256PostgresDatabaseIdentity(databaseIdentity);
        const snapshotHandoff = buildPostgresLogicalBackupV4SnapshotHandoffBinding({
          sourceDatabaseOid: databaseOid,
          databaseIdentitySha256,
          sourceUrlSha256,
          effectiveRoleName: backupGroupRoleName,
          snapshotIdentifier,
        });

        const changed = await databaseAdmin.query(
          "UPDATE pintpath_app.schema_metadata SET value = 'changed-after-export' WHERE key = 'import_state'",
        );
        expect(changed.rowCount).toBe(1);
        await maintenance.query(`GRANT ${quoteIdentifier(backupGroupRoleName)}
          TO ${quoteIdentifier(loginRoleName)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
        const membershipRegrantedAt = now();
        const regranted = await observeMembership(maintenance, backupGroupRoleName, loginRoleName);
        expectMembership(regranted, true);

        const authenticatedPgDump = await AuthenticatedClient.connect({
          connectionString: sourceUrlValue,
          application_name: "pintpath-v4-authority-pg-dump",
        });
        expect(authenticatedPgDump.authenticationMethod).toBe("scram-sha-256");
        pgDump = authenticatedPgDump.client;
        const pgDumpAuthenticationEvidenceSha256 = evidenceHash(
          "pintpath-v4-pg-dump-scram-authentication",
          { method: authenticatedPgDump.authenticationMethod, sessionUserRoleName: loginRoleName },
        );
        const pgDumpExternalWatchdogEvidenceSha256 = evidenceHash(
          "pintpath-v4-pg-dump-external-watchdog-contract",
          {
            watchdogStartedAt: membershipRegrantedAt,
            timeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
            serverGucTimeoutsAuthoritative: false,
            independentAdminBackendTerminationRequired: true,
          },
        );
        const pgDumpSessionIdentitySha256 = evidenceHash("pintpath-v4-pg-dump-session", {
          backendPid: pgDump.processID,
          sessionUserRoleName: loginRoleName,
          sourceUrlSha256,
        });
        expect(pgDumpSessionIdentitySha256).not.toBe(sourceSessionIdentitySha256);

        const third = new Client({
          connectionString: sourceUrlValue,
          application_name: "pintpath-v4-authority-third-connection-denial",
        });
        third.on("error", () => undefined);
        let thirdConnectionError: unknown;
        try {
          await third.connect();
        } catch (error) {
          thirdConnectionError = error;
        } finally {
          await third.end().catch(() => undefined);
        }
        expect(thirdConnectionError).toMatchObject({ code: "53300" });

        await pgDump.query(`SET ROLE ${quoteIdentifier(backupGroupRoleName)}`);
        await pgDump.query("SET SESSION search_path = pg_catalog, pg_temp");
        await pgDump.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        pgDumpTransactionOpen = true;
        await pgDump.query(`SET TRANSACTION SNAPSHOT ${quoteLiteral(snapshotIdentifier)}`);
        const visible = await pgDump.query<Record<string, unknown> & QueryResultRow>(
          `SELECT current_user AS "currentUserRoleName", session_user AS "sessionUserRoleName",
             pg_catalog.current_setting('transaction_isolation') AS isolation,
             pg_catalog.current_setting('transaction_read_only')::boolean AS "readOnly",
             (SELECT value FROM pintpath_app.schema_metadata WHERE key = 'import_state')
               AS "snapshotImportState"`,
        );
        expect(visible.rows[0]).toEqual({
          currentUserRoleName: backupGroupRoleName,
          sessionUserRoleName: loginRoleName,
          isolation: "repeatable read",
          readOnly: true,
          snapshotImportState: "ready",
        });
        const pgDumpSnapshotImportedAt = now();
        const snapshotVisibilityEvidenceSha256 = evidenceHash(
          "pintpath-v4-pg-dump-snapshot-visibility",
          {
            ...visible.rows[0],
            thirdConnectionDeniedCode: (thirdConnectionError as { code?: unknown }).code,
          },
        );
        const pgDumpExactRawArgumentsEvidenceSha256 = evidenceHash(
          "pintpath-v4-pg-dump-exact-raw-arguments",
          {
            roleArgumentSha256: evidenceHash(
              "pintpath-v4-pg-dump-raw-role-argument",
              `--role=${backupGroupRoleName}`,
            ),
            snapshotArgumentSha256: evidenceHash(
              "pintpath-v4-pg-dump-raw-snapshot-argument",
              `--snapshot=${snapshotIdentifier}`,
            ),
          },
        );

        await pgDump.query("ROLLBACK");
        pgDumpTransactionOpen = false;
        await pgDump.query("RESET ROLE");
        await source.query("ROLLBACK");
        sourceTransactionOpen = false;
        await source.query("RESET ROLE");
        const sourceTransactionEndedAt = now();

        await maintenance.query(`ALTER ROLE ${quoteIdentifier(loginRoleName)} NOLOGIN`);
        await maintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}
          FROM ${quoteIdentifier(loginRoleName)}`);
        await databaseAdmin.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)}
          FROM ${quoteIdentifier(loginRoleName)}`);
        const disabledBeforeTermination = await maintenance.query<{
          loginDisabled: boolean;
        }>(`SELECT NOT role.rolcanlogin AS "loginDisabled"
            FROM pg_catalog.pg_roles AS role WHERE role.oid = $1::oid`, [loginRoleOid]);
        expect(disabledBeforeTermination.rows[0]?.loginDisabled).toBe(true);
        const terminated = await maintenance.query<{ pid: number; terminated: boolean }>(
          `SELECT activity.pid, pg_catalog.pg_terminate_backend(activity.pid, 5000) AS terminated
           FROM pg_catalog.pg_stat_activity AS activity
           WHERE activity.usesysid = $1::oid
             AND activity.pid <> pg_catalog.pg_backend_pid()
           ORDER BY activity.pid`,
          [loginRoleOid],
        );
        expect(terminated.rows).toHaveLength(2);
        expect(terminated.rows.every((row) => row.terminated)).toBe(true);
        const terminatedBackendCount = terminated.rows.length;
        await waitForZeroActiveSessions(maintenance, loginRoleOid);
        const preDrop = await observeMembership(maintenance, backupGroupRoleName, loginRoleName);
        expectMembership(preDrop, false);
        await pgDump.end().catch(() => undefined);
        pgDump = null;
        await source.end().catch(() => undefined);
        source = null;
        await maintenance.query(`DROP ROLE ${quoteIdentifier(loginRoleName)}`);
        const cleanupCompletedAt = now();
        const cleanedUp = await observeMembership(maintenance, backupGroupRoleName, loginRoleName);
        expectMembership(cleanedUp, false, false);
        const cleanupEvidenceSha256 = evidenceHash("pintpath-v4-cleanup", {
          disabledBeforeTermination: disabledBeforeTermination.rows[0],
          terminatedBackendCount,
          activeSessionCountBeforeDrop: 0,
          membershipBeforeDrop: preDrop,
          membershipAfterDrop: cleanedUp,
        });

        const receipt = buildPostgresLogicalBackupV4SourceAuthorityReceipt({
          createdAt: cleanupCompletedAt,
          startedAt,
          expiresAt,
          serverClockEvidenceSha256,
          sourceDatabaseOid: databaseOid,
          databaseIdentitySha256,
          sourceUrlSha256,
          backupGroupRoleOid: String(groupCatalogRow?.roleOid),
          ephemeralLoginRoleOid: String(loginCatalogRow?.roleOid),
          ephemeralLoginVersion: loginVersion,
          backupGroupCatalogEvidenceSha256: evidenceHash(
            "pintpath-v4-backup-group-catalog",
            groupCatalogRow,
          ),
          ephemeralLoginCatalogEvidenceSha256: evidenceHash(
            "pintpath-v4-ephemeral-login-catalog",
            loginCatalogRow,
          ),
          effectiveConnectableDatabaseCount,
          effectiveDatabaseScopeEvidenceSha256,
          sourceSessionIdentitySha256,
          independentAdminSessionIdentitySha256,
          pgDumpSessionIdentitySha256,
          sourceAuthenticationEvidenceSha256,
          pgDumpAuthenticationEvidenceSha256,
          sourceSessionTimeoutEvidenceSha256,
          pgDumpExternalWatchdogEvidenceSha256,
          eventTimes: {
            loginProvisionedAt,
            sourceRoleSetAt,
            membershipRevokedAt,
            sourceTransactionBeganAt,
            v2CaptureCompletedAt,
            snapshotExportedAt,
            membershipRegrantedAt,
            pgDumpSnapshotImportedAt,
            sourceTransactionEndedAt,
            cleanupCompletedAt,
          },
          membershipEvidenceSha256: {
            provisioned: evidenceHash("pintpath-v4-membership-provisioned", provisioned),
            detachedForV2: evidenceHash("pintpath-v4-membership-detached", detached),
            regrantedForPgDump: evidenceHash("pintpath-v4-membership-regranted", regranted),
            cleanedUp: evidenceHash("pintpath-v4-membership-cleaned-up", cleanedUp),
          },
          sourceTransactionEvidenceSha256: evidenceHash(
            "pintpath-v4-source-transaction",
            sourceTransactionEvidence,
          ),
          captureToExportSequenceEvidenceSha256,
          sourceCapture: buildPostgresLogicalBackupV4SourceCaptureBinding(capture),
          snapshotHandoff,
          pgDumpSnapshotVisibilityEvidenceSha256: snapshotVisibilityEvidenceSha256,
          pgDumpExactRawArgumentsEvidenceSha256,
          cleanupEvidenceSha256,
          terminatedBackendCount,
        });
        receiptBuilt = true;
        const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson(receipt);
        expect(canonical).not.toContain(snapshotIdentifier);
        expect(canonical).not.toContain(password);
        expect(canonical).not.toContain(sourceUrlValue);
        expect(receipt.activationAuthorized).toBe(false);
        expect(receipt.artifactEmissionAuthorized).toBe(false);
        expect(receipt.productionCutoverAuthorized).toBe(false);
        expect(receipt.v2Capture.captureSha256)
          .toBe(sha256CanonicalPostgresLogicalState(capture));
        expect(receipt.exportedSnapshot.bindingSha256)
          .toBe(receipt.pgDumpHandoff.importedSnapshotBindingSha256);
        expect(receipt.v2Capture.sourceSessionIdentitySha256)
          .toBe(receipt.exportedSnapshot.sourceSessionIdentitySha256);
        expect(receipt.sessions.source.identitySha256)
          .not.toBe(receipt.sessions.pgDump.identitySha256);
        expect(receipt.membershipTransitions.map(
          (transition) => transition.backupGroupChildMembershipCount,
        )).toEqual([1, 0, 1, 0]);
        expect(parsePostgresLogicalBackupV4SourceAuthorityReceipt(Buffer.from(canonical)))
          .toEqual(receipt);
        expect(postgresLogicalBackupV4SourceAuthorityReceiptSha256(receipt))
          .toBe(hashBytes(canonical));
      } finally {
        if (pgDump) {
          if (pgDumpTransactionOpen) await pgDump.query("ROLLBACK").catch(() => undefined);
          await pgDump.query("RESET ROLE").catch(() => undefined);
          await pgDump.end().catch(() => undefined);
        }
        if (source) {
          if (sourceTransactionOpen) await source.query("ROLLBACK").catch(() => undefined);
          await source.query("RESET ROLE").catch(() => undefined);
          await source.end().catch(() => undefined);
        }
        if (loginRoleName && backupGroupRoleName) {
          await maintenance.query(`ALTER ROLE ${quoteIdentifier(loginRoleName)} NOLOGIN`)
            .catch(() => undefined);
          await maintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}
            FROM ${quoteIdentifier(loginRoleName)}`).catch(() => undefined);
          if (databaseAdmin) {
            await databaseAdmin.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)}
              FROM ${quoteIdentifier(loginRoleName)}`).catch(() => undefined);
          }
          if (loginRoleOid) {
            await maintenance.query(
              `SELECT pg_catalog.pg_terminate_backend(activity.pid, 5000)
               FROM pg_catalog.pg_stat_activity AS activity
               WHERE activity.usesysid = $1::oid
                 AND activity.pid <> pg_catalog.pg_backend_pid()`,
              [loginRoleOid],
            ).catch(() => undefined);
            await waitForZeroActiveSessions(maintenance, loginRoleOid).catch(() => undefined);
          }
          await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginRoleName)}`)
            .catch(() => undefined);
        }
        if (databaseAdmin) await databaseAdmin.end().catch(() => undefined);
        await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`)
          .catch(() => undefined);
        if (databaseOid) {
          for (const roleName of scopedRoleNames(databaseOid)) {
            await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`)
              .catch(() => undefined);
          }
        }
        if (!runtimeRoleExisted) {
          await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
        }
        if (!migratorRoleExisted) {
          await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
        }
        await maintenance.end().catch(() => undefined);
      }
      expect(receiptBuilt).toBe(true);
    }, 90_000);
  },
);
