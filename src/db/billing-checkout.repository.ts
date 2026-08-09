import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESERVATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MAX_RESERVATION_TTL_MS = 24 * 60 * 60_000;
const MAX_VENUE_IDENTITY_ROWS = 256;

export const BILLING_CHECKOUT_LOCK_CONTRACT = Object.freeze({
  version: 1,
  actorPrefix: "billing-checkout:actor:",
  consumerSubjectPrefix: "billing-checkout:subject:consumer:",
  venueSubjectPrefix: "billing-checkout:subject:venue:",
  order: "sorted-advisory-locks-before-account-rows-before-subject-rows",
} as const);

export type BillingCheckoutSubjectType = "consumer" | "venue";
export type BillingCheckoutProductKey =
  | "consumer:monthly"
  | "consumer:yearly"
  | "venue:pro:paid"
  | "venue:pro:trial:30"
  | "venue:pro:trial:60";

export type BillingCheckoutRepositoryErrorCode =
  | "account_not_found"
  | "deletion_locked"
  | "finalization_conflict"
  | "intro_trial_already_claimed"
  | "invalid_input"
  | "persistence_failure"
  | "reservation_expired"
  | "reservation_not_found"
  | "reservation_token_conflict"
  | "stale_reservation"
  | "venue_identity_conflict"
  | "venue_not_found";

const ERROR_MESSAGES: Readonly<Record<BillingCheckoutRepositoryErrorCode, string>> = {
  account_not_found: "The billing actor account does not exist.",
  deletion_locked: "Billing changes are unavailable while account deletion is being processed.",
  finalization_conflict: "The checkout reservation was already finalized with different provider details.",
  intro_trial_already_claimed: "The venue identity has already claimed its introductory trial.",
  invalid_input: "The billing checkout persistence input is invalid.",
  persistence_failure: "Billing checkout persistence could not be completed.",
  reservation_expired: "The checkout reservation expired before it could be finalized.",
  reservation_not_found: "The checkout reservation does not exist.",
  reservation_token_conflict: "The checkout reservation token is already assigned.",
  stale_reservation: "The checkout reservation changed before this operation completed.",
  venue_identity_conflict: "The venue billing identity changed during this operation.",
  venue_not_found: "The venue billing identity does not have a venue profile.",
};

/** Stable, secret-free failures for future service/HTTP error mapping. */
export class BillingCheckoutRepositoryError extends Error {
  readonly code: BillingCheckoutRepositoryErrorCode;

  constructor(code: BillingCheckoutRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BillingCheckoutRepositoryError";
    this.code = code;
  }
}

export interface BillingCheckoutReservationRecord {
  subjectType: BillingCheckoutSubjectType;
  subjectId: string;
  productKey: BillingCheckoutProductKey;
  reservationToken: string;
  stripeCheckoutSessionId: string | null;
  checkoutUrl: string | null;
  status: "reserved" | "finalized";
  expired: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface VenueIntroTrialMarkResult {
  outcome: "marked" | "already_claimed";
  canonicalVenueId: string;
  venueIds: string[];
  updatedProfiles: number;
}

interface ReservationRow {
  subjectType: unknown;
  subjectId: unknown;
  productKey: unknown;
  reservationToken: unknown;
  stripeCheckoutSessionId: unknown;
  checkoutUrl: unknown;
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ActorRow {
  id: unknown;
  authProvider: unknown;
  deletionLocked: unknown;
}

interface VenueAliasRow {
  aliasVenueId: unknown;
  canonicalVenueId: unknown;
}

interface VenueTrialRow {
  venueId: unknown;
  introTrialEverClaimed: unknown;
}

interface VenueIdentity {
  canonicalVenueId: string;
  venueIds: string[];
  profiles: Array<{ venueId: string; introTrialEverClaimed: boolean }>;
}

function repositoryError(code: BillingCheckoutRepositoryErrorCode): never {
  throw new BillingCheckoutRepositoryError(code);
}

export function billingCheckoutActorLockKey(actorAccountId: string): string {
  return `${BILLING_CHECKOUT_LOCK_CONTRACT.actorPrefix}${requireText(actorAccountId)}`;
}

export function billingCheckoutConsumerSubjectLockKey(subjectAccountId: string): string {
  return `${BILLING_CHECKOUT_LOCK_CONTRACT.consumerSubjectPrefix}${requireText(subjectAccountId)}`;
}

export function billingCheckoutVenueSubjectLockKey(canonicalVenueId: string): string {
  return `${BILLING_CHECKOUT_LOCK_CONTRACT.venueSubjectPrefix}${requireText(canonicalVenueId)}`;
}

function requireText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("invalid_input");
  }
  return normalized;
}

