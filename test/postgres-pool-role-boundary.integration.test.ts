import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  Client,
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkPostgresMaintenanceRuntimeReadiness,
} from "../src/db/postgres-maintenance-runtime.js";
import {
  checkPostgresRuntimeReadiness,
  postgresRuntimeQueries,
} from "../src/db/postgres-runtime.js";
import {
  sqlDatabaseInternals,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_POOL_ROLE_BOUNDARY_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const databaseName = `pintpath_pool_role_${suffix}`;
const runtimeLogin = `pintpath_runtime_login_${suffix}`;
const maintenanceLogin = `pintpath_maintenance_login_${suffix}`;
const runtimePassword = `Runtime_${crypto.randomBytes(24).toString("base64url")}`;
const maintenancePassword = `Maintenance_${crypto.randomBytes(24).toString("base64url")}`;
const schemaSql = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
const additiveMigrationSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260810003612_add_pintpath_logical_backup_role.sql",
), "utf8");
const inertKernelSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
), "utf8");
const maintenanceRoleSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260812235959_add_privacy_maintenance_role.sql",
), "utf8");
const activationSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260813000000_activate_reviewed_price_promotion_kernel.sql",
), "utf8");

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
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
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    )
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function withDatabase(
  adminUrl: URL,
  username?: string,
  password?: string,
): string {
  const url = new URL(adminUrl.toString());
  url.pathname = `/${databaseName}`;
  if (username !== undefined) url.username = username;
  if (password !== undefined) url.password = password;
  return url.toString();
}

/**
 * The production adapter requires TLS, while the isolated CI PostgreSQL
 * service intentionally has TLS disabled. This minimal test-only adapter uses
 * the exact production startup-option builder so real PG17 proves the
 * session_user/current_user transition and the production readiness queries.
 */
