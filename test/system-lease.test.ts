import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";

describe("system job leases", () => {
  let database: BetterSqlite3.Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("propagates database failures instead of reporting ordinary lease contention", async () => {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    const repository = new SystemStateRepository(asAsyncSqliteDatabase(database));
    database.exec("DROP TABLE system_state");

    await expect(repository.acquireLease({
      key: "lease:evidence_retention",
      owner: "test-owner",
      leaseToken: "test-execution-token",
      now: "2026-07-15T00:00:00.000Z",
      leaseUntil: "2026-07-15T01:00:00.000Z",
    })).rejects.toThrow(/system_state/i);
  });

  it("renews only the unexpired lease held by the exact owner and token", async () => {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    const repository = new SystemStateRepository(asAsyncSqliteDatabase(database));
    const identity = {
      key: "lease:evidence_retention",
      owner: "test-owner",
      leaseToken: "test-execution-token",
    } as const;

    await expect(repository.acquireLease({
      ...identity,
      now: "2026-07-15T00:00:00.000Z",
      leaseUntil: "2026-07-15T00:10:00.000Z",
    })).resolves.not.toBeNull();
    await expect(repository.renewLease({
      ...identity,
      now: "2026-07-15T00:05:00.000Z",
      leaseUntil: "2026-07-15T00:20:00.000Z",
    })).resolves.toMatchObject({
      value: {
        owner: identity.owner,
        leaseToken: identity.leaseToken,
        leaseUntil: "2026-07-15T00:20:00.000Z",
      },
    });
    await expect(repository.renewLease({
      ...identity,
      leaseToken: "wrong-token",
      now: "2026-07-15T00:06:00.000Z",
      leaseUntil: "2026-07-15T00:30:00.000Z",
    })).resolves.toBeNull();
    await expect(repository.renewLease({
      ...identity,
      now: "2026-07-15T00:21:00.000Z",
      leaseUntil: "2026-07-15T00:40:00.000Z",
    })).resolves.toBeNull();
  });
});
