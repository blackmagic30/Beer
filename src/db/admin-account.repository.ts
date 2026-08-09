import {
  BILLING_CHECKOUT_LOCK_CONTRACT,
  billingCheckoutActorLockKey,
} from "./billing-checkout.repository.js";
import type {
  AccountRole,
  AccountStatus,
  AgeVerificationStatus,
  BusinessAccount,
  PaidSubscriptionStatus,
  SubscriptionStatus,
} from "./business.repository.js";
import {
  MISSION_LIFECYCLE_LOCK_CONTRACT,
  missionLifecycleAccountLockKey,
} from "./mission-lifecycle.repository.js";
import {
  SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT,
  sourceEvidenceAccountLockKey,
} from "./source-evidence-object.repository.js";
import type { SqlDatabase } from "./sql-database.js";
import {
  VENUE_ACCESS_LOCK_CONTRACT,
  venueAccessAccountLockKey,
} from "./venue-access.repository.js";
import {
  VENUE_PARTNER_LOCK_CONTRACT,
  venuePartnerAccountLockKey,
} from "./venue-partner.repository.js";
import {
  VENUE_REQUEST_LOCK_CONTRACT,
  venueRequestAccountLockKey,
} from "./venue-request.repository.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ACCOUNT_ID_LENGTH = 255;
const MAX_SEARCH_QUERY_LENGTH = 120;
const MAX_SEARCH_RESULTS = 25;
const MAX_EMAIL_LENGTH = 320;

const ACCOUNT_ROLES = new Set<AccountRole>(["user", "admin", "venue_manager"]);
const ACCOUNT_STATUSES = new Set<AccountStatus>(["active", "warned", "suspended"]);
const SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  "free",
  "premium_monthly",
  "premium_yearly",
  "contributor_unlocked",
  "admin",
]);
const PAID_SUBSCRIPTION_STATUSES = new Set<PaidSubscriptionStatus>([
  "premium_monthly",
  "premium_yearly",
]);
const AGE_VERIFICATION_STATUSES = new Set<AgeVerificationStatus>([
  "not_started",
  "pending",
  "verified",
  "rejected",
  "expired",
]);

/**
 * Status overrides take the same sorted cross-repository advisory union as an
 * account-deletion transition, then lock actor/target account rows in ID order.
 */
export const ADMIN_ACCOUNT_LOCK_CONTRACT = Object.freeze({
  version: 1,
  billingCheckoutVersion: BILLING_CHECKOUT_LOCK_CONTRACT.version,
  venueAccessVersion: VENUE_ACCESS_LOCK_CONTRACT.version,
  missionLifecycleVersion: MISSION_LIFECYCLE_LOCK_CONTRACT.version,
  venueRequestVersion: VENUE_REQUEST_LOCK_CONTRACT.version,
  venuePartnerVersion: VENUE_PARTNER_LOCK_CONTRACT.version,
  sourceEvidenceObjectVersion: SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT.version,
  order: Object.freeze([
    "sorted_cross_repository_actor_and_target_advisory_keys",
    "actor_and_target_account_rows_sorted_by_id",
    "conditional_account_and_profile_update",
    "conditional_session_containment",
  ] as const),
} as const);

export interface AdminAccountSearchResult {
  id: string;
  publicAccountId: string;
  email: string;
  displayName: string | null;
  role: AccountRole;
  status: AccountStatus;
  emailVerifiedAt: string | null;
  ageConfirmedAt: string | null;
  createdAt: string;
}

export interface AdminAccountStatusOverrideInput {
  actorAccountId: string;
  userId: string;
  status: AccountStatus;
  trustScore?: number | undefined;
  fraudStrikeCount?: number | undefined;
  expectedUpdatedAt: string;
  now: string;
}

export interface AdminAccountStatusOverrideResult {
  account: BusinessAccount;
  revokedSessions: number;
  revokedDiscountPasses: number;
  revokedProviderSessions: number;
}

export type AdminAccountRepositoryErrorCode =
  | "account_deletion_locked"
  | "account_not_found"
  | "actor_not_authorized"
  | "admin_self_override"
  | "invalid_input"
  | "malformed_record"
  | "persistence_failure"
  | "write_conflict";

