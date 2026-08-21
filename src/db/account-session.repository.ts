import crypto from "node:crypto";

import type {
  AccountRole,
  AccountSession,
  AccountStatus,
  AgeVerification,
  AgeVerificationStatus,
  BusinessAccount,
  SubscriptionStatus,
} from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_HASH = /^[0-9a-f]{64}$/;
const MAX_ACCOUNT_SESSION_LIMIT = 1_000;
const MAX_SESSION_LIST_OFFSET = 2_147_483_647;
const PUBLIC_ACCOUNT_ID_ATTEMPTS = 20;
const TOUCH_THROTTLE_MS = 2 * 60_000;
const PROVIDER_GLOBAL_REVOCATION_PENDING_HASH =
  "1c85b251c4aa3bab422ff9f4d0d1af2662f30cc4d7c2cb7717d80583eb80d8c6";
const PROVIDER_GLOBAL_REVOCATION_PENDING_PREFIX = "provider_global_revocation_pending:";
const PROVIDER_GLOBAL_REVOCATION_CLAIM_PREFIX = "provider_global_revocation_claim:";
const PROVIDER_GLOBAL_REVOCATION_CLAIM = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_GLOBAL_REVOCATION_CLAIM_LEASE_MS = 5 * 60_000;
type ProviderGlobalRevocationOperation = "logout_all" | "password_reset";

export type AccountSessionRepositoryErrorCode =
  | "account_not_found"
  | "account_not_session_eligible"
  | "account_identity_conflict"
  | "display_name_conflict"
  | "invalid_input"
  | "provider_global_revocation_pending"
  | "provider_session_revoked"
  | "session_conflict";

const ERROR_MESSAGES: Readonly<Record<AccountSessionRepositoryErrorCode, string>> = {
  account_not_found: "The account does not exist.",
  account_not_session_eligible: "The account cannot create or use an active session.",
  account_identity_conflict: "The account identity conflicts with an existing account.",
  display_name_conflict: "The display name conflicts with an existing account.",
  invalid_input: "The account or session input is invalid.",
  provider_global_revocation_pending: "Provider-wide session revocation is already pending.",
  provider_session_revoked: "The provider session has been revoked.",
  session_conflict: "The session conflicts with existing session state.",
};

/** Stable, secret-free failures that service wiring can map to HTTP outcomes. */
export class AccountSessionRepositoryError extends Error {
  readonly code: AccountSessionRepositoryErrorCode;

  constructor(code: AccountSessionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AccountSessionRepositoryError";
    this.code = code;
  }
}

interface AccountRow {
  id: string;
  publicAccountId: string | null;
  email: string;
  passwordHash: string;
  displayName: string | null;
  displayNameKey: string | null;
  avatarUrl: string | null;
  authProvider: string;
  supabaseUserId: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  mfaVerifiedAt: string | null;
  providerTokensValidAfter: string | null;
  stripePaidSubscriptionStatus: BusinessAccount["stripePaidSubscriptionStatus"];
  stripeEventCreatedAt: string | null;
  role: AccountRole;
  ageConfirmedAt: string | null;
  termsAcceptedAt: string | null;
  privacyAcceptedAt: string | null;
  termsVersion: string | null;
  privacyVersion: string | null;
  ageVerificationStatus: AgeVerificationStatus;
  isOver18Verified: boolean | number;
  subscriptionStatus: SubscriptionStatus;
  stripeCustomerId: string | null;
  premiumUntil: string | null;
  trustScore: number | string;
  contributionPointsCurrentMonth: number | string;
  approvedSubmissionCount: number | string;
  rejectedSubmissionCount: number | string;
  fraudStrikeCount: number | string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

interface AgeVerificationRow {
  id: string;
  userId: string;
  status: AgeVerificationStatus;
  ageThreshold: number | string;
  isOver18: boolean | number;
  providerName: string | null;
  providerReferenceId: string | null;
  checkedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  tokenHash: string;
  userId: string;
  providerSessionIdHash: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastIpHash: string | null;
  userAgentHash: string | null;
}

interface LockedAccountRow {
  id: string;
  status: AccountStatus;
  authProvider: string;
  providerTokensValidAfter: string | null;
  updatedAt: string;
  deletionLocked: boolean | number;
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

const AGE_VERIFICATION_PROJECTION = `
  verification.id AS "id",
  verification.user_id AS "userId",
  verification.status AS "status",
  verification.age_threshold AS "ageThreshold",
  verification.is_over_18 AS "isOver18",
  verification.provider_name AS "providerName",
  verification.provider_reference_id AS "providerReferenceId",
  verification.checked_at AS "checkedAt",
  verification.expires_at AS "expiresAt",
  verification.created_at AS "createdAt",
  verification.updated_at AS "updatedAt"`;

const SESSION_PROJECTION = `
  session.token_hash AS "tokenHash",
  session.user_id AS "userId",
  session.provider_session_id_hash AS "providerSessionIdHash",
  session.created_at AS "createdAt",
  session.expires_at AS "expiresAt",
  session.revoked_at AS "revokedAt",
  session.last_used_at AS "lastUsedAt",
  session.last_ip_hash AS "lastIpHash",
  session.user_agent_hash AS "userAgentHash"`;

function invalidInput(): never {
  throw new AccountSessionRepositoryError("invalid_input");
}

function requireBoundedText(value: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) invalidInput();
  return normalized;
}

function normalizeEmail(value: string): string {
  return requireBoundedText(value, 320).toLowerCase();
}

function normalizeDisplayNameKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 160 || /[\r\n\0]/.test(normalized)) invalidInput();
  return normalized;
}

function requireCanonicalUtc(value: string): string {
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) invalidInput();
    return value;
  } catch {
    return invalidInput();
  }
}

function requireSha256Hash(value: string): string {
  const normalized = requireBoundedText(value, 64);
  if (value !== normalized || !SHA256_HEX_HASH.test(normalized)) invalidInput();
  return normalized;
}

function optionalCanonicalUtc(value: string | null | undefined): string | null {
  return value == null ? null : requireCanonicalUtc(value);
}

function safeNumber(value: number | string, integer: boolean): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || (integer && !Number.isSafeInteger(numeric))) {
    throw new Error("Account numeric data is outside the supported application range.");
  }
  if (typeof value === "string") {
    if (integer && BigInt(value) !== BigInt(numeric)) {
      throw new Error("Account numeric data is outside the supported application range.");
    }
    if (!integer && value.replace(/\.0+$/, "") !== String(numeric)) {
      throw new Error("Account numeric data is outside the supported application range.");
    }
  }
  return numeric;
}

function toAccount(row: AccountRow): BusinessAccount {
  return {
    ...row,
    publicAccountId: row.publicAccountId ?? row.id,
    isOver18Verified: Boolean(row.isOver18Verified),
    trustScore: safeNumber(row.trustScore, true),
    contributionPointsCurrentMonth: safeNumber(row.contributionPointsCurrentMonth, false),
    approvedSubmissionCount: safeNumber(row.approvedSubmissionCount, true),
    rejectedSubmissionCount: safeNumber(row.rejectedSubmissionCount, true),
    fraudStrikeCount: safeNumber(row.fraudStrikeCount, true),
  };
}

function toAgeVerification(row: AgeVerificationRow): AgeVerification {
  return {
    ...row,
    ageThreshold: safeNumber(row.ageThreshold, true),
    isOver18: Boolean(row.isOver18),
  };
}

function toSession(row: SessionRow): AccountSession {
  return {
    id: row.tokenHash.slice(0, 24),
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    lastIpHash: row.lastIpHash,
    userAgentHash: row.userAgentHash,
    providerBacked: Boolean(row.providerSessionIdHash),
  };
}

function isConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23505" || (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"));
}

function normalizeListLimit(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) invalidInput();
  return Math.min(maximum, Math.max(1, Math.trunc(candidate)));
}

function normalizeListOffset(value: number | undefined): number {
  const candidate = value ?? 0;
  if (!Number.isFinite(candidate)) invalidInput();
  return Math.min(MAX_SESSION_LIST_OFFSET, Math.max(0, Math.trunc(candidate)));
}

function normalizeActiveSessionLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Active session limit must be a positive integer.");
  }
  if (value > MAX_ACCOUNT_SESSION_LIMIT) {
    throw new Error(`Active session limit must not exceed ${MAX_ACCOUNT_SESSION_LIMIT}.`);
  }
  return value;
}

function booleanBinding(database: SqlDatabase, value: boolean): boolean | number {
  return database.dialect === "postgres" ? value : value ? 1 : 0;
}

function publicAccountId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let randomPart = "";
  for (let index = 0; index < 8; index += 1) {
    randomPart += alphabet[crypto.randomInt(alphabet.length)]!;
  }
  return `PP-${randomPart}`;
}

export interface SessionMutationSummary {
  revokedSessions: number;
  revokedDiscountPasses: number;
  revokedProviderSessions: number;
}

export type AccountSessionTokenRotationResult = "rotated" | "created" | "conflict";

/**
 * Authoritative Supabase account state that may be committed with a provider-
 * bound app-session rotation. Legal and age acceptance, when present, are
 * timestamped with the new session's `createdAt` inside the same transaction.
 */
export interface SupabaseAccountSessionMutation {
  authProvider: "supabase";
  supabaseUserId: string;
  email: string;
  displayName: string | null;
  displayNameKey?: string | null | undefined;
  avatarUrl: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  mfaVerifiedAt: string | null;
  legalAcceptance?: {
    termsVersion: string;
    privacyVersion: string;
    ageConfirmed: true;
  } | null | undefined;
}

export interface AccountSessionTokenRotationInput {
  currentTokenHash?: string | null | undefined;
  newTokenHash: string;
  userId: string;
  providerSessionIdHash: string;
  providerTokenIssuedAt?: string | null | undefined;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string | null | undefined;
  lastIpHash?: string | null | undefined;
  userAgentHash?: string | null | undefined;
  maxActiveSessions: number;
  supabaseAccountMutation?: SupabaseAccountSessionMutation | null | undefined;
}

export type SupabaseAccountSessionTokenRotationInput = Omit<
  AccountSessionTokenRotationInput,
  "supabaseAccountMutation"
> & {
  supabaseAccountMutation: SupabaseAccountSessionMutation;
};

export type SupabaseAccountSessionTokenRotationResult =
  | { status: "rotated" | "created"; account: BusinessAccount }
  | { status: "conflict" };

