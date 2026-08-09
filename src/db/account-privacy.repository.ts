import crypto from "node:crypto";

import { billingCheckoutActorLockKey } from "./billing-checkout.repository.js";
import { missionLifecycleAccountLockKey } from "./mission-lifecycle.repository.js";
import {
  SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT,
  sourceEvidenceAccountLockKey,
} from "./source-evidence-object.repository.js";
import type { SqlDatabase, SqlRunResult } from "./sql-database.js";
import { venueAccessAccountLockKey } from "./venue-access.repository.js";
import { venuePartnerAccountLockKey } from "./venue-partner.repository.js";
import { venueRequestAccountLockKey } from "./venue-request.repository.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_IDENTIFIER_LENGTH = 255;

export const ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION = "2026-08-03";
export const ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION = "2026-08-08";

/** Version fence for the source-evidence account lock adopted by anonymisation. */
export const ACCOUNT_PRIVACY_SOURCE_EVIDENCE_LOCK_VERSION =
  SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT.version;

export const ACCOUNT_PRIVACY_TRANSACTION_TABLES = Object.freeze([
  "accounts",
  "profiles",
  "auth_sessions",
  "revoked_provider_sessions",
  "billing_checkout_reservations",
  "account_discount_passes",
  "account_preferences",
  "account_privacy_settings",
  "saved_items",
  "user_activity_events",
  "events",
  "age_verifications",
  "verifications",
  "mission_progress",
  "venue_manager_assignments",
  "discount_redemptions",
  "pint_point_drink_records",
  "pint_point_ledger",
  "free_pint_reward_codes",
  "free_pint_reward_redemptions",
  "leaderboard_prize_awards",
  "account_reward_vouchers",
  "leaderboard_prize_campaigns",
  "venue_pending_changes",
  "venue_partner_outreach",
  "feedback",
  "wrong_price_reports",
  "venue_requests",
  "venue_interest_requests",
  "venue_claim_requests",
  "submissions",
  "submission_items",
  "submission_source_evidence",
  "contribution_ledger",
  "venue_price_records",
  "source_evidence_objects",
  "system_state",
  "migration_quarantined_records",
  "security_audit_log",
  "stripe_webhook_events",
  "account_deletion_requests",
  "account_deletion_completion_outbox",
  "account_deletion_notice_recipient_secrets",
] as const);

export type AccountPrivacyRepositoryErrorCode =
  | "invalid_input"
  | "account_not_found"
  | "deletion_request_not_found"
  | "deletion_attempt_conflict"
  | "identity_deletion_unconfirmed"
  | "stripe_deletion_unconfirmed"
  | "tombstone_unconfirmed"
  | "notification_not_prepared"
  | "stored_json_invalid"
  | "completion_conflict";

const ERROR_MESSAGES: Readonly<Record<AccountPrivacyRepositoryErrorCode, string>> = {
  invalid_input: "The account privacy input is invalid.",
  account_not_found: "The account does not exist.",
  deletion_request_not_found: "The account deletion request does not exist.",
  deletion_attempt_conflict: "The account deletion attempt no longer owns the request.",
  identity_deletion_unconfirmed: "The external account identity deletion is not durably confirmed.",
  stripe_deletion_unconfirmed: "The external billing customer deletion is not durably confirmed.",
  tombstone_unconfirmed: "The independent account deletion tombstone is not durably confirmed.",
  notification_not_prepared: "The completion notification was not durably prepared.",
  stored_json_invalid: "Stored privacy-related JSON is invalid.",
  completion_conflict: "The account deletion completion state conflicts with durable state.",
};

/** Stable failures never interpolate account identifiers, emails, or provider data. */
export class AccountPrivacyRepositoryError extends Error {
  readonly code: AccountPrivacyRepositoryErrorCode;

  constructor(code: AccountPrivacyRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AccountPrivacyRepositoryError";
    this.code = code;
  }
}

export type PrivacyExportRow = Readonly<Record<string, unknown>>;

export interface AccountPrivacyExport {
  accountPrivate: PrivacyExportRow;
  profile: PrivacyExportRow | null;
  preferences: PrivacyExportRow | null;
  privacySettings: PrivacyExportRow | null;
  savedItems: PrivacyExportRow[];
  billingCheckoutReservations: PrivacyExportRow[];
  sessions: PrivacyExportRow[];
  revokedProviderSessions: PrivacyExportRow[];
  discountPasses: PrivacyExportRow[];
  sourceEvidenceMetadata: PrivacyExportRow[];
  submissions: PrivacyExportRow[];
  submissionItems: PrivacyExportRow[];
  submissionSourceEvidence: PrivacyExportRow[];
  submissionsReviewed: PrivacyExportRow[];
  feedback: PrivacyExportRow[];
  wrongPriceReports: PrivacyExportRow[];
  venueRequests: PrivacyExportRow[];
  venueInterestRequests: PrivacyExportRow[];
  venueClaimRequests: PrivacyExportRow[];
  ageVerifications: PrivacyExportRow[];
  verifications: PrivacyExportRow[];
  missionProgress: PrivacyExportRow[];
  venueAssignments: PrivacyExportRow[];
  venuePendingChanges: PrivacyExportRow[];
  venuePartnerOutreach: PrivacyExportRow[];
  discountRedemptions: PrivacyExportRow[];
  pintPointDrinkRecords: PrivacyExportRow[];
  pintPointLedger: PrivacyExportRow[];
  freePintRewardCodes: PrivacyExportRow[];
  freePintRewardRedemptions: PrivacyExportRow[];
  contributionLedger: PrivacyExportRow[];
  rewardVouchers: PrivacyExportRow[];
  leaderboardPrizeAwards: PrivacyExportRow[];
  leaderboardPrizeCampaignsFinalized: PrivacyExportRow[];
  activity: PrivacyExportRow[];
  analyticsEvents: PrivacyExportRow[];
  securityAudit: PrivacyExportRow[];
  deletionRequests: PrivacyExportRow[];
  deletionNotifications: PrivacyExportRow[];
  deletionNotificationEvents: PrivacyExportRow[];
  venueReportDeliverySettings: PrivacyExportRow[];
  migrationQuarantinedRecords: PrivacyExportRow[];
  stripeWebhookEvents: PrivacyExportRow[];
}