const ERROR_MESSAGES: Readonly<Record<AdminAccountRepositoryErrorCode, string>> = {
  account_deletion_locked: "The account cannot be changed during its deletion transition.",
  account_not_found: "The account does not exist.",
  actor_not_authorized: "The account is not authorised for admin account operations.",
  admin_self_override: "An administrator cannot override their own admin account.",
  invalid_input: "The admin account input is invalid.",
  malformed_record: "Stored account data is malformed.",
  persistence_failure: "Admin account data could not be processed.",
  write_conflict: "The account changed before the override could be saved.",
};

/** Stable, secret-free failures for service and HTTP error mapping. */
export class AdminAccountRepositoryError extends Error {
  readonly code: AdminAccountRepositoryErrorCode;

  constructor(code: AdminAccountRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AdminAccountRepositoryError";
    this.code = code;
  }
}

type RawRow = Record<string, unknown>;

interface AuthorityRow extends RawRow {
  id: unknown;
  role: unknown;
  subscriptionStatus: unknown;
  status: unknown;
  authProvider: unknown;
  updatedAt: unknown;
  deletionLocked: unknown;
}

interface AdminSearchRow extends RawRow {
  id: unknown;
  publicAccountId: unknown;
  email: unknown;
  displayName: unknown;
  role: unknown;
  status: unknown;
  emailVerifiedAt: unknown;
  ageConfirmedAt: unknown;
  createdAt: unknown;
}

interface AccountRow extends RawRow {
  id: unknown;
  publicAccountId: unknown;
  email: unknown;
  passwordHash: unknown;
  displayName: unknown;
  displayNameKey: unknown;
  avatarUrl: unknown;
  authProvider: unknown;
  supabaseUserId: unknown;
  emailVerifiedAt: unknown;
  mfaLevel: unknown;
  mfaVerifiedAt: unknown;
  providerTokensValidAfter: unknown;
  stripePaidSubscriptionStatus: unknown;
  stripeEventCreatedAt: unknown;
  role: unknown;
  ageConfirmedAt: unknown;
  termsAcceptedAt: unknown;
  privacyAcceptedAt: unknown;
  termsVersion: unknown;
  privacyVersion: unknown;
  ageVerificationStatus: unknown;
  isOver18Verified: unknown;
  subscriptionStatus: unknown;
  stripeCustomerId: unknown;
  premiumUntil: unknown;
  trustScore: unknown;
  contributionPointsCurrentMonth: unknown;
  approvedSubmissionCount: unknown;
  rejectedSubmissionCount: unknown;
  fraudStrikeCount: unknown;
  status: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const ACCOUNT_PROJECTION = `
  account.id AS "id",
  account.public_account_id AS "publicAccountId",
  account.email AS "email",
  account.password_hash AS "passwordHash",
  account.display_name AS "displayName",
  account.display_name_key AS "displayNameKey",
  account.avatar_url AS "avatarUrl",
  account.auth_provider AS "authProvider",
  account.supabase_user_id AS "supabaseUserId",
  account.email_verified_at AS "emailVerifiedAt",
  account.mfa_level AS "mfaLevel",
  account.mfa_verified_at AS "mfaVerifiedAt",
  account.provider_tokens_valid_after AS "providerTokensValidAfter",
  account.stripe_paid_subscription_status AS "stripePaidSubscriptionStatus",
  account.stripe_event_created_at AS "stripeEventCreatedAt",
  account.role AS "role",
  account.age_confirmed_at AS "ageConfirmedAt",
  account.terms_accepted_at AS "termsAcceptedAt",
  account.privacy_accepted_at AS "privacyAcceptedAt",
  account.terms_version AS "termsVersion",
  account.privacy_version AS "privacyVersion",
  account.age_verification_status AS "ageVerificationStatus",
  account.is_over_18_verified AS "isOver18Verified",
  account.subscription_status AS "subscriptionStatus",
  account.stripe_customer_id AS "stripeCustomerId",
  account.premium_until AS "premiumUntil",
  account.trust_score AS "trustScore",
  account.contribution_points_current_month AS "contributionPointsCurrentMonth",
  account.approved_submission_count AS "approvedSubmissionCount",
  account.rejected_submission_count AS "rejectedSubmissionCount",
  account.fraud_strike_count AS "fraudStrikeCount",
  account.status AS "status",
  account.created_at AS "createdAt",
  account.updated_at AS "updatedAt"`;

function fail(code: AdminAccountRepositoryErrorCode): never {
  throw new AdminAccountRepositoryError(code);
}

function inputText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return fail("invalid_input");
  }
  return normalized;
}

