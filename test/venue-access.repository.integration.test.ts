import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  VenueAccessRepository,
  VenueAccessRepositoryError,
} from "../src/db/venue-access.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_VENUE_ACCESS_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_venue_access_integration_test";
const TEST_LOGIN = "pintpath_venue_access_integration_login";
const NOW = "2026-08-08T12:00:00.000Z";
const LATER = "2026-08-08T12:05:00.000Z";
const EXPIRES_AT = "2026-08-11T12:00:00.000Z";
const AFTER_EXPIRY = "2026-08-11T12:01:00.000Z";
const REINVITE_EXPIRES_AT = "2026-08-14T12:01:00.000Z";

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
  ) throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
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
        const savepoint = `venue_access_nested_${active.nextSavepoint++}`;
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

class ReviewFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  failNextReview = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (this.failNextReview && /UPDATE\s+venue_claim_requests[\s\S]*reviewed_by/i.test(sql)) {
          this.failNextReview = false;
          throw new Error("injected PostgreSQL review failure");
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
    // The owning fixture closes the shared delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

class PausedDeletionTransitionDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private pauseEnabled = false;
  private paused = false;
  private readonly transitionStarted: Promise<void>;
  private transitionStartedResolve!: () => void;
  private readonly releaseTransition: Promise<void>;
  private releaseTransitionResolve!: () => void;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {
    this.transitionStarted = new Promise((resolve) => { this.transitionStartedResolve = resolve; });
    this.releaseTransition = new Promise((resolve) => { this.releaseTransitionResolve = resolve; });
  }

  enablePause(): void {
    this.pauseEnabled = true;
  }

  waitUntilTransitionIsHoldingLocks(): Promise<void> {
    return this.transitionStarted;
  }

  release(): void {
    this.releaseTransitionResolve();
  }

