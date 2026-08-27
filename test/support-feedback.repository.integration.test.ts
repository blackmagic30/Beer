import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SupportFeedbackRepository,
  SupportFeedbackRepositoryError,
} from "../src/db/support-feedback.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_SUPPORT_FEEDBACK_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_support_feedback_integration_test";
const TEST_LOGIN = "pintpath_support_feedback_integration_login";
const NOW = "2026-08-08T18:00:00.000Z";
const LATER = "2026-08-08T18:01:00.000Z";
const LATEST = "2026-08-08T18:02:00.000Z";

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`);
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
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  }
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1
    && bindings[0] !== null
    && typeof bindings[0] === "object"
    && !Array.isArray(bindings[0])
    && !Buffer.isBuffer(bindings[0])
    && !(bindings[0] instanceof Date)
  ) return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Direct adapter restricted to the explicitly insecure loopback rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return { rows: result.rows.map(normalizeRow), rowCount: result.rowCount ?? 0 };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `support_feedback_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run({ client, nextSavepoint: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
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
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: null,
    };
  }
}

class WrongPriceInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private failed = false;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (!this.failed && /INSERT\s+INTO\s+wrong_price_reports/i.test(sql)) {
          this.failed = true;
          throw new Error("injected PostgreSQL wrong-price failure");
        }
        return result;
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => statement.get<Row>(...bindings),
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => statement.all<Row>(...bindings),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.delegate.exec(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return this.delegate.transaction(work);
  }

  async close(): Promise<void> {
    // The fixture owns the delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

function expectCode(code: SupportFeedbackRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SupportFeedbackRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("real restricted PG17 support/feedback repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: SupportFeedbackRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    database = new LoopbackPostgresTestDatabase(withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password));
    repository = new SupportFeedbackRepository(database);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      const rolesExpectedAbsent = [
        TEST_LOGIN,
        ...(!runtimeRoleExisted ? ["pintpath_runtime"] : []),
        ...(!migratorRoleExisted ? ["pintpath_migrator"] : []),
      ];
      const residue = await admin.query<{ databases: string; roles: string }>(
        `SELECT
           (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])) AS roles`,
        [TEST_DATABASE, rolesExpectedAbsent],
      ).catch(() => ({ rows: [{ databases: "1", roles: "1" }] }));
      if (residue.rows[0]?.databases !== "0" || residue.rows[0]?.roles !== "0") {
        throw new Error("Support/feedback PG rehearsal left database or role residue.");
      }
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves PG17 least privilege, native types, duplicate fencing, dispute threshold, and OCC", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    const runtime = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls",
              role.rolcreatedb AS "createDb", role.rolcreaterole AS "createRole",
              role.rolreplication AS "replication",
              pg_has_role(current_user, 'pintpath_runtime', 'member') AS "runtimeMember",
              pg_has_role(current_user, 'pintpath_migrator', 'member') AS "migratorMember"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<{
      serverVersionNum: string;
      superuser: boolean;
      bypassRls: boolean;
      createDb: boolean;
      createRole: boolean;
      replication: boolean;
      runtimeMember: boolean;
      migratorMember: boolean;
    }>();
    expect(runtime).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
      createDb: false,
      createRole: false,
      replication: false,
      runtimeMember: true,
      migratorMember: false,
    });
    const rls = await database.prepare(
      `SELECT bool_and(class.relrowsecurity) AS "enabled",
              bool_and(class.relforcerowsecurity) AS "forced"
         FROM pg_catalog.pg_class class
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'pintpath_app'
          AND class.relname = ANY(@tables)`,
    ).get<{ enabled: boolean; forced: boolean }>({
      tables: ["feedback", "wrong_price_reports", "venue_price_records"],
    });
    expect(rls).toEqual({ enabled: true, forced: true });

    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES
         ('pg-admin', 'pg-admin@example.test', 'hash', 'admin', 'free', @now, @now),
         ('pg-user-one', 'pg-user-one@example.test', 'hash', 'user', 'free', @now, @now),
         ('pg-user-two', 'pg-user-two@example.test', 'hash', 'user', 'free', @now, @now)`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence,
         source_type, last_verified_at, created_at, updated_at
       ) VALUES ('pg-price', 'venue-one', 'Venue One', 'Fitzroy', 'Carlton Draught',
                 'carlton_draft', 'pint', 12.5, FALSE, 'yes', 'community_confirmed',
                 'community_verified', @now, @now, @now)`,
    ).run({ now: NOW });
    const feedback = await repository.createFeedback({
      id: "pg-feedback",
      userId: "pg-user-one",
      anonymousSessionId: null,
      feedbackType: "bug",
      message: "The venue filter is broken.",
      venueId: "venue-one",
      venueName: "Venue One",
      contactEmail: null,
      priority: "normal",
      triageReason: "Product triage.",
      now: NOW,
    });
    expect(feedback.updatedAt).toBe(NOW);
    const common = {
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "pg-price",
      beerName: "Carlton Draught",
      reason: "price_changed" as const,
      notes: null,
      sourcePhotoUrl: null,
      now: NOW,
    };
    const duplicateRace = await Promise.all([
      repository.createWrongPriceReport({ ...common, id: "pg-report-a", userId: "pg-user-one", anonymousSessionId: null }),
      repository.createWrongPriceReport({ ...common, id: "pg-report-b", userId: "pg-user-one", anonymousSessionId: null }),
    ]);
    expect(duplicateRace.filter((result) => result.duplicate)).toHaveLength(1);
    expect(duplicateRace.filter((result) => !result.duplicate)).toHaveLength(1);
    const second = await repository.createWrongPriceReport({
      ...common,
      id: "pg-report-second",
      userId: "pg-user-two",
      anonymousSessionId: null,
      now: LATER,
    });
    expect(second).toMatchObject({ duplicate: false, markedDisputed: true });
    const native = await database.prepare(
      `SELECT pg_catalog.pg_typeof(price)::text AS "priceType",
              pg_catalog.pg_typeof(is_happy_hour_price)::text AS "booleanType",
              pg_catalog.pg_typeof(updated_at)::text AS "timestampType",
              confidence AS "confidence"
         FROM venue_price_records WHERE id = 'pg-price'`,
    ).get<{ priceType: string; booleanType: string; timestampType: string; confidence: string }>();
    expect(native).toEqual({
      priceType: "numeric",
      booleanType: "boolean",
      timestampType: "timestamp with time zone",
      confidence: "disputed",
    });

    await database.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, suburb, active, created_at, updated_at
       ) VALUES ('pg-manager-venue', 'PG Manager Venue', 'Fitzroy', TRUE, @now, @now)`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, created_at, updated_at
       ) VALUES ('pg-manager-beer', 'pg-manager-venue', 'Guinness', 'guinness',
                 'pint', 12, TRUE, TRUE, @now, @now, @now)`,
    ).run({ now: NOW });
    const managerCommon = {
      venueId: "pg-manager-venue",
      venueName: "PG Manager Venue",
      priceRecordId: "bar_beer:pg-manager-beer",
      beerName: "Guinness",
      reason: "price_changed" as const,
      notes: null,
      sourcePhotoUrl: null,
      now: NOW,
    };
    const managerRace = await Promise.all([
      repository.createWrongPriceReport({
        ...managerCommon,
        id: "pg-manager-report-a",
        userId: "pg-user-one",
        anonymousSessionId: null,
      }),
      repository.createWrongPriceReport({
        ...managerCommon,
        id: "pg-manager-report-b",
        userId: "pg-user-one",
        anonymousSessionId: null,
      }),
    ]);
    expect(managerRace.filter((result) => result.duplicate)).toHaveLength(1);
    expect(managerRace.filter((result) => !result.duplicate)).toHaveLength(1);
    await expect(repository.createWrongPriceReport({
      ...managerCommon,
      id: "pg-manager-report-second",
      userId: "pg-user-two",
      anonymousSessionId: null,
      now: LATER,
    })).resolves.toMatchObject({ duplicate: false, markedDisputed: false });
    const managerStorage = await database.prepare(
      `SELECT count(*)::text AS "count",
              min(price_record_id) AS "priceRecordId"
         FROM wrong_price_reports
        WHERE venue_id = 'pg-manager-venue'
          AND beer_name = 'Guinness'
          AND reason = 'price_changed'`,
    ).get<{ count: string; priceRecordId: string | null }>();
    expect(managerStorage).toEqual({ count: "2", priceRecordId: null });

    const workflowRace = await Promise.all([
      repository.updateFeedbackWorkflow({
        id: "pg-feedback",
        status: "in_progress",
        assignedTo: "pg-admin",
        resolutionNote: "Investigating.",
        resolvedBy: "pg-admin",
        expectedUpdatedAt: NOW,
        now: LATER,
      }),
      repository.updateFeedbackWorkflow({
        id: "pg-feedback",
        status: "resolved",
        assignedTo: "pg-admin",
        resolutionNote: "Resolved.",
        resolvedBy: "pg-admin",
        expectedUpdatedAt: NOW,
        now: LATEST,
      }),
    ]);
    expect(workflowRace.filter((result) => result.state === "updated")).toHaveLength(1);
    expect(workflowRace.filter((result) => result.state === "conflict")).toHaveLength(1);
  });

  it("rolls back an accepted PostgreSQL insert after an injected failure", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES ('pg-rollback-user', 'pg-rollback-user@example.test', 'hash', 'user', 'free', @now, @now)`,
    ).run({ now: NOW });
    const faulted = new SupportFeedbackRepository(new WrongPriceInsertFaultDatabase(database));
    await expect(faulted.createWrongPriceReport({
      id: "pg-rollback-report",
      userId: "pg-rollback-user",
      anonymousSessionId: null,
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "pg-price",
      beerName: "Carlton Draught",
      reason: "other",
      notes: null,
      sourcePhotoUrl: null,
      now: LATEST,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    const row = await database.prepare(
      "SELECT count(*) AS \"count\" FROM wrong_price_reports WHERE id = 'pg-rollback-report'",
    ).get<{ count: string }>();
    expect(Number(row?.count ?? 0)).toBe(0);
  });
});
