import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { MissionLifecycleRepository } from "../src/db/mission-lifecycle.repository.js";
import {
  VenueManagerInternalSubmissionRepository,
  VenueManagerInternalSubmissionRepositoryError,
  type CreateVenueManagerInternalSubmissionInput,
} from "../src/db/venue-manager-internal-submission.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_VENUE_MANAGER_INTERNAL_SUBMISSION_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_venue_manager_internal_submission_integration_test";
const TEST_LOGIN = "pintpath_venue_manager_internal_submission_integration_login";
const NOW = "2026-08-09T10:00:00.000Z";
const LATER = "2026-08-09T10:05:00.000Z";
const OBSERVED_AT = "2026-08-09T09:00:00.000Z";
const ACCEPTED_AT = "2026-08-09T08:00:00.000Z";
const ACCEPTED_AFTER = "2026-08-08T10:00:00.000Z";
const MISSION_UPDATED_AT = "2026-08-09T07:00:00.000Z";
const RETENTION_EXPIRES_AT = "2026-11-07T00:00:00.000Z";

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
        const savepoint = `venue_manager_internal_nested_${active.nextSavepoint++}`;
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

class PauseAfterSqlDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly paused: Promise<void>;
  private markPaused!: () => void;
  private readonly releaseGate: Promise<void>;
  private releaseGateResolve!: () => void;
  private armed = true;

  constructor(
    private readonly delegate: LoopbackPostgresTestDatabase,
    private readonly pattern: RegExp,
  ) {
    this.paused = new Promise<void>((resolve) => { this.markPaused = resolve; });
    this.releaseGate = new Promise<void>((resolve) => { this.releaseGateResolve = resolve; });
  }

  private async pause<Result>(sql: string, result: Result): Promise<Result> {
    if (this.armed && this.pattern.test(sql)) {
      this.armed = false;
      this.markPaused();
      await this.releaseGate;
    }
    return result;
  }

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => this.pause(sql, await statement.run(...bindings)),
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => this.pause(
        sql,
        await statement.get<Row>(...bindings),
      ),
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

class ItemInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private armed = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (this.armed && /INSERT\s+INTO\s+submission_items/i.test(sql)) {
          this.armed = false;
          throw new Error("injected PostgreSQL internal detail");
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
    // The owning fixture closes the shared delegate exactly once.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

function expectCode(
  code: VenueManagerInternalSubmissionRepositoryError["code"],
): (error: unknown) => boolean {
  return (error) => error instanceof VenueManagerInternalSubmissionRepositoryError && error.code === code;
}

function submissionInput(input: {
  id: string;
  clientSubmissionId: string;
  managerAccountId: string;
  managerAssignmentId: string;
  venueId: string;
  evidenceId: string;
  missionId?: string | undefined;
}): CreateVenueManagerInternalSubmissionInput {
  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    managerAccountId: input.managerAccountId,
    managerAssignmentId: input.managerAssignmentId,
    venueId: input.venueId,
    venueName: `Venue ${input.venueId}`,
    suburb: "Fitzroy",
    submissionType: "happy_hour_update",
    observedAt: OBSERVED_AT,
    evidenceIds: [input.evidenceId],
    ocrStatus: "not_requested",
    ocrSummary: null,
    notes: "PostgreSQL internal happy hour.",
    location: null,
    pendingVenue: {
      googlePlaceId: null,
      name: `Venue ${input.venueId}`,
      address: "1 Test Street",
      suburb: "Fitzroy",
      state: "VIC",
      postcode: "3065",
      phone: null,
      website: null,
      latitude: null,
      longitude: null,
    },
    mission: input.missionId ? {
      id: input.missionId,
      progressId: `progress-${input.missionId}`,
      expectedMissionUpdatedAt: MISSION_UPDATED_AT,
      expectedProgressUpdatedAt: ACCEPTED_AT,
      acceptedAfter: ACCEPTED_AFTER,
    } : null,
    items: [{
      id: `${input.id}:item:0`,
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draught",
      servingSize: "pint",
      price: 9.5,
      isHappyHourPrice: true,
      happyHourDetails: "Weekdays 5pm-7pm",
      isOnTap: "yes",
      confidence: 0.72,
      captureSource: "manual",
      sourceText: null,
      requiresCatalogApproval: false,
    }],
    safety: {
      internalOnly: true,
      publicationEligible: false,
      rewardEligible: false,
      pointsAwarded: 0,
    },
    now: NOW,
  };
}

