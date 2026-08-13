import type { SqlDatabase, SqlRunResult } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_BATCH_LIMIT = 500;
const REDACTED_QUARANTINE_PAYLOAD = '{"redactedAfterRetention":true}';

export const ACCOUNT_DATA_RETENTION_POLICY = {
  version: "2026-08-03",
  authSessions: { action: "delete", daysAfterExpiryOrRevocation: 30 },
  revokedProviderSessions: {
    action: "retain_device_denylist_until_account_deletion",
    globallyRevokedRowsDaysAfterRevocation: 90,
  },
  stripeWebhookPayloads: { action: "redact_payload", daysAfterReceipt: 30 },
  stripeWebhookEventEnvelope: {
    action: "delete_after_durable_idempotency_tombstone",
    daysAfterReceipt: 400,
  },
  securityRequestFingerprints: { action: "redact", daysAfterCreation: 30 },
  securityAuditEnvelope: { action: "retain", daysAfterCreation: 400 },
  reviewedSubmissionExactLocation: { action: "purge", daysAfterReview: 30 },
  pendingEvidenceHardCap: { action: "purge_even_if_review_open", daysAfterCreation: 180 },
  pendingIngestionImages: {
    action: "redact_bytes_preserve_review_metadata",
    retentionDaysAfterCreation: 90,
    hardCapDaysAfterCreation: 180,
  },
  migrationQuarantinePayload: { action: "redact", daysAfterQuarantine: 30 },
  migrationBackups: { action: "delete", daysAfterCreation: 30 },
  accountDeletion: {
    delete: [
      "auth_sessions", "revoked_provider_sessions", "account_discount_passes", "account_preferences",
      "account_privacy_settings", "saved_items", "recent_searches", "user_activity_events", "events",
      "age_verifications", "verifications", "mission_progress", "venue_manager_assignments",
      "discount_redemptions", "pint_point_drink_records", "pint_point_ledger", "free_pint_reward_codes",
      "free_pint_reward_redemptions", "account_reward_vouchers", "leaderboard_prize_awards",
      "submission_items", "submissions", "contribution_ledger", "submission_derived_venue_price_records",
    ],
    redact: [
      "accounts", "profiles", "source_evidence_objects", "feedback", "wrong_price_reports",
      "venue_requests", "venue_interest_requests", "venue_claim_requests", "venue_pending_changes",
      "venue_partner_outreach", "system_state venue-report-delivery settings", "security_audit_log",
      "stripe_webhook_events", "migration_quarantined_records", "account_deletion_requests",
    ],
    pseudonymise: [],
    completionNotification: {
      action: "encrypt_until_delivery_then_purge",
      maximumDaysAfterCompletion: 30,
      nonIdentifyingWebhookReceiptDays: 400,
    },
  },
} as const;

export const PRIVACY_RETENTION_POLICY_VERSION = ACCOUNT_DATA_RETENTION_POLICY.version;

export type PrivacyRetentionRepositoryErrorCode =
  | "invalid_input"
  | "malformed_result"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<PrivacyRetentionRepositoryErrorCode, string>> = {
  invalid_input: "The privacy-retention input is invalid.",
  malformed_result: "The privacy-retention database result is malformed.",
  persistence_failure: "Privacy-retention persistence could not be completed.",
};

/** Stable failures deliberately omit SQL, record identifiers, and stored values. */
export class PrivacyRetentionRepositoryError extends Error {
  readonly code: PrivacyRetentionRepositoryErrorCode;

  constructor(code: PrivacyRetentionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PrivacyRetentionRepositoryError";
    this.code = code;
  }
}

export interface PrivacyRetentionInput {
  asOf: string;
  authSessionCutoff: string;
  providerRevocationCutoff: string;
  stripePayloadCutoff: string;
  stripeEnvelopeCutoff: string;
  securityFingerprintCutoff: string;
  securityEnvelopeCutoff: string;
  reviewedLocationCutoff: string;
  migrationQuarantineCutoff: string;
  deletionNotificationEventCutoff: string;
  batchLimit: number;
}