function persistedText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("persistence_failure");
  }
  return normalized;
}

function optionalPersistedText(value: unknown, maximum = 255): string | null {
  return value == null ? null : persistedText(value, maximum);
}

function requireCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("invalid_input");
    }
    return value;
  } catch {
    return repositoryError("invalid_input");
  }
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

function requireSubjectType(value: unknown): BillingCheckoutSubjectType {
  if (value !== "consumer" && value !== "venue") return repositoryError("invalid_input");
  return value;
}

function requireProductKey(
  value: unknown,
  subjectType: BillingCheckoutSubjectType,
): BillingCheckoutProductKey {
  const productKey = requireText(value, 64);
  const allowed = subjectType === "consumer"
    ? productKey === "consumer:monthly" || productKey === "consumer:yearly"
    : productKey === "venue:pro:paid"
      || productKey === "venue:pro:trial:30"
      || productKey === "venue:pro:trial:60";
  if (!allowed) return repositoryError("invalid_input");
  return productKey as BillingCheckoutProductKey;
}

function persistedProductKey(value: unknown, subjectType: BillingCheckoutSubjectType): BillingCheckoutProductKey {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  const allowed = subjectType === "consumer"
    ? value === "consumer:monthly" || value === "consumer:yearly"
    : value === "venue:pro:paid" || value === "venue:pro:trial:30" || value === "venue:pro:trial:60";
  if (!allowed) return repositoryError("persistence_failure");
  return value as BillingCheckoutProductKey;
}

function requireReservationToken(value: unknown): string {
  const token = requireText(value, 128);
  if (!RESERVATION_TOKEN.test(token)) return repositoryError("invalid_input");
  return token;
}

function persistedBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return repositoryError("persistence_failure");
}

