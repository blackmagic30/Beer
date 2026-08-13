import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  VENUE_MANAGER_INTERNAL_SUBMISSION_LOCK_CONTRACT,
  VenueManagerInternalSubmissionRepository,
  VenueManagerInternalSubmissionRepositoryError,
  type CreateVenueManagerInternalSubmissionInput,
} from "../src/db/venue-manager-internal-submission.repository.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const NOW = "2026-08-09T10:00:00.000Z";
const OBSERVED_AT = "2026-08-09T09:00:00.000Z";
const ACCEPTED_AT = "2026-08-09T08:00:00.000Z";
const ACCEPTED_AFTER = "2026-08-08T10:00:00.000Z";
const MISSION_UPDATED_AT = "2026-08-09T07:00:00.000Z";
const RETENTION_EXPIRES_AT = "2026-11-07T00:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenueManagerInternalSubmissionRepository;
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: { role?: string; status?: string; authProvider?: string } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, ?, 'free', ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.test`,
    options.authProvider ?? "local",
    options.role ?? "venue_manager",
    options.status ?? "active",
    NOW,
    NOW,
  );
}

function insertAssignment(
  raw: BetterSqlite3.Database,
  options: {
    id?: string;
    userId?: string;
    venueId?: string;
    accessLevel?: string;
    status?: string;
  } = {},
): void {
  raw.prepare(
    `INSERT INTO venue_manager_assignments (
       id, user_id, venue_id, venue_name, suburb, access_level, status,
       approved_by, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'Internal Hotel', 'Fitzroy', ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    options.id ?? "assignment-manager",
    options.userId ?? "manager",
    options.venueId ?? "venue-internal",
    options.accessLevel ?? "manager",
    options.status ?? "active",
    NOW,
    NOW,
  );
}

function insertEvidence(
  raw: BetterSqlite3.Database,
  id: string,
  options: { ownerUserId?: string | null; deletedAt?: string | null; retentionExpiresAt?: string | null } = {},
): void {
  raw.prepare(
    `INSERT INTO source_evidence_objects (
       id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
       data_base64, external_url, retention_expires_at, deleted_at, created_at
     ) VALUES (?, ?, 'sqlite_private', ?, 'image/jpeg', 4, 'dGVzdA==', NULL, ?, ?, ?)`,
  ).run(
    id,
    options.ownerUserId === undefined ? "manager" : options.ownerUserId,
    `evidence/${id}`,
    options.retentionExpiresAt === undefined ? RETENTION_EXPIRES_AT : options.retentionExpiresAt,
    options.deletedAt ?? null,
    OBSERVED_AT,
  );
}

function insertMission(
  raw: BetterSqlite3.Database,
  options: {
    id?: string;
    venueId?: string;
    reason?: string;
    active?: boolean;
    status?: string;
    submissionId?: string | null;
    progressUpdatedAt?: string;
  } = {},
): void {
  const id = options.id ?? "mission-happy-hour";
  raw.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
       active, sponsor_flag, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, 'Internal Hotel', 'Fitzroy', ?, 'normal', 10, 1, ?, 0, NULL, ?, ?)`,
  ).run(
    id,
    options.venueId ?? "venue-internal",
    options.reason ?? "Missing happy-hour details",
    options.active === false ? 0 : 1,
    MISSION_UPDATED_AT,
    MISSION_UPDATED_AT,
  );
  const status = options.status ?? "accepted";
  raw.prepare(
    `INSERT INTO mission_progress (
       id, mission_id, user_id, submission_id, status, accepted_at,
       submitted_at, completed_at, updated_at
     ) VALUES (?, ?, 'manager', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `progress-${id}`,
    id,
    options.submissionId ?? null,
    status,
    ACCEPTED_AT,
    status === "submitted" ? NOW : null,
    status === "completed" ? NOW : null,
    options.progressUpdatedAt ?? ACCEPTED_AT,
  );
}

