import crypto from "node:crypto";

import { Client, Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SavedUpdatesReadRepository,
  type SavedUpdateReadScope,
} from "../src/db/saved-updates-read.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_saved_updates_read_it";
const TEST_LOGIN = "pintpath_saved_updates_read_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const AS_OF = "2026-08-31T12:00:00.000Z";
const EVENT_WINDOW_START = "2026-08-24T12:00:00.000Z";
const STALE_WINDOW_START = "2026-07-25T12:00:00.000Z";
const STALE_BEFORE = "2026-08-01T12:00:00.000Z";

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
      max: 2,
      application_name: "pintpath-saved-updates-read-integration",
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
      throw new Error("SavedUpdatesReadRepository must not open a transaction.");
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

function scope(input: {
  id: string;
  type: "venue" | "beer";
  itemId: string;
  beerKey: string;
  label: string;
}): SavedUpdateReadScope {
  return {
    savedItemId: input.id,
    scopeType: input.type,
    itemId: input.itemId,
    beerKey: input.beerKey,
    label: input.label,
    savedAt: "2026-08-20T00:00:00.000Z",
    staleEligibleAfter: "2026-07-21T00:00:00.000Z",
  };
}

describe.skipIf(!configuredAdminUrl)("Saved Updates read repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: SavedUpdatesReadRepository;

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
      throw new Error("The disposable Saved Updates rehearsal requires a PostgreSQL 17 superuser.");
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

      CREATE TABLE venue_identity_aliases (
        alias_venue_id text PRIMARY KEY,
        canonical_venue_id text NOT NULL,
        identity_key text NOT NULL,
        source text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX idx_venue_identity_aliases_canonical
        ON venue_identity_aliases(canonical_venue_id);

      CREATE TABLE venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        suburb text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE submissions (
        id text PRIMARY KEY,
        status text NOT NULL,
        reviewed_at timestamptz
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
        is_on_tap text NOT NULL DEFAULT 'unknown',
        confidence text NOT NULL,
        source_type text NOT NULL,
        source_submission_id text REFERENCES submissions(id),
        source_ingestion_id text,
        source_evidence_verified_at timestamptz,
        last_verified_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX idx_venue_price_records_venue ON venue_price_records(venue_id);
      CREATE INDEX idx_venue_price_records_beer ON venue_price_records(normalized_beer_id);

      CREATE TABLE venue_beers (
        id text PRIMARY KEY,
        venue_id text NOT NULL REFERENCES venue_profiles(venue_id),
        beer_name text NOT NULL,
        normalized_beer_id text,
        serve_size text,
        price numeric,
        on_tap boolean NOT NULL DEFAULT false,
        in_stock boolean NOT NULL DEFAULT true,
        price_verified_at timestamptz,
        source_ingestion_id text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX idx_venue_beers_venue ON venue_beers(venue_id);
      CREATE INDEX idx_venue_beers_normalized ON venue_beers(normalized_beer_id);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON ALL TABLES IN SCHEMA pintpath_app TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new SavedUpdatesReadRepository(database);
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
      throw new Error("Disposable Saved Updates PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("uses alias-safe current authority and explicit approval/evidence timestamps", async () => {
    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    await targetAdmin!.query(
      `INSERT INTO venue_profiles (venue_id, name, suburb, active, created_at, updated_at) VALUES
         ('venue-canonical', 'Canonical Hotel', 'Fitzroy', true, $1, $1),
         ('venue-approved', 'Approved Hotel', 'Fitzroy', true, $1, $1),
         ('venue-evidence', 'Evidence Hotel', 'Fitzroy', true, $1, $1),
         ('venue-stale', 'Stale Hotel', 'Fitzroy', true, $1, $1),
         ('venue-ambiguous', 'Ambiguous Hotel', 'Fitzroy', true, $1, $1)`,
      ["2026-01-01T00:00:00.000Z"],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES ('venue-alias', 'venue-canonical', 'canonical|alias', 'test', $1, $1)`,
      ["2026-01-01T00:00:00.000Z"],
    );
    await targetAdmin!.query(
      `INSERT INTO submissions (id, status, reviewed_at) VALUES
         ('submission-approved', 'approved', '2026-08-28T09:00:00.000Z'),
         ('submission-pending', 'pending', '2026-08-29T09:00:00.000Z')`,
    );
    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence, source_type,
         source_submission_id, source_ingestion_id, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       ) VALUES
         ('community-shadowed', 'venue-canonical', 'Canonical Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 12.25, false, 'yes', 'community_confirmed', 'community_verified',
          NULL, NULL, '2026-08-29T09:00:00.000Z', '2026-08-29T09:00:00.000Z', $1, $2),
         ('approved-authority', 'venue-approved', 'Approved Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 12.50, false, 'yes', 'community_confirmed', 'community_verified',
          'submission-approved', NULL, '2026-08-27T09:00:00.000Z', '2026-08-25T09:00:00.000Z', $1, $3),
         ('evidence-authority', 'venue-evidence', 'Evidence Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 12.75, false, 'yes', 'photo_verified', 'admin_manual_capture',
          NULL, NULL, '2026-08-29T10:00:00.000Z', '2026-08-27T10:00:00.000Z', $1, $4),
         ('stale-crossing', 'venue-stale', 'Stale Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 13.00, false, 'yes', 'admin_verified', 'admin_manual_capture',
          NULL, NULL, NULL, '2026-07-30T12:00:00.000Z', $1, '2026-07-30T12:00:00.000Z'),
         ('ambiguous-observation', 'venue-ambiguous', 'Ambiguous Hotel', 'Fitzroy', 'Guinness',
          'guinness', 'pint', 13.25, false, 'yes', 'community_confirmed', 'community_verified',
          'submission-pending', NULL, NULL, '2026-08-29T11:00:00.000Z', $1, $4)`,
      [
        "2026-01-01T00:00:00.000Z",
        "2026-08-29T09:00:00.000Z",
        "2026-08-28T09:00:00.000Z",
        "2026-08-29T10:00:00.000Z",
      ],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price, on_tap, in_stock,
         price_verified_at, source_ingestion_id, created_at, updated_at
       ) VALUES (
         'manager-current', 'venue-canonical', 'Guinness', 'guinness', 'pint', 11.75,
         true, true, '2026-08-29T09:00:00.000Z', NULL, $1, '2026-08-29T09:00:00.000Z'
       )`,
      ["2026-01-01T00:00:00.000Z"],
    );

    const page = await repository.listEligibleCandidates({
      scopes: [
        scope({
          id: "saved-venue-alias",
          type: "venue",
          itemId: "venue-alias",
          beerKey: "unused",
          label: "Canonical Hotel",
        }),
        scope({
          id: "saved-beer",
          type: "beer",
          itemId: "guinness",
          beerKey: "guinness",
          label: "Guinness",
        }),
      ],
      asOf: AS_OF,
      eventWindowStart: EVENT_WINDOW_START,
      staleWindowStart: STALE_WINDOW_START,
      staleBefore: STALE_BEFORE,
    });

    expect(page.truncated).toBe(false);
    expect(page.candidates.filter((candidate) => candidate.savedItemId === "saved-venue-alias"))
      .toEqual([
        expect.objectContaining({
          recordId: "bar_beer:manager-current",
          canonicalVenueId: "venue-canonical",
          authorityVerifiedAt: "2026-08-29T09:00:00.000Z",
        }),
      ]);
    expect(page.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        savedItemId: "saved-beer",
        recordId: "approved-authority",
        authorityVerifiedAt: "2026-08-28T09:00:00.000Z",
      }),
      expect.objectContaining({
        savedItemId: "saved-beer",
        recordId: "evidence-authority",
        authorityVerifiedAt: "2026-08-29T10:00:00.000Z",
      }),
      expect.objectContaining({
        savedItemId: "saved-beer",
        recordId: "stale-crossing",
        authorityVerifiedAt: null,
        freshnessVerifiedAt: "2026-07-30T12:00:00.000Z",
      }),
    ]));
    expect(page.candidates.map((candidate) => candidate.recordId)).not.toContain("community-shadowed");
    expect(page.candidates.map((candidate) => candidate.recordId)).not.toContain("ambiguous-observation");
  });

  it("does not resurrect trusted-old rows shadowed by non-actionable or future current authority", async () => {
    await targetAdmin!.query(
      `INSERT INTO venue_profiles (venue_id, name, suburb, active, created_at, updated_at) VALUES
         ('shadow-pending', 'Shadow Pending', 'Fitzroy', true, $1, $1),
         ('shadow-off-tap', 'Shadow Off Tap', 'Fitzroy', true, $1, $1),
         ('shadow-null-price', 'Shadow Null Price', 'Fitzroy', true, $1, $1),
         ('shadow-manager-null', 'Shadow Manager Null', 'Fitzroy', true, $1, $1),
         ('shadow-future', 'Shadow Future', 'Fitzroy', true, $1, $1)`,
      ["2026-01-01T00:00:00.000Z"],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence, source_type,
         source_submission_id, source_ingestion_id, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       )
       SELECT venue_id || '-trusted-old', venue_id, venue_name, 'Fitzroy',
              'Shadow Beer', 'shadow_beer', 'pint', 12.00, false, 'yes',
              'admin_verified', 'admin_manual_capture', NULL, NULL,
              '2026-08-27T10:00:00.000Z', '2026-08-27T09:00:00.000Z',
              '2026-01-01T00:00:00.000Z', '2026-08-27T10:00:00.000Z'
         FROM (VALUES
           ('shadow-pending', 'Shadow Pending'),
           ('shadow-off-tap', 'Shadow Off Tap'),
           ('shadow-null-price', 'Shadow Null Price'),
           ('shadow-manager-null', 'Shadow Manager Null'),
           ('shadow-future', 'Shadow Future')
         ) AS trusted(venue_id, venue_name)`,
    );
    const savedShadowBeer = scope({
      id: "saved-shadow-beer",
      type: "beer",
      itemId: "shadow_beer",
      beerKey: "shadow_beer",
      label: "Shadow Beer",
    });
    const beforeSupersession = await repository.listEligibleCandidates({
      scopes: [savedShadowBeer],
      asOf: AS_OF,
      eventWindowStart: EVENT_WINDOW_START,
      staleWindowStart: STALE_WINDOW_START,
      staleBefore: STALE_BEFORE,
    });
    expect(beforeSupersession.candidates).toHaveLength(5);

    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence, source_type,
         source_submission_id, source_ingestion_id, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       ) VALUES
         ('shadow-pending-current', 'shadow-pending', 'Shadow Pending', 'Fitzroy',
          'Shadow Beer', 'shadow_beer', 'pint', 12.25, false, 'yes',
          'user_reported_pending', 'community_verified', NULL, NULL, NULL,
          '2026-08-29T09:00:00.000Z', $1, '2026-08-29T09:00:00.000Z'),
         ('shadow-off-tap-current', 'shadow-off-tap', 'Shadow Off Tap', 'Fitzroy',
          'Shadow Beer', 'shadow_beer', 'pint', 12.25, false, 'no',
          'admin_verified', 'admin_manual_capture', NULL, NULL,
          '2026-08-29T10:30:00.000Z', '2026-08-29T10:00:00.000Z', $1,
          '2026-08-29T10:30:00.000Z'),
         ('shadow-null-price-current', 'shadow-null-price', 'Shadow Null Price', 'Fitzroy',
          'Shadow Beer', 'shadow_beer', 'pint', NULL, false, 'yes',
          'admin_verified', 'admin_manual_capture', NULL, NULL,
          '2026-08-29T11:30:00.000Z', '2026-08-29T11:00:00.000Z', $1,
          '2026-08-29T11:30:00.000Z'),
         ('shadow-future-current', 'shadow-future', 'Shadow Future', 'Fitzroy',
          'Shadow Beer', 'shadow_beer', 'pint', 12.25, false, 'yes',
          'admin_verified', 'admin_manual_capture', NULL, NULL,
          '2026-09-02T10:00:00.000Z', '2026-09-02T09:00:00.000Z', $1,
          '2026-09-02T10:00:00.000Z')`,
      ["2026-01-01T00:00:00.000Z"],
    );
    await targetAdmin!.query(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price, on_tap, in_stock,
         price_verified_at, source_ingestion_id, created_at, updated_at
       ) VALUES (
         'shadow-manager-null-current', 'shadow-manager-null', 'Shadow Beer', 'shadow_beer',
         'pint', NULL, true, true, NULL, NULL,
         '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z'
       )`,
    );

    const afterSupersession = await repository.listEligibleCandidates({
      scopes: [savedShadowBeer],
      asOf: AS_OF,
      eventWindowStart: EVENT_WINDOW_START,
      staleWindowStart: STALE_WINDOW_START,
      staleBefore: STALE_BEFORE,
    });
    expect(afterSupersession).toEqual({ candidates: [], truncated: false });
  });

  it("fails closed after the bounded 100-result authority set", async () => {
    await targetAdmin!.query(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence, source_type,
         source_submission_id, source_ingestion_id, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       )
       SELECT 'overflow-' || series::text,
              'overflow-venue-' || series::text,
              'Overflow Venue ' || series::text,
              'Fitzroy', 'Overflow Beer', 'overflow_beer', 'pint', 12.00,
              false, 'yes', 'admin_verified', 'admin_manual_capture', NULL, NULL,
              '2026-08-28T12:00:00.000Z', '2026-08-28T12:00:00.000Z',
              '2026-01-01T00:00:00.000Z', '2026-08-28T12:00:00.000Z'
         FROM generate_series(1, 101) AS series`,
    );

    const completedBefore = database!.metrics().completedQueries;
    const page = await repository.listEligibleCandidates({
      scopes: [scope({
        id: "saved-overflow",
        type: "beer",
        itemId: "overflow_beer",
        beerKey: "overflow_beer",
        label: "Overflow Beer",
      })],
      asOf: AS_OF,
      eventWindowStart: EVENT_WINDOW_START,
      staleWindowStart: STALE_WINDOW_START,
      staleBefore: STALE_BEFORE,
    });

    expect(page.truncated).toBe(true);
    expect(page.candidates).toHaveLength(100);
    expect(database!.metrics()).toMatchObject({
      completedQueries: completedBefore + 1,
      failedQueries: 0,
    });
  });
});