function requireCheckoutUrl(value: unknown): string {
  const urlText = requireText(value, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return repositoryError("invalid_input");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return repositoryError("invalid_input");
  }
  return urlText;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

function toReservation(row: ReservationRow, asOf: string): BillingCheckoutReservationRecord {
  const subjectType = row.subjectType === "consumer" || row.subjectType === "venue"
    ? row.subjectType
    : repositoryError("persistence_failure");
  const subjectId = persistedText(row.subjectId);
  const productKey = persistedProductKey(row.productKey, subjectType);
  const reservationToken = persistedText(row.reservationToken, 128);
  if (!RESERVATION_TOKEN.test(reservationToken)) return repositoryError("persistence_failure");
  const stripeCheckoutSessionId = optionalPersistedText(row.stripeCheckoutSessionId);
  const checkoutUrl = optionalPersistedText(row.checkoutUrl, 2_048);
  if (stripeCheckoutSessionId !== null && checkoutUrl === null) {
    return repositoryError("persistence_failure");
  }
  const expiresAt = persistedCanonicalUtc(row.expiresAt);
  const createdAt = persistedCanonicalUtc(row.createdAt);
  const updatedAt = persistedCanonicalUtc(row.updatedAt);
  return {
    subjectType,
    subjectId,
    productKey,
    reservationToken,
    stripeCheckoutSessionId,
    checkoutUrl,
    status: checkoutUrl === null ? "reserved" : "finalized",
    expired: expiresAt <= asOf,
    expiresAt,
    createdAt,
    updatedAt,
  };
}

const RESERVATION_PROJECTION = `
  reservation.subject_type AS "subjectType",
  reservation.subject_id AS "subjectId",
  reservation.product_key AS "productKey",
  reservation.reservation_token AS "reservationToken",
  reservation.stripe_checkout_session_id AS "stripeCheckoutSessionId",
  reservation.checkout_url AS "checkoutUrl",
  reservation.expires_at AS "expiresAt",
  reservation.created_at AS "createdAt",
  reservation.updated_at AS "updatedAt"`;

/**
 * PostgreSQL-native checkout persistence. Provider calls and all commercial
 * launch decisions remain in the service layer.
 *
 * Lock contract for every mutation:
 *   1. acquire sorted transaction-scoped advisory locks for actor + subject;
 *   2. lock and validate the actor account/deletion state;
 *   3. lock venue identity/profile rows when the subject is a venue;
 *   4. lock/mutate the reservation (or venue trial flags) conditionally;
 *   5. re-check the deletion lock immediately before commit.
 *
 * Account-deletion writers use the same `billing-checkout:actor:<id>` advisory
 * lock; every future account-deletion transition must preserve that union.
 * Venue-identity writers must likewise lock both old/new canonical
 * `billing-checkout:subject:venue:<id>` keys before alias insertion/re-homing;
 * row locks cannot fence a not-yet-existing alias.
 */
export class BillingCheckoutRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translateFailure<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BillingCheckoutRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new BillingCheckoutRepositoryError("reservation_token_conflict");
      throw new BillingCheckoutRepositoryError("persistence_failure");
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

  private async actor(actorAccountId: string): Promise<ActorRow | null> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id", account.auth_provider AS "authProvider",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${this.lockSuffix("account")}`,
    ).get<ActorRow>(actorAccountId);
    return row ?? null;
  }

  private async assertMutableActor(actorAccountId: string): Promise<void> {
    const row = await this.actor(actorAccountId);
    if (!row) return repositoryError("account_not_found");
    persistedText(row.id);
    const authProvider = persistedText(row.authProvider, 64);
    if (authProvider === "deleted" || persistedBoolean(row.deletionLocked)) {
      return repositoryError("deletion_locked");
    }
  }

  private async assertDeletionStillUnlocked(actorAccountId: string): Promise<void> {
    const row = await this.database.prepare(
      `SELECT account.auth_provider AS "authProvider",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account WHERE account.id = ?`,
    ).get<{ authProvider: unknown; deletionLocked: unknown }>(actorAccountId);
    if (!row) return repositoryError("account_not_found");
    if (persistedText(row.authProvider, 64) === "deleted" || persistedBoolean(row.deletionLocked)) {
      return repositoryError("deletion_locked");
    }
  }

  private async lookupCanonicalVenueId(venueId: string, lock: boolean): Promise<string> {
    const suffix = lock ? this.lockSuffix("alias") : "";
    const row = await this.database.prepare(
      `SELECT alias.alias_venue_id AS "aliasVenueId",
              alias.canonical_venue_id AS "canonicalVenueId"
         FROM venue_identity_aliases alias
        WHERE alias.alias_venue_id = ?${suffix}`,
    ).get<VenueAliasRow>(venueId);
    if (!row) return venueId;
    if (persistedText(row.aliasVenueId) !== venueId) return repositoryError("persistence_failure");
    return persistedText(row.canonicalVenueId);
  }

  private async venueIdentity(
    requestedVenueId: string,
    expectedCanonicalVenueId: string,
    lock: boolean,
  ): Promise<VenueIdentity> {
    const canonicalVenueId = await this.lookupCanonicalVenueId(requestedVenueId, lock);
    if (canonicalVenueId !== expectedCanonicalVenueId) return repositoryError("venue_identity_conflict");
    const suffix = lock ? this.lockSuffix("alias") : "";
    const aliases = await this.database.prepare(
      `SELECT alias.alias_venue_id AS "aliasVenueId",
              alias.canonical_venue_id AS "canonicalVenueId"
         FROM venue_identity_aliases alias
        WHERE alias.canonical_venue_id = ?
        ORDER BY alias.alias_venue_id
        LIMIT ?${suffix}`,
    ).all<VenueAliasRow>(canonicalVenueId, MAX_VENUE_IDENTITY_ROWS + 1);
    if (aliases.length > MAX_VENUE_IDENTITY_ROWS) return repositoryError("venue_identity_conflict");
    const venueIds = Array.from(new Set([
      canonicalVenueId,
      ...aliases.map((row) => {
        if (persistedText(row.canonicalVenueId) !== canonicalVenueId) {
          return repositoryError("persistence_failure");
        }
        return persistedText(row.aliasVenueId);
      }),
    ])).sort();
    const placeholders = venueIds.map(() => "?").join(", ");
    const profileSuffix = lock ? this.lockSuffix("venue") : "";
    const profileRows = await this.database.prepare(
      `SELECT venue.venue_id AS "venueId",
              venue.intro_trial_ever_claimed AS "introTrialEverClaimed"
         FROM venue_profiles venue
        WHERE venue.venue_id IN (${placeholders})
        ORDER BY venue.venue_id${profileSuffix}`,
    ).all<VenueTrialRow>(...venueIds);
    if (profileRows.length === 0) return repositoryError("venue_not_found");
    const profiles = profileRows.map((row) => ({
      venueId: persistedText(row.venueId),
      introTrialEverClaimed: persistedBoolean(row.introTrialEverClaimed),
    }));
    return { canonicalVenueId, venueIds, profiles };
  }

  private async reservation(
    subjectType: BillingCheckoutSubjectType,
    subjectId: string,
    lock: boolean,
  ): Promise<ReservationRow | null> {
    const suffix = lock ? this.lockSuffix("reservation") : "";
    const row = await this.database.prepare(
      `SELECT ${RESERVATION_PROJECTION}
         FROM billing_checkout_reservations reservation
        WHERE reservation.subject_type = ? AND reservation.subject_id = ?${suffix}`,
    ).get<ReservationRow>(subjectType, subjectId);
    return row ?? null;
  }

  private async resolveSubjectForTransaction(input: {
    subjectType: BillingCheckoutSubjectType;
    subjectId: string;
    actorAccountId?: string | undefined;
  }): Promise<{ subjectId: string; venueIdentity: VenueIdentity | null }> {
    if (input.subjectType === "consumer") {
      if (input.actorAccountId !== undefined && input.actorAccountId !== input.subjectId) {
        return repositoryError("invalid_input");
      }
      await this.advisoryLocks([
        billingCheckoutActorLockKey(input.actorAccountId ?? input.subjectId),
        billingCheckoutConsumerSubjectLockKey(input.subjectId),
      ]);
      if (input.actorAccountId !== undefined) {
        await this.assertMutableActor(input.actorAccountId);
      }
      return { subjectId: input.subjectId, venueIdentity: null };
    }

    const initialCanonicalVenueId = await this.lookupCanonicalVenueId(input.subjectId, false);
    const lockKeys = [billingCheckoutVenueSubjectLockKey(initialCanonicalVenueId)];
    if (input.actorAccountId !== undefined) {
      lockKeys.push(billingCheckoutActorLockKey(input.actorAccountId));
    }
    await this.advisoryLocks(lockKeys);
    if (input.actorAccountId !== undefined) {
      await this.assertMutableActor(input.actorAccountId);
    }
    const venueIdentity = await this.venueIdentity(input.subjectId, initialCanonicalVenueId, true);
    return { subjectId: venueIdentity.canonicalVenueId, venueIdentity };
  }

  async claimBillingCheckoutReservation(input: {
    actorAccountId: string;
    subjectType: BillingCheckoutSubjectType;
    subjectId: string;
    productKey: BillingCheckoutProductKey;
    reservationToken: string;
    expiresAt: string;
    now: string;
  }): Promise<BillingCheckoutReservationRecord> {
    const actorAccountId = requireText(input.actorAccountId);
    const subjectType = requireSubjectType(input.subjectType);
    const subjectId = requireText(input.subjectId);
    const productKey = requireProductKey(input.productKey, subjectType);
    const reservationToken = requireReservationToken(input.reservationToken);
    const now = requireCanonicalUtc(input.now);
    const expiresAt = requireCanonicalUtc(input.expiresAt);
    const ttl = Date.parse(expiresAt) - Date.parse(now);
    if (ttl <= 0 || ttl > MAX_RESERVATION_TTL_MS) return repositoryError("invalid_input");

    return this.translateFailure(this.database.transaction(async () => {
      const resolved = await this.resolveSubjectForTransaction({ subjectType, subjectId, actorAccountId });
      const existingRow = await this.reservation(subjectType, resolved.subjectId, true);
      if (existingRow) {
        const existing = toReservation(existingRow, now);
        if (!existing.expired) {
          await this.assertDeletionStillUnlocked(actorAccountId);
          return existing;
        }
      }

      if (
        subjectType === "venue"
        && productKey.startsWith("venue:pro:trial:")
        && resolved.venueIdentity?.profiles.some((profile) => profile.introTrialEverClaimed)
      ) {
        return repositoryError("intro_trial_already_claimed");
      }

      if (existingRow) {
        const existing = toReservation(existingRow, now);
        const updated = await this.database.prepare(
          `UPDATE billing_checkout_reservations
              SET product_key = @productKey, reservation_token = @reservationToken,
                  stripe_checkout_session_id = NULL, checkout_url = NULL,
                  expires_at = @expiresAt, created_at = @now, updated_at = @now
            WHERE subject_type = @subjectType AND subject_id = @subjectId
              AND reservation_token = @expectedToken
              AND expires_at = @expectedExpiresAt
              AND updated_at = @expectedUpdatedAt
              AND expires_at <= @now`,
        ).run({
          subjectType,
          subjectId: resolved.subjectId,
          productKey,
          reservationToken,
          expiresAt,
          now,
          expectedToken: existing.reservationToken,
          expectedExpiresAt: existing.expiresAt,
          expectedUpdatedAt: existing.updatedAt,
        });
        if (updated.changes !== 1) return repositoryError("stale_reservation");
      } else {
        const inserted = await this.database.prepare(
          `INSERT INTO billing_checkout_reservations (
             subject_type, subject_id, product_key, reservation_token,
             stripe_checkout_session_id, checkout_url, expires_at, created_at, updated_at
           ) VALUES (
             @subjectType, @subjectId, @productKey, @reservationToken,
             NULL, NULL, @expiresAt, @now, @now
           ) ON CONFLICT(subject_type, subject_id) DO NOTHING`,
        ).run({ subjectType, subjectId: resolved.subjectId, productKey, reservationToken, expiresAt, now });
        if (inserted.changes !== 1) return repositoryError("stale_reservation");
      }

      await this.assertDeletionStillUnlocked(actorAccountId);
      const claimed = await this.reservation(subjectType, resolved.subjectId, false);
      if (!claimed) return repositoryError("persistence_failure");
      const reservation = toReservation(claimed, now);
      if (
        reservation.reservationToken !== reservationToken
        || reservation.productKey !== productKey
        || reservation.expiresAt !== expiresAt
        || reservation.status !== "reserved"
      ) return repositoryError("stale_reservation");
      return reservation;
    }));
  }

  async getBillingCheckoutReservation(input: {
    subjectType: BillingCheckoutSubjectType;
    subjectId: string;
    asOf: string;
  }): Promise<BillingCheckoutReservationRecord | null> {
    const subjectType = requireSubjectType(input.subjectType);
    const subjectId = requireText(input.subjectId);
    const asOf = requireCanonicalUtc(input.asOf);
    return this.translateFailure(this.database.transaction(async () => {
      const resolved = await this.resolveSubjectForTransaction({ subjectType, subjectId });
      const row = await this.reservation(subjectType, resolved.subjectId, false);
      return row ? toReservation(row, asOf) : null;
    }));
  }

  async finalizeBillingCheckoutReservation(input: {
    actorAccountId: string;
    subjectType: BillingCheckoutSubjectType;
    subjectId: string;
    reservationToken: string;
    stripeCheckoutSessionId: string | null;
    checkoutUrl: string;
    now: string;
  }): Promise<BillingCheckoutReservationRecord> {
    const actorAccountId = requireText(input.actorAccountId);
    const subjectType = requireSubjectType(input.subjectType);
    const subjectId = requireText(input.subjectId);
    const reservationToken = requireReservationToken(input.reservationToken);
    const stripeCheckoutSessionId = input.stripeCheckoutSessionId == null
      ? null
      : requireText(input.stripeCheckoutSessionId);
    const checkoutUrl = requireCheckoutUrl(input.checkoutUrl);
    const now = requireCanonicalUtc(input.now);

    return this.translateFailure(this.database.transaction(async () => {
      const resolved = await this.resolveSubjectForTransaction({ subjectType, subjectId, actorAccountId });
      const row = await this.reservation(subjectType, resolved.subjectId, true);
      if (!row) return repositoryError("reservation_not_found");
      const existing = toReservation(row, now);
      if (existing.reservationToken !== reservationToken) return repositoryError("stale_reservation");
      if (existing.status === "finalized") {
        if (
          existing.stripeCheckoutSessionId !== stripeCheckoutSessionId
          || existing.checkoutUrl !== checkoutUrl
        ) return repositoryError("finalization_conflict");
        await this.assertDeletionStillUnlocked(actorAccountId);
        return existing;
      }
      if (existing.expired) return repositoryError("reservation_expired");

      const updated = await this.database.prepare(
        `UPDATE billing_checkout_reservations
            SET stripe_checkout_session_id = @stripeCheckoutSessionId,
                checkout_url = @checkoutUrl, updated_at = @now
          WHERE subject_type = @subjectType AND subject_id = @subjectId
            AND reservation_token = @reservationToken
            AND checkout_url IS NULL AND stripe_checkout_session_id IS NULL
            AND expires_at > @now`,
      ).run({
        subjectType,
        subjectId: resolved.subjectId,
        reservationToken,
        stripeCheckoutSessionId,
        checkoutUrl,
        now,
      });
      if (updated.changes !== 1) return repositoryError("stale_reservation");
      await this.assertDeletionStillUnlocked(actorAccountId);
      const finalizedRow = await this.reservation(subjectType, resolved.subjectId, false);
      if (!finalizedRow) return repositoryError("persistence_failure");
      const finalized = toReservation(finalizedRow, now);
      if (
        finalized.status !== "finalized"
        || finalized.reservationToken !== reservationToken
        || finalized.stripeCheckoutSessionId !== stripeCheckoutSessionId
        || finalized.checkoutUrl !== checkoutUrl
      ) return repositoryError("stale_reservation");
      return finalized;
    }));
  }

  async hasVenueIntroTrialEverClaimed(input: {
    venueId: string;
    asOf: string;
  }): Promise<boolean> {
    const venueId = requireText(input.venueId);
    requireCanonicalUtc(input.asOf);
    return this.translateFailure(this.database.transaction(async () => {
      const resolved = await this.resolveSubjectForTransaction({ subjectType: "venue", subjectId: venueId });
      return resolved.venueIdentity!.profiles.some((profile) => profile.introTrialEverClaimed);
    }));
  }

  async markVenueIntroTrialEverClaimed(input: {
    actorAccountId: string;
    venueId: string;
    now: string;
  }): Promise<VenueIntroTrialMarkResult> {
    const actorAccountId = requireText(input.actorAccountId);
    const venueId = requireText(input.venueId);
    const now = requireCanonicalUtc(input.now);
    return this.translateFailure(this.database.transaction(async () => {
      const resolved = await this.resolveSubjectForTransaction({
        subjectType: "venue",
        subjectId: venueId,
        actorAccountId,
      });
      const identity = resolved.venueIdentity!;
      const placeholders = identity.venueIds.map(() => "?").join(", ");
      const unclaimedPredicate = this.database.dialect === "postgres"
        ? "intro_trial_ever_claimed IS FALSE"
        : "intro_trial_ever_claimed = 0";
      const truth = this.database.dialect === "postgres" ? true : 1;
      const updated = await this.database.prepare(
        `UPDATE venue_profiles
            SET intro_trial_ever_claimed = ?, updated_at = ?
          WHERE venue_id IN (${placeholders}) AND ${unclaimedPredicate}`,
      ).run(truth, now, ...identity.venueIds);
      await this.assertDeletionStillUnlocked(actorAccountId);
      return {
        outcome: updated.changes === 0 ? "already_claimed" : "marked",
        canonicalVenueId: identity.canonicalVenueId,
        venueIds: identity.venueIds,
        updatedProfiles: updated.changes,
      };
    }));
  }
}
