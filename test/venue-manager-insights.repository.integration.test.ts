import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublicVenuePriceRecord } from "../src/db/business.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import {
  VenueManagerInsightsRepository,
  VenueManagerInsightsRepositoryError,
  type VenueManagerInsightsInput,
} from "../src/db/venue-manager-insights.repository.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_venue_manager_insights_integration_test";
const TEST_LOGIN = "pintpath_venue_manager_insights_login";
const TEST_READER = "pintpath_venue_manager_insights_reader";
const START = "2026-05-01T00:00:00.000Z";
const END = "2026-06-01T00:00:00.000Z";
const CREATED = "2026-05-10T00:00:00.000Z";
const STALE_BEFORE = "2026-05-02T00:00:00.000Z";

const READ_TABLES = [
  "events",
  "wrong_price_reports",
  "venue_requests",
  "submissions",
] as const;

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`,
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    decodeURIComponent(url.pathname.slice(1)) !== "postgres" ||
    !url.username ||
    !url.password ||
    url.searchParams.get("sslmode") !== "disable" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.hash ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(
      `${ADMIN_URL_ENV} must target an explicit disposable loopback maintenance database.`,
    );
  return url;
}

function withDatabase(
  url: URL,
  database: string,
  username?: string,
  password?: string,
): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1 &&
    bindings[0] !== null &&
    typeof bindings[0] === "object" &&
    !Array.isArray(bindings[0]) &&
    !Buffer.isBuffer(bindings[0]) &&
    !(bindings[0] instanceof Date)
  )
    return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  ) as Row;
}

/** Test-only direct-PG adapter for an explicitly disposable loopback cluster. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{
    client: PoolClient;
    nextSavepoint: number;
  }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
      options:
        "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
  }

  private async query<Row extends QueryResultRow>(
    sql: string,
    bindings: SqlBindings,
  ) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
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

  transaction<Result>(
    work: () => Result | Promise<Result>,
  ): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `venue_manager_insights_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          await active.client
            .query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            .catch(() => undefined);
          await active.client
            .query(`RELEASE SAVEPOINT ${savepoint}`)
            .catch(() => undefined);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await this.transactionClient.run(
          { client, nextSavepoint: 1 },
          work,
        );
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

