import crypto from "node:crypto";

import {
  type AccountDeletionRequestRow,
  type AccountDeletionSecretPurgeCheckpointEntry,
  AccountDeletionQueueRepository,
} from "../db/account-deletion-queue.repository.js";
import { AppError } from "./errors.js";
import {
  AccountDeletionNotificationError,
  type AccountDeletionNotificationMessage,
  type AccountDeletionNotificationProvider,
  decryptAccountDeletionDestination,
  encryptAccountDeletionDestination,
  serializeResendAccountDeletionRequest,
} from "./account-deletion-notification.js";

export const ACCOUNT_DELETION_NOTICE_TEMPLATE_V1 = "account-deletion-complete-v1";
export const ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION = ACCOUNT_DELETION_NOTICE_TEMPLATE_V1;
export const ACCOUNT_DELETION_NOTICE_RECIPIENT_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_NOTICE_HELD_RECIPIENT_DAYS = 60;
export const ACCOUNT_DELETION_NOTICE_IDEMPOTENCY_WINDOW_HOURS = 23;
export const ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS = 24;
const ACCOUNT_DELETION_NOTICE_LEASE_MINUTES = 5;
const ACCOUNT_DELETION_NOTICE_STATUS_CHECK_MINUTES = 15;
const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const MAX_RESEND_WEBHOOK_BYTES = 256 * 1024;

export interface AccountDeletionNotificationKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface AccountDeletionNotificationWorkerConfig {
  provider: AccountDeletionNotificationProvider;
  keyring: AccountDeletionNotificationKeyring;
  performRecipientSecretPhysicalCheckpoint: (
    snapshot: readonly AccountDeletionSecretPurgeCheckpointEntry[],
  ) => Promise<boolean>;
  publicBaseUrl: string;
  from: string;
  replyTo?: string | undefined;
  supportEmail: string;
}

export interface ResendWebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface VerifiedResendWebhookEvent {
  eventId: string;
  type: string;
  createdAt: string;
  providerMessageId: string;
  payloadSha256: string;
  outcome: "delivered" | "failed" | "pending";
  relevant: boolean;
}

function addDays(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function addMinutes(value: string, minutes: number): string {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

function assertIso(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function decodeKeyMaterial(value: string, keyId: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`Account deletion notification key ${keyId} must be base64 encoded.`);
  }
  const key = Buffer.from(normalized, "base64");
  if (key.byteLength !== 32 || key.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error(`Account deletion notification key ${keyId} must decode to exactly 32 bytes.`);
  }
  return key;
}

export function parseAccountDeletionNotificationKeyring(input: {
  activeKeyId: string;
  keyringJson: string;
}): AccountDeletionNotificationKeyring {
  const activeKeyId = input.activeKeyId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(activeKeyId)) {
    throw new Error("ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.keyringJson);
  } catch {
    throw new Error("ACCOUNT_DELETION_NOTICE_KEYRING_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ACCOUNT_DELETION_NOTICE_KEYRING_JSON must be an object of key IDs to base64 keys.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) {
    throw new Error("ACCOUNT_DELETION_NOTICE_KEYRING_JSON must contain between one and eight keys.");
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(keyId) || typeof value !== "string") {
      throw new Error("ACCOUNT_DELETION_NOTICE_KEYRING_JSON contains an invalid key entry.");
    }
    keys.set(keyId, decodeKeyMaterial(value, keyId));
  }
  if (!keys.has(activeKeyId)) {
    throw new Error("ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID is not present in ACCOUNT_DELETION_NOTICE_KEYRING_JSON.");
  }
  return { activeKeyId, keys };
}

function retryDelayMinutes(attemptCount: number): number {
  return Math.min(6 * 60, 5 * (2 ** Math.max(0, Math.min(6, attemptCount - 1))));
}

interface AccountDeletionCompletionTemplateInput {
  requestId: string;
  destination: string;
  from: string;
  replyTo?: string | undefined;
  publicBaseUrl: string;
  supportEmail: string;
}

function assertV1RequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(normalized)) {
    throw new AccountDeletionNotificationError(
      "Account deletion request ID is invalid.",
      "permanent",
    );
  }
  return normalized;
}

