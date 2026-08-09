import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  VENUE_PARTNER_LOCK_CONTRACT,
  VenuePartnerRepository,
  VenuePartnerRepositoryError,
  type CreateVenueInterestInput,
  type UpsertVenuePartnerOutreachInput,
  type VenuePartnerRepositoryErrorCode,
} from "../src/db/venue-partner.repository.js";

const T0 = "2026-08-08T12:00:00.000Z";
const T1 = "2026-08-08T12:05:00.000Z";
const T2 = "2026-08-08T12:10:00.000Z";
const T3 = "2026-08-08T12:15:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenuePartnerRepository;
}

function fixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new VenuePartnerRepository(database) };
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

function lockDeletion(raw: BetterSqlite3.Database, userId: string): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
  ).run(`delete-${userId}`, userId, T0, T1, T0, T0);
}

function interestInput(
  overrides: Partial<CreateVenueInterestInput> = {},
): CreateVenueInterestInput {
  return {
    id: "interest-a",
    userId: null,
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    managerName: "Alex Manager",
    email: "Manager@Example.Test",
    phone: "+61 400 000 000",
    role: "Owner",
    notes: "Interested in launch access.",
    now: T0,
    ...overrides,
  };
}

function outreachInput(
  overrides: Partial<UpsertVenuePartnerOutreachInput> = {},
): UpsertVenuePartnerOutreachInput {
  return {
    actorAccountId: "admin-a",
    id: "outreach-a",
    venueId: "venue-a",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    status: "lead",
    tierFit: "pro",
    nextAction: "Call the manager.",
    lastContactedAt: null,
    contactName: "Alex Manager",
    notes: "Warm introduction.",
    expectedUpdatedAt: null,
    now: T0,
    ...overrides,
  };
}

function expectCode(code: VenuePartnerRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof VenuePartnerRepositoryError && error.code === code;
}