function inputTimestamp(value: unknown): string {
  const normalized = inputText(value, 64);
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(normalized) || new Date(normalized).toISOString() !== normalized) {
      return fail("invalid_input");
    }
  } catch {
    return fail("invalid_input");
  }
  return normalized;
}

function inputInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail("invalid_input");
  }
  return value as number;
}

function optionalInputInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value == null ? null : inputInteger(value, minimum, maximum);
}

function recordText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("malformed_record");
  if (
    !value
    || value !== value.trim()
    || value.length > maximum
    || /[\r\n\0]/.test(value)
  ) {
    return fail("malformed_record");
  }
  return value;
}

function optionalRecordText(value: unknown, maximum: number): string | null {
  return value == null ? null : recordText(value, maximum);
}

function recordTimestamp(value: unknown): string {
  if (typeof value !== "string") return fail("malformed_record");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return fail("malformed_record");
    }
  } catch {
    return fail("malformed_record");
  }
  return value;
}

function optionalRecordTimestamp(value: unknown): string | null {
  return value == null ? null : recordTimestamp(value);
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function recordAccountRole(value: unknown): AccountRole {
  if (typeof value === "string" && ACCOUNT_ROLES.has(value as AccountRole)) {
    return value as AccountRole;
  }
  return fail("malformed_record");
}

function recordAccountStatus(value: unknown): AccountStatus {
  if (typeof value === "string" && ACCOUNT_STATUSES.has(value as AccountStatus)) {
    return value as AccountStatus;
  }
  return fail("malformed_record");
}

function inputAccountStatus(value: unknown): AccountStatus {
  if (typeof value === "string" && ACCOUNT_STATUSES.has(value as AccountStatus)) {
    return value as AccountStatus;
  }
  return fail("invalid_input");
}

function recordSubscriptionStatus(value: unknown): SubscriptionStatus {
  if (typeof value === "string" && SUBSCRIPTION_STATUSES.has(value as SubscriptionStatus)) {
    return value as SubscriptionStatus;
  }
  return fail("malformed_record");
}

function recordPaidSubscriptionStatus(value: unknown): PaidSubscriptionStatus | null {
  if (value == null) return null;
  if (typeof value === "string" && PAID_SUBSCRIPTION_STATUSES.has(value as PaidSubscriptionStatus)) {
    return value as PaidSubscriptionStatus;
  }
  return fail("malformed_record");
}

function recordAgeVerificationStatus(value: unknown): AgeVerificationStatus {
  if (typeof value === "string" && AGE_VERIFICATION_STATUSES.has(value as AgeVerificationStatus)) {
    return value as AgeVerificationStatus;
  }
  return fail("malformed_record");
}

function recordInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    return fail("malformed_record");
  }
  if (typeof value === "string") {
    if (!/^(?:0|[1-9]\d*)$/.test(value) || value !== String(numeric)) {
      return fail("malformed_record");
    }
  }
  return numeric;
}

function recordExactNumber(value: unknown, minimum = 0): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  if (
    typeof value === "string"
    && !/^[+-]?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  ) return fail("malformed_record");
  const numeric = Number(value);
  const significantDigits = typeof value === "string"
    ? value
      .replace(/^[+-]/, "")
      .replace(/[eE].*$/, "")
      .replace(".", "")
      .replace(/^0+/, "").length
    : 0;
  if (
    !Number.isFinite(numeric)
    || numeric < minimum
    || Number.isInteger(numeric) && !Number.isSafeInteger(numeric)
    || significantDigits > 15
  ) return fail("malformed_record");
  return numeric;
}

function toSearchResult(row: AdminSearchRow): AdminAccountSearchResult {
  const id = recordText(row.id, MAX_ACCOUNT_ID_LENGTH);
  return {
    id,
    publicAccountId: optionalRecordText(row.publicAccountId, 64) ?? id,
    email: recordText(row.email, MAX_EMAIL_LENGTH),
    displayName: optionalRecordText(row.displayName, 240),
    role: recordAccountRole(row.role),
    status: recordAccountStatus(row.status),
    emailVerifiedAt: optionalRecordTimestamp(row.emailVerifiedAt),
    ageConfirmedAt: optionalRecordTimestamp(row.ageConfirmedAt),
    createdAt: recordTimestamp(row.createdAt),
  };
}