function assertV1EmailAddress(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 320
    || /[\r\n\0]/.test(normalized)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new AccountDeletionNotificationError(`${label} is invalid.`, "permanent");
  }
  return normalized;
}

function assertV1MailFrom(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500 || /[\r\n\0]/.test(normalized)) {
    throw new AccountDeletionNotificationError(
      "Account deletion notification sender is invalid.",
      "permanent",
    );
  }
  return normalized;
}

function escapeV1Html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Immutable renderer for account-deletion-complete-v1.
 *
 * Do not refactor this released template to shared copy or validation helpers:
 * Resend binds its idempotency key to the complete serialized provider payload.
 * Any future copy or markup change must use a new template version and branch.
 */
function buildAccountDeletionCompletionMessageV1(
  input: AccountDeletionCompletionTemplateInput,
): AccountDeletionNotificationMessage {
  const requestId = assertV1RequestId(input.requestId);
  const destination = assertV1EmailAddress(
    input.destination,
    "Account deletion notification destination",
  );
  const from = assertV1MailFrom(input.from);
  const replyTo = input.replyTo
    ? assertV1EmailAddress(input.replyTo, "Account deletion notification reply address")
    : undefined;
  const supportEmail = assertV1EmailAddress(input.supportEmail, "Account deletion support address");
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.publicBaseUrl);
  } catch {
    throw new AccountDeletionNotificationError("Pint Path public URL is invalid.", "permanent");
  }
  if (!(["http:", "https:"] as string[]).includes(baseUrl.protocol)) {
    throw new AccountDeletionNotificationError("Pint Path public URL is invalid.", "permanent");
  }

  const termsUrl = new URL("/terms.html", baseUrl).toString();
  const privacyUrl = new URL("/privacy.html", baseUrl).toString();
  const subject = "Your Pint Path account deletion is complete";
  const text = [
    "Your Pint Path account deletion is complete.",
    "",
    "We have completed your account deletion request. You can no longer sign in with the deleted account.",
    "Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.",
    "",
    `Deletion request reference: ${requestId}`,
    `Support: ${supportEmail}`,
    `Terms: ${termsUrl}`,
    `Privacy: ${privacyUrl}`,
  ].join("\n");
  const html = [
    "<h1>Your Pint Path account deletion is complete</h1>",
    "<p>We have completed your account deletion request. You can no longer sign in with the deleted account.</p>",
    "<p>Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.</p>",
    `<p>Deletion request reference: <strong>${escapeV1Html(requestId)}</strong></p>`,
    '<hr style="margin:24px 0 16px; border:0; border-top:1px solid #CBD5E1;">',
    `<p><a href="mailto:${escapeV1Html(supportEmail)}">Support</a> · `,
    `<a href="${escapeV1Html(termsUrl)}">Terms</a> · `,
    `<a href="${escapeV1Html(privacyUrl)}">Privacy</a></p>`,
  ].join("");

  return {
    requestId,
    from,
    to: destination,
    ...(replyTo ? { replyTo } : {}),
    subject,
    text,
    html,
  };
}

function buildVersionedCompletionMessage(
  templateVersion: string,
  input: AccountDeletionCompletionTemplateInput,
): AccountDeletionNotificationMessage {
  switch (templateVersion) {
    case ACCOUNT_DELETION_NOTICE_TEMPLATE_V1:
      return buildAccountDeletionCompletionMessageV1(input);
    default:
      throw new AccountDeletionNotificationError(
        `Unsupported account deletion notification template: ${templateVersion}`,
        "permanent",
      );
  }
}

