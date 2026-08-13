import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AccountDeletionQueueRepository,
  type AccountDeletionCompletionOutboxRow,
  type AccountDeletionNoticeRecipientSecretRow,
  type AccountDeletionRequestRow,
} from "../db/account-deletion-queue.repository.js";
import {
  ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
  ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
  AccountPrivacyRepository,
} from "../db/account-privacy.repository.js";
import { AccountSessionRepository } from "../db/account-session.repository.js";
import type { SqlDatabase } from "../db/sql-database.js";
import {
  createPostgresAccountDeletionSecretPhysicalCheckpoint,
  type AccountDeletionSecretPhysicalCheckpoint,
} from "./account-deletion-secret-checkpoint.js";
import {
  type AccountDeletionTombstone,
  normalizeTombstones,
  parseAccountDeletionTombstones,
} from "./data-backup.js";
import {
  type AccountDeletionLedgerCheckpoint,
  type VerifiedAccountDeletionLedger,
} from "./offsite-backup.js";
import {
  encryptAccountDeletionDestination,
  type AccountDeletionNotificationProvider,
} from "./account-deletion-notification.js";
import { inspectPostgresLogicalRuntimeDatabaseIdentity } from "./postgres-logical-offsite.js";
import {
  canonicalPostgresLogicalStateJson,
  parsePostgresLogicalSourceStateReceipt,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalSourceStateReceipt,
} from "./postgres-logical-state.js";

export const POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND =
  "pintpath-postgres-account-deletion-recovery-fixture" as const;
export const POSTGRES_ACCOUNT_DELETION_RECOVERY_COMPLETION_KIND =
  "pintpath-postgres-account-deletion-recovery-fixture-completion" as const;
export const POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION = 1 as const;
export const POSTGRES_ACCOUNT_DELETION_RECOVERY_AUTHORITY_FILES = Object.freeze([
  "checkpoint.json",
  "current.json",
  "genesis.json",
] as const);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIXTURE_ID_PREFIX = "recovery-proof-";
const REQUEST_ID_PREFIX = "recovery-proof-delete-";
const FIXTURE_EMAIL_DOMAIN = "pintpath.invalid";
const TEMPLATE_VERSION = "account-deletion-complete-v1";
const KEY_ID = "recovery-proof-ephemeral-aes-gcm-v1";
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const TOMBSTONE_LEDGER_PREFIX = "_control/account-deletion-ledger/v1";
const TOMBSTONE_LEDGER_GENESIS_PATH = "_control/account-deletion-ledger-genesis.json";
const CURRENT_TOMBSTONE_LEDGER_PATH = "_control/account-deletion-tombstones.json";

const BACKUP_BOUND_TABLES = Object.freeze([
  "accounts",
  "profiles",
  "auth_sessions",
  "account_deletion_requests",
  "account_deletion_completion_outbox",
  "account_deletion_notice_recipient_secrets",
  "account_deletion_notification_events",
  "source_evidence_objects",
] as const);

export type PostgresAccountDeletionRecoveryFixtureFailureCode =
  | "invalid_input"
  | "postgres_required"
  | "database_identity_unavailable"
  | "database_identity_mismatch"
  | "unsafe_receipt_file"
  | "receipt_invalid"
  | "receipt_hash_mismatch"
  | "receipt_write_failed"
  | "logical_backup_receipt_invalid"
  | "logical_backup_not_after_prepare"
  | "logical_backup_state_mismatch"
  | "fixture_state_conflict"
  | "checkpoint_backlog_present"
  | "tombstone_verification_failed"
  | "authority_directory_unsafe"
  | "tombstone_mark_failed"
  | "anonymisation_failed"
  | "physical_checkpoint_failed"
  | "provider_call_forbidden";

const ERROR_MESSAGES: Readonly<Record<PostgresAccountDeletionRecoveryFixtureFailureCode, string>> = {
  invalid_input: "The account-deletion recovery proof input is invalid.",
  postgres_required: "The account-deletion recovery proof requires PostgreSQL.",
  database_identity_unavailable: "The PostgreSQL database identity could not be verified.",
  database_identity_mismatch: "The PostgreSQL database does not match the fixture authority.",
  unsafe_receipt_file: "The account-deletion recovery proof receipt is unsafe.",
  receipt_invalid: "The account-deletion recovery proof receipt is invalid.",
  receipt_hash_mismatch: "The account-deletion recovery proof receipt hash does not match.",
  receipt_write_failed: "The account-deletion recovery proof receipt could not be sealed.",
  logical_backup_receipt_invalid: "The logical-backup state receipt is invalid.",
  logical_backup_not_after_prepare: "The logical backup does not follow fixture preparation.",
  logical_backup_state_mismatch: "The logical backup does not contain the prepared fixture state.",
  fixture_state_conflict: "The account-deletion recovery fixture conflicts with durable state.",
  checkpoint_backlog_present: "An unrelated deletion-secret checkpoint backlog is present.",
  tombstone_verification_failed: "The account-deletion tombstone authority was not durably verified.",
  authority_directory_unsafe: "The account-deletion ledger authority directory is unsafe.",
  tombstone_mark_failed: "The verified account-deletion tombstone could not be recorded locally.",
  anonymisation_failed: "The synthetic account could not be anonymised safely.",
  physical_checkpoint_failed: "The deletion-recipient purge did not pass its physical checkpoint.",
  provider_call_forbidden: "A provider call is forbidden during the synthetic recovery proof.",
};

/** Stable, secret-free operator failure. Raw SQL, provider and filesystem errors never escape. */
export class PostgresAccountDeletionRecoveryFixtureError extends Error {
  constructor(readonly code: PostgresAccountDeletionRecoveryFixtureFailureCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PostgresAccountDeletionRecoveryFixtureError";
  }
}

export interface PostgresAccountDeletionRecoveryFixtureCounts {
  readonly account: string;
  readonly profile: string;
  readonly session: string;
  readonly deletionRequest: string;
  readonly completionOutbox: string;
  readonly recipientSecret: string;
  readonly notificationEvent: string;
  readonly sourceEvidence: string;
  readonly sendEligibleOutbox: string;
  readonly pendingSecretCheckpoint: string;
}

export interface PostgresAccountDeletionRecoveryFixtureSemanticState {
  readonly phase: "prepared" | "completed";
  readonly account: {
    readonly emailSha256: string;
    readonly publicAccountId: string;
    readonly authProvider: string;
    readonly supabaseUserId: string | null;
    readonly stripeCustomerId: string | null;
    readonly subscriptionStatus: string;
    readonly status: string;
  };
  readonly profile: {
    readonly emailSha256: string;
    readonly publicAccountId: string;
    readonly accountStatus: string;
  };
  readonly request: {
    readonly status: AccountDeletionRequestRow["status"];
    readonly attemptCount: number;
    readonly requestedAt: string;
    readonly executeAfter: string;
    readonly processingStartedAt: string | null;
    readonly completedAt: string | null;
    readonly identityDeletedAt: string | null;
    readonly stripeCustomerDeletedAt: string | null;
    readonly stripeCustomerIdSnapshot: string | null;
    readonly deletionTombstoneRecordedAt: string | null;
    readonly userMessagePresent: boolean;
    readonly lastErrorPresent: boolean;
    readonly resultSummarySha256: string | null;
  };
  readonly outbox: {
    readonly status: AccountDeletionCompletionOutboxRow["status"];
    readonly attemptCount: number;
    readonly templateVersion: string;
    readonly idempotencyKeySha256: string;
    readonly payloadFingerprint: string | null;
    readonly providerMessageId: string | null;
    readonly providerLastEvent: string | null;
    readonly providerEventAt: string | null;
    readonly nextAttemptAt: string | null;
    readonly leaseTokenPresent: boolean;
    readonly leaseExpiresAt: string | null;
    readonly acceptedAt: string | null;
    readonly deliveredAt: string | null;
    readonly terminalAt: string | null;
    readonly secretPurgeCheckpointPending: boolean;
    readonly secretPurgeGeneration: number;
  };
  readonly recipientSecret: {
    readonly keyId: string | null;
    readonly nonceSha256: string | null;
    readonly ciphertextSha256: string | null;
    readonly authTagSha256: string | null;
    readonly purgeAfter: string | null;
  };
  readonly sessionTokenHashSha256: string | null;
  readonly counts: PostgresAccountDeletionRecoveryFixtureCounts;
}

export interface PostgresAccountDeletionRecoveryFixtureReceipt {
  readonly kind: typeof POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND;
  readonly version: typeof POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION;
  readonly fixtureId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly preparedAt: string;
  readonly databaseIdentitySha256: string;
  readonly preparedState: PostgresAccountDeletionRecoveryFixtureSemanticState;
  readonly preparedStateSha256: string;
  readonly backupRowCounts: readonly {
    readonly tableName: typeof BACKUP_BOUND_TABLES[number];
    readonly rowCount: string;
  }[];
}

