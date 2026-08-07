import crypto from "node:crypto";

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const DESTINATION_CIPHER_VERSION = 1 as const;
const DESTINATION_AAD_CONTEXT = "pintpath/account-deletion-destination/v1";

export type AccountDeletionNotificationProviderMode = "mock" | "resend";
export type AccountDeletionNotificationErrorOutcome =
  | "retryable"
  | "permanent"
  | "uncertain"
  | "idempotency_conflict";
export type AccountDeletionNotificationDeliveryStatus = "pending" | "delivered" | "failed" | "unknown";

export interface AccountDeletionEncryptedDestination {
  version: typeof DESTINATION_CIPHER_VERSION;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface AccountDeletionNotificationMessage {
  requestId: string;
  from: string;
  to: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html: string;
}

export interface AccountDeletionNotificationStatus {
  providerId: string;
  lastEvent: string | null;
  deliveryStatus: AccountDeletionNotificationDeliveryStatus;
}

export interface AccountDeletionNotificationProvider {
  readonly mode: AccountDeletionNotificationProviderMode;
  send(message: AccountDeletionNotificationMessage): Promise<{ id: string }>;
  getStatus?(providerId: string): Promise<AccountDeletionNotificationStatus>;
}

export function serializeResendAccountDeletionRequest(
  message: AccountDeletionNotificationMessage,
): string {
  return JSON.stringify({
    from: message.from,
    to: [message.to],
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html,
    tags: [{ name: "message_type", value: "account_deletion_completion" }],
  });
}

export class AccountDeletionNotificationError extends Error {
  constructor(
    message: string,
    readonly outcome: AccountDeletionNotificationErrorOutcome,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "AccountDeletionNotificationError";
  }
}

function assertRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(normalized)) {
    throw new AccountDeletionNotificationError(
      "Account deletion request ID is invalid.",
      "permanent",
    );
  }
  return normalized;
}

function assertEmailAddress(value: string, label: string): string {
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

function assertMailFrom(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500 || /[\r\n\0]/.test(normalized)) {
    throw new AccountDeletionNotificationError(
      "Account deletion notification sender is invalid.",
      "permanent",
    );
  }
  return normalized;
}

function assertProviderId(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) {
    throw new AccountDeletionNotificationError(
      "Account deletion notification provider ID is invalid.",
      "permanent",
    );
  }
  return normalized;
}

function encryptionSecretBytes(secret: string | Uint8Array): Buffer {
  const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (bytes.byteLength < 32) {
    throw new AccountDeletionNotificationError(
      "Account deletion destination encryption secret must contain at least 32 bytes.",
      "permanent",
    );
  }
  return bytes;
}

function deriveDestinationKey(secret: string | Uint8Array): Buffer {
  return crypto
    .createHash("sha256")
    .update(`${DESTINATION_AAD_CONTEXT}/key\0`, "utf8")
    .update(encryptionSecretBytes(secret))
    .digest();
}

function destinationAad(requestId: string): Buffer {
  return Buffer.from(`${DESTINATION_AAD_CONTEXT}\0${assertRequestId(requestId)}`, "utf8");
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AccountDeletionNotificationError(
      `Encrypted account deletion destination ${label} is invalid.`,
      "permanent",
    );
  }
  return Buffer.from(value, "base64url");
}

/**
 * Encrypts the short-lived completion destination independently of account data.
 * Callers must supply a dedicated high-entropy secret that is not an auth or
 * provider credential. The request ID is authenticated as AES-GCM AAD, so a
 * ciphertext cannot be moved to another deletion request.
 */
