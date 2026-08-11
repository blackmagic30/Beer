import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MissionDiscoveryAutomationRepository,
  type MissionFeedPageInput,
} from "../src/db/mission-discovery-automation.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_MISSION_DISCOVERY_SCALE_TEST_ADMIN_URL";
const EVIDENCE_PATH_ENV = "PINTPATH_MISSION_DISCOVERY_SCALE_EVIDENCE_PATH";
const REQUIRED_ENV = "PINTPATH_MISSION_DISCOVERY_SCALE_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredEvidencePath = process.env[EVIDENCE_PATH_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const integrationRequired = configuredRequired === "true";

if (configuredRequired && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (integrationRequired && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}
if (integrationRequired && !configuredEvidencePath) {
  throw new Error(`${EVIDENCE_PATH_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

const RUN_SUFFIX = `${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
const TEST_DATABASE = `pintpath_mission_scale_${RUN_SUFFIX}`;
const TEST_LOGIN = `pintpath_mission_scale_login_${RUN_SUFFIX}`;
const TEST_PASSWORD = crypto.randomBytes(32).toString("hex");
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";
const VENUE_COUNT = 10_000;
const PRICE_COUNT = 100_000;
const REQUEST_COUNT = 20_000;
const MANUAL_MISSION_COUNT = 10_000;
const AUTO_MISSION_COUNT = 5_000;
const MISSION_COUNT = MANUAL_MISSION_COUNT + AUTO_MISSION_COUNT;
const DEEP_OFFSET = 4_998;
const DEEP_LIMIT = 2;

const PLAN_CEILINGS_MS = Object.freeze({
  publicFeed: 1_000,
  searchFeed: 1_000,
  radiusFeed: 1_000,
  candidates: 2_000,
  autoOwners: 100,
  inactiveAuto: 250,
  activeDemo: 250,
});

type QueryMethod = "run" | "get" | "all" | "exec";

interface CapturedQuery {
  readonly sourceSql: string;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly method: QueryMethod;
}

interface ExplainSummary {
  readonly name: string;
  readonly ceilingMs: number;
  readonly querySha256: string;
  readonly parametersSha256: string;
  readonly parameterCount: number;
  readonly planSha256: string;
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly settings: Readonly<Record<string, string>>;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly tempReadBlocks: number;
  readonly tempWrittenBlocks: number;
  readonly peakSortSpaceKb: number;
  readonly indexes: readonly string[];
  readonly nodeTypes: readonly string[];
  readonly sequentialScanRelations: readonly string[];
  readonly sortMethods: readonly string[];
}

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

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Disposable PostgreSQL identifier is not canonical.");
  }
  return `"${value}"`;
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

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Captures exactly the SQL compiled by a real repository call before replaying it under EXPLAIN. */
class CapturingLoopbackPostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private readonly captured: CapturedQuery[] = [];
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
      application_name: "pintpath-mission-discovery-scale-gate",
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c row_security=on",
        "-c statement_timeout=60000",
        "-c lock_timeout=10000",
      ].join(" "),
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
  }

  private async query<Row extends QueryResultRow>(
    sourceSql: string,
    bindings: SqlBindings,
    method: QueryMethod,
  ) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sourceSql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      this.captured.push({
        sourceSql,
        text: compiled.text,
        values: [...compiled.values],
        method,
      });
      return { rows: result.rows.map(normalizeRow), rowCount: result.rowCount ?? 0 };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings), "run");
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) =>
        (await this.query<Row>(sql, normalizeBindings(bindings), "get")).rows[0],
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) =>
        (await this.query<Row>(sql, normalizeBindings(bindings), "all")).rows,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, [], "exec");
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `mission_scale_nested_${active.nextSavepoint++}`;
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

  captureCount(): number {
    return this.captured.length;
  }

  capturesSince(index: number): readonly CapturedQuery[] {
    return this.captured.slice(index);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: this.closed ? 0 : this.pool.totalCount,
      idleConnections: this.closed ? 0 : this.pool.idleCount,
      waitingRequests: this.closed ? 0 : this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: null,
    };
  }
}

