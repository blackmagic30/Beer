import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  Client,
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AccountSessionRepository,
  AccountSessionRepositoryError,
} from "../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import { PrivacyRetentionRepository } from "../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import type { BusinessRepository } from "../src/db/business.repository.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { SupportFeedbackRepository } from "../src/db/support-feedback.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { BillingCheckoutRepository } from "../src/db/billing-checkout.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { MissionLifecycleRepository } from "../src/db/mission-lifecycle.repository.js";
import { MissionDiscoveryAutomationRepository } from "../src/db/mission-discovery-automation.repository.js";
import { StripeSubscriptionRepository } from "../src/db/stripe-subscription.repository.js";
import { VenueRequestRepository } from "../src/db/venue-request.repository.js";
import { VenuePartnerRepository } from "../src/db/venue-partner.repository.js";
import { AdminAnalyticsRepository } from "../src/db/admin-analytics.repository.js";
import { VenueManagerInsightsRepository } from "../src/db/venue-manager-insights.repository.js";
import { AdminAccountRepository } from "../src/db/admin-account.repository.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_ACCOUNT_SESSION_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_account_session_integration_test";
const TEST_LOGIN = "pintpath_account_session_integration_login";
const NOW = "2026-08-08T02:00:00.000Z";
const LATER = "2026-08-08T03:00:00.000Z";
const EXPIRES_AT = "2026-09-08T02:00:00.000Z";

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
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
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

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
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

/** Test-only direct-PG adapter for the explicitly insecure loopback rehearsal. */
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
      max: 16,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
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

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `account_session_nested_${active.nextSavepoint++}`;
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