export interface PostgresAccountDeletionRecoveryFixtureCompletionReceipt {
  readonly kind: typeof POSTGRES_ACCOUNT_DELETION_RECOVERY_COMPLETION_KIND;
  readonly version: typeof POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION;
  readonly completedAt: string;
  readonly fixtureReceiptSha256: string;
  readonly logicalBackupStateReceiptSha256: string;
  readonly databaseIdentitySha256: string;
  readonly tombstoneSha256: string;
  readonly ledgerAuthoritySha256: string;
  readonly ledgerCurrentSha256: string;
  readonly ledgerGenesisSha256: string;
  readonly ledgerCheckpointSha256: string;
  readonly ledgerImmutableSetSha256: string;
  readonly ledgerTombstoneCount: number;
  readonly completedStateSha256: string;
  readonly providerCallCount: 0;
}

export interface PostgresAccountDeletionRecoveryInspection {
  readonly receipt: PostgresAccountDeletionRecoveryFixtureReceipt;
  readonly receiptSha256: string;
  readonly databaseIdentitySha256: string;
  readonly state: PostgresAccountDeletionRecoveryFixtureSemanticState;
  readonly stateSha256: string;
}

export interface PreparePostgresAccountDeletionRecoveryFixtureOptions {
  readonly database: SqlDatabase;
  readonly receiptFile: string;
  /** Externally reviewed target pin; the CLI requires it before any mutation. */
  readonly expectedDatabaseIdentitySha256?: string | undefined;
  readonly fixtureId?: string | undefined;
  readonly preparedAt?: string | undefined;
  readonly inspectDatabaseIdentity?: ((database: SqlDatabase) => Promise<string>) | undefined;
}

export interface InspectPostgresAccountDeletionRecoveryFixtureOptions {
  readonly database: SqlDatabase;
  readonly receiptFile: string;
  readonly expectedReceiptSha256: string;
  readonly inspectDatabaseIdentity?: ((database: SqlDatabase) => Promise<string>) | undefined;
}

export type VerifiedAccountDeletionTombstoneAppend = (
  tombstone: AccountDeletionTombstone,
) => Promise<VerifiedAccountDeletionLedger>;

export interface CompletePostgresAccountDeletionRecoveryFixtureOptions {
  readonly database: SqlDatabase;
  readonly receiptFile: string;
  readonly expectedReceiptSha256: string;
  readonly logicalBackupStateReceiptFile: string;
  readonly expectedLogicalBackupStateReceiptSha256: string;
  readonly ledgerAuthorityDirectory: string;
  readonly completionReceiptFile: string;
  readonly completedAt: string;
  readonly appendAndVerifyTombstone: VerifiedAccountDeletionTombstoneAppend;
  readonly physicalCheckpoint?: AccountDeletionSecretPhysicalCheckpoint | undefined;
  readonly inspectDatabaseIdentity?: ((database: SqlDatabase) => Promise<string>) | undefined;
}

export interface PreparedPostgresAccountDeletionRecoveryFixture {
  readonly receipt: PostgresAccountDeletionRecoveryFixtureReceipt;
  readonly receiptSha256: string;
  readonly stateSha256: string;
  readonly databaseIdentitySha256: string;
}

export interface CompletedPostgresAccountDeletionRecoveryFixture {
  readonly receipt: PostgresAccountDeletionRecoveryFixtureCompletionReceipt;
  readonly receiptSha256: string;
  readonly stateSha256: string;
  readonly databaseIdentitySha256: string;
  readonly ledgerAuthoritySha256: string;
}

interface AccountRow {
  readonly publicAccountId: string;
  readonly email: string;
  readonly authProvider: string;
  readonly supabaseUserId: string | null;
  readonly stripeCustomerId: string | null;
  readonly subscriptionStatus: string;
  readonly status: string;
}

interface ProfileRow {
  readonly publicAccountId: string;
  readonly email: string;
  readonly accountStatus: string;
}

interface CountRow {
  readonly count: number | string;
}

interface SessionRow {
  readonly tokenHash: string;
}

interface LedgerGenesis {
  readonly version: 1;
  readonly kind: "pint-path-account-deletion-ledger-genesis";
  readonly createdAt: string;
  readonly immutablePrefix: string;
  readonly currentLedgerPath: string;
}

interface ValidatedLedgerAuthority {
  readonly currentBytes: Buffer;
  readonly genesisBytes: Buffer;
  readonly checkpointBytes: Buffer;
  readonly currentSha256: string;
  readonly genesisSha256: string;
  readonly checkpointSha256: string;
  readonly immutableSetSha256: string;
  readonly tombstoneCount: number;
  readonly authoritySha256: string;
  readonly tombstoneSha256: string;
}

function fixtureError(code: PostgresAccountDeletionRecoveryFixtureFailureCode): PostgresAccountDeletionRecoveryFixtureError {
  return new PostgresAccountDeletionRecoveryFixtureError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function canonicalUtc(value: string): string {
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      throw new Error("invalid");
    }
    return value;
  } catch {
    throw fixtureError("invalid_input");
  }
}

function exactSha256(value: string, code: PostgresAccountDeletionRecoveryFixtureFailureCode): string {
  if (!SHA256_PATTERN.test(value)) throw fixtureError(code);
  return value;
}

function exactCount(value: number | string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw fixtureError("fixture_state_conflict");
  return BigInt(text).toString();
}

function fixtureIdentity(fixtureIdInput?: string): { fixtureId: string; userId: string; requestId: string; email: string } {
  const fixtureId = (fixtureIdInput ?? crypto.randomUUID()).toLowerCase();
  if (!UUID_PATTERN.test(fixtureId)) throw fixtureError("invalid_input");
  const userId = `${FIXTURE_ID_PREFIX}${fixtureId}`;
  return {
    fixtureId,
    userId,
    requestId: `${REQUEST_ID_PREFIX}${fixtureId}`,
    email: `${userId}@${FIXTURE_EMAIL_DOMAIN}`,
  };
}

function asBuffer(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw fixtureError("fixture_state_conflict");
  }
}

function semanticSha256(state: PostgresAccountDeletionRecoveryFixtureSemanticState): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-account-deletion-recovery-semantic-state",
    version: 1,
    ...state,
  });
}

function tombstoneSha256(tombstone: AccountDeletionTombstone): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-account-deletion-tombstone",
    version: 1,
    requestId: tombstone.requestId,
    userId: tombstone.userId,
    completedAt: tombstone.completedAt,
  });
}

async function count(
  database: SqlDatabase,
  sql: string,
  bindings: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const row = await database.prepare(sql).get<CountRow>(bindings);
  return exactCount(row?.count ?? "0");
}

async function backupRowCounts(
  database: SqlDatabase,
): Promise<PostgresAccountDeletionRecoveryFixtureReceipt["backupRowCounts"]> {
  const rows: Array<{ tableName: typeof BACKUP_BOUND_TABLES[number]; rowCount: string }> = [];
  for (const tableName of BACKUP_BOUND_TABLES) {
    rows.push({
      tableName,
      rowCount: await count(database, `SELECT count(*) AS count FROM ${tableName}`),
    });
  }
  return rows;
}

async function pendingCheckpointRequestIds(database: SqlDatabase): Promise<string[]> {
  const rows = await database.prepare(
    `SELECT request_id AS "requestId"
       FROM account_deletion_completion_outbox
      WHERE secret_purge_checkpoint_pending = TRUE
      ORDER BY request_id`,
  ).all<{ requestId: string }>();
  return rows.map((row) => row.requestId);
}

