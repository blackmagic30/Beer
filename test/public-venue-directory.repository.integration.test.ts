import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import type {
  SqlDatabase,
  SqlPoolMetrics,
  SqlRunResult,
  SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_public_venue_directory_integration_test";
const NOW = "2026-08-08T00:00:00.000Z";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";

function validateDisposableAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback Postgres admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.hash
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  }
  return url;
}

function withDatabase(url: URL, databaseName: string): string {
  const target = new URL(url.toString());
  target.pathname = `/${databaseName}`;
  return target.toString();
}

function compileQuestionMarkBindings(sql: string): string {
  let binding = 0;
  return sql.replaceAll("?", () => `$${++binding}`);
}

class IntegrationPostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: Client) {}

  prepare(sql: string): SqlStatement {
    const text = compileQuestionMarkBindings(sql);
    return {
      run: async (...bindings: unknown[]): Promise<SqlRunResult> => {
        const result = await this.client.query(text, bindings);
        return { changes: result.rowCount ?? 0 };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]): Promise<Row | undefined> => {
        const result = await this.client.query<Row>(text, bindings);
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]): Promise<Row[]> => {
        const result = await this.client.query<Row>(text, bindings);
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      await this.client.query("BEGIN");
      try {
        const result = await work();
        await this.client.query("COMMIT");
        return result;
      } catch (error) {
        await this.client.query("ROLLBACK");
        throw error;
      }
    };
  }

  async close(): Promise<void> {}

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: 1,
      idleConnections: 0,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("public venue directory on real PostgreSQL 17", () => {
  let admin: Client;
  let target: Client;
  let repository: PublicVenueDirectoryRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    target = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await target.connect();
    await target.query(`
      CREATE SCHEMA pintpath_app;
      SET search_path = pintpath_app, pg_catalog;
      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        address text,
        suburb text,
        phone text,
        website text,
        instagram text,
        description text,
        opening_hours_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        venue_tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        active boolean NOT NULL DEFAULT TRUE,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_location_cache (
        venue_id text PRIMARY KEY,
        latitude numeric,
        longitude numeric
      );
      CREATE TABLE missions (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        suburb text,
        active boolean NOT NULL DEFAULT TRUE,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE venue_identity_aliases (
        alias_venue_id text PRIMARY KEY,
        canonical_venue_id text NOT NULL
      );
      CREATE TABLE venue_price_records (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        normalized_beer_id text,
        beer_name text NOT NULL,
        source_type text NOT NULL,
        source_ingestion_id text
      );
      CREATE TABLE venue_beers (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        normalized_beer_id text,
        beer_name text NOT NULL,
        in_stock boolean NOT NULL DEFAULT TRUE,
        source_ingestion_id text
      );
    `);
    repository = new PublicVenueDirectoryRepository(new IntegrationPostgresDatabase(target));
  }, 30_000);

  afterAll(async () => {
    await target?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("uses native booleans/jsonb and portable bounded VALUES queries", async () => {
    await target.query(
      `INSERT INTO venue_profiles (
         venue_id, name, address, suburb, opening_hours_json, venue_tags_json, active, updated_at
       ) VALUES
         ('venue-a', 'Alpha Hotel', '1 Main Street', 'Fitzroy', $1::jsonb, $2::jsonb, TRUE, $3),
         ('venue-hidden', 'Hidden Hotel', NULL, NULL, '{}'::jsonb, '[]'::jsonb, FALSE, $3)`,
      [JSON.stringify({ friday: { open: true } }), JSON.stringify(["user submitted"]), NOW],
    );
    await target.query(
      "INSERT INTO venue_location_cache (venue_id, latitude, longitude) VALUES ('venue-a', -37.8, 144.9)",
    );
    await target.query(
      `INSERT INTO missions (id, venue_id, venue_name, suburb, active, updated_at) VALUES
         ('mission-a', 'venue-a', 'Mission Duplicate', 'Fitzroy', TRUE, $1),
         ('mission-b', 'venue-b', 'bravo Mission', 'Brunswick', TRUE, $1)`,
      [NOW],
    );
    await target.query(
      "INSERT INTO venue_identity_aliases (alias_venue_id, canonical_venue_id) VALUES ('venue-alias', 'venue-a')",
    );
    await target.query(
      `INSERT INTO venue_price_records (
         id, venue_id, normalized_beer_id, beer_name, source_type, source_ingestion_id
       ) VALUES
         ('price-a', 'venue-alias', 'carlton_draft', 'Carlton Draught', 'community_verified', NULL),
         ('price-quarantined', 'venue-a', 'victoria_bitter', 'Victoria Bitter', 'source_ingestion_quarantined', 'ingestion-q')`,
    );
    await target.query(
      `INSERT INTO venue_beers (
         id, venue_id, normalized_beer_id, beer_name, in_stock, source_ingestion_id
       ) VALUES
         ('beer-a', 'venue-a', 'guinness', 'Guinness', TRUE, NULL),
         ('beer-out', 'venue-a', 'hahn_super_dry', 'Hahn Super Dry', FALSE, NULL),
         ('beer-q', 'venue-a', 'stone_and_wood_pacific_ale', 'Stone & Wood Pacific Ale', TRUE, 'ingestion-q')`,
    );

    const page = await repository.listPublicVenueDirectoryPage({ limit: 20, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.venues).toEqual([
      expect.objectContaining({
        id: "venue-a",
        openingHours: { friday: { open: true } },
        venueTags: ["user submitted"],
        isUserSubmittedVenue: true,
        latitude: -37.8,
        longitude: 144.9,
      }),
      expect.objectContaining({ id: "venue-b", name: "bravo Mission" }),
    ]);
    const keys = await repository.listPublicVenueBeerKeys(["venue-a", "venue-alias"]);
    expect(keys.get("venue-a")).toEqual(["carlton_draft", "guinness"]);
    expect(keys.get("venue-alias")).toEqual(["carlton_draft", "guinness"]);
  });
});