async function insertManagerFixture(
  database: LoopbackPostgresTestDatabase,
  input: {
    accountId: string;
    assignmentId: string;
    venueId: string;
    evidenceId: string;
    extraVenueId?: string | undefined;
  },
): Promise<void> {
  await database.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (@id, @email, 'hash', 'local', 'venue_manager', 'free', 'active', @now, @now)`,
  ).run({ id: input.accountId, email: `${input.accountId}@example.test`, now: NOW });
  await database.prepare(
    `INSERT INTO venue_manager_assignments (
       id, user_id, venue_id, venue_name, suburb, access_level, status,
       approved_by, expires_at, created_at, updated_at
     ) VALUES (@id, @userId, @venueId, @venueName, 'Fitzroy', 'manager', 'active',
               NULL, NULL, @now, @now)`,
  ).run({
    id: input.assignmentId,
    userId: input.accountId,
    venueId: input.venueId,
    venueName: `Venue ${input.venueId}`,
    now: NOW,
  });
  if (input.extraVenueId) {
    await database.prepare(
      `INSERT INTO venue_manager_assignments (
         id, user_id, venue_id, venue_name, suburb, access_level, status,
         approved_by, expires_at, created_at, updated_at
       ) VALUES (@id, @userId, @venueId, @venueName, 'Fitzroy', 'manager', 'active',
                 NULL, NULL, @now, @now)`,
    ).run({
      id: `${input.assignmentId}-extra`,
      userId: input.accountId,
      venueId: input.extraVenueId,
      venueName: `Venue ${input.extraVenueId}`,
      now: NOW,
    });
  }
  await database.prepare(
    `INSERT INTO source_evidence_objects (
       id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
       data_base64, external_url, retention_expires_at, deleted_at, created_at
     ) VALUES (@id, @ownerUserId, 'sqlite_private', @objectPath, 'image/jpeg', 4,
               'dGVzdA==', NULL, @retentionExpiresAt, NULL, @createdAt)`,
  ).run({
    id: input.evidenceId,
    ownerUserId: input.accountId,
    objectPath: `evidence/${input.evidenceId}`,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
    createdAt: OBSERVED_AT,
  });
}

async function insertMissionFixture(
  database: LoopbackPostgresTestDatabase,
  missionId: string,
  managerAccountId: string,
  venueId: string,
): Promise<void> {
  await database.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
       active, sponsor_flag, last_verified_at, created_at, updated_at
     ) VALUES (@id, @venueId, @venueName, 'Fitzroy', 'Missing happy-hour details',
               'normal', 10, 1, @truth, @falsity, NULL, @updatedAt, @updatedAt)`,
  ).run({
    id: missionId,
    venueId,
    venueName: `Venue ${venueId}`,
    truth: true,
    falsity: false,
    updatedAt: MISSION_UPDATED_AT,
  });
  await database.prepare(
    `INSERT INTO mission_progress (
       id, mission_id, user_id, submission_id, status, accepted_at,
       submitted_at, completed_at, updated_at
     ) VALUES (@id, @missionId, @userId, NULL, 'accepted', @acceptedAt, NULL, NULL, @acceptedAt)`,
  ).run({
    id: `progress-${missionId}`,
    missionId,
    userId: managerAccountId,
    acceptedAt: ACCEPTED_AT,
  });
}

async function assertBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => "settled" as const, () => "settled" as const),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
  ]);
  expect(outcome).toBe("blocked");
}

