import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  AccountDeletionNotificationError,
  type AccountDeletionNotificationMessage,
  type AccountDeletionNotificationProvider,
  serializeResendAccountDeletionRequest,
} from "../src/lib/account-deletion-notification.js";
import {
  ACCOUNT_DELETION_NOTICE_IDEMPOTENCY_WINDOW_HOURS,
  ACCOUNT_DELETION_NOTICE_TEMPLATE_V1,
  ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS,
  AccountDeletionNotificationCoordinator,
  parseAccountDeletionNotificationKeyring,
} from "../src/lib/account-deletion-notification-worker.js";

const NOW = "2026-08-03T10:00:00.000Z";
const ACTIVE_KEY_ID = "deletion-key-2026-08";
const ACTIVE_KEY = Buffer.alloc(32, 0x41);
const RETIRED_KEY = Buffer.alloc(32, 0x42);
const RECIPIENT = "deletion-recipient@example.com";

const openDatabases: BetterSqlite3.Database[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (openDatabases.length > 0) openDatabases.pop()!.close();
  while (temporaryRoots.length > 0) fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function isoAfterMinutes(value: string, minutes: number): string {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

function validKeyringJson(): string {
  return JSON.stringify({
    [ACTIVE_KEY_ID]: ACTIVE_KEY.toString("base64"),
    "deletion-key-retired": RETIRED_KEY.toString("base64"),
  });
}

function defaultProvider(): AccountDeletionNotificationProvider {
  return {
    mode: "resend",
    send: vi.fn(async () => ({ id: "resend-deletion-message" })),
    getStatus: vi.fn(async (providerId) => ({
      providerId,
      lastEvent: "delivered",
      deliveryStatus: "delivered",
    })),
  };
}

function createHarness(provider: AccountDeletionNotificationProvider = defaultProvider()) {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  openDatabases.push(database);
  const repository = new BusinessRepository(database);
  const coordinator = new AccountDeletionNotificationCoordinator(repository, {
    provider,
    keyring: parseAccountDeletionNotificationKeyring({
      activeKeyId: ACTIVE_KEY_ID,
      keyringJson: validKeyringJson(),
    }),
    publicBaseUrl: "https://pintpath.au",
    from: "Pint Path <account@pintpath.au>",
    replyTo: "admin@pintpath.au",
    supportEmail: "admin@pintpath.au",
  });
  return { database, repository, coordinator, provider };
}

function createDeletionFixture(
  harness: ReturnType<typeof createHarness>,
  suffix: string,
) {
  const user = harness.repository.createAccount({
    id: `deletion-user-${suffix}`,
    email: RECIPIENT,
    passwordHash: "test-password-hash",
    role: "user",
    subscriptionStatus: "free",
    now: NOW,
  });
  const admin = harness.repository.createAccount({
    id: `deletion-admin-${suffix}`,
    email: `deletion-admin-${suffix}@example.com`,
    passwordHash: "test-password-hash",
    role: "admin",
    subscriptionStatus: "admin",
    now: NOW,
  });
  const request = harness.repository.createAccountDeletionRequest({
    id: `delete-request-${suffix}`,
    userId: user.id,
    userMessage: "Delete this account.",
    requestedAt: isoAfterMinutes(NOW, -8 * 24 * 60),
    executeAfter: isoAfterMinutes(NOW, -24 * 60),
  });
  return { user, admin, requestId: String(request.id) };
}

function operatorAudit(
  fixture: ReturnType<typeof createDeletionFixture>,
  id: string,
  reason = "Operator verified the provider outcome.",
) {
  return {
    id,
    actorUserId: fixture.admin.id,
    actorRole: fixture.admin.role,
    reason,
  };
}

function prepareHeldNotification(
  harness: ReturnType<typeof createHarness>,
  fixture: ReturnType<typeof createDeletionFixture>,
  now = NOW,
) {
  return harness.coordinator.beginDeletionWithPreparedNotification({
    requestId: fixture.requestId,
    reviewedBy: fixture.admin.id,
    destination: fixture.user.email,
    now,
    staleBefore: isoAfterMinutes(now, -10),
  });
}

function activateNotification(
  harness: ReturnType<typeof createHarness>,
  fixture: ReturnType<typeof createDeletionFixture>,
  completedAt = NOW,
) {
  const processing = prepareHeldNotification(harness, fixture, completedAt);
  expect(processing).toEqual(expect.objectContaining({ status: "processing" }));
  harness.repository.executeAccountAnonymisation({
    requestId: fixture.requestId,
    reviewedBy: fixture.admin.id,
    now: completedAt,
    completionNotificationDisposition: "enqueue_live",
    completionNotificationRetentionExpiresAt:
      harness.coordinator.completionRetentionExpiresAt(completedAt),
  });
}

function acceptedNotificationHarness() {
  const send = vi.fn(async () => ({ id: "resend-webhook-message" }));
  const getStatus = vi.fn(async (providerId: string) => ({
    providerId,
    lastEvent: "sent",
    deliveryStatus: "pending" as const,
  }));
  const provider: AccountDeletionNotificationProvider = { mode: "resend", send, getStatus };
  const harness = createHarness(provider);
  const fixture = createDeletionFixture(harness, "webhook");
  activateNotification(harness, fixture);
  return { ...harness, fixture, send, getStatus };
}

function signedWebhook(input: {
  eventId: string;
  type: string;
  createdAt: string;
  providerMessageId: string;
  receivedAt: string;
  signingSecretBytes?: Buffer;
  messageType?: string;
}) {
  const signingSecretBytes = input.signingSecretBytes ?? Buffer.alloc(32, 0x71);
  const timestamp = String(Math.floor(new Date(input.receivedAt).getTime() / 1000));
  const rawBody = Buffer.from(JSON.stringify({
    type: input.type,
    created_at: input.createdAt,
    data: {
      email_id: input.providerMessageId,
      tags: { message_type: input.messageType ?? "account_deletion_completion" },
    },
  }), "utf8");
  const signature = crypto
    .createHmac("sha256", signingSecretBytes)
    .update(`${input.eventId}.${timestamp}.`, "utf8")
    .update(rawBody)
    .digest("base64");
  return {
    rawBody,
    headers: {
      id: input.eventId,
      timestamp,
      signature: `v1,${signature}`,
    },
    signingSecret: `whsec_${signingSecretBytes.toString("base64")}`,
    now: new Date(input.receivedAt),
  };
}

describe("account deletion notification keyring", () => {
  it("parses a bounded rotation keyring and requires the active 32-byte key", () => {
    const keyring = parseAccountDeletionNotificationKeyring({
      activeKeyId: ` ${ACTIVE_KEY_ID} `,
      keyringJson: validKeyringJson(),
    });

    expect(keyring.activeKeyId).toBe(ACTIVE_KEY_ID);
    expect(keyring.keys.size).toBe(2);
    expect(keyring.keys.get(ACTIVE_KEY_ID)).toEqual(ACTIVE_KEY);
    expect(() => parseAccountDeletionNotificationKeyring({
      activeKeyId: "missing-key",
      keyringJson: validKeyringJson(),
    })).toThrow("is not present");
    expect(() => parseAccountDeletionNotificationKeyring({
      activeKeyId: ACTIVE_KEY_ID,
      keyringJson: JSON.stringify({ [ACTIVE_KEY_ID]: Buffer.alloc(31).toString("base64") }),
    })).toThrow("exactly 32 bytes");
    expect(() => parseAccountDeletionNotificationKeyring({
      activeKeyId: ACTIVE_KEY_ID,
      keyringJson: "not-json",
    })).toThrow("must be valid JSON");
  });
});

describe("account deletion notification preparation and activation", () => {
  it("atomically claims deletion with a held encrypted secret and stores no plaintext destination in notification rows", () => {
    const harness = createHarness();
    const fixture = createDeletionFixture(harness, "held");

    const processing = prepareHeldNotification(harness, fixture);

    expect(processing).toEqual(expect.objectContaining({ status: "processing" }));
    const outbox = harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId);
    const recipient = harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId);
    expect(outbox).toEqual(expect.objectContaining({
      request_id: fixture.requestId,
      status: "held",
      attempt_count: 0,
      next_attempt_at: null,
      retention_expires_at: null,
    }));
    expect(outbox).not.toHaveProperty("recipient_email");
    expect(recipient).toEqual(expect.objectContaining({
      request_id: fixture.requestId,
      key_id: ACTIVE_KEY_ID,
      nonce: expect.any(Buffer),
      ciphertext: expect.any(Buffer),
      auth_tag: expect.any(Buffer),
    }));
    const notificationStorage = JSON.stringify({
      outbox,
      recipient: recipient && {
        ...recipient,
        nonce: recipient.nonce.toString("base64"),
        ciphertext: recipient.ciphertext.toString("base64"),
        authTag: recipient.auth_tag.toString("base64"),
      },
    });
    expect(notificationStorage).not.toContain(RECIPIENT);
    expect(prepareHeldNotification(harness, fixture)).toBeNull();
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_completion_outbox WHERE request_id = ?",
    ).get(fixture.requestId)).toEqual({ count: 1 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets WHERE request_id = ?",
    ).get(fixture.requestId)).toEqual({ count: 1 });
  });

  it("keeps held work unclaimable and requires durable preparation inside the anonymisation transaction", async () => {
    const missing = createHarness();
    const missingFixture = createDeletionFixture(missing, "missing-activation");
    expect(missing.repository.beginAccountDeletion({
      requestId: missingFixture.requestId,
      reviewedBy: missingFixture.admin.id,
      now: NOW,
      staleBefore: isoAfterMinutes(NOW, -10),
    })).toBeTruthy();

    expect(() => missing.repository.executeAccountAnonymisation({
      requestId: missingFixture.requestId,
      reviewedBy: missingFixture.admin.id,
      now: NOW,
      completionNotificationDisposition: "enqueue_live",
      completionNotificationRetentionExpiresAt:
        missing.coordinator.completionRetentionExpiresAt(NOW),
    })).toThrow("was not durably prepared before anonymisation");
    expect(missing.repository.getAccountById(missingFixture.user.id)).toEqual(expect.objectContaining({
      email: RECIPIENT,
      status: "active",
    }));
    expect(missing.repository.getAccountDeletionRequestById(missingFixture.requestId)).toEqual(
      expect.objectContaining({ status: "processing" }),
    );

    const held = createHarness();
    const heldFixture = createDeletionFixture(held, "held-activation");
    expect(prepareHeldNotification(held, heldFixture)).toBeTruthy();
    await expect(held.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({ claimed: 0 });

    held.repository.executeAccountAnonymisation({
      requestId: heldFixture.requestId,
      reviewedBy: heldFixture.admin.id,
      now: NOW,
      completionNotificationDisposition: "enqueue_live",
      completionNotificationRetentionExpiresAt: held.coordinator.completionRetentionExpiresAt(NOW),
    });
    expect(held.repository.getAccountDeletionCompletionOutbox(heldFixture.requestId)).toEqual(
      expect.objectContaining({
        status: "pending",
        completed_at: NOW,
        next_attempt_at: NOW,
        retention_expires_at: held.coordinator.completionRetentionExpiresAt(NOW),
      }),
    );
  });
});