function messageFingerprint(input: {
  templateVersion: string;
  idempotencyKey: string;
  message: AccountDeletionNotificationMessage;
  key: Buffer;
}): string {
  return crypto.createHmac("sha256", input.key)
    .update("pintpath/account-deletion-provider-payload/v1\0", "utf8")
    .update(JSON.stringify({
      templateVersion: input.templateVersion,
      idempotencyKey: input.idempotencyKey,
      serializedBody: serializeResendAccountDeletionRequest(input.message),
    }))
    .digest("hex");
}

function webhookOutcome(type: string): VerifiedResendWebhookEvent["outcome"] {
  if (["email.delivered", "email.opened", "email.clicked", "email.complained"].includes(type)) {
    return "delivered";
  }
  if (["email.bounced", "email.failed", "email.suppressed"].includes(type)) {
    return "failed";
  }
  return "pending";
}

function webhookTagValue(value: unknown, name: string): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[name];
    return typeof candidate === "string" ? candidate : null;
  }
  if (Array.isArray(value)) {
    const entry = value.find((candidate) => (
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).name === name
    )) as Record<string, unknown> | undefined;
    return typeof entry?.value === "string" ? entry.value : null;
  }
  return null;
}

function timingSafeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && crypto.timingSafeEqual(left, right);
}

