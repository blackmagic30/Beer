import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
  ACCOUNT_PRIVACY_SOURCE_EVIDENCE_LOCK_VERSION,
  ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
  AccountPrivacyRepository,
  type ExecuteAccountAnonymisationInput,
} from "../src/db/account-privacy.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const NOW = "2026-08-08T02:00:00.000Z";
const TOMORROW = "2026-08-09T02:00:00.000Z";
const NEXT_WEEK = "2026-08-15T02:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AccountPrivacyRepository;
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: {
    email?: string;
    supabaseUserId?: string | null;
    stripeCustomerId?: string | null;
  } = {},
): void {
  const email = options.email ?? `${id}@example.test`;
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, display_name, display_name_key,
       auth_provider, supabase_user_id, role, age_verification_status,
       is_over_18_verified, subscription_status, stripe_customer_id,
       trust_score, contribution_points_current_month, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'password-hash', ?, ?, ?, ?, 'user', 'verified', 1,
               'premium_monthly', ?, 82, 15, 'active', ?, ?)`,
  ).run(
    id,
    `PP-${id}`,
    email,
    `Display ${id}`,
    `display-${id}`,
    options.supabaseUserId ? "supabase" : "local",
    options.supabaseUserId ?? null,
    options.stripeCustomerId ?? null,
    NOW,
    NOW,
  );
  raw.prepare(
    `INSERT INTO profiles (
       id, public_account_id, email, display_name, display_name_key, username,
       role, account_status, age_verification_status, is_over_18_verified,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', 'verified', 1, ?, ?)`,
  ).run(
    id,
    `PP-${id}`,
    email,
    `Display ${id}`,
    `display-${id}`,
    `username-${id}`,
    NOW,
    NOW,
  );
}

function insertProcessingRequest(
  raw: BetterSqlite3.Database,
  userId: string,
  requestId = `delete-${userId}`,
  options: {
    attemptCount?: number;
    identityDeletedAt?: string | null;
    stripeDeletedAt?: string | null;
    stripeSnapshot?: string | null;
    tombstoneRecordedAt?: string | null;
    prepareNotification?: boolean;
    prepareRecipient?: boolean;
  } = {},
): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, user_message, requested_at, execute_after,
       processing_started_at, identity_deleted_at, stripe_customer_deleted_at,
       stripe_customer_id_snapshot, deletion_tombstone_recorded_at,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, 'processing', 'delete all of my data', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    userId,
    NOW,
    NOW,
    NOW,
    options.identityDeletedAt ?? null,
    options.stripeDeletedAt ?? null,
    options.stripeSnapshot ?? null,
    options.tombstoneRecordedAt === undefined ? NOW : options.tombstoneRecordedAt,
    options.attemptCount ?? 1,
    NOW,
    NOW,
  );
  if (options.prepareNotification === false) return;
  raw.prepare(
    `INSERT INTO account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status, created_at, updated_at
     ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
  ).run(requestId, `notice:${requestId}`, NOW, NOW);
  if (options.prepareRecipient === false) return;
  raw.prepare(
    `INSERT INTO account_deletion_notice_recipient_secrets (
       request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
     ) VALUES (?, 'privacy-test-key', ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    Buffer.alloc(12, 1),
    Buffer.from(`encrypted:${requestId}`),
    Buffer.alloc(16, 2),
    NOW,
    TOMORROW,
  );
}