function toBusinessAccount(row: AccountRow): BusinessAccount {
  const id = recordText(row.id, MAX_ACCOUNT_ID_LENGTH);
  return {
    id,
    publicAccountId: optionalRecordText(row.publicAccountId, 64) ?? id,
    email: recordText(row.email, MAX_EMAIL_LENGTH),
    passwordHash: recordText(row.passwordHash, 2_048),
    displayName: optionalRecordText(row.displayName, 240),
    displayNameKey: optionalRecordText(row.displayNameKey, 160),
    avatarUrl: optionalRecordText(row.avatarUrl, 2_048),
    authProvider: recordText(row.authProvider, 80),
    supabaseUserId: optionalRecordText(row.supabaseUserId, MAX_ACCOUNT_ID_LENGTH),
    emailVerifiedAt: optionalRecordTimestamp(row.emailVerifiedAt),
    mfaLevel: recordText(row.mfaLevel, 80),
    mfaVerifiedAt: optionalRecordTimestamp(row.mfaVerifiedAt),
    providerTokensValidAfter: optionalRecordTimestamp(row.providerTokensValidAfter),
    stripePaidSubscriptionStatus: recordPaidSubscriptionStatus(row.stripePaidSubscriptionStatus),
    stripeEventCreatedAt: optionalRecordTimestamp(row.stripeEventCreatedAt),
    role: recordAccountRole(row.role),
    ageConfirmedAt: optionalRecordTimestamp(row.ageConfirmedAt),
    termsAcceptedAt: optionalRecordTimestamp(row.termsAcceptedAt),
    privacyAcceptedAt: optionalRecordTimestamp(row.privacyAcceptedAt),
    termsVersion: optionalRecordText(row.termsVersion, 80),
    privacyVersion: optionalRecordText(row.privacyVersion, 80),
    ageVerificationStatus: recordAgeVerificationStatus(row.ageVerificationStatus),
    isOver18Verified: recordBoolean(row.isOver18Verified),
    subscriptionStatus: recordSubscriptionStatus(row.subscriptionStatus),
    stripeCustomerId: optionalRecordText(row.stripeCustomerId, MAX_ACCOUNT_ID_LENGTH),
    premiumUntil: optionalRecordTimestamp(row.premiumUntil),
    trustScore: recordInteger(row.trustScore, 0, 100),
    contributionPointsCurrentMonth: recordExactNumber(row.contributionPointsCurrentMonth),
    approvedSubmissionCount: recordInteger(row.approvedSubmissionCount),
    rejectedSubmissionCount: recordInteger(row.rejectedSubmissionCount),
    fraudStrikeCount: recordInteger(row.fraudStrikeCount),
    status: recordAccountStatus(row.status),
    createdAt: recordTimestamp(row.createdAt),
    updatedAt: recordTimestamp(row.updatedAt),
  };
}