async function readFixtureState(
  database: SqlDatabase,
  receipt: Pick<PostgresAccountDeletionRecoveryFixtureReceipt, "userId" | "requestId">,
): Promise<PostgresAccountDeletionRecoveryFixtureSemanticState> {
  const account = await database.prepare(
    `SELECT public_account_id AS "publicAccountId", email,
            auth_provider AS "authProvider", supabase_user_id AS "supabaseUserId",
            stripe_customer_id AS "stripeCustomerId",
            subscription_status AS "subscriptionStatus", status
       FROM accounts WHERE id = @userId`,
  ).get<AccountRow>({ userId: receipt.userId });
  const profile = await database.prepare(
    `SELECT public_account_id AS "publicAccountId", email,
            account_status AS "accountStatus"
       FROM profiles WHERE id = @userId`,
  ).get<ProfileRow>({ userId: receipt.userId });
  const request = await new AccountDeletionQueueRepository(database)
    .getAccountDeletionRequestById(receipt.requestId);
  const outbox = await new AccountDeletionQueueRepository(database)
    .getAccountDeletionCompletionOutbox(receipt.requestId);
  const recipient = await new AccountDeletionQueueRepository(database)
    .getAccountDeletionNoticeRecipientSecret(receipt.requestId);
  const sessions = await database.prepare(
    `SELECT token_hash AS "tokenHash" FROM auth_sessions
      WHERE user_id = @userId ORDER BY token_hash`,
  ).all<SessionRow>({ userId: receipt.userId });

  if (!account || !profile || !request || !outbox) throw fixtureError("fixture_state_conflict");
  const phase = request.status === "processing" ? "prepared"
    : request.status === "completed" ? "completed"
      : null;
  if (!phase) throw fixtureError("fixture_state_conflict");

  const counts: PostgresAccountDeletionRecoveryFixtureCounts = {
    account: await count(database, "SELECT count(*) AS count FROM accounts WHERE id = @userId", receipt),
    profile: await count(database, "SELECT count(*) AS count FROM profiles WHERE id = @userId", receipt),
    session: exactCount(sessions.length),
    deletionRequest: await count(
      database,
      "SELECT count(*) AS count FROM account_deletion_requests WHERE id = @requestId AND user_id = @userId",
      receipt,
    ),
    completionOutbox: await count(
      database,
      "SELECT count(*) AS count FROM account_deletion_completion_outbox WHERE request_id = @requestId",
      receipt,
    ),
    recipientSecret: await count(
      database,
      "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
      receipt,
    ),
    notificationEvent: await count(
      database,
      "SELECT count(*) AS count FROM account_deletion_notification_events WHERE request_id = @requestId",
      receipt,
    ),
    sourceEvidence: await count(
      database,
      "SELECT count(*) AS count FROM source_evidence_objects WHERE owner_user_id = @userId",
      receipt,
    ),
    sendEligibleOutbox: await count(
      database,
      `SELECT count(*) AS count FROM account_deletion_completion_outbox
        WHERE request_id = @requestId AND status IN ('pending', 'sending', 'accepted')`,
      receipt,
    ),
    pendingSecretCheckpoint: await count(
      database,
      `SELECT count(*) AS count FROM account_deletion_completion_outbox
        WHERE request_id = @requestId AND secret_purge_checkpoint_pending = TRUE`,
      receipt,
    ),
  };

  return {
    phase,
    account: {
      emailSha256: sha256(account.email.trim().toLowerCase()),
      publicAccountId: account.publicAccountId,
      authProvider: account.authProvider,
      supabaseUserId: account.supabaseUserId,
      stripeCustomerId: account.stripeCustomerId,
      subscriptionStatus: account.subscriptionStatus,
      status: account.status,
    },
    profile: {
      emailSha256: sha256(profile.email.trim().toLowerCase()),
      publicAccountId: profile.publicAccountId,
      accountStatus: profile.accountStatus,
    },
    request: {
      status: request.status,
      attemptCount: request.attempt_count,
      requestedAt: request.requested_at,
      executeAfter: request.execute_after,
      processingStartedAt: request.processing_started_at,
      completedAt: request.completed_at,
      identityDeletedAt: request.identity_deleted_at,
      stripeCustomerDeletedAt: request.stripe_customer_deleted_at,
      stripeCustomerIdSnapshot: request.stripe_customer_id_snapshot,
      deletionTombstoneRecordedAt: request.deletion_tombstone_recorded_at,
      userMessagePresent: request.user_message !== null,
      lastErrorPresent: request.last_error !== null,
      resultSummarySha256: request.result_summary_json === null
        ? null
        : sha256CanonicalPostgresLogicalState(JSON.parse(request.result_summary_json) as unknown),
    },
    outbox: {
      status: outbox.status,
      attemptCount: outbox.attempt_count,
      templateVersion: outbox.template_version,
      idempotencyKeySha256: sha256(outbox.idempotency_key),
      payloadFingerprint: outbox.payload_fingerprint,
      providerMessageId: outbox.provider_message_id,
      providerLastEvent: outbox.provider_last_event,
      providerEventAt: outbox.provider_event_at,
      nextAttemptAt: outbox.next_attempt_at,
      leaseTokenPresent: outbox.lease_token !== null,
      leaseExpiresAt: outbox.lease_expires_at,
      acceptedAt: outbox.accepted_at,
      deliveredAt: outbox.delivered_at,
      terminalAt: outbox.terminal_at,
      secretPurgeCheckpointPending: outbox.secret_purge_checkpoint_pending,
      secretPurgeGeneration: outbox.secret_purge_generation,
    },
    recipientSecret: recipientState(recipient),
    sessionTokenHashSha256: sessions.length === 1 ? sha256(sessions[0]!.tokenHash) : null,
    counts,
  };
}

function recipientState(recipient: AccountDeletionNoticeRecipientSecretRow | null):
PostgresAccountDeletionRecoveryFixtureSemanticState["recipientSecret"] {
  return recipient ? {
    keyId: recipient.key_id,
    nonceSha256: sha256(recipient.nonce),
    ciphertextSha256: sha256(recipient.ciphertext),
    authTagSha256: sha256(recipient.auth_tag),
    purgeAfter: recipient.purge_after,
  } : {
    keyId: null,
    nonceSha256: null,
    ciphertextSha256: null,
    authTagSha256: null,
    purgeAfter: null,
  };
}

