import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  STRIPE_SUBSCRIPTION_LOCK_CONTRACT,
  StripeSubscriptionRepository,
  StripeSubscriptionRepositoryError,
  type StripeApplicationEffect,
} from "../src/db/stripe-subscription.repository.js";

const RECEIVED_AT = "2026-08-08T02:00:00.000Z";
const EVENT_AT = "2026-08-08T01:59:00.000Z";
const SAME_EVENT_AT = "2026-08-08T02:10:00.000Z";
const APPLIED_AT = "2026-08-08T02:01:00.000Z";
const RETRY_AT = "2026-08-08T02:02:00.000Z";
const PERIOD_END = "2026-09-08T02:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: StripeSubscriptionRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new StripeSubscriptionRepository(database) };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: {
    stripeCustomerId?: string | null;
    subscriptionStatus?: string;
    paidStatus?: string | null;
    eventCreatedAt?: string | null;
    authProvider?: string;
  } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       stripe_customer_id, stripe_paid_subscription_status, stripe_event_created_at,
       created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, 'user', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.test`,
    options.authProvider ?? "local",
    options.subscriptionStatus ?? "free",
    options.stripeCustomerId ?? null,
    options.paidStatus ?? null,
    options.eventCreatedAt ?? null,
    RECEIVED_AT,
    RECEIVED_AT,
  );
}

function insertVenue(
  raw: BetterSqlite3.Database,
  id: string,
  options: {
    subscriptionId?: string | null;
    customerId?: string | null;
    membershipTier?: string;
    paidTier?: string | null;
    eventCreatedAt?: string | null;
    manualOverride?: boolean;
    suburb?: string | null;
  } = {},
): void {
  raw.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, suburb, membership_tier, stripe_paid_membership_tier,
       stripe_customer_id, stripe_subscription_id, stripe_event_created_at,
       tier_manual_override, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `Venue ${id}`,
    options.suburb ?? "Fitzroy",
    options.membershipTier ?? "basic",
    options.paidTier ?? null,
    options.customerId ?? null,
    options.subscriptionId ?? null,
    options.eventCreatedAt ?? null,
    options.manualOverride ? 1 : 0,
    RECEIVED_AT,
    RECEIVED_AT,
  );
}

function insertVenueAlias(
  raw: BetterSqlite3.Database,
  aliasVenueId: string,
  canonicalVenueId: string,
): void {
  raw.prepare(
    `INSERT INTO venue_identity_aliases (
       alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
     ) VALUES (?, ?, ?, 'stripe-test', ?, ?)`,
  ).run(aliasVenueId, canonicalVenueId, `identity:${canonicalVenueId}`, RECEIVED_AT, RECEIVED_AT);
}

async function claim(
  repository: StripeSubscriptionRepository,
  id: string,
  eventType: string,
  eventCreatedAt: string | null = EVENT_AT,
  receivedAt = RECEIVED_AT,
): Promise<string> {
  const result = await repository.claimWebhookEvent({
    id,
    eventType,
    eventCreatedAt,
    payload: {
      id,
      type: eventType,
      data: { object: { customer: "cus_test", client_secret: "must-not-persist" } },
    },
    receivedAt,
  });
  if (result.state !== "claimed") throw new Error(`Expected ${id} to be claimed.`);
  return result.processingToken;
}

function accountCheckout(userId: string, customerId = "cus_account"): StripeApplicationEffect {
  return {
    kind: "checkout_grant",
    expectedTargetKind: "account",
    expectedAccountId: userId,
    expectedCanonicalVenueId: null,
    billingProfileVenueId: null,
    authorityConfirmed: true,
    stripeCustomerId: customerId,
    stripeSubscriptionId: "sub_account",
    providerStatus: "active",
    subscriptionCurrentPeriodEnd: PERIOD_END,
    target: { kind: "account", userId, paidStatus: "premium_monthly" },
  };
}

function accountState(
  customerId: string,
  expectedAccountId: string | null,
  overrides: Partial<Extract<StripeApplicationEffect, { kind: "subscription_state" }>> = {},
): Extract<StripeApplicationEffect, { kind: "subscription_state" }> {
  return {
    kind: "subscription_state",
    expectedTargetKind: expectedAccountId === null ? "none" : "account",
    expectedAccountId,
    expectedCanonicalVenueId: null,
    billingProfileVenueId: null,
    authorityConfirmed: false,
    stripeCustomerId: customerId,
    stripeSubscriptionId: "sub_account",
    providerStatus: "active",
    grantEligible: true,
    intendedAccountPaidStatus: "premium_monthly",
    intendedVenuePaidTier: null,
    subscriptionCurrentPeriodEnd: PERIOD_END,
    ...overrides,
  };
}

describe("StripeSubscriptionRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("publishes an immutable versioned cross-repository lock contract", () => {
    expect(Object.isFrozen(STRIPE_SUBSCRIPTION_LOCK_CONTRACT)).toBe(true);
    expect(STRIPE_SUBSCRIPTION_LOCK_CONTRACT).toMatchObject({
      version: 1,
      billingCheckoutVersion: 1,
      eventPrefix: "stripe-subscription:v1:event:",
    });
    expect(STRIPE_SUBSCRIPTION_LOCK_CONTRACT.order).toContain("sorted-advisory-union");
    expect(STRIPE_SUBSCRIPTION_LOCK_CONTRACT.order).toContain("before-webhook-row");
  });

  it("claims one owner, redacts JSON, and makes applied duplicates idempotent", async () => {
    const { raw, repository } = fixture();
    const first = repository.claimWebhookEvent({
      id: "evt_duplicate",
      eventType: "checkout.session.completed",
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_duplicate", client_secret: "sk_secret", nested: { password: "hidden" } },
      receivedAt: RECEIVED_AT,
    });
    const second = repository.claimWebhookEvent({
      id: "evt_duplicate",
      eventType: "checkout.session.completed",
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_duplicate", client_secret: "sk_secret", nested: { password: "hidden" } },
      receivedAt: RECEIVED_AT,
    });
    const claims = await Promise.all([first, second]);
    expect(claims.filter((entry) => entry.state === "claimed")).toHaveLength(1);
    expect(claims.filter((entry) => entry.state === "in_progress")).toHaveLength(1);
    const owned = claims.find((entry) => entry.state === "claimed");
    if (!owned || owned.state !== "claimed") throw new Error("Expected one claim owner.");

    const stored = await repository.getWebhookEvent("evt_duplicate");
    expect(stored).toMatchObject({ status: "processing", attempts: 1, eventCreatedAt: EVENT_AT });
    expect(stored?.payload).toEqual({
      id: "evt_duplicate",
      client_secret: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });

    await expect(repository.applyClaimedEvent({
      id: "evt_duplicate",
      processingToken: owned.processingToken,
      appliedAt: APPLIED_AT,
      effect: { kind: "acknowledge", reason: "unsupported_or_noop" },
    })).resolves.toMatchObject({ outcome: "acknowledged" });
    await expect(repository.applyClaimedEvent({
      id: "evt_duplicate",
      processingToken: owned.processingToken,
      appliedAt: APPLIED_AT,
      effect: { kind: "acknowledge", reason: "unsupported_or_noop" },
    })).resolves.toMatchObject({ outcome: "already_applied" });
    await expect(repository.claimWebhookEvent({
      id: "evt_duplicate",
      eventType: "checkout.session.completed",
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_duplicate" },
      receivedAt: RETRY_AT,
    })).resolves.toEqual({ state: "applied", processingToken: null, attempts: 1 });
    expect(raw.prepare("SELECT count(*) AS count FROM stripe_webhook_events").get()).toEqual({ count: 1 });
  });

  it("commits account access, billing, analytics, audit, and event finalization together", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "checkout-account");
    const processingToken = await claim(
      repository,
      "evt_account_checkout",
      "checkout.session.completed",
    );

    const applied = await repository.applyClaimedEvent({
      id: "evt_account_checkout",
      processingToken,
      appliedAt: APPLIED_AT,
      effect: accountCheckout("checkout-account"),
    });
    expect(applied).toMatchObject({
      outcome: "account_applied",
      targetType: "account",
      targetId: "checkout-account",
      account: {
        subscriptionStatus: "premium_monthly",
        stripePaidSubscriptionStatus: "premium_monthly",
        stripeCustomerId: "cus_account",
        stripeEventCreatedAt: EVENT_AT,
        premiumUntil: null,
      },
    });
    expect(await repository.getWebhookEvent("evt_account_checkout")).toMatchObject({
      status: "applied",
      appliedAt: APPLIED_AT,
      processingToken: null,
    });
    expect(raw.prepare(
      "SELECT event_type AS eventType, user_id AS userId FROM events WHERE user_id = ?",
    ).get("checkout-account")).toEqual({ eventType: "subscription_created", userId: "checkout-account" });
    expect(raw.prepare(
      "SELECT action, actor_user_id AS actorUserId, target_id AS targetId FROM security_audit_log",
    ).get()).toEqual({
      action: "stripe_subscription_update",
      actorUserId: "checkout-account",
      targetId: "checkout-account",
    });
  });

  it("fences stale and same-timestamp reordered events until Stripe authority is confirmed", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "ordered-account", {
      stripeCustomerId: "cus_ordered",
      subscriptionStatus: "premium_monthly",
      paidStatus: "premium_monthly",
      eventCreatedAt: SAME_EVENT_AT,
    });

    const oldToken = await claim(
      repository,
      "evt_old",
      "customer.subscription.deleted",
      "2026-08-08T02:09:59.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_old",
      processingToken: oldToken,
      appliedAt: APPLIED_AT,
      effect: accountState("cus_ordered", "ordered-account", {
        providerStatus: "canceled",
        grantEligible: false,
        intendedAccountPaidStatus: null,
      }),
    })).resolves.toMatchObject({ outcome: "stale" });
    expect(raw.prepare("SELECT subscription_status FROM accounts WHERE id = ?").get("ordered-account"))
      .toEqual({ subscription_status: "premium_monthly" });

    const equalToken = await claim(
      repository,
      "evt_equal",
      "customer.subscription.deleted",
      SAME_EVENT_AT,
      "2026-08-08T02:11:00.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_equal",
      processingToken: equalToken,
      appliedAt: "2026-08-08T02:11:01.000Z",
      effect: accountState("cus_ordered", "ordered-account", {
        providerStatus: "canceled",
        grantEligible: false,
        intendedAccountPaidStatus: null,
        authorityConfirmed: false,
      }),
    })).rejects.toMatchObject({ code: "authoritative_state_required" });
    expect(await repository.getWebhookEvent("evt_equal")).toMatchObject({ status: "processing" });

    await expect(repository.applyClaimedEvent({
      id: "evt_equal",
      processingToken: equalToken,
      appliedAt: "2026-08-08T02:11:02.000Z",
      effect: accountState("cus_ordered", "ordered-account", {
        providerStatus: "canceled",
        grantEligible: false,
        intendedAccountPaidStatus: null,
        authorityConfirmed: true,
      }),
    })).resolves.toMatchObject({
      outcome: "account_applied",
      account: { subscriptionStatus: "free", stripePaidSubscriptionStatus: "premium_monthly" },
    });
  });

  it("serializes concurrent events for one customer and requires authority on the equal-time loser", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "race-account", { stripeCustomerId: "cus_race" });
    const firstToken = await claim(
      repository,
      "evt_race_one",
      "customer.subscription.updated",
      SAME_EVENT_AT,
    );
    const secondToken = await claim(
      repository,
      "evt_race_two",
      "customer.subscription.updated",
      SAME_EVENT_AT,
      "2026-08-08T02:00:01.000Z",
    );

    const results = await Promise.allSettled([
      repository.applyClaimedEvent({
        id: "evt_race_one",
        processingToken: firstToken,
        appliedAt: "2026-08-08T02:12:00.000Z",
        effect: accountState("cus_race", "race-account", { intendedAccountPaidStatus: "premium_monthly" }),
      }),
      repository.applyClaimedEvent({
        id: "evt_race_two",
        processingToken: secondToken,
        appliedAt: "2026-08-08T02:12:01.000Z",
        effect: accountState("cus_race", "race-account", { intendedAccountPaidStatus: "premium_yearly" }),
      }),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === "rejected");
    if (!rejected || rejected.status !== "rejected") throw new Error("Expected authority fencing.");
    expect(rejected.reason).toBeInstanceOf(StripeSubscriptionRepositoryError);
    expect(rejected.reason).toMatchObject({ code: "authoritative_state_required" });
    expect(raw.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT count(*) AS count FROM security_audit_log").get()).toEqual({ count: 1 });
  });

  it("ignores deletion-locked accounts while atomically recording the tombstone audit", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "deleting-account");
    raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('delete-request', 'deleting-account', 'processing', ?, ?, ?, ?)`,
    ).run(RECEIVED_AT, RECEIVED_AT, RECEIVED_AT, RECEIVED_AT);
    const processingToken = await claim(
      repository,
      "evt_deleted_account",
      "checkout.session.completed",
    );

    await expect(repository.applyClaimedEvent({
      id: "evt_deleted_account",
      processingToken,
      appliedAt: APPLIED_AT,
      effect: accountCheckout("deleting-account", "cus_deleting"),
    })).resolves.toMatchObject({ outcome: "deleted_account", targetId: "deleting-account" });
    expect(raw.prepare(
      "SELECT subscription_status, stripe_customer_id FROM accounts WHERE id = ?",
    ).get("deleting-account")).toEqual({ subscription_status: "free", stripe_customer_id: null });
    expect(raw.prepare("SELECT action, target_type AS targetType FROM security_audit_log").get()).toEqual({
      action: "stripe_event_ignored_deleted_account",
      targetType: "account_tombstone",
    });
    expect(await repository.getWebhookEvent("evt_deleted_account")).toMatchObject({ status: "applied" });
  });

  it("rolls back every billing side effect, marks failure, and safely retries", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "retry-account");
    const firstToken = await claim(
      repository,
      "evt_retry",
      "checkout.session.completed",
    );
    raw.exec(`CREATE TRIGGER reject_stripe_audit
      BEFORE INSERT ON security_audit_log
      BEGIN SELECT RAISE(ABORT, 'provider-secret-must-not-escape'); END`);

    await expect(repository.applyClaimedEvent({
      id: "evt_retry",
      processingToken: firstToken,
      appliedAt: APPLIED_AT,
      effect: accountCheckout("retry-account", "cus_retry"),
    })).rejects.toEqual(expect.objectContaining({
      name: "StripeSubscriptionRepositoryError",
      code: "persistence_failure",
      message: "Stripe persistence could not be completed.",
    }));
    expect(raw.prepare(
      "SELECT subscription_status, stripe_customer_id FROM accounts WHERE id = ?",
    ).get("retry-account")).toEqual({ subscription_status: "free", stripe_customer_id: null });
    expect(await repository.getWebhookEvent("evt_retry")).toMatchObject({ status: "processing", attempts: 1 });
    expect(await repository.markWebhookEventFailed({
      id: "evt_retry",
      processingToken: firstToken,
      failedAt: APPLIED_AT,
      // Compose the synthetic secret shape at runtime so repository push
      // protection never has to distinguish a fixture from a real key.
      error: `provider token ${["sk", "live", "123456789012345678901234"].join("_")}`,
    })).toBe(true);
    expect((await repository.getWebhookEvent("evt_retry"))?.lastError).not.toContain("sk_live");

    raw.exec("DROP TRIGGER reject_stripe_audit");
    const retryClaim = await repository.claimWebhookEvent({
      id: "evt_retry",
      eventType: "checkout.session.completed",
      eventCreatedAt: EVENT_AT,
      payload: { id: "evt_retry" },
      receivedAt: RETRY_AT,
    });
    expect(retryClaim).toMatchObject({ state: "claimed", attempts: 2 });
    if (retryClaim.state !== "claimed") throw new Error("Expected failed event to be reclaimed.");
    await expect(repository.markWebhookEventFailed({
      id: "evt_retry",
      processingToken: firstToken,
      failedAt: "2026-08-08T02:02:30.000Z",
      error: "stale worker must not own this retry",
    })).resolves.toBe(false);
    await expect(repository.applyClaimedEvent({
      id: "evt_retry",
      processingToken: firstToken,
      appliedAt: "2026-08-08T02:02:31.000Z",
      effect: accountCheckout("retry-account", "cus_retry"),
    })).rejects.toMatchObject({ code: "event_claim_lost" });
    await expect(repository.applyClaimedEvent({
      id: "evt_retry",
      processingToken: retryClaim.processingToken,
      appliedAt: "2026-08-08T02:03:00.000Z",
      effect: accountCheckout("retry-account", "cus_retry"),
    })).resolves.toMatchObject({ outcome: "account_applied" });
  });

  it("distinguishes a retryable explicit-account miss from an acknowledged unknown customer", async () => {
    const { raw, repository } = fixture();
    const checkoutToken = await claim(
      repository,
      "evt_unknown_account",
      "checkout.session.completed",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_unknown_account",
      processingToken: checkoutToken,
      appliedAt: APPLIED_AT,
      effect: accountCheckout("missing-account", "cus_missing"),
    })).rejects.toMatchObject({ code: "account_not_found" });
    expect(await repository.getWebhookEvent("evt_unknown_account")).toMatchObject({ status: "processing" });

    const stateToken = await claim(
      repository,
      "evt_unknown_customer",
      "customer.subscription.deleted",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_unknown_customer",
      processingToken: stateToken,
      appliedAt: APPLIED_AT,
      effect: accountState("cus_unknown", null, {
        stripeSubscriptionId: "sub_unknown",
        providerStatus: "canceled",
        grantEligible: false,
        intendedAccountPaidStatus: null,
      }),
    })).resolves.toMatchObject({ outcome: "target_not_found", targetType: null });
    expect(await repository.getWebhookEvent("evt_unknown_customer")).toMatchObject({ status: "applied" });
    expect(raw.prepare("SELECT action FROM security_audit_log").get()).toEqual({
      action: "stripe_event_target_not_found",
    });
  });

  it("keeps all venue entitlement flags coherent and honors a manual override", async () => {
    const { raw, repository } = fixture();
    insertVenue(raw, "venue-pro");
    const checkoutToken = await claim(
      repository,
      "evt_venue_checkout",
      "checkout.session.async_payment_succeeded",
    );
    const checkout = await repository.applyClaimedEvent({
      id: "evt_venue_checkout",
      processingToken: checkoutToken,
      appliedAt: APPLIED_AT,
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "venue-pro",
        billingProfileVenueId: "venue-pro",
        authorityConfirmed: true,
        stripeCustomerId: "cus_venue",
        stripeSubscriptionId: "sub_venue",
        providerStatus: "trialing",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "venue", venueId: "venue-pro", paidTier: "pro" },
      },
    });
    expect(checkout).toMatchObject({
      outcome: "venue_applied",
      venue: {
        membershipTier: "pro",
        stripePaidMembershipTier: "pro",
        subscriptionStatus: "trialing",
        highlightedName: true,
        premiumBadge: "Pro",
        promoted: true,
        featuredSpecialEligible: true,
        introTrialEverClaimed: true,
      },
    });

    raw.prepare("UPDATE venue_profiles SET tier_manual_override = 1 WHERE venue_id = ?").run("venue-pro");
    const deletedToken = await claim(
      repository,
      "evt_venue_deleted",
      "customer.subscription.deleted",
      "2026-08-08T02:20:00.000Z",
      "2026-08-08T02:21:00.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_venue_deleted",
      processingToken: deletedToken,
      appliedAt: "2026-08-08T02:21:01.000Z",
      effect: {
        kind: "subscription_state",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "venue-pro",
        billingProfileVenueId: "venue-pro",
        authorityConfirmed: true,
        stripeCustomerId: "cus_venue",
        stripeSubscriptionId: "sub_venue",
        providerStatus: "canceled",
        grantEligible: false,
        intendedAccountPaidStatus: null,
        intendedVenuePaidTier: "pro",
        subscriptionCurrentPeriodEnd: PERIOD_END,
      },
    })).resolves.toMatchObject({ outcome: "manual_override", targetId: "venue-pro" });
    expect(raw.prepare(
      `SELECT membership_tier, highlighted_name, promoted, featured_special_eligible
         FROM venue_profiles WHERE venue_id = ?`,
    ).get("venue-pro")).toEqual({
      membership_tier: "pro",
      highlighted_name: 1,
      promoted: 1,
      featured_special_eligible: 1,
    });
  });

  it("rejects cross-target and duplicate billing identities without finalizing the event", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "collision-account", { stripeCustomerId: "cus_collision" });
    insertVenue(raw, "collision-venue", {
      customerId: "cus_collision",
      subscriptionId: "sub_collision",
    });
    const collisionToken = await claim(
      repository,
      "evt_target_collision",
      "customer.subscription.updated",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_target_collision",
      processingToken: collisionToken,
      appliedAt: APPLIED_AT,
      effect: {
        kind: "subscription_state",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "collision-venue",
        billingProfileVenueId: "collision-venue",
        authorityConfirmed: true,
        stripeCustomerId: "cus_collision",
        stripeSubscriptionId: "sub_collision",
        providerStatus: "active",
        grantEligible: true,
        intendedAccountPaidStatus: null,
        intendedVenuePaidTier: "pro",
        subscriptionCurrentPeriodEnd: PERIOD_END,
      },
    })).rejects.toMatchObject({ code: "billing_identity_conflict" });
    expect(await repository.getWebhookEvent("evt_target_collision")).toMatchObject({ status: "processing" });

    insertAccount(raw, "duplicate-one", { stripeCustomerId: "cus_duplicate" });
    insertAccount(raw, "duplicate-two", { stripeCustomerId: "cus_duplicate" });
    const duplicateToken = await claim(
      repository,
      "evt_duplicate_identity",
      "customer.subscription.updated",
      "2026-08-08T02:30:00.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_duplicate_identity",
      processingToken: duplicateToken,
      appliedAt: "2026-08-08T02:30:01.000Z",
      effect: accountState("cus_duplicate", "duplicate-one", { authorityConfirmed: true }),
    })).rejects.toMatchObject({ code: "billing_identity_conflict" });
    expect(raw.prepare("SELECT count(*) AS count FROM security_audit_log").get()).toEqual({ count: 0 });
  });

  it("re-resolves canonical venue identity and enforces one deterministic billing-profile owner", async () => {
    const { raw, repository } = fixture();
    insertVenue(raw, "venue-alias-owner");
    insertVenueAlias(raw, "venue-alias-owner", "venue-canonical");
    const token = await claim(repository, "evt_alias_checkout", "checkout.session.completed");
    await expect(repository.applyClaimedEvent({
      id: "evt_alias_checkout",
      processingToken: token,
      appliedAt: APPLIED_AT,
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "venue-canonical",
        billingProfileVenueId: "venue-alias-owner",
        authorityConfirmed: true,
        stripeCustomerId: "cus_alias",
        stripeSubscriptionId: "sub_alias",
        providerStatus: "active",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "venue", venueId: "venue-alias-owner", paidTier: "pro" },
      },
    })).resolves.toMatchObject({
      outcome: "venue_applied",
      targetId: "venue-alias-owner",
    });

    insertVenue(raw, "venue-canonical", { subscriptionId: "sub_canonical" });
    const ambiguousToken = await claim(
      repository,
      "evt_ambiguous_owner",
      "checkout.session.completed",
      "2026-08-08T02:40:00.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_ambiguous_owner",
      processingToken: ambiguousToken,
      appliedAt: "2026-08-08T02:40:01.000Z",
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "venue-canonical",
        billingProfileVenueId: "venue-alias-owner",
        authorityConfirmed: true,
        stripeCustomerId: "cus_ambiguous",
        stripeSubscriptionId: "sub_ambiguous",
        providerStatus: "active",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "venue", venueId: "venue-alias-owner", paidTier: "pro" },
      },
    })).rejects.toMatchObject({ code: "billing_identity_conflict" });

    const staleToken = await claim(
      repository,
      "evt_stale_canonical",
      "checkout.session.completed",
      "2026-08-08T02:41:00.000Z",
    );
    await expect(repository.applyClaimedEvent({
      id: "evt_stale_canonical",
      processingToken: staleToken,
      appliedAt: "2026-08-08T02:41:01.000Z",
      effect: {
        kind: "checkout_grant",
        expectedTargetKind: "venue",
        expectedAccountId: null,
        expectedCanonicalVenueId: "venue-alias-owner",
        billingProfileVenueId: "venue-alias-owner",
        authorityConfirmed: true,
        stripeCustomerId: "cus_stale_alias",
        stripeSubscriptionId: "sub_stale_alias",
        providerStatus: "active",
        subscriptionCurrentPeriodEnd: PERIOD_END,
        target: { kind: "venue", venueId: "venue-alias-owner", paidTier: "pro" },
      },
    })).rejects.toMatchObject({ code: "venue_identity_conflict" });
  });

  it("requires ordered mutating events and accepts only data resolved before the transaction", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "provider-order-account");
    const processingToken = await claim(
      repository,
      "evt_no_timestamp",
      "checkout.session.completed",
      null,
    );
    let providerCallCompleted = false;
    const resolvedEffect = await Promise.resolve().then(() => {
      providerCallCompleted = true;
      return accountCheckout("provider-order-account", "cus_provider_order");
    });
    expect(providerCallCompleted).toBe(true);
    await expect(repository.applyClaimedEvent({
      id: "evt_no_timestamp",
      processingToken,
      appliedAt: APPLIED_AT,
      effect: resolvedEffect,
    })).rejects.toMatchObject({ code: "event_timestamp_required" });
    expect(raw.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").get("provider-order-account"))
      .toEqual({ stripe_customer_id: null });
  });
});
