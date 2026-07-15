import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";

describe("system job leases", () => {
  let database: BetterSqlite3.Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("propagates database failures instead of reporting ordinary lease contention", () => {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    const repository = new BusinessRepository(database);
    database.exec("DROP TABLE system_state");

    expect(() => repository.acquireSystemLease({
      key: "lease:evidence_retention",
      owner: "test-owner",
      now: "2026-07-15T00:00:00.000Z",
      leaseUntil: "2026-07-15T01:00:00.000Z",
    })).toThrow(/system_state/i);
  });
});