function validSemanticState(value: unknown): value is PostgresAccountDeletionRecoveryFixtureSemanticState {
  if (
    !isPlainObject(value)
    || !exactKeys(value, [
      "phase", "account", "profile", "request", "outbox", "recipientSecret",
      "sessionTokenHashSha256", "counts",
    ])
    || !["prepared", "completed"].includes(String(value.phase))
    || !isPlainObject(value.account)
    || !exactKeys(value.account, [
      "emailSha256", "publicAccountId", "authProvider", "supabaseUserId",
      "stripeCustomerId", "subscriptionStatus", "status",
    ])
    || !SHA256_PATTERN.test(String(value.account.emailSha256))
    || ![value.account.publicAccountId, value.account.authProvider,
      value.account.subscriptionStatus, value.account.status].every((entry) => (
      typeof entry === "string" && entry.length > 0 && entry.length <= 255
    ))
    || ![value.account.supabaseUserId, value.account.stripeCustomerId].every((entry) => (
      entry === null || (typeof entry === "string" && entry.length > 0 && entry.length <= 255)
    ))
    || !isPlainObject(value.profile)
    || !exactKeys(value.profile, ["emailSha256", "publicAccountId", "accountStatus"])
    || !SHA256_PATTERN.test(String(value.profile.emailSha256))
    || ![value.profile.publicAccountId, value.profile.accountStatus].every((entry) => (
      typeof entry === "string" && entry.length > 0 && entry.length <= 255
    ))
    || !isPlainObject(value.request)
    || !exactKeys(value.request, [
      "status", "attemptCount", "requestedAt", "executeAfter", "processingStartedAt",
      "completedAt", "identityDeletedAt", "stripeCustomerDeletedAt",
      "stripeCustomerIdSnapshot", "deletionTombstoneRecordedAt", "userMessagePresent",
      "lastErrorPresent", "resultSummarySha256",
    ])
    || !["processing", "completed"].includes(String(value.request.status))
    || !Number.isSafeInteger(value.request.attemptCount)
    || Number(value.request.attemptCount) < 1
    || !isCanonicalUtc(value.request.requestedAt)
    || !isCanonicalUtc(value.request.executeAfter)
    || ![value.request.processingStartedAt, value.request.completedAt,
      value.request.identityDeletedAt, value.request.stripeCustomerDeletedAt,
      value.request.deletionTombstoneRecordedAt].every((entry) => (
      entry === null || isCanonicalUtc(entry)
    ))
    || !(value.request.stripeCustomerIdSnapshot === null
      || typeof value.request.stripeCustomerIdSnapshot === "string")
    || typeof value.request.userMessagePresent !== "boolean"
    || typeof value.request.lastErrorPresent !== "boolean"
    || !(value.request.resultSummarySha256 === null
      || SHA256_PATTERN.test(String(value.request.resultSummarySha256)))
    || !isPlainObject(value.outbox)
    || !exactKeys(value.outbox, [
      "status", "attemptCount", "templateVersion", "idempotencyKeySha256",
      "payloadFingerprint", "providerMessageId", "providerLastEvent", "providerEventAt",
      "nextAttemptAt", "leaseTokenPresent", "leaseExpiresAt", "acceptedAt", "deliveredAt",
      "terminalAt", "secretPurgeCheckpointPending", "secretPurgeGeneration",
    ])
    || !["held", "suppressed_restore"].includes(String(value.outbox.status))
    || !Number.isSafeInteger(value.outbox.attemptCount)
    || Number(value.outbox.attemptCount) < 0
    || typeof value.outbox.templateVersion !== "string"
    || !SHA256_PATTERN.test(String(value.outbox.idempotencyKeySha256))
    || ![value.outbox.payloadFingerprint, value.outbox.providerMessageId,
      value.outbox.providerLastEvent].every((entry) => entry === null || typeof entry === "string")
    || ![value.outbox.providerEventAt, value.outbox.nextAttemptAt, value.outbox.leaseExpiresAt,
      value.outbox.acceptedAt, value.outbox.deliveredAt, value.outbox.terminalAt].every((entry) => (
      entry === null || isCanonicalUtc(entry)
    ))
    || typeof value.outbox.leaseTokenPresent !== "boolean"
    || typeof value.outbox.secretPurgeCheckpointPending !== "boolean"
    || !Number.isSafeInteger(value.outbox.secretPurgeGeneration)
    || Number(value.outbox.secretPurgeGeneration) < 0
    || !isPlainObject(value.recipientSecret)
    || !exactKeys(value.recipientSecret, [
      "keyId", "nonceSha256", "ciphertextSha256", "authTagSha256", "purgeAfter",
    ])
    || !(value.recipientSecret.keyId === null || typeof value.recipientSecret.keyId === "string")
    || ![value.recipientSecret.nonceSha256, value.recipientSecret.ciphertextSha256,
      value.recipientSecret.authTagSha256].every((entry) => (
      entry === null || SHA256_PATTERN.test(String(entry))
    ))
    || !(value.recipientSecret.purgeAfter === null || isCanonicalUtc(value.recipientSecret.purgeAfter))
    || !(value.sessionTokenHashSha256 === null
      || SHA256_PATTERN.test(String(value.sessionTokenHashSha256)))
    || !isPlainObject(value.counts)
    || !exactKeys(value.counts, [
      "account", "profile", "session", "deletionRequest", "completionOutbox",
      "recipientSecret", "notificationEvent", "sourceEvidence", "sendEligibleOutbox",
      "pendingSecretCheckpoint",
    ])
    || !Object.values(value.counts).every((entry) => typeof entry === "string" && /^\d+$/.test(entry))
  ) return false;
  return true;
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseFixtureReceipt(bytes: Buffer): PostgresAccountDeletionRecoveryFixtureReceipt {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw fixtureError("receipt_invalid");
  }
  if (
    !isPlainObject(value)
    || canonicalPostgresLogicalStateJson(value) !== text
    || !exactKeys(value, [
      "kind", "version", "fixtureId", "userId", "requestId", "preparedAt",
      "databaseIdentitySha256", "preparedState", "preparedStateSha256", "backupRowCounts",
    ])
    || value.kind !== POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND
    || value.version !== POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION
    || typeof value.fixtureId !== "string"
    || !UUID_PATTERN.test(value.fixtureId)
    || typeof value.userId !== "string"
    || value.userId !== `${FIXTURE_ID_PREFIX}${value.fixtureId}`
    || typeof value.requestId !== "string"
    || value.requestId !== `${REQUEST_ID_PREFIX}${value.fixtureId}`
    || !isCanonicalUtc(value.preparedAt)
    || !SHA256_PATTERN.test(String(value.databaseIdentitySha256))
    || !validSemanticState(value.preparedState)
    || value.preparedState.phase !== "prepared"
    || !SHA256_PATTERN.test(String(value.preparedStateSha256))
    || semanticSha256(value.preparedState) !== value.preparedStateSha256
    || !Array.isArray(value.backupRowCounts)
    || value.backupRowCounts.length !== BACKUP_BOUND_TABLES.length
    || !value.backupRowCounts.every((entry, index) => (
      isPlainObject(entry)
      && exactKeys(entry, ["tableName", "rowCount"])
      && entry.tableName === BACKUP_BOUND_TABLES[index]
      && typeof entry.rowCount === "string"
      && /^\d+$/.test(entry.rowCount)
    ))
  ) throw fixtureError("receipt_invalid");
  return value as unknown as PostgresAccountDeletionRecoveryFixtureReceipt;
}

function parseCompletionReceipt(bytes: Buffer): PostgresAccountDeletionRecoveryFixtureCompletionReceipt {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw fixtureError("receipt_invalid");
  }
  if (
    !isPlainObject(value)
    || canonicalPostgresLogicalStateJson(value) !== text
    || !exactKeys(value, [
      "kind", "version", "completedAt", "fixtureReceiptSha256",
      "logicalBackupStateReceiptSha256", "databaseIdentitySha256", "tombstoneSha256",
      "ledgerAuthoritySha256", "ledgerCurrentSha256", "ledgerGenesisSha256",
      "ledgerCheckpointSha256", "ledgerImmutableSetSha256", "ledgerTombstoneCount",
      "completedStateSha256", "providerCallCount",
    ])
    || value.kind !== POSTGRES_ACCOUNT_DELETION_RECOVERY_COMPLETION_KIND
    || value.version !== POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION
    || !isCanonicalUtc(value.completedAt)
    || ![
      value.fixtureReceiptSha256, value.logicalBackupStateReceiptSha256,
      value.databaseIdentitySha256, value.tombstoneSha256, value.ledgerAuthoritySha256,
      value.ledgerCurrentSha256, value.ledgerGenesisSha256, value.ledgerCheckpointSha256,
      value.ledgerImmutableSetSha256, value.completedStateSha256,
    ].every((entry) => SHA256_PATTERN.test(String(entry)))
    || !Number.isSafeInteger(value.ledgerTombstoneCount)
    || Number(value.ledgerTombstoneCount) < 1
    || value.providerCallCount !== 0
  ) throw fixtureError("receipt_invalid");
  return value as unknown as PostgresAccountDeletionRecoveryFixtureCompletionReceipt;
}

interface TrustedFile {
  readonly bytes: Buffer;
  readonly sha256: string;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readTrustedFile(
  filePathInput: string,
  invalidCode: PostgresAccountDeletionRecoveryFixtureFailureCode,
): Promise<TrustedFile> {
  if (!path.isAbsolute(filePathInput) || path.resolve(filePathInput) !== filePathInput || filePathInput.includes("\0")) {
    throw fixtureError(invalidCode);
  }
  let before: fs.Stats;
  let handle: fs.promises.FileHandle | null = null;
  try {
    before = await fs.promises.lstat(filePathInput);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o7777) !== 0o600
      || before.size < 1
      || before.size > MAX_RECEIPT_BYTES
      || (process.getuid && before.uid !== process.getuid())
      || await fs.promises.realpath(filePathInput) !== filePathInput
    ) throw new Error("unsafe");
    // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
    // identity; both the descriptor and pathname are revalidated after read.
    // codeql[js/file-system-race]
    handle = await fs.promises.open(
      filePathInput,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error("changed");
    const bytes = await handle.readFile();
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePathInput);
    if (!sameFile(before, afterDescriptor) || !sameFile(before, afterPath)) throw new Error("changed");
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError(invalidCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafePrivateParent(filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || filePath.includes("\0")) {
    throw fixtureError("unsafe_receipt_file");
  }
  try {
    const parent = path.dirname(filePath);
    const stat = await fs.promises.lstat(parent);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || (stat.mode & 0o7777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid())
      || await fs.promises.realpath(parent) !== parent
    ) throw new Error("unsafe");
  } catch {
    throw fixtureError("unsafe_receipt_file");
  }
}

async function writeExclusiveCanonicalFile(filePath: string, value: unknown): Promise<TrustedFile> {
  await assertSafePrivateParent(filePath);
  const bytes = Buffer.from(canonicalPostgresLogicalStateJson(value), "utf8");
  const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.link(temporaryPath, filePath);
    await fs.promises.unlink(temporaryPath);
    const written = await readTrustedFile(filePath, "unsafe_receipt_file");
    if (!written.bytes.equals(bytes)) throw new Error("changed");
    return written;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await handle?.close().catch(() => undefined);
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      const existing = await readTrustedFile(filePath, "unsafe_receipt_file");
      if (existing.bytes.equals(bytes)) return existing;
    }
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw fixtureError("receipt_write_failed");
  }
}

async function readFixtureAuthority(
  filePath: string,
  expectedSha256: string,
): Promise<{ receipt: PostgresAccountDeletionRecoveryFixtureReceipt; bytes: Buffer; sha256: string }> {
  exactSha256(expectedSha256, "receipt_hash_mismatch");
  const trusted = await readTrustedFile(filePath, "unsafe_receipt_file");
  if (trusted.sha256 !== expectedSha256) throw fixtureError("receipt_hash_mismatch");
  return { receipt: parseFixtureReceipt(trusted.bytes), ...trusted };
}

