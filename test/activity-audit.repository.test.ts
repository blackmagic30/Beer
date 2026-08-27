import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActivityAuditRepository,
  ActivityAuditRepositoryError,
} from "../src/db/activity-audit.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const NOW = "2026-08-08T16:00:00.000Z";
const LATER = "2026-08-08T16:01:00.000Z";
const AFTER = "2026-08-08T16:02:00.000Z";
const IP_HASH = "a".repeat(32);
const USER_AGENT_HASH = "b".repeat(32);

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: ActivityAuditRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new ActivityAuditRepository(database) };
}

function insertAccount(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, role, subscription_status, created_at, updated_at
     ) VALUES (?, ?, 'hash', 'user', 'free', ?, ?)`,
  ).run(id, `${id}@example.test`, NOW, NOW);
}

function expectCode(code: ActivityAuditRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ActivityAuditRepositoryError && error.code === code;
}

class PostInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  failNextActivityInsert = true;

  constructor(private readonly delegate: AsyncSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (this.failNextActivityInsert && /INSERT\s+INTO\s+user_activity_events/i.test(sql)) {
          this.failNextActivityInsert = false;
          throw new Error("injected post-insert failure");
        }
        return result;
      },
      get: async <Row>(...bindings: unknown[]) => statement.get(...bindings) as Promise<Row | undefined>,
      all: async <Row>(...bindings: unknown[]) => statement.all(...bindings) as Promise<Row[]>,
    } as SqlStatement;
  }

  async exec(sql: string): Promise<void> {
    await this.delegate.exec(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return this.delegate.transaction(work);
  }

  async close(): Promise<void> {
    // The fixture owns the shared delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("ActivityAuditRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("creates, redacts, reads, and idempotently races the same user activity", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "activity-user");
    const input = {
      id: "activity-idempotent",
      userId: "activity-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: "activity-user",
      metadata: {
        method: "local",
        apiKey: "sk_test_must_not_persist",
        message: "Bearer hidden-token-value",
      },
      createdAt: NOW,
    };
    const writes = await Promise.all([
      repository.createUserActivityEvent(input),
      repository.createUserActivityEvent(input),
    ]);
    expect(writes.map((write) => write.outcome).sort()).toEqual(["duplicate", "inserted"]);
    expect(writes[0]?.record.metadata).toEqual({
      method: "local",
      apiKey: "[REDACTED]",
      message: "[REDACTED]",
    });
    await expect(repository.getUserActivityEventById(input.id)).resolves.toEqual(writes[0]?.record);
    expect(raw.prepare("SELECT count(*) AS count FROM user_activity_events").get()).toEqual({ count: 1 });

    await expect(repository.createUserActivityEvent({
      ...input,
      eventType: "password_reset_completed",
    })).rejects.toSatisfy(expectCode("activity_conflict"));
    await expect(repository.createUserActivityEvent({
      ...input,
      id: "missing-account-activity",
      userId: "missing-account",
      relatedEntityId: "missing-account",
    })).rejects.toSatisfy(expectCode("account_not_found"));
  });

  it("uses deterministic created-at/id keyset pagination for user activity", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "paged-user");
    insertAccount(raw, "other-user");
    for (const id of ["activity-a", "activity-c", "activity-b"]) {
      await repository.createUserActivityEvent({
        id,
        userId: "paged-user",
        eventType: "venue_portal_viewed",
        relatedEntityType: "venue",
        relatedEntityId: "venue-1",
        metadata: { id },
        createdAt: NOW,
      });
    }
    await repository.createUserActivityEvent({
      id: "activity-newest",
      userId: "paged-user",
      eventType: "venue_portal_viewed",
      relatedEntityType: "venue",
      relatedEntityId: "venue-1",
      metadata: {},
      createdAt: LATER,
    });
    await repository.createUserActivityEvent({
      id: "other-activity",
      userId: "other-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: "other-user",
      metadata: {},
      createdAt: LATER,
    });

    const first = await repository.listUserActivityEvents({ userId: "paged-user", limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["activity-newest", "activity-c"]);
    expect(first.nextCursor).toEqual({ createdAt: NOW, id: "activity-c" });
    const second = await repository.listUserActivityEvents({
      userId: "paged-user",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual(["activity-b", "activity-a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("records normalized general analytics events with explicit duplicate conflicts", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "analytics-user");
    const input = {
      id: "analytics-event",
      userId: "analytics-user",
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: "venue-analytics",
      beerId: "Guinness",
      suburb: "Fitzroy",
      metadata: { query: "Guinness", authorization: "Bearer analytics-secret" },
      createdAt: NOW,
    };
    await expect(repository.recordEvent(input)).resolves.toMatchObject({
      outcome: "inserted",
      record: {
        beerId: "guinness",
        metadata: { query: "Guinness", authorization: "[REDACTED]" },
      },
    });
    await expect(repository.recordEvent(input)).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(repository.recordEvent({ ...input, suburb: "Carlton" }))
      .rejects.toSatisfy(expectCode("event_conflict"));
    await expect(repository.recordEvent({
      ...input,
      id: "missing-account-analytics",
      userId: "missing-account",
    })).rejects.toSatisfy(expectCode("account_not_found"));
    expect(raw.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 1 });
  });

  it("atomically replays caller-keyed events while preserving the first timestamp", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "idempotent-event-user");
    const input = {
      id: "price-confirmation:stable-key",
      userId: "idempotent-event-user",
      anonymousSessionId: null,
      eventType: "price_confirmation_answered",
      venueId: "venue-1",
      beerId: "Guinness",
      suburb: "Fitzroy",
      metadata: {
        outcome: "yes",
        priceRecordId: "price-1",
        priceVersion: "a".repeat(64),
        sourceType: "community_verified",
      },
      createdAt: NOW,
    };

    const writes = await Promise.all([
      repository.recordIdempotentEvent(input),
      repository.recordIdempotentEvent({ ...input, createdAt: LATER }),
    ]);
    expect(writes.map((write) => write.outcome).sort()).toEqual(["duplicate", "inserted"]);
    const insertedIndex = writes.findIndex((write) => write.outcome === "inserted");
    const firstTimestamp = insertedIndex === 0 ? NOW : LATER;
    expect(writes.every((write) => write.record.createdAt === firstTimestamp)).toBe(true);
    expect(raw.prepare("SELECT count(*) AS count FROM events WHERE id = ?")
      .get(input.id)).toEqual({ count: 1 });

    await expect(repository.recordIdempotentEvent({
      ...input,
      metadata: { ...input.metadata, outcome: "no" },
      createdAt: LATER,
    })).rejects.toSatisfy(expectCode("event_conflict"));
  });

  it("returns bounded signal-only Yes evidence and suppresses accounts that later answer No", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "confirmation-evidence-one");
    insertAccount(raw, "confirmation-evidence-two");
    const yes = (id: string, userId: string, createdAt: string) => repository.recordIdempotentEvent({
      id,
      userId,
      anonymousSessionId: null,
      eventType: "price_confirmation_answered",
      venueId: "venue-1",
      beerId: "guinness",
      suburb: "Fitzroy",
      metadata: {
        outcome: "yes",
        priceRecordId: "price-1",
        priceVersion: "a".repeat(64),
        sourceType: "community_verified",
      },
      createdAt,
    });
    await yes("confirmation-evidence-yes-one", "confirmation-evidence-one", NOW);
    await yes("confirmation-evidence-yes-two", "confirmation-evidence-two", LATER);

    await expect(repository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["price-1", "price-1", "missing-price"],
      since: "2026-08-08T15:59:00.000Z",
      asOf: AFTER,
      limit: 10,
    })).resolves.toEqual([{
      eventId: "confirmation-evidence-yes-two",
      priceRecordId: "price-1",
      priceVersion: "a".repeat(64),
      venueId: "venue-1",
      beerId: "guinness",
      suburb: "Fitzroy",
      sourceType: "community_verified",
      confirmedAt: LATER,
      verificationEffect: "signal_only",
    }]);

    const no = (id: string, userId: string) => repository.recordIdempotentEvent({
      id,
      userId,
      anonymousSessionId: null,
      eventType: "price_confirmation_answered",
      venueId: "venue-1",
      beerId: "guinness",
      suburb: "Fitzroy",
      metadata: {
        outcome: "no",
        priceRecordId: "price-1",
        priceVersion: "a".repeat(64),
        sourceType: "community_verified",
      },
      createdAt: AFTER,
    });
    await no("confirmation-evidence-no-two", "confirmation-evidence-two");
    await expect(repository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["price-1"],
      since: "2026-08-08T15:59:00.000Z",
      asOf: AFTER,
    })).resolves.toEqual([
      expect.objectContaining({ eventId: "confirmation-evidence-yes-one", confirmedAt: NOW }),
    ]);
    await no("confirmation-evidence-no-one", "confirmation-evidence-one");
    await expect(repository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["price-1"],
      since: "2026-08-08T15:59:00.000Z",
      asOf: AFTER,
    })).resolves.toEqual([]);
  });

  it("inserts, filters, counts, and keyset-pages security audits deterministically", async () => {
    const { repository } = fixture();
    const insert = (id: string, action: string, actorUserId: string | null, createdAt: string) =>
      repository.insertSecurityAuditLog({
        id,
        actorUserId,
        actorRole: actorUserId ? "admin" : null,
        action,
        targetType: "account",
        targetId: "target-account",
        metadata: { id, password: "must-not-persist" },
        ipHash: actorUserId ? IP_HASH : null,
        userAgentHash: actorUserId ? USER_AGENT_HASH : null,
        createdAt,
      });
    await insert("audit-a", "account_updated", "admin-1", NOW);
    await insert("audit-c", "account_updated", "admin-1", NOW);
    await insert("audit-b", "account_updated", "admin-2", NOW);
    await insert("audit-newest", "account_updated", "admin-1", LATER);
    await insert("audit-other", "session_revoked", null, LATER);

    const first = await repository.listSecurityAuditLogs({
      action: "account_updated",
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual(["audit-newest", "audit-c"]);
    expect(first.items[0]?.metadata).toEqual({ id: "audit-newest", password: "[REDACTED]" });
    const second = await repository.listSecurityAuditLogs({
      action: "account_updated",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual(["audit-b", "audit-a"]);
    expect(second.nextCursor).toBeNull();
    await expect(repository.countSecurityAuditLogs({ action: "account_updated" })).resolves.toBe(4);
    await expect(repository.countSecurityAuditLogs({ actorUserId: "admin-1" })).resolves.toBe(3);

    await repository.insertSecurityAuditLog({
      id: "audit-venue-delete",
      actorUserId: "admin-1",
      actorRole: "venue_manager",
      action: "venue_manager_delete",
      targetType: "venue_beer",
      targetId: "beer-1",
      metadata: { venueId: "venue-1", changeType: "beer" },
      ipHash: IP_HASH,
      userAgentHash: USER_AGENT_HASH,
      createdAt: LATER,
    });
    await expect(repository.countRecentVenueManagerDeletes({
      venueId: "venue-1",
      since: NOW,
    })).resolves.toBe(1);
    await expect(repository.countRecentVenueManagerDeletes({
      venueId: "venue-1",
      since: NOW,
      changeType: "happy_hour",
    })).resolves.toBe(0);

    await expect(insert("audit-a", "account_updated", "admin-1", NOW))
      .resolves.toMatchObject({ outcome: "duplicate" });
    await expect(repository.insertSecurityAuditLog({
      id: "audit-a",
      actorUserId: "admin-1",
      actorRole: "admin",
      action: "different_action",
      targetType: "account",
      targetId: "target-account",
      metadata: {},
      ipHash: IP_HASH,
      userAgentHash: USER_AGENT_HASH,
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("audit_conflict"));
  });

  it("rejects malformed actors, cursors, metadata, timestamps, and unbounded pages", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "validation-user");
    await expect(repository.createUserActivityEvent({
      id: "invalid-related",
      userId: "validation-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: null,
      metadata: {},
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createUserActivityEvent({
      id: "invalid-metadata",
      userId: "validation-user",
      eventType: "user_login",
      relatedEntityType: null,
      relatedEntityId: null,
      metadata: { impossible: 1n } as unknown as Record<string, unknown>,
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.recordEvent({
      id: "oversized-metadata",
      userId: null,
      anonymousSessionId: null,
      eventType: "map_viewed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { value: "x".repeat(40_000) },
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.recordEvent({
      id: "oversized-secret-metadata",
      userId: null,
      anonymousSessionId: null,
      eventType: "map_viewed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { password: "x".repeat(40_000) },
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.insertSecurityAuditLog({
      id: "invalid-actor",
      actorUserId: null,
      actorRole: "admin",
      action: "account_updated",
      targetType: "account",
      targetId: "target",
      metadata: {},
      ipHash: "not-a-hash",
      userAgentHash: null,
      createdAt: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.listUserActivityEvents({ userId: "validation-user", limit: 0 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.listSecurityAuditLogs({
      limit: 1,
      cursor: { createdAt: "not-a-timestamp", id: "cursor" },
    })).rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("fails closed on malformed stored JSON and timestamps", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "malformed-user");
    raw.prepare(
      `INSERT INTO user_activity_events (
         id, user_id, event_type, related_entity_type, related_entity_id, metadata_json, created_at
       ) VALUES ('malformed-json', 'malformed-user', 'user_login', NULL, NULL, '[]', ?)`,
    ).run(NOW);
    await expect(repository.getUserActivityEventById("malformed-json"))
      .rejects.toSatisfy(expectCode("stored_record_invalid"));
    raw.prepare(
      `INSERT INTO user_activity_events (
         id, user_id, event_type, related_entity_type, related_entity_id, metadata_json, created_at
       ) VALUES ('malformed-time', 'malformed-user', 'user_login', NULL, NULL, '{}', 'yesterday')`,
    ).run();
    await expect(repository.getUserActivityEventById("malformed-time"))
      .rejects.toSatisfy(expectCode("stored_record_invalid"));
  });

  it("rolls back an accepted insert when a later database step fails, then retries safely", async () => {
    const { raw, database, repository } = fixture();
    insertAccount(raw, "rollback-user");
    const faultRepository = new ActivityAuditRepository(new PostInsertFaultDatabase(database));
    const input = {
      id: "rollback-activity",
      userId: "rollback-user",
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: "rollback-user",
      metadata: {},
      createdAt: NOW,
    };
    await expect(faultRepository.createUserActivityEvent(input))
      .rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getUserActivityEventById(input.id)).resolves.toBeNull();
    await expect(repository.createUserActivityEvent(input)).resolves.toMatchObject({ outcome: "inserted" });
    expect(raw.prepare("SELECT count(*) AS count FROM user_activity_events WHERE id = ?").get(input.id))
      .toEqual({ count: 1 });
  });
});