describe.skipIf(!configuredAdminUrl)("VenueManagerInternalSubmissionRepository on restricted PostgreSQL 17", () => {
  let adminUrl: URL;
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: VenueManagerInternalSubmissionRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const identity = await admin.query<{ server_version_num: string; is_superuser: boolean }>(
      `SELECT current_setting('server_version_num') AS server_version_num,
              role.rolsuper AS is_superuser
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    );
    const serverVersion = Number(identity.rows[0]?.server_version_num ?? 0);
    if (serverVersion < 170_000 || serverVersion >= 180_000 || !identity.rows[0]?.is_superuser) {
      throw new Error("The internal venue-submission rehearsal requires a PostgreSQL 17 loopback superuser.");
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
    repository = new VenueManagerInternalSubmissionRepository(database);
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
      throw new Error("Internal venue-submission PG rehearsal left database or role residue.");
    }
  }, 30_000);

  it("proves restricted RLS, native types, one concurrent winner, and zero public effects", async () => {
    if (!database || !targetAdmin) throw new Error("PostgreSQL fixture was not initialized.");
    const role = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls",
              role.rolcreatedb AS "createDb", role.rolcreaterole AS "createRole",
              pg_catalog.pg_has_role(current_user, 'pintpath_runtime', 'member') AS "runtimeMember",
              pg_catalog.pg_has_role(current_user, 'pintpath_migrator', 'member') AS "migratorMember",
              pg_catalog.has_schema_privilege(current_user, 'pintpath_app', 'CREATE') AS "schemaCreate",
              pg_catalog.has_table_privilege(current_user, 'submissions', 'TRUNCATE') AS "tableTruncate"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<Record<string, boolean | string>>();
    expect(role).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
      createDb: false,
      createRole: false,
      runtimeMember: true,
      migratorMember: false,
      schemaCreate: false,
      tableTruncate: false,
    });
    const rls = await database.prepare(
      `SELECT class.relname AS "table", class.relrowsecurity AS "enabled",
              class.relforcerowsecurity AS "forced"
         FROM pg_catalog.pg_class class
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'pintpath_app'
          AND class.relname IN ('submissions', 'submission_items', 'submission_source_evidence')
        ORDER BY class.relname`,
    ).all<Array<{ table: string; enabled: boolean; forced: boolean }>[number]>();
    expect(rls).toEqual([
      { table: "submission_items", enabled: true, forced: true },
      { table: "submission_source_evidence", enabled: true, forced: true },
      { table: "submissions", enabled: true, forced: true },
    ]);

    await insertManagerFixture(database, {
      accountId: "pg-manager-create",
      assignmentId: "pg-assignment-create",
      venueId: "pg-venue-create",
      evidenceId: "pg-evidence-create",
    });
    const request = submissionInput({
      id: "pg-internal-create",
      clientSubmissionId: "pg-client-create-001",
      managerAccountId: "pg-manager-create",
      managerAssignmentId: "pg-assignment-create",
      venueId: "pg-venue-create",
      evidenceId: "pg-evidence-create",
    });
    const results = await Promise.all([
      repository.createInternalHappyHourSubmission(request),
      repository.createInternalHappyHourSubmission(request),
      repository.createInternalHappyHourSubmission(request),
    ]);
    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(2);
    expect(results[0]?.record.submission).toMatchObject({
      status: "pending",
      submissionType: "happy_hour_update",
      pointsAwarded: 0,
      pointsEligibleByLocation: false,
      internalOnly: true,
    });

    const native = await targetAdmin.query<{
      points_type: string;
      eligible_type: string;
      pending_type: string;
      observed_type: string;
      price_type: string;
      happy_type: string;
    }>(
      `SELECT pg_catalog.pg_typeof(submission.points_awarded)::text AS points_type,
              pg_catalog.pg_typeof(submission.points_eligible_by_location)::text AS eligible_type,
              pg_catalog.pg_typeof(submission.pending_venue_json)::text AS pending_type,
              pg_catalog.pg_typeof(submission.observed_at)::text AS observed_type,
              pg_catalog.pg_typeof(item.price)::text AS price_type,
              pg_catalog.pg_typeof(item.is_happy_hour_price)::text AS happy_type
         FROM pintpath_app.submissions submission
         JOIN pintpath_app.submission_items item ON item.submission_id = submission.id
        WHERE submission.id = 'pg-internal-create'`,
    );
    expect(native.rows[0]).toEqual({
      points_type: "numeric",
      eligible_type: "boolean",
      pending_type: "jsonb",
      observed_type: "timestamp with time zone",
      price_type: "numeric",
      happy_type: "boolean",
    });
    const publicEffects = await targetAdmin.query<{ prices: string; happy_hours: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM pintpath_app.venue_price_records WHERE source_submission_id = 'pg-internal-create') AS prices,
         (SELECT count(*)::text FROM pintpath_app.venue_happy_hours WHERE venue_id = 'pg-venue-create') AS happy_hours,
         (SELECT count(*)::text FROM pintpath_app.contribution_ledger WHERE submission_id = 'pg-internal-create') AS ledger`,
    );
    expect(publicEffects.rows[0]).toEqual({ prices: "0", happy_hours: "0", ledger: "0" });
  });

  it("serializes real assignment revocation, deletion, and mission-deactivation races", async () => {
    if (!database) throw new Error("PostgreSQL fixture was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, auth_provider, role, subscription_status,
         status, created_at, updated_at
       ) VALUES ('pg-admin-races', 'pg-admin-races@example.test', 'hash', 'local',
                 'admin', 'admin', 'active', @now, @now)`,
    ).run({ now: NOW });

    await insertManagerFixture(database, {
      accountId: "pg-manager-revoke",
      assignmentId: "pg-assignment-revoke",
      venueId: "pg-venue-revoke",
      evidenceId: "pg-evidence-revoke",
      extraVenueId: "pg-venue-revoke-extra",
    });
    const revokeDatabase = new PauseAfterSqlDatabase(
      database,
      /UPDATE\s+venue_manager_assignments[\s\S]*SET\s+status\s*=\s*'revoked'/i,
    );
    const revoke = new VenueAccessRepository(revokeDatabase).revokeVenueAssignment({
      actorAccountId: "pg-admin-races",
      userId: "pg-manager-revoke",
      venueId: "pg-venue-revoke",
      expectedAccessLevel: "manager",
      now: LATER,
    });
    await revokeDatabase.waitUntilPaused();
    const revokeSubmission = repository.createInternalHappyHourSubmission(submissionInput({
      id: "pg-internal-revoke",
      clientSubmissionId: "pg-client-revoke-001",
      managerAccountId: "pg-manager-revoke",
      managerAssignmentId: "pg-assignment-revoke",
      venueId: "pg-venue-revoke",
      evidenceId: "pg-evidence-revoke",
    }));
    await assertBlocked(revokeSubmission);
    revokeDatabase.release();
    await expect(revoke).resolves.toMatchObject({ outcome: "revoked" });
    await expect(revokeSubmission).rejects.toSatisfy(expectCode("assignment_not_active"));

    await insertManagerFixture(database, {
      accountId: "pg-manager-delete",
      assignmentId: "pg-assignment-delete",
      venueId: "pg-venue-delete",
      evidenceId: "pg-evidence-delete",
    });
    const deletionRepository = new AccountDeletionQueueRepository(database);
    await deletionRepository.createAccountDeletionRequest({
      id: "pg-delete-request",
      userId: "pg-manager-delete",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: RETENTION_EXPIRES_AT,
    });
    const deletionDatabase = new PauseAfterSqlDatabase(
      database,
      /UPDATE\s+account_deletion_requests[\s\S]*SET\s+status\s*=\s*'processing'[\s\S]*RETURNING/i,
    );
    const beginDeletion = new AccountDeletionQueueRepository(deletionDatabase).beginAccountDeletion({
      requestId: "pg-delete-request",
      reviewedBy: "pg-admin-races",
      now: LATER,
      staleBefore: NOW,
    });
    await deletionDatabase.waitUntilPaused();
    const deletionSubmission = repository.createInternalHappyHourSubmission(submissionInput({
      id: "pg-internal-delete",
      clientSubmissionId: "pg-client-delete-001",
      managerAccountId: "pg-manager-delete",
      managerAssignmentId: "pg-assignment-delete",
      venueId: "pg-venue-delete",
      evidenceId: "pg-evidence-delete",
    }));
    await assertBlocked(deletionSubmission);
    deletionDatabase.release();
    await expect(beginDeletion).resolves.toMatchObject({ status: "processing" });
    await expect(deletionSubmission).rejects.toSatisfy(expectCode("deletion_locked"));

    await insertManagerFixture(database, {
      accountId: "pg-manager-mission",
      assignmentId: "pg-assignment-mission",
      venueId: "pg-venue-mission",
      evidenceId: "pg-evidence-mission",
    });
    await insertMissionFixture(database, "pg-mission-race", "pg-manager-mission", "pg-venue-mission");
    const missionDatabase = new PauseAfterSqlDatabase(
      database,
      /UPDATE\s+missions\s+SET\s+active/i,
    );
    const deactivate = new MissionLifecycleRepository(missionDatabase).setMissionActive({
      missionId: "pg-mission-race",
      active: false,
      expectedUpdatedAt: MISSION_UPDATED_AT,
      now: LATER,
    });
    await missionDatabase.waitUntilPaused();
    const missionSubmission = repository.createInternalHappyHourSubmission(submissionInput({
      id: "pg-internal-mission",
      clientSubmissionId: "pg-client-mission-001",
      managerAccountId: "pg-manager-mission",
      managerAssignmentId: "pg-assignment-mission",
      venueId: "pg-venue-mission",
      evidenceId: "pg-evidence-mission",
      missionId: "pg-mission-race",
    }));
    await assertBlocked(missionSubmission);
    missionDatabase.release();
    await expect(deactivate).resolves.toMatchObject({ active: false });
    await expect(missionSubmission).rejects.toSatisfy(expectCode("mission_inactive"));

    const count = await database.prepare(
      `SELECT count(*)::text AS "count" FROM submissions
        WHERE id IN ('pg-internal-revoke', 'pg-internal-delete', 'pg-internal-mission')`,
    ).get<{ count: string }>();
    expect(count).toEqual({ count: "0" });
  });

  it("rolls back every major write and hides native database details", async () => {
    if (!database) throw new Error("PostgreSQL fixture was not initialized.");
    await insertManagerFixture(database, {
      accountId: "pg-manager-rollback",
      assignmentId: "pg-assignment-rollback",
      venueId: "pg-venue-rollback",
      evidenceId: "pg-evidence-rollback",
    });
    await insertMissionFixture(database, "pg-mission-rollback", "pg-manager-rollback", "pg-venue-rollback");
    const request = submissionInput({
      id: "pg-internal-rollback",
      clientSubmissionId: "pg-client-rollback-001",
      managerAccountId: "pg-manager-rollback",
      managerAssignmentId: "pg-assignment-rollback",
      venueId: "pg-venue-rollback",
      evidenceId: "pg-evidence-rollback",
      missionId: "pg-mission-rollback",
    });
    const faulted = new VenueManagerInternalSubmissionRepository(new ItemInsertFaultDatabase(database));
    const failure = await faulted.createInternalHappyHourSubmission(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VenueManagerInternalSubmissionRepositoryError);
    expect(failure).toMatchObject({ code: "persistence_failure" });
    expect((failure as Error).message).not.toContain("PostgreSQL internal detail");
    const state = await database.prepare(
      `SELECT
         (SELECT count(*)::text FROM submissions WHERE id = 'pg-internal-rollback') AS "submissions",
         (SELECT count(*)::text FROM submission_items WHERE submission_id = 'pg-internal-rollback') AS "items",
         (SELECT count(*)::text FROM submission_source_evidence WHERE submission_id = 'pg-internal-rollback') AS "links",
         (SELECT status FROM mission_progress WHERE id = 'progress-pg-mission-rollback') AS "missionStatus",
         (SELECT submission_id FROM mission_progress WHERE id = 'progress-pg-mission-rollback') AS "missionSubmissionId"`,
    ).get<Record<string, string | null>>();
    expect(state).toEqual({
      submissions: "0",
      items: "0",
      links: "0",
      missionStatus: "accepted",
      missionSubmissionId: null,
    });
    await expect(repository.createInternalHappyHourSubmission(request))
      .resolves.toMatchObject({ outcome: "created" });
  });
});
