import crypto from "node:crypto";

import { Client, Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  VenueDataReadRepository,
  VenueDataReadRepositoryError,
} from "../src/db/venue-data-read.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_venue_data_read_it";
const TEST_LOGIN = "pintpath_venue_data_read_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const BASE_TIME = "2026-08-09T00:00:00.000Z";
const MINUTE_1 = "2026-08-09T00:01:00.000Z";
const MINUTE_2 = "2026-08-09T00:02:00.000Z";
const MINUTE_3 = "2026-08-09T00:03:00.000Z";

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
  ) {
    return bindings[0] as Readonly<Record<string, unknown>>;
  }
  return bindings;
}

function collectIndexNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectIndexNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  for (const [key, child] of Object.entries(value)) {
    if (key === "Index Name" && typeof child === "string") names.add(child);
    else collectIndexNames(child, names);
  }
  return names;
}

/** Test-only adapter for an explicitly insecure loopback PostgreSQL rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private completedQueries = 0;
  private failedQueries = 0;
  private closed = false;
  private nativeBooleanObserved = false;
  private canonicalTimestampObserved = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
      application_name: "pintpath-venue-data-read-integration",
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000",
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    try {
      const result = await this.pool.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      for (const row of result.rows) {
        if (Object.hasOwn(row, "existsFlag") && typeof row.existsFlag === "boolean") {
          this.nativeBooleanObserved = true;
        }
        if (
          Object.hasOwn(row, "lastVerifiedAt")
          && typeof row.lastVerifiedAt === "string"
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.lastVerifiedAt)
        ) {
          this.canonicalTimestampObserved = true;
        }
      }
      return result;
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount ?? 0 };
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
      throw new Error("VenueDataReadRepository must not open a transaction.");
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

  nativeResultsObserved(): { boolean: boolean; timestamp: boolean } {
    return {
      boolean: this.nativeBooleanObserved,
      timestamp: this.canonicalTimestampObserved,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("venue data read repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: VenueDataReadRepository;

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
      throw new Error("The disposable venue-data rehearsal requires a PostgreSQL 17 superuser.");
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
    await admin.query(`REVOKE CONNECT ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(`
      CREATE SCHEMA pintpath_app;
      SET search_path = pintpath_app, pg_catalog;

      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        suburb text,
        active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE venue_location_cache (
        venue_id text PRIMARY KEY,
        venue_name text NOT NULL,
        suburb text,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_price_records (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        suburb text,
        beer_name text NOT NULL,
        normalized_beer_id text,
        last_verified_at timestamptz NOT NULL
      );

      CREATE INDEX idx_venue_profiles_duplicate_name
        ON venue_profiles (
          lower(btrim(name)),
          lower(btrim(COALESCE(suburb, ''))),
          venue_id COLLATE "C"
        ) INCLUDE (name, suburb)
        WHERE active;
      CREATE INDEX idx_venue_location_cache_duplicate_name
        ON venue_location_cache (
          lower(btrim(venue_name)),
          lower(btrim(COALESCE(suburb, ''))),
          venue_id COLLATE "C"
        ) INCLUDE (venue_name, suburb);
      CREATE INDEX idx_venue_price_records_duplicate_name
        ON venue_price_records (
          lower(btrim(venue_name)),
          lower(btrim(COALESCE(suburb, ''))),
          venue_id COLLATE "C",
          id COLLATE "C"
        ) INCLUDE (venue_name, suburb);
      CREATE INDEX idx_venue_price_records_venue
        ON venue_price_records (venue_id, last_verified_at DESC);
      CREATE INDEX idx_venue_price_records_venue_normalized_beer
        ON venue_price_records (venue_id, normalized_beer_id)
        WHERE normalized_beer_id IS NOT NULL;
      CREATE INDEX idx_venue_price_records_venue_beer_name
        ON venue_price_records (venue_id, lower(btrim(beer_name)));

      ALTER TABLE venue_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE venue_profiles FORCE ROW LEVEL SECURITY;
      ALTER TABLE venue_location_cache ENABLE ROW LEVEL SECURITY;
      ALTER TABLE venue_location_cache FORCE ROW LEVEL SECURITY;
      ALTER TABLE venue_price_records ENABLE ROW LEVEL SECURITY;
      ALTER TABLE venue_price_records FORCE ROW LEVEL SECURITY;

      CREATE POLICY venue_profiles_runtime_select ON venue_profiles
        FOR SELECT TO ${TEST_LOGIN} USING (venue_id <> 'rls-hidden');
      CREATE POLICY venue_location_cache_runtime_select ON venue_location_cache
        FOR SELECT TO ${TEST_LOGIN} USING (venue_id <> 'rls-hidden');
      CREATE POLICY venue_price_records_runtime_select ON venue_price_records
        FOR SELECT TO ${TEST_LOGIN} USING (venue_id <> 'rls-hidden');

      REVOKE ALL ON ALL TABLES IN SCHEMA pintpath_app FROM PUBLIC;
      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON venue_profiles, venue_location_cache, venue_price_records TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new VenueDataReadRepository(database);
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
      throw new Error("Disposable venue-data PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("enforces forced RLS and a SELECT-only non-bypass runtime role", async () => {
    const privilege = await targetAdmin!.query<{
      is_superuser: boolean;
      bypasses_rls: boolean;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      forced_rls_tables: string;
    }>(
      `SELECT role.rolsuper AS is_superuser,
              role.rolbypassrls AS bypasses_rls,
              has_table_privilege($1, 'pintpath_app.venue_profiles', 'SELECT') AS can_select,
              has_table_privilege($1, 'pintpath_app.venue_profiles', 'INSERT') AS can_insert,
              has_table_privilege($1, 'pintpath_app.venue_profiles', 'UPDATE') AS can_update,
              has_table_privilege($1, 'pintpath_app.venue_profiles', 'DELETE') AS can_delete,
              (SELECT count(*)::text
                 FROM pg_catalog.pg_class relation
                 JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'pintpath_app'
                  AND relation.relname IN (
                    'venue_profiles', 'venue_location_cache', 'venue_price_records'
                  )
                  AND relation.relrowsecurity
                  AND relation.relforcerowsecurity) AS forced_rls_tables
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = $1`,
      [TEST_LOGIN],
    );
    expect(privilege.rows[0]).toEqual({
      is_superuser: false,
      bypasses_rls: false,
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      forced_rls_tables: "3",
    });
    await expect(database!.exec(
      "INSERT INTO venue_profiles (venue_id, name, active) VALUES ('forbidden', 'Forbidden', TRUE)",
    )).rejects.toMatchObject({ code: "42501" });
  });

  it("preserves native results and deterministic semantics under concurrent reads", async () => {
    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    await targetAdmin!.query(
      `INSERT INTO venue_profiles (venue_id, name, suburb, active) VALUES
         ('venue-profile', 'The Test Hotel', 'Fitzroy', TRUE),
         ('inactive-profile', 'Closed Hotel', 'Fitzroy', FALSE),
         ('rls-hidden', 'Hidden Hotel', 'Fitzroy', TRUE)`,
    );
    await targetAdmin!.query(
      `INSERT INTO venue_location_cache (venue_id, venue_name, suburb, updated_at) VALUES
         ('venue-location', 'The Test Hotel', 'Richmond', $1),
         ('rls-hidden', 'Hidden Hotel', 'Richmond', $1)`,
      [BASE_TIME],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, last_verified_at
       ) VALUES
         ('duplicate-price', 'venue-price', 'The Test Hotel', 'Richmond',
          'Carlton Draught', 'carlton_draft', $1),
         ('old', 'venue-a', 'Alpha Hotel', 'Fitzroy',
          'Carlton Draught', 'carlton_draft', $2),
         ('new', 'venue-a', 'Alpha Hotel', 'Fitzroy',
          'Stone & Wood Pacific Ale', 'stone_and_wood_pacific_ale', $3),
         ('hidden-price', 'rls-hidden', 'Hidden Hotel', 'Fitzroy',
          'Hidden Beer', 'hidden_beer', $4)`,
      [BASE_TIME, MINUTE_1, MINUTE_2, MINUTE_3],
    );

    const batches = await Promise.all(Array.from({ length: 12 }, async () => Promise.all([
      repository.findLikelyVenueDuplicate({ name: " the test hotel ", suburb: "fitzroy" }),
      repository.findLikelyVenueDuplicate({ name: "THE TEST HOTEL", suburb: "richmond" }),
      repository.getLatestVenueDataTimestamp(" venue-a "),
      repository.venueHasPublishedBeerRecord({
        venueId: "venue-a",
        beerName: "not-the-name",
        normalizedBeerId: "stone_and_wood_pacific_ale",
      }),
      repository.venueHasPublishedBeerRecord({
        venueId: "venue-a",
        beerName: " STONE & WOOD PACIFIC ALE ",
        normalizedBeerId: "unknown",
      }),
    ])));

    for (const batch of batches) {
      expect(batch).toEqual([
        {
          venueId: "venue-profile",
          venueName: "The Test Hotel",
          suburb: "Fitzroy",
          source: "venue_profile",
        },
        {
          venueId: "venue-location",
          venueName: "The Test Hotel",
          suburb: "Richmond",
          source: "location_cache",
        },
        MINUTE_2,
        true,
        true,
      ]);
    }
    expect(database!.nativeResultsObserved()).toEqual({ boolean: true, timestamp: true });

    await expect(repository.findLikelyVenueDuplicate({ name: "Hidden Hotel" })).resolves.toBeNull();
    await expect(repository.getLatestVenueDataTimestamp("rls-hidden")).resolves.toBeNull();
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: "rls-hidden",
      beerName: "Hidden Beer",
      normalizedBeerId: "hidden_beer",
    })).resolves.toBe(false);
  });

  it("validates every proposed PostgreSQL index with EXPLAIN ANALYZE", async () => {
    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    await targetAdmin!.query("ANALYZE venue_profiles; ANALYZE venue_location_cache; ANALYZE venue_price_records");
    await targetAdmin!.query("SET enable_seqscan = off");
    const plans = [
      {
        index: "idx_venue_profiles_duplicate_name",
        sql: `SELECT venue_id, name, suburb
                FROM venue_profiles
               WHERE active = TRUE
                 AND lower(trim(name)) = 'the test hotel'
               ORDER BY CASE
                          WHEN lower(trim(COALESCE(suburb, ''))) = 'fitzroy' THEN 0
                          ELSE 1
                        END,
                        venue_id COLLATE "C"
               LIMIT 1`,
      },
      {
        index: "idx_venue_location_cache_duplicate_name",
        sql: `SELECT venue_id, venue_name, suburb
                FROM venue_location_cache
               WHERE lower(trim(venue_name)) = 'the test hotel'
               ORDER BY CASE
                          WHEN lower(trim(COALESCE(suburb, ''))) = 'richmond' THEN 0
                          ELSE 1
                        END,
                        venue_id COLLATE "C"
               LIMIT 1`,
      },
      {
        index: "idx_venue_price_records_duplicate_name",
        sql: `SELECT venue_id, venue_name, suburb
                FROM venue_price_records
               WHERE lower(trim(venue_name)) = 'the test hotel'
               ORDER BY CASE
                          WHEN lower(trim(COALESCE(suburb, ''))) = 'richmond' THEN 0
                          ELSE 1
                        END,
                        venue_id COLLATE "C", id COLLATE "C"
               LIMIT 1`,
      },
      {
        index: "idx_venue_price_records_venue",
        sql: `SELECT last_verified_at
                FROM venue_price_records
               WHERE venue_id = 'venue-a'
               ORDER BY last_verified_at DESC
               LIMIT 1`,
      },
      {
        index: "idx_venue_price_records_venue_normalized_beer",
        sql: `SELECT 1
                FROM venue_price_records
               WHERE venue_id = 'venue-a'
                 AND normalized_beer_id = 'stone_and_wood_pacific_ale'
               LIMIT 1`,
      },
      {
        index: "idx_venue_price_records_venue_beer_name",
        sql: `SELECT 1
                FROM venue_price_records
               WHERE venue_id = 'venue-a'
                 AND lower(trim(beer_name)) = 'stone & wood pacific ale'
               LIMIT 1`,
      },
    ] as const;

    try {
      for (const candidate of plans) {
        const result = await targetAdmin!.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate.sql}`,
        );
        expect([...collectIndexNames(result.rows[0]?.["QUERY PLAN"])]).toContain(candidate.index);
      }
    } finally {
      await targetAdmin!.query("RESET enable_seqscan");
    }
  });

  it("fails closed when PostgreSQL returns a malformed persisted identifier", async () => {
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.venue_location_cache (
         venue_id, venue_name, suburb, updated_at
       ) VALUES ('', 'Malformed Hotel', 'Fitzroy', $1)`,
      [BASE_TIME],
    );

    await expect(repository.findLikelyVenueDuplicate({
      name: "Malformed Hotel",
    })).rejects.toBeInstanceOf(VenueDataReadRepositoryError);
    await expect(repository.findLikelyVenueDuplicate({
      name: "Malformed Hotel",
    })).rejects.toMatchObject({ code: "malformed_record" });
  });
});