export function encryptAccountDeletionDestination(input: {
  requestId: string;
  destination: string;
  encryptionSecret: string | Uint8Array;
}): AccountDeletionEncryptedDestination {
  const requestId = assertRequestId(input.requestId);
  const destination = assertEmailAddress(input.destination, "Account deletion notification destination");
  const key = deriveDestinationKey(input.encryptionSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(destinationAad(requestId));
  const ciphertext = Buffer.concat([
    cipher.update(destination, "utf8"),
    cipher.final(),
  ]);

  return {
    version: DESTINATION_CIPHER_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptAccountDeletionDestination(input: {
  requestId: string;
  encryptedDestination: AccountDeletionEncryptedDestination;
  encryptionSecret: string | Uint8Array;
}): string {
  const requestId = assertRequestId(input.requestId);
  const encrypted = input.encryptedDestination;
  if (
    encrypted.version !== DESTINATION_CIPHER_VERSION
    || encrypted.algorithm !== "aes-256-gcm"
  ) {
    throw new AccountDeletionNotificationError(
      "Encrypted account deletion destination version is unsupported.",
      "permanent",
    );
  }

  const iv = decodeBase64Url(encrypted.iv, "IV");
  const ciphertext = decodeBase64Url(encrypted.ciphertext, "ciphertext");
  const authTag = decodeBase64Url(encrypted.authTag, "authentication tag");
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new AccountDeletionNotificationError(
      "Encrypted account deletion destination is malformed.",
      "permanent",
    );
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveDestinationKey(input.encryptionSecret),
      iv,
    );
    decipher.setAAD(destinationAad(requestId));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return assertEmailAddress(plaintext, "Decrypted account deletion notification destination");
  } catch (error) {
    if (error instanceof AccountDeletionNotificationError) throw error;
    throw new AccountDeletionNotificationError(
      "Encrypted account deletion destination could not be authenticated.",
      "permanent",
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildAccountDeletionCompletionMessage(input: {
  requestId: string;
  destination: string;
  from: string;
  replyTo?: string | undefined;
  publicBaseUrl: string;
  supportEmail: string;
}): AccountDeletionNotificationMessage {
  const requestId = assertRequestId(input.requestId);
  const destination = assertEmailAddress(input.destination, "Account deletion notification destination");
  const from = assertMailFrom(input.from);
  const replyTo = input.replyTo
    ? assertEmailAddress(input.replyTo, "Account deletion notification reply address")
    : undefined;
  const supportEmail = assertEmailAddress(input.supportEmail, "Account deletion support address");
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
    `<p>Deletion request reference: <strong>${escapeHtml(requestId)}</strong></p>`,
    '<hr style="margin:24px 0 16px; border:0; border-top:1px solid #CBD5E1;">',
    `<p><a href="mailto:${escapeHtml(supportEmail)}">Support</a> · `,
    `<a href="${escapeHtml(termsUrl)}">Terms</a> · `,
    `<a href="${escapeHtml(privacyUrl)}">Privacy</a></p>`,
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

function errorOutcomeForHttpStatus(
  status: number,
  body: Record<string, unknown>,
): AccountDeletionNotificationErrorOutcome {
  if (status === 409) {
    const errorName = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    if (errorName === "invalid_idempotent_request") return "idempotency_conflict";
    if (errorName === "concurrent_idempotent_requests") return "retryable";
    // A generic conflict does not prove whether the original request was
    // accepted. Keep the same payload and idempotency key inside its window.
    return "uncertain";
  }
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "retryable"
    : "permanent";
}

function responseRecord(responseText: string): Record<string, unknown> {
  if (!responseText) return {};
  try {
    const parsed: unknown = JSON.parse(responseText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function fetchResponseText(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  operation: "send" | "status";
}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      ...input.init,
      signal: controller.signal,
    });
    const responseText = await response.text();
    return { response, body: responseRecord(responseText) };
  } catch {
    throw new AccountDeletionNotificationError(
      input.operation === "send"
        ? "Resend account deletion notification outcome is uncertain."
        : "Resend account deletion notification status could not be confirmed.",
      input.operation === "send" ? "uncertain" : "retryable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function mapResendAccountDeletionLastEvent(
  lastEvent: unknown,
): Pick<AccountDeletionNotificationStatus, "lastEvent" | "deliveryStatus"> {
  if (typeof lastEvent !== "string" || !lastEvent.trim()) {
    return { lastEvent: null, deliveryStatus: "unknown" };
  }
  const normalized = lastEvent.trim().toLowerCase();
  if (["delivered", "opened", "clicked", "complained"].includes(normalized)) {
    return { lastEvent: normalized, deliveryStatus: "delivered" };
  }
  if (["bounced", "failed", "suppressed", "canceled", "cancelled"].includes(normalized)) {
    return { lastEvent: normalized, deliveryStatus: "failed" };
  }
  if (["scheduled", "queued", "sent", "delivery_delayed"].includes(normalized)) {
    return { lastEvent: normalized, deliveryStatus: "pending" };
  }
  return { lastEvent: normalized, deliveryStatus: "unknown" };
}

export function createResendAccountDeletionNotificationProvider(input: {
  apiKey: string;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}): AccountDeletionNotificationProvider {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new AccountDeletionNotificationError(
      "Resend API key is required for account deletion notifications.",
      "permanent",
    );
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AccountDeletionNotificationError(
      "Account deletion notification timeout must be positive.",
      "permanent",
    );
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    mode: "resend",
    async send(message) {
      const requestId = assertRequestId(message.requestId);
      const result = await fetchResponseText({
        fetchImpl,
        url: RESEND_EMAIL_ENDPOINT,
        timeoutMs,
        operation: "send",
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "Idempotency-Key": `pintpath-account-deletion/${requestId}`,
            "user-agent": "PintPath/1.0 (+https://pintpath.au)",
          },
          body: serializeResendAccountDeletionRequest(message),
        },
      });

      if (!result.response.ok) {
        throw new AccountDeletionNotificationError(
          `Resend account deletion notification send failed with HTTP ${result.response.status}.`,
          errorOutcomeForHttpStatus(result.response.status, result.body),
          result.response.status,
        );
      }
      if (typeof result.body.id !== "string" || !result.body.id.trim()) {
        throw new AccountDeletionNotificationError(
          "Resend accepted the account deletion notification without returning a provider ID.",
          "uncertain",
          result.response.status,
        );
      }
      return { id: result.body.id.trim() };
    },
  };
}

export function createMockAccountDeletionNotificationProvider(): AccountDeletionNotificationProvider {
  const sentIds = new Set<string>();
  return {
    mode: "mock",
    async send(message) {
      const requestId = assertRequestId(message.requestId);
      const id = `mock-${crypto
        .createHash("sha256")
        .update(`pintpath-account-deletion/${requestId}`)
        .digest("hex")
        .slice(0, 20)}`;
      sentIds.add(id);
      return { id };
    },
    async getStatus(providerId) {
      const id = assertProviderId(providerId);
      return sentIds.has(id)
        ? { providerId: id, lastEvent: "delivered", deliveryStatus: "delivered" }
        : { providerId: id, lastEvent: null, deliveryStatus: "unknown" };
    },
  };
}