describe.skipIf(!configuredAdminUrl)("real PG17 account/session repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: AccountSessionRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
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
    repository = new AccountSessionRepository(database);
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
      await admin.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves identity locking, session overlap, native mappings, containment, and rollback", async () => {
    const secretEmail = "pg-race-secret@example.test";
    const create = (id: string, email = `${id}@example.test`) => repository.createAccount({
      id,
      email,
      passwordHash: `password-${id}`,
      displayName: `PG ${id}`,
      displayNameKey: `pg ${id}`,
      role: "user",
      subscriptionStatus: "free",
      now: NOW,
    });

    const identityRace = await Promise.allSettled([
      create("pg-race-one", secretEmail),
      create("pg-race-two", secretEmail.toUpperCase()),
    ]);
    expect(identityRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const identityFailure = identityRace.find((result) => result.status === "rejected");
    if (identityFailure?.status !== "rejected") throw new Error("Expected one identity conflict.");
    expect(identityFailure.reason).toBeInstanceOf(AccountSessionRepositoryError);
    expect(identityFailure.reason).toMatchObject({ code: "account_identity_conflict" });
    expect(String(identityFailure.reason.message)).not.toContain(secretEmail);

    const account = await create("pg-session-user");
    const linkPeer = await create("pg-link-peer");
    const providerIdentity = "pg-provider-identity-secret";
    const linkRace = await Promise.allSettled([
      repository.linkSupabaseAccount({
        userId: account.id,
        supabaseUserId: providerIdentity,
        email: account.email,
        authProvider: "supabase",
        displayName: account.displayName,
        displayNameKey: account.displayNameKey,
        avatarUrl: null,
        emailVerifiedAt: NOW,
        mfaLevel: "aal2",
        mfaVerifiedAt: NOW,
        now: NOW,
      }),
      repository.linkSupabaseAccount({
        userId: linkPeer.id,
        supabaseUserId: providerIdentity,
        email: linkPeer.email,
        authProvider: "supabase",
        displayName: linkPeer.displayName,
        displayNameKey: linkPeer.displayNameKey,
        avatarUrl: null,
        emailVerifiedAt: NOW,
        mfaLevel: "aal2",
        mfaVerifiedAt: NOW,
        now: NOW,
      }),
    ]);
    expect(linkRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const linkedAccount = await repository.getAccountBySupabaseUserId(providerIdentity);
    expect(linkedAccount).not.toBeNull();
    expect(linkedAccount?.isOver18Verified).toBe(false);
    expect(typeof linkedAccount?.trustScore).toBe("number");

    const activeAccount = linkedAccount!;
    const overlappingTokens = Array.from({ length: 16 }, (_, index) => token(`pg-overlap-${index}`));
    await Promise.all(overlappingTokens.map((tokenHash, index) => repository.createSessionWithLimit({
      tokenHash,
      userId: activeAccount.id,
      createdAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
      expiresAt: EXPIRES_AT,
      providerSessionIdHash: `pg-provider-session-${index}`,
      maxActiveSessions: 4,
    })));
    expect(await repository.countUserSessions(activeAccount.id, NOW)).toBe(4);
    expect(await repository.countUserSessionHistory(activeAccount.id, NOW)).toBe(12);
    const current = await repository.listUserSessions({ userId: activeAccount.id, now: NOW });
    expect(current).toHaveLength(4);
    const currentToken = overlappingTokens.find((candidate) => candidate.startsWith(current[0]!.id));
    expect(currentToken).toBeTruthy();
    expect(await repository.getAccountBySessionTokenHash(currentToken!, NOW)).toMatchObject({
      id: activeAccount.id,
    });
    expect(await repository.touchSession({
      tokenHash: currentToken!,
      lastUsedAt: LATER,
      lastIpHash: "pg-ip-hash",
      userAgentHash: "pg-agent-hash",
    })).toBe(true);

    const resetProvider = current[0]!.providerBacked
      ? `pg-provider-session-${overlappingTokens.indexOf(currentToken!)}`
      : "pg-reset-provider";
    await expect(repository.completePasswordResetContainment({
      userId: activeAccount.id,
      providerSessionIdHash: resetProvider,
      providerTokensValidAfter: LATER,
      revokedAt: LATER,
    })).resolves.toMatchObject({ revokedSessions: 4 });
    expect(await repository.getAccountBySessionTokenHash(currentToken!, LATER)).toBeNull();
    await expect(repository.createSession({
      tokenHash: token("pg-revoked-provider-reuse"),
      userId: activeAccount.id,
      providerSessionIdHash: resetProvider,
      createdAt: LATER,
      expiresAt: EXPIRES_AT,
    })).rejects.toMatchObject({ code: "provider_session_revoked" });

    const rollbackAccount = await create("pg-rollback-user");
    await targetAdmin!.query(`CREATE FUNCTION pintpath_app.reject_profile_update()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'profile invariant rejected'; END $$`);
    await targetAdmin!.query(`CREATE TRIGGER reject_profile_update
      BEFORE UPDATE OF display_name ON pintpath_app.profiles
      FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_profile_update()`);
    await expect(repository.updateAccountDisplayName({
      userId: rollbackAccount.id,
      displayName: "Must Roll Back",
      displayNameKey: "must roll back pg",
      now: LATER,
    })).rejects.toThrow("profile invariant rejected");
    expect(await repository.getAccountById(rollbackAccount.id)).toMatchObject({
      displayName: rollbackAccount.displayName,
      displayNameKey: rollbackAccount.displayNameKey,
      updatedAt: NOW,
    });
    await targetAdmin!.query("DROP TRIGGER reject_profile_update ON pintpath_app.profiles");
    await targetAdmin!.query("DROP FUNCTION pintpath_app.reject_profile_update()");
  }, 30_000);

  it("maps an overlapping service display-name race to a stable secret-free conflict", async () => {
    const first = await repository.createAccount({
      id: "pg-service-race-one",
      email: "pg-service-race-one@example.test",
      passwordHash: "password-one",
      displayName: "PG Service One",
      displayNameKey: "pg service one",
      role: "user",
      subscriptionStatus: "free",
      now: NOW,
    });
    const second = await repository.createAccount({
      id: "pg-service-race-two",
      email: "pg-service-race-two@example.test",
      passwordHash: "password-two",
      displayName: "PG Service Two",
      displayNameKey: "pg service two",
      role: "user",
      subscriptionStatus: "free",
      now: NOW,
    });
    const legacyRepository = {
      getProfileById: () => null,
    } as unknown as BusinessRepository;
    const service = new BusinessService(
      legacyRepository,
      {
        NODE_ENV: "test",
        COMMERCIAL_LAUNCH_ENABLED: false,
        SUPABASE_URL: undefined,
        SUPABASE_ANON_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      } as unknown as ConstructorParameters<typeof BusinessService>[1],
      new PublicVenueDirectoryRepository(database!),
      new PublicPriceRepository(database!),
      new SystemStateRepository(database!),
      new ActivityAuditRepository(database!),
      new SupportFeedbackRepository(database!),
      repository,
      new AccountProfilePreferencesRepository(database!),
      new VenueInventoryRepository(database!),
      new VenueIdentityRepository(database!),
      new BillingCheckoutRepository(database!),
      new VenueAccessRepository(database!),
      new MissionLifecycleRepository(database!),
      new MissionDiscoveryAutomationRepository(database!),
      new StripeSubscriptionRepository(database!),
      new VenueRequestRepository(database!),
      new VenuePartnerRepository(database!),
      new AdminAnalyticsRepository(database!),
      new VenueManagerInsightsRepository(database!),
      new AdminAccountRepository(database!),
      new AccountDeletionQueueRepository(database!),
      new AccountPrivacyRepository(database!),
      new PrivacyRetentionRepository(database!),
      new CommunitySubmissionRepository(database!),
      new VenueManagerInternalSubmissionRepository(database!),
      new SourceEvidenceObjectRepository(database!),
      new SourceEvidenceRetentionRepository(database!),
      new VenuePendingChangeRepository(database!),
      new VenueDataReadRepository(database!),
      async () => true,
    );
    const confidentialCandidate = "PG Shared Race Name";
    const race = await Promise.allSettled([
      service.updateDisplayName(first, { displayName: confidentialCandidate }),
      service.updateDisplayName(second, { displayName: confidentialCandidate }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = race.find((result) => result.status === "rejected");
    if (failure?.status !== "rejected") throw new Error("Expected one service display-name conflict.");
    expect(failure.reason).toMatchObject({
      statusCode: 409,
      message: "That display name is already taken. Choose another leaderboard name.",
    });
    expect(failure.reason).not.toBeInstanceOf(AccountSessionRepositoryError);
    expect(JSON.stringify(failure.reason)).not.toContain(confidentialCandidate);
  }, 30_000);
});