function input(
  overrides: Partial<CreateVenueManagerInternalSubmissionInput> = {},
): CreateVenueManagerInternalSubmissionInput {
  const id = overrides.id ?? "internal-submission";
  return {
    id,
    clientSubmissionId: "client-internal-001",
    managerAccountId: "manager",
    managerAssignmentId: "assignment-manager",
    venueId: "venue-internal",
    venueName: "Internal Hotel",
    suburb: "Fitzroy",
    submissionType: "happy_hour_update",
    observedAt: OBSERVED_AT,
    evidenceIds: ["evidence-b", "evidence-a"],
    ocrStatus: "processed",
    ocrSummary: {
      model: "fixture-model",
      imageCount: 2,
      extractedRowCount: 2,
      rejectedCandidateCount: 0,
      pendingCatalogCount: 0,
      message: "Internal review only.",
    },
    notes: "Venue manager submitted update.",
    location: {
      latitude: -37.798,
      longitude: 144.978,
      accuracyMeters: 15,
      capturedAt: OBSERVED_AT,
      distanceToVenueMeters: 18,
    },
    pendingVenue: {
      googlePlaceId: "place-internal",
      name: "Internal Hotel",
      address: "1 Test Street",
      suburb: "Fitzroy",
      state: "VIC",
      postcode: "3065",
      phone: null,
      website: "https://example.test/venue",
      latitude: -37.798,
      longitude: 144.978,
    },
    mission: null,
    items: [{
      id: `${id}:item:0`,
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draught",
      servingSize: "pint",
      price: 9.5,
      isHappyHourPrice: true,
      happyHourDetails: "Weekdays 5pm-7pm",
      isOnTap: "yes",
      confidence: 0.72,
      captureSource: "manual",
      sourceText: null,
      requiresCatalogApproval: false,
    }, {
      id: `${id}:item:1`,
      beerName: "House lager special",
      normalizedBeerId: null,
      servingSize: "schooner",
      price: null,
      isHappyHourPrice: false,
      happyHourDetails: "Two-for-one until 6pm",
      isOnTap: "unknown",
      confidence: 0.52,
      captureSource: "photo_ocr",
      sourceText: "2 for 1 house lager",
      requiresCatalogApproval: false,
    }],
    safety: {
      internalOnly: true,
      publicationEligible: false,
      rewardEligible: false,
      pointsAwarded: 0,
    },
    now: NOW,
    ...overrides,
  };
}

function missionInput(
  overrides: Partial<CreateVenueManagerInternalSubmissionInput> = {},
): CreateVenueManagerInternalSubmissionInput {
  return input({
    mission: {
      id: "mission-happy-hour",
      progressId: "progress-mission-happy-hour",
      expectedMissionUpdatedAt: MISSION_UPDATED_AT,
      expectedProgressUpdatedAt: ACCEPTED_AT,
      acceptedAfter: ACCEPTED_AFTER,
    },
    ...overrides,
  });
}

function expectCode(
  code: VenueManagerInternalSubmissionRepositoryError["code"],
): (error: unknown) => boolean {
  return (error) => error instanceof VenueManagerInternalSubmissionRepositoryError && error.code === code;
}

class ItemInsertFaultDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  private armed = true;

  constructor(private readonly delegate: AsyncSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings: unknown[]) => {
        const result = await statement.run(...bindings);
        if (this.armed && /INSERT\s+INTO\s+submission_items/i.test(sql)) {
          this.armed = false;
          throw new Error("injected private SQLite detail");
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
    // The fixture owns the shared connection.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("VenueManagerInternalSubmissionRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    insertAccount(raw, "manager");
    insertAccount(raw, "other-manager");
    insertAssignment(raw);
    insertEvidence(raw, "evidence-a");
    insertEvidence(raw, "evidence-b");
    const database = new AsyncSqliteDatabase(raw);
    const created = {
      raw,
      database,
      repository: new VenueManagerInternalSubmissionRepository(database),
    };
    databases.push(database);
    return created;
  }

  it("exports a frozen shared-lock order and records only an internal pending happy-hour submission", async () => {
    expect(VENUE_MANAGER_INTERNAL_SUBMISSION_LOCK_CONTRACT).toEqual(expect.objectContaining({
      version: 1,
      internalOnly: true,
      keyOrder: "distinct-lexicographic-ascending",
      hashFunction: "pg_catalog.hashtext",
      lockFunction: "pg_catalog.pg_advisory_xact_lock",
      sharedVersions: { venueAccess: 1, sourceEvidence: 1, missionLifecycle: 1 },
    }));
    expect(Object.isFrozen(VENUE_MANAGER_INTERNAL_SUBMISSION_LOCK_CONTRACT)).toBe(true);
    expect(Object.isFrozen(VENUE_MANAGER_INTERNAL_SUBMISSION_LOCK_CONTRACT.rowOrder)).toBe(true);

    const { raw, repository } = fixture();
    const untouchedTables = [
      "venue_price_records",
      "venue_happy_hours",
      "contribution_ledger",
      "events",
      "user_activity_events",
      "security_audit_log",
      "beer_catalog_items",
    ] as const;
    const beforeCounts = new Map(untouchedTables.map((table) => [
      table,
      raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number },
    ]));
    const result = await repository.createInternalHappyHourSubmission(input());
    expect(result).toMatchObject({
      outcome: "created",
      record: {
        submission: {
          id: "internal-submission",
          clientSubmissionId: "client-internal-001",
          status: "pending",
          submissionType: "happy_hour_update",
          pointsAwarded: 0,
          pointsEligibleByLocation: false,
          pointsEligibilityReason: "venue_manager_not_reward_eligible",
          internalOnly: true,
          sourcePhotoUrl: "private:evidence:evidence-b",
          pendingVenue: { googlePlaceId: "place-internal" },
        },
        evidenceIds: ["evidence-b", "evidence-a"],
      },
    });
    expect(result.record.items).toHaveLength(2);
    expect(result.record.items.every((item) => item.requiresCatalogApproval === false)).toBe(true);

    expect(raw.prepare(
      `SELECT status, submission_type, points_awarded, points_eligible_by_location,
              reviewed_by, reviewed_at, fraud_flagged
         FROM submissions WHERE id = ?`,
    ).get("internal-submission")).toEqual({
      status: "pending",
      submission_type: "happy_hour_update",
      points_awarded: 0,
      points_eligible_by_location: 0,
      reviewed_by: null,
      reviewed_at: null,
      fraud_flagged: 0,
    });
    expect(raw.prepare(
      "SELECT evidence_id, sort_order FROM submission_source_evidence WHERE submission_id = ? ORDER BY sort_order",
    ).all("internal-submission")).toEqual([
      { evidence_id: "evidence-b", sort_order: 0 },
      { evidence_id: "evidence-a", sort_order: 1 },
    ]);
    for (const table of untouchedTables) {
      expect(raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual(beforeCounts.get(table));
    }
  });

  it("has one concurrent winner, exact replay, and no duplicated items or evidence links", async () => {
    const { raw, repository } = fixture();
    const request = input();
    const results = await Promise.all([
      repository.createInternalHappyHourSubmission(request),
      repository.createInternalHappyHourSubmission(request),
      repository.createInternalHappyHourSubmission(request),
    ]);
    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(2);
    expect(raw.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT count(*) AS count FROM submission_items").get()).toEqual({ count: 2 });
    expect(raw.prepare("SELECT count(*) AS count FROM submission_source_evidence").get()).toEqual({ count: 2 });

    await expect(repository.createInternalHappyHourSubmission(input({ notes: "Different content" })))
      .rejects.toSatisfy(expectCode("submission_conflict"));
    const differentId = "internal-other-id";
    await expect(repository.createInternalHappyHourSubmission(input({
      id: differentId,
      items: input({ id: differentId }).items,
    }))).rejects.toSatisfy(expectCode("submission_conflict"));
  });

  it("rejects public, reward, catalogue, ordinary-beer, oversized, and malformed effects", async () => {
    const { repository } = fixture();
    await expect(repository.createInternalHappyHourSubmission(input({
      submissionType: "single_beer_price",
    } as unknown as Partial<CreateVenueManagerInternalSubmissionInput>)))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createInternalHappyHourSubmission(input({
      safety: { internalOnly: true, publicationEligible: true, rewardEligible: false, pointsAwarded: 0 },
    } as unknown as Partial<CreateVenueManagerInternalSubmissionInput>)))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createInternalHappyHourSubmission({
      ...input(),
      publication: { venuePriceRecords: ["unsafe"] },
    } as unknown as CreateVenueManagerInternalSubmissionInput))
      .rejects.toSatisfy(expectCode("invalid_input"));

    const ordinary = input().items.map((item) => ({ ...item }));
    ordinary[0] = { ...ordinary[0]!, isHappyHourPrice: false, happyHourDetails: null };
    await expect(repository.createInternalHappyHourSubmission(input({ items: ordinary })))
      .rejects.toSatisfy(expectCode("invalid_input"));
    const catalog = input().items.map((item) => ({ ...item }));
    catalog[0] = { ...catalog[0]!, requiresCatalogApproval: true } as unknown as typeof catalog[number];
    await expect(repository.createInternalHappyHourSubmission(input({ items: catalog })))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createInternalHappyHourSubmission(input({
      evidenceIds: Array.from({ length: 8 }, (_, index) => `too-many-${index}`),
    }))).rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("rechecks active manager/deletion/venue fences and owned live evidence", async () => {
    const { raw, repository } = fixture();
    await expect(repository.createInternalHappyHourSubmission(input({ venueId: "wrong-venue" })))
      .rejects.toSatisfy(expectCode("wrong_venue"));

    raw.prepare("UPDATE venue_manager_assignments SET status = 'revoked' WHERE id = 'assignment-manager'").run();
    await expect(repository.createInternalHappyHourSubmission(input()))
      .rejects.toSatisfy(expectCode("assignment_not_active"));
    raw.prepare("UPDATE venue_manager_assignments SET status = 'active' WHERE id = 'assignment-manager'").run();

    raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('delete-manager', 'manager', 'processing', ?, ?, ?, ?)`,
    ).run(NOW, RETENTION_EXPIRES_AT, NOW, NOW);
    await expect(repository.createInternalHappyHourSubmission(input()))
      .rejects.toSatisfy(expectCode("deletion_locked"));
    raw.prepare("DELETE FROM account_deletion_requests WHERE id = 'delete-manager'").run();

    insertEvidence(raw, "other-evidence", { ownerUserId: "other-manager" });
    await expect(repository.createInternalHappyHourSubmission(input({ evidenceIds: ["other-evidence"] })))
      .rejects.toSatisfy(expectCode("evidence_not_owned"));
    insertEvidence(raw, "expired-evidence", { retentionExpiresAt: OBSERVED_AT });
    await expect(repository.createInternalHappyHourSubmission(input({ evidenceIds: ["expired-evidence"] })))
      .rejects.toSatisfy(expectCode("evidence_not_live"));
    await expect(repository.createInternalHappyHourSubmission(input({ evidenceIds: ["missing-evidence"] })))
      .rejects.toSatisfy(expectCode("evidence_not_found"));
  });

  it("moves one accepted happy-hour mission to submitted exactly once and fences stale mission state", async () => {
    const { raw, repository } = fixture();
    insertMission(raw);
    const created = await repository.createInternalHappyHourSubmission(missionInput());
    expect(created.outcome).toBe("created");
    expect(raw.prepare(
      "SELECT status, submission_id, submitted_at, completed_at FROM mission_progress WHERE id = ?",
    ).get("progress-mission-happy-hour")).toEqual({
      status: "submitted",
      submission_id: "internal-submission",
      submitted_at: NOW,
      completed_at: null,
    });
    await expect(repository.createInternalHappyHourSubmission(missionInput()))
      .resolves.toMatchObject({ outcome: "replayed" });
    expect(raw.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 1 });

    const { raw: staleRaw, repository: staleRepository } = fixture();
    insertMission(staleRaw);
    await expect(staleRepository.createInternalHappyHourSubmission(missionInput({
      mission: { ...missionInput().mission!, expectedMissionUpdatedAt: NOW },
    }))).rejects.toSatisfy(expectCode("mission_stale"));
    staleRaw.prepare("UPDATE missions SET active = 0 WHERE id = 'mission-happy-hour'").run();
    await expect(staleRepository.createInternalHappyHourSubmission(missionInput()))
      .rejects.toSatisfy(expectCode("mission_inactive"));
  });

  it("rejects non-happy-hour, wrong-venue, unaccepted, completed, and expired reservations", async () => {
    const cases: Array<{
      missionOptions: Parameters<typeof insertMission>[1];
      expected: VenueManagerInternalSubmissionRepositoryError["code"];
      missionOverride?: Partial<NonNullable<CreateVenueManagerInternalSubmissionInput["mission"]>>;
    }> = [
      { missionOptions: { reason: "Missing current beer prices" }, expected: "mission_not_happy_hour" },
      { missionOptions: { venueId: "other-venue" }, expected: "mission_wrong_venue" },
      { missionOptions: { status: "cancelled" }, expected: "mission_not_accepted" },
      { missionOptions: { status: "completed" }, expected: "mission_not_accepted" },
      { missionOptions: {}, missionOverride: { acceptedAfter: NOW }, expected: "invalid_input" },
    ];
    for (const scenario of cases) {
      const { raw, repository } = fixture();
      insertMission(raw, scenario.missionOptions);
      const base = missionInput().mission!;
      await expect(repository.createInternalHappyHourSubmission(missionInput({
        mission: { ...base, ...scenario.missionOverride },
      }))).rejects.toSatisfy(expectCode(scenario.expected));
    }
  });

  it("rolls back submission, items, links, and mission progress while hiding database details", async () => {
    const { raw, database } = fixture();
    insertMission(raw);
    const faulted = new VenueManagerInternalSubmissionRepository(new ItemInsertFaultDatabase(database));
    const error = await faulted.createInternalHappyHourSubmission(missionInput()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(VenueManagerInternalSubmissionRepositoryError);
    expect(error).toMatchObject({ code: "persistence_failure" });
    expect((error as Error).message).not.toContain("private SQLite detail");
    expect(raw.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT count(*) AS count FROM submission_items").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT count(*) AS count FROM submission_source_evidence").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT status, submission_id FROM mission_progress WHERE id = ?")
      .get("progress-mission-happy-hour")).toEqual({ status: "accepted", submission_id: null });
  });

  it("fails closed on a malformed stored internal row", async () => {
    const { raw, repository } = fixture();
    await repository.createInternalHappyHourSubmission(input());
    raw.prepare("UPDATE submissions SET points_awarded = 5 WHERE id = 'internal-submission'").run();
    await expect(repository.createInternalHappyHourSubmission(input()))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });
});
