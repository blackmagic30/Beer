import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  SystemStateRepository,
  systemStateRepositoryQueries,
} from "../src/db/system-state.repository.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const NOW = "2026-08-08T02:00:00.000Z";
const LATER = "2026-08-08T02:05:00.000Z";
const EVEN_LATER = "2026-08-08T02:10:00.000Z";

interface RecordedCall {
  sql: string;
  bindings: unknown[];
  operation: "get" | "run" | "all";
}

class EchoSqlDatabase implements SqlDatabase {
  readonly calls: RecordedCall[] = [];
  transactionCalls = 0;
  nextGet: unknown = "echo";

  constructor(
    readonly dialect: "sqlite" | "postgres",
    private readonly objectValuedJson = false,
  ) {}

  prepare(sql: string): SqlStatement {
    const record = (operation: RecordedCall["operation"], bindings: unknown[]) => {
      this.calls.push({ sql, bindings, operation });
    };
    return {
      run: async (...bindings) => {
        record("run", bindings);
        return { changes: 0 };
      },
      get: async (...bindings) => {
        record("get", bindings);
        if (this.nextGet !== "echo") return this.nextGet as never;
        const input = bindings[0] as Record<string, unknown>;
        const valueJson = this.objectValuedJson
          ? JSON.parse(input.valueJson as string) as unknown
          : input.valueJson;
        return {
          valueJson,
          updatedAt: input.now,
          revision: input.revision,
        } as never;
      },
      all: async (...bindings) => {
        record("all", bindings);
        return [];
      },
    };
  }

  async exec(): Promise<void> {}

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      this.transactionCalls += 1;
      return work();
    };
  }

  async close(): Promise<void> {}

  metrics(): SqlPoolMetrics {
    return {
      dialect: this.dialect,
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      completedQueries: this.calls.length,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    };
  }
}

class NoTransactionDatabase implements SqlDatabase {
  transactionCalls = 0;

  constructor(private readonly delegate: SqlDatabase) {}

  get dialect(): "sqlite" | "postgres" {
    return this.delegate.dialect;
  }

  prepare(sql: string): SqlStatement {
    return this.delegate.prepare(sql);
  }

  exec(sql: string): Promise<void> {
    return this.delegate.exec(sql);
  }

  transaction<Result>(): () => Promise<Result> {
    this.transactionCalls += 1;
    throw new Error("SystemStateRepository must not open an application transaction.");
  }