function feedInput(overrides: Partial<MissionFeedPageInput> = {}): MissionFeedPageInput {
  return {
    userId: null,
    suburb: undefined,
    searchTerms: [],
    savedSuburbs: [],
    savedOnly: false,
    latitude: undefined,
    longitude: undefined,
    radiusMeters: 50_000,
    sort: "points",
    limit: 20,
    offset: 0,
    acceptedAfter: "2026-07-31T00:00:00.000Z",
    veryFreshCutoff: "2026-07-31T00:00:00.000Z",
    weekOldCutoff: "2026-07-15T00:00:00.000Z",
    veryFreshPoints: 1,
    weekOldPoints: 5,
    stalePoints: 10,
    newVenuePoints: 20,
    excludeHappyHourMissions: true,
    ...overrides,
  };
}

function recordPlanFacts(value: unknown, facts: {
  indexes: Set<string>;
  nodeTypes: Set<string>;
  sequentialScanRelations: Set<string>;
  sortMethods: Set<string>;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  peakSortSpaceKb: number;
}): void {
  if (Array.isArray(value)) {
    for (const item of value) recordPlanFacts(item, facts);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record["Node Type"] === "Seq Scan" && typeof record["Relation Name"] === "string") {
    facts.sequentialScanRelations.add(record["Relation Name"]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "Index Name" && typeof child === "string") facts.indexes.add(child);
    if (key === "Node Type" && typeof child === "string") facts.nodeTypes.add(child);
    if (key === "Sort Method" && typeof child === "string") facts.sortMethods.add(child);
    if (key === "Sort Space Used" && typeof child === "number") {
      facts.peakSortSpaceKb = Math.max(facts.peakSortSpaceKb, child);
    }
    if (key === "Temp Read Blocks" && typeof child === "number") facts.tempReadBlocks += child;
    if (key === "Temp Written Blocks" && typeof child === "number") facts.tempWrittenBlocks += child;
    recordPlanFacts(child, facts);
  }
}

function boundedExplainSettings(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PostgreSQL JSON EXPLAIN omitted its bounded settings evidence.");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error("PostgreSQL JSON EXPLAIN returned an unbounded settings inventory.");
  }
  const normalized: Record<string, string> = {};
  for (const [key, setting] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof setting !== "string" || setting.length > 128) {
      throw new Error("PostgreSQL JSON EXPLAIN returned malformed settings evidence.");
    }
    normalized[key] = setting;
  }
  return Object.freeze(normalized);
}

function nonnegativePlanNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`PostgreSQL JSON EXPLAIN returned malformed ${field} evidence.`);
  }
  return value;
}