describe("account deletion completion notification worker", () => {
  it("keeps the released v1 message snapshot, provider body, and fingerprint immutable", async () => {
    const send = vi.fn(async (_message: AccountDeletionNotificationMessage) => ({
      id: "resend-template-v1-message",
    }));
    const harness = createHarness({ mode: "resend", send });
    const fixture = createDeletionFixture(harness, "template-v1");
    activateNotification(harness, fixture);

    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({ template_version: ACCOUNT_DELETION_NOTICE_TEMPLATE_V1 }));
    await expect(harness.coordinator.processDue({ now: new Date(NOW) }))
      .resolves.toMatchObject({ accepted: 1 });

    const expectedText = [
      "Your Pint Path account deletion is complete.",
      "",
      "We have completed your account deletion request. You can no longer sign in with the deleted account.",
      "Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.",
      "",
      "Deletion request reference: delete-request-template-v1",
      "Support: admin@pintpath.au",
      "Terms: https://pintpath.au/terms.html",
      "Privacy: https://pintpath.au/privacy.html",
    ].join("\n");
    const expectedHtml = [
      "<h1>Your Pint Path account deletion is complete</h1>",
      "<p>We have completed your account deletion request. You can no longer sign in with the deleted account.</p>",
      "<p>Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.</p>",
      "<p>Deletion request reference: <strong>delete-request-template-v1</strong></p>",
      '<hr style="margin:24px 0 16px; border:0; border-top:1px solid #CBD5E1;">',
      '<p><a href="mailto:admin@pintpath.au">Support</a> · ',
      '<a href="https://pintpath.au/terms.html">Terms</a> · ',
      '<a href="https://pintpath.au/privacy.html">Privacy</a></p>',
    ].join("");
    const expectedMessage = {
      requestId: "delete-request-template-v1",
      from: "Pint Path <account@pintpath.au>",
      to: RECIPIENT,
      replyTo: "admin@pintpath.au",
      subject: "Your Pint Path account deletion is complete",
      text: expectedText,
      html: expectedHtml,
    } satisfies AccountDeletionNotificationMessage;
    const message = send.mock.calls[0]![0];
    expect(message).toStrictEqual(expectedMessage);

    // Released v1 golden: any intentional byte change requires a new template
    // version and dispatcher branch rather than updating this expectation.
    const expectedProviderBody = [
      '{"from":"Pint Path <account@pintpath.au>",',
      '"to":["deletion-recipient@example.com"],',
      '"reply_to":"admin@pintpath.au",',
      '"subject":"Your Pint Path account deletion is complete",',
      '"text":"Your Pint Path account deletion is complete.\\n\\n',
      'We have completed your account deletion request. You can no longer sign in with the deleted account.\\n',
      'Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.\\n\\n',
      'Deletion request reference: delete-request-template-v1\\n',
      'Support: admin@pintpath.au\\n',
      'Terms: https://pintpath.au/terms.html\\n',
      'Privacy: https://pintpath.au/privacy.html",',
      '"html":"<h1>Your Pint Path account deletion is complete</h1>',
      '<p>We have completed your account deletion request. You can no longer sign in with the deleted account.</p>',
      '<p>Some records may be retained where required by law or for security, fraud prevention, dispute resolution, and legal compliance, as described in our Privacy Policy.</p>',
      '<p>Deletion request reference: <strong>delete-request-template-v1</strong></p>',
      '<hr style=\\"margin:24px 0 16px; border:0; border-top:1px solid #CBD5E1;\\">',
      '<p><a href=\\"mailto:admin@pintpath.au\\">Support</a> · ',
      '<a href=\\"https://pintpath.au/terms.html\\">Terms</a> · ',
      '<a href=\\"https://pintpath.au/privacy.html\\">Privacy</a></p>",',
      '"tags":[{"name":"message_type","value":"account_deletion_completion"}]}',
    ].join("");
    expect(serializeResendAccountDeletionRequest(message)).toBe(expectedProviderBody);
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({
        template_version: "account-deletion-complete-v1",
        idempotency_key: "pintpath-account-deletion/delete-request-template-v1",
        payload_fingerprint: "ae237173ca01a45715d6ac6a62b9b2e6f248381598300b83468b65d22b619208",
      }));
  });

  it("moves an unsupported future template version to manual review without sending", async () => {
    const send = vi.fn(async (_message: AccountDeletionNotificationMessage) => ({
      id: "must-not-send-unsupported-template",
    }));
    const harness = createHarness({ mode: "resend", send });
    const fixture = createDeletionFixture(harness, "unsupported-template");
    activateNotification(harness, fixture);
    harness.database.prepare(`
      UPDATE account_deletion_completion_outbox
         SET template_version = ?
       WHERE request_id = ?
    `).run("account-deletion-complete-v2", fixture.requestId);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({
      claimed: 1,
      accepted: 0,
      manualReview: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({
        status: "manual_review",
        payload_fingerprint: null,
        last_error: "Unsupported account deletion notification template: account-deletion-complete-v2",
      }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
  });

  it("sends once, records provider acceptance, polls delivery, and purges the encrypted destination", async () => {
    const send = vi.fn(async () => ({ id: "resend-delivery-accepted" }));
    const getStatus = vi.fn(async (providerId: string) => ({
      providerId,
      lastEvent: "delivered",
      deliveryStatus: "delivered" as const,
    }));
    const harness = createHarness({ mode: "resend", send, getStatus });
    const fixture = createDeletionFixture(harness, "delivery");
    activateNotification(harness, fixture);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toEqual({
      claimed: 1,
      accepted: 1,
      delivered: 0,
      deferred: 0,
      failed: 0,
      manualReview: 0,
      recipientsPurged: 0,
      securePurgeCheckpointPendingCount: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      requestId: fixture.requestId,
      to: RECIPIENT,
      subject: expect.stringContaining("deletion is complete"),
    }));
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "accepted",
        provider_message_id: "resend-delivery-accepted",
        payload_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        accepted_at: NOW,
        next_attempt_at: isoAfterMinutes(NOW, 15),
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();

    const pollAt = isoAfterMinutes(NOW, 15);
    await expect(harness.coordinator.processDue({ now: new Date(pollAt) })).resolves.toMatchObject({
      claimed: 1,
      accepted: 0,
      delivered: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith("resend-delivery-accepted");
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "delivered",
        provider_last_event: "delivered",
        delivered_at: pollAt,
        terminal_at: pollAt,
        next_attempt_at: null,
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).toBeNull();
  });

  it("allows only one overlapping worker to claim and send a notification", async () => {
    let releaseSend!: (value: { id: string }) => void;
    const send = vi.fn(() => new Promise<{ id: string }>((resolve) => { releaseSend = resolve; }));
    const provider: AccountDeletionNotificationProvider = {
      mode: "resend",
      send,
      getStatus: vi.fn(async (providerId) => ({
        providerId,
        lastEvent: "sent",
        deliveryStatus: "pending",
      })),
    };
    const harness = createHarness(provider);
    const fixture = createDeletionFixture(harness, "overlap");
    activateNotification(harness, fixture);

    const firstWorker = harness.coordinator.processDue({ now: new Date(NOW) });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const secondWorker = await harness.coordinator.processDue({ now: new Date(NOW) });

    expect(secondWorker).toMatchObject({ claimed: 0, accepted: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    releaseSend({ id: "resend-overlap-message" });
    await expect(firstWorker).resolves.toMatchObject({ claimed: 1, accepted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses a sending-only provider and waits for a signed webhook instead of polling", async () => {
    const send = vi.fn(async () => ({ id: "resend-webhook-only-message" }));
    const harness = createHarness({ mode: "resend", send });
    const fixture = createDeletionFixture(harness, "webhook-only");
    activateNotification(harness, fixture);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({
      accepted: 1,
      delivered: 0,
    });
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "accepted",
        next_attempt_at: isoAfterMinutes(NOW, ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS * 60),
      }),
    );

    const deliveredAt = isoAfterMinutes(NOW, 2);
    const result = harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-only-delivered",
      type: "email.delivered",
      createdAt: deliveredAt,
      providerMessageId: "resend-webhook-only-message",
      receivedAt: deliveredAt,
    }));
    expect(result).toEqual({ received: true, duplicate: false, matched: true });
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).toBeNull();
  });

  it("retains the encrypted recipient for review when no signed delivery webhook arrives", async () => {
    const harness = createHarness({
      mode: "resend",
      send: vi.fn(async () => ({ id: "resend-no-webhook-message" })),
    });
    const fixture = createDeletionFixture(harness, "no-webhook");
    activateNotification(harness, fixture);
    await harness.coordinator.processDue({ now: new Date(NOW) });

    const reviewAt = isoAfterMinutes(NOW, ACCOUNT_DELETION_NOTICE_WEBHOOK_GRACE_HOURS * 60);
    await expect(harness.coordinator.processDue({ now: new Date(reviewAt) })).resolves.toMatchObject({
      manualReview: 1,
    });
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({ status: "manual_review", next_attempt_at: null }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
  });

  it("retains and permits an audited-safe reset after a confirmed pre-acceptance failure", async () => {
    const harness = createHarness({
      mode: "resend",
      send: vi.fn(async () => {
        throw new AccountDeletionNotificationError("Provider rejected the request.", "permanent", 422);
      }),
    });
    const fixture = createDeletionFixture(harness, "confirmed-failure");
    activateNotification(harness, fixture);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({ failed: 1 });
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
    expect(harness.repository.retryFailedAccountDeletionNotification({
      requestId: fixture.requestId,
      now: isoAfterMinutes(NOW, 1),
      audit: operatorAudit(fixture, "audit-confirmed-failure-retry", "Provider configuration was corrected."),
    })).toEqual(expect.objectContaining({ status: "pending", first_attempt_at: null }));
    expect(harness.repository.listSecurityAuditLogs({
      action: "account_deletion_notification_retry_authorized",
    })).toEqual([
      expect.objectContaining({
        id: "audit-confirmed-failure-retry",
        actorUserId: fixture.admin.id,
        targetId: fixture.requestId,
        metadata: { reason: "Provider configuration was corrected." },
      }),
    ]);
  });

  it("rolls back retry authorization when its audit row cannot be written", async () => {
    const harness = createHarness({
      mode: "resend",
      send: vi.fn(async () => {
        throw new AccountDeletionNotificationError("Provider rejected the request.", "permanent", 422);
      }),
    });
    const fixture = createDeletionFixture(harness, "retry-audit-rollback");
    activateNotification(harness, fixture);
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const before = harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId);
    const duplicateAuditId = "duplicate-retry-audit-id";
    harness.repository.insertSecurityAuditLog({
      id: duplicateAuditId,
      actorUserId: fixture.admin.id,
      actorRole: fixture.admin.role,
      action: "unrelated_existing_audit",
      targetType: "account_deletion_request",
      targetId: fixture.requestId,
      metadata: {},
      ipHash: null,
      userAgentHash: null,
      createdAt: NOW,
    });

    expect(() => harness.repository.retryFailedAccountDeletionNotification({
      requestId: fixture.requestId,
      now: isoAfterMinutes(NOW, 1),
      audit: operatorAudit(fixture, duplicateAuditId, "Provider configuration was corrected."),
    })).toThrow();
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(before);
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
    expect(harness.repository.countSecurityAuditLogs({
      action: "account_deletion_notification_retry_authorized",
    })).toBe(0);
  });

  it("blocks automatic retry when Resend reports a changed-payload idempotency conflict", async () => {
    const harness = createHarness({
      mode: "resend",
      send: vi.fn(async () => {
        throw new AccountDeletionNotificationError(
          "Provider idempotency key is bound to another payload.",
          "idempotency_conflict",
          409,
        );
      }),
    });
    const fixture = createDeletionFixture(harness, "idempotency-conflict");
    activateNotification(harness, fixture);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) }))
      .resolves.toMatchObject({ failed: 0, manualReview: 1 });
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({
        status: "manual_review",
        provider_last_event: "invalid_idempotent_request",
        payload_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
    expect(harness.repository.retryFailedAccountDeletionNotification({
      requestId: fixture.requestId,
      now: isoAfterMinutes(NOW, 1),
      audit: operatorAudit(fixture, "audit-blocked-idempotency-retry"),
    })).toBeNull();
  });

  it("moves a retry to manual review if the exact provider payload changes", async () => {
    const firstSend = vi.fn(async () => {
      throw new AccountDeletionNotificationError("Provider outcome unknown.", "uncertain");
    });
    const harness = createHarness({ mode: "resend", send: firstSend });
    const fixture = createDeletionFixture(harness, "payload-drift");
    activateNotification(harness, fixture);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({
      deferred: 1,
    });
    const lockedFingerprint = harness.repository
      .getAccountDeletionCompletionOutbox(fixture.requestId)?.payload_fingerprint;
    expect(lockedFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const secondSend = vi.fn(async () => ({ id: "must-not-send-after-drift" }));
    const changedCoordinator = new AccountDeletionNotificationCoordinator(harness.repository, {
      provider: { mode: "resend", send: secondSend },
      keyring: parseAccountDeletionNotificationKeyring({
        activeKeyId: ACTIVE_KEY_ID,
        keyringJson: validKeyringJson(),
      }),
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <changed-account@pintpath.au>",
      replyTo: "admin@pintpath.au",
      supportEmail: "admin@pintpath.au",
    });
    await expect(changedCoordinator.processDue({ now: new Date(isoAfterMinutes(NOW, 5)) }))
      .resolves.toMatchObject({ manualReview: 1 });
    expect(secondSend).not.toHaveBeenCalled();
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "manual_review",
        payload_fingerprint: lockedFingerprint,
        last_error: expect.stringContaining("payload changed"),
      }),
    );
  });

  it("re-prepares a held destination purged before an interrupted deletion completed", () => {
    const harness = createHarness();
    const fixture = createDeletionFixture(harness, "held-purge-retry");
    expect(prepareHeldNotification(harness, fixture)).toBeTruthy();
    const retryAt = isoAfterMinutes(NOW, 61 * 24 * 60);
    expect(harness.repository.purgeExpiredAccountDeletionNotificationRecipients(retryAt)).toBe(1);
    harness.repository.failAccountDeletion({
      requestId: fixture.requestId,
      error: "Interrupted before anonymisation.",
      now: retryAt,
    });

    expect(prepareHeldNotification(harness, fixture, isoAfterMinutes(retryAt, 1)))
      .toEqual(expect.objectContaining({ status: "processing" }));
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({ status: "held", completed_at: null }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).not.toBeNull();
  });

  it("does not clear a newer purge generation created by another database connection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-deletion-checkpoint-race-"));
    temporaryRoots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const database = new BetterSqlite3(databasePath);
    initializeDatabaseSchema(database);
    const secondDatabase = new BetterSqlite3(databasePath);
    secondDatabase.pragma("foreign_keys = ON");
    secondDatabase.pragma("journal_mode = WAL");
    secondDatabase.pragma("secure_delete = ON");
    openDatabases.push(database, secondDatabase);
    const repository = new BusinessRepository(database);
    const secondRepository = new BusinessRepository(secondDatabase);
    const coordinator = new AccountDeletionNotificationCoordinator(repository, {
      provider: defaultProvider(),
      keyring: parseAccountDeletionNotificationKeyring({
        activeKeyId: ACTIVE_KEY_ID,
        keyringJson: validKeyringJson(),
      }),
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <account@pintpath.au>",
      replyTo: "admin@pintpath.au",
      supportEmail: "admin@pintpath.au",
    });
    const harness = { database, repository, coordinator, provider: defaultProvider() };
    const fixture = createDeletionFixture(harness, "checkpoint-race");
    expect(prepareHeldNotification(harness, fixture)).toBeTruthy();
    const firstPurgeAt = isoAfterMinutes(NOW, 61 * 24 * 60);
    expect(repository.purgeExpiredAccountDeletionNotificationRecipients(firstPurgeAt)).toBe(1);
    repository.failAccountDeletion({
      requestId: fixture.requestId,
      error: "Interrupted before anonymisation.",
      now: firstPurgeAt,
    });
    expect(prepareHeldNotification(harness, fixture, isoAfterMinutes(firstPurgeAt, 1))).toBeTruthy();
    expect(repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({
        secret_purge_checkpoint_pending: 1,
        secret_purge_generation: 1,
      }));

    const originalPragma = database.pragma.bind(database);
    const secondPurgeAt = isoAfterMinutes(NOW, 122 * 24 * 60);
    const pragmaSpy = vi.spyOn(database, "pragma").mockImplementation(((source: string) => {
      const result = originalPragma(source);
      expect(secondRepository.purgeExpiredAccountDeletionNotificationRecipients(secondPurgeAt)).toBe(1);
      return result;
    }) as typeof database.pragma);

    expect(repository.checkpointAccountDeletionNotificationSecrets()).toBe(true);
    expect(repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({
        secret_purge_checkpoint_pending: 1,
        secret_purge_generation: 2,
      }));
    pragmaSpy.mockRestore();
    expect(repository.checkpointAccountDeletionNotificationSecrets()).toBe(true);
    expect(repository.getAccountDeletionNotificationQueueSummary(secondPurgeAt)
      .securePurgeCheckpointPendingCount).toBe(0);
  });

  it("moves an unreconciled stale send beyond the 23-hour idempotency window to manual review", async () => {
    const send = vi.fn(async () => ({ id: "must-not-send" }));
    const provider: AccountDeletionNotificationProvider = {
      mode: "resend",
      send,
      getStatus: vi.fn(),
    };
    const harness = createHarness(provider);
    const fixture = createDeletionFixture(harness, "stale-uncertain");
    activateNotification(harness, fixture);
    const staleAt = isoAfterMinutes(
      NOW,
      -(ACCOUNT_DELETION_NOTICE_IDEMPOTENCY_WINDOW_HOURS * 60 + 1),
    );
    harness.database.prepare(
      `UPDATE account_deletion_completion_outbox
          SET status = 'sending', first_attempt_at = ?, next_attempt_at = ?,
              lease_token = 'crashed-worker', lease_expires_at = ?,
              last_error = 'Resend outcome was uncertain.'
        WHERE request_id = ?`,
    ).run(staleAt, staleAt, isoAfterMinutes(NOW, -1), fixture.requestId);

    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({
      claimed: 1,
      accepted: 0,
      manualReview: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "manual_review",
        next_attempt_at: null,
        lease_token: null,
        last_error: expect.stringContaining("idempotency window"),
      }),
    );
  });

  it("purges an encrypted recipient at its retention boundary without sending", async () => {
    const send = vi.fn(async () => ({ id: "must-not-send" }));
    const provider: AccountDeletionNotificationProvider = {
      mode: "resend",
      send,
      getStatus: vi.fn(),
    };
    const harness = createHarness(provider);
    const fixture = createDeletionFixture(harness, "retention");
    activateNotification(harness, fixture);
    const purgeAt = harness.coordinator.completionRetentionExpiresAt(NOW);
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(purgeAt)
      .overdueRetentionCount).toBe(1);

    await expect(harness.coordinator.processDue({ now: new Date(purgeAt) })).resolves.toMatchObject({
      claimed: 0,
      recipientsPurged: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).toBeNull();
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "purged",
        terminal_at: purgeAt,
        next_attempt_at: null,
        last_error: expect.stringContaining("retention limit"),
      }),
    );
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(purgeAt)
      .overdueRetentionCount).toBe(0);
    expect(harness.repository.resolveAccountDeletionNotificationManualReview({
      requestId: fixture.requestId,
      resolution: "verified_delivered",
      now: isoAfterMinutes(purgeAt, 1),
      audit: operatorAudit(fixture, "audit-retention-delivered-resolution"),
    })).toBeNull();
    expect(harness.repository.resolveAccountDeletionNotificationManualReview({
      requestId: fixture.requestId,
      resolution: "undeliverable",
      now: isoAfterMinutes(purgeAt, 2),
      audit: operatorAudit(fixture, "audit-retention-undeliverable-resolution"),
    })).toEqual(expect.objectContaining({
      status: "failed",
      provider_last_event: "operator_resolved_undeliverable",
    }));
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(isoAfterMinutes(purgeAt, 2))
      .manualReviewCount).toBe(0);
  });

  it("allows a retention-expired confirmed failure to be terminally acknowledged", async () => {
    const harness = createHarness({
      mode: "resend",
      send: vi.fn(async () => {
        throw new AccountDeletionNotificationError("Provider rejected the request.", "permanent", 422);
      }),
    });
    const fixture = createDeletionFixture(harness, "failed-retention-resolution");
    activateNotification(harness, fixture);
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const purgeAt = harness.coordinator.completionRetentionExpiresAt(NOW);
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(purgeAt)
      .overdueRetentionCount).toBe(1);
    expect(harness.repository.purgeExpiredAccountDeletionNotificationRecipients(purgeAt)).toBe(1);
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(purgeAt)
      .overdueRetentionCount).toBe(0);
    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId))
      .toEqual(expect.objectContaining({ status: "failed", provider_message_id: null }));

    expect(harness.repository.resolveAccountDeletionNotificationManualReview({
      requestId: fixture.requestId,
      resolution: "undeliverable",
      now: isoAfterMinutes(purgeAt, 1),
      audit: operatorAudit(fixture, "audit-failed-retention-resolution"),
    })).toEqual(expect.objectContaining({
      status: "failed",
      provider_last_event: "operator_resolved_undeliverable",
    }));
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(isoAfterMinutes(purgeAt, 1))
      .manualReviewCount).toBe(0);
  });
});

