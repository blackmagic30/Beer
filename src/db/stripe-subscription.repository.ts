import crypto from "node:crypto";

import { redactSecrets } from "../lib/redact.js";
import {
  BILLING_CHECKOUT_LOCK_CONTRACT,
  billingCheckoutActorLockKey,
  billingCheckoutConsumerSubjectLockKey,
  billingCheckoutVenueSubjectLockKey,
} from "./billing-checkout.repository.js";
import type { PaidSubscriptionStatus, SubscriptionStatus } from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STRIPE_EVENT_TYPES = /^[a-z0-9][a-z0-9._-]*$/;
const CLAIM_STALE_AFTER_MS = 5 * 60_000;
const MAX_WEBHOOK_ATTEMPTS = 100;
const MAX_WEBHOOK_PAYLOAD_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_VENUE_IDENTITY_ROWS = 256;
const MAX_CANONICAL_VENUE_DEPTH = 32;

export const STRIPE_SUBSCRIPTION_LOCK_CONTRACT = Object.freeze({
  version: 1,
  billingCheckoutVersion: BILLING_CHECKOUT_LOCK_CONTRACT.version,
  eventPrefix: "stripe-subscription:v1:event:",
  customerPrefix: "stripe-subscription:v1:customer:",
  subscriptionPrefix: "stripe-subscription:v1:subscription:",
  accountIdentityPrefix: "stripe-subscription:v1:identity:account",
  venueIdentityPrefix: "stripe-subscription:v1:identity:venue",
  order: "unlocked-preflight-before-sorted-advisory-union-before-account-rows-before-venue-identity-and-profile-rows-before-webhook-row-before-mutation-audit-analytics-and-finalization",
} as const);

export type StripeSubscriptionRepositoryErrorCode =
  | "account_not_found"
  | "authoritative_state_required"
  | "billing_identity_conflict"
  | "event_claim_lost"
  | "event_conflict"
  | "event_timestamp_required"
  | "invalid_input"
  | "persistence_failure"
  | "retry_exhausted"
  | "venue_identity_conflict";

const ERROR_MESSAGES: Readonly<Record<StripeSubscriptionRepositoryErrorCode, string>> = {
  account_not_found: "The Stripe event references an account that does not exist.",
  authoritative_state_required: "Authoritative Stripe state is required before this event can be applied.",
  billing_identity_conflict: "The Stripe billing identity is linked to conflicting local records.",
  event_claim_lost: "Stripe event processing ownership is no longer valid.",
  event_conflict: "The Stripe event conflicts with its persisted identity.",
  event_timestamp_required: "The Stripe event needs a valid creation timestamp before it can change billing state.",
  invalid_input: "The Stripe persistence input is invalid.",
  persistence_failure: "Stripe persistence could not be completed.",
  retry_exhausted: "The Stripe event has exhausted its bounded retry allowance.",
  venue_identity_conflict: "The venue billing identity changed before the Stripe event could be applied.",
};

/** Stable, secret-free failures for future HTTP/service error mapping. */
export class StripeSubscriptionRepositoryError extends Error {
  readonly code: StripeSubscriptionRepositoryErrorCode;

  constructor(code: StripeSubscriptionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "StripeSubscriptionRepositoryError";
    this.code = code;
  }
}

export interface StripeWebhookEventRecord {
  id: string;
  eventType: string;
  status: "pending" | "processing" | "applied" | "failed";
  eventCreatedAt: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  appliedAt: string | null;
  processedAt: string;
  processingToken: string | null;
}

export type StripeWebhookClaimResult =
  | { state: "claimed"; processingToken: string; attempts: number }
  | { state: "applied"; processingToken: null; attempts: number }
  | { state: "in_progress"; processingToken: null; attempts: number };

export type StripeAcknowledgementReason =
  | "checkout_authority_rejected"
  | "checkout_unsettled"
  | "checkout_async_payment_failed"
  | "unsupported_or_noop";

export type StripeExpectedTargetKind = "account" | "venue" | "none";

interface StripeTargetExpectation {
  expectedTargetKind: StripeExpectedTargetKind;
  expectedAccountId: string | null;
  expectedCanonicalVenueId: string | null;
  billingProfileVenueId: string | null;
}

export type StripeApplicationEffect =
  | {
      kind: "acknowledge";
      reason: StripeAcknowledgementReason;
      targetId?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
    }
  | {
      kind: "checkout_grant";
      expectedTargetKind: "account" | "venue";
      expectedAccountId: string | null;
      expectedCanonicalVenueId: string | null;
      billingProfileVenueId: string | null;
      authorityConfirmed: boolean;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      providerStatus: "active" | "trialing";
      subscriptionCurrentPeriodEnd: string | null;
      target:
        | { kind: "account"; userId: string; paidStatus: PaidSubscriptionStatus }
        | { kind: "venue"; venueId: string; paidTier: "pro" };
    }
  | {
      kind: "subscription_state";
      expectedTargetKind: StripeExpectedTargetKind;
      expectedAccountId: string | null;
      expectedCanonicalVenueId: string | null;
      billingProfileVenueId: string | null;
      authorityConfirmed: boolean;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      providerStatus: string | null;
      grantEligible: boolean;
      intendedAccountPaidStatus: PaidSubscriptionStatus | null;
      intendedVenuePaidTier: "pro" | null;
      subscriptionCurrentPeriodEnd: string | null;
    };

export interface StripeAccountBillingState {
  id: string;
  role: string;
  authProvider: string;
  subscriptionStatus: SubscriptionStatus;
  stripePaidSubscriptionStatus: PaidSubscriptionStatus | null;
  stripeCustomerId: string | null;
  stripeEventCreatedAt: string | null;
  premiumUntil: string | null;
  updatedAt: string;
}

export interface StripeVenueBillingState {
  venueId: string;
  suburb: string | null;
  membershipTier: "basic" | "pro";
  stripePaidMembershipTier: "pro" | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  highlightedName: boolean;
  premiumBadge: string | null;
  promoted: boolean;
  featuredSpecialEligible: boolean;
  stripeEventCreatedAt: string | null;
  introTrialEverClaimed: boolean;
  tierManualOverride: boolean;
  updatedAt: string;
}

/**
 * Immutable target snapshot resolved before provider authority work. The apply
 * transaction re-resolves this identity under the shared lock union and rejects
 * any change, so callers never infer an account/venue target from Stripe data
 * alone.
 */
export type StripeResolvedBillingTarget =
  | {
      kind: "none";
      expectedTargetKind: "none";
      expectedAccountId: null;
      expectedCanonicalVenueId: null;
      billingProfileVenueId: null;
      account: null;
      venue: null;
    }
  | {
      kind: "account";
      expectedTargetKind: "account";
      expectedAccountId: string;
      expectedCanonicalVenueId: null;
      billingProfileVenueId: null;
      account: StripeAccountBillingState;
      venue: null;
    }
  | {
      kind: "venue";
      expectedTargetKind: "venue";
      expectedAccountId: null;
      expectedCanonicalVenueId: string;
      billingProfileVenueId: string;
      account: null;
      venue: StripeVenueBillingState;
    };

export interface StripeApplicationResult {
  eventId: string;
  eventType: string;
  eventCreatedAt: string | null;
  outcome:
    | "account_applied"
    | "venue_applied"
    | "acknowledged"
    | "already_applied"
    | "stale"
    | "deleted_account"
    | "manual_override"
    | "target_not_found";
  targetType: "account" | "venue" | null;
  targetId: string | null;
  account: StripeAccountBillingState | null;
  venue: StripeVenueBillingState | null;
}

interface WebhookEventRow {
  id: string;
  eventType: string;
  status: string;
  eventCreatedAt: string | null;
  payloadJson: unknown;
  attempts: number | string;
  lastError: string | null;
  receivedAt: string;
  appliedAt: string | null;
  processedAt: string;
  processingToken: string | null;
}

interface AccountBillingRow {
  id: string;
  role: string;
  authProvider: string;
  subscriptionStatus: string;
  stripePaidSubscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeEventCreatedAt: string | null;
  premiumUntil: string | null;
  updatedAt: string;
  deletionLocked: boolean | number;
}

interface VenueBillingRow {
  venueId: string;
  suburb: string | null;
  membershipTier: string;
  stripePaidMembershipTier: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  highlightedName: boolean | number;
  premiumBadge: string | null;
  promoted: boolean | number;
  featuredSpecialEligible: boolean | number;
  stripeEventCreatedAt: string | null;
  introTrialEverClaimed: boolean | number;
  tierManualOverride: boolean | number;
  updatedAt: string;
}

interface VenueAliasRow {
  aliasVenueId: unknown;
  canonicalVenueId: unknown;
}

