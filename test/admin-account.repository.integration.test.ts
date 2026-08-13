import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import {
  Client,
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AdminAccountRepository,
  AdminAccountRepositoryError,
} from "../src/db/admin-account.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_admin_account_it";
const TEST_LOGIN = "pintpath_admin_account_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const NOW = "2026-08-09T01:00:00.000Z";
const LATER = "2026-08-09T02:00:00.000Z";
const LATEST = "2026-08-09T03:00:00.000Z";
const EXPIRES_AT = "2026-09-09T01:00:00.000Z";

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

/** Transaction-aware adapter only for the explicitly insecure loopback rehearsal. */
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
  private nativeBooleanObserved = false;
  private nativeInt8Observed = false;
  private canonicalTimestampObserved = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
      application_name: "pintpath-admin-account-integration",
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c statement_timeout=30000",
        "-c idle_in_transaction_session_timeout=30000",
        "-c lock_timeout=10000",
      ].join(" "),
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
      for (const row of result.rows) {
        if (Object.values(row).some((value) => typeof value === "boolean")) {
          this.nativeBooleanObserved = true;
        }
        if (Object.hasOwn(row, "trustScore") && typeof row.trustScore === "number") {
          this.nativeInt8Observed = true;
        }
        if (
          Object.hasOwn(row, "updatedAt")
          && typeof row.updatedAt === "string"
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.updatedAt)
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

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `admin_account_nested_${active.nextSavepoint++}`;
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

  nativeResultsObserved(): { boolean: boolean; int8: boolean; timestamp: boolean } {
    return {
      boolean: this.nativeBooleanObserved,
      int8: this.nativeInt8Observed,
      timestamp: this.canonicalTimestampObserved,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("admin account repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: AdminAccountRepository;

  async function seedAccount(input: {
    id: string;
    role?: "user" | "admin" | "venue_manager";
    subscriptionStatus?: "free" | "admin";
    status?: "active" | "warned" | "suspended";
    displayName?: string;
    createdAt?: string;
    updatedAt?: string;
    contributionPoints?: number;
  }): Promise<void> {
    const role = input.role ?? "user";
    const subscriptionStatus = input.subscriptionStatus ?? "free";
    const status = input.status ?? "active";
    const displayName = input.displayName ?? `User ${input.id}`;
    const createdAt = input.createdAt ?? NOW;
    const updatedAt = input.updatedAt ?? NOW;
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.accounts (
         id, public_account_id, email, password_hash, display_name, display_name_key,
         role, subscription_status, status, contribution_points_current_month,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.id,
        `PP-${input.id}`,
        `${input.id}@example.test`,
        `hash-${input.id}`,
        displayName,
        displayName.toLowerCase(),
        role,
        subscriptionStatus,
        status,
        input.contributionPoints ?? 0,
        createdAt,
        updatedAt,
      ],
    );
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.profiles (
         id, public_account_id, email, display_name, display_name_key, role,
         account_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        `PP-${input.id}`,
        `${input.id}@example.test`,
        displayName,
        displayName.toLowerCase(),
        role,
        status,
        createdAt,
        updatedAt,
      ],
    );
  }

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
      throw new Error("The disposable admin-account rehearsal requires a PostgreSQL 17 superuser.");
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
      CREATE EXTENSION pg_trgm WITH SCHEMA public;
      CREATE SCHEMA pintpath_app;
      SET search_path = pintpath_app, pg_catalog;

      CREATE TABLE accounts (
        id text PRIMARY KEY,
        public_account_id text UNIQUE,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        display_name text,
        display_name_key text,
        avatar_url text,
        auth_provider text NOT NULL DEFAULT 'local',
        supabase_user_id text UNIQUE,
        email_verified_at timestamptz,
        mfa_level text NOT NULL DEFAULT 'aal1',
        mfa_verified_at timestamptz,
        provider_tokens_valid_after timestamptz,
        stripe_paid_subscription_status text,
        stripe_event_created_at timestamptz,
        role text NOT NULL DEFAULT 'user',
        age_confirmed_at timestamptz,
        terms_accepted_at timestamptz,
        privacy_accepted_at timestamptz,
        terms_version text,
        privacy_version text,
        age_verification_status text NOT NULL DEFAULT 'not_started',
        is_over_18_verified boolean NOT NULL DEFAULT false,
        subscription_status text NOT NULL DEFAULT 'free',
        stripe_customer_id text,
        premium_until timestamptz,
        trust_score bigint NOT NULL DEFAULT 50,
        contribution_points_current_month numeric NOT NULL DEFAULT 0,
        approved_submission_count bigint NOT NULL DEFAULT 0,
        rejected_submission_count bigint NOT NULL DEFAULT 0,
        fraud_strike_count bigint NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE profiles (
        id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        public_account_id text UNIQUE,
        email text,
        display_name text,
        display_name_key text,
        role text NOT NULL DEFAULT 'user',
        account_status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE auth_sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(id),
        provider_session_id_hash text,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
      CREATE TABLE revoked_provider_sessions (
        user_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_session_id_hash text NOT NULL,
        revoked_at timestamptz NOT NULL,
        reason text NOT NULL,
        PRIMARY KEY (user_id, provider_session_id_hash)
      );
      CREATE TABLE account_discount_passes (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_token_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
        code_hash text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
      CREATE TABLE account_deletion_requests (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status text NOT NULL,
        requested_at timestamptz NOT NULL,
        execute_after timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id, expires_at DESC);
      CREATE INDEX idx_account_discount_passes_user
        ON account_discount_passes (user_id, status, expires_at DESC);
      CREATE INDEX idx_account_deletion_requests_unfinished_user
        ON account_deletion_requests (user_id)
        WHERE status IN ('pending_review', 'approved', 'processing', 'failed');
      CREATE INDEX idx_accounts_admin_search_trgm
        ON accounts USING gin ((
          lower(email || '|' || COALESCE(display_name, '') || '|'
            || COALESCE(public_account_id, '') || '|' || id)
        ) public.gin_trgm_ops);

      ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
      ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
      ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
      ALTER TABLE revoked_provider_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE revoked_provider_sessions FORCE ROW LEVEL SECURITY;
      ALTER TABLE account_discount_passes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE account_discount_passes FORCE ROW LEVEL SECURITY;
      ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;

      CREATE POLICY accounts_runtime_select ON accounts FOR SELECT TO ${TEST_LOGIN}
        USING (id <> 'rls-hidden');
      CREATE POLICY accounts_runtime_update ON accounts FOR UPDATE TO ${TEST_LOGIN}
        USING (id <> 'rls-hidden') WITH CHECK (id <> 'rls-hidden');
      CREATE POLICY profiles_runtime_select ON profiles FOR SELECT TO ${TEST_LOGIN}
        USING (id <> 'rls-hidden');
      CREATE POLICY profiles_runtime_update ON profiles FOR UPDATE TO ${TEST_LOGIN}
        USING (id <> 'rls-hidden') WITH CHECK (id <> 'rls-hidden');
      CREATE POLICY auth_sessions_runtime_select ON auth_sessions FOR SELECT TO ${TEST_LOGIN}
        USING (user_id <> 'rls-hidden');
      CREATE POLICY auth_sessions_runtime_update ON auth_sessions FOR UPDATE TO ${TEST_LOGIN}
        USING (user_id <> 'rls-hidden') WITH CHECK (user_id <> 'rls-hidden');
      CREATE POLICY revoked_provider_sessions_runtime_select ON revoked_provider_sessions
        FOR SELECT TO ${TEST_LOGIN} USING (user_id <> 'rls-hidden');
      CREATE POLICY revoked_provider_sessions_runtime_insert ON revoked_provider_sessions
        FOR INSERT TO ${TEST_LOGIN} WITH CHECK (user_id <> 'rls-hidden');
      CREATE POLICY revoked_provider_sessions_runtime_update ON revoked_provider_sessions
        FOR UPDATE TO ${TEST_LOGIN}
        USING (user_id <> 'rls-hidden') WITH CHECK (user_id <> 'rls-hidden');
      CREATE POLICY account_discount_passes_runtime_select ON account_discount_passes
        FOR SELECT TO ${TEST_LOGIN} USING (user_id <> 'rls-hidden');
      CREATE POLICY account_discount_passes_runtime_update ON account_discount_passes
        FOR UPDATE TO ${TEST_LOGIN}
        USING (user_id <> 'rls-hidden') WITH CHECK (user_id <> 'rls-hidden');
      CREATE POLICY account_deletion_requests_runtime_select ON account_deletion_requests
        FOR SELECT TO ${TEST_LOGIN} USING (user_id <> 'rls-hidden');

      REVOKE ALL ON ALL TABLES IN SCHEMA pintpath_app FROM PUBLIC;
      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT, UPDATE ON accounts, profiles, auth_sessions, account_discount_passes
        TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON revoked_provider_sessions TO ${TEST_LOGIN};
      GRANT SELECT ON account_deletion_requests TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new AdminAccountRepository(database);
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
      throw new Error("Disposable admin-account PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("enforces forced RLS and the exact least-privilege mutation surface", async () => {
    await seedAccount({ id: "rls-admin", role: "admin", subscriptionStatus: "admin" });
    await seedAccount({ id: "rls-hidden", displayName: "Private Needle Account" });
    const privilege = await targetAdmin!.query<{
      is_superuser: boolean;
      bypasses_rls: boolean;
      forced_rls_tables: string;
      accounts_select: boolean;
      accounts_update: boolean;
      accounts_insert: boolean;
      accounts_delete: boolean;
      revocations_insert: boolean;
      deletion_select: boolean;
      deletion_update: boolean;
    }>(
      `SELECT role.rolsuper AS is_superuser,
              role.rolbypassrls AS bypasses_rls,
              (SELECT count(*)::text
                 FROM pg_catalog.pg_class relation
                 JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'pintpath_app'
                  AND relation.relname IN (
                    'accounts', 'profiles', 'auth_sessions', 'revoked_provider_sessions',
                    'account_discount_passes', 'account_deletion_requests'
                  )
                  AND relation.relrowsecurity
                  AND relation.relforcerowsecurity) AS forced_rls_tables,
              has_table_privilege($1, 'pintpath_app.accounts', 'SELECT') AS accounts_select,
              has_table_privilege($1, 'pintpath_app.accounts', 'UPDATE') AS accounts_update,
              has_table_privilege($1, 'pintpath_app.accounts', 'INSERT') AS accounts_insert,
              has_table_privilege($1, 'pintpath_app.accounts', 'DELETE') AS accounts_delete,
              has_table_privilege(
                $1, 'pintpath_app.revoked_provider_sessions', 'INSERT'
              ) AS revocations_insert,
              has_table_privilege(
                $1, 'pintpath_app.account_deletion_requests', 'SELECT'
              ) AS deletion_select,
              has_table_privilege(
                $1, 'pintpath_app.account_deletion_requests', 'UPDATE'
              ) AS deletion_update
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = $1`,
      [TEST_LOGIN],
    );
    expect(privilege.rows[0]).toEqual({
      is_superuser: false,
      bypasses_rls: false,
      forced_rls_tables: "6",
      accounts_select: true,
      accounts_update: true,
      accounts_insert: false,
      accounts_delete: false,
      revocations_insert: true,
      deletion_select: true,
      deletion_update: false,
    });
    await expect(database!.exec(
      `INSERT INTO accounts (id, public_account_id, email, password_hash, created_at, updated_at)
       VALUES ('forbidden', 'PP-forbidden', 'forbidden@example.test', 'hash', now(), now())`,
    )).rejects.toMatchObject({ code: "42501" });
    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "rls-admin",
      query: "private needle",
      limit: 25,
    })).resolves.toEqual([]);
  });

  it("decodes native PostgreSQL types and atomically contains a suspended account", async () => {
    await seedAccount({
      id: "native-admin",
      role: "admin",
      subscriptionStatus: "admin",
    });
    await seedAccount({
      id: "native-target",
      role: "venue_manager",
      subscriptionStatus: "admin",
      contributionPoints: 12.5,
    });
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.auth_sessions (
         token_hash, user_id, provider_session_id_hash, created_at, expires_at
       ) VALUES
         ('native-session-one', 'native-target', 'native-provider-one', $1, $2),
         ('native-session-two', 'native-target', 'native-provider-two', $1, $2)`,
      [NOW, EXPIRES_AT],
    );
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (
         'native-pass', 'native-target', 'native-session-one', 'native-code',
         'active', $1, $2
       )`,
      [NOW, EXPIRES_AT],
    );

    const result = await repository.overrideUserStatus({
      actorAccountId: "native-admin",
      userId: "native-target",
      status: "suspended",
      trustScore: 19,
      fraudStrikeCount: 4,
      expectedUpdatedAt: NOW,
      now: LATER,
    });
    expect(result).toMatchObject({
      account: {
        id: "native-target",
        role: "venue_manager",
        subscriptionStatus: "admin",
        status: "suspended",
        trustScore: 19,
        fraudStrikeCount: 4,
        contributionPointsCurrentMonth: 12.5,
        isOver18Verified: false,
        updatedAt: LATER,
      },
      revokedSessions: 2,
      revokedDiscountPasses: 1,
      revokedProviderSessions: 2,
    });
    expect(database!.nativeResultsObserved()).toEqual({
      boolean: true,
      int8: true,
      timestamp: true,
    });
    const durable = await targetAdmin!.query<{
      status: string;
      profile_status: string;
      revoked_sessions: string;
      revoked_passes: string;
      provider_revocations: string;
    }>(
      `SELECT account.status,
              profile.account_status AS profile_status,
              (SELECT count(*)::text FROM pintpath_app.auth_sessions session
                WHERE session.user_id = account.id AND session.revoked_at = $2) AS revoked_sessions,
              (SELECT count(*)::text FROM pintpath_app.account_discount_passes pass
                WHERE pass.user_id = account.id AND pass.status = 'revoked') AS revoked_passes,
              (SELECT count(*)::text FROM pintpath_app.revoked_provider_sessions revocation
                WHERE revocation.user_id = account.id) AS provider_revocations
         FROM pintpath_app.accounts account
         JOIN pintpath_app.profiles profile ON profile.id = account.id
        WHERE account.id = $1`,
      ["native-target", LATER],
    );
    expect(durable.rows[0]).toEqual({
      status: "suspended",
      profile_status: "suspended",
      revoked_sessions: "2",
      revoked_passes: "1",
      provider_revocations: "2",
    });

    await seedAccount({ id: "deletion-fenced-target" });
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('deletion-fence', 'deletion-fenced-target', 'processing', $1, $2, $1, $1)`,
      [NOW, LATEST],
    );
    await expect(repository.overrideUserStatus({
      actorAccountId: "native-admin",
      userId: "deletion-fenced-target",
      status: "warned",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).rejects.toMatchObject({ code: "account_deletion_locked" });
  });

  it("serializes competing expected revisions so exactly one admin decision commits", async () => {
    await seedAccount({
      id: "concurrent-admin",
      role: "admin",
      subscriptionStatus: "admin",
    });
    await seedAccount({ id: "concurrent-target" });

    const decisions = await Promise.allSettled([
      repository.overrideUserStatus({
        actorAccountId: "concurrent-admin",
        userId: "concurrent-target",
        status: "warned",
        expectedUpdatedAt: NOW,
        now: LATER,
      }),
      repository.overrideUserStatus({
        actorAccountId: "concurrent-admin",
        userId: "concurrent-target",
        status: "suspended",
        expectedUpdatedAt: NOW,
        now: LATEST,
      }),
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    const rejection = decisions.find((decision) => decision.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toBeInstanceOf(AdminAccountRepositoryError);
      expect(rejection.reason).toMatchObject({ code: "write_conflict" });
    }
    const state = await targetAdmin!.query<{
      status: string;
      updated_at: string;
      profile_status: string;
      profile_updated_at: string;
    }>(
      `SELECT account.status,
              to_char(account.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at,
              profile.account_status AS profile_status,
              to_char(profile.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS profile_updated_at
         FROM pintpath_app.accounts account
         JOIN pintpath_app.profiles profile ON profile.id = account.id
        WHERE account.id = 'concurrent-target'`,
    );
    expect(state.rows[0]?.profile_status).toBe(state.rows[0]?.status);
    expect(state.rows[0]?.profile_updated_at).toBe(state.rows[0]?.updated_at);
    expect([LATER, LATEST]).toContain(state.rows[0]?.updated_at);
  });

  it("rolls back every partial containment write and fails closed on native malformed rows", async () => {
    await seedAccount({ id: "rollback-admin", role: "admin", subscriptionStatus: "admin" });
    await seedAccount({ id: "rollback-target" });
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.auth_sessions (
         token_hash, user_id, provider_session_id_hash, created_at, expires_at
       ) VALUES ('rollback-session', 'rollback-target', 'rollback-provider-secret', $1, $2)`,
      [NOW, EXPIRES_AT],
    );
    await targetAdmin!.query(
      `INSERT INTO pintpath_app.account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (
         'rollback-pass', 'rollback-target', 'rollback-session', 'rollback-code',
         'active', $1, $2
       )`,
      [NOW, EXPIRES_AT],
    );
    await targetAdmin!.query(`
      CREATE FUNCTION pintpath_app.reject_admin_session_containment()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'private rollback detail';
      END
      $$;
      CREATE TRIGGER reject_admin_session_containment
      BEFORE UPDATE OF revoked_at ON pintpath_app.auth_sessions
      FOR EACH ROW WHEN (OLD.user_id = 'rollback-target')
      EXECUTE FUNCTION pintpath_app.reject_admin_session_containment();
    `);

    const failure = await repository.overrideUserStatus({
      actorAccountId: "rollback-admin",
      userId: "rollback-target",
      status: "suspended",
      expectedUpdatedAt: NOW,
      now: LATER,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "persistence_failure" });
    expect(String((failure as Error).message)).not.toContain("private rollback detail");
    const rollbackState = await targetAdmin!.query<{
      status: string;
      profile_status: string;
      revoked_at: string | null;
      pass_status: string;
      provider_revocations: string;
    }>(
      `SELECT account.status,
              profile.account_status AS profile_status,
              session.revoked_at::text AS revoked_at,
              pass.status AS pass_status,
              (SELECT count(*)::text FROM pintpath_app.revoked_provider_sessions revocation
                WHERE revocation.user_id = account.id) AS provider_revocations
         FROM pintpath_app.accounts account
         JOIN pintpath_app.profiles profile ON profile.id = account.id
         JOIN pintpath_app.auth_sessions session ON session.user_id = account.id
         JOIN pintpath_app.account_discount_passes pass ON pass.user_id = account.id
        WHERE account.id = 'rollback-target'`,
    );
    expect(rollbackState.rows[0]).toEqual({
      status: "active",
      profile_status: "active",
      revoked_at: null,
      pass_status: "active",
      provider_revocations: "0",
    });
    await targetAdmin!.query(`
      DROP TRIGGER reject_admin_session_containment ON pintpath_app.auth_sessions;
      DROP FUNCTION pintpath_app.reject_admin_session_containment();
      UPDATE pintpath_app.accounts SET trust_score = 101 WHERE id = 'rollback-target';
    `);

    await expect(repository.overrideUserStatus({
      actorAccountId: "rollback-admin",
      userId: "rollback-target",
      status: "warned",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).rejects.toMatchObject({ code: "malformed_record" });
    const malformedRollback = await targetAdmin!.query<{ status: string; updated_at: string }>(
      `SELECT status,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
         FROM pintpath_app.accounts WHERE id = 'rollback-target'`,
    );
    expect(malformedRollback.rows[0]).toEqual({ status: "active", updated_at: NOW });
  });

  it("uses the proposed bounded contains-search index under EXPLAIN ANALYZE", async () => {
    await targetAdmin!.query("ANALYZE pintpath_app.accounts");
    await targetAdmin!.query("SET enable_seqscan = off");
    try {
      const plan = await targetAdmin!.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT id
           FROM pintpath_app.accounts account
          WHERE lower(
                  account.email || '|' || COALESCE(account.display_name, '') || '|'
                  || COALESCE(account.public_account_id, '') || '|' || account.id
                ) LIKE '%native%' ESCAPE '\\'
          LIMIT 25`,
      );
      expect([...collectIndexNames(plan.rows[0]?.["QUERY PLAN"])]).toContain(
        "idx_accounts_admin_search_trgm",
      );
    } finally {
      await targetAdmin!.query("RESET enable_seqscan");
    }
  });
});
