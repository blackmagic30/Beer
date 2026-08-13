import { redactSecrets } from "../lib/redact.js";
import {
  BILLING_CHECKOUT_LOCK_CONTRACT,
  billingCheckoutActorLockKey,
} from "./billing-checkout.repository.js";
import {
  MISSION_LIFECYCLE_LOCK_CONTRACT,
  missionLifecycleAccountLockKey,
} from "./mission-lifecycle.repository.js";
import { postgresWorkerQueries } from "./postgres-worker.repository.js";
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
  VENUE_REQUEST_LOCK_CONTRACT,
  venueRequestAccountLockKey,
} from "./venue-request.repository.js";
import {
  VENUE_PARTNER_LOCK_CONTRACT,
  venuePartnerAccountLockKey,
} from "./venue-partner.repository.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_LIST_LIMIT = 1_000;
const MAX_LIST_OFFSET = 2_147_483_647;
const MAX_RECIPIENT_CIPHERTEXT_BYTES = 4_096;

/** Maximum recipient secrets purged by one short transaction. Reinvoke until the result is below this limit. */
export const ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT = 64;

/**
 * Cross-repository lock fence used by every deletion-request creation or state
 * transition. Advisory keys are sorted before the account row and request row
 * are locked, matching checkout, venue-access, mission-lifecycle, venue-
 * request, and venue-partner writers.
 */
export const ACCOUNT_DELETION_CROSS_REPOSITORY_LOCK_CONTRACT = Object.freeze({
  version: 1,
  billingCheckoutVersion: BILLING_CHECKOUT_LOCK_CONTRACT.version,
  venueAccessVersion: VENUE_ACCESS_LOCK_CONTRACT.version,
  missionLifecycleVersion: MISSION_LIFECYCLE_LOCK_CONTRACT.version,
  venueRequestVersion: VENUE_REQUEST_LOCK_CONTRACT.version,
  venuePartnerVersion: VENUE_PARTNER_LOCK_CONTRACT.version,
  sourceEvidenceObjectVersion: SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT.version,
  order: Object.freeze([
    "sorted_cross_repository_account_advisory_keys",
    "account_row",
    "account_deletion_request_row",
    "conditional_write",
  ] as const),
} as const);

export type AccountDeletionRequestStatus =
  | "pending_review"
  | "approved"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

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

export type AccountDeletionOperatorRole = "user" | "admin" | "venue_manager";

export interface AccountDeletionRequestRow {
  id: string;
  user_id: string;
  status: AccountDeletionRequestStatus;
  user_message: string | null;
  requested_at: string;
  execute_after: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  completed_at: string | null;
  processing_started_at: string | null;
  identity_deleted_at: string | null;
  stripe_customer_deleted_at: string | null;
  stripe_customer_id_snapshot: string | null;
  deletion_tombstone_recorded_at: string | null;
  last_error: string | null;
  attempt_count: number;
  result_summary_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountDeletionRequestListRow extends AccountDeletionRequestRow {
  completion_notification_status: AccountDeletionNotificationStatus | null;
  completion_notification_attempt_count: number | null;
  completion_notification_provider_message_id: string | null;
  completion_notification_provider_event: string | null;
  completion_notification_accepted_at: string | null;
  completion_notification_delivered_at: string | null;
  completion_notification_terminal_at: string | null;
  completion_notification_retention_expires_at: string | null;
  completion_notification_last_error: string | null;
  completion_notification_updated_at: string | null;
}

export interface AccountDeletionCompletionOutboxRow {
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

export interface AccountDeletionNoticeRecipientSecretRow {
  request_id: string;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  created_at: string;
  purge_after: string;
}

export interface AccountDeletionQueueSummary {
  actionableCount: number;
  dueCount: number;
  failedCount: number;
  processingCount: number;
  oldestDueAt: string | null;
  nextDueAt: string | null;
}

export interface AccountDeletionNotificationQueueSummary {
  pendingCount: number;
  acceptedCount: number;
  manualReviewCount: number;
  overdueRetentionCount: number;
  securePurgeCheckpointPendingCount: number;
  oldestSecurePurgeCheckpointAt: string | null;
  oldestPendingAt: string | null;
}

export interface AccountDeletionNotificationOperatorAudit {
  id: string;
  actorUserId: string;
  actorRole: AccountDeletionOperatorRole;
  reason: string;
}

export interface AccountDeletionSecretPurgeCheckpointEntry {
  requestId: string;
  generation: number;
}

export type AccountDeletionQueueRepositoryErrorCode =
  | "account_not_found"
  | "invalid_input"
  | "notification_identity_conflict"
  | "notification_terminal"
  | "notification_recipient_missing"
  | "provider_event_identity_conflict"
  | "operator_audit_conflict"
  | "numeric_range";

const ERROR_MESSAGES: Readonly<Record<AccountDeletionQueueRepositoryErrorCode, string>> = {
  account_not_found: "The account for the deletion request does not exist.",
  invalid_input: "The account deletion queue input is invalid.",
  notification_identity_conflict: "The completion notification identity conflicts with durable state.",
  notification_terminal: "The completion notification is already terminal.",
  notification_recipient_missing: "The completion notification recipient was not durably prepared.",
  provider_event_identity_conflict: "The provider event identity conflicts with durable state.",
  operator_audit_conflict: "The operator audit identity conflicts with durable state.",
  numeric_range: "Account deletion queue numeric data is outside the supported range.",
};

/** Stable failures that never interpolate identifiers, provider payloads, or encrypted data. */
export class AccountDeletionQueueRepositoryError extends Error {
  readonly code: AccountDeletionQueueRepositoryErrorCode;

