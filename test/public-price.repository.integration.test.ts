import crypto from "node:crypto";

import { Client, Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_public_price_integration_test";
const TEST_LOGIN = "pintpath_public_price_integration_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const BASE_TIME = "2026-08-08T00:00:00.000Z";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";
const MINUTE_2 = "2026-08-08T00:02:00.000Z";
const MINUTE_3 = "2026-08-08T00:03:00.000Z";
const MINUTE_4 = "2026-08-08T00:04:00.000Z";
const MINUTE_5 = "2026-08-08T00:05:00.000Z";
const MINUTE_6 = "2026-08-08T00:06:00.000Z";
const MINUTE_7 = "2026-08-08T00:07:00.000Z";

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
  private completedQueries = 0;
  private failedQueries = 0;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000",
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    try {
      const result = await this.pool.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return {
        rows: result.rows.map(normalizeRow),
        rowCount: result.rowCount ?? 0,
      };
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

  transaction<Result>(_work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      throw new Error("PublicPriceRepository must not open a transaction.");
    };
  }

  async close(): Promise<void> {
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

describe.skipIf(!configuredAdminUrl)("public price repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: PublicPriceRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const identity = await admin.query<{ server_version_num: string; is_superuser: boolean }>(
      `SELECT
         current_setting('server_version_num') AS server_version_num,
         role.rolsuper AS is_superuser
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`,
    );
    const version = Number(identity.rows[0]?.server_version_num ?? 0);
    if (version < 170_000 || version >= 180_000 || !identity.rows[0]?.is_superuser) {
      throw new Error("The disposable public-price rehearsal requires a PostgreSQL 17 superuser.");
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
      CREATE TABLE venue_identity_aliases (
        alias_venue_id text PRIMARY KEY,
        canonical_venue_id text NOT NULL
      );
      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        address text,
        suburb text,
        membership_tier text NOT NULL DEFAULT 'basic',
        highlighted_name boolean NOT NULL DEFAULT FALSE,
        premium_badge text,
        promoted boolean NOT NULL DEFAULT FALSE,
        featured_special_eligible boolean NOT NULL DEFAULT FALSE,
        accepts_pint_path_codes boolean NOT NULL DEFAULT FALSE,
        active boolean NOT NULL DEFAULT TRUE
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
        is_happy_hour_price boolean NOT NULL DEFAULT FALSE,
        happy_hour_details text,
        is_on_tap text NOT NULL DEFAULT 'unknown',
        confidence text NOT NULL DEFAULT 'user_reported_pending',
        source_type text NOT NULL,
        source_submission_id text,
        source_ingestion_id text,
        source_evidence_reference text,
        source_evidence_verified_at timestamptz,
        last_verified_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_beers (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        beer_name text NOT NULL,
        normalized_beer_id text,
        serve_size text,
        price numeric,
        on_tap boolean NOT NULL DEFAULT FALSE,
        in_stock boolean NOT NULL DEFAULT TRUE,
        price_verified_at timestamptz,
        source_ingestion_id text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_happy_hours (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
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
        venue_id text NOT NULL,
        title text NOT NULL,
        description text NOT NULL,
        price numeric,
        discount text,
        starts_at timestamptz,
        ends_at timestamptz,
        start_time time without time zone,
        end_time time without time zone,
        schedule_note text,
        exclusive boolean NOT NULL DEFAULT FALSE,
        active boolean NOT NULL DEFAULT TRUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON ALL TABLES IN SCHEMA pintpath_app TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new PublicPriceRepository(database);
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
      throw new Error("Disposable public-price PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("preserves native bool/numeric/timestamptz ranking, pagination, and manager projections", async () => {
    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    await targetAdmin!.query(
      `INSERT INTO venue_profiles (
         venue_id, name, address, suburb, membership_tier, highlighted_name,
         premium_badge, promoted, featured_special_eligible, accepts_pint_path_codes, active
       ) VALUES
         ('venue-canonical', 'Canonical Hotel', '1 Test Street', 'Fitzroy', 'plus',
          TRUE, 'Partner', TRUE, TRUE, TRUE, TRUE)`,
    );
    await targetAdmin!.query(
      `INSERT INTO venue_identity_aliases (alias_venue_id, canonical_venue_id)
       VALUES ('venue-alias', 'venue-canonical')`,
    );
    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, happy_hour_details,
         is_on_tap, confidence, source_type, source_ingestion_id,
         source_evidence_reference, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       ) VALUES
         ('carlton-old', 'venue-alias', 'Old Hotel', 'Fitzroy', 'Carlton Draught',
          'carlton_draft', 'pint', 12.25, FALSE, NULL, 'yes', 'community_confirmed',
          'community_verified', NULL, NULL, NULL, $1, $1, $1),
         ('carlton-current', 'venue-canonical', 'Canonical Hotel', 'Fitzroy', 'Carlton Draught',
          'carlton_draft', 'pint', 11.75, FALSE, NULL, 'yes', 'community_confirmed',
          'community_verified', NULL, NULL, NULL, $2, $1, $2),
         ('happy-current', 'venue-alias', 'Old Hotel', 'Fitzroy', 'Carlton Draught',
          'carlton_draft', 'pint', 8.50, TRUE, 'Weekdays', 'yes', 'community_confirmed',
          'community_verified', NULL, NULL, NULL, $3, $1, $3),
         ('guinness-current', 'venue-canonical', 'Canonical Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 14.50, FALSE, NULL, 'yes', 'community_confirmed',
          'community_verified', 'ingestion-1', 'evidence/object-1', $4, $4, $1, $4),
         ('quarantined', 'venue-canonical', 'Canonical Hotel', 'Fitzroy', 'Hidden Beer',
          'hidden', 'pint', 99.00, FALSE, NULL, 'unknown', 'disputed',
          'source_ingestion_quarantined', 'ingestion-q', NULL, NULL, $4, $1, $4)`,
      [MINUTE_1, MINUTE_2, MINUTE_4, MINUTE_5],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, source_ingestion_id, created_at, updated_at
       ) VALUES
         ('manager-carlton', 'venue-canonical', 'Carlton Draught', 'carlton_draft',
          'pint', 10.50, TRUE, TRUE, $3, NULL, $1, $3),
         ('manager-stone', 'venue-canonical', 'Stone & Wood Pacific Ale', 'stone_and_wood_pacific_ale',
          'pint', 13.25, TRUE, TRUE, $2, NULL, $1, $2)`,
      [BASE_TIME, MINUTE_2, MINUTE_3],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_happy_hours (
         id, venue_id, title, days_of_week_json, start_time, end_time,
         description, happy_hour_beers_json, active, created_at, updated_at
       ) VALUES (
         'manager-happy', 'venue-canonical', 'Friday Frothies', $1::jsonb, '17:00', '19:00',
         'Two hours of offers', $2::jsonb, TRUE, $3, $4
       )`,
      [
        JSON.stringify(["friday"]),
        JSON.stringify([{
          beerName: "Carlton Draught",
          normalizedBeerId: "carlton_draft",
          servingSize: "pint",
          happyHourPrice: 7.5,
          onTap: true,
          inStock: true,
        }]),
        BASE_TIME,
        MINUTE_6,
      ],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_specials (
         id, venue_id, title, description, price, discount, starts_at, ends_at,
         start_time, end_time, schedule_note, exclusive, active, created_at, updated_at
       ) VALUES (
         'manager-special', 'venue-canonical', 'Member pint', 'A launch offer', 8.25,
         '$2 off', $1, $2, '17:00', '20:00', 'Friday only', TRUE, TRUE, $1, $3
       )`,
      [BASE_TIME, MINUTE_7, MINUTE_7],
    );

    const current = await repository.listCurrentPriceRecords();
    expect(current.map((record) => record.id)).toEqual([
      "guinness-current",
      "happy-current",
      "carlton-current",
    ]);
    expect(current.find((record) => record.id === "guinness-current")).toEqual(expect.objectContaining({
      price: 14.5,
      isHappyHourPrice: false,
      hasSourceLinkage: true,
      hasSourceEvidence: true,
      lastVerifiedAt: MINUTE_5,
    }));

    const firstPage = await repository.listCurrentPriceRecordPage({ limit: 1 });
    expect(firstPage.map((record) => record.id)).toEqual(["guinness-current"]);
    const secondPage = await repository.listCurrentPriceRecordPage({
      limit: 5,
      before: { verifiedAt: firstPage[0]!.lastVerifiedAt, id: firstPage[0]!.id },
    });
    expect(secondPage.map((record) => record.id)).toEqual(["happy-current"]);

    const manager = await repository.listVenueManagerPriceRecords(20, "venue-canonical");
    expect(manager.map((record) => record.id)).toEqual([
      "venue_special:manager-special",
      "bar_happy_hour:manager-happy",
      "bar_beer:manager-carlton",
      "bar_beer:manager-stone",
    ]);
    expect(manager[0]).toEqual(expect.objectContaining({
      price: 8.25,
      specialExclusive: true,
      membershipTier: "pro",
      highlightedName: true,
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
    }));
    expect(manager[1]).toEqual(expect.objectContaining({
      happyHourDays: ["friday"],
      happyHourStartTime: "17:00:00",
      happyHourEndTime: "19:00:00",
      happyHourBeers: [expect.objectContaining({ happyHourPrice: 7.5, onTap: true })],
    }));
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_beer:manager-carlton"))
      .resolves.toEqual(manager.find((record) => record.id === "bar_beer:manager-carlton"));
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_happy_hour:manager-happy"))
      .resolves.toBeNull();
  });
});
