import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MissionLifecycleRepository,
  MissionLifecycleRepositoryError,
  missionLifecycleAccountLockKey,
  missionLifecycleMissionLockKey,
  type CreateMissionInput,
  type MissionLifecycleRepositoryErrorCode,
} from "../src/db/mission-lifecycle.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_mission_lifecycle_integration_test";
const TEST_LOGIN = "pintpath_mission_lifecycle_login";
const TEST_PASSWORD = "mission-lifecycle-test-password";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const T0 = "2026-08-08T12:00:00.000Z";
const T1 = "2026-08-08T12:05:00.000Z";
const T2 = "2026-08-08T12:10:00.000Z";
const OLD_CUTOFF = "2020-01-01T00:00:00.000Z";

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

function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    id: "mission-a",
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    reason: "Verify the current pint price.",
    priority: "high",
    points: 5.25,
    multiplier: 1.5,
    active: true,
    sponsorFlag: false,
    lastVerifiedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function expectCode(code: MissionLifecycleRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof MissionLifecycleRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("mission lifecycle repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: MissionLifecycleRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Mission lifecycle integration requires PostgreSQL 17; received ${version}.`);
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
      CREATE INDEX missions_lifecycle_order
        ON pintpath_app.missions (updated_at DESC, id ASC);

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
      CREATE UNIQUE INDEX mission_progress_open_reservation
        ON pintpath_app.mission_progress (mission_id)
        WHERE status IN ('accepted', 'submitted');
      CREATE INDEX mission_progress_user_updated
        ON pintpath_app.mission_progress (user_id, updated_at DESC, id ASC);
      CREATE INDEX mission_progress_expiry
        ON pintpath_app.mission_progress (status, accepted_at, id);

      CREATE TABLE pintpath_app.account_deletion_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES pintpath_app.accounts(id) ON DELETE CASCADE,
        status text NOT NULL
      );

      CREATE TABLE pintpath_app.venue_requests (
        id text PRIMARY KEY,
        mission_id text REFERENCES pintpath_app.missions(id) ON DELETE SET NULL
      );

      ALTER TABLE pintpath_app.accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.accounts FORCE ROW LEVEL SECURITY;
      CREATE POLICY accounts_runtime_select ON pintpath_app.accounts
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY accounts_runtime_update ON pintpath_app.accounts
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.missions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.missions FORCE ROW LEVEL SECURITY;
      CREATE POLICY missions_runtime_all ON pintpath_app.missions
        FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.submissions FORCE ROW LEVEL SECURITY;
      CREATE POLICY submissions_runtime_select ON pintpath_app.submissions
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      ALTER TABLE pintpath_app.mission_progress ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.mission_progress FORCE ROW LEVEL SECURITY;
      CREATE POLICY mission_progress_runtime_all ON pintpath_app.mission_progress
        FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.account_deletion_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.account_deletion_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY deletion_runtime_select ON pintpath_app.account_deletion_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      ALTER TABLE pintpath_app.venue_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY venue_requests_runtime_select ON pintpath_app.venue_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT UPDATE (id) ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE, DELETE ON pintpath_app.missions TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.submissions TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.mission_progress TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.account_deletion_requests TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.venue_requests TO ${TEST_LOGIN};

      CREATE FUNCTION pintpath_app.reject_second_rollback_progress()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF NEW.user_id = 'rollback-second' THEN
          RAISE EXCEPTION 'forced mission-progress rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_second_rollback_progress() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_second_rollback_progress() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_second_rollback_progress
        BEFORE INSERT ON pintpath_app.mission_progress
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_second_rollback_progress();
    `);

    restrictedUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new MissionLifecycleRepository(database);
  });

  beforeEach(async () => {
    await targetAdmin!.query(
      `TRUNCATE TABLE
         pintpath_app.mission_progress,
         pintpath_app.submissions,
         pintpath_app.venue_requests,
         pintpath_app.account_deletion_requests,
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
        throw new Error("Mission lifecycle PostgreSQL integration cleanup was not exact.");
      }
      await admin.end().catch(() => undefined);
    }
  });

  async function insertAccount(id: string, status = "active", authProvider = "local"): Promise<void> {
    await targetAdmin!.query(
      "INSERT INTO pintpath_app.accounts (id, status, auth_provider) VALUES ($1, $2, $3)",
      [id, status, authProvider],
    );
  }

  it("uses the shared mission advisory fence, gives contention one winner, and runs with native types and least privilege", async () => {
    await insertAccount("pg-owner-a");
    await insertAccount("pg-owner-b");
    const created = await repository.createMission(missionInput());
    await repository.createMission(missionInput({
      id: "mission-admin-weighted",
      venueId: "venue-admin-weighted",
      points: 6,
      multiplier: 2,
    }));
    expect((await repository.listAdminMissions({ limit: 2, offset: 0 })).map((mission) => mission.id))
      .toEqual(["mission-admin-weighted", "mission-a"]);

    const blocker = new Client({ connectionString: restrictedUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [missionLifecycleMissionLockKey("mission-a")],
    );
    let settled = false;
    const fenced = repository.setMissionActive({
      missionId: "mission-a",
      active: false,
      expectedUpdatedAt: created.updatedAt,
      now: T1,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    const disabled = await fenced;
    await blocker.end();
    await repository.setMissionActive({
      missionId: disabled.id,
      active: true,
      expectedUpdatedAt: disabled.updatedAt,
      now: T2,
    });

    const race = await Promise.allSettled([
      repository.acceptMission({ missionId: "mission-a", userId: "pg-owner-a", now: T2, acceptedAfter: OLD_CUTOFF }),
      repository.acceptMission({ missionId: "mission-a", userId: "pg-owner-b", now: T2, acceptedAfter: OLD_CUTOFF }),
    ]);
    const winners = race.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<
      MissionLifecycleRepository["acceptMission"]
    >>> => result.status === "fulfilled");
    const losers = race.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toSatisfy(expectCode("mission_reserved"));
    await expect(repository.acceptMission({
      missionId: "mission-a",
      userId: winners[0]!.value.userId,
      now: T2,
      acceptedAfter: OLD_CUTOFF,
    })).resolves.toEqual(winners[0]!.value);

    const native = await targetAdmin!.query<{
      points_type: string;
      active_type: string;
      created_type: string;
      accepted_type: string;
    }>(`
      SELECT pg_typeof(mission.points)::text AS points_type,
             pg_typeof(mission.active)::text AS active_type,
             pg_typeof(mission.created_at)::text AS created_type,
             pg_typeof(progress.accepted_at)::text AS accepted_type
        FROM pintpath_app.missions mission
        JOIN pintpath_app.mission_progress progress ON progress.mission_id = mission.id
       WHERE mission.id = 'mission-a'
    `);
    expect(native.rows[0]).toEqual({
      points_type: "numeric",
      active_type: "boolean",
      created_type: "timestamp with time zone",
      accepted_type: "timestamp with time zone",
    });

    const security = await targetAdmin!.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname AS table_name, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relnamespace = 'pintpath_app'::regnamespace
         AND relname IN ('accounts', 'missions', 'mission_progress', 'account_deletion_requests')
       ORDER BY relname
    `);
    expect(security.rows).toHaveLength(4);
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
      progress_delete: boolean;
      mission_delete: boolean;
    }>(`
      SELECT role.rolsuper AS superuser, role.rolbypassrls AS bypassrls,
             role.rolcreatedb AS create_database, role.rolcreaterole AS create_role,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'INSERT') AS account_insert,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'UPDATE') AS account_update,
             has_column_privilege(current_user, 'pintpath_app.accounts', 'id', 'UPDATE') AS account_id_update,
             has_table_privilege(current_user, 'pintpath_app.mission_progress', 'DELETE') AS progress_delete,
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
      progress_delete: false,
      mission_delete: true,
    });
    await expect(restricted.query(
      "INSERT INTO pintpath_app.accounts (id) VALUES ('forbidden-account')",
    )).rejects.toMatchObject({ code: "42501" });
    await expect(restricted.query("TRUNCATE pintpath_app.missions"))
      .rejects.toMatchObject({ code: "42501" });
    await restricted.end();
  });

  it("reclaims expiry, fences stale releases, and enforces inactive/account/deletion boundaries", async () => {
    for (const id of ["first", "second", "suspended", "deletion-locked"]) await insertAccount(id);
    await targetAdmin!.query("UPDATE pintpath_app.accounts SET status = 'suspended' WHERE id = 'suspended'");
    await targetAdmin!.query(
      "INSERT INTO pintpath_app.account_deletion_requests (id, user_id, status) VALUES ('delete-lock', 'deletion-locked', 'processing')",
    );
    await repository.createMission(missionInput());

    const first = await repository.acceptMission({
      missionId: "mission-a", userId: "first", now: T0, acceptedAfter: OLD_CUTOFF,
    });
    const second = await repository.acceptMission({
      missionId: "mission-a", userId: "second", now: T2, acceptedAfter: T0,
    });
    await expect(repository.getMissionProgress({ missionId: "mission-a", userId: "first" }))
      .resolves.toMatchObject({ id: first.id, status: "cancelled" });
    await expect(repository.releaseAcceptedMission({
      missionId: "mission-a",
      userId: "second",
      expectedAcceptedAt: second.acceptedAt,
      expectedUpdatedAt: T0,
      now: T2,
    })).rejects.toSatisfy(expectCode("progress_version_conflict"));
    const releaseBlocker = new Client({ connectionString: restrictedUrl });
    await releaseBlocker.connect();
    await releaseBlocker.query("BEGIN");
    await releaseBlocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [missionLifecycleAccountLockKey("second")],
    );
    let releaseSettled = false;
    const release = repository.releaseAcceptedMission({
      missionId: "mission-a",
      userId: "second",
      expectedAcceptedAt: second.acceptedAt,
      expectedUpdatedAt: second.updatedAt,
      now: T2,
    }).finally(() => {
      releaseSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(releaseSettled).toBe(false);
    await releaseBlocker.query("COMMIT");
    await expect(release).resolves.toMatchObject({ status: "cancelled" });
    await releaseBlocker.end();

    for (const [id, account] of [["suspended-mission", "suspended"], ["deletion-mission", "deletion-locked"]] as const) {
      await repository.createMission(missionInput({ id, venueId: `${id}-venue` }));
      await expect(repository.acceptMission({ missionId: id, userId: account, now: T2, acceptedAfter: OLD_CUTOFF }))
        .rejects.toSatisfy(expectCode(account === "suspended" ? "account_not_eligible" : "deletion_locked"));
    }
    const inactive = await repository.createMission(missionInput({
      id: "inactive-mission", venueId: "inactive-venue", active: false,
    }));
    await expect(repository.acceptMission({
      missionId: inactive.id, userId: "first", now: T2, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("mission_inactive"));

    for (const suffix of ["x", "y", "z"]) {
      await insertAccount(`batch-${suffix}`);
      await repository.createMission(missionInput({ id: `batch-${suffix}`, venueId: `batch-venue-${suffix}` }));
      await repository.acceptMission({
        missionId: `batch-${suffix}`, userId: `batch-${suffix}`, now: T0, acceptedAfter: OLD_CUTOFF,
      });
    }
    await expect(repository.expireAcceptedMissionProgress({ acceptedBefore: T0, now: T1, limit: 2 }))
      .resolves.toEqual({ expired: 2, hasMore: true });
    await expect(repository.expireAcceptedMissionProgress({ acceptedBefore: T0, now: T1, limit: 2 }))
      .resolves.toEqual({ expired: 1, hasMore: false });
  });

  it("applies admin OCC/delete guards and rolls back expiry cleanup after a failed replacement", async () => {
    await insertAccount("history-owner");
    await insertAccount("rollback-first");
    await insertAccount("rollback-second");

    const unused = await repository.createMission(missionInput({ id: "unused", venueId: "unused-venue" }));
    const inactive = await repository.setMissionActive({
      missionId: unused.id,
      active: false,
      expectedUpdatedAt: unused.updatedAt,
      now: T0,
    });
    await expect(repository.setMissionActive({
      missionId: unused.id,
      active: true,
      expectedUpdatedAt: unused.updatedAt,
      now: T1,
    })).rejects.toSatisfy(expectCode("mission_version_conflict"));
    await expect(repository.deleteMissionIfUnused({
      missionId: unused.id,
      expectedUpdatedAt: inactive.updatedAt,
    })).resolves.toEqual(inactive);

    const progressUsed = await repository.createMission(missionInput({
      id: "progress-used", venueId: "progress-used-venue",
    }));
    await repository.acceptMission({
      missionId: progressUsed.id, userId: "history-owner", now: T0, acceptedAfter: OLD_CUTOFF,
    });
    await expect(repository.deleteMissionIfUnused({
      missionId: progressUsed.id, expectedUpdatedAt: progressUsed.updatedAt,
    })).rejects.toSatisfy(expectCode("mission_in_use"));

    const submissionUsed = await repository.createMission(missionInput({
      id: "submission-used", venueId: "submission-used-venue",
    }));
    await targetAdmin!.query(
      "INSERT INTO pintpath_app.submissions (id, mission_id) VALUES ('submission-link', 'submission-used')",
    );
    await expect(repository.deleteMissionIfUnused({
      missionId: submissionUsed.id, expectedUpdatedAt: submissionUsed.updatedAt,
    })).rejects.toSatisfy(expectCode("mission_in_use"));

    const requestUsed = await repository.createMission(missionInput({
      id: "request-used", venueId: "request-used-venue",
    }));
    await targetAdmin!.query(
      "INSERT INTO pintpath_app.venue_requests (id, mission_id) VALUES ('request-link', 'request-used')",
    );
    await expect(repository.deleteMissionIfUnused({
      missionId: requestUsed.id, expectedUpdatedAt: requestUsed.updatedAt,
    })).rejects.toSatisfy(expectCode("mission_in_use"));

    await repository.createMission(missionInput({ id: "rollback", venueId: "rollback-venue" }));
    const first = await repository.acceptMission({
      missionId: "rollback", userId: "rollback-first", now: T0, acceptedAfter: OLD_CUTOFF,
    });
    await expect(repository.acceptMission({
      missionId: "rollback", userId: "rollback-second", now: T2, acceptedAfter: T0,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getMissionProgress({ missionId: "rollback", userId: "rollback-first" }))
      .resolves.toEqual(first);
    await expect(repository.getMissionProgress({ missionId: "rollback", userId: "rollback-second" }))
      .resolves.toBeNull();
  });
});