describe("account deletion completion Resend webhooks", () => {
  it("rejects a signed event with an invalid provider timestamp as a bad request", () => {
    const harness = createHarness();
    expect(() => harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-invalid-created-at",
      type: "email.delivered",
      createdAt: "not-an-iso-timestamp",
      providerMessageId: "resend-webhook-message",
      receivedAt: NOW,
    }))).toThrow(expect.objectContaining({
      message: "Invalid Resend webhook event.",
      statusCode: 400,
    }));
  });

  it("accepts a valid signed event, rejects invalid signatures, and deduplicates replay", async () => {
    const harness = acceptedNotificationHarness();
    await expect(harness.coordinator.processDue({ now: new Date(NOW) })).resolves.toMatchObject({ accepted: 1 });
    const deliveredAt = isoAfterMinutes(NOW, 2);
    const webhook = signedWebhook({
      eventId: "webhook-delivered-1",
      type: "email.delivered",
      createdAt: deliveredAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: deliveredAt,
    });

    expect(() => harness.coordinator.handleVerifiedWebhook({
      ...webhook,
      headers: { ...webhook.headers, signature: `v1,${Buffer.alloc(32).toString("base64")}` },
    })).toThrow("signature is invalid");
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_notification_events",
    ).get()).toEqual({ count: 0 });

    expect(harness.coordinator.handleVerifiedWebhook(webhook)).toEqual({
      received: true,
      duplicate: false,
      matched: true,
    });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "delivered",
        provider_last_event: "email.delivered",
        provider_event_at: deliveredAt,
        delivered_at: deliveredAt,
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();

    expect(harness.coordinator.handleVerifiedWebhook(webhook)).toEqual({
      received: true,
      duplicate: true,
      matched: true,
    });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_notification_events",
    ).get()).toEqual({ count: 1 });
  });

  it("records but ignores an older failure event after a newer delivered event", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const deliveredAt = isoAfterMinutes(NOW, 3);
    harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-newer-delivered",
      type: "email.delivered",
      createdAt: deliveredAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: deliveredAt,
    }));
    const olderFailedAt = isoAfterMinutes(NOW, 1);
    const olderResult = harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-older-bounced",
      type: "email.bounced",
      createdAt: olderFailedAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: isoAfterMinutes(NOW, 4),
    }));

    expect(olderResult).toEqual({ received: true, duplicate: false, matched: true });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "delivered",
        provider_last_event: "email.delivered",
        provider_event_at: deliveredAt,
      }),
    );
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_notification_events",
    ).get()).toEqual({ count: 2 });
  });

  it("accepts a terminal event at the same provider timestamp as an earlier pending event", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const eventAt = isoAfterMinutes(NOW, 2);
    harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-same-time-sent",
      type: "email.sent",
      createdAt: eventAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: eventAt,
    }));
    harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-same-time-delivered",
      type: "email.delivered",
      createdAt: eventAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: isoAfterMinutes(NOW, 3),
    }));

    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId))
      .toEqual(expect.objectContaining({ status: "delivered", provider_last_event: "email.delivered" }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();
  });

  it("reconciles a delayed signed delivery after the completed recipient reached its retention limit", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const purgeAt = harness.coordinator.completionRetentionExpiresAt(NOW);
    await expect(harness.coordinator.processDue({ now: new Date(purgeAt) })).resolves.toMatchObject({
      recipientsPurged: 1,
    });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "purged",
        provider_message_id: "resend-webhook-message",
        completed_at: NOW,
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();

    const deliveredAt = isoAfterMinutes(purgeAt, -1);
    const receivedAt = isoAfterMinutes(purgeAt, 1);
    expect(harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-delivered-after-retention-purge",
      type: "email.delivered",
      createdAt: deliveredAt,
      providerMessageId: "resend-webhook-message",
      receivedAt,
    }))).toEqual({ received: true, duplicate: false, matched: true });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "delivered",
        provider_last_event: "email.delivered",
        provider_event_at: deliveredAt,
        delivered_at: deliveredAt,
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(receivedAt)).toEqual(
      expect.objectContaining({ manualReviewCount: 0, overdueRetentionCount: 0 }),
    );
  });

  it("ignores unrelated signed events but asks Resend to retry a relevant unmatched event", () => {
    const harness = createHarness();
    const eventAt = isoAfterMinutes(NOW, 1);
    expect(harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "unrelated-report-email",
      type: "email.delivered",
      createdAt: eventAt,
      providerMessageId: "another-feature-message",
      receivedAt: eventAt,
      messageType: "monthly_report",
    }))).toEqual({ received: true, duplicate: false, matched: false });
    expect(() => harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "relevant-not-yet-registered",
      type: "email.delivered",
      createdAt: eventAt,
      providerMessageId: "pending-provider-race",
      receivedAt: eventAt,
    }))).toThrow("not registered yet");
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM account_deletion_notification_events",
    ).get()).toEqual({ count: 0 });
  });

  it("persists a secure-purge checkpoint retry when WAL truncation is temporarily busy", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const deliveredAt = isoAfterMinutes(NOW, 2);
    const webhook = signedWebhook({
      eventId: "webhook-checkpoint-retry",
      type: "email.delivered",
      createdAt: deliveredAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: deliveredAt,
    });
    const checkpoint = vi.spyOn(harness.repository, "checkpointAccountDeletionNotificationSecrets")
      .mockReturnValueOnce(false);

    expect(() => harness.coordinator.handleVerifiedWebhook(webhook)).toThrow("checkpoint is temporarily busy");
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(deliveredAt)
      .securePurgeCheckpointPendingCount).toBe(1);

    checkpoint.mockRestore();
    expect(harness.coordinator.handleVerifiedWebhook(webhook)).toEqual({
      received: true,
      duplicate: true,
      matched: true,
    });
    expect(harness.repository.getAccountDeletionNotificationQueueSummary(deliveredAt)
      .securePurgeCheckpointPendingCount).toBe(0);
  });

  it("allows an operator to resolve manual review and securely purge the destination", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const bouncedAt = isoAfterMinutes(NOW, 2);
    harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-manual-resolution-bounce",
      type: "email.bounced",
      createdAt: bouncedAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: bouncedAt,
    }));
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId))
      .toEqual(expect.objectContaining({ status: "manual_review" }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).not.toBeNull();

    const resolvedAt = isoAfterMinutes(NOW, 3);
    expect(harness.repository.resolveAccountDeletionNotificationManualReview({
      requestId: harness.fixture.requestId,
      resolution: "undeliverable",
      now: resolvedAt,
      audit: operatorAudit(
        harness.fixture,
        "audit-manual-undeliverable-resolution",
        "Resend showed an independently verified terminal bounce.",
      ),
    })).toEqual(expect.objectContaining({
      status: "failed",
      provider_last_event: "operator_resolved_undeliverable",
      provider_event_at: bouncedAt,
      secret_purge_checkpoint_pending: 1,
    }));
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();
    expect(harness.repository.listSecurityAuditLogs({
      action: "account_deletion_notification_manually_resolved",
    })).toEqual([
      expect.objectContaining({
        id: "audit-manual-undeliverable-resolution",
        actorUserId: harness.fixture.admin.id,
        targetId: harness.fixture.requestId,
        metadata: {
          resolution: "undeliverable",
          reason: "Resend showed an independently verified terminal bounce.",
        },
      }),
    ]);
    expect(harness.repository.retryFailedAccountDeletionNotification({
      requestId: harness.fixture.requestId,
      now: isoAfterMinutes(NOW, 4),
      audit: operatorAudit(harness.fixture, "audit-blocked-operator-retry"),
    })).toBeNull();
    expect(harness.repository.checkpointAccountDeletionNotificationSecrets()).toBe(true);

    const delayedFailedAt = isoAfterMinutes(NOW, 2.25);
    expect(harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-failed-before-operator-resolution",
      type: "email.failed",
      createdAt: delayedFailedAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: isoAfterMinutes(NOW, 3.5),
    }))).toEqual({ received: true, duplicate: false, matched: true });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "failed",
        provider_last_event: "operator_resolved_undeliverable",
        provider_event_at: bouncedAt,
      }),
    );

    const delayedDeliveredAt = isoAfterMinutes(NOW, 2.5);
    expect(harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-delivered-before-operator-resolution",
      type: "email.delivered",
      createdAt: delayedDeliveredAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: isoAfterMinutes(NOW, 4),
    }))).toEqual({ received: true, duplicate: false, matched: true });
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "delivered",
        provider_last_event: "email.delivered",
        provider_event_at: delayedDeliveredAt,
        delivered_at: delayedDeliveredAt,
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).toBeNull();
  });

  it("rolls back terminal resolution and recipient purge when its audit row cannot be written", async () => {
    const harness = acceptedNotificationHarness();
    await harness.coordinator.processDue({ now: new Date(NOW) });
    const bouncedAt = isoAfterMinutes(NOW, 2);
    harness.coordinator.handleVerifiedWebhook(signedWebhook({
      eventId: "webhook-resolution-audit-rollback-bounce",
      type: "email.bounced",
      createdAt: bouncedAt,
      providerMessageId: "resend-webhook-message",
      receivedAt: bouncedAt,
    }));
    const before = harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId);
    const duplicateAuditId = "duplicate-resolution-audit-id";
    harness.repository.insertSecurityAuditLog({
      id: duplicateAuditId,
      actorUserId: harness.fixture.admin.id,
      actorRole: harness.fixture.admin.role,
      action: "unrelated_existing_audit",
      targetType: "account_deletion_request",
      targetId: harness.fixture.requestId,
      metadata: {},
      ipHash: null,
      userAgentHash: null,
      createdAt: bouncedAt,
    });

    expect(() => harness.repository.resolveAccountDeletionNotificationManualReview({
      requestId: harness.fixture.requestId,
      resolution: "undeliverable",
      now: isoAfterMinutes(NOW, 3),
      audit: operatorAudit(
        harness.fixture,
        duplicateAuditId,
        "Resend showed an independently verified terminal bounce.",
      ),
    })).toThrow();
    expect(harness.repository.getAccountDeletionCompletionOutbox(harness.fixture.requestId)).toEqual(before);
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(harness.fixture.requestId)).not.toBeNull();
    expect(harness.repository.countSecurityAuditLogs({
      action: "account_deletion_notification_manually_resolved",
    })).toBe(0);
  });
});