  private async pauseAfterProcessingTransition<Result>(sql: string, result: Result): Promise<Result> {
    if (
      this.pauseEnabled
      && !this.paused
      && /UPDATE\s+account_deletion_requests[\s\S]*SET status = 'processing'/i.test(sql)
      && result
    ) {
      this.paused = true;
      this.transitionStartedResolve();
      await this.releaseTransition;
    }
    return result;
  }

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => statement.run(...bindings),
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => this.pauseAfterProcessingTransition(
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
    // The owning fixture closes the shared delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

function expectCode(code: VenueAccessRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof VenueAccessRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("real restricted PG17 venue access repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: VenueAccessRepository;
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
    database = new LoopbackPostgresTestDatabase(withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password));
    repository = new VenueAccessRepository(database);
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
        throw new Error("Venue access PG rehearsal left database or role residue.");
      }
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves restricted-role claim/review contention and native PG result shapes", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    const runtime = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls",
              has_table_privilege(current_user, 'venue_claim_requests', 'SELECT,INSERT,UPDATE,DELETE') AS "claimCrud",
              has_table_privilege(current_user, 'venue_claim_requests', 'TRUNCATE') AS "claimTruncate",
              jsonb_build_object('scope', 'venue-access') AS "metadata"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<{
      serverVersionNum: string;
      superuser: boolean;
      bypassRls: boolean;
      claimCrud: boolean;
      claimTruncate: boolean;
      metadata: Record<string, unknown>;
    }>();
    expect(runtime).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
      claimCrud: true,
      claimTruncate: false,
      metadata: { scope: "venue-access" },
    });
    await expect(database.exec("TRUNCATE TABLE venue_claim_requests")).rejects.toThrow();
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES
         ('pg-admin', 'pg-admin@example.test', 'hash', 'admin', 'admin', 'active', @now, @now),
         ('pg-claimant', 'pg-claimant@example.test', 'hash', 'user', 'free', 'active', @now, @now)`,
    ).run({ now: NOW });

    const claims = await Promise.all([
      repository.createVenueClaim({
        id: "pg-claim-a", userId: "pg-claimant", venueId: "pg-venue", venueName: "PG Venue",
        address: "1 PG Street", suburb: "Carlton", requesterName: "PG Claimant", requesterRole: "Owner",
        contactEmail: "pg-claimant@example.test", contactPhone: null, message: "First", now: NOW,
      }),
      repository.createVenueClaim({
        id: "pg-claim-b", userId: "pg-claimant", venueId: "pg-venue", venueName: "PG Venue",
        address: "1 PG Street", suburb: "Carlton", requesterName: "PG Claimant", requesterRole: "Owner",
        contactEmail: "pg-claimant@example.test", contactPhone: null, message: "Retry", now: NOW,
      }),
    ]);
    expect(claims.map((result) => result.outcome).sort()).toEqual(["created", "existing"]);
    expect(new Set(claims.map((result) => result.claim.id)).size).toBe(1);
    expect(claims[0]!.claim.createdAt).toBe(NOW);

    await database.prepare(
      `INSERT INTO venue_claim_requests (
         id, user_id, venue_id, venue_name, requester_name, requester_role,
         contact_email, status, created_at, updated_at
       ) VALUES
         ('pg-page-a', 'pg-claimant', 'pg-page-a', 'PG Page A', 'Claimant', 'Owner',
          'pg-claimant@example.test', 'pending', @later, @later),
         ('pg-page-b', 'pg-claimant', 'pg-page-b', 'PG Page B', 'Claimant', 'Owner',
          'pg-claimant@example.test', 'pending', @later, @later)`,
    ).run({ later: LATER });
    const claimPageOne = await repository.listVenueClaims({ userId: "pg-claimant", limit: 2 });
    const claimPageTwo = await repository.listVenueClaims({
      userId: "pg-claimant", limit: 2, cursor: claimPageOne.nextCursor,
    });
    expect(claimPageOne.claims.map((item) => item.id)).toEqual(["pg-page-b", "pg-page-a"]);
    expect(claimPageTwo.claims.map((item) => item.id)).toEqual([claims[0]!.claim.id]);
    expect(new Set([...claimPageOne.claims, ...claimPageTwo.claims].map((item) => item.id)).size).toBe(3);

    const claim = claims[0]!.claim;
    const reviews = await Promise.allSettled([
      repository.reviewVenueClaimAndAssignManager({
        claimId: claim.id, reviewerAccountId: "pg-admin", decision: "approved",
        reviewNote: "Verified", expectedUpdatedAt: claim.updatedAt,
        assignmentId: "pg-manager-assignment", now: LATER,
      }),
      repository.reviewVenueClaimAndAssignManager({
        claimId: claim.id, reviewerAccountId: "pg-admin", decision: "rejected",
        reviewNote: "Competing", expectedUpdatedAt: claim.updatedAt, assignmentId: null, now: LATER,
      }),
    ]);
    expect(reviews.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(reviews.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const native = await database.prepare(
      `SELECT claim.created_at AS "createdAt", (claim.status = 'approved') AS "approved"
         FROM venue_claim_requests claim WHERE claim.id = ?`,
    ).get<{ createdAt: string; approved: boolean }>(claim.id);
    expect(native).toEqual({ createdAt: NOW, approved: expect.any(Boolean) });
    expect(await repository.countVenueClaims()).toBe(3);
    expect(await repository.countVenueClaims({ status: "pending" })).toBe(2);
    expect(await repository.countVenueAssignments({ currentOnly: true })).toBe(native!.approved ? 1 : 0);
    expect(await repository.listActiveAssignedVenueIds({
      venueIds: ["pg-page-b", "pg-venue", "pg-venue", "missing-venue"],
    })).toEqual(native!.approved ? ["pg-venue"] : []);
    await expect(database.prepare(
      `SELECT pg_typeof(count(*))::text AS "countType" FROM venue_claim_requests`,
    ).get<{ countType: string }>()).resolves.toEqual({ countType: "bigint" });
  });

  it("fences invitation generations, deletion state, and PostgreSQL rollback", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES
         ('pg-manager', 'pg-manager@example.test', 'hash', 'user', 'free', 'active', @now, @now),
         ('pg-staff', 'pg-staff@example.test', 'hash', 'user', 'free', 'active', @now, @now),
         ('pg-locked', 'pg-locked@example.test', 'hash', 'user', 'free', 'active', @now, @now),
         ('pg-rollback', 'pg-rollback@example.test', 'hash', 'user', 'free', 'active', @now, @now)`,
    ).run({ now: NOW });
    await repository.assignVenueManager({
      assignmentId: "pg-manager-access", adminAccountId: "pg-admin", userId: "pg-manager",
      venueId: "pg-counter-venue", venueName: "PG Counter Venue", suburb: "Carlton", now: NOW,
    });
    const invitationAttempts = await Promise.allSettled([
      repository.inviteCounterStaff({
        invitationToken: token("pg-invite-a"), inviterAccountId: "pg-manager", userId: "pg-staff",
        venueId: "pg-counter-venue", venueName: "PG Counter Venue", suburb: "Carlton",
        now: NOW, expiresAt: EXPIRES_AT,
      }),
      repository.inviteCounterStaff({
        invitationToken: token("pg-invite-b"), inviterAccountId: "pg-manager", userId: "pg-staff",
        venueId: "pg-counter-venue", venueName: "PG Counter Venue", suburb: "Carlton",
        now: NOW, expiresAt: EXPIRES_AT,
      }),
    ]);
    expect(invitationAttempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(invitationAttempts.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const first = await repository.getVenueAssignment({ userId: "pg-staff", venueId: "pg-counter-venue" });
    if (!first) throw new Error("Expected the winning invitation.");
    const assignmentPageOne = await repository.listVenueAssignments({ venueId: "pg-counter-venue", limit: 1 });
    const assignmentPageTwo = await repository.listVenueAssignments({
      venueId: "pg-counter-venue", limit: 1, cursor: assignmentPageOne.nextCursor,
    });
    expect(assignmentPageOne.assignments).toHaveLength(1);
    expect(assignmentPageTwo.assignments).toHaveLength(1);
    expect(assignmentPageOne.assignments[0]!.id).not.toBe(assignmentPageTwo.assignments[0]!.id);
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: first.id, userId: "pg-staff", decision: "accept", now: EXPIRES_AT,
    })).rejects.toSatisfy(expectCode("invitation_expired"));
    const replacement = await repository.inviteCounterStaff({
      invitationToken: token("pg-replacement"), inviterAccountId: "pg-manager", userId: "pg-staff",
      venueId: "pg-counter-venue", venueName: "PG Counter Venue", suburb: "Carlton",
      now: AFTER_EXPIRY, expiresAt: REINVITE_EXPIRES_AT,
    });
    expect(replacement.assignment.id).not.toBe(first.id);
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: first.id, userId: "pg-staff", decision: "accept", now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("invitation_not_found"));

    await database.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('delete-pg-locked', 'pg-locked', 'processing', @now, @expiresAt, @now, @now)`,
    ).run({ now: NOW, expiresAt: EXPIRES_AT });
    await expect(repository.createVenueClaim({
      id: "pg-locked-claim", userId: "pg-locked", venueId: "pg-venue", venueName: "PG Venue",
      address: null, suburb: null, requesterName: "Locked", requesterRole: "Owner",
      contactEmail: "pg-locked@example.test", contactPhone: null, message: null, now: NOW,
    })).rejects.toSatisfy(expectCode("deletion_locked"));

    const rollbackClaim = await repository.createVenueClaim({
      id: "pg-rollback-claim", userId: "pg-rollback", venueId: "pg-rollback-venue",
      venueName: "PG Rollback Venue", address: null, suburb: null, requesterName: "Rollback",
      requesterRole: "Owner", contactEmail: "pg-rollback@example.test", contactPhone: null,
      message: null, now: NOW,
    });
    const faultRepository = new VenueAccessRepository(new ReviewFaultDatabase(database));
    await expect(faultRepository.reviewVenueClaimAndAssignManager({
      claimId: rollbackClaim.claim.id, reviewerAccountId: "pg-admin", decision: "approved",
      reviewNote: "Will roll back", expectedUpdatedAt: rollbackClaim.claim.updatedAt,
      assignmentId: "pg-rollback-assignment", now: LATER,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getVenueClaim(rollbackClaim.claim.id)).resolves.toMatchObject({ status: "pending" });
    await expect(repository.getVenueAssignment({ userId: "pg-rollback", venueId: "pg-rollback-venue" }))
      .resolves.toBeNull();
  });

  it("serializes a deletion transition ahead of venue access on the shared account lock", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES ('pg-deletion-race', 'pg-deletion-race@example.test', 'hash', 'user', 'free', 'active', @now, @now)`,
    ).run({ now: NOW });

    const pausedDatabase = new PausedDeletionTransitionDatabase(database);
    const deletionRepository = new AccountDeletionQueueRepository(pausedDatabase);
    await deletionRepository.createAccountDeletionRequest({
      id: "pg-deletion-race-request",
      userId: "pg-deletion-race",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: EXPIRES_AT,
    });
    pausedDatabase.enablePause();
    const deletionAttempt = deletionRepository.beginAccountDeletion({
      requestId: "pg-deletion-race-request",
      reviewedBy: "pg-admin",
      now: LATER,
      staleBefore: NOW,
    });
    await pausedDatabase.waitUntilTransitionIsHoldingLocks();

    let claimSettled = false;
    const claimAttempt = repository.createVenueClaim({
      id: "pg-deletion-race-claim",
      userId: "pg-deletion-race",
      venueId: "pg-deletion-race-venue",
      venueName: "PG Deletion Race Venue",
      address: null,
      suburb: null,
      requesterName: "Deletion Race",
      requesterRole: "Owner",
      contactEmail: "pg-deletion-race@example.test",
      contactPhone: null,
      message: null,
      now: LATER,
    });
    void claimAttempt.then(
      () => { claimSettled = true; },
      () => { claimSettled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(claimSettled).toBe(false);

    pausedDatabase.release();
    await expect(deletionAttempt).resolves.toMatchObject({ status: "processing" });
    await expect(claimAttempt).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.getVenueClaim("pg-deletion-race-claim")).resolves.toBeNull();
  });
});
