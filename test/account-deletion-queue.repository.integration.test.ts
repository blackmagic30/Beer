import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT,
  AccountDeletionQueueRepository,
} from "../src/db/account-deletion-queue.repository.js";
import { createPostgresAccountDeletionSecretPhysicalCheckpoint } from
  "../src/lib/account-deletion-secret-checkpoint.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_ACCOUNT_DELETION_QUEUE_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const resourceSuffix = crypto.randomBytes(6).toString("hex");
const TEST_DATABASE = `pintpath_adq_${resourceSuffix}`;
const TEST_LOGIN = `pintpath_adq_login_${resourceSuffix}`;
const STALE = "2026-08-08T01:00:00.000Z";
const NOW = "2026-08-08T02:00:00.000Z";
const FIVE_MINUTES = "2026-08-08T02:05:00.000Z";
const TEN_MINUTES = "2026-08-08T02:10:00.000Z";
const NEXT_WEEK = "2026-08-15T02:00:00.000Z";

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(
      `${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`,
    );
  }
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1
    && bindings[0] !== null
    && typeof bindings[0] === "object"
    && !Array.isArray(bindings[0])
    && !Buffer.isBuffer(bindings[0])
    && !(bindings[0] instanceof Date)
  ) return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value === null || typeof value !== "object") return value;
  return JSON.stringify(value);
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  ) as Row;
}