export interface PrivacyRetentionMutationCounts {
  authSessionsDeleted: number;
  providerRevocationsDeleted: number;
  stripePayloadsRedacted: number;
  /**
   * Always zero until a reviewed durable Stripe-event tombstone authority is
   * added. The event ID is currently the webhook replay/idempotency boundary.
   */
  stripeEnvelopesDeleted: number;
  securityFingerprintsRedacted: number;
  securityEnvelopesDeleted: number;
  reviewedLocationsPurged: number;
  migrationQuarantinePayloadsRedacted: number;
  deletionNotificationEventsDeleted: number;
}

export interface PrivacyRetentionResult extends PrivacyRetentionMutationCounts {
  processedCount: number;
  progressed: boolean;
  hasMore: boolean;
  hasActionableMore: boolean;
  stalled: boolean;
  stripeEnvelopeDeletionDeferred: true;
  /** Bounded at the invocation batch limit; this is a backlog signal, not a mutation count. */
  stripeEnvelopesAwaitingTombstoneInBatch: number;
}

interface NormalizedPrivacyRetentionInput extends Omit<PrivacyRetentionInput, "batchLimit"> {
  batchLimit: number;
}

interface BacklogRow extends Record<string, unknown> {
  authSessions: unknown;
  providerRevocations: unknown;
  stripePayloads: unknown;
  stripeEnvelopes: unknown;
  securityFingerprints: unknown;
  securityEnvelopes: unknown;
  reviewedLocations: unknown;
  migrationQuarantinePayloads: unknown;
  deletionNotificationEvents: unknown;
  stripeEnvelopeBatchCount: unknown;
}

function fail(code: PrivacyRetentionRepositoryErrorCode): never {
  throw new PrivacyRetentionRepositoryError(code);
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return fail("invalid_input");
  try {
    if (new Date(value).toISOString() !== value) return fail("invalid_input");
  } catch {
    return fail("invalid_input");
  }
  return value;
}

function normalizeInput(input: PrivacyRetentionInput): NormalizedPrivacyRetentionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
  const normalized: NormalizedPrivacyRetentionInput = {
    asOf: canonicalTimestamp(input.asOf),
    authSessionCutoff: canonicalTimestamp(input.authSessionCutoff),
    providerRevocationCutoff: canonicalTimestamp(input.providerRevocationCutoff),
    stripePayloadCutoff: canonicalTimestamp(input.stripePayloadCutoff),
    stripeEnvelopeCutoff: canonicalTimestamp(input.stripeEnvelopeCutoff),
    securityFingerprintCutoff: canonicalTimestamp(input.securityFingerprintCutoff),
    securityEnvelopeCutoff: canonicalTimestamp(input.securityEnvelopeCutoff),
    reviewedLocationCutoff: canonicalTimestamp(input.reviewedLocationCutoff),
    migrationQuarantineCutoff: canonicalTimestamp(input.migrationQuarantineCutoff),
    deletionNotificationEventCutoff: canonicalTimestamp(input.deletionNotificationEventCutoff),
    batchLimit: input.batchLimit,
  };
  if (
    !Number.isSafeInteger(normalized.batchLimit)
    || normalized.batchLimit < 1
    || normalized.batchLimit > MAX_BATCH_LIMIT
  ) return fail("invalid_input");
  const cutoffs = [
    normalized.authSessionCutoff,
    normalized.providerRevocationCutoff,
    normalized.stripePayloadCutoff,
    normalized.stripeEnvelopeCutoff,
    normalized.securityFingerprintCutoff,
    normalized.securityEnvelopeCutoff,
    normalized.reviewedLocationCutoff,
    normalized.migrationQuarantineCutoff,
    normalized.deletionNotificationEventCutoff,
  ];
  if (
    cutoffs.some((cutoff) => cutoff > normalized.asOf)
    || normalized.stripeEnvelopeCutoff > normalized.stripePayloadCutoff
    || normalized.securityEnvelopeCutoff > normalized.securityFingerprintCutoff
  ) return fail("invalid_input");
  return normalized;
}

function resultBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_result");
}

function resultCount(value: unknown, maximum: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_result");
  if (typeof value === "string" && !/^\d+$/.test(value)) return fail("malformed_result");
  const count = Number(value);
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || count > maximum
    || typeof value === "string" && BigInt(value) !== BigInt(count)
  ) return fail("malformed_result");
  return count;
}

function mutationCount(result: SqlRunResult, remaining: number): number {
  return resultCount((result as { changes?: unknown }).changes, remaining);
}

/**
 * Bounded, database-only privacy retention authority.
 *
 * Each invocation mutates at most `batchLimit` rows in one short transaction.
 * PostgreSQL candidates are locked with `SKIP LOCKED`; SQLite uses its bounded
 * subquery equivalent inside `BEGIN IMMEDIATE`. Provider and filesystem I/O do
 * not belong in this transaction.
 */
export class PrivacyRetentionRepository {
  constructor(private readonly database: SqlDatabase) {}

  private collation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PrivacyRetentionRepositoryError) throw error;
      return fail("persistence_failure");
    }
  }

  private async mutate(
    sqliteSql: string,
    postgresSql: string,
    bindings: readonly unknown[],
    remaining: number,
  ): Promise<number> {
    if (remaining === 0) return 0;
    const result = await this.database
      .prepare(this.database.dialect === "postgres" ? postgresSql : sqliteSql)
      .run(...bindings, remaining);
    return mutationCount(result, remaining);
  }

  private async backlog(input: NormalizedPrivacyRetentionInput): Promise<{
    hasMore: boolean;
    hasActionableMore: boolean;
    stripeEnvelopeBatchCount: number;
  }> {
    const row = await this.database.prepare(
      `SELECT
         EXISTS (
           SELECT 1 FROM auth_sessions
            WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
               OR expires_at <= ?
         ) AS "authSessions",
         EXISTS (
           SELECT 1 FROM revoked_provider_sessions
            WHERE revoked_at <= ?
              AND reason IN ('password_reset_completed', 'all_app_sessions_revoked')
         ) AS "providerRevocations",
         EXISTS (
           SELECT 1 FROM stripe_webhook_events
            WHERE received_at <= ? AND status = 'applied'
              AND (payload_json IS NOT NULL OR last_error IS NOT NULL)
         ) AS "stripePayloads",
         EXISTS (
           SELECT 1 FROM stripe_webhook_events
            WHERE received_at <= ? AND status = 'applied'
         ) AS "stripeEnvelopes",
         EXISTS (
           SELECT 1 FROM security_audit_log
            WHERE created_at <= ?
              AND (ip_hash IS NOT NULL OR user_agent_hash IS NOT NULL)
         ) AS "securityFingerprints",
         EXISTS (
           SELECT 1 FROM security_audit_log WHERE created_at <= ?
         ) AS "securityEnvelopes",
         EXISTS (
           SELECT 1 FROM submissions
            WHERE reviewed_at IS NOT NULL AND reviewed_at <= ?
              AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
              AND (upload_latitude IS NOT NULL OR upload_longitude IS NOT NULL
                OR upload_accuracy_meters IS NOT NULL OR upload_location_captured_at IS NOT NULL)
         ) AS "reviewedLocations",
         EXISTS (
           SELECT 1 FROM migration_quarantined_records
            WHERE quarantined_at <= ? AND payload_json <> '${REDACTED_QUARANTINE_PAYLOAD}'
         ) AS "migrationQuarantinePayloads",
         EXISTS (
           SELECT 1
             FROM account_deletion_notification_events event
             JOIN account_deletion_completion_outbox notice ON notice.request_id = event.request_id
            WHERE event.received_at <= ?
              AND notice.retention_expires_at IS NOT NULL
              AND notice.retention_expires_at <= ?
              AND notice.status IN ('delivered', 'purged', 'cancelled', 'suppressed_restore')
         ) AS "deletionNotificationEvents",
         (
           SELECT count(*) FROM (
             SELECT id FROM stripe_webhook_events
              WHERE received_at <= ? AND status = 'applied'
              ORDER BY received_at ASC, id ${this.collation()} ASC
              LIMIT ?
           ) stripe_envelope_batch
         ) AS "stripeEnvelopeBatchCount"`,
    ).get<BacklogRow>(
      input.authSessionCutoff,
      input.authSessionCutoff,
      input.providerRevocationCutoff,
      input.stripePayloadCutoff,
      input.stripeEnvelopeCutoff,
      input.securityFingerprintCutoff,
      input.securityEnvelopeCutoff,
      input.reviewedLocationCutoff,
      input.migrationQuarantineCutoff,
      input.deletionNotificationEventCutoff,
      input.asOf,
      input.stripeEnvelopeCutoff,
      input.batchLimit,
    );
    if (!row) return fail("malformed_result");
    const actionable = [
      resultBoolean(row.authSessions),
      resultBoolean(row.providerRevocations),
      resultBoolean(row.stripePayloads),
      resultBoolean(row.securityFingerprints),
      resultBoolean(row.securityEnvelopes),
      resultBoolean(row.reviewedLocations),
      resultBoolean(row.migrationQuarantinePayloads),
      resultBoolean(row.deletionNotificationEvents),
    ];
    const stripeEnvelopes = resultBoolean(row.stripeEnvelopes);
    return {
      hasActionableMore: actionable.some(Boolean),
      hasMore: stripeEnvelopes || actionable.some(Boolean),
      stripeEnvelopeBatchCount: resultCount(row.stripeEnvelopeBatchCount, input.batchLimit),
    };
  }

  async prunePrivacyRetention(inputValue: PrivacyRetentionInput): Promise<PrivacyRetentionResult> {
    const input = normalizeInput(inputValue);
    return this.translate(() => this.database.transaction(async () => {
      let remaining = input.batchLimit;
      const take = async (
        sqliteSql: string,
        postgresSql: string,
        bindings: readonly unknown[],
      ): Promise<number> => {
        const count = await this.mutate(sqliteSql, postgresSql, bindings, remaining);
        remaining -= count;
        return count;
      };

      let authSessionsDeleted = await take(
        `DELETE FROM auth_sessions
          WHERE token_hash IN (
            SELECT token_hash FROM auth_sessions
             WHERE revoked_at IS NOT NULL AND revoked_at <= ?
             ORDER BY revoked_at ASC, token_hash ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT token_hash FROM auth_sessions
            WHERE revoked_at IS NOT NULL AND revoked_at <= ?
            ORDER BY revoked_at ASC, token_hash ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         DELETE FROM auth_sessions target USING candidates
          WHERE target.token_hash = candidates.token_hash`,
        [input.authSessionCutoff],
      );
      authSessionsDeleted += await take(
        `DELETE FROM auth_sessions
          WHERE token_hash IN (
            SELECT token_hash FROM auth_sessions
             WHERE expires_at <= ?
             ORDER BY expires_at ASC, token_hash ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT token_hash FROM auth_sessions
            WHERE expires_at <= ?
            ORDER BY expires_at ASC, token_hash ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         DELETE FROM auth_sessions target USING candidates
          WHERE target.token_hash = candidates.token_hash`,
        [input.authSessionCutoff],
      );

      const providerRevocationsDeleted = await take(
        `DELETE FROM revoked_provider_sessions
          WHERE (user_id, provider_session_id_hash) IN (
            SELECT user_id, provider_session_id_hash FROM revoked_provider_sessions
             WHERE revoked_at <= ?
               AND reason IN ('password_reset_completed', 'all_app_sessions_revoked')
             ORDER BY revoked_at ASC, user_id ${this.collation()} ASC,
                      provider_session_id_hash ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT user_id, provider_session_id_hash FROM revoked_provider_sessions
            WHERE revoked_at <= ?
              AND reason IN ('password_reset_completed', 'all_app_sessions_revoked')
            ORDER BY revoked_at ASC, user_id ${this.collation()} ASC,
                     provider_session_id_hash ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         DELETE FROM revoked_provider_sessions target USING candidates
          WHERE target.user_id = candidates.user_id
            AND target.provider_session_id_hash = candidates.provider_session_id_hash`,
        [input.providerRevocationCutoff],
      );

      const stripePayloadsRedacted = await take(
        `UPDATE stripe_webhook_events
            SET payload_json = NULL, last_error = NULL
          WHERE id IN (
            SELECT id FROM stripe_webhook_events
             WHERE received_at <= ? AND status = 'applied'
               AND (payload_json IS NOT NULL OR last_error IS NOT NULL)
             ORDER BY received_at ASC, id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT id FROM stripe_webhook_events
            WHERE received_at <= ? AND status = 'applied'
              AND (payload_json IS NOT NULL OR last_error IS NOT NULL)
            ORDER BY received_at ASC, id ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         UPDATE stripe_webhook_events target
            SET payload_json = NULL, last_error = NULL
           FROM candidates WHERE target.id = candidates.id`,
        [input.stripePayloadCutoff],
      );

      // Stripe envelopes intentionally remain the durable webhook replay key.
      const stripeEnvelopesDeleted = 0;

      const securityFingerprintsRedacted = await take(
        `UPDATE security_audit_log
            SET ip_hash = NULL, user_agent_hash = NULL
          WHERE id IN (
            SELECT id FROM security_audit_log
             WHERE created_at <= ?
               AND (ip_hash IS NOT NULL OR user_agent_hash IS NOT NULL)
             ORDER BY created_at ASC, id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT id FROM security_audit_log
            WHERE created_at <= ?
              AND (ip_hash IS NOT NULL OR user_agent_hash IS NOT NULL)
            ORDER BY created_at ASC, id ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         UPDATE security_audit_log target
            SET ip_hash = NULL, user_agent_hash = NULL
           FROM candidates WHERE target.id = candidates.id`,
        [input.securityFingerprintCutoff],
      );

      const securityEnvelopesDeleted = await take(
        `DELETE FROM security_audit_log
          WHERE id IN (
            SELECT id FROM security_audit_log
             WHERE created_at <= ?
             ORDER BY created_at ASC, id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT id FROM security_audit_log
            WHERE created_at <= ?
            ORDER BY created_at ASC, id ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         DELETE FROM security_audit_log target USING candidates
          WHERE target.id = candidates.id`,
        [input.securityEnvelopeCutoff],
      );

      const reviewedLocationsPurged = await take(
        `UPDATE submissions
            SET upload_latitude = NULL, upload_longitude = NULL,
                upload_accuracy_meters = NULL, upload_location_captured_at = NULL
          WHERE id IN (
            SELECT id FROM submissions
             WHERE reviewed_at IS NOT NULL AND reviewed_at <= ?
               AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
               AND (upload_latitude IS NOT NULL OR upload_longitude IS NOT NULL
                 OR upload_accuracy_meters IS NOT NULL OR upload_location_captured_at IS NOT NULL)
             ORDER BY reviewed_at ASC, id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT id FROM submissions
            WHERE reviewed_at IS NOT NULL AND reviewed_at <= ?
              AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
              AND (upload_latitude IS NOT NULL OR upload_longitude IS NOT NULL
                OR upload_accuracy_meters IS NOT NULL OR upload_location_captured_at IS NOT NULL)
            ORDER BY reviewed_at ASC, id ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         UPDATE submissions target
            SET upload_latitude = NULL, upload_longitude = NULL,
                upload_accuracy_meters = NULL, upload_location_captured_at = NULL
           FROM candidates WHERE target.id = candidates.id`,
        [input.reviewedLocationCutoff],
      );

      const migrationQuarantinePayloadsRedacted = await take(
        `UPDATE migration_quarantined_records
            SET payload_json = '${REDACTED_QUARANTINE_PAYLOAD}'
          WHERE id IN (
            SELECT id FROM migration_quarantined_records
             WHERE quarantined_at <= ? AND payload_json <> '${REDACTED_QUARANTINE_PAYLOAD}'
             ORDER BY quarantined_at ASC, id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT id FROM migration_quarantined_records
            WHERE quarantined_at <= ? AND payload_json <> '${REDACTED_QUARANTINE_PAYLOAD}'
            ORDER BY quarantined_at ASC, id ${this.collation()} ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
         )
         UPDATE migration_quarantined_records target
            SET payload_json = '${REDACTED_QUARANTINE_PAYLOAD}'
           FROM candidates WHERE target.id = candidates.id`,
        [input.migrationQuarantineCutoff],
      );

      const deletionNotificationEventsDeleted = await take(
        `DELETE FROM account_deletion_notification_events
          WHERE event_id IN (
            SELECT event.event_id
              FROM account_deletion_notification_events event
              JOIN account_deletion_completion_outbox notice ON notice.request_id = event.request_id
             WHERE event.received_at <= ?
               AND notice.retention_expires_at IS NOT NULL
               AND notice.retention_expires_at <= ?
               AND notice.status IN ('delivered', 'purged', 'cancelled', 'suppressed_restore')
             ORDER BY event.received_at ASC, event.event_id ${this.collation()} ASC
             LIMIT ?
          )`,
        `WITH candidates AS (
           SELECT event.event_id
             FROM account_deletion_notification_events event
             JOIN account_deletion_completion_outbox notice ON notice.request_id = event.request_id
            WHERE event.received_at <= ?
              AND notice.retention_expires_at IS NOT NULL
              AND notice.retention_expires_at <= ?
              AND notice.status IN ('delivered', 'purged', 'cancelled', 'suppressed_restore')
            ORDER BY event.received_at ASC, event.event_id ${this.collation()} ASC
            LIMIT ? FOR UPDATE OF event, notice SKIP LOCKED
         )
         DELETE FROM account_deletion_notification_events target USING candidates
          WHERE target.event_id = candidates.event_id`,
        [input.deletionNotificationEventCutoff, input.asOf],
      );

      const counts: PrivacyRetentionMutationCounts = {
        authSessionsDeleted,
        providerRevocationsDeleted,
        stripePayloadsRedacted,
        stripeEnvelopesDeleted,
        securityFingerprintsRedacted,
        securityEnvelopesDeleted,
        reviewedLocationsPurged,
        migrationQuarantinePayloadsRedacted,
        deletionNotificationEventsDeleted,
      };
      const processedCount = Object.values(counts).reduce((total, count) => total + count, 0);
      if (!Number.isSafeInteger(processedCount) || processedCount < 0 || processedCount > input.batchLimit) {
        return fail("malformed_result");
      }
      const remainingBacklog = await this.backlog(input);
      const progressed = processedCount > 0;
      return {
        ...counts,
        processedCount,
        progressed,
        hasMore: remainingBacklog.hasMore,
        hasActionableMore: remainingBacklog.hasActionableMore,
        stalled: remainingBacklog.hasMore && !progressed,
        stripeEnvelopeDeletionDeferred: true as const,
        stripeEnvelopesAwaitingTombstoneInBatch: remainingBacklog.stripeEnvelopeBatchCount,
      };
    })());
  }
}
