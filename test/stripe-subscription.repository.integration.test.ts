import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  billingCheckoutActorLockKey,
  billingCheckoutConsumerSubjectLockKey,
  billingCheckoutVenueSubjectLockKey,
} from "../src/db/billing-checkout.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import {
  StripeSubscriptionRepository,
  type StripeApplicationEffect,
} from "../src/db/stripe-subscription.repository.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_stripe_subscription_integration_test";
const TEST_LOGIN = "pintpath_stripe_subscription_integration_login";
const NOW = "2026-08-08T04:00:00.000Z";
const EVENT_AT = "2026-08-08T03:59:00.000Z";
const APPLIED_AT = "2026-08-08T04:01:00.000Z";
const PERIOD_END = "2026-09-08T04:00:00.000Z";

function accountCheckoutEffect(
  accountId: string,
  customerId: string,
  subscriptionId: string,
  paidStatus: "premium_monthly" | "premium_yearly" = "premium_monthly",
): StripeApplicationEffect {
  return {
    kind: "checkout_grant",
    expectedTargetKind: "account",
    expectedAccountId: accountId,
    expectedCanonicalVenueId: null,
    billingProfileVenueId: null,
    authorityConfirmed: true,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    providerStatus: "active",
    subscriptionCurrentPeriodEnd: PERIOD_END,
    target: { kind: "account", userId: accountId, paidStatus },
  };
}

function accountStateEffect(input: {
  accountId: string;
  customerId: string;
  subscriptionId: string;
  authorityConfirmed?: boolean;
  grantEligible?: boolean;
}): Extract<StripeApplicationEffect, { kind: "subscription_state" }> {
  return {
    kind: "subscription_state",
    expectedTargetKind: "account",
    expectedAccountId: input.accountId,
    expectedCanonicalVenueId: null,
    billingProfileVenueId: null,
    authorityConfirmed: input.authorityConfirmed ?? true,
    stripeCustomerId: input.customerId,
    stripeSubscriptionId: input.subscriptionId,
    providerStatus: input.grantEligible === false ? "canceled" : "active",
    grantEligible: input.grantEligible ?? true,
    intendedAccountPaidStatus: input.grantEligible === false ? null : "premium_monthly",
    intendedVenuePaidTier: null,
    subscriptionCurrentPeriodEnd: PERIOD_END,
  };
}

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

/** Direct PG adapter restricted to the explicitly insecure loopback rehearsal. */
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
      max: 12,
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
        const savepoint = `stripe_subscription_nested_${active.nextSavepoint++}`;
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

