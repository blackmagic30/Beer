import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PrivacyRetentionRepository,
  PrivacyRetentionRepositoryError,
  type PrivacyRetentionInput,
} from "../src/db/privacy-retention.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_privacy_retention_integration_test";
const TEST_LOGIN = "pintpath_privacy_retention_login";
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
  ) throw new Error(`${ADMIN_URL_ENV} must target an explicit disposable loopback maintenance database.`);
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

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Test-only direct-PG adapter for an explicitly disposable loopback cluster. */
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
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
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
        const savepoint = `privacy_retention_nested_${active.nextSavepoint++}`;
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

async function insertAccount(client: Client, id = "retention-user") {
  await client.query(
    `INSERT INTO pintpath_app.accounts (id, email, password_hash, created_at, updated_at)
     VALUES ($1, $2, 'hash', $3, $3)`,
    [id, `${id}@example.test`, VERY_OLD],
  );
}

async function insertDeletionNotice(
  client: Client,
  input: { suffix: string; status: string; retentionExpiresAt: string },
) {
  const userId = `notice-user-${input.suffix}`;
  const requestId = `notice-request-${input.suffix}`;
  await insertAccount(client, userId);
  await client.query(
    `INSERT INTO pintpath_app.account_deletion_requests (
       id, user_id, status, requested_at, execute_after, completed_at, created_at, updated_at
     ) VALUES ($1, $2, 'completed', $3, $3, $3, $3, $3)`,
    [requestId, userId, VERY_OLD],
  );
  await client.query(
    `INSERT INTO pintpath_app.account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status,
       retention_expires_at, created_at, updated_at
     ) VALUES ($1, 'v1', $2, $3, $4, $5, $5)`,
    [requestId, `notice-key-${input.suffix}`, input.status, input.retentionExpiresAt, VERY_OLD],
  );
  await client.query(
    `INSERT INTO pintpath_app.account_deletion_notification_events (
       event_id, request_id, provider_message_id, event_type,
       event_created_at, received_at, payload_sha256
     ) VALUES ($1, $2, $3, 'delivered', $4, $4, $5)`,
    [
      `notice-event-${input.suffix}`,
      requestId,
      `provider-${input.suffix}`,
      VERY_OLD,
      input.suffix.padEnd(64, "a").slice(0, 64),
    ],
  );
}

async function seedAllOutcomes(client: Client) {
  await insertAccount(client);
  await client.query(
    `INSERT INTO pintpath_app.auth_sessions (
       token_hash, user_id, created_at, expires_at, revoked_at, last_ip_hash, user_agent_hash
     ) VALUES
       ('expired-old', 'retention-user', $1, $2, NULL, 'ip', 'agent'),
       ('revoked-old', 'retention-user', $1, $3, $2, 'ip', 'agent'),
       ('active', 'retention-user', $4, $3, NULL, 'ip', 'agent'),
       ('expired-recent', 'retention-user', $4, $4, NULL, 'ip', 'agent')`,
    [VERY_OLD, OLD, FUTURE, RECENT],
  );
  await client.query(
    `INSERT INTO pintpath_app.revoked_provider_sessions (
       user_id, provider_session_id_hash, revoked_at, reason
     ) VALUES
       ('retention-user', 'provider-old', $1, 'all_app_sessions_revoked'),
       ('retention-user', 'provider-protected', $1, 'device_compromise'),
       ('retention-user', 'provider-recent', $2, 'password_reset_completed')`,
    [VERY_OLD, RECENT],
  );
  await client.query(
    `INSERT INTO pintpath_app.stripe_webhook_events (
       id, event_type, status, event_created_at, payload_json, attempts,
       last_error, received_at, applied_at, processed_at, processing_token
     ) VALUES
       ('stripe-redact', 'customer.updated', 'applied', $1, '{"private":"payload"}', 1,
        'private-error', $1, $1, $1, NULL),
       ('stripe-envelope', 'customer.updated', 'applied', $2, NULL, 1,
        NULL, $2, $2, $2, NULL),
       ('stripe-pending', 'customer.updated', 'pending', $2, '{"keep":"pending"}', 1,
        'retry', $2, NULL, $2, NULL),
       ('stripe-processing', 'customer.updated', 'processing', $2, '{"keep":"processing"}', 1,
        'retry', $2, NULL, $2, 'lease'),
       ('stripe-failed', 'customer.updated', 'failed', $2, '{"keep":"failed"}', 1,
        'retry', $2, NULL, $2, NULL)`,
    [OLD, VERY_OLD],
  );
  await client.query(
    `INSERT INTO pintpath_app.security_audit_log (
       id, action, metadata_json, ip_hash, user_agent_hash, created_at
     ) VALUES
       ('audit-fingerprint', 'retention-test', '{}', 'ip', 'agent', $1),
       ('audit-envelope', 'retention-test', '{}', NULL, NULL, $2),
       ('audit-recent', 'retention-test', '{}', 'ip', 'agent', $3)`,
    [OLD, VERY_OLD, RECENT],
  );
  await client.query(
    `INSERT INTO pintpath_app.submissions (
       id, user_id, venue_id, venue_name, status, submission_type, observed_at,
       upload_latitude, upload_longitude, upload_accuracy_meters,
       upload_location_captured_at, reviewed_at, created_at, updated_at
     ) VALUES
       ('submission-terminal', 'retention-user', 'venue', 'Venue', 'approved', 'price_update', $1,
        -37.8, 144.9, 10, $1, $1, $1, $1),
       ('submission-pending', 'retention-user', 'venue', 'Venue', 'pending', 'price_update', $1,
        -37.8, 144.9, 10, $1, $1, $1, $1),
       ('submission-evidence', 'retention-user', 'venue', 'Venue', 'needs_more_evidence', 'price_update', $1,
        -37.8, 144.9, 10, $1, $1, $1, $1),
       ('submission-disputed', 'retention-user', 'venue', 'Venue', 'disputed', 'price_update', $1,
        -37.8, 144.9, 10, $1, $1, $1, $1),
       ('submission-recent', 'retention-user', 'venue', 'Venue', 'approved', 'price_update', $2,
        -37.8, 144.9, 10, $2, $2, $2, $2)`,
    [OLD, RECENT],
  );
  await client.query(
    `INSERT INTO pintpath_app.migration_quarantined_records (
       id, entity_type, original_id, reason, payload_json, quarantined_at
     ) VALUES
       ('quarantine-old', 'account', 'old', 'test', '{"private":"value"}', $1),
       ('quarantine-redacted', 'account', 'already', 'test', '{"redactedAfterRetention":true}', $1),
       ('quarantine-recent', 'account', 'recent', 'test', '{"private":"recent"}', $2)`,
    [OLD, RECENT],
  );
  await insertDeletionNotice(client, { suffix: "expired", status: "delivered", retentionExpiresAt: OLD });
  await insertDeletionNotice(client, { suffix: "unexpired", status: "delivered", retentionExpiresAt: FUTURE });
  await insertDeletionNotice(client, { suffix: "active", status: "sending", retentionExpiresAt: OLD });
}