  close(): Promise<void> {
    return this.delegate.close();
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

function createSqlite(): {
  raw: BetterSqlite3.Database;
  database: NoTransactionDatabase;
  repository: SystemStateRepository;
} {
  const raw = new BetterSqlite3(":memory:");
  raw.exec(`CREATE TABLE system_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL CHECK (length(revision) > 0)
  )`);
  const database = new NoTransactionDatabase(new AsyncSqliteDatabase(raw));
  return { raw, database, repository: new SystemStateRepository(database) };
}

function bindingOf(call: RecordedCall): Record<string, unknown> {
  return call.bindings[0] as Record<string, unknown>;
}

function expectRevisionAt(revision: string, now = NOW): void {
  expect(revision).toMatch(
    new RegExp(`^${now.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i"),
  );
}

describe("SystemStateRepository with AsyncSqliteDatabase", () => {
  const databases: NoTransactionDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function sqlite() {
    const fixture = createSqlite();
    databases.push(fixture.database);
    return fixture;
  }

  it("gets absent state and round-trips a canonically serialized JSON object", async () => {
    const { raw, database, repository } = sqlite();

    await expect(repository.get("settings:reports")).resolves.toBeNull();
    const written = await repository.set(
      "settings:reports",
      { z: 3, a: { z: true, a: [2, { z: null, a: "value" }] } },
      NOW,
    );

    expect(written).toEqual({
      value: { a: { a: [2, { a: "value", z: null }], z: true }, z: 3 },
      updatedAt: NOW,
      revision: written.revision,
    });
    expectRevisionAt(written.revision);
    expect(written.updatedAt).not.toContain("#");
    expect(raw.prepare(
      "SELECT value_json AS valueJson, updated_at AS updatedAt, revision FROM system_state WHERE key = ?",
    ).get("settings:reports")).toEqual({
      valueJson: '{"a":{"a":[2,{"a":"value","z":null}],"z":true},"z":3}',
      updatedAt: NOW,
      revision: written.revision,
    });
    await expect(repository.get("settings:reports")).resolves.toEqual(written);
    expect(database.transactionCalls).toBe(0);
  });

  it("generates a distinct returned revision for writes in the same millisecond", async () => {
    const { raw, repository } = sqlite();

    const first = await repository.set("same-ms", { generation: 1 }, NOW);
    const second = await repository.set("same-ms", { generation: 2 }, NOW);

    expectRevisionAt(first.revision);
    expectRevisionAt(second.revision);
    expect(second.revision).not.toBe(first.revision);
    expect(first.updatedAt).toBe(NOW);
    expect(second.updatedAt).toBe(NOW);
    expect(raw.prepare("SELECT revision FROM system_state WHERE key = 'same-ms'").get())
      .toEqual({ revision: second.revision });
  });

  it("allows one CAS creator, rejects stale revisions, and lets the returned claim drive terminal CAS", async () => {
    const { database, repository } = sqlite();

    const contenders = await Promise.all([
      repository.compareAndSet("job:one", null, { state: "claimed", owner: "one" }, NOW),
      repository.compareAndSet("job:one", null, { state: "claimed", owner: "two" }, NOW),
    ]);
    const claims = contenders.filter((value) => value !== null);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expectRevisionAt(claim.revision);

    await expect(repository.compareAndSet(
      "job:one",
      `${NOW}#stale-revision`,
      { state: "done", owner: "stale" },
      NOW,
    )).resolves.toBeNull();

    const terminal = await repository.compareAndSet(
      "job:one",
      claim.revision,
      { state: "done", claimRevision: claim.revision },
      NOW,
    );
    expect(terminal).not.toBeNull();
    expect(terminal?.value).toEqual({ claimRevision: claim.revision, state: "done" });
    expect(terminal?.revision).not.toBe(claim.revision);
    expect(terminal?.updatedAt).toBe(NOW);
    await expect(repository.compareAndSet(
      "job:one",
      claim.revision,
      { state: "incorrect-second-terminal" },
      NOW,
    )).resolves.toBeNull();
    expect(database.transactionCalls).toBe(0);
  });

  it("fences lease contention, expiry, reacquisition, and release by owner plus token", async () => {
    const { database, repository } = sqlite();
    const firstInput = {
      key: "lease:reports",
      owner: "worker-one",
      leaseToken: "generation-one",
      now: NOW,
      leaseUntil: LATER,
    } as const;

    const first = await repository.acquireLease(firstInput);
    expect(first?.value).toEqual({
      acquiredAt: NOW,
      leaseToken: "generation-one",
      leaseUntil: LATER,
      owner: "worker-one",
    });
    expectRevisionAt(first!.revision);
    await expect(repository.acquireLease({
      ...firstInput,
      owner: "worker-two",
      leaseToken: "generation-two",
    })).resolves.toBeNull();
    await expect(repository.releaseLease({
      key: firstInput.key,
      owner: firstInput.owner,
      leaseToken: "stale-generation",
      now: NOW,
    })).resolves.toBeNull();

    const released = await repository.releaseLease({
      key: firstInput.key,
      owner: firstInput.owner,
      leaseToken: firstInput.leaseToken,
      now: NOW,
    });
    expect(released?.value).toEqual({
      leaseToken: "generation-one",
      leaseUntil: NOW,
      owner: "worker-one",
      releasedAt: NOW,
    });
    expect(released?.revision).not.toBe(first?.revision);

    const reacquired = await repository.acquireLease({
      key: firstInput.key,
      owner: "worker-two",
      leaseToken: "generation-two",
      now: NOW,
      leaseUntil: LATER,
    });
    expect(reacquired?.value.owner).toBe("worker-two");
    await expect(repository.releaseLease({
      key: firstInput.key,
      owner: firstInput.owner,
      leaseToken: firstInput.leaseToken,
      now: NOW,
    })).resolves.toBeNull();

    const expiring = await repository.acquireLease({
      key: "lease:expiry",
      owner: "worker-one",
      leaseToken: "expiry-one",
      now: NOW,
      leaseUntil: LATER,
    });
    expect(expiring).not.toBeNull();
    const afterExpiry = await repository.acquireLease({
      key: "lease:expiry",
      owner: "worker-two",
      leaseToken: "expiry-two",
      now: LATER,
      leaseUntil: EVEN_LATER,
    });
    expect(afterExpiry?.value.leaseToken).toBe("expiry-two");
    expect(database.transactionCalls).toBe(0);
  });