function writeScaleEvidence(value: Readonly<Record<string, unknown>>): void {
  if (!configuredEvidencePath) return;
  if (
    !path.isAbsolute(configuredEvidencePath)
    || path.normalize(configuredEvidencePath) !== configuredEvidencePath
    || /[\r\n\0]/.test(configuredEvidencePath)
  ) {
    throw new Error(`${EVIDENCE_PATH_ENV} must be a canonical absolute path.`);
  }
  fs.writeFileSync(configuredEvidencePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function explainDocument(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error("PostgreSQL returned a malformed JSON EXPLAIN document.");
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("PostgreSQL returned a malformed JSON EXPLAIN document.");
  }
  return parsed[0] as Record<string, unknown>;
}

describe.skipIf(!configuredAdminUrl)("mission discovery/automation production-scale PostgreSQL 17 gate", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let planner: Client | null = null;
  let database: CapturingLoopbackPostgresDatabase | null = null;
  let repository: MissionDiscoveryAutomationRepository;
  let backupRole = "";
  let backupRoleCleanupAuthorized = false;
  let backupRolePreexisted = false;
  let canonicalSchemaSha256 = "";
  let serverVersionNum = 0;
  let databaseCreated = false;
  let loginCreated = false;
  let runtimeRolePreexisted = true;
  let migratorRolePreexisted = true;

  beforeAll(async () => {
    adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
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
      throw new Error("The mission scale gate requires a disposable PostgreSQL 17 superuser.");
    }
    serverVersionNum = version;

    const preflight = await admin.query<{
      database_exists: boolean;
      login_exists: boolean;
      runtime_exists: boolean;
      migrator_exists: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS login_exists,
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pintpath_runtime') AS runtime_exists,
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pintpath_migrator') AS migrator_exists`,
      [TEST_DATABASE, TEST_LOGIN],
    );
    const initial = preflight.rows[0];
    if (initial?.database_exists || initial?.login_exists) {
      throw new Error("Refusing to reuse a non-empty disposable mission scale identity.");
    }
    runtimeRolePreexisted = initial?.runtime_exists ?? false;
    migratorRolePreexisted = initial?.migrator_exists ?? false;

    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(TEST_DATABASE)} WITH TEMPLATE template0 ENCODING 'UTF8'`,
    );
    databaseCreated = true;
    const oid = await admin.query<{ oid: string }>(
      "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname = $1",
      [TEST_DATABASE],
    );
    if (!/^[1-9][0-9]{0,9}$/.test(oid.rows[0]?.oid ?? "")) {
      throw new Error("Disposable mission scale database OID is not canonical.");
    }
    backupRole = `pintpath_logical_backup_d${oid.rows[0]!.oid}`;
    const backupPreflight = await admin.query<{ role_exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS role_exists",
      [backupRole],
    );
    backupRolePreexisted = backupPreflight.rows[0]?.role_exists ?? false;
    if (backupRolePreexisted) {
      throw new Error("Refusing to reuse a preexisting database-scoped logical-backup role.");
    }
    backupRoleCleanupAuthorized = true;

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    const canonicalSchema = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
    if (!canonicalSchema.startsWith("-- Generated by scripts/generate-postgres-schema.ts.")) {
      throw new Error("Mission scale gate requires the canonical generated PostgreSQL schema.");
    }
    canonicalSchemaSha256 = crypto.createHash("sha256").update(canonicalSchema).digest("hex");
    await targetAdmin.query(canonicalSchema);

    await admin.query(
      `CREATE ROLE ${quoteIdentifier(TEST_LOGIN)} LOGIN PASSWORD '${TEST_PASSWORD}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
    );
    loginCreated = true;
    await admin.query(`GRANT pintpath_runtime TO ${quoteIdentifier(TEST_LOGIN)}`);
    await admin.query(
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${quoteIdentifier(TEST_DATABASE)} FROM PUBLIC`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(TEST_DATABASE)} TO ${quoteIdentifier(TEST_LOGIN)}`,
    );
    await admin.query(
      `ALTER ROLE ${quoteIdentifier(TEST_LOGIN)} IN DATABASE ${quoteIdentifier(TEST_DATABASE)}
       SET search_path = pintpath_app, pg_catalog`,
    );

    await targetAdmin.query(
      `INSERT INTO pintpath_app.accounts (
         id, email, password_hash, display_name, created_at, updated_at
       ) VALUES ('scale-user', 'scale-user@example.test', 'not-a-secret-hash', 'Scale User', $1, $1)`,
      [T0],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.venue_profiles (
         venue_id, name, address, suburb, area, active, created_at, updated_at
       )
       SELECT 'venue:' || lpad(series::text, 6, '0'),
              'Scale Venue ' || lpad(series::text, 6, '0'),
              CASE WHEN series = 6000
                   THEN '6000 Scale Street needle-006000'
                   ELSE series::text || ' Scale Street' END,
              'Melbourne', 'Inner Melbourne', true, $1, $1
         FROM pg_catalog.generate_series(1, $2::integer) AS generated(series)`,
      [T0, VENUE_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.venue_location_cache (
         venue_id, venue_name, suburb, latitude, longitude, updated_at
       )
       SELECT 'venue:' || lpad(series::text, 6, '0'),
              'Scale Venue ' || lpad(series::text, 6, '0'),
              'Melbourne',
              -37.8136::double precision + series::double precision * 0.00001,
              144.9631::double precision + series::double precision * 0.00001,
              $1
         FROM pg_catalog.generate_series(1, $2::integer) AS generated(series)`,
      [T0, VENUE_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.missions (
         id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
         active, sponsor_flag, last_verified_at, created_at, updated_at
       )
       SELECT 'manual:' || lpad(series::text, 6, '0'),
              'venue:' || lpad(series::text, 6, '0'),
              'Scale Venue ' || lpad(series::text, 6, '0'),
              'Melbourne', 'No data - add current prices', 'normal', 5, 1,
              true, false, NULL, $1, $2
         FROM pg_catalog.generate_series(1, $3::integer) AS generated(series)`,
      [T0, T1, MANUAL_MISSION_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.missions (
         id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
         active, sponsor_flag, last_verified_at, created_at, updated_at
       )
       SELECT 'auto:' || lpad(series::text, 6, '0'),
              CASE WHEN series BETWEEN 2501 AND 3500
                   THEN 'demo:' || lpad(series::text, 6, '0')
                   ELSE 'venue:' || lpad(series::text, 6, '0') END,
              'Auto Scale Venue ' || lpad(series::text, 6, '0'),
              'Melbourne', 'No data - add current prices', 'normal', 5, 1,
              series > 2500, false, NULL, $1, $2
         FROM pg_catalog.generate_series(1, $3::integer) AS generated(series)`,
      [T0, T1, AUTO_MISSION_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, serving_size, price,
         is_happy_hour_price, happy_hour_details, source_type,
         last_verified_at, created_at, updated_at
       )
       SELECT 'price:' || lpad(series::text, 6, '0'),
              'venue:' || lpad((((series - 1) % $2::integer) + 1)::text, 6, '0'),
              'Scale Venue ' || lpad((((series - 1) % $2::integer) + 1)::text, 6, '0'),
              'Melbourne',
              'Scale Beer ' || ((((series - 1) / $2::integer) % 10) + 1)::text,
              'pint', 10 + ((series - 1) % 10),
              series <= $2::integer,
              CASE WHEN series <= $2::integer THEN '16:00-18:00' ELSE NULL END,
              'scale_fixture', $1, $1, $1
         FROM pg_catalog.generate_series(1, $3::integer) AS generated(series)`,
      [T0, VENUE_COUNT, PRICE_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.venue_requests (
         id, request_type, venue_id, venue_name, suburb, status, mission_id,
         created_at, updated_at
       )
       SELECT 'request:' || lpad(series::text, 6, '0'),
              'price_check',
              'venue:' || lpad((((series - 1) % $2::integer) + 1)::text, 6, '0'),
              'Scale Venue ' || lpad((((series - 1) % $2::integer) + 1)::text, 6, '0'),
              'Melbourne', 'open',
              CASE WHEN series BETWEEN 1 AND 100
                     THEN 'auto:' || lpad((series + 200)::text, 6, '0')
                   WHEN series BETWEEN 101 AND 200
                     THEN 'auto:' || lpad((series + 2600)::text, 6, '0')
                   ELSE NULL END,
              $1, $1
         FROM pg_catalog.generate_series(1, $3::integer) AS generated(series)`,
      [T0, VENUE_COUNT, REQUEST_COUNT],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.submissions (
         id, mission_id, user_id, venue_id, venue_name, suburb, status,
         submission_type, observed_at, created_at, updated_at
       )
       SELECT 'scale-submission:' || lpad(series::text, 3, '0'),
              CASE WHEN series <= 100
                     THEN 'auto:' || lpad((series + 100)::text, 6, '0')
                   ELSE 'auto:' || lpad((series + 2500)::text, 6, '0') END,
              'scale-user',
              'venue:' || lpad(series::text, 6, '0'),
              'Scale Venue ' || lpad(series::text, 6, '0'),
              'Melbourne', 'pending', 'price_update', $1, $1, $1
         FROM pg_catalog.generate_series(1, 200) AS generated(series)`,
      [T0],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.mission_progress (
         id, mission_id, user_id, status, accepted_at, completed_at, updated_at
       )
       SELECT 'scale-progress:' || lpad(series::text, 3, '0'),
              CASE WHEN series <= 100
                     THEN 'auto:' || lpad(series::text, 6, '0')
                   ELSE 'auto:' || lpad((series + 2400)::text, 6, '0') END,
              'scale-user', 'completed', $1, $2, $2
         FROM pg_catalog.generate_series(1, 200) AS generated(series)`,
      [T0, T1],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.venue_happy_hours (
         id, venue_id, title, days_of_week_json, start_time, end_time,
         description, active, created_at, updated_at
       )
       SELECT 'scale-happy:' || lpad(series::text, 6, '0'),
              'venue:' || lpad(series::text, 6, '0'),
              'Scale Happy Hour', '[1,2,3,4,5]'::jsonb, '16:00', '18:00',
              'Scale fixture', true, $1, $1
         FROM pg_catalog.generate_series(1, 2000) AS generated(series)`,
      [T0],
    );
    await targetAdmin.query(
      `VACUUM (ANALYZE)
         pintpath_app.venue_profiles,
         pintpath_app.venue_location_cache,
         pintpath_app.venue_price_records,
         pintpath_app.venue_requests,
         pintpath_app.venue_happy_hours,
         pintpath_app.missions,
         pintpath_app.mission_progress,
         pintpath_app.submissions`,
    );

    const runtimeUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new CapturingLoopbackPostgresDatabase(runtimeUrl);
    repository = new MissionDiscoveryAutomationRepository(database);
    planner = new Client({
      connectionString: runtimeUrl,
      application_name: "pintpath-mission-discovery-scale-explain",
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c row_security=on",
        "-c statement_timeout=60000",
        "-c lock_timeout=10000",
      ].join(" "),
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
    await planner.connect();
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await planner?.end().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      if (databaseCreated) {
        await admin.query(
          `SELECT pg_catalog.pg_terminate_backend(pid)
             FROM pg_catalog.pg_stat_activity
            WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
          [TEST_DATABASE],
        ).catch(() => undefined);
        await admin.query(`DROP DATABASE ${quoteIdentifier(TEST_DATABASE)}`).catch(() => undefined);
      }
      if (loginCreated) {
        await admin.query(`DROP ROLE ${quoteIdentifier(TEST_LOGIN)}`).catch(() => undefined);
      }
      if (backupRole && backupRoleCleanupAuthorized) {
        await admin.query(`DROP ROLE ${quoteIdentifier(backupRole)}`).catch(() => undefined);
      }
      if (!runtimeRolePreexisted) {
        await admin.query("DROP ROLE pintpath_runtime").catch(() => undefined);
      }
      if (!migratorRolePreexisted) {
        await admin.query("DROP ROLE pintpath_migrator").catch(() => undefined);
      }
      const leftovers = await admin.query<{
        database_exists: boolean;
        login_exists: boolean;
        backup_exists: boolean;
        runtime_exists: boolean;
        migrator_exists: boolean;
      }>(
        `SELECT
           EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS login_exists,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $3) AS backup_exists,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pintpath_runtime') AS runtime_exists,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pintpath_migrator') AS migrator_exists`,
        [TEST_DATABASE, TEST_LOGIN, backupRole],
      ).catch(() => ({ rows: [{
        database_exists: true,
        login_exists: true,
        backup_exists: true,
        runtime_exists: !runtimeRolePreexisted,
        migrator_exists: !migratorRolePreexisted,
      }] }));
      await admin.end().catch(() => undefined);
      if (
        leftovers.rows[0]?.database_exists
        || leftovers.rows[0]?.login_exists
        || leftovers.rows[0]?.backup_exists !== backupRolePreexisted
        || leftovers.rows[0]?.runtime_exists !== runtimeRolePreexisted
        || leftovers.rows[0]?.migrator_exists !== migratorRolePreexisted
      ) {
        throw new Error("Mission scale PostgreSQL integration cleanup was not exact.");
      }
    }
  }, 60_000);

  async function oneRoundTrip<Result>(work: () => Promise<Result>): Promise<{
    result: Result;
    capture: CapturedQuery;
  }> {
    const completedBefore = database!.metrics().completedQueries;
    const captureBefore = database!.captureCount();
    const result = await work();
    expect(database!.metrics().completedQueries - completedBefore).toBe(1);
    const captures = database!.capturesSince(captureBefore);
    expect(captures).toHaveLength(1);
    return { result, capture: captures[0]! };
  }

  async function explain(
    name: string,
    capture: CapturedQuery,
    ceilingMs: number,
  ): Promise<ExplainSummary> {
    expect(capture.method).toBe("all");
    const result = await planner!.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${capture.text}`,
      [...capture.values],
    );
    const document = explainDocument(result.rows[0]?.["QUERY PLAN"]);
    const planningTimeMs = nonnegativePlanNumber(document["Planning Time"], "planning-time");
    const executionTimeMs = nonnegativePlanNumber(document["Execution Time"], "execution-time");
    expect(executionTimeMs).toBeLessThanOrEqual(ceilingMs);
    const settings = boundedExplainSettings(document.Settings);
    expect(settings).toEqual({ search_path: "pintpath_app,pg_catalog" });

    const facts = {
      indexes: new Set<string>(),
      nodeTypes: new Set<string>(),
      sequentialScanRelations: new Set<string>(),
      sortMethods: new Set<string>(),
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      peakSortSpaceKb: 0,
    };
    recordPlanFacts(document.Plan, facts);
    expect(facts.tempReadBlocks).toBe(0);
    expect(facts.tempWrittenBlocks).toBe(0);
    if (!document.Plan || typeof document.Plan !== "object") {
      throw new Error("PostgreSQL JSON EXPLAIN omitted its root plan evidence.");
    }
    const rootPlan = document.Plan as Record<string, unknown>;
    return {
      name,
      ceilingMs,
      querySha256: crypto.createHash("sha256").update(capture.text).digest("hex"),
      parametersSha256: crypto.createHash("sha256")
        .update(JSON.stringify(capture.values))
        .digest("hex"),
      parameterCount: capture.values.length,
      planSha256: crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex"),
      planningTimeMs,
      executionTimeMs,
      settings,
      sharedHitBlocks: nonnegativePlanNumber(rootPlan["Shared Hit Blocks"], "shared-hit-block"),
      sharedReadBlocks: nonnegativePlanNumber(rootPlan["Shared Read Blocks"], "shared-read-block"),
      tempReadBlocks: facts.tempReadBlocks,
      tempWrittenBlocks: facts.tempWrittenBlocks,
      peakSortSpaceKb: facts.peakSortSpaceKb,
      indexes: [...facts.indexes].sort(),
      nodeTypes: [...facts.nodeTypes].sort(),
      sequentialScanRelations: [...facts.sequentialScanRelations].sort(),
      sortMethods: [...facts.sortMethods].sort(),
    };
  }

  it("proves bounded default-planner paths at production-like cardinality under the exact runtime authority", async () => {
    const fixture = await planner!.query<{
      venues: string;
      prices: string;
      requests: string;
      missions: string;
      progress_links: string;
      submission_links: string;
      request_links: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM venue_profiles) AS venues,
         (SELECT count(*)::text FROM venue_price_records) AS prices,
         (SELECT count(*)::text FROM venue_requests) AS requests,
         (SELECT count(*)::text FROM missions) AS missions,
         (SELECT count(*)::text FROM mission_progress) AS progress_links,
         (SELECT count(*)::text FROM submissions WHERE mission_id IS NOT NULL) AS submission_links,
         (SELECT count(*)::text FROM venue_requests WHERE mission_id IS NOT NULL) AS request_links`,
    );
    expect(fixture.rows[0]).toEqual({
      venues: String(VENUE_COUNT),
      prices: String(PRICE_COUNT),
      requests: String(REQUEST_COUNT),
      missions: String(MISSION_COUNT),
      progress_links: "200",
      submission_links: "200",
      request_links: "200",
    });

    const authority = await planner!.query<{
      session_login: string;
      current_login: string;
      current_role: string;
      superuser: boolean;
      create_database: boolean;
      create_role: boolean;
      inherit: boolean;
      replication: boolean;
      bypassrls: boolean;
      parents: string[];
      children: string[];
      can_connect: boolean;
      can_create: boolean;
      can_temporary: boolean;
      row_security_setting: string;
    }>(
      `SELECT session_user AS session_login,
              current_user AS current_login,
              current_role AS current_role,
              role.rolsuper AS superuser,
              role.rolcreatedb AS create_database,
              role.rolcreaterole AS create_role,
              role.rolinherit AS inherit,
              role.rolreplication AS replication,
              role.rolbypassrls AS bypassrls,
              ARRAY(
                SELECT parent.rolname::text
                  FROM pg_catalog.pg_auth_members membership
                  JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
                 WHERE membership.member = role.oid
                 ORDER BY parent.rolname
              ) AS parents,
              ARRAY(
                SELECT member.rolname::text
                  FROM pg_catalog.pg_auth_members membership
                  JOIN pg_catalog.pg_roles member ON member.oid = membership.member
                 WHERE membership.roleid = role.oid
                 ORDER BY member.rolname
              ) AS children,
              pg_catalog.has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
              pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
              pg_catalog.has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_temporary,
              current_setting('row_security') AS row_security_setting
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = current_user`,
    );
    expect(authority.rows[0]).toEqual({
      session_login: TEST_LOGIN,
      current_login: TEST_LOGIN,
      current_role: TEST_LOGIN,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: true,
      replication: false,
      bypassrls: false,
      parents: ["pintpath_runtime"],
      children: [],
      can_connect: true,
      can_create: false,
      can_temporary: false,
      row_security_setting: "on",
    });

    const runtimeAuthority = await planner!.query<{
      can_login: boolean;
      superuser: boolean;
      create_database: boolean;
      create_role: boolean;
      inherit: boolean;
      replication: boolean;
      bypassrls: boolean;
      parents: string[];
    }>(
      `SELECT role.rolcanlogin AS can_login,
              role.rolsuper AS superuser,
              role.rolcreatedb AS create_database,
              role.rolcreaterole AS create_role,
              role.rolinherit AS inherit,
              role.rolreplication AS replication,
              role.rolbypassrls AS bypassrls,
              ARRAY(
                SELECT parent.rolname::text
                  FROM pg_catalog.pg_auth_members membership
                  JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
                 WHERE membership.member = role.oid
                 ORDER BY parent.rolname
              ) AS parents
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = 'pintpath_runtime'`,
    );
    expect(runtimeAuthority.rows).toEqual([{
      can_login: false,
      superuser: false,
      create_database: false,
      create_role: false,
      inherit: true,
      replication: false,
      bypassrls: false,
      parents: [],
    }]);

    const memberships = await planner!.query<{
      parent: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      `SELECT parent.rolname::text AS parent,
              membership.admin_option,
              membership.inherit_option,
              membership.set_option
         FROM pg_catalog.pg_auth_members membership
         JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
         JOIN pg_catalog.pg_roles member ON member.oid = membership.member
        WHERE member.rolname = current_user
        ORDER BY parent.rolname`,
    );
    expect(memberships.rows).toEqual([{
      parent: "pintpath_runtime",
      admin_option: false,
      inherit_option: true,
      set_option: true,
    }]);

    const protectedTables = [
      "accounts",
      "mission_progress",
      "missions",
      "submissions",
      "venue_happy_hours",
      "venue_location_cache",
      "venue_price_records",
      "venue_profiles",
      "venue_requests",
    ];
    const rls = await planner!.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      runtime_policy_count: string;
    }>(
      `SELECT relation.relname::text AS table_name,
              relation.relrowsecurity AS enabled,
              relation.relforcerowsecurity AS forced,
              count(policy.oid) FILTER (
                WHERE policy.polroles = ARRAY['pintpath_runtime'::regrole::oid]
                  AND policy.polname = (relation.relname || '_runtime_all')::name
                  AND policy.polcmd = '*'
              )::text AS runtime_policy_count
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_catalog.pg_policy policy ON policy.polrelid = relation.oid
        WHERE namespace.nspname = 'pintpath_app'
          AND relation.relname = ANY($1::text[])
        GROUP BY relation.oid, relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
        ORDER BY relation.relname`,
      [protectedTables],
    );
    expect(rls.rows).toEqual(protectedTables.map((tableName) => ({
      table_name: tableName,
      enabled: true,
      forced: true,
      runtime_policy_count: "1",
    })));

    const plannerDefaults = await planner!.query<{ name: string; setting: string }>(
      `SELECT name, setting
         FROM pg_catalog.pg_settings
        WHERE name = ANY(ARRAY[
          'enable_bitmapscan', 'enable_hashagg', 'enable_hashjoin',
          'enable_incremental_sort', 'enable_indexonlyscan', 'enable_indexscan',
          'enable_memoize', 'enable_mergejoin', 'enable_nestloop',
          'enable_seqscan', 'enable_sort', 'plan_cache_mode'
        ])
        ORDER BY name`,
    );
    expect(Object.fromEntries(plannerDefaults.rows.map((row) => [row.name, row.setting]))).toEqual({
      enable_bitmapscan: "on",
      enable_hashagg: "on",
      enable_hashjoin: "on",
      enable_incremental_sort: "on",
      enable_indexonlyscan: "on",
      enable_indexscan: "on",
      enable_memoize: "on",
      enable_mergejoin: "on",
      enable_nestloop: "on",
      enable_seqscan: "on",
      enable_sort: "on",
      plan_cache_mode: "auto",
    });

    const firstDeepFeed = await oneRoundTrip(() => repository.listMissionFeedPage(feedInput({
      limit: DEEP_LIMIT,
      offset: DEEP_OFFSET,
    })));
    expect(firstDeepFeed.result.total).toBe(12_500);
    expect(firstDeepFeed.result.missions.map((mission) => mission.id)).toEqual([
      "manual:002499",
      "manual:002500",
    ]);
    const repeatedDeepFeed = await oneRoundTrip(() => repository.listMissionFeedPage(feedInput({
      limit: DEEP_LIMIT,
      offset: DEEP_OFFSET,
    })));
    expect(repeatedDeepFeed.result).toEqual(firstDeepFeed.result);

    const searchFeed = await oneRoundTrip(() => repository.listMissionFeedPage(feedInput({
      searchTerms: ["needle-006000"],
      limit: 10,
    })));
    expect(searchFeed.result.total).toBe(1);
    expect(searchFeed.result.missions.map((mission) => mission.id)).toEqual(["manual:006000"]);

    const radiusFeed = await oneRoundTrip(() => repository.listMissionFeedPage(feedInput({
      latitude: -37.81359,
      longitude: 144.96311,
      sort: "nearby",
      limit: 2,
    })));
    expect(radiusFeed.result.total).toBe(11_500);
    expect(radiusFeed.result.missions.map((mission) => mission.id)).toEqual([
      "manual:000001",
      "manual:000002",
    ]);

    const firstCandidates = await oneRoundTrip(() => repository.listMissionVenueCandidates({
      limit: DEEP_LIMIT,
      offset: DEEP_OFFSET,
    }));
    expect(firstCandidates.result).toEqual([
      expect.objectContaining({ venueId: "venue:004999", recordCount: 10, latestVerifiedAt: T0 }),
      expect.objectContaining({ venueId: "venue:005000", recordCount: 10, latestVerifiedAt: T0 }),
    ]);
    const repeatedCandidates = await oneRoundTrip(() => repository.listMissionVenueCandidates({
      limit: DEEP_LIMIT,
      offset: DEEP_OFFSET,
    }));
    expect(repeatedCandidates.result).toEqual(firstCandidates.result);

    const summaries: ExplainSummary[] = [];
    summaries.push(await explain(
      "public-feed-deep-page",
      repeatedDeepFeed.capture,
      PLAN_CEILINGS_MS.publicFeed,
    ));
    summaries.push(await explain("address-search", searchFeed.capture, PLAN_CEILINGS_MS.searchFeed));
    summaries.push(await explain("radius-sort", radiusFeed.capture, PLAN_CEILINGS_MS.radiusFeed));
    summaries.push(await explain(
      "venue-candidates-deep-page",
      repeatedCandidates.capture,
      PLAN_CEILINGS_MS.candidates,
    ));

    const inactiveCaptureStart = database!.captureCount();
    await expect(repository.pruneInactiveAutoMissions({ limit: 500 })).resolves.toEqual({
      changed: 500,
      hasMore: true,
    });
    const inactiveCapture = database!.capturesSince(inactiveCaptureStart).find((capture) =>
      capture.method === "all"
      && capture.sourceSql.includes("mission.id LIKE 'auto:%' AND mission.active = @falsity")
      && capture.sourceSql.includes("ORDER BY mission.id ASC"),
    );
    expect(inactiveCapture).toBeDefined();
    summaries.push(await explain(
      "inactive-auto-pruning",
      inactiveCapture!,
      PLAN_CEILINGS_MS.inactiveAuto,
    ));

    const demoCaptureStart = database!.captureCount();
    await expect(repository.deactivateDemoMissions({ now: T2, limit: 500 })).resolves.toEqual({
      changed: 500,
      hasMore: true,
    });
    const demoCapture = database!.capturesSince(demoCaptureStart).find((capture) =>
      capture.method === "all"
      && capture.sourceSql.includes("mission.venue_id LIKE 'demo:%' AND mission.active = @truth")
      && capture.sourceSql.includes("ORDER BY mission.id ASC"),
    );
    expect(demoCapture).toBeDefined();
    summaries.push(await explain("active-demo-deactivation", demoCapture!, PLAN_CEILINGS_MS.activeDemo));

    const ownerCaptureStart = database!.captureCount();
    await expect(repository.replaceAutoMissions({ missions: [], now: T2 })).resolves.toBe(0);
    const ownerCapture = database!.capturesSince(ownerCaptureStart).find((capture) =>
      capture.method === "all"
      && capture.sourceSql.includes("WHERE mission.id LIKE 'auto:%'")
      && !capture.sourceSql.includes("mission.active ="),
    );
    expect(ownerCapture).toBeDefined();
    summaries.push(await explain("auto-mission-owner-discovery", ownerCapture!, PLAN_CEILINGS_MS.autoOwners));

    expect(database!.metrics()).toMatchObject({ failedQueries: 0, transactionFailures: 0 });
    expect(summaries.map((summary) => summary.name)).toEqual([
      "public-feed-deep-page",
      "address-search",
      "radius-sort",
      "venue-candidates-deep-page",
      "inactive-auto-pruning",
      "active-demo-deactivation",
      "auto-mission-owner-discovery",
    ]);
    const evidence = Object.freeze({
      version: 1,
      serverVersionNum,
      canonicalSchemaSha256,
      fixture: fixture.rows[0],
      authority: {
        restrictedRuntimeLogin: true,
        exactRuntimeMembership: true,
        forcedRlsTableCount: protectedTables.length,
      },
      ceilingsMs: PLAN_CEILINGS_MS,
      plans: summaries,
    });
    writeScaleEvidence(evidence);
    console.info(`mission-discovery-scale-evidence=${JSON.stringify(evidence)}`);
  }, 120_000);
});