type ResolvedApplicationTarget =
  | { kind: "none" }
  | { kind: "account"; accountId: string; account: AccountBillingRow }
  | {
      kind: "venue";
      canonicalVenueId: string;
      billingProfileVenueId: string;
      venue: VenueBillingRow;
    };

const WEBHOOK_EVENT_PROJECTION = `
  webhook.id AS "id",
  webhook.event_type AS "eventType",
  webhook.status AS "status",
  webhook.event_created_at AS "eventCreatedAt",
  webhook.payload_json AS "payloadJson",
  webhook.attempts AS "attempts",
  webhook.last_error AS "lastError",
  webhook.received_at AS "receivedAt",
  webhook.applied_at AS "appliedAt",
  webhook.processed_at AS "processedAt",
  webhook.processing_token AS "processingToken"`;

const ACCOUNT_BILLING_PROJECTION = `
  account.id AS "id",
  account.role AS "role",
  account.auth_provider AS "authProvider",
  account.subscription_status AS "subscriptionStatus",
  account.stripe_paid_subscription_status AS "stripePaidSubscriptionStatus",
  account.stripe_customer_id AS "stripeCustomerId",
  account.stripe_event_created_at AS "stripeEventCreatedAt",
  account.premium_until AS "premiumUntil",
  account.updated_at AS "updatedAt",
  EXISTS (
    SELECT 1 FROM account_deletion_requests deletion
    WHERE deletion.user_id = account.id
      AND deletion.status IN ('processing', 'failed', 'completed')
  ) AS "deletionLocked"`;

const VENUE_BILLING_PROJECTION = `
  venue.venue_id AS "venueId",
  venue.suburb AS "suburb",
  venue.membership_tier AS "membershipTier",
  venue.stripe_paid_membership_tier AS "stripePaidMembershipTier",
  venue.stripe_customer_id AS "stripeCustomerId",
  venue.stripe_subscription_id AS "stripeSubscriptionId",
  venue.subscription_status AS "subscriptionStatus",
  venue.subscription_current_period_end AS "subscriptionCurrentPeriodEnd",
  venue.highlighted_name AS "highlightedName",
  venue.premium_badge AS "premiumBadge",
  venue.promoted AS "promoted",
  venue.featured_special_eligible AS "featuredSpecialEligible",
  venue.stripe_event_created_at AS "stripeEventCreatedAt",
  venue.intro_trial_ever_claimed AS "introTrialEverClaimed",
  venue.tier_manual_override AS "tierManualOverride",
  venue.updated_at AS "updatedAt"`;

function repositoryError(code: StripeSubscriptionRepositoryErrorCode): never {
  throw new StripeSubscriptionRepositoryError(code);
}

function requireText(value: string, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("invalid_input");
  }
  return normalized;
}

function optionalText(value: string | null | undefined, maximum = 255): string | null {
  return value == null ? null : requireText(value, maximum);
}

function requireEventType(value: string): string {
  const normalized = requireText(value, 160).toLowerCase();
  if (!STRIPE_EVENT_TYPES.test(normalized)) return repositoryError("invalid_input");
  return normalized;
}

function requireCanonicalUtc(value: string): string {
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("invalid_input");
    }
    return value;
  } catch {
    return repositoryError("invalid_input");
  }
}

function optionalCanonicalUtc(value: string | null | undefined): string | null {
  return value == null ? null : requireCanonicalUtc(value);
}

function persistedText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("persistence_failure");
  }
  return normalized;
}

function persistedCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("persistence_failure");
    }
    return value;
  } catch {
    return repositoryError("persistence_failure");
  }
}

function optionalPersistedCanonicalUtc(value: unknown): string | null {
  return value == null ? null : persistedCanonicalUtc(value);
}

function safeInteger(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return repositoryError("persistence_failure");
    return value;
  }
  if (!/^\d+$/.test(value)) return repositoryError("persistence_failure");
  const exact = BigInt(value);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) return repositoryError("persistence_failure");
  return Number(exact);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return repositoryError("persistence_failure");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return repositoryError("persistence_failure");
  }
  return parsed as Record<string, unknown>;
}

function serializeObject(value: Record<string, unknown>, maximumBytes: number): string {
  try {
    const serialized = JSON.stringify(redactSecrets(value));
    if (!serialized || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
      return repositoryError("invalid_input");
    }
    return serialized;
  } catch {
    return repositoryError("invalid_input");
  }
}

function requirePaidStatus(value: string): PaidSubscriptionStatus {
  if (value !== "premium_monthly" && value !== "premium_yearly") {
    return repositoryError("invalid_input");
  }
  return value;
}

function optionalPaidStatus(value: string | null): PaidSubscriptionStatus | null {
  return value == null ? null : requirePaidStatus(value);
}

function persistedPaidStatus(value: unknown): PaidSubscriptionStatus | null {
  if (value == null) return null;
  if (value !== "premium_monthly" && value !== "premium_yearly") {
    return repositoryError("persistence_failure");
  }
  return value;
}

function requireSubscriptionStatus(value: string): SubscriptionStatus {
  if (!["free", "premium_monthly", "premium_yearly", "contributor_unlocked", "admin"].includes(value)) {
    return repositoryError("persistence_failure");
  }
  return value as SubscriptionStatus;
}

function normalizeVenueTier(value: string): "basic" | "pro" {
  if (value === "basic" || value === "free") return "basic";
  if (value === "pro" || value === "plus" || value === "super_premium") return "pro";
  return repositoryError("persistence_failure");
}

function normalizePaidVenueTier(value: string | null): "pro" | null {
  if (value == null) return null;
  if (value === "pro" || value === "plus" || value === "super_premium") return "pro";
  return repositoryError("persistence_failure");
}

function toWebhookEvent(row: WebhookEventRow): StripeWebhookEventRecord {
  if (!["pending", "processing", "applied", "failed"].includes(row.status)) {
    return repositoryError("persistence_failure");
  }
  return {
    id: persistedText(row.id),
    eventType: STRIPE_EVENT_TYPES.test(row.eventType) ? row.eventType : repositoryError("persistence_failure"),
    status: row.status as StripeWebhookEventRecord["status"],
    eventCreatedAt: optionalPersistedCanonicalUtc(row.eventCreatedAt),
    payload: jsonObject(row.payloadJson),
    attempts: safeInteger(row.attempts),
    lastError: row.lastError == null ? null : String(redactSecrets(row.lastError)).slice(0, 500),
    receivedAt: persistedCanonicalUtc(row.receivedAt),
    appliedAt: optionalPersistedCanonicalUtc(row.appliedAt),
    processedAt: persistedCanonicalUtc(row.processedAt),
    processingToken: row.processingToken,
  };
}

