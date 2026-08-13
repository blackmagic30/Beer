import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_CROSS_REPOSITORY_LOCK_CONTRACT,
  ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT,
  AccountDeletionQueueRepository,
  AccountDeletionQueueRepositoryError,
} from "../src/db/account-deletion-queue.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const STALE = "2026-08-08T01:00:00.000Z";
const NOW = "2026-08-08T02:00:00.000Z";
const FIVE_MINUTES = "2026-08-08T02:05:00.000Z";
const TEN_MINUTES = "2026-08-08T02:10:00.000Z";
const FIFTEEN_MINUTES = "2026-08-08T02:15:00.000Z";
const TWENTY_MINUTES = "2026-08-08T02:20:00.000Z";
const TOMORROW = "2026-08-09T02:00:00.000Z";
const NEXT_WEEK = "2026-08-15T02:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AccountDeletionQueueRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  insertAccount(raw, "operator");
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new AccountDeletionQueueRepository(database) };
}

function insertAccount(raw: BetterSqlite3.Database, id: string, stripeCustomerId: string | null = null): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, display_name, role,
       subscription_status, stripe_customer_id, stripe_paid_subscription_status,
       stripe_event_created_at, premium_until, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', ?, 'user', 'premium_monthly', ?, 'premium_monthly', ?, ?, ?, ?)`,
  ).run(
    id,
    `PP-${id}`,
    `${id}@example.test`,
    id,
    stripeCustomerId,
    stripeCustomerId ? NOW : null,
    stripeCustomerId ? NEXT_WEEK : null,
    NOW,
    NOW,
  );
}

async function createRequest(
  fixture: Fixture,
  requestId: string,
  userId: string,
  executeAfter = TOMORROW,
) {
  insertAccount(fixture.raw, userId);
  return fixture.repository.createAccountDeletionRequest({
    id: requestId,
    userId,
    userMessage: "Please remove my account.",
    requestedAt: NOW,
    executeAfter,
  });
}

async function beginWithNotification(
  fixture: Fixture,
  requestId: string,
  idempotencyKey = `delete-notice:${requestId}`,
) {
  return fixture.repository.beginAccountDeletionWithCompletionNotification({
    requestId,
    reviewedBy: "operator",
    now: NOW,
    staleBefore: STALE,
    templateVersion: "account-deletion-complete-v1",
    idempotencyKey,
    keyId: "recipient-key-v1",
    nonce: Buffer.from("00112233445566778899aabb", "hex"),
    ciphertext: Buffer.from(`encrypted-recipient:${requestId}`),
    authTag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    purgeAfter: NEXT_WEEK,
  });
}