/** Direct PG adapter limited to the disposable loopback integration database. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return { rows: result.rows.map(normalizeRow), rowCount: result.rowCount ?? 0 };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `adq_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run({ client, nextSavepoint: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("real PG17 account-deletion queue repository", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let competingDatabase: LoopbackPostgresTestDatabase | null = null;
  let repository: AccountDeletionQueueRepository;
  let competingRepository: AccountDeletionQueueRepository;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    const runtimeUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password);
    database = new LoopbackPostgresTestDatabase(runtimeUrl);
    competingDatabase = new LoopbackPostgresTestDatabase(runtimeUrl);
    repository = new AccountDeletionQueueRepository(database);
    competingRepository = new AccountDeletionQueueRepository(competingDatabase);
  }, 30_000);

  afterAll(async () => {
    await competingDatabase?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      const leftovers = await admin.query<{ database_exists: boolean; role_exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS role_exists`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      await admin.end().catch(() => undefined);
      if (leftovers.rows[0]?.database_exists || leftovers.rows[0]?.role_exists) {
        throw new Error("Disposable account-deletion integration resources were not removed.");
      }
    }
  }, 30_000);

  async function insertAccount(id: string): Promise<void> {
    await database!.prepare(
      `INSERT INTO accounts (
         id, public_account_id, email, password_hash, display_name, role,
         subscription_status, created_at, updated_at
       ) VALUES (
         @id, @publicId, @email, 'hash', @id, 'user', 'free', @now, @now
       )`,
    ).run({ id, publicId: `PP-${id}`, email: `${id}@example.test`, now: NOW });
  }

  async function prepareActiveNotification(requestId: string, userId: string): Promise<void> {
    await insertAccount(userId);
    await repository.createAccountDeletionRequest({
      id: requestId,
      userId,
      userMessage: null,
      requestedAt: NOW,
      executeAfter: FIVE_MINUTES,
    });
    await repository.beginAccountDeletionWithCompletionNotification({
      requestId,
      reviewedBy: "operator",
      now: NOW,
      staleBefore: STALE,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKey: `notice:${requestId}`,
      keyId: "pg-key-v1",
      nonce: Buffer.from("00112233445566778899aabb", "hex"),
      ciphertext: Buffer.from(`ciphertext:${requestId}`),
      authTag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      purgeAfter: NEXT_WEEK,
    });
    await database!.prepare(
      `UPDATE account_deletion_requests
          SET status = 'completed', completed_at = @now, updated_at = @now
        WHERE id = @requestId`,
    ).run({ requestId, now: NOW });
    await database!.prepare(
      `UPDATE account_deletion_completion_outbox
          SET status = 'pending', completed_at = @now, next_attempt_at = @now,
              retention_expires_at = @retention, updated_at = @now
        WHERE request_id = @requestId`,
    ).run({ requestId, now: NOW, retention: NEXT_WEEK });
  }

  it("preserves async queue semantics, native values, and single-statement claim fencing", async () => {
    await insertAccount("operator");
    await insertAccount("pg-user");
    const [first, second] = await Promise.all([
      repository.createAccountDeletionRequest({
        id: "pg-request-one",
        userId: "pg-user",
        userMessage: null,
        requestedAt: NOW,
        executeAfter: FIVE_MINUTES,
      }),
      repository.createAccountDeletionRequest({
        id: "pg-request-two",
        userId: "pg-user",
        userMessage: null,
        requestedAt: NOW,
        executeAfter: FIVE_MINUTES,
      }),
    ]);
    expect(first.id).toBe(second.id);
    const requestId = first.id;
    const ciphertext = Buffer.from("postgres-recipient-ciphertext");
    const begun = await repository.beginAccountDeletionWithCompletionNotification({
      requestId,
      reviewedBy: "operator",
      now: NOW,
      staleBefore: STALE,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKey: `notice:${requestId}`,
      keyId: "pg-key-v1",
      nonce: Buffer.from("00112233445566778899aabb", "hex"),
      ciphertext,
      authTag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      purgeAfter: NEXT_WEEK,
    });
    expect(begun).toMatchObject({ status: "processing", attempt_count: 1 });
    expect((await repository.getAccountDeletionNoticeRecipientSecret(requestId))?.ciphertext)
      .toEqual(ciphertext);
    expect((await repository.getAccountDeletionCompletionOutbox(requestId))
      ?.secret_purge_checkpoint_pending).toBe(false);
    await database!.prepare(
      `UPDATE account_deletion_requests
          SET status = 'completed', completed_at = @now, updated_at = @now
        WHERE id = @requestId`,
    ).run({ requestId, now: NOW });
    await database!.prepare(
      `UPDATE account_deletion_completion_outbox
          SET status = 'pending', completed_at = @now, next_attempt_at = @now,
              retention_expires_at = @retention, updated_at = @now
        WHERE request_id = @requestId`,
    ).run({ requestId, now: NOW, retention: NEXT_WEEK });

    const [claimOne, claimTwo] = await Promise.all([
      repository.claimNextAccountDeletionCompletionNotification({
        now: NOW,
        staleBefore: STALE,
        leaseToken: "pg-lease-one",
        leaseExpiresAt: FIVE_MINUTES,
      }),
      repository.claimNextAccountDeletionCompletionNotification({
        now: NOW,
        staleBefore: STALE,
        leaseToken: "pg-lease-two",
        leaseExpiresAt: FIVE_MINUTES,
      }),
    ]);
    expect([claimOne, claimTwo].filter(Boolean)).toHaveLength(1);
    const winningToken = claimOne?.lease_token ?? claimTwo?.lease_token;
    const losingToken = winningToken === "pg-lease-one" ? "pg-lease-two" : "pg-lease-one";
    expect(await repository.lockAccountDeletionNotificationPayload({
      requestId,
      leaseToken: losingToken,
      payloadFingerprint: "a".repeat(64),
      now: NOW,
    })).toBe(false);
    expect(await repository.lockAccountDeletionNotificationPayload({
      requestId,
      leaseToken: winningToken!,
      payloadFingerprint: "a".repeat(64),
      now: NOW,
    })).toBe(true);
    expect(await repository.markAccountDeletionNotificationAccepted({
      requestId,
      leaseToken: winningToken!,
      providerMessageId: "pg-provider-message",
      acceptedAt: NOW,
      nextCheckAt: FIVE_MINUTES,
    })).toBe(true);
    const accepted = await repository.getAccountDeletionCompletionOutbox(requestId);
    expect(accepted).toMatchObject({
      status: "accepted",
      payload_fingerprint: "a".repeat(64),
      secret_purge_checkpoint_pending: false,
    });
    expect(typeof accepted?.secret_purge_checkpoint_pending).toBe("boolean");

    const claimedForDelivery = await repository.claimNextAccountDeletionCompletionNotification({
      now: FIVE_MINUTES,
      staleBefore: NOW,
      leaseToken: "pg-delivery-lease",
      leaseExpiresAt: TEN_MINUTES,
    });
    expect(claimedForDelivery?.lease_token).toBe("pg-delivery-lease");
    expect(await repository.markAccountDeletionNotificationDelivered({
      requestId,
      leaseToken: "pg-delivery-lease",
      providerEvent: "delivered",
      eventAt: FIVE_MINUTES,
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await repository.getAccountDeletionNoticeRecipientSecret(requestId)).toBeNull();
    expect(await repository.captureAccountDeletionNotificationSecretPurgeCheckpoint())
      .toEqual([{ requestId, generation: 1 }]);
    expect(await repository.acknowledgeAccountDeletionNotificationSecretPurgeCheckpoint([
      { requestId, generation: 1 },
    ])).toBe(1);
    expect(await repository.getAccountDeletionCompletionOutbox(requestId)).toMatchObject({
      status: "delivered",
      secret_purge_checkpoint_pending: false,
      secret_purge_generation: 1,
    });
    expect(await repository.countAccountDeletionRequests()).toBe(1);
  }, 30_000);

  it("rejects a purge acknowledgement when another session reinserts the recipient after physical verification", async () => {
    await insertAccount("pg-checkpoint-operator");
    await insertAccount("pg-checkpoint-user");
    await repository.createAccountDeletionRequest({
      id: "pg-checkpoint-request",
      userId: "pg-checkpoint-user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: FIVE_MINUTES,
    });
    expect(await repository.beginAccountDeletionWithCompletionNotification({
      requestId: "pg-checkpoint-request",
      reviewedBy: "pg-checkpoint-operator",
      now: NOW,
      staleBefore: STALE,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKey: "notice:pg-checkpoint-request",
      keyId: "pg-checkpoint-key-v1",
      nonce: Buffer.from("00112233445566778899aabb", "hex"),
      ciphertext: Buffer.from("first-checkpoint-recipient"),
      authTag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      purgeAfter: FIVE_MINUTES,
    })).toMatchObject({ status: "processing", attempt_count: 1 });
    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(FIVE_MINUTES)).toBe(1);
    expect(await repository.captureAccountDeletionNotificationSecretPurgeCheckpoint())
      .toContainEqual({ requestId: "pg-checkpoint-request", generation: 1 });

    const physicalCheckpoint = createPostgresAccountDeletionSecretPhysicalCheckpoint(database!);
    const checkpointed = await repository.checkpointAccountDeletionNotificationSecrets(async (snapshot) => {
      expect(snapshot).toContainEqual({ requestId: "pg-checkpoint-request", generation: 1 });
      expect(await physicalCheckpoint(snapshot)).toBe(true);
      expect(await competingRepository.beginAccountDeletionWithCompletionNotification({
        requestId: "pg-checkpoint-request",
        reviewedBy: "pg-checkpoint-operator",
        now: TEN_MINUTES,
        staleBefore: FIVE_MINUTES,
        templateVersion: "account-deletion-complete-v1",
        idempotencyKey: "notice:pg-checkpoint-request",
        keyId: "pg-checkpoint-key-v2",
        nonce: Buffer.from("112233445566778899aabbcc", "hex"),
        ciphertext: Buffer.from("reinserted-checkpoint-recipient"),
        authTag: Buffer.from("112233445566778899aabbccddeeff00", "hex"),
        purgeAfter: NEXT_WEEK,
      })).toMatchObject({ status: "processing", attempt_count: 2 });
      return true;
    });

    expect(checkpointed).toBe(false);
    expect(await repository.getAccountDeletionNoticeRecipientSecret("pg-checkpoint-request"))
      .toMatchObject({ key_id: "pg-checkpoint-key-v2" });
    expect(await repository.getAccountDeletionCompletionOutbox("pg-checkpoint-request"))
      .toMatchObject({
        status: "held",
        secret_purge_checkpoint_pending: true,
        secret_purge_generation: 2,
      });
    expect(await repository.acknowledgeAccountDeletionNotificationSecretPurgeCheckpoint([
      { requestId: "pg-checkpoint-request", generation: 2 },
    ])).toBe(0);

    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(NEXT_WEEK)).toBe(1);
    expect(await repository.checkpointAccountDeletionNotificationSecrets(physicalCheckpoint)).toBe(true);
    expect(await repository.getAccountDeletionCompletionOutbox("pg-checkpoint-request"))
      .toMatchObject({
        status: "purged",
        secret_purge_checkpoint_pending: false,
        secret_purge_generation: 3,
      });
  }, 30_000);

  it("matches SQLite for operator, webhook, retention, JSONB, and attempt-fenced transitions", async () => {
    await insertAccount("pg-atomic-claim-user");
    await repository.createAccountDeletionRequest({
      id: "pg-atomic-claim-request",
      userId: "pg-atomic-claim-user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: FIVE_MINUTES,
    });
    const atomicClaims = await Promise.all([
      repository.beginAccountDeletion({
        requestId: "pg-atomic-claim-request",
        reviewedBy: "operator",
        now: NOW,
        staleBefore: STALE,
      }),
      repository.beginAccountDeletion({
        requestId: "pg-atomic-claim-request",
        reviewedBy: "operator",
        now: NOW,
        staleBefore: STALE,
      }),
    ]);
    expect(atomicClaims.filter((row) => row !== null)).toEqual([
      expect.objectContaining({
        id: "pg-atomic-claim-request",
        status: "processing",
        processing_started_at: NOW,
        attempt_count: 1,
      }),
    ]);

    await prepareActiveNotification("pg-manual-request", "pg-manual-user");
    await repository.claimNextAccountDeletionCompletionNotification({
      now: NOW,
      staleBefore: STALE,
      leaseToken: "pg-manual-fail-lease",
      leaseExpiresAt: FIVE_MINUTES,
    });
    expect(await repository.markAccountDeletionNotificationFailed({
      requestId: "pg-manual-request",
      leaseToken: "pg-manual-fail-lease",
      error: "provider rejected person@example.test",
      now: NOW,
    })).toBe(true);
    expect(await repository.retryFailedAccountDeletionNotification({
      requestId: "pg-manual-request",
      now: FIVE_MINUTES,
      audit: {
        id: "pg-retry-audit",
        actorUserId: "operator",
        actorRole: "admin",
        reason: "Independent retry approval.",
      },
    })).toMatchObject({ status: "pending" });
    await repository.claimNextAccountDeletionCompletionNotification({
      now: FIVE_MINUTES,
      staleBefore: NOW,
      leaseToken: "pg-manual-review-lease",
      leaseExpiresAt: TEN_MINUTES,
    });
    expect(await repository.markAccountDeletionNotificationForManualReview({
      requestId: "pg-manual-request",
      leaseToken: "pg-manual-review-lease",
      providerEvent: "delivery_unknown",
      error: "provider outcome uncertain",
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await repository.resolveAccountDeletionNotificationManualReview({
      requestId: "pg-manual-request",
      resolution: "undeliverable",
      now: TEN_MINUTES,
      audit: {
        id: "pg-resolve-audit",
        actorUserId: "operator",
        actorRole: "admin",
        reason: "Independent provider check.",
      },
    })).toMatchObject({
      status: "failed",
      provider_last_event: "operator_resolved_undeliverable",
      secret_purge_checkpoint_pending: true,
    });
    const auditMetadata = await database!.prepare(
      "SELECT metadata_json FROM security_audit_log WHERE id = @id",
    ).get<{ metadata_json: string }>({ id: "pg-resolve-audit" });
    expect(JSON.parse(auditMetadata!.metadata_json)).toMatchObject({ resolution: "undeliverable" });

    await prepareActiveNotification("pg-webhook-request", "pg-webhook-user");
    await repository.claimNextAccountDeletionCompletionNotification({
      now: NOW,
      staleBefore: STALE,
      leaseToken: "pg-webhook-lease",
      leaseExpiresAt: FIVE_MINUTES,
    });
    await repository.markAccountDeletionNotificationAccepted({
      requestId: "pg-webhook-request",
      leaseToken: "pg-webhook-lease",
      providerMessageId: "pg-webhook-message",
      acceptedAt: NOW,
      nextCheckAt: FIVE_MINUTES,
    });
    await repository.recordAccountDeletionNotificationWebhook({
      eventId: "pg-newer-event",
      providerMessageId: "pg-webhook-message",
      eventType: "email.sent",
      eventCreatedAt: FIVE_MINUTES,
      receivedAt: TEN_MINUTES,
      payloadSha256: "b".repeat(64),
      outcome: "pending",
    });
    await repository.recordAccountDeletionNotificationWebhook({
      eventId: "pg-older-event",
      providerMessageId: "pg-webhook-message",
      eventType: "email.bounced",
      eventCreatedAt: NOW,
      receivedAt: TEN_MINUTES,
      payloadSha256: "c".repeat(64),
      outcome: "failed",
    });
    expect(await repository.getAccountDeletionCompletionOutbox("pg-webhook-request"))
      .toMatchObject({ status: "accepted", provider_last_event: "email.sent", provider_event_at: FIVE_MINUTES });
    const deliveredEvent = {
      eventId: "pg-delivered-event",
      providerMessageId: "pg-webhook-message",
      eventType: "email.delivered",
      eventCreatedAt: TEN_MINUTES,
      receivedAt: TEN_MINUTES,
      payloadSha256: "d".repeat(64),
      outcome: "delivered" as const,
    };
    expect(await repository.recordAccountDeletionNotificationWebhook(deliveredEvent))
      .toEqual({ duplicate: false, matched: true, requestId: "pg-webhook-request" });
    expect(await repository.recordAccountDeletionNotificationWebhook(deliveredEvent))
      .toEqual({ duplicate: true, matched: true, requestId: "pg-webhook-request" });
    expect(await repository.getAccountDeletionNoticeRecipientSecret("pg-webhook-request")).toBeNull();

    await insertAccount("pg-stripe-user");
    await database!.prepare(
      `UPDATE accounts
          SET subscription_status = 'premium_monthly',
              stripe_paid_subscription_status = 'premium_monthly',
              stripe_customer_id = 'cus_pg_user', premium_until = @until
        WHERE id = 'pg-stripe-user'`,
    ).run({ until: NEXT_WEEK });
    await repository.createAccountDeletionRequest({
      id: "pg-stripe-request",
      userId: "pg-stripe-user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: FIVE_MINUTES,
    });
    const stripeAttempt = await repository.beginAccountDeletion({
      requestId: "pg-stripe-request",
      reviewedBy: "operator",
      now: NOW,
      staleBefore: STALE,
    });
    await database!.prepare(
      `INSERT INTO stripe_webhook_events (
         id, event_type, status, payload_json, attempts, last_error,
         received_at, processed_at, processing_token
       ) VALUES (
         'pg-stripe-event', 'customer.deleted', 'applied', @payloadJson, 1,
         'redact me', @now, @now, NULL
       )`,
    ).run({
      payloadJson: JSON.stringify({ data: { object: { customer: "cus_pg_user" } } }),
      now: NOW,
    });
    expect(await repository.markAccountDeletionStripeCustomerDeleted({
      requestId: "pg-stripe-request",
      userId: "pg-stripe-user",
      stripeCustomerId: "cus_pg_user",
      attemptCount: stripeAttempt!.attempt_count - 1,
      now: FIVE_MINUTES,
    })).toBe(false);
    expect(await repository.markAccountDeletionStripeCustomerDeleted({
      requestId: "pg-stripe-request",
      userId: "pg-stripe-user",
      stripeCustomerId: "cus_pg_user",
      attemptCount: stripeAttempt!.attempt_count,
      now: FIVE_MINUTES,
    })).toBe(true);
    expect(await database!.prepare(
      "SELECT payload_json, last_error FROM stripe_webhook_events WHERE id = 'pg-stripe-event'",
    ).get()).toEqual({ payload_json: null, last_error: null });

    await insertAccount("pg-purge-user");
    await repository.createAccountDeletionRequest({
      id: "pg-purge-request",
      userId: "pg-purge-user",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: FIVE_MINUTES,
    });
    await repository.beginAccountDeletionWithCompletionNotification({
      requestId: "pg-purge-request",
      reviewedBy: "operator",
      now: NOW,
      staleBefore: STALE,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKey: "notice:pg-purge-request",
      keyId: "pg-key-v1",
      nonce: Buffer.from("00112233445566778899aabb", "hex"),
      ciphertext: Buffer.from("purge-me"),
      authTag: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      purgeAfter: FIVE_MINUTES,
    });
    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(FIVE_MINUTES)).toBe(1);
    expect(await repository.getAccountDeletionCompletionOutbox("pg-purge-request"))
      .toMatchObject({ status: "purged", secret_purge_checkpoint_pending: true });
    expect(await repository.checkpointAccountDeletionNotificationSecrets(
      createPostgresAccountDeletionSecretPhysicalCheckpoint(database!),
    )).toBe(true);
    expect(await repository.getAccountDeletionCompletionOutbox("pg-purge-request"))
      .toMatchObject({ status: "purged", secret_purge_checkpoint_pending: false });
    expect((await repository.getAccountDeletionNotificationQueueSummary(TEN_MINUTES)).manualReviewCount)
      .toBeGreaterThanOrEqual(1);

    await database!.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, user_message, requested_at, execute_after,
         completed_at, created_at, updated_at
       )
       SELECT 'pg-batch-request-' || lpad(item::text, 3, '0'),
              'operator', 'completed', NULL, @now, @now, @now, @now, @now
         FROM generate_series(0, @batchLimit) AS item`,
    ).run({ now: NOW, batchLimit: ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT });
    await database!.prepare(
      `INSERT INTO account_deletion_completion_outbox (
         request_id, template_version, idempotency_key, status, created_at, updated_at
       )
       SELECT id, 'account-deletion-complete-v1',
              'pg-batch-notice-' || substring(id FROM length('pg-batch-request-') + 1),
              'held', @now, @now
         FROM account_deletion_requests
        WHERE id LIKE 'pg-batch-request-%'`,
    ).run({ now: NOW });
    await database!.prepare(
      `INSERT INTO account_deletion_notice_recipient_secrets (
         request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
       )
       SELECT request_id, 'pg-batch-key', decode('00112233445566778899aabb', 'hex'),
              convert_to(request_id, 'UTF8'),
              decode('00112233445566778899aabbccddeeff', 'hex'), @now, @now
         FROM account_deletion_completion_outbox
        WHERE request_id LIKE 'pg-batch-request-%'`,
    ).run({ now: NOW });
    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(NOW))
      .toBe(ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT);
    expect(await database!.prepare(
      `SELECT count(*) AS count
         FROM account_deletion_notice_recipient_secrets
        WHERE request_id LIKE 'pg-batch-request-%'`,
    ).get<{ count: string }>()).toEqual({ count: "1" });
    expect(await database!.prepare(
      `SELECT request_id
         FROM account_deletion_notice_recipient_secrets
        WHERE request_id LIKE 'pg-batch-request-%'`,
    ).get()).toEqual({
      request_id: `pg-batch-request-${String(ACCOUNT_DELETION_RECIPIENT_PURGE_BATCH_LIMIT).padStart(3, "0")}`,
    });
    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(NOW)).toBe(1);
    expect(await repository.purgeExpiredAccountDeletionNotificationRecipients(NOW)).toBe(0);
  }, 30_000);
});
