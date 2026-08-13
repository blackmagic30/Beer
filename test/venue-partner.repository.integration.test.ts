import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  VenuePartnerRepository,
  VenuePartnerRepositoryError,
  venuePartnerInterestLockKey,
  type CreateVenueInterestInput,
  type UpsertVenuePartnerOutreachInput,
  type VenuePartnerRepositoryErrorCode,
} from "../src/db/venue-partner.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_venue_partner_integration_test";
const TEST_LOGIN = "pintpath_venue_partner_login";
const TEST_PASSWORD = "venue-partner-test-password";
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

function interestInput(
  overrides: Partial<CreateVenueInterestInput> = {},
): CreateVenueInterestInput {
  return {
    id: "interest-a",
    userId: null,
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    managerName: "Alex Manager",
    email: "manager@example.test",
    phone: "+61 400 000 000",
    role: "Owner",
    notes: "Interested in launch access.",
    now: T0,
    ...overrides,
  };
}

function outreachInput(
  overrides: Partial<UpsertVenuePartnerOutreachInput> = {},
): UpsertVenuePartnerOutreachInput {
  return {
    actorAccountId: "admin-a",
    id: "outreach-a",
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    status: "lead",
    tierFit: "pro",
    nextAction: "Call the manager.",
    lastContactedAt: null,
    contactName: "Alex Manager",
    notes: "Warm introduction.",
    expectedUpdatedAt: null,
    now: T0,
    ...overrides,
  };
}

