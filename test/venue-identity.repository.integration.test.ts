import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import {
  VenueIdentityRepository,
  billingCheckoutVenueSubjectLockKey,
  type VenueIdentityRepositoryError,
} from "../src/db/venue-identity.repository.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_venue_identity_integration_test";
const TEST_LOGIN = "pintpath_venue_identity_integration_login";
const TEST_PASSWORD = "venue-identity-test-password";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const BASE_TIME = "2026-08-08T00:00:00.000Z";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";
const MINUTE_2 = "2026-08-08T00:02:00.000Z";

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

function rejectedCode(results: PromiseSettledResult<unknown>[]): string | undefined {
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  return (rejected?.reason as VenueIdentityRepositoryError | undefined)?.code;
}

describe.skipIf(!configuredAdminUrl)("venue identity repository on real PostgreSQL 17", () => {
  let admin: Client | null = null;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let restrictedUrl = "";
  let repository: VenueIdentityRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = Number((await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    )).rows[0]?.version);
    if (version < 170000 || version >= 180000) {
      throw new Error(`Venue identity integration requires PostgreSQL 17; received ${version}.`);
    }
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${TEST_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`CREATE DATABASE ${TEST_DATABASE} WITH TEMPLATE template0 ENCODING 'UTF8'`);
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_LOGIN}`);

    const targetUrl = withDatabase(adminUrl, TEST_DATABASE);
    targetAdmin = new Client({ connectionString: targetUrl });
    await targetAdmin.connect();
    await targetAdmin.query(`
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA pintpath_app AUTHORIZATION postgres;
      REVOKE ALL ON SCHEMA pintpath_app FROM PUBLIC;

      CREATE TABLE pintpath_app.venue_identity_aliases (
        alias_venue_id text PRIMARY KEY,
        canonical_venue_id text NOT NULL,
        identity_key text NOT NULL,
        source text NOT NULL DEFAULT 'automatic_exact_match',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX venue_identity_aliases_canonical
        ON pintpath_app.venue_identity_aliases (canonical_venue_id, updated_at DESC);

      CREATE TABLE pintpath_app.venue_location_cache (
        venue_id text PRIMARY KEY,
        venue_name text NOT NULL,
        suburb text,
        latitude double precision,
        longitude double precision,
        updated_at timestamptz NOT NULL
      );

      ALTER TABLE pintpath_app.venue_identity_aliases ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_identity_aliases FORCE ROW LEVEL SECURITY;
      CREATE POLICY venue_identity_runtime ON pintpath_app.venue_identity_aliases
        FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);
      ALTER TABLE pintpath_app.venue_location_cache ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pintpath_app.venue_location_cache FORCE ROW LEVEL SECURITY;
      CREATE POLICY venue_location_runtime ON pintpath_app.venue_location_cache
        FOR ALL TO ${TEST_LOGIN} USING (true) WITH CHECK (true);

      GRANT USAGE ON SCHEMA pintpath_app TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.venue_identity_aliases TO ${TEST_LOGIN};
      GRANT SELECT, INSERT, UPDATE ON pintpath_app.venue_location_cache TO ${TEST_LOGIN};

      CREATE FUNCTION pintpath_app.reject_identity_location_test()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, pintpath_app AS $$
      BEGIN
        IF NEW.venue_name = 'ROLLBACK TEST' THEN
          RAISE EXCEPTION 'forced location rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      REVOKE ALL ON FUNCTION pintpath_app.reject_identity_location_test() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pintpath_app.reject_identity_location_test() TO ${TEST_LOGIN};
      CREATE TRIGGER reject_identity_location
        BEFORE INSERT OR UPDATE ON pintpath_app.venue_location_cache
        FOR EACH ROW EXECUTE FUNCTION pintpath_app.reject_identity_location_test();
    `);

    restrictedUrl = withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, TEST_PASSWORD);
    database = new LoopbackPostgresTestDatabase(restrictedUrl);
    repository = new VenueIdentityRepository(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      const cleanup = await admin.query<{ databases: string; roles: string }>(
        `SELECT
           (SELECT count(*)::text FROM pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::text FROM pg_roles WHERE rolname = $2) AS roles`,
        [TEST_DATABASE, TEST_LOGIN],
      );
      if (cleanup.rows[0]?.databases !== "0" || cleanup.rows[0]?.roles !== "0") {
        throw new Error("Venue identity PostgreSQL integration cleanup was not exact.");
      }
      await admin.end().catch(() => undefined);
    }
  });

  it("shares old/new Billing subject fences and gives first-alias/re-home races one winner", async () => {
    const blocker = new Client({ connectionString: restrictedUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      billingCheckoutVenueSubjectLockKey("fenced-alias"),
    ]);
    let settled = false;
    const fencedInsert = repository.upsertVenueIdentityAlias({
      aliasVenueId: "fenced-alias",
      canonicalVenueId: "fenced-canonical",
      identityKey: "fenced",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    await expect(fencedInsert).resolves.toMatchObject({ canonicalVenueId: "fenced-canonical" });

    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      billingCheckoutVenueSubjectLockKey("new-fenced-canonical"),
    ]);
    settled = false;
    const newFenceInsert = repository.upsertVenueIdentityAlias({
      aliasVenueId: "new-fenced-alias",
      canonicalVenueId: "new-fenced-canonical",
      identityKey: "new-fenced",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    await expect(newFenceInsert).resolves.toMatchObject({ canonicalVenueId: "new-fenced-canonical" });
    await blocker.end();

    const firstRace = await Promise.allSettled([
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "pg-race-alias",
        canonicalVenueId: "pg-canonical-a",
        identityKey: "pg-a",
        expectedUpdatedAt: null,
        now: BASE_TIME,
      }),
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "pg-race-alias",
        canonicalVenueId: "pg-canonical-b",
        identityKey: "pg-b",
        expectedUpdatedAt: null,
        now: BASE_TIME,
      }),
    ]);
    expect(firstRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(firstRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(rejectedCode(firstRace)).toBe("alias_version_conflict");
    const current = firstRace.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
      updatedAt: string;
    }>;

    const rehomeRace = await Promise.allSettled([
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "pg-race-alias",
        canonicalVenueId: "pg-canonical-c",
        identityKey: "pg-c",
        expectedUpdatedAt: current.value.updatedAt,
        now: MINUTE_1,
      }),
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "pg-race-alias",
        canonicalVenueId: "pg-canonical-d",
        identityKey: "pg-d",
        expectedUpdatedAt: current.value.updatedAt,
        now: MINUTE_1,
      }),
    ]);
    expect(rehomeRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rehomeRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(rejectedCode(rehomeRace)).toBe("alias_version_conflict");

    const winner = await repository.getCanonicalVenueId("pg-race-alias");
    await expect(repository.upsertVenueIdentityAlias({
      aliasVenueId: winner,
      canonicalVenueId: "pg-race-alias",
      identityKey: "cycle",
      expectedUpdatedAt: null,
      now: MINUTE_2,
    })).rejects.toMatchObject({ code: "identity_cycle" });
    expect(await repository.listVenueIdentityIds(winner))
      .toEqual(expect.arrayContaining(["pg-race-alias", winner]));
  });

  it("uses native location types with OCC, concurrent fencing, and rollback", async () => {
    const inserted = await repository.upsertVenueLocationCache({
      venueId: "pg-location",
      venueName: "PG Location",
      suburb: "Fitzroy",
      latitude: -37.798,
      longitude: 144.978,
      expectedUpdatedAt: null,
      now: BASE_TIME,
    });
    expect(inserted).toMatchObject({
      latitude: -37.798,
      longitude: 144.978,
      updatedAt: BASE_TIME,
    });
    const native = await database!.prepare(
      `SELECT pg_typeof(location.latitude)::text AS "latitudeType",
              pg_typeof(location.updated_at)::text AS "timestampType",
              to_jsonb(location) AS "nativeJson"
         FROM venue_location_cache location
        WHERE location.venue_id = ?`,
    ).get<{ latitudeType: string; timestampType: string; nativeJson: unknown }>("pg-location");
    expect(native).toMatchObject({
      latitudeType: "double precision",
      timestampType: "timestamp with time zone",
      nativeJson: expect.objectContaining({ venue_id: "pg-location", latitude: -37.798 }),
    });

    const race = await Promise.allSettled([
      repository.upsertVenueLocationCache({
        ...inserted,
        venueName: "PG Location North",
        expectedUpdatedAt: inserted.updatedAt,
        now: MINUTE_1,
      }),
      repository.upsertVenueLocationCache({
        ...inserted,
        venueName: "PG Location South",
        expectedUpdatedAt: inserted.updatedAt,
        now: MINUTE_1,
      }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(rejectedCode(race)).toBe("location_version_conflict");
    const beforeRollback = await repository.getVenueLocationCache("pg-location");
    await expect(repository.upsertVenueLocationCache({
      ...beforeRollback!,
      venueName: "ROLLBACK TEST",
      expectedUpdatedAt: beforeRollback!.updatedAt,
      now: MINUTE_2,
    })).rejects.toMatchObject({ code: "persistence_failure" });
    expect(await repository.getVenueLocationCache("pg-location")).toEqual(beforeRollback);
  });

  it("runs as a least-privilege RLS-bound login without delete or DDL authority", async () => {
    const privileges = await database!.prepare(
      `SELECT current_user AS "currentUser",
              has_table_privilege(current_user, 'pintpath_app.venue_identity_aliases', 'SELECT') AS "aliasSelect",
              has_table_privilege(current_user, 'pintpath_app.venue_identity_aliases', 'INSERT') AS "aliasInsert",
              has_table_privilege(current_user, 'pintpath_app.venue_identity_aliases', 'UPDATE') AS "aliasUpdate",
              has_table_privilege(current_user, 'pintpath_app.venue_identity_aliases', 'DELETE') AS "aliasDelete",
              has_schema_privilege(current_user, 'pintpath_app', 'CREATE') AS "schemaCreate"`,
    ).get<{
      currentUser: string;
      aliasSelect: boolean;
      aliasInsert: boolean;
      aliasUpdate: boolean;
      aliasDelete: boolean;
      schemaCreate: boolean;
    }>();
    expect(privileges).toEqual({
      currentUser: TEST_LOGIN,
      aliasSelect: true,
      aliasInsert: true,
      aliasUpdate: true,
      aliasDelete: false,
      schemaCreate: false,
    });
    await expect(database!.prepare(
      "DELETE FROM venue_identity_aliases WHERE alias_venue_id = ?",
    ).run("fenced-alias")).rejects.toThrow(/permission denied/i);
    await expect(database!.exec("CREATE TABLE pintpath_app.forbidden_identity_table (id text)"))
      .rejects.toThrow(/permission denied/i);
  });
});
