import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  VENUE_ACCESS_LOCK_CONTRACT,
  VenueAccessRepository,
  VenueAccessRepositoryError,
  venueAccessAccountLockKey,
} from "../src/db/venue-access.repository.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const NOW = "2026-08-08T10:00:00.000Z";
const LATER = "2026-08-08T10:05:00.000Z";
const EXPIRES_AT = "2026-08-11T10:00:00.000Z";
const AT_EXPIRY = "2026-08-11T10:00:00.000Z";
const REINVITE_AT = "2026-08-11T10:01:00.000Z";
const REINVITE_EXPIRES_AT = "2026-08-14T10:01:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenueAccessRepository;
}

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new VenueAccessRepository(database) };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  role: "user" | "admin" | "venue_manager" = "user",
  status: "active" | "warned" | "suspended" = "active",
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, role, subscription_status, status, auth_provider,
       created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, ?, ?, 'local', ?, ?)`,
  ).run(id, `${id}@example.test`, role, role === "admin" ? "admin" : "free", status, NOW, NOW);
}

function lockDeletion(raw: BetterSqlite3.Database, userId: string): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
  ).run(`delete-${userId}`, userId, NOW, EXPIRES_AT, NOW, NOW);
}

function claimInput(overrides: Partial<Parameters<VenueAccessRepository["createVenueClaim"]>[0]> = {}) {
  return {
    id: "claim-default",
    userId: "claimant",
    venueId: "venue-one",
    venueName: "Venue One",
    address: "1 Test Street",
    suburb: "Carlton",
    requesterName: "Claimant Person",
    requesterRole: "Owner",
    contactEmail: "claimant@example.test",
    contactPhone: null,
    message: "I manage this venue.",
    now: NOW,
    ...overrides,
  };
}

function expectCode(code: VenueAccessRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof VenueAccessRepositoryError && error.code === code;
}

class ReviewFaultDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  failAfterClaimReview = true;

  constructor(private readonly delegate: AsyncSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings: unknown[]) => {
        const result = await statement.run(...bindings);
        if (this.failAfterClaimReview && /UPDATE\s+venue_claim_requests[\s\S]*reviewed_by/i.test(sql)) {
          this.failAfterClaimReview = false;
          throw new Error("injected review failure containing private database details");
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
    // The fixture owns the shared database.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("VenueAccessRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("exports one immutable validated account lock contract for deletion coordination", () => {
    expect(VENUE_ACCESS_LOCK_CONTRACT).toEqual(expect.objectContaining({
      version: 1,
      accountKeyPrefix: "venue-access:account:",
      deletionLockStatuses: ["processing", "failed", "completed"],
    }));
    expect(Object.isFrozen(VENUE_ACCESS_LOCK_CONTRACT)).toBe(true);
    expect(Object.isFrozen(VENUE_ACCESS_LOCK_CONTRACT.lockOrder)).toBe(true);
    expect(Object.isFrozen(VENUE_ACCESS_LOCK_CONTRACT.deletionLockStatuses)).toBe(true);
    expect(venueAccessAccountLockKey("account-one")).toBe("venue-access:account:account-one");
    expect(() => venueAccessAccountLockKey("  ")).toThrow(VenueAccessRepositoryError);
    expect(() => venueAccessAccountLockKey("bad\naccount")).toThrow(VenueAccessRepositoryError);
    expect(() => venueAccessAccountLockKey("a".repeat(256))).toThrow(VenueAccessRepositoryError);
  });

  it("serializes concurrent claim creation and returns the one pending claim", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "claimant");

    const results = await Promise.all([
      repository.createVenueClaim(claimInput({ id: "claim-a" })),
      repository.createVenueClaim(claimInput({ id: "claim-b", message: "retry payload" })),
      repository.createVenueClaim(claimInput({ id: "claim-c", message: "another retry" })),
    ]);

    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((result) => result.claim.id)).size).toBe(1);
    expect(raw.prepare(
      "SELECT count(*) AS count FROM venue_claim_requests WHERE user_id = ? AND venue_id = ? AND status = 'pending'",
    ).get("claimant", "venue-one")).toEqual({ count: 1 });
    await expect(repository.getPendingVenueClaim({ userId: "claimant", venueId: "venue-one" }))
      .resolves.toEqual(expect.objectContaining({ id: results[0]!.claim.id, status: "pending" }));
  });

  it("uses exact idempotency and rejects a reused claim id with different identity", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "claimant");
    const created = await repository.createVenueClaim(claimInput());
    expect(created.outcome).toBe("created");
    await expect(repository.createVenueClaim(claimInput({ now: LATER })))
      .resolves.toMatchObject({ outcome: "existing", claim: { id: "claim-default" } });
    await expect(repository.createVenueClaim(claimInput({ venueId: "venue-two" })))
      .rejects.toSatisfy(expectCode("claim_conflict"));
  });

  it("lists claims with deterministic tied-timestamp keyset pagination", async () => {
    const { raw, repository } = fixture();
    for (const id of ["claimant-a", "claimant-b", "claimant-c"]) insertAccount(raw, id);
    await Promise.all([
      repository.createVenueClaim(claimInput({ id: "claim-a", userId: "claimant-a", venueId: "venue-a", contactEmail: "claimant-a@example.test" })),
      repository.createVenueClaim(claimInput({ id: "claim-b", userId: "claimant-b", venueId: "venue-b", contactEmail: "claimant-b@example.test" })),
      repository.createVenueClaim(claimInput({ id: "claim-c", userId: "claimant-c", venueId: "venue-c", contactEmail: "claimant-c@example.test" })),
    ]);
    const first = await repository.listVenueClaims({ limit: 2 });
    const second = await repository.listVenueClaims({ limit: 2, cursor: first.nextCursor });
    expect(first.claims.map((claim) => claim.id)).toEqual(["claim-c", "claim-b"]);
    expect(second.claims.map((claim) => claim.id)).toEqual(["claim-a"]);
    expect(first.nextCursor).toEqual({ createdAt: NOW, id: "claim-b" });
    expect(second.nextCursor).toBeNull();
  });

  it("counts native claim and assignment states and batch-loads active assigned venue ids", async () => {
    const { raw, repository } = fixture();
    for (const id of ["claimant-a", "claimant-b", "claimant-c", "admin", "manager", "staff", "former"]) {
      insertAccount(raw, id, id === "admin" ? "admin" : "user");
    }
    await Promise.all([
      repository.createVenueClaim(claimInput({ id: "claim-a", userId: "claimant-a", venueId: "venue-a", contactEmail: "claimant-a@example.test" })),
      repository.createVenueClaim(claimInput({ id: "claim-b", userId: "claimant-b", venueId: "venue-b", contactEmail: "claimant-b@example.test" })),
      repository.createVenueClaim(claimInput({ id: "claim-c", userId: "claimant-c", venueId: "venue-c", contactEmail: "claimant-c@example.test" })),
    ]);
    raw.prepare(
      "UPDATE venue_claim_requests SET status = 'rejected', reviewed_at = ?, updated_at = ? WHERE id = 'claim-c'",
    ).run(LATER, LATER);
    await repository.assignVenueManager({
      assignmentId: "active-manager", adminAccountId: "admin", userId: "manager",
      venueId: "venue-b", venueName: "Venue B", suburb: null, now: NOW,
    });
    raw.prepare(
      `INSERT INTO venue_manager_assignments (
         id, user_id, venue_id, venue_name, access_level, status, approved_by,
         expires_at, created_at, updated_at
       ) VALUES
         ('active-counter', 'staff', 'venue-a', 'Venue A', 'counter_staff', 'active', 'admin', NULL, ?, ?),
         ('former-manager', 'former', 'venue-c', 'Venue C', 'manager', 'revoked', 'admin', NULL, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);

    await expect(repository.countVenueClaims()).resolves.toBe(3);
    await expect(repository.countVenueClaims({ status: "pending" })).resolves.toBe(2);
    await expect(repository.countVenueAssignments()).resolves.toBe(3);
    await expect(repository.countVenueAssignments({ currentOnly: true })).resolves.toBe(2);
    await expect(repository.countVenueAssignments({ status: "active" })).resolves.toBe(2);
    await expect(repository.listActiveAssignedVenueIds({
      venueIds: ["venue-c", "venue-b", "venue-a", "venue-a", "missing-venue"],
    })).resolves.toEqual(["venue-a", "venue-b"]);
    await expect(repository.listActiveAssignedVenueIds({ venueIds: [] })).resolves.toEqual([]);
    await expect(repository.listActiveAssignedVenueIds({
      venueIds: Array.from({ length: 101 }, (_, index) => `venue-${index}`),
    })).rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("reviews once, assigns a manager atomically, and fences competing decisions", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "claimant");
    const created = await repository.createVenueClaim(claimInput());

    const settled = await Promise.allSettled([
      repository.reviewVenueClaimAndAssignManager({
        claimId: created.claim.id,
        reviewerAccountId: "admin",
        decision: "approved",
        reviewNote: "Verified by phone.",
        expectedUpdatedAt: created.claim.updatedAt,
        assignmentId: "manager-assignment",
        now: LATER,
      }),
      repository.reviewVenueClaimAndAssignManager({
        claimId: created.claim.id,
        reviewerAccountId: "admin",
        decision: "rejected",
        reviewNote: "Conflicting review.",
        expectedUpdatedAt: created.claim.updatedAt,
        assignmentId: null,
        now: LATER,
      }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const claim = await repository.getVenueClaim(created.claim.id);
    expect(claim?.status).toMatch(/^(approved|rejected)$/);
    if (claim?.status === "approved") {
      await expect(repository.getVenueAssignment({ userId: "claimant", venueId: "venue-one" }))
        .resolves.toMatchObject({ accessLevel: "manager", status: "active" });
      expect(raw.prepare("SELECT role FROM accounts WHERE id = 'claimant'").get()).toEqual({ role: "venue_manager" });
    } else {
      expect(raw.prepare("SELECT count(*) AS count FROM venue_manager_assignments").get()).toEqual({ count: 0 });
    }
  });

  it("rolls the claim review back when manager assignment cannot commit and closes raw errors", async () => {
    const { raw, database, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "claimant");
    const created = await repository.createVenueClaim(claimInput());
    const faultRepository = new VenueAccessRepository(new ReviewFaultDatabase(database));

    let caught: unknown;
    try {
      await faultRepository.reviewVenueClaimAndAssignManager({
        claimId: created.claim.id,
        reviewerAccountId: "admin",
        decision: "approved",
        reviewNote: "Verified.",
        expectedUpdatedAt: created.claim.updatedAt,
        assignmentId: "manager-assignment",
        now: LATER,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VenueAccessRepositoryError);
    expect((caught as VenueAccessRepositoryError).code).toBe("persistence_failure");
    expect((caught as Error).message).not.toContain("private database details");
    await expect(repository.getVenueClaim(created.claim.id)).resolves.toMatchObject({ status: "pending" });
    await expect(repository.getVenueAssignment({ userId: "claimant", venueId: "venue-one" })).resolves.toBeNull();
    expect(raw.prepare("SELECT role FROM accounts WHERE id = 'claimant'").get()).toEqual({ role: "user" });
  });

  it("keeps assignments unique, paginates deterministically, and demotes only after the final manager revoke", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "manager");
    await repository.assignVenueManager({
      assignmentId: "manager-one",
      adminAccountId: "admin",
      userId: "manager",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: "Carlton",
      now: NOW,
    });
    await repository.assignVenueManager({
      assignmentId: "manager-two",
      adminAccountId: "admin",
      userId: "manager",
      venueId: "venue-two",
      venueName: "Venue Two",
      suburb: "Fitzroy",
      now: NOW,
    });
    const pageOne = await repository.listVenueAssignments({ userId: "manager", limit: 1 });
    const pageTwo = await repository.listVenueAssignments({ userId: "manager", limit: 1, cursor: pageOne.nextCursor });
    expect(pageOne.assignments.map((assignment) => assignment.id)).toEqual(["manager-two"]);
    expect(pageTwo.assignments.map((assignment) => assignment.id)).toEqual(["manager-one"]);

    const concurrentRevokes = await Promise.all([
      repository.revokeVenueAssignment({
        actorAccountId: "admin", userId: "manager", venueId: "venue-one",
        expectedAccessLevel: "manager", now: LATER,
      }),
      repository.revokeVenueAssignment({
        actorAccountId: "admin", userId: "manager", venueId: "venue-one",
        expectedAccessLevel: "manager", now: LATER,
      }),
    ]);
    expect(concurrentRevokes.map((result) => result.outcome).sort()).toEqual(["duplicate", "revoked"]);
    expect(raw.prepare("SELECT role FROM accounts WHERE id = 'manager'").get()).toEqual({ role: "venue_manager" });
    await repository.revokeVenueAssignment({
      actorAccountId: "admin", userId: "manager", venueId: "venue-two",
      expectedAccessLevel: "manager", now: LATER,
    });
    expect(raw.prepare("SELECT role FROM accounts WHERE id = 'manager'").get()).toEqual({ role: "user" });
    await expect(repository.revokeVenueAssignment({
      actorAccountId: "admin", userId: "manager", venueId: "venue-two",
      expectedAccessLevel: "manager", now: LATER,
    })).resolves.toMatchObject({ outcome: "duplicate", assignment: { status: "revoked" } });
    await expect(repository.inviteCounterStaff({
      invitationToken: token("former-manager-counter"),
      inviterAccountId: "admin",
      userId: "manager",
      venueId: "venue-two",
      venueName: "Venue Two",
      suburb: "Fitzroy",
      now: LATER,
      expiresAt: EXPIRES_AT,
    })).resolves.toMatchObject({
      outcome: "invited",
      assignment: { accessLevel: "counter_staff", status: "pending" },
    });
  });

  it("fences counter invitations, rotates expired tokens, and rejects stale responses", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "manager");
    insertAccount(raw, "staff");
    await repository.assignVenueManager({
      assignmentId: "manager-assignment",
      adminAccountId: "admin",
      userId: "manager",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: "Carlton",
      now: NOW,
    });
    const firstToken = token("first-invite");
    const first = await repository.inviteCounterStaff({
      invitationToken: firstToken,
      inviterAccountId: "manager",
      userId: "staff",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: "Carlton",
      now: NOW,
      expiresAt: EXPIRES_AT,
    });
    expect(first).toMatchObject({ outcome: "invited", assignment: { id: firstToken, status: "pending" } });
    await expect(repository.inviteCounterStaff({
      invitationToken: firstToken,
      inviterAccountId: "manager",
      userId: "staff",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: "Carlton",
      now: NOW,
      expiresAt: EXPIRES_AT,
    })).resolves.toMatchObject({ outcome: "existing" });
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: firstToken, userId: "staff", decision: "accept", now: AT_EXPIRY,
    })).rejects.toSatisfy(expectCode("invitation_expired"));

    const secondToken = token("second-invite");
    const replacement = await repository.inviteCounterStaff({
      invitationToken: secondToken,
      inviterAccountId: "manager",
      userId: "staff",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: "Carlton",
      now: REINVITE_AT,
      expiresAt: REINVITE_EXPIRES_AT,
    });
    expect(replacement.assignment.id).toBe(secondToken);
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: firstToken, userId: "staff", decision: "accept", now: REINVITE_AT,
    })).rejects.toSatisfy(expectCode("invitation_not_found"));
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: secondToken, userId: "staff", decision: "accept", now: REINVITE_AT,
    })).resolves.toMatchObject({ outcome: "accepted", assignment: { status: "active", expiresAt: null } });
    expect(raw.prepare("SELECT role FROM accounts WHERE id = 'staff'").get()).toEqual({ role: "user" });
  });

  it("allows only one concurrent invitation response and preserves exact retry semantics", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "staff");
    const invitationToken = token("concurrent-response");
    await repository.inviteCounterStaff({
      invitationToken,
      inviterAccountId: "admin",
      userId: "staff",
      venueId: "venue-one",
      venueName: "Venue One",
      suburb: null,
      now: NOW,
      expiresAt: EXPIRES_AT,
    });
    const responses = await Promise.allSettled([
      repository.respondToCounterStaffInvitation({ invitationToken, userId: "staff", decision: "accept", now: LATER }),
      repository.respondToCounterStaffInvitation({ invitationToken, userId: "staff", decision: "decline", now: LATER }),
    ]);
    expect(responses.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const assignment = await repository.getVenueAssignment({ userId: "staff", venueId: "venue-one" });
    expect(assignment?.status).toMatch(/^(active|revoked)$/);
    if (assignment?.status === "active") {
      await expect(repository.respondToCounterStaffInvitation({
        invitationToken, userId: "staff", decision: "accept", now: LATER,
      })).resolves.toMatchObject({ outcome: "duplicate" });
    } else {
      await expect(repository.respondToCounterStaffInvitation({
        invitationToken, userId: "staff", decision: "decline", now: LATER,
      })).rejects.toSatisfy(expectCode("invitation_stale"));
    }
  });

  it("expires bounded invitations and blocks suspended, deleted, and deletion-locked accounts", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", "admin");
    insertAccount(raw, "staff-a");
    insertAccount(raw, "staff-b");
    insertAccount(raw, "suspended", "user", "suspended");
    insertAccount(raw, "locked");
    lockDeletion(raw, "locked");

    for (const [userId, invitationToken] of [["staff-a", token("expire-a")], ["staff-b", token("expire-b")]] as const) {
      await repository.inviteCounterStaff({
        invitationToken, inviterAccountId: "admin", userId, venueId: `venue-${userId}`,
        venueName: `Venue ${userId}`, suburb: null, now: NOW, expiresAt: EXPIRES_AT,
      });
    }
    const first = await repository.expireCounterStaffInvitations({ asOf: AT_EXPIRY, limit: 1 });
    const second = await repository.expireCounterStaffInvitations({ asOf: AT_EXPIRY, limit: 10 });
    expect(first.expiredCount).toBe(1);
    expect(second.expiredCount).toBe(1);
    await expect(repository.respondToCounterStaffInvitation({
      invitationToken: token("expire-a"), userId: "staff-a", decision: "decline", now: AT_EXPIRY,
    })).rejects.toSatisfy(expectCode("invitation_stale"));

    await expect(repository.createVenueClaim(claimInput({
      id: "suspended-claim", userId: "suspended", contactEmail: "suspended@example.test",
    }))).rejects.toSatisfy(expectCode("account_not_active"));
    await expect(repository.createVenueClaim(claimInput({
      id: "locked-claim", userId: "locked", contactEmail: "locked@example.test",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.assignVenueManager({
      assignmentId: "locked-manager", adminAccountId: "admin", userId: "locked",
      venueId: "locked-venue", venueName: "Locked Venue", suburb: null, now: NOW,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    raw.prepare("UPDATE accounts SET auth_provider = 'deleted' WHERE id = 'staff-a'").run();
    await expect(repository.createVenueClaim(claimInput({
      id: "deleted-claim", userId: "staff-a", contactEmail: "staff-a@example.test",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));

    raw.prepare(
      `INSERT INTO venue_manager_assignments (
         id, user_id, venue_id, venue_name, access_level, status, approved_by,
         expires_at, created_at, updated_at
       ) VALUES ('legacy-counter-id', 'staff-b', 'legacy-venue', 'Legacy Venue',
                 'counter_staff', 'active', 'admin', NULL, ?, ?)`,
    ).run(NOW, NOW);
    await expect(repository.getVenueAssignment({ userId: "staff-b", venueId: "legacy-venue" }))
      .resolves.toMatchObject({ id: "legacy-counter-id", accessLevel: "counter_staff", status: "active" });
  });

  it("rejects malformed stored timestamps and state with a stable persistence error", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "claimant");
    raw.prepare(
      `INSERT INTO venue_claim_requests (
         id, user_id, venue_id, venue_name, requester_name, requester_role,
         contact_email, status, created_at, updated_at
       ) VALUES ('bad-claim', 'claimant', 'venue-one', 'Venue One', 'Name', 'Owner',
                 'claimant@example.test', 'pending', 'not-a-date', ?)`,
    ).run(NOW);
    await expect(repository.getVenueClaim("bad-claim")).rejects.toSatisfy(expectCode("persistence_failure"));
  });
});
