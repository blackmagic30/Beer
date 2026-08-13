import { describe, expect, it } from "vitest";

import {
  PostgresWorkerRepository,
  postgresWorkerQueries,
} from "../src/db/postgres-worker.repository.js";
import type {
  SqlDatabase,
  SqlPoolMetrics,
  SqlStatement,
} from "../src/db/sql-database.js";

interface RecordedQuery {
  sql: string;
  bindings: unknown[];
  operation: "get" | "run" | "all";
}

class ScriptedSqlDatabase implements SqlDatabase {
  readonly calls: RecordedQuery[] = [];
  transactionCalls = 0;
  private readonly responses: unknown[];

  constructor(
    readonly dialect: "sqlite" | "postgres",
    responses: unknown[] = [],
  ) {
    this.responses = [...responses];
  }

  prepare(sql: string): SqlStatement {
    const take = (operation: RecordedQuery["operation"], bindings: unknown[]) => {
      this.calls.push({ sql, bindings, operation });
      return this.responses.shift();
    };
    return {
      run: async (...bindings) => {
        const response = take("run", bindings) as { changes?: number } | undefined;
        return { changes: response?.changes ?? 0 };
      },
      get: async (...bindings) => take("get", bindings) as never,
      all: async (...bindings) => (take("all", bindings) ?? []) as never,
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

const NOW = "2026-08-08T02:00:00.000Z";
const STALE_BEFORE = "2026-08-08T01:55:00.000Z";
const LATER = "2026-08-08T02:05:00.000Z";

function bindingsOf(call: RecordedQuery): Record<string, unknown> {
  return call.bindings[0] as Record<string, unknown>;
}

describe("Postgres worker repository", () => {
  it("refuses to run its Postgres-only locking contract on SQLite", () => {
    expect(() => new PostgresWorkerRepository(new ScriptedSqlDatabase("sqlite")))
      .toThrow(/requires a Postgres/i);
  });

  it("atomically claims one deterministic deletion-notification row and lets a loser continue", async () => {
    const database = new ScriptedSqlDatabase("postgres", [
      { request_id: "request-1", status: "sending", lease_token: "lease-winner" },
      undefined,
    ]);
    const repository = new PostgresWorkerRepository(database);

    const winner = await repository.claimNextAccountDeletionCompletionNotification({
      now: NOW,
      staleBefore: STALE_BEFORE,
      leaseToken: "lease-winner",
      leaseExpiresAt: LATER,
    });
    const loser = await repository.claimNextAccountDeletionCompletionNotification({
      now: NOW,
      staleBefore: STALE_BEFORE,
      leaseToken: "lease-loser",
      leaseExpiresAt: LATER,
    });

    expect(winner).toMatchObject({ request_id: "request-1", lease_token: "lease-winner" });
    expect(loser).toBeNull();
    expect(database.transactionCalls).toBe(0);
    expect(database.calls).toHaveLength(2);
    const sql = database.calls[0]!.sql;
    expect(sql).toContain("FOR UPDATE OF notice SKIP LOCKED");
    expect(sql).toContain("UPDATE account_deletion_completion_outbox AS notice");
    expect(sql).toContain("FROM candidate");
    expect(sql).toContain("RETURNING notice.*");
    expect(sql).toContain(
      "ORDER BY notice.next_attempt_at ASC, notice.created_at ASC, notice.request_id ASC",
    );
    expect(bindingsOf(database.calls[1]!)).toMatchObject({ leaseToken: "lease-loser" });
  });

  it("guards every deletion-notification mutation with the active lease token", async () => {
    const database = new ScriptedSqlDatabase("postgres", [
      { mutationKey: "request-1" },
      { mutationKey: "request-1" },
      undefined,
      { mutationKey: "request-1" },
    ]);
    const repository = new PostgresWorkerRepository(database);

    expect(await repository.lockAccountDeletionNotificationPayload({
      requestId: "request-1",
      leaseToken: "lease-1",
      payloadFingerprint: "not-a-fingerprint",
      now: NOW,
    })).toBe(false);
    expect(database.calls).toHaveLength(0);

    expect(await repository.lockAccountDeletionNotificationPayload({
      requestId: "request-1",
      leaseToken: "lease-1",
      payloadFingerprint: "a".repeat(64),
      now: NOW,
    })).toBe(true);
    expect(await repository.markAccountDeletionNotificationAccepted({
      requestId: "request-1",
      leaseToken: "lease-1",
      providerMessageId: "provider-1",
      acceptedAt: NOW,
      nextCheckAt: LATER,
    })).toBe(true);
    expect(await repository.deferAccountDeletionNotification({
      requestId: "request-1",
      leaseToken: "stale-lease",
      nextAttemptAt: LATER,
      redactedError: "temporary failure",
      now: NOW,
    })).toBe(false);
    expect(await repository.markAccountDeletionNotificationFailed({
      requestId: "request-1",
      leaseToken: "lease-1",
      providerEvent: "rejected",
      redactedError: "x".repeat(600),
      now: NOW,
    })).toBe(true);

    expect(database.calls).toHaveLength(4);
    for (const call of database.calls) {
      expect(call.sql).toContain("status = 'sending' AND lease_token = @leaseToken");
      expect(call.sql).toContain("RETURNING request_id AS \"mutationKey\"");
    }
    expect(bindingsOf(database.calls[2]!).leaseToken).toBe("stale-lease");
    expect(bindingsOf(database.calls[3]!).redactedError).toHaveLength(500);
  });

  it("uses SKIP LOCKED for deterministic admin review claims", async () => {
    const database = new ScriptedSqlDatabase("postgres", [
      {
        id: "ingestion-1",
        status: "publishing",
        claimToken: "review-token-1",
        claimedAt: NOW,
      },
      undefined,
    ]);
    const repository = new PostgresWorkerRepository(database);

    expect(await repository.claimAdminIngestionReview({
      action: "publish",
      claimToken: "review-token-1",
      claimedAt: NOW,
      staleBefore: STALE_BEFORE,
    })).toEqual({
      id: "ingestion-1",
      status: "publishing",
      claimToken: "review-token-1",
      claimedAt: NOW,
    });
    expect(await repository.claimAdminIngestionReview({
      id: "ingestion-1",
      action: "reject",
      claimToken: "review-token-2",
      claimedAt: NOW,
      staleBefore: STALE_BEFORE,
    })).toBeNull();

    const sql = database.calls[0]!.sql;
    expect(sql).toContain("@id::text IS NULL");
    expect(sql).toContain("FOR UPDATE OF queued SKIP LOCKED");
    expect(sql).toContain("ORDER BY queued.created_at ASC, queued.id ASC");
    expect(sql).toContain("UPDATE admin_ingestion_queue AS queued");
    expect(sql).toContain("FROM candidate");
    expect(bindingsOf(database.calls[0]!)).toMatchObject({ id: null, status: "publishing" });
    expect(bindingsOf(database.calls[1]!)).toMatchObject({ id: "ingestion-1", status: "rejecting" });
    expect(database.transactionCalls).toBe(0);
  });
});