function insertRepresentativePrivateData(raw: BetterSqlite3.Database, userId: string): void {
  const email = `${userId}@example.test`;
  raw.prepare(
    `INSERT INTO account_preferences (
       user_id, preferred_suburbs_json, preferred_beers_json, preferred_use_cases_json,
       onboarding_completed_at, created_at, updated_at
     ) VALUES (?, '["Fitzroy"]', '["lager"]', '["dinner"]', ?, ?, ?)`,
  ).run(userId, NOW, NOW, NOW);
  raw.prepare(
    `INSERT INTO account_privacy_settings (
       user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
       product_research_enabled, email_updates_enabled, consented_at, created_at, updated_at
     ) VALUES (?, 1, 1, 1, 1, ?, ?, ?)`,
  ).run(userId, NOW, NOW, NOW);
  raw.prepare(
    `INSERT INTO saved_items (id, user_id, item_type, item_id, label, metadata_json, created_at)
     VALUES ('saved-b', ?, 'venue', 'venue-b', 'B venue', '{}', ?),
            ('saved-a', ?, 'venue', 'venue-a', 'A venue', '{}', ?)`,
  ).run(userId, NOW, userId, NOW);
  raw.prepare(
    `INSERT INTO auth_sessions (
       token_hash, user_id, created_at, expires_at, last_ip_hash, user_agent_hash
     ) VALUES ('abcdefghijklmnopqrstuvwxyz-secret-token', ?, ?, ?, 'ip-hash', 'ua-hash')`,
  ).run(userId, NOW, NEXT_WEEK);
  raw.prepare(
    `INSERT INTO billing_checkout_reservations (
       subject_type, subject_id, product_key, reservation_token,
       stripe_checkout_session_id, checkout_url, expires_at, created_at, updated_at
     ) VALUES ('consumer', ?, 'consumer-premium-monthly', ?, 'cs_private',
               'https://checkout.invalid/private', ?, ?, ?)`,
  ).run(userId, `reservation-${userId}`, NEXT_WEEK, NOW, NOW);
  raw.prepare(
    `INSERT INTO source_evidence_objects (
       id, owner_user_id, object_path, mime_type, byte_size, data_base64,
       external_url, retention_expires_at, created_at
     ) VALUES (?, ?, ?, 'image/jpeg', 10, 'cHJpdmF0ZQ==',
               'https://evidence.invalid/private', ?, ?)`,
  ).run(`evidence-${userId}`, userId, `accounts/${userId}/photo.jpg`, NEXT_WEEK, NOW);
  raw.prepare(
    `INSERT INTO submissions (
       id, user_id, venue_id, venue_name, status, submission_type, observed_at,
       source_photo_url, notes, reviewed_by, reviewed_at, created_at, updated_at
     ) VALUES (?, ?, 'venue-1', 'Test Venue', 'approved', 'menu_photo', ?,
               'https://photo.invalid/private', 'private note', 'operator', ?, ?, ?)`,
  ).run(`submission-${userId}`, userId, NOW, NOW, NOW, NOW);
  raw.prepare(
    `INSERT INTO submission_items (
       id, submission_id, beer_name, serving_size, price, created_at
     ) VALUES (?, ?, 'Test Lager', 'pint', 12.5, ?)`,
  ).run(`item-${userId}`, `submission-${userId}`, NOW);
  raw.prepare(
    `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
     VALUES (?, ?, 0, ?)`,
  ).run(`submission-${userId}`, `evidence-${userId}`, NOW);
  raw.prepare(
    `INSERT INTO contribution_ledger (
       id, user_id, submission_id, venue_id, points, reason, month_key, created_at
     ) VALUES (?, ?, ?, 'venue-1', 5, 'approved_submission', '2026-08', ?)`,
  ).run(`contribution-${userId}`, userId, `submission-${userId}`, NOW);
  raw.prepare(
    `INSERT INTO venue_price_records (
       id, venue_id, venue_name, beer_name, serving_size, price, source_type,
       source_submission_id, last_verified_at, created_at, updated_at
     ) VALUES (?, 'venue-1', 'Test Venue', 'Test Lager', 'pint', 12.5,
               'user_submission', ?, ?, ?, ?)`,
  ).run(`price-${userId}`, `submission-${userId}`, NOW, NOW, NOW);
  raw.prepare(
    `INSERT INTO system_state (key, value_json, updated_at, revision)
     VALUES ('venue-report-delivery:venue-1', ?, ?, 'report-revision-before')`,
  ).run(JSON.stringify({
    enabled: true,
    recipients: [email, "operator@example.test"],
    updatedBy: userId,
  }), NOW);
  raw.prepare(
    `INSERT INTO migration_quarantined_records (
       id, entity_type, original_id, reason, payload_json, quarantined_at
     ) VALUES (?, 'account', ?, 'test', ?, ?)`,
  ).run(`quarantine-${userId}`, userId, JSON.stringify({ userId, email }), NOW);
  raw.prepare(
    `INSERT INTO security_audit_log (
       id, actor_user_id, actor_role, action, target_type, target_id,
       metadata_json, ip_hash, user_agent_hash, created_at
     ) VALUES (?, ?, 'user', 'privacy-test', 'account', ?, ?, 'ip', 'ua', ?)`,
  ).run(`audit-${userId}`, userId, userId, JSON.stringify({ userId, email }), NOW);
  raw.prepare(
    `INSERT INTO events (
       id, user_id, event_type, metadata_json, created_at
     ) VALUES (?, 'operator', 'privacy-test', ?, ?)`,
  ).run(`event-${userId}`, JSON.stringify({ message: `${userId} ${email}` }), NOW);
  raw.prepare(
    `INSERT INTO stripe_webhook_events (
       id, event_type, status, payload_json, received_at, processed_at
     ) VALUES (?, 'customer.updated', 'applied', ?, ?, ?)`,
  ).run(
    `stripe-event-${userId}`,
    JSON.stringify({ data: { object: { metadata: { user_id: userId } } } }),
    NOW,
    NOW,
  );
}