export interface AccountAnonymisationSummary {
  anonymisedAccount: string;
  surrogatePublicId: string;
  evidenceIds: string[];
  removedSubmissions: number;
  removedSubmissionItems: number;
  removedContributionRows: number;
  removedDerivedPriceRecords: number;
  retentionPolicyVersion: typeof ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION;
  transactionContractVersion: typeof ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION;
}

export interface ExecuteAccountAnonymisationInput {
  requestId: string;
  attemptCount: number;
  reviewedBy: string;
  now: string;
  completionNotificationDisposition: "enqueue_live" | "suppress_restore" | "none";
  completionNotificationRetentionExpiresAt?: string | undefined;
  providerPolicy: {
    requireTombstoneReceipt: boolean;
    allowUnconfirmedStripeDeletion: boolean;
  };
}

interface LockedDeletionRequestRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  status: string;
  attempt_count: number | string;
  identity_deleted_at: string | null;
  stripe_customer_deleted_at: string | null;
  stripe_customer_id_snapshot: string | null;
  deletion_tombstone_recorded_at: string | null;
  result_summary_json: string | null;
}

interface LockedAccountRow extends Record<string, unknown> {
  id: string;
  email: string;
  auth_provider: string;
  supabase_user_id: string | null;
  stripe_customer_id: string | null;
}

interface EvidenceRow extends Record<string, unknown> {
  id: string;
}

function invalidInput(): never {
  throw new AccountPrivacyRepositoryError("invalid_input");
}

function requireIdentifier(value: string): string {
  if (
    !value
    || value !== value.trim()
    || value.length > MAX_IDENTIFIER_LENGTH
    || /[\r\n\0]/.test(value)
  ) invalidInput();
  return value;
}

function requireCanonicalUtc(value: string): string {
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) invalidInput();
    return value;
  } catch {
    return invalidInput();
  }
}

function requireAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalidInput();
  return value;
}

function databaseInteger(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || (typeof value === "string" && BigInt(value) !== BigInt(numeric))) {
    throw new AccountPrivacyRepositoryError("completion_conflict");
  }
  return numeric;
}

function parseRequiredJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not-object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AccountPrivacyRepositoryError("stored_json_invalid");
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseStoredSummary(value: string | null): AccountAnonymisationSummary {
  if (!value) throw new AccountPrivacyRepositoryError("completion_conflict");
  const parsed = parseRequiredJsonObject(value);
  if (
    typeof parsed.anonymisedAccount !== "string"
    || !/^DEL-[A-F0-9]{12}$/.test(parsed.anonymisedAccount)
    || typeof parsed.surrogatePublicId !== "string"
    || parsed.surrogatePublicId !== parsed.anonymisedAccount
    || !Array.isArray(parsed.evidenceIds)
    || !parsed.evidenceIds.every(
      (entry) => typeof entry === "string"
        && entry.length > 0
        && entry.length <= MAX_IDENTIFIER_LENGTH
        && entry === entry.trim()
        && !/[\r\n\0]/.test(entry),
    )
    || new Set(parsed.evidenceIds).size !== parsed.evidenceIds.length
    || !isNonNegativeSafeInteger(parsed.removedSubmissions)
    || !isNonNegativeSafeInteger(parsed.removedSubmissionItems)
    || !isNonNegativeSafeInteger(parsed.removedContributionRows)
    || !isNonNegativeSafeInteger(parsed.removedDerivedPriceRecords)
    || parsed.retentionPolicyVersion !== ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION
    || parsed.transactionContractVersion !== ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION
  ) throw new AccountPrivacyRepositoryError("completion_conflict");
  return {
    anonymisedAccount: parsed.anonymisedAccount,
    surrogatePublicId: parsed.surrogatePublicId,
    evidenceIds: parsed.evidenceIds,
    removedSubmissions: parsed.removedSubmissions,
    removedSubmissionItems: parsed.removedSubmissionItems,
    removedContributionRows: parsed.removedContributionRows,
    removedDerivedPriceRecords: parsed.removedDerivedPriceRecords,
    retentionPolicyVersion: ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
    transactionContractVersion: ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
  };
}

function scrubDeletedIdentityJson(
  rawJson: string,
  input: { userId: string; email: string; surrogateId: string },
): string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === input.userId) return input.surrogateId;
      const emailPattern = new RegExp(input.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      return value.replaceAll(input.userId, input.surrogateId).replace(emailPattern, "[deleted-email]");
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const scrubbedKey = scrub(key);
        return [typeof scrubbedKey === "string" ? scrubbedKey : "[deleted-key]", scrub(entry)];
      }));
    }
    return value;
  };
  try {
    return JSON.stringify(scrub(JSON.parse(rawJson)));
  } catch {
    return '{"redactedAfterAccountDeletion":true}';
  }
}

function toExportRow(row: Record<string, unknown>): PrivacyExportRow {
  return Object.freeze({ ...row });
}

/**
 * Async privacy export and account anonymisation boundary.
 * All filesystem, Supabase, Stripe, mail, and offsite-ledger I/O must complete
 * before executeAccountAnonymisation is called.
 */