describe("VenuePartnerRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function createFixture(): Fixture {
    const created = fixture();
    databases.push(created.database);
    return created;
  }

  it("creates venue interest exactly, normalizes data, and rejects conflicting or malformed input", async () => {
    const { raw, repository } = createFixture();
    expect(VENUE_PARTNER_LOCK_CONTRACT).toEqual({
      version: 1,
      accountPrefix: "venue-partner:account:",
      interestPrefix: "venue-partner:interest:",
      outreachVenuePrefix: "venue-partner:outreach:venue:",
      outreachIdentityPrefix: "venue-partner:outreach:id:",
      order: "sorted-advisory-locks-before-account-rows-before-record-rows-before-conditional-writes",
    });

    const created = await repository.createVenueInterest(interestInput());
    expect(created).toMatchObject({
      id: "interest-a",
      userId: null,
      email: "manager@example.test",
      status: "open",
      assignedTo: null,
      resolvedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    await expect(repository.createVenueInterest(interestInput({ now: T1 }))).resolves.toEqual(created);
    expect(raw.prepare("SELECT count(*) AS count FROM venue_interest_requests").get()).toEqual({ count: 1 });

    await expect(repository.createVenueInterest(interestInput({ venueName: "Different Hotel" })))
      .rejects.toSatisfy(expectCode("interest_id_conflict"));
    await expect(repository.createVenueInterest(interestInput({ id: "bad-email", email: "not-an-email" })))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.createVenueInterest(interestInput({ id: "bad-time", now: "2026-08-08" })))
      .rejects.toSatisfy(expectCode("invalid_input"));

    raw.prepare("UPDATE venue_interest_requests SET created_at = 'not-a-time' WHERE id = 'interest-a'").run();
    await expect(repository.getVenueInterestById("interest-a"))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("checks authenticated interest owners and account-deletion fences", async () => {
    const { raw, repository } = createFixture();
    insertAccount(raw, "warned", { status: "warned" });
    insertAccount(raw, "suspended", { status: "suspended" });
    insertAccount(raw, "deleted", { authProvider: "deleted" });
    insertAccount(raw, "deletion-locked");
    lockDeletion(raw, "deletion-locked");

    await expect(repository.createVenueInterest(interestInput({ id: "warned", userId: "warned" })))
      .resolves.toMatchObject({ id: "warned", userId: "warned" });
    await expect(repository.createVenueInterest(interestInput({ id: "missing", userId: "missing" })))
      .rejects.toSatisfy(expectCode("account_not_found"));
    await expect(repository.createVenueInterest(interestInput({ id: "suspended", userId: "suspended" })))
      .rejects.toSatisfy(expectCode("account_not_eligible"));
    await expect(repository.createVenueInterest(interestInput({ id: "deleted", userId: "deleted" })))
      .rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.createVenueInterest(interestInput({
      id: "deletion-locked",
      userId: "deletion-locked",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
    expect(raw.prepare("SELECT count(*) AS count FROM venue_interest_requests").get()).toEqual({ count: 1 });
  });

  it("uses deterministic bounded keyset pages and exact status counts for interests", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    await repository.createVenueInterest(interestInput({ id: "interest-b", now: T1 }));
    await repository.createVenueInterest(interestInput({ id: "interest-a", venueId: "venue-b", now: T1 }));
    await repository.createVenueInterest(interestInput({ id: "interest-c", venueId: "venue-c", now: T2 }));

    const first = await repository.listVenueInterests({ limit: 2 });
    expect(first.interests.map((interest) => interest.id)).toEqual(["interest-c", "interest-a"]);
    const second = await repository.listVenueInterests({ limit: 2, cursor: first.nextCursor });
    expect(second.interests.map((interest) => interest.id)).toEqual(["interest-b"]);
    expect(second.nextCursor).toBeNull();

    await repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: "interest-b",
      status: "contacted",
      assignedTo: null,
      resolutionNote: "Called.",
      expectedUpdatedAt: T1,
      now: T3,
    });
    expect(await repository.countVenueInterests()).toBe(3);
    expect(await repository.countVenueInterests({ status: "open" })).toBe(2);
    expect(await repository.countVenueInterests({ status: "contacted" })).toBe(1);
    await expect(repository.listVenueInterests({ limit: 101 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("enforces admin eligibility, OCC, terminal workflow metadata, and rollback", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    insertAdmin(raw, "admin-b");
    insertAdmin(raw, "admin-deletion");
    insertAccount(raw, "ordinary");
    lockDeletion(raw, "admin-deletion");
    const interest = await repository.createVenueInterest(interestInput());

    const assigned = await repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: interest.id,
      status: "contacted",
      assignedTo: "admin-b",
      resolutionNote: "Follow-up booked.",
      expectedUpdatedAt: interest.updatedAt,
      now: T1,
    });
    expect(assigned).toMatchObject({
      status: "contacted",
      assignedTo: "admin-b",
      resolvedAt: null,
      resolvedBy: null,
      updatedAt: T1,
    });

    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "ordinary",
      interestId: interest.id,
      status: "partner",
      assignedTo: null,
      resolutionNote: "No authority.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("admin_not_authorized"));
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-deletion",
      interestId: interest.id,
      status: "partner",
      assignedTo: null,
      resolutionNote: "Deletion fence.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: interest.id,
      status: "partner",
      assignedTo: "admin-b",
      resolutionNote: "Converted.",
      expectedUpdatedAt: interest.updatedAt,
      now: T2,
    })).rejects.toSatisfy(expectCode("interest_version_conflict"));

    const terminal = await repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: interest.id,
      status: "partner",
      assignedTo: "admin-b",
      resolutionNote: "Converted.",
      expectedUpdatedAt: assigned.updatedAt,
      now: T2,
    });
    expect(terminal).toMatchObject({
      status: "partner",
      resolvedAt: T2,
      resolvedBy: "admin-a",
      updatedAt: T2,
    });
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: interest.id,
      status: "partner",
      assignedTo: "admin-b",
      resolutionNote: "Converted.",
      expectedUpdatedAt: terminal.updatedAt,
      now: T3,
    })).resolves.toEqual(terminal);

    const rollback = await repository.createVenueInterest(interestInput({ id: "rollback-interest" }));
    raw.exec(`
      CREATE TRIGGER reject_rollback_interest
      BEFORE UPDATE ON venue_interest_requests
      WHEN OLD.id = 'rollback-interest'
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);
    await expect(repository.updateVenueInterestWorkflow({
      actorAccountId: "admin-a",
      interestId: rollback.id,
      status: "contacted",
      assignedTo: null,
      resolutionNote: "Must roll back.",
      expectedUpdatedAt: rollback.updatedAt,
      now: T1,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getVenueInterestById(rollback.id)).resolves.toEqual(rollback);
  });

  it("creates, exactly replays, and OCC-updates outreach without replacing its identity", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");

    const created = await repository.upsertVenuePartnerOutreach(outreachInput());
    expect(created).toMatchObject({
      created: true,
      replayed: false,
      outreach: { id: "outreach-a", venueId: "venue-a", status: "lead", updatedAt: T0 },
    });
    const replay = await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "ignored-replay-id",
      now: T1,
    }));
    expect(replay).toEqual({ outreach: created.outreach, created: false, replayed: true });
    expect(raw.prepare("SELECT id FROM venue_partner_outreach WHERE venue_id = 'venue-a'").get())
      .toEqual({ id: "outreach-a" });

    await expect(repository.upsertVenuePartnerOutreach(outreachInput({ status: "contacted", now: T1 })))
      .rejects.toSatisfy(expectCode("outreach_version_conflict"));
    const updated = await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "ignored-update-id",
      status: "contacted",
      lastContactedAt: T1,
      expectedUpdatedAt: created.outreach.updatedAt,
      now: T1,
    }));
    expect(updated).toMatchObject({
      created: false,
      replayed: false,
      outreach: { id: "outreach-a", status: "contacted", lastContactedAt: T1, updatedAt: T1 },
    });
    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      status: "interested",
      expectedUpdatedAt: created.outreach.updatedAt,
      now: T2,
    }))).rejects.toSatisfy(expectCode("outreach_version_conflict"));
    await expect(repository.getVenuePartnerOutreachByVenueId("venue-a"))
      .resolves.toEqual(updated.outreach);
    await expect(repository.getVenuePartnerOutreachById("outreach-a"))
      .resolves.toEqual(updated.outreach);

    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      id: "outreach-a",
      venueId: "venue-b",
      venueName: "Beta Hotel",
    }))).rejects.toSatisfy(expectCode("outreach_id_conflict"));
  });

  it("serializes outreach contention and fences non-admin or deleting actors", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    insertAdmin(raw, "admin-deletion");
    insertAccount(raw, "ordinary");
    lockDeletion(raw, "admin-deletion");

    const race = await Promise.all([
      repository.upsertVenuePartnerOutreach(outreachInput({ id: "race-a", venueId: "race-venue" })),
      repository.upsertVenuePartnerOutreach(outreachInput({ id: "race-b", venueId: "race-venue" })),
    ]);
    expect(race.filter((result) => result.created)).toHaveLength(1);
    expect(race.filter((result) => result.replayed)).toHaveLength(1);
    expect(new Set(race.map((result) => result.outreach.id)).size).toBe(1);

    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      actorAccountId: "ordinary",
      id: "ordinary",
      venueId: "ordinary-venue",
    }))).rejects.toSatisfy(expectCode("admin_not_authorized"));
    await expect(repository.upsertVenuePartnerOutreach(outreachInput({
      actorAccountId: "admin-deletion",
      id: "deletion",
      venueId: "deletion-venue",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
  });

  it("lists and counts outreach with deterministic keysets and strict native decoding", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "outreach-b",
      venueId: "venue-b",
      venueName: "Beta Hotel",
      now: T1,
    }));
    await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "outreach-a",
      venueId: "venue-a",
      venueName: "Alpha Hotel",
      now: T1,
    }));
    await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "outreach-c",
      venueId: "venue-c",
      venueName: "Charlie Hotel",
      status: "partner",
      now: T2,
    }));

    const first = await repository.listVenuePartnerOutreach({ limit: 2 });
    expect(first.outreach.map((entry) => entry.venueId)).toEqual(["venue-c", "venue-a"]);
    const second = await repository.listVenuePartnerOutreach({ limit: 2, cursor: first.nextCursor });
    expect(second.outreach.map((entry) => entry.venueId)).toEqual(["venue-b"]);
    expect(await repository.countVenuePartnerOutreach()).toBe(3);
    expect(await repository.countVenuePartnerOutreach({ status: "partner" })).toBe(1);
    await expect(repository.listVenuePartnerOutreachByVenueIds({
      venueIds: ["venue-b", "venue-c", "venue-b", "missing-venue"],
    })).resolves.toEqual([
      expect.objectContaining({ venueId: "venue-b", venueName: "Beta Hotel" }),
      expect.objectContaining({ venueId: "venue-c", venueName: "Charlie Hotel" }),
    ]);
    await expect(repository.listVenuePartnerOutreachByVenueIds({ venueIds: [] })).resolves.toEqual([]);
    await expect(repository.listVenuePartnerOutreachByVenueIds({
      venueIds: Array.from({ length: 101 }, (_, index) => `venue-${index}`),
    })).rejects.toSatisfy(expectCode("invalid_input"));

    raw.prepare("UPDATE venue_partner_outreach SET status = 'unknown' WHERE venue_id = 'venue-a'").run();
    await expect(repository.getVenuePartnerOutreachByVenueId("venue-a"))
      .rejects.toSatisfy(expectCode("malformed_record"));
  });

  it("rolls back outreach update failures without exposing database details", async () => {
    const { raw, repository } = createFixture();
    insertAdmin(raw, "admin-a");
    const created = await repository.upsertVenuePartnerOutreach(outreachInput({
      id: "rollback-outreach",
      venueId: "rollback-venue",
    }));
    raw.exec(`
      CREATE TRIGGER reject_rollback_outreach
      BEFORE UPDATE ON venue_partner_outreach
      WHEN OLD.venue_id = 'rollback-venue'
      BEGIN
        SELECT RAISE(ABORT, 'sensitive database detail');
      END;
    `);
    const operation = repository.upsertVenuePartnerOutreach(outreachInput({
      id: "new-id-is-ignored",
      venueId: "rollback-venue",
      status: "contacted",
      expectedUpdatedAt: created.outreach.updatedAt,
      now: T1,
    }));
    await expect(operation).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(operation).rejects.not.toThrow(/sensitive database detail/i);
    await expect(repository.getVenuePartnerOutreachByVenueId("rollback-venue"))
      .resolves.toEqual(created.outreach);
  });
});