function toAccountState(row: AccountBillingRow): StripeAccountBillingState {
  return {
    id: row.id,
    role: row.role,
    authProvider: row.authProvider,
    subscriptionStatus: requireSubscriptionStatus(row.subscriptionStatus),
    stripePaidSubscriptionStatus: persistedPaidStatus(row.stripePaidSubscriptionStatus),
    stripeCustomerId: row.stripeCustomerId,
    stripeEventCreatedAt: optionalPersistedCanonicalUtc(row.stripeEventCreatedAt),
    premiumUntil: optionalPersistedCanonicalUtc(row.premiumUntil),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

function toVenueState(row: VenueBillingRow): StripeVenueBillingState {
  return {
    venueId: row.venueId,
    suburb: row.suburb,
    membershipTier: normalizeVenueTier(row.membershipTier),
    stripePaidMembershipTier: normalizePaidVenueTier(row.stripePaidMembershipTier),
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    subscriptionStatus: row.subscriptionStatus,
    subscriptionCurrentPeriodEnd: optionalPersistedCanonicalUtc(row.subscriptionCurrentPeriodEnd),
    highlightedName: Boolean(row.highlightedName),
    premiumBadge: row.premiumBadge,
    promoted: Boolean(row.promoted),
    featuredSpecialEligible: Boolean(row.featuredSpecialEligible),
    stripeEventCreatedAt: optionalPersistedCanonicalUtc(row.stripeEventCreatedAt),
    introTrialEverClaimed: Boolean(row.introTrialEverClaimed),
    tierManualOverride: Boolean(row.tierManualOverride),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

function deterministicId(namespace: "audit" | "analytics", eventId: string, discriminator: string): string {
  const digest = crypto.createHash("sha256")
    .update(`${namespace}\0${eventId}\0${discriminator}`)
    .digest("hex")
    .slice(0, 40);
  return `stripe-${namespace}-${digest}`;
}

function eventOrdering(
  targetEventCreatedAt: string | null,
  eventCreatedAt: string,
  authorityConfirmed: boolean,
): "apply" | "stale" {
  if (!targetEventCreatedAt) return "apply";
  const comparison = Date.parse(targetEventCreatedAt) - Date.parse(eventCreatedAt);
  if (comparison > 0) return "stale";
  if (comparison === 0 && !authorityConfirmed) return repositoryError("authoritative_state_required");
  return "apply";
}

function normalizeTargetExpectation(value: StripeTargetExpectation): StripeTargetExpectation {
  if (!value || typeof value !== "object") return repositoryError("invalid_input");
  const expectedTargetKind = value.expectedTargetKind;
  if (expectedTargetKind !== "account" && expectedTargetKind !== "venue" && expectedTargetKind !== "none") {
    return repositoryError("invalid_input");
  }
  const expectedAccountId = optionalText(value.expectedAccountId);
  const expectedCanonicalVenueId = optionalText(value.expectedCanonicalVenueId);
  const billingProfileVenueId = optionalText(value.billingProfileVenueId);
  if (expectedTargetKind === "account") {
    if (!expectedAccountId || expectedCanonicalVenueId || billingProfileVenueId) {
      return repositoryError("invalid_input");
    }
  } else if (expectedTargetKind === "venue") {
    if (expectedAccountId || !expectedCanonicalVenueId || !billingProfileVenueId) {
      return repositoryError("invalid_input");
    }
  } else if (expectedAccountId || expectedCanonicalVenueId || billingProfileVenueId) {
    return repositoryError("invalid_input");
  }
  return { expectedTargetKind, expectedAccountId, expectedCanonicalVenueId, billingProfileVenueId };
}

function normalizeEffect(effect: StripeApplicationEffect): StripeApplicationEffect {
  if (!effect || typeof effect !== "object") return repositoryError("invalid_input");
  if (effect.kind === "acknowledge") {
    if (!["checkout_authority_rejected", "checkout_unsettled", "checkout_async_payment_failed", "unsupported_or_noop"]
      .includes(effect.reason)) return repositoryError("invalid_input");
    const metadata = effect.metadata ?? {};
    serializeObject(metadata, MAX_METADATA_BYTES);
    return {
      kind: "acknowledge",
      reason: effect.reason,
      targetId: optionalText(effect.targetId, 255),
      metadata,
    };
  }
  if (effect.kind === "checkout_grant") {
    if (typeof effect.authorityConfirmed !== "boolean") return repositoryError("invalid_input");
    const expectation = normalizeTargetExpectation(effect);
    if (expectation.expectedTargetKind === "none") return repositoryError("invalid_input");
    const checkoutExpectation = {
      ...expectation,
      expectedTargetKind: expectation.expectedTargetKind as "account" | "venue",
    };
    const stripeCustomerId = optionalText(effect.stripeCustomerId);
    const stripeSubscriptionId = optionalText(effect.stripeSubscriptionId);
    if (expectation.expectedTargetKind === "account" && !stripeCustomerId) {
      return repositoryError("invalid_input");
    }
    if (expectation.expectedTargetKind === "venue" && !stripeSubscriptionId) {
      return repositoryError("invalid_input");
    }
    const common = {
      kind: "checkout_grant" as const,
      ...checkoutExpectation,
      authorityConfirmed: effect.authorityConfirmed,
      stripeCustomerId,
      stripeSubscriptionId,
      providerStatus: effect.providerStatus,
      subscriptionCurrentPeriodEnd: optionalCanonicalUtc(effect.subscriptionCurrentPeriodEnd),
    };
    if (effect.providerStatus !== "active" && effect.providerStatus !== "trialing") {
      return repositoryError("invalid_input");
    }
    if (!effect.target || typeof effect.target !== "object") return repositoryError("invalid_input");
    if (effect.target.kind === "account") {
      const userId = requireText(effect.target.userId);
      if (expectation.expectedTargetKind !== "account" || expectation.expectedAccountId !== userId) {
        return repositoryError("invalid_input");
      }
      return {
        ...common,
        target: {
          kind: "account",
          userId,
          paidStatus: requirePaidStatus(effect.target.paidStatus),
        },
      };
    }
    if (effect.target.kind === "venue" && effect.target.paidTier === "pro") {
      const venueId = requireText(effect.target.venueId);
      if (expectation.expectedTargetKind !== "venue" || expectation.billingProfileVenueId !== venueId) {
        return repositoryError("invalid_input");
      }
      return {
        ...common,
        target: { kind: "venue", venueId, paidTier: "pro" },
      };
    }
    return repositoryError("invalid_input");
  }
  if (effect.kind === "subscription_state") {
    if (typeof effect.authorityConfirmed !== "boolean" || typeof effect.grantEligible !== "boolean") {
      return repositoryError("invalid_input");
    }
    const providerStatus = optionalText(effect.providerStatus, 120);
    if (effect.grantEligible && providerStatus !== "active" && providerStatus !== "trialing") {
      return repositoryError("invalid_input");
    }
    if (effect.intendedVenuePaidTier != null && effect.intendedVenuePaidTier !== "pro") {
      return repositoryError("invalid_input");
    }
    const expectation = normalizeTargetExpectation(effect);
    const stripeCustomerId = optionalText(effect.stripeCustomerId);
    const stripeSubscriptionId = optionalText(effect.stripeSubscriptionId);
    if (expectation.expectedTargetKind === "account" && !stripeCustomerId) {
      return repositoryError("invalid_input");
    }
    if (expectation.expectedTargetKind === "venue" && !stripeSubscriptionId) {
      return repositoryError("invalid_input");
    }
    if (expectation.expectedTargetKind === "account" && effect.intendedVenuePaidTier !== null) {
      return repositoryError("invalid_input");
    }
    if (expectation.expectedTargetKind === "venue" && effect.intendedAccountPaidStatus !== null) {
      return repositoryError("invalid_input");
    }
    if (
      expectation.expectedTargetKind === "none"
      && (effect.intendedAccountPaidStatus !== null || effect.intendedVenuePaidTier !== null)
    ) return repositoryError("invalid_input");
    return {
      kind: "subscription_state",
      ...expectation,
      authorityConfirmed: effect.authorityConfirmed,
      stripeCustomerId,
      stripeSubscriptionId,
      providerStatus,
      grantEligible: effect.grantEligible,
      intendedAccountPaidStatus: optionalPaidStatus(effect.intendedAccountPaidStatus),
      intendedVenuePaidTier: effect.intendedVenuePaidTier,
      subscriptionCurrentPeriodEnd: optionalCanonicalUtc(effect.subscriptionCurrentPeriodEnd),
    };
  }
  return repositoryError("invalid_input");
}

/**
 * Async Stripe event and billing persistence shared by rehearsal SQLite and the
 * native Postgres runtime. Stripe HTTP calls and payload interpretation stay in
 * the service layer. `applyClaimedEvent` receives only normalized data.
 *
 * Application lock contract:
 *   1. read the event and billing/venue identity without locks;
 *   2. acquire one sorted transaction-scoped advisory union containing Stripe
 *      identity keys and the shared BillingCheckout actor/subject keys;
 *   3. re-resolve and lock accounts first, then venue identity/profile rows;
 *   4. lock and revalidate the webhook row plus processing token;
 *   5. mutate the target, insert essential audit/analytics rows, and finalize
 *      the webhook last in the same short transaction.
 *
 * Account deletion already joins the shared actor key, while venue alias merges
 * join the shared venue-subject key. No provider call may occur inside this
 * repository or while these locks are held.
 */
export class StripeSubscriptionRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translateFailure<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StripeSubscriptionRepositoryError) throw error;
      throw new StripeSubscriptionRepositoryError("persistence_failure");
    }
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of Array.from(new Set(keys)).sort()) {
      await this.database.prepare(
        "SELECT pg_advisory_xact_lock(hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private applicationLockKeys(id: string, effect: StripeApplicationEffect): string[] {
    const keys = [`${STRIPE_SUBSCRIPTION_LOCK_CONTRACT.eventPrefix}${id}`];
    if (effect.kind === "acknowledge") return keys;
    if (effect.stripeCustomerId) {
      keys.push(`${STRIPE_SUBSCRIPTION_LOCK_CONTRACT.customerPrefix}${effect.stripeCustomerId}`);
    }
    if (effect.stripeSubscriptionId) {
      keys.push(`${STRIPE_SUBSCRIPTION_LOCK_CONTRACT.subscriptionPrefix}${effect.stripeSubscriptionId}`);
    }
    if (effect.expectedTargetKind === "account") {
      keys.push(
        STRIPE_SUBSCRIPTION_LOCK_CONTRACT.accountIdentityPrefix,
        billingCheckoutActorLockKey(effect.expectedAccountId!),
        billingCheckoutConsumerSubjectLockKey(effect.expectedAccountId!),
      );
    } else if (effect.expectedTargetKind === "venue") {
      keys.push(
        STRIPE_SUBSCRIPTION_LOCK_CONTRACT.venueIdentityPrefix,
        billingCheckoutVenueSubjectLockKey(effect.expectedCanonicalVenueId!),
      );
    }
    return keys;
  }

  private async webhookEvent(id: string, lock = false): Promise<WebhookEventRow | null> {
    const suffix = lock ? this.lockSuffix("webhook") : "";
    const row = await this.database.prepare(
      `SELECT ${WEBHOOK_EVENT_PROJECTION}
         FROM stripe_webhook_events webhook
        WHERE webhook.id = ?${suffix}`,
    ).get<WebhookEventRow>(id);
    return row ?? null;
  }

  private async accountById(id: string, lock = true): Promise<AccountBillingRow | null> {
    const suffix = lock ? this.lockSuffix("account") : "";
    const row = await this.database.prepare(
      `SELECT ${ACCOUNT_BILLING_PROJECTION}
         FROM accounts account
        WHERE account.id = ?${suffix}`,
    ).get<AccountBillingRow>(id);
    return row ?? null;
  }

  private async accountByCustomer(customerId: string, lock = true): Promise<AccountBillingRow | null> {
    const suffix = lock ? this.lockSuffix("account") : "";
    const rows = await this.database.prepare(
      `SELECT ${ACCOUNT_BILLING_PROJECTION}
         FROM accounts account
        WHERE account.stripe_customer_id = ?
        ORDER BY account.id
        LIMIT 2${suffix}`,
    ).all<AccountBillingRow>(customerId);
    if (rows.length > 1) repositoryError("billing_identity_conflict");
    return rows[0] ?? null;
  }

  private async venueById(id: string, lock = true): Promise<VenueBillingRow | null> {
    const suffix = lock ? this.lockSuffix("venue") : "";
    const row = await this.database.prepare(
      `SELECT ${VENUE_BILLING_PROJECTION}
         FROM venue_profiles venue
        WHERE venue.venue_id = ?${suffix}`,
    ).get<VenueBillingRow>(id);
    return row ?? null;
  }

  private async venueBySubscription(subscriptionId: string, lock = true): Promise<VenueBillingRow | null> {
    const suffix = lock ? this.lockSuffix("venue") : "";
    const rows = await this.database.prepare(
      `SELECT ${VENUE_BILLING_PROJECTION}
         FROM venue_profiles venue
        WHERE venue.stripe_subscription_id = ?
        ORDER BY venue.venue_id
        LIMIT 2${suffix}`,
    ).all<VenueBillingRow>(subscriptionId);
    if (rows.length > 1) repositoryError("billing_identity_conflict");
    return rows[0] ?? null;
  }

  private async venueByCustomer(customerId: string, lock = true): Promise<VenueBillingRow | null> {
    const suffix = lock ? this.lockSuffix("venue") : "";
    const rows = await this.database.prepare(
      `SELECT ${VENUE_BILLING_PROJECTION}
         FROM venue_profiles venue
        WHERE venue.stripe_customer_id = ?
        ORDER BY venue.venue_id
        LIMIT 2${suffix}`,
    ).all<VenueBillingRow>(customerId);
    if (rows.length > 1) repositoryError("billing_identity_conflict");
    return rows[0] ?? null;
  }

  private async venueAlias(venueId: string, lock: boolean): Promise<VenueAliasRow | null> {
    const suffix = lock ? this.lockSuffix("alias") : "";
    const row = await this.database.prepare(
      `SELECT alias.alias_venue_id AS "aliasVenueId",
              alias.canonical_venue_id AS "canonicalVenueId"
         FROM venue_identity_aliases alias
        WHERE alias.alias_venue_id = ?${suffix}`,
    ).get<VenueAliasRow>(venueId);
    return row ?? null;
  }

  private async canonicalVenueId(venueId: string, lock: boolean): Promise<string> {
    let current = venueId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_CANONICAL_VENUE_DEPTH; depth += 1) {
      if (visited.has(current)) repositoryError("venue_identity_conflict");
      visited.add(current);
      const row = await this.venueAlias(current, lock);
      if (!row) return current;
      if (persistedText(row.aliasVenueId) !== current) repositoryError("persistence_failure");
      const next = persistedText(row.canonicalVenueId);
      if (next === current) repositoryError("venue_identity_conflict");
      current = next;
    }
    return repositoryError("venue_identity_conflict");
  }

  private async resolveVenueBillingProfile(input: {
    expectedCanonicalVenueId: string;
    billingProfileVenueId: string | null;
    lock: boolean;
  }): Promise<ResolvedApplicationTarget & { kind: "venue" }> {
    const canonicalVenueId = await this.canonicalVenueId(
      input.billingProfileVenueId ?? input.expectedCanonicalVenueId,
      input.lock,
    );
    const expectedCanonicalVenueId = await this.canonicalVenueId(input.expectedCanonicalVenueId, input.lock);
    if (
      canonicalVenueId !== input.expectedCanonicalVenueId
      || expectedCanonicalVenueId !== input.expectedCanonicalVenueId
    ) repositoryError("venue_identity_conflict");

    const suffix = input.lock ? this.lockSuffix("alias") : "";
    const aliases = await this.database.prepare(
      `SELECT alias.alias_venue_id AS "aliasVenueId",
              alias.canonical_venue_id AS "canonicalVenueId"
         FROM venue_identity_aliases alias
        WHERE alias.canonical_venue_id = ?
        ORDER BY alias.alias_venue_id
        LIMIT ?${suffix}`,
    ).all<VenueAliasRow>(canonicalVenueId, MAX_VENUE_IDENTITY_ROWS + 1);
    if (aliases.length > MAX_VENUE_IDENTITY_ROWS) repositoryError("venue_identity_conflict");
    const venueIds = Array.from(new Set([
      canonicalVenueId,
      ...aliases.map((row) => {
        if (persistedText(row.canonicalVenueId) !== canonicalVenueId) repositoryError("persistence_failure");
        return persistedText(row.aliasVenueId);
      }),
    ])).sort();
    if (input.billingProfileVenueId && !venueIds.includes(input.billingProfileVenueId)) {
      repositoryError("venue_identity_conflict");
    }
    const placeholders = venueIds.map(() => "?").join(", ");
    const profileSuffix = input.lock ? this.lockSuffix("venue") : "";
    const profiles = await this.database.prepare(
      `SELECT ${VENUE_BILLING_PROJECTION}
         FROM venue_profiles venue
        WHERE venue.venue_id IN (${placeholders})
        ORDER BY venue.venue_id
        LIMIT ?${profileSuffix}`,
    ).all<VenueBillingRow>(...venueIds, MAX_VENUE_IDENTITY_ROWS + 1);
    if (profiles.length === 0 || profiles.length > MAX_VENUE_IDENTITY_ROWS) {
      repositoryError("billing_identity_conflict");
    }
    const canonicalProfile = profiles.find((row) => row.venueId === canonicalVenueId) ?? null;
    const deterministicOwner = canonicalProfile ?? (profiles.length === 1 ? profiles[0]! : null);
    if (!deterministicOwner || (
      input.billingProfileVenueId
      && deterministicOwner.venueId !== input.billingProfileVenueId
    )) {
      repositoryError("billing_identity_conflict");
    }
    return {
      kind: "venue",
      canonicalVenueId,
      billingProfileVenueId: deterministicOwner.venueId,
      venue: deterministicOwner,
    };
  }

  private async resolveApplicationTarget(
    effect: Exclude<StripeApplicationEffect, { kind: "acknowledge" }>,
    lock: boolean,
  ): Promise<ResolvedApplicationTarget> {
    const accountCustomerOwner = effect.stripeCustomerId
      ? await this.accountByCustomer(effect.stripeCustomerId, lock)
      : null;

    let expectedAccount: AccountBillingRow | null = null;
    if (effect.expectedTargetKind === "account") {
      expectedAccount = await this.accountById(effect.expectedAccountId!, lock);
      if (!expectedAccount) {
        if (effect.kind === "checkout_grant") repositoryError("account_not_found");
        repositoryError("billing_identity_conflict");
      }
    }

    let expectedVenue: (ResolvedApplicationTarget & { kind: "venue" }) | null = null;
    if (effect.expectedTargetKind === "venue") {
      expectedVenue = await this.resolveVenueBillingProfile({
        expectedCanonicalVenueId: effect.expectedCanonicalVenueId!,
        billingProfileVenueId: effect.billingProfileVenueId!,
        lock,
      });
    }

    const venueCustomerOwner = effect.stripeCustomerId
      ? await this.venueByCustomer(effect.stripeCustomerId, lock)
      : null;
    const venueSubscriptionOwner = effect.stripeSubscriptionId
      ? await this.venueBySubscription(effect.stripeSubscriptionId, lock)
      : null;

    if (accountCustomerOwner && (venueCustomerOwner || venueSubscriptionOwner)) {
      repositoryError("billing_identity_conflict");
    }
    if (
      venueCustomerOwner
      && venueSubscriptionOwner
      && venueCustomerOwner.venueId !== venueSubscriptionOwner.venueId
    ) repositoryError("billing_identity_conflict");

    if (effect.expectedTargetKind === "none") {
      if (accountCustomerOwner || venueCustomerOwner || venueSubscriptionOwner) {
        repositoryError("billing_identity_conflict");
      }
      return { kind: "none" };
    }

    if (effect.expectedTargetKind === "account") {
      if (venueCustomerOwner || venueSubscriptionOwner) repositoryError("billing_identity_conflict");
      if (
        effect.kind === "subscription_state"
        && (!accountCustomerOwner || accountCustomerOwner.id !== effect.expectedAccountId)
      ) repositoryError("billing_identity_conflict");
      if (accountCustomerOwner && accountCustomerOwner.id !== effect.expectedAccountId) {
        repositoryError("billing_identity_conflict");
      }
      if (
        expectedAccount!.stripeCustomerId
        && effect.stripeCustomerId
        && expectedAccount!.stripeCustomerId !== effect.stripeCustomerId
      ) repositoryError("billing_identity_conflict");
      return { kind: "account", accountId: expectedAccount!.id, account: expectedAccount! };
    }

    if (accountCustomerOwner) repositoryError("billing_identity_conflict");
    if (effect.kind === "subscription_state") {
      if (
        !venueSubscriptionOwner
        || venueSubscriptionOwner.venueId !== expectedVenue!.billingProfileVenueId
      ) repositoryError("billing_identity_conflict");
    }
    if (venueCustomerOwner && venueCustomerOwner.venueId !== expectedVenue!.billingProfileVenueId) {
      repositoryError("billing_identity_conflict");
    }
    if (venueSubscriptionOwner && venueSubscriptionOwner.venueId !== expectedVenue!.billingProfileVenueId) {
      repositoryError("billing_identity_conflict");
    }
    if (
      expectedVenue!.venue.stripeCustomerId
      && effect.stripeCustomerId
      && expectedVenue!.venue.stripeCustomerId !== effect.stripeCustomerId
    ) repositoryError("billing_identity_conflict");
    if (
      expectedVenue!.venue.stripeSubscriptionId
      && effect.stripeSubscriptionId
      && expectedVenue!.venue.stripeSubscriptionId !== effect.stripeSubscriptionId
    ) repositoryError("billing_identity_conflict");
    return expectedVenue!;
  }

  private targetFingerprint(target: ResolvedApplicationTarget): string {
    if (target.kind === "none") return "none";
    if (target.kind === "account") return `account:${target.accountId}`;
    return `venue:${target.canonicalVenueId}:${target.billingProfileVenueId}`;
  }

  private resolvedTargetSnapshot(target: ResolvedApplicationTarget): StripeResolvedBillingTarget {
    if (target.kind === "none") {
      return {
        kind: "none",
        expectedTargetKind: "none",
        expectedAccountId: null,
        expectedCanonicalVenueId: null,
        billingProfileVenueId: null,
        account: null,
        venue: null,
      };
    }
    if (target.kind === "account") {
      return {
        kind: "account",
        expectedTargetKind: "account",
        expectedAccountId: target.accountId,
        expectedCanonicalVenueId: null,
        billingProfileVenueId: null,
        account: toAccountState(target.account),
        venue: null,
      };
    }
    return {
      kind: "venue",
      expectedTargetKind: "venue",
      expectedAccountId: null,
      expectedCanonicalVenueId: target.canonicalVenueId,
      billingProfileVenueId: target.billingProfileVenueId,
      account: null,
      venue: toVenueState(target.venue),
    };
  }

  /** Resolves existing Stripe customer/subscription ownership without mutating state. */
  async resolveBillingTarget(input: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  }): Promise<StripeResolvedBillingTarget> {
    const stripeCustomerId = optionalText(input.stripeCustomerId);
    const stripeSubscriptionId = optionalText(input.stripeSubscriptionId);
    if (!stripeCustomerId && !stripeSubscriptionId) repositoryError("invalid_input");

    return this.translateFailure(async () => {
      const accountCustomerOwner = stripeCustomerId
        ? await this.accountByCustomer(stripeCustomerId, false)
        : null;
      const venueCustomerOwner = stripeCustomerId
        ? await this.venueByCustomer(stripeCustomerId, false)
        : null;
      const venueSubscriptionOwner = stripeSubscriptionId
        ? await this.venueBySubscription(stripeSubscriptionId, false)
        : null;

      if (accountCustomerOwner && (venueCustomerOwner || venueSubscriptionOwner)) {
        repositoryError("billing_identity_conflict");
      }
      if (
        venueCustomerOwner
        && venueSubscriptionOwner
        && venueCustomerOwner.venueId !== venueSubscriptionOwner.venueId
      ) repositoryError("billing_identity_conflict");
      if (accountCustomerOwner) {
        return this.resolvedTargetSnapshot({
          kind: "account",
          accountId: accountCustomerOwner.id,
          account: accountCustomerOwner,
        });
      }
      const venueOwner = venueSubscriptionOwner ?? venueCustomerOwner;
      if (!venueOwner) return this.resolvedTargetSnapshot({ kind: "none" });
      const canonicalVenueId = await this.canonicalVenueId(venueOwner.venueId, false);
      const target = await this.resolveVenueBillingProfile({
        expectedCanonicalVenueId: canonicalVenueId,
        billingProfileVenueId: venueOwner.venueId,
        lock: false,
      });
      return this.resolvedTargetSnapshot(target);
    });
  }

  /** Resolves an explicit consumer checkout target before provider authority work. */
  async resolveAccountBillingTarget(accountId: string): Promise<StripeResolvedBillingTarget & { kind: "account" }> {
    const expectedAccountId = requireText(accountId);
    return this.translateFailure(async () => {
      const account = await this.accountById(expectedAccountId, false);
      if (!account) repositoryError("account_not_found");
      return this.resolvedTargetSnapshot({
        kind: "account",
        accountId: account.id,
        account,
      }) as StripeResolvedBillingTarget & { kind: "account" };
    });
  }

  /** Resolves the deterministic billing-profile owner for explicit checkout metadata. */
  async resolveVenueBillingTarget(venueId: string): Promise<StripeResolvedBillingTarget & { kind: "venue" }> {
    const requestedVenueId = requireText(venueId);
    return this.translateFailure(async () => {
      const canonicalVenueId = await this.canonicalVenueId(requestedVenueId, false);
      const target = await this.resolveVenueBillingProfile({
        expectedCanonicalVenueId: canonicalVenueId,
        billingProfileVenueId: null,
        lock: false,
      });
      return this.resolvedTargetSnapshot(target) as StripeResolvedBillingTarget & { kind: "venue" };
    });
  }

  async getWebhookEvent(id: string): Promise<StripeWebhookEventRecord | null> {
    const eventId = requireText(id);
    return this.translateFailure(async () => {
      const row = await this.webhookEvent(eventId);
      return row ? toWebhookEvent(row) : null;
    });
  }

  async claimWebhookEvent(input: {
    id: string;
    eventType: string;
    eventCreatedAt: string | null;
    payload: Record<string, unknown>;
    receivedAt: string;
  }): Promise<StripeWebhookClaimResult> {
    const id = requireText(input.id);
    const eventType = requireEventType(input.eventType);
    const eventCreatedAt = optionalCanonicalUtc(input.eventCreatedAt);
    const receivedAt = requireCanonicalUtc(input.receivedAt);
    const payloadJson = serializeObject(input.payload, MAX_WEBHOOK_PAYLOAD_BYTES);

    return this.translateFailure(this.database.transaction(async () => {
      const processingToken = crypto.randomUUID();
      const inserted = await this.database.prepare(
        `INSERT OR IGNORE INTO stripe_webhook_events (
           id, event_type, status, event_created_at, payload_json, attempts,
           last_error, received_at, applied_at, processed_at, processing_token
         ) VALUES (
           @id, @eventType, 'processing', @eventCreatedAt, @payloadJson, 1,
           NULL, @receivedAt, NULL, @receivedAt, @processingToken
         )`,
      ).run({ id, eventType, eventCreatedAt, payloadJson, receivedAt, processingToken });

      const persisted = await this.webhookEvent(id, true);
      if (!persisted) repositoryError("persistence_failure");
      const event = toWebhookEvent(persisted);
      if (event.eventType !== eventType) repositoryError("event_conflict");
      if (event.eventCreatedAt && eventCreatedAt && event.eventCreatedAt !== eventCreatedAt) {
        repositoryError("event_conflict");
      }
      if (inserted.changes === 1) {
        return { state: "claimed", processingToken, attempts: 1 };
      }
      if (event.status === "applied") {
        return { state: "applied", processingToken: null, attempts: event.attempts };
      }
      const staleBefore = new Date(Date.parse(receivedAt) - CLAIM_STALE_AFTER_MS).toISOString();
      if (event.status === "processing" && event.processedAt > staleBefore) {
        return { state: "in_progress", processingToken: null, attempts: event.attempts };
      }
      if (event.attempts >= MAX_WEBHOOK_ATTEMPTS) repositoryError("retry_exhausted");

      const claimed = await this.database.prepare(
        `UPDATE stripe_webhook_events
            SET status = 'processing', attempts = attempts + 1, last_error = NULL,
                received_at = @receivedAt, payload_json = @payloadJson,
                event_created_at = COALESCE(@eventCreatedAt, event_created_at),
                processed_at = @receivedAt, processing_token = @processingToken
          WHERE id = @id
            AND (
              status IN ('failed', 'pending')
              OR (status = 'processing' AND (processed_at IS NULL OR processed_at <= @staleBefore))
            )`,
      ).run({ id, receivedAt, payloadJson, eventCreatedAt, processingToken, staleBefore });
      if (claimed.changes !== 1) {
        return { state: "in_progress", processingToken: null, attempts: event.attempts };
      }
      return { state: "claimed", processingToken, attempts: event.attempts + 1 };
    }));
  }

  async markWebhookEventFailed(input: {
    id: string;
    processingToken: string;
    failedAt: string;
    error: string;
  }): Promise<boolean> {
    const id = requireText(input.id);
    const processingToken = requireText(input.processingToken, 128);
    const failedAt = requireCanonicalUtc(input.failedAt);
    if (typeof input.error !== "string") repositoryError("invalid_input");
    const error = String(redactSecrets(input.error))
      .replace(/\0/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || "Stripe event application failed";
    return this.translateFailure(async () => {
      const result = await this.database.prepare(
        `UPDATE stripe_webhook_events
            SET status = 'failed', processed_at = @failedAt, last_error = @error,
                processing_token = NULL
          WHERE id = @id AND status = 'processing' AND processing_token = @processingToken`,
      ).run({ id, processingToken, failedAt, error });
      return result.changes === 1;
    });
  }

  private assertEffectMatchesEvent(eventType: string, effect: StripeApplicationEffect): void {
    if (effect.kind === "checkout_grant" && ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(eventType)) repositoryError("event_conflict");
    if (effect.kind === "subscription_state" && ![
      "customer.subscription.deleted",
      "customer.subscription.updated",
      "invoice.payment_failed",
    ].includes(eventType)) repositoryError("event_conflict");
  }

  private async insertAudit(input: {
    eventId: string;
    discriminator: string;
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<void> {
    const metadataJson = serializeObject(input.metadata, MAX_METADATA_BYTES);
    await this.database.prepare(
      `INSERT INTO security_audit_log (
         id, actor_user_id, actor_role, action, target_type, target_id,
         metadata_json, ip_hash, user_agent_hash, created_at
       ) VALUES (
         @id, @actorUserId, @actorRole, @action, @targetType, @targetId,
         @metadataJson, NULL, NULL, @createdAt
       )`,
    ).run({
      ...input,
      id: deterministicId("audit", input.eventId, input.discriminator),
      metadataJson,
    });
  }

  private async insertAnalytics(input: {
    eventId: string;
    discriminator: string;
    userId: string | null;
    eventType: "subscription_created" | "subscription_cancelled";
    venueId: string | null;
    suburb: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<void> {
    const metadataJson = serializeObject(input.metadata, MAX_METADATA_BYTES);
    await this.database.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
         suburb, metadata_json, created_at
       ) VALUES (
         @id, @userId, NULL, @eventType, @venueId, NULL,
         @suburb, @metadataJson, @createdAt
       )`,
    ).run({
      ...input,
      id: deterministicId("analytics", input.eventId, input.discriminator),
      metadataJson,
    });
  }

  private async finalizeEvent(input: {
    id: string;
    processingToken: string;
    appliedAt: string;
  }): Promise<void> {
    const result = await this.database.prepare(
      `UPDATE stripe_webhook_events
          SET status = 'applied', applied_at = @appliedAt, processed_at = @appliedAt,
              last_error = NULL, processing_token = NULL
        WHERE id = @id AND status = 'processing' AND processing_token = @processingToken`,
    ).run(input);
    if (result.changes !== 1) repositoryError("event_claim_lost");
  }

  private result(input: {
    event: StripeWebhookEventRecord;
    outcome: StripeApplicationResult["outcome"];
    targetType?: StripeApplicationResult["targetType"];
    targetId?: string | null;
    account?: StripeAccountBillingState | null;
    venue?: StripeVenueBillingState | null;
  }): StripeApplicationResult {
    return {
      eventId: input.event.id,
      eventType: input.event.eventType,
      eventCreatedAt: input.event.eventCreatedAt,
      outcome: input.outcome,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      account: input.account ?? null,
      venue: input.venue ?? null,
    };
  }

  private async acknowledge(
    event: StripeWebhookEventRecord,
    effect: Extract<StripeApplicationEffect, { kind: "acknowledge" }>,
    appliedAt: string,
  ): Promise<void> {
    const actions: Readonly<Partial<Record<StripeAcknowledgementReason, string>>> = {
      checkout_authority_rejected: "stripe_checkout_authority_rejected",
      checkout_unsettled: "stripe_checkout_unsettled",
      checkout_async_payment_failed: "stripe_checkout_async_payment_failed",
    };
    const action = actions[effect.reason];
    if (!action) return;
    await this.insertAudit({
      eventId: event.id,
      discriminator: effect.reason,
      actorUserId: null,
      actorRole: null,
      action,
      targetType: "stripe_checkout",
      targetId: effect.targetId ?? null,
      metadata: { ...effect.metadata, eventType: event.eventType },
      createdAt: appliedAt,
    });
  }

  private async applyAccountCheckout(input: {
    event: StripeWebhookEventRecord;
    effect: Extract<StripeApplicationEffect, { kind: "checkout_grant" }>;
    resolvedTarget: ResolvedApplicationTarget;
    appliedAt: string;
  }): Promise<StripeApplicationResult> {
    const target = input.effect.target;
    if (
      target.kind !== "account"
      || input.resolvedTarget.kind !== "account"
      || input.resolvedTarget.accountId !== target.userId
    ) repositoryError("billing_identity_conflict");
    const accountRow = input.resolvedTarget.account;
    if (accountRow.authProvider === "deleted" || Boolean(accountRow.deletionLocked)) {
      await this.insertAudit({
        eventId: input.event.id,
        discriminator: "deleted-account",
        actorUserId: null,
        actorRole: null,
        action: "stripe_event_ignored_deleted_account",
        targetType: "account_tombstone",
        targetId: target.userId,
        metadata: { eventType: input.event.eventType },
        createdAt: input.appliedAt,
      });
      return this.result({
        event: input.event,
        outcome: "deleted_account",
        targetType: "account",
        targetId: target.userId,
      });
    }
    const eventCreatedAt = input.event.eventCreatedAt ?? repositoryError("event_timestamp_required");
    if (eventOrdering(accountRow.stripeEventCreatedAt, eventCreatedAt, input.effect.authorityConfirmed) === "stale") {
      return this.result({ event: input.event, outcome: "stale", targetType: "account", targetId: target.userId });
    }

    const mutation = await this.database.prepare(
      `UPDATE accounts
          SET subscription_status = @subscriptionStatus,
              stripe_paid_subscription_status = @paidStatus,
              stripe_customer_id = COALESCE(@stripeCustomerId, stripe_customer_id),
              premium_until = NULL,
              stripe_event_created_at = @eventCreatedAt,
              updated_at = @appliedAt
        WHERE id = @userId
          AND auth_provider <> 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_requests deletion
             WHERE deletion.user_id = accounts.id
               AND deletion.status IN ('processing', 'failed', 'completed')
          )`,
    ).run({
      userId: target.userId,
      subscriptionStatus: target.paidStatus,
      paidStatus: target.paidStatus,
      stripeCustomerId: input.effect.stripeCustomerId,
      eventCreatedAt,
      appliedAt: input.appliedAt,
    });
    if (mutation.changes !== 1) {
      const current = await this.accountById(target.userId);
      if (current && (current.authProvider === "deleted" || Boolean(current.deletionLocked))) {
        await this.insertAudit({
          eventId: input.event.id,
          discriminator: "deleted-account",
          actorUserId: null,
          actorRole: null,
          action: "stripe_event_ignored_deleted_account",
          targetType: "account_tombstone",
          targetId: target.userId,
          metadata: { eventType: input.event.eventType },
          createdAt: input.appliedAt,
        });
        return this.result({
          event: input.event,
          outcome: "deleted_account",
          targetType: "account",
          targetId: target.userId,
        });
      }
      repositoryError("persistence_failure");
    }
    const updatedRow = await this.accountById(target.userId);
    if (!updatedRow) repositoryError("persistence_failure");
    const updated = toAccountState(updatedRow);
    await this.insertAnalytics({
      eventId: input.event.id,
      discriminator: "account-created",
      userId: updated.id,
      eventType: "subscription_created",
      venueId: null,
      suburb: null,
      metadata: { mode: "stripe", subscriptionStatus: updated.subscriptionStatus },
      createdAt: input.appliedAt,
    });
    await this.insertAudit({
      eventId: input.event.id,
      discriminator: "account-update",
      actorUserId: updated.id,
      actorRole: updated.role,
      action: "stripe_subscription_update",
      targetType: "account",
      targetId: updated.id,
      metadata: { eventType: input.event.eventType, subscriptionStatus: updated.subscriptionStatus },
      createdAt: input.appliedAt,
    });
    return this.result({
      event: input.event,
      outcome: "account_applied",
      targetType: "account",
      targetId: updated.id,
      account: updated,
    });
  }

  private async applyVenueCheckout(input: {
    event: StripeWebhookEventRecord;
    effect: Extract<StripeApplicationEffect, { kind: "checkout_grant" }>;
    resolvedTarget: ResolvedApplicationTarget;
    appliedAt: string;
  }): Promise<StripeApplicationResult> {
    const target = input.effect.target;
    if (
      target.kind !== "venue"
      || input.resolvedTarget.kind !== "venue"
      || input.resolvedTarget.billingProfileVenueId !== target.venueId
    ) repositoryError("billing_identity_conflict");
    const venueRow = input.resolvedTarget.venue;
    const eventCreatedAt = input.event.eventCreatedAt ?? repositoryError("event_timestamp_required");
    if (eventOrdering(venueRow.stripeEventCreatedAt, eventCreatedAt, input.effect.authorityConfirmed) === "stale") {
      return this.result({ event: input.event, outcome: "stale", targetType: "venue", targetId: target.venueId });
    }
    if (Boolean(venueRow.tierManualOverride)) {
      await this.insertAudit({
        eventId: input.event.id,
        discriminator: "venue-manual-override",
        actorUserId: null,
        actorRole: null,
        action: "stripe_subscription_update",
        targetType: "venue",
        targetId: target.venueId,
        metadata: { eventType: input.event.eventType, tier: "pro", status: input.effect.providerStatus, manualOverride: true },
        createdAt: input.appliedAt,
      });
      return this.result({
        event: input.event,
        outcome: "manual_override",
        targetType: "venue",
        targetId: target.venueId,
        venue: toVenueState(venueRow),
      });
    }
    await this.database.prepare(
      `UPDATE venue_profiles
          SET membership_tier = 'pro', stripe_paid_membership_tier = 'pro',
              stripe_customer_id = COALESCE(@stripeCustomerId, stripe_customer_id),
              stripe_subscription_id = COALESCE(@stripeSubscriptionId, stripe_subscription_id),
              intro_trial_ever_claimed = CASE
                WHEN @stripeCustomerId IS NOT NULL OR @stripeSubscriptionId IS NOT NULL THEN @truth
                ELSE intro_trial_ever_claimed
              END,
              subscription_status = @providerStatus,
              subscription_current_period_end = @periodEnd,
              highlighted_name = @truth, premium_badge = 'Pro', promoted = @truth,
              featured_special_eligible = @truth,
              stripe_event_created_at = @eventCreatedAt, updated_at = @appliedAt
        WHERE venue_id = @venueId AND tier_manual_override = @falsity`,
    ).run({
      venueId: target.venueId,
      stripeCustomerId: input.effect.stripeCustomerId,
      stripeSubscriptionId: input.effect.stripeSubscriptionId,
      providerStatus: input.effect.providerStatus,
      periodEnd: input.effect.subscriptionCurrentPeriodEnd,
      eventCreatedAt,
      appliedAt: input.appliedAt,
      truth: this.database.dialect === "postgres" ? true : 1,
      falsity: this.database.dialect === "postgres" ? false : 0,
    });
    const updatedRow = await this.venueById(target.venueId);
    if (!updatedRow) repositoryError("persistence_failure");
    const updated = toVenueState(updatedRow);
    await this.insertAnalytics({
      eventId: input.event.id,
      discriminator: "venue-created",
      userId: null,
      eventType: "subscription_created",
      venueId: updated.venueId,
      suburb: null,
      metadata: { mode: "stripe", billingContext: "venue", tier: "pro" },
      createdAt: input.appliedAt,
    });
    await this.insertAudit({
      eventId: input.event.id,
      discriminator: "venue-update",
      actorUserId: null,
      actorRole: null,
      action: "stripe_subscription_update",
      targetType: "venue",
      targetId: updated.venueId,
      metadata: { eventType: input.event.eventType, tier: "pro", status: input.effect.providerStatus },
      createdAt: input.appliedAt,
    });
    return this.result({
      event: input.event,
      outcome: "venue_applied",
      targetType: "venue",
      targetId: updated.venueId,
      venue: updated,
    });
  }

  private async applySubscriptionState(input: {
    event: StripeWebhookEventRecord;
    effect: Extract<StripeApplicationEffect, { kind: "subscription_state" }>;
    resolvedTarget: ResolvedApplicationTarget;
    appliedAt: string;
  }): Promise<StripeApplicationResult> {
    const eventCreatedAt = input.event.eventCreatedAt ?? repositoryError("event_timestamp_required");
    const venueRow = input.resolvedTarget.kind === "venue" ? input.resolvedTarget.venue : null;
    if (venueRow) {
      if (eventOrdering(venueRow.stripeEventCreatedAt, eventCreatedAt, input.effect.authorityConfirmed) === "stale") {
        return this.result({
          event: input.event,
          outcome: "stale",
          targetType: "venue",
          targetId: venueRow.venueId,
        });
      }
      if (Boolean(venueRow.tierManualOverride)) {
        await this.insertAudit({
          eventId: input.event.id,
          discriminator: "venue-manual-override",
          actorUserId: null,
          actorRole: null,
          action: input.effect.grantEligible ? "stripe_subscription_update" : "stripe_subscription_downgrade",
          targetType: "venue",
          targetId: venueRow.venueId,
          metadata: {
            eventType: input.event.eventType,
            stripeStatus: input.effect.providerStatus,
            shouldDowngrade: !input.effect.grantEligible,
            intendedTier: input.effect.intendedVenuePaidTier,
            manualOverride: true,
          },
          createdAt: input.appliedAt,
        });
        return this.result({
          event: input.event,
          outcome: "manual_override",
          targetType: "venue",
          targetId: venueRow.venueId,
          venue: toVenueState(venueRow),
        });
      }
      const currentTier = normalizeVenueTier(venueRow.membershipTier);
      const intendedTier = input.effect.intendedVenuePaidTier
        ?? normalizePaidVenueTier(venueRow.stripePaidMembershipTier)
        ?? (currentTier === "pro" ? "pro" : null);
      const nextTier = input.effect.grantEligible ? intendedTier ?? currentTier : "basic";
      const nextPaidTier = input.effect.intendedVenuePaidTier ?? normalizePaidVenueTier(venueRow.stripePaidMembershipTier);
      const pro = nextTier === "pro";
      await this.database.prepare(
        `UPDATE venue_profiles
            SET membership_tier = @nextTier,
                stripe_paid_membership_tier = @nextPaidTier,
                stripe_customer_id = COALESCE(@stripeCustomerId, stripe_customer_id),
                stripe_subscription_id = COALESCE(@stripeSubscriptionId, stripe_subscription_id),
                intro_trial_ever_claimed = CASE
                  WHEN @stripeCustomerId IS NOT NULL OR @stripeSubscriptionId IS NOT NULL THEN @truth
                  ELSE intro_trial_ever_claimed
                END,
                subscription_status = @providerStatus,
                subscription_current_period_end = @periodEnd,
                highlighted_name = @pro, premium_badge = @premiumBadge,
                promoted = @pro, featured_special_eligible = @pro,
                stripe_event_created_at = @eventCreatedAt, updated_at = @appliedAt
          WHERE venue_id = @venueId AND tier_manual_override = @falsity`,
      ).run({
        venueId: venueRow.venueId,
        nextTier,
        nextPaidTier,
        stripeCustomerId: input.effect.stripeCustomerId,
        stripeSubscriptionId: input.effect.stripeSubscriptionId,
        providerStatus: input.effect.providerStatus ?? "inactive_or_unknown",
        periodEnd: input.effect.grantEligible ? input.effect.subscriptionCurrentPeriodEnd : null,
        pro: this.database.dialect === "postgres" ? pro : pro ? 1 : 0,
        premiumBadge: pro ? "Pro" : null,
        eventCreatedAt,
        appliedAt: input.appliedAt,
        truth: this.database.dialect === "postgres" ? true : 1,
        falsity: this.database.dialect === "postgres" ? false : 0,
      });
      const updatedRow = await this.venueById(venueRow.venueId);
      if (!updatedRow) repositoryError("persistence_failure");
      const updated = toVenueState(updatedRow);
      if (!input.effect.grantEligible) {
        await this.insertAnalytics({
          eventId: input.event.id,
          discriminator: "venue-cancelled",
          userId: null,
          eventType: "subscription_cancelled",
          venueId: updated.venueId,
          suburb: updated.suburb,
          metadata: { mode: "stripe", billingContext: "venue" },
          createdAt: input.appliedAt,
        });
      }
      await this.insertAudit({
        eventId: input.event.id,
        discriminator: input.effect.grantEligible ? "venue-update" : "venue-downgrade",
        actorUserId: null,
        actorRole: null,
        action: input.effect.grantEligible ? "stripe_subscription_update" : "stripe_subscription_downgrade",
        targetType: "venue",
        targetId: updated.venueId,
        metadata: {
          eventType: input.event.eventType,
          stripeStatus: input.effect.providerStatus,
          shouldDowngrade: !input.effect.grantEligible,
          intendedTier,
        },
        createdAt: input.appliedAt,
      });
      return this.result({
        event: input.event,
        outcome: "venue_applied",
        targetType: "venue",
        targetId: updated.venueId,
        venue: updated,
      });
    }

    const accountRow = input.resolvedTarget.kind === "account" ? input.resolvedTarget.account : null;
    if (!accountRow) {
      await this.insertAudit({
        eventId: input.event.id,
        discriminator: "billing-target-not-found",
        actorUserId: null,
        actorRole: null,
        action: "stripe_event_target_not_found",
        targetType: "stripe_billing_identity",
        targetId: null,
        metadata: {
          eventType: input.event.eventType,
          hadCustomerId: Boolean(input.effect.stripeCustomerId),
          hadSubscriptionId: Boolean(input.effect.stripeSubscriptionId),
        },
        createdAt: input.appliedAt,
      });
      return this.result({ event: input.event, outcome: "target_not_found" });
    }
    if (accountRow.authProvider === "deleted" || Boolean(accountRow.deletionLocked)) {
      await this.insertAudit({
        eventId: input.event.id,
        discriminator: "deleted-account",
        actorUserId: null,
        actorRole: null,
        action: "stripe_event_ignored_deleted_account",
        targetType: "account_tombstone",
        targetId: accountRow.id,
        metadata: { eventType: input.event.eventType },
        createdAt: input.appliedAt,
      });
      return this.result({
        event: input.event,
        outcome: "deleted_account",
        targetType: "account",
        targetId: accountRow.id,
      });
    }
    if (eventOrdering(accountRow.stripeEventCreatedAt, eventCreatedAt, input.effect.authorityConfirmed) === "stale") {
      return this.result({ event: input.event, outcome: "stale", targetType: "account", targetId: accountRow.id });
    }
    const currentStatus = requireSubscriptionStatus(accountRow.subscriptionStatus);
    const nextStatus: SubscriptionStatus = input.effect.grantEligible
      ? input.effect.intendedAccountPaidStatus ?? currentStatus
      : "free";
    const nextPaidStatus = input.effect.intendedAccountPaidStatus
      ?? optionalPaidStatus(accountRow.stripePaidSubscriptionStatus);
    const mutation = await this.database.prepare(
      `UPDATE accounts
          SET subscription_status = @nextStatus,
              stripe_paid_subscription_status = @nextPaidStatus,
              premium_until = @premiumUntil,
              stripe_event_created_at = @eventCreatedAt,
              updated_at = @appliedAt
        WHERE id = @userId
          AND auth_provider <> 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM account_deletion_requests deletion
             WHERE deletion.user_id = accounts.id
               AND deletion.status IN ('processing', 'failed', 'completed')
          )`,
    ).run({
      userId: accountRow.id,
      nextStatus,
      nextPaidStatus,
      premiumUntil: input.effect.subscriptionCurrentPeriodEnd,
      eventCreatedAt,
      appliedAt: input.appliedAt,
    });
    if (mutation.changes !== 1) {
      const current = await this.accountById(accountRow.id);
      if (current && (current.authProvider === "deleted" || Boolean(current.deletionLocked))) {
        await this.insertAudit({
          eventId: input.event.id,
          discriminator: "deleted-account",
          actorUserId: null,
          actorRole: null,
          action: "stripe_event_ignored_deleted_account",
          targetType: "account_tombstone",
          targetId: accountRow.id,
          metadata: { eventType: input.event.eventType },
          createdAt: input.appliedAt,
        });
        return this.result({
          event: input.event,
          outcome: "deleted_account",
          targetType: "account",
          targetId: accountRow.id,
        });
      }
      repositoryError("persistence_failure");
    }
    const updatedRow = await this.accountById(accountRow.id);
    if (!updatedRow) repositoryError("persistence_failure");
    const updated = toAccountState(updatedRow);
    if (!input.effect.grantEligible) {
      await this.insertAnalytics({
        eventId: input.event.id,
        discriminator: "account-cancelled",
        userId: updated.id,
        eventType: "subscription_cancelled",
        venueId: null,
        suburb: null,
        metadata: { mode: "stripe" },
        createdAt: input.appliedAt,
      });
    }
    await this.insertAudit({
      eventId: input.event.id,
      discriminator: input.effect.grantEligible ? "account-update" : "account-downgrade",
      actorUserId: updated.id,
      actorRole: updated.role,
      action: input.effect.grantEligible ? "stripe_subscription_update" : "stripe_subscription_downgrade",
      targetType: "account",
      targetId: updated.id,
      metadata: {
        eventType: input.event.eventType,
        stripeStatus: input.effect.providerStatus,
        shouldDowngrade: !input.effect.grantEligible,
        intendedStatus: input.effect.intendedAccountPaidStatus,
      },
      createdAt: input.appliedAt,
    });
    return this.result({
      event: input.event,
      outcome: "account_applied",
      targetType: "account",
      targetId: updated.id,
      account: updated,
    });
  }

  async applyClaimedEvent(input: {
    id: string;
    processingToken: string;
    appliedAt: string;
    effect: StripeApplicationEffect;
  }): Promise<StripeApplicationResult> {
    const id = requireText(input.id);
    const processingToken = requireText(input.processingToken, 128);
    const appliedAt = requireCanonicalUtc(input.appliedAt);
    const effect = normalizeEffect(input.effect);

    return this.translateFailure(this.database.transaction(async () => {
      const preflightRow = await this.webhookEvent(id, false);
      if (!preflightRow) repositoryError("event_claim_lost");
      const preflightEvent = toWebhookEvent(preflightRow);
      if (preflightEvent.status === "applied") {
        return this.result({ event: preflightEvent, outcome: "already_applied" });
      }
      this.assertEffectMatchesEvent(preflightEvent.eventType, effect);
      if (effect.kind !== "acknowledge" && !preflightEvent.eventCreatedAt) {
        repositoryError("event_timestamp_required");
      }
      const preflightTarget = effect.kind === "acknowledge"
        ? ({ kind: "none" } as const)
        : await this.resolveApplicationTarget(effect, false);

      await this.advisoryLocks(this.applicationLockKeys(id, effect));
      const lockedTarget = effect.kind === "acknowledge"
        ? ({ kind: "none" } as const)
        : await this.resolveApplicationTarget(effect, true);
      if (this.targetFingerprint(preflightTarget) !== this.targetFingerprint(lockedTarget)) {
        repositoryError("billing_identity_conflict");
      }

      const persisted = await this.webhookEvent(id, true);
      if (!persisted) repositoryError("event_claim_lost");
      const event = toWebhookEvent(persisted);
      if (
        event.eventType !== preflightEvent.eventType
        || event.eventCreatedAt !== preflightEvent.eventCreatedAt
      ) repositoryError("event_conflict");
      if (event.status === "applied") {
        return this.result({ event, outcome: "already_applied" });
      }
      if (event.status !== "processing" || event.processingToken !== processingToken) {
        repositoryError("event_claim_lost");
      }
      this.assertEffectMatchesEvent(event.eventType, effect);

      let result: StripeApplicationResult;
      if (effect.kind === "acknowledge") {
        await this.acknowledge(event, effect, appliedAt);
        result = this.result({ event, outcome: "acknowledged" });
      } else if (effect.kind === "checkout_grant") {
        result = effect.target.kind === "account"
          ? await this.applyAccountCheckout({ event, effect, resolvedTarget: lockedTarget, appliedAt })
          : await this.applyVenueCheckout({ event, effect, resolvedTarget: lockedTarget, appliedAt });
      } else {
        result = await this.applySubscriptionState({ event, effect, resolvedTarget: lockedTarget, appliedAt });
      }
      await this.finalizeEvent({ id, processingToken, appliedAt });
      return result;
    }));
  }
}
