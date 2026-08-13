import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MissionDiscoveryAutomationRepository,
  MissionDiscoveryAutomationRepositoryError,
  missionDiscoveryAutomationWriterLockKey,
  type AutoMissionDefinition,
  type MissionDiscoveryAutomationRepositoryErrorCode,
  type MissionFeedPageInput,
} from "../src/db/mission-discovery-automation.repository.js";
import {
  MissionLifecycleRepository,
  missionLifecycleMissionLockKey,
} from "../src/db/mission-lifecycle.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_mission_discovery_integration_test";
const TEST_LOGIN = "pintpath_mission_discovery_login";
const TEST_PASSWORD = "mission-discovery-test-password";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-25T00:00:00.000Z";
const T2 = "2026-07-31T00:00:00.000Z";
const T3 = "2026-08-01T00:00:00.000Z";
const ACCEPT_HOLD_KEY = "mission-discovery-test:accept-hold";

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

/** Restricted, explicitly disposable loopback-only PostgreSQL test adapter. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
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
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) =>
        (await this.query<Row>(sql, normalizeBindings(bindings))).rows[0],
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) =>
        (await this.query<Row>(sql, normalizeBindings(bindings))).rows,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `mission_discovery_nested_${active.nextSavepoint++}`;
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

function expectCode(code: MissionDiscoveryAutomationRepositoryErrorCode) {
  return (error: unknown) => error instanceof MissionDiscoveryAutomationRepositoryError && error.code === code;
}

function autoMission(id: string, overrides: Partial<AutoMissionDefinition> = {}): AutoMissionDefinition {
  return {
    id,
    venueId: overrides.venueId ?? `${id}:venue`,
    venueName: overrides.venueName ?? `Venue ${id}`,
    suburb: overrides.suburb ?? "Melbourne",
    reason: overrides.reason ?? "Stale drink menu - update current prices",
    priority: overrides.priority ?? "high",
    points: overrides.points ?? 10,
    multiplier: overrides.multiplier ?? 1,
    active: overrides.active ?? true,
    sponsorFlag: overrides.sponsorFlag ?? false,
    lastVerifiedAt: overrides.lastVerifiedAt ?? T0,
  };
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
    radiusMeters: 5_000,
    sort: "points",
    limit: 20,
    offset: 0,
    acceptedAfter: T2,
    veryFreshCutoff: T2,
    weekOldCutoff: T1,
    veryFreshPoints: 1,
    weekOldPoints: 5,
    stalePoints: 10,
    newVenuePoints: 20,
    excludeHappyHourMissions: true,
    ...overrides,
  };
}

describe.skipIf(!configuredAdminUrl)("mission discovery/automation repository on restricted PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: MissionDiscoveryAutomationRepository;
  let lifecycle: MissionLifecycleRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Mission discovery integration requires PostgreSQL 17; received ${version}.`);
    }
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${TEST_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE} WITH TEMPLATE template0 ENCODING 'UTF8'`);
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(`
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA pintpath_app AUTHORIZATION CURRENT_USER;
      REVOKE ALL ON SCHEMA pintpath_app FROM PUBLIC;

      CREATE TABLE pintpath_app.accounts (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'active',
        auth_provider text NOT NULL DEFAULT 'local'
      );
      CREATE TABLE pintpath_app.missions (
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
        last_verified_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX missions_active_updated ON pintpath_app.missions (active, updated_at DESC, id ASC);
      CREATE TABLE pintpath_app.submissions (
        id text PRIMARY KEY,
        mission_id text REFERENCES pintpath_app.missions(id) ON DELETE SET NULL
      );
      CREATE TABLE pintpath_app.mission_progress (
        id text PRIMARY KEY,
        mission_id text NOT NULL REFERENCES pintpath_app.missions(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES pintpath_app.accounts(id) ON DELETE CASCADE,
        submission_id text REFERENCES pintpath_app.submissions(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'accepted',
        accepted_at timestamptz NOT NULL,
        submitted_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL,
        UNIQUE (mission_id, user_id)
      );
      CREATE UNIQUE INDEX mission_progress_open ON pintpath_app.mission_progress (mission_id)
        WHERE status IN ('accepted', 'submitted');
      CREATE TABLE pintpath_app.account_deletion_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES pintpath_app.accounts(id),
        status text NOT NULL
      );
      CREATE TABLE pintpath_app.venue_requests (
        id text PRIMARY KEY,
        venue_id text,
        venue_name text,
        suburb text,
        mission_id text REFERENCES pintpath_app.missions(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX venue_requests_mission ON pintpath_app.venue_requests (mission_id);
      CREATE TABLE pintpath_app.venue_profiles (
        venue_id text PRIMARY KEY,
        name text NOT NULL,
        address text,
        suburb text,
        active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE pintpath_app.venue_location_cache (
        venue_id text PRIMARY KEY,
        venue_name text NOT NULL,
        suburb text,
        latitude double precision,
        longitude double precision,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE pintpath_app.venue_price_records (
        id text PRIMARY KEY,
        venue_id text NOT NULL,
        venue_name text NOT NULL,
        suburb text,
        is_happy_hour_price boolean NOT NULL DEFAULT false,
        happy_hour_details text,
        last_verified_at timestamptz NOT NULL
      );
      CREATE INDEX venue_price_venue_verified ON pintpath_app.venue_price_records (venue_id, last_verified_at DESC, id ASC);
      CREATE TABLE pintpath_app.venue_happy_hours (
        id text PRIMARY KEY,
        venue_id text NOT NULL REFERENCES pintpath_app.venue_profiles(venue_id),
        active boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL
      );

      ALTER TABLE pintpath_app.accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.accounts FORCE ROW LEVEL SECURITY;
      CREATE POLICY accounts_runtime ON pintpath_app.accounts FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY accounts_lock_runtime ON pintpath_app.accounts
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);
      ALTER TABLE pintpath_app.missions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.missions FORCE ROW LEVEL SECURITY;
      CREATE POLICY missions_runtime ON pintpath_app.missions FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);
      ALTER TABLE pintpath_app.submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.submissions FORCE ROW LEVEL SECURITY;
      CREATE POLICY submissions_runtime ON pintpath_app.submissions FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.mission_progress ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.mission_progress FORCE ROW LEVEL SECURITY;
      CREATE POLICY progress_runtime ON pintpath_app.mission_progress FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);
      ALTER TABLE pintpath_app.account_deletion_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.account_deletion_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY deletion_runtime ON pintpath_app.account_deletion_requests FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.venue_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY requests_runtime ON pintpath_app.venue_requests FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.venue_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_profiles FORCE ROW LEVEL SECURITY;
      CREATE POLICY profiles_runtime ON pintpath_app.venue_profiles FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.venue_location_cache ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_location_cache FORCE ROW LEVEL SECURITY;
      CREATE POLICY locations_runtime ON pintpath_app.venue_location_cache FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.venue_price_records ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_price_records FORCE ROW LEVEL SECURITY;
      CREATE POLICY prices_runtime ON pintpath_app.venue_price_records FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE pintpath_app.venue_happy_hours ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_happy_hours FORCE ROW LEVEL SECURITY;
      CREATE POLICY happy_runtime ON pintpath_app.venue_happy_hours FOR SELECT TO ${TEST_LOGIN} USING (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT UPDATE (id) ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE, DELETE ON pintpath_app.missions TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.submissions TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.mission_progress TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.account_deletion_requests TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_requests TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_profiles TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_location_cache TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_price_records TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_happy_hours TO ${TEST_LOGIN};

      CREATE FUNCTION pintpath_app.hold_race_acceptance()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF NEW.user_id = 'race-owner' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('${ACCEPT_HOLD_KEY}'));
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.hold_race_acceptance() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.hold_race_acceptance() TO ${TEST_LOGIN};
      CREATE TRIGGER hold_race_acceptance
        BEFORE INSERT ON pintpath_app.mission_progress
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.hold_race_acceptance();
    `);

    restrictedUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new MissionDiscoveryAutomationRepository(database);
    lifecycle = new MissionLifecycleRepository(database);
  });

  beforeEach(async () => {
    await targetAdmin!.query(`
      DROP TRIGGER IF EXISTS reject_automation_insert ON pintpath_app.missions;
      DROP FUNCTION IF EXISTS pintpath_app.reject_automation_insert();
      TRUNCATE TABLE
        pintpath_app.mission_progress,
        pintpath_app.submissions,
        pintpath_app.venue_requests,
        pintpath_app.venue_happy_hours,
        pintpath_app.venue_price_records,
        pintpath_app.venue_location_cache,
        pintpath_app.venue_profiles,
        pintpath_app.account_deletion_requests,
        pintpath_app.missions,
        pintpath_app.accounts;
    `);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      const cleanup = await admin.query<{ databases: string; roles: string }>(
        `SELECT
           (SELECT count(*)::text FROM pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::text FROM pg_roles WHERE rolname = $2) AS roles`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      if (cleanup.rows[0]?.databases !== "0" || cleanup.rows[0]?.roles !== "0") {
        throw new Error("Mission discovery PostgreSQL integration cleanup was not exact.");
      }
      await admin.end().catch(() => undefined);
    }
  });

  async function insertAccount(id: string): Promise<void> {
    await targetAdmin!.query("INSERT INTO pintpath_app.accounts (id) VALUES ($1)", [id]);
  }

  it("runs feed/candidate SQL with native types, one round trip, forced RLS, and least privilege", async () => {
    await lifecycle.createMission({
      id: "manual:pg-feed",
      venueId: "venue:pg-feed",
      venueName: "Postgres Feed Hotel",
      suburb: "Carlton",
      reason: "No data - add current prices",
      priority: "high",
      points: 5.25,
      multiplier: 1.5,
      active: true,
      sponsorFlag: false,
      lastVerifiedAt: null,
      createdAt: T0,
      updatedAt: T3,
    });
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.venue_profiles (venue_id, name, address, suburb, active)
       VALUES ('venue:pg-feed', 'Postgres Feed Hotel', '1 Smith Street', 'Carlton', true)`,
    );
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.venue_location_cache
       (venue_id, venue_name, suburb, latitude, longitude, updated_at)
       VALUES ('venue:pg-feed', 'Postgres Feed Hotel', 'Carlton', -37.8136, 144.9631, $1)`,
      [T3],
    );
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.venue_price_records
       (id, venue_id, venue_name, suburb, is_happy_hour_price, happy_hour_details, last_verified_at)
       VALUES ('price:pg-feed', 'venue:pg-feed', 'Postgres Feed Hotel', 'Carlton', false, null, $1)`,
      [T3],
    );

    const feedBefore = database!.metrics().completedQueries;
    const feed = await repository.listMissionFeedPage(feedInput({
      searchTerms: ["smith"], latitude: -37.8136, longitude: 144.9631, sort: "nearby",
    }));
    expect(database!.metrics().completedQueries - feedBefore).toBe(1);
    expect(feed).toEqual({
      total: 1,
      missions: [expect.objectContaining({
        id: "manual:pg-feed",
        points: 20,
        multiplier: 1.5,
        active: true,
        lastVerifiedAt: T3,
        distanceMeters: 0,
      })],
    });

    const candidateBefore = database!.metrics().completedQueries;
    const candidates = await repository.listMissionVenueCandidates({ limit: 10 });
    expect(database!.metrics().completedQueries - candidateBefore).toBe(1);
    expect(candidates).toEqual([
      expect.objectContaining({ venueId: "venue:pg-feed", recordCount: 1, latestVerifiedAt: T3 }),
    ]);

    const native = await targetAdmin!.query<{
      points: string;
      active: string;
      updated: string;
      latitude: string;
    }>(`
      SELECT pg_typeof(mission.points)::text AS points,
             pg_typeof(mission.active)::text AS active,
             pg_typeof(mission.updated_at)::text AS updated,
             pg_typeof(location.latitude)::text AS latitude
        FROM pintpath_app.missions mission
        JOIN pintpath_app.venue_location_cache location ON location.venue_id = mission.venue_id
       WHERE mission.id = 'manual:pg-feed'
    `);
    expect(native.rows[0]).toEqual({
      points: "numeric",
      active: "boolean",
      updated: "timestamp with time zone",
      latitude: "double precision",
    });

    const security = await targetAdmin!.query<{ rls: boolean; forced: boolean }>(`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'pintpath_app'::regnamespace
         AND relname IN (
           'accounts', 'missions', 'submissions', 'mission_progress',
           'account_deletion_requests', 'venue_requests', 'venue_profiles',
           'venue_location_cache', 'venue_price_records', 'venue_happy_hours'
         )
    `);
    expect(security.rows).toHaveLength(10);
    expect(security.rows.every((row) => row.rls && row.forced)).toBe(true);

    const restricted = new Client({ connectionString: restrictedUrl });
    await restricted.connect();
    const privileges = await restricted.query<{
      superuser: boolean;
      bypassrls: boolean;
      create_database: boolean;
      create_role: boolean;
      profile_insert: boolean;
      progress_delete: boolean;
      mission_delete: boolean;
    }>(`
      SELECT role.rolsuper AS superuser,
             role.rolbypassrls AS bypassrls,
             role.rolcreatedb AS create_database,
             role.rolcreaterole AS create_role,
             has_table_privilege(current_user, 'pintpath_app.venue_profiles', 'INSERT') AS profile_insert,
             has_table_privilege(current_user, 'pintpath_app.mission_progress', 'DELETE') AS progress_delete,
             has_table_privilege(current_user, 'pintpath_app.missions', 'DELETE') AS mission_delete
        FROM pg_roles role WHERE role.rolname = current_user
    `);
    expect(privileges.rows[0]).toEqual({
      superuser: false,
      bypassrls: false,
      create_database: false,
      create_role: false,
      profile_insert: false,
      progress_delete: false,
      mission_delete: true,
    });
    await expect(restricted.query("TRUNCATE pintpath_app.missions"))
      .rejects.toMatchObject({ code: "42501" });
    await restricted.end();
  });

  it("shares mission locks so acceptance wins replacement/deletion and serializes automation writers", async () => {
    await insertAccount("race-owner");
    await lifecycle.createMission({
      id: "auto:race",
      venueId: "race-venue",
      venueName: "Race Hotel",
      suburb: "Fitzroy",
      reason: "Stale price",
      priority: "high",
      points: 10,
      multiplier: 1,
      active: true,
      sponsorFlag: false,
      lastVerifiedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });

    const acceptHold = new Client({ connectionString: restrictedUrl });
    await acceptHold.connect();
    await acceptHold.query("BEGIN");
    await acceptHold.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ACCEPT_HOLD_KEY]);
    let acceptedSettled = false;
    const acceptance = lifecycle.acceptMission({
      missionId: "auto:race",
      userId: "race-owner",
      now: T2,
      acceptedAfter: "2026-06-01T00:00:00.000Z",
    }).finally(() => {
      acceptedSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acceptedSettled).toBe(false);
    let replacementSettled = false;
    const replacement = repository.replaceAutoMissions({ missions: [], now: T3 }).finally(() => {
      replacementSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementSettled).toBe(false);
    await acceptHold.query("COMMIT");
    await expect(acceptance).resolves.toEqual(expect.objectContaining({ status: "accepted" }));
    await expect(replacement).resolves.toBe(0);
    await acceptHold.end();
    expect((await targetAdmin!.query<{ active: boolean }>(
      "SELECT active FROM pintpath_app.missions WHERE id = 'auto:race'",
    )).rows[0]?.active).toBe(true);
    await expect(repository.pruneInactiveAutoMissions({ limit: 10 }))
      .resolves.toEqual({ changed: 0, hasMore: false });

    const writerBlock = new Client({ connectionString: restrictedUrl });
    await writerBlock.connect();
    await writerBlock.query("BEGIN");
    await writerBlock.query("SELECT pg_advisory_xact_lock(hashtext($1))", [missionDiscoveryAutomationWriterLockKey()]);
    let firstWriterSettled = false;
    let secondWriterSettled = false;
    const firstWriter = repository.replaceAutoMissions({
      missions: [autoMission("auto:writer", { venueId: "demo:writer" })],
      now: T3,
    }).finally(() => {
      firstWriterSettled = true;
    });
    const secondWriter = repository.deactivateDemoMissions({ now: T3, limit: 10 }).finally(() => {
      secondWriterSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstWriterSettled).toBe(false);
    expect(secondWriterSettled).toBe(false);
    await writerBlock.query("COMMIT");
    await Promise.all([firstWriter, secondWriter]);
    await writerBlock.end();
  });

  it("rechecks bounded owners and rolls back failed or malformed automation writes", async () => {
    await repository.replaceAutoMissions({ missions: [autoMission("auto:owner")], now: T1 });
    const blocker = new Client({ connectionString: restrictedUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [missionLifecycleMissionLockKey("auto:owner")]);
    const changedOwnerSet = repository.replaceAutoMissions({ missions: [], now: T3 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES ('auto:late-owner', 'late-venue', 'Late Venue', 'Stale price',
                 'high', 10, 1, true, false, $1, $1)`,
      [T2],
    );
    await blocker.query("COMMIT");
    await expect(changedOwnerSet).rejects.toSatisfy(expectCode("owner_set_changed"));
    await blocker.end();
    expect((await targetAdmin!.query<{ active: boolean }>(
      "SELECT active FROM pintpath_app.missions WHERE id = 'auto:owner'",
    )).rows[0]?.active).toBe(true);

    await targetAdmin!.query(`
      CREATE FUNCTION pintpath_app.reject_automation_insert()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF NEW.id = 'auto:rollback-b' THEN
          RAISE EXCEPTION 'forced automation rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_automation_insert() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_automation_insert() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_automation_insert
        BEFORE INSERT ON pintpath_app.missions
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_automation_insert();
    `);
    await expect(repository.replaceAutoMissions({
      missions: [autoMission("auto:rollback-a"), autoMission("auto:rollback-b")],
      now: T3,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    expect((await targetAdmin!.query<{ active: boolean }>(
      "SELECT active FROM pintpath_app.missions WHERE id = 'auto:owner'",
    )).rows[0]?.active).toBe(true);
    expect((await targetAdmin!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pintpath_app.missions WHERE id IN ('auto:rollback-a', 'auto:rollback-b')",
    )).rows[0]?.count).toBe("0");

    await targetAdmin!.query("DROP TRIGGER reject_automation_insert ON pintpath_app.missions");
    await targetAdmin!.query("DROP FUNCTION pintpath_app.reject_automation_insert()");
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES ('auto:malformed', 'demo:malformed', '', 'Stale price',
                 'high', 10, 1, true, false, $1, $1)`,
      [T0],
    );
    await expect(repository.deactivateDemoMissions({ now: T3, limit: 10 }))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });
});
