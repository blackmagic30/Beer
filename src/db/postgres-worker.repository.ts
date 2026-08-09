import type { SqlDatabase } from "./sql-database.js";

export type AccountDeletionNotificationStatus =
  | "held"
  | "pending"
  | "sending"
  | "accepted"
  | "delivered"
  | "failed"
  | "manual_review"
  | "purged"
  | "cancelled"
  | "suppressed_restore";

export interface PostgresAccountDeletionOutboxRow {
  request_id: string;
  template_version: string;
  idempotency_key: string;
  payload_fingerprint: string | null;
  secret_purge_checkpoint_pending: boolean;
  secret_purge_generation: number;
  status: AccountDeletionNotificationStatus;
  attempt_count: number;
  first_attempt_at: string | null;
  next_attempt_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  provider_message_id: string | null;
  provider_last_event: string | null;
  provider_event_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  terminal_at: string | null;
  retention_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminIngestionReviewClaim {
  id: string;
  status: "publishing" | "rejecting";
  claimToken: string;
  claimedAt: string;
}

interface MutationReceiptRow {
  mutationKey: string;
}

interface AdminIngestionReviewClaimRow {
  id: string;
  status: "publishing" | "rejecting";
  claimToken: string;
  claimedAt: string;
}

const OUTBOX_LEASE_GUARD = "status = 'sending' AND lease_token = @leaseToken";

/**
 * These statements are exported so the concurrency contract can be audited and
 * regression-tested without requiring a live production database.
 *
 * Each claim is a single statement. Callers must let that statement commit
 * before performing provider, filesystem, or other network I/O.
 */
export const postgresWorkerQueries = Object.freeze({
  claimAccountDeletionNotification: `/* postgres-worker:claim-account-deletion */
    WITH candidate AS (
      SELECT notice.request_id
        FROM account_deletion_completion_outbox AS notice
        JOIN account_deletion_requests AS deletion
          ON deletion.id = notice.request_id
       WHERE deletion.status = 'completed'
         AND notice.retention_expires_at > @now
         AND notice.next_attempt_at IS NOT NULL
         AND notice.next_attempt_at <= @now
         AND (
           notice.status IN ('pending', 'accepted')
           OR (
             notice.status = 'sending'
             AND (
               notice.lease_expires_at <= @now
               OR (notice.lease_expires_at IS NULL AND notice.updated_at <= @staleBefore)
             )
           )
         )
       ORDER BY notice.next_attempt_at ASC, notice.created_at ASC, notice.request_id ASC
       FOR UPDATE OF notice SKIP LOCKED
       LIMIT 1
    )
    UPDATE account_deletion_completion_outbox AS notice
       SET status = 'sending',
           attempt_count = notice.attempt_count + 1,
           first_attempt_at = COALESCE(notice.first_attempt_at, @now),
           lease_token = @leaseToken,
           lease_expires_at = @leaseExpiresAt,
           updated_at = @now
      FROM candidate
     WHERE notice.request_id = candidate.request_id
    RETURNING notice.*`,

  lockAccountDeletionPayload: `/* postgres-worker:lock-account-deletion-payload */
    UPDATE account_deletion_completion_outbox
       SET payload_fingerprint = COALESCE(payload_fingerprint, @payloadFingerprint),
           updated_at = @now
     WHERE request_id = @requestId
       AND ${OUTBOX_LEASE_GUARD}
       AND (payload_fingerprint IS NULL OR payload_fingerprint = @payloadFingerprint)
    RETURNING request_id AS "mutationKey"`,

  acceptAccountDeletionNotification: `/* postgres-worker:accept-account-deletion */
    UPDATE account_deletion_completion_outbox
       SET status = 'accepted',
           provider_message_id = COALESCE(provider_message_id, @providerMessageId),
           provider_last_event = COALESCE(provider_last_event, 'accepted'),
           accepted_at = COALESCE(accepted_at, @acceptedAt),
           next_attempt_at = @nextCheckAt,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = @acceptedAt
     WHERE request_id = @requestId
       AND ${OUTBOX_LEASE_GUARD}
       AND (provider_message_id IS NULL OR provider_message_id = @providerMessageId)
    RETURNING request_id AS "mutationKey"`,

  deferAccountDeletionNotification: `/* postgres-worker:defer-account-deletion */
    UPDATE account_deletion_completion_outbox
       SET status = CASE WHEN provider_message_id IS NULL THEN 'pending' ELSE 'accepted' END,
           next_attempt_at = @nextAttemptAt,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = @redactedError,
           updated_at = @now
     WHERE request_id = @requestId
       AND ${OUTBOX_LEASE_GUARD}
    RETURNING request_id AS "mutationKey"`,

  failAccountDeletionNotification: `/* postgres-worker:fail-account-deletion */
    UPDATE account_deletion_completion_outbox
       SET status = 'failed',
           provider_last_event = COALESCE(@providerEvent, provider_last_event),
           provider_event_at = COALESCE(@providerEventAt, provider_event_at),
           next_attempt_at = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = @redactedError,
           terminal_at = @now,
           updated_at = @now
     WHERE request_id = @requestId
       AND ${OUTBOX_LEASE_GUARD}
    RETURNING request_id AS "mutationKey"`,

  claimAdminIngestionReview: `/* postgres-worker:claim-admin-ingestion-review */
    WITH candidate AS (
      SELECT queued.id
        FROM admin_ingestion_queue AS queued
       WHERE (@id::text IS NULL OR queued.id = @id)
         AND (
           (queued.status = 'pending_review' AND queued.review_claim_token IS NULL)
           OR (
             queued.status IN ('publishing', 'rejecting')
             AND (queued.review_claimed_at IS NULL OR queued.review_claimed_at <= @staleBefore)
           )
         )
       ORDER BY queued.created_at ASC, queued.id ASC
       FOR UPDATE OF queued SKIP LOCKED
       LIMIT 1
    )
    UPDATE admin_ingestion_queue AS queued
       SET status = @status,
           review_claim_token = @claimToken,
           review_claimed_at = @claimedAt,
           updated_at = @claimedAt
      FROM candidate
     WHERE queued.id = candidate.id
    RETURNING queued.id,
              queued.status,
              queued.review_claim_token AS "claimToken",
              queued.review_claimed_at AS "claimedAt"`,
});

function assertCorrelationValue(label: string, value: string): void {
  if (!value || value !== value.trim() || value.length > 255) {
    throw new Error(`${label} must be a non-empty value of at most 255 characters.`);
  }
}

function assertCanonicalTimestamp(label: string, value: string): void {
  try {
    if (new Date(value).toISOString() !== value) throw new Error("non-canonical");
  } catch {
    throw new Error(`${label} must be a canonical UTC ISO timestamp.`);
  }
}

function assertOrderedTimestamps(
  earlierLabel: string,
  earlier: string,
  laterLabel: string,
  later: string,
  allowEqual = true,
): void {
  assertCanonicalTimestamp(earlierLabel, earlier);
  assertCanonicalTimestamp(laterLabel, later);
  if (allowEqual ? earlier > later : earlier >= later) {
    throw new Error(`${laterLabel} must be ${allowEqual ? "at or after" : "after"} ${earlierLabel}.`);
  }
}

function boundedRedactedError(value: string): string {
  return value.slice(0, 500);
}

export class PostgresWorkerRepository {
  constructor(private readonly database: SqlDatabase) {
    if (database.dialect !== "postgres") {
      throw new Error("PostgresWorkerRepository requires a Postgres SqlDatabase.");
    }
  }