function expectedPreparedState(
  state: PostgresAccountDeletionRecoveryFixtureSemanticState,
  receipt: Pick<PostgresAccountDeletionRecoveryFixtureReceipt, "userId" | "requestId" | "preparedAt">,
): boolean {
  const email = `${receipt.userId}@${FIXTURE_EMAIL_DOMAIN}`;
  const expectedPurgeAfter = new Date(Date.parse(receipt.preparedAt) + 60 * 24 * 60 * 60_000).toISOString();
  return state.phase === "prepared"
    && state.account.emailSha256 === sha256(email)
    && state.account.authProvider === "local"
    && state.account.supabaseUserId === null
    && state.account.stripeCustomerId === null
    && state.account.subscriptionStatus === "free"
    && state.account.status === "active"
    && state.profile.emailSha256 === sha256(email)
    && state.profile.publicAccountId === state.account.publicAccountId
    && state.profile.accountStatus === "active"
    && state.request.status === "processing"
    && state.request.attemptCount === 1
    && state.request.requestedAt < state.request.executeAfter
    && state.request.executeAfter < receipt.preparedAt
    && state.request.processingStartedAt === receipt.preparedAt
    && state.request.completedAt === null
    && state.request.identityDeletedAt === null
    && state.request.stripeCustomerDeletedAt === null
    && state.request.stripeCustomerIdSnapshot === null
    && state.request.deletionTombstoneRecordedAt === null
    && !state.request.userMessagePresent
    && !state.request.lastErrorPresent
    && state.request.resultSummarySha256 === null
    && state.outbox.status === "held"
    && state.outbox.attemptCount === 0
    && state.outbox.templateVersion === TEMPLATE_VERSION
    && state.outbox.idempotencyKeySha256 === sha256(`recovery-proof-notice:${receipt.requestId}`)
    && state.outbox.payloadFingerprint === null
    && state.outbox.providerMessageId === null
    && state.outbox.providerLastEvent === null
    && state.outbox.providerEventAt === null
    && state.outbox.nextAttemptAt === null
    && !state.outbox.leaseTokenPresent
    && state.outbox.leaseExpiresAt === null
    && state.outbox.acceptedAt === null
    && state.outbox.deliveredAt === null
    && state.outbox.terminalAt === null
    && !state.outbox.secretPurgeCheckpointPending
    && state.outbox.secretPurgeGeneration === 0
    && state.recipientSecret.keyId === KEY_ID
    && state.recipientSecret.nonceSha256 !== null
    && state.recipientSecret.ciphertextSha256 !== null
    && state.recipientSecret.authTagSha256 !== null
    && state.recipientSecret.purgeAfter === expectedPurgeAfter
    && state.sessionTokenHashSha256 !== null
    && JSON.stringify(state.counts) === JSON.stringify({
      account: "1",
      profile: "1",
      session: "1",
      deletionRequest: "1",
      completionOutbox: "1",
      recipientSecret: "1",
      notificationEvent: "0",
      sourceEvidence: "0",
      sendEligibleOutbox: "0",
      pendingSecretCheckpoint: "0",
    } satisfies PostgresAccountDeletionRecoveryFixtureCounts);
}

function expectedCompletedState(
  state: PostgresAccountDeletionRecoveryFixtureSemanticState,
  receipt: Pick<PostgresAccountDeletionRecoveryFixtureReceipt, "userId" | "requestId">,
  completedAt: string,
): boolean {
  const surrogatePublicId = `DEL-${sha256(receipt.userId).slice(0, 12).toUpperCase()}`;
  const surrogateEmail = `deleted-${receipt.userId}@invalid.pintpath.local`;
  const expectedSummarySha256 = sha256CanonicalPostgresLogicalState({
    anonymisedAccount: surrogatePublicId,
    evidenceIds: [],
    removedContributionRows: 0,
    removedDerivedPriceRecords: 0,
    removedSubmissionItems: 0,
    removedSubmissions: 0,
    retentionPolicyVersion: ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
    surrogatePublicId,
    transactionContractVersion: ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
  });
  return state.phase === "completed"
    && state.account.emailSha256 === sha256(surrogateEmail)
    && state.account.publicAccountId === surrogatePublicId
    && state.account.authProvider === "deleted"
    && state.account.supabaseUserId === null
    && state.account.stripeCustomerId === null
    && state.account.subscriptionStatus === "free"
    && state.account.status === "suspended"
    && state.profile.emailSha256 === sha256(surrogateEmail)
    && state.profile.publicAccountId === surrogatePublicId
    && state.profile.accountStatus === "suspended"
    && state.request.status === "completed"
    && state.request.attemptCount === 1
    && state.request.completedAt === completedAt
    && state.request.identityDeletedAt === null
    && state.request.stripeCustomerDeletedAt === null
    && state.request.stripeCustomerIdSnapshot === null
    && state.request.deletionTombstoneRecordedAt === completedAt
    && !state.request.userMessagePresent
    && !state.request.lastErrorPresent
    && state.request.resultSummarySha256 === expectedSummarySha256
    && state.outbox.status === "suppressed_restore"
    && state.outbox.attemptCount === 0
    && state.outbox.templateVersion === TEMPLATE_VERSION
    && state.outbox.payloadFingerprint === null
    && state.outbox.providerMessageId === null
    && state.outbox.providerLastEvent === null
    && state.outbox.providerEventAt === null
    && state.outbox.nextAttemptAt === null
    && !state.outbox.leaseTokenPresent
    && state.outbox.leaseExpiresAt === null
    && state.outbox.acceptedAt === null
    && state.outbox.deliveredAt === null
    && state.outbox.terminalAt === completedAt
    && !state.outbox.secretPurgeCheckpointPending
    && state.outbox.secretPurgeGeneration === 1
    && Object.values(state.recipientSecret).every((entry) => entry === null)
    && state.sessionTokenHashSha256 === null
    && JSON.stringify(state.counts) === JSON.stringify({
      account: "1",
      profile: "1",
      session: "0",
      deletionRequest: "1",
      completionOutbox: "1",
      recipientSecret: "0",
      notificationEvent: "0",
      sourceEvidence: "0",
      sendEligibleOutbox: "0",
      pendingSecretCheckpoint: "0",
    } satisfies PostgresAccountDeletionRecoveryFixtureCounts);
}

async function databaseIdentity(
  database: SqlDatabase,
  inspector: (database: SqlDatabase) => Promise<string>,
): Promise<string> {
  if (database.dialect !== "postgres") throw fixtureError("postgres_required");
  try {
    return exactSha256(await inspector(database), "database_identity_unavailable");
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("database_identity_unavailable");
  }
}

async function inspectWithReceipt(
  database: SqlDatabase,
  receipt: PostgresAccountDeletionRecoveryFixtureReceipt,
  receiptSha256: string,
  inspector: (database: SqlDatabase) => Promise<string>,
): Promise<PostgresAccountDeletionRecoveryInspection> {
  const identity = await databaseIdentity(database, inspector);
  if (identity !== receipt.databaseIdentitySha256) throw fixtureError("database_identity_mismatch");
  let state: PostgresAccountDeletionRecoveryFixtureSemanticState;
  try {
    state = await readFixtureState(database, receipt);
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("fixture_state_conflict");
  }
  const stateSha256 = semanticSha256(state);
  if (state.phase === "prepared") {
    if (
      !expectedPreparedState(state, receipt)
      || stateSha256 !== receipt.preparedStateSha256
    ) throw fixtureError("fixture_state_conflict");
  } else if (
    !state.request.completedAt
    || !expectedCompletedState(state, receipt, state.request.completedAt)
  ) {
    throw fixtureError("fixture_state_conflict");
  }
  return {
    receipt,
    receiptSha256,
    databaseIdentitySha256: identity,
    state,
    stateSha256,
  };
}