function priceRecord(
  id: string,
  overrides: Partial<PublicVenuePriceRecord> = {},
): PublicVenuePriceRecord {
  return {
    id,
    venueId: "venue-1",
    venueName: "Manager Hotel",
    suburb: "Fitzroy",
    beerName: `Beer ${id}`,
    normalizedBeerId: id,
    servingSize: "pint",
    price: 12,
    isHappyHourPrice: false,
    happyHourDetails: null,
    isOnTap: "yes",
    confidence: "venue_confirmed",
    sourceType: "venue_submission",
    sourceSubmissionId: null,
    lastVerifiedAt: "2026-05-20T00:00:00.000Z",
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function input(
  overrides: Partial<VenueManagerInsightsInput> = {},
): VenueManagerInsightsInput {
  return {
    venueId: "venue-1",
    suburb: "Fitzroy",
    staleBefore: STALE_BEFORE,
    priceRecords: [
      priceRecord("lager"),
      priceRecord("pale-ale", { isHappyHourPrice: true }),
      priceRecord("stout"),
      priceRecord("future", { createdAt: END, lastVerifiedAt: END }),
    ],
    startIso: START,
    endIso: END,
    ...overrides,
  };
}

async function seedParity(client: Client) {
  await client.query(
    `INSERT INTO pintpath_app.accounts (id, email, password_hash, created_at, updated_at)
     VALUES ('insights-user', 'insights-user@example.test', 'hash', $1, $1)`,
    [START],
  );
  await client.query(
    `INSERT INTO pintpath_app.wrong_price_reports (
       id, user_id, anonymous_session_id, venue_id, venue_name, beer_name,
       reason, notes, source_photo_url, status, created_at, updated_at
     ) VALUES ('report-1', 'insights-user', 'sensitive-session', 'venue-1',
       'Manager Hotel', 'Lager', 'price_changed', 'private note',
       'private:evidence:one', 'resolved', $1, $1)`,
    [CREATED],
  );
  await client.query(
    `INSERT INTO pintpath_app.venue_requests (
       id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
       beer_name, suburb, notes, status, created_at, updated_at
     ) VALUES ('request-1', 'insights-user', 'request-session', 'verify_venue', NULL,
       'manager hotel', NULL, 'Fitzroy', 'private request', 'open', $1, $1)`,
    [CREATED],
  );
  await client.query(
    `INSERT INTO pintpath_app.submissions (
       id, user_id, venue_id, venue_name, suburb, status, submission_type,
       observed_at, source_photo_url, ocr_status, ocr_summary_json, notes,
       points_awarded, points_eligible_by_location, pending_venue_json,
       fraud_flagged, created_at, updated_at
     ) VALUES ('submission-1', 'insights-user', 'venue-1', 'Manager Hotel',
       'Fitzroy', 'approved', 'photo_upload', $1, 'private:evidence:submission',
       'processed', $2::jsonb, 'private submission', 4.5, true, $3::jsonb, false, $1, $1)`,
    [
      CREATED,
      JSON.stringify({
        model: "test",
        imageCount: 1,
        extractedRowCount: 2,
        rejectedCandidateCount: 0,
        pendingCatalogCount: 0,
        message: "ok",
      }),
      JSON.stringify({
        name: "Pending Hotel",
        latitude: -37.81,
        longitude: 144.96,
      }),
    ],
  );
  const events: ReadonlyArray<
    readonly [
      string,
      string | null,
      string | null,
      string,
      string | null,
      string | null,
      string | null,
      string,
    ]
  > = [
    [
      "view-1",
      "insights-user",
      null,
      "venue_card_viewed",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "view-duplicate",
      "insights-user",
      null,
      "venue_detail_opened",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "view-2",
      null,
      "viewer-two",
      "venue_detail_opened",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "preview-1",
      null,
      "preview-one",
      "free_preview_viewed",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "happy-1",
      null,
      "happy-one",
      "happy_hour_near_me_used",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "marker-1",
      null,
      "marker-one",
      "map_pin_click",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
    [
      "beer-1",
      null,
      "beer-one",
      "beer_search_performed",
      null,
      "lager",
      "Fitzroy",
      "{}",
    ],
    [
      "beer-2",
      null,
      "beer-two",
      "beer_search_performed",
      null,
      null,
      "Fitzroy",
      '{"query":42}',
    ],
    [
      "beer-3",
      null,
      "beer-three",
      "beer_search_performed",
      null,
      "porter",
      "Fitzroy",
      "{}",
    ],
    [
      "outside-range",
      null,
      "outside",
      "venue_card_viewed",
      "venue-1",
      null,
      "Fitzroy",
      "{}",
    ],
  ];
  for (const [
    id,
    userId,
    anonymousId,
    eventType,
    venueId,
    beerId,
    suburb,
    metadata,
  ] of events) {
    await client.query(
      `INSERT INTO pintpath_app.events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
         suburb, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        id,
        userId,
        anonymousId,
        eventType,
        venueId,
        beerId,
        suburb,
        metadata,
        id === "outside-range" ? END : CREATED,
      ],
    );
  }
}

describe.skipIf(!configuredAdminUrl)(
  "VenueManagerInsightsRepository on restricted PostgreSQL 17",
  () => {
    let maintenanceUrl: URL;
    let maintenance: Client;
    let targetAdmin: Client | null = null;
    let database: LoopbackPostgresTestDatabase | null = null;
    let restrictedUrl = "";
    let runtimeRoleExisted = false;
    let migratorRoleExisted = false;

    beforeAll(async () => {
      maintenanceUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: maintenanceUrl.toString() });
      await maintenance.connect();
      const version = Number(
        (
          await maintenance.query<{ version: string }>(
            "SELECT current_setting('server_version_num') AS version",
          )
        ).rows[0]?.version,
      );
      if (version < 170000 || version >= 180000) {
        throw new Error(
          `Venue-manager insights integration requires PostgreSQL 17; received ${version}.`,
        );
      }
      const existingRoles = await maintenance.query<{ rolname: string }>(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
        [["pintpath_runtime", "pintpath_migrator"]],
      );
      runtimeRoleExisted = existingRoles.rows.some(
        (row) => row.rolname === "pintpath_runtime",
      );
      migratorRoleExisted = existingRoles.rows.some(
        (row) => row.rolname === "pintpath_migrator",
      );
      await maintenance.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      );
      await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${TEST_READER}`);
      await maintenance.query(`CREATE DATABASE ${TEST_DATABASE}`);

      targetAdmin = new Client({
        connectionString: withDatabase(maintenanceUrl, TEST_DATABASE),
      });
      await targetAdmin.connect();
      await targetAdmin.query(
        fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"),
      );

      const password = crypto.randomBytes(24).toString("hex");
      await maintenance.query(
        `CREATE ROLE ${TEST_READER} NOLOGIN
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await maintenance.query(
        `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await maintenance.query(`GRANT ${TEST_READER} TO ${TEST_LOGIN}`);
      await targetAdmin.query(
        `GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_READER}`,
      );
      await targetAdmin.query(
        `GRANT SELECT ON ${READ_TABLES.map((table) => `pintpath_app.${table}`).join(", ")}
       TO ${TEST_READER}`,
      );
      for (const table of READ_TABLES) {
        await targetAdmin.query(
          `CREATE POLICY ${table}_venue_manager_insights_reader ON pintpath_app.${table}
         FOR SELECT TO ${TEST_READER} USING (true)`,
        );
      }
      await maintenance.query(
        `REVOKE ALL ON DATABASE ${TEST_DATABASE} FROM PUBLIC`,
      );
      await maintenance.query(
        `GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`,
      );
      restrictedUrl = withDatabase(
        maintenanceUrl,
        TEST_DATABASE,
        TEST_LOGIN,
        password,
      );
    }, 30_000);

    beforeEach(async () => {
      if (!targetAdmin) throw new Error("PostgreSQL fixture is unavailable.");
      await database?.close();
      database = null;
      await targetAdmin.query(
        `TRUNCATE TABLE pintpath_app.events, pintpath_app.wrong_price_reports,
        pintpath_app.venue_requests, pintpath_app.submissions, pintpath_app.accounts CASCADE`,
      );
      database = new LoopbackPostgresTestDatabase(restrictedUrl);
    });

    afterAll(async () => {
      await database?.close().catch(() => undefined);
      await targetAdmin?.end().catch(() => undefined);
      if (maintenance) {
        await maintenance
          .query(
            "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [TEST_DATABASE],
          )
          .catch(() => undefined);
        await maintenance
          .query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`)
          .catch(() => undefined);
        await maintenance
          .query(`REVOKE ${TEST_READER} FROM ${TEST_LOGIN}`)
          .catch(() => undefined);
        await maintenance
          .query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`)
          .catch(() => undefined);
        await maintenance
          .query(`DROP ROLE IF EXISTS ${TEST_READER}`)
          .catch(() => undefined);
        if (!runtimeRoleExisted)
          await maintenance
            .query("DROP ROLE IF EXISTS pintpath_runtime")
            .catch(() => undefined);
        if (!migratorRoleExisted)
          await maintenance
            .query("DROP ROLE IF EXISTS pintpath_migrator")
            .catch(() => undefined);
        const leftovers = await maintenance.query<{
          database_exists: boolean;
          login_exists: boolean;
          reader_exists: boolean;
        }>(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS login_exists,
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $3) AS reader_exists`,
          [TEST_DATABASE, TEST_LOGIN, TEST_READER],
        );
        expect(leftovers.rows[0]).toEqual({
          database_exists: false,
          login_exists: false,
          reader_exists: false,
        });
        await maintenance.end().catch(() => undefined);
      }
    }, 30_000);

    it("matches native PostgreSQL values through forced RLS and a read-only role", async () => {
      if (!targetAdmin || !database)
        throw new Error("PostgreSQL fixture is unavailable.");
      await seedParity(targetAdmin);
      const role = await targetAdmin.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_LOGIN],
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      const privileges = await targetAdmin.query<{
        table_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT table_name,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege($1, format('pintpath_app.%I', table_name), 'DELETE') AS can_delete
         FROM unnest($2::text[]) AS source(table_name)
        ORDER BY table_name`,
        [TEST_LOGIN, [...READ_TABLES]],
      );
      expect(privileges.rows).toEqual(
        [...READ_TABLES].sort().map((tableName) => ({
          table_name: tableName,
          can_select: true,
          can_insert: false,
          can_update: false,
          can_delete: false,
        })),
      );
      const rls = await targetAdmin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT bool_and(relrowsecurity) AS relrowsecurity,
              bool_and(relforcerowsecurity) AS relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE oid = ANY($1::regclass[])`,
        [READ_TABLES.map((table) => `pintpath_app.${table}`)],
      );
      expect(rls.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      const result = await new VenueManagerInsightsRepository(
        database,
      ).getVenueManagerInsights(input());
      expect(result).toMatchObject({
        venueId: "venue-1",
        priceRecords: [{ id: "lager" }, { id: "pale-ale" }, { id: "stout" }],
        wrongPriceReports: [
          {
            id: "report-1",
            userId: "insights-user",
            sourcePhotoUrl: "private:evidence:one",
          },
        ],
        requests: [{ id: "request-1", venueName: "manager hotel" }],
        submissions: [
          {
            id: "submission-1",
            pointsAwarded: 4.5,
            pointsEligibleByLocation: true,
            fraudFlagged: false,
            ocrSummary: { model: "test", extractedRowCount: 2 },
            pendingVenue: {
              name: "Pending Hotel",
              latitude: -37.81,
              longitude: 144.96,
            },
            createdAt: CREATED,
          },
        ],
        aggregateInsights: {
          venueViews: 2,
          pricePreviewViews: 1,
          happyHourClicks: 1,
          markerClicks: 1,
          topSearchedBeersNearby: [
            { key: "42", count: 1 },
            { key: "lager", count: 1 },
            { key: "porter", count: 1 },
          ],
          missingBeerSearches: [
            { key: "42", count: 1 },
            { key: "porter", count: 1 },
          ],
        },
        listingQuality: {
          score: 95,
          latestVerifiedAt: "2026-05-20T00:00:00.000Z",
        },
      });
      expect(typeof result.aggregateInsights.venueViews).toBe("number");
      expect(typeof result.submissions[0]?.pointsAwarded).toBe("number");

      await expect(
        database
          .prepare("DELETE FROM wrong_price_reports WHERE id = ?")
          .run("report-1"),
      ).rejects.toThrow();
    });

    it("uses deterministic C-collated ties and bounds every detail list", async () => {
      if (!targetAdmin || !database)
        throw new Error("PostgreSQL fixture is unavailable.");
      await targetAdmin.query(
        `INSERT INTO pintpath_app.wrong_price_reports (
         id, venue_id, venue_name, reason, status, created_at, updated_at
       )
       SELECT 'report-' || lpad(value::text, 2, '0'), 'venue-1', 'Manager Hotel',
              'price_changed', 'resolved', $1, $1
         FROM generate_series(29, 0, -1) AS value`,
        [CREATED],
      );
      await targetAdmin.query(
        `INSERT INTO pintpath_app.events (
         id, anonymous_session_id, event_type, beer_id, suburb, metadata_json, created_at
       )
       SELECT 'event-beer-' || lpad(value::text, 2, '0'),
              'actor-beer-' || lpad(value::text, 2, '0'),
              'beer_search_performed', 'beer-' || lpad(value::text, 2, '0'),
              'Fitzroy', '{}'::jsonb, $1
         FROM generate_series(9, 0, -1) AS value`,
        [CREATED],
      );

      const result = await new VenueManagerInsightsRepository(
        database,
      ).getVenueManagerInsights(input({ priceRecords: [] }));
      expect(result.wrongPriceReports).toHaveLength(25);
      expect(result.wrongPriceReports.map((row) => row.id)).toEqual(
        Array.from(
          { length: 25 },
          (_, index) => `report-${String(index).padStart(2, "0")}`,
        ),
      );
      expect(
        result.aggregateInsights.topSearchedBeersNearby.map((row) => row.key),
      ).toEqual(
        Array.from(
          { length: 8 },
          (_, index) => `beer-${String(index).padStart(2, "0")}`,
        ),
      );
      expect(
        result.aggregateInsights.missingBeerSearches.map((row) => row.key),
      ).toEqual(
        Array.from(
          { length: 5 },
          (_, index) => `beer-${String(index).padStart(2, "0")}`,
        ),
      );
    });

    it("contains malformed PostgreSQL state and permission failures without private detail", async () => {
      if (!targetAdmin || !database)
        throw new Error("PostgreSQL fixture is unavailable.");
      await targetAdmin.query(
        `INSERT INTO pintpath_app.wrong_price_reports (
         id, venue_id, venue_name, reason, status, created_at, updated_at
       ) VALUES ('private-malformed-pg-id', 'venue-1', 'Manager Hotel',
         'price_changed', 'private-invalid-state', $1, $1)`,
        [CREATED],
      );
      const malformed = await new VenueManagerInsightsRepository(database)
        .getVenueManagerInsights(input({ priceRecords: [] }))
        .catch((error: unknown) => error);
      expect(malformed).toBeInstanceOf(VenueManagerInsightsRepositoryError);
      expect(malformed).toMatchObject({ code: "malformed_result" });
      expect(String(malformed)).not.toContain("private-malformed-pg-id");
      expect(String(malformed)).not.toContain("private-invalid-state");

      await targetAdmin.query(
        "DELETE FROM pintpath_app.wrong_price_reports WHERE id = 'private-malformed-pg-id'",
      );
      await targetAdmin.query(
        `REVOKE SELECT ON pintpath_app.events FROM ${TEST_READER}`,
      );
      try {
        const denied = await new VenueManagerInsightsRepository(database)
          .getVenueManagerInsights(input({ priceRecords: [] }))
          .catch((error: unknown) => error);
        expect(denied).toBeInstanceOf(VenueManagerInsightsRepositoryError);
        expect(denied).toMatchObject({ code: "persistence_failure" });
        expect(String(denied)).not.toContain("permission denied");
        expect(String(denied)).not.toContain("events");
      } finally {
        await targetAdmin.query(
          `GRANT SELECT ON pintpath_app.events TO ${TEST_READER}`,
        );
      }
    });
  },
);
