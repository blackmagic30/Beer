import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import {
  SourceEvidenceObjectRepository,
  SourceEvidenceObjectRepositoryError,
  sourceEvidenceAccountLockKey,
  type RegisterSourceEvidenceObjectInput,
} from "../src/db/source-evidence-object.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_SOURCE_EVIDENCE_OBJECT_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_source_evidence_object_integration_test";
const TEST_LOGIN = "pintpath_source_evidence_object_integration_login";
const CREATED_AT = "2026-08-09T00:00:00.000Z";
const RETENTION_EXPIRES_AT = "2026-11-07T00:00:00.000Z";
const BYTES = Buffer.from("postgres private evidence", "utf8");

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

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Direct adapter restricted to this explicitly gated loopback PG17 rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
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
      max: 8,
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
        const savepoint = `source_evidence_object_nested_${active.nextSavepoint++}`;
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

/** Throws after PostgreSQL accepts one evidence insert to prove transaction rollback. */
class InsertFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private armed = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (this.armed && /INSERT\s+OR\s+IGNORE\s+INTO\s+source_evidence_objects/i.test(sql)) {
          this.armed = false;
          throw new Error("injected PostgreSQL source-evidence detail");
        }
        return result;
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => statement.get<Row>(...bindings),
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => statement.all<Row>(...bindings),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.delegate.exec(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return this.delegate.transaction(work);
  }

  async close(): Promise<void> {
    // The owning fixture closes the delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

/** Pauses a real deletion transition after its guarded UPDATE but before commit. */
class PauseAfterDeletionBeginDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly paused: Promise<void>;
  private markPaused!: () => void;
  private readonly releaseGate: Promise<void>;
  private releaseGateResolve!: () => void;
  private armed = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {
    this.paused = new Promise<void>((resolve) => {
      this.markPaused = resolve;
    });
    this.releaseGate = new Promise<void>((resolve) => {
      this.releaseGateResolve = resolve;
    });
  }

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => statement.run(...bindings),
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await statement.get<Row>(...bindings);
        if (
          this.armed
          && /UPDATE\s+account_deletion_requests[\s\S]*SET\s+status\s*=\s*'processing'[\s\S]*RETURNING/i.test(sql)
        ) {
          this.armed = false;
          this.markPaused();
          await this.releaseGate;
        }
        return result;
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => statement.all<Row>(...bindings),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.delegate.exec(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return this.delegate.transaction(work);
  }

  async close(): Promise<void> {
    // The owning fixture closes the shared delegate exactly once.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }

  async waitUntilPaused(): Promise<void> {
    await this.paused;
  }

  release(): void {
    this.releaseGateResolve();
  }
}

function registration(
  id: string,
  ownerUserId: string | null,
  overrides: Partial<RegisterSourceEvidenceObjectInput> = {},
): RegisterSourceEvidenceObjectInput {
  const provider = overrides.storageProvider ?? "sqlite_private";
  return {
    id,
    ownerUserId,
    storageProvider: provider,
    objectPath: provider === "sqlite_private" ? `evidence/${id}` : `evidence/2026-08/${id}.jpg`,
    mimeType: "image/jpeg",
    byteSize: BYTES.length,
    dataBase64: provider === "sqlite_private" ? BYTES.toString("base64") : null,
    externalUrl: null,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function expectCode(code: SourceEvidenceObjectRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SourceEvidenceObjectRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("SourceEvidenceObjectRepository on restricted PostgreSQL 17", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: SourceEvidenceObjectRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const identity = await admin.query<{ server_version_num: string; is_superuser: boolean }>(
      `SELECT current_setting('server_version_num') AS server_version_num,
              role.rolsuper AS is_superuser
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = current_user`,
    );
    const serverVersion = Number(identity.rows[0]?.server_version_num ?? 0);
    if (serverVersion < 170_000 || serverVersion >= 180_000 || !identity.rows[0]?.is_superuser) {
      throw new Error("The source-evidence object rehearsal requires a PostgreSQL 17 loopback superuser.");
    }

    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));

    const password = crypto.randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new SourceEvidenceObjectRepository(database);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.query("ROLLBACK").catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    targetAdmin = null;
    if (!admin) return;
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
    await admin.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
    if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
    if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
    const expectedAbsent = [
      TEST_LOGIN,
      ...(!runtimeRoleExisted ? ["pintpath_runtime"] : []),
      ...(!migratorRoleExisted ? ["pintpath_migrator"] : []),
    ];
    const residue = await admin.query<{ databases: string; roles: string }>(
      `SELECT
         (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS databases,
         (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])) AS roles`,
      [TEST_DATABASE, expectedAbsent],
    ).catch(() => ({ rows: [{ databases: "1", roles: "1" }] }));
    await admin.end().catch(() => undefined);
    admin = null;
    if (residue.rows[0]?.databases !== "0" || residue.rows[0]?.roles !== "0") {
      throw new Error("Source-evidence object PG rehearsal left database or role residue.");
    }
  }, 30_000);

  it("proves PG17 RLS, least privilege, native decoding, exact concurrency, and account-lock contention", async () => {
    if (!database || !targetAdmin) throw new Error("PostgreSQL fixture was not initialized.");
    const role = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls",
              role.rolcreatedb AS "createDb", role.rolcreaterole AS "createRole",
              role.rolreplication AS "replication",
              pg_catalog.pg_has_role(current_user, 'pintpath_runtime', 'member') AS "runtimeMember",
              pg_catalog.pg_has_role(current_user, 'pintpath_migrator', 'member') AS "migratorMember",
              pg_catalog.has_schema_privilege(current_user, 'pintpath_app', 'CREATE') AS "schemaCreate",
              pg_catalog.has_table_privilege(current_user, 'source_evidence_objects', 'TRUNCATE') AS "tableTruncate"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<Record<string, boolean | string>>();
    expect(role).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
      createDb: false,
      createRole: false,
      replication: false,
      runtimeMember: true,
      migratorMember: false,
      schemaCreate: false,
      tableTruncate: false,
    });
    const rls = await database.prepare(
      `SELECT class.relrowsecurity AS "enabled", class.relforcerowsecurity AS "forced"
         FROM pg_catalog.pg_class class
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'pintpath_app' AND class.relname = 'source_evidence_objects'`,
    ).get<{ enabled: boolean; forced: boolean }>();
    expect(rls).toEqual({ enabled: true, forced: true });

    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, auth_provider, role, subscription_status,
         status, created_at, updated_at
       ) VALUES
         ('pg-owner-race', 'pg-owner-race@example.test', 'hash', 'local', 'user', 'free',
          'active', @now, @now),
         ('pg-owner-lock', 'pg-owner-lock@example.test', 'hash', 'local', 'user', 'free',
          'warned', @now, @now)`,
    ).run({ now: CREATED_AT });

    const concurrentInput = registration("pg-race", "pg-owner-race");
    const race = await Promise.all([
      repository.registerSourceEvidenceObject(concurrentInput),
      repository.registerSourceEvidenceObject(concurrentInput),
      repository.registerSourceEvidenceObject(concurrentInput),
    ]);
    expect(race.filter((result) => result.state === "created")).toHaveLength(1);
    expect(race.filter((result) => result.state === "replayed")).toHaveLength(2);
    expect(race[0]?.object).toMatchObject({
      id: "pg-race",
      byteSize: BYTES.length,
      createdAt: CREATED_AT,
      retentionExpiresAt: RETENTION_EXPIRES_AT,
    });
    const native = await targetAdmin.query<{
      byte_type: string;
      created_type: string;
      retention_type: string;
      byte_size: string;
    }>(
      `SELECT pg_catalog.pg_typeof(byte_size)::text AS byte_type,
              pg_catalog.pg_typeof(created_at)::text AS created_type,
              pg_catalog.pg_typeof(retention_expires_at)::text AS retention_type,
              byte_size::text AS byte_size
         FROM pintpath_app.source_evidence_objects WHERE id = 'pg-race'`,
    );
    expect(native.rows[0]).toEqual({
      byte_type: "bigint",
      created_type: "timestamp with time zone",
      retention_type: "timestamp with time zone",
      byte_size: String(BYTES.length),
    });

    await targetAdmin.query("BEGIN");
    await targetAdmin.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [sourceEvidenceAccountLockKey("pg-owner-lock")],
    );
    const blockedRegistration = repository.registerSourceEvidenceObject(
      registration("pg-lock-contention", "pg-owner-lock"),
    );
    try {
      const early = await Promise.race([
        blockedRegistration.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 120)),
      ]);
      expect(early).toBe("blocked");
    } finally {
      await targetAdmin.query("COMMIT");
    }
    await expect(blockedRegistration).resolves.toMatchObject({ state: "created" });
  });

  it("fences deletion, conflicts, malformed native rows, and rolls back an accepted insert", async () => {
    if (!database || !targetAdmin) throw new Error("PostgreSQL fixture was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, auth_provider, role, subscription_status,
         status, created_at, updated_at
       ) VALUES
         ('pg-owner-deleting', 'pg-owner-deleting@example.test', 'hash', 'local', 'user', 'free',
          'active', @now, @now),
         ('pg-owner-rollback', 'pg-owner-rollback@example.test', 'hash', 'local', 'user', 'free',
          'active', @now, @now)`,
    ).run({ now: CREATED_AT });
    await database.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('pg-deletion', 'pg-owner-deleting', 'processing', @now, @expires, @now, @now)`,
    ).run({ now: CREATED_AT, expires: RETENTION_EXPIRES_AT });
    await expect(repository.registerSourceEvidenceObject(
      registration("pg-deletion-locked", "pg-owner-deleting"),
    )).rejects.toSatisfy(expectCode("deletion_locked"));

    const identity = registration("pg-conflict", null, {
      storageProvider: "filesystem_private",
      dataBase64: null,
    });
    await repository.registerSourceEvidenceObject(identity);
    await expect(repository.registerSourceEvidenceObject({ ...identity, id: "pg-conflict-other" }))
      .rejects.toSatisfy(expectCode("evidence_conflict"));

    const rollbackInput = registration("pg-rollback", "pg-owner-rollback");
    const faulted = new SourceEvidenceObjectRepository(new InsertFaultDatabase(database));
    const fault = await faulted.registerSourceEvidenceObject(rollbackInput).catch((error: unknown) => error);
    expect(fault).toBeInstanceOf(SourceEvidenceObjectRepositoryError);
    expect(fault).toMatchObject({ code: "persistence_failure" });
    expect((fault as Error).message).not.toContain("PostgreSQL source-evidence detail");
    const rollbackCount = await targetAdmin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pintpath_app.source_evidence_objects WHERE id = 'pg-rollback'",
    );
    expect(rollbackCount.rows[0]?.count).toBe("0");
    await expect(repository.registerSourceEvidenceObject(rollbackInput))
      .resolves.toMatchObject({ state: "created" });

    await targetAdmin.query(
      `INSERT INTO pintpath_app.source_evidence_objects (
         id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
         data_base64, external_url, retention_expires_at, deleted_at, created_at
       ) VALUES (
         'pg-malformed', NULL, 'sqlite_private', 'evidence/pg-malformed', 'image/jpeg',
         9000000::bigint, 'cHJpdmF0ZQ==', NULL,
         '2026-11-07T00:00:00.000Z'::timestamptz, NULL,
         '2026-08-09T00:00:00.000Z'::timestamptz
       )`,
    );
    await expect(repository.getSourceEvidenceObject("pg-malformed"))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("serializes a real deletion transition ahead of owned evidence registration", async () => {
    if (!database) throw new Error("PostgreSQL fixture was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, auth_provider, role, subscription_status,
         status, created_at, updated_at
       ) VALUES (
         'pg-deletion-race', 'pg-deletion-race@example.test', 'hash', 'local',
         'user', 'free', 'active', @now, @now
       )`,
    ).run({ now: CREATED_AT });

    const pausedDatabase = new PauseAfterDeletionBeginDatabase(database);
    const deletionRepository = new AccountDeletionQueueRepository(pausedDatabase);
    await deletionRepository.createAccountDeletionRequest({
      id: "pg-deletion-race-request",
      userId: "pg-deletion-race",
      userMessage: null,
      requestedAt: CREATED_AT,
      executeAfter: RETENTION_EXPIRES_AT,
    });

    const deletionAttempt = deletionRepository.beginAccountDeletion({
      requestId: "pg-deletion-race-request",
      reviewedBy: "pg-deletion-race",
      now: RETENTION_EXPIRES_AT,
      staleBefore: CREATED_AT,
    });
    await pausedDatabase.waitUntilPaused();

    let registrationSettled = false;
    const registrationAttempt = repository.registerSourceEvidenceObject(
      registration("pg-deletion-race-evidence", "pg-deletion-race", {
        createdAt: RETENTION_EXPIRES_AT,
        retentionExpiresAt: "2027-02-05T00:00:00.000Z",
      }),
    );
    void registrationAttempt.then(
      () => { registrationSettled = true; },
      () => { registrationSettled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(registrationSettled).toBe(false);

    pausedDatabase.release();
    await expect(deletionAttempt).resolves.toMatchObject({ status: "processing" });
    await expect(registrationAttempt).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.getSourceEvidenceObject("pg-deletion-race-evidence")).resolves.toBeNull();
  });
});
