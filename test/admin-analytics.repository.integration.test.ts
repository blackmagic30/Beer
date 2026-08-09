import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminAnalyticsRepository,
  AdminAnalyticsRepositoryError,
  type AdminAnalyticsRepositoryErrorCode,
} from "../src/db/admin-analytics.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import {
  ANALYTICS_AS_OF,
  ANALYTICS_STALE_BEFORE,
  ANALYTICS_TOTAL_VENUES,
  EXPECTED_COVERAGE_WITHOUT_AGE,
  EXPECTED_KPI_BUCKETS,
  EXPECTED_KPI_METRICS,
  EXPECTED_MONTH_COHORTS,
  EXPECTED_PARTNER_LEADS,
  EXPECTED_WEEK_COHORTS,
  KPI_INPUT,
  seedAdminAnalyticsFixture,
} from "./admin-analytics.repository.fixtures.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_admin_analytics_integration_test";
const TEST_LOGIN = "pintpath_admin_analytics_login";
const TEST_PASSWORD = "admin-analytics-test-password";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";

const TABLES = [
  "accounts",
  "missions",
  "venue_location_cache",
  "venue_profiles",
  "events",
  "submissions",
  "contribution_ledger",
  "venue_price_records",
  "venue_requests",
] as const;

function validateDisposableAdminUrl(value: string): URL {
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
    throw new Error(
      `${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`,
    );
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

/** Test-only adapter for an explicitly insecure disposable loopback database. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{
    client: PoolClient;
    nextSavepoint: number;
  }>();
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
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
        const savepoint = `pintpath_nested_${active.nextSavepoint++}`;
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
        await client.query("BEGIN READ ONLY");
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

function expectCode(code: AdminAnalyticsRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof AdminAnalyticsRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("admin analytics repository on real PostgreSQL 17", () => {
  let maintenanceUrl: URL | null = null;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let adminDatabase: LoopbackPostgresTestDatabase | null = null;
  let restrictedDatabase: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: AdminAnalyticsRepository;

  beforeAll(async () => {
    maintenanceUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: maintenanceUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Admin analytics integration requires PostgreSQL 17; received ${version}.`);
    }

    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN}
       LOGIN PASSWORD '${TEST_PASSWORD}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.query(`REVOKE ALL ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    const targetAdminUrl = withDatabase(maintenanceUrl, TEST_DATABASE);
    restrictedUrl = withDatabase(maintenanceUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    targetAdmin = new Client({ connectionString: targetAdminUrl });
    await targetAdmin.connect();
    await targetAdmin.query(`CREATE SCHEMA pintpath_app`);
    await targetAdmin.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await targetAdmin.query(`GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN}`);
    await targetAdmin.query(`ALTER ROLE ${TEST_LOGIN} IN DATABASE ${TEST_DATABASE}
      SET search_path = pintpath_app, pg_catalog`);
    await targetAdmin.query(`SET search_path = pintpath_app, pg_catalog`);
    await targetAdmin.query(`
      CREATE TABLE accounts (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'user',
        subscription_status text NOT NULL DEFAULT 'free',
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE missions (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        suburb text,
        reason text NOT NULL,
        priority text NOT NULL DEFAULT 'normal',
        points numeric NOT NULL,
        multiplier numeric NOT NULL DEFAULT 1,
        active boolean NOT NULL DEFAULT true,
        sponsor_flag boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_location_cache (
        venue_id text PRIMARY KEY,
        venue_name text NOT NULL,
        suburb text,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        suburb text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE events (
        id text PRIMARY KEY,
        user_id text REFERENCES accounts(id),
        anonymous_session_id text,
        event_type text NOT NULL,
        venue_id text,
        beer_id text,
        suburb text,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
        created_at timestamptz NOT NULL
      );
      CREATE TABLE submissions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(id),
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        submission_type text NOT NULL,
        observed_at timestamptz NOT NULL,
        points_awarded numeric NOT NULL DEFAULT 0,
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE contribution_ledger (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(id),
        submission_id text,
        venue_id text NOT NULL,
        points numeric NOT NULL,
        reason text NOT NULL,
        month_key text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE venue_price_records (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        suburb text,
        beer_name text NOT NULL,
        normalized_beer_id text,
        serving_size text NOT NULL,
        price numeric,
        is_happy_hour_price boolean NOT NULL DEFAULT false,
        happy_hour_details text,
        is_on_tap text NOT NULL DEFAULT 'unknown',
        confidence text NOT NULL DEFAULT 'user_reported_pending',
        source_type text NOT NULL,
        last_verified_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_requests (
        id text PRIMARY KEY,
        user_id text REFERENCES accounts(id),
        anonymous_session_id text,
        request_type text NOT NULL,
        venue_id text,
        venue_name text,
        suburb text,
        status text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);

    for (const table of TABLES) {
      await targetAdmin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await targetAdmin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await targetAdmin.query(
        `CREATE POLICY ${table}_analytics_select ON ${table}
         FOR SELECT TO ${TEST_LOGIN} USING (true)`,
      );
    }
    await targetAdmin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA pintpath_app TO ${TEST_LOGIN}`);
    adminDatabase = new LoopbackPostgresTestDatabase(targetAdminUrl);
  });

  beforeEach(async () => {
    if (!targetAdmin || !adminDatabase) throw new Error("PostgreSQL fixture is unavailable.");
    await restrictedDatabase?.close();
    restrictedDatabase = null;
    await targetAdmin.query(`TRUNCATE TABLE
      events, contribution_ledger, submissions, venue_requests, venue_price_records,
      venue_profiles, venue_location_cache, missions, accounts`);
    await seedAdminAnalyticsFixture(adminDatabase);
    restrictedDatabase = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new AdminAnalyticsRepository(restrictedDatabase);
  });

  afterAll(async () => {
    await restrictedDatabase?.close().catch(() => undefined);
    await adminDatabase?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      const leftovers = await admin.query<{ database_exists: boolean; role_exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      expect(leftovers.rows[0]).toEqual({ database_exists: false, role_exists: false });
      await admin.end().catch(() => undefined);
    }
  });

  it("matches the SQLite fixture exactly across native JSONB, boolean, numeric, timestamp, and null values", async () => {
    if (!targetAdmin) throw new Error("PostgreSQL fixture is unavailable.");
    await expect(repository.countKnownVenues()).resolves.toBe(12);
    const dashboard = await repository.getAdminKpiDashboard(KPI_INPUT);
    const preview = await repository.getAnalyticsPreview();
    expect(preview.missionConversionCount).toBe(1);
    expect(preview.topSearchedBeers).toContainEqual({ key: "guinness", count: 3 });
    expect(preview.topClickedVenues).toContainEqual({ key: "venue-alpha", label: "Alpha Hotel", count: 3 });
    expect(dashboard.metrics).toEqual(EXPECTED_KPI_METRICS);
    expect({
      topSearchedBeers: dashboard.topSearchedBeers,
      topSearchedSuburbs: dashboard.topSearchedSuburbs,
      topClickedVenues: dashboard.topClickedVenues,
      topVenuesNeedingData: dashboard.topVenuesNeedingData,
      highDemandVenuesWithStaleOrMissingData: dashboard.highDemandVenuesWithStaleOrMissingData,
    }).toEqual(EXPECTED_KPI_BUCKETS);
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 24 }))
      .resolves.toEqual(EXPECTED_WEEK_COHORTS);
    await expect(repository.getRetentionCohorts({ groupBy: "month", limit: 24 }))
      .resolves.toEqual(EXPECTED_MONTH_COHORTS);

    const coverage = await repository.getCoverageDashboard({
      staleBefore: ANALYTICS_STALE_BEFORE,
      asOf: ANALYTICS_AS_OF,
      totalVenues: ANALYTICS_TOTAL_VENUES,
    });
    const { averagePriceRecordAgeDays, ...stableCoverage } = coverage;
    expect(stableCoverage).toEqual(EXPECTED_COVERAGE_WITHOUT_AGE);
    expect(averagePriceRecordAgeDays).toBe(32);
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 10 }))
      .resolves.toEqual(EXPECTED_PARTNER_LEADS);

    const allTime = await repository.getAdminKpiDashboard({ ...KPI_INPUT, since: null });
    expect(allTime.metrics).toMatchObject({
      newUsers: 5,
      subscriptionConversionCount: 2,
      totalRejectedSubmissions: 2,
      totalContributorPointsAwarded: 14.5,
    });

    await targetAdmin.query(
      `UPDATE pintpath_app.events
          SET metadata_json = '{"venueName": 12}'::jsonb
        WHERE id = 'event-alpha-card'`,
    );
    await expect(repository.getAnalyticsPreview())
      .rejects.toSatisfy(expectCode("malformed_record"));
    await expect(repository.getAdminKpiDashboard(KPI_INPUT))
      .rejects.toSatisfy(expectCode("malformed_record"));
    await targetAdmin.query(
      `UPDATE pintpath_app.events
          SET metadata_json = '{"venueName": "Alpha Hotel"}'::jsonb
        WHERE id = 'event-alpha-card'`,
    );
    await targetAdmin.query(
      "UPDATE pintpath_app.venue_price_records SET confidence = 'corrupt' WHERE id = 'price-stale'",
    );
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 10 }))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("keeps concurrent reads deterministic and enforces all result bounds", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, async () => Promise.all([
      repository.getRetentionCohorts({ groupBy: "week", limit: 2 }),
      repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 2 }),
    ])));
    for (const [cohorts, leads] of results) {
      expect(cohorts).toEqual(EXPECTED_WEEK_COHORTS.slice(0, 2));
      expect(leads).toEqual(EXPECTED_PARTNER_LEADS.slice(0, 2));
    }
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 25 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 101 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("runs under forced RLS with SELECT-only privileges, rolls back, and closes privately", async () => {
    if (!targetAdmin || !restrictedDatabase) throw new Error("PostgreSQL fixture is unavailable.");
    const role = await restrictedDatabase.prepare(
      `SELECT current_user AS "currentUser",
              current_setting('transaction_read_only') AS "readOnly"`,
    ).get<{ currentUser: string; readOnly: string }>();
    expect(role?.currentUser).toBe(TEST_LOGIN);

    const privileges = await targetAdmin.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      rls: boolean;
      force_rls: boolean;
    }>(
      `SELECT table_name,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'DELETE') AS can_delete,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'TRUNCATE') AS can_truncate,
              relrowsecurity AS rls,
              relforcerowsecurity AS force_rls
         FROM information_schema.tables
         JOIN pg_catalog.pg_class ON relname = table_name
        WHERE table_schema = 'pintpath_app'
        ORDER BY table_name`,
      [TEST_LOGIN],
    );
    expect(privileges.rows).toHaveLength(TABLES.length);
    for (const privilege of privileges.rows) {
      expect(privilege).toMatchObject({
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        rls: true,
        force_rls: true,
      });
    }
    await expect(restrictedDatabase.prepare(
      "INSERT INTO events (id, event_type, metadata_json, created_at) VALUES ('forbidden', 'x', '{}', CURRENT_TIMESTAMP)",
    ).run()).rejects.toThrow();

    const before = await repository.countKnownVenues();
    await expect(restrictedDatabase.transaction(async () => {
      await repository.getAdminKpiDashboard(KPI_INPUT);
      throw new Error("force read-only rollback");
    })()).rejects.toThrow("force read-only rollback");
    await expect(repository.countKnownVenues()).resolves.toBe(before);
    expect(restrictedDatabase.metrics().transactionFailures).toBe(1);

    await restrictedDatabase.close();
    await expect(repository.countKnownVenues()).rejects.toSatisfy(expectCode("persistence_failure"));
  });
});