interface NormalizedSupabaseAccountSessionMutation {
  authProvider: "supabase";
  supabaseUserId: string;
  email: string;
  displayName: string | null;
  displayNameKey: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  mfaVerifiedAt: string | null;
  legalAcceptance: {
    termsVersion: string;
    privacyVersion: string;
    ageConfirmed: true;
  } | null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function nullableBoundedText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalidInput();
  return requireBoundedText(value, maximum);
}

function normalizeSupabaseAccountSessionMutation(
  value: SupabaseAccountSessionMutation,
): NormalizedSupabaseAccountSessionMutation {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !hasOnlyKeys(value as unknown as Record<string, unknown>, [
      "authProvider",
      "supabaseUserId",
      "email",
      "displayName",
      "displayNameKey",
      "avatarUrl",
      "emailVerifiedAt",
      "mfaLevel",
      "mfaVerifiedAt",
      "legalAcceptance",
    ])
    || value.authProvider !== "supabase"
  ) invalidInput();
  const emailVerifiedAt = value.emailVerifiedAt === null
    ? null
    : typeof value.emailVerifiedAt === "string"
      ? requireCanonicalUtc(value.emailVerifiedAt)
      : invalidInput();
  const mfaVerifiedAt = value.mfaVerifiedAt === null
    ? null
    : typeof value.mfaVerifiedAt === "string"
      ? requireCanonicalUtc(value.mfaVerifiedAt)
      : invalidInput();
  let legalAcceptance: NormalizedSupabaseAccountSessionMutation["legalAcceptance"] = null;
  if (value.legalAcceptance != null) {
    if (
      typeof value.legalAcceptance !== "object"
      || Array.isArray(value.legalAcceptance)
      || !hasOnlyKeys(value.legalAcceptance as unknown as Record<string, unknown>, [
        "termsVersion",
        "privacyVersion",
        "ageConfirmed",
      ])
      || value.legalAcceptance.ageConfirmed !== true
    ) invalidInput();
    legalAcceptance = {
      termsVersion: requireBoundedText(value.legalAcceptance.termsVersion, 80),
      privacyVersion: requireBoundedText(value.legalAcceptance.privacyVersion, 80),
      ageConfirmed: true,
    };
  }
  return {
    authProvider: "supabase",
    supabaseUserId: requireBoundedText(value.supabaseUserId),
    email: normalizeEmail(value.email),
    displayName: nullableBoundedText(value.displayName, 160),
    displayNameKey: normalizeDisplayNameKey(value.displayNameKey),
    avatarUrl: nullableBoundedText(value.avatarUrl, 2_048),
    emailVerifiedAt,
    mfaLevel: requireBoundedText(value.mfaLevel, 80),
    mfaVerifiedAt,
    legalAcceptance,
  };
}

const EMPTY_SESSION_MUTATION: SessionMutationSummary = {
  revokedSessions: 0,
  revokedDiscountPasses: 0,
  revokedProviderSessions: 0,
};

/**
 * Pure async account/auth/session persistence for both rehearsal SQLite and the
 * native Postgres runtime. Provider I/O and password/token generation stay in
 * the service layer, outside these short database transactions.
 */
export class AccountSessionRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async lockIdentityKeys(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of Array.from(new Set(keys)).sort()) {
      await this.database.prepare(
        "SELECT pg_advisory_xact_lock(hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private async lockAccount(userId: string): Promise<LockedAccountRow | null> {
    const suffix = this.database.dialect === "postgres" ? " FOR UPDATE OF account" : "";
    const row = await this.database.prepare(
      `SELECT account.id AS "id", account.status AS "status",
              account.auth_provider AS "authProvider",
              account.provider_tokens_valid_after AS "providerTokensValidAfter",
              account.updated_at AS "updatedAt",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                WHERE deletion.user_id = account.id
                  AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
       FROM accounts account
       WHERE account.id = ?${suffix}`,
    ).get<LockedAccountRow>(userId);
    return row ?? null;
  }

  private requireMutableAccount(row: LockedAccountRow | null): LockedAccountRow {
    if (!row) throw new AccountSessionRepositoryError("account_not_found");
    if (row.authProvider === "deleted") {
      throw new AccountSessionRepositoryError("account_not_session_eligible");
    }
    return row;
  }

  private requireSessionEligibleAccount(row: LockedAccountRow | null): LockedAccountRow {
    const account = this.requireMutableAccount(row);
    if (account.status === "suspended" || Boolean(account.deletionLocked)) {
      throw new AccountSessionRepositoryError("account_not_session_eligible");
    }
    return account;
  }

  private async advanceProviderTokensValidAfter(input: {
    account: LockedAccountRow;
    candidate: string;
    updatedAt: string;
  }): Promise<void> {
    if (
      input.account.providerTokensValidAfter
      && Date.parse(input.candidate) <= Date.parse(input.account.providerTokensValidAfter)
    ) return;
    const updatedAt = Date.parse(input.updatedAt) > Date.parse(input.account.updatedAt)
      ? input.updatedAt
      : input.account.updatedAt;
    const updated = await this.database.prepare(
      `UPDATE accounts
       SET provider_tokens_valid_after = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.candidate, updatedAt, input.account.id);
    if (updated.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
  }

  private async findAccount(sql: string, ...bindings: unknown[]): Promise<BusinessAccount | null> {
    const row = await this.database.prepare(sql).get<AccountRow>(...bindings);
    return row ? toAccount(row) : null;
  }

  private async getAccountByIdInternal(id: string): Promise<BusinessAccount | null> {
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account WHERE account.id = ? LIMIT 1`,
      id,
    );
  }

  private async identityOwner(columnPredicate: string, value: string, excludingId?: string): Promise<string | null> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id" FROM accounts account
       WHERE ${columnPredicate}
         AND (CAST(? AS TEXT) IS NULL OR account.id <> ?)
       ORDER BY account.id ASC LIMIT 1`,
    ).get<{ id: string }>(value, excludingId ?? null, excludingId ?? null);
    return row?.id ?? null;
  }

  private async upsertProfileFromAccount(account: BusinessAccount, now: string): Promise<void> {
    await this.database.prepare(
      `INSERT INTO profiles (
         id, public_account_id, email, display_name, display_name_key, username,
         avatar_url, role, account_status, age_verification_status,
         is_over_18_verified, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         public_account_id = COALESCE(excluded.public_account_id, profiles.public_account_id),
         email = excluded.email,
         display_name = excluded.display_name,
         display_name_key = excluded.display_name_key,
         avatar_url = excluded.avatar_url,
         role = excluded.role,
         account_status = excluded.account_status,
         age_verification_status = excluded.age_verification_status,
         is_over_18_verified = excluded.is_over_18_verified,
         updated_at = excluded.updated_at`,
    ).run(
      account.id,
      account.publicAccountId,
      account.email,
      account.displayName,
      account.displayNameKey,
      account.avatarUrl,
      account.role,
      account.status,
      account.ageVerificationStatus,
      booleanBinding(this.database, account.isOver18Verified),
      now,
      now,
    );
  }

  /** Caller must hold the account row lock for the enclosing transaction. */
  private async applySupabaseAccountSessionMutationLocked(
    userId: string,
    mutation: NormalizedSupabaseAccountSessionMutation,
    now: string,
  ): Promise<{ account: BusinessAccount; establishedProviderCredentialBoundary: boolean }> {
    if (await this.identityOwner("lower(account.email) = ?", mutation.email, userId)) {
      throw new AccountSessionRepositoryError("account_identity_conflict");
    }
    if (await this.identityOwner("account.supabase_user_id = ?", mutation.supabaseUserId, userId)) {
      throw new AccountSessionRepositoryError("account_identity_conflict");
    }
    if (
      mutation.displayNameKey
      && await this.identityOwner("lower(account.display_name_key) = ?", mutation.displayNameKey, userId)
    ) {
      throw new AccountSessionRepositoryError("display_name_conflict");
    }

    const previous = await this.getAccountByIdInternal(userId);
    if (!previous) throw new AccountSessionRepositoryError("account_not_found");
    const establishedProviderCredentialBoundary = previous.supabaseUserId !== mutation.supabaseUserId;
    const linked = await this.database.prepare(
      `UPDATE accounts
       SET supabase_user_id = ?, auth_provider = ?, email = ?,
           password_hash = 'supabase-auth', display_name = ?,
           display_name_key = ?, avatar_url = ?,
           email_verified_at = COALESCE(?, email_verified_at),
           mfa_level = ?, mfa_verified_at = ?, updated_at = ?
       WHERE id = ? AND auth_provider <> 'deleted'`,
    ).run(
      mutation.supabaseUserId,
      mutation.authProvider,
      mutation.email,
      mutation.displayName,
      mutation.displayNameKey,
      mutation.avatarUrl,
      mutation.emailVerifiedAt,
      mutation.mfaLevel,
      mutation.mfaVerifiedAt,
      now,
      userId,
    );
    if (linked.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");

    if (mutation.legalAcceptance) {
      const accepted = await this.database.prepare(
        `UPDATE accounts
         SET terms_accepted_at = ?, privacy_accepted_at = ?, terms_version = ?,
             privacy_version = ?, age_confirmed_at = COALESCE(age_confirmed_at, ?),
             updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(
        now,
        now,
        mutation.legalAcceptance.termsVersion,
        mutation.legalAcceptance.privacyVersion,
        now,
        now,
        userId,
      );
      if (accepted.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
    }

    if (establishedProviderCredentialBoundary) {
      await this.database.prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(now, userId);
      await this.database.prepare(
        `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
         WHERE user_id = ? AND status = 'active'`,
      ).run(now, userId);
    }

    const account = await this.getAccountByIdInternal(userId);
    if (!account) throw new AccountSessionRepositoryError("account_not_found");
    await this.upsertProfileFromAccount(account, now);
    return { account, establishedProviderCredentialBoundary };
  }

  async getAccountById(id: string): Promise<BusinessAccount | null> {
    return this.getAccountByIdInternal(requireBoundedText(id));
  }

