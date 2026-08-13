import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountSessionRepository,
  AccountSessionRepositoryError,
} from "../src/db/account-session.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const NOW = "2026-08-08T02:00:00.000Z";
const ONE_MINUTE_LATER = "2026-08-08T02:01:00.000Z";
const THREE_MINUTES_LATER = "2026-08-08T02:03:00.000Z";
const RESET_AT = "2026-08-08T03:00:00.000Z";
const EXPIRES_AT = "2026-09-08T02:00:00.000Z";

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AccountSessionRepository;
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new AccountSessionRepository(database) };
}

async function createAccount(
  repository: AccountSessionRepository,
  id: string,
  overrides: Partial<Parameters<AccountSessionRepository["createAccount"]>[0]> = {},
) {
  return repository.createAccount({
    id,
    email: `${id}@example.test`,
    passwordHash: `password-hash-${id}`,
    displayName: `User ${id}`,
    displayNameKey: `user ${id}`,
    role: "user",
    subscriptionStatus: "free",
    now: NOW,
    ...overrides,
  });
}

describe("AccountSessionRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("creates an account and profile atomically with normalized, portable mappings", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "account-one", {
      email: "  PERSON@Example.Test ",
      displayName: "Person One",
      displayNameKey: "  PERSON ONE ",
      role: "admin",
      subscriptionStatus: "admin",
      termsAcceptedAt: NOW,
      privacyAcceptedAt: NOW,
      termsVersion: "2026-08",
      privacyVersion: "2026-08",
    });

    expect(account).toMatchObject({
      id: "account-one",
      email: "person@example.test",
      displayNameKey: "person one",
      isOver18Verified: false,
      trustScore: 50,
      contributionPointsCurrentMonth: 0,
    });
    expect(account.publicAccountId).toMatch(/^PP-[A-HJ-NP-Z2-9]{8}$/);
    expect(await repository.getAccountByEmail("PERSON@EXAMPLE.TEST")).toEqual(account);
    expect(await repository.getAccountById(account.id)).toEqual(account);
    expect(await repository.getAccountByDisplayNameKey("PERSON ONE")).toEqual(account);
    expect(await repository.getAccountByPublicAccountId(account.publicAccountId.toLowerCase())).toEqual(account);
    expect(await repository.getAccountBySupabaseUserId(account.id)).toEqual(account);
    expect(await repository.listActiveAdminAccounts()).toEqual([account]);
    expect(await repository.listActiveAdminAccounts(account.id)).toEqual([]);
    raw.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ?")
      .run("cus_account_one", account.id);
    expect(await repository.getAccountByStripeCustomerId("cus_account_one"))
      .toMatchObject({ id: account.id, stripeCustomerId: "cus_account_one" });
    expect(raw.prepare(
      `SELECT public_account_id AS publicAccountId, email, display_name AS displayName,
              display_name_key AS displayNameKey, is_over_18_verified AS isOver18Verified
       FROM profiles WHERE id = ?`,
    ).get(account.id)).toEqual({
      publicAccountId: account.publicAccountId,
      email: account.email,
      displayName: "Person One",
      displayNameKey: "person one",
      isOver18Verified: 0,
    });
  });

  it("serializes case-normalized account and provider-link races with stable secret-free errors", async () => {
    const { repository } = fixture();
    const secretEmail = "Race-Identity@Example.Test";
    const creations = await Promise.allSettled([
      createAccount(repository, "race-one", { email: secretEmail, displayNameKey: "race one" }),
      createAccount(repository, "race-two", { email: secretEmail.toUpperCase(), displayNameKey: "race two" }),
    ]);
    expect(creations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const creationFailure = creations.find((result) => result.status === "rejected");
    expect(creationFailure?.status).toBe("rejected");
    if (creationFailure?.status === "rejected") {
      expect(creationFailure.reason).toBeInstanceOf(AccountSessionRepositoryError);
      expect(creationFailure.reason).toMatchObject({ code: "account_identity_conflict" });
      expect(String(creationFailure.reason.message)).not.toContain(secretEmail);
    }

    const first = await createAccount(repository, "link-one");
    const second = await createAccount(repository, "link-two");
    const providerIdentity = "provider-identity-secret-value";
    const links = await Promise.allSettled([
      repository.linkSupabaseAccount({
        userId: first.id,
        supabaseUserId: providerIdentity,
        email: first.email,
        authProvider: "supabase",
        displayName: first.displayName,
        displayNameKey: first.displayNameKey,
        avatarUrl: null,
        emailVerifiedAt: NOW,
        mfaLevel: "aal2",
        mfaVerifiedAt: NOW,
        now: NOW,
      }),
      repository.linkSupabaseAccount({
        userId: second.id,
        supabaseUserId: providerIdentity,
        email: second.email,
        authProvider: "supabase",
        displayName: second.displayName,
        displayNameKey: second.displayNameKey,
        avatarUrl: null,
        emailVerifiedAt: NOW,
        mfaLevel: "aal2",
        mfaVerifiedAt: NOW,
        now: NOW,
      }),
    ]);
    expect(links.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const linkFailure = links.find((result) => result.status === "rejected");
    if (linkFailure?.status !== "rejected") throw new Error("Expected one provider link to fail.");
    expect(linkFailure.reason).toMatchObject({ code: "account_identity_conflict" });
    expect(String(linkFailure.reason.message)).not.toContain(providerIdentity);
  });

  it("updates display, security, legal, and age state without splitting account/profile invariants", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "invariant-user");
    const displayed = await repository.updateAccountDisplayName({
      userId: account.id,
      displayName: "New Display",
      displayNameKey: "NEW DISPLAY",
      now: ONE_MINUTE_LATER,
    });
    expect(displayed.displayNameKey).toBe("new display");
    const secured = await repository.updateAccountSecurityClaims({
      userId: account.id,
      emailVerifiedAt: ONE_MINUTE_LATER,
      mfaLevel: "aal2",
      mfaVerifiedAt: ONE_MINUTE_LATER,
      now: ONE_MINUTE_LATER,
    });
    expect(secured).toMatchObject({
      emailVerifiedAt: ONE_MINUTE_LATER,
      mfaLevel: "aal2",
      mfaVerifiedAt: ONE_MINUTE_LATER,
    });
    const legal = await repository.updateLegalAcceptance({
      userId: account.id,
      acceptedAt: ONE_MINUTE_LATER,
      termsVersion: "terms-v2",
      privacyVersion: "privacy-v2",
    });
    expect(legal).toMatchObject({
      termsAcceptedAt: ONE_MINUTE_LATER,
      privacyAcceptedAt: ONE_MINUTE_LATER,
      termsVersion: "terms-v2",
      privacyVersion: "privacy-v2",
    });
    expect((await repository.updateAgeConfirmed(account.id, ONE_MINUTE_LATER)).ageConfirmedAt)
      .toBe(ONE_MINUTE_LATER);
    const verification = await repository.upsertAgeVerification({
      id: "age-verification-one",
      userId: account.id,
      status: "verified",
      ageThreshold: 18,
      isOver18: true,
      providerName: "test-provider",
      providerReferenceId: "provider-reference",
      checkedAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      now: ONE_MINUTE_LATER,
    });
    expect(verification).toMatchObject({ ageThreshold: 18, isOver18: true, status: "verified" });
    expect(await repository.getLatestAgeVerification(account.id)).toEqual(verification);
    expect(await repository.getAccountById(account.id)).toMatchObject({
      ageVerificationStatus: "verified",
      isOver18Verified: true,
    });
    expect(raw.prepare(
      `SELECT display_name_key AS displayNameKey, age_verification_status AS ageStatus,
              is_over_18_verified AS verified FROM profiles WHERE id = ?`,
    ).get(account.id)).toEqual({ displayNameKey: "new display", ageStatus: "verified", verified: 1 });
  });

  it("rolls back an account mutation when its profile half fails", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rollback-user");
    raw.exec(`CREATE TRIGGER reject_profile_display_update
      BEFORE UPDATE OF display_name ON profiles
      BEGIN SELECT RAISE(ABORT, 'profile invariant rejected'); END`);

    await expect(repository.updateAccountDisplayName({
      userId: account.id,
      displayName: "Must Roll Back",
      displayNameKey: "must roll back",
      now: ONE_MINUTE_LATER,
    })).rejects.toMatchObject({ code: "display_name_conflict" });
    expect(await repository.getAccountById(account.id)).toMatchObject({
      displayName: account.displayName,
      displayNameKey: account.displayNameKey,
      updatedAt: NOW,
    });
  });

  it("enforces the active-session cap under overlapping creation and never exposes token secrets in conflicts", async () => {
    const { repository } = fixture();
    const account = await createAccount(repository, "session-cap-user");
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      tokenHash: token(`overlap-${index}`),
      userId: account.id,
      createdAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
      expiresAt: EXPIRES_AT,
      providerSessionIdHash: `provider-overlap-${index}`,
      maxActiveSessions: 3,
    }));
    await expect(Promise.all(sessions.map((session) => repository.createSessionWithLimit(session))))
      .resolves.toHaveLength(12);
    expect(await repository.countUserSessions(account.id, NOW)).toBe(3);
    expect(await repository.countUserSessionHistory(account.id, NOW)).toBe(9);
    expect(await repository.listUserSessions({ userId: account.id, now: NOW, limit: 200 }))
      .toHaveLength(3);

    const duplicateSecret = token("duplicate-session-secret");
    await repository.createSession({
      tokenHash: duplicateSecret,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    const failure = await repository.createSession({
      tokenHash: duplicateSecret,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "session_conflict" });
    expect(String((failure as Error).message)).not.toContain(duplicateSecret);
  });

  it("authenticates, throttles monotonic touches, and atomically revokes provider-backed sessions", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "auth-user");
    const firstToken = token("provider-session-one");
    const secondToken = token("provider-session-two");
    for (const tokenHash of [firstToken, secondToken]) {
      await repository.createSession({
        tokenHash,
        userId: account.id,
        providerSessionIdHash: "provider-family",
        createdAt: NOW,
        expiresAt: EXPIRES_AT,
        lastIpHash: "ip-one",
        userAgentHash: "agent-one",
      });
    }
    expect(await repository.getAccountBySessionTokenHash(firstToken, NOW)).toEqual(account);
    expect(await repository.getSessionExpiresAt(firstToken, NOW)).toBe(EXPIRES_AT);
    expect(await repository.getActiveProviderSessionExpiresAt({
      tokenHash: firstToken,
      userId: account.id,
      providerSessionIdHash: "provider-family",
      now: NOW,
    })).toBe(EXPIRES_AT);
    expect(await repository.getActiveSessionCreatedAt({ tokenHash: firstToken, userId: account.id, now: NOW }))
      .toBe(NOW);

    expect(await repository.touchSession({
      tokenHash: firstToken,
      lastUsedAt: THREE_MINUTES_LATER,
      lastIpHash: "ip-one",
      userAgentHash: "agent-one",
    })).toBe(true);
    expect(await repository.touchSession({
      tokenHash: firstToken,
      lastUsedAt: new Date(Date.parse(THREE_MINUTES_LATER) + 30_000).toISOString(),
      lastIpHash: "ip-one",
      userAgentHash: "agent-one",
    })).toBe(false);
    expect(await repository.touchSession({
      tokenHash: firstToken,
      lastUsedAt: new Date(Date.parse(THREE_MINUTES_LATER) + 30_000).toISOString(),
      lastIpHash: "ip-two",
      userAgentHash: "agent-one",
    })).toBe(true);
    expect(await repository.touchSession({
      tokenHash: firstToken,
      lastUsedAt: ONE_MINUTE_LATER,
      lastIpHash: "stale-ip",
      userAgentHash: "stale-agent",
    })).toBe(false);

    expect(await repository.revokeSession({ tokenHash: firstToken, revokedAt: RESET_AT })).toBe(true);
    expect(await repository.getAccountBySessionTokenHash(firstToken, RESET_AT)).toBeNull();
    expect(await repository.getAccountBySessionTokenHash(secondToken, RESET_AT)).toBeNull();
    expect(await repository.isProviderSessionRevoked({
      userId: account.id,
      providerSessionIdHash: "provider-family",
    })).toBe(true);
    expect(raw.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at = ?",
    ).get(account.id, RESET_AT)).toEqual({ count: 2 });
  });

  it("contains password resets across sessions, discount passes, reward codes, and provider-token boundaries", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "reset-user");
    const tokenHash = token("password-reset-session-secret");
    await repository.createSession({
      tokenHash,
      userId: account.id,
      providerSessionIdHash: "provider-reset-family",
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    raw.prepare(
      `INSERT INTO account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run("reset-pass", account.id, tokenHash, "reset-pass-code", NOW, EXPIRES_AT);
    raw.prepare(
      `INSERT INTO free_pint_reward_codes (
         id, user_id, public_account_id, code_hash, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run("reset-reward", account.id, account.publicAccountId, "reset-reward-code", NOW, EXPIRES_AT);

    await expect(repository.completePasswordResetContainment({
      userId: account.id,
      providerSessionIdHash: "current-provider-reset-session",
      providerTokensValidAfter: RESET_AT,
      revokedAt: RESET_AT,
    })).resolves.toEqual({ revokedSessions: 1, revokedDiscountPasses: 1, cancelledRewardCodes: 1 });
    expect(await repository.getAccountById(account.id)).toMatchObject({ providerTokensValidAfter: RESET_AT });
    expect(raw.prepare("SELECT status, revoked_at AS revokedAt FROM account_discount_passes WHERE id = 'reset-pass'").get())
      .toEqual({ status: "revoked", revokedAt: RESET_AT });
    expect(raw.prepare("SELECT status, cancelled_at AS cancelledAt FROM free_pint_reward_codes WHERE id = 'reset-reward'").get())
      .toEqual({ status: "cancelled", cancelledAt: RESET_AT });
    await expect(repository.createSession({
      tokenHash: token("must-not-be-created"),
      userId: account.id,
      providerSessionIdHash: "provider-reset-family",
      createdAt: RESET_AT,
      expiresAt: EXPIRES_AT,
    })).rejects.toMatchObject({ code: "provider_session_revoked" });
  });

  it("lists current/history sessions, revokes by public session id/all, and blocks deletion-locked accounts", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "history-user");
    const localToken = token("history-local");
    const providerToken = token("history-provider");
    await repository.createSession({ tokenHash: localToken, userId: account.id, createdAt: NOW, expiresAt: EXPIRES_AT });
    await repository.createSession({
      tokenHash: providerToken,
      userId: account.id,
      providerSessionIdHash: "history-provider-family",
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
    });
    expect(await repository.listUserSessions({ userId: account.id, now: NOW })).toHaveLength(2);
    expect(await repository.revokeUserSessionById({
      userId: account.id,
      sessionId: localToken.slice(0, 24),
      revokedAt: RESET_AT,
    })).toEqual({ revoked: true, revokedDiscountPasses: 0 });
    expect(await repository.countUserSessions(account.id, NOW)).toBe(1);
    expect(await repository.countUserSessionHistory(account.id, NOW)).toBe(1);
    expect(await repository.revokeUserSessions({ userId: account.id, revokedAt: RESET_AT })).toBe(1);
    expect(await repository.countUserSessions(account.id, NOW)).toBe(0);
    expect(await repository.listUserSessionHistory({ userId: account.id, now: NOW })).toHaveLength(2);

    const blockedToken = token("deletion-locked-token");
    raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
    ).run("deletion-lock", account.id, RESET_AT, RESET_AT, RESET_AT, RESET_AT);
    expect(await repository.hasDeletionLock(account.id)).toBe(true);
    await expect(repository.createSession({
      tokenHash: blockedToken,
      userId: account.id,
      createdAt: RESET_AT,
      expiresAt: EXPIRES_AT,
    })).rejects.toMatchObject({ code: "account_not_session_eligible" });
    expect(await repository.getAccountBySessionTokenHash(providerToken, RESET_AT)).toBeNull();
    expect(await repository.touchSession({
      tokenHash: providerToken,
      lastUsedAt: RESET_AT,
      lastIpHash: null,
      userAgentHash: null,
    })).toBe(false);
  });

  it("rejects malformed or unbounded inputs before opening unsafe SQL work", async () => {
    const { repository } = fixture();
    await expect(createAccount(repository, "bad-time", { now: "2026-08-08 02:00:00" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    const account = await createAccount(repository, "limit-user");
    await expect(repository.createSessionWithLimit({
      tokenHash: token("bad-limit"),
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 0,
    })).rejects.toThrow("Active session limit must be a positive integer.");
    await expect(repository.listUserSessions({ userId: account.id, now: NOW, limit: Number.NaN }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });
});