export async function preparePostgresAccountDeletionRecoveryFixture(
  options: PreparePostgresAccountDeletionRecoveryFixtureOptions,
): Promise<PreparedPostgresAccountDeletionRecoveryFixture> {
  const inspector = options.inspectDatabaseIdentity
    ?? inspectPostgresLogicalRuntimeDatabaseIdentity;
  if (options.database.dialect !== "postgres") throw fixtureError("postgres_required");

  try {
    const existing = await readTrustedFile(options.receiptFile, "unsafe_receipt_file");
    const receipt = parseFixtureReceipt(existing.bytes);
    if (
      (options.fixtureId !== undefined && options.fixtureId.toLowerCase() !== receipt.fixtureId)
      || (options.preparedAt !== undefined && options.preparedAt !== receipt.preparedAt)
    ) throw fixtureError("fixture_state_conflict");
    const inspected = await inspectWithReceipt(
      options.database,
      receipt,
      existing.sha256,
      inspector,
    );
    if (
      options.expectedDatabaseIdentitySha256 !== undefined
      && inspected.databaseIdentitySha256 !== exactSha256(
        options.expectedDatabaseIdentitySha256,
        "database_identity_mismatch",
      )
    ) throw fixtureError("database_identity_mismatch");
    if (inspected.state.phase !== "prepared") throw fixtureError("fixture_state_conflict");
    return {
      receipt,
      receiptSha256: existing.sha256,
      stateSha256: inspected.stateSha256,
      databaseIdentitySha256: inspected.databaseIdentitySha256,
    };
  } catch (error) {
    if (
      error instanceof PostgresAccountDeletionRecoveryFixtureError
      && error.code !== "unsafe_receipt_file"
    ) throw error;
    try {
      await fs.promises.lstat(options.receiptFile);
      throw fixtureError("unsafe_receipt_file");
    } catch (statError) {
      if (statError instanceof PostgresAccountDeletionRecoveryFixtureError) throw statError;
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw fixtureError("unsafe_receipt_file");
      }
    }
  }

  await assertSafePrivateParent(options.receiptFile);
  const fixture = fixtureIdentity(options.fixtureId);
  const preparedAt = canonicalUtc(options.preparedAt ?? new Date().toISOString());
  const preparedAtMs = Date.parse(preparedAt);
  const requestedAt = new Date(preparedAtMs - 2 * 60_000).toISOString();
  const executeAfter = new Date(preparedAtMs - 60_000).toISOString();
  const staleBefore = new Date(preparedAtMs - 3 * 60_000).toISOString();
  const sessionExpiresAt = new Date(preparedAtMs + 7 * 24 * 60 * 60_000).toISOString();
  const purgeAfter = new Date(preparedAtMs + 60 * 24 * 60 * 60_000).toISOString();
  const identity = await databaseIdentity(options.database, inspector);
  if (
    options.expectedDatabaseIdentitySha256 !== undefined
    && identity !== exactSha256(
      options.expectedDatabaseIdentitySha256,
      "database_identity_mismatch",
    )
  ) throw fixtureError("database_identity_mismatch");
  let receipt: PostgresAccountDeletionRecoveryFixtureReceipt;

  try {
    receipt = await options.database.transaction(async () => {
      if ((await pendingCheckpointRequestIds(options.database)).length !== 0) {
        throw fixtureError("checkpoint_backlog_present");
      }
      const accountRepository = new AccountSessionRepository(options.database);
      const queueRepository = new AccountDeletionQueueRepository(options.database);
      await accountRepository.createAccount({
        id: fixture.userId,
        email: fixture.email,
        passwordHash: "recovery-proof-disabled-password-hash",
        role: "user",
        subscriptionStatus: "free",
        authProvider: "local",
        supabaseUserId: null,
        now: preparedAt,
      });
      const sessionEntropy = crypto.randomBytes(32);
      const tokenHash = sha256(Buffer.concat([
        Buffer.from("pintpath/recovery-proof/session/v1\0", "utf8"),
        sessionEntropy,
      ]));
      sessionEntropy.fill(0);
      await accountRepository.createSession({
        tokenHash,
        userId: fixture.userId,
        createdAt: preparedAt,
        expiresAt: sessionExpiresAt,
      });
      await queueRepository.createAccountDeletionRequest({
        id: fixture.requestId,
        userId: fixture.userId,
        userMessage: null,
        requestedAt,
        executeAfter,
      });

      const encryptionSecret = crypto.randomBytes(32);
      try {
        const encrypted = encryptAccountDeletionDestination({
          requestId: fixture.requestId,
          destination: fixture.email,
          encryptionSecret,
        });
        const begun = await queueRepository.beginAccountDeletionWithCompletionNotification({
          requestId: fixture.requestId,
          reviewedBy: fixture.userId,
          now: preparedAt,
          staleBefore,
          templateVersion: TEMPLATE_VERSION,
          idempotencyKey: `recovery-proof-notice:${fixture.requestId}`,
          keyId: KEY_ID,
          nonce: asBuffer(encrypted.iv),
          ciphertext: asBuffer(encrypted.ciphertext),
          authTag: asBuffer(encrypted.authTag),
          purgeAfter,
        });
        if (!begun || begun.status !== "processing" || begun.attempt_count !== 1) {
          throw fixtureError("fixture_state_conflict");
        }
      } finally {
        encryptionSecret.fill(0);
      }

      const preparedState = await readFixtureState(options.database, fixture);
      if (!expectedPreparedState(preparedState, { ...fixture, preparedAt })) {
        throw fixtureError("fixture_state_conflict");
      }
      return {
        kind: POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND,
        version: POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION,
        fixtureId: fixture.fixtureId,
        userId: fixture.userId,
        requestId: fixture.requestId,
        preparedAt,
        databaseIdentitySha256: identity,
        preparedState,
        preparedStateSha256: semanticSha256(preparedState),
        backupRowCounts: await backupRowCounts(options.database),
      };
    })();
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("fixture_state_conflict");
  }

  const written = await writeExclusiveCanonicalFile(options.receiptFile, receipt);
  return {
    receipt,
    receiptSha256: written.sha256,
    stateSha256: receipt.preparedStateSha256,
    databaseIdentitySha256: identity,
  };
}

export async function inspectPostgresAccountDeletionRecoveryFixture(
  options: InspectPostgresAccountDeletionRecoveryFixtureOptions,
): Promise<PostgresAccountDeletionRecoveryInspection> {
  const authority = await readFixtureAuthority(
    options.receiptFile,
    options.expectedReceiptSha256,
  );
  return inspectWithReceipt(
    options.database,
    authority.receipt,
    authority.sha256,
    options.inspectDatabaseIdentity ?? inspectPostgresLogicalRuntimeDatabaseIdentity,
  );
}

async function readLogicalBackupReceipt(
  filePath: string,
  expectedSha256: string,
): Promise<{ receipt: PostgresLogicalSourceStateReceipt; sha256: string }> {
  exactSha256(expectedSha256, "logical_backup_receipt_invalid");
  const trusted = await readTrustedFile(filePath, "logical_backup_receipt_invalid");
  if (trusted.sha256 !== expectedSha256) throw fixtureError("logical_backup_receipt_invalid");
  try {
    return {
      receipt: parsePostgresLogicalSourceStateReceipt(trusted.bytes),
      sha256: trusted.sha256,
    };
  } catch {
    throw fixtureError("logical_backup_receipt_invalid");
  }
}

function assertLogicalBackupContainsFixture(
  logicalReceipt: PostgresLogicalSourceStateReceipt,
  fixtureReceipt: PostgresAccountDeletionRecoveryFixtureReceipt,
  completedAt: string,
): void {
  if (logicalReceipt.source.databaseIdentitySha256 !== fixtureReceipt.databaseIdentitySha256) {
    throw fixtureError("database_identity_mismatch");
  }
  if (
    logicalReceipt.capturedAt < fixtureReceipt.preparedAt
    || logicalReceipt.capturedAt >= completedAt
  ) throw fixtureError("logical_backup_not_after_prepare");
  const rows = new Map(logicalReceipt.state.tables.map((table) => [table.tableName, table.rowCount]));
  if (fixtureReceipt.backupRowCounts.some((entry) => rows.get(entry.tableName) !== entry.rowCount)) {
    throw fixtureError("logical_backup_state_mismatch");
  }
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) throw new Error("not-object");
    return parsed;
  } catch {
    throw fixtureError("tombstone_verification_failed");
  }
}

function sameTombstone(
  left: AccountDeletionTombstone,
  right: AccountDeletionTombstone,
): boolean {
  return left.requestId === right.requestId
    && left.userId === right.userId
    && left.completedAt === right.completedAt;
}

function canonicalCurrentBytes(tombstones: AccountDeletionTombstone[], generatedAt: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt,
    tombstones: normalizeTombstones(tombstones),
  }, null, 2)}\n`);
}

function canonicalGenesisBytes(genesis: LedgerGenesis): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: genesis.version,
    kind: genesis.kind,
    createdAt: genesis.createdAt,
    immutablePrefix: genesis.immutablePrefix,
    currentLedgerPath: genesis.currentLedgerPath,
  }, null, 2)}\n`);
}