function executeInput(
  userId: string,
  overrides: Partial<ExecuteAccountAnonymisationInput> = {},
): ExecuteAccountAnonymisationInput {
  return {
    requestId: `delete-${userId}`,
    attemptCount: 1,
    reviewedBy: "operator",
    now: NOW,
    completionNotificationDisposition: "none",
    providerPolicy: {
      requireTombstoneReceipt: true,
      allowUnconfirmedStripeDeletion: false,
    },
    ...overrides,
  };
}

function recursivelyCollectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) recursivelyCollectKeys(entry, keys);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      recursivelyCollectKeys(entry, keys);
    }
  }
  return keys;
}

describe("AccountPrivacyRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    insertAccount(raw, "operator", { email: "operator@example.test" });
    const database = new AsyncSqliteDatabase(raw);
    databases.push(database);
    return { raw, database, repository: new AccountPrivacyRepository(database) };
  }

  it("exports a deterministic, comprehensive snapshot without recipient encryption bytes", async () => {
    const created = fixture();
    insertAccount(created.raw, "export-user");
    insertProcessingRequest(created.raw, "export-user");
    insertRepresentativePrivateData(created.raw, "export-user");
    created.raw.prepare(
      "UPDATE accounts SET password_hash = 'DO-NOT-EXPORT-PASSWORD-HASH' WHERE id = 'export-user'",
    ).run();
    created.raw.prepare(
      `UPDATE billing_checkout_reservations
          SET reservation_token = 'DO-NOT-EXPORT-RESERVATION-TOKEN',
              checkout_url = 'https://checkout.invalid/DO-NOT-EXPORT-CAPABILITY'
        WHERE subject_type = 'consumer' AND subject_id = 'export-user'`,
    ).run();
    created.raw.prepare(
      `UPDATE account_deletion_requests
          SET last_error = 'DO-NOT-EXPORT-DELETION-ERROR',
              stripe_customer_id_snapshot = 'DO-NOT-EXPORT-STRIPE-SNAPSHOT'
        WHERE id = 'delete-export-user'`,
    ).run();
    created.raw.prepare(
      `UPDATE account_deletion_completion_outbox
          SET idempotency_key = 'DO-NOT-EXPORT-NOTICE-IDEMPOTENCY',
              payload_fingerprint = ?, lease_token = 'DO-NOT-EXPORT-LEASE',
              last_error = 'DO-NOT-EXPORT-NOTICE-ERROR'
        WHERE request_id = 'delete-export-user'`,
    ).run("f".repeat(64));
    created.raw.prepare(
      `UPDATE account_deletion_notice_recipient_secrets
          SET ciphertext = ?, key_id = 'DO-NOT-EXPORT-KEY-ID'
        WHERE request_id = 'delete-export-user'`,
    ).run(Buffer.from("DO-NOT-EXPORT-RECIPIENT-CIPHERTEXT"));
    created.raw.prepare(
      `UPDATE stripe_webhook_events
          SET processing_token = 'DO-NOT-EXPORT-STRIPE-PROCESSING-TOKEN',
              last_error = 'DO-NOT-EXPORT-STRIPE-ERROR',
              payload_json = ?
        WHERE id = 'stripe-event-export-user'`,
    ).run(JSON.stringify({
      data: {
        object: {
          client_secret: "DO-NOT-EXPORT-STRIPE-CLIENT-SECRET",
          metadata: { user_id: "export-user" },
        },
      },
    }));
    created.raw.prepare(
      `INSERT INTO free_pint_reward_codes (
         id, user_id, public_account_id, code_hash, created_at, expires_at
       ) VALUES (
         'reward-export-user', 'export-user', 'PP-export-user',
         'DO-NOT-EXPORT-REWARD-CODE-HASH', ?, ?
       )`,
    ).run(NOW, NEXT_WEEK);
    created.raw.prepare(
      "UPDATE submissions SET reviewed_by = 'export-user' WHERE id = 'submission-export-user'",
    ).run();

    const exported = await created.repository.exportAccountRelatedData({ userId: "export-user" });

    expect(exported.accountPrivate).toMatchObject({
      id: "export-user",
      email: "export-user@example.test",
      is_over_18_verified: 1,
    });
    expect(exported.profile).toMatchObject({ id: "export-user", username: "username-export-user" });
    expect(exported.preferences).toMatchObject({ preferred_suburbs_json: '["Fitzroy"]' });
    expect(exported.privacySettings).toMatchObject({ optional_analytics_enabled: 1 });
    expect(exported.savedItems.map((row) => row.id)).toEqual(["saved-a", "saved-b"]);
    expect(exported.sessions).toEqual([
      expect.objectContaining({ session_id: "abcdefghijklmnopqrstuvwx" }),
    ]);
    expect(exported.billingCheckoutReservations).toHaveLength(1);
    expect(exported.submissions).toEqual([
      expect.objectContaining({ id: "submission-export-user", notes: "private note" }),
    ]);
    expect(exported.submissions[0]).not.toHaveProperty("source_photo_url");
    expect(exported.submissionsReviewed[0]).not.toHaveProperty("source_photo_url");
    expect(exported.submissionItems).toEqual([
      expect.objectContaining({ id: "item-export-user" }),
    ]);
    expect(exported.submissionSourceEvidence).toEqual([
      expect.objectContaining({ evidence_id: "evidence-export-user" }),
    ]);
    expect(exported.sourceEvidenceMetadata).toEqual([
      expect.objectContaining({ id: "evidence-export-user", byte_size: 10 }),
    ]);
    expect(exported.sourceEvidenceMetadata[0]).not.toHaveProperty("object_path");
    expect(JSON.stringify(exported)).not.toContain("accounts/export-user/photo.jpg");
    expect(JSON.stringify(exported)).not.toContain("https://photo.invalid/private");
    expect(exported.venueReportDeliverySettings).toHaveLength(1);
    expect(exported.migrationQuarantinedRecords).toHaveLength(1);
    expect(exported.stripeWebhookEvents).toHaveLength(1);
    expect(exported.stripeWebhookEvents[0]).not.toHaveProperty("payload_json");
    expect(exported.billingCheckoutReservations[0]).not.toHaveProperty("checkout_url");
    expect(exported.freePintRewardCodes[0]).not.toHaveProperty("code_hash");
    expect(exported.deletionNotifications).toEqual([
      expect.not.objectContaining({ nonce: expect.anything() }),
    ]);
    expect(exported).not.toHaveProperty("deletionRecipientSecrets");
    const forbiddenKeys = [
      "password_hash",
      "token_hash",
      "reservation_token",
      "checkout_url",
      "code_hash",
      "idempotency_key",
      "payload_fingerprint",
      "lease_token",
      "processing_token",
      "ciphertext",
      "auth_tag",
      "nonce",
      "key_id",
      "stripe_customer_id_snapshot",
      "last_error",
    ];
    const exportedKeys = recursivelyCollectKeys(exported);
    for (const key of forbiddenKeys) expect(exportedKeys.has(key), key).toBe(false);
    const serialized = JSON.stringify(exported);
    for (const sentinel of [
      "DO-NOT-EXPORT-PASSWORD-HASH",
      "abcdefghijklmnopqrstuvwxyz-secret-token",
      "DO-NOT-EXPORT-RESERVATION-TOKEN",
      "DO-NOT-EXPORT-CAPABILITY",
      "DO-NOT-EXPORT-DELETION-ERROR",
      "DO-NOT-EXPORT-STRIPE-SNAPSHOT",
      "DO-NOT-EXPORT-NOTICE-IDEMPOTENCY",
      "DO-NOT-EXPORT-LEASE",
      "DO-NOT-EXPORT-RECIPIENT-CIPHERTEXT",
      "DO-NOT-EXPORT-KEY-ID",
      "DO-NOT-EXPORT-STRIPE-PROCESSING-TOKEN",
      "DO-NOT-EXPORT-STRIPE-ERROR",
      "DO-NOT-EXPORT-STRIPE-CLIENT-SECRET",
      "DO-NOT-EXPORT-REWARD-CODE-HASH",
    ]) expect(serialized, sentinel).not.toContain(sentinel);
    expect(Object.keys(exported)).toEqual([
      "accountPrivate", "profile", "preferences", "privacySettings", "savedItems",
      "billingCheckoutReservations", "sessions", "revokedProviderSessions", "discountPasses",
      "sourceEvidenceMetadata", "submissions", "submissionItems", "submissionSourceEvidence",
      "submissionsReviewed", "feedback", "wrongPriceReports", "venueRequests",
      "venueInterestRequests", "venueClaimRequests", "ageVerifications", "verifications",
      "missionProgress", "venueAssignments", "venuePendingChanges", "venuePartnerOutreach",
      "discountRedemptions", "pintPointDrinkRecords", "pintPointLedger", "freePintRewardCodes",
      "freePintRewardRedemptions", "contributionLedger", "rewardVouchers",
      "leaderboardPrizeAwards", "leaderboardPrizeCampaignsFinalized", "activity",
      "analyticsEvents", "securityAudit", "deletionRequests", "deletionNotifications",
      "deletionNotificationEvents", "venueReportDeliverySettings", "migrationQuarantinedRecords",
      "stripeWebhookEvents",
    ]);
  });

  it("anonymises all representative data and activates completion notification atomically", async () => {
    const created = fixture();
    insertAccount(created.raw, "delete-user");
    insertProcessingRequest(created.raw, "delete-user");
    insertRepresentativePrivateData(created.raw, "delete-user");

    const summary = await created.repository.executeAccountAnonymisation(executeInput(
      "delete-user",
      {
        completionNotificationDisposition: "enqueue_live",
        completionNotificationRetentionExpiresAt: NEXT_WEEK,
      },
    ));

    expect(summary).toEqual({
      anonymisedAccount: expect.stringMatching(/^DEL-[A-F0-9]{12}$/),
      surrogatePublicId: expect.stringMatching(/^DEL-[A-F0-9]{12}$/),
      evidenceIds: ["evidence-delete-user"],
      removedSubmissions: 1,
      removedSubmissionItems: 1,
      removedContributionRows: 1,
      removedDerivedPriceRecords: 1,
      retentionPolicyVersion: ACCOUNT_PRIVACY_RETENTION_POLICY_VERSION,
      transactionContractVersion: ACCOUNT_PRIVACY_TRANSACTION_CONTRACT_VERSION,
    });
    expect(ACCOUNT_PRIVACY_SOURCE_EVIDENCE_LOCK_VERSION).toBe(1);
    expect(summary.anonymisedAccount).toBe(summary.surrogatePublicId);
    expect(created.raw.prepare("SELECT * FROM accounts WHERE id = 'delete-user'").get()).toMatchObject({
      public_account_id: summary.surrogatePublicId,
      email: "deleted-delete-user@invalid.pintpath.local",
      password_hash: "deleted",
      auth_provider: "deleted",
      is_over_18_verified: 0,
      subscription_status: "free",
      status: "suspended",
    });
    expect(created.raw.prepare("SELECT * FROM profiles WHERE id = 'delete-user'").get()).toMatchObject({
      public_account_id: summary.surrogatePublicId,
      username: null,
      is_over_18_verified: 0,
      account_status: "suspended",
    });
    for (const table of [
      "account_preferences", "account_privacy_settings", "saved_items", "auth_sessions",
      "billing_checkout_reservations", "submissions", "submission_items", "contribution_ledger",
      "venue_price_records",
    ]) {
      expect((created.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
        .toBe(0);
    }
    expect(created.raw.prepare(
      "SELECT * FROM source_evidence_objects WHERE id = 'evidence-delete-user'",
    ).get()).toMatchObject({
      owner_user_id: null,
      data_base64: null,
      external_url: null,
      byte_size: null,
      deleted_at: NOW,
    });
    const report = created.raw.prepare(
      "SELECT value_json, revision FROM system_state WHERE key = 'venue-report-delivery:venue-1'",
    ).get() as { value_json: string; revision: string };
    expect(JSON.parse(report.value_json)).toEqual({
      enabled: true,
      recipients: ["operator@example.test"],
      updatedBy: null,
      redactedAfterAccountDeletion: true,
    });
    expect(report.revision).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.revision).not.toContain("#");
    expect(created.raw.prepare(
      "SELECT payload_json FROM migration_quarantined_records WHERE id = 'quarantine-delete-user'",
    ).get()).toEqual({ payload_json: '{"redactedAfterAccountDeletion":true}' });
    expect(created.raw.prepare(
      "SELECT payload_json, last_error FROM stripe_webhook_events WHERE id = 'stripe-event-delete-user'",
    ).get()).toEqual({ payload_json: null, last_error: null });
    expect(created.raw.prepare(
      "SELECT metadata_json FROM events WHERE id = 'event-delete-user'",
    ).get()).toEqual({
      metadata_json: expect.not.stringContaining("delete-user@example.test"),
    });
    expect(created.raw.prepare(
      "SELECT status, completed_at, result_summary_json FROM account_deletion_requests WHERE id = 'delete-delete-user'",
    ).get()).toMatchObject({
      status: "completed",
      completed_at: NOW,
      result_summary_json: JSON.stringify(summary),
    });
    expect(created.raw.prepare(
      "SELECT status, completed_at, next_attempt_at, retention_expires_at FROM account_deletion_completion_outbox WHERE request_id = 'delete-delete-user'",
    ).get()).toEqual({
      status: "pending",
      completed_at: NOW,
      next_attempt_at: NOW,
      retention_expires_at: NEXT_WEEK,
    });
    expect(created.raw.prepare(
      "SELECT purge_after FROM account_deletion_notice_recipient_secrets WHERE request_id = 'delete-delete-user'",
    ).get()).toEqual({ purge_after: NEXT_WEEK });
  });

  it("rolls every privacy mutation back when the completion notification is not prepared", async () => {
    const created = fixture();
    insertAccount(created.raw, "rollback-user");
    insertProcessingRequest(created.raw, "rollback-user", "delete-rollback-user", {
      prepareRecipient: false,
    });
    insertRepresentativePrivateData(created.raw, "rollback-user");
    const reportBefore = created.raw.prepare(
      "SELECT * FROM system_state WHERE key = 'venue-report-delivery:venue-1'",
    ).get();

    await expect(created.repository.executeAccountAnonymisation(executeInput(
      "rollback-user",
      {
        completionNotificationDisposition: "enqueue_live",
        completionNotificationRetentionExpiresAt: NEXT_WEEK,
      },
    ))).rejects.toMatchObject({
      code: "notification_not_prepared",
      message: "The completion notification was not durably prepared.",
    });

    expect(created.raw.prepare("SELECT email, status FROM accounts WHERE id = 'rollback-user'").get())
      .toEqual({ email: "rollback-user@example.test", status: "active" });
    expect(created.raw.prepare("SELECT id FROM submissions WHERE id = 'submission-rollback-user'").get())
      .toEqual({ id: "submission-rollback-user" });
    expect(created.raw.prepare(
      "SELECT * FROM system_state WHERE key = 'venue-report-delivery:venue-1'",
    ).get()).toEqual(reportBefore);
    expect(created.raw.prepare(
      "SELECT status, result_summary_json FROM account_deletion_requests WHERE id = 'delete-rollback-user'",
    ).get()).toEqual({ status: "processing", result_summary_json: null });
    expect(created.database.metrics().transactionFailures).toBe(1);
  });

  it("fails closed on malformed report-recipient JSON and rolls the transaction back", async () => {
    const created = fixture();
    insertAccount(created.raw, "invalid-json-user");
    insertProcessingRequest(created.raw, "invalid-json-user");
    created.raw.prepare(
      `INSERT INTO system_state (key, value_json, updated_at, revision)
       VALUES ('venue-report-delivery:invalid', '{bad-json', ?, 'revision')`,
    ).run(NOW);

    await expect(created.repository.executeAccountAnonymisation(executeInput("invalid-json-user")))
      .rejects.toMatchObject({ code: "stored_json_invalid" });
    expect(created.raw.prepare("SELECT email FROM accounts WHERE id = 'invalid-json-user'").get())
      .toEqual({ email: "invalid-json-user@example.test" });
    expect(created.raw.prepare(
      "SELECT status FROM account_deletion_requests WHERE id = 'delete-invalid-json-user'",
    ).get()).toEqual({ status: "processing" });
  });

  it("fences stale attempts and makes a contending winning attempt idempotent", async () => {
    const created = fixture();
    insertAccount(created.raw, "fenced-user");
    insertProcessingRequest(created.raw, "fenced-user", "delete-fenced-user", {
      prepareNotification: false,
    });

    await expect(created.repository.executeAccountAnonymisation(executeInput(
      "fenced-user",
      { attemptCount: 2 },
    ))).rejects.toMatchObject({ code: "deletion_attempt_conflict" });
    expect(created.raw.prepare("SELECT status FROM accounts WHERE id = 'fenced-user'").get())
      .toEqual({ status: "active" });

    const [first, second] = await Promise.all([
      created.repository.executeAccountAnonymisation(executeInput("fenced-user")),
      created.repository.executeAccountAnonymisation(executeInput("fenced-user")),
    ]);
    expect(second).toEqual(first);
    expect(await created.repository.executeAccountAnonymisation(executeInput("fenced-user")))
      .toEqual(first);
    await expect(created.repository.executeAccountAnonymisation(executeInput(
      "fenced-user",
      { attemptCount: 2 },
    ))).rejects.toMatchObject({ code: "deletion_attempt_conflict" });

    created.raw.prepare(
      `UPDATE account_deletion_requests
          SET result_summary_json = json_remove(result_summary_json, '$.transactionContractVersion')
        WHERE id = 'delete-fenced-user'`,
    ).run();
    await expect(created.repository.executeAccountAnonymisation(executeInput("fenced-user")))
      .rejects.toMatchObject({ code: "completion_conflict" });
  });

  it("suppresses restore notifications and purges recipient material in the completion transaction", async () => {
    const created = fixture();
    insertAccount(created.raw, "restore-user");
    insertProcessingRequest(created.raw, "restore-user");

    await created.repository.executeAccountAnonymisation(executeInput(
      "restore-user",
      { completionNotificationDisposition: "suppress_restore" },
    ));

    expect(created.raw.prepare(
      `SELECT status, terminal_at, next_attempt_at, lease_token, lease_expires_at,
              secret_purge_checkpoint_pending, secret_purge_generation
         FROM account_deletion_completion_outbox
        WHERE request_id = 'delete-restore-user'`,
    ).get()).toEqual({
      status: "suppressed_restore",
      terminal_at: NOW,
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
      secret_purge_checkpoint_pending: 1,
      secret_purge_generation: 1,
    });
    expect(created.raw.prepare(
      "SELECT request_id FROM account_deletion_notice_recipient_secrets WHERE request_id = 'delete-restore-user'",
    ).get()).toBeUndefined();
    expect(created.raw.prepare(
      "SELECT status FROM account_deletion_requests WHERE id = 'delete-restore-user'",
    ).get()).toEqual({ status: "completed" });
  });

  it("requires durable identity, Stripe, and tombstone receipts before local anonymisation", async () => {
    const created = fixture();
    insertAccount(created.raw, "provider-user", {
      supabaseUserId: "supabase-provider-user",
      stripeCustomerId: "cus_provider_user",
    });
    insertProcessingRequest(created.raw, "provider-user", "delete-provider-user", {
      tombstoneRecordedAt: null,
      stripeSnapshot: "cus_provider_user",
      prepareNotification: false,
    });

    await expect(created.repository.executeAccountAnonymisation(executeInput("provider-user")))
      .rejects.toMatchObject({ code: "identity_deletion_unconfirmed" });
    created.raw.prepare(
      "UPDATE account_deletion_requests SET identity_deleted_at = ? WHERE id = 'delete-provider-user'",
    ).run(NOW);
    await expect(created.repository.executeAccountAnonymisation(executeInput("provider-user")))
      .rejects.toMatchObject({ code: "stripe_deletion_unconfirmed" });
    created.raw.prepare(
      "UPDATE account_deletion_requests SET stripe_customer_deleted_at = ? WHERE id = 'delete-provider-user'",
    ).run(NOW);
    await expect(created.repository.executeAccountAnonymisation(executeInput("provider-user")))
      .rejects.toMatchObject({ code: "tombstone_unconfirmed" });

    expect(created.raw.prepare("SELECT status FROM accounts WHERE id = 'provider-user'").get())
      .toEqual({ status: "active" });
  });
});