  constructor(code: AccountDeletionQueueRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AccountDeletionQueueRepositoryError";
    this.code = code;
  }
}

interface RawAccountDeletionRequestRow extends Omit<AccountDeletionRequestRow, "attempt_count"> {
  attempt_count: number | string;
}

interface RawAccountDeletionRequestListRow extends RawAccountDeletionRequestRow {
  completion_notification_status: AccountDeletionNotificationStatus | null;
  completion_notification_attempt_count: number | string | null;
  completion_notification_provider_message_id: string | null;
  completion_notification_provider_event: string | null;
  completion_notification_accepted_at: string | null;
  completion_notification_delivered_at: string | null;
  completion_notification_terminal_at: string | null;
  completion_notification_retention_expires_at: string | null;
  completion_notification_last_error: string | null;
  completion_notification_updated_at: string | null;
}

interface RawAccountDeletionCompletionOutboxRow extends Omit<
  AccountDeletionCompletionOutboxRow,
  "secret_purge_checkpoint_pending" | "secret_purge_generation" | "attempt_count"
> {
  secret_purge_checkpoint_pending: boolean | number;
  secret_purge_generation: number | string;
  attempt_count: number | string;
}

interface CountRow {
  count: number | string;
}

const REQUEST_STATUSES = new Set<AccountDeletionRequestStatus>([
  "pending_review",
  "approved",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_NOTIFICATION_STATUSES = new Set<AccountDeletionNotificationStatus>([
  "delivered",
  "failed",
  "purged",
  "cancelled",
  "suppressed_restore",
]);

function invalidInput(): never {
  throw new AccountDeletionQueueRepositoryError("invalid_input");
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

function requireOptionalMessage(value: string | null): string | null {
  if (value === null) return null;
  if (!value || value.length > 2_000 || value !== value.trim() || value.includes("\0")) invalidInput();
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

function requireTimestampOrder(earlier: string, later: string, allowEqual = true): void {
  requireCanonicalUtc(earlier);
  requireCanonicalUtc(later);
  if (allowEqual ? earlier > later : earlier >= later) invalidInput();
}

function requireRequestStatus(value: string): AccountDeletionRequestStatus {
  if (!REQUEST_STATUSES.has(value as AccountDeletionRequestStatus)) invalidInput();
  return value as AccountDeletionRequestStatus;
}

function requireSafeNonNegativeInteger(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalidInput();
  return value;
}

function safeDatabaseInteger(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new AccountDeletionQueueRepositoryError("numeric_range");
  }
  if (typeof value === "string" && BigInt(value) !== BigInt(numeric)) {
    throw new AccountDeletionQueueRepositoryError("numeric_range");
  }
  return numeric;
}

function optionalSafeDatabaseInteger(value: number | string | null): number | null {
  return value === null ? null : safeDatabaseInteger(value);
}

function requireBuffer(value: Buffer, exactLength?: number): Buffer {
  if (
    !Buffer.isBuffer(value)
    || value.length === 0
    || (exactLength !== undefined && value.length !== exactLength)
    || value.length > MAX_RECIPIENT_CIPHERTEXT_BYTES
  ) invalidInput();
  return Buffer.from(value);
}

function sanitizeError(value: string): string {
  if (!value || value.length > 20_000 || value.includes("\0")) invalidInput();
  return redactSecrets(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .slice(0, 500);
}

function sanitizeAuditReason(value: string): string {
  if (!value || value !== value.trim() || value.length > 500 || value.includes("\0")) invalidInput();
  return redactSecrets(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .slice(0, 220);
}

function toRequest(row: RawAccountDeletionRequestRow): AccountDeletionRequestRow {
  return { ...row, attempt_count: safeDatabaseInteger(row.attempt_count) };
}

function toRequestListRow(row: RawAccountDeletionRequestListRow): AccountDeletionRequestListRow {
  return {
    ...toRequest(row),
    completion_notification_status: row.completion_notification_status,
    completion_notification_attempt_count: optionalSafeDatabaseInteger(
      row.completion_notification_attempt_count,
    ),
    completion_notification_provider_message_id: row.completion_notification_provider_message_id,
    completion_notification_provider_event: row.completion_notification_provider_event,
    completion_notification_accepted_at: row.completion_notification_accepted_at,
    completion_notification_delivered_at: row.completion_notification_delivered_at,
    completion_notification_terminal_at: row.completion_notification_terminal_at,
    completion_notification_retention_expires_at: row.completion_notification_retention_expires_at,
    completion_notification_last_error: row.completion_notification_last_error,
    completion_notification_updated_at: row.completion_notification_updated_at,
  };
}

function toOutbox(row: RawAccountDeletionCompletionOutboxRow): AccountDeletionCompletionOutboxRow {
  return {
    ...row,
    secret_purge_checkpoint_pending: Boolean(row.secret_purge_checkpoint_pending),
    secret_purge_generation: safeDatabaseInteger(row.secret_purge_generation),
    attempt_count: safeDatabaseInteger(row.attempt_count),
  };
}

function requireAudit(audit: AccountDeletionNotificationOperatorAudit): {
  id: string;
  actorUserId: string;
  actorRole: AccountDeletionOperatorRole;
  reason: string;
} {
  if (!["user", "admin", "venue_manager"].includes(audit.actorRole)) invalidInput();
  return {
    id: requireIdentifier(audit.id),
    actorUserId: requireIdentifier(audit.actorUserId),
    actorRole: audit.actorRole,
    reason: sanitizeAuditReason(audit.reason),
  };
}

/**
 * Async account-deletion request and completion-notification state boundary.
 * Provider and offsite-ledger I/O must happen between these short mutations,
 * never inside a repository transaction.
 */
export class AccountDeletionQueueRepository {
  constructor(private readonly database: SqlDatabase) {}

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

  private async lockDeletionActorAccount(userId: string): Promise<void> {
    await this.advisoryLocks([
      billingCheckoutActorLockKey(userId),
      missionLifecycleAccountLockKey(userId),
      venueAccessAccountLockKey(userId),
      venueRequestAccountLockKey(userId),
      venuePartnerAccountLockKey(userId),
      sourceEvidenceAccountLockKey(userId),
    ]);
    const account = await this.database.prepare(
      `SELECT account.id AS "id"
         FROM accounts account
        WHERE account.id = ?${this.lockSuffix("account")}`,
    ).get<{ id: string }>(userId);
    if (!account || account.id !== userId) {
      throw new AccountDeletionQueueRepositoryError("account_not_found");
    }
  }

  /**
   * Discover the immutable owner without a row lock, then fence the actor and
   * re-read under the request-row lock. This preserves lock-before-row order.
   */
  private async lockDeletionRequest(
    requestId: string,
    expectedUserId?: string,
  ): Promise<{ userId: string } | null> {
    const snapshot = await this.database.prepare(
      `SELECT deletion.user_id AS "userId"
         FROM account_deletion_requests deletion
        WHERE deletion.id = ?`,
    ).get<{ userId: string }>(requestId);
    if (!snapshot || (expectedUserId !== undefined && snapshot.userId !== expectedUserId)) return null;

    const userId = requireIdentifier(snapshot.userId);
    await this.lockDeletionActorAccount(userId);
    const locked = await this.database.prepare(
      `SELECT deletion.user_id AS "userId"
         FROM account_deletion_requests deletion
        WHERE deletion.id = ?${this.lockSuffix("deletion")}`,
    ).get<{ userId: string }>(requestId);
    if (
      !locked
      || locked.userId !== userId
      || (expectedUserId !== undefined && locked.userId !== expectedUserId)
    ) return null;
    return { userId };
  }

  private checkpointBoolean(value: boolean): boolean | number {
    return this.database.dialect === "postgres" ? value : value ? 1 : 0;
  }

  private async insertOperatorAudit(input: {
    audit: ReturnType<typeof requireAudit>;
    action: string;
    requestId: string;
    metadata: Record<string, unknown>;
    now: string;
  }): Promise<void> {
    const inserted = await this.database.prepare(
      `INSERT INTO security_audit_log (
         id, actor_user_id, actor_role, action, target_type, target_id,
         metadata_json, ip_hash, user_agent_hash, created_at
       ) VALUES (
         @id, @actorUserId, @actorRole, @action, 'account_deletion_request', @requestId,
         @metadataJson, NULL, NULL, @now
       ) ON CONFLICT(id) DO NOTHING`,
    ).run({
      id: input.audit.id,
      actorUserId: input.audit.actorUserId,
      actorRole: input.audit.actorRole,
      action: input.action,
      requestId: input.requestId,
      metadataJson: JSON.stringify(redactSecrets(input.metadata)),
      now: input.now,
    });
    if (inserted.changes !== 1) {
      throw new AccountDeletionQueueRepositoryError("operator_audit_conflict");
    }
  }

  async createAccountDeletionRequest(input: {
    id: string;
    userId: string;
    userMessage: string | null;
    requestedAt: string;
    executeAfter: string;
  }): Promise<AccountDeletionRequestRow> {
    const id = requireIdentifier(input.id);
    const userId = requireIdentifier(input.userId);
    const userMessage = requireOptionalMessage(input.userMessage);
    requireTimestampOrder(input.requestedAt, input.executeAfter);

    return this.database.transaction(async () => {
      await this.lockDeletionActorAccount(userId);
      await this.database.prepare(
        `INSERT INTO account_deletion_requests (
           id, user_id, status, user_message, requested_at, execute_after,
           reviewed_by, reviewed_at, completed_at, result_summary_json, created_at, updated_at
         ) VALUES (
           @id, @userId, 'pending_review', @userMessage, @requestedAt, @executeAfter,
           NULL, NULL, NULL, NULL, @requestedAt, @requestedAt
         ) ON CONFLICT DO NOTHING`,
      ).run({ id, userId, userMessage, requestedAt: input.requestedAt, executeAfter: input.executeAfter });
      const row = await this.database.prepare(
        `SELECT * FROM account_deletion_requests
          WHERE user_id = @userId
            AND status IN ('pending_review', 'approved', 'processing', 'failed')
          ORDER BY requested_at DESC, id ASC
          LIMIT 1`,
      ).get<RawAccountDeletionRequestRow>({ userId });
      if (!row) throw new AccountDeletionQueueRepositoryError("notification_identity_conflict");
      return toRequest(row);
    })();
  }

  async listAccountDeletionRequests(input: {
    status?: AccountDeletionRequestStatus | undefined;
    limit: number;
    offset?: number | undefined;
    asOf?: string | undefined;
  }): Promise<AccountDeletionRequestListRow[]> {
    const limit = requireSafeNonNegativeInteger(input.limit, MAX_LIST_LIMIT);
    if (limit === 0) invalidInput();
    const offset = requireSafeNonNegativeInteger(input.offset ?? 0, MAX_LIST_OFFSET);
    const asOf = requireCanonicalUtc(input.asOf ?? new Date().toISOString());
    const status = input.status === undefined ? null : requireRequestStatus(input.status);
    const whereClause = status === null ? "" : "WHERE deletion.status = @status";
    const rows = await this.database.prepare(
      `SELECT deletion.*,
              notice.status AS completion_notification_status,
              notice.attempt_count AS completion_notification_attempt_count,
              notice.provider_message_id AS completion_notification_provider_message_id,
              notice.provider_last_event AS completion_notification_provider_event,
              notice.accepted_at AS completion_notification_accepted_at,
              notice.delivered_at AS completion_notification_delivered_at,
              notice.terminal_at AS completion_notification_terminal_at,
              notice.retention_expires_at AS completion_notification_retention_expires_at,
              notice.last_error AS completion_notification_last_error,
              notice.updated_at AS completion_notification_updated_at
         FROM account_deletion_requests deletion
         LEFT JOIN account_deletion_completion_outbox notice ON notice.request_id = deletion.id
         ${whereClause}
        ORDER BY
          CASE
            WHEN deletion.status IN ('pending_review', 'approved', 'failed', 'processing')
             AND deletion.execute_after <= @asOf THEN 0
            WHEN deletion.status IN ('pending_review', 'approved', 'failed', 'processing') THEN 1
            ELSE 2
          END ASC,
          CASE WHEN deletion.status IN ('pending_review', 'approved', 'failed', 'processing')
               THEN deletion.execute_after ELSE NULL END ASC,
          CASE WHEN deletion.status NOT IN ('pending_review', 'approved', 'failed', 'processing')
               THEN deletion.requested_at ELSE NULL END DESC,
          deletion.id ASC
        LIMIT @limit OFFSET @offset`,
    ).all<RawAccountDeletionRequestListRow>({ status, asOf, limit, offset });
    return rows.map(toRequestListRow);
  }

  async getAccountDeletionQueueSummary(asOf: string): Promise<AccountDeletionQueueSummary> {
    requireCanonicalUtc(asOf);
    const row = await this.database.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('pending_review', 'approved', 'failed', 'processing')
                           THEN 1 ELSE 0 END), 0) AS actionable_count,
         COALESCE(SUM(CASE WHEN status IN ('pending_review', 'approved', 'failed', 'processing')
                            AND execute_after <= @asOf THEN 1 ELSE 0 END), 0) AS due_count,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
         COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_count,
         MIN(CASE WHEN status IN ('pending_review', 'approved', 'failed', 'processing')
                   AND execute_after <= @asOf THEN execute_after ELSE NULL END) AS oldest_due_at,
         MIN(CASE WHEN status IN ('pending_review', 'approved', 'failed', 'processing')
                   AND execute_after > @asOf THEN execute_after ELSE NULL END) AS next_due_at
       FROM account_deletion_requests`,
    ).get<{
      actionable_count: number | string;
      due_count: number | string;
      failed_count: number | string;
      processing_count: number | string;
      oldest_due_at: string | null;
      next_due_at: string | null;
    }>({ asOf });
    return {
      actionableCount: safeDatabaseInteger(row?.actionable_count ?? 0),
      dueCount: safeDatabaseInteger(row?.due_count ?? 0),
      failedCount: safeDatabaseInteger(row?.failed_count ?? 0),
      processingCount: safeDatabaseInteger(row?.processing_count ?? 0),
      oldestDueAt: row?.oldest_due_at ?? null,
      nextDueAt: row?.next_due_at ?? null,
    };
  }

  async countAccountDeletionRequests(status?: AccountDeletionRequestStatus): Promise<number> {
    const normalizedStatus = status === undefined ? null : requireRequestStatus(status);
    const row = normalizedStatus === null
      ? await this.database.prepare("SELECT count(*) AS count FROM account_deletion_requests").get<CountRow>()
      : await this.database.prepare(
        "SELECT count(*) AS count FROM account_deletion_requests WHERE status = @status",
      ).get<CountRow>({ status: normalizedStatus });
    return safeDatabaseInteger(row?.count ?? 0);
  }

  async getAccountDeletionRequestForUser(userId: string): Promise<AccountDeletionRequestRow | null> {
    const row = await this.database.prepare(
      `SELECT * FROM account_deletion_requests
        WHERE user_id = @userId ORDER BY requested_at DESC, id ASC LIMIT 1`,
    ).get<RawAccountDeletionRequestRow>({ userId: requireIdentifier(userId) });
    return row ? toRequest(row) : null;
  }

  async getAccountDeletionRequestById(requestId: string): Promise<AccountDeletionRequestRow | null> {
    const row = await this.database.prepare(
      "SELECT * FROM account_deletion_requests WHERE id = @requestId LIMIT 1",
    ).get<RawAccountDeletionRequestRow>({ requestId: requireIdentifier(requestId) });
    return row ? toRequest(row) : null;
  }

  async beginAccountDeletion(input: {
    requestId: string;
    reviewedBy: string;
    now: string;
    staleBefore: string;
  }): Promise<AccountDeletionRequestRow | null> {
    const requestId = requireIdentifier(input.requestId);
    const reviewedBy = requireIdentifier(input.reviewedBy);
    requireTimestampOrder(input.staleBefore, input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId)) return null;
      const claimed = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET status = 'processing', reviewed_by = @reviewedBy,
                reviewed_at = COALESCE(reviewed_at, @now), processing_started_at = @now,
                last_error = NULL, attempt_count = attempt_count + 1, updated_at = @now
          WHERE id = @requestId AND (
            status IN ('pending_review', 'approved', 'failed')
            OR (status = 'processing' AND processing_started_at <= @staleBefore)
          )
          RETURNING *`,
      ).get<RawAccountDeletionRequestRow>({
        requestId,
        reviewedBy,
        now: input.now,
        staleBefore: input.staleBefore,
      });
      return claimed ? toRequest(claimed) : null;
    })();
  }

  async beginAccountDeletionWithCompletionNotification(input: {
    requestId: string;
    reviewedBy: string;
    now: string;
    staleBefore: string;
    templateVersion: string;
    idempotencyKey: string;
    keyId: string;
    nonce: Buffer;
    ciphertext: Buffer;
    authTag: Buffer;
    purgeAfter: string;
  }): Promise<AccountDeletionRequestRow | null> {
    const requestId = requireIdentifier(input.requestId);
    const reviewedBy = requireIdentifier(input.reviewedBy);
    const templateVersion = requireIdentifier(input.templateVersion);
    const idempotencyKey = requireIdentifier(input.idempotencyKey);
    const keyId = requireIdentifier(input.keyId);
    const nonce = requireBuffer(input.nonce, 12);
    const ciphertext = requireBuffer(input.ciphertext);
    const authTag = requireBuffer(input.authTag, 16);
    requireTimestampOrder(input.staleBefore, input.now);
    requireTimestampOrder(input.now, input.purgeAfter, false);

    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId)) return null;
      const claimed = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET status = 'processing', reviewed_by = @reviewedBy,
                reviewed_at = COALESCE(reviewed_at, @now), processing_started_at = @now,
                last_error = NULL, attempt_count = attempt_count + 1, updated_at = @now
          WHERE id = @requestId AND (
            status IN ('pending_review', 'approved', 'failed')
            OR (status = 'processing' AND processing_started_at <= @staleBefore)
          )`,
      ).run({ requestId, reviewedBy, now: input.now, staleBefore: input.staleBefore });
      if (claimed.changes !== 1) return null;

      await this.database.prepare(
        `INSERT INTO account_deletion_completion_outbox (
           request_id, template_version, idempotency_key, payload_fingerprint, status, attempt_count,
           first_attempt_at, next_attempt_at, lease_token, lease_expires_at,
           provider_message_id, provider_last_event, provider_event_at, last_error,
           completed_at, accepted_at, delivered_at, terminal_at, retention_expires_at,
           created_at, updated_at
         ) VALUES (
           @requestId, @templateVersion, @idempotencyKey, NULL, 'held', 0,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, @now, @now
         ) ON CONFLICT DO NOTHING`,
      ).run({ requestId, templateVersion, idempotencyKey, now: input.now });

      let outbox = await this.getAccountDeletionCompletionOutbox(requestId);
      if (!outbox || outbox.idempotency_key !== idempotencyKey) {
        throw new AccountDeletionQueueRepositoryError("notification_identity_conflict");
      }
      if (outbox.status === "purged" && outbox.completed_at === null) {
        await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET template_version = @templateVersion, payload_fingerprint = NULL, status = 'held',
                  attempt_count = 0, first_attempt_at = NULL, next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL, provider_message_id = NULL,
                  provider_last_event = NULL, provider_event_at = NULL, last_error = NULL,
                  accepted_at = NULL, delivered_at = NULL, terminal_at = NULL,
                  retention_expires_at = NULL,
                  secret_purge_generation = secret_purge_generation + 1, updated_at = @now
            WHERE request_id = @requestId AND status = 'purged' AND completed_at IS NULL`,
        ).run({ requestId, templateVersion, now: input.now });
        outbox = await this.getAccountDeletionCompletionOutbox(requestId);
      }
      if (!outbox || TERMINAL_NOTIFICATION_STATUSES.has(outbox.status)) {
        throw new AccountDeletionQueueRepositoryError("notification_terminal");
      }

      await this.database.prepare(
        `INSERT INTO account_deletion_notice_recipient_secrets (
           request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
         ) VALUES (
           @requestId, @keyId, @nonce, @ciphertext, @authTag, @now, @purgeAfter
         ) ON CONFLICT(request_id) DO NOTHING`,
      ).run({ requestId, keyId, nonce, ciphertext, authTag, now: input.now, purgeAfter: input.purgeAfter });
      const recipient = await this.database.prepare(
        "SELECT request_id FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
      ).get<{ request_id: string }>({ requestId });
      if (!recipient) throw new AccountDeletionQueueRepositoryError("notification_recipient_missing");
      const request = await this.getAccountDeletionRequestById(requestId);
      if (!request) throw new AccountDeletionQueueRepositoryError("notification_identity_conflict");
      return request;
    })();
  }

  async getAccountDeletionCompletionOutbox(
    requestId: string,
  ): Promise<AccountDeletionCompletionOutboxRow | null> {
    const row = await this.database.prepare(
      "SELECT * FROM account_deletion_completion_outbox WHERE request_id = @requestId",
    ).get<RawAccountDeletionCompletionOutboxRow>({ requestId: requireIdentifier(requestId) });
    return row ? toOutbox(row) : null;
  }

  async getAccountDeletionNoticeRecipientSecret(
    requestId: string,
  ): Promise<AccountDeletionNoticeRecipientSecretRow | null> {
    const row = await this.database.prepare(
      "SELECT * FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
    ).get<AccountDeletionNoticeRecipientSecretRow>({ requestId: requireIdentifier(requestId) });
    if (!row) return null;
    if (!Buffer.isBuffer(row.nonce) || !Buffer.isBuffer(row.ciphertext) || !Buffer.isBuffer(row.auth_tag)) {
      throw new AccountDeletionQueueRepositoryError("notification_recipient_missing");
    }
    return { ...row, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), auth_tag: Buffer.from(row.auth_tag) };
  }

  async listReferencedAccountDeletionNoticeKeyIds(): Promise<string[]> {
    const rows = await this.database.prepare(
      "SELECT DISTINCT key_id FROM account_deletion_notice_recipient_secrets ORDER BY key_id",
    ).all<{ key_id: string }>();
    return rows.map((row) => row.key_id);
  }

  async lockAccountDeletionNotificationPayload(input: {
    requestId: string;
    leaseToken: string;
    payloadFingerprint: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    requireCanonicalUtc(input.now);
    if (!SHA256_HEX.test(input.payloadFingerprint)) invalidInput();
    const result = await this.database.prepare(
      this.database.dialect === "postgres"
        ? postgresWorkerQueries.lockAccountDeletionPayload
        : `UPDATE account_deletion_completion_outbox
              SET payload_fingerprint = COALESCE(payload_fingerprint, @payloadFingerprint),
                  updated_at = @now
            WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken
              AND (payload_fingerprint IS NULL OR payload_fingerprint = @payloadFingerprint)`,
    ).run({ requestId, leaseToken, payloadFingerprint: input.payloadFingerprint, now: input.now });
    return result.changes === 1;
  }

  async claimNextAccountDeletionCompletionNotification(input: {
    now: string;
    staleBefore: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<AccountDeletionCompletionOutboxRow | null> {
    const leaseToken = requireIdentifier(input.leaseToken);
    requireTimestampOrder(input.staleBefore, input.now);
    requireTimestampOrder(input.now, input.leaseExpiresAt, false);
    if (this.database.dialect === "postgres") {
      const row = await this.database.prepare(
        postgresWorkerQueries.claimAccountDeletionNotification,
      ).get<RawAccountDeletionCompletionOutboxRow>({
        now: input.now,
        staleBefore: input.staleBefore,
        leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      if (!row) return null;
      const claimed = toOutbox(row);
      if (claimed.status !== "sending" || claimed.lease_token !== leaseToken) {
        throw new AccountDeletionQueueRepositoryError("notification_identity_conflict");
      }
      return claimed;
    }

    return this.database.transaction(async () => {
      const candidate = await this.database.prepare(
        `SELECT notice.request_id
           FROM account_deletion_completion_outbox notice
           JOIN account_deletion_requests deletion ON deletion.id = notice.request_id
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
          LIMIT 1`,
      ).get<{ request_id: string }>({ now: input.now, staleBefore: input.staleBefore });
      if (!candidate) return null;
      const result = await this.database.prepare(
        `UPDATE account_deletion_completion_outbox
            SET status = 'sending', attempt_count = attempt_count + 1,
                first_attempt_at = COALESCE(first_attempt_at, @now),
                lease_token = @leaseToken, lease_expires_at = @leaseExpiresAt, updated_at = @now
          WHERE request_id = @requestId
            AND (
              status IN ('pending', 'accepted')
              OR (
                status = 'sending'
                AND (
                  lease_expires_at <= @now
                  OR (lease_expires_at IS NULL AND updated_at <= @staleBefore)
                )
              )
            )`,
      ).run({
        requestId: candidate.request_id,
        now: input.now,
        staleBefore: input.staleBefore,
        leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      return result.changes === 1
        ? this.getAccountDeletionCompletionOutbox(candidate.request_id)
        : null;
    })();
  }

  async markAccountDeletionNotificationAccepted(input: {
    requestId: string;
    leaseToken: string;
    providerMessageId: string;
    acceptedAt: string;
    nextCheckAt: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    const providerMessageId = requireIdentifier(input.providerMessageId);
    requireTimestampOrder(input.acceptedAt, input.nextCheckAt, false);
    const result = await this.database.prepare(
      this.database.dialect === "postgres"
        ? postgresWorkerQueries.acceptAccountDeletionNotification
        : `UPDATE account_deletion_completion_outbox
              SET status = 'accepted', provider_message_id = COALESCE(provider_message_id, @providerMessageId),
                  provider_last_event = COALESCE(provider_last_event, 'accepted'),
                  accepted_at = COALESCE(accepted_at, @acceptedAt), next_attempt_at = @nextCheckAt,
                  lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = @acceptedAt
            WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken
              AND (provider_message_id IS NULL OR provider_message_id = @providerMessageId)`,
    ).run({ requestId, leaseToken, providerMessageId, acceptedAt: input.acceptedAt, nextCheckAt: input.nextCheckAt });
    return result.changes === 1;
  }

  async deferAccountDeletionNotification(input: {
    requestId: string;
    leaseToken: string;
    nextAttemptAt: string;
    error: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    requireTimestampOrder(input.now, input.nextAttemptAt, false);
    const redactedError = sanitizeError(input.error);
    const result = await this.database.prepare(
      this.database.dialect === "postgres"
        ? postgresWorkerQueries.deferAccountDeletionNotification
        : `UPDATE account_deletion_completion_outbox
              SET status = CASE WHEN provider_message_id IS NULL THEN 'pending' ELSE 'accepted' END,
                  next_attempt_at = @nextAttemptAt, lease_token = NULL, lease_expires_at = NULL,
                  last_error = @redactedError, updated_at = @now
            WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken`,
    ).run({ requestId, leaseToken, nextAttemptAt: input.nextAttemptAt, redactedError, now: input.now });
    return result.changes === 1;
  }

  async markAccountDeletionNotificationForManualReview(input: {
    requestId: string;
    leaseToken: string;
    providerEvent?: string | null | undefined;
    error: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    const providerEvent = input.providerEvent == null ? null : requireIdentifier(input.providerEvent);
    requireCanonicalUtc(input.now);
    const result = await this.database.prepare(
      `UPDATE account_deletion_completion_outbox
          SET status = 'manual_review', provider_last_event = COALESCE(@providerEvent, provider_last_event),
              provider_event_at = COALESCE(@providerEventAt, provider_event_at), next_attempt_at = NULL,
              lease_token = NULL, lease_expires_at = NULL, last_error = @redactedError, updated_at = @now
        WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken`,
    ).run({
      requestId,
      leaseToken,
      providerEvent,
      providerEventAt: providerEvent ? input.now : null,
      redactedError: sanitizeError(input.error),
      now: input.now,
    });
    return result.changes === 1;
  }

  async markAccountDeletionNotificationFailed(input: {
    requestId: string;
    leaseToken: string;
    providerEvent?: string | null | undefined;
    error: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    const providerEvent = input.providerEvent == null ? null : requireIdentifier(input.providerEvent);
    requireCanonicalUtc(input.now);
    const redactedError = sanitizeError(input.error);
    const result = await this.database.prepare(
      this.database.dialect === "postgres"
        ? postgresWorkerQueries.failAccountDeletionNotification
        : `UPDATE account_deletion_completion_outbox
              SET status = 'failed', provider_last_event = COALESCE(@providerEvent, provider_last_event),
                  provider_event_at = COALESCE(@providerEventAt, provider_event_at), next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL, last_error = @redactedError,
                  terminal_at = @now, updated_at = @now
            WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken`,
    ).run({
      requestId,
      leaseToken,
      providerEvent,
      providerEventAt: providerEvent ? input.now : null,
      redactedError,
      now: input.now,
    });
    return result.changes === 1;
  }

  async retryFailedAccountDeletionNotification(input: {
    requestId: string;
    now: string;
    audit: AccountDeletionNotificationOperatorAudit;
  }): Promise<AccountDeletionCompletionOutboxRow | null> {
    const requestId = requireIdentifier(input.requestId);
    requireCanonicalUtc(input.now);
    const audit = requireAudit(input.audit);
    return this.database.transaction(async () => {
      const result = await this.database.prepare(
        `UPDATE account_deletion_completion_outbox
            SET status = 'pending', attempt_count = 0, first_attempt_at = NULL,
                next_attempt_at = @now, lease_token = NULL, lease_expires_at = NULL,
                provider_message_id = NULL, provider_last_event = NULL, provider_event_at = NULL,
                accepted_at = NULL, delivered_at = NULL, payload_fingerprint = NULL,
                terminal_at = NULL, last_error = NULL, updated_at = @now
          WHERE request_id = @requestId AND status = 'failed' AND provider_message_id IS NULL
            AND retention_expires_at > @now
            AND EXISTS (
              SELECT 1 FROM account_deletion_notice_recipient_secrets recipient
               WHERE recipient.request_id = account_deletion_completion_outbox.request_id
                 AND recipient.purge_after > @now
            )`,
      ).run({ requestId, now: input.now });
      if (result.changes !== 1) return null;
      await this.insertOperatorAudit({
        audit,
        action: "account_deletion_notification_retry_authorized",
        requestId,
        metadata: { reason: audit.reason },
        now: input.now,
      });
      return this.getAccountDeletionCompletionOutbox(requestId);
    })();
  }

  async resolveAccountDeletionNotificationManualReview(input: {
    requestId: string;
    resolution: "verified_delivered" | "undeliverable";
    now: string;
    audit: AccountDeletionNotificationOperatorAudit;
  }): Promise<AccountDeletionCompletionOutboxRow | null> {
    const requestId = requireIdentifier(input.requestId);
    if (!["verified_delivered", "undeliverable"].includes(input.resolution)) invalidInput();
    requireCanonicalUtc(input.now);
    const audit = requireAudit(input.audit);
    const delivered = input.resolution === "verified_delivered";
    const truthLiteral = this.database.dialect === "postgres" ? "TRUE" : "1";
    const deliveredLiteral = delivered
      ? truthLiteral
      : this.database.dialect === "postgres" ? "FALSE" : "0";
    return this.database.transaction(async () => {
      const result = await this.database.prepare(
        `UPDATE account_deletion_completion_outbox
            SET status = @status, provider_last_event = @providerEvent,
                delivered_at = CASE WHEN ${deliveredLiteral} = ${truthLiteral} THEN COALESCE(delivered_at, @now)
                                    ELSE delivered_at END,
                terminal_at = COALESCE(terminal_at, @now), next_attempt_at = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                last_error = CASE WHEN ${deliveredLiteral} = ${truthLiteral} THEN NULL
                                  ELSE 'Operator independently resolved the notice as undeliverable.' END,
                secret_purge_checkpoint_pending = ${truthLiteral},
                secret_purge_generation = secret_purge_generation + 1, updated_at = @now
          WHERE request_id = @requestId
            AND (
              status = 'manual_review'
              OR status = 'purged'
              OR (status = 'failed' AND COALESCE(provider_last_event, '') <> 'operator_resolved_undeliverable')
            )
            AND (${deliveredLiteral} <> ${truthLiteral} OR provider_message_id IS NOT NULL)`,
      ).run({
        requestId,
        status: delivered ? "delivered" : "failed",
        providerEvent: delivered ? "operator_verified_delivered" : "operator_resolved_undeliverable",
        now: input.now,
      });
      if (result.changes !== 1) return null;
      await this.database.prepare(
        "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
      ).run({ requestId });
      await this.insertOperatorAudit({
        audit,
        action: "account_deletion_notification_manually_resolved",
        requestId,
        metadata: { resolution: input.resolution, reason: audit.reason },
        now: input.now,
      });
      return this.getAccountDeletionCompletionOutbox(requestId);
    })();
  }

  async markAccountDeletionNotificationDelivered(input: {
    requestId: string;
    leaseToken: string;
    providerEvent: string;
    eventAt: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const leaseToken = requireIdentifier(input.leaseToken);
    const providerEvent = requireIdentifier(input.providerEvent);
    requireTimestampOrder(input.eventAt, input.now);
    return this.database.transaction(async () => {
      const result = await this.database.prepare(
        `UPDATE account_deletion_completion_outbox
            SET status = 'delivered', provider_last_event = @providerEvent,
                provider_event_at = @eventAt, delivered_at = COALESCE(delivered_at, @eventAt),
                terminal_at = COALESCE(terminal_at, @eventAt), next_attempt_at = NULL,
                lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
                secret_purge_checkpoint_pending = @truth,
                secret_purge_generation = secret_purge_generation + 1, updated_at = @now
          WHERE request_id = @requestId AND status = 'sending' AND lease_token = @leaseToken`,
      ).run({ requestId, leaseToken, providerEvent, eventAt: input.eventAt, now: input.now, truth: this.checkpointBoolean(true) });
      if (result.changes !== 1) return false;
      await this.database.prepare(
        "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
      ).run({ requestId });
      return true;
    })();
  }

  async recordAccountDeletionNotificationWebhook(input: {
    eventId: string;
    providerMessageId: string;
    eventType: string;
    eventCreatedAt: string;
    receivedAt: string;
    payloadSha256: string;
    outcome: "delivered" | "failed" | "pending";
  }): Promise<{ duplicate: boolean; matched: boolean; requestId: string | null }> {
    const eventId = requireIdentifier(input.eventId);
    const providerMessageId = requireIdentifier(input.providerMessageId);
    const eventType = requireIdentifier(input.eventType);
    requireTimestampOrder(input.eventCreatedAt, input.receivedAt);
    if (!SHA256_HEX.test(input.payloadSha256)) invalidInput();
    if (!["delivered", "failed", "pending"].includes(input.outcome)) invalidInput();

    return this.database.transaction(async () => {
      const lockClause = this.database.dialect === "postgres" ? " FOR UPDATE" : "";
      const noticeRow = await this.database.prepare(
        `SELECT * FROM account_deletion_completion_outbox
          WHERE provider_message_id = @providerMessageId${lockClause}`,
      ).get<RawAccountDeletionCompletionOutboxRow>({ providerMessageId });
      if (!noticeRow) return { duplicate: false, matched: false, requestId: null };
      const notice = toOutbox(noticeRow);
      const inserted = await this.database.prepare(
        `INSERT INTO account_deletion_notification_events (
           event_id, request_id, provider_message_id, event_type,
           event_created_at, received_at, payload_sha256
         ) VALUES (
           @eventId, @requestId, @providerMessageId, @eventType,
           @eventCreatedAt, @receivedAt, @payloadSha256
         ) ON CONFLICT(event_id) DO NOTHING`,
      ).run({
        eventId,
        requestId: notice.request_id,
        providerMessageId,
        eventType,
        eventCreatedAt: input.eventCreatedAt,
        receivedAt: input.receivedAt,
        payloadSha256: input.payloadSha256,
      });
      if (inserted.changes === 0) {
        const existing = await this.database.prepare(
          `SELECT request_id, provider_message_id, event_type, event_created_at, payload_sha256
             FROM account_deletion_notification_events WHERE event_id = @eventId`,
        ).get<{
          request_id: string;
          provider_message_id: string;
          event_type: string;
          event_created_at: string;
          payload_sha256: string;
        }>({ eventId });
        if (
          !existing
          || existing.request_id !== notice.request_id
          || existing.provider_message_id !== providerMessageId
          || existing.event_type !== eventType
          || existing.event_created_at !== input.eventCreatedAt
          || existing.payload_sha256 !== input.payloadSha256
        ) throw new AccountDeletionQueueRepositoryError("provider_event_identity_conflict");
        return { duplicate: true, matched: true, requestId: notice.request_id };
      }
      if (notice.provider_event_at && input.eventCreatedAt < notice.provider_event_at) {
        return { duplicate: false, matched: true, requestId: notice.request_id };
      }

      if (input.outcome === "delivered") {
        await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET status = 'delivered', provider_last_event = @eventType,
                  provider_event_at = @eventCreatedAt,
                  delivered_at = COALESCE(delivered_at, @eventCreatedAt),
                  terminal_at = COALESCE(terminal_at, @eventCreatedAt), next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
                  secret_purge_checkpoint_pending = @truth,
                  secret_purge_generation = secret_purge_generation + 1, updated_at = @receivedAt
            WHERE request_id = @requestId
              AND status NOT IN ('cancelled', 'suppressed_restore')
              AND (status <> 'purged' OR completed_at IS NOT NULL)`,
        ).run({
          requestId: notice.request_id,
          eventType,
          eventCreatedAt: input.eventCreatedAt,
          receivedAt: input.receivedAt,
          truth: this.checkpointBoolean(true),
        });
        await this.database.prepare(
          "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
        ).run({ requestId: notice.request_id });
      } else if (input.outcome === "failed") {
        await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET status = 'manual_review', provider_last_event = @eventType,
                  provider_event_at = @eventCreatedAt, next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  last_error = 'Provider reported that the completion notice was not delivered.',
                  updated_at = @receivedAt
            WHERE request_id = @requestId
              AND status NOT IN ('delivered', 'cancelled', 'suppressed_restore', 'purged')
              AND NOT (status = 'failed' AND provider_last_event = 'operator_resolved_undeliverable')`,
        ).run({ requestId: notice.request_id, eventType, eventCreatedAt: input.eventCreatedAt, receivedAt: input.receivedAt });
      } else {
        const nextCheckAt = new Date(new Date(input.receivedAt).getTime() + 15 * 60_000).toISOString();
        await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET status = 'accepted', provider_last_event = @eventType,
                  provider_event_at = @eventCreatedAt, next_attempt_at = @nextCheckAt,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = @receivedAt
            WHERE request_id = @requestId AND status IN ('sending', 'accepted')`,
        ).run({ requestId: notice.request_id, eventType, eventCreatedAt: input.eventCreatedAt, nextCheckAt, receivedAt: input.receivedAt });
      }
      return { duplicate: false, matched: true, requestId: notice.request_id };
    })();
  }

  /** Purges at most ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT rows; callers drain by reinvoking. */
  async purgeExpiredAccountDeletionNotificationRecipients(now: string): Promise<number> {
    requireCanonicalUtc(now);
    return this.database.transaction(async () => {
      const lockClause = this.database.dialect === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";
      const rows = await this.database.prepare(
        `SELECT request_id FROM account_deletion_notice_recipient_secrets
          WHERE purge_after <= @now
          ORDER BY purge_after, request_id
          LIMIT @batchLimit${lockClause}`,
      ).all<{ request_id: string }>({
        now,
        batchLimit: ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT,
      });
      for (const row of rows) {
        await this.database.prepare(
          "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
        ).run({ requestId: row.request_id });
        await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET status = CASE WHEN status IN ('delivered', 'failed', 'cancelled', 'suppressed_restore')
                                THEN status ELSE 'purged' END,
                  terminal_at = COALESCE(terminal_at, @now), next_attempt_at = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  last_error = CASE WHEN status IN ('delivered', 'failed', 'cancelled', 'suppressed_restore')
                                    THEN last_error
                                    ELSE 'Encrypted notification recipient reached its retention limit.' END,
                  secret_purge_checkpoint_pending = @truth,
                  secret_purge_generation = secret_purge_generation + 1, updated_at = @now
            WHERE request_id = @requestId`,
        ).run({ requestId: row.request_id, now, truth: this.checkpointBoolean(true) });
      }
      return rows.length;
    })();
  }

  async getAccountDeletionNotificationQueueSummary(
    now: string,
  ): Promise<AccountDeletionNotificationQueueSummary> {
    requireCanonicalUtc(now);
    const truth = this.database.dialect === "postgres" ? "TRUE" : "1";
    const row = await this.database.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END), 0) AS pending_count,
         COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count,
         COALESCE(SUM(CASE WHEN status IN ('manual_review', 'purged')
                                OR (status = 'failed' AND COALESCE(provider_last_event, '') <> 'operator_resolved_undeliverable')
                           THEN 1 ELSE 0 END), 0) AS manual_review_count,
         (SELECT COUNT(*) FROM account_deletion_notice_recipient_secrets recipient
           WHERE recipient.purge_after <= @now) AS overdue_retention_count,
         COALESCE(SUM(CASE WHEN secret_purge_checkpoint_pending = ${truth} THEN 1 ELSE 0 END), 0)
           AS secure_purge_checkpoint_pending_count,
         MIN(CASE WHEN secret_purge_checkpoint_pending = ${truth} THEN updated_at ELSE NULL END)
           AS oldest_secure_purge_checkpoint_at,
         MIN(CASE WHEN status IN ('pending', 'sending', 'accepted') THEN completed_at ELSE NULL END)
           AS oldest_pending_at
       FROM account_deletion_completion_outbox`,
    ).get<{
      pending_count: number | string;
      accepted_count: number | string;
      manual_review_count: number | string;
      overdue_retention_count: number | string;
      secure_purge_checkpoint_pending_count: number | string;
      oldest_secure_purge_checkpoint_at: string | null;
      oldest_pending_at: string | null;
    }>({ now });
    return {
      pendingCount: safeDatabaseInteger(row?.pending_count ?? 0),
      acceptedCount: safeDatabaseInteger(row?.accepted_count ?? 0),
      manualReviewCount: safeDatabaseInteger(row?.manual_review_count ?? 0),
      overdueRetentionCount: safeDatabaseInteger(row?.overdue_retention_count ?? 0),
      securePurgeCheckpointPendingCount: safeDatabaseInteger(row?.secure_purge_checkpoint_pending_count ?? 0),
      oldestSecurePurgeCheckpointAt: row?.oldest_secure_purge_checkpoint_at ?? null,
      oldestPendingAt: row?.oldest_pending_at ?? null,
    };
  }

  async captureAccountDeletionNotificationSecretPurgeCheckpoint(): Promise<
    AccountDeletionSecretPurgeCheckpointEntry[]
  > {
    const truth = this.database.dialect === "postgres" ? "TRUE" : "1";
    const rows = await this.database.prepare(
      `SELECT request_id AS "requestId", secret_purge_generation AS "generation"
         FROM account_deletion_completion_outbox
        WHERE secret_purge_checkpoint_pending = ${truth}
        ORDER BY request_id`,
    ).all<{ requestId: string; generation: number | string }>();
    return rows.map((row) => ({ requestId: row.requestId, generation: safeDatabaseInteger(row.generation) }));
  }

  async acknowledgeAccountDeletionNotificationSecretPurgeCheckpoint(
    snapshot: readonly AccountDeletionSecretPurgeCheckpointEntry[],
  ): Promise<number> {
    if (snapshot.length > 100_000) invalidInput();
    const normalized = snapshot.map((entry) => ({
      requestId: requireIdentifier(entry.requestId),
      generation: requireSafeNonNegativeInteger(entry.generation),
    }));
    const truth = this.checkpointBoolean(true);
    const falsity = this.checkpointBoolean(false);
    return this.database.transaction(async () => {
      let cleared = 0;
      for (const entry of normalized) {
        const result = await this.database.prepare(
          `UPDATE account_deletion_completion_outbox
              SET secret_purge_checkpoint_pending = @falsity
            WHERE request_id = @requestId
              AND secret_purge_checkpoint_pending = @truth
              AND secret_purge_generation = @generation
              AND NOT EXISTS (
                SELECT 1
                  FROM account_deletion_notice_recipient_secrets recipient
                 WHERE recipient.request_id = @requestId
              )`,
        ).run({ ...entry, truth, falsity });
        cleared += result.changes;
      }
      return cleared;
    })();
  }

  /** The physical checkpoint callback runs after capture and before the short guarded acknowledgement. */
  async checkpointAccountDeletionNotificationSecrets(
    performPhysicalCheckpoint: (
      snapshot: readonly AccountDeletionSecretPurgeCheckpointEntry[],
    ) => Promise<boolean>,
  ): Promise<boolean> {
    const snapshot = await this.captureAccountDeletionNotificationSecretPurgeCheckpoint();
    if (snapshot.length === 0) return true;
    try {
      if (!await performPhysicalCheckpoint(snapshot)) return false;
    } catch {
      return false;
    }
    const acknowledged = await this.acknowledgeAccountDeletionNotificationSecretPurgeCheckpoint(snapshot);
    return acknowledged === snapshot.length;
  }

  async markAccountDeletionIdentityDeleted(input: {
    requestId: string;
    attemptCount: number;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const attemptCount = requireSafeNonNegativeInteger(input.attemptCount);
    const now = requireCanonicalUtc(input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId)) return false;
      const result = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET identity_deleted_at = COALESCE(identity_deleted_at, @now), updated_at = @now
          WHERE id = @requestId AND status = 'processing' AND attempt_count = @attemptCount`,
      ).run({ requestId, attemptCount, now });
      return result.changes === 1;
    })();
  }

  async markAccountDeletionStripeCustomerDeleted(input: {
    requestId: string;
    userId: string;
    stripeCustomerId: string;
    attemptCount: number;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const userId = requireIdentifier(input.userId);
    const stripeCustomerId = requireIdentifier(input.stripeCustomerId);
    const attemptCount = requireSafeNonNegativeInteger(input.attemptCount);
    const now = requireCanonicalUtc(input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId, userId)) return false;
      const receipt = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET stripe_customer_deleted_at = COALESCE(stripe_customer_deleted_at, @now),
                stripe_customer_id_snapshot = COALESCE(stripe_customer_id_snapshot, @stripeCustomerId),
                updated_at = @now
          WHERE id = @requestId AND user_id = @userId AND status = 'processing'
            AND attempt_count = @attemptCount
            AND (stripe_customer_id_snapshot IS NULL OR stripe_customer_id_snapshot = @stripeCustomerId)`,
      ).run({ requestId, userId, stripeCustomerId, attemptCount, now });
      if (receipt.changes !== 1) return false;
      const stripePredicate = this.database.dialect === "postgres"
        ? "payload_json #>> '{data,object,customer}' = @stripeCustomerId"
        : "json_valid(payload_json) AND json_extract(payload_json, '$.data.object.customer') = @stripeCustomerId";
      await this.database.prepare(
        `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
          WHERE payload_json IS NOT NULL AND ${stripePredicate}`,
      ).run({ stripeCustomerId });
      await this.database.prepare(
        `UPDATE accounts
            SET subscription_status = 'free', stripe_paid_subscription_status = NULL,
                stripe_customer_id = NULL, stripe_event_created_at = NULL,
                premium_until = NULL, updated_at = @now
          WHERE id = @userId`,
      ).run({ userId, now });
      return true;
    })();
  }

  async markAccountDeletionTombstoneRecorded(input: {
    requestId: string;
    attemptCount: number;
    recordedAt: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const attemptCount = requireSafeNonNegativeInteger(input.attemptCount);
    const recordedAt = requireCanonicalUtc(input.recordedAt);
    const now = requireCanonicalUtc(input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId)) return false;
      const result = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET deletion_tombstone_recorded_at = COALESCE(deletion_tombstone_recorded_at, @recordedAt),
                updated_at = @now
          WHERE id = @requestId AND status = 'processing' AND attempt_count = @attemptCount`,
      ).run({ requestId, attemptCount, recordedAt, now });
      return result.changes === 1;
    })();
  }

  async failAccountDeletion(input: {
    requestId: string;
    attemptCount: number;
    error: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const attemptCount = requireSafeNonNegativeInteger(input.attemptCount);
    const redactedError = sanitizeError(input.error);
    const now = requireCanonicalUtc(input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId)) return false;
      const result = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET status = 'failed', last_error = @redactedError, updated_at = @now
          WHERE id = @requestId AND status = 'processing' AND attempt_count = @attemptCount`,
      ).run({ requestId, attemptCount, redactedError, now });
      return result.changes === 1;
    })();
  }

  async cancelAccountDeletion(input: {
    requestId: string;
    userId: string;
    now: string;
  }): Promise<boolean> {
    const requestId = requireIdentifier(input.requestId);
    const userId = requireIdentifier(input.userId);
    const now = requireCanonicalUtc(input.now);
    return this.database.transaction(async () => {
      if (!await this.lockDeletionRequest(requestId, userId)) return false;
      const result = await this.database.prepare(
        `UPDATE account_deletion_requests
            SET status = 'cancelled', updated_at = @now
          WHERE id = @requestId AND user_id = @userId
            AND identity_deleted_at IS NULL
            AND stripe_customer_deleted_at IS NULL
            AND deletion_tombstone_recorded_at IS NULL
            AND status IN ('pending_review', 'approved', 'failed')`,
      ).run({ requestId, userId, now });
      if (result.changes !== 1) return false;
      await this.database.prepare(
        `UPDATE account_deletion_completion_outbox
            SET status = 'cancelled', terminal_at = @now, next_attempt_at = NULL,
                lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
                secret_purge_checkpoint_pending = @truth,
                secret_purge_generation = secret_purge_generation + 1, updated_at = @now
          WHERE request_id = @requestId AND status = 'held'`,
      ).run({ requestId, now, truth: this.checkpointBoolean(true) });
      await this.database.prepare(
        "DELETE FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
      ).run({ requestId });
      return true;
    })();
  }
}
