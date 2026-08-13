import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import {
  VenuePendingChangeRepository,
  type VenuePendingChangeRepositoryError,
} from "../src/db/venue-pending-change.repository.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_venue_pending_change_integration_test";
const TEST_LOGIN = "pintpath_venue_pending_change_integration_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const BASE_TIME = "2026-08-08T00:00:00.000Z";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";
const MINUTE_2 = "2026-08-08T00:02:00.000Z";
const MINUTE_3 = "2026-08-08T00:03:00.000Z";
const MINUTE_4 = "2026-08-08T00:04:00.000Z";
const MINUTE_5 = "2026-08-08T00:05:00.000Z";

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

/** Test-only adapter for an explicitly insecure loopback PostgreSQL rehearsal. */
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
      max: 4,
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

function beerPayload(id: string, expectedUpdatedAt: string | null, name = "Postgres Lager") {
  return {
    id,
    beerName: name,
    normalizedBeerId: "postgres_lager",
    brewery: "Native Brewery",
    style: "Lager",
    abv: 4.8,
    serveSize: "pint",
    price: 12.5,
    onTap: true,
    inStock: true,
    notes: null,
    priceConfirmed: true,
    stockConfirmed: true,
    expectedUpdatedAt,
  };
}

describe.skipIf(!configuredAdminUrl)("venue pending-change repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: VenuePendingChangeRepository;
  let inventory: VenueInventoryRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const identity = await admin.query<{ server_version_num: string; is_superuser: boolean }>(
      `SELECT current_setting('server_version_num') AS server_version_num,
              role.rolsuper AS is_superuser
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`,
    );
    const version = Number(identity.rows[0]?.server_version_num ?? 0);
    if (version < 170_000 || version >= 180_000 || !identity.rows[0]?.is_superuser) {
      throw new Error("The disposable pending-change rehearsal requires a PostgreSQL 17 superuser.");
    }

    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    const password = crypto.randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(`
      CREATE SCHEMA pintpath_app;
      SET search_path = pintpath_app, pg_catalog;
      CREATE TABLE accounts (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        address text,
        suburb text,
        area text,
        phone text,
        website text,
        instagram text,
        description text,
        opening_hours_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        venue_tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        membership_tier text NOT NULL DEFAULT 'basic',
        highlighted_name boolean NOT NULL DEFAULT FALSE,
        premium_badge text,
        promoted boolean NOT NULL DEFAULT FALSE,
        featured_special_eligible boolean NOT NULL DEFAULT FALSE,
        stripe_customer_id text,
        stripe_subscription_id text,
        subscription_status text,
        subscription_current_period_end timestamptz,
        stripe_paid_membership_tier text,
        tier_manual_override boolean NOT NULL DEFAULT FALSE,
        accepts_pint_path_codes boolean NOT NULL DEFAULT FALSE,
        stripe_event_created_at timestamptz,
        pos_webhook_token_version bigint NOT NULL DEFAULT 1,
        pos_previous_token_version bigint,
        pos_previous_token_valid_until timestamptz,
        pos_last_success_at timestamptz,
        pos_last_terminal_id text,
        active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_beers (
        id text PRIMARY KEY,
        venue_id text NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
        beer_name text NOT NULL,
        normalized_beer_id text,
        brewery text,
        style text,
        abv numeric,
        serve_size text,
        price numeric,
        currency text NOT NULL DEFAULT 'AUD',
        on_tap boolean NOT NULL DEFAULT FALSE,
        in_stock boolean NOT NULL DEFAULT TRUE,
        notes text,
        price_verified_at timestamptz,
        stock_verified_at timestamptz,
        source_ingestion_id text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_happy_hours (
        id text PRIMARY KEY,
        venue_id text NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
        title text NOT NULL,
        days_of_week_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        start_time time without time zone NOT NULL,
        end_time time without time zone NOT NULL,
        description text NOT NULL,
        happy_hour_beers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_specials (
        id text PRIMARY KEY,
        venue_id text NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
        title text NOT NULL,
        description text NOT NULL,
        price numeric,
        discount text,
        savings_amount_cents bigint,
        starts_at timestamptz,
        ends_at timestamptz,
        start_time time without time zone,
        end_time time without time zone,
        recurrence_frequency text NOT NULL DEFAULT 'none',
        days_of_week_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        timezone text NOT NULL DEFAULT 'Australia/Melbourne',
        schedule_note text,
        exclusive boolean NOT NULL DEFAULT FALSE,
        active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_pending_changes (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        change_type text NOT NULL,
        action text NOT NULL,
        target_id text,
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
        status text NOT NULL DEFAULT 'pending',
        submitted_by text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        submitted_at timestamptz NOT NULL,
        reviewed_by text REFERENCES accounts(id) ON DELETE SET NULL,
        reviewed_at timestamptz,
        rejection_reason text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX venue_pending_changes_venue_status
        ON venue_pending_changes (venue_id, status, submitted_at DESC);
      CREATE INDEX venue_pending_changes_submitter_status
        ON venue_pending_changes (submitted_by, status, submitted_at DESC);
      CREATE INDEX venue_pending_changes_status
        ON venue_pending_changes (status, submitted_at DESC);
      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pintpath_app TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new VenuePendingChangeRepository(database);
    inventory = new VenueInventoryRepository(database);
    await database.prepare(
      `INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
       VALUES
         ('submitter', 'submitter@example.test', 'hash', ?, ?),
         ('reviewer-a', 'reviewer-a@example.test', 'hash', ?, ?),
         ('reviewer-b', 'reviewer-b@example.test', 'hash', ?, ?)`,
    ).run(BASE_TIME, BASE_TIME, BASE_TIME, BASE_TIME, BASE_TIME, BASE_TIME);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (!admin) return;
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
    const residue = await admin.query<{ database_count: string; role_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS database_count,
         (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = $2) AS role_count`,
      [TEST_DATABASE, TEST_LOGIN],
    );
    await admin.end().catch(() => undefined);
    admin = null;
    if (residue.rows[0]?.database_count !== "0" || residue.rows[0]?.role_count !== "0") {
      throw new Error("Disposable venue pending-change PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("uses native PostgreSQL types, a restricted role, and one-winner row/advisory fencing", async () => {
    const role = await database!.prepare(
      `SELECT role.rolsuper AS "superuser",
              role.rolcreatedb AS "createDatabase",
              role.rolcreaterole AS "createRole",
              role.rolreplication AS "replication",
              role.rolbypassrls AS "bypassRls",
              pg_catalog.has_schema_privilege(current_user, 'pintpath_app', 'CREATE') AS "schemaCreate"
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`,
    ).get<Record<string, boolean>>();
    expect(role).toEqual({
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      schemaCreate: false,
    });

    await inventory.upsertBarProfile({
      barId: "venue-pg",
      name: "Postgres Hotel",
      address: null,
      suburb: "Fitzroy",
      area: "Inner North",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: { fri: { open: "12:00", close: "23:00" } },
      venueTags: ["native jsonb"],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      tierManualOverride: false,
      acceptsPintPathCodes: false,
      active: true,
      now: BASE_TIME,
    });
    const pending = await repository.createBarPendingChange({
      id: "pending-pg-race",
      barId: "venue-pg",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-pg-race",
      payload: beerPayload("beer-pg-race", null),
      submittedBy: "submitter",
      now: "2026-08-08T10:01:00+10:00",
    });
    expect(pending.submittedAt).toBe(MINUTE_1);

    const reviews = await Promise.allSettled([
      repository.reviewBarPendingChange({
        id: pending.id,
        status: "approved",
        reviewedBy: "reviewer-a",
        expectedUpdatedAt: pending.updatedAt,
        reviewedAt: MINUTE_2,
        rejectionReason: null,
      }),
      repository.reviewBarPendingChange({
        id: pending.id,
        status: "approved",
        reviewedBy: "reviewer-b",
        expectedUpdatedAt: pending.updatedAt,
        reviewedAt: MINUTE_2,
        rejectionReason: null,
      }),
    ]);
    expect(reviews.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = reviews.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected one reviewer to lose the PostgreSQL race.");
    expect((rejected.reason as VenuePendingChangeRepositoryError).code).toBe("pending_change_not_reviewable");
    expect(await inventory.getBarBeerById("beer-pg-race")).toMatchObject({
      price: 12.5,
      abv: 4.8,
      priceVerifiedAt: MINUTE_2,
      stockVerifiedAt: MINUTE_2,
    });
    expect(await repository.countBarPendingChanges()).toBe(1);
    expect(await repository.countBarPendingChanges({ status: "pending" })).toBe(0);
    expect(await repository.countBarPendingChanges({ status: "approved", barId: "venue-pg" })).toBe(1);

    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    const native = await targetAdmin!.query<{
      payload_type: string;
      submitted_type: string;
      price_type: string;
      on_tap_type: string;
      count_type: string;
    }>(
      `SELECT
         pg_catalog.pg_typeof(pending.payload_json)::text AS payload_type,
         pg_catalog.pg_typeof(pending.submitted_at)::text AS submitted_type,
         pg_catalog.pg_typeof(beer.price)::text AS price_type,
         pg_catalog.pg_typeof(beer.on_tap)::text AS on_tap_type,
         (SELECT pg_catalog.pg_typeof(count(*))::text FROM venue_pending_changes) AS count_type
       FROM venue_pending_changes pending
       JOIN venue_beers beer ON beer.id = pending.target_id
       WHERE pending.id = $1`,
      [pending.id],
    );
    expect(native.rows[0]).toEqual({
      payload_type: "jsonb",
      submitted_type: "timestamp with time zone",
      price_type: "numeric",
      on_tap_type: "boolean",
      count_type: "bigint",
    });
  });

  it("rolls back a stale PostgreSQL approval without changing pending or inventory state", async () => {
    const original = await inventory.upsertBarBeer({
      id: "beer-pg-stale",
      barId: "venue-pg",
      beerName: "Original",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 10,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: MINUTE_2,
    });
    const pending = await repository.createBarPendingChange({
      id: "pending-pg-stale",
      barId: "venue-pg",
      changeType: "beer",
      action: "upsert",
      targetId: original.id,
      payload: beerPayload(original.id, original.updatedAt, "Pending writer"),
      submittedBy: "submitter",
      now: MINUTE_3,
    });
    await inventory.upsertBarBeer({
      id: original.id,
      barId: "venue-pg",
      beerName: "Concurrent writer",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 11,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      expectedUpdatedAt: original.updatedAt,
      now: MINUTE_4,
    });

    await expect(repository.reviewBarPendingChange({
      id: pending.id,
      status: "approved",
      reviewedBy: "reviewer-a",
      expectedUpdatedAt: pending.updatedAt,
      reviewedAt: MINUTE_5,
      rejectionReason: null,
    })).rejects.toMatchObject({ code: "target_version_conflict" });
    expect(await repository.getBarPendingChangeById(pending.id)).toMatchObject({
      status: "pending",
      reviewedBy: null,
    });
    expect(await inventory.getBarBeerById(original.id)).toMatchObject({
      beerName: "Concurrent writer",
      price: 11,
    });
  });
});
