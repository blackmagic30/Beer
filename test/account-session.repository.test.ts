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
const SIX_MINUTES_LATER = "2026-08-08T02:06:00.000Z";
const RESET_AT = "2026-08-08T03:00:00.000Z";
const EXPIRES_AT = "2026-09-08T02:00:00.000Z";

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function claim(label: string): string {
  return crypto.createHash("sha256").update(label).digest("base64url");
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

  it("atomically rotates one active session while retaining its revoked audit tombstone", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-user");
    const currentTokenHash = token("rotation-current");
    const newTokenHash = token("rotation-replacement");
    const currentProviderHash = token("provider-family-current");
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      providerSessionIdHash: "provider-family-before-rotation",
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
      lastIpHash: "ip-before-rotation",
      userAgentHash: "agent-before-rotation",
    });
    raw.prepare(
      `INSERT INTO account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run("rotation-pass", account.id, currentTokenHash, "rotation-code", NOW, EXPIRES_AT);

    await expect(repository.rotateOrCreateSessionToken({
      currentTokenHash,
      newTokenHash,
      userId: account.id,
      providerSessionIdHash: currentProviderHash,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      lastUsedAt: ONE_MINUTE_LATER,
      lastIpHash: "ip-after-rotation",
      userAgentHash: "agent-after-rotation",
      maxActiveSessions: 10,
    })).resolves.toBe("rotated");

    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, user_id AS userId,
              provider_session_id_hash AS providerSessionIdHash,
              created_at AS createdAt, expires_at AS expiresAt,
              last_used_at AS lastUsedAt, last_ip_hash AS lastIpHash,
              user_agent_hash AS userAgentHash
       FROM auth_sessions WHERE token_hash = ?`,
    ).get(newTokenHash)).toEqual({
      tokenHash: newTokenHash,
      userId: account.id,
      providerSessionIdHash: currentProviderHash,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      lastUsedAt: ONE_MINUTE_LATER,
      lastIpHash: "ip-after-rotation",
      userAgentHash: "agent-after-rotation",
    });
    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, provider_session_id_hash AS providerSessionIdHash,
              revoked_at AS revokedAt
       FROM auth_sessions WHERE token_hash = ?`,
    ).get(currentTokenHash)).toEqual({
      tokenHash: currentTokenHash,
      providerSessionIdHash: "provider-family-before-rotation",
      revokedAt: ONE_MINUTE_LATER,
    });
    expect(raw.prepare(
      `SELECT session_token_hash AS sessionTokenHash, status, revoked_at AS revokedAt
       FROM account_discount_passes WHERE id = 'rotation-pass'`,
    ).get()).toEqual({
      sessionTokenHash: currentTokenHash,
      status: "revoked",
      revokedAt: ONE_MINUTE_LATER,
    });
    expect(await repository.getAccountBySessionTokenHash(currentTokenHash, ONE_MINUTE_LATER)).toBeNull();
    expect(await repository.getAccountBySessionTokenHash(newTokenHash, ONE_MINUTE_LATER)).toEqual(account);
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
    expect(await repository.countUserSessionHistory(account.id, ONE_MINUTE_LATER)).toBe(1);
  });

  it("atomically links Supabase account state while rotating across a new provider boundary", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "atomic-supabase-link-user", {
      displayName: "Local Display",
      displayNameKey: "local display",
    });
    const currentTokenHash = token("atomic-supabase-link-current");
    const otherTokenHash = token("atomic-supabase-link-other");
    const newTokenHash = token("atomic-supabase-link-new");
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await repository.createSession({
      tokenHash: otherTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    for (const [id, sessionTokenHash] of [
      ["atomic-supabase-link-current-pass", currentTokenHash],
      ["atomic-supabase-link-other-pass", otherTokenHash],
    ] as const) {
      raw.prepare(
        `INSERT INTO account_discount_passes (
           id, user_id, session_token_hash, code_hash, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, account.id, sessionTokenHash, token(`${id}-code`), NOW, EXPIRES_AT);
    }

    await expect(repository.rotateOrCreateSessionToken({
      currentTokenHash,
      newTokenHash,
      userId: account.id,
      providerSessionIdHash: token("atomic-supabase-link-provider-session"),
      providerTokenIssuedAt: ONE_MINUTE_LATER,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
      supabaseAccountMutation: {
        authProvider: "supabase",
        supabaseUserId: "atomic-supabase-provider-user",
        email: "  ATOMIC-SUPABASE@Example.Test ",
        displayName: "Provider Display",
        displayNameKey: "  PROVIDER DISPLAY ",
        avatarUrl: "https://example.test/provider-avatar.png",
        emailVerifiedAt: ONE_MINUTE_LATER,
        mfaLevel: "aal2",
        mfaVerifiedAt: ONE_MINUTE_LATER,
        legalAcceptance: {
          termsVersion: "terms-current",
          privacyVersion: "privacy-current",
          ageConfirmed: true,
        },
      },
    })).resolves.toBe("rotated");

    expect(await repository.getAccountById(account.id)).toMatchObject({
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-provider-user",
      email: "atomic-supabase@example.test",
      displayName: "Provider Display",
      displayNameKey: "provider display",
      avatarUrl: "https://example.test/provider-avatar.png",
      emailVerifiedAt: ONE_MINUTE_LATER,
      mfaLevel: "aal2",
      mfaVerifiedAt: ONE_MINUTE_LATER,
      termsAcceptedAt: ONE_MINUTE_LATER,
      privacyAcceptedAt: ONE_MINUTE_LATER,
      termsVersion: "terms-current",
      privacyVersion: "privacy-current",
      ageConfirmedAt: ONE_MINUTE_LATER,
      updatedAt: ONE_MINUTE_LATER,
    });
    expect(raw.prepare(
      `SELECT email, display_name AS displayName, display_name_key AS displayNameKey,
              avatar_url AS avatarUrl, updated_at AS updatedAt
       FROM profiles WHERE id = ?`,
    ).get(account.id)).toEqual({
      email: "atomic-supabase@example.test",
      displayName: "Provider Display",
      displayNameKey: "provider display",
      avatarUrl: "https://example.test/provider-avatar.png",
      updatedAt: ONE_MINUTE_LATER,
    });
    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, revoked_at AS revokedAt
       FROM auth_sessions WHERE user_id = ? ORDER BY token_hash`,
    ).all(account.id)).toEqual([
      { tokenHash: currentTokenHash, revokedAt: ONE_MINUTE_LATER },
      { tokenHash: newTokenHash, revokedAt: null },
      { tokenHash: otherTokenHash, revokedAt: ONE_MINUTE_LATER },
    ].sort((left, right) => left.tokenHash.localeCompare(right.tokenHash)));
    expect(raw.prepare(
      `SELECT status, revoked_at AS revokedAt FROM account_discount_passes
       WHERE user_id = ? ORDER BY id`,
    ).all(account.id)).toEqual([
      { status: "revoked", revokedAt: ONE_MINUTE_LATER },
      { status: "revoked", revokedAt: ONE_MINUTE_LATER },
    ]);
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
  });

  it("returns the account committed with a Supabase first-session mutation and a shaped conflict", async () => {
    const { repository } = fixture();
    const account = await createAccount(repository, "atomic-supabase-result-user", {
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-result-provider-user",
      emailVerifiedAt: NOW,
      mfaLevel: "aal1",
    });
    const providerSessionIdHash = token("atomic-supabase-result-provider-session");
    const mutation = {
      authProvider: "supabase" as const,
      supabaseUserId: account.supabaseUserId!,
      email: "  ATOMIC-SUPABASE-RESULT@Example.Test ",
      displayName: "Atomic Supabase Result",
      displayNameKey: "  ATOMIC SUPABASE RESULT ",
      avatarUrl: "https://example.test/atomic-supabase-result.png",
      emailVerifiedAt: ONE_MINUTE_LATER,
      mfaLevel: "aal2",
      mfaVerifiedAt: ONE_MINUTE_LATER,
    };

    const result = await repository.rotateOrCreateSessionTokenWithSupabaseAccountMutation({
      currentTokenHash: null,
      newTokenHash: token("atomic-supabase-result-new"),
      userId: account.id,
      providerSessionIdHash,
      providerTokenIssuedAt: ONE_MINUTE_LATER,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
      supabaseAccountMutation: mutation,
    });

    expect(result.status).toBe("created");
    if (result.status === "conflict") throw new Error("Expected the first provider session to be created.");
    expect(result.account).toEqual(await repository.getAccountById(account.id));
    expect(result.account).toMatchObject({
      email: "atomic-supabase-result@example.test",
      displayName: "Atomic Supabase Result",
      displayNameKey: "atomic supabase result",
      avatarUrl: "https://example.test/atomic-supabase-result.png",
      emailVerifiedAt: ONE_MINUTE_LATER,
      mfaLevel: "aal2",
      mfaVerifiedAt: ONE_MINUTE_LATER,
      updatedAt: ONE_MINUTE_LATER,
    });

    await expect(repository.rotateOrCreateSessionTokenWithSupabaseAccountMutation({
      currentTokenHash: null,
      newTokenHash: token("atomic-supabase-result-conflict"),
      userId: account.id,
      providerSessionIdHash,
      providerTokenIssuedAt: ONE_MINUTE_LATER,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
      supabaseAccountMutation: mutation,
    })).resolves.toEqual({ status: "conflict" });
  });

  it("rolls back every Supabase account and profile write when the late session insert conflicts", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "atomic-supabase-rollback-user", {
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-rollback-provider-original",
      emailVerifiedAt: NOW,
      mfaLevel: "aal1",
    });
    const currentTokenHash = token("atomic-supabase-rollback-current");
    const collidingTokenHash = token("atomic-supabase-rollback-collision");
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      providerSessionIdHash: token("atomic-supabase-rollback-provider-session-original"),
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    const collisionOwner = await createAccount(repository, "atomic-supabase-rollback-collision-owner");
    await repository.createSession({
      tokenHash: collidingTokenHash,
      userId: collisionOwner.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    const beforeAccount = await repository.getAccountById(account.id);
    const beforeProfile = raw.prepare("SELECT * FROM profiles WHERE id = ?").get(account.id);

    await expect(repository.rotateOrCreateSessionToken({
      currentTokenHash,
      newTokenHash: collidingTokenHash,
      userId: account.id,
      providerSessionIdHash: token("atomic-supabase-rollback-provider-session-new"),
      providerTokenIssuedAt: ONE_MINUTE_LATER,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
      supabaseAccountMutation: {
        authProvider: "supabase",
        supabaseUserId: "atomic-supabase-rollback-provider-changed",
        email: "atomic-supabase-rollback-changed@example.test",
        displayName: "Changed Despite Conflict",
        displayNameKey: "changed despite conflict",
        avatarUrl: "https://example.test/changed.png",
        emailVerifiedAt: ONE_MINUTE_LATER,
        mfaLevel: "aal2",
        mfaVerifiedAt: ONE_MINUTE_LATER,
        legalAcceptance: {
          termsVersion: "changed-terms",
          privacyVersion: "changed-privacy",
          ageConfirmed: true,
        },
      },
    })).resolves.toBe("conflict");

    expect(await repository.getAccountById(account.id)).toEqual(beforeAccount);
    expect(raw.prepare("SELECT * FROM profiles WHERE id = ?").get(account.id)).toEqual(beforeProfile);
    expect(await repository.getAccountBySessionTokenHash(currentTokenHash, ONE_MINUTE_LATER))
      .toEqual(beforeAccount);
    expect(raw.prepare(
      "SELECT user_id AS userId, revoked_at AS revokedAt FROM auth_sessions WHERE token_hash = ?",
    ).get(collidingTokenHash)).toEqual({ userId: collisionOwner.id, revokedAt: null });
  });

  it("rejects Supabase identity conflicts before changing the account, profile, or current session", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "atomic-supabase-identity-user", {
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-identity-provider",
    });
    const peer = await createAccount(repository, "atomic-supabase-identity-peer", {
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-identity-peer-provider",
      displayName: "Peer Display",
      displayNameKey: "peer display",
    });
    const currentTokenHash = token("atomic-supabase-identity-current");
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    const beforeAccount = await repository.getAccountById(account.id);
    const beforeProfile = raw.prepare("SELECT * FROM profiles WHERE id = ?").get(account.id);
    const rotation = (overrides: { email: string; supabaseUserId: string; displayNameKey: string }) =>
      repository.rotateOrCreateSessionToken({
        currentTokenHash,
        newTokenHash: token(`atomic-supabase-identity-new-${overrides.email}`),
        userId: account.id,
        providerSessionIdHash: token(`atomic-supabase-identity-session-${overrides.email}`),
        providerTokenIssuedAt: ONE_MINUTE_LATER,
        createdAt: ONE_MINUTE_LATER,
        expiresAt: EXPIRES_AT,
        maxActiveSessions: 10,
        supabaseAccountMutation: {
          authProvider: "supabase",
          supabaseUserId: overrides.supabaseUserId,
          email: overrides.email,
          displayName: "Conflicting Display",
          displayNameKey: overrides.displayNameKey,
          avatarUrl: null,
          emailVerifiedAt: ONE_MINUTE_LATER,
          mfaLevel: "aal2",
          mfaVerifiedAt: ONE_MINUTE_LATER,
        },
      });

    await expect(rotation({
      email: peer.email,
      supabaseUserId: account.supabaseUserId!,
      displayNameKey: "available display",
    })).rejects.toMatchObject({ code: "account_identity_conflict" });
    await expect(rotation({
      email: account.email,
      supabaseUserId: peer.supabaseUserId!,
      displayNameKey: "available display",
    })).rejects.toMatchObject({ code: "account_identity_conflict" });
    await expect(rotation({
      email: account.email,
      supabaseUserId: account.supabaseUserId!,
      displayNameKey: peer.displayNameKey!,
    })).rejects.toMatchObject({ code: "display_name_conflict" });

    expect(await repository.getAccountById(account.id)).toEqual(beforeAccount);
    expect(raw.prepare("SELECT * FROM profiles WHERE id = ?").get(account.id)).toEqual(beforeProfile);
    expect(await repository.getAccountBySessionTokenHash(currentTokenHash, ONE_MINUTE_LATER))
      .toEqual(beforeAccount);
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
  });

  it("commits only the winning concurrent Supabase mutation with its replacement session", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "atomic-supabase-race-user", {
      authProvider: "supabase",
      supabaseUserId: "atomic-supabase-race-provider-user",
      emailVerifiedAt: NOW,
      mfaLevel: "aal1",
    });
    const currentTokenHash = token("atomic-supabase-race-current");
    const replacements = [token("atomic-supabase-race-first"), token("atomic-supabase-race-second")];
    const providerHashes = [token("atomic-supabase-race-provider-first"), token("atomic-supabase-race-provider-second")];
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });

    const results = await Promise.all(replacements.map((newTokenHash, index) =>
      repository.rotateOrCreateSessionToken({
        currentTokenHash,
        newTokenHash,
        userId: account.id,
        providerSessionIdHash: providerHashes[index]!,
        providerTokenIssuedAt: ONE_MINUTE_LATER,
        createdAt: ONE_MINUTE_LATER,
        expiresAt: EXPIRES_AT,
        maxActiveSessions: 10,
        supabaseAccountMutation: {
          authProvider: "supabase",
          supabaseUserId: "atomic-supabase-race-provider-user",
          email: `atomic-supabase-race-${index}@example.test`,
          displayName: `Atomic Supabase Winner ${index}`,
          displayNameKey: `atomic supabase winner ${index}`,
          avatarUrl: `https://example.test/winner-${index}.png`,
          emailVerifiedAt: ONE_MINUTE_LATER,
          mfaLevel: index === 0 ? "aal1" : "aal2",
          mfaVerifiedAt: index === 0 ? null : ONE_MINUTE_LATER,
        },
      })));
    expect(results.filter((result) => result === "rotated")).toHaveLength(1);
    expect(results.filter((result) => result === "conflict")).toHaveLength(1);
    const winner = results.findIndex((result) => result === "rotated");
    expect(await repository.getAccountById(account.id)).toMatchObject({
      email: `atomic-supabase-race-${winner}@example.test`,
      displayName: `Atomic Supabase Winner ${winner}`,
      displayNameKey: `atomic supabase winner ${winner}`,
      avatarUrl: `https://example.test/winner-${winner}.png`,
      mfaLevel: winner === 0 ? "aal1" : "aal2",
      mfaVerifiedAt: winner === 0 ? null : ONE_MINUTE_LATER,
    });
    expect(raw.prepare(
      `SELECT email, display_name AS displayName, avatar_url AS avatarUrl
       FROM profiles WHERE id = ?`,
    ).get(account.id)).toEqual({
      email: `atomic-supabase-race-${winner}@example.test`,
      displayName: `Atomic Supabase Winner ${winner}`,
      avatarUrl: `https://example.test/winner-${winner}.png`,
    });
    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, provider_session_id_hash AS providerSessionIdHash
       FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`,
    ).all(account.id)).toEqual([{
      tokenHash: replacements[winner],
      providerSessionIdHash: providerHashes[winner],
    }]);
  });

  it("creates a first browser session once and conflicts on an existing exact provider family", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-create-user");
    const providerSessionIdHash = token("rotation-create-provider");
    const firstTokenHash = token("rotation-create-first");
    const replacementTokenHash = token("rotation-create-replacement");
    const input = {
      userId: account.id,
      providerSessionIdHash,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    };

    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: null,
      newTokenHash: firstTokenHash,
    })).resolves.toBe("created");
    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: null,
      newTokenHash: replacementTokenHash,
    })).resolves.toBe("conflict");
    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: token("rotation-create-absent-current"),
      newTokenHash: replacementTokenHash,
    })).resolves.toBe("conflict");

    const otherAccount = await createAccount(repository, "rotation-create-other-user");
    const otherTokenHash = token("rotation-create-other-user-cookie");
    await repository.createSession({
      tokenHash: otherTokenHash,
      userId: otherAccount.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: otherTokenHash,
      newTokenHash: replacementTokenHash,
    })).resolves.toBe("conflict");

    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, provider_session_id_hash AS providerSessionIdHash,
              revoked_at AS revokedAt
       FROM auth_sessions WHERE user_id = ?`,
    ).all(account.id)).toEqual([{
      tokenHash: firstTokenHash,
      providerSessionIdHash,
      revokedAt: null,
    }]);
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
    expect(await repository.countUserSessionHistory(account.id, ONE_MINUTE_LATER)).toBe(0);

    const prunedAccount = await createAccount(repository, "rotation-pruned-cookie-user");
    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: token("rotation-pruned-cookie"),
      newTokenHash: token("rotation-pruned-cookie-replacement"),
      userId: prunedAccount.id,
      providerSessionIdHash: token("rotation-pruned-cookie-provider"),
    })).resolves.toBe("conflict");
    expect(await repository.countUserSessions(prunedAccount.id, ONE_MINUTE_LATER)).toBe(0);
    await expect(repository.rotateOrCreateSessionToken({
      ...input,
      currentTokenHash: null,
      newTokenHash: token("rotation-pruned-cookie-replacement"),
      userId: prunedAccount.id,
      providerSessionIdHash: token("rotation-pruned-cookie-provider"),
    })).resolves.toBe("created");
    expect(await repository.countUserSessions(prunedAccount.id, ONE_MINUTE_LATER)).toBe(1);
  });

  it("fails closed on unavailable rotation sources, provider revocation, and replacement collisions", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-failure-user");
    const currentTokenHash = token("rotation-failure-current");
    const collisionTokenHash = token("rotation-failure-collision");
    const duplicateProviderTokenHash = token("rotation-failure-provider-duplicate");
    const expiredTokenHash = token("rotation-failure-expired");
    const revokedTokenHash = token("rotation-failure-revoked");
    const freshProviderHash = token("rotation-failure-fresh-provider");
    const revokedProviderHash = token("rotation-failure-revoked-provider");
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      providerSessionIdHash: "rotation-failure-provider",
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await repository.createSession({
      tokenHash: collisionTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await repository.createSession({
      tokenHash: expiredTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: ONE_MINUTE_LATER,
    });
    await repository.createSession({
      tokenHash: revokedTokenHash,
      userId: account.id,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await repository.revokeSession({ tokenHash: revokedTokenHash, revokedAt: ONE_MINUTE_LATER });
    raw.prepare(
      `INSERT INTO account_discount_passes (
         id, user_id, session_token_hash, code_hash, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run("rotation-rollback-pass", account.id, currentTokenHash, "rollback-code", NOW, EXPIRES_AT);

    const rotationInput = {
      newTokenHash: token("rotation-failure-new"),
      userId: account.id,
      providerSessionIdHash: freshProviderHash,
      createdAt: THREE_MINUTES_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    };
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash: expiredTokenHash,
    })).resolves.toBe("conflict");
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash: revokedTokenHash,
    })).resolves.toBe("conflict");
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
      newTokenHash: collisionTokenHash,
    })).resolves.toBe("conflict");
    await repository.createSession({
      tokenHash: duplicateProviderTokenHash,
      userId: account.id,
      providerSessionIdHash: freshProviderHash,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
    })).resolves.toBe("conflict");
    await repository.revokeProviderSession({
      userId: account.id,
      providerSessionIdHash: revokedProviderHash,
      revokedAt: THREE_MINUTES_LATER,
      reason: "rotation_test",
    });
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
      providerSessionIdHash: revokedProviderHash,
    })).resolves.toBe("conflict");

    expect(await repository.getAccountBySessionTokenHash(currentTokenHash, THREE_MINUTES_LATER)).toEqual(account);
    expect(raw.prepare(
      `SELECT session_token_hash AS sessionTokenHash, status, revoked_at AS revokedAt
       FROM account_discount_passes WHERE id = 'rotation-rollback-pass'`,
    ).get()).toEqual({ sessionTokenHash: currentTokenHash, status: "active", revokedAt: null });
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
      createdAt: "2026-08-08 02:03:00",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
      providerSessionIdHash: " ",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.rotateOrCreateSessionToken({
      ...rotationInput,
      currentTokenHash,
      newTokenHash: currentTokenHash,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("serializes overlapping rotations so exactly one replacement wins", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-race-user");
    const currentTokenHash = token("rotation-race-current");
    const replacements = [token("rotation-race-first"), token("rotation-race-second")];
    const providerHashes = [token("rotation-race-provider-0"), token("rotation-race-provider-1")];
    await repository.createSession({
      tokenHash: currentTokenHash,
      userId: account.id,
      providerSessionIdHash: "rotation-race-provider-before",
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });

    const results = await Promise.all(replacements.map((newTokenHash, index) => repository.rotateOrCreateSessionToken({
      currentTokenHash,
      newTokenHash,
      userId: account.id,
      providerSessionIdHash: providerHashes[index]!,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    })));
    expect(results.filter((result) => result === "rotated")).toHaveLength(1);
    expect(results.filter((result) => result === "conflict")).toHaveLength(1);
    const rows = raw.prepare(
      `SELECT token_hash AS tokenHash, provider_session_id_hash AS providerSessionIdHash,
              revoked_at AS revokedAt
       FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`,
    ).all(account.id) as Array<{ tokenHash: string; providerSessionIdHash: string }>;
    expect(rows).toHaveLength(1);
    const winner = results.findIndex((result) => result === "rotated");
    expect(rows[0]).toEqual({
      tokenHash: replacements[winner],
      providerSessionIdHash: providerHashes[winner],
      revokedAt: null,
    });
    expect(raw.prepare(
      "SELECT revoked_at AS revokedAt FROM auth_sessions WHERE token_hash = ?",
    ).get(currentTokenHash)).toEqual({ revokedAt: ONE_MINUTE_LATER });
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
    expect(await repository.countUserSessionHistory(account.id, ONE_MINUTE_LATER)).toBe(1);
  });

  it("serializes overlapping first-sync creates by exact provider family", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-create-race-user");
    const replacements = [token("rotation-create-race-first"), token("rotation-create-race-second")];
    const providerSessionIdHash = token("rotation-create-race-provider");

    const results = await Promise.all(replacements.map((newTokenHash) => repository.rotateOrCreateSessionToken({
      currentTokenHash: null,
      newTokenHash,
      userId: account.id,
      providerSessionIdHash,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    })));
    expect(results.filter((result) => result === "created")).toHaveLength(1);
    expect(results.filter((result) => result === "conflict")).toHaveLength(1);
    const winner = results.findIndex((result) => result === "created");
    expect(raw.prepare(
      `SELECT token_hash AS tokenHash, provider_session_id_hash AS providerSessionIdHash
       FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`,
    ).all(account.id)).toEqual([{
      tokenHash: replacements[winner],
      providerSessionIdHash,
    }]);
    expect(await repository.countUserSessions(account.id, ONE_MINUTE_LATER)).toBe(1);
    expect(await repository.countUserSessionHistory(account.id, ONE_MINUTE_LATER)).toBe(0);
  });

  it("rechecks the provider-token epoch under the same account lock as cookie creation", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "rotation-epoch-user");
    await expect(repository.rotateOrCreateSessionToken({
      currentTokenHash: null,
      newTokenHash: token("rotation-epoch-first"),
      userId: account.id,
      providerSessionIdHash: token("rotation-epoch-provider-first"),
      providerTokenIssuedAt: NOW,
      createdAt: ONE_MINUTE_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    })).resolves.toBe("created");

    await expect(repository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: RESET_AT,
      providerTokensValidAfter: RESET_AT,
    })).resolves.toEqual({ revokedSessions: 1, revokedDiscountPasses: 0 });
    expect(raw.prepare(
      `SELECT provider_tokens_valid_after AS providerTokensValidAfter
       FROM accounts WHERE id = ?`,
    ).get(account.id)).toEqual({ providerTokensValidAfter: RESET_AT });

    const replacement = {
      currentTokenHash: null,
      newTokenHash: token("rotation-epoch-replacement"),
      userId: account.id,
      providerSessionIdHash: token("rotation-epoch-provider-replacement"),
      createdAt: "2026-08-08T03:00:01.000Z",
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    };
    await expect(repository.rotateOrCreateSessionToken({
      ...replacement,
      providerTokenIssuedAt: NOW,
    })).resolves.toBe("conflict");
    await expect(repository.rotateOrCreateSessionToken({
      ...replacement,
      providerTokenIssuedAt: null,
    })).resolves.toBe("conflict");
    await expect(repository.rotateOrCreateSessionToken({
      ...replacement,
      providerTokenIssuedAt: "2026-08-08T03:00:01.000Z",
    })).resolves.toBe("created");
    expect(await repository.countUserSessions(account.id, "2026-08-08T03:00:01.000Z")).toBe(1);
  });

  it("keeps the provider-token epoch monotonic across clock-skewed containment paths", async () => {
    const { repository } = fixture();
    const logoutThenReset = await createAccount(repository, "epoch-logout-then-reset");
    await repository.revokeUserSessionsWithSummary({
      userId: logoutThenReset.id,
      revokedAt: RESET_AT,
      providerTokensValidAfter: RESET_AT,
    });
    await repository.completePasswordResetContainment({
      userId: logoutThenReset.id,
      providerSessionIdHash: token("epoch-older-password-reset-provider"),
      providerTokensValidAfter: ONE_MINUTE_LATER,
      revokedAt: ONE_MINUTE_LATER,
    });
    expect(await repository.getAccountById(logoutThenReset.id)).toMatchObject({
      providerTokensValidAfter: RESET_AT,
      updatedAt: RESET_AT,
    });

    const resetThenLogout = await createAccount(repository, "epoch-reset-then-logout");
    await repository.completePasswordResetContainment({
      userId: resetThenLogout.id,
      providerSessionIdHash: token("epoch-newer-password-reset-provider"),
      providerTokensValidAfter: RESET_AT,
      revokedAt: RESET_AT,
    });
    await repository.revokeUserSessionsWithSummary({
      userId: resetThenLogout.id,
      revokedAt: ONE_MINUTE_LATER,
      providerTokensValidAfter: ONE_MINUTE_LATER,
    });
    expect(await repository.getAccountById(resetThenLogout.id)).toMatchObject({
      providerTokensValidAfter: RESET_AT,
      updatedAt: RESET_AT,
    });

    const concurrent = await createAccount(repository, "epoch-concurrent-containment");
    await Promise.all([
      repository.revokeUserSessionsWithSummary({
        userId: concurrent.id,
        revokedAt: ONE_MINUTE_LATER,
        providerTokensValidAfter: ONE_MINUTE_LATER,
      }),
      repository.completePasswordResetContainment({
        userId: concurrent.id,
        providerSessionIdHash: token("epoch-concurrent-provider"),
        providerTokensValidAfter: RESET_AT,
        revokedAt: RESET_AT,
      }),
    ]);
    expect(await repository.getAccountById(concurrent.id)).toMatchObject({
      providerTokensValidAfter: RESET_AT,
      updatedAt: RESET_AT,
    });
  });

  it("single-owns provider-global revocation and conditionally clears only the matching claim", async () => {
    const { raw, repository } = fixture();
    const account = await createAccount(repository, "provider-global-claim-user");
    const firstClaim = claim("provider-global-first-claim");
    const secondClaim = claim("provider-global-second-claim");
    const staleReplacementClaim = claim("provider-global-stale-replacement-claim");
    await repository.createSession({
      tokenHash: token("provider-global-current-session"),
      userId: account.id,
      providerSessionIdHash: token("provider-global-current-provider"),
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
    });

    await expect(repository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: ONE_MINUTE_LATER,
      providerTokensValidAfter: ONE_MINUTE_LATER,
      beginProviderGlobalRevocation: { claimId: firstClaim, operation: "logout_all" },
    })).resolves.toEqual({ revokedSessions: 1, revokedDiscountPasses: 0 });
    expect(await repository.hasProviderGlobalRevocationPending(account.id)).toBe(true);
    await expect(repository.completePasswordResetContainment({
      userId: account.id,
      providerSessionIdHash: token("provider-global-overlap-provider"),
      providerTokensValidAfter: ONE_MINUTE_LATER,
      revokedAt: ONE_MINUTE_LATER,
      beginProviderGlobalRevocation: { claimId: secondClaim, operation: "password_reset" },
    })).rejects.toMatchObject({ code: "provider_global_revocation_pending" });
    await expect(repository.createSession({
      tokenHash: token("provider-global-blocked-session"),
      userId: account.id,
      providerSessionIdHash: token("provider-global-blocked-provider"),
      createdAt: THREE_MINUTES_LATER,
      expiresAt: EXPIRES_AT,
    })).rejects.toMatchObject({ code: "account_not_session_eligible" });
    await expect(repository.rotateOrCreateSessionToken({
      currentTokenHash: null,
      newTokenHash: token("provider-global-blocked-rotation"),
      userId: account.id,
      providerSessionIdHash: token("provider-global-blocked-rotation-provider"),
      providerTokenIssuedAt: THREE_MINUTES_LATER,
      createdAt: THREE_MINUTES_LATER,
      expiresAt: EXPIRES_AT,
      maxActiveSessions: 10,
    })).resolves.toBe("conflict");
    await expect(repository.claimProviderGlobalRevocation({
      userId: account.id,
      claimId: secondClaim,
      claimedAt: THREE_MINUTES_LATER,
    })).resolves.toEqual({ status: "busy" });
    await expect(repository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: THREE_MINUTES_LATER,
      providerTokensValidAfter: THREE_MINUTES_LATER,
      finishProviderGlobalRevocation: {
        claimId: secondClaim,
        completed: true,
        operation: "logout_all",
      },
    })).rejects.toMatchObject({ code: "provider_global_revocation_pending" });
    expect(await repository.hasProviderGlobalRevocationPending(account.id)).toBe(true);

    await expect(repository.claimProviderGlobalRevocation({
      userId: account.id,
      claimId: staleReplacementClaim,
      claimedAt: SIX_MINUTES_LATER,
    })).resolves.toEqual({ status: "claimed", operation: "logout_all" });
    await expect(repository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: SIX_MINUTES_LATER,
      providerTokensValidAfter: SIX_MINUTES_LATER,
      finishProviderGlobalRevocation: {
        claimId: firstClaim,
        completed: true,
        operation: "logout_all",
      },
    })).rejects.toMatchObject({ code: "provider_global_revocation_pending" });
    expect(await repository.hasProviderGlobalRevocationPending(account.id)).toBe(true);
    await expect(repository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: SIX_MINUTES_LATER,
      providerTokensValidAfter: SIX_MINUTES_LATER,
      finishProviderGlobalRevocation: {
        claimId: staleReplacementClaim,
        completed: true,
        operation: "logout_all",
      },
    })).resolves.toEqual({ revokedSessions: 0, revokedDiscountPasses: 0 });
    expect(await repository.hasProviderGlobalRevocationPending(account.id)).toBe(false);
    expect(raw.prepare(
      "SELECT count(*) AS count FROM revoked_provider_sessions WHERE user_id = ? AND provider_session_id_hash = ?",
    ).get(account.id, "1c85b251c4aa3bab422ff9f4d0d1af2662f30cc4d7c2cb7717d80583eb80d8c6"))
      .toEqual({ count: 0 });
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