  async getAccountByEmail(email: string): Promise<BusinessAccount | null> {
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE lower(account.email) = ? ORDER BY account.id ASC LIMIT 1`,
      normalizeEmail(email),
    );
  }

  async getAccountBySupabaseUserId(supabaseUserId: string): Promise<BusinessAccount | null> {
    const normalized = requireBoundedText(supabaseUserId);
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE account.supabase_user_id = ? OR account.id = ?
       ORDER BY CASE WHEN account.supabase_user_id = ? THEN 0 ELSE 1 END, account.id ASC
       LIMIT 1`,
      normalized,
      normalized,
      normalized,
    );
  }

  async getAccountByDisplayNameKey(displayNameKey: string): Promise<BusinessAccount | null> {
    const normalized = normalizeDisplayNameKey(displayNameKey);
    if (!normalized) return null;
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE lower(account.display_name_key) = ? ORDER BY account.id ASC LIMIT 1`,
      normalized,
    );
  }

  async getAccountByPublicAccountId(value: string): Promise<BusinessAccount | null> {
    const normalized = requireBoundedText(value, 64).toUpperCase();
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE upper(account.public_account_id) = ? ORDER BY account.id ASC LIMIT 1`,
      normalized,
    );
  }

  async getAccountByStripeCustomerId(stripeCustomerId: string): Promise<BusinessAccount | null> {
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE account.stripe_customer_id = ?
       ORDER BY account.updated_at DESC, account.id ASC LIMIT 1`,
      requireBoundedText(stripeCustomerId),
    );
  }

  async createAccount(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: AccountRole;
    subscriptionStatus: SubscriptionStatus;
    now: string;
    displayName?: string | null | undefined;
    displayNameKey?: string | null | undefined;
    avatarUrl?: string | null | undefined;
    authProvider?: string | undefined;
    supabaseUserId?: string | null | undefined;
    emailVerifiedAt?: string | null | undefined;
    mfaLevel?: string | undefined;
    mfaVerifiedAt?: string | null | undefined;
    termsAcceptedAt?: string | null | undefined;
    privacyAcceptedAt?: string | null | undefined;
    termsVersion?: string | null | undefined;
    privacyVersion?: string | null | undefined;
  }): Promise<BusinessAccount> {
    const id = requireBoundedText(input.id);
    const email = normalizeEmail(input.email);
    const passwordHash = requireBoundedText(input.passwordHash, 2_048);
    const displayNameKey = normalizeDisplayNameKey(input.displayNameKey);
    const authProvider = requireBoundedText(input.authProvider ?? "local", 80);
    const supabaseUserId = input.supabaseUserId == null
      ? null
      : requireBoundedText(input.supabaseUserId);
    const now = requireCanonicalUtc(input.now);
    const emailVerifiedAt = optionalCanonicalUtc(input.emailVerifiedAt);
    const mfaVerifiedAt = optionalCanonicalUtc(input.mfaVerifiedAt);
    const termsAcceptedAt = optionalCanonicalUtc(input.termsAcceptedAt);
    const privacyAcceptedAt = optionalCanonicalUtc(input.privacyAcceptedAt);

    for (let attempt = 0; attempt < PUBLIC_ACCOUNT_ID_ATTEMPTS; attempt += 1) {
      const generatedPublicAccountId = publicAccountId();
      const create = this.database.transaction(async () => {
        await this.lockIdentityKeys([
          `account:id:${id}`,
          `account:email:${email}`,
          `account:public:${generatedPublicAccountId}`,
          ...(displayNameKey ? [`account:display:${displayNameKey}`] : []),
          ...(supabaseUserId ? [`account:supabase:${supabaseUserId}`] : []),
        ]);
        if (await this.identityOwner("account.id = ?", id)) {
          throw new AccountSessionRepositoryError("account_identity_conflict");
        }
        if (await this.identityOwner("lower(account.email) = ?", email)) {
          throw new AccountSessionRepositoryError("account_identity_conflict");
        }
        if (displayNameKey && await this.identityOwner("lower(account.display_name_key) = ?", displayNameKey)) {
          throw new AccountSessionRepositoryError("display_name_conflict");
        }
        if (supabaseUserId && await this.identityOwner("account.supabase_user_id = ?", supabaseUserId)) {
          throw new AccountSessionRepositoryError("account_identity_conflict");
        }
        if (await this.identityOwner("account.public_account_id = ?", generatedPublicAccountId)) {
          return null;
        }

        await this.database.prepare(
          `INSERT INTO accounts (
             id, public_account_id, email, password_hash, display_name,
             display_name_key, avatar_url, auth_provider, supabase_user_id,
             email_verified_at, mfa_level, mfa_verified_at, role,
             subscription_status, terms_accepted_at, privacy_accepted_at,
             terms_version, privacy_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          generatedPublicAccountId,
          email,
          passwordHash,
          input.displayName ?? null,
          displayNameKey,
          input.avatarUrl ?? null,
          authProvider,
          supabaseUserId,
          emailVerifiedAt,
          requireBoundedText(input.mfaLevel ?? "aal1", 80),
          mfaVerifiedAt,
          input.role,
          input.subscriptionStatus,
          termsAcceptedAt,
          privacyAcceptedAt,
          input.termsVersion ?? null,
          input.privacyVersion ?? null,
          now,
          now,
        );
        const account = await this.getAccountByIdInternal(id);
        if (!account) throw new AccountSessionRepositoryError("account_not_found");
        await this.upsertProfileFromAccount(account, now);
        return account;
      });
      try {
        const created = await create();
        if (created) return created;
      } catch (error) {
        if (error instanceof AccountSessionRepositoryError) throw error;
        if (isConstraintViolation(error)) {
          throw new AccountSessionRepositoryError("account_identity_conflict");
        }
        throw error;
      }
    }
    throw new AccountSessionRepositoryError("account_identity_conflict");
  }

  async linkSupabaseAccount(input: {
    userId: string;
    supabaseUserId: string;
    email: string;
    authProvider: string;
    displayName: string | null;
    displayNameKey?: string | null | undefined;
    avatarUrl: string | null;
    emailVerifiedAt: string | null;
    mfaLevel: string;
    mfaVerifiedAt: string | null;
    now: string;
  }): Promise<BusinessAccount> {
    const userId = requireBoundedText(input.userId);
    const supabaseUserId = requireBoundedText(input.supabaseUserId);
    const email = normalizeEmail(input.email);
    const displayNameKey = normalizeDisplayNameKey(input.displayNameKey);
    const now = requireCanonicalUtc(input.now);
    const link = this.database.transaction(async () => {
      await this.lockIdentityKeys([
        `account:email:${email}`,
        `account:supabase:${supabaseUserId}`,
        ...(displayNameKey ? [`account:display:${displayNameKey}`] : []),
      ]);
      this.requireMutableAccount(await this.lockAccount(userId));
      if (await this.identityOwner("lower(account.email) = ?", email, userId)) {
        throw new AccountSessionRepositoryError("account_identity_conflict");
      }
      if (await this.identityOwner("account.supabase_user_id = ?", supabaseUserId, userId)) {
        throw new AccountSessionRepositoryError("account_identity_conflict");
      }
      if (displayNameKey && await this.identityOwner("lower(account.display_name_key) = ?", displayNameKey, userId)) {
        throw new AccountSessionRepositoryError("display_name_conflict");
      }
      const previous = await this.getAccountByIdInternal(userId);
      if (!previous) throw new AccountSessionRepositoryError("account_not_found");
      const establishesProviderCredentialBoundary = previous.supabaseUserId !== supabaseUserId;
      const result = await this.database.prepare(
        `UPDATE accounts
         SET supabase_user_id = ?, auth_provider = ?, email = ?,
             password_hash = 'supabase-auth', display_name = ?,
             display_name_key = ?, avatar_url = ?,
             email_verified_at = COALESCE(?, email_verified_at),
             mfa_level = ?, mfa_verified_at = ?, updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(
        supabaseUserId,
        requireBoundedText(input.authProvider, 80),
        email,
        input.displayName,
        displayNameKey,
        input.avatarUrl,
        optionalCanonicalUtc(input.emailVerifiedAt),
        requireBoundedText(input.mfaLevel, 80),
        optionalCanonicalUtc(input.mfaVerifiedAt),
        now,
        userId,
      );
      if (result.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
      if (establishesProviderCredentialBoundary) {
        await this.database.prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        ).run(now, userId);
        await this.database.prepare(
          `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
           WHERE user_id = ? AND status = 'active'`,
        ).run(now, userId);
      }
      const account = await this.getAccountByIdInternal(userId);
      if (!account) throw new AccountSessionRepositoryError("account_not_found");
      await this.upsertProfileFromAccount(account, now);
      return account;
    });
    try {
      return await link();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) throw error;
      if (isConstraintViolation(error)) {
        throw new AccountSessionRepositoryError("account_identity_conflict");
      }
      throw error;
    }
  }

  async updateAccountDisplayName(input: {
    userId: string;
    displayName: string | null;
    displayNameKey?: string | null | undefined;
    now: string;
  }): Promise<BusinessAccount> {
    const userId = requireBoundedText(input.userId);
    const displayNameKey = normalizeDisplayNameKey(input.displayNameKey);
    const now = requireCanonicalUtc(input.now);
    const update = this.database.transaction(async () => {
      if (displayNameKey) await this.lockIdentityKeys([`account:display:${displayNameKey}`]);
      this.requireMutableAccount(await this.lockAccount(userId));
      if (displayNameKey && await this.identityOwner("lower(account.display_name_key) = ?", displayNameKey, userId)) {
        throw new AccountSessionRepositoryError("display_name_conflict");
      }
      const result = await this.database.prepare(
        `UPDATE accounts SET display_name = ?, display_name_key = ?, updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(input.displayName, displayNameKey, now, userId);
      if (result.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
      const account = await this.getAccountByIdInternal(userId);
      if (!account) throw new AccountSessionRepositoryError("account_not_found");
      await this.upsertProfileFromAccount(account, now);
      return account;
    });
    try {
      return await update();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) throw error;
      if (isConstraintViolation(error)) {
        throw new AccountSessionRepositoryError("display_name_conflict");
      }
      throw error;
    }
  }

  async updateAccountSecurityClaims(input: {
    userId: string;
    emailVerifiedAt?: string | null | undefined;
    mfaLevel?: string | undefined;
    mfaVerifiedAt?: string | null | undefined;
    now: string;
  }): Promise<BusinessAccount> {
    const userId = requireBoundedText(input.userId);
    const now = requireCanonicalUtc(input.now);
    const update = this.database.transaction(async () => {
      this.requireMutableAccount(await this.lockAccount(userId));
      const result = await this.database.prepare(
        `UPDATE accounts
         SET email_verified_at = COALESCE(?, email_verified_at),
             mfa_level = COALESCE(?, mfa_level),
             mfa_verified_at = COALESCE(?, mfa_verified_at),
             updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(
        optionalCanonicalUtc(input.emailVerifiedAt),
        input.mfaLevel == null ? null : requireBoundedText(input.mfaLevel, 80),
        optionalCanonicalUtc(input.mfaVerifiedAt),
        now,
        userId,
      );
      if (result.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
      const account = await this.getAccountByIdInternal(userId);
      if (!account) throw new AccountSessionRepositoryError("account_not_found");
      return account;
    });
    return update();
  }

  async updateAgeConfirmed(userIdInput: string, confirmedAtInput: string): Promise<BusinessAccount> {
    const userId = requireBoundedText(userIdInput);
    const confirmedAt = requireCanonicalUtc(confirmedAtInput);
    const update = this.database.transaction(async () => {
      this.requireMutableAccount(await this.lockAccount(userId));
      const result = await this.database.prepare(
        `UPDATE accounts SET age_confirmed_at = ?, updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(confirmedAt, confirmedAt, userId);
      if (result.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
      await this.database.prepare(
        "UPDATE profiles SET updated_at = ? WHERE id = ?",
      ).run(confirmedAt, userId);
      const account = await this.getAccountByIdInternal(userId);
      if (!account) throw new AccountSessionRepositoryError("account_not_found");
      return account;
    });
    return update();
  }

  async updateLegalAcceptance(input: {
    userId: string;
    acceptedAt: string;
    termsVersion: string;
    privacyVersion: string;
  }): Promise<BusinessAccount> {
    const userId = requireBoundedText(input.userId);
    const acceptedAt = requireCanonicalUtc(input.acceptedAt);
    const update = this.database.transaction(async () => {
      this.requireMutableAccount(await this.lockAccount(userId));
      const result = await this.database.prepare(
        `UPDATE accounts
         SET terms_accepted_at = ?, privacy_accepted_at = ?, terms_version = ?,
             privacy_version = ?, updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(
        acceptedAt,
        acceptedAt,
        requireBoundedText(input.termsVersion, 80),
        requireBoundedText(input.privacyVersion, 80),
        acceptedAt,
        userId,
      );
      if (result.changes !== 1) throw new AccountSessionRepositoryError("account_not_found");
      await this.database.prepare(
        "UPDATE profiles SET updated_at = ? WHERE id = ?",
      ).run(acceptedAt, userId);
      const account = await this.getAccountByIdInternal(userId);
      if (!account) throw new AccountSessionRepositoryError("account_not_found");
      return account;
    });
    return update();
  }

  async listActiveAdminAccounts(excludeUserId?: string): Promise<BusinessAccount[]> {
    const excluded = excludeUserId == null ? null : requireBoundedText(excludeUserId);
    const rows = await this.database.prepare(
      `SELECT ${ACCOUNT_PROJECTION} FROM accounts account
       WHERE account.status = 'active' AND account.auth_provider <> 'deleted'
         AND (account.role = 'admin' OR account.subscription_status = 'admin')
         AND (CAST(? AS TEXT) IS NULL OR account.id <> ?)
       ORDER BY account.created_at ASC, account.id ASC`,
    ).all<AccountRow>(excluded, excluded);
    return rows.map(toAccount);
  }

  async hasDeletionLock(userId: string): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS "locked" FROM account_deletion_requests
       WHERE user_id = ? AND status IN ('processing', 'failed', 'completed') LIMIT 1`,
    ).get<{ locked: number }>(requireBoundedText(userId));
    return Boolean(row);
  }

  async upsertAgeVerification(input: {
    id: string;
    userId: string;
    status: AgeVerificationStatus;
    ageThreshold: number;
    isOver18: boolean;
    providerName: string | null;
    providerReferenceId: string | null;
    checkedAt: string | null;
    expiresAt: string | null;
    now: string;
  }): Promise<AgeVerification> {
    const id = requireBoundedText(input.id);
    const userId = requireBoundedText(input.userId);
    const now = requireCanonicalUtc(input.now);
    if (!Number.isSafeInteger(input.ageThreshold) || input.ageThreshold < 0 || input.ageThreshold > 150) {
      invalidInput();
    }
    const update = this.database.transaction(async () => {
      this.requireMutableAccount(await this.lockAccount(userId));
      await this.database.prepare(
        `INSERT INTO age_verifications (
           id, user_id, status, age_threshold, is_over_18, provider_name,
           provider_reference_id, checked_at, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           age_threshold = excluded.age_threshold,
           is_over_18 = excluded.is_over_18,
           provider_name = excluded.provider_name,
           provider_reference_id = excluded.provider_reference_id,
           checked_at = excluded.checked_at,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE age_verifications.user_id = excluded.user_id`,
      ).run(
        id,
        userId,
        input.status,
        input.ageThreshold,
        booleanBinding(this.database, input.isOver18),
        input.providerName,
        input.providerReferenceId,
        optionalCanonicalUtc(input.checkedAt),
        optionalCanonicalUtc(input.expiresAt),
        now,
        now,
      );
      const verified = input.status === "verified" && input.isOver18;
      await this.database.prepare(
        `UPDATE accounts
         SET age_verification_status = ?, is_over_18_verified = ?, updated_at = ?
         WHERE id = ? AND auth_provider <> 'deleted'`,
      ).run(input.status, booleanBinding(this.database, verified), now, userId);
      await this.database.prepare(
        `UPDATE profiles
         SET age_verification_status = ?, is_over_18_verified = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.status, booleanBinding(this.database, verified), now, userId);
      const verification = await this.getAgeVerificationByIdInternal(id);
      if (!verification || verification.userId !== userId) invalidInput();
      return verification;
    });
    try {
      return await update();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) throw error;
      if (isConstraintViolation(error)) throw new AccountSessionRepositoryError("invalid_input");
      throw error;
    }
  }

  private async getAgeVerificationByIdInternal(id: string): Promise<AgeVerification | null> {
    const row = await this.database.prepare(
      `SELECT ${AGE_VERIFICATION_PROJECTION}
       FROM age_verifications verification WHERE verification.id = ? LIMIT 1`,
    ).get<AgeVerificationRow>(id);
    return row ? toAgeVerification(row) : null;
  }

  async getAgeVerificationById(id: string): Promise<AgeVerification | null> {
    return this.getAgeVerificationByIdInternal(requireBoundedText(id));
  }

  async getLatestAgeVerification(userId: string): Promise<AgeVerification | null> {
    const row = await this.database.prepare(
      `SELECT ${AGE_VERIFICATION_PROJECTION}
       FROM age_verifications verification
       WHERE verification.user_id = ?
       ORDER BY verification.created_at DESC, verification.id DESC LIMIT 1`,
    ).get<AgeVerificationRow>(requireBoundedText(userId));
    return row ? toAgeVerification(row) : null;
  }

  private validateSessionInput(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
    providerSessionIdHash?: string | null | undefined;
  }) {
    const createdAt = requireCanonicalUtc(input.createdAt);
    const expiresAt = requireCanonicalUtc(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalidInput();
    return {
      tokenHash: requireBoundedText(input.tokenHash),
      userId: requireBoundedText(input.userId),
      createdAt,
      expiresAt,
      lastUsedAt: optionalCanonicalUtc(input.lastUsedAt) ?? createdAt,
      lastIpHash: input.lastIpHash == null ? null : requireBoundedText(input.lastIpHash),
      userAgentHash: input.userAgentHash == null ? null : requireBoundedText(input.userAgentHash),
      providerSessionIdHash: input.providerSessionIdHash == null
        ? null
        : requireBoundedText(input.providerSessionIdHash),
    };
  }

  private async insertSession(input: ReturnType<AccountSessionRepository["validateSessionInput"]>): Promise<void> {
    if (input.providerSessionIdHash && await this.isProviderSessionRevoked({
      userId: input.userId,
      providerSessionIdHash: input.providerSessionIdHash,
    })) {
      throw new AccountSessionRepositoryError("provider_session_revoked");
    }
    await this.database.prepare(
      `INSERT INTO auth_sessions (
         token_hash, user_id, provider_session_id_hash, created_at, expires_at,
         last_used_at, last_ip_hash, user_agent_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.tokenHash,
      input.userId,
      input.providerSessionIdHash,
      input.createdAt,
      input.expiresAt,
      input.lastUsedAt,
      input.lastIpHash,
      input.userAgentHash,
    );
  }

  private async isProviderGlobalRevocationPending(userId: string): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS "pending" FROM revoked_provider_sessions
       WHERE user_id = ? AND provider_session_id_hash = ?
       LIMIT 1`,
    ).get<{ pending: number | boolean }>(
      userId,
      PROVIDER_GLOBAL_REVOCATION_PENDING_HASH,
    );
    return row !== undefined;
  }

  async hasProviderGlobalRevocationPending(userId: string): Promise<boolean> {
    return this.isProviderGlobalRevocationPending(requireBoundedText(userId));
  }

  private requireProviderGlobalRevocationOperation(
    operation: ProviderGlobalRevocationOperation,
  ): ProviderGlobalRevocationOperation {
    if (operation !== "logout_all" && operation !== "password_reset") invalidInput();
    return operation;
  }

  private providerGlobalRevocationPendingReason(operation: ProviderGlobalRevocationOperation): string {
    return `${PROVIDER_GLOBAL_REVOCATION_PENDING_PREFIX}${this.requireProviderGlobalRevocationOperation(operation)}`;
  }

  private providerGlobalRevocationClaimReason(
    operation: ProviderGlobalRevocationOperation,
    claimId: string,
  ): string {
    if (!PROVIDER_GLOBAL_REVOCATION_CLAIM.test(claimId)) invalidInput();
    return `${PROVIDER_GLOBAL_REVOCATION_CLAIM_PREFIX}${this.requireProviderGlobalRevocationOperation(operation)}:${claimId}`;
  }

  private providerGlobalRevocationOperationFromReason(reason: string): ProviderGlobalRevocationOperation | null {
    for (const operation of ["logout_all", "password_reset"] as const) {
      if (
        reason === this.providerGlobalRevocationPendingReason(operation)
        || reason.startsWith(`${PROVIDER_GLOBAL_REVOCATION_CLAIM_PREFIX}${operation}:`)
      ) return operation;
    }
    return null;
  }

  private async beginProviderGlobalRevocation(
    userId: string,
    startedAt: string,
    operation: ProviderGlobalRevocationOperation,
    claimId: string,
  ): Promise<void> {
    const result = await this.database.prepare(
      `INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider_session_id_hash) DO NOTHING`,
    ).run(
      userId,
      PROVIDER_GLOBAL_REVOCATION_PENDING_HASH,
      startedAt,
      this.providerGlobalRevocationClaimReason(operation, claimId),
    );
    if (result.changes !== 1) {
      throw new AccountSessionRepositoryError("provider_global_revocation_pending");
    }
  }

  private async requireProviderGlobalRevocationClaim(
    userId: string,
    operation: ProviderGlobalRevocationOperation,
    claimId: string,
  ): Promise<void> {
    const row = await this.database.prepare(
      `SELECT reason AS "reason" FROM revoked_provider_sessions
       WHERE user_id = ? AND provider_session_id_hash = ?
       LIMIT 1`,
    ).get<{ reason: string }>(userId, PROVIDER_GLOBAL_REVOCATION_PENDING_HASH);
    if (row?.reason !== this.providerGlobalRevocationClaimReason(operation, claimId)) {
      throw new AccountSessionRepositoryError("provider_global_revocation_pending");
    }
  }

  private async finishProviderGlobalRevocation(
    userId: string,
    operation: ProviderGlobalRevocationOperation,
    claimId: string,
    finishedAt: string,
    completed: boolean,
  ): Promise<void> {
    const claimReason = this.providerGlobalRevocationClaimReason(operation, claimId);
    const result = completed
      ? await this.database.prepare(
          `DELETE FROM revoked_provider_sessions
           WHERE user_id = ? AND provider_session_id_hash = ? AND reason = ?`,
        ).run(userId, PROVIDER_GLOBAL_REVOCATION_PENDING_HASH, claimReason)
      : await this.database.prepare(
          `UPDATE revoked_provider_sessions
           SET revoked_at = ?, reason = ?
           WHERE user_id = ? AND provider_session_id_hash = ? AND reason = ?`,
        ).run(
          finishedAt,
          this.providerGlobalRevocationPendingReason(operation),
          userId,
          PROVIDER_GLOBAL_REVOCATION_PENDING_HASH,
          claimReason,
        );
    if (result.changes !== 1) {
      throw new AccountSessionRepositoryError("provider_global_revocation_pending");
    }
  }

  async claimProviderGlobalRevocation(input: {
    userId: string;
    claimId: string;
    claimedAt: string;
  }): Promise<
    | { status: "claimed"; operation: ProviderGlobalRevocationOperation }
    | { status: "absent" | "busy" }
  > {
    const userId = requireBoundedText(input.userId);
    const claimedAt = requireCanonicalUtc(input.claimedAt);
    const staleBefore = new Date(
      Date.parse(claimedAt) - PROVIDER_GLOBAL_REVOCATION_CLAIM_LEASE_MS,
    ).toISOString();
    const claim = this.database.transaction(async (): Promise<
      | { status: "claimed"; operation: ProviderGlobalRevocationOperation }
      | { status: "absent" | "busy" }
    > => {
      if (!await this.lockAccount(userId)) {
        throw new AccountSessionRepositoryError("account_not_found");
      }
      const marker = await this.database.prepare(
        `SELECT revoked_at AS "revokedAt", reason AS "reason"
         FROM revoked_provider_sessions
         WHERE user_id = ? AND provider_session_id_hash = ?
         LIMIT 1`,
      ).get<{ revokedAt: string; reason: string }>(userId, PROVIDER_GLOBAL_REVOCATION_PENDING_HASH);
      if (!marker) return { status: "absent" };
      const operation = this.providerGlobalRevocationOperationFromReason(marker.reason);
      if (!operation) return { status: "busy" };
      const claimIsStale = marker.reason.startsWith(PROVIDER_GLOBAL_REVOCATION_CLAIM_PREFIX)
        && Date.parse(marker.revokedAt) <= Date.parse(staleBefore);
      if (marker.reason !== this.providerGlobalRevocationPendingReason(operation) && !claimIsStale) {
        return { status: "busy" };
      }
      const claimReason = this.providerGlobalRevocationClaimReason(operation, input.claimId);
      const result = await this.database.prepare(
        `UPDATE revoked_provider_sessions
         SET revoked_at = ?, reason = ?
         WHERE user_id = ? AND provider_session_id_hash = ?
           AND revoked_at = ? AND reason = ?`,
      ).run(
        claimedAt,
        claimReason,
        userId,
        PROVIDER_GLOBAL_REVOCATION_PENDING_HASH,
        marker.revokedAt,
        marker.reason,
      );
      return result.changes === 1 ? { status: "claimed", operation } : { status: "busy" };
    });
    return claim();
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
    providerSessionIdHash?: string | null | undefined;
  }): Promise<void> {
    const normalized = this.validateSessionInput(input);
    const create = this.database.transaction(async () => {
      this.requireSessionEligibleAccount(await this.lockAccount(normalized.userId));
      if (await this.isProviderGlobalRevocationPending(normalized.userId)) {
        throw new AccountSessionRepositoryError("account_not_session_eligible");
      }
      await this.insertSession(normalized);
    });
    try {
      await create();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) throw error;
      if (isConstraintViolation(error)) throw new AccountSessionRepositoryError("session_conflict");
      throw error;
    }
  }

  async createSessionWithLimit(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
    providerSessionIdHash?: string | null | undefined;
    maxActiveSessions: number;
  }): Promise<SessionMutationSummary> {
    const normalized = this.validateSessionInput(input);
    const maxActiveSessions = normalizeActiveSessionLimit(input.maxActiveSessions);
    const create = this.database.transaction(async () => {
      this.requireSessionEligibleAccount(await this.lockAccount(normalized.userId));
      if (await this.isProviderGlobalRevocationPending(normalized.userId)) {
        throw new AccountSessionRepositoryError("account_not_session_eligible");
      }
      await this.insertSession(normalized);
      return this.revokeExcessActiveSessionsInternal({
        userId: normalized.userId,
        now: normalized.createdAt,
        maxActiveSessions,
        preserveTokenHash: normalized.tokenHash,
      });
    });
    try {
      return await create();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) throw error;
      if (isConstraintViolation(error)) throw new AccountSessionRepositoryError("session_conflict");
      throw error;
    }
  }

  /** Atomically rotates or creates one provider-bound browser app session. */
  async rotateOrCreateSessionToken(
    input: AccountSessionTokenRotationInput,
  ): Promise<AccountSessionTokenRotationResult> {
    return this.rotateOrCreateSessionTokenAtomic(input, "status");
  }

  /**
   * Atomically commits a Supabase account mutation with its provider-bound app
   * session and returns the account projection loaded inside that transaction.
   */
  async rotateOrCreateSessionTokenWithSupabaseAccountMutation(
    input: SupabaseAccountSessionTokenRotationInput,
  ): Promise<SupabaseAccountSessionTokenRotationResult> {
    return this.rotateOrCreateSessionTokenAtomic(input, "supabase_account");
  }

  private rotateOrCreateSessionTokenAtomic(
    input: AccountSessionTokenRotationInput,
    response: "status",
  ): Promise<AccountSessionTokenRotationResult>;
  private rotateOrCreateSessionTokenAtomic(
    input: SupabaseAccountSessionTokenRotationInput,
    response: "supabase_account",
  ): Promise<SupabaseAccountSessionTokenRotationResult>;
  private async rotateOrCreateSessionTokenAtomic(
    input: AccountSessionTokenRotationInput,
    response: "status" | "supabase_account",
  ): Promise<AccountSessionTokenRotationResult | SupabaseAccountSessionTokenRotationResult> {
    const currentTokenHash = input.currentTokenHash == null
      ? null
      : requireSha256Hash(input.currentTokenHash);
    const newTokenHash = requireSha256Hash(input.newTokenHash);
    const providerSessionIdHash = requireSha256Hash(input.providerSessionIdHash);
    const providerTokenIssuedAt = input.providerTokenIssuedAt == null
      ? null
      : requireCanonicalUtc(input.providerTokenIssuedAt);
    const supabaseAccountMutation = input.supabaseAccountMutation == null
      ? null
      : normalizeSupabaseAccountSessionMutation(input.supabaseAccountMutation);
    const maxActiveSessions = normalizeActiveSessionLimit(input.maxActiveSessions);
    const normalized = this.validateSessionInput({
      tokenHash: newTokenHash,
      userId: input.userId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      lastUsedAt: input.lastUsedAt,
      lastIpHash: input.lastIpHash,
      userAgentHash: input.userAgentHash,
      providerSessionIdHash,
    });
    if (currentTokenHash && currentTokenHash === normalized.tokenHash) invalidInput();
    if (
      Date.parse(normalized.lastUsedAt) < Date.parse(normalized.createdAt)
      || Date.parse(normalized.lastUsedAt) >= Date.parse(normalized.expiresAt)
    ) invalidInput();

    const conflictResult = (): AccountSessionTokenRotationResult | SupabaseAccountSessionTokenRotationResult =>
      response === "supabase_account" ? { status: "conflict" } : "conflict";
    const rotateOrCreate = this.database.transaction(async (): Promise<
      AccountSessionTokenRotationResult | SupabaseAccountSessionTokenRotationResult
    > => {
      if (supabaseAccountMutation) {
        // Keep the global identity -> account -> session lock order used by
        // account linking. Conflict checks and every write still happen only
        // after the account/session authority has been locked and revalidated.
        await this.lockIdentityKeys([
          `account:email:${supabaseAccountMutation.email}`,
          `account:supabase:${supabaseAccountMutation.supabaseUserId}`,
          ...(supabaseAccountMutation.displayNameKey
            ? [`account:display:${supabaseAccountMutation.displayNameKey}`]
            : []),
        ]);
      }
      const account = this.requireSessionEligibleAccount(await this.lockAccount(normalized.userId));
      if (await this.isProviderGlobalRevocationPending(normalized.userId)) return conflictResult();
      if (
        account.providerTokensValidAfter
        && (
          providerTokenIssuedAt === null
          || Date.parse(providerTokenIssuedAt) <= Date.parse(account.providerTokensValidAfter)
        )
      ) return conflictResult();
      const current = currentTokenHash
        ? await this.lockSessionByTokenForUser(currentTokenHash, normalized.userId)
        : null;
      if (currentTokenHash && !current) return conflictResult();
      if (current && (
        current.revokedAt !== null
        || Date.parse(current.createdAt) > Date.parse(normalized.createdAt)
        || Date.parse(current.expiresAt) <= Date.parse(normalized.createdAt)
      )) return conflictResult();
      if (
        current?.providerSessionIdHash && await this.isProviderSessionRevoked({
          userId: normalized.userId,
          providerSessionIdHash: current.providerSessionIdHash,
        })
      ) return conflictResult();
      if (!normalized.providerSessionIdHash || await this.isProviderSessionRevoked({
        userId: normalized.userId,
        providerSessionIdHash: normalized.providerSessionIdHash,
      })) return conflictResult();
      if (await this.hasActiveProviderSessionForUser({
        userId: normalized.userId,
        providerSessionIdHash: normalized.providerSessionIdHash,
        now: normalized.createdAt,
        excludingTokenHash: current?.tokenHash ?? null,
      })) return conflictResult();

      const accountMutation = supabaseAccountMutation
        ? await this.applySupabaseAccountSessionMutationLocked(
            normalized.userId,
            supabaseAccountMutation,
            normalized.createdAt,
          )
        : null;

      await this.insertSession(normalized);

      if (current && currentTokenHash && !accountMutation?.establishedProviderCredentialBoundary) {
        await this.database.prepare(
          `UPDATE account_discount_passes
           SET status = 'revoked', revoked_at = ?
           WHERE user_id = ? AND session_token_hash = ? AND status = 'active'`,
        ).run(normalized.createdAt, normalized.userId, currentTokenHash);
        const revoked = await this.database.prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE token_hash = ? AND user_id = ?
             AND revoked_at IS NULL AND expires_at > ?`,
        ).run(normalized.createdAt, currentTokenHash, normalized.userId, normalized.createdAt);
        if (revoked.changes !== 1) {
          throw new AccountSessionRepositoryError("session_conflict");
        }
      }
      await this.revokeExcessActiveSessionsInternal({
        userId: normalized.userId,
        now: normalized.createdAt,
        maxActiveSessions,
        preserveTokenHash: normalized.tokenHash,
      });
      const status = current ? "rotated" : "created";
      if (response === "supabase_account") {
        if (!accountMutation) throw new AccountSessionRepositoryError("invalid_input");
        return { status, account: accountMutation.account };
      }
      return status;
    });

    try {
      return await rotateOrCreate();
    } catch (error) {
      if (error instanceof AccountSessionRepositoryError) {
        if (error.code === "provider_session_revoked" || error.code === "session_conflict") {
          return conflictResult();
        }
        throw error;
      }
      if (isConstraintViolation(error)) return conflictResult();
      throw error;
    }
  }

  private activeSessionRankingCte(): string {
    return `WITH ranked_active_sessions AS (
      SELECT session.token_hash, session.user_id, session.provider_session_id_hash,
             row_number() OVER (
               PARTITION BY session.user_id
               ORDER BY CASE WHEN session.token_hash = @preserveTokenHash THEN 1 ELSE 0 END DESC,
                        COALESCE(session.last_used_at, session.created_at) DESC,
                        session.created_at DESC,
                        session.token_hash DESC
             ) AS session_rank
      FROM auth_sessions session
      WHERE session.revoked_at IS NULL
        AND session.expires_at > @now
        AND (CAST(@userId AS TEXT) IS NULL OR session.user_id = @userId)
    ), excess_sessions AS (
      SELECT token_hash, user_id, provider_session_id_hash
      FROM ranked_active_sessions
      WHERE session_rank > @maxActiveSessions
    )`;
  }

  private async revokeExcessActiveSessionsInternal(input: {
    now: string;
    maxActiveSessions: number;
    userId?: string | undefined;
    preserveTokenHash?: string | undefined;
  }): Promise<SessionMutationSummary> {
    const bindings = {
      now: input.now,
      maxActiveSessions: input.maxActiveSessions,
      userId: input.userId ?? null,
      preserveTokenHash: input.preserveTokenHash ?? null,
    };
    const ranking = this.activeSessionRankingCte();
    const providerRevokedAt = this.database.dialect === "postgres"
      ? "CAST(@now AS TIMESTAMPTZ)"
      : "@now";
    const providerRevocations = await this.database.prepare(
      `${ranking}, provider_candidates AS (
         SELECT DISTINCT excess.user_id, excess.provider_session_id_hash
         FROM excess_sessions excess
         WHERE excess.provider_session_id_hash IS NOT NULL
       )
       INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       )
       SELECT candidate.user_id, candidate.provider_session_id_hash,
              ${providerRevokedAt}, 'session_limit_exceeded'
       FROM provider_candidates candidate
       WHERE NOT EXISTS (
         SELECT 1 FROM ranked_active_sessions retained
         WHERE retained.session_rank <= @maxActiveSessions
           AND retained.user_id = candidate.user_id
           AND retained.provider_session_id_hash = candidate.provider_session_id_hash
       )
       ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
         revoked_at = excluded.revoked_at,
         reason = excluded.reason`,
    ).run(bindings);
    const revokedDiscountPasses = await this.database.prepare(
      `${ranking}
       UPDATE account_discount_passes
       SET status = 'revoked', revoked_at = @now
       WHERE status = 'active'
         AND session_token_hash IN (SELECT token_hash FROM excess_sessions)`,
    ).run(bindings);
    const revokedSessions = await this.database.prepare(
      `${ranking}
       UPDATE auth_sessions
       SET revoked_at = @now
       WHERE revoked_at IS NULL
         AND token_hash IN (SELECT token_hash FROM excess_sessions)`,
    ).run(bindings);
    return {
      revokedSessions: revokedSessions.changes,
      revokedDiscountPasses: revokedDiscountPasses.changes,
      revokedProviderSessions: providerRevocations.changes,
    };
  }

  async revokeExcessActiveSessions(input: {
    now: string;
    maxActiveSessions: number;
    userId?: string | undefined;
    preserveTokenHash?: string | undefined;
  }): Promise<SessionMutationSummary> {
    const now = requireCanonicalUtc(input.now);
    const maxActiveSessions = normalizeActiveSessionLimit(input.maxActiveSessions);
    const userId = input.userId == null ? undefined : requireBoundedText(input.userId);
    const preserveTokenHash = input.preserveTokenHash == null
      ? undefined
      : requireBoundedText(input.preserveTokenHash);
    const revoke = this.database.transaction(async () => {
      if (userId) {
        if (!await this.lockAccount(userId)) return { ...EMPTY_SESSION_MUTATION };
      } else if (this.database.dialect === "postgres") {
        await this.database.prepare(
          `SELECT account.id AS "id"
           FROM accounts account
           WHERE EXISTS (
             SELECT 1 FROM auth_sessions session
             WHERE session.user_id = account.id
               AND session.revoked_at IS NULL AND session.expires_at > ?
           )
           ORDER BY account.id ASC
           FOR UPDATE OF account`,
        ).all<{ id: string }>(now);
      }
      return this.revokeExcessActiveSessionsInternal({
        now,
        maxActiveSessions,
        ...(userId ? { userId } : {}),
        ...(preserveTokenHash ? { preserveTokenHash } : {}),
      });
    });
    return revoke();
  }

  private activeAccountSessionPredicates(accountAlias = "account", sessionAlias = "session"): string {
    return `${accountAlias}.status <> 'suspended'
      AND ${accountAlias}.auth_provider <> 'deleted'
      AND NOT EXISTS (
        SELECT 1 FROM revoked_provider_sessions provider_global_revocation
        WHERE provider_global_revocation.user_id = ${accountAlias}.id
          AND provider_global_revocation.provider_session_id_hash = '${PROVIDER_GLOBAL_REVOCATION_PENDING_HASH}'
      )
      AND NOT EXISTS (
        SELECT 1 FROM account_deletion_requests deletion
        WHERE deletion.user_id = ${accountAlias}.id
          AND deletion.status IN ('processing', 'failed', 'completed')
      )
      AND (
        ${sessionAlias}.provider_session_id_hash IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM revoked_provider_sessions provider_revocation
          WHERE provider_revocation.user_id = ${sessionAlias}.user_id
            AND provider_revocation.provider_session_id_hash = ${sessionAlias}.provider_session_id_hash
        )
      )`;
  }

  async getAccountBySessionTokenHash(tokenHash: string, nowInput: string): Promise<BusinessAccount | null> {
    const now = requireCanonicalUtc(nowInput);
    return this.findAccount(
      `SELECT ${ACCOUNT_PROJECTION}
       FROM auth_sessions session
       JOIN accounts account ON account.id = session.user_id
       WHERE session.token_hash = ?
         AND session.expires_at > ?
         AND session.revoked_at IS NULL
         AND ${this.activeAccountSessionPredicates()}
       LIMIT 1`,
      requireBoundedText(tokenHash),
      now,
    );
  }

  async getSessionExpiresAt(tokenHash: string, nowInput: string): Promise<string | null> {
    const row = await this.database.prepare(
      `SELECT session.expires_at AS "expiresAt"
       FROM auth_sessions session
       JOIN accounts account ON account.id = session.user_id
       WHERE session.token_hash = ? AND session.expires_at > ?
         AND session.revoked_at IS NULL
         AND ${this.activeAccountSessionPredicates()}
       LIMIT 1`,
    ).get<{ expiresAt: string }>(requireBoundedText(tokenHash), requireCanonicalUtc(nowInput));
    return row?.expiresAt ?? null;
  }

  async getActiveProviderSessionExpiresAt(input: {
    tokenHash: string;
    userId: string;
    providerSessionIdHash: string;
    now: string;
  }): Promise<string | null> {
    const row = await this.database.prepare(
      `SELECT session.expires_at AS "expiresAt"
       FROM auth_sessions session
       JOIN accounts account ON account.id = session.user_id
       WHERE session.token_hash = ? AND session.user_id = ?
         AND session.provider_session_id_hash = ?
         AND session.revoked_at IS NULL AND session.expires_at > ?
         AND ${this.activeAccountSessionPredicates()}
       LIMIT 1`,
    ).get<{ expiresAt: string }>(
      requireBoundedText(input.tokenHash),
      requireBoundedText(input.userId),
      requireBoundedText(input.providerSessionIdHash),
      requireCanonicalUtc(input.now),
    );
    return row?.expiresAt ?? null;
  }

  async getActiveSessionCreatedAt(input: {
    tokenHash: string;
    userId: string;
    now: string;
  }): Promise<string | null> {
    const row = await this.database.prepare(
      `SELECT session.created_at AS "createdAt"
       FROM auth_sessions session
       JOIN accounts account ON account.id = session.user_id
       WHERE session.token_hash = ? AND session.user_id = ?
         AND session.expires_at > ? AND session.revoked_at IS NULL
         AND ${this.activeAccountSessionPredicates()}
       LIMIT 1`,
    ).get<{ createdAt: string }>(
      requireBoundedText(input.tokenHash),
      requireBoundedText(input.userId),
      requireCanonicalUtc(input.now),
    );
    return row?.createdAt ?? null;
  }

  private async userIdForSession(tokenHash: string): Promise<string | null> {
    const row = await this.database.prepare(
      "SELECT user_id AS \"userId\" FROM auth_sessions WHERE token_hash = ? LIMIT 1",
    ).get<{ userId: string }>(tokenHash);
    return row?.userId ?? null;
  }

  async touchSession(input: {
    tokenHash: string;
    lastUsedAt: string;
    lastIpHash: string | null;
    userAgentHash: string | null;
  }): Promise<boolean> {
    const tokenHash = requireBoundedText(input.tokenHash);
    const lastUsedAt = requireCanonicalUtc(input.lastUsedAt);
    const threshold = new Date(Date.parse(lastUsedAt) - TOUCH_THROTTLE_MS).toISOString();
    const lastIpHash = input.lastIpHash == null ? null : requireBoundedText(input.lastIpHash);
    const userAgentHash = input.userAgentHash == null ? null : requireBoundedText(input.userAgentHash);
    const touch = this.database.transaction(async () => {
      const userId = await this.userIdForSession(tokenHash);
      if (!userId) return false;
      try {
        this.requireSessionEligibleAccount(await this.lockAccount(userId));
      } catch (error) {
        if (error instanceof AccountSessionRepositoryError) return false;
        throw error;
      }
      if (await this.isProviderGlobalRevocationPending(userId)) return false;
      const result = await this.database.prepare(
        `UPDATE auth_sessions AS session
         SET last_used_at = ?, last_ip_hash = ?, user_agent_hash = ?
         WHERE session.token_hash = ? AND session.user_id = ?
           AND session.revoked_at IS NULL AND session.expires_at > ?
           AND (session.last_used_at IS NULL OR session.last_used_at <= ?)
           AND (
             session.last_used_at IS NULL OR session.last_used_at <= ?
             OR session.last_ip_hash IS DISTINCT FROM ?
             OR session.user_agent_hash IS DISTINCT FROM ?
           )
           AND (
             session.provider_session_id_hash IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM revoked_provider_sessions provider_revocation
               WHERE provider_revocation.user_id = session.user_id
                 AND provider_revocation.provider_session_id_hash = session.provider_session_id_hash
             )
           )`,
      ).run(
        lastUsedAt,
        lastIpHash,
        userAgentHash,
        tokenHash,
        userId,
        lastUsedAt,
        lastUsedAt,
        threshold,
        lastIpHash,
        userAgentHash,
      );
      return result.changes === 1;
    });
    return touch();
  }

  private async lockSessionByToken(tokenHash: string): Promise<SessionRow | null> {
    const suffix = this.database.dialect === "postgres" ? " FOR UPDATE OF session" : "";
    const row = await this.database.prepare(
      `SELECT ${SESSION_PROJECTION} FROM auth_sessions session
       WHERE session.token_hash = ? LIMIT 1${suffix}`,
    ).get<SessionRow>(tokenHash);
    return row ?? null;
  }

  private async lockSessionByTokenForUser(tokenHash: string, userId: string): Promise<SessionRow | null> {
    const suffix = this.database.dialect === "postgres" ? " FOR UPDATE OF session" : "";
    const row = await this.database.prepare(
      `SELECT ${SESSION_PROJECTION} FROM auth_sessions session
       WHERE session.token_hash = ? AND session.user_id = ? LIMIT 1${suffix}`,
    ).get<SessionRow>(tokenHash, userId);
    return row ?? null;
  }

  private async hasActiveProviderSessionForUser(input: {
    userId: string;
    providerSessionIdHash: string;
    now: string;
    excludingTokenHash: string | null;
  }): Promise<boolean> {
    const suffix = this.database.dialect === "postgres" ? " FOR UPDATE OF session" : "";
    const row = await this.database.prepare(
      `SELECT session.token_hash AS "tokenHash" FROM auth_sessions session
       WHERE session.user_id = ? AND session.provider_session_id_hash = ?
         AND session.revoked_at IS NULL AND session.expires_at > ?
         AND (CAST(? AS TEXT) IS NULL OR session.token_hash <> ?)
       ORDER BY session.token_hash ASC LIMIT 1${suffix}`,
    ).get<{ tokenHash: string }>(
      input.userId,
      input.providerSessionIdHash,
      input.now,
      input.excludingTokenHash,
      input.excludingTokenHash,
    );
    return Boolean(row);
  }

  private async upsertProviderRevocation(input: {
    userId: string;
    providerSessionIdHash: string;
    revokedAt: string;
    reason: string;
  }): Promise<void> {
    await this.database.prepare(
      `INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
         revoked_at = excluded.revoked_at,
         reason = excluded.reason`,
    ).run(input.userId, input.providerSessionIdHash, input.revokedAt, input.reason);
  }

  private async revokeSessionDiscountPasses(input: {
    userId: string;
    tokenHash?: string | undefined;
    providerSessionIdHash?: string | undefined;
    revokedAt: string;
  }): Promise<number> {
    const result = input.providerSessionIdHash
      ? await this.database.prepare(
        `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
         WHERE status = 'active' AND session_token_hash IN (
           SELECT token_hash FROM auth_sessions
           WHERE user_id = ? AND provider_session_id_hash = ?
         )`,
      ).run(input.revokedAt, input.userId, input.providerSessionIdHash)
      : await this.database.prepare(
        `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
         WHERE status = 'active' AND user_id = ? AND session_token_hash = ?`,
      ).run(input.revokedAt, input.userId, input.tokenHash ?? null);
    return result.changes;
  }

  async revokeSessionWithSummary(input: { tokenHash: string; revokedAt: string }): Promise<{
    revoked: boolean;
    revokedDiscountPasses: number;
  }> {
    const tokenHash = requireBoundedText(input.tokenHash);
    const revokedAt = requireCanonicalUtc(input.revokedAt);
    const revoke = this.database.transaction(async () => {
      const userId = await this.userIdForSession(tokenHash);
      if (!userId || !await this.lockAccount(userId)) return { revoked: false, revokedDiscountPasses: 0 };
      const session = await this.lockSessionByToken(tokenHash);
      if (!session || session.userId !== userId || session.revokedAt !== null) {
        return { revoked: false, revokedDiscountPasses: 0 };
      }
      const result = session.providerSessionIdHash
        ? await this.database.prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE user_id = ? AND provider_session_id_hash = ? AND revoked_at IS NULL`,
        ).run(revokedAt, userId, session.providerSessionIdHash)
        : await this.database.prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`,
        ).run(revokedAt, tokenHash, userId);
      if (session.providerSessionIdHash) {
        await this.upsertProviderRevocation({
          userId,
          providerSessionIdHash: session.providerSessionIdHash,
          revokedAt,
          reason: "app_session_revoked",
        });
      }
      const revokedDiscountPasses = await this.revokeSessionDiscountPasses({
        userId,
        ...(session.providerSessionIdHash
          ? { providerSessionIdHash: session.providerSessionIdHash }
          : { tokenHash }),
        revokedAt,
      });
      return { revoked: result.changes > 0, revokedDiscountPasses };
    });
    return revoke();
  }

  async revokeSession(input: { tokenHash: string; revokedAt: string }): Promise<boolean> {
    return (await this.revokeSessionWithSummary(input)).revoked;
  }

  private async revokeAllProviderSessionsForUser(input: {
    userId: string;
    revokedAt: string;
    reason: string;
  }): Promise<number> {
    const revokedAt = this.database.dialect === "postgres"
      ? "CAST(? AS TIMESTAMPTZ)"
      : "?";
    const result = await this.database.prepare(
      `INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       )
       SELECT DISTINCT session.user_id, session.provider_session_id_hash, ${revokedAt}, ?
       FROM auth_sessions session
       WHERE session.user_id = ? AND session.provider_session_id_hash IS NOT NULL
       ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
         revoked_at = excluded.revoked_at,
         reason = excluded.reason`,
    ).run(input.revokedAt, input.reason, input.userId);
    return result.changes;
  }

  async revokeUserSessionsWithSummary(input: {
    userId: string;
    revokedAt: string;
    providerTokensValidAfter?: string | null | undefined;
    beginProviderGlobalRevocation?: {
      claimId: string;
      operation: ProviderGlobalRevocationOperation;
    } | undefined;
    finishProviderGlobalRevocation?: {
      claimId: string;
      completed: boolean;
      operation: ProviderGlobalRevocationOperation;
    } | undefined;
  }): Promise<{
    revokedSessions: number;
    revokedDiscountPasses: number;
  }> {
    const userId = requireBoundedText(input.userId);
    const revokedAt = requireCanonicalUtc(input.revokedAt);
    const providerTokensValidAfter = input.providerTokensValidAfter == null
      ? null
      : requireCanonicalUtc(input.providerTokensValidAfter);
    if (input.beginProviderGlobalRevocation && input.finishProviderGlobalRevocation) {
      invalidInput();
    }
    const revoke = this.database.transaction(async () => {
      const account = await this.lockAccount(userId);
      if (!account) return { revokedSessions: 0, revokedDiscountPasses: 0 };
      if (input.beginProviderGlobalRevocation) {
        await this.beginProviderGlobalRevocation(
          userId,
          revokedAt,
          input.beginProviderGlobalRevocation.operation,
          input.beginProviderGlobalRevocation.claimId,
        );
      }
      if (input.finishProviderGlobalRevocation) {
        await this.requireProviderGlobalRevocationClaim(
          userId,
          input.finishProviderGlobalRevocation.operation,
          input.finishProviderGlobalRevocation.claimId,
        );
      }
      if (providerTokensValidAfter) {
        await this.advanceProviderTokensValidAfter({
          account,
          candidate: providerTokensValidAfter,
          updatedAt: revokedAt,
        });
      }
      await this.revokeAllProviderSessionsForUser({
        userId,
        revokedAt,
        reason: "all_app_sessions_revoked",
      });
      const revokedDiscountPasses = await this.database.prepare(
        `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
         WHERE user_id = ? AND status = 'active'`,
      ).run(revokedAt, userId);
      const result = await this.database.prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, userId);
      if (input.finishProviderGlobalRevocation) {
        await this.finishProviderGlobalRevocation(
          userId,
          input.finishProviderGlobalRevocation.operation,
          input.finishProviderGlobalRevocation.claimId,
          revokedAt,
          input.finishProviderGlobalRevocation.completed,
        );
      }
      return { revokedSessions: result.changes, revokedDiscountPasses: revokedDiscountPasses.changes };
    });
    return revoke();
  }

  async revokeUserSessions(input: { userId: string; revokedAt: string }): Promise<number> {
    return (await this.revokeUserSessionsWithSummary(input)).revokedSessions;
  }

  async completePasswordResetContainment(input: {
    userId: string;
    providerSessionIdHash: string;
    providerTokensValidAfter: string;
    revokedAt: string;
    beginProviderGlobalRevocation?: {
      claimId: string;
      operation: ProviderGlobalRevocationOperation;
    } | undefined;
    finishProviderGlobalRevocation?: {
      claimId: string;
      completed: boolean;
      operation: ProviderGlobalRevocationOperation;
    } | undefined;
  }): Promise<{ revokedSessions: number; revokedDiscountPasses: number; cancelledRewardCodes: number }> {
    const userId = requireBoundedText(input.userId);
    const providerSessionIdHash = requireBoundedText(input.providerSessionIdHash);
    const providerTokensValidAfter = requireCanonicalUtc(input.providerTokensValidAfter);
    const revokedAt = requireCanonicalUtc(input.revokedAt);
    if (input.beginProviderGlobalRevocation && input.finishProviderGlobalRevocation) {
      invalidInput();
    }
    const contain = this.database.transaction(async () => {
      const account = await this.lockAccount(userId);
      if (!account) {
        throw new AccountSessionRepositoryError("account_not_found");
      }
      if (input.beginProviderGlobalRevocation) {
        await this.beginProviderGlobalRevocation(
          userId,
          revokedAt,
          input.beginProviderGlobalRevocation.operation,
          input.beginProviderGlobalRevocation.claimId,
        );
      }
      if (input.finishProviderGlobalRevocation) {
        await this.requireProviderGlobalRevocationClaim(
          userId,
          input.finishProviderGlobalRevocation.operation,
          input.finishProviderGlobalRevocation.claimId,
        );
      }
      await this.revokeAllProviderSessionsForUser({
        userId,
        revokedAt,
        reason: "password_reset_completed",
      });
      await this.upsertProviderRevocation({
        userId,
        providerSessionIdHash,
        revokedAt,
        reason: "password_reset_completed",
      });
      const revokedSessions = await this.database.prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(revokedAt, userId);
      const revokedDiscountPasses = await this.database.prepare(
        `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
         WHERE user_id = ? AND status = 'active'`,
      ).run(revokedAt, userId);
      const cancelledRewardCodes = await this.database.prepare(
        `UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ?
         WHERE user_id = ? AND status = 'active'`,
      ).run(revokedAt, userId);
      await this.advanceProviderTokensValidAfter({
        account,
        candidate: providerTokensValidAfter,
        updatedAt: revokedAt,
      });
      if (input.finishProviderGlobalRevocation) {
        await this.finishProviderGlobalRevocation(
          userId,
          input.finishProviderGlobalRevocation.operation,
          input.finishProviderGlobalRevocation.claimId,
          revokedAt,
          input.finishProviderGlobalRevocation.completed,
        );
      }
      return {
        revokedSessions: revokedSessions.changes,
        revokedDiscountPasses: revokedDiscountPasses.changes,
        cancelledRewardCodes: cancelledRewardCodes.changes,
      };
    });
    return contain();
  }

  async revokeProviderSession(input: {
    userId: string;
    providerSessionIdHash: string;
    revokedAt: string;
    reason: string;
  }): Promise<void> {
    const userId = requireBoundedText(input.userId);
    const providerSessionIdHash = requireBoundedText(input.providerSessionIdHash);
    const revokedAt = requireCanonicalUtc(input.revokedAt);
    const revoke = this.database.transaction(async () => {
      if (!await this.lockAccount(userId)) {
        throw new AccountSessionRepositoryError("account_not_found");
      }
      await this.upsertProviderRevocation({
        userId,
        providerSessionIdHash,
        revokedAt,
        reason: requireBoundedText(input.reason, 160),
      });
      await this.database.prepare(
        `UPDATE auth_sessions SET revoked_at = ?
         WHERE user_id = ? AND provider_session_id_hash = ? AND revoked_at IS NULL`,
      ).run(revokedAt, userId, providerSessionIdHash);
      await this.revokeSessionDiscountPasses({ userId, providerSessionIdHash, revokedAt });
    });
    await revoke();
  }

  async isProviderSessionRevoked(input: {
    userId: string;
    providerSessionIdHash: string;
  }): Promise<boolean> {
    const row = await this.database.prepare(
      `SELECT 1 AS "revoked" FROM revoked_provider_sessions
       WHERE user_id = ? AND provider_session_id_hash = ? LIMIT 1`,
    ).get<{ revoked: number }>(
      requireBoundedText(input.userId),
      requireBoundedText(input.providerSessionIdHash),
    );
    return Boolean(row);
  }

  async listUserSessions(input: {
    userId: string;
    now: string;
    limit?: number;
    offset?: number;
  }): Promise<AccountSession[]> {
    const rows = await this.database.prepare(
      `SELECT ${SESSION_PROJECTION}
       FROM auth_sessions session
       WHERE session.user_id = ? AND session.revoked_at IS NULL AND session.expires_at > ?
         AND (
           session.provider_session_id_hash IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM revoked_provider_sessions provider_revocation
             WHERE provider_revocation.user_id = session.user_id
               AND provider_revocation.provider_session_id_hash = session.provider_session_id_hash
           )
         )
       ORDER BY COALESCE(session.last_used_at, session.created_at) DESC,
                session.created_at DESC, session.token_hash DESC
       LIMIT ? OFFSET ?`,
    ).all<SessionRow>(
      requireBoundedText(input.userId),
      requireCanonicalUtc(input.now),
      normalizeListLimit(input.limit, 100, 200),
      normalizeListOffset(input.offset),
    );
    return rows.map(toSession);
  }

  async listUserSessionHistory(input: {
    userId: string;
    now: string;
    limit?: number;
    offset?: number;
  }): Promise<AccountSession[]> {
    const rows = await this.database.prepare(
      `SELECT ${SESSION_PROJECTION}
       FROM auth_sessions session
       WHERE session.user_id = ?
         AND (
           session.revoked_at IS NOT NULL OR session.expires_at <= ?
           OR (
             session.provider_session_id_hash IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM revoked_provider_sessions provider_revocation
               WHERE provider_revocation.user_id = session.user_id
                 AND provider_revocation.provider_session_id_hash = session.provider_session_id_hash
             )
           )
         )
       ORDER BY COALESCE(session.revoked_at, session.expires_at) DESC,
                session.created_at DESC, session.token_hash DESC
       LIMIT ? OFFSET ?`,
    ).all<SessionRow>(
      requireBoundedText(input.userId),
      requireCanonicalUtc(input.now),
      normalizeListLimit(input.limit, 20, 100),
      normalizeListOffset(input.offset),
    );
    return rows.map(toSession);
  }

  private safeCount(value: number | string | undefined): number {
    return value == null ? 0 : safeNumber(value, true);
  }

  async countUserSessionHistory(userId: string, now: string): Promise<number> {
    const row = await this.database.prepare(
      `SELECT count(*) AS "count" FROM auth_sessions session
       WHERE session.user_id = ?
         AND (
           session.revoked_at IS NOT NULL OR session.expires_at <= ?
           OR (
             session.provider_session_id_hash IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM revoked_provider_sessions provider_revocation
               WHERE provider_revocation.user_id = session.user_id
                 AND provider_revocation.provider_session_id_hash = session.provider_session_id_hash
             )
           )
         )`,
    ).get<{ count: number | string }>(requireBoundedText(userId), requireCanonicalUtc(now));
    return this.safeCount(row?.count);
  }

  async countUserSessions(userId: string, now: string): Promise<number> {
    const row = await this.database.prepare(
      `SELECT count(*) AS "count" FROM auth_sessions session
       WHERE session.user_id = ? AND session.revoked_at IS NULL AND session.expires_at > ?
         AND (
           session.provider_session_id_hash IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM revoked_provider_sessions provider_revocation
             WHERE provider_revocation.user_id = session.user_id
               AND provider_revocation.provider_session_id_hash = session.provider_session_id_hash
           )
         )`,
    ).get<{ count: number | string }>(requireBoundedText(userId), requireCanonicalUtc(now));
    return this.safeCount(row?.count);
  }

  async revokeUserSessionById(input: {
    userId: string;
    sessionId: string;
    revokedAt: string;
  }): Promise<{ revoked: boolean; revokedDiscountPasses: number }> {
    const userId = requireBoundedText(input.userId);
    const sessionId = requireBoundedText(input.sessionId, 24);
    const revokedAt = requireCanonicalUtc(input.revokedAt);
    const revoke = this.database.transaction(async () => {
      if (!await this.lockAccount(userId)) {
        return { revoked: false, revokedDiscountPasses: 0 };
      }
      const suffix = this.database.dialect === "postgres" ? " FOR UPDATE OF session" : "";
      const session = await this.database.prepare(
        `SELECT ${SESSION_PROJECTION} FROM auth_sessions session
         WHERE session.user_id = ? AND substr(session.token_hash, 1, 24) = ?
         ORDER BY session.token_hash ASC LIMIT 1${suffix}`,
      ).get<SessionRow>(userId, sessionId);
      if (!session || session.revokedAt !== null) {
        return { revoked: false, revokedDiscountPasses: 0 };
      }
      const result = session.providerSessionIdHash
        ? await this.database.prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE user_id = ? AND provider_session_id_hash = ? AND revoked_at IS NULL`,
        ).run(revokedAt, userId, session.providerSessionIdHash)
        : await this.database.prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`,
        ).run(revokedAt, session.tokenHash, userId);
      const revokedDiscountPasses = await this.revokeSessionDiscountPasses({
        userId,
        ...(session.providerSessionIdHash
          ? { providerSessionIdHash: session.providerSessionIdHash }
          : { tokenHash: session.tokenHash }),
        revokedAt,
      });
      if (result.changes > 0 && session.providerSessionIdHash) {
        await this.upsertProviderRevocation({
          userId,
          providerSessionIdHash: session.providerSessionIdHash,
          revokedAt,
          reason: "app_session_revoked",
        });
      }
      return { revoked: result.changes > 0, revokedDiscountPasses };
    });
    return revoke();
  }
}
