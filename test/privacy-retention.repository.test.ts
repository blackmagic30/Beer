import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  ACCOUNT_DATA_RETENTION_POLICY,
  PrivacyRetentionRepository,
  PrivacyRetentionRepositoryError,
  type PrivacyRetentionInput,
} from "../src/db/privacy-retention.repository.js";
import {
  asAsyncSqliteDatabase,
  type SqlDatabase,
  type SqlStatement,
} from "../src/db/sql-database.js";

const AS_OF = "2026-08-09T00:00:00.000Z";
const POLICY_CUTOFF = "2026-07-10T00:00:00.000Z";
const PROVIDER_CUTOFF = "2026-05-11T00:00:00.000Z";
const ENVELOPE_CUTOFF = "2025-07-05T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const VERY_OLD = "2025-01-01T00:00:00.000Z";
const RECENT = "2026-08-01T00:00:00.000Z";
const FUTURE = "2026-09-01T00:00:00.000Z";

const INPUT: PrivacyRetentionInput = {
  asOf: AS_OF,
  authSessionCutoff: POLICY_CUTOFF,
  providerRevocationCutoff: PROVIDER_CUTOFF,
  stripePayloadCutoff: POLICY_CUTOFF,
  stripeEnvelopeCutoff: ENVELOPE_CUTOFF,
  securityFingerprintCutoff: POLICY_CUTOFF,
  securityEnvelopeCutoff: ENVELOPE_CUTOFF,
  reviewedLocationCutoff: POLICY_CUTOFF,
  migrationQuarantineCutoff: POLICY_CUTOFF,
  deletionNotificationEventCutoff: POLICY_CUTOFF,
  batchLimit: 500,
};

const openDatabases: SqlDatabase[] = [];

function fixture() {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = asAsyncSqliteDatabase(raw);
  openDatabases.push(database);
  return { raw, database, repository: new PrivacyRetentionRepository(database) };
}

function insertAccount(raw: BetterSqlite3.Database, id = "retention-user") {
  raw.prepare(
    `INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
     VALUES (?, ?, 'hash', ?, ?)`,
  ).run(id, `${id}@example.test`, VERY_OLD, VERY_OLD);
}