function expectCode(code: VenuePartnerRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof VenuePartnerRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("venue partner repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: VenuePartnerRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Venue partner integration requires PostgreSQL 17; received ${version}.`);
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

      CREATE TABLE pintpath_app.account_deletion_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES pintpath_app.accounts(id) ON DELETE CASCADE,
        status text NOT NULL
      );

      CREATE TABLE pintpath_app.venue_interest_requests (
        id text PRIMARY KEY,
        user_id text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        venue_id text,
        venue_name text NOT NULL,
        manager_name text NOT NULL,
        email text NOT NULL,
        phone text,
        role text NOT NULL,
        notes text,
        status text NOT NULL DEFAULT 'open',
        assigned_to text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        resolution_note text,
        resolved_at timestamptz,
        resolved_by text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX venue_interest_order
        ON pintpath_app.venue_interest_requests (created_at DESC, id ASC);
      CREATE INDEX venue_interest_status_order
        ON pintpath_app.venue_interest_requests (status, created_at DESC, id ASC);

      CREATE TABLE pintpath_app.venue_partner_outreach (
        id text PRIMARY KEY,
        venue_id text NOT NULL UNIQUE,
        venue_name text NOT NULL,
        suburb text,
        status text NOT NULL DEFAULT 'lead',
        tier_fit text,
        next_action text,
        last_contacted_at timestamptz,
        contact_name text,
        notes text,
        updated_by text REFERENCES pintpath_app.accounts(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX venue_outreach_order
        ON pintpath_app.venue_partner_outreach (updated_at DESC, venue_id ASC);
      CREATE INDEX venue_outreach_status_order
        ON pintpath_app.venue_partner_outreach (status, updated_at DESC, venue_id ASC);

      ALTER TABLE pintpath_app.accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.accounts FORCE ROW LEVEL SECURITY;
      CREATE POLICY accounts_runtime_select ON pintpath_app.accounts
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY accounts_runtime_update ON pintpath_app.accounts
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.account_deletion_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.account_deletion_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY deletion_runtime_select ON pintpath_app.account_deletion_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      ALTER TABLE pintpath_app.venue_interest_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_interest_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY interest_runtime_select ON pintpath_app.venue_interest_requests
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY interest_runtime_insert ON pintpath_app.venue_interest_requests
        FOR INSERT TO ${TEST_LOGIN} WITH CHECK (true);
      CREATE POLICY interest_runtime_update ON pintpath_app.venue_interest_requests
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      ALTER TABLE pintpath_app.venue_partner_outreach ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_partner_outreach FORCE ROW LEVEL SECURITY;
      CREATE POLICY outreach_runtime_select ON pintpath_app.venue_partner_outreach
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY outreach_runtime_insert ON pintpath_app.venue_partner_outreach
        FOR INSERT TO ${TEST_LOGIN} WITH CHECK (true);
      CREATE POLICY outreach_runtime_update ON pintpath_app.venue_partner_outreach
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT UPDATE (id) ON pintpath_app.accounts TO ${TEST_LOGIN};
      GRANT SELECT ON pintpath_app.account_deletion_requests TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.venue_interest_requests TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.venue_partner_outreach TO ${TEST_LOGIN};

      CREATE FUNCTION pintpath_app.reject_rollback_interest()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF OLD.id = 'rollback-interest' THEN
          RAISE EXCEPTION 'forced venue-interest rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_rollback_interest() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_rollback_interest() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_rollback_interest
        BEFORE UPDATE ON pintpath_app.venue_interest_requests
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_rollback_interest();

      CREATE FUNCTION pintpath_app.reject_rollback_outreach()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF OLD.venue_id = 'rollback-venue' THEN
          RAISE EXCEPTION 'forced venue-outreach rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_rollback_outreach() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_rollback_outreach() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_rollback_outreach
        BEFORE UPDATE ON pintpath_app.venue_partner_outreach
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_rollback_outreach();
    `);

    restrictedUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new VenuePartnerRepository(database);
  });

  beforeEach(async () => {
    await targetAdmin!.query(
      `TRUNCATE TABLE
         pintpath_app.venue_partner_outreach,
         pintpath_app.venue_interest_requests,
         pintpath_app.account_deletion_requests,
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
        throw new Error("Venue partner PostgreSQL integration cleanup was not exact.");
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

  it("shares advisory fences, replays contention, decodes native types, and runs under restricted RLS", async () => {
    await insertAdmin("admin-a");

    const blocker = new Client({ connectionString: restrictedUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [venuePartnerInterestLockKey("blocked-interest")],
    );
    let settled = false;
    const blocked = repository.createVenueInterest(interestInput({ id: "blocked-interest" })).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    await blocked;
    await blocker.end();

    const interestRace = await Promise.all([
      repository.createVenueInterest(interestInput({ id: "race-interest" })),
      repository.createVenueInterest(interestInput({ id: "race-interest", now: T1 })),
    ]);
    expect(interestRace[0]).toEqual(interestRace[1]);
    const outreachRace = await Promise.all([
      repository.upsertVenuePartnerOutreach(outreachInput({ id: "race-outreach-a", venueId: "race-venue" })),
      repository.upsertVenuePartnerOutreach(outreachInput({ id: "race-outreach-b", venueId: "race-venue" })),
    ]);
    expect(outreachRace.filter((result) => result.created)).toHaveLength(1);
    expect(outreachRace.filter((result) => result.replayed)).toHaveLength(1);

    const native = await targetAdmin!.query<{
      interest_created_type: string;
      interest_resolved_type: string;
      outreach_created_type: string;
      outreach_last_contacted_type: string;
      count_type: string;
    }>(`
      SELECT
        pg_typeof(interest.created_at)::text AS interest_created_type,
        pg_typeof(interest.resolved_at)::text AS interest_resolved_type,
        pg_typeof(outreach.created_at)::text AS outreach_created_type,
        pg_typeof(outreach.last_contacted_at)::text AS outreach_last_contacted_type,
        (SELECT pg_typeof(count(*))::text FROM pintpath_app.venue_partner_outreach) AS count_type
      FROM pintpath_app.venue_interest_requests interest
      CROSS JOIN pintpath_app.venue_partner_outreach outreach
      WHERE interest.id = 'race-interest' AND outreach.venue_id = 'race-venue'
    `);
    expect(native.rows[0]).toEqual({
      interest_created_type: "timestamp with time zone",
      interest_resolved_type: "timestamp with time zone",
      outreach_created_type: "timestamp with time zone",
      outreach_last_contacted_type: "timestamp with time zone",
      count_type: "bigint",
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
           'accounts', 'account_deletion_requests',
           'venue_interest_requests', 'venue_partner_outreach'
         )
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
      interest_delete: boolean;
      outreach_delete: boolean;
    }>(`
      SELECT role.rolsuper AS superuser, role.rolbypassrls AS bypassrls,
             role.rolcreatedb AS create_database, role.rolcreaterole AS create_role,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'INSERT') AS account_insert,
             has_table_privilege(current_user, 'pintpath_app.accounts', 'UPDATE') AS account_update,
             has_column_privilege(current_user, 'pintpath_app.accounts', 'id', 'UPDATE') AS account_id_update,
             has_table_privilege(current_user, 'pintpath_app.venue_interest_requests', 'DELETE') AS interest_delete,
             has_table_privilege(current_user, 'pintpath_app.venue_partner_outreach', 'DELETE') AS outreach_delete
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
      interest_delete: false,
      outreach_delete: false,
    });
    await expect(restricted.query("DELETE FROM pintpath_app.venue_interest_requests"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(restricted.query("TRUNCATE pintpath_app.venue_partner_outreach"))
      .rejects.toMatchObject({ code: "42501" });
    await restricted.end();
  });

  it("enforces owner/deletion/admin boundaries and deterministic OCC keysets", async () => {
    await insertAdmin("admin-a");
    await insertAdmin("admin-b");
    await insertAdmin("admin-deletion");
    await insertAccount("owner-a");
    await insertAccount("ordinary");
    await insertAccount("suspended", { status: "suspended" });
    await insertAccount("deletion-locked");
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.account_deletion_requests (id, user_id, status)
       VALUES
         ('delete-owner', 'deletion-locked', 'processing'),
         ('delete-admin', 'admin-deletion', 'processing')`,
    );

    await expect(repository.createVenueInterest(interestInput({ id: "suspended", userId: "suspended" })))
      .rejects.toSatisfy(expectCode("account_not_eligible"));
    await expect(repository.createVenueInterest(interestInput({
      id: "deletion-locked",
      userId: "deletion-locked",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));

    const interest = await repository.createVenueInterest(interestInput({ userId: "owner-a" }));
    const race = await Promise.allSettled([
      repository.updateVenueInterestWorkflow({
        actorAccountId: "admin-a",
        interestId: interest.id,
        status: "contacted",
        assignedTo: "admin-b",
        resolutionNote: "Contacted.",
        expectedUpdatedAt: interest.updatedAt,
        now: T1,
      }),
      repository.updateVenueInterestWorkflow({
        actorAccountId: "admin-b",
        interestId: interest.id,
        status: "closed",
        assignedTo: null,
        resolutionNote: "Closed.",
        expectedUpdatedAt: interest.updatedAt,
        now: T1,
      }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = race.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(loser?.reason).toSatisfy(expectCode("interest_version_conflict"));
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "ordinary",
      interestId: interest.id,
      status: "partner",
      assignedTo: null,
      resolutionNote: null,
      expectedUpdatedAt: (await repository.getVenueInterestById(interest.id))!.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("admin_not_authorized"));
    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      actorAccountId: "admin-deletion",
      id: "deletion-outreach",
      venueId: "deletion-venue",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));

    await repository.createVenueInterest(interestInput({ id: "interest-b", now: T2 }));
    await repository.createVenueInterest(interestInput({ id: "interest-c", venueId: "venue-c", now: T3 }));
    const firstInterests = await repository.listVenueInterests({ limit: 1 });
    const secondInterests = await repository.listVenueInterests({
      limit: 3,
      cursor: firstInterests.nextCursor,
    });
    expect(firstInterests.interests.map((entry) => entry.id)).toEqual(["interest-c"]);
    expect(secondInterests.interests.map((entry) => entry.id)).toEqual(["interest-b", "interest-a"]);
    expect(await repository.countVenueInterests()).toBe(3);

    const outreach = await repository.upsertVenuePartnerOutreach(outreachInput());
    const updated = await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "ignored-update-id",
      status: "contacted",
      lastContactedAt: T2,
      expectedUpdatedAt: outreach.outreach.updatedAt,
      now: T2,
    }));
    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      status: "partner",
      expectedUpdatedAt: outreach.outreach.updatedAt,
      now: T3,
    }))).rejects.toSatisfy(expectCode("outreach_version_conflict"));
    await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "outreach-b",
      venueId: "venue-b",
      venueName: "Beta Hotel",
      status: "partner",
      now: T3,
    }));
    const page = await repository.listVenuePartnerOutreach({ limit: 1 });
    expect(page.outreach.map((entry) => entry.venueId)).toEqual(["venue-b"]);
    expect((await repository.listVenuePartnerOutreach({ limit: 2, cursor: page.nextCursor })).outreach)
      .toEqual([updated.outreach]);
    expect(await repository.countVenuePartnerOutreach()).toBe(2);
    expect(await repository.countVenuePartnerOutreach({ status: "partner" })).toBe(1);
    await expect(repository.listVenuePartnerOutreachByVenueIds({
      venueIds: ["venue-b", "venue-a", "venue-b", "missing-venue"],
    })).resolves.toEqual([
      expect.objectContaining({ venueId: "venue-a", status: "contacted" }),
      expect.objectContaining({ venueId: "venue-b", status: "partner" }),
    ]);
  });

  it("rolls back forced PostgreSQL workflow and outreach failures", async () => {
    await insertAdmin("admin-a");
    const interest = await repository.createVenueInterest(interestInput({ id: "rollback-interest" }));
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: interest.id,
      status: "contacted",
      assignedTo: null,
      resolutionNote: "Must roll back.",
      expectedUpdatedAt: interest.updatedAt,
      now: T1,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getVenueInterestById(interest.id)).resolves.toEqual(interest);

    const outreach = await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "rollback-outreach",
      venueId: "rollback-venue",
    }));
    const failed = repository.upsertVenuePartnerOutreach(outreachInput({
      id: "ignored-update-id",
      venueId: "rollback-venue",
      status: "contacted",
      expectedUpdatedAt: outreach.outreach.updatedAt,
      now: T1,
    }));
    await expect(failed).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(failed).rejects.not.toThrow(/forced venue-outreach rollback/i);
    await expect(repository.getVenuePartnerOutreachByVenueId("rollback-venue"))
      .resolves.toEqual(outreach.outreach);
  });
});
