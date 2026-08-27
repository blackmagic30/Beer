import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  SupportFeedbackRepository,
  SupportFeedbackRepositoryError,
} from "../src/db/support-feedback.repository.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const NOW = "2026-08-08T18:00:00.000Z";
const LATER = "2026-08-08T18:01:00.000Z";
const LATEST = "2026-08-08T18:02:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: SupportFeedbackRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new SupportFeedbackRepository(database) };
}

function insertAccount(raw: BetterSqlite3.Database, id: string, role = "user"): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, role, subscription_status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, 'free', ?, ?)`,
  ).run(id, `${id}@example.test`, role, NOW, NOW);
}

function insertPrice(raw: BetterSqlite3.Database, id: string, confidence = "community_confirmed"): void {
  raw.prepare(
    `INSERT INTO venue_price_records (
       id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
       serving_size, price, is_happy_hour_price, is_on_tap, confidence,
       source_type, last_verified_at, created_at, updated_at
     ) VALUES (?, 'venue-one', 'Venue One', 'Fitzroy', 'Carlton Draught',
               'carlton_draft', 'pint', 12.5, 0, 'yes', ?, 'community_verified', ?, ?, ?)`,
  ).run(id, confidence, NOW, NOW, NOW);
}

function insertManagerPrice(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO venue_profiles (venue_id, name, suburb, active, created_at, updated_at)
     VALUES ('venue-manager', 'Manager Venue', 'Fitzroy', 1, ?, ?)`,
  ).run(NOW, NOW);
  raw.prepare(
    `INSERT INTO venue_beers (
       id, venue_id, beer_name, normalized_beer_id, serve_size, price,
       on_tap, in_stock, price_verified_at, created_at, updated_at
     ) VALUES (?, 'venue-manager', 'Guinness', 'guinness', 'pint', 12,
               1, 1, ?, ?, ?)`,
  ).run(id, NOW, NOW, NOW);
}

function expectCode(code: SupportFeedbackRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SupportFeedbackRepositoryError && error.code === code;
}

class PostInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  private failed = false;

  constructor(private readonly delegate: AsyncSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings) => {
        const result = await statement.run(...bindings);
        if (!this.failed && /INSERT\s+INTO\s+wrong_price_reports/i.test(sql)) {
          this.failed = true;
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
    // The fixture owns the delegate.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("SupportFeedbackRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("creates exact-idempotent feedback and rejects mismatched or missing-account writes", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "feedback-user");
    const input = {
      id: "feedback-idempotent",
      userId: "feedback-user",
      anonymousSessionId: null,
      feedbackType: "security_report" as const,
      message: "Please review this report.",
      venueId: "venue-one",
      venueName: "Venue One",
      contactEmail: "USER@EXAMPLE.TEST",
      priority: "high" as const,
      triageReason: "Security review.",
      now: NOW,
    };
    const first = await repository.createFeedback(input);
    const replay = await repository.createFeedback(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      contactEmail: "user@example.test",
      status: "open",
      assignedTo: null,
      createdAt: NOW,
    });
    expect(raw.prepare("SELECT count(*) AS count FROM feedback").get()).toEqual({ count: 1 });

    await expect(repository.createFeedback({ ...input, message: "Different data." }))
      .rejects.toSatisfy(expectCode("feedback_conflict"));
    await expect(repository.createFeedback({ ...input, id: "missing-account", userId: "absent" }))
      .rejects.toSatisfy(expectCode("account_not_found"));
    await expect(repository.createFeedback({ ...input, id: "bad-time", now: "2026-08-08" }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("orders feedback deterministically by priority and time and returns exact counts", async () => {
    const { repository } = fixture();
    const create = (id: string, priority: "low" | "normal" | "medium" | "high", now: string) =>
      repository.createFeedback({
        id,
        userId: null,
        anonymousSessionId: `anon-${id}`,
        feedbackType: "general_feedback",
        message: `Feedback ${id}`,
        venueId: null,
        venueName: null,
        contactEmail: null,
        priority,
        triageReason: null,
        now,
      });
    await create("low", "low", LATEST);
    await create("high-a", "high", NOW);
    await create("normal", "normal", LATEST);
    await create("high-b", "high", NOW);
    await create("medium", "medium", LATER);

    await expect(repository.listFeedback({ limit: 3 })).resolves.toMatchObject([
      { id: "high-b" },
      { id: "high-a" },
      { id: "medium" },
    ]);
    await expect(repository.listFeedback({ limit: 2, offset: 3 })).resolves.toMatchObject([
      { id: "normal" },
      { id: "low" },
    ]);
    await expect(repository.countFeedback()).resolves.toBe(5);
    await expect(repository.listFeedback({ limit: 0 })).rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("serializes duplicate wrong-price reports and disputes only after two distinct users", async () => {
    const { raw, repository } = fixture();
    insertPrice(raw, "price-one");
    insertAccount(raw, "reporter-one");
    insertAccount(raw, "reporter-two");
    const make = (id: string, userId: string) => repository.createWrongPriceReport({
      id,
      userId,
      anonymousSessionId: null,
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "price-one",
      beerName: "Carlton Draught",
      reason: "price_changed",
      notes: null,
      sourcePhotoUrl: null,
      now: id === "report-two" ? LATER : NOW,
    });

    const duplicateRace = await Promise.all([make("report-one", "reporter-one"), make("report-one-race", "reporter-one")]);
    expect(duplicateRace.filter((result) => result.duplicate)).toHaveLength(1);
    expect(duplicateRace.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(raw.prepare("SELECT confidence FROM venue_price_records WHERE id = 'price-one'").get())
      .toEqual({ confidence: "community_confirmed" });

    const second = await make("report-two", "reporter-two");
    expect(second).toMatchObject({ duplicate: false, markedDisputed: true });
    expect(raw.prepare("SELECT confidence, updated_at FROM venue_price_records WHERE id = 'price-one'").get())
      .toEqual({ confidence: "disputed", updated_at: LATER });
    await expect(repository.countWrongPriceReports()).resolves.toBe(2);
    await expect(repository.listWrongPriceReports({ limit: 10 })).resolves.toMatchObject([
      { id: "report-two" },
      { id: "report-one" },
    ]);
  });

  it("binds manager-price reports to venue_beers, deduplicates, and never mutates trust", async () => {
    const { raw, repository } = fixture();
    insertManagerPrice(raw, "manager-beer-one");
    insertAccount(raw, "manager-reporter-one");
    insertAccount(raw, "manager-reporter-two");
    const common = {
      venueId: "venue-manager",
      venueName: "Manager Venue",
      priceRecordId: "bar_beer:manager-beer-one",
      beerName: "Guinness",
      reason: "price_changed" as const,
      notes: null,
      sourcePhotoUrl: null,
      now: NOW,
    };

    const race = await Promise.all([
      repository.createWrongPriceReport({
        ...common,
        id: "manager-report-a",
        userId: "manager-reporter-one",
        anonymousSessionId: null,
      }),
      repository.createWrongPriceReport({
        ...common,
        id: "manager-report-b",
        userId: "manager-reporter-one",
        anonymousSessionId: null,
      }),
    ]);
    expect(race.filter((result) => result.duplicate)).toHaveLength(1);
    expect(race.filter((result) => !result.duplicate)).toHaveLength(1);
    const second = await repository.createWrongPriceReport({
      ...common,
      id: "manager-report-second",
      userId: "manager-reporter-two",
      anonymousSessionId: null,
      now: LATER,
    });
    expect(second).toMatchObject({ duplicate: false, markedDisputed: false });
    expect(raw.prepare(
      `SELECT count(*) AS count,
              min(price_record_id) AS priceRecordId
         FROM wrong_price_reports
        WHERE venue_id = 'venue-manager' AND beer_name = 'Guinness' AND reason = 'price_changed'`,
    ).get()).toEqual({ count: 2, priceRecordId: null });
    await expect(repository.listWrongPriceReports({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        id: "manager-report-second",
        priceRecordId: null,
      }),
      expect.objectContaining({ priceRecordId: null }),
    ]);
    await expect(repository.createWrongPriceReport({
      ...common,
      id: "missing-manager-report",
      userId: "manager-reporter-one",
      anonymousSessionId: null,
      priceRecordId: "bar_beer:missing-manager-beer",
    })).rejects.toSatisfy(expectCode("price_record_not_found"));
  });

  it("deduplicates anonymous reporters, keeps venue-confirmed prices authoritative, and checks references", async () => {
    const { raw, repository } = fixture();
    insertPrice(raw, "price-confirmed", "venue_confirmed");
    insertAccount(raw, "first-user");
    insertAccount(raw, "second-user");
    const common = {
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "price-confirmed",
      beerName: "Carlton Draught",
      reason: "beer_not_available" as const,
      notes: "No longer on tap.",
      sourcePhotoUrl: "evidence://wrong-price/example",
      now: NOW,
    };
    await repository.createWrongPriceReport({
      ...common,
      id: "anonymous-one",
      userId: null,
      anonymousSessionId: "anonymous-session",
    });
    await expect(repository.createWrongPriceReport({
      ...common,
      id: "anonymous-two",
      userId: null,
      anonymousSessionId: "anonymous-session",
    })).resolves.toMatchObject({ duplicate: true });
    await repository.createWrongPriceReport({ ...common, id: "user-one", userId: "first-user", anonymousSessionId: null });
    const second = await repository.createWrongPriceReport({
      ...common,
      id: "user-two",
      userId: "second-user",
      anonymousSessionId: null,
      now: LATER,
    });
    expect(second.markedDisputed).toBe(false);
    expect(raw.prepare("SELECT confidence FROM venue_price_records WHERE id = 'price-confirmed'").get())
      .toEqual({ confidence: "venue_confirmed" });

    await expect(repository.createWrongPriceReport({
      ...common,
      id: "no-identity",
      userId: null,
      anonymousSessionId: null,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createWrongPriceReport({
      ...common,
      id: "missing-price",
      userId: "first-user",
      anonymousSessionId: null,
      priceRecordId: "absent",
    })).rejects.toSatisfy(expectCode("price_record_not_found"));
  });

  it("updates feedback and wrong-price workflow records with monotonic optimistic concurrency", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin-one", "admin");
    insertAccount(raw, "admin-two", "admin");
    insertPrice(raw, "workflow-price");
    await repository.createFeedback({
      id: "workflow-feedback",
      userId: null,
      anonymousSessionId: "anon-feedback",
      feedbackType: "bug",
      message: "The filter is broken.",
      venueId: null,
      venueName: null,
      contactEmail: null,
      priority: "normal",
      triageReason: null,
      now: NOW,
    });
    await repository.createWrongPriceReport({
      id: "workflow-report",
      userId: null,
      anonymousSessionId: "anon-report",
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "workflow-price",
      beerName: "Carlton Draught",
      reason: "other",
      notes: null,
      sourcePhotoUrl: null,
      now: NOW,
    });

    const assigned = await repository.updateFeedbackWorkflow({
      id: "workflow-feedback",
      status: "in_progress",
      assignedTo: "admin-two",
      resolutionNote: "Investigating.",
      resolvedBy: "admin-one",
      expectedUpdatedAt: NOW,
      now: LATER,
    });
    expect(assigned).toMatchObject({
      state: "updated",
      item: { assignedTo: "admin-two", resolvedAt: null, resolvedBy: null, updatedAt: LATER },
    });
    await expect(repository.updateFeedbackWorkflow({
      id: "workflow-feedback",
      status: "resolved",
      assignedTo: "admin-two",
      resolutionNote: "Fixed.",
      resolvedBy: "admin-one",
      expectedUpdatedAt: NOW,
      now: LATEST,
    })).resolves.toEqual({ state: "conflict" });
    await expect(repository.updateWrongPriceWorkflow({
      id: "workflow-report",
      status: "resolved",
      assignedTo: null,
      resolutionNote: "Venue confirmed the new price.",
      resolvedBy: "admin-one",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).resolves.toMatchObject({
      state: "updated",
      item: { status: "resolved", resolvedAt: LATER, resolvedBy: "admin-one" },
    });
    await expect(repository.updateFeedbackWorkflow({
      id: "absent",
      status: "open",
      assignedTo: null,
      resolutionNote: null,
      resolvedBy: "admin-one",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).resolves.toEqual({ state: "not_found" });
    await expect(repository.updateFeedbackWorkflow({
      id: "workflow-feedback",
      status: "open",
      assignedTo: "missing-admin",
      resolutionNote: null,
      resolvedBy: "admin-one",
      expectedUpdatedAt: LATER,
      now: LATEST,
    })).rejects.toSatisfy(expectCode("account_not_found"));
  });

  it("rolls back a wrong-price insert and confidence mutation when persistence fails", async () => {
    const { raw, database } = fixture();
    insertAccount(raw, "rollback-user");
    insertPrice(raw, "rollback-price");
    const repository = new SupportFeedbackRepository(new PostInsertFaultDatabase(database));
    await expect(repository.createWrongPriceReport({
      id: "rollback-report",
      userId: "rollback-user",
      anonymousSessionId: null,
      venueId: "venue-one",
      venueName: "Venue One",
      priceRecordId: "rollback-price",
      beerName: "Carlton Draught",
      reason: "price_changed",
      notes: null,
      sourcePhotoUrl: null,
      now: NOW,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    expect(raw.prepare("SELECT count(*) AS count FROM wrong_price_reports").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT confidence FROM venue_price_records WHERE id = 'rollback-price'").get())
      .toEqual({ confidence: "community_confirmed" });
  });

  it("fails closed when stored enum or timestamp data is invalid", async () => {
    const { raw, repository } = fixture();
    raw.prepare(
      `INSERT INTO feedback (
         id, feedback_type, message, status, priority, created_at, updated_at
       ) VALUES ('invalid-stored', 'bug', 'Stored issue', 'open', 'urgent', ?, ?)`,
    ).run(NOW, NOW);
    await expect(repository.listFeedback({ limit: 10 })).rejects.toSatisfy(expectCode("stored_record_invalid"));
  });
});
