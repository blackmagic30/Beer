import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdminAccountRepository,
  AdminAccountRepositoryError,
} from "../src/db/admin-account.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const NOW = "2026-08-09T01:00:00.000Z";
const LATER = "2026-08-09T02:00:00.000Z";
const LATEST = "2026-08-09T03:00:00.000Z";
const EXPIRES_AT = "2026-09-09T01:00:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AdminAccountRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new AdminAccountRepository(database) };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  overrides: {
    email?: string;
    displayName?: string | null;
    publicAccountId?: string;
    role?: "user" | "admin" | "venue_manager";
    subscriptionStatus?: "free" | "admin";
    status?: "active" | "warned" | "suspended";
    authProvider?: string;
    createdAt?: string;
    updatedAt?: string;
  } = {},
): void {
  const email = overrides.email ?? `${id}@example.test`;
  const displayName = overrides.displayName === undefined ? `User ${id}` : overrides.displayName;
  const publicAccountId = overrides.publicAccountId ?? `PP-${id}`;
  const role = overrides.role ?? "user";
  const subscriptionStatus = overrides.subscriptionStatus ?? "free";
  const status = overrides.status ?? "active";
  const authProvider = overrides.authProvider ?? "local";
  const createdAt = overrides.createdAt ?? NOW;
  const updatedAt = overrides.updatedAt ?? NOW;
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, display_name, display_name_key,
       auth_provider, role, subscription_status, status, created_at, updated_at
     ) VALUES (
       @id, @publicAccountId, @email, @passwordHash, @displayName, @displayNameKey,
       @authProvider, @role, @subscriptionStatus, @status, @createdAt, @updatedAt
     )`,
  ).run({
    id,
    publicAccountId,
    email,
    passwordHash: `hash-${id}`,
    displayName,
    displayNameKey: displayName?.toLowerCase() ?? null,
    authProvider,
    role,
    subscriptionStatus,
    status,
    createdAt,
    updatedAt,
  });
  raw.prepare(
    `INSERT INTO profiles (
       id, public_account_id, email, display_name, display_name_key, role,
       account_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    publicAccountId,
    email,
    displayName,
    displayName?.toLowerCase() ?? null,
    role,
    status,
    createdAt,
    updatedAt,
  );
}

