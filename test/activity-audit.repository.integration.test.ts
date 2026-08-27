import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ActivityAuditRepository,
  ActivityAuditRepositoryError,
} from "../src/db/activity-audit.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_ACTIVITY_AUDIT_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_activity_audit_integration_test";
const TEST_LOGIN = "pintpath_activity_audit_integration_login";
const NOW = "2026-08-08T18:00:00.000Z";
const LATER = "2026-08-08T18:01:00.000Z";
const BEFORE = "2026-08-08T17:59:00.000Z";
const IP_HASH = "a".repeat(32);
const USER_AGENT_HASH = "b".repeat(32);

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
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
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

/** Direct PG adapter restricted to the explicitly insecure loopback rehearsal. */
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
      max: 16,
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
        const savepoint = `activity_audit_nested_${active.nextSavepoint++}`;
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

/** Injects one failure after PostgreSQL accepts an activity INSERT. */
class ActivityInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  failNextActivityInsert = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (this.failNextActivityInsert && /INSERT\s+INTO\s+user_activity_events/i.test(sql)) {
          this.failNextActivityInsert = false;
          throw new Error("injected PostgreSQL activity failure");
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
    // The fixture owns the shared delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

function expectCode(code: ActivityAuditRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ActivityAuditRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("real restricted PG17 activity/audit repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: ActivityAuditRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
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
    repository = new ActivityAuditRepository(database);
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
      await admin.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      const rolesExpectedAbsent = [
        TEST_LOGIN,
        ...(!runtimeRoleExisted ? ["pintpath_runtime"] : []),
        ...(!migratorRoleExisted ? ["pintpath_migrator"] : []),
      ];
      const residue = await admin.query<{ databases: string; roles: string }>(
        `SELECT
           (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])) AS roles`,
        [TEST_DATABASE, rolesExpectedAbsent],
      ).catch(() => ({ rows: [{ databases: "1", roles: "1" }] }));
      if (residue.rows[0]?.databases !== "0" || residue.rows[0]?.roles !== "0") {
        throw new Error("Activity/audit PG rehearsal left database or role residue.");
      }
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves PG17 least privilege, RLS, native types, contention, and keyset ordering", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    const runtime = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls",
              role.rolcreatedb AS "createDb", role.rolcreaterole AS "createRole",
              role.rolreplication AS "replication",
              pg_has_role(current_user, 'pintpath_runtime', 'member') AS "runtimeMember",
              pg_has_role(current_user, 'pintpath_migrator', 'member') AS "migratorMember"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<{
      serverVersionNum: string;
      superuser: boolean;
      bypassRls: boolean;
      createDb: boolean;
      createRole: boolean;
      replication: boolean;
      runtimeMember: boolean;
      migratorMember: boolean;
    }>();
    expect(runtime).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
      createDb: false,
      createRole: false,
      replication: false,
      runtimeMember: true,
      migratorMember: false,
    });
    const rls = await database.prepare(
      `SELECT bool_and(class.relrowsecurity) AS "enabled",
              bool_and(class.relforcerowsecurity) AS "forced"
         FROM pg_catalog.pg_class class
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'pintpath_app'
          AND class.relname = ANY(@tables)`,
    ).get<{ enabled: boolean; forced: boolean }>({
      tables: ["user_activity_events", "events", "security_audit_log"],
    });
    expect(rls).toEqual({ enabled: true, forced: true });

    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES ('pg-activity-user', 'pg-activity-user@example.test', 'hash', 'user', 'free', @now, @now)`,
    ).run({ now: NOW });
    const activityInput = {
      id: "pg-activity-idempotent",
      userId: "pg-activity-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: "pg-activity-user",
      metadata: { authProvider: "local", apiKey: "sk_test_never_store" },
      createdAt: NOW,
    };
    const exactWrites = await Promise.all([
      repository.createUserActivityEvent(activityInput),
      repository.createUserActivityEvent(activityInput),
    ]);
    expect(exactWrites.map((write) => write.outcome).sort()).toEqual(["duplicate", "inserted"]);
    expect(exactWrites[0]?.record.metadata).toEqual({ authProvider: "[REDACTED]", apiKey: "[REDACTED]" });

    const conflictBase = {
      ...activityInput,
      id: "pg-activity-conflict",
      metadata: { contender: "a" },
    };
    const conflictWrites = await Promise.allSettled([
      repository.createUserActivityEvent(conflictBase),
      repository.createUserActivityEvent({ ...conflictBase, metadata: { contender: "b" } }),
    ]);
    expect(conflictWrites.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    const rejected = conflictWrites.find((write) => write.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toSatisfy(expectCode("activity_conflict"));

    await repository.createUserActivityEvent({ ...activityInput, id: "pg-activity-z", createdAt: LATER });
    await repository.createUserActivityEvent({ ...activityInput, id: "pg-activity-y", createdAt: LATER });
    const firstPage = await repository.listUserActivityEvents({ userId: "pg-activity-user", limit: 2 });
    expect(firstPage.items.map((item) => item.id)).toEqual(["pg-activity-z", "pg-activity-y"]);
    const secondPage = await repository.listUserActivityEvents({
      userId: "pg-activity-user",
      limit: 3,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map((item) => item.id)).toContain("pg-activity-idempotent");

    await repository.recordEvent({
      id: "pg-analytics",
      userId: "pg-activity-user",
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: "pg-venue",
      beerId: "Guinness",
      suburb: "Fitzroy",
      metadata: { query: "Guinness" },
      createdAt: NOW,
    });
    const idempotentEventInput = {
      id: "pg-price-confirmation",
      userId: "pg-activity-user",
      anonymousSessionId: null,
      eventType: "price_confirmation_answered",
      venueId: "pg-venue",
      beerId: "Guinness",
      suburb: "Fitzroy",
      metadata: {
        outcome: "yes",
        priceRecordId: "pg-price-1",
        priceVersion: "a".repeat(64),
        sourceType: "community_verified",
      },
      createdAt: NOW,
    };
    const idempotentWrites = await Promise.all([
      repository.recordIdempotentEvent(idempotentEventInput),
      repository.recordIdempotentEvent({ ...idempotentEventInput, createdAt: LATER }),
    ]);
    expect(idempotentWrites.map((write) => write.outcome).sort()).toEqual(["duplicate", "inserted"]);
    const insertedIdempotentIndex = idempotentWrites.findIndex((write) => write.outcome === "inserted");
    const firstIdempotentTimestamp = insertedIdempotentIndex === 0 ? NOW : LATER;
    expect(idempotentWrites.every((write) => write.record.createdAt === firstIdempotentTimestamp)).toBe(true);
    await expect(repository.recordIdempotentEvent({
      ...idempotentEventInput,
      metadata: { ...idempotentEventInput.metadata, outcome: "no" },
      createdAt: LATER,
    })).rejects.toSatisfy(expectCode("event_conflict"));
    await expect(repository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["pg-price-1"],
      since: BEFORE,
      asOf: LATER,
    })).resolves.toEqual([
      expect.objectContaining({
        eventId: "pg-price-confirmation",
        priceRecordId: "pg-price-1",
        priceVersion: "a".repeat(64),
        sourceType: "community_verified",
        verificationEffect: "signal_only",
      }),
    ]);
    await repository.recordIdempotentEvent({
      ...idempotentEventInput,
      id: "pg-price-confirmation-no",
      metadata: { ...idempotentEventInput.metadata, outcome: "no" },
      createdAt: LATER,
    });
    await expect(repository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["pg-price-1"],
      since: BEFORE,
      asOf: LATER,
    })).resolves.toEqual([]);
    await repository.insertSecurityAuditLog({
      id: "pg-audit",
      actorUserId: "pg-activity-user",
      actorRole: "user",
      action: "account_updated",
      targetType: "account",
      targetId: "pg-activity-user",
      metadata: { source: "integration", password: "never-store" },
      ipHash: IP_HASH,
      userAgentHash: USER_AGENT_HASH,
      createdAt: NOW,
    });
    await repository.insertSecurityAuditLog({
      id: "pg-audit-venue-delete",
      actorUserId: "pg-activity-user",
      actorRole: "venue_manager",
      action: "venue_manager_delete",
      targetType: "venue_beer",
      targetId: "pg-beer",
      metadata: { venueId: "pg-venue", changeType: "beer" },
      ipHash: IP_HASH,
      userAgentHash: USER_AGENT_HASH,
      createdAt: LATER,
    });
    await expect(repository.countSecurityAuditLogs({ action: "account_updated" })).resolves.toBe(1);
    await expect(repository.countRecentVenueManagerDeletes({
      venueId: "pg-venue",
      since: NOW,
      changeType: "beer",
    })).resolves.toBe(1);

    const nativeRows = await database.prepare(
      `SELECT activity.metadata_json AS "activityMetadata",
              activity.created_at AS "activityCreatedAt",
              event.metadata_json AS "eventMetadata",
              audit.metadata_json AS "auditMetadata"
         FROM user_activity_events activity
         CROSS JOIN events event
         CROSS JOIN security_audit_log audit
        WHERE activity.id = 'pg-activity-idempotent'
          AND event.id = 'pg-analytics' AND audit.id = 'pg-audit'`,
    ).all<{
      activityMetadata: Record<string, unknown>;
      activityCreatedAt: string;
      eventMetadata: Record<string, unknown>;
      auditMetadata: Record<string, unknown>;
    }>();
    expect(nativeRows).toEqual([{
      activityMetadata: { authProvider: "[REDACTED]", apiKey: "[REDACTED]" },
      activityCreatedAt: NOW,
      eventMetadata: { query: "Guinness" },
      auditMetadata: { source: "integration", password: "[REDACTED]" },
    }]);
  });

  it("rolls back post-insert failures, maps missing actors, and enforces JSONB objects", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    const input = {
      id: "pg-rollback-activity",
      userId: "pg-activity-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: "pg-activity-user",
      metadata: {},
      createdAt: LATER,
    };
    const faultRepository = new ActivityAuditRepository(new ActivityInsertFaultDatabase(database));
    await expect(faultRepository.createUserActivityEvent(input))
      .rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getUserActivityEventById(input.id)).resolves.toBeNull();
    await expect(repository.createUserActivityEvent(input)).resolves.toMatchObject({ outcome: "inserted" });

    await expect(repository.createUserActivityEvent({
      ...input,
      id: "pg-missing-account",
      userId: "missing-account",
      relatedEntityId: "missing-account",
    })).rejects.toSatisfy(expectCode("account_not_found"));

    await expect(database.prepare(
      `INSERT INTO security_audit_log (
         id, actor_user_id, actor_role, action, target_type, target_id,
         metadata_json, ip_hash, user_agent_hash, created_at
       ) VALUES ('pg-invalid-jsonb', NULL, NULL, 'invalid_json_test', NULL, NULL,
                 '[]'::jsonb, NULL, NULL, @now)`,
    ).run({ now: NOW })).rejects.toMatchObject({ code: "23514" });
    const invalidCount = await database.prepare(
      "SELECT count(*)::text AS \"count\" FROM security_audit_log WHERE id = 'pg-invalid-jsonb'",
    ).get<{ count: string }>();
    expect(invalidCount).toEqual({ count: "0" });
  });
});
