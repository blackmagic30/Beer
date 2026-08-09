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
});