function toAuthority(row: AuthorityRow): {
  id: string;
  role: AccountRole;
  subscriptionStatus: SubscriptionStatus;
  status: AccountStatus;
  authProvider: string;
  updatedAt: string;
  deletionLocked: boolean;
} {
  return {
    id: recordText(row.id, MAX_ACCOUNT_ID_LENGTH),
    role: recordAccountRole(row.role),
    subscriptionStatus: recordSubscriptionStatus(row.subscriptionStatus),
    status: recordAccountStatus(row.status),
    authProvider: recordText(row.authProvider, 80),
    updatedAt: recordTimestamp(row.updatedAt),
    deletionLocked: recordBoolean(row.deletionLocked),
  };
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function accountAdvisoryKeys(accountId: string): string[] {
  return [
    billingCheckoutActorLockKey(accountId),
    missionLifecycleAccountLockKey(accountId),
    venueAccessAccountLockKey(accountId),
    venueRequestAccountLockKey(accountId),
    venuePartnerAccountLockKey(accountId),
    sourceEvidenceAccountLockKey(accountId),
  ];
}

/**
 * Async admin account search/status authority. Production allowlists, MFA,
 * last-admin policy, HTTP authorization, and security audit I/O remain in the
 * service. Suspension containment is database-only and commits atomically.
 */
export class AdminAccountRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AdminAccountRepositoryError) throw error;
      throw new AdminAccountRepositoryError("persistence_failure");
    }
  }

  private binaryCollation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of [...new Set(keys)].sort()) {
      await this.database.prepare(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private authorityProjection(alias: string): string {
    return `${alias}.id AS "id",
      ${alias}.role AS "role",
      ${alias}.subscription_status AS "subscriptionStatus",
      ${alias}.status AS "status",
      ${alias}.auth_provider AS "authProvider",
      ${alias}.updated_at AS "updatedAt",
      EXISTS (
        SELECT 1 FROM account_deletion_requests deletion
        WHERE deletion.user_id = ${alias}.id
          AND deletion.status IN ('processing', 'failed', 'completed')
      ) AS "deletionLocked"`;
  }

  private requireAdminAuthority(row: AuthorityRow | undefined): ReturnType<typeof toAuthority> {
    if (!row) return fail("actor_not_authorized");
    const actor = toAuthority(row);
    if (
      (actor.role !== "admin" && actor.subscriptionStatus !== "admin")
      || actor.status === "suspended"
      || actor.authProvider === "deleted"
      || actor.deletionLocked
    ) {
      return fail("actor_not_authorized");
    }
    return actor;
  }

  async searchAccountsForAdmin(input: {
    actorAccountId: string;
    query: string;
    limit: number;
  }): Promise<AdminAccountSearchResult[]> {
    return this.guarded(async () => {
      const actorAccountId = inputText(input.actorAccountId, MAX_ACCOUNT_ID_LENGTH);
      const query = inputText(input.query, MAX_SEARCH_QUERY_LENGTH).toLowerCase();
      if (query.length < 2) return fail("invalid_input");
      const limit = inputInteger(input.limit, 1, MAX_SEARCH_RESULTS);
      const actorRow = await this.database.prepare(
        `SELECT ${this.authorityProjection("account")}
           FROM accounts account
          WHERE account.id = ?
          LIMIT 1`,
      ).get<AuthorityRow>(actorAccountId);
      this.requireAdminAuthority(actorRow);

      const escaped = escapeLike(query);
      const contains = `%${escaped}%`;
      const prefix = `${escaped}%`;
      const binaryCollation = this.binaryCollation();
      const postgresTrigramPrefilter = this.database.dialect === "postgres"
        ? `AND lower(
             account.email || '|' || COALESCE(account.display_name, '') || '|'
             || COALESCE(account.public_account_id, '') || '|' || account.id
           ) LIKE @contains ESCAPE '\\'`
        : "";
      const rows = await this.database.prepare(
        `SELECT account.id AS "id",
                account.public_account_id AS "publicAccountId",
                account.email AS "email",
                account.display_name AS "displayName",
                account.role AS "role",
                account.status AS "status",
                account.email_verified_at AS "emailVerifiedAt",
                account.age_confirmed_at AS "ageConfirmedAt",
                account.created_at AS "createdAt"
           FROM accounts account
          WHERE (
            lower(account.email) LIKE @contains ESCAPE '\\'
            OR lower(COALESCE(account.display_name, '')) LIKE @contains ESCAPE '\\'
            OR lower(COALESCE(account.public_account_id, '')) LIKE @contains ESCAPE '\\'
            OR lower(account.id) LIKE @contains ESCAPE '\\'
          )
          ${postgresTrigramPrefilter}
          ORDER BY
            CASE
              WHEN lower(account.email) = @query THEN 0
              WHEN lower(account.email) LIKE @prefix ESCAPE '\\' THEN 1
              WHEN lower(COALESCE(account.display_name, '')) LIKE @prefix ESCAPE '\\' THEN 2
              ELSE 3
            END ASC,
            account.created_at DESC,
            account.id ${binaryCollation} ASC
          LIMIT @limit`,
      ).all<AdminSearchRow>({ query, contains, prefix, limit });
      if (rows.length > limit) return fail("malformed_record");
      return rows.map(toSearchResult);
    });
  }

  async overrideUserStatus(
    input: AdminAccountStatusOverrideInput,
  ): Promise<AdminAccountStatusOverrideResult> {
    return this.guarded(async () => {
      const actorAccountId = inputText(input.actorAccountId, MAX_ACCOUNT_ID_LENGTH);
      const userId = inputText(input.userId, MAX_ACCOUNT_ID_LENGTH);
      const status = inputAccountStatus(input.status);
      const trustScore = optionalInputInteger(input.trustScore, 0, 100);
      const fraudStrikeCount = optionalInputInteger(input.fraudStrikeCount, 0, 10);
      const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
      const now = inputTimestamp(input.now);
      if (Date.parse(now) <= Date.parse(expectedUpdatedAt)) return fail("invalid_input");
      const binaryCollation = this.binaryCollation();

      return this.database.transaction(async () => {
        await this.advisoryLocks([
          ...accountAdvisoryKeys(actorAccountId),
          ...accountAdvisoryKeys(userId),
        ]);
        const lockedRows = await this.database.prepare(
          `SELECT ${this.authorityProjection("account")}
             FROM accounts account
            WHERE account.id = @actorAccountId OR account.id = @userId
            ORDER BY account.id ${binaryCollation} ASC${this.lockSuffix("account")}`,
        ).all<AuthorityRow>({ actorAccountId, userId });
        const actor = this.requireAdminAuthority(
          lockedRows.find((row) => row.id === actorAccountId),
        );
        const targetRow = lockedRows.find((row) => row.id === userId);
        if (!targetRow) return fail("account_not_found");
        const target = toAuthority(targetRow);
        if (target.authProvider === "deleted" || target.deletionLocked) {
          return fail("account_deletion_locked");
        }
        if (
          actor.id === target.id
          && (target.role === "admin" || target.subscriptionStatus === "admin")
        ) {
          return fail("admin_self_override");
        }
        if (target.updatedAt !== expectedUpdatedAt) return fail("write_conflict");

        const updated = await this.database.prepare(
          `UPDATE accounts
              SET status = @status,
                  trust_score = COALESCE(CAST(@trustScore AS BIGINT), trust_score),
                  fraud_strike_count = COALESCE(CAST(@fraudStrikeCount AS BIGINT), fraud_strike_count),
                  updated_at = @now
            WHERE id = @userId
              AND updated_at = @expectedUpdatedAt
              AND auth_provider <> 'deleted'
              AND NOT EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                WHERE deletion.user_id = accounts.id
                  AND deletion.status IN ('processing', 'failed', 'completed')
              )`,
        ).run({
          status,
          trustScore,
          fraudStrikeCount,
          now,
          userId,
          expectedUpdatedAt,
        });
        if (updated.changes !== 1) return fail("write_conflict");

        const profileUpdated = await this.database.prepare(
          "UPDATE profiles SET account_status = ?, updated_at = ? WHERE id = ?",
        ).run(status, now, userId);
        if (profileUpdated.changes !== 1) return fail("malformed_record");

        let revokedProviderSessions = 0;
        let revokedDiscountPasses = 0;
        let revokedSessions = 0;
        if (status === "suspended") {
          const revokedAt = this.database.dialect === "postgres"
            ? "CAST(@now AS TIMESTAMPTZ)"
            : "@now";
          revokedProviderSessions = (await this.database.prepare(
            `INSERT INTO revoked_provider_sessions (
               user_id, provider_session_id_hash, revoked_at, reason
             )
             SELECT DISTINCT session.user_id, session.provider_session_id_hash,
                    ${revokedAt}, 'all_app_sessions_revoked'
               FROM auth_sessions session
              WHERE session.user_id = @userId
                AND session.provider_session_id_hash IS NOT NULL
             ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
               revoked_at = excluded.revoked_at,
               reason = excluded.reason`,
          ).run({ userId, now })).changes;
          revokedDiscountPasses = (await this.database.prepare(
            `UPDATE account_discount_passes
                SET status = 'revoked', revoked_at = @now
              WHERE user_id = @userId AND status = 'active'`,
          ).run({ userId, now })).changes;
          revokedSessions = (await this.database.prepare(
            `UPDATE auth_sessions
                SET revoked_at = @now
              WHERE user_id = @userId AND revoked_at IS NULL`,
          ).run({ userId, now })).changes;
        }

        const accountRow = await this.database.prepare(
          `SELECT ${ACCOUNT_PROJECTION}
             FROM accounts account
            WHERE account.id = ?
            LIMIT 1`,
        ).get<AccountRow>(userId);
        if (!accountRow) return fail("account_not_found");
        return {
          account: toBusinessAccount(accountRow),
          revokedSessions,
          revokedDiscountPasses,
          revokedProviderSessions,
        };
      })();
    });
  }
}

export const adminAccountRepositoryLimits = Object.freeze({
  maxAccountIdLength: MAX_ACCOUNT_ID_LENGTH,
  maxSearchQueryLength: MAX_SEARCH_QUERY_LENGTH,
  maxSearchResults: MAX_SEARCH_RESULTS,
});