  it("fails closed for malformed stored leases but treats a missing expiry as abandoned", async () => {
    const { raw, repository } = sqlite();
    const insert = raw.prepare(
      "INSERT INTO system_state (key, value_json, updated_at, revision) VALUES (?, ?, ?, ?)",
    );
    insert.run("lease:invalid-json", "{", NOW, "seed-invalid-json");
    insert.run("lease:invalid-type", '{"leaseUntil":42}', NOW, "seed-invalid-type");
    insert.run("lease:invalid-text", '{"leaseUntil":"not-a-timestamp"}', NOW, "seed-invalid-text");
    insert.run(
      "lease:invalid-date",
      '{"leaseUntil":"2026-02-30T00:00:00.000Z"}',
      NOW,
      "seed-invalid-date",
    );
    insert.run("lease:missing-expiry", '{"owner":"abandoned"}', NOW, "seed-missing");

    for (const key of [
      "lease:invalid-json",
      "lease:invalid-type",
      "lease:invalid-text",
      "lease:invalid-date",
    ]) {
      await expect(repository.acquireLease({
        key,
        owner: "worker",
        leaseToken: "generation",
        now: NOW,
        leaseUntil: LATER,
      })).resolves.toBeNull();
    }
    await expect(repository.acquireLease({
      key: "lease:missing-expiry",
      owner: "worker",
      leaseToken: "generation",
      now: NOW,
      leaseUntil: LATER,
    })).resolves.toMatchObject({ value: { owner: "worker", leaseToken: "generation" } });
  });

  it("validates bounded identities, canonical timestamps, and JSON-object values", async () => {
    const { repository } = sqlite();

    await expect(repository.get(" ")).rejects.toThrow(/key must be/i);
    await expect(repository.set("x".repeat(256), {}, NOW)).rejects.toThrow(/at most 255/i);
    await expect(repository.set("state", [] as unknown as object, NOW)).rejects.toThrow(/JSON object/i);
    await expect(repository.set("state", null as unknown as object, NOW)).rejects.toThrow(/JSON object/i);
    await expect(repository.set("state", { value: Number.NaN }, NOW)).rejects.toThrow(/finite/i);
    await expect(repository.set("state", { value: undefined }, NOW)).rejects.toThrow(/JSON-compatible/i);
    await expect(repository.set("state", {}, "2026-08-08T02:00:00Z"))
      .rejects.toThrow(/millisecond precision/i);
    await expect(repository.acquireLease({
      key: "lease:bounded",
      owner: "x".repeat(256),
      leaseToken: "token",
      now: NOW,
      leaseUntil: LATER,
    })).rejects.toThrow(/owner.*255/i);
    await expect(repository.acquireLease({
      key: "lease:bounded",
      owner: "owner",
      leaseToken: " token ",
      now: NOW,
      leaseUntil: LATER,
    })).rejects.toThrow(/leaseToken/i);
    await expect(repository.acquireLease({
      key: "lease:bounded",
      owner: "owner",
      leaseToken: "token",
      now: NOW,
      leaseUntil: NOW,
    })).rejects.toThrow(/after now/i);
  });

