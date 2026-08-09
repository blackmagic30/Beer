import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  MissionDiscoveryAutomationRepository,
  MissionDiscoveryAutomationRepositoryError,
  MISSION_DISCOVERY_AUTOMATION_LOCK_CONTRACT,
  missionDiscoveryAutomationWriterLockKey,
  type AutoMissionDefinition,
  type MissionFeedPageInput,
} from "../src/db/mission-discovery-automation.repository.js";
import {
  MissionLifecycleRepository,
  missionLifecycleMissionLockKey,
} from "../src/db/mission-lifecycle.repository.js";
import { asAsyncSqliteDatabase, type SqlDatabase } from "../src/db/sql-database.js";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-25T00:00:00.000Z";
const T2 = "2026-07-31T00:00:00.000Z";
const T3 = "2026-08-01T00:00:00.000Z";

interface Harness {
  raw: BetterSqlite3.Database;
  database: SqlDatabase;
  repository: MissionDiscoveryAutomationRepository;
  lifecycle: MissionLifecycleRepository;
}

const harnesses: Harness[] = [];

function createHarness(): Harness {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = asAsyncSqliteDatabase(raw);
  const harness = {
    raw,
    database,
    repository: new MissionDiscoveryAutomationRepository(database),
    lifecycle: new MissionLifecycleRepository(database),
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.database.close()));
});

function expectCode(code: MissionDiscoveryAutomationRepositoryError["code"]) {
  return (error: unknown) => error instanceof MissionDiscoveryAutomationRepositoryError && error.code === code;
}