export function verifyResendWebhook(input: {
  rawBody: Buffer;
  headers: ResendWebhookHeaders;
  signingSecret: string;
  now?: Date | undefined;
}): VerifiedResendWebhookEvent {
  if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > MAX_RESEND_WEBHOOK_BYTES) {
    throw new AppError("Invalid Resend webhook payload.", 400);
  }
  const eventId = input.headers.id?.trim() ?? "";
  const timestampText = input.headers.timestamp?.trim() ?? "";
  const signatureHeader = input.headers.signature?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(eventId) || !/^\d{10}$/.test(timestampText) || !signatureHeader) {
    throw new AppError("Resend webhook signature is missing or invalid.", 401);
  }
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > RESEND_WEBHOOK_TOLERANCE_SECONDS) {
    throw new AppError("Resend webhook timestamp is outside the accepted window.", 401);
  }
  const encodedSecret = input.signingSecret.trim().replace(/^whsec_/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSecret)) {
    throw new AppError("Resend webhook signing secret is invalid.", 500, undefined, false);
  }
  const secret = Buffer.from(encodedSecret, "base64");
  if (secret.byteLength < 24 || secret.byteLength > 64) {
    throw new AppError("Resend webhook signing secret is invalid.", 500, undefined, false);
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${eventId}.${timestampText}.`, "utf8")
    .update(input.rawBody)
    .digest();
  const valid = signatureHeader
    .split(/\s+/)
    .map((part) => part.match(/^v1,([A-Za-z0-9+/]+={0,2})$/)?.[1])
    .filter((part): part is string => Boolean(part))
    .some((part) => timingSafeEqual(Buffer.from(part, "base64"), expected));
  if (!valid) throw new AppError("Resend webhook signature is invalid.", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw new AppError("Invalid Resend webhook payload.", 400);
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const data = record?.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : null;
  const type = typeof record?.type === "string" ? record.type.trim().toLowerCase() : "";
  let createdAt = "";
  if (typeof record?.created_at === "string") {
    try {
      createdAt = assertIso(record.created_at, "Webhook event time");
    } catch {
      throw new AppError("Invalid Resend webhook event.", 400);
    }
  }
  const providerMessageId = typeof data?.email_id === "string" ? data.email_id.trim() : "";
  if (!/^email\.[a-z_]+$/.test(type) || !createdAt || !/^[A-Za-z0-9._:-]{1,256}$/.test(providerMessageId)) {
    throw new AppError("Invalid Resend webhook event.", 400);
  }
  return {
    eventId,
    type,
    createdAt,
    providerMessageId,
    payloadSha256: crypto.createHmac("sha256", secret)
      .update("pintpath/resend-webhook-receipt/v1\0", "utf8")
      .update(input.rawBody)
      .digest("hex"),
    outcome: webhookOutcome(type),
    relevant: webhookTagValue(data?.tags, "message_type") === "account_deletion_completion",
  };
}

export class AccountDeletionNotificationCoordinator {
  constructor(
    private readonly repository: AccountDeletionQueueRepository,
    private readonly config: AccountDeletionNotificationWorkerConfig,
  ) {}

  beginDeletionWithPreparedNotification(input: {
    requestId: string;
    reviewedBy: string;
    destination: string;
    now: string;
    staleBefore: string;
  }): Promise<AccountDeletionRequestRow | null> {
    const now = assertIso(input.now, "Notification preparation time");
    const activeKey = this.config.keyring.keys.get(this.config.keyring.activeKeyId);
    if (!activeKey) throw new Error("The active account deletion notification encryption key is unavailable.");
    const encrypted = encryptAccountDeletionDestination({
      requestId: input.requestId,
      destination: input.destination,
      encryptionSecret: activeKey,
    });
    return this.repository.beginAccountDeletionWithCompletionNotification({
      requestId: input.requestId,
      reviewedBy: input.reviewedBy,
      now,
      staleBefore: assertIso(input.staleBefore, "Notification stale-claim time"),
      templateVersion: ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION,
      idempotencyKey: `pintpath-account-deletion/${input.requestId}`,
      keyId: this.config.keyring.activeKeyId,
      nonce: Buffer.from(encrypted.iv, "base64url"),
      ciphertext: Buffer.from(encrypted.ciphertext, "base64url"),
      authTag: Buffer.from(encrypted.authTag, "base64url"),
      purgeAfter: addDays(now, ACCOUNT_DELETION_NOTICE_HELD_RECIPIENT_DAYS),
    });
  }

  completionRetentionExpiresAt(completedAt: string): string {
    return addDays(assertIso(completedAt, "Deletion completion time"), ACCOUNT_DELETION_NOTICE_RECIPIENT_RETENTION_DAYS);
  }

  async checkpointRecipientSecrets(): Promise<boolean> {
    return this.repository.checkpointAccountDeletionNotificationSecrets(
      this.config.performRecipientSecretPhysicalCheckpoint,
    );
  }

  async processDue(input: { now?: Date | undefined; limit?: number | undefined } = {}): Promise<{
    claimed: number;
    accepted: number;
    delivered: number;
    deferred: number;
    failed: number;
    manualReview: number;
    recipientsPurged: number;
    securePurgeCheckpointPendingCount: number;
  }> {
    const nowDate = input.now ?? new Date();
    const now = nowDate.toISOString();
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));
    // Retry any prior secure-delete checkpoint before claiming new work. A
    // busy reader can temporarily prevent WAL truncation, so the durable flag
    // remains set until a later pass succeeds.
    await this.checkpointRecipientSecrets();
    const recipientsPurged = await this.repository.purgeExpiredAccountDeletionNotificationRecipients(now);
    const summary = {
      claimed: 0,
      accepted: 0,
      delivered: 0,
      deferred: 0,
      failed: 0,
      manualReview: 0,
      recipientsPurged,
      securePurgeCheckpointPendingCount: 0,
    };
    for (let index = 0; index < limit; index += 1) {
      const leaseToken = crypto.randomUUID();
      const notice = await this.repository.claimNextAccountDeletionCompletionNotification({
        now,
        staleBefore: addMinutes(now, -ACCOUNT_DELETION_NOTICE_LEASE_MINUTES),
        leaseToken,
        leaseExpiresAt: addMinutes(now, ACCOUNT_DELETION_NOTICE_LEASE_MINUTES),
      });
      if (!notice) break;
      summary.claimed += 1;
      const firstAttemptAgeMs = notice.first_attempt_at
        ? nowDate.getTime() - new Date(notice.first_attempt_at).getTime()
        : 0;
      if (
        !notice.provider_message_id
        && firstAttemptAgeMs >= ACCOUNT_DELETION_NOTICE_IDEMPOTENCY_WINDOW_HOURS * 60 * 60_000
      ) {
        const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
          requestId: notice.request_id,
          leaseToken,
          error: "Send outcome was not reconciled inside the provider idempotency window.",
          now,
        });
        if (transitioned) summary.manualReview += 1;
        continue;
      }
      try {
        if (notice.provider_message_id) {
          if (!this.config.provider.getStatus) {
            const acceptedAt = new Date(notice.accepted_at ?? notice.first_attempt_at ?? now).getTime();
            const reviewAt = acceptedAt + ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS * 60 * 60_000;
            if (nowDate.getTime() >= reviewAt) {
              const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
                requestId: notice.request_id,
                leaseToken,
                error: "No verified delivery event arrived inside the webhook confirmation window.",
                now,
              });
              if (transitioned) summary.manualReview += 1;
            } else {
              const transitioned = await this.repository.deferAccountDeletionNotification({
                requestId: notice.request_id,
                leaseToken,
                nextAttemptAt: new Date(reviewAt).toISOString(),
                error: "Awaiting a signed provider delivery webhook.",
                now,
              });
              if (transitioned) summary.deferred += 1;
            }
            continue;
          }
          const providerStatus = await this.config.provider.getStatus(notice.provider_message_id);
          if (providerStatus.deliveryStatus === "delivered") {
            const transitioned = await this.repository.markAccountDeletionNotificationDelivered({
              requestId: notice.request_id,
              providerEvent: providerStatus.lastEvent ?? "delivered",
              eventAt: now,
              now,
              leaseToken,
            });
            if (transitioned) {
              await this.checkpointRecipientSecrets();
              summary.delivered += 1;
            }
          } else if (providerStatus.deliveryStatus === "failed") {
            const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
              requestId: notice.request_id,
              leaseToken,
              providerEvent: providerStatus.lastEvent,
              error: "Provider reported that the completion notice was not delivered.",
              now,
            });
            if (transitioned) summary.manualReview += 1;
          } else {
            const transitioned = await this.repository.deferAccountDeletionNotification({
              requestId: notice.request_id,
              leaseToken,
              nextAttemptAt: addMinutes(now, ACCOUNT_DELETION_NOTICE_STATUS_CHECK_MINUTES),
              error: providerStatus.deliveryStatus === "unknown"
                ? "Provider delivery status is not yet recognized."
                : "Provider delivery is still pending.",
              now,
            });
            if (transitioned) summary.deferred += 1;
          }
          continue;
        }

        if (notice.idempotency_key !== `pintpath-account-deletion/${notice.request_id}`) {
          throw new AccountDeletionNotificationError("Stored notification idempotency key is invalid.", "permanent");
        }
        const recipient = await this.repository.getAccountDeletionNoticeRecipientSecret(notice.request_id);
        if (!recipient) {
          throw new AccountDeletionNotificationError("Encrypted notification recipient is unavailable.", "permanent");
        }
        const key = this.config.keyring.keys.get(recipient.key_id);
        if (!key) {
          const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
            requestId: notice.request_id,
            leaseToken,
            error: "The encryption key referenced by this notification is unavailable.",
            now,
          });
          if (transitioned) summary.manualReview += 1;
          continue;
        }
        const destination = decryptAccountDeletionDestination({
          requestId: notice.request_id,
          encryptedDestination: {
            version: 1,
            algorithm: "aes-256-gcm",
            iv: recipient.nonce.toString("base64url"),
            ciphertext: recipient.ciphertext.toString("base64url"),
            authTag: recipient.auth_tag.toString("base64url"),
          },
          encryptionSecret: key,
        });
        let message: AccountDeletionNotificationMessage;
        try {
          message = buildVersionedCompletionMessage(notice.template_version, {
            requestId: notice.request_id,
            destination,
            from: this.config.from,
            ...(this.config.replyTo ? { replyTo: this.config.replyTo } : {}),
            publicBaseUrl: this.config.publicBaseUrl,
            supportEmail: this.config.supportEmail,
          });
        } catch (error) {
          const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
            requestId: notice.request_id,
            leaseToken,
            error: error instanceof Error ? error.message : "The stored notification template is unsupported.",
            now,
          });
          if (transitioned) summary.manualReview += 1;
          continue;
        }
        const fingerprint = messageFingerprint({
          templateVersion: notice.template_version,
          idempotencyKey: notice.idempotency_key,
          message,
          key,
        });
        if (!await this.repository.lockAccountDeletionNotificationPayload({
          requestId: notice.request_id,
          leaseToken,
          payloadFingerprint: fingerprint,
          now,
        })) {
          const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
            requestId: notice.request_id,
            leaseToken,
            error: "The queued completion notice payload changed after its idempotency key was reserved.",
            now,
          });
          if (transitioned) summary.manualReview += 1;
          continue;
        }
        const sent = await this.config.provider.send(message);
        const transitioned = await this.repository.markAccountDeletionNotificationAccepted({
          requestId: notice.request_id,
          leaseToken,
          providerMessageId: sent.id,
          acceptedAt: now,
          nextCheckAt: this.config.provider.getStatus
            ? addMinutes(now, ACCOUNT_DELETION_NOTICE_STATUS_CHECK_MINUTES)
            : addMinutes(now, ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS * 60),
        });
        if (transitioned) summary.accepted += 1;
      } catch (error) {
        const notificationError = error instanceof AccountDeletionNotificationError ? error : null;
        if (notificationError?.outcome === "idempotency_conflict") {
          const transitioned = await this.repository.markAccountDeletionNotificationForManualReview({
            requestId: notice.request_id,
            leaseToken,
            providerEvent: "invalid_idempotent_request",
            error: "The provider reports that this idempotency key is bound to a different payload; automatic retry is blocked.",
            now,
          });
          if (transitioned) summary.manualReview += 1;
          continue;
        }
        if (notificationError?.outcome === "permanent") {
          const transitioned = await this.repository.markAccountDeletionNotificationFailed({
            requestId: notice.request_id,
            leaseToken,
            error: notificationError.message,
            now,
          });
          if (transitioned) summary.failed += 1;
          continue;
        }
        const nextAttemptAt = addMinutes(now, retryDelayMinutes(notice.attempt_count));
        const transitioned = await this.repository.deferAccountDeletionNotification({
          requestId: notice.request_id,
          leaseToken,
          nextAttemptAt,
          error: notificationError?.message ?? "Account deletion notification delivery failed.",
          now,
        });
        if (transitioned) summary.deferred += 1;
      }
    }
    await this.checkpointRecipientSecrets();
    summary.securePurgeCheckpointPendingCount = (
      await this.repository.getAccountDeletionNotificationQueueSummary(now)
    ).securePurgeCheckpointPendingCount;
    return summary;
  }

  async handleVerifiedWebhook(input: {
    rawBody: Buffer;
    headers: ResendWebhookHeaders;
    signingSecret: string;
    now?: Date | undefined;
  }): Promise<{ received: true; duplicate: boolean; matched: boolean }> {
    const now = input.now ?? new Date();
    const event = verifyResendWebhook({ ...input, now });
    if (!event.relevant) {
      return { received: true, duplicate: false, matched: false };
    }
    const result = await this.repository.recordAccountDeletionNotificationWebhook({
      eventId: event.eventId,
      providerMessageId: event.providerMessageId,
      eventType: event.type,
      eventCreatedAt: event.createdAt,
      receivedAt: now.toISOString(),
      payloadSha256: event.payloadSha256,
      outcome: event.outcome,
    });
    if (!result.matched) {
      throw new AppError("The signed deletion-notice event is not registered yet; retry later.", 503);
    }
    if (
      event.outcome === "delivered"
      && result.matched
      && !await this.checkpointRecipientSecrets()
    ) {
      // Resend retries non-2xx webhook responses. The event insert is
      // idempotent, and the durable purge flag keeps retrying WAL truncation.
      throw new AppError("Secure recipient purge checkpoint is temporarily busy; retry later.", 503);
    }
    return { received: true, duplicate: result.duplicate, matched: result.matched };
  }
}
