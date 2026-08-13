import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { reserveOpenAiMenuOcrRollingBudget } from "../src/lib/external-provider-cost-budget.js";
import type {
  SqlDatabase,
  SqlPoolMetrics,
  SqlRunResult,
  SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_system_state_integration_test";
const NOW = "2026-08-08T02:00:00.000Z";
const LATER = "2026-08-08T02:05:00.000Z";
const EVEN_LATER = "2026-08-08T02:10:00.000Z";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";

function validateDisposableAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback Postgres admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.hash
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  }
  return url;
}

function withDatabase(url: URL, databaseName: string): string {
  const target = new URL(url.toString());
  target.pathname = `/${databaseName}`;
  return target.toString();
}

function compileNamedBindings(
  sql: string,
  bindings: Readonly<Record<string, unknown>>,
): { text: string; values: unknown[] } {
  const indexes = new Map<string, number>();
  const values: unknown[] = [];
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (!Object.hasOwn(bindings, name)) throw new Error(`Missing named SQL binding: ${name}`);
    let index = indexes.get(name);
    if (!index) {
      values.push(bindings[name]);
      index = values.length;
      indexes.set(name, index);
    }
    return `$${index}`;
  });
  return { text, values };
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

class IntegrationPostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: Client) {}

  prepare(sql: string): SqlStatement {
    const execute = async <Row extends QueryResultRow>(bindings: unknown[]) => {
      const named = bindings[0] as Readonly<Record<string, unknown>>;
      const compiled = compileNamedBindings(sql, named);
      return this.client.query<Row>(compiled.text, compiled.values);
    };
    return {
      run: async (...bindings: unknown[]): Promise<SqlRunResult> => {
        const result = await execute(bindings);
        return { changes: result.rowCount ?? 0 };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]): Promise<Row | undefined> => {
        const result = await execute<Row>(bindings);
        return result.rows[0] ? normalizeRow(result.rows[0]) : undefined;
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]): Promise<Row[]> => {
        const result = await execute<Row>(bindings);
        return result.rows.map(normalizeRow);
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      await this.client.query("BEGIN");
      try {
        const result = await work();
        await this.client.query("COMMIT");
        return result;
      } catch (error) {
        await this.client.query("ROLLBACK");
        throw error;
      }
    };
  }

  async close(): Promise<void> {}

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: 1,
      idleConnections: 0,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("system state authority on real PostgreSQL 17", () => {
  let admin: Client;
  let target: Client;
  let targetTwo: Client;
  let database: IntegrationPostgresDatabase;
  let databaseTwo: IntegrationPostgresDatabase;
  let repository: SystemStateRepository;
  let repositoryTwo: SystemStateRepository;

  beforeAll(async () => {
    const adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    target = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await target.connect();
    await target.query(`
      CREATE TABLE system_state (
        key text PRIMARY KEY,
        value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL,
        revision text NOT NULL CHECK (length(revision) > 0)
      )
    `);
    targetTwo = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetTwo.connect();
    database = new IntegrationPostgresDatabase(target);
    databaseTwo = new IntegrationPostgresDatabase(targetTwo);
    repository = new SystemStateRepository(database);
    repositoryTwo = new SystemStateRepository(databaseTwo);
  }, 30_000);

  afterAll(async () => {
    await target?.end().catch(() => undefined);
    await targetTwo?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("round-trips canonical state and fences same-millisecond CAS revisions", async () => {
    const written = await repository.set("report:settings", { z: 1, a: { enabled: true } }, NOW);
    expect(await repository.get("report:settings")).toEqual(written);
    const next = await repository.compareAndSet(
      "report:settings",
      written.revision,
      { z: 2, a: { enabled: false } },
      NOW,
    );
    expect(next?.updatedAt).toBe(NOW);
    expect(next?.revision).not.toBe(written.revision);
    await expect(repository.compareAndSet(
      "report:settings",
      written.revision,
      { stale: true },
      NOW,
    )).resolves.toBeNull();
  });

  it("atomically fences contention, expiry, release tokens, and ABA reacquisition", async () => {
    const contenders = await Promise.all([
      repository.acquireLease({
        key: "lease:reports",
        owner: "worker-one",
        leaseToken: "generation-one",
        now: NOW,
        leaseUntil: LATER,
      }),
      repository.acquireLease({
        key: "lease:reports",
        owner: "worker-two",
        leaseToken: "generation-two",
        now: NOW,
        leaseUntil: LATER,
      }),
    ]);
    const acquired = contenders.filter((record) => record !== null);
    expect(acquired).toHaveLength(1);
    const winner = acquired[0]!.value;
    await expect(repository.releaseLease({
      key: "lease:reports",
      owner: winner.owner,
      leaseToken: "stale-token",
      now: NOW,
    })).resolves.toBeNull();
    expect(await repository.releaseLease({
      key: "lease:reports",
      owner: winner.owner,
      leaseToken: winner.leaseToken,
      now: NOW,
    })).not.toBeNull();
    const reacquired = await repository.acquireLease({
      key: "lease:reports",
      owner: "worker-three",
      leaseToken: "generation-three",
      now: NOW,
      leaseUntil: LATER,
    });
    expect(reacquired?.value.leaseToken).toBe("generation-three");
    await expect(repository.releaseLease({
      key: "lease:reports",
      owner: winner.owner,
      leaseToken: winner.leaseToken,
      now: NOW,
    })).resolves.toBeNull();

    expect(await repository.acquireLease({
      key: "lease:expiry",
      owner: "worker-one",
      leaseToken: "expiry-one",
      now: NOW,
      leaseUntil: LATER,
    })).not.toBeNull();
    expect(await repository.acquireLease({
      key: "lease:expiry",
      owner: "worker-two",
      leaseToken: "expiry-two",
      now: LATER,
      leaseUntil: EVEN_LATER,
    })).toMatchObject({ value: { leaseToken: "expiry-two" } });
  });

  it("serializes the monthly OpenAI reservation across Postgres sessions using database time", async () => {
    const stores = [
      { repository, database },
      { repository: repositoryTwo, database: databaseTwo },
    ] as const;
    const reservations = [];
    for (let round = 0; round < 10; round += 1) {
      reservations.push(...await Promise.all(stores.map((store) =>
        reserveOpenAiMenuOcrRollingBudget(store.repository, store.database))));
    }

    expect(reservations.every((entry) => entry.allowed)).toBe(true);
    expect(reservations.map((entry) => entry.reservedCents).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 5));
    expect(new Set(reservations.map((entry) => entry.stateKey))).toHaveLength(1);
    await expect(reserveOpenAiMenuOcrRollingBudget(repository, database)).resolves
      .toEqual(expect.objectContaining({
        allowed: false,
        reservedCents: 100,
        reservationCount: 20,
      }));
  });
});