function insertAccount(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
     VALUES (?, ?, 'hash', ?, ?)`,
  ).run(id, `${id}@example.com`, T0, T0);
}

async function createMission(
  lifecycle: MissionLifecycleRepository,
  overrides: Partial<Parameters<MissionLifecycleRepository["createMission"]>[0]> = {},
) {
  const id = overrides.id ?? "manual:mission";
  return lifecycle.createMission({
    id,
    venueId: overrides.venueId ?? `${id}:venue`,
    venueName: overrides.venueName ?? `Venue ${id}`,
    suburb: overrides.suburb ?? "Melbourne",
    reason: overrides.reason ?? "Confirm current drink prices",
    priority: overrides.priority ?? "normal",
    points: overrides.points ?? 5,
    multiplier: overrides.multiplier ?? 1,
    active: overrides.active ?? true,
    sponsorFlag: overrides.sponsorFlag ?? false,
    lastVerifiedAt: overrides.lastVerifiedAt ?? null,
    createdAt: overrides.createdAt ?? T0,
    updatedAt: overrides.updatedAt ?? T0,
  });
}

function autoMission(id: string, overrides: Partial<AutoMissionDefinition> = {}): AutoMissionDefinition {
  return {
    id,
    venueId: overrides.venueId ?? `${id}:venue`,
    venueName: overrides.venueName ?? `Venue ${id}`,
    suburb: overrides.suburb ?? "Melbourne",
    reason: overrides.reason ?? "Stale drink menu - update current prices",
    priority: overrides.priority ?? "high",
    points: overrides.points ?? 10,
    multiplier: overrides.multiplier ?? 1,
    active: overrides.active ?? true,
    sponsorFlag: overrides.sponsorFlag ?? false,
    lastVerifiedAt: overrides.lastVerifiedAt ?? T0,
  };
}

function insertLocation(
  raw: BetterSqlite3.Database,
  venueId: string,
  venueName: string,
  suburb: string,
  latitude: number,
  longitude: number,
): void {
  raw.prepare(
    `INSERT INTO venue_location_cache (venue_id, venue_name, suburb, latitude, longitude, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(venueId, venueName, suburb, latitude, longitude, T3);
}

function insertPrice(raw: BetterSqlite3.Database, input: {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  verifiedAt: string;
  happyHour?: boolean;
  happyHourDetails?: string | null;
}): void {
  raw.prepare(
    `INSERT INTO venue_price_records (
       id, venue_id, venue_name, suburb, beer_name, serving_size,
       is_happy_hour_price, happy_hour_details, source_type,
       last_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'Test Beer', 'pint', ?, ?, 'test', ?, ?, ?)`,
  ).run(
    input.id,
    input.venueId,
    input.venueName,
    input.suburb,
    input.happyHour ? 1 : 0,
    input.happyHourDetails ?? null,
    input.verifiedAt,
    input.verifiedAt,
    input.verifiedAt,
  );
}

function insertSubmissionLink(
  raw: BetterSqlite3.Database,
  missionId: string,
  accountId: string,
  id = `${missionId}:submission`,
): void {
  raw.prepare(
    `INSERT INTO submissions (
       id, mission_id, user_id, venue_id, venue_name, status, submission_type,
       observed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 'single_beer_price', ?, ?, ?)`,
  ).run(id, missionId, accountId, `${missionId}:venue`, `Venue ${missionId}`, T3, T3, T3);
}

function insertRequestLink(raw: BetterSqlite3.Database, missionId: string, id = `${missionId}:request`): void {
  raw.prepare(
    `INSERT INTO venue_requests (
       id, request_type, status, mission_id, created_at, updated_at
     ) VALUES (?, 'missing_venue', 'mission_created', ?, ?, ?)`,
  ).run(id, missionId, T3, T3);
}

function feedInput(overrides: Partial<MissionFeedPageInput> = {}): MissionFeedPageInput {
  return {
    userId: null,
    suburb: undefined,
    searchTerms: [],
    savedSuburbs: [],
    savedOnly: false,
    latitude: undefined,
    longitude: undefined,
    radiusMeters: 5_000,
    sort: "points",
    limit: 20,
    offset: 0,
    acceptedAfter: T2,
    veryFreshCutoff: T2,
    weekOldCutoff: T1,
    veryFreshPoints: 1,
    weekOldPoints: 5,
    stalePoints: 10,
    newVenuePoints: 20,
    excludeHappyHourMissions: true,
    ...overrides,
  };
}

describe("MissionDiscoveryAutomationRepository SQLite", () => {
  it("keeps the lock contract versioned and sorts its writer before shared mission owners", () => {
    expect(MISSION_DISCOVERY_AUTOMATION_LOCK_CONTRACT).toEqual(expect.objectContaining({
      version: 1,
      missionLifecycleVersion: 1,
      writerKey: missionDiscoveryAutomationWriterLockKey(),
    }));
    expect(missionDiscoveryAutomationWriterLockKey() < missionLifecycleMissionLockKey("auto:a")).toBe(true);
  });

  it("fails closed when replacement or discovered owner sets exceed their hard bounds", async () => {
    const { raw, repository } = createHarness();
    await expect(repository.replaceAutoMissions({
      missions: Array.from({ length: 5_001 }, (_, index) => autoMission(`auto:input-bound:${index}`)),
      now: T3,
    })).rejects.toSatisfy(expectCode("invalid_input"));

    raw.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 10001
       )
       INSERT INTO missions (
         id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
         active, sponsor_flag, last_verified_at, created_at, updated_at
       )
       SELECT printf('auto:owner-bound:%05d', value),
              printf('venue:owner-bound:%05d', value),
              'Bounded owner', NULL, 'Stale price', 'high', 10, 1,
              1, 0, NULL, ?, ?
         FROM sequence`,
    ).run(T0, T0);
    await expect(repository.replaceAutoMissions({ missions: [], now: T3 }))
      .rejects.toSatisfy(expectCode("owner_set_too_large"));
  });

  it("preserves public feed scoring, availability, free-launch filters, search, saved, radius, count, and deterministic pages", async () => {
    const { raw, repository, lifecycle } = createHarness();
    insertAccount(raw, "feed-owner");
    insertAccount(raw, "other-owner");

    await createMission(lifecycle, {
      id: "manual:no-data", venueId: "venue:no-data", venueName: "Alpha Empty Hotel",
      suburb: "Carlton", reason: "No data - add current prices", lastVerifiedAt: null, updatedAt: T3,
    });
    await createMission(lifecycle, {
      id: "manual:fresh", venueId: "venue:fresh", venueName: "Bravo Smith Hotel",
      suburb: "Carlton", reason: "Confirm current prices", lastVerifiedAt: T0, updatedAt: T2,
    });
    insertPrice(raw, {
      id: "price:fresh", venueId: "venue:fresh", venueName: "Bravo Smith Hotel",
      suburb: "Carlton", verifiedAt: T3,
    });
    raw.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, address, suburb, area, opening_hours_json, venue_tags_json,
         membership_tier, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '{}', '[]', 'basic', 1, ?, ?)`,
    ).run("venue:fresh", "Bravo Smith Hotel", "10 Smith Street", "Carlton", "Carlton", T0, T3);
    await createMission(lifecycle, {
      id: "auto:stale", venueId: "venue:stale", venueName: "Charlie Stale Bar",
      suburb: "Fitzroy", reason: "Stale drink menu", lastVerifiedAt: T0, updatedAt: T1,
    });
    await createMission(lifecycle, {
      id: "auto:happy", venueId: "venue:happy", venueName: "Hidden Happy Bar",
      suburb: "Carlton", reason: "Missing happy-hour details", lastVerifiedAt: null, updatedAt: T3,
    });
    await createMission(lifecycle, {
      id: "auto:hh", venueId: "venue:hh", venueName: "Hidden HH Bar",
      suburb: "Carlton", reason: "Add current HH specials", lastVerifiedAt: null, updatedAt: T3,
    });
    await createMission(lifecycle, {
      id: "manual:far", venueId: "venue:far", venueName: "Far Hotel",
      suburb: "Carlton", reason: "No prices recorded", lastVerifiedAt: null, updatedAt: T3,
    });
    await createMission(lifecycle, {
      id: "manual:reserved", venueId: "venue:reserved", venueName: "Reserved Hotel",
      suburb: "Carlton", reason: "No prices recorded", lastVerifiedAt: null, updatedAt: T3,
    });
    await createMission(lifecycle, {
      id: "manual:expired", venueId: "venue:expired", venueName: "Expired Reservation Hotel",
      suburb: "Carlton", reason: "No prices recorded", lastVerifiedAt: null, updatedAt: T3,
    });
    insertLocation(raw, "venue:no-data", "Alpha Empty Hotel", "Carlton", -37.8136, 144.9631);
    insertLocation(raw, "venue:fresh", "Bravo Smith Hotel", "Carlton", -37.814, 144.964);
    insertLocation(raw, "venue:stale", "Charlie Stale Bar", "Fitzroy", -37.798, 144.978);
    insertLocation(raw, "venue:far", "Far Hotel", "Carlton", -38.3, 145.4);
    insertLocation(raw, "venue:reserved", "Reserved Hotel", "Carlton", -37.815, 144.965);
    insertLocation(raw, "venue:expired", "Expired Reservation Hotel", "Carlton", -37.816, 144.966);

    await lifecycle.acceptMission({
      missionId: "manual:reserved", userId: "other-owner", now: T3, acceptedAfter: T1,
    });
    await lifecycle.acceptMission({
      missionId: "manual:expired", userId: "other-owner", now: T0, acceptedAfter: "2026-06-01T00:00:00.000Z",
    });

    const page = await repository.listMissionFeedPage(feedInput({ limit: 2 }));
    expect(page.total).toBe(5);
    expect(page.missions.map((mission) => mission.id)).toEqual(["manual:expired", "manual:far"]);
    expect(page.missions.every((mission) => mission.points === 20)).toBe(true);
    const second = await repository.listMissionFeedPage(feedInput({ limit: 2, offset: 2 }));
    expect(second.total).toBe(5);
    expect(second.missions.map((mission) => mission.id)).toEqual(["manual:no-data", "auto:stale"]);
    expect(second.missions.map((mission) => mission.points)).toEqual([20, 10]);

    const ownReserved = await repository.listMissionFeedPage(feedInput({
      userId: "other-owner",
      searchTerms: ["reserved", "hotel"],
    }));
    expect(ownReserved.missions.map((mission) => mission.id)).toEqual(["manual:reserved"]);
    expect(ownReserved.missions[0]).toEqual(expect.objectContaining({
      userProgress: "accepted",
      reservationAcceptedAt: T3,
    }));

    const searched = await repository.listMissionFeedPage(feedInput({ searchTerms: ["smith", "street"] }));
    expect(searched.missions).toEqual([
      expect.objectContaining({
        id: "manual:fresh",
        points: 1,
        lastVerifiedAt: T3,
        venueAddress: "10 Smith Street",
      }),
    ]);
    const saved = await repository.listMissionFeedPage(feedInput({
      savedOnly: true,
      savedSuburbs: [" carlton ", "CARLTON"],
    }));
    expect(saved.missions.every((mission) => mission.suburb === "Carlton")).toBe(true);
    expect(await repository.listMissionFeedPage(feedInput({ savedOnly: true, savedSuburbs: [] })))
      .toEqual({ missions: [], total: 0 });

    const nearby = await repository.listMissionFeedPage(feedInput({
      latitude: -37.8136,
      longitude: 144.9631,
      radiusMeters: 1_000,
      sort: "nearby",
      limit: 20,
    }));
    expect(nearby.missions.map((mission) => mission.id)).toEqual([
      "manual:no-data",
      "manual:fresh",
      "manual:expired",
    ]);
    expect(nearby.missions[0]).toEqual(expect.objectContaining({ distanceMeters: 0, distanceKm: 0 }));

    await expect(repository.listMissionFeedPage(feedInput({ offset: 4_999, limit: 2 })))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("collects deterministic venue candidates in one set-based query", async () => {
    const { raw, database, repository, lifecycle } = createHarness();
    insertLocation(raw, "venue:a", "Alpha Location", "Carlton", -37.8, 144.9);
    insertPrice(raw, {
      id: "price:b:old", venueId: "venue:b", venueName: "Old Price Name",
      suburb: "Richmond", verifiedAt: T0,
    });
    insertPrice(raw, {
      id: "price:b:new", venueId: "venue:b", venueName: "Bravo Latest Price",
      suburb: "Richmond", verifiedAt: T2, happyHour: true,
    });
    raw.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, suburb, area, opening_hours_json, venue_tags_json,
         membership_tier, active, created_at, updated_at
       ) VALUES ('venue:c', 'Charlie Profile', 'Fitzroy', 'Fitzroy', '{}', '[]', 'basic', 1, ?, ?)`,
    ).run(T0, T3);
    raw.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, suburb, area, opening_hours_json, venue_tags_json,
         membership_tier, active, created_at, updated_at
       ) VALUES ('venue:b', 'Inactive Profile', 'Richmond', 'Richmond', '{}', '[]', 'basic', 0, ?, ?)`,
    ).run(T0, T3);
    raw.prepare(
      `INSERT INTO venue_requests (
         id, request_type, venue_id, venue_name, suburb, status, created_at, updated_at
       ) VALUES ('request:d', 'missing_venue', 'venue:d', 'Delta Request', 'Brunswick', 'open', ?, ?)`,
    ).run(T1, T1);
    await createMission(lifecycle, {
      id: "manual:candidate", venueId: "venue:e", venueName: "Echo Manual",
      suburb: "Collingwood", updatedAt: T1,
    });
    raw.prepare(
      `INSERT INTO venue_happy_hours (
         id, venue_id, title, days_of_week_json, start_time, end_time,
         description, happy_hour_beers_json, active, created_at, updated_at
       ) VALUES ('happy:b', 'venue:b', 'Happy hour', '[]', '17:00', '18:00', 'Test', '[]', 1, ?, ?)`,
    ).run(T0, T3);

    const before = database.metrics().completedQueries;
    const candidates = await repository.listMissionVenueCandidates({ limit: 20 });
    const after = database.metrics().completedQueries;
    expect(after - before).toBe(1);
    expect(candidates.map((candidate) => candidate.venueId)).toEqual([
      "venue:a", "venue:c", "venue:d", "venue:e", "venue:b",
    ]);
    expect(candidates.at(-1)).toEqual({
      venueId: "venue:b",
      venueName: "Bravo Latest Price",
      suburb: "Richmond",
      latestVerifiedAt: T2,
      recordCount: 2,
      happyHourLastVerifiedAt: T3,
    });
    expect((await repository.listMissionVenueCandidates({ limit: 2, offset: 2 })).map((candidate) => candidate.venueId))
      .toEqual(["venue:d", "venue:e"]);
    await expect(repository.listMissionVenueCandidates({ limit: 2, offset: 4_999 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("atomically replaces auto missions while preserving every linked owner", async () => {
    const { raw, repository, lifecycle } = createHarness();
    insertAccount(raw, "automation-owner");
    for (const id of ["auto:stale", "auto:accepted", "auto:submitted", "auto:request-linked"]) {
      await createMission(lifecycle, { id, venueId: `${id}:venue`, updatedAt: T0 });
    }
    await lifecycle.acceptMission({
      missionId: "auto:accepted", userId: "automation-owner", now: T1,
      acceptedAfter: "2026-06-01T00:00:00.000Z",
    });
    insertSubmissionLink(raw, "auto:submitted", "automation-owner");
    insertRequestLink(raw, "auto:request-linked");

    expect(await repository.replaceAutoMissions({
      missions: [
        autoMission("auto:new", { venueName: "New Auto Venue", lastVerifiedAt: T2 }),
        autoMission("auto:accepted", { active: false, venueName: "Accepted Preserved" }),
      ],
      now: T3,
    })).toBe(2);

    const rows = raw.prepare(
      "SELECT id, active, venue_name FROM missions WHERE id LIKE 'auto:%' ORDER BY id",
    ).all() as Array<{ id: string; active: number; venue_name: string }>;
    expect(rows).toEqual([
      { id: "auto:accepted", active: 1, venue_name: "Accepted Preserved" },
      { id: "auto:new", active: 1, venue_name: "New Auto Venue" },
      { id: "auto:request-linked", active: 1, venue_name: "Venue auto:request-linked" },
      { id: "auto:stale", active: 0, venue_name: "Venue auto:stale" },
      { id: "auto:submitted", active: 1, venue_name: "Venue auto:submitted" },
    ]);
  });

  it("rolls back the entire replacement and fails closed on malformed owners", async () => {
    const { raw, repository, lifecycle } = createHarness();
    await createMission(lifecycle, { id: "auto:rollback-stale", updatedAt: T0 });
    raw.exec(`
      CREATE TRIGGER reject_rollback_auto
      BEFORE INSERT ON missions
      WHEN NEW.id = 'auto:rollback-b'
      BEGIN
        SELECT RAISE(FAIL, 'forced automation rollback');
      END;
    `);
    await expect(repository.replaceAutoMissions({
      missions: [autoMission("auto:rollback-a"), autoMission("auto:rollback-b")],
      now: T3,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    expect(raw.prepare("SELECT active FROM missions WHERE id = 'auto:rollback-stale'").get())
      .toEqual({ active: 1 });
    expect(raw.prepare("SELECT count(*) AS count FROM missions WHERE id IN ('auto:rollback-a', 'auto:rollback-b')").get())
      .toEqual({ count: 0 });

    raw.exec("DROP TRIGGER reject_rollback_auto");
    await createMission(lifecycle, { id: "auto:malformed", venueId: "demo:malformed", updatedAt: T0 });
    raw.prepare("UPDATE missions SET points = 'not-a-number' WHERE id = 'auto:malformed'").run();
    await expect(repository.deactivateDemoMissions({ now: T3, limit: 10 }))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("bounds prune/demo batches and never deletes or deactivates linked missions", async () => {
    const { raw, repository, lifecycle } = createHarness();
    insertAccount(raw, "maintenance-owner");
    await repository.replaceAutoMissions({
      missions: [
        autoMission("auto:inactive:a", { active: false }),
        autoMission("auto:inactive:b", { active: false }),
        autoMission("auto:inactive:linked", { active: false }),
        autoMission("auto:demo:a", { venueId: "demo:a" }),
        autoMission("auto:demo:b", { venueId: "demo:b" }),
        autoMission("auto:demo:linked", { venueId: "demo:linked" }),
      ],
      now: T1,
    });
    insertRequestLink(raw, "auto:inactive:linked", "inactive-link");
    await lifecycle.acceptMission({
      missionId: "auto:demo:linked", userId: "maintenance-owner", now: T2,
      acceptedAfter: "2026-06-01T00:00:00.000Z",
    });

    await expect(repository.pruneInactiveAutoMissions({ limit: 1 }))
      .resolves.toEqual({ changed: 1, hasMore: true });
    await expect(repository.pruneInactiveAutoMissions({ limit: 1 }))
      .resolves.toEqual({ changed: 1, hasMore: false });
    expect(raw.prepare("SELECT active FROM missions WHERE id = 'auto:inactive:linked'").get())
      .toEqual({ active: 0 });

    await expect(repository.deactivateDemoMissions({ now: T3, limit: 1 }))
      .resolves.toEqual({ changed: 1, hasMore: true });
    await expect(repository.deactivateDemoMissions({ now: T3, limit: 1 }))
      .resolves.toEqual({ changed: 1, hasMore: false });
    expect(raw.prepare("SELECT active FROM missions WHERE id = 'auto:demo:linked'").get())
      .toEqual({ active: 1 });
    expect(raw.prepare("SELECT count(*) AS count FROM missions WHERE id LIKE 'auto:inactive:%'").get())
      .toEqual({ count: 1 });
  });

  it("lets an acceptance win safely against replacement deactivation", async () => {
    const { raw, repository, lifecycle } = createHarness();
    insertAccount(raw, "race-owner");
    await createMission(lifecycle, { id: "auto:race", updatedAt: T0 });

    const [accepted, replaced] = await Promise.all([
      lifecycle.acceptMission({
        missionId: "auto:race", userId: "race-owner", now: T2,
        acceptedAfter: "2026-06-01T00:00:00.000Z",
      }),
      repository.replaceAutoMissions({ missions: [], now: T3 }),
    ]);
    expect(accepted).toEqual(expect.objectContaining({ missionId: "auto:race", status: "accepted" }));
    expect(replaced).toBe(0);
    expect(raw.prepare("SELECT active FROM missions WHERE id = 'auto:race'").get())
      .toEqual({ active: 1 });
  });
});
