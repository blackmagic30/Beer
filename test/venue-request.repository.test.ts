import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  VENUE_REQUEST_LOCK_CONTRACT,
  VenueRequestRepository,
  VenueRequestRepositoryError,
  venueRequestAccountLockKey,
  type CreateOrGetVenueRequestInput,
  type VenueRequestRepositoryErrorCode,
} from "../src/db/venue-request.repository.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const T0 = "2026-08-08T12:00:00.000Z";
const T1 = "2026-08-08T12:05:00.000Z";
const T2 = "2026-08-08T12:10:00.000Z";
const T3 = "2026-08-08T12:15:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenueRequestRepository;
}

function fixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new VenueRequestRepository(database) };
}

function requestInput(
  overrides: Partial<CreateOrGetVenueRequestInput> = {},
): CreateOrGetVenueRequestInput {
  return {
    id: "request-a",
    userId: null,
    anonymousSessionId: "anonymous-a",
    requestType: "missing_venue",
    venueId: null,
    venueName: "Alpha Hotel",
    googlePlaceId: "google-alpha",
    beerName: null,
    suburb: "Fitzroy",
    notes: "Please add this venue.",
    now: T0,
    ...overrides,
  };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: {
    status?: "active" | "warned" | "suspended";
    authProvider?: string;
    role?: "user" | "admin";
    subscriptionStatus?: string;
  } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.test`,
    options.authProvider ?? "local",
    options.role ?? "user",
    options.subscriptionStatus ?? "free",
    options.status ?? "active",
    T0,
    T0,
  );
}

function insertAdmin(raw: BetterSqlite3.Database, id: string): void {
  insertAccount(raw, id, { role: "admin", subscriptionStatus: "admin" });
}

function lockDeletion(raw: BetterSqlite3.Database, userId: string, status = "processing"): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`delete-${userId}`, userId, status, T0, T1, T0, T0);
}

function expectCode(code: VenueRequestRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof VenueRequestRepositoryError && error.code === code;
}

describe("VenueRequestRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function createFixture(): Fixture {
    const created = fixture();
    databases.push(created.database);
    return created;
  }

  it("creates exact-idempotently and rejects conflicting or malformed data", async () => {
    const { raw, repository } = createFixture();
    const created = await repository.createOrGetVenueRequest(requestInput());
    expect(VENUE_REQUEST_LOCK_CONTRACT).toMatchObject({
      version: 1,
      accountPrefix: "venue-request:account:",
      requestPrefix: "venue-request:request:",
      duplicatePrefix: "venue-request:duplicate:",
    });
    expect(created).toMatchObject({ duplicate: false, ownershipPromoted: false });
    await expect(repository.createOrGetVenueRequest(requestInput())).resolves.toEqual({
      request: created.request,
      duplicate: true,
      ownershipPromoted: false,
    });
    await expect(repository.createOrGetVenueRequest(requestInput({ venueName: "Different Hotel" })))
      .rejects.toSatisfy(expectCode("request_id_conflict"));
    await expect(repository.createOrGetVenueRequest(requestInput({ now: "2026-08-08T22:00:00+10:00" })))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createOrGetVenueRequest(requestInput({
      id: "invalid-beer",
      requestType: "missing_beer",
      beerName: null,
    }))).rejects.toSatisfy(expectCode("invalid_input"));

    expect(await repository.getVenueRequestById("request-a")).toEqual(created.request);
    raw.prepare("UPDATE venue_requests SET created_at = 'not-a-timestamp' WHERE id = 'request-a'").run();
    await expect(repository.getVenueRequestById("request-a"))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("preserves 255-character identities and bounds request-derived mission venue IDs", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    const requestId = "r".repeat(255);
    const missionId = "m".repeat(255);
    expect(venueRequestAccountLockKey("a".repeat(255)))
      .toBe(`venue-request:account:${"a".repeat(255)}`);
    const request = (await repository.createOrGetVenueRequest(requestInput({
      id: requestId,
      googlePlaceId: "google-long-request",
    }))).request;
    expect(request.id).toBe(requestId);
    const created = await repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId,
      missionId,
      expectedRequestUpdatedAt: request.updatedAt,
      now: T1,
    });
    expect(created.mission.id).toBe(missionId);
    expect(created.mission.venueId).toMatch(/^request:[a-f0-9]{64}$/);
    expect(created.mission.venueId.length).toBeLessThanOrEqual(255);
    await expect(repository.getVenueRequestById("r".repeat(256)))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("fences same-owner Google duplicates atomically under contention", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "owner-a");
    const inputs = ["request-a", "request-b", "request-c"].map((id) => requestInput({
      id,
      userId: "owner-a",
      anonymousSessionId: "anonymous-a",
    }));
    const results = await Promise.all(inputs.map((input) => repository.createOrGetVenueRequest(input)));
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(new Set(results.map((result) => result.request.id))).toEqual(new Set(["request-a"]));
    expect(raw.prepare(
      `SELECT count(*) AS count FROM venue_requests
        WHERE user_id = 'owner-a' AND google_place_id = 'google-alpha'`,
    ).get()).toEqual({ count: 1 });
  });

  it("promotes an anonymous duplicate to its authenticated account without replacing it", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "owner-a");
    const anonymous = await repository.createOrGetVenueRequest(requestInput());
    const promoted = await repository.createOrGetVenueRequest(requestInput({
      id: "authenticated-retry",
      userId: "owner-a",
      now: T1,
    }));
    expect(promoted).toMatchObject({
      duplicate: true,
      ownershipPromoted: true,
      request: { id: anonymous.request.id, userId: "owner-a", updatedAt: T1 },
    });
    const replay = await repository.createOrGetVenueRequest(requestInput({
      id: "another-retry",
      userId: "owner-a",
      anonymousSessionId: null,
      now: T2,
    }));
    expect(replay).toMatchObject({
      duplicate: true,
      ownershipPromoted: false,
      request: { id: anonymous.request.id, userId: "owner-a", updatedAt: T1 },
    });
    expect(raw.prepare("SELECT count(*) AS count FROM venue_requests").get()).toEqual({ count: 1 });
  });

  it("enforces account status and deletion fences on authenticated creation", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "warned", { status: "warned" });
    insertAccount(raw, "suspended", { status: "suspended" });
    insertAccount(raw, "deleted", { authProvider: "deleted" });
    insertAccount(raw, "deletion-locked");
    lockDeletion(raw, "deletion-locked");

    await expect(repository.createOrGetVenueRequest(requestInput({ id: "warned", userId: "warned" })))
      .resolves.toMatchObject({ duplicate: false });
    await expect(repository.createOrGetVenueRequest(requestInput({ id: "missing", userId: "missing" })))
      .rejects.toSatisfy(expectCode("account_not_found"));
    await expect(repository.createOrGetVenueRequest(requestInput({ id: "suspended", userId: "suspended" })))
      .rejects.toSatisfy(expectCode("account_not_eligible"));
    await expect(repository.createOrGetVenueRequest(requestInput({ id: "deleted", userId: "deleted" })))
      .rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.createOrGetVenueRequest(requestInput({
      id: "deletion-locked",
      userId: "deletion-locked",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
    expect(raw.prepare("SELECT count(*) AS count FROM venue_requests").get()).toEqual({ count: 1 });
  });

  it("lists and counts with bounded deterministic keyset pagination", async () => {
    const { repository } = createFixture();
    await repository.createOrGetVenueRequest(requestInput({ id: "request-b" }));
    await repository.createOrGetVenueRequest(requestInput({
      id: "request-a",
      googlePlaceId: "google-beta",
      venueName: "Beta Hotel",
    }));
    await repository.createOrGetVenueRequest(requestInput({
      id: "request-c",
      requestType: "missing_beer",
      googlePlaceId: null,
      venueName: null,
      beerName: "Pale Ale",
      now: T1,
    }));

    const first = await repository.listVenueRequests({ limit: 2 });
    expect(first.requests.map((request) => request.id)).toEqual(["request-c", "request-a"]);
    expect(first.nextCursor).toEqual({ createdAt: T0, id: "request-a" });
    const second = await repository.listVenueRequests({ limit: 2, cursor: first.nextCursor });
    expect(second.requests.map((request) => request.id)).toEqual(["request-b"]);
    expect(second.nextCursor).toBeNull();
    expect(await repository.countVenueRequests()).toBe(3);
    expect(await repository.countVenueRequests({ requestType: "missing_venue", status: "open" })).toBe(2);
    await expect(repository.listVenueRequests({ limit: 101 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.countVenueRequests({ status: "bad" as "open" }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("applies admin-only OCC trust transitions and fences mission-owned rows", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    insertAdmin(raw, "admin-b");
    insertAdmin(raw, "admin-deletion");
    lockDeletion(raw, "admin-deletion");
    insertAccount(raw, "ordinary");
    const created = (await repository.createOrGetVenueRequest(requestInput())).request;

    const assigned = await repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: created.id,
      status: "in_progress",
      assignedTo: "admin-b",
      resolutionNote: "Reviewing source details.",
      expectedUpdatedAt: created.updatedAt,
      now: T1,
    });
    expect(assigned).toMatchObject({ status: "in_progress", assignedTo: "admin-b", updatedAt: T1 });
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: created.id,
      status: "resolved",
      assignedTo: "admin-b",
      resolutionNote: "Done.",
      expectedUpdatedAt: created.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("request_version_conflict"));
    const resolved = await repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: created.id,
      status: "resolved",
      assignedTo: "admin-b",
      resolutionNote: "Done.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionNote: "Done.",
      resolvedAt: T2,
      resolvedBy: "admin-a",
    });
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: created.id,
      status: "resolved",
      assignedTo: "admin-b",
      resolutionNote: "Done.",
      expectedUpdatedAt: resolved.updatedAt,
      now: T3,
    })).resolves.toEqual(resolved);
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-deletion",
      requestId: created.id,
      status: "open",
      assignedTo: null,
      resolutionNote: null,
      expectedUpdatedAt: resolved.updatedAt,
      now: T3,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "ordinary",
      requestId: created.id,
      status: "open",
      assignedTo: null,
      resolutionNote: null,
      expectedUpdatedAt: resolved.updatedAt,
      now: T3,
    })).rejects.toSatisfy(expectCode("admin_not_authorized"));

    const missionRequest = (await repository.createOrGetVenueRequest(requestInput({
      id: "mission-request",
      googlePlaceId: "google-mission",
      now: T1,
    }))).request;
    const missionResult = await repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId: missionRequest.id,
      missionId: "mission-a",
      expectedRequestUpdatedAt: missionRequest.updatedAt,
      now: T2,
    });
    await expect(repository.updateTrustWorkflow({
      actorAccountId: "admin-a",
      requestId: missionRequest.id,
      status: "resolved",
      assignedTo: null,
      resolutionNote: "Must use submission authority.",
      expectedUpdatedAt: missionResult.request.updatedAt,
      now: T3,
    })).rejects.toSatisfy(expectCode("request_state_conflict"));
  });

  it("creates a mission and claims its request in one transaction under contention", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    insertAdmin(raw, "admin-b");
    const request = (await repository.createOrGetVenueRequest(requestInput({
      requestType: "verify_beer_at_venue",
      venueId: "venue-a",
      googlePlaceId: null,
      beerName: "Pale Ale",
    }))).request;

    const attempts = await Promise.allSettled([
      repository.createMissionFromVenueRequest({
        actorAccountId: "admin-a",
        requestId: request.id,
        missionId: "mission-a",
        expectedRequestUpdatedAt: request.updatedAt,
        now: T1,
      }),
      repository.createMissionFromVenueRequest({
        actorAccountId: "admin-b",
        requestId: request.id,
        missionId: "mission-b",
        expectedRequestUpdatedAt: request.updatedAt,
        now: T1,
      }),
    ]);
    const winners = attempts.filter((result) => result.status === "fulfilled");
    const losers = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toSatisfy((error: unknown) =>
      expectCode("request_version_conflict")(error) || expectCode("request_state_conflict")(error));
    const winner = winners[0]!.value;
    expect(winner.request).toMatchObject({ status: "mission_created", missionId: winner.mission.id });
    expect(winner.mission).toMatchObject({
      venueId: "venue-a",
      venueName: "Alpha Hotel",
      reason: "verify beer at venue",
      priority: "normal",
      points: 2,
      multiplier: 1,
      active: true,
      sponsorFlag: false,
    });
    expect(raw.prepare("SELECT count(*) AS count FROM missions").get()).toEqual({ count: 1 });
  });

  it("rolls back mission insertion on ID conflict and downstream request-claim failure", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    const first = (await repository.createOrGetVenueRequest(requestInput())).request;
    raw.prepare(
      `INSERT INTO missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES ('occupied', 'venue-x', 'Existing', 'existing', 'normal', 4, 1, 1, 0, ?, ?)`,
    ).run(T0, T0);
    await expect(repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId: first.id,
      missionId: "occupied",
      expectedRequestUpdatedAt: first.updatedAt,
      now: T1,
    })).rejects.toSatisfy(expectCode("mission_id_conflict"));
    expect(await repository.getVenueRequestById(first.id)).toMatchObject({ status: "open", missionId: null });

    const rollbackRequest = (await repository.createOrGetVenueRequest(requestInput({
      id: "rollback-request",
      googlePlaceId: "google-rollback",
    }))).request;
    raw.exec(
      `CREATE TRIGGER fail_venue_request_claim
       BEFORE UPDATE ON venue_requests
       WHEN NEW.id = 'rollback-request'
       BEGIN
         SELECT RAISE(ABORT, 'forced rollback');
       END`,
    );
    await expect(repository.createMissionFromVenueRequest({
      actorAccountId: "admin-a",
      requestId: rollbackRequest.id,
      missionId: "rolled-back-mission",
      expectedRequestUpdatedAt: rollbackRequest.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    expect(raw.prepare("SELECT count(*) AS count FROM missions WHERE id = 'rolled-back-mission'").get())
      .toEqual({ count: 0 });
    expect(await repository.getVenueRequestById(rollbackRequest.id))
      .toMatchObject({ status: "open", missionId: null, updatedAt: T0 });
  });
});