function insertDeletionNotice(
  raw: BetterSqlite3.Database,
  input: { suffix: string; status: string; retentionExpiresAt: string },
) {
  const userId = `notice-user-${input.suffix}`;
  const requestId = `notice-request-${input.suffix}`;
  insertAccount(raw, userId);
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, completed_at, created_at, updated_at
     ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
  ).run(requestId, userId, VERY_OLD, VERY_OLD, VERY_OLD, VERY_OLD, VERY_OLD);
  raw.prepare(
    `INSERT INTO account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status,
       retention_expires_at, created_at, updated_at
     ) VALUES (?, 'v1', ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    `notice-key-${input.suffix}`,
    input.status,
    input.retentionExpiresAt,
    VERY_OLD,
    VERY_OLD,
  );
  raw.prepare(
    `INSERT INTO account_deletion_notification_events (
       event_id, request_id, provider_message_id, event_type,
       event_created_at, received_at, payload_sha256
     ) VALUES (?, ?, ?, 'delivered', ?, ?, ?)`,
  ).run(
    `notice-event-${input.suffix}`,
    requestId,
    `provider-${input.suffix}`,
    VERY_OLD,
    VERY_OLD,
    input.suffix.padEnd(64, "a").slice(0, 64),
  );
}

function seedAllOutcomes(raw: BetterSqlite3.Database) {
  insertAccount(raw);
  const insertSession = raw.prepare(
    `INSERT INTO auth_sessions (
       token_hash, user_id, created_at, expires_at, revoked_at, last_ip_hash, user_agent_hash
     ) VALUES (?, 'retention-user', ?, ?, ?, 'ip', 'agent')`,
  );
  insertSession.run("expired-old", VERY_OLD, OLD, null);
  insertSession.run("revoked-old", VERY_OLD, FUTURE, OLD);
  insertSession.run("active", RECENT, FUTURE, null);
  insertSession.run("expired-recent", RECENT, RECENT, null);

  const insertRevocation = raw.prepare(
    `INSERT INTO revoked_provider_sessions (
       user_id, provider_session_id_hash, revoked_at, reason
     ) VALUES ('retention-user', ?, ?, ?)`,
  );
  insertRevocation.run("provider-old", VERY_OLD, "all_app_sessions_revoked");
  insertRevocation.run("provider-protected", VERY_OLD, "device_compromise");
  insertRevocation.run("provider-recent", RECENT, "password_reset_completed");

  const insertStripe = raw.prepare(
    `INSERT INTO stripe_webhook_events (
       id, event_type, status, event_created_at, payload_json, attempts,
       last_error, received_at, applied_at, processed_at, processing_token
     ) VALUES (?, 'customer.updated', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  insertStripe.run("stripe-redact", "applied", OLD, '{"private":"payload"}', "private-error", OLD, OLD, OLD, null);
  insertStripe.run("stripe-envelope", "applied", VERY_OLD, null, null, VERY_OLD, VERY_OLD, VERY_OLD, null);
  insertStripe.run("stripe-pending", "pending", VERY_OLD, '{"keep":"pending"}', "retry", VERY_OLD, null, VERY_OLD, null);
  insertStripe.run("stripe-processing", "processing", VERY_OLD, '{"keep":"processing"}', "retry", VERY_OLD, null, VERY_OLD, "lease");
  insertStripe.run("stripe-failed", "failed", VERY_OLD, '{"keep":"failed"}', "retry", VERY_OLD, null, VERY_OLD, null);

  const insertAudit = raw.prepare(
    `INSERT INTO security_audit_log (
       id, action, metadata_json, ip_hash, user_agent_hash, created_at
     ) VALUES (?, 'retention-test', '{}', ?, ?, ?)`,
  );
  insertAudit.run("audit-fingerprint", "ip", "agent", OLD);
  insertAudit.run("audit-envelope", null, null, VERY_OLD);
  insertAudit.run("audit-recent", "ip", "agent", RECENT);

  const insertSubmission = raw.prepare(
    `INSERT INTO submissions (
       id, user_id, venue_id, venue_name, status, submission_type, observed_at,
       upload_latitude, upload_longitude, upload_accuracy_meters,
       upload_location_captured_at, reviewed_at, created_at, updated_at
     ) VALUES (?, 'retention-user', 'venue', 'Venue', ?, 'price_update', ?,
               -37.8, 144.9, 10, ?, ?, ?, ?)`,
  );
  insertSubmission.run("submission-terminal", "approved", OLD, OLD, OLD, OLD, OLD);
  insertSubmission.run("submission-pending", "pending", OLD, OLD, OLD, OLD, OLD);
  insertSubmission.run("submission-evidence", "needs_more_evidence", OLD, OLD, OLD, OLD, OLD);
  insertSubmission.run("submission-disputed", "disputed", OLD, OLD, OLD, OLD, OLD);
  insertSubmission.run("submission-recent", "approved", RECENT, RECENT, RECENT, RECENT, RECENT);

  const insertQuarantine = raw.prepare(
    `INSERT INTO migration_quarantined_records (
       id, entity_type, original_id, reason, payload_json, quarantined_at
     ) VALUES (?, 'account', ?, 'test', ?, ?)`,
  );
  insertQuarantine.run("quarantine-old", "old", '{"private":"value"}', OLD);
  insertQuarantine.run("quarantine-redacted", "already", '{"redactedAfterRetention":true}', OLD);
  insertQuarantine.run("quarantine-recent", "recent", '{"private":"recent"}', RECENT);

  insertDeletionNotice(raw, { suffix: "expired", status: "delivered", retentionExpiresAt: OLD });
  insertDeletionNotice(raw, { suffix: "unexpired", status: "delivered", retentionExpiresAt: FUTURE });
  insertDeletionNotice(raw, { suffix: "active", status: "sending", retentionExpiresAt: OLD });
}

afterEach(async () => {
  while (openDatabases.length > 0) await openDatabases.pop()?.close().catch(() => undefined);
});

describe("PrivacyRetentionRepository on SQLite", () => {
  it("owns the executable policy and defers Stripe envelope deletion to tombstones", () => {
    expect(ACCOUNT_DATA_RETENTION_POLICY).toMatchObject({
      version: "2026-08-03",
      stripeWebhookEventEnvelope: {
        action: "delete_after_durable_idempotency_tombstone",
        daysAfterReceipt: 400,
      },
    });
  });

  it("applies every safe policy outcome while preserving active, open-review, retryable, and unexpired state", async () => {
    const { raw, repository } = fixture();
    seedAllOutcomes(raw);

    const result = await repository.prunePrivacyRetention(INPUT);

    expect(result).toEqual({
      authSessionsDeleted: 2,
      providerRevocationsDeleted: 1,
      stripePayloadsRedacted: 1,
      stripeEnvelopesDeleted: 0,
      securityFingerprintsRedacted: 1,
      securityEnvelopesDeleted: 1,
      reviewedLocationsPurged: 1,
      migrationQuarantinePayloadsRedacted: 1,
      deletionNotificationEventsDeleted: 1,
      processedCount: 9,
      progressed: true,
      hasMore: true,
      hasActionableMore: false,
      stalled: false,
      stripeEnvelopeDeletionDeferred: true,
      stripeEnvelopesAwaitingTombstoneInBatch: 1,
    });
    expect(raw.prepare("SELECT token_hash FROM auth_sessions ORDER BY token_hash").all())
      .toEqual([{ token_hash: "active" }, { token_hash: "expired-recent" }]);
    expect(raw.prepare("SELECT provider_session_id_hash FROM revoked_provider_sessions ORDER BY provider_session_id_hash").all())
      .toEqual([{ provider_session_id_hash: "provider-protected" }, { provider_session_id_hash: "provider-recent" }]);
    expect(raw.prepare("SELECT id, payload_json, last_error FROM stripe_webhook_events ORDER BY id").all())
      .toEqual([
        { id: "stripe-envelope", payload_json: null, last_error: null },
        { id: "stripe-failed", payload_json: '{"keep":"failed"}', last_error: "retry" },
        { id: "stripe-pending", payload_json: '{"keep":"pending"}', last_error: "retry" },
        { id: "stripe-processing", payload_json: '{"keep":"processing"}', last_error: "retry" },
        { id: "stripe-redact", payload_json: null, last_error: null },
      ]);
    expect(raw.prepare(
      `SELECT id, upload_latitude FROM submissions
        WHERE id IN ('submission-terminal', 'submission-pending', 'submission-evidence', 'submission-disputed')
        ORDER BY id`,
    ).all()).toEqual([
      { id: "submission-disputed", upload_latitude: -37.8 },
      { id: "submission-evidence", upload_latitude: -37.8 },
      { id: "submission-pending", upload_latitude: -37.8 },
      { id: "submission-terminal", upload_latitude: null },
    ]);
    expect(raw.prepare("SELECT event_id FROM account_deletion_notification_events ORDER BY event_id").all())
      .toEqual([{ event_id: "notice-event-active" }, { event_id: "notice-event-unexpired" }]);

    await expect(repository.prunePrivacyRetention(INPUT)).resolves.toMatchObject({
      processedCount: 0,
      progressed: false,
      hasMore: true,
      hasActionableMore: false,
      stalled: true,
      stripeEnvelopesAwaitingTombstoneInBatch: 1,
    });
  });

  it("enforces one total batch budget and drains deterministically without double-counting", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw);
    const insert = raw.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, 'retention-user', ?, ?)`,
    );
    insert.run("session-c", VERY_OLD, OLD);
    insert.run("session-a", VERY_OLD, OLD);
    insert.run("session-b", VERY_OLD, OLD);
    const input = { ...INPUT, batchLimit: 2 };

    const [first, second] = await Promise.all([
      repository.prunePrivacyRetention(input),
      repository.prunePrivacyRetention(input),
    ]);

    expect(first.authSessionsDeleted + second.authSessionsDeleted).toBe(3);
    expect(first.processedCount + second.processedCount).toBe(3);
    expect(first.processedCount).toBeLessThanOrEqual(2);
    expect(second.processedCount).toBeLessThanOrEqual(2);
    expect(raw.prepare("SELECT count(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
    await expect(repository.prunePrivacyRetention(input)).resolves.toMatchObject({
      processedCount: 0,
      hasMore: false,
      stalled: false,
    });
  });

  it("rolls the complete batch back on an injected persistence failure and keeps failures secret-safe", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw);
    raw.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES ('rollback-session', 'retention-user', ?, ?)`,
    ).run(VERY_OLD, OLD);
    raw.prepare(
      `INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       ) VALUES ('retention-user', 'rollback-provider', ?, 'all_app_sessions_revoked')`,
    ).run(VERY_OLD);
    raw.exec(`CREATE TRIGGER reject_retention_provider_delete
      BEFORE DELETE ON revoked_provider_sessions
      BEGIN SELECT RAISE(ABORT, 'private retention trigger detail'); END`);

    const failure = await repository.prunePrivacyRetention(INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PrivacyRetentionRepositoryError);
    expect(failure).toMatchObject({ code: "persistence_failure" });
    expect(String(failure)).not.toContain("private retention trigger detail");
    expect(raw.prepare("SELECT count(*) AS count FROM auth_sessions WHERE token_hash = 'rollback-session'").get())
      .toEqual({ count: 1 });
    expect(raw.prepare("SELECT count(*) AS count FROM revoked_provider_sessions").get())
      .toEqual({ count: 1 });
  });

  it("rejects noncanonical policy bounds and malformed native results", async () => {
    const { database } = fixture();
    const repository = new PrivacyRetentionRepository(database);
    await expect(repository.prunePrivacyRetention({ ...INPUT, asOf: "2026-08-09T00:00:00Z" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.prunePrivacyRetention({ ...INPUT, batchLimit: 501 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.prunePrivacyRetention({ ...INPUT, stripeEnvelopeCutoff: AS_OF }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const malformed: SqlDatabase = {
      dialect: database.dialect,
      prepare(sql: string): SqlStatement {
        const statement = database.prepare(sql);
        if (!sql.startsWith("SELECT\n         EXISTS")) return statement;
        return {
          ...statement,
          get: async () => ({
            authSessions: "private malformed value",
            providerRevocations: 0,
            stripePayloads: 0,
            stripeEnvelopes: 0,
            securityFingerprints: 0,
            securityEnvelopes: 0,
            reviewedLocations: 0,
            migrationQuarantinePayloads: 0,
            deletionNotificationEvents: 0,
            stripeEnvelopeBatchCount: 0,
          }),
        };
      },
      exec: (sql) => database.exec(sql),
      transaction: (work) => database.transaction(work),
      close: () => database.close(),
      metrics: () => database.metrics(),
    };
    await expect(new PrivacyRetentionRepository(malformed).prunePrivacyRetention(INPUT))
      .rejects.toMatchObject({ code: "malformed_result" });
  });

  it("maps a closed database failure without leaking driver details", async () => {
    const { database, repository } = fixture();
    await database.close();
    const failure = await repository.prunePrivacyRetention(INPUT).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "persistence_failure" });
    expect(String(failure)).not.toContain("closed");
  });
});
