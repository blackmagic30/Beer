import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  BILLING_CHECKOUT_LOCK_CONTRACT,
  BillingCheckoutRepository,
  BillingCheckoutRepositoryError,
  billingCheckoutConsumerSubjectLockKey,
  billingCheckoutVenueSubjectLockKey,
} from "../src/db/billing-checkout.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import { billingCheckoutVenueSubjectLockKey as venueIdentityBillingSubjectLockKey } from "../src/db/venue-identity.repository.js";

const NOW = "2026-08-08T12:00:00.000Z";
const LATER = "2026-08-08T12:05:00.000Z";
const EXPIRES_AT = "2026-08-08T12:35:00.000Z";
const AFTER_EXPIRY = "2026-08-08T12:40:00.000Z";
const RETRY_EXPIRES_AT = "2026-08-08T13:15:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: BillingCheckoutRepository;
}

function token(label: string): string {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function createFixture(): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = new AsyncSqliteDatabase(raw);
  return { raw, database, repository: new BillingCheckoutRepository(database) };
}

function insertAccount(raw: BetterSqlite3.Database, id: string, authProvider = "local"): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, 'user', 'free', ?, ?)`,
  ).run(id, `${id}@example.test`, authProvider, NOW, NOW);
}

function insertVenue(raw: BetterSqlite3.Database, id: string, claimed = false): void {
  raw.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, intro_trial_ever_claimed, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `Venue ${id}`, claimed ? 1 : 0, NOW, NOW);
}

function insertAlias(raw: BetterSqlite3.Database, alias: string, canonical: string): void {
  raw.prepare(
    `INSERT INTO venue_identity_aliases (
       alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
     ) VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(alias, canonical, `identity:${canonical}`, NOW, NOW);
}

function lockDeletion(raw: BetterSqlite3.Database, userId: string, status = "processing"): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`delete-${userId}`, userId, status, NOW, EXPIRES_AT, NOW, NOW);
}

function expectCode(code: BillingCheckoutRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof BillingCheckoutRepositoryError && error.code === code;
}

class InstrumentedDatabase implements SqlDatabase {
  readonly dialect: "sqlite";
  transactionDepth = 0;
  failAfterFinalizeWrite = false;

