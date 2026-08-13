import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SourceEvidenceRetentionRepository,
  type SourceEvidenceRetentionRepositoryError,
} from "../src/db/source-evidence-retention.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_source_evidence_retention_integration_test";
const TEST_LOGIN = "pintpath_source_evidence_retention_integration_login";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const BASE_TIME = "2026-08-08T00:00:00.000Z";
const HARD_CUTOFF = "2026-08-08T00:20:00.000Z";
const NOW = "2026-08-08T01:40:00.000Z";
const DELETED_AT = "2026-08-08T01:41:00.000Z";

function validateDisposableAdminUrl(value: string): URL {
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

/** Test-only adapter for an explicitly insecure loopback PostgreSQL rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{
    client: PoolClient;
    nextSavepoint: number;
  }>();
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
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
        const savepoint = `pintpath_nested_${active.nextSavepoint++}`;
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

describe.skipIf(!configuredAdminUrl)("source-evidence retention repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: SourceEvidenceRetentionRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const identity = await admin.query<{ server_version_num: string; is_superuser: boolean }>(
      `SELECT current_setting('server_version_num') AS server_version_num,
              role.rolsuper AS is_superuser
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`,
    );
    const version = Number(identity.rows[0]?.server_version_num ?? 0);
    if (version < 170_000 || version >= 180_000 || !identity.rows[0]?.is_superuser) {
      throw new Error("The disposable retention rehearsal requires a PostgreSQL 17 superuser.");
    }

    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    const password = crypto.randomBytes(32).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(`
      CREATE SCHEMA pintpath_app;
      SET search_path = pintpath_app, pg_catalog;
      CREATE TABLE accounts (
        id text PRIMARY KEY
      );
      CREATE TABLE source_evidence_objects (
        id text PRIMARY KEY,
        owner_user_id text REFERENCES accounts(id),
        storage_provider text NOT NULL DEFAULT 'sqlite_private',
        object_path text NOT NULL UNIQUE,
        mime_type text,
        byte_size bigint,
        data_base64 text,
        external_url text,
        retention_expires_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE submissions (
        id text PRIMARY KEY,
        status text NOT NULL
      );
      CREATE TABLE submission_source_evidence (
        submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        evidence_id text NOT NULL REFERENCES source_evidence_objects(id) ON DELETE CASCADE,
        sort_order bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (submission_id, evidence_id),
        UNIQUE (submission_id, sort_order)
      );
      CREATE INDEX source_evidence_retention
        ON source_evidence_objects (deleted_at, retention_expires_at);
      CREATE INDEX source_evidence_owner
        ON source_evidence_objects (owner_user_id, created_at DESC);
      CREATE INDEX submission_source_evidence_evidence
        ON submission_source_evidence (evidence_id);

      INSERT INTO accounts (id) VALUES ('owner-pg');
      INSERT INTO submissions (id, status) VALUES
        ('submission-pending', 'pending'),
        ('submission-approved', 'approved');
      INSERT INTO source_evidence_objects (
        id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
        data_base64, external_url, retention_expires_at, deleted_at, created_at
      ) VALUES
        ('pg-native', 'owner-pg', 'supabase_private', 'private/pg-native', 'image/jpeg', 1024,
         'cHJpdmF0ZQ==', 'https://private.example/pg-native', '2026-08-08T00:50:00Z', NULL, '2026-08-08T00:30:00Z'),
        ('pg-concurrent', 'owner-pg', 'filesystem_private', 'private/pg-concurrent', 'image/png', 2048,
         'cHJpdmF0ZQ==', NULL, '2026-08-08T00:51:00Z', NULL, '2026-08-08T00:31:00Z'),
        ('pg-held', 'owner-pg', 'supabase_private', 'private/pg-held', 'image/jpeg', 512,
         NULL, NULL, '2026-08-08T00:52:00Z', NULL, '2026-08-08T00:21:00Z'),
        ('pg-hard-cap', 'owner-pg', 'supabase_private', 'private/pg-hard-cap', 'image/jpeg', 512,
         NULL, NULL, '2026-08-08T00:53:00Z', NULL, '2026-08-08T00:20:00Z'),
        ('pg-closed', 'owner-pg', 'sqlite_private', 'private/pg-closed', 'image/jpeg', 128,
         'cHJpdmF0ZQ==', NULL, '2026-08-08T00:54:00Z', NULL, '2026-08-08T00:30:00Z');
      INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at) VALUES
        ('submission-pending', 'pg-held', 0, '2026-08-08T00:55:00Z'),
        ('submission-pending', 'pg-hard-cap', 1, '2026-08-08T00:55:00Z'),
        ('submission-approved', 'pg-closed', 0, '2026-08-08T00:55:00Z');

      ALTER TABLE source_evidence_objects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE source_evidence_objects FORCE ROW LEVEL SECURITY;
      CREATE POLICY source_evidence_retention_select ON source_evidence_objects
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      CREATE POLICY source_evidence_retention_update ON source_evidence_objects
        FOR UPDATE TO ${TEST_LOGIN} USING (true) WITH CHECK (true);
      ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE submissions FORCE ROW LEVEL SECURITY;
      CREATE POLICY submission_retention_select ON submissions
        FOR SELECT TO ${TEST_LOGIN} USING (true);
      ALTER TABLE submission_source_evidence ENABLE ROW LEVEL SECURITY;
      ALTER TABLE submission_source_evidence FORCE ROW LEVEL SECURITY;
      CREATE POLICY submission_evidence_retention_select ON submission_source_evidence
        FOR SELECT TO ${TEST_LOGIN} USING (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT, UPDATE ON source_evidence_objects TO ${TEST_LOGIN};
      GRANT SELECT ON submissions, submission_source_evidence TO ${TEST_LOGIN};
    `);

    database = new LoopbackPostgresTestDatabase(
      withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password),
    );
    repository = new SourceEvidenceRetentionRepository(database);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (!admin) return;
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
    const residue = await admin.query<{ database_count: string; role_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS database_count,
         (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = $2) AS role_count`,
      [TEST_DATABASE, TEST_LOGIN],
    );
    await admin.end().catch(() => undefined);
    admin = null;
    if (residue.rows[0]?.database_count !== "0" || residue.rows[0]?.role_count !== "0") {
      throw new Error("Disposable source-evidence retention PostgreSQL resources were not fully removed.");
    }
  }, 30_000);

  it("uses native types and least-privilege RLS-capable runtime access", async () => {
    const role = await database!.prepare(
      `SELECT role.rolsuper AS "superuser",
              role.rolcreatedb AS "createDatabase",
              role.rolcreaterole AS "createRole",
              role.rolreplication AS "replication",
              role.rolbypassrls AS "bypassRls",
              pg_catalog.has_schema_privilege(current_user, 'pintpath_app', 'CREATE') AS "schemaCreate",
              pg_catalog.has_table_privilege(current_user, 'source_evidence_objects', 'INSERT') AS "tableInsert",
              pg_catalog.has_table_privilege(current_user, 'source_evidence_objects', 'DELETE') AS "tableDelete"
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`,
    ).get<Record<string, boolean>>();
    expect(role).toEqual({
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      schemaCreate: false,
      tableInsert: false,
      tableDelete: false,
    });

    const candidates = await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 20,
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "pg-native",
      "pg-concurrent",
      "pg-hard-cap",
      "pg-closed",
    ]);
    expect(candidates.find((candidate) => candidate.id === "pg-hard-cap"))
      .toMatchObject({ heldForOpenReview: true, reason: "hard_cap" });
    expect(await repository.countExpiredSourceEvidence(NOW, HARD_CUTOFF)).toBe(4);
    expect(await repository.countOverdueHeldSourceEvidence(NOW, HARD_CUTOFF)).toEqual({
      heldForOpenReview: 2,
      pastHardCap: 1,
    });

    await targetAdmin!.query("SET search_path = pintpath_app, pg_catalog");
    const native = await targetAdmin!.query<{
      byte_type: string;
      retention_type: string;
      linked_created_type: string;
    }>(
      `SELECT pg_catalog.pg_typeof(evidence.byte_size)::text AS byte_type,
              pg_catalog.pg_typeof(evidence.retention_expires_at)::text AS retention_type,
              pg_catalog.pg_typeof(link.created_at)::text AS linked_created_type
       FROM source_evidence_objects evidence
       JOIN submission_source_evidence link ON link.evidence_id = 'pg-hard-cap'
       WHERE evidence.id = 'pg-native'`,
    );
    expect(native.rows[0]).toEqual({
      byte_type: "bigint",
      retention_type: "timestamp with time zone",
      linked_created_type: "timestamp with time zone",
    });

    const nativeCandidate = candidates.find((candidate) => candidate.id === "pg-native")!;
    const tombstone = await repository.markSourceEvidenceDeleted({
      id: nativeCandidate.id,
      deletionToken: nativeCandidate.deletionToken,
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      deletedAt: DELETED_AT,
    });
    expect(tombstone).toMatchObject({
      objectPath: "private/pg-native",
      externalUrl: null,
      byteSize: null,
      deletedAt: DELETED_AT,
    });
  });

  it("allows only one PostgreSQL replica to acknowledge an identical provider deletion", async () => {
    const candidate = (await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 20,
    })).find((item) => item.id === "pg-concurrent")!;
    const finalizations = await Promise.allSettled([
      repository.markSourceEvidenceDeleted({
        id: candidate.id,
        deletionToken: candidate.deletionToken,
        now: NOW,
        hardCutoff: HARD_CUTOFF,
        deletedAt: DELETED_AT,
      }),
      repository.markSourceEvidenceDeleted({
        id: candidate.id,
        deletionToken: candidate.deletionToken,
        now: NOW,
        hardCutoff: HARD_CUTOFF,
        deletedAt: DELETED_AT,
      }),
    ]);
    expect(finalizations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = finalizations.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected one PostgreSQL finalizer to lose the row fence.");
    expect((rejected.reason as SourceEvidenceRetentionRepositoryError).code)
      .toBe("retention_candidate_conflict");
    await expect(repository.listSourceEvidenceForOwner({ ownerUserId: "owner-pg", limit: 20 }))
      .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: candidate.id })]));
  });
});
