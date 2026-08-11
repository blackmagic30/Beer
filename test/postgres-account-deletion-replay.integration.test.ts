import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import type { PostgresLogicalRestoreReceipt } from "../src/lib/postgres-logical-restore.js";
import {
  POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
  postgresAccountDeletionReplayTargetIdentitySha256,
  replayPostgresAccountDeletionTombstones,
} from "../src/lib/postgres-account-deletion-replay.js";
import {
  AccountDeletionNotificationCoordinator,
  type AccountDeletionNotificationWorkerConfig,
} from "../src/lib/account-deletion-notification-worker.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`.toLowerCase();
const TEST_DATABASE = `pintpath_deletion_replay_${suffix}`;
const TEST_LOGIN = `pintpath_deletion_replay_login_${suffix}`;
const TEST_PASSWORD = `Replay_${crypto.randomBytes(24).toString("base64url")}`;
const USER_ID = `replay-user-${suffix}`;
const ADMIN_ID = `replay-admin-${suffix}`;
const REQUEST_ID = `replay-request-${suffix}`;
const PROCESSING_AT = "2026-08-09T04:40:00.000Z";
const COMPLETED_AT = "2026-08-09T04:45:00.000Z";
const REPLAYED_AT = "2026-08-09T05:45:00.000Z";

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
  ) throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 maintenance database.`);
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
  if (Array.isArray(value)) return value;
  if (Buffer.isBuffer(value) || value === null || typeof value !== "object") return value;
  return JSON.stringify(value);
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  ) as Row;
}

/** One-connection adapter keeps the session advisory lock on the exact backend used by replay. */
class DisposableLoopbackPostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{
    client: PoolClient;
    nextSavepoint: number;
  }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 0,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c statement_timeout=30000",
        "-c idle_in_transaction_session_timeout=30000",
        "-c lock_timeout=10000",
        "-c synchronous_commit=on",
      ].join(" "),
    });
    this.pool.on("error", () => {
      this.failedQueries += 1;
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
        const savepoint = `deletion_replay_nested_${active.nextSavepoint++}`;
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

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pretty(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writePrivate(filePath: string, bytes: string | Buffer): void {
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

describe.skipIf(!configuredAdminUrl)("real restricted PG17 deletion tombstone replay", () => {
  let adminUrl: URL;
  let maintenance: Client | null = null;
  let targetAdmin: Client | null = null;
  let root = "";
  let runtimeUrl = "";
  let targetIdentitySha256 = "";
  let baseRestoreReceiptSha256 = "";
  let authority: {
    directory: string;
    currentSha256: string;
    genesisSha256: string;
    checkpointSha256: string;
    immutableSetSha256: string;
  };
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    maintenance = new Client({ connectionString: adminUrl.toString() });
    await maintenance.connect();
    const version = await maintenance.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
      throw new Error("Deletion replay integration requires PostgreSQL 17.");
    }
    const roles = await maintenance.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await maintenance.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await maintenance.query(
      `ALTER DATABASE ${TEST_DATABASE}
         SET pintpath.logical_restore_target_class TO 'disposable-rehearsal'`,
    );
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    await targetAdmin.query(`UPDATE pintpath_app.schema_metadata
      SET value = CASE key
        WHEN 'import_state' THEN 'ready'
        WHEN 'migration_candidate_sha' THEN $1
        WHEN 'migration_manifest_sha256' THEN $2
        WHEN 'migration_plan_sha256' THEN $3
        WHEN 'migration_run_sha256' THEN $4
        WHEN 'source_schema_fingerprint' THEN $5
        WHEN 'source_schema_version' THEN '16'
        WHEN 'source_snapshot_sha256' THEN $6
        WHEN 'target_ddl_sha256' THEN $7
        ELSE value
      END`, [
      "c".repeat(40), "1".repeat(64), "2".repeat(64), "3".repeat(64),
      "4".repeat(64), "5".repeat(64), "6".repeat(64),
    ]);
    await maintenance.query(`CREATE ROLE ${TEST_LOGIN}
      LOGIN PASSWORD '${TEST_PASSWORD}' INHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await maintenance.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    await targetAdmin.query(
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${TEST_LOGIN}`,
    );
    runtimeUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);

    const runtimeSetup = new DisposableLoopbackPostgresDatabase(runtimeUrl);
    try {
      await runtimeSetup.prepare(`INSERT INTO accounts (
        id, public_account_id, email, password_hash, auth_provider, role,
        subscription_status, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'fixture-password-hash', 'local', 'user', 'free', 'active', ?, ?)`)
        .run(USER_ID, USER_ID, `${USER_ID}@example.test`, PROCESSING_AT, PROCESSING_AT);
      await runtimeSetup.prepare(`INSERT INTO accounts (
        id, public_account_id, email, password_hash, auth_provider, role,
        subscription_status, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'fixture-password-hash', 'local', 'admin', 'admin', 'active', ?, ?)`)
        .run(ADMIN_ID, ADMIN_ID, `${ADMIN_ID}@example.test`, PROCESSING_AT, PROCESSING_AT);
      await runtimeSetup.prepare(`INSERT INTO profiles (
        id, public_account_id, email, role, account_status,
        age_verification_status, is_over_18_verified, created_at, updated_at
      ) VALUES (?, ?, ?, 'user', 'active', 'not_started', false, ?, ?)`)
        .run(USER_ID, USER_ID, `${USER_ID}@example.test`, PROCESSING_AT, PROCESSING_AT);
      await runtimeSetup.prepare(`INSERT INTO auth_sessions (
        token_hash, user_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?)`)
        .run(`session-${suffix}`, USER_ID, PROCESSING_AT, "2026-08-10T04:40:00.000Z");
      const queue = new AccountDeletionQueueRepository(runtimeSetup);
      await queue.createAccountDeletionRequest({
        id: REQUEST_ID,
        userId: USER_ID,
        userMessage: "Synthetic restore-deletion proof.",
        requestedAt: "2026-08-01T04:40:00.000Z",
        executeAfter: "2026-08-08T04:40:00.000Z",
      });
      const workerConfig: AccountDeletionNotificationWorkerConfig = {
        provider: {
          mode: "mock",
          send: async () => { throw new Error("The replay fixture must not invoke a provider."); },
        },
        keyring: {
          activeKeyId: "fixture-key",
          keys: new Map([["fixture-key", crypto.randomBytes(32)]]),
        },
        performRecipientSecretPhysicalCheckpoint: async () => true,
        publicBaseUrl: "https://pintpath.au",
        from: "Pint Path <account@pintpath.au>",
        supportEmail: "admin@pintpath.au",
      };
      const coordinator = new AccountDeletionNotificationCoordinator(queue, workerConfig);
      const processing = await coordinator.beginDeletionWithPreparedNotification({
        requestId: REQUEST_ID,
        reviewedBy: ADMIN_ID,
        destination: `${USER_ID}@example.test`,
        now: PROCESSING_AT,
        staleBefore: "2026-08-09T04:30:00.000Z",
      });
      if (processing?.status !== "processing" || processing.attempt_count !== 1) {
        throw new Error("Synthetic deletion fixture did not reach processing attempt 1.");
      }
    } finally {
      await runtimeSetup.close();
    }

    const identity = await targetAdmin.query<{
      systemIdentifier: string;
      databaseOid: string;
      databaseName: string;
      serverVersionNum: string;
      targetClass: string;
    }>(`SELECT
      control.system_identifier::text AS "systemIdentifier",
      database.oid::text AS "databaseOid",
      current_database() AS "databaseName",
      current_setting('server_version_num') AS "serverVersionNum",
      current_setting('pintpath.logical_restore_target_class') AS "targetClass"
      FROM pg_catalog.pg_database AS database
      CROSS JOIN pg_catalog.pg_control_system() AS control
      WHERE database.datname = current_database()`);
    targetIdentitySha256 = postgresAccountDeletionReplayTargetIdentitySha256(identity.rows[0]!);

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-replay-pg17-")));
    fs.chmodSync(root, 0o700);
    const evidenceDirectory = path.join(root, "evidence");
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.chmodSync(evidenceDirectory, 0o700);
    const runtimeUrlFile = path.join(root, "runtime-url");
    writePrivate(runtimeUrlFile, `${runtimeUrl}\n`);
    const baseReceipt: PostgresLogicalRestoreReceipt = {
      kind: "pintpath-postgres-logical-restore-rehearsal",
      version: 1,
      status: "verified",
      restoredAt: "2026-08-09T04:35:00.000Z",
      backupManifestSha256: "1".repeat(64),
      backupArchiveSha256: "2".repeat(64),
      targetIdentitySha256,
      targetUrlSha256: "3".repeat(64),
      authoritativeTableCount: 56,
      authoritativeColumnCount: 717,
      foreignKeyCount: 76,
      authoritativeRowCount: "6",
      nonEmptyAuthoritativeTableCount: 6,
      authoritativeCountInventorySha256: "4".repeat(64),
      controlCountInventorySha256: "5".repeat(64),
      schemaMetadataSha256: "6".repeat(64),
      rowSecurityTableCount: 59,
      aclContractSha256: "7".repeat(64),
      apiRolesIsolated: true,
      runtimeApplicationAccessRestored: true,
      migratorReconciliationAccessVerified: true,
      runtimeOperationsIsolated: true,
      promotionReconciliationReady: true,
      sourceStateBindingStatus: "exact-match",
      expectedSourceStateReceiptSha256: "8".repeat(64),
      sourceSnapshotBindingSha256: "9".repeat(64),
      expectedSourceTableSetSha256: "a".repeat(64),
      expectedSourceDataSha256: "b".repeat(64),
      expectedSourceStateTotalsSha256: "c".repeat(64),
      expectedSourceKeyRangesSha256: "d".repeat(64),
      expectedArchivedControlTableSetSha256: "e".repeat(64),
      expectedArchivedControlDataSha256: "f".repeat(64),
      expectedArchivedControlKeyRangesSha256: "0".repeat(64),
      expectedSourceOverallStateSha256: "ab".repeat(32),
      restoredOverallStateSha256: "ab".repeat(32),
      exactDataReconciliation: "canonical-contract-exact",
    };
    const baseRestoreReceiptBytes = canonicalPostgresBackupJson(baseReceipt);
    writePrivate(path.join(root, "base-restore-receipt.json"), baseRestoreReceiptBytes);
    baseRestoreReceiptSha256 = sha256(baseRestoreReceiptBytes);
    const authorityDirectory = path.join(root, "authority");
    fs.mkdirSync(authorityDirectory, { mode: 0o700 });
    fs.chmodSync(authorityDirectory, 0o700);
    const tombstone = { requestId: REQUEST_ID, userId: USER_ID, completedAt: COMPLETED_AT };
    const current = pretty({ version: 1, generatedAt: COMPLETED_AT, tombstones: [tombstone] });
    const genesis = pretty({
      version: 1,
      kind: "pint-path-account-deletion-ledger-genesis",
      createdAt: "2026-08-01T00:00:00.000Z",
      immutablePrefix: "_control/account-deletion-ledger/v1",
      currentLedgerPath: "_control/account-deletion-tombstones.json",
    });
    const immutableObject = pretty({ version: 1, generatedAt: COMPLETED_AT, tombstones: [tombstone] });
    const immutableSetSha256 = sha256(Buffer.from(JSON.stringify([{
      path: `_control/account-deletion-ledger/v1/${sha256(Buffer.from(
        `${REQUEST_ID}\0${USER_ID}\0${COMPLETED_AT}`,
      ))}.json`,
      sha256: sha256(immutableObject),
    }])));
    const checkpoint = pretty({
      version: 2,
      generatedAt: COMPLETED_AT,
      genesisPath: "_control/account-deletion-ledger-genesis.json",
      genesisSha256: sha256(genesis),
      currentLedgerPath: "_control/account-deletion-tombstones.json",
      currentLedgerSha256: sha256(current),
      immutableObjectCount: 1,
      immutableSetSha256,
      tombstoneCount: 1,
      latestCompletedAt: COMPLETED_AT,
    });
    writePrivate(path.join(authorityDirectory, "current.json"), current);
    writePrivate(path.join(authorityDirectory, "genesis.json"), genesis);
    writePrivate(path.join(authorityDirectory, "checkpoint.json"), checkpoint);
    authority = {
      directory: authorityDirectory,
      currentSha256: sha256(current),
      genesisSha256: sha256(genesis),
      checkpointSha256: sha256(checkpoint),
      immutableSetSha256,
    };
  }, 30_000);

  afterAll(async () => {
    await targetAdmin?.end().catch(() => undefined);
    if (maintenance) {
      await maintenance.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await maintenance.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) {
        await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      }
      if (!migratorRoleExisted) {
        await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      }
      const leftovers = await maintenance.query<{
        databaseExists: boolean;
        loginExists: boolean;
      }>(`SELECT
        EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS "databaseExists",
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS "loginExists"`,
      [TEST_DATABASE, TEST_LOGIN]);
      await maintenance.end().catch(() => undefined);
      if (leftovers.rows[0]?.databaseExists || leftovers.rows[0]?.loginExists) {
        throw new Error("Disposable deletion-replay database or login was not removed.");
      }
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("replays a nonzero tombstone under the restricted runtime role and is exactly idempotent", async () => {
    const runtimeUrlFile = path.join(root, "runtime-url");
    const baseRestoreReceiptFile = path.join(root, "base-restore-receipt.json");
    const options = (receipt: string) => ({
      runtimeUrlFile,
      baseRestoreReceiptFile,
      expectedBaseRestoreReceiptSha256: baseRestoreReceiptSha256,
      deletionLedgerAuthorityDirectory: authority.directory,
      expectedTargetIdentitySha256: targetIdentitySha256,
      expectedLedgerCurrentSha256: authority.currentSha256,
      expectedLedgerGenesisSha256: authority.genesisSha256,
      expectedLedgerCheckpointSha256: authority.checkpointSha256,
      expectedLedgerImmutableSetSha256: authority.immutableSetSha256,
      expectedTombstoneCount: 1,
      receiptFile: path.join(root, "evidence", receipt),
      confirmation: POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    });
    const overrides = {
      env: { NODE_ENV: "test" },
      getUid: () => process.getuid?.() ?? 0,
      now: () => new Date(REPLAYED_AT),
      allowInsecureLoopbackForTests: true,
      createDatabase: () => new DisposableLoopbackPostgresDatabase(runtimeUrl),
    };
    await targetAdmin!.end();
    targetAdmin = null;
    const first = await replayPostgresAccountDeletionTombstones(
      options("replay-first.json"),
      overrides,
    );
    const second = await replayPostgresAccountDeletionTombstones(
      options("replay-second.json"),
      overrides,
    );
    expect(first).toMatchObject({
      seen: 1,
      newlyApplied: 1,
      alreadyApplied: 0,
      missing: 0,
      failed: 0,
    });
    expect(second).toMatchObject({
      seen: 1,
      newlyApplied: 0,
      alreadyApplied: 1,
      missing: 0,
      failed: 0,
    });
    expect(second.semanticProjectionSha256).toBe(first.semanticProjectionSha256);
    const firstReceiptFile = path.join(root, "evidence", "replay-first.json");
    const firstReceiptFileDescriptor = fs.openSync(
      firstReceiptFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      expect(fs.fstatSync(firstReceiptFileDescriptor).mode & 0o7777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(
        firstReceiptFileDescriptor,
        "utf8",
      )).baseRestoreReceiptSha256).toBe(baseRestoreReceiptSha256);
    } finally {
      fs.closeSync(firstReceiptFileDescriptor);
    }

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    const verification = await targetAdmin!.query<{
      accountStatus: string;
      authProvider: string;
      supabaseUserId: string | null;
      stripeCustomerId: string | null;
      requestStatus: string;
      completedAt: Date;
      outboxStatus: string;
      terminalAt: Date | null;
      leaseToken: string | null;
      providerMessageId: string | null;
      checkpointPending: boolean;
      sessionCount: string;
      recipientCount: string;
      eventCount: string;
      evidenceCount: string;
    }>(`SELECT
      account.status AS "accountStatus",
      account.auth_provider AS "authProvider",
      account.supabase_user_id AS "supabaseUserId",
      account.stripe_customer_id AS "stripeCustomerId",
      deletion.status AS "requestStatus",
      deletion.completed_at AS "completedAt",
      notice.status AS "outboxStatus",
      notice.terminal_at AS "terminalAt",
      notice.lease_token AS "leaseToken",
      notice.provider_message_id AS "providerMessageId",
      notice.secret_purge_checkpoint_pending AS "checkpointPending",
      (SELECT count(*)::text FROM pintpath_app.auth_sessions WHERE user_id = $1) AS "sessionCount",
      (SELECT count(*)::text FROM pintpath_app.account_deletion_notice_recipient_secrets
        WHERE request_id = $2) AS "recipientCount",
      (SELECT count(*)::text FROM pintpath_app.account_deletion_notification_events
        WHERE request_id = $2) AS "eventCount",
      (SELECT count(*)::text FROM pintpath_app.source_evidence_objects
        WHERE owner_user_id = $1 AND deleted_at IS NULL) AS "evidenceCount"
      FROM pintpath_app.accounts account
      JOIN pintpath_app.account_deletion_requests deletion ON deletion.user_id = account.id
      JOIN pintpath_app.account_deletion_completion_outbox notice ON notice.request_id = deletion.id
      WHERE account.id = $1 AND deletion.id = $2`, [USER_ID, REQUEST_ID]);
    expect(verification.rows).toEqual([expect.objectContaining({
      accountStatus: "suspended",
      authProvider: "deleted",
      supabaseUserId: null,
      stripeCustomerId: null,
      requestStatus: "completed",
      outboxStatus: "suppressed_restore",
      leaseToken: null,
      providerMessageId: null,
      checkpointPending: false,
      sessionCount: "0",
      recipientCount: "0",
      eventCount: "0",
      evidenceCount: "0",
    })]);
    expect(verification.rows[0]?.completedAt.toISOString()).toBe(COMPLETED_AT);
    expect(verification.rows[0]?.terminalAt?.toISOString()).toBe(COMPLETED_AT);
  }, 60_000);
});