  async claimNextAccountDeletionCompletionNotification(input: {
    now: string;
    staleBefore: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<PostgresAccountDeletionOutboxRow | null> {
    assertCorrelationValue("leaseToken", input.leaseToken);
    assertOrderedTimestamps("staleBefore", input.staleBefore, "now", input.now);
    assertOrderedTimestamps("now", input.now, "leaseExpiresAt", input.leaseExpiresAt, false);
    const row = await this.database
      .prepare(postgresWorkerQueries.claimAccountDeletionNotification)
      .get<PostgresAccountDeletionOutboxRow>({
        now: input.now,
        staleBefore: input.staleBefore,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    if (!row) return null;
    if (row.status !== "sending" || row.lease_token !== input.leaseToken) {
      throw new Error("Account deletion notification claim returned an invalid ownership token.");
    }
    return row;
  }

  async lockAccountDeletionNotificationPayload(input: {
    requestId: string;
    leaseToken: string;
    payloadFingerprint: string;
    now: string;
  }): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(input.payloadFingerprint)) return false;
    assertCorrelationValue("requestId", input.requestId);
    assertCorrelationValue("leaseToken", input.leaseToken);
    assertCanonicalTimestamp("now", input.now);
    return this.mutationSucceeded(postgresWorkerQueries.lockAccountDeletionPayload, input);
  }

  async markAccountDeletionNotificationAccepted(input: {
    requestId: string;
    leaseToken: string;
    providerMessageId: string;
    acceptedAt: string;
    nextCheckAt: string;
  }): Promise<boolean> {
    assertCorrelationValue("requestId", input.requestId);
    assertCorrelationValue("leaseToken", input.leaseToken);
    assertCorrelationValue("providerMessageId", input.providerMessageId);
    assertOrderedTimestamps("acceptedAt", input.acceptedAt, "nextCheckAt", input.nextCheckAt);
    return this.mutationSucceeded(postgresWorkerQueries.acceptAccountDeletionNotification, input);
  }

  async deferAccountDeletionNotification(input: {
    requestId: string;
    leaseToken: string;
    nextAttemptAt: string;
    redactedError: string;
    now: string;
  }): Promise<boolean> {
    assertCorrelationValue("requestId", input.requestId);
    assertCorrelationValue("leaseToken", input.leaseToken);
    assertOrderedTimestamps("now", input.now, "nextAttemptAt", input.nextAttemptAt);
    return this.mutationSucceeded(postgresWorkerQueries.deferAccountDeletionNotification, {
      ...input,
      redactedError: boundedRedactedError(input.redactedError),
    });
  }

  async markAccountDeletionNotificationFailed(input: {
    requestId: string;
    leaseToken: string;
    providerEvent?: string | null;
    redactedError: string;
    now: string;
  }): Promise<boolean> {
    assertCorrelationValue("requestId", input.requestId);
    assertCorrelationValue("leaseToken", input.leaseToken);
    assertCanonicalTimestamp("now", input.now);
    return this.mutationSucceeded(postgresWorkerQueries.failAccountDeletionNotification, {
      requestId: input.requestId,
      leaseToken: input.leaseToken,
      providerEvent: input.providerEvent ?? null,
      providerEventAt: input.providerEvent ? input.now : null,
      redactedError: boundedRedactedError(input.redactedError),
      now: input.now,
    });
  }

  async claimAdminIngestionReview(input: {
    id?: string | null;
    action: "publish" | "reject";
    claimToken: string;
    claimedAt: string;
    staleBefore: string;
  }): Promise<AdminIngestionReviewClaim | null> {
    if (input.id !== undefined && input.id !== null) assertCorrelationValue("id", input.id);
    assertCorrelationValue("claimToken", input.claimToken);
    assertOrderedTimestamps("staleBefore", input.staleBefore, "claimedAt", input.claimedAt);
    const row = await this.database
      .prepare(postgresWorkerQueries.claimAdminIngestionReview)
      .get<AdminIngestionReviewClaimRow>({
        id: input.id ?? null,
        status: input.action === "publish" ? "publishing" : "rejecting",
        claimToken: input.claimToken,
        claimedAt: input.claimedAt,
        staleBefore: input.staleBefore,
      });
    if (!row) return null;
    const expectedStatus = input.action === "publish" ? "publishing" : "rejecting";
    if (
      row.status !== expectedStatus
      || row.claimToken !== input.claimToken
      || row.claimedAt !== input.claimedAt
    ) {
      throw new Error("Admin ingestion review claim returned an invalid ownership token.");
    }
    return row;
  }

  private async mutationSucceeded(
    sql: string,
    bindings: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const row = await this.database.prepare(sql).get<MutationReceiptRow>(bindings);
    return row !== undefined;
  }
}