describe.skipIf(!configuredAdminUrl)("real PG17 Stripe subscription repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: StripeSubscriptionRepository;
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
    repository = new StripeSubscriptionRepository(database);
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
      const residue = await admin.query<{ databases: string; roles: string }>(
        `SELECT
           (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = $2) AS roles`,
        [TEST_DATABASE, TEST_LOGIN],
      ).catch(() => ({ rows: [{ databases: "1", roles: "1" }] }));
      if (residue.rows[0]?.databases !== "0" || residue.rows[0]?.roles !== "0") {
        throw new Error("Stripe repository PG rehearsal left database or login residue.");
      }
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves restricted-role claiming, native result decoding, row fencing, and atomic billing state", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES (
         'pg-account', 'pg-account@example.test', 'hash', 'user', 'free', @now, @now
       )`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, suburb, membership_tier, created_at, updated_at
       ) VALUES ('pg-venue', 'PG Venue', 'Carlton', 'basic', @now, @now)`,
    ).run({ now: NOW });

    const claimInput = {
      id: "evt_pg_account",
      eventType: "checkout.session.completed",
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_pg_account", api_key: "must-be-redacted", data: { object: { customer: "cus_pg" } } },
      receivedAt: NOW,
    };
    const claims = await Promise.all([
      repository.claimWebhookEvent(claimInput),
      repository.claimWebhookEvent(claimInput),
    ]);
    expect(claims.filter((claim) => claim.state === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.state === "in_progress")).toHaveLength(1);
    const owned = claims.find((claim) => claim.state === "claimed");
    if (!owned || owned.state !== "claimed") throw new Error("Expected a PG claim owner.");
    expect(await repository.getWebhookEvent("evt_pg_account")).toMatchObject({
      attempts: 1,
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_pg_account", api_key: "[REDACTED]", data: { object: { customer: "cus_pg" } } },
    });

    const accountApplied = await repository.applyClaimedEvent({
      id: "evt_pg_account",
      processingToken: owned.processingToken,
      appliedAt: APPLIED_AT,
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "account",
        expectedAccountId: "pg-account",
        expectedCanonicalVenueId: null,
        billingProfileVenueId: null,
        authorityConfirmed: true,
        stripeCustomerId: "cus_pg",
        stripeSubscriptionId: "sub_pg_account",
        providerStatus: "active",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "account", userId: "pg-account", paidStatus: "premium_yearly" },
      },
    });
    expect(accountApplied).toMatchObject({
      outcome: "account_applied",
      account: {
        subscriptionStatus: "premium_yearly",
        stripePaidSubscriptionStatus: "premium_yearly",
        stripeCustomerId: "cus_pg",
        stripeEventCreatedAt: EVENT_AT,
      },
    });

    const venueToken = await repository.claimWebhookEvent({
      id: "evt_pg_venue",
      eventType: "checkout.session.async_payment_succeeded",
      eventCreatedAt: "2026-08-08T04:10:00.000Z",
      payload: { id: "evt_pg_venue" },
      receivedAt: "2026-08-08T04:10:01.000Z",
    });
    if (venueToken.state !== "claimed") throw new Error("Expected venue event claim.");
    const venueApplied = await repository.applyClaimedEvent({
      id: "evt_pg_venue",
      processingToken: venueToken.processingToken,
      appliedAt: "2026-08-08T04:10:02.000Z",
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "pg-venue",
        billingProfileVenueId: "pg-venue",
        authorityConfirmed: true,
        stripeCustomerId: "cus_pg_venue",
        stripeSubscriptionId: "sub_pg_venue",
        providerStatus: "trialing",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "venue", venueId: "pg-venue", paidTier: "pro" },
      },
    });
    expect(venueApplied).toMatchObject({
      outcome: "venue_applied",
      venue: {
        membershipTier: "pro",
        highlightedName: true,
        promoted: true,
        featuredSpecialEligible: true,
        introTrialEverClaimed: true,
        subscriptionCurrentPeriodEnd: PERIOD_END,
      },
    });

    const nativeRows = await database.prepare(
      `SELECT webhook.attempts AS "attempts", webhook.payload_json AS "payload",
              venue.highlighted_name AS "highlighted"
         FROM stripe_webhook_events webhook
         CROSS JOIN venue_profiles venue
        WHERE webhook.id = 'evt_pg_account' AND venue.venue_id = 'pg-venue'`,
    ).all<{ attempts: string; payload: Record<string, unknown>; highlighted: boolean }>();
    expect(nativeRows).toEqual([expect.objectContaining({
      attempts: "1",
      payload: expect.objectContaining({ api_key: "[REDACTED]" }),
      highlighted: true,
    })]);
    expect(database.metrics()).toMatchObject({ dialect: "postgres", transactionFailures: 0 });
  });

  it("serializes behind deletion and checkout account locks before touching target rows", async () => {
    if (!database || !targetAdmin) throw new Error("Postgres test database was not initialized.");
    for (const accountId of ["pg-deletion-lock", "pg-checkout-lock"]) {
      await database.prepare(
        `INSERT INTO accounts (
           id, email, password_hash, role, subscription_status, created_at, updated_at
         ) VALUES (@id, @email, 'hash', 'user', 'free', @now, @now)`,
      ).run({ id: accountId, email: `${accountId}@example.test`, now: NOW });
    }

    const deletionClaim = await repository.claimWebhookEvent({
      id: "evt_pg_deletion_lock",
      eventType: "checkout.session.completed",
      eventCreatedAt: "2026-08-08T04:20:00.000Z",
      payload: { id: "evt_pg_deletion_lock" },
      receivedAt: "2026-08-08T04:20:01.000Z",
    });
    if (deletionClaim.state !== "claimed") throw new Error("Expected deletion-lock event claim.");

    await targetAdmin.query("BEGIN");
    try {
      await targetAdmin.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        billingCheckoutActorLockKey("pg-deletion-lock"),
      ]);
      await targetAdmin.query(
        "SELECT id FROM pintpath_app.accounts WHERE id = $1 FOR UPDATE",
        ["pg-deletion-lock"],
      );
      await targetAdmin.query(
        `INSERT INTO pintpath_app.account_deletion_requests (
           id, user_id, status, requested_at, execute_after, created_at, updated_at
         ) VALUES ($1, $2, 'processing', $3, $3, $3, $3)`,
        ["delete-pg-stripe-lock", "pg-deletion-lock", "2026-08-08T04:20:02.000Z"],
      );
      let settled = false;
      const applying = repository.applyClaimedEvent({
        id: "evt_pg_deletion_lock",
        processingToken: deletionClaim.processingToken,
        appliedAt: "2026-08-08T04:20:03.000Z",
        effect: accountCheckoutEffect("pg-deletion-lock", "cus_pg_deletion", "sub_pg_deletion"),
      });
      void applying.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await targetAdmin.query("COMMIT");
      await expect(applying).resolves.toMatchObject({
        outcome: "deleted_account",
        targetId: "pg-deletion-lock",
      });
    } catch (error) {
      await targetAdmin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const checkoutClaim = await repository.claimWebhookEvent({
      id: "evt_pg_checkout_lock",
      eventType: "checkout.session.completed",
      eventCreatedAt: "2026-08-08T04:21:00.000Z",
      payload: { id: "evt_pg_checkout_lock" },
      receivedAt: "2026-08-08T04:21:01.000Z",
    });
    if (checkoutClaim.state !== "claimed") throw new Error("Expected checkout-lock event claim.");
    await targetAdmin.query("BEGIN");
    try {
      await targetAdmin.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        billingCheckoutConsumerSubjectLockKey("pg-checkout-lock"),
      ]);
      let settled = false;
      const applying = repository.applyClaimedEvent({
        id: "evt_pg_checkout_lock",
        processingToken: checkoutClaim.processingToken,
        appliedAt: "2026-08-08T04:21:02.000Z",
        effect: accountCheckoutEffect("pg-checkout-lock", "cus_pg_checkout_lock", "sub_pg_checkout_lock"),
      });
      void applying.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await targetAdmin.query("COMMIT");
      await expect(applying).resolves.toMatchObject({ outcome: "account_applied" });
    } catch (error) {
      await targetAdmin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("fails closed when a venue alias is re-homed while the shared subject lock is contended", async () => {
    if (!database || !targetAdmin) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO venue_profiles (venue_id, name, membership_tier, created_at, updated_at)
       VALUES ('pg-alias-profile', 'PG Alias Profile', 'basic', @now, @now)`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (
         'pg-alias-profile', 'pg-canonical-old', 'identity:pg-canonical-old',
         'stripe-test', @now, @now
       )`,
    ).run({ now: NOW });
    const claim = await repository.claimWebhookEvent({
      id: "evt_pg_alias_race",
      eventType: "checkout.session.completed",
      eventCreatedAt: "2026-08-08T04:30:00.000Z",
      payload: { id: "evt_pg_alias_race" },
      receivedAt: "2026-08-08T04:30:01.000Z",
    });
    if (claim.state !== "claimed") throw new Error("Expected venue alias event claim.");

    await targetAdmin.query("BEGIN");
    try {
      await targetAdmin.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        billingCheckoutVenueSubjectLockKey("pg-canonical-old"),
      ]);
      await targetAdmin.query(
        `UPDATE pintpath_app.venue_identity_aliases
            SET canonical_venue_id = 'pg-canonical-new',
                identity_key = 'identity:pg-canonical-new', updated_at = $1
          WHERE alias_venue_id = 'pg-alias-profile'`,
        ["2026-08-08T04:30:02.000Z"],
      );
      let settled = false;
      const applying = repository.applyClaimedEvent({
        id: "evt_pg_alias_race",
        processingToken: claim.processingToken,
        appliedAt: "2026-08-08T04:30:03.000Z",
        effect: {
          kind: "checkout_grant",
          expectedTargetKind: "venue",
          expectedAccountId: null,
          expectedCanonicalVenueId: "pg-canonical-old",
          billingProfileVenueId: "pg-alias-profile",
          authorityConfirmed: true,
          stripeCustomerId: "cus_pg_alias_race",
          stripeSubscriptionId: "sub_pg_alias_race",
          providerStatus: "active",
          subscriptionCurrentPeriodEnd: PERIOD_END,
          target: { kind: "venue", venueId: "pg-alias-profile", paidTier: "pro" },
        },
      });
      void applying.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await targetAdmin.query("COMMIT");
      await expect(applying).rejects.toMatchObject({ code: "venue_identity_conflict" });
    } catch (error) {
      await targetAdmin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    expect(await repository.getWebhookEvent("evt_pg_alias_race")).toMatchObject({ status: "processing" });
  });

  it("rejects target-kind collisions and duplicate customer identities under the restricted role", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, stripe_customer_id, created_at, updated_at
       ) VALUES (
         'pg-collision-account', 'pg-collision-account@example.test', 'hash', 'user', 'free',
         'cus_pg_collision', @now, @now
       )`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, membership_tier, stripe_customer_id, stripe_subscription_id, created_at, updated_at
       ) VALUES (
         'pg-collision-venue', 'PG Collision Venue', 'basic', 'cus_pg_collision',
         'sub_pg_collision', @now, @now
       )`,
    ).run({ now: NOW });
    const collisionClaim = await repository.claimWebhookEvent({
      id: "evt_pg_target_collision",
      eventType: "customer.subscription.updated",
      eventCreatedAt: "2026-08-08T04:40:00.000Z",
      payload: { id: "evt_pg_target_collision" },
      receivedAt: "2026-08-08T04:40:01.000Z",
    });
    if (collisionClaim.state !== "claimed") throw new Error("Expected collision event claim.");
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_target_collision",
      processingToken: collisionClaim.processingToken,
      appliedAt: "2026-08-08T04:40:02.000Z",
      effect: {
        kind: "subscription_state",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "pg-collision-venue",
        billingProfileVenueId: "pg-collision-venue",
        authorityConfirmed: true,
        stripeCustomerId: "cus_pg_collision",
        stripeSubscriptionId: "sub_pg_collision",
        providerStatus: "active",
        grantEligible: true,
        intendedAccountPaidStatus: null,
        intendedVenuePaidTier: "pro",
        subscriptionCurrentPeriodEnd: PERIOD_END,
      },
    })).rejects.toMatchObject({ code: "billing_identity_conflict" });

    for (const accountId of ["pg-duplicate-one", "pg-duplicate-two"]) {
      await database.prepare(
        `INSERT INTO accounts (
           id, email, password_hash, role, subscription_status, stripe_customer_id, created_at, updated_at
         ) VALUES (@id, @email, 'hash', 'user', 'free', 'cus_pg_duplicate', @now, @now)`,
      ).run({ id: accountId, email: `${accountId}@example.test`, now: NOW });
    }
    const duplicateClaim = await repository.claimWebhookEvent({
      id: "evt_pg_duplicate_identity",
      eventType: "customer.subscription.updated",
      eventCreatedAt: "2026-08-08T04:41:00.000Z",
      payload: { id: "evt_pg_duplicate_identity" },
      receivedAt: "2026-08-08T04:41:01.000Z",
    });
    if (duplicateClaim.state !== "claimed") throw new Error("Expected duplicate identity event claim.");
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_duplicate_identity",
      processingToken: duplicateClaim.processingToken,
      appliedAt: "2026-08-08T04:41:02.000Z",
      effect: accountStateEffect({
        accountId: "pg-duplicate-one",
        customerId: "cus_pg_duplicate",
        subscriptionId: "sub_pg_duplicate",
      }),
    })).rejects.toMatchObject({ code: "billing_identity_conflict" });
  });

  it("requires equal-time authority and rolls back PostgreSQL mutations before a fenced retry", async () => {
    if (!database || !targetAdmin) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, stripe_customer_id,
         stripe_paid_subscription_status, stripe_event_created_at, created_at, updated_at
       ) VALUES (
         'pg-equal-account', 'pg-equal-account@example.test', 'hash', 'user',
         'premium_monthly', 'cus_pg_equal', 'premium_monthly',
         '2026-08-08T04:50:00.000Z', @now, @now
       )`,
    ).run({ now: NOW });
    const equalClaim = await repository.claimWebhookEvent({
      id: "evt_pg_equal_time",
      eventType: "customer.subscription.deleted",
      eventCreatedAt: "2026-08-08T04:50:00.000Z",
      payload: { id: "evt_pg_equal_time" },
      receivedAt: "2026-08-08T04:50:01.000Z",
    });
    if (equalClaim.state !== "claimed") throw new Error("Expected equal-time event claim.");
    const equalEffect = accountStateEffect({
      accountId: "pg-equal-account",
      customerId: "cus_pg_equal",
      subscriptionId: "sub_pg_equal",
      authorityConfirmed: false,
      grantEligible: false,
    });
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_equal_time",
      processingToken: equalClaim.processingToken,
      appliedAt: "2026-08-08T04:50:02.000Z",
      effect: equalEffect,
    })).rejects.toMatchObject({ code: "authoritative_state_required" });
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_equal_time",
      processingToken: equalClaim.processingToken,
      appliedAt: "2026-08-08T04:50:03.000Z",
      effect: { ...equalEffect, authorityConfirmed: true },
    })).resolves.toMatchObject({ outcome: "account_applied", account: { subscriptionStatus: "free" } });

    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES (
         'pg-rollback-account', 'pg-rollback-account@example.test', 'hash', 'user', 'free', @now, @now
       )`,
    ).run({ now: NOW });
    const rollbackClaim = await repository.claimWebhookEvent({
      id: "evt_pg_rollback",
      eventType: "checkout.session.completed",
      eventCreatedAt: "2026-08-08T04:51:00.000Z",
      payload: { id: "evt_pg_rollback" },
      receivedAt: "2026-08-08T04:51:01.000Z",
    });
    if (rollbackClaim.state !== "claimed") throw new Error("Expected rollback event claim.");
    await targetAdmin.query(
      `CREATE FUNCTION pintpath_app.reject_stripe_audit_test() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic stripe audit failure'; END $$`,
    );
    await targetAdmin.query(
      `CREATE TRIGGER reject_stripe_audit_test
         BEFORE INSERT ON pintpath_app.security_audit_log
         FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_stripe_audit_test()`,
    );
    try {
      await expect(repository.applyClaimedEvent({
        id: "evt_pg_rollback",
        processingToken: rollbackClaim.processingToken,
        appliedAt: "2026-08-08T04:51:02.000Z",
        effect: accountCheckoutEffect("pg-rollback-account", "cus_pg_rollback", "sub_pg_rollback"),
      })).rejects.toMatchObject({ code: "persistence_failure" });
    } finally {
      await targetAdmin.query(
        "DROP TRIGGER IF EXISTS reject_stripe_audit_test ON pintpath_app.security_audit_log",
      );
      await targetAdmin.query("DROP FUNCTION IF EXISTS pintpath_app.reject_stripe_audit_test() ");
    }
    const rolledBack = await database.prepare(
      `SELECT subscription_status AS "subscriptionStatus", stripe_customer_id AS "stripeCustomerId"
         FROM accounts WHERE id = 'pg-rollback-account'`,
    ).get<{ subscriptionStatus: string; stripeCustomerId: string | null }>();
    expect(rolledBack).toEqual({ subscriptionStatus: "free", stripeCustomerId: null });
    expect(await repository.getWebhookEvent("evt_pg_rollback")).toMatchObject({ status: "processing" });
    expect(await repository.markWebhookEventFailed({
      id: "evt_pg_rollback",
      processingToken: rollbackClaim.processingToken,
      failedAt: "2026-08-08T04:51:03.000Z",
      error: "synthetic retry",
    })).toBe(true);
    const retry = await repository.claimWebhookEvent({
      id: "evt_pg_rollback",
      eventType: "checkout.session.completed",
      eventCreatedAt: "2026-08-08T04:51:00.000Z",
      payload: { id: "evt_pg_rollback" },
      receivedAt: "2026-08-08T04:52:00.000Z",
    });
    if (retry.state !== "claimed") throw new Error("Expected rollback retry claim.");
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_rollback",
      processingToken: rollbackClaim.processingToken,
      appliedAt: "2026-08-08T04:52:01.000Z",
      effect: accountCheckoutEffect("pg-rollback-account", "cus_pg_rollback", "sub_pg_rollback"),
    })).rejects.toMatchObject({ code: "event_claim_lost" });
    await expect(repository.applyClaimedEvent({
      id: "evt_pg_rollback",
      processingToken: retry.processingToken,
      appliedAt: "2026-08-08T04:52:02.000Z",
      effect: accountCheckoutEffect("pg-rollback-account", "cus_pg_rollback", "sub_pg_rollback"),
    })).resolves.toMatchObject({ outcome: "account_applied" });

    const role = await admin.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [TEST_LOGIN],
    );
    expect(role.rows).toEqual([{
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
    }]);
  });
});
