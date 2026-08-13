import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_ACCOUNT_PROFILE_PREFERENCES_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const resourceSuffix = crypto.randomBytes(6).toString("hex");
const TEST_DATABASE = `pintpath_profile_${resourceSuffix}`;
const TEST_LOGIN = `pintpath_profile_login_${resourceSuffix}`;
const T0 = "2026-08-08T02:00:00.000Z";
const T1 = "2026-08-08T02:01:00.000Z";
const T2 = "2026-08-08T02:02:00.000Z";

function validateAdminUrl(value: string): URL {
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

/** Direct PG adapter restricted to a unique disposable loopback database. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c statement_timeout=30000",
        "-c idle_in_transaction_session_timeout=30000",
        "-c lock_timeout=10000",
      ].join(" "),
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
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

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `profile_nested_${active.nextSavepoint++}`;
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

function successfulResult<T>(results: PromiseSettledResult<T>[]): T {
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<T> => result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: "write_conflict" });
  return fulfilled[0]!.value;
}

describe.skipIf(!configuredAdminUrl)("real PG17 account profile/preferences repository", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: AccountProfilePreferencesRepository;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    const version = await targetAdmin.query<{ server_version_num: string }>("SHOW server_version_num");
    if (Math.floor(Number(version.rows[0]?.server_version_num) / 10_000) !== 17) {
      throw new Error("Account profile/preferences integration tests require PostgreSQL 17.");
    }
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new AccountProfilePreferencesRepository(database);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      const leftovers = await admin.query<{ database_exists: boolean; role_exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS role_exists`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      await admin.end().catch(() => undefined);
      if (leftovers.rows[0]?.database_exists || leftovers.rows[0]?.role_exists) {
        throw new Error("Disposable account profile/preferences integration resources were not removed.");
      }
    }
  }, 30_000);

  async function insertAccount(id: string): Promise<void> {
    await database!.prepare(
      `INSERT INTO accounts (
         id, public_account_id, email, password_hash, role, subscription_status,
         status, created_at, updated_at
       ) VALUES (@id, @publicId, @email, 'hash', 'user', 'free', 'active', @now, @now)`,
    ).run({ id, publicId: `PP-${id}`, email: `${id}@example.test`, now: T0 });
  }

  it("preserves native booleans/jsonb/timestamptz and deterministic profile, preference, save, and search semantics", async () => {
    expect(await database!.prepare(
      `SELECT role.rolsuper, role.rolbypassrls
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get()).toEqual({ rolsuper: false, rolbypassrls: false });
    const userId = "pg-profile-user";
    await insertAccount(userId);
    const profile = await repository.upsertProfile({
      id: userId,
      publicAccountId: `PP-${userId}`,
      email: `${userId}@example.test`,
      displayName: "PG Profile",
      displayNameKey: "pg-profile",
      username: "pg_username",
      avatarUrl: null,
      role: "user",
      accountStatus: "active",
      ageVerificationStatus: "verified",
      isOver18Verified: true,
      now: T0,
    });
    expect(profile).toMatchObject({
      isOver18Verified: true,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await database!.prepare(
      "SELECT is_over_18_verified, created_at FROM profiles WHERE id = @userId",
    ).get({ userId })).toEqual({ is_over_18_verified: true, created_at: T0 });

    const preferences = await repository.upsertAccountPreferences({
      userId,
      preferredSuburbs: ["Fitzroy"],
      preferredBeers: ["Lager"],
      preferredUseCases: ["recently_verified"],
      onboardingCompletedAt: T0,
      now: T0,
      expectedUpdatedAt: null,
    });
    expect(preferences).toMatchObject({
      preferredSuburbs: ["Fitzroy"],
      preferredBeers: ["Lager"],
      preferredUseCases: ["recently_verified"],
      onboardingCompletedAt: T0,
    });
    expect(await database!.prepare(
      "SELECT preferred_suburbs_json, onboarding_completed_at FROM account_preferences WHERE user_id = @userId",
    ).get({ userId })).toEqual({
      preferred_suburbs_json: '["Fitzroy"]',
      onboarding_completed_at: T0,
    });

    const saves = await Promise.all([
      repository.saveItem({
        id: "pg-save-one",
        userId,
        itemType: "venue",
        itemId: "venue-pg",
        label: "PG Venue",
        suburb: "Fitzroy",
        metadata: { apiKey: "DO-NOT-STORE", source: "pg" },
        now: T0,
      }),
      repository.saveItem({
        id: "pg-save-two",
        userId,
        itemType: "venue",
        itemId: "venue-pg",
        label: "PG Venue",
        suburb: "Fitzroy",
        metadata: { apiKey: "DO-NOT-STORE", source: "pg" },
        now: T1,
      }),
    ]);
    expect(saves[0]!.id).toBe(saves[1]!.id);
    expect(saves[0]!.metadata).toEqual({ apiKey: "[REDACTED]", source: "pg" });
    expect((await repository.listSavedItems(userId))).toEqual([saves[1]]);
    expect(await database!.prepare(
      "SELECT metadata_json, created_at FROM saved_items WHERE user_id = @userId",
    ).get({ userId })).toEqual({
      metadata_json: '{"apiKey":"[REDACTED]","source":"pg"}',
      created_at: saves[0]!.createdAt,
    });

    await database!.prepare(
      `INSERT INTO events (id, user_id, event_type, suburb, metadata_json, created_at)
       VALUES ('pg-search-a', @userId, 'search_performed', NULL, @query, @createdAt),
              ('pg-search-z', @userId, 'beer_search_performed', NULL, @label, @createdAt)`,
    ).run({
      userId,
      query: '{"query":"Query A"}',
      label: '{"label":"Beer Z"}',
      createdAt: T2,
    });
    expect(await repository.listRecentSearches(userId, -1)).toEqual([
      { eventType: "beer_search_performed", label: "Beer Z", suburb: null, createdAt: T2 },
      { eventType: "search_performed", label: "Query A", suburb: null, createdAt: T2 },
    ]);
    expect(await repository.getDefaultAccountPrivacySettings(userId, T0)).toMatchObject({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      consentVersion: "2026-08-03",
    });
  });

  it("fences concurrent privacy updates, atomically purges scopes, and rolls back on purge failure", async () => {
    const userId = "pg-privacy-user";
    await insertAccount(userId);
    await repository.upsertAccountPrivacySettings({
      userId,
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: "2026-08-03",
      now: T0,
      expectedUpdatedAt: null,
    });
    await database!.prepare(
      `INSERT INTO events (id, user_id, event_type, metadata_json, created_at)
       VALUES ('pg-optional', @userId, 'search_performed', @optional, @now),
              ('pg-venue', @userId, 'search_performed', @venue, @now),
              ('pg-essential', @userId, 'search_performed', @essential, @now)`,
    ).run({
      userId,
      optional: '{"privacyScope":"optional_analytics"}',
      venue: '{"privacyScope":"venue_insight"}',
      essential: '{"privacyScope":"essential"}',
      now: T0,
    });
    const base = {
      userId,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: "2026-08-03",
      expectedUpdatedAt: T0,
    } as const;
    const results = await Promise.allSettled([
      repository.upsertAccountPrivacySettings({ ...base, productResearchEnabled: false, now: T1 }),
      repository.upsertAccountPrivacySettings({ ...base, productResearchEnabled: true, now: T2 }),
    ]);
    const winner = successfulResult(results);
    expect(await repository.getAccountPrivacySettings(userId)).toEqual(winner);
    expect(await database!.prepare(
      "SELECT id FROM events WHERE user_id = @userId ORDER BY id",
    ).all({ userId })).toEqual([{ id: "pg-essential" }]);
    expect(await database!.prepare(
      `SELECT optional_analytics_enabled, venue_report_inclusion_enabled,
              product_research_enabled, consented_at, updated_at
         FROM account_privacy_settings WHERE user_id = @userId`,
    ).get({ userId })).toEqual({
      optional_analytics_enabled: false,
      venue_report_inclusion_enabled: false,
      product_research_enabled: winner.productResearchEnabled,
      consented_at: winner.updatedAt,
      updated_at: winner.updatedAt,
    });

    const rollbackUser = "pg-profile-rollback";
    await insertAccount(rollbackUser);
    await repository.upsertAccountPrivacySettings({
      userId: rollbackUser,
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: "2026-08-03",
      now: T0,
      expectedUpdatedAt: null,
    });
    await database!.prepare(
      `INSERT INTO events (id, user_id, event_type, metadata_json, created_at)
       VALUES ('pg-rollback-event', @userId, 'search_performed', @metadata, @now)`,
    ).run({
      userId: rollbackUser,
      metadata: '{"privacyScope":"optional_analytics"}',
      now: T0,
    });
    await targetAdmin!.query(
      `CREATE FUNCTION pintpath_app.fail_profile_privacy_purge() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.user_id = 'pg-profile-rollback' THEN
           RAISE EXCEPTION 'DO-NOT-LEAK-PG-ROLLBACK-SENTINEL';
         END IF;
         RETURN OLD;
       END
       $$;
       CREATE TRIGGER fail_profile_privacy_purge
       BEFORE DELETE ON pintpath_app.events
       FOR EACH ROW EXECUTE FUNCTION pintpath_app.fail_profile_privacy_purge();`,
    );
    await expect(repository.upsertAccountPrivacySettings({
      userId: rollbackUser,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: "2026-08-03",
      now: T1,
      expectedUpdatedAt: T0,
    })).rejects.toMatchObject({
      code: "persistence_failed",
      message: "The account profile or preference change could not be persisted.",
    });
    expect(await repository.getAccountPrivacySettings(rollbackUser)).toMatchObject({
      optionalAnalyticsEnabled: true,
      updatedAt: T0,
    });
    expect(await database!.prepare(
      "SELECT id FROM events WHERE id = 'pg-rollback-event'",
    ).get()).toEqual({ id: "pg-rollback-event" });
    expect(database!.metrics().transactionFailures).toBeGreaterThanOrEqual(2);
  });
});