function activateNotification(raw: BetterSqlite3.Database, requestId: string, at = NOW): void {
  raw.prepare(
    `UPDATE account_deletion_requests
        SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(at, at, requestId);
  raw.prepare(
    `UPDATE account_deletion_completion_outbox
        SET status = 'pending', completed_at = ?, next_attempt_at = ?,
            retention_expires_at = ?, updated_at = ?
      WHERE request_id = ?`,
  ).run(at, at, NEXT_WEEK, at, requestId);
}

async function claim(
  fixture: Fixture,
  requestId: string,
  leaseToken = `lease:${requestId}:one`,
  now = NOW,
  leaseExpiresAt = FIVE_MINUTES,
) {
  const claimed = await fixture.repository.claimNextAccountDeletionCompletionNotification({
    now,
    staleBefore: STALE,
    leaseToken,
    leaseExpiresAt,
  });
  expect(claimed?.request_id).toBe(requestId);
  return claimed!;
}

describe("AccountDeletionQueueRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("publishes the cross-repository lock order and fails closed for a missing actor account", async () => {
    const created = fixture();
    expect(ACCOUNT_DELETION_CROSS_REPOSITORY_LOCK_CONTRACT).toEqual({
      version: 1,
      billingCheckoutVersion: 1,
      venueAccessVersion: 1,
      missionLifecycleVersion: 1,
      venueRequestVersion: 1,
      venuePartnerVersion: 1,
      sourceEvidenceObjectVersion: 1,
      order: [
        "sorted_cross_repository_account_advisory_keys",
        "account_row",
        "account_deletion_request_row",
        "conditional_write",
      ],
    });
    await expect(created.repository.createAccountDeletionRequest({
      id: "missing-account-request",
      userId: "missing-account",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: TOMORROW,
    })).rejects.toEqual(expect.objectContaining({
      name: "AccountDeletionQueueRepositoryError",
      code: "account_not_found",
      message: "The account for the deletion request does not exist.",
    }));
    expect(await created.repository.countAccountDeletionRequests()).toBe(0);
  });

  it("converges concurrent request creation onto one durable unfinished request", async () => {
    const created = fixture();
    insertAccount(created.raw, "concurrent-user");
    const [first, second] = await Promise.all([
      created.repository.createAccountDeletionRequest({
        id: "request-one",
        userId: "concurrent-user",
        userMessage: null,
        requestedAt: NOW,
        executeAfter: TOMORROW,
      }),
      created.repository.createAccountDeletionRequest({
        id: "request-two",
        userId: "concurrent-user",
        userMessage: null,
        requestedAt: NOW,
        executeAfter: TOMORROW,
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(await created.repository.countAccountDeletionRequests()).toBe(1);
    expect(await created.repository.getAccountDeletionQueueSummary(TOMORROW)).toEqual({
      actionableCount: 1,
      dueCount: 1,
      failedCount: 0,
      processingCount: 0,
      oldestDueAt: TOMORROW,
      nextDueAt: null,
    });
    expect(await created.repository.listAccountDeletionRequests({ limit: 10, asOf: TOMORROW }))
      .toEqual([expect.objectContaining({ id: first.id, completion_notification_status: null })]);
  });

  it("returns the exact atomic deletion claim receipt under contention", async () => {
    const created = fixture();
    await createRequest(created, "atomic-claim-request", "atomic-claim-user");
    const [first, second] = await Promise.all([
      created.repository.beginAccountDeletion({
        requestId: "atomic-claim-request",
        reviewedBy: "operator",
        now: NOW,
        staleBefore: STALE,
      }),
      created.repository.beginAccountDeletion({
        requestId: "atomic-claim-request",
        reviewedBy: "operator",
        now: NOW,
        staleBefore: STALE,
      }),
    ]);
    const receipts = [first, second].filter((row) => row !== null);
    expect(receipts).toEqual([
      expect.objectContaining({
        id: "atomic-claim-request",
        status: "processing",
        processing_started_at: NOW,
        attempt_count: 1,
      }),
    ]);
    expect(await created.repository.getAccountDeletionRequestById("atomic-claim-request"))
      .toEqual(receipts[0]);
  });

  it("prepares the deletion claim, outbox, and encrypted recipient atomically without changing bytes", async () => {
    const created = fixture();
    await createRequest(created, "atomic-request", "atomic-user");
    const request = await beginWithNotification(created, "atomic-request");
    expect(request).toMatchObject({ status: "processing", attempt_count: 1 });
    expect(await created.repository.getAccountDeletionCompletionOutbox("atomic-request"))
      .toMatchObject({ status: "held", idempotency_key: "delete-notice:atomic-request" });
    expect(await created.repository.getAccountDeletionNoticeRecipientSecret("atomic-request"))
      .toEqual(expect.objectContaining({
        key_id: "recipient-key-v1",
        nonce: Buffer.from("00112233445566778899aabb", "hex"),
        ciphertext: Buffer.from("encrypted-recipient:atomic-request"),
        auth_tag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      }));
    expect(await created.repository.listReferencedAccountDeletionNoticeKeyIds()).toEqual(["recipient-key-v1"]);

    await createRequest(created, "conflicting-request", "conflicting-user");
    await expect(beginWithNotification(
      created,
      "conflicting-request",
      "delete-notice:atomic-request",
    )).rejects.toMatchObject({ code: "notification_identity_conflict" });
    expect(await created.repository.getAccountDeletionRequestById("conflicting-request"))
      .toMatchObject({ status: "pending_review", attempt_count: 0 });
    expect(await created.repository.getAccountDeletionCompletionOutbox("conflicting-request")).toBeNull();
    expect(await created.repository.getAccountDeletionNoticeRecipientSecret("conflicting-request")).toBeNull();
  });

  it("claims once, recovers expired work, and rejects every stale lease mutation", async () => {
    const created = fixture();
    await createRequest(created, "claim-request", "claim-user");
    await beginWithNotification(created, "claim-request");
    activateNotification(created.raw, "claim-request");

    const [first, second] = await Promise.all([
      created.repository.claimNextAccountDeletionCompletionNotification({
        now: NOW,
        staleBefore: STALE,
        leaseToken: "lease-one",
        leaseExpiresAt: FIVE_MINUTES,
      }),
      created.repository.claimNextAccountDeletionCompletionNotification({
        now: NOW,
        staleBefore: STALE,
        leaseToken: "lease-two",
        leaseExpiresAt: FIVE_MINUTES,
      }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winningToken = first?.lease_token ?? second?.lease_token;
    expect(winningToken).toMatch(/^lease-(one|two)$/);
    const staleToken = winningToken === "lease-one" ? "lease-two" : "lease-one";
    expect(await created.repository.lockAccountDeletionNotificationPayload({
      requestId: "claim-request",
      leaseToken: staleToken,
      payloadFingerprint: "a".repeat(64),
      now: NOW,
    })).toBe(false);

    const recovered = await created.repository.claimNextAccountDeletionCompletionNotification({
      now: TEN_MINUTES,
      staleBefore: FIVE_MINUTES,
      leaseToken: "lease-recovered",
      leaseExpiresAt: FIFTEEN_MINUTES,
    });
    expect(recovered).toMatchObject({ lease_token: "lease-recovered", attempt_count: 2 });
    expect(await created.repository.deferAccountDeletionNotification({
      requestId: "claim-request",
      leaseToken: winningToken!,
      nextAttemptAt: TWENTY_MINUTES,
      error: "stale token must not commit",
      now: TEN_MINUTES,
    })).toBe(false);
    expect(await created.repository.lockAccountDeletionNotificationPayload({
      requestId: "claim-request",
      leaseToken: "lease-recovered",
      payloadFingerprint: "b".repeat(64),
      now: TEN_MINUTES,
    })).toBe(true);
  });

  it("fences accepted, deferred, failed, manual-review, and delivered transitions", async () => {
    const delivered = fixture();
    await createRequest(delivered, "delivered-request", "delivered-user");
    await beginWithNotification(delivered, "delivered-request");
    activateNotification(delivered.raw, "delivered-request");
    await claim(delivered, "delivered-request");
    expect(await delivered.repository.markAccountDeletionNotificationAccepted({
      requestId: "delivered-request",
      leaseToken: "lease:delivered-request:one",
      providerMessageId: "provider-message-one",
      acceptedAt: NOW,
      nextCheckAt: FIVE_MINUTES,
    })).toBe(true);
    await claim(delivered, "delivered-request", "lease:delivered-request:two", FIVE_MINUTES, TEN_MINUTES);
    expect(await delivered.repository.markAccountDeletionNotificationDelivered({
      requestId: "delivered-request",
      leaseToken: "lease:delivered-request:one",
      providerEvent: "delivered",
      eventAt: FIVE_MINUTES,
      now: FIVE_MINUTES,
    })).toBe(false);
    expect(await delivered.repository.markAccountDeletionNotificationDelivered({
      requestId: "delivered-request",
      leaseToken: "lease:delivered-request:two",
      providerEvent: "delivered",
      eventAt: FIVE_MINUTES,
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await delivered.repository.getAccountDeletionNoticeRecipientSecret("delivered-request")).toBeNull();
    expect(await delivered.repository.getAccountDeletionCompletionOutbox("delivered-request"))
      .toMatchObject({ status: "delivered", secret_purge_checkpoint_pending: true, secret_purge_generation: 1 });

    const failed = fixture();
    await createRequest(failed, "failed-request", "failed-user");
    await beginWithNotification(failed, "failed-request");
    activateNotification(failed.raw, "failed-request");
    await claim(failed, "failed-request");
    expect(await failed.repository.markAccountDeletionNotificationFailed({
      requestId: "failed-request",
      leaseToken: "lease:failed-request:one",
      providerEvent: "rejected",
      error: "provider rejected person@example.test with Bearer dangerous-secret",
      now: NOW,
    })).toBe(true);
    expect((await failed.repository.getAccountDeletionCompletionOutbox("failed-request"))?.last_error)
      .not.toContain("person@example.test");
    expect((await failed.repository.getAccountDeletionCompletionOutbox("failed-request"))?.last_error)
      .not.toContain("dangerous-secret");
    expect(await failed.repository.retryFailedAccountDeletionNotification({
      requestId: "failed-request",
      now: FIVE_MINUTES,
      audit: { id: "audit-retry", actorUserId: "operator", actorRole: "admin", reason: "Verified retry." },
    })).toMatchObject({ status: "pending", attempt_count: 0, payload_fingerprint: null });
    await claim(failed, "failed-request", "manual-lease", FIVE_MINUTES, TEN_MINUTES);
    expect(await failed.repository.markAccountDeletionNotificationForManualReview({
      requestId: "failed-request",
      leaseToken: "manual-lease",
      error: "outcome uncertain",
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await failed.repository.resolveAccountDeletionNotificationManualReview({
      requestId: "failed-request",
      resolution: "undeliverable",
      now: TEN_MINUTES,
      audit: { id: "audit-resolve", actorUserId: "operator", actorRole: "admin", reason: "Independent check." },
    })).toMatchObject({ status: "failed", provider_last_event: "operator_resolved_undeliverable" });
    expect(await failed.repository.resolveAccountDeletionNotificationManualReview({
      requestId: "failed-request",
      resolution: "undeliverable",
      now: FIFTEEN_MINUTES,
      audit: { id: "audit-repeat", actorUserId: "operator", actorRole: "admin", reason: "Duplicate check." },
    })).toBeNull();
  });

  it("applies signed provider events idempotently and ignores older reordered outcomes", async () => {
    const created = fixture();
    await createRequest(created, "webhook-request", "webhook-user");
    await beginWithNotification(created, "webhook-request");
    activateNotification(created.raw, "webhook-request");
    await claim(created, "webhook-request");
    await created.repository.markAccountDeletionNotificationAccepted({
      requestId: "webhook-request",
      leaseToken: "lease:webhook-request:one",
      providerMessageId: "provider-webhook-message",
      acceptedAt: NOW,
      nextCheckAt: FIVE_MINUTES,
    });
    const pending = await created.repository.recordAccountDeletionNotificationWebhook({
      eventId: "event-newer",
      providerMessageId: "provider-webhook-message",
      eventType: "email.sent",
      eventCreatedAt: TEN_MINUTES,
      receivedAt: FIFTEEN_MINUTES,
      payloadSha256: "c".repeat(64),
      outcome: "pending",
    });
    expect(pending).toEqual({ duplicate: false, matched: true, requestId: "webhook-request" });
    expect(await created.repository.recordAccountDeletionNotificationWebhook({
      eventId: "event-older",
      providerMessageId: "provider-webhook-message",
      eventType: "email.bounced",
      eventCreatedAt: FIVE_MINUTES,
      receivedAt: FIFTEEN_MINUTES,
      payloadSha256: "d".repeat(64),
      outcome: "failed",
    })).toEqual({ duplicate: false, matched: true, requestId: "webhook-request" });
    expect(await created.repository.getAccountDeletionCompletionOutbox("webhook-request"))
      .toMatchObject({ status: "accepted", provider_last_event: "email.sent", provider_event_at: TEN_MINUTES });
    expect(await created.repository.recordAccountDeletionNotificationWebhook({
      eventId: "event-newer",
      providerMessageId: "provider-webhook-message",
      eventType: "email.sent",
      eventCreatedAt: TEN_MINUTES,
      receivedAt: FIFTEEN_MINUTES,
      payloadSha256: "c".repeat(64),
      outcome: "pending",
    })).toEqual({ duplicate: true, matched: true, requestId: "webhook-request" });
    await expect(created.repository.recordAccountDeletionNotificationWebhook({
      eventId: "event-newer",
      providerMessageId: "provider-webhook-message",
      eventType: "email.changed",
      eventCreatedAt: TEN_MINUTES,
      receivedAt: FIFTEEN_MINUTES,
      payloadSha256: "e".repeat(64),
      outcome: "pending",
    })).rejects.toMatchObject({ code: "provider_event_identity_conflict" });
  });

  it("fences a checkpoint across recipient reinsertion and clears only the later purged generation", async () => {
    const created = fixture();
    await createRequest(created, "purge-request", "purge-user");
    await beginWithNotification(created, "purge-request");
    created.raw.prepare(
      "UPDATE account_deletion_notice_recipient_secrets SET purge_after = ? WHERE request_id = ?",
    ).run(NOW, "purge-request");
    expect(await created.repository.purgeExpiredAccountDeletionNotificationRecipients(NOW)).toBe(1);
    expect(await created.repository.getAccountDeletionNoticeRecipientSecret("purge-request")).toBeNull();
    expect(await created.repository.getAccountDeletionCompletionOutbox("purge-request"))
      .toMatchObject({ status: "purged", secret_purge_checkpoint_pending: true, secret_purge_generation: 1 });
    const snapshot = await created.repository.captureAccountDeletionNotificationSecretPurgeCheckpoint();
    expect(snapshot).toEqual([{ requestId: "purge-request", generation: 1 }]);

    expect(await created.repository.beginAccountDeletionWithCompletionNotification({
      requestId: "purge-request",
      reviewedBy: "operator",
      now: TEN_MINUTES,
      staleBefore: FIVE_MINUTES,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKey: "delete-notice:purge-request",
      keyId: "recipient-key-v2",
      nonce: Buffer.from("112233445566778899aabbcc", "hex"),
      ciphertext: Buffer.from("reinserted-recipient"),
      authTag: Buffer.from("112233445566778899aabbccddeeff00", "hex"),
      purgeAfter: NEXT_WEEK,
    })).toMatchObject({ status: "processing", attempt_count: 2 });
    expect(await created.repository.getAccountDeletionNoticeRecipientSecret("purge-request")).not.toBeNull();
    expect(await created.repository.getAccountDeletionCompletionOutbox("purge-request"))
      .toMatchObject({ status: "held", secret_purge_checkpoint_pending: true, secret_purge_generation: 2 });
    expect(await created.repository.acknowledgeAccountDeletionNotificationSecretPurgeCheckpoint(snapshot)).toBe(0);
    expect((await created.repository.getAccountDeletionCompletionOutbox("purge-request"))
      ?.secret_purge_checkpoint_pending).toBe(true);

    const checkpoint = vi.fn(async () => true);
    expect(await created.repository.checkpointAccountDeletionNotificationSecrets(checkpoint)).toBe(false);
    expect(checkpoint).toHaveBeenCalledWith([{ requestId: "purge-request", generation: 2 }]);
    expect((await created.repository.getAccountDeletionCompletionOutbox("purge-request"))
      ?.secret_purge_checkpoint_pending).toBe(true);

    expect(await created.repository.purgeExpiredAccountDeletionNotificationRecipients(NEXT_WEEK)).toBe(1);
    expect(await created.repository.checkpointAccountDeletionNotificationSecrets(checkpoint)).toBe(true);
    expect(checkpoint).toHaveBeenLastCalledWith([{ requestId: "purge-request", generation: 3 }]);
    expect((await created.repository.getAccountDeletionCompletionOutbox("purge-request"))
      ?.secret_purge_checkpoint_pending).toBe(false);
  });

  it("bounds each recipient purge transaction and drains deterministic batches across calls", async () => {
    const created = fixture();
    insertAccount(created.raw, "batch-user");
    const insertRequest = created.raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, user_message, requested_at, execute_after,
         completed_at, created_at, updated_at
       ) VALUES (?, 'batch-user', 'completed', NULL, ?, ?, ?, ?, ?)`,
    );
    const insertOutbox = created.raw.prepare(
      `INSERT INTO account_deletion_completion_outbox (
         request_id, template_version, idempotency_key, status, created_at, updated_at
       ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
    );
    const insertSecret = created.raw.prepare(
      `INSERT INTO account_deletion_notice_recipient_secrets (
         request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
       ) VALUES (?, 'batch-key', ?, ?, ?, ?, ?)`,
    );
    created.raw.transaction(() => {
      for (let index = 0; index <= ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const requestId = `batch-request-${suffix}`;
        insertRequest.run(requestId, NOW, NOW, NOW, NOW, NOW);
        insertOutbox.run(requestId, `batch-notice-${suffix}`, NOW, NOW);
        insertSecret.run(
          requestId,
          Buffer.from("00112233445566778899aabb", "hex"),
          Buffer.from(`ciphertext-${suffix}`),
          Buffer.from("00112233445566778899aabbccddeeff", "hex"),
          NOW,
          NOW,
        );
      }
    })();

    expect(await created.repository.purgeExpiredAccountDeletionNotificationRecipients(NOW))
      .toBe(ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT);
    expect(created.raw.prepare(
      "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets",
    ).get()).toEqual({ count: 1 });
    expect(created.raw.prepare(
      "SELECT request_id FROM account_deletion_notice_recipient_secrets",
    ).get()).toEqual({
      request_id: `batch-request-${String(ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT).padStart(3, "0")}`,
    });
    expect(await created.repository.purgeExpiredAccountDeletionNotificationRecipients(NOW)).toBe(1);
    expect(await created.repository.purgeExpiredAccountDeletionNotificationRecipients(NOW)).toBe(0);
    expect(created.raw.prepare(
      "SELECT count(*) AS count FROM account_deletion_completion_outbox WHERE status = 'purged'",
    ).get()).toEqual({ count: ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT + 1 });
  });

  it("fences provider deletion receipts by attempt and enforces cancellation constraints", async () => {
    const created = fixture();
    insertAccount(created.raw, "provider-user", "cus_provider_user");
    await created.repository.createAccountDeletionRequest({
      id: "provider-request",
      userId: "provider-user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: TOMORROW,
    });
    const processing = await beginWithNotification(created, "provider-request");
    expect(processing?.attempt_count).toBe(1);
    created.raw.prepare(
      `INSERT INTO stripe_webhook_events (
         id, event_type, status, payload_json, attempts, last_error,
         received_at, processed_at, processing_token
       ) VALUES (?, 'customer.deleted', 'applied', ?, 1, 'sensitive', ?, ?, NULL)`,
    ).run(
      "stripe-event-one",
      JSON.stringify({ data: { object: { customer: "cus_provider_user" } } }),
      NOW,
      NOW,
    );
    expect(await created.repository.markAccountDeletionStripeCustomerDeleted({
      requestId: "provider-request",
      userId: "provider-user",
      stripeCustomerId: "cus_provider_user",
      attemptCount: 0,
      now: FIVE_MINUTES,
    })).toBe(false);
    expect(created.raw.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?")
      .get("provider-user")).toEqual({ stripe_customer_id: "cus_provider_user" });
    expect(await created.repository.markAccountDeletionStripeCustomerDeleted({
      requestId: "provider-request",
      userId: "provider-user",
      stripeCustomerId: "cus_provider_user",
      attemptCount: 1,
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(created.raw.prepare(
      "SELECT payload_json, last_error FROM stripe_webhook_events WHERE id = ?",
    ).get("stripe-event-one")).toEqual({ payload_json: null, last_error: null });
    expect(await created.repository.markAccountDeletionIdentityDeleted({
      requestId: "provider-request",
      attemptCount: 1,
      now: TEN_MINUTES,
    })).toBe(true);
    expect(await created.repository.markAccountDeletionTombstoneRecorded({
      requestId: "provider-request",
      attemptCount: 1,
      recordedAt: TEN_MINUTES,
      now: TEN_MINUTES,
    })).toBe(true);
    expect(await created.repository.cancelAccountDeletion({
      requestId: "provider-request",
      userId: "provider-user",
      now: FIFTEEN_MINUTES,
    })).toBe(false);

    await createRequest(created, "cancel-request", "cancel-user");
    await beginWithNotification(created, "cancel-request");
    expect(await created.repository.failAccountDeletion({
      requestId: "cancel-request",
      attemptCount: 1,
      error: "safe failure",
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await created.repository.cancelAccountDeletion({
      requestId: "cancel-request",
      userId: "cancel-user",
      now: TEN_MINUTES,
    })).toBe(true);
    expect(await created.repository.getAccountDeletionCompletionOutbox("cancel-request"))
      .toMatchObject({ status: "cancelled", secret_purge_checkpoint_pending: true });
    expect(await created.repository.getAccountDeletionNoticeRecipientSecret("cancel-request")).toBeNull();
  });

  it("rejects malformed timestamps, identifiers, hashes, and secret-bearing error failures stably", async () => {
    const created = fixture();
    await expect(created.repository.createAccountDeletionRequest({
      id: "bad\nrequest",
      userId: "user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: TOMORROW,
    })).rejects.toBeInstanceOf(AccountDeletionQueueRepositoryError);
    await expect(created.repository.getAccountDeletionQueueSummary("2026-08-08"))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(created.repository.lockAccountDeletionNotificationPayload({
      requestId: "request",
      leaseToken: "lease",
      payloadFingerprint: crypto.randomBytes(31).toString("hex"),
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