class Pg17StartupRoleDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private completedQueries = 0;
  private failedQueries = 0;
  private closed = false;

  constructor(
    connectionString: string,
    activeRole: "pintpath_runtime" | "pintpath_maintenance",
  ) {
    this.pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 0,
      options: sqlDatabaseInternals.buildPostgresStartupOptions({
        activeRole,
        statementTimeoutMs: 30_000,
        idleInTransactionTimeoutMs: 30_000,
      }),
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
    this.pool.on("error", () => {
      this.failedQueries += 1;
    });
  }

  private async query<Row extends QueryResultRow>(sql: string) {
    if (this.closed) throw new Error("Database is closed.");
    try {
      const result = await this.pool.query<Row>(sql);
      this.completedQueries += 1;
      return result;
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async () => {
        const result = await this.query(sql);
        return { changes: result.rowCount ?? 0 };
      },
      get: async <Row extends QueryResultRow>() =>
        (await this.query<Row>(sql)).rows[0],
      all: async <Row extends QueryResultRow>() =>
        (await this.query<Row>(sql)).rows,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        await client.query("BEGIN");
        const result = await work();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client?.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client?.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)(
  "Postgres pool external-LOGIN/effective-role boundary on real PostgreSQL 17",
  () => {
    let clusterAdmin: Client;
    let databaseAdmin: Client;
    let runtimeWithoutRole: Client;
    let maintenanceWithoutRole: Client;
    let runtimeDatabase: Pg17StartupRoleDatabase;
    let maintenanceDatabase: Pg17StartupRoleDatabase;
    let runtimeUrl = "";
    let maintenanceUrl = "";
    let standaloneClientsClosed = false;
    let databaseOid = "";
    const preexistingRoles = new Set<string>();

    beforeAll(async () => {
      const adminUrl = validateAdminUrl(configuredAdminUrl);
      clusterAdmin = new Client({ connectionString: adminUrl.toString() });
      await clusterAdmin.connect();
      const server = await clusterAdmin.query<{ version: string; superuser: boolean }>(`SELECT
        pg_catalog.current_setting('server_version_num') AS version,
        role.rolsuper AS superuser
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user`);
      if (!/^17\d{4}$/.test(server.rows[0]?.version ?? "")) {
        throw new Error("Pool role-boundary integration requires PostgreSQL 17.");
      }
      if (server.rows[0]?.superuser !== true) {
        throw new Error("Pool role-boundary integration requires a disposable superuser.");
      }
      const canonical = await clusterAdmin.query<{ name: string }>(`SELECT rolname AS name
        FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::text[])`, [[
        "pintpath_runtime",
        "pintpath_migrator",
        "pintpath_migration_verifier_authority",
        "pintpath_maintenance",
      ]]);
      canonical.rows.forEach((row) => preexistingRoles.add(row.name));
      await clusterAdmin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      for (const login of [runtimeLogin, maintenanceLogin]) {
        await clusterAdmin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(login)}`);
      }
      await clusterAdmin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      databaseAdmin = new Client({
        connectionString: withDatabase(adminUrl),
      });
      await databaseAdmin.connect();
      databaseOid = (await databaseAdmin.query<{ oid: string }>(`SELECT oid::text AS oid
        FROM pg_catalog.pg_database
        WHERE datname = pg_catalog.current_database()`)).rows[0]?.oid ?? "";
      if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) {
        throw new Error("pool_role_boundary_database_oid_unavailable");
      }
      await databaseAdmin.query("CREATE SCHEMA IF NOT EXISTS extensions");
      await databaseAdmin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions");
      await databaseAdmin.query(schemaSql);
      await databaseAdmin.query(additiveMigrationSql);
      await databaseAdmin.query(inertKernelSql);
      await databaseAdmin.query(maintenanceRoleSql);
      await databaseAdmin.query(`UPDATE pintpath_app.schema_metadata
        SET value = 'ready', updated_at = '2026-08-14T00:00:00.000Z'::pg_catalog.timestamptz
        WHERE key = 'import_state'`);
      await databaseAdmin.query(activationSql);
      await clusterAdmin.query(`CREATE ROLE ${quoteIdentifier(runtimeLogin)}
        LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`);
      await clusterAdmin.query(`CREATE ROLE ${quoteIdentifier(maintenanceLogin)}
        LOGIN PASSWORD '${maintenancePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`);
      await clusterAdmin.query(`GRANT pintpath_runtime TO ${quoteIdentifier(runtimeLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await clusterAdmin.query(`GRANT pintpath_maintenance TO ${quoteIdentifier(maintenanceLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await databaseAdmin.query(
        `REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`,
      );
      await databaseAdmin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await databaseAdmin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(maintenanceLogin)}`,
      );

      runtimeUrl = withDatabase(adminUrl, runtimeLogin, runtimePassword);
      maintenanceUrl = withDatabase(
        adminUrl,
        maintenanceLogin,
        maintenancePassword,
      );
      runtimeWithoutRole = new Client({ connectionString: runtimeUrl });
      maintenanceWithoutRole = new Client({ connectionString: maintenanceUrl });
      await runtimeWithoutRole.connect();
      await maintenanceWithoutRole.connect();
      runtimeDatabase = new Pg17StartupRoleDatabase(runtimeUrl, "pintpath_runtime");
      maintenanceDatabase = new Pg17StartupRoleDatabase(
        maintenanceUrl,
        "pintpath_maintenance",
      );
    }, 30_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      await runtimeDatabase?.close().catch((error) => failures.push(error));
      await maintenanceDatabase?.close().catch((error) => failures.push(error));
      if (!standaloneClientsClosed) {
        await runtimeWithoutRole?.end().catch((error) => failures.push(error));
        await maintenanceWithoutRole?.end().catch((error) => failures.push(error));
      }
      await databaseAdmin?.end().catch((error) => failures.push(error));
      if (clusterAdmin) {
        try {
          await clusterAdmin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
          );
          for (const login of [runtimeLogin, maintenanceLogin]) {
            await clusterAdmin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(login)}`);
          }
          for (const role of [
            `pintpath_reviewed_price_reviewer_execute_d${databaseOid}`,
            `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
            `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
            `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
            `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
            `pintpath_logical_backup_d${databaseOid}`,
          ]) {
            if (databaseOid) {
              await clusterAdmin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
            }
          }
          for (const role of [
            "pintpath_maintenance",
            "pintpath_migration_verifier_authority",
            "pintpath_migrator",
            "pintpath_runtime",
          ]) {
            if (!preexistingRoles.has(role)) {
              await clusterAdmin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
            }
          }
        } catch (error) {
          failures.push(error);
        }
        await clusterAdmin.end().catch((error) => failures.push(error));
      }
      if (failures.length > 0) throw failures[0];
    }, 30_000);

    it("requires startup SET ROLE and preserves the external session identity", async () => {
      const runtimeIdentity = await runtimeWithoutRole.query<{
        sessionUser: string;
        currentUser: string;
      }>(`SELECT session_user::text AS "sessionUser",
                 current_user::text AS "currentUser"`);
      expect(runtimeIdentity.rows).toEqual([{
        sessionUser: runtimeLogin,
        currentUser: runtimeLogin,
      }]);
      await expect(runtimeWithoutRole.query(
        "SELECT value FROM pintpath_app.schema_metadata WHERE key = 'schema_version'",
      )).rejects.toMatchObject({ code: "42501" });

      const maintenanceIdentity = await maintenanceWithoutRole.query<{
        sessionUser: string;
        currentUser: string;
      }>(`SELECT session_user::text AS "sessionUser",
                 current_user::text AS "currentUser"`);
      expect(maintenanceIdentity.rows).toEqual([{
        sessionUser: maintenanceLogin,
        currentUser: maintenanceLogin,
      }]);
      await expect(maintenanceWithoutRole.query(
        "SELECT value FROM pintpath_app.schema_metadata WHERE key = 'schema_version'",
      )).rejects.toMatchObject({ code: "42501" });

      await expect(runtimeDatabase.prepare(`SELECT
        session_user::text AS "sessionUser",
        current_user::text AS "currentUser",
        role.rolcanlogin AS "activeCanLogin"
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user`).get()).resolves.toEqual({
          sessionUser: runtimeLogin,
          currentUser: "pintpath_runtime",
          activeCanLogin: false,
        });
      await expect(maintenanceDatabase.prepare(`SELECT
        session_user::text AS "sessionUser",
        current_user::text AS "currentUser",
        role.rolcanlogin AS "activeCanLogin"
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user`).get()).resolves.toEqual({
          sessionUser: maintenanceLogin,
          currentUser: "pintpath_maintenance",
          activeCanLogin: false,
        });
      await expect(runtimeDatabase.prepare(
        postgresRuntimeQueries.runtimeSession,
      ).get()).resolves.toMatchObject({
        activeRoleExact: true,
        isSuperuser: false,
        canBypassRls: false,
        isRuntimeMember: true,
        loginCanLogin: true,
        loginCanCreateDatabase: false,
        loginCanCreateRole: false,
        loginInheritsPrivileges: false,
        loginCanReplicate: false,
        loginConnectionLimit: 8,
        loginValidUntilNull: true,
        loginMemberships: '["pintpath_runtime"]',
        loginMembershipOptionsExact: true,
        runtimeRoleSafe: true,
        runtimeRoleParents: "[]",
        runtimeRoleChildrenExact: true,
        runtimeRoleChildrenSafeForRotation: true,
        hasRoleSettings: false,
        canConnectDatabase: true,
        canCreateDatabaseObjects: false,
        canCreateTemporaryObjects: false,
        databaseAclExact: true,
        hasUnsafeDirectAclDependencies: false,
        ownsDatabaseObjects: false,
        hasUnsafeDefaultPrivileges: false,
      });
      await expect(runtimeDatabase.prepare(
        postgresRuntimeQueries.runtimeAuthority,
      ).get()).resolves.toMatchObject({
        canUseApplicationSchema: true,
        canCreateApplicationObjects: false,
        hasApplicationSequenceAccess: false,
        hasUnexpectedTableAuthority: false,
        hasColumnAclEntries: false,
        hasUnexpectedAclDependency: false,
        hasGrantableAcl: false,
      });
      await expect(checkPostgresRuntimeReadiness(runtimeDatabase)).resolves.toMatchObject({
        ready: true,
        failures: [],
      });
      await expect(
        checkPostgresMaintenanceRuntimeReadiness(maintenanceDatabase),
      ).resolves.toEqual({ ready: true, failures: [] });

      const escapeSchema = quoteIdentifier(`maintenance_escape_${suffix}`);
      await databaseAdmin.query(`CREATE SCHEMA ${escapeSchema}`);
      try {
        await databaseAdmin.query(`CREATE TABLE ${escapeSchema}.granted_rows (id integer)`);
        await databaseAdmin.query(
          `GRANT USAGE ON SCHEMA ${escapeSchema} TO pintpath_maintenance`,
        );
        await databaseAdmin.query(
          `GRANT SELECT ON ${escapeSchema}.granted_rows TO pintpath_maintenance`,
        );
        await expect(
          checkPostgresMaintenanceRuntimeReadiness(maintenanceDatabase),
        ).resolves.toMatchObject({
          ready: false,
          failures: expect.arrayContaining(["maintenance_acl_dependency_present"]),
        });
        await databaseAdmin.query(
          `REVOKE SELECT ON ${escapeSchema}.granted_rows FROM pintpath_maintenance`,
        );
        await databaseAdmin.query(
          `REVOKE USAGE ON SCHEMA ${escapeSchema} FROM pintpath_maintenance`,
        );
        await databaseAdmin.query(
          `ALTER TABLE ${escapeSchema}.granted_rows OWNER TO pintpath_maintenance`,
        );
        await expect(
          checkPostgresMaintenanceRuntimeReadiness(maintenanceDatabase),
        ).resolves.toMatchObject({
          ready: false,
          failures: expect.arrayContaining(["database_object_ownership_present"]),
        });
      } finally {
        await databaseAdmin.query(`DROP SCHEMA IF EXISTS ${escapeSchema} CASCADE`);
      }
      await expect(
        checkPostgresMaintenanceRuntimeReadiness(maintenanceDatabase),
      ).resolves.toEqual({ ready: true, failures: [] });
    });

    it("admits four process-shaped pool sets with a reserved maintenance probe", async () => {
      await runtimeDatabase.close();
      await maintenanceDatabase.close();
      await runtimeWithoutRole.end();
      await maintenanceWithoutRole.end();
      standaloneClientsClosed = true;

      const runtimePools = Array.from({ length: 4 }, () => new Pool({
        connectionString: runtimeUrl,
        max: 2,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 0,
        options: sqlDatabaseInternals.buildPostgresStartupOptions({
          activeRole: "pintpath_runtime",
          statementTimeoutMs: 30_000,
          idleInTransactionTimeoutMs: 30_000,
        }),
      }));
      const maintenancePoolPairs = Array.from({ length: 4 }, () => ({
        work: new Pool({
          connectionString: maintenanceUrl,
          max: 1,
          connectionTimeoutMillis: 2_000,
          idleTimeoutMillis: 0,
          options: sqlDatabaseInternals.buildPostgresStartupOptions({
            activeRole: "pintpath_maintenance",
            statementTimeoutMs: 30_000,
            idleInTransactionTimeoutMs: 30_000,
          }),
        }),
        readiness: new Pool({
          connectionString: maintenanceUrl,
          max: 1,
          connectionTimeoutMillis: 2_000,
          idleTimeoutMillis: 0,
          options: sqlDatabaseInternals.buildPostgresStartupOptions({
            activeRole: "pintpath_maintenance",
            statementTimeoutMs: 30_000,
            idleInTransactionTimeoutMs: 30_000,
          }),
        }),
      }));
      const maintenancePools = maintenancePoolPairs.flatMap(
        ({ readiness, work }) => [readiness, work],
      );
      const heldClients: PoolClient[] = [];
      const overflowClients: Client[] = [];
      try {
        for (const pool of runtimePools) {
          heldClients.push(await pool.connect(), await pool.connect());
        }
        for (const pool of maintenancePools) {
          heldClients.push(await pool.connect());
        }

        const observed = await databaseAdmin.query<{
          username: string;
          connectionCount: number;
        }>(`SELECT usename::text AS username,
                  pg_catalog.count(*)::integer AS "connectionCount"
             FROM pg_catalog.pg_stat_activity
            WHERE datname = pg_catalog.current_database()
              AND usename = ANY($1::text[])
            GROUP BY usename`, [[runtimeLogin, maintenanceLogin]]);
        expect(new Map(observed.rows.map((row) => [
          row.username,
          row.connectionCount,
        ]))).toEqual(new Map([
          [runtimeLogin, 8],
          [maintenanceLogin, 8],
        ]));

        for (const connectionString of [runtimeUrl, maintenanceUrl]) {
          const overflow = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
          overflowClients.push(overflow);
          await expect(overflow.connect()).rejects.toMatchObject({ code: "53300" });
        }
      } finally {
        for (const client of heldClients) client.release();
        await Promise.all([
          ...runtimePools.map((pool) => pool.end()),
          ...maintenancePools.map((pool) => pool.end()),
          ...overflowClients.map((client) => client.end().catch(() => undefined)),
        ]);
      }
    }, 30_000);
  },
);