  constructor(private readonly delegate: AsyncSqliteDatabase) {
    this.dialect = delegate.dialect;
  }

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings: unknown[]) => {
        const result = await statement.run(...bindings);
        if (
          this.failAfterFinalizeWrite
          && /UPDATE\s+billing_checkout_reservations[\s\S]*stripe_checkout_session_id\s*=\s*@stripeCheckoutSessionId/i.test(sql)
        ) {
          this.failAfterFinalizeWrite = false;
          throw new Error("injected finalize failure");
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
    return this.delegate.transaction(async () => {
      this.transactionDepth += 1;
      try {
        return await work();
      } finally {
        this.transactionDepth -= 1;
      }
    });
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("BillingCheckoutRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const created = createFixture();
    databases.push(created.database);
    return created;
  }

  it("exports validated, immutable consumer and venue subject lock keys", () => {
    expect(Object.isFrozen(BILLING_CHECKOUT_LOCK_CONTRACT)).toBe(true);
    expect(billingCheckoutConsumerSubjectLockKey(" account-subject ")).toBe(
      "billing-checkout:subject:consumer:account-subject",
    );
    expect(billingCheckoutVenueSubjectLockKey(" venue-subject ")).toBe(
      "billing-checkout:subject:venue:venue-subject",
    );
    expect(billingCheckoutVenueSubjectLockKey("venue-subject")).toBe(
      venueIdentityBillingSubjectLockKey("venue-subject"),
    );
    expect(() => billingCheckoutConsumerSubjectLockKey("bad\nsubject")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => billingCheckoutVenueSubjectLockKey("\0venue")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("serializes concurrent claims so exactly one reservation identity wins", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "one-winner");

    const requests = ["monthly-winner", "yearly-loser", "third-loser"].map((label, index) =>
      repository.claimBillingCheckoutReservation({
        actorAccountId: "one-winner",
        subjectType: "consumer",
        subjectId: "one-winner",
        productKey: index === 0 ? "consumer:monthly" : "consumer:yearly",
        reservationToken: token(label),
        expiresAt: EXPIRES_AT,
        now: NOW,
      }));
    const results = await Promise.all(requests);

    expect(new Set(results.map((result) => result.reservationToken)).size).toBe(1);
    expect(results[0]).toMatchObject({
      subjectType: "consumer",
      subjectId: "one-winner",
      productKey: "consumer:monthly",
      reservationToken: token("monthly-winner"),
      status: "reserved",
      expired: false,
    });
    expect(raw.prepare("SELECT count(*) AS count FROM billing_checkout_reservations").get()).toEqual({ count: 1 });
  });

  it("keeps provider I/O outside transactions and finalizes exact retries idempotently", async () => {
    const { raw, database } = fixture();
    insertAccount(raw, "provider-boundary");
    const instrumented = new InstrumentedDatabase(database);
    const repository = new BillingCheckoutRepository(instrumented);
    const claimed = await repository.claimBillingCheckoutReservation({
      actorAccountId: "provider-boundary",
      subjectType: "consumer",
      subjectId: "provider-boundary",
      productKey: "consumer:monthly",
      reservationToken: token("provider-boundary"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });

    const providerCall = async () => {
      expect(instrumented.transactionDepth).toBe(0);
      return { id: "cs_provider_boundary", url: "https://checkout.example.test/provider-boundary" };
    };
    const provider = await providerCall();
    const finalized = await repository.finalizeBillingCheckoutReservation({
      actorAccountId: "provider-boundary",
      subjectType: "consumer",
      subjectId: "provider-boundary",
      reservationToken: claimed.reservationToken,
      stripeCheckoutSessionId: provider.id,
      checkoutUrl: provider.url,
      now: LATER,
    });
    expect(finalized).toMatchObject({ status: "finalized", expired: false });

    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "provider-boundary",
      subjectType: "consumer",
      subjectId: "provider-boundary",
      reservationToken: claimed.reservationToken,
      stripeCheckoutSessionId: provider.id,
      checkoutUrl: provider.url,
      now: AFTER_EXPIRY,
    })).resolves.toMatchObject({ status: "finalized", expired: true, updatedAt: LATER });
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "provider-boundary",
      subjectType: "consumer",
      subjectId: "provider-boundary",
      reservationToken: claimed.reservationToken,
      stripeCheckoutSessionId: "cs_conflict",
      checkoutUrl: "https://checkout.example.test/conflict",
      now: LATER,
    })).rejects.toSatisfy(expectCode("finalization_conflict"));
  });

  it("fences stale tokens and expired finalization while allowing a bounded retry claim", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "retry-account");
    const first = await repository.claimBillingCheckoutReservation({
      actorAccountId: "retry-account",
      subjectType: "consumer",
      subjectId: "retry-account",
      productKey: "consumer:monthly",
      reservationToken: token("retry-first"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });

    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "retry-account",
      subjectType: "consumer",
      subjectId: "retry-account",
      reservationToken: token("stale-token"),
      stripeCheckoutSessionId: "cs_stale",
      checkoutUrl: "https://checkout.example.test/stale",
      now: LATER,
    })).rejects.toSatisfy(expectCode("stale_reservation"));
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "retry-account",
      subjectType: "consumer",
      subjectId: "retry-account",
      reservationToken: first.reservationToken,
      stripeCheckoutSessionId: "cs_late",
      checkoutUrl: "https://checkout.example.test/late",
      now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("reservation_expired"));

    const retried = await repository.claimBillingCheckoutReservation({
      actorAccountId: "retry-account",
      subjectType: "consumer",
      subjectId: "retry-account",
      productKey: "consumer:yearly",
      reservationToken: token("retry-second"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    });
    expect(retried).toMatchObject({
      productKey: "consumer:yearly",
      reservationToken: token("retry-second"),
      checkoutUrl: null,
      stripeCheckoutSessionId: null,
      createdAt: AFTER_EXPIRY,
    });
  });

  it("rolls back failed replacement and finalize writes, then permits a safe retry", async () => {
    const { raw, database, repository } = fixture();
    insertAccount(raw, "rollback-a");
    insertAccount(raw, "rollback-b");
    await repository.claimBillingCheckoutReservation({
      actorAccountId: "rollback-a",
      subjectType: "consumer",
      subjectId: "rollback-a",
      productKey: "consumer:monthly",
      reservationToken: token("rollback-original"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });
    await repository.claimBillingCheckoutReservation({
      actorAccountId: "rollback-b",
      subjectType: "consumer",
      subjectId: "rollback-b",
      productKey: "consumer:monthly",
      reservationToken: token("already-owned-token"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    });

    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "rollback-a",
      subjectType: "consumer",
      subjectId: "rollback-a",
      productKey: "consumer:yearly",
      reservationToken: token("already-owned-token"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("reservation_token_conflict"));
    await expect(repository.getBillingCheckoutReservation({
      subjectType: "consumer",
      subjectId: "rollback-a",
      asOf: AFTER_EXPIRY,
    })).resolves.toMatchObject({
      reservationToken: token("rollback-original"),
      productKey: "consumer:monthly",
      expired: true,
    });

    const instrumented = new InstrumentedDatabase(database);
    const injectedRepository = new BillingCheckoutRepository(instrumented);
    const replacement = await injectedRepository.claimBillingCheckoutReservation({
      actorAccountId: "rollback-a",
      subjectType: "consumer",
      subjectId: "rollback-a",
      productKey: "consumer:yearly",
      reservationToken: token("rollback-replacement"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    });
    instrumented.failAfterFinalizeWrite = true;
    await expect(injectedRepository.finalizeBillingCheckoutReservation({
      actorAccountId: "rollback-a",
      subjectType: "consumer",
      subjectId: "rollback-a",
      reservationToken: replacement.reservationToken,
      stripeCheckoutSessionId: "cs_rollback",
      checkoutUrl: "https://checkout.example.test/rollback",
      now: "2026-08-08T12:45:00.000Z",
    })).rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getBillingCheckoutReservation({
      subjectType: "consumer",
      subjectId: "rollback-a",
      asOf: "2026-08-08T12:45:00.000Z",
    })).resolves.toMatchObject({ status: "reserved", checkoutUrl: null });
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "rollback-a",
      subjectType: "consumer",
      subjectId: "rollback-a",
      reservationToken: replacement.reservationToken,
      stripeCheckoutSessionId: "cs_rollback",
      checkoutUrl: "https://checkout.example.test/rollback",
      now: "2026-08-08T12:45:00.000Z",
    })).resolves.toMatchObject({ status: "finalized" });
  });

  it("rejects deleted/deletion-locked actors without mutating checkout state", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "locked-claim");
    lockDeletion(raw, "locked-claim");
    insertAccount(raw, "deleted-claim", "deleted");

    for (const actorAccountId of ["locked-claim", "deleted-claim"]) {
      await expect(repository.claimBillingCheckoutReservation({
        actorAccountId,
        subjectType: "consumer",
        subjectId: actorAccountId,
        productKey: "consumer:monthly",
        reservationToken: token(actorAccountId),
        expiresAt: EXPIRES_AT,
        now: NOW,
      })).rejects.toSatisfy(expectCode("deletion_locked"));
    }
    expect(raw.prepare("SELECT count(*) AS count FROM billing_checkout_reservations").get()).toEqual({ count: 0 });

    insertAccount(raw, "locked-finalize");
    const reservation = await repository.claimBillingCheckoutReservation({
      actorAccountId: "locked-finalize",
      subjectType: "consumer",
      subjectId: "locked-finalize",
      productKey: "consumer:monthly",
      reservationToken: token("locked-finalize"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });
    lockDeletion(raw, "locked-finalize", "failed");
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "locked-finalize",
      subjectType: "consumer",
      subjectId: "locked-finalize",
      reservationToken: reservation.reservationToken,
      stripeCheckoutSessionId: "cs_locked",
      checkoutUrl: "https://checkout.example.test/locked",
      now: LATER,
    })).rejects.toSatisfy(expectCode("deletion_locked"));
    expect(raw.prepare(
      "SELECT checkout_url AS checkoutUrl FROM billing_checkout_reservations WHERE subject_id = ?",
    ).get("locked-finalize")).toEqual({ checkoutUrl: null });
  });

  it("uses one canonical venue identity for reservations and one-time trial flags", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "venue-manager");
    insertVenue(raw, "venue-canonical");
    insertVenue(raw, "venue-alias");
    insertAlias(raw, "venue-alias", "venue-canonical");

    await expect(repository.hasVenueIntroTrialEverClaimed({
      venueId: "venue-alias",
      asOf: NOW,
    })).resolves.toBe(false);
    const reservation = await repository.claimBillingCheckoutReservation({
      actorAccountId: "venue-manager",
      subjectType: "venue",
      subjectId: "venue-alias",
      productKey: "venue:pro:trial:30",
      reservationToken: token("venue-trial"),
      expiresAt: EXPIRES_AT,
      now: NOW,
    });
    expect(reservation.subjectId).toBe("venue-canonical");
    await expect(repository.getBillingCheckoutReservation({
      subjectType: "venue",
      subjectId: "venue-alias",
      asOf: NOW,
    })).resolves.toMatchObject({ subjectId: "venue-canonical", reservationToken: token("venue-trial") });

    await expect(repository.markVenueIntroTrialEverClaimed({
      actorAccountId: "venue-manager",
      venueId: "venue-alias",
      now: LATER,
    })).resolves.toEqual({
      outcome: "marked",
      canonicalVenueId: "venue-canonical",
      venueIds: ["venue-alias", "venue-canonical"],
      updatedProfiles: 2,
    });
    await expect(repository.markVenueIntroTrialEverClaimed({
      actorAccountId: "venue-manager",
      venueId: "venue-canonical",
      now: AFTER_EXPIRY,
    })).resolves.toMatchObject({ outcome: "already_claimed", updatedProfiles: 0 });
    expect(raw.prepare(
      "SELECT venue_id AS venueId, intro_trial_ever_claimed AS claimed, updated_at AS updatedAt FROM venue_profiles ORDER BY venue_id",
    ).all()).toEqual([
      { venueId: "venue-alias", claimed: 1, updatedAt: LATER },
      { venueId: "venue-canonical", claimed: 1, updatedAt: LATER },
    ]);
    await expect(repository.hasVenueIntroTrialEverClaimed({
      venueId: "venue-canonical",
      asOf: AFTER_EXPIRY,
    })).resolves.toBe(true);

    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "venue-manager",
      subjectType: "venue",
      subjectId: "venue-alias",
      productKey: "venue:pro:trial:60",
      reservationToken: token("second-venue-trial"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    })).rejects.toSatisfy(expectCode("intro_trial_already_claimed"));
    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "venue-manager",
      subjectType: "venue",
      subjectId: "venue-alias",
      productKey: "venue:pro:paid",
      reservationToken: token("venue-paid"),
      expiresAt: RETRY_EXPIRES_AT,
      now: AFTER_EXPIRY,
    })).resolves.toMatchObject({ productKey: "venue:pro:paid", subjectId: "venue-canonical" });
  });

  it("enforces bounded inputs and fail-closed persisted native shapes", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "bounded-account");
    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "bounded-account",
      subjectType: "consumer",
      subjectId: "bounded-account",
      productKey: "consumer:monthly",
      reservationToken: "short",
      expiresAt: EXPIRES_AT,
      now: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.claimBillingCheckoutReservation({
      actorAccountId: "bounded-account",
      subjectType: "consumer",
      subjectId: "bounded-account",
      productKey: "consumer:monthly",
      reservationToken: token("too-long-ttl"),
      expiresAt: "2026-08-10T12:00:00.000Z",
      now: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.finalizeBillingCheckoutReservation({
      actorAccountId: "bounded-account",
      subjectType: "consumer",
      subjectId: "bounded-account",
      reservationToken: token("missing"),
      stripeCheckoutSessionId: null,
      checkoutUrl: "http://checkout.example.test/insecure",
      now: NOW,
    })).rejects.toSatisfy(expectCode("invalid_input"));

    insertVenue(raw, "corrupt-bool");
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.prepare("UPDATE venue_profiles SET intro_trial_ever_claimed = 2 WHERE venue_id = ?").run("corrupt-bool");
    await expect(repository.hasVenueIntroTrialEverClaimed({
      venueId: "corrupt-bool",
      asOf: NOW,
    })).rejects.toSatisfy(expectCode("persistence_failure"));
  });
});
