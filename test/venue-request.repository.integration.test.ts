import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  VenueRequestRepository,
  VenueRequestRepositoryError,
  venueRequestLockKey,
  type CreateOrGetVenueRequestInput,
  type VenueRequestRepositoryErrorCode,
} from "../src/db/venue-request.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_venue_request_integration_test";
const TEST_LOGIN = "pintpath_venue_request_login";
const TEST_PASSWORD = "venue-request-test-password";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const T0 = "2026-08-08T12:00:00.000Z";
const T1 = "2026-08-08T12:05:00.000Z";
const T2 = "2026-08-08T12:10:00.000Z";
const T3 = "2026-08-08T12:15:00.000Z";

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

function requestInput(
  overrides: Partial<CreateOrGetVenueRequestInput> = {},
): CreateOrGetVenueRequestInput {
  return {
    id: "request-a",
    userId: null,
    anonymousSessionId: "anonymous-a",
    requestType: "missing_venue",
    venueId: null,
    venueName: "Alpha Hotel",
    googlePlaceId: "google-alpha",
    beerName: null,
    suburb: "Fitzroy",
    notes: "Please add this venue.",
    now: T0,
    ...overrides,
  };
}

function expectCode(code: VenueRequestRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof VenueRequestRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("venue request repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: VenueRequestRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Venue request integration requires PostgreSQL 17; received ${version}.`);
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
        auth_provider text NOT NULL DEFAULT 'local',
        role text NOT NULL DEFAULT 'user',
        subscription_status text NOT NULL DEFAULT 'free'
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

      CREATE TABLE pintpath_app.submissions (
        id text PRIMARY KEY
      );

      CREATE TABLE pintpath_app.account_deletion_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES pintpath_app.accounts(id) ON DELETE CASCADE,
        status text NOT NULL
      );

      CREATE TABLE pintpath_app.venue_requests (
        id text PRIMARY KEY,
        user_id text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        anonymous_session_id text,
        request_type text NOT NULL,
        venue_id text,
        venue_name text,
        google_place_id text,
        beer_name text,
        suburb text,
        notes text,
        status text NOT NULL DEFAULT 'open',
        mission_id text REFERENCES pintpath_app.missions(id) ON DELETE SET NULL,
        source_submission_id text REFERENCES pintpath_app.submissions(id) ON DELETE SET NULL,
        assigned_to text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        resolution_note text,
        resolved_at timestamptz,
        resolved_by text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX venue_requests_order
        ON pintpath_app.venue_requests (created_at DESC, id ASC);
      CREATE UNIQUE INDEX venue_requests_user_google_open
        ON pintpath_app.venue_requests (user_id, google_place_id)
        WHERE user_id IS NOT NULL AND google_place_id IS NOT NULL
          AND request_type = 'missing_venue'
          AND status IN ('open', 'in_progress', 'mission_created');
      CREATE UNIQUE INDEX venue_requests_anon_google_open
        ON pintpath_app.venue_requests (anonymous_session_id, google_place_id)
        WHERE user_id IS NULL AND anonymous_session_id IS NOT NULL
          AND google_place_id IS NOT NULL AND request_type = 'missing_venue'
          AND status IN ('open', 'in_progress', 'mission_created');

      ALTER TABLE pintpath_app.accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.accounts FORCE ROW LEVEL SECURITY;
      CREATE POLICY accounts_runtime_select ON pintpath_app.accounts
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY accounts_runtime_update ON pintpath_app.accounts
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.missions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.missions FORCE ROW LEVEL SECURITY;
      CREATE POLICY missions_runtime_select ON pintpath_app.missions
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY missions_runtime_insert ON pintpath_app.missions
        FOR INSERT TO ${TEST_LOGIN} WITH CHECK (true);

      ALTER TABLE pintpath_app.submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.submissions FORCE ROW LEVEL SECURITY;
      CREATE POLICY submissions_runtime_select ON pintpath_app.submissions
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      ALTER TABLE pintpath_app.account_deletion_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.account_deletion_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY deletion_runtime_select ON pintpath_app.account_deletion_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      ALTER TABLE pintpath_app.venue_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY venue_requests_runtime_select ON pintpath_app.venue_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY venue_requests_runtime_insert ON pintpath_app.venue_requests
        FOR INSERT TO ${TEST_LOGIN} WITH CHECK (true);
      CREATE POLICY venue_requests_runtime_update ON pintpath_app.venue_requests
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT UPDATE (id) ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT SELECT, INSERT ON pintpath_app.missions TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.submissions TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.account_deletion_requests TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.venue_requests TO ${TEST_LOGIN};

      CREATE FUNCTION pintpath_app.reject_rollback_request_claim()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF NEW.id = 'rollback-request' THEN
          RAISE EXCEPTION 'forced venue-request rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_rollback_request_claim() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_rollback_request_claim() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_rollback_request_claim
        BEFORE UPDATE ON pintpath_app.venue_requests
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_rollback_request_claim();
    `);

    restrictedUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new VenueRequestRepository(database);
  });

  beforeEach(async () => {
    await targetAdmin!.query(
      `TRUNCATE TABLE
         pintpath_app.venue_requests,
         pintpath_app.account_deletion_requests,
         pintpath_app.submissions,
         pintpath_app.missions,
         pintpath_app.accounts`,
    );
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
        throw new Error("Venue request PostgreSQL integration cleanup was not exact.");
      }
      await admin.end().catch(() => undefined);
    }
  });

  async function insertAccount(
    id: string,
    options: {
      status?: string;
      authProvider?: string;
      role?: string;
      subscriptionStatus?: string;
    } = {},
  ): Promise<void> {
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.accounts
         (id, status, auth_provider, role, subscription_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        options.status ?? "active",
        options.authProvider ?? "local",
        options.role ?? "user",
        options.subscriptionStatus ?? "free",
      ],
    );
  }

  async function insertAdmin(id: string): Promise<void> {
    await insertAccount(id, { role: "admin", subscriptionStatus: "admin" });
  }

  it("shares advisory fences, deduplicates contention, promotes ownership, and runs with RLS and least privilege", async () => {
    await insertAccount("owner-a");

    const blocker = new Client({ connectionString: restrictedUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [venueRequestLockKey("blocked-request")],
    );
    let settled = false;
    const blocked = repository.createOrGetVenueRequest(requestInput({
      id: "blocked-request",
      googlePlaceId: "google-blocked",
    })).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    await blocked;
    await blocker.end();

    const race = await Promise.all([
      repository.createOrGetVenueRequest(requestInput({
        id: "owner-request-a",
        userId: "owner-a",
        googlePlaceId: "google-owner",
      })),
      repository.createOrGetVenueRequest(requestInput({
        id: "owner-request-b",
        userId: "owner-a",
        googlePlaceId: "google-owner",
      })),
    ]);
    expect(race.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(new Set(race.map((result) => result.request.id)).size).toBe(1);

    const anonymous = await repository.createOrGetVenueRequest(requestInput({
      id: "anonymous-request",
      googlePlaceId: "google-promotion",
      anonymousSessionId: "promote-session",
    }));
    const promoted = await repository.createOrGetVenueRequest(requestInput({
      id: "authenticated-retry",
      userId: "owner-a",
      googlePlaceId: "google-promotion",
      anonymousSessionId: "promote-session",
      now: T1,
    }));
    expect(promoted).toMatchObject({
      duplicate: true,
      ownershipPromoted: true,
      request: { id: anonymous.request.id, userId: "owner-a", updatedAt: T1 },
    });

    const native = await targetAdmin!.query<{
      created_type: string;
      resolved_type: string;
    }>(`
      SELECT pg_typeof(created_at)::text AS created_type,
             pg_typeof(resolved_at)::text AS resolved_type
        FROM pintpath_app.venue_requests WHERE id = 'anonymous-request'
    `);
    expect(native.rows[0]).toEqual({
      created_type: "timestamp with time zone",
      resolved_type: "timestamp with time zone",
    });

    const security = await targetAdmin!.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname AS table_name, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relnamespace = 'pintpath_app'::regnamespace
         AND relname IN (
           'accounts', 'missions', 'submissions',
           'account_deletion_requests', 'venue_requests'
         )
       ORDER BY relname
    `);
    expect(security.rows).toHaveLength(5);
    expect(security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const restricted = new Client({ connectionString: restrictedUrl });
    await restricted.connect();
    const privileges = await restricted.query<{
      superuser: boolean;
      bypassrls: boolean;
      create_database: boolean;
      create_role: boolean;
      account_insert: boolean;
      account_update: boolean;
      account_id_update: boolean;
      request_delete: boolean;
      mission_update: boolean;
      mission_delete: boolean;
    }>(`
      SELECT role.rolsuper AS superuser, role.rolbypassrls AS bypassrls,
             role.rolcreatedb AS create_database, role.rolcreaterole AS create_role,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'INSERT') AS account_insert,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'UPDATE') AS account_update,
             has_column_privilege(current_user, 'pintpath_app.accounts', 'id', 'UPDATE') AS account_id_update,
             has_table_privilege(current_user, 'pintpath_app.venue_requests', 'DELETE') AS request_delete,
             has_table_privilege(current_user, 'pintpath_app.missions', 'UPDATE') AS mission_update,
             has_table_privilege(current_user, 'pintpath_app.missions', 'DELETE') AS mission_delete
        FROM pg_roles role WHERE role.rolname = current_user
    `);
    expect(privileges.rows[0]).toEqual({
      superuser: false,
      bypassrls: false,
      create_database: false,
      create_role: false,
      account_insert: false,
      account_update: false,
      account_id_update: true,
      request_delete: false,
      mission_update: false,
      mission_delete: false,
    });
    await expect(restricted.query("DELETE FROM pintpath_app.venue_requests"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(restricted.query("TRUNCATE pintpath_app.venue_requests"))
      .rejects.toMatchObject({ code: "42501" });
    await restricted.end();
  });

  it("enforces account/deletion/admin boundaries and deterministic OCC workflow pagination", async () => {
    await insertAdmin("admin-a");
    await insertAdmin("admin-b");
    await insertAdmin("admin-deletion");
    await insertAccount("ordinary");
    await insertAccount("suspended", { status: "suspended" });
    await insertAccount("deletion-locked");
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.account_deletion_requests (id, user_id, status)
       VALUES
         ('delete-lock', 'deletion-locked', 'processing'),
         ('delete-admin-lock', 'admin-deletion', 'processing')`,
    );

    await expect(repository.createOrGetVenueRequest(requestInput({ id: "suspended", userId: "suspended" })))
      .rejects.toSatisfy(expectCode("account_not_eligible"));
    await expect(repository.createOrGetVenueRequest(requestInput({
      id: "deletion-locked",
      userId: "deletion-locked",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));

    const request = (await repository.createOrGetVenueRequest(requestInput())).request;
    const assigned = await repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: request.id,
      status: "in_progress",
      assignedTo: "admin-b",
      resolutionNote: "Reviewing.",
      expectedUpdatedAt: request.updatedAt,
      now: T1,
    });
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "ordinary",
      requestId: request.id,
      status: "resolved",
      assignedTo: null,
      resolutionNote: "No authority.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("admin_not_authorized"));
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-deletion",
      requestId: request.id,
      status: "resolved",
      assignedTo: null,
      resolutionNote: "Deletion must fence this mutation.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: request.id,
      status: "resolved",
      assignedTo: "admin-b",
      resolutionNote: "Resolved.",
      expectedUpdatedAt: request.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("request_version_conflict"));
    await repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: request.id,
      status: "resolved",
      assignedTo: "admin-b",
      resolutionNote: "Resolved.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    });

    await repository.createOrGetVenueRequest(requestInput({
      id: "later-request",
      googlePlaceId: "google-later",
      now: T3,
    }));
    const first = await repository.listVenueRequests({ limit: 1 });
    expect(first.requests.map((entry) => entry.id)).toEqual(["later-request"]);
    const second = await repository.listVenueRequests({ limit: 2, cursor: first.nextCursor });
    expect(second.requests.map((entry) => entry.id)).toEqual(["request-a"]);
    expect(await repository.countVenueRequests({ status: "resolved" })).toBe(1);
    expect(await repository.countVenueRequests({ status: "open" })).toBe(1);
  });

  it("claims request-to-mission exactly once and rolls back all partial mission writes", async () => {
    await insertAdmin("admin-a");
    await insertAdmin("admin-b");
    const request = (await repository.createOrGetVenueRequest(requestInput({
      requestType: "verify_beer_at_venue",
      venueId: "venue-a",
      googlePlaceId: null,
      beerName: "Pale Ale",
    }))).request;

    const race = await Promise.allSettled([
      repository.createMissionFromVenueRequest({
        actorAccountId: "admin-a",
        requestId: request.id,
        missionId: "mission-a",
        expectedRequestUpdatedAt: request.updatedAt,
        now: T1,
      }),
      repository.createMissionFromVenueRequest({
        actorAccountId: "admin-b",
        requestId: request.id,
        missionId: "mission-b",
        expectedRequestUpdatedAt: request.updatedAt,
        now: T1,
      }),
    ]);
    const winner = race.find((result) => result.status === "fulfilled");
    const loser = race.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winner?.status).toBe("fulfilled");
    expect(loser?.reason).toSatisfy((error: unknown) =>
      expectCode("request_version_conflict")(error) || expectCode("request_state_conflict")(error));
    if (winner?.status !== "fulfilled") throw new Error("Expected one request-to-mission winner.");
    expect(winner.value).toMatchObject({
      request: { status: "mission_created", missionId: winner.value.mission.id },
      mission: {
        venueId: "venue-a",
        venueName: "Alpha Hotel",
        reason: "verify beer at venue",
        points: 2,
        multiplier: 1,
        active: true,
        sponsorFlag: false,
      },
    });

    const native = await targetAdmin!.query<{
      points_type: string;
      active_type: string;
      created_type: string;
    }>(`
      SELECT pg_typeof(points)::text AS points_type,
             pg_typeof(active)::text AS active_type,
             pg_typeof(created_at)::text AS created_type
        FROM pintpath_app.missions WHERE id = $1
    `, [winner.value.mission.id]);
    expect(native.rows[0]).toEqual({
      points_type: "numeric",
      active_type: "boolean",
      created_type: "timestamp with time zone",
    });

    const rollbackRequest = (await repository.createOrGetVenueRequest(requestInput({
      id: "rollback-request",
      googlePlaceId: "google-rollback",
    }))).request;
    await expect(repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId: rollbackRequest.id,
      missionId: "rolled-back-mission",
      expectedRequestUpdatedAt: rollbackRequest.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    expect(await repository.getVenueRequestById(rollbackRequest.id))
      .toMatchObject({ status: "open", missionId: null, updatedAt: T0 });
    expect((await targetAdmin!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pintpath_app.missions WHERE id = 'rolled-back-mission'",
    )).rows[0]?.count).toBe("0");

    await targetAdmin!.query(
      `INSERT INTO pintpath_app.missions (
         id, venue_id, venue_name, reason, points, multiplier, created_at, updated_at
       ) VALUES ('occupied', 'venue-x', 'Existing', 'existing', 4, 1, $1, $1)`,
      [T0],
    );
    const conflictRequest = (await repository.createOrGetVenueRequest(requestInput({
      id: "conflict-request",
      googlePlaceId: "google-conflict",
    }))).request;
    await expect(repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId: conflictRequest.id,
      missionId: "occupied",
      expectedRequestUpdatedAt: conflictRequest.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("mission_id_conflict"));
    expect(await repository.getVenueRequestById(conflictRequest.id))
      .toMatchObject({ status: "open", missionId: null, updatedAt: T0 });
  });
});