function insertSession(
  raw: BetterSqlite3.Database,
  input: { token: string; userId: string; providerHash: string | null; revokedAt?: string | null },
): void {
  raw.prepare(
    `INSERT INTO auth_sessions (
       token_hash, user_id, provider_session_id_hash, created_at, expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.token, input.userId, input.providerHash, NOW, EXPIRES_AT, input.revokedAt ?? null);
}

describe("AdminAccountRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("authorizes from persistent state and returns deterministic, literal, bounded search results", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(raw, "exact", {
      email: "needle@example.test",
      displayName: "Unrelated Exact",
      createdAt: NOW,
    });
    insertAccount(raw, "email-prefix", {
      email: "needle-two@example.test",
      displayName: "Unrelated Prefix",
      createdAt: LATEST,
    });
    insertAccount(raw, "display-prefix", {
      email: "z@example.test",
      displayName: "Needle House",
      createdAt: LATER,
    });
    insertAccount(raw, "contains", {
      email: "x-needle@example.test",
      displayName: "Unrelated Contains",
      createdAt: LATEST,
    });
    insertAccount(raw, "literal-percent", {
      email: "literal@example.test",
      displayName: "Value %% Marker",
    });
    insertAccount(raw, "ordinary", { email: "ordinary@example.test" });

    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "admin",
      query: "  NEEDLE  ",
      limit: 25,
    })).resolves.toMatchObject([
      { id: "email-prefix" },
      { id: "exact" },
      { id: "display-prefix" },
      { id: "contains" },
    ]);
    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "admin",
      query: "needle@example.test",
      limit: 25,
    })).resolves.toMatchObject([
      { id: "exact" },
      { id: "contains" },
    ]);
    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "admin",
      query: "%%",
      limit: 25,
    })).resolves.toMatchObject([{ id: "literal-percent" }]);
    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "admin",
      query: "needle",
      limit: 26,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.searchAccountsForAdmin({
      actorAccountId: "admin",
      query: "x",
      limit: 5,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects stale, suspended, deleted, or non-admin actors without leaking identifiers", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "ordinary-actor");
    insertAccount(raw, "suspended-admin", {
      role: "admin",
      subscriptionStatus: "admin",
      status: "suspended",
    });
    insertAccount(raw, "deleted-admin", {
      role: "admin",
      subscriptionStatus: "admin",
      authProvider: "deleted",
    });
    insertAccount(raw, "target");

    for (const actorAccountId of ["ordinary-actor", "suspended-admin", "deleted-admin", "missing-secret-actor"]) {
      const result = await repository.searchAccountsForAdmin({
        actorAccountId,
        query: "target",
        limit: 5,
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AdminAccountRepositoryError);
      expect(result).toMatchObject({ code: "actor_not_authorized" });
      expect(String((result as Error).message)).not.toContain(actorAccountId);
    }
  });

  it("updates account/profile and contains every local session atomically on suspension", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(raw, "target", { role: "venue_manager", subscriptionStatus: "admin" });
    insertSession(raw, { token: "session-one", userId: "target", providerHash: "provider-one" });
    insertSession(raw, { token: "session-two", userId: "target", providerHash: "provider-two" });
    insertSession(raw, {
      token: "session-already-revoked",
      userId: "target",
      providerHash: "provider-old",
      revokedAt: NOW,
    });
    raw.prepare(
      `INSERT INTO account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run("pass-active", "target", "session-one", "code-one", NOW, EXPIRES_AT);
    raw.prepare(
      `INSERT INTO account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'revoked', ?, ?, ?)`,
    ).run("pass-old", "target", "session-two", "code-two", NOW, EXPIRES_AT, NOW);

    const result = await repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "target",
      status: "suspended",
      trustScore: 17,
      fraudStrikeCount: 3,
      expectedUpdatedAt: NOW,
      now: LATER,
    });

    expect(result).toMatchObject({
      account: {
        id: "target",
        role: "venue_manager",
        subscriptionStatus: "admin",
        status: "suspended",
        trustScore: 17,
        fraudStrikeCount: 3,
        updatedAt: LATER,
        isOver18Verified: false,
      },
      revokedSessions: 2,
      revokedDiscountPasses: 1,
      revokedProviderSessions: 3,
    });
    expect(raw.prepare("SELECT account_status, updated_at FROM profiles WHERE id = ?")
      .get("target")).toEqual({ account_status: "suspended", updated_at: LATER });
    expect(raw.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at = ?",
    ).get("target", LATER)).toEqual({ count: 2 });
    expect(raw.prepare(
      "SELECT count(*) AS count FROM revoked_provider_sessions WHERE user_id = ? AND reason = ?",
    ).get("target", "all_app_sessions_revoked")).toEqual({ count: 3 });
    expect(raw.prepare("SELECT count(*) AS count FROM security_audit_log").get()).toEqual({ count: 0 });
  });

  it("allows pending deletion review but fences terminal/in-flight deletion states and self-admin override", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(raw, "pending-target");
    raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("deletion-pending", "pending-target", "pending_review", NOW, LATEST, NOW, NOW);
    await expect(repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "pending-target",
      status: "warned",
      trustScore: 101,
      expectedUpdatedAt: NOW,
      now: LATER,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "pending-target",
      status: "warned",
      expectedUpdatedAt: NOW,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "pending-target",
      status: "warned",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).resolves.toMatchObject({ account: { status: "warned" } });

    for (const deletionStatus of ["processing", "failed", "completed"] as const) {
      const id = `${deletionStatus}-target`;
      insertAccount(raw, id);
      raw.prepare(
        `INSERT INTO account_deletion_requests (
           id, user_id, status, requested_at, execute_after, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(`deletion-${deletionStatus}`, id, deletionStatus, NOW, LATEST, NOW, NOW);
      await expect(repository.overrideUserStatus({
        actorAccountId: "admin",
        userId: id,
        status: "warned",
        expectedUpdatedAt: NOW,
        now: LATER,
      })).rejects.toMatchObject({ code: "account_deletion_locked" });
    }
    await expect(repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "admin",
      status: "suspended",
      expectedUpdatedAt: NOW,
      now: LATER,
    })).rejects.toMatchObject({ code: "admin_self_override" });
  });

  it("uses optimistic concurrency so only one overlapping status decision commits", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(raw, "target");

    const decisions = await Promise.allSettled([
      repository.overrideUserStatus({
        actorAccountId: "admin",
        userId: "target",
        status: "warned",
        expectedUpdatedAt: NOW,
        now: LATER,
      }),
      repository.overrideUserStatus({
        actorAccountId: "admin",
        userId: "target",
        status: "suspended",
        expectedUpdatedAt: NOW,
        now: LATEST,
      }),
    ]);

    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    const rejection = decisions.find((decision) => decision.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toMatchObject({ code: "write_conflict" });
    }
    const account = raw.prepare("SELECT status, updated_at FROM accounts WHERE id = ?").get("target");
    const profile = raw.prepare("SELECT account_status, updated_at FROM profiles WHERE id = ?").get("target");
    expect(profile).toEqual({
      account_status: (account as { status: string }).status,
      updated_at: (account as { updated_at: string }).updated_at,
    });
  });

  it("rolls back account and containment writes on profile failure and maps malformed/driver failures safely", async () => {
    const { raw, database, repository } = fixture();
    insertAccount(raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(raw, "rollback-target");
    insertSession(raw, {
      token: "rollback-session",
      userId: "rollback-target",
      providerHash: "rollback-provider-secret",
    });
    raw.exec(`CREATE TRIGGER reject_admin_profile_override
      BEFORE UPDATE OF account_status ON profiles
      WHEN OLD.id = 'rollback-target'
      BEGIN SELECT RAISE(ABORT, 'private profile failure detail'); END`);

    const failed = await repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "rollback-target",
      status: "suspended",
      expectedUpdatedAt: NOW,
      now: LATER,
    }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "persistence_failure" });
    expect(String((failed as Error).message)).not.toContain("private profile failure detail");
    expect(raw.prepare("SELECT status, updated_at FROM accounts WHERE id = ?").get("rollback-target"))
      .toEqual({ status: "active", updated_at: NOW });
    expect(raw.prepare("SELECT revoked_at FROM auth_sessions WHERE token_hash = ?").get("rollback-session"))
      .toEqual({ revoked_at: null });
    expect(raw.prepare("SELECT count(*) AS count FROM revoked_provider_sessions").get())
      .toEqual({ count: 0 });

    raw.exec("DROP TRIGGER reject_admin_profile_override");
    raw.prepare("UPDATE accounts SET trust_score = 'malformed-private-value' WHERE id = ?")
      .run("rollback-target");
    const malformed = await repository.overrideUserStatus({
      actorAccountId: "admin",
      userId: "rollback-target",
      status: "warned",
      expectedUpdatedAt: NOW,
      now: LATER,
    }).catch((error: unknown) => error);
    expect(malformed).toMatchObject({ code: "malformed_record" });
    expect(String((malformed as Error).message)).not.toContain("malformed-private-value");
    expect(raw.prepare("SELECT status, updated_at FROM accounts WHERE id = ?").get("rollback-target"))
      .toEqual({ status: "active", updated_at: NOW });

    await database.close();
    const driverFailure = await repository.searchAccountsForAdmin({
      actorAccountId: "admin-secret-id",
      query: "private-query",
      limit: 5,
    }).catch((error: unknown) => error);
    expect(driverFailure).toMatchObject({ code: "persistence_failure" });
    expect(String((driverFailure as Error).message)).not.toContain("admin-secret-id");
    expect(String((driverFailure as Error).message)).not.toContain("private-query");
  });
});
