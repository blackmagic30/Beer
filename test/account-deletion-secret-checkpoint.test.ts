import { describe, expect, it, vi } from "vitest";

import { createPostgresAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";
import type { SqlDatabase, SqlPoolMetrics } from "../src/db/sql-database.js";

function databaseWithResult(result: {
  synchronousCommit: string;
  hasRecipientSecret: boolean;
}): SqlDatabase {
  return {
    dialect: "postgres",
    prepare: vi.fn(() => ({
      run: vi.fn(async () => ({ changes: 0 })),
      get: vi.fn(async () => result),
      all: vi.fn(async () => []),
    })),
    exec: vi.fn(async () => undefined),
    transaction: vi.fn(() => async () => undefined),
    close: vi.fn(async () => undefined),
    metrics: vi.fn((): SqlPoolMetrics => ({
      dialect: "postgres",
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    })),
  };
}

describe("PostgreSQL account-deletion secret checkpoint", () => {
  it("acknowledges a bounded generation only after synchronous absence proof", async () => {
    const database = databaseWithResult({
      synchronousCommit: "on",
      hasRecipientSecret: false,
    });
    const checkpoint =
      createPostgresAccountDeletionSecretPhysicalCheckpoint(database);
    await expect(
      checkpoint([
        { requestId: "deletion-request-1", generation: 2 },
        { requestId: "deletion-request-2", generation: 4 },
      ]),
    ).resolves.toBe(true);
    expect(database.prepare).toHaveBeenCalledWith(
      expect.stringContaining("current_setting('synchronous_commit')"),
    );
  });

  it.each([
    [
      "unsynced commit",
      { synchronousCommit: "off", hasRecipientSecret: false },
    ],
    [
      "live recipient secret",
      { synchronousCommit: "on", hasRecipientSecret: true },
    ],
  ])("fails closed for %s", async (_label, result) => {
    const checkpoint = createPostgresAccountDeletionSecretPhysicalCheckpoint(
      databaseWithResult(result),
    );
    await expect(
      checkpoint([{ requestId: "deletion-request-1", generation: 2 }]),
    ).resolves.toBe(false);
  });

  it("rejects duplicate, malformed, and non-PostgreSQL snapshots without querying", async () => {
    const postgres = databaseWithResult({
      synchronousCommit: "on",
      hasRecipientSecret: false,
    });
    const checkpoint =
      createPostgresAccountDeletionSecretPhysicalCheckpoint(postgres);
    await expect(
      checkpoint([
        { requestId: "duplicate", generation: 1 },
        { requestId: "duplicate", generation: 1 },
      ]),
    ).resolves.toBe(false);
    await expect(
      checkpoint([{ requestId: " bad", generation: 1 }]),
    ).resolves.toBe(false);
    expect(postgres.prepare).not.toHaveBeenCalled();

    const sqlite = { ...postgres, dialect: "sqlite" as const };
    await expect(
      createPostgresAccountDeletionSecretPhysicalCheckpoint(sqlite)([]),
    ).resolves.toBe(false);
  });
});