  it("propagates database errors instead of reporting ordinary contention", async () => {
    const { raw, repository } = sqlite();
    raw.exec("DROP TABLE system_state");

    await expect(repository.get("state")).rejects.toThrow(/system_state/i);
    await expect(repository.acquireLease({
      key: "lease:error",
      owner: "worker",
      leaseToken: "generation",
      now: NOW,
      leaseUntil: LATER,
    })).rejects.toThrow(/system_state/i);
  });
});

describe("SystemStateRepository PostgreSQL SQL contract", () => {
  it("uses a single conditional JSONB UPSERT with validated timestamptz expiry", async () => {
    const database = new EchoSqlDatabase("postgres", true);
    const repository = new SystemStateRepository(database);

    const acquired = await repository.acquireLease({
      key: "lease:reports",
      owner: "worker-one",
      leaseToken: "generation-one",
      now: NOW,
      leaseUntil: LATER,
    });

    expect(acquired?.value).toEqual({
      acquiredAt: NOW,
      leaseToken: "generation-one",
      leaseUntil: LATER,
      owner: "worker-one",
    });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.operation).toBe("get");
    expect(database.calls[0]?.sql).toBe(systemStateRepositoryQueries.acquirePostgresSystemLease);
    expect(database.calls[0]?.sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(database.calls[0]?.sql).toContain("jsonb_typeof(system_state.value_json)");
    expect(database.calls[0]?.sql).toContain("pg_input_is_valid");
    expect(database.calls[0]?.sql).toContain("::timestamptz <= @now::timestamptz");
    expect(database.calls[0]?.sql).toContain("RETURNING value_json");
    expect(bindingOf(database.calls[0]!).valueJson).toBe(
      `{"acquiredAt":"${NOW}","leaseToken":"generation-one","leaseUntil":"${LATER}","owner":"worker-one"}`,
    );
    expect(database.transactionCalls).toBe(0);
  });

  it("token-guards release in one statement and normalizes object-valued pg JSON results", async () => {
    const database = new EchoSqlDatabase("postgres", true);
    const repository = new SystemStateRepository(database);

    const released = await repository.releaseLease({
      key: "lease:reports",
      owner: "worker-one",
      leaseToken: "generation-one",
      now: NOW,
    });

    expect(released?.value).toEqual({
      leaseToken: "generation-one",
      leaseUntil: NOW,
      owner: "worker-one",
      releasedAt: NOW,
    });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.sql).toBe(systemStateRepositoryQueries.releasePostgresSystemLease);
    expect(database.calls[0]?.sql).toContain("value_json ->> 'owner' = @owner");
    expect(database.calls[0]?.sql).toContain("value_json ->> 'leaseToken' = @leaseToken");
    expect(database.calls[0]?.sql).toContain("RETURNING value_json");
    expect(database.transactionCalls).toBe(0);
  });

  it("binds canonical JSON and verifies that RETURNING exposes the exact write revision", async () => {
    const database = new EchoSqlDatabase("postgres");
    const repository = new SystemStateRepository(database);

    const written = await repository.set("canonical", { z: 1, a: { z: 2, a: 3 } }, NOW);
    expect(bindingOf(database.calls[0]!).valueJson).toBe('{"a":{"a":3,"z":2},"z":1}');
    expect(bindingOf(database.calls[0]!).revision).toBe(written.revision);
    expectRevisionAt(written.revision);

    const mismatch = new EchoSqlDatabase("postgres");
    mismatch.nextGet = { valueJson: "{}", updatedAt: NOW, revision: "unexpected" };
    await expect(new SystemStateRepository(mismatch).set("canonical", {}, NOW))
      .rejects.toThrow(/does not match its write token/i);
  });
});