function canonicalCheckpointBytes(checkpoint: AccountDeletionLedgerCheckpoint): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: checkpoint.version,
    generatedAt: checkpoint.generatedAt,
    genesisPath: checkpoint.genesisPath,
    genesisSha256: checkpoint.genesisSha256,
    currentLedgerPath: checkpoint.currentLedgerPath,
    currentLedgerSha256: checkpoint.currentLedgerSha256,
    immutableObjectCount: checkpoint.immutableObjectCount,
    immutableSetSha256: checkpoint.immutableSetSha256,
    tombstoneCount: checkpoint.tombstoneCount,
    latestCompletedAt: checkpoint.latestCompletedAt,
  }, null, 2)}\n`);
}

function validateLedgerAuthority(
  value: VerifiedAccountDeletionLedger,
  expectedTombstone: AccountDeletionTombstone,
): ValidatedLedgerAuthority {
  try {
    if (
      !Buffer.isBuffer(value.bytes)
      || !Buffer.isBuffer(value.genesisBytes)
      || !Buffer.isBuffer(value.checkpointBytes)
      || !SHA256_PATTERN.test(value.sha256)
      || !SHA256_PATTERN.test(value.genesisSha256)
      || !SHA256_PATTERN.test(value.checkpointSha256)
      || sha256(value.bytes) !== value.sha256
      || sha256(value.genesisBytes) !== value.genesisSha256
      || sha256(value.checkpointBytes) !== value.checkpointSha256
      || !Array.isArray(value.tombstones)
      || !isPlainObject(value.checkpoint)
    ) throw new Error("invalid");

    const currentObject = parseJsonObject(value.bytes);
    if (
      !exactKeys(currentObject, ["version", "generatedAt", "tombstones"])
      || currentObject.version !== 1
      || !isCanonicalUtc(currentObject.generatedAt)
    ) throw new Error("invalid");
    const current = parseAccountDeletionTombstones(value.bytes);
    if (
      !canonicalCurrentBytes(current.tombstones, current.generatedAt).equals(value.bytes)
      || JSON.stringify(current.tombstones) !== JSON.stringify(value.tombstones)
      || !current.tombstones.every((entry) => isCanonicalUtc(entry.completedAt))
      || !current.tombstones.some((entry) => sameTombstone(entry, expectedTombstone))
    ) throw new Error("invalid");

    const genesisObject = parseJsonObject(value.genesisBytes);
    if (
      !exactKeys(genesisObject, [
        "version", "kind", "createdAt", "immutablePrefix", "currentLedgerPath",
      ])
      || genesisObject.version !== 1
      || genesisObject.kind !== "pint-path-account-deletion-ledger-genesis"
      || !isCanonicalUtc(genesisObject.createdAt)
      || genesisObject.immutablePrefix !== TOMBSTONE_LEDGER_PREFIX
      || genesisObject.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH
    ) throw new Error("invalid");
    const genesis = genesisObject as unknown as LedgerGenesis;
    if (!canonicalGenesisBytes(genesis).equals(value.genesisBytes)) throw new Error("invalid");

    const checkpointObject = parseJsonObject(value.checkpointBytes);
    if (
      !exactKeys(checkpointObject, [
        "version", "generatedAt", "genesisPath", "genesisSha256", "currentLedgerPath",
        "currentLedgerSha256", "immutableObjectCount", "immutableSetSha256",
        "tombstoneCount", "latestCompletedAt",
      ])
      || checkpointObject.version !== 2
      || !isCanonicalUtc(checkpointObject.generatedAt)
      || checkpointObject.genesisPath !== TOMBSTONE_LEDGER_GENESIS_PATH
      || checkpointObject.genesisSha256 !== value.genesisSha256
      || checkpointObject.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH
      || checkpointObject.currentLedgerSha256 !== value.sha256
      || !Number.isSafeInteger(checkpointObject.immutableObjectCount)
      || Number(checkpointObject.immutableObjectCount) < 1
      || !SHA256_PATTERN.test(String(checkpointObject.immutableSetSha256))
      || !Number.isSafeInteger(checkpointObject.tombstoneCount)
      || Number(checkpointObject.tombstoneCount) < 1
      || checkpointObject.tombstoneCount !== current.tombstones.length
      || Number(checkpointObject.immutableObjectCount) < current.tombstones.length
      || checkpointObject.latestCompletedAt === null
      || !isCanonicalUtc(checkpointObject.latestCompletedAt)
      || checkpointObject.generatedAt !== current.generatedAt
    ) throw new Error("invalid");
    const latestCompletedAt = current.tombstones.reduce(
      (latest, entry) => entry.completedAt > latest ? entry.completedAt : latest,
      current.tombstones[0]!.completedAt,
    );
    if (checkpointObject.latestCompletedAt !== latestCompletedAt) throw new Error("invalid");
    const checkpoint = checkpointObject as unknown as AccountDeletionLedgerCheckpoint;
    if (
      canonicalPostgresLogicalStateJson(checkpoint)
        !== canonicalPostgresLogicalStateJson(value.checkpoint)
      || !canonicalCheckpointBytes(checkpoint).equals(value.checkpointBytes)
    ) throw new Error("invalid");

    const authoritySha256 = sha256CanonicalPostgresLogicalState({
      kind: "pintpath-account-deletion-ledger-recovery-authority",
      version: 1,
      currentSha256: value.sha256,
      genesisSha256: value.genesisSha256,
      checkpointSha256: value.checkpointSha256,
      immutableSetSha256: checkpoint.immutableSetSha256,
      tombstoneCount: checkpoint.tombstoneCount,
    });
    return {
      currentBytes: Buffer.from(value.bytes),
      genesisBytes: Buffer.from(value.genesisBytes),
      checkpointBytes: Buffer.from(value.checkpointBytes),
      currentSha256: value.sha256,
      genesisSha256: value.genesisSha256,
      checkpointSha256: value.checkpointSha256,
      immutableSetSha256: checkpoint.immutableSetSha256,
      tombstoneCount: checkpoint.tombstoneCount,
      authoritySha256,
      tombstoneSha256: tombstoneSha256(expectedTombstone),
    };
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("tombstone_verification_failed");
  }
}

async function assertPrivateDirectoryParent(directoryPath: string): Promise<void> {
  if (
    !path.isAbsolute(directoryPath)
    || path.resolve(directoryPath) !== directoryPath
    || directoryPath.includes("\0")
  ) throw fixtureError("authority_directory_unsafe");
  try {
    const parent = path.dirname(directoryPath);
    const stat = await fs.promises.lstat(parent);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || (stat.mode & 0o7777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid())
      || await fs.promises.realpath(parent) !== parent
    ) throw new Error("unsafe");
  } catch {
    throw fixtureError("authority_directory_unsafe");
  }
}

async function verifySealedAuthorityDirectory(
  directoryPath: string,
  authority: ValidatedLedgerAuthority,
): Promise<void> {
  try {
    const stat = await fs.promises.lstat(directoryPath);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || (stat.mode & 0o7777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid())
      || await fs.promises.realpath(directoryPath) !== directoryPath
    ) throw new Error("unsafe");
    const entries = (await fs.promises.readdir(directoryPath)).sort();
    if (JSON.stringify(entries) !== JSON.stringify(POSTGRES_ACCOUNT_DELETION_RECOVERY_AUTHORITY_FILES)) {
      throw new Error("unsafe");
    }
    const expected = new Map<string, Buffer>([
      ["current.json", authority.currentBytes],
      ["genesis.json", authority.genesisBytes],
      ["checkpoint.json", authority.checkpointBytes],
    ]);
    for (const filename of POSTGRES_ACCOUNT_DELETION_RECOVERY_AUTHORITY_FILES) {
      const trusted = await readTrustedFile(
        path.join(directoryPath, filename),
        "authority_directory_unsafe",
      );
      if (!trusted.bytes.equals(expected.get(filename)!)) throw new Error("changed");
    }
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("authority_directory_unsafe");
  }
}

async function sealLedgerAuthorityDirectory(
  directoryPath: string,
  authority: ValidatedLedgerAuthority,
): Promise<void> {
  await assertPrivateDirectoryParent(directoryPath);
  try {
    await verifySealedAuthorityDirectory(directoryPath, authority);
    return;
  } catch (error) {
    if (
      !(error instanceof PostgresAccountDeletionRecoveryFixtureError)
      || error.code !== "authority_directory_unsafe"
    ) throw error;
    try {
      await fs.promises.lstat(directoryPath);
      throw error;
    } catch (statError) {
      if (statError instanceof PostgresAccountDeletionRecoveryFixtureError) throw statError;
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const temporaryPath = `${directoryPath}.tmp-${crypto.randomUUID()}`;
  let temporaryCreated = false;
  try {
    await fs.promises.mkdir(temporaryPath, { mode: 0o700 });
    temporaryCreated = true;
    await fs.promises.chmod(temporaryPath, 0o700);
    const files: Readonly<Record<typeof POSTGRES_ACCOUNT_DELETION_RECOVERY_AUTHORITY_FILES[number], Buffer>> = {
      "checkpoint.json": authority.checkpointBytes,
      "current.json": authority.currentBytes,
      "genesis.json": authority.genesisBytes,
    };
    for (const filename of POSTGRES_ACCOUNT_DELETION_RECOVERY_AUTHORITY_FILES) {
      const handle = await fs.promises.open(path.join(temporaryPath, filename), "wx", 0o600);
      try {
        await handle.writeFile(files[filename]);
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const directoryHandle = await fs.promises.open(temporaryPath, fs.constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await fs.promises.rename(temporaryPath, directoryPath);
    temporaryCreated = false;
    await verifySealedAuthorityDirectory(directoryPath, authority);
  } catch (error) {
    if (temporaryCreated) {
      await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
      await verifySealedAuthorityDirectory(directoryPath, authority);
      return;
    } catch {
      throw fixtureError("authority_directory_unsafe");
    }
  }
}

export async function completePostgresAccountDeletionRecoveryFixture(
  options: CompletePostgresAccountDeletionRecoveryFixtureOptions,
): Promise<CompletedPostgresAccountDeletionRecoveryFixture> {
  const completedAt = canonicalUtc(options.completedAt);
  const fixtureAuthority = await readFixtureAuthority(
    options.receiptFile,
    options.expectedReceiptSha256,
  );
  const inspector = options.inspectDatabaseIdentity
    ?? inspectPostgresLogicalRuntimeDatabaseIdentity;
  const inspected = await inspectWithReceipt(
    options.database,
    fixtureAuthority.receipt,
    fixtureAuthority.sha256,
    inspector,
  );
  const logicalAuthority = await readLogicalBackupReceipt(
    options.logicalBackupStateReceiptFile,
    options.expectedLogicalBackupStateReceiptSha256,
  );
  assertLogicalBackupContainsFixture(logicalAuthority.receipt, fixtureAuthority.receipt, completedAt);

  if (inspected.state.phase === "prepared") {
    const currentCounts = await backupRowCounts(options.database);
    if (
      canonicalPostgresLogicalStateJson(currentCounts)
      !== canonicalPostgresLogicalStateJson(fixtureAuthority.receipt.backupRowCounts)
    ) {
      throw fixtureError("fixture_state_conflict");
    }
    if ((await pendingCheckpointRequestIds(options.database)).length !== 0) {
      throw fixtureError("checkpoint_backlog_present");
    }
  } else if (inspected.state.request.completedAt !== completedAt) {
    throw fixtureError("fixture_state_conflict");
  }

  const tombstone: AccountDeletionTombstone = {
    requestId: fixtureAuthority.receipt.requestId,
    userId: fixtureAuthority.receipt.userId,
    completedAt,
  };
  let verifiedLedger: VerifiedAccountDeletionLedger;
  try {
    verifiedLedger = await options.appendAndVerifyTombstone(tombstone);
  } catch {
    throw fixtureError("tombstone_verification_failed");
  }
  const ledgerAuthority = validateLedgerAuthority(verifiedLedger, tombstone);
  await sealLedgerAuthorityDirectory(options.ledgerAuthorityDirectory, ledgerAuthority);

  const queueRepository = new AccountDeletionQueueRepository(options.database);
  let request = await queueRepository.getAccountDeletionRequestById(tombstone.requestId);
  if (!request || request.attempt_count !== 1) throw fixtureError("fixture_state_conflict");
  if (request.status === "processing") {
    if (
      request.deletion_tombstone_recorded_at !== null
      && request.deletion_tombstone_recorded_at !== completedAt
    ) throw fixtureError("tombstone_mark_failed");
    if (!await queueRepository.markAccountDeletionTombstoneRecorded({
      requestId: tombstone.requestId,
      attemptCount: 1,
      recordedAt: completedAt,
      now: completedAt,
    })) throw fixtureError("tombstone_mark_failed");
  } else if (
    request.status !== "completed"
    || request.completed_at !== completedAt
    || request.deletion_tombstone_recorded_at !== completedAt
  ) {
    throw fixtureError("fixture_state_conflict");
  }

  try {
    await new AccountPrivacyRepository(options.database).executeAccountAnonymisation({
      requestId: tombstone.requestId,
      attemptCount: 1,
      reviewedBy: tombstone.userId,
      now: completedAt,
      completionNotificationDisposition: "suppress_restore",
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    });
  } catch {
    throw fixtureError("anonymisation_failed");
  }

  const pending = await pendingCheckpointRequestIds(options.database);
  if (
    pending.length > 1
    || (pending.length === 1 && pending[0] !== tombstone.requestId)
  ) throw fixtureError("checkpoint_backlog_present");
  try {
    const physicalCheckpoint = options.physicalCheckpoint
      ?? createPostgresAccountDeletionSecretPhysicalCheckpoint(options.database);
    if (!await queueRepository.checkpointAccountDeletionNotificationSecrets(physicalCheckpoint)) {
      throw fixtureError("physical_checkpoint_failed");
    }
  } catch (error) {
    if (error instanceof PostgresAccountDeletionRecoveryFixtureError) throw error;
    throw fixtureError("physical_checkpoint_failed");
  }

  let completedState: PostgresAccountDeletionRecoveryFixtureSemanticState;
  try {
    completedState = await readFixtureState(options.database, fixtureAuthority.receipt);
  } catch {
    throw fixtureError("fixture_state_conflict");
  }
  if (!expectedCompletedState(completedState, fixtureAuthority.receipt, completedAt)) {
    throw fixtureError("fixture_state_conflict");
  }
  request = await queueRepository.getAccountDeletionRequestById(tombstone.requestId);
  if (!request || request.completed_at !== completedAt) throw fixtureError("fixture_state_conflict");

  const completionReceipt: PostgresAccountDeletionRecoveryFixtureCompletionReceipt = {
    kind: POSTGRES_ACCOUNT_DELETION_RECOVERY_COMPLETION_KIND,
    version: POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION,
    completedAt,
    fixtureReceiptSha256: fixtureAuthority.sha256,
    logicalBackupStateReceiptSha256: logicalAuthority.sha256,
    databaseIdentitySha256: fixtureAuthority.receipt.databaseIdentitySha256,
    tombstoneSha256: ledgerAuthority.tombstoneSha256,
    ledgerAuthoritySha256: ledgerAuthority.authoritySha256,
    ledgerCurrentSha256: ledgerAuthority.currentSha256,
    ledgerGenesisSha256: ledgerAuthority.genesisSha256,
    ledgerCheckpointSha256: ledgerAuthority.checkpointSha256,
    ledgerImmutableSetSha256: ledgerAuthority.immutableSetSha256,
    ledgerTombstoneCount: ledgerAuthority.tombstoneCount,
    completedStateSha256: semanticSha256(completedState),
    providerCallCount: 0,
  };
  const completionFile = await writeExclusiveCanonicalFile(
    options.completionReceiptFile,
    completionReceipt,
  );
  const parsedCompletion = parseCompletionReceipt(completionFile.bytes);
  if (
    canonicalPostgresLogicalStateJson(parsedCompletion)
    !== canonicalPostgresLogicalStateJson(completionReceipt)
  ) {
    throw fixtureError("receipt_write_failed");
  }
  return {
    receipt: completionReceipt,
    receiptSha256: completionFile.sha256,
    stateSha256: completionReceipt.completedStateSha256,
    databaseIdentitySha256: completionReceipt.databaseIdentitySha256,
    ledgerAuthoritySha256: completionReceipt.ledgerAuthoritySha256,
  };
}

/** A deliberate tripwire for any accidental email-provider wiring in this proof path. */
export function createFailIfCalledAccountDeletionRecoveryProvider(): AccountDeletionNotificationProvider {
  return Object.freeze({
    mode: "mock" as const,
    async send(): Promise<never> {
      throw fixtureError("provider_call_forbidden");
    },
    async getStatus(): Promise<never> {
      throw fixtureError("provider_call_forbidden");
    },
  });
}

export const postgresAccountDeletionRecoveryFixtureInternals = {
  BACKUP_BOUND_TABLES,
  canonicalCheckpointBytes,
  canonicalCurrentBytes,
  canonicalGenesisBytes,
  expectedCompletedState,
  expectedPreparedState,
  parseCompletionReceipt,
  parseFixtureReceipt,
  semanticSha256,
  tombstoneSha256,
  validateLedgerAuthority,
};
