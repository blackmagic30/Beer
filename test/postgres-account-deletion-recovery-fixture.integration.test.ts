import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import type { AccountDeletionTombstone } from "../src/lib/data-backup.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";
import {
  completePostgresAccountDeletionRecoveryFixture,
  inspectPostgresAccountDeletionRecoveryFixture,
  preparePostgresAccountDeletionRecoveryFixture,
} from "../src/lib/postgres-account-deletion-recovery-fixture.js";
import { inspectPostgresLogicalRuntimeDatabaseIdentity } from
  "../src/lib/postgres-logical-offsite.js";
import {
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  computePostgresLogicalStateInventory,
} from "../src/lib/postgres-logical-state.js";

const ADMIN_URL_ENV = "PINTPATH_ACCOUNT_DELETION_RECOVERY_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const suffix = crypto.randomBytes(6).toString("hex");
const TEST_DATABASE = `pintpath_adr_${suffix}`;
const TEST_LOGIN = `pintpath_adr_login_${suffix}`;
const TEST_PASSWORD = `PintpathAdr_${crypto.randomBytes(18).toString("hex")}`;
const FIXTURE_ID = "018f0f5a-7b9c-7def-8abc-0123456789ab";
const PREPARED_AT = "2026-08-09T01:00:00.000Z";
const BACKED_UP_AT = "2026-08-09T01:30:00.000Z";
const COMPLETED_AT = "2026-08-09T02:00:00.000Z";

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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
  ) throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database.`);
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

/** Runtime-role adapter restricted to the disposable loopback integration database. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactions = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
      options: [
        "-c search_path=pintpath_app,pg_catalog",
        "-c statement_timeout=30000",
        "-c lock_timeout=10000",
        "-c synchronous_commit=on",
      ].join(" "),
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactions.getStore()?.client ?? this.pool;
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
      const active = this.transactions.getStore();
      if (active) {
        const savepoint = `adr_nested_${active.nextSavepoint++}`;
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
        const result = await this.transactions.run({ client, nextSavepoint: 1 }, work);
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

function verifiedLedger(tombstone: AccountDeletionTombstone): VerifiedAccountDeletionLedger {
  const current = { version: 1, generatedAt: COMPLETED_AT, tombstones: [tombstone] };
  const bytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
  const genesis = {
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: PREPARED_AT,
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  };
  const genesisBytes = Buffer.from(`${JSON.stringify(genesis, null, 2)}\n`);
  const checkpoint = {
    version: 2 as const,
    generatedAt: COMPLETED_AT,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256(genesisBytes),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256(bytes),
    immutableObjectCount: 1,
    immutableSetSha256: sha256("immutable-ledger-set"),
    tombstoneCount: 1,
    latestCompletedAt: COMPLETED_AT,
  };
  const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
  return {
    bytes,
    sha256: sha256(bytes),
    genesisBytes,
    genesisSha256: sha256(genesisBytes),
    checkpointBytes,
    checkpointSha256: sha256(checkpointBytes),
    tombstones: [tombstone],
    checkpoint,
  };
}

describe.skipIf(!configuredAdminUrl)("real PG17 account-deletion recovery fixture", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let root = "";
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
      throw new Error("The disposable account-deletion recovery integration requires PostgreSQL 17.");
    }
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    await targetAdmin.query(
      `UPDATE pintpath_app.schema_metadata SET value = CASE key
        WHEN 'import_state' THEN 'ready'
        WHEN 'live_schema_sha256' THEN $9
        WHEN 'migration_candidate_sha' THEN $1
        WHEN 'migration_manifest_sha256' THEN $2
        WHEN 'migration_plan_sha256' THEN $3
        WHEN 'migration_run_sha256' THEN $4
        WHEN 'source_schema_fingerprint' THEN $5
        WHEN 'source_schema_version' THEN $6
        WHEN 'source_snapshot_sha256' THEN $7
        WHEN 'target_ddl_sha256' THEN $8
        ELSE value END`,
      [
        "c".repeat(40), "1".repeat(64), "2".repeat(64), "3".repeat(64),
        POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
        String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
        "4".repeat(64), "5".repeat(64), "6".repeat(64),
      ],
    );
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${TEST_PASSWORD}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    await targetAdmin.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${TEST_LOGIN}`);
    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD),
    );
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-adr-integration-")));
    fs.chmodSync(root, 0o700);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      const leftovers = await admin.query<{ databaseExists: boolean; loginExists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1) AS "databaseExists",
                EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2) AS "loginExists"`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      await admin.end().catch(() => undefined);
      if (leftovers.rows[0]?.databaseExists || leftovers.rows[0]?.loginExists) {
        throw new Error("Disposable account-deletion recovery integration resources were not removed.");
      }
    }
  }, 30_000);

  it("prepares before backup, completes after verified append, checkpoints, and is exactly replay-safe", async () => {
    const fixtureReceiptFile = path.join(root, "fixture-receipt.json");
    const completionReceiptFile = path.join(root, "completion-receipt.json");
    const ledgerDirectory = path.join(root, "ledger-authority");
    const identity = await inspectPostgresLogicalRuntimeDatabaseIdentity(database!);
    const prepared = await preparePostgresAccountDeletionRecoveryFixture({
      database: database!,
      receiptFile: fixtureReceiptFile,
      expectedDatabaseIdentitySha256: identity,
      fixtureId: FIXTURE_ID,
      preparedAt: PREPARED_AT,
    });
    expect(prepared.receipt.preparedState).toMatchObject({
      phase: "prepared",
      counts: {
        account: "1",
        profile: "1",
        session: "1",
        deletionRequest: "1",
        completionOutbox: "1",
        recipientSecret: "1",
        notificationEvent: "0",
        sourceEvidence: "0",
        sendEligibleOutbox: "0",
        pendingSecretCheckpoint: "0",
      },
    });
    expect(fs.statSync(fixtureReceiptFile).mode & 0o7777).toBe(0o600);
    await expect(inspectPostgresAccountDeletionRecoveryFixture({
      database: database!,
      receiptFile: fixtureReceiptFile,
      expectedReceiptSha256: prepared.receiptSha256,
    })).resolves.toMatchObject({ state: { phase: "prepared" } });

    const state = await computePostgresLogicalStateInventory({
      query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        const result = await targetAdmin!.query<Row>(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    });
    const logicalReceipt = buildPostgresLogicalSourceStateReceipt({
      capturedAt: BACKED_UP_AT,
      databaseIdentitySha256: identity,
      sourceUrlSha256: sha256("restricted-runtime-url"),
      snapshotBindingSha256: sha256("exported-snapshot"),
      archiveBytes: 1,
      archiveSha256: sha256("archive"),
      archiveListingSha256: sha256("listing"),
      manifestBindingSha256: sha256("manifest"),
      state,
    });
    const logicalReceiptFile = path.join(root, "state-receipt.json");
    const logicalReceiptBytes = Buffer.from(canonicalPostgresLogicalStateJson(logicalReceipt));
    fs.writeFileSync(logicalReceiptFile, logicalReceiptBytes, { mode: 0o600 });
    fs.chmodSync(logicalReceiptFile, 0o600);

    const liveBoundCounts = [];
    for (const entry of prepared.receipt.backupRowCounts) {
      const live = await targetAdmin!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pintpath_app.${entry.tableName}`,
      );
      liveBoundCounts.push({ tableName: entry.tableName, rowCount: live.rows[0]!.count });
    }
    expect(liveBoundCounts).toEqual(prepared.receipt.backupRowCounts);

    let appendCalls = 0;
    const options = {
      database: database!,
      receiptFile: fixtureReceiptFile,
      expectedReceiptSha256: prepared.receiptSha256,
      logicalBackupStateReceiptFile: logicalReceiptFile,
      expectedLogicalBackupStateReceiptSha256: sha256(logicalReceiptBytes),
      ledgerAuthorityDirectory: ledgerDirectory,
      completionReceiptFile,
      completedAt: COMPLETED_AT,
      appendAndVerifyTombstone: async (tombstone: AccountDeletionTombstone) => {
        appendCalls += 1;
        return verifiedLedger(tombstone);
      },
    };
    const completed = await completePostgresAccountDeletionRecoveryFixture(options);
    expect(completed.receipt).toMatchObject({
      completedAt: COMPLETED_AT,
      providerCallCount: 0,
      ledgerTombstoneCount: 1,
    });
    expect(fs.statSync(completionReceiptFile).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(ledgerDirectory).mode & 0o7777).toBe(0o700);
    expect(fs.readdirSync(ledgerDirectory).sort()).toEqual([
      "checkpoint.json", "current.json", "genesis.json",
    ]);
    for (const filename of fs.readdirSync(ledgerDirectory)) {
      expect(fs.statSync(path.join(ledgerDirectory, filename)).mode & 0o7777).toBe(0o600);
    }
    const inspected = await inspectPostgresAccountDeletionRecoveryFixture({
      database: database!,
      receiptFile: fixtureReceiptFile,
      expectedReceiptSha256: prepared.receiptSha256,
    });
    expect(inspected.state).toMatchObject({
      phase: "completed",
      account: { authProvider: "deleted", supabaseUserId: null, stripeCustomerId: null },
      outbox: {
        status: "suppressed_restore",
        providerMessageId: null,
        providerLastEvent: null,
        secretPurgeCheckpointPending: false,
        secretPurgeGeneration: 1,
      },
      counts: {
        session: "0",
        recipientSecret: "0",
        notificationEvent: "0",
        sourceEvidence: "0",
        sendEligibleOutbox: "0",
        pendingSecretCheckpoint: "0",
      },
    });

    const repeated = await completePostgresAccountDeletionRecoveryFixture(options);
    expect(repeated).toEqual(completed);
    expect(appendCalls).toBe(2);
    const role = await targetAdmin!.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [TEST_LOGIN],
    );
    expect(role.rows).toEqual([{
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    }]);
  }, 60_000);
});