describe("account deletion notification restore suppression", () => {
  it("suppresses prepared notification work during tombstone reconciliation and destroys its recipient", async () => {
    const send = vi.fn(async () => ({ id: "must-not-send" }));
    const provider: AccountDeletionNotificationProvider = {
      mode: "resend",
      send,
      getStatus: vi.fn(),
    };
    const harness = createHarness(provider);
    const fixture = createDeletionFixture(harness, "restore");
    expect(prepareHeldNotification(harness, fixture)).toBeTruthy();

    harness.repository.executeAccountAnonymisation({
      requestId: fixture.requestId,
      reviewedBy: fixture.admin.id,
      now: NOW,
      completionNotificationDisposition: "suppress_restore",
    });

    expect(harness.repository.getAccountDeletionCompletionOutbox(fixture.requestId)).toEqual(
      expect.objectContaining({
        status: "suppressed_restore",
        next_attempt_at: null,
        terminal_at: NOW,
        last_error: expect.stringContaining("suppressed during deletion-tombstone restore"),
      }),
    );
    expect(harness.repository.getAccountDeletionNoticeRecipientSecret(fixture.requestId)).toBeNull();
    await expect(harness.coordinator.processDue({ now: new Date(isoAfterMinutes(NOW, 24 * 60)) }))
      .resolves.toMatchObject({ claimed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