describe.skipIf(!configuredAdminUrl)("PrivacyRetentionRepository on restricted PostgreSQL 17", () => {
  let maintenanceUrl: URL;
  let maintenance: Client;
  let targetAdmin: Client | null = null;
  let firstDatabase: LoopbackPostgresTestDatabase | null = null;
  let secondDatabase: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    maintenanceUrl = validateAdminUrl(configuredAdminUrl);
    maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    const version = Number((await maintenance.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Privacy retention integration requires PostgreSQL 17; received ${version}.`);
    }
    const existingRoles = await maintenance.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = existingRoles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = existingRoles.rows.some((row) => row.rolname === "pintpath_migrator");
    await maintenance.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await maintenance.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await maintenance.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(maintenanceUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await maintenance.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await maintenance.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    await maintenance.query(`REVOKE ALL ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await maintenance.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);
    restrictedUrl = withDatabase(maintenanceUrl, TEST_DATABASE, TEST_LOGIN, password);
  }, 30_000);

  beforeEach(async () => {
    if (!targetAdmin) throw new Error("PostgreSQL fixture is unavailable.");
    await firstDatabase?.close();
    await secondDatabase?.close();
    firstDatabase = null;
    secondDatabase = null;
    await targetAdmin.query("TRUNCATE TABLE pintpath_app.accounts CASCADE");
    await targetAdmin.query("TRUNCATE TABLE pintpath_app.stripe_webhook_events, pintpath_app.security_audit_log, pintpath_app.migration_quarantined_records CASCADE");
    firstDatabase = new LoopbackPostgresTestDatabase(restrictedUrl);
    secondDatabase = new LoopbackPostgresTestDatabase(restrictedUrl);
  });

  afterAll(async () => {
    await firstDatabase?.close().catch(() => undefined);
    await secondDatabase?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (maintenance) {
      await maintenance.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await maintenance.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
      await maintenance.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      const leftovers = await maintenance.query<{ database_exists: boolean; role_exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS database_exists,
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS role_exists`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      expect(leftovers.rows[0]).toEqual({ database_exists: false, role_exists: false });
      await maintenance.end().catch(() => undefined);
    }
  }, 30_000);

  it("matches SQLite semantics through least-privilege RLS and native PostgreSQL values", async () => {
    if (!targetAdmin || !firstDatabase) throw new Error("PostgreSQL fixture is unavailable.");
    await seedAllOutcomes(targetAdmin);
    const role = await targetAdmin.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [TEST_LOGIN],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    const rls = await targetAdmin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT bool_and(relrowsecurity) AS relrowsecurity,
              bool_and(relforcerowsecurity) AS relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE oid = ANY($1::regclass[])`,
      [[
        "pintpath_app.auth_sessions",
        "pintpath_app.revoked_provider_sessions",
        "pintpath_app.stripe_webhook_events",
        "pintpath_app.security_audit_log",
        "pintpath_app.submissions",
        "pintpath_app.migration_quarantined_records",
        "pintpath_app.account_deletion_notification_events",
      ]],
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const result = await new PrivacyRetentionRepository(firstDatabase).prunePrivacyRetention(INPUT);
    expect(result).toMatchObject({
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
      hasMore: true,
      hasActionableMore: false,
      stripeEnvelopesAwaitingTombstoneInBatch: 1,
    });
    expect((await targetAdmin.query(
      "SELECT id, payload_json, last_error FROM pintpath_app.stripe_webhook_events ORDER BY id",
    )).rows).toEqual([
      { id: "stripe-envelope", payload_json: null, last_error: null },
      { id: "stripe-failed", payload_json: { keep: "failed" }, last_error: "retry" },
      { id: "stripe-pending", payload_json: { keep: "pending" }, last_error: "retry" },
      { id: "stripe-processing", payload_json: { keep: "processing" }, last_error: "retry" },
      { id: "stripe-redact", payload_json: null, last_error: null },
    ]);
    expect((await targetAdmin.query(
      "SELECT event_id FROM pintpath_app.account_deletion_notification_events ORDER BY event_id",
    )).rows).toEqual([
      { event_id: "notice-event-active" },
      { event_id: "notice-event-unexpired" },
    ]);
  });

  it("uses SKIP LOCKED so concurrent workers never double-count one bounded batch", async () => {
    if (!targetAdmin || !firstDatabase || !secondDatabase) throw new Error("PostgreSQL fixture is unavailable.");
    await insertAccount(targetAdmin);
    const values = Array.from({ length: 40 }, (_, index) => (
      `('concurrent-${String(index).padStart(3, "0")}', 'retention-user', '${VERY_OLD}', '${OLD}')`
    )).join(",\n");
    await targetAdmin.query(
      `INSERT INTO pintpath_app.auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES ${values}`,
    );
    const input = { ...INPUT, batchLimit: 25 };
    const [first, second] = await Promise.all([
      new PrivacyRetentionRepository(firstDatabase).prunePrivacyRetention(input),
      new PrivacyRetentionRepository(secondDatabase).prunePrivacyRetention(input),
    ]);
    expect(first.authSessionsDeleted + second.authSessionsDeleted).toBe(40);
    expect(first.processedCount + second.processedCount).toBe(40);
    expect(first.processedCount).toBeLessThanOrEqual(25);
    expect(second.processedCount).toBeLessThanOrEqual(25);
    expect((await targetAdmin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pintpath_app.auth_sessions",
    )).rows[0]).toEqual({ count: "0" });
  });

  it("rolls back earlier mutations after an injected PostgreSQL failure and hides private details", async () => {
    if (!targetAdmin || !firstDatabase) throw new Error("PostgreSQL fixture is unavailable.");
    await insertAccount(targetAdmin);
    await targetAdmin.query(
      `INSERT INTO pintpath_app.auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES ('rollback-session', 'retention-user', $1, $2)`,
      [VERY_OLD, OLD],
    );
    await targetAdmin.query(
      `INSERT INTO pintpath_app.revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       ) VALUES ('retention-user', 'rollback-provider', $1, 'all_app_sessions_revoked')`,
      [VERY_OLD],
    );
    await targetAdmin.query(`CREATE FUNCTION pintpath_app.reject_privacy_retention_delete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private retention trigger detail'; END $$`);
    await targetAdmin.query(`CREATE TRIGGER reject_privacy_retention_delete
      BEFORE DELETE ON pintpath_app.revoked_provider_sessions
      FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_privacy_retention_delete()`);

    const failure = await new PrivacyRetentionRepository(firstDatabase)
      .prunePrivacyRetention(INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PrivacyRetentionRepositoryError);
    expect(failure).toMatchObject({ code: "persistence_failure" });
    expect(String(failure)).not.toContain("private retention trigger detail");
    expect((await targetAdmin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pintpath_app.auth_sessions WHERE token_hash = 'rollback-session'",
    )).rows[0]).toEqual({ count: "1" });

    await targetAdmin.query("DROP TRIGGER reject_privacy_retention_delete ON pintpath_app.revoked_provider_sessions");
    await targetAdmin.query("DROP FUNCTION pintpath_app.reject_privacy_retention_delete()");
  });
});