export class AccountPrivacyRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of [...new Set(keys)].sort()) {
      await this.one<{ locked: unknown }>(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(?)) AS \"locked\"",
        key,
      );
    }
  }

  private one<Row extends Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined> {
    return this.database.prepare(sql).get<Row>(...bindings);
  }

  private all<Row extends Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]> {
    return this.database.prepare(sql).all<Row>(...bindings);
  }

  private run(sql: string, ...bindings: unknown[]): Promise<SqlRunResult> {
    return this.database.prepare(sql).run(...bindings);
  }

  private jsonTextContains(column: string): string {
    return this.database.dialect === "postgres"
      ? `position(? in ${column}::text) > 0`
      : `instr(${column}, ?) > 0`;
  }

  private lowerJsonTextContains(column: string): string {
    return this.database.dialect === "postgres"
      ? `position(? in lower(${column}::text)) > 0`
      : `instr(lower(${column}), ?) > 0`;
  }

  private lowerTextContains(column: string): string {
    return this.database.dialect === "postgres"
      ? `position(? in lower(COALESCE(${column}, ''))) > 0`
      : `instr(lower(COALESCE(${column}, '')), ?) > 0`;
  }

  private falseLiteral(): string {
    return this.database.dialect === "postgres" ? "FALSE" : "0";
  }

  async exportAccountRelatedData(input: { userId: string }): Promise<AccountPrivacyExport> {
    const userId = requireIdentifier(input.userId);
    return this.database.transaction(async () => {
      if (this.database.dialect === "postgres") {
        await this.database.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      }
      const accountPrivate = await this.one<LockedAccountRow>(
        `SELECT id, public_account_id, email, display_name, avatar_url, auth_provider, supabase_user_id,
                email_verified_at, mfa_level, mfa_verified_at, provider_tokens_valid_after, role,
                age_confirmed_at, terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
                age_verification_status, is_over_18_verified, subscription_status, stripe_customer_id,
                stripe_paid_subscription_status, stripe_event_created_at, premium_until, trust_score,
                contribution_points_current_month, approved_submission_count, rejected_submission_count,
                fraud_strike_count, status, created_at, updated_at
           FROM accounts WHERE id = ?`,
        userId,
      );
      if (!accountPrivate) throw new AccountPrivacyRepositoryError("account_not_found");
      const email = accountPrivate.email.trim().toLowerCase();
      const stripeCustomerId = accountPrivate.stripe_customer_id;

      const one = async (sql: string, ...bindings: unknown[]) => {
        const row = await this.one<Record<string, unknown>>(sql, ...bindings);
        return row ? toExportRow(row) : null;
      };
      const rows = async (sql: string, ...bindings: unknown[]) => (
        await this.all<Record<string, unknown>>(sql, ...bindings)
      ).map(toExportRow);
      const pendingJsonUser = this.jsonTextContains("payload_json");
      const pendingJsonEmail = this.lowerJsonTextContains("payload_json");
      const outreachEmail = this.lowerTextContains("notes");
      const quarantineUser = this.jsonTextContains("payload_json");
      const quarantineEmail = this.lowerJsonTextContains("payload_json");
      const submissionExportColumns = `id, client_submission_id, mission_id, user_id, venue_id,
        venue_name, suburb, status, submission_type, observed_at,
        (source_photo_url IS NOT NULL) AS has_private_evidence,
        ocr_status, ocr_summary_json, notes, points_awarded,
        upload_latitude, upload_longitude, upload_accuracy_meters,
        upload_location_captured_at, distance_to_venue_meters,
        points_eligible_by_location, points_eligibility_reason, pending_venue_json,
        reviewed_by, reviewed_at, rejection_reason, fraud_flagged, created_at, updated_at`;

      const reportSettingsSql = this.database.dialect === "postgres"
        ? `SELECT key, value_json, updated_at, revision FROM system_state
            WHERE key LIKE 'venue-report-delivery:%'
              AND jsonb_typeof(value_json) = 'object'
              AND (
                value_json ->> 'updatedBy' = ?
                OR EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(
                      CASE WHEN jsonb_typeof(value_json -> 'recipients') = 'array'
                           THEN value_json -> 'recipients' ELSE '[]'::jsonb END
                    ) AS recipient(value)
                   WHERE lower(recipient.value) = ?
                )
              )
            ORDER BY updated_at, key`
        : `SELECT key, value_json, updated_at, revision FROM system_state
            WHERE key LIKE 'venue-report-delivery:%'
              AND json_valid(value_json)
              AND (
                json_extract(value_json, '$.updatedBy') = ?
                OR EXISTS (
                  SELECT 1 FROM json_each(value_json, '$.recipients')
                   WHERE lower(CAST(value AS TEXT)) = ?
                )
              )
            ORDER BY updated_at, key`;
      const stripeWebhookSql = this.database.dialect === "postgres"
        ? stripeCustomerId
          ? `SELECT id, event_type, status, event_created_at, attempts,
                    received_at, applied_at, processed_at
               FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL
                AND (payload_json #>> '{data,object,customer}' = ?
                     OR payload_json #>> '{data,object,metadata,user_id}' = ?)
              ORDER BY received_at, id`
          : `SELECT id, event_type, status, event_created_at, attempts,
                    received_at, applied_at, processed_at
               FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL
                AND payload_json #>> '{data,object,metadata,user_id}' = ?
              ORDER BY received_at, id`
        : stripeCustomerId
          ? `SELECT id, event_type, status, event_created_at, attempts,
                    received_at, applied_at, processed_at
               FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL AND json_valid(payload_json)
                AND (json_extract(payload_json, '$.data.object.customer') = ?
                     OR json_extract(payload_json, '$.data.object.metadata.user_id') = ?)
              ORDER BY received_at, id`
          : `SELECT id, event_type, status, event_created_at, attempts,
                    received_at, applied_at, processed_at
               FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL AND json_valid(payload_json)
                AND json_extract(payload_json, '$.data.object.metadata.user_id') = ?
              ORDER BY received_at, id`;

      return {
        accountPrivate: toExportRow(accountPrivate),
        profile: await one("SELECT * FROM profiles WHERE id = ?", userId),
        preferences: await one("SELECT * FROM account_preferences WHERE user_id = ?", userId),
        privacySettings: await one("SELECT * FROM account_privacy_settings WHERE user_id = ?", userId),
        savedItems: await rows("SELECT * FROM saved_items WHERE user_id = ? ORDER BY created_at, id", userId),
        billingCheckoutReservations: await rows(
          `SELECT subject_type, subject_id, product_key, stripe_checkout_session_id,
                  expires_at, created_at, updated_at
             FROM billing_checkout_reservations
            WHERE subject_type = 'consumer' AND subject_id = ?
            ORDER BY product_key, created_at`,
          userId,
        ),
        sessions: await rows(
          `SELECT substr(token_hash, 1, 24) AS session_id, created_at, expires_at, revoked_at,
                  last_used_at, last_ip_hash, user_agent_hash, provider_session_id_hash
             FROM auth_sessions WHERE user_id = ? ORDER BY created_at, token_hash`,
          userId,
        ),
        revokedProviderSessions: await rows(
          `SELECT provider_session_id_hash, revoked_at, reason
             FROM revoked_provider_sessions WHERE user_id = ?
            ORDER BY revoked_at, provider_session_id_hash`,
          userId,
        ),
        discountPasses: await rows(
          `SELECT id, status, created_at, expires_at, revoked_at, last_used_at
             FROM account_discount_passes WHERE user_id = ? ORDER BY created_at, id`,
          userId,
        ),
        sourceEvidenceMetadata: await rows(
          `SELECT id, mime_type, byte_size,
                  retention_expires_at, deleted_at, created_at
             FROM source_evidence_objects WHERE owner_user_id = ? ORDER BY created_at, id`,
          userId,
        ),
        submissions: await rows(
          `SELECT ${submissionExportColumns}
             FROM submissions WHERE user_id = ? ORDER BY created_at, id`,
          userId,
        ),
        submissionItems: await rows(
          `SELECT item.* FROM submission_items item
             JOIN submissions submission ON submission.id = item.submission_id
            WHERE submission.user_id = ? ORDER BY item.created_at, item.id`,
          userId,
        ),
        submissionSourceEvidence: await rows(
          `SELECT link.* FROM submission_source_evidence link
             JOIN submissions submission ON submission.id = link.submission_id
            WHERE submission.user_id = ?
            ORDER BY link.submission_id, link.sort_order, link.evidence_id`,
          userId,
        ),
        submissionsReviewed: await rows(
          `SELECT ${submissionExportColumns}
             FROM submissions WHERE reviewed_by = ? ORDER BY reviewed_at, id`,
          userId,
        ),
        feedback: await rows(
          `SELECT * FROM feedback
            WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?
               OR lower(COALESCE(contact_email, '')) = ?
            ORDER BY created_at, id`,
          userId, userId, userId, email,
        ),
        wrongPriceReports: await rows(
          `SELECT * FROM wrong_price_reports
            WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?
            ORDER BY created_at, id`,
          userId, userId, userId,
        ),
        venueRequests: await rows(
          `SELECT * FROM venue_requests
            WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?
            ORDER BY created_at, id`,
          userId, userId, userId,
        ),
        venueInterestRequests: await rows(
          `SELECT * FROM venue_interest_requests
            WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(email) = ?
            ORDER BY created_at, id`,
          userId, userId, userId, email,
        ),
        venueClaimRequests: await rows(
          `SELECT * FROM venue_claim_requests
            WHERE user_id = ? OR reviewed_by = ? OR lower(contact_email) = ?
            ORDER BY created_at, id`,
          userId, userId, email,
        ),
        ageVerifications: await rows(
          "SELECT * FROM age_verifications WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        verifications: await rows(
          "SELECT * FROM verifications WHERE verifier_user_id = ? ORDER BY created_at, id",
          userId,
        ),
        missionProgress: await rows(
          "SELECT * FROM mission_progress WHERE user_id = ? ORDER BY accepted_at, mission_id",
          userId,
        ),
        venueAssignments: await rows(
          `SELECT * FROM venue_manager_assignments
            WHERE user_id = ? OR approved_by = ? ORDER BY created_at, user_id, venue_id`,
          userId, userId,
        ),
        venuePendingChanges: await rows(
          `SELECT * FROM venue_pending_changes
            WHERE submitted_by = ? OR reviewed_by = ?
               OR ${pendingJsonUser} OR ${pendingJsonEmail}
            ORDER BY created_at, id`,
          userId, userId, userId, email,
        ),
        venuePartnerOutreach: await rows(
          `SELECT * FROM venue_partner_outreach
            WHERE updated_by = ? OR ${outreachEmail} ORDER BY created_at, id`,
          userId, email,
        ),
        discountRedemptions: await rows(
          `SELECT id, user_id, public_account_id, venue_id, venue_name, suburb,
                  special_id, item_name, quantity, estimated_savings_cents,
                  discount_pass_id, redeemed_by_user_id, redeemed_at, metadata_json, created_at
             FROM discount_redemptions
            WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at, id`,
          userId, userId,
        ),
        pintPointDrinkRecords: await rows(
          `SELECT id, user_id, venue_id, venue_name, suburb, item_name, beverage_category,
                  quantity, is_alcoholic, points_awarded, source, reward_code_id,
                  recorded_by_user_id, status, voided_at, voided_by_user_id, void_reason,
                  recorded_at, metadata_json, created_at
             FROM pint_point_drink_records
            WHERE user_id = ? OR recorded_by_user_id = ? OR voided_by_user_id = ?
            ORDER BY created_at, id`,
          userId, userId, userId,
        ),
        pintPointLedger: await rows(
          "SELECT * FROM pint_point_ledger WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        freePintRewardCodes: await rows(
          `SELECT id, user_id, public_account_id, eligible_venue_scope, status,
                  points_reserved, created_at, expires_at, used_at, cancelled_at,
                  rejected_at, rejected_reason, redeemed_by_user_id, redeemed_venue_id,
                  metadata_json
             FROM free_pint_reward_codes
            WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at, id`,
          userId, userId,
        ),
        freePintRewardRedemptions: await rows(
          `SELECT * FROM free_pint_reward_redemptions
            WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at, id`,
          userId, userId,
        ),
        contributionLedger: await rows(
          "SELECT * FROM contribution_ledger WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        rewardVouchers: await rows(
          "SELECT * FROM account_reward_vouchers WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        leaderboardPrizeAwards: await rows(
          "SELECT * FROM leaderboard_prize_awards WHERE user_id = ? ORDER BY created_at, month_key, rank",
          userId,
        ),
        leaderboardPrizeCampaignsFinalized: await rows(
          `SELECT * FROM leaderboard_prize_campaigns
            WHERE finalized_by = ? ORDER BY created_at, month_key`,
          userId,
        ),
        activity: await rows(
          "SELECT * FROM user_activity_events WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        analyticsEvents: await rows(
          "SELECT * FROM events WHERE user_id = ? ORDER BY created_at, id",
          userId,
        ),
        securityAudit: await rows(
          `SELECT * FROM security_audit_log
            WHERE actor_user_id = ? OR (target_type = 'account' AND target_id = ?)
            ORDER BY created_at, id`,
          userId, userId,
        ),
        deletionRequests: await rows(
          `SELECT id, user_id, status, user_message, requested_at, execute_after,
                  reviewed_by, reviewed_at, completed_at, processing_started_at,
                  identity_deleted_at, stripe_customer_deleted_at,
                  deletion_tombstone_recorded_at, attempt_count, result_summary_json,
                  created_at, updated_at
             FROM account_deletion_requests
            WHERE user_id = ? OR reviewed_by = ? ORDER BY requested_at, id`,
          userId, userId,
        ),
        deletionNotifications: await rows(
          `SELECT notice.request_id, notice.template_version, notice.status,
                  notice.attempt_count, notice.first_attempt_at, notice.next_attempt_at,
                  notice.provider_message_id, notice.provider_last_event,
                  notice.provider_event_at, notice.completed_at, notice.accepted_at,
                  notice.delivered_at, notice.terminal_at, notice.retention_expires_at,
                  notice.created_at, notice.updated_at
             FROM account_deletion_completion_outbox notice
             JOIN account_deletion_requests deletion ON deletion.id = notice.request_id
            WHERE deletion.user_id = ? ORDER BY notice.created_at, notice.request_id`,
          userId,
        ),
        deletionNotificationEvents: await rows(
          `SELECT event.event_id, event.request_id, event.provider_message_id,
                  event.event_type, event.event_created_at, event.received_at,
                  event.payload_sha256
             FROM account_deletion_notification_events event
             JOIN account_deletion_requests deletion ON deletion.id = event.request_id
            WHERE deletion.user_id = ? ORDER BY event.event_created_at, event.event_id`,
          userId,
        ),
        venueReportDeliverySettings: await rows(reportSettingsSql, userId, email),
        migrationQuarantinedRecords: await rows(
          `SELECT * FROM migration_quarantined_records
            WHERE ${quarantineUser} OR ${quarantineEmail}
            ORDER BY quarantined_at, id`,
          userId, email,
        ),
        stripeWebhookEvents: stripeCustomerId
          ? await rows(stripeWebhookSql, stripeCustomerId, userId)
          : await rows(stripeWebhookSql, userId),
      };
    })();
  }

  async executeAccountAnonymisation(
    input: ExecuteAccountAnonymisationInput,
  ): Promise<AccountAnonymisationSummary> {
    const requestId = requireIdentifier(input.requestId);
    const reviewedBy = requireIdentifier(input.reviewedBy);
    const attemptCount = requireAttemptCount(input.attemptCount);
    const now = requireCanonicalUtc(input.now);
    if (!["enqueue_live", "suppress_restore", "none"].includes(input.completionNotificationDisposition)) {
      invalidInput();
    }
    const notificationRetentionExpiresAt = input.completionNotificationRetentionExpiresAt === undefined
      ? null
      : requireCanonicalUtc(input.completionNotificationRetentionExpiresAt);
    if (input.completionNotificationDisposition === "enqueue_live") {
      if (!notificationRetentionExpiresAt || notificationRetentionExpiresAt <= now) invalidInput();
    } else if (notificationRetentionExpiresAt !== null) {
      invalidInput();
    }
    if (
      typeof input.providerPolicy?.requireTombstoneReceipt !== "boolean"
      || typeof input.providerPolicy?.allowUnconfirmedStripeDeletion !== "boolean"
    ) invalidInput();

    return this.database.transaction(async () => {
      const rowLock = this.database.dialect === "postgres" ? " FOR UPDATE" : "";
      const requestSnapshot = await this.one<{ user_id: string }>(
        "SELECT user_id FROM account_deletion_requests WHERE id = ?",
        requestId,
      );
      if (!requestSnapshot) throw new AccountPrivacyRepositoryError("deletion_request_not_found");
      const lockedUserId = requireIdentifier(requestSnapshot.user_id);
      await this.advisoryLocks([
        billingCheckoutActorLockKey(lockedUserId),
        missionLifecycleAccountLockKey(lockedUserId),
        venueAccessAccountLockKey(lockedUserId),
        venuePartnerAccountLockKey(lockedUserId),
        venueRequestAccountLockKey(lockedUserId),
        sourceEvidenceAccountLockKey(lockedUserId),
      ]);

      const account = await this.one<LockedAccountRow>(
        `SELECT id, email, auth_provider, supabase_user_id, stripe_customer_id
           FROM accounts WHERE id = ?${rowLock}`,
        lockedUserId,
      );
      if (!account) throw new AccountPrivacyRepositoryError("account_not_found");

      const request = await this.one<LockedDeletionRequestRow>(
        `SELECT id, user_id, status, attempt_count, identity_deleted_at,
                stripe_customer_deleted_at, stripe_customer_id_snapshot,
                deletion_tombstone_recorded_at, result_summary_json
           FROM account_deletion_requests WHERE id = ?${rowLock}`,
        requestId,
      );
      if (!request) throw new AccountPrivacyRepositoryError("deletion_request_not_found");
      if (request.user_id !== lockedUserId) {
        throw new AccountPrivacyRepositoryError("deletion_attempt_conflict");
      }
      if (databaseInteger(request.attempt_count) !== attemptCount) {
        throw new AccountPrivacyRepositoryError("deletion_attempt_conflict");
      }
      if (request.status === "completed") return parseStoredSummary(request.result_summary_json);
      if (request.status !== "processing") {
        throw new AccountPrivacyRepositoryError("deletion_attempt_conflict");
      }

      if (account.supabase_user_id && !request.identity_deleted_at) {
        throw new AccountPrivacyRepositoryError("identity_deletion_unconfirmed");
      }
      const stripeCustomerId = account.stripe_customer_id ?? request.stripe_customer_id_snapshot;
      if (
        stripeCustomerId
        && !request.stripe_customer_deleted_at
        && !input.providerPolicy.allowUnconfirmedStripeDeletion
      ) throw new AccountPrivacyRepositoryError("stripe_deletion_unconfirmed");
      if (input.providerPolicy.requireTombstoneReceipt && !request.deletion_tombstone_recorded_at) {
        throw new AccountPrivacyRepositoryError("tombstone_unconfirmed");
      }

      const userId = account.id;
      const accountEmail = account.email;
      const email = accountEmail.trim().toLowerCase();
      const surrogatePublicId = `DEL-${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 12).toUpperCase()}`;
      const surrogateEmail = `deleted-${userId}@invalid.pintpath.local`;
      const evidenceRows = await this.all<EvidenceRow>(
        "SELECT id FROM source_evidence_objects WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY id",
        userId,
      );

      await this.run("DELETE FROM auth_sessions WHERE user_id = ?", userId);
      await this.run("DELETE FROM revoked_provider_sessions WHERE user_id = ?", userId);
      await this.run(
        "DELETE FROM billing_checkout_reservations WHERE subject_type = 'consumer' AND subject_id = ?",
        userId,
      );
      await this.run("DELETE FROM account_discount_passes WHERE user_id = ?", userId);
      await this.run("DELETE FROM account_preferences WHERE user_id = ?", userId);
      await this.run("DELETE FROM account_privacy_settings WHERE user_id = ?", userId);
      await this.run("DELETE FROM saved_items WHERE user_id = ?", userId);
      await this.run("DELETE FROM user_activity_events WHERE user_id = ?", userId);
      await this.run("DELETE FROM events WHERE user_id = ?", userId);
      await this.run("DELETE FROM age_verifications WHERE user_id = ?", userId);
      await this.run("DELETE FROM verifications WHERE verifier_user_id = ?", userId);
      await this.run("DELETE FROM mission_progress WHERE user_id = ?", userId);
      await this.run("DELETE FROM venue_manager_assignments WHERE user_id = ?", userId);
      await this.run("UPDATE venue_manager_assignments SET approved_by = NULL WHERE approved_by = ?", userId);
      await this.run("DELETE FROM discount_redemptions WHERE user_id = ?", userId);
      await this.run(
        "UPDATE discount_redemptions SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?",
        userId,
      );
      await this.run("DELETE FROM pint_point_ledger WHERE user_id = ?", userId);
      await this.run("DELETE FROM pint_point_drink_records WHERE user_id = ?", userId);
      await this.run(
        "UPDATE pint_point_drink_records SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ?",
        userId,
      );
      await this.run(
        "UPDATE pint_point_drink_records SET voided_by_user_id = NULL WHERE voided_by_user_id = ?",
        userId,
      );
      await this.run("DELETE FROM free_pint_reward_redemptions WHERE user_id = ?", userId);
      await this.run(
        "UPDATE free_pint_reward_redemptions SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?",
        userId,
      );
      await this.run("DELETE FROM free_pint_reward_codes WHERE user_id = ?", userId);
      await this.run(
        "UPDATE free_pint_reward_codes SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?",
        userId,
      );
      await this.run("DELETE FROM leaderboard_prize_awards WHERE user_id = ?", userId);
      await this.run("DELETE FROM account_reward_vouchers WHERE user_id = ?", userId);
      await this.run(
        "UPDATE leaderboard_prize_campaigns SET finalized_by = NULL WHERE finalized_by = ?",
        userId,
      );
      await this.run("DELETE FROM venue_pending_changes WHERE submitted_by = ?", userId);

      const venuePendingUser = this.database.dialect === "postgres"
        ? "position(@userId in payload_json::text) > 0"
        : "instr(payload_json, @userId) > 0";
      const venuePendingEmail = this.database.dialect === "postgres"
        ? "position(@email in lower(payload_json::text)) > 0"
        : "instr(lower(payload_json), @email) > 0";
      await this.run(
        `UPDATE venue_pending_changes
            SET reviewed_by = CASE WHEN reviewed_by = @userId THEN NULL ELSE reviewed_by END,
                payload_json = CASE WHEN ${venuePendingUser} OR ${venuePendingEmail}
                                    THEN @redactedJson ELSE payload_json END,
                rejection_reason = CASE WHEN reviewed_by = @userId THEN NULL ELSE rejection_reason END,
                updated_at = @now
          WHERE reviewed_by = @userId OR ${venuePendingUser} OR ${venuePendingEmail}`,
        {
          userId,
          email,
          redactedJson: '{"redactedAfterAccountDeletion":true}',
          now,
        },
      );

      const outreachEmail = this.database.dialect === "postgres"
        ? "position(@email in lower(COALESCE(notes, ''))) > 0"
        : "instr(lower(COALESCE(notes, '')), @email) > 0";
      await this.run(
        `UPDATE venue_partner_outreach
            SET updated_by = CASE WHEN updated_by = @userId THEN NULL ELSE updated_by END,
                notes = CASE WHEN updated_by = @userId OR ${outreachEmail} THEN NULL ELSE notes END,
                updated_at = @now
          WHERE updated_by = @userId OR ${outreachEmail}`,
        { userId, email, now },
      );

      await this.run(
        `UPDATE feedback
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?)
                                            THEN NULL ELSE anonymous_session_id END,
                contact_email = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?)
                                     THEN NULL ELSE contact_email END,
                message = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?)
                               THEN '[redacted after account deletion]' ELSE message END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?)
                                             OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?
             OR lower(COALESCE(contact_email, '')) = lower(?)`,
        userId, userId, accountEmail, userId, accountEmail, userId, accountEmail,
        userId, userId, userId, accountEmail, userId, now,
        userId, userId, userId, accountEmail,
      );
      await this.run(
        `UPDATE wrong_price_reports
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? THEN NULL ELSE anonymous_session_id END,
                notes = CASE WHEN user_id = ? THEN NULL ELSE notes END,
                source_photo_url = CASE WHEN user_id = ? THEN NULL ELSE source_photo_url END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?`,
        userId, userId, userId, userId, userId, userId, userId, userId, now, userId, userId, userId,
      );
      await this.run(
        `UPDATE venue_requests
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? THEN NULL ELSE anonymous_session_id END,
                notes = CASE WHEN user_id = ? THEN NULL ELSE notes END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?`,
        userId, userId, userId, userId, userId, userId, userId, now, userId, userId, userId,
      );
      await this.run(
        `UPDATE venue_interest_requests
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                manager_name = CASE WHEN user_id = ? OR lower(email) = lower(?)
                                    THEN 'Deleted account' ELSE manager_name END,
                email = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN ? ELSE email END,
                phone = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN NULL ELSE phone END,
                notes = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN NULL ELSE notes END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(email) = lower(?)`,
        userId, userId, accountEmail, userId, accountEmail, surrogateEmail,
        userId, accountEmail, userId, accountEmail, userId, userId, userId, userId,
        now, userId, userId, userId, accountEmail,
      );
      await this.run(
        `UPDATE venue_claim_requests
            SET requester_name = CASE WHEN user_id = ? OR lower(contact_email) = lower(?)
                                      THEN 'Deleted account' ELSE requester_name END,
                requester_role = CASE WHEN user_id = ? OR lower(contact_email) = lower(?)
                                      THEN 'Deleted account' ELSE requester_role END,
                contact_email = CASE WHEN user_id = ? OR lower(contact_email) = lower(?)
                                     THEN ? ELSE contact_email END,
                contact_phone = CASE WHEN user_id = ? OR lower(contact_email) = lower(?)
                                     THEN NULL ELSE contact_phone END,
                message = CASE WHEN user_id = ? OR lower(contact_email) = lower(?)
                               THEN NULL ELSE message END,
                reviewed_by = CASE WHEN reviewed_by = ? THEN NULL ELSE reviewed_by END,
                review_note = CASE WHEN reviewed_by = ? THEN NULL ELSE review_note END,
                updated_at = ?
          WHERE user_id = ? OR reviewed_by = ? OR lower(contact_email) = lower(?)`,
        userId, accountEmail, userId, accountEmail, userId, accountEmail, surrogateEmail,
        userId, accountEmail, userId, accountEmail, userId, userId, now, userId, userId, accountEmail,
      );

      await this.run(
        "UPDATE submissions SET reviewed_by = NULL WHERE reviewed_by = ? AND user_id <> ?",
        userId,
        userId,
      );
      const removedDerivedPriceRecords = (await this.run(
        `DELETE FROM venue_price_records
          WHERE source_submission_id IN (SELECT id FROM submissions WHERE user_id = ?)`,
        userId,
      )).changes;
      const removedContributionRows = (await this.run(
        `DELETE FROM contribution_ledger
          WHERE user_id = ? OR submission_id IN (SELECT id FROM submissions WHERE user_id = ?)`,
        userId,
        userId,
      )).changes;
      const removedSubmissionItems = (await this.run(
        `DELETE FROM submission_items
          WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?)`,
        userId,
      )).changes;
      const removedSubmissions = (await this.run(
        "DELETE FROM submissions WHERE user_id = ?",
        userId,
      )).changes;

      await this.run(
        `UPDATE source_evidence_objects
            SET owner_user_id = NULL, data_base64 = NULL, external_url = NULL,
                byte_size = NULL, deleted_at = COALESCE(deleted_at, ?)
          WHERE owner_user_id = ?`,
        now,
        userId,
      );

      const reportSettings = await this.all<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM system_state
          WHERE key LIKE 'venue-report-delivery:%'
          ORDER BY key${rowLock}`,
      );
      for (const setting of reportSettings) {
        const value = parseRequiredJsonObject(setting.value_json);
        if (
          value.recipients !== undefined
          && (!Array.isArray(value.recipients)
            || !value.recipients.every((recipient) => typeof recipient === "string"))
        ) throw new AccountPrivacyRepositoryError("stored_json_invalid");
        if (
          (value.enabled !== undefined && typeof value.enabled !== "boolean")
          || (value.updatedBy !== undefined
            && value.updatedBy !== null
            && typeof value.updatedBy !== "string")
        ) throw new AccountPrivacyRepositoryError("stored_json_invalid");
        const recipients = (value.recipients ?? []) as string[];
        const filteredRecipients = recipients.filter(
          (recipient) => recipient.trim().toLowerCase() !== email,
        );
        const authoredByUser = value.updatedBy === userId;
        if (!authoredByUser && filteredRecipients.length === recipients.length) continue;
        await this.run(
          "UPDATE system_state SET value_json = ?, updated_at = ?, revision = ? WHERE key = ?",
          JSON.stringify({
            ...value,
            enabled: filteredRecipients.length > 0 ? value.enabled !== false : false,
            recipients: filteredRecipients,
            updatedBy: authoredByUser ? null : value.updatedBy,
            redactedAfterAccountDeletion: true,
          }),
          now,
          crypto.randomUUID(),
          setting.key,
        );
      }

      const quarantineUser = this.database.dialect === "postgres"
        ? "position(@userId in payload_json::text) > 0"
        : "instr(payload_json, @userId) > 0";
      const quarantineEmail = this.database.dialect === "postgres"
        ? "position(@email in lower(payload_json::text)) > 0"
        : "instr(lower(payload_json), @email) > 0";
      await this.run(
        `UPDATE migration_quarantined_records
            SET payload_json = @redactedJson
          WHERE ${quarantineUser} OR ${quarantineEmail}`,
        { userId, email, redactedJson: '{"redactedAfterAccountDeletion":true}' },
      );
      await this.run(
        `UPDATE security_audit_log
            SET actor_user_id = CASE WHEN actor_user_id = ? THEN NULL ELSE actor_user_id END,
                actor_role = CASE WHEN actor_user_id = ? THEN NULL ELSE actor_role END,
                target_id = CASE WHEN target_id = ? THEN ? ELSE target_id END,
                metadata_json = CASE WHEN actor_user_id = ? OR target_id = ?
                                     THEN '{"redactedAfterAccountDeletion":true}' ELSE metadata_json END,
                ip_hash = CASE WHEN actor_user_id = ? THEN NULL ELSE ip_hash END,
                user_agent_hash = CASE WHEN actor_user_id = ? THEN NULL ELSE user_agent_hash END
          WHERE actor_user_id = ? OR target_id = ?`,
        userId, userId, userId, surrogatePublicId, userId, userId,
        userId, userId, userId, userId,
      );

      for (const table of ["security_audit_log", "events"] as const) {
        const userMatch = this.database.dialect === "postgres"
          ? "position(@userId in metadata_json::text) > 0"
          : "instr(metadata_json, @userId) > 0";
        const emailMatch = this.database.dialect === "postgres"
          ? "position(@email in lower(metadata_json::text)) > 0"
          : "instr(lower(metadata_json), @email) > 0";
        const matches = await this.all<{ id: string; metadata_json: string }>(
          `SELECT id, metadata_json FROM ${table}
            WHERE ${userMatch} OR ${emailMatch}
            ORDER BY id${rowLock}`,
          { userId, email },
        );
        for (const match of matches) {
          await this.run(
            `UPDATE ${table} SET metadata_json = ? WHERE id = ?`,
            scrubDeletedIdentityJson(match.metadata_json, {
              userId,
              email: accountEmail,
              surrogateId: surrogatePublicId,
            }),
            match.id,
          );
        }
      }

      if (stripeCustomerId) {
        const stripeMatch = this.database.dialect === "postgres"
          ? `(payload_json #>> '{data,object,customer}' = @stripeCustomerId
              OR payload_json #>> '{data,object,metadata,user_id}' = @userId)`
          : `(json_valid(payload_json) AND (
                json_extract(payload_json, '$.data.object.customer') = @stripeCustomerId
                OR json_extract(payload_json, '$.data.object.metadata.user_id') = @userId
             ))`;
        await this.run(
          `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
            WHERE payload_json IS NOT NULL AND ${stripeMatch}`,
          { stripeCustomerId, userId },
        );
      } else {
        const stripeMatch = this.database.dialect === "postgres"
          ? "payload_json #>> '{data,object,metadata,user_id}' = @userId"
          : "json_valid(payload_json) AND json_extract(payload_json, '$.data.object.metadata.user_id') = @userId";
        await this.run(
          `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
            WHERE payload_json IS NOT NULL AND ${stripeMatch}`,
          { userId },
        );
      }

      await this.run(
        `UPDATE account_deletion_requests
            SET user_message = NULL, last_error = NULL, stripe_customer_id_snapshot = NULL
          WHERE user_id = ?`,
        userId,
      );
      await this.run(
        "UPDATE account_deletion_requests SET reviewed_by = NULL WHERE reviewed_by = ? AND user_id <> ?",
        userId,
        userId,
      );
      await this.run(
        `UPDATE profiles
            SET public_account_id = ?, email = ?, username = NULL, avatar_url = NULL,
                display_name = NULL, display_name_key = NULL, role = 'user',
                account_status = 'suspended', age_verification_status = 'not_started',
                is_over_18_verified = ${this.falseLiteral()}, updated_at = ?
          WHERE id = ?`,
        surrogatePublicId,
        surrogateEmail,
        now,
        userId,
      );
      await this.run(
        `UPDATE accounts
            SET public_account_id = ?, email = ?, password_hash = 'deleted', display_name = NULL,
                display_name_key = NULL, avatar_url = NULL, auth_provider = 'deleted',
                supabase_user_id = NULL, email_verified_at = NULL, mfa_level = 'aal1',
                mfa_verified_at = NULL, provider_tokens_valid_after = NULL, role = 'user',
                age_confirmed_at = NULL, terms_accepted_at = NULL, privacy_accepted_at = NULL,
                terms_version = NULL, privacy_version = NULL,
                age_verification_status = 'not_started', is_over_18_verified = ${this.falseLiteral()},
                subscription_status = 'free', stripe_customer_id = NULL,
                stripe_paid_subscription_status = NULL, stripe_event_created_at = NULL,
                premium_until = NULL, trust_score = 0, contribution_points_current_month = 0,
                fraud_strike_count = 0, status = 'suspended', updated_at = ?
          WHERE id = ?`,
        surrogatePublicId,
        surrogateEmail,
        now,
        userId,
      );

      const summary: AccountAnonymisationSummary = {
        anonymisedAccount: surrogatePublicId,
        surrogatePublicId,
        evidenceIds: evidenceRows.map((row) => row.id),
        removedSubmissions,
        removedSubmissionItems,
        removedContributionRows,
        removedDerivedPriceRecords,
        retentionPolicyVersion: ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
        transactionContractVersion: ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
      };

      if (input.completionNotificationDisposition === "enqueue_live") {
        await this.run(
          `UPDATE account_deletion_notice_recipient_secrets
              SET purge_after = ? WHERE request_id = ?`,
          notificationRetentionExpiresAt,
          requestId,
        );
        const activated = await this.run(
          `UPDATE account_deletion_completion_outbox
              SET status = 'pending', completed_at = ?, next_attempt_at = ?,
                  retention_expires_at = (
                    SELECT purge_after FROM account_deletion_notice_recipient_secrets recipient
                     WHERE recipient.request_id = account_deletion_completion_outbox.request_id
                  ),
                  last_error = NULL, updated_at = ?
            WHERE request_id = ? AND status = 'held'
              AND EXISTS (
                SELECT 1 FROM account_deletion_notice_recipient_secrets recipient
                 WHERE recipient.request_id = account_deletion_completion_outbox.request_id
              )`,
          now,
          now,
          now,
          requestId,
        );
        if (activated.changes !== 1) {
          throw new AccountPrivacyRepositoryError("notification_not_prepared");
        }
      } else if (input.completionNotificationDisposition === "suppress_restore") {
        const truth = this.database.dialect === "postgres" ? "TRUE" : "1";
        await this.run(
          `UPDATE account_deletion_completion_outbox
              SET status = CASE WHEN status = 'delivered' THEN status ELSE 'suppressed_restore' END,
                  terminal_at = COALESCE(terminal_at, ?), next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  last_error = CASE WHEN status = 'delivered' THEN last_error
                                    ELSE 'Notification suppressed during deletion-tombstone restore reconciliation.' END,
                  secret_purge_checkpoint_pending = ${truth},
                  secret_purge_generation = secret_purge_generation + 1, updated_at = ?
            WHERE request_id = ?`,
          now,
          now,
          requestId,
        );
        await this.run(
          "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = ?",
          requestId,
        );
      }

      const completed = await this.one<{ id: string }>(
        `UPDATE account_deletion_requests
            SET status = 'completed', reviewed_by = ?, reviewed_at = ?, completed_at = ?,
                result_summary_json = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND attempt_count = ?
          RETURNING id`,
        reviewedBy,
        now,
        now,
        JSON.stringify(summary),
        now,
        requestId,
        attemptCount,
      );
      if (!completed) throw new AccountPrivacyRepositoryError("completion_conflict");
      return summary;
    })();
  }
}
