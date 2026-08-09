import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_ACCOUNT_PRIVACY_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const resourceSuffix = crypto.randomBytes(6).toString("hex");
const TEST_DATABASE = `pintpath_privacy_${resourceSuffix}`;
const TEST_LOGIN = `pintpath_privacy_login_${resourceSuffix}`;
const NOW = "2026-08-08T02:00:00.000Z";
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

/** Direct PG adapter restricted to a unique disposable loopback database. */
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
      max: 8,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c statement_timeout=30000",
        "-c idle_in_transaction_session_timeout=30000",
        "-c lock_timeout=10000",
      ].join(" "),
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
        const savepoint = `privacy_nested_${active.nextSavepoint++}`;
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

describe.skipIf(!configuredAdminUrl)("real PG17 account privacy repository", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: AccountPrivacyRepository;

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
    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new AccountPrivacyRepository(database);
    await insertAccount("operator", "operator@example.test");
  }, 30_000);

  afterAll(async () => {
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
        throw new Error("Disposable account-privacy integration resources were not removed.");
      }
    }
  }, 30_000);

  async function insertAccount(id: string, email = `${id}@example.test`): Promise<void> {
    await database!.prepare(
      `INSERT INTO accounts (
         id, public_account_id, email, password_hash, display_name, display_name_key,
         auth_provider, role, age_verification_status, is_over_18_verified,
         subscription_status, trust_score, contribution_points_current_month,
         status, created_at, updated_at
       ) VALUES (
         @id, @publicId, @email, 'hash', @id, @id, 'local', 'user', 'verified',
         TRUE, 'premium_monthly', 75, 10, 'active', @now, @now
       )`,
    ).run({ id, publicId: `PP-${id}`, email, now: NOW });
    await database!.prepare(
      `INSERT INTO profiles (
         id, public_account_id, email, display_name, display_name_key, username,
         role, account_status, age_verification_status, is_over_18_verified,
         created_at, updated_at
       ) VALUES (
         @id, @publicId, @email, @id, @id, @username, 'user', 'active',
         'verified', TRUE, @now, @now
       )`,
    ).run({ id, publicId: `PP-${id}`, email, username: `username-${id}`, now: NOW });
  }

  async function insertProcessingRequest(
    userId: string,
    options: { recipient?: boolean; outbox?: boolean } = {},
  ): Promise<void> {
    const requestId = `delete-${userId}`;
    await database!.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, user_message, requested_at, execute_after,
         processing_started_at, deletion_tombstone_recorded_at, attempt_count,
         created_at, updated_at
       ) VALUES (
         @requestId, @userId, 'processing', 'delete me', @now, @now,
         @now, @now, 1, @now, @now
       )`,
    ).run({ requestId, userId, now: NOW });
    if (options.outbox === false) return;
    await database!.prepare(
      `INSERT INTO account_deletion_completion_outbox (
         request_id, template_version, idempotency_key, status, created_at, updated_at
       ) VALUES (@requestId, 'account-deletion-complete-v1', @idempotencyKey, 'held', @now, @now)`,
    ).run({ requestId, idempotencyKey: `notice:${requestId}`, now: NOW });
    if (options.recipient === false) return;
    await database!.prepare(
      `INSERT INTO account_deletion_notice_recipient_secrets (
         request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
       ) VALUES (@requestId, 'pg-key', @nonce, @ciphertext, @authTag, @now, @purgeAfter)`,
    ).run({
      requestId,
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.from(`encrypted:${requestId}`),
      authTag: Buffer.alloc(16, 2),
      now: NOW,
      purgeAfter: NEXT_WEEK,
    });
  }

  it("uses native PG jsonb, booleans, bytea, and timestamptz across export and anonymisation", async () => {
    const userId = "pg-privacy-user";
    await insertAccount(userId);
    await insertProcessingRequest(userId);
    await database!.prepare(
      `INSERT INTO account_preferences (
         user_id, preferred_suburbs_json, preferred_beers_json, preferred_use_cases_json,
         created_at, updated_at
       ) VALUES (@userId, '["Fitzroy"]', '[]', '[]', @now, @now)`,
    ).run({ userId, now: NOW });
    await database!.prepare(
      `INSERT INTO account_privacy_settings (
         user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
         product_research_enabled, email_updates_enabled, created_at, updated_at
       ) VALUES (@userId, TRUE, TRUE, TRUE, TRUE, @now, @now)`,
    ).run({ userId, now: NOW });
    await database!.prepare(
      `INSERT INTO source_evidence_objects (
         id, owner_user_id, object_path, byte_size, data_base64, external_url, created_at
       ) VALUES ('pg-evidence', @userId, @path, 8, 'cHJpdmF0ZQ==',
                 'https://evidence.invalid/private', @now)`,
    ).run({ userId, path: `accounts/${userId}/photo.jpg`, now: NOW });
    await database!.prepare(
      `INSERT INTO submissions (
         id, user_id, venue_id, venue_name, status, submission_type, observed_at,
         notes, created_at, updated_at
       ) VALUES ('pg-submission', @userId, 'venue-pg', 'PG Venue', 'approved',
                 'manual', @now, 'private', @now, @now)`,
    ).run({ userId, now: NOW });
    await database!.prepare(
      `INSERT INTO submission_items (
         id, submission_id, beer_name, serving_size, price, created_at
       ) VALUES ('pg-item', 'pg-submission', 'PG Lager', 'pint', 13, @now)`,
    ).run({ now: NOW });
    await database!.prepare(
      `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
       VALUES ('pg-submission', 'pg-evidence', 0, @now)`,
    ).run({ now: NOW });
    await database!.prepare(
      `INSERT INTO system_state (key, value_json, updated_at, revision)
       VALUES ('venue-report-delivery:pg', @valueJson, @now, 'before')`,
    ).run({
      valueJson: JSON.stringify({
        enabled: true,
        recipients: [`${userId}@example.test`, "operator@example.test"],
        updatedBy: userId,
      }),
      now: NOW,
    });
    await database!.prepare(
      `INSERT INTO stripe_webhook_events (
         id, event_type, status, payload_json, received_at, processed_at
       ) VALUES ('pg-stripe-event', 'customer.updated', 'applied', @payload, @now, @now)`,
    ).run({
      payload: JSON.stringify({ data: { object: { metadata: { user_id: userId } } } }),
      now: NOW,
    });

    const exported = await repository.exportAccountRelatedData({ userId });
    expect(exported.accountPrivate).toMatchObject({
      id: userId,
      is_over_18_verified: true,
      created_at: NOW,
    });
    expect(exported.preferences).toMatchObject({ preferred_suburbs_json: '["Fitzroy"]' });
    expect(exported.privacySettings).toMatchObject({ optional_analytics_enabled: true });
    expect(exported.sourceEvidenceMetadata).toEqual([
      expect.objectContaining({ id: "pg-evidence", byte_size: 8, created_at: NOW }),
    ]);
    expect(exported.venueReportDeliverySettings).toEqual([
      expect.objectContaining({ key: "venue-report-delivery:pg" }),
    ]);
    expect(exported.stripeWebhookEvents).toHaveLength(1);

    const summary = await repository.executeAccountAnonymisation({
      requestId: `delete-${userId}`,
      attemptCount: 1,
      reviewedBy: "operator",
      now: NOW,
      completionNotificationDisposition: "enqueue_live",
      completionNotificationRetentionExpiresAt: NEXT_WEEK,
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    });
    expect(summary).toMatchObject({
      evidenceIds: ["pg-evidence"],
      removedSubmissions: 1,
      removedSubmissionItems: 1,
    });
    expect(await database!.prepare(
      "SELECT is_over_18_verified, status, updated_at FROM accounts WHERE id = @userId",
    ).get({ userId })).toEqual({ is_over_18_verified: false, status: "suspended", updated_at: NOW });
    expect(await database!.prepare(
      "SELECT data_base64, external_url, byte_size, deleted_at FROM source_evidence_objects WHERE id = 'pg-evidence'",
    ).get()).toEqual({ data_base64: null, external_url: null, byte_size: null, deleted_at: NOW });
    const report = await database!.prepare(
      "SELECT value_json, revision FROM system_state WHERE key = 'venue-report-delivery:pg'",
    ).get<{ value_json: string; revision: string }>();
    expect(JSON.parse(report!.value_json)).toMatchObject({
      recipients: ["operator@example.test"],
      updatedBy: null,
      redactedAfterAccountDeletion: true,
    });
    expect(report!.revision).toMatch(/^[0-9a-f-]{36}$/);
    expect(await database!.prepare(
      "SELECT status, completed_at, retention_expires_at FROM account_deletion_completion_outbox WHERE request_id = @requestId",
    ).get({ requestId: `delete-${userId}` })).toEqual({
      status: "pending",
      completed_at: NOW,
      retention_expires_at: NEXT_WEEK,
    });
  });

  it("rolls back notification failure and serializes contending attempts idempotently", async () => {
    const rollbackUser = "pg-rollback-user";
    await insertAccount(rollbackUser);
    await insertProcessingRequest(rollbackUser, { recipient: false });
    await expect(repository.executeAccountAnonymisation({
      requestId: `delete-${rollbackUser}`,
      attemptCount: 1,
      reviewedBy: "operator",
      now: NOW,
      completionNotificationDisposition: "enqueue_live",
      completionNotificationRetentionExpiresAt: NEXT_WEEK,
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    })).rejects.toMatchObject({ code: "notification_not_prepared" });
    expect(await database!.prepare(
      "SELECT email, status FROM accounts WHERE id = @userId",
    ).get({ userId: rollbackUser })).toEqual({
      email: `${rollbackUser}@example.test`,
      status: "active",
    });
    expect(await database!.prepare(
      "SELECT status FROM account_deletion_requests WHERE id = @requestId",
    ).get({ requestId: `delete-${rollbackUser}` })).toEqual({ status: "processing" });

    const contentionUser = "pg-contention-user";
    await insertAccount(contentionUser);
    await insertProcessingRequest(contentionUser, { outbox: false });
    const input = {
      requestId: `delete-${contentionUser}`,
      attemptCount: 1,
      reviewedBy: "operator",
      now: NOW,
      completionNotificationDisposition: "none" as const,
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    };
    const [first, second] = await Promise.all([
      repository.executeAccountAnonymisation(input),
      repository.executeAccountAnonymisation(input),
    ]);
    expect(second).toEqual(first);
    await expect(repository.executeAccountAnonymisation({ ...input, attemptCount: 2 }))
      .rejects.toMatchObject({ code: "deletion_attempt_conflict" });

    const restoreUser = "pg-restore-user";
    await insertAccount(restoreUser);
    await insertProcessingRequest(restoreUser);
    await repository.executeAccountAnonymisation({
      ...input,
      requestId: `delete-${restoreUser}`,
      completionNotificationDisposition: "suppress_restore",
    });
    expect(await database!.prepare(
      `SELECT status, secret_purge_checkpoint_pending, secret_purge_generation
         FROM account_deletion_completion_outbox WHERE request_id = @requestId`,
    ).get({ requestId: `delete-${restoreUser}` })).toEqual({
      status: "suppressed_restore",
      secret_purge_checkpoint_pending: true,
      secret_purge_generation: 1,
    });
    expect(await database!.prepare(
      "SELECT request_id FROM account_deletion_notice_recipient_secrets WHERE request_id = @requestId",
    ).get({ requestId: `delete-${restoreUser}` })).toBeUndefined();
    expect(database!.metrics().transactionFailures).toBeGreaterThanOrEqual(2);
  });
});
