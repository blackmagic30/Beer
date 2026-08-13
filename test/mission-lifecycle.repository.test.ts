import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  MISSION_LIFECYCLE_LOCK_CONTRACT,
  MissionLifecycleRepository,
  MissionLifecycleRepositoryError,
  missionLifecycleAccountLockKey,
  type CreateMissionInput,
  type MissionLifecycleRepositoryErrorCode,
} from "../src/db/mission-lifecycle.repository.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const T0 = "2026-08-08T12:00:00.000Z";
const T1 = "2026-08-08T12:05:00.000Z";
const T2 = "2026-08-08T12:10:00.000Z";
const OLD_CUTOFF = "2020-01-01T00:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: MissionLifecycleRepository;
}

function fixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new MissionLifecycleRepository(database) };
}

function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    id: "mission-a",
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    reason: "Verify the current pint price.",
    priority: "high",
    points: 5,
    multiplier: 1.5,
    active: true,
    sponsorFlag: false,
    lastVerifiedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: { status?: "active" | "warned" | "suspended"; authProvider?: string } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, 'user', 'free', ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.test`,
    options.authProvider ?? "local",
    options.status ?? "active",
    T0,
    T0,
  );
}

function lockDeletion(raw: BetterSqlite3.Database, userId: string, status = "processing"): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`delete-${userId}`, userId, status, T0, T1, T0, T0);
}

function expectCode(code: MissionLifecycleRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof MissionLifecycleRepositoryError && error.code === code;
}

describe("MissionLifecycleRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function createFixture(): Fixture {
    const created = fixture();
    databases.push(created.database);
    return created;
  }

  it("creates exact-idempotently and lists lifecycle records with bounded deterministic cursors", async () => {
    const { raw, repository } = createFixture();
    const alpha = await repository.createMission(missionInput({ id: "mission-a", venueId: "venue-a" }));
    await repository.createMission(missionInput({ id: "mission-b", venueId: "venue-b", active: false }));
    await repository.createMission(missionInput({
      id: "mission-c",
      venueId: "venue-c",
      venueName: "Charlie Hotel",
      suburb: "Carlton",
      createdAt: T1,
      updatedAt: T1,
    }));

    await expect(repository.createMission(missionInput({ id: "mission-a", venueId: "venue-a" })))
      .resolves.toEqual(alpha);
    await expect(repository.createMission(missionInput({
      id: "mission-a",
      venueId: "venue-a",
      reason: "A conflicting retry.",
    }))).rejects.toSatisfy(expectCode("mission_version_conflict"));

    const first = await repository.listMissions({ activeOnly: false, limit: 2 });
    expect(first.missions.map((mission) => mission.id)).toEqual(["mission-c", "mission-a"]);
    expect(first.nextCursor).toEqual({ updatedAt: T0, id: "mission-a" });
    const second = await repository.listMissions({
      activeOnly: false,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.missions.map((mission) => mission.id)).toEqual(["mission-b"]);
    expect(second.nextCursor).toBeNull();
    expect(await repository.countMissions({ activeOnly: false })).toBe(3);
    expect(await repository.countMissions({ activeOnly: true })).toBe(2);
    expect((await repository.listMissions({ activeOnly: false, suburb: "FITZROY", limit: 10 })).missions)
      .toHaveLength(2);

    await expect(repository.listMissions({ activeOnly: false, limit: 0 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createMission(missionInput({ updatedAt: "2026-08-08T22:00:00.000+10:00" })))
      .rejects.toSatisfy(expectCode("invalid_input"));

    raw.prepare("UPDATE missions SET active = 2 WHERE id = 'mission-a'").run();
    await expect(repository.getMissionById("mission-a")).rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("preserves weighted admin ordering with a bounded offset", async () => {
    const { repository } = createFixture();
    await repository.createMission(missionInput({
      id: "admin-low",
      venueId: "admin-venue-low",
      points: 4,
      multiplier: 1,
    }));
    await repository.createMission(missionInput({
      id: "admin-high-b",
      venueId: "admin-venue-high-b",
      points: 5,
      multiplier: 2,
    }));
    await repository.createMission(missionInput({
      id: "admin-high-a",
      venueId: "admin-venue-high-a",
      points: 10,
      multiplier: 1,
    }));

    await expect(repository.listAdminMissions({ limit: 2, offset: 0 }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "admin-high-a" }),
        expect.objectContaining({ id: "admin-high-b" }),
      ]));
    expect((await repository.listAdminMissions({ limit: 2, offset: 0 })).map((mission) => mission.id))
      .toEqual(["admin-high-a", "admin-high-b"]);
    expect((await repository.listAdminMissions({ limit: 2, offset: 1 })).map((mission) => mission.id))
      .toEqual(["admin-high-b", "admin-low"]);
    await expect(repository.listAdminMissions({ limit: 1_001, offset: 0 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.listAdminMissions({ limit: 1, offset: 5_001 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("preserves 255-character identifiers and an exact zero multiplier", async () => {
    const { repository } = createFixture();
    const id = "m".repeat(255);
    const venueId = "v".repeat(255);
    const mission = await repository.createMission(missionInput({
      id,
      venueId,
      multiplier: 0,
    }));
    expect(mission).toMatchObject({ id, venueId, multiplier: 0 });
    await expect(repository.getMissionById(id)).resolves.toEqual(mission);
    await expect(repository.createMission(missionInput({ id: "m".repeat(256) })))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createMission(missionInput({ id: "negative", multiplier: -0.000001 })))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("serializes same-mission contention and returns the current owner replay without regression", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "account-a");
    insertAccount(raw, "account-b");
    await repository.createMission(missionInput());

    const race = await Promise.allSettled([
      repository.acceptMission({ missionId: "mission-a", userId: "account-a", now: T0, acceptedAfter: OLD_CUTOFF }),
      repository.acceptMission({ missionId: "mission-a", userId: "account-b", now: T0, acceptedAfter: OLD_CUTOFF }),
    ]);
    const fulfilled = race.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<
      MissionLifecycleRepository["acceptMission"]
    >>> => result.status === "fulfilled");
    const rejected = race.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toSatisfy(expectCode("mission_reserved"));

    const winner = fulfilled[0]!.value;
    await expect(repository.acceptMission({
      missionId: winner.missionId,
      userId: winner.userId,
      now: T1,
      acceptedAfter: OLD_CUTOFF,
    })).resolves.toEqual(winner);
    expect((await repository.listMissionProgressForUser({ userId: winner.userId, limit: 10 })).progress)
      .toEqual([winner]);
    expect(raw.prepare(
      "SELECT count(*) AS count FROM mission_progress WHERE mission_id = 'mission-a' AND status = 'accepted'",
    ).get()).toEqual({ count: 1 });
  });

  it("expires and reacquires reservations atomically while fencing stale release tokens", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "first-owner");
    insertAccount(raw, "second-owner");
    insertAccount(raw, "third-owner");
    await repository.createMission(missionInput());

    const first = await repository.acceptMission({
      missionId: "mission-a",
      userId: "first-owner",
      now: T0,
      acceptedAfter: OLD_CUTOFF,
    });
    const second = await repository.acceptMission({
      missionId: "mission-a",
      userId: "second-owner",
      now: T2,
      acceptedAfter: T0,
    });
    expect(second).toMatchObject({ userId: "second-owner", status: "accepted", acceptedAt: T2 });
    expect(MISSION_LIFECYCLE_LOCK_CONTRACT).toMatchObject({
      version: 1,
      accountPrefix: "mission-lifecycle:account:",
      missionPrefix: "mission-lifecycle:mission:",
    });
    expect(missionLifecycleAccountLockKey("second-owner"))
      .toBe("mission-lifecycle:account:second-owner");
    expect(await repository.getMissionProgress({ missionId: "mission-a", userId: "first-owner" }))
      .toMatchObject({ id: first.id, status: "cancelled" });

    await expect(repository.releaseAcceptedMission({
      missionId: "mission-a",
      userId: "second-owner",
      expectedAcceptedAt: second.acceptedAt,
      expectedUpdatedAt: T0,
      now: T2,
    })).rejects.toSatisfy(expectCode("progress_version_conflict"));
    const released = await repository.releaseAcceptedMission({
      missionId: "mission-a",
      userId: "second-owner",
      expectedAcceptedAt: second.acceptedAt,
      expectedUpdatedAt: second.updatedAt,
      now: T2,
    });
    expect(released.status).toBe("cancelled");
    expect(released.updatedAt).toBe("2026-08-08T12:10:00.001Z");
    await expect(repository.releaseAcceptedMission({
      missionId: "mission-a",
      userId: "second-owner",
      expectedAcceptedAt: second.acceptedAt,
      expectedUpdatedAt: second.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("progress_not_releasable"));

    await expect(repository.acceptMission({
      missionId: "mission-a",
      userId: "third-owner",
      now: T2,
      acceptedAfter: T0,
    })).resolves.toMatchObject({ userId: "third-owner", status: "accepted" });
  });

  it("rejects inactive missions and invalid or deletion-locked contributor accounts", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "eligible");
    insertAccount(raw, "suspended", { status: "suspended" });
    insertAccount(raw, "deleted", { authProvider: "deleted" });
    insertAccount(raw, "deletion-locked");
    lockDeletion(raw, "deletion-locked");
    await repository.createMission(missionInput({ active: false }));

    await expect(repository.acceptMission({
      missionId: "mission-a", userId: "eligible", now: T0, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("mission_inactive"));
    const active = await repository.setMissionActive({
      missionId: "mission-a", active: true, expectedUpdatedAt: T0, now: T1,
    });
    expect(active.active).toBe(true);
    await expect(repository.acceptMission({
      missionId: "missing", userId: "eligible", now: T1, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("mission_not_found"));
    await expect(repository.acceptMission({
      missionId: "mission-a", userId: "missing", now: T1, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("account_not_found"));
    await expect(repository.acceptMission({
      missionId: "mission-a", userId: "suspended", now: T1, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("account_not_eligible"));
    await expect(repository.acceptMission({
      missionId: "mission-a", userId: "deleted", now: T1, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.acceptMission({
      missionId: "mission-a", userId: "deletion-locked", now: T1, acceptedAfter: OLD_CUTOFF,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    expect(raw.prepare("SELECT count(*) AS count FROM mission_progress").get()).toEqual({ count: 0 });
  });

  it("expires bounded batches and pages unavailable mission ids without truncating history", async () => {
    const { raw, repository } = createFixture();
    for (const suffix of ["a", "b", "c"]) {
      insertAccount(raw, `owner-${suffix}`);
      await repository.createMission(missionInput({
        id: `mission-${suffix}`,
        venueId: `venue-${suffix}`,
      }));
      await repository.acceptMission({
        missionId: `mission-${suffix}`,
        userId: `owner-${suffix}`,
        now: T0,
        acceptedAfter: OLD_CUTOFF,
      });
    }

    const unavailableFirst = await repository.listUnavailableMissionIds({
      acceptedAfter: OLD_CUTOFF,
      limit: 2,
    });
    expect(unavailableFirst).toEqual({ missionIds: ["mission-a", "mission-b"], nextCursor: "mission-b" });
    await expect(repository.listUnavailableMissionIds({
      acceptedAfter: OLD_CUTOFF,
      limit: 2,
      cursor: unavailableFirst.nextCursor,
    })).resolves.toEqual({ missionIds: ["mission-c"], nextCursor: null });
    await expect(repository.listUnavailableMissionIds({
      userId: "owner-a",
      acceptedAfter: OLD_CUTOFF,
      limit: 10,
    })).resolves.toEqual({ missionIds: ["mission-b", "mission-c"], nextCursor: null });

    await expect(repository.expireAcceptedMissionProgress({ acceptedBefore: T0, now: T1, limit: 2 }))
      .resolves.toEqual({ expired: 2, hasMore: true });
    await expect(repository.expireAcceptedMissionProgress({ acceptedBefore: T0, now: T1, limit: 2 }))
      .resolves.toEqual({ expired: 1, hasMore: false });
    expect(raw.prepare("SELECT count(*) AS count FROM mission_progress WHERE status = 'cancelled'").get())
      .toEqual({ count: 3 });
  });

  it("applies admin OCC and deletes only missions with no linked history", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "history-owner");
    const unused = await repository.createMission(missionInput({ id: "unused", venueId: "unused-venue" }));
    const disabled = await repository.setMissionActive({
      missionId: unused.id,
      active: false,
      expectedUpdatedAt: unused.updatedAt,
      now: T0,
    });
    expect(disabled).toMatchObject({ active: false, updatedAt: "2026-08-08T12:00:00.001Z" });
    await expect(repository.setMissionActive({
      missionId: unused.id,
      active: true,
      expectedUpdatedAt: unused.updatedAt,
      now: T1,
    })).rejects.toSatisfy(expectCode("mission_version_conflict"));
    await expect(repository.deleteMissionIfUnused({
      missionId: unused.id,
      expectedUpdatedAt: unused.updatedAt,
    })).rejects.toSatisfy(expectCode("mission_version_conflict"));
    await expect(repository.deleteMissionIfUnused({
      missionId: unused.id,
      expectedUpdatedAt: disabled.updatedAt,
    })).resolves.toEqual(disabled);
    await expect(repository.getMissionById(unused.id)).resolves.toBeNull();

    const used = await repository.createMission(missionInput({ id: "used", venueId: "used-venue" }));
    await repository.acceptMission({
      missionId: used.id,
      userId: "history-owner",
      now: T0,
      acceptedAfter: OLD_CUTOFF,
    });
    await expect(repository.deleteMissionIfUnused({ missionId: used.id, expectedUpdatedAt: used.updatedAt }))
      .rejects.toSatisfy(expectCode("mission_in_use"));
    await expect(repository.getMissionById(used.id)).resolves.not.toBeNull();
  });

  it("rolls back expired-owner cancellation when replacement reservation persistence fails", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "rollback-first");
    insertAccount(raw, "rollback-second");
    await repository.createMission(missionInput());
    const first = await repository.acceptMission({
      missionId: "mission-a",
      userId: "rollback-first",
      now: T0,
      acceptedAfter: OLD_CUTOFF,
    });
    raw.exec(`
      CREATE TRIGGER reject_rollback_second_progress
      BEFORE INSERT ON mission_progress
      WHEN NEW.user_id = 'rollback-second'
      BEGIN
        SELECT RAISE(ABORT, 'forced mission-progress rollback');
      END;
    `);

    await expect(repository.acceptMission({
      missionId: "mission-a",
      userId: "rollback-second",
      now: T2,
      acceptedAfter: T0,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getMissionProgress({ missionId: "mission-a", userId: "rollback-first" }))
      .resolves.toEqual(first);
    await expect(repository.getMissionProgress({ missionId: "mission-a", userId: "rollback-second" }))
      .resolves.toBeNull();
  });
});
