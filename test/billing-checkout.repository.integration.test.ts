import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BillingCheckoutRepository,
  BillingCheckoutRepositoryError,
} from "../src/db/billing-checkout.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import { venueAccessAccountLockKey } from "../src/db/venue-access.repository.js";

const ADMIN_URL_ENV = "PINTPATH_BILLING_CHECKOUT_POSTGRES_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_billing_checkout_integration_test";
const TEST_LOGIN = "pintpath_billing_checkout_integration_login";
const NOW = "2026-08-08T14:00:00.000Z";
const LATER = "2026-08-08T14:05:00.000Z";
const EXPIRES_AT = "2026-08-08T14:35:00.000Z";
const AFTER_EXPIRY = "2026-08-08T14:40:00.000Z";
const RETRY_EXPIRES_AT = "2026-08-08T15:15:00.000Z";

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
        const savepoint = `billing_checkout_nested_${active.nextSavepoint++}`;
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

/** Injects one failure after PostgreSQL accepts the finalize UPDATE. */
class FinalizeWriteFaultDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  failNextFinalize = true;

  constructor(private readonly delegate: LoopbackPostgresTestDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (
          this.failNextFinalize
          && /UPDATE\s+billing_checkout_reservations[\s\S]*stripe_checkout_session_id\s*=\s*@stripeCheckoutSessionId/i.test(sql)
        ) {
          this.failNextFinalize = false;
          throw new Error("injected PostgreSQL finalize failure");
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

/** Pauses one real deletion transition after its guarded UPDATE but before commit. */
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

function expectCode(code: BillingCheckoutRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof BillingCheckoutRepositoryError && error.code === code;
}

describe.skipIf(!configuredAdminUrl)("real restricted PG17 billing checkout repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: BillingCheckoutRepository;
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
    repository = new BillingCheckoutRepository(database);
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
        throw new Error("Billing checkout PG rehearsal left database or role residue.");
      }
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("proves restricted-role contention, canonical venue locks, and native bool/time/jsonb shapes", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    const runtime = await database.prepare(
      `SELECT current_setting('server_version_num') AS "serverVersionNum",
              role.rolsuper AS "superuser", role.rolbypassrls AS "bypassRls"
         FROM pg_catalog.pg_roles role WHERE role.rolname = current_user`,
    ).get<{ serverVersionNum: string; superuser: boolean; bypassRls: boolean }>();
    expect(runtime).toEqual({
      serverVersionNum: expect.stringMatching(/^17\d{4}$/),
      superuser: false,
      bypassRls: false,
    });
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES (
         'pg-manager', 'pg-manager@example.test', 'hash', 'bar_manager', 'free', @now, @now
       )`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, opening_hours_json, intro_trial_ever_claimed, created_at, updated_at
       ) VALUES
         ('pg-venue', 'PG Venue', @openingHours, FALSE, @now, @now),
         ('pg-alias', 'PG Alias', @openingHours, FALSE, @now, @now)`,
    ).run({ now: NOW, openingHours: JSON.stringify({ mon: ["12:00-22:00"] }) });
    await database.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES ('pg-alias', 'pg-venue', 'pg-identity', 'test', @now, @now)`,
    ).run({ now: NOW });

    const claims = await Promise.all([
      repository.claimBillingCheckoutReservation({
        actorAccountId: "pg-manager",
        subjectType: "venue",
        subjectId: "pg-alias",
        productKey: "venue:pro:trial:30",
        reservationToken: token("pg-winner-a"),
        expiresAt: EXPIRES_AT,
        now: NOW,
      }),
      repository.claimBillingCheckoutReservation({
        actorAccountId: "pg-manager",
        subjectType: "venue",
        subjectId: "pg-venue",
        productKey: "venue:pro:trial:60",
        reservationToken: token("pg-winner-b"),
        expiresAt: EXPIRES_AT,
        now: NOW,
      }),
    ]);
    expect(new Set(claims.map((claim) => claim.reservationToken)).size).toBe(1);
    expect(claims[0]).toMatchObject({ subjectId: "pg-venue", status: "reserved", expired: false });

    const finalized = await repository.finalizeBillingCheckoutReservation({
      actorAccountId: "pg-manager",
      subjectType: "venue",
      subjectId: "pg-alias",
      reservationToken: claims[0]!.reservationToken,
      stripeCheckoutSessionId: "cs_pg_venue",
      checkoutUrl: "https://checkout.example.test/pg-venue",
      now: LATER,
    });
    expect(finalized).toMatchObject({ subjectId: "pg-venue", status: "finalized", updatedAt: LATER });

    const marks = await Promise.all([
      repository.markVenueIntroTrialEverClaimed({ actorAccountId: "pg-manager", venueId: "pg-alias", now: LATER }),
      repository.markVenueIntroTrialEverClaimed({ actorAccountId: "pg-manager", venueId: "pg-venue", now: LATER }),
    ]);
    expect(marks.map((mark) => mark.outcome).sort()).toEqual(["already_claimed", "marked"]);
    expect(marks.reduce((sum, mark) => sum + mark.updatedProfiles, 0)).toBe(2);
    await expect(repository.hasVenueIntroTrialEverClaimed({ venueId: "pg-alias", asOf: LATER })).resolves.toBe(true);

    const nativeRows = await database.prepare(
      `SELECT reservation.expires_at AS "expiresAt",
              venue.intro_trial_ever_claimed AS "trialClaimed",
              venue.opening_hours_json AS "openingHours"
         FROM billing_checkout_reservations reservation
         JOIN venue_profiles venue ON venue.venue_id = reservation.subject_id
        WHERE reservation.subject_type = 'venue' AND reservation.subject_id = 'pg-venue'`,
    ).all<{ expiresAt: string; trialClaimed: boolean; openingHours: Record<string, unknown> }>();
    expect(nativeRows).toEqual([{
      expiresAt: EXPIRES_AT,
      trialClaimed: true,
      openingHours: { mon: ["12:00-22:00"] },
    }]);
  });

  it("preserves expired state after a unique-token rollback and enforces deletion locks", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES
         ('pg-retry-a', 'pg-retry-a@example.test', 'hash', 'user', 'free', @now, @now),
         ('pg-retry-b', 'pg-retry-b@example.test', 'hash', 'user', 'free', @now, @now),
         ('pg-locked', 'pg-locked@example.test', 'hash', 'user', 'free', @now, @now)`,
    ).run({ now: NOW });
    await repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      productKey: "consumer:monthly",
      reservationToken: token("pg-original"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      reservationToken: token("pg-original"),
      stripeCheckoutSessionId: "cs_pg_expired",
      checkoutUrl: "https://checkout.example.test/pg-expired",
      now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("reservation_expired"));
    await repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-retry-b",
      subjectType: "consumer",
      subjectId: "pg-retry-b",
      productKey: "consumer:monthly",
      reservationToken: token("pg-owned"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    });
    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      productKey: "consumer:yearly",
      reservationToken: token("pg-owned"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("reservation_token_conflict"));
    await expect(repository.getBillingCheckoutReservation({
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      asOf: AFTER_EXPIRY,
    })).resolves.toMatchObject({
      reservationToken: token("pg-original"),
      productKey: "consumer:monthly",
      expired: true,
    });
    const retried = await repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      productKey: "consumer:yearly",
      reservationToken: token("pg-retried"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    });
    expect(retried).toMatchObject({
      reservationToken: token("pg-retried"),
      productKey: "consumer:yearly",
      status: "reserved",
    });

    const faultDatabase = new FinalizeWriteFaultDatabase(database);
    const faultRepository = new BillingCheckoutRepository(faultDatabase);
    await expect(faultRepository.finalizeBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      reservationToken: retried.reservationToken,
      stripeCheckoutSessionId: "cs_pg_retry",
      checkoutUrl: "https://checkout.example.test/pg-retry",
      now: "2026-08-08T14:45:00.000Z",
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getBillingCheckoutReservation({
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      asOf: "2026-08-08T14:45:00.000Z",
    })).resolves.toMatchObject({ status: "reserved", checkoutUrl: null });
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "pg-retry-a",
      subjectType: "consumer",
      subjectId: "pg-retry-a",
      reservationToken: retried.reservationToken,
      stripeCheckoutSessionId: "cs_pg_retry",
      checkoutUrl: "https://checkout.example.test/pg-retry",
      now: "2026-08-08T14:45:00.000Z",
    })).resolves.toMatchObject({ status: "finalized" });

    await database.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('delete-pg-locked', 'pg-locked', 'processing', @now, @expiresAt, @now, @now)`,
    ).run({ now: NOW, expiresAt: EXPIRES_AT });
    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-locked",
      subjectType: "consumer",
      subjectId: "pg-locked",
      productKey: "consumer:monthly",
      reservationToken: token("pg-locked"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    const lockedRow = await database.prepare(
      "SELECT count(*)::text AS \"count\" FROM billing_checkout_reservations WHERE subject_id = 'pg-locked'",
    ).get<{ count: string }>();
    expect(lockedRow).toEqual({ count: "0" });
  });

  it("serializes real deletion transitions with both checkout and venue-access account fences", async () => {
    if (!database) throw new Error("Postgres test database was not initialized.");
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, created_at, updated_at
       ) VALUES
         ('pg-cross-repository-lock', 'pg-cross-repository-lock@example.test', 'hash', 'user', 'free', @now, @now),
         ('pg-venue-access-lock', 'pg-venue-access-lock@example.test', 'hash', 'user', 'free', @now, @now)`,
    ).run({ now: NOW });

    const deletionQueue = new AccountDeletionQueueRepository(database);
    await deletionQueue.createAccountDeletionRequest({
      id: "pg-cross-repository-request",
      userId: "pg-cross-repository-lock",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: LATER,
    });

    const pausedDatabase = new PauseAfterDeletionBeginDatabase(database);
    const pausedQueue = new AccountDeletionQueueRepository(pausedDatabase);
    const begin = pausedQueue.beginAccountDeletion({
      requestId: "pg-cross-repository-request",
      reviewedBy: "pg-cross-repository-lock",
      now: LATER,
      staleBefore: NOW,
    });
    await pausedDatabase.waitUntilPaused();

    let checkoutSettled = false;
    const checkout = repository.claimBillingCheckoutReservation({
      actorAccountId: "pg-cross-repository-lock",
      subjectType: "consumer",
      subjectId: "pg-cross-repository-lock",
      productKey: "consumer:monthly",
      reservationToken: token("pg-cross-repository-token"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    }).then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    ).finally(() => {
      checkoutSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(checkoutSettled).toBe(false);

    pausedDatabase.release();
    await expect(begin).resolves.toMatchObject({ status: "processing" });
    const checkoutResult = await checkout;
    expect(checkoutResult.value).toBeNull();
    expect(checkoutResult.error).toSatisfy(expectCode("deletion_locked"));
    expect(await database.prepare(
      `SELECT count(*)::integer AS "count"
         FROM billing_checkout_reservations
        WHERE subject_type = 'consumer' AND subject_id = 'pg-cross-repository-lock'`,
    ).get<{ count: number }>()).toEqual({ count: 0 });

    let venueFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => {
      venueFenceHeld = resolve;
    });
    let releaseVenueFence!: () => void;
    const venueFenceGate = new Promise<void>((resolve) => {
      releaseVenueFence = resolve;
    });
    const heldFence = database.transaction(async () => {
      await database!.prepare(
        "SELECT pg_advisory_xact_lock(hashtext(?)) AS \"locked\"",
      ).get(venueAccessAccountLockKey("pg-venue-access-lock"));
      venueFenceHeld();
      await venueFenceGate;
    })();
    await fenceHeld;

    let creationSettled = false;
    const creation = deletionQueue.createAccountDeletionRequest({
      id: "pg-venue-access-request",
      userId: "pg-venue-access-lock",
      userMessage: null,
      requestedAt: NOW,
      executeAfter: LATER,
    }).finally(() => {
      creationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(creationSettled).toBe(false);
    releaseVenueFence();
    await heldFence;
    await expect(creation).resolves.toMatchObject({
      id: "pg-venue-access-request",
      status: "pending_review",
    });
  }, 30_000);
});
