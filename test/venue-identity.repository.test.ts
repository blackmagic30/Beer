import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  VENUE_IDENTITY_LOCK_CONTRACT,
  VenueIdentityRepository,
  VenueIdentityRepositoryError,
  billingCheckoutVenueSubjectLockKey,
  type UpsertVenueLocationCacheInput,
  type VenueIdentityRepositoryErrorCode,
} from "../src/db/venue-identity.repository.js";

const BASE_TIME = "2026-08-08T00:00:00.000Z";
const OFFSET_BASE_TIME = "2026-08-08T10:00:00.000+10:00";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenueIdentityRepository;
}

async function expectCode(
  promise: Promise<unknown>,
  code: VenueIdentityRepositoryErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "VenueIdentityRepositoryError",
    code,
  });
}

function locationInput(
  overrides: Partial<UpsertVenueLocationCacheInput> = {},
): UpsertVenueLocationCacheInput {
  return {
    venueId: "venue-location",
    venueName: "Location Hotel",
    suburb: "Fitzroy",
    latitude: -37.798,
    longitude: 144.978,
    expectedUpdatedAt: null,
    now: BASE_TIME,
    ...overrides,
  };
}

describe("VenueIdentityRepository with AsyncSqliteDatabase", () => {
  const fixtures: Fixture[] = [];

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    const database = new AsyncSqliteDatabase(raw);
    const created = { raw, database, repository: new VenueIdentityRepository(database) };
    fixtures.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ database }) => {
      if (database.metrics().totalConnections > 0) await database.close();
    }));
  });

  it("exposes the exact BillingCheckout venue-subject fence", () => {
    expect(VENUE_IDENTITY_LOCK_CONTRACT).toEqual({
      billingVenueSubjectPrefix: "billing-checkout:subject:venue:",
      locationPrefix: "venue-identity:location:",
      order: "sorted-old-new-billing-subject-keys-before-alias-rows",
    });
    expect(billingCheckoutVenueSubjectLockKey(" venue-a "))
      .toBe("billing-checkout:subject:venue:venue-a");
    expect(() => billingCheckoutVenueSubjectLockKey("\n"))
      .toThrow(VenueIdentityRepositoryError);
  });

  it("inserts, resolves, lists, idempotently replays, and re-homes aliases", async () => {
    const { repository } = fixture();
    expect(await repository.getCanonicalVenueId("venue-a")).toBe("venue-a");
    expect(await repository.listVenueIdentityIds("venue-a")).toEqual(["venue-a"]);

    const inserted = await repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-b",
      identityKey: "hotel|fitzroy",
      expectedUpdatedAt: null,
      now: OFFSET_BASE_TIME,
    });
    expect(inserted).toEqual({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-b",
      identityKey: "hotel|fitzroy",
      source: "automatic_exact_match",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    });
    expect(await repository.getCanonicalVenueId("venue-a")).toBe("venue-b");
    expect(await repository.listVenueIdentityIds("venue-a")).toEqual(["venue-a", "venue-b"]);
    expect(await repository.listVenueIdentityIds("venue-b")).toEqual(["venue-a", "venue-b"]);

    const replay = await repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-b",
      identityKey: "hotel|fitzroy",
      expectedUpdatedAt: null,
      now: MINUTE_1,
    });
    expect(replay).toEqual(inserted);

    const rehomed = await repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-c",
      identityKey: "hotel|fitzroy|reviewed",
      source: "manual_review",
      expectedUpdatedAt: inserted.updatedAt,
      now: BASE_TIME,
    });
    expect(rehomed).toMatchObject({
      canonicalVenueId: "venue-c",
      identityKey: "hotel|fitzroy|reviewed",
      source: "manual_review",
      createdAt: BASE_TIME,
      updatedAt: "2026-08-08T00:00:00.001Z",
    });
    expect(await repository.listVenueIdentityIds("venue-b")).toEqual(["venue-b"]);
    expect(await repository.listVenueIdentityIds("venue-c")).toEqual(["venue-a", "venue-c"]);
  });

  it("allows one first-alias winner and one stale re-home winner", async () => {
    const { repository } = fixture();
    const firstRace = await Promise.allSettled([
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "raced-alias",
        canonicalVenueId: "canonical-a",
        identityKey: "race-a",
        expectedUpdatedAt: null,
        now: BASE_TIME,
      }),
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "raced-alias",
        canonicalVenueId: "canonical-b",
        identityKey: "race-b",
        expectedUpdatedAt: null,
        now: BASE_TIME,
      }),
    ]);
    expect(firstRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(firstRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((firstRace.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "alias_version_conflict" });

    const currentCanonical = await repository.getCanonicalVenueId("raced-alias");
    const current = firstRace.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<
      VenueIdentityRepository["upsertVenueIdentityAlias"]
    >>> => result.status === "fulfilled")!.value;
    expect(current.canonicalVenueId).toBe(currentCanonical);

    const rehomeRace = await Promise.allSettled([
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "raced-alias",
        canonicalVenueId: "canonical-c",
        identityKey: "race-c",
        expectedUpdatedAt: current.updatedAt,
        now: MINUTE_1,
      }),
      repository.upsertVenueIdentityAlias({
        aliasVenueId: "raced-alias",
        canonicalVenueId: "canonical-d",
        identityKey: "race-d",
        expectedUpdatedAt: current.updatedAt,
        now: MINUTE_1,
      }),
    ]);
    expect(rehomeRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rehomeRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((rehomeRace.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "alias_version_conflict" });
  });

  it("rejects self-aliases and direct or persisted cycles", async () => {
    const { raw, repository } = fixture();
    await expectCode(repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-a",
      identityKey: "self",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    }), "identity_cycle");

    await repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-a",
      canonicalVenueId: "venue-b",
      identityKey: "a-to-b",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    });
    await expectCode(repository.upsertVenueIdentityAlias({
      aliasVenueId: "venue-b",
      canonicalVenueId: "venue-a",
      identityKey: "b-to-a",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    }), "identity_cycle");

    const insert = raw.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'manual_test', ?, ?)`,
    );
    insert.run("cycle-x", "cycle-y", "x", BASE_TIME, BASE_TIME);
    insert.run("cycle-y", "cycle-x", "y", BASE_TIME, BASE_TIME);
    await expectCode(repository.getCanonicalVenueId("cycle-x"), "identity_cycle");
  });

  it("rolls back descendant re-homing when the root alias insert fails", async () => {
    const { raw, repository } = fixture();
    await repository.upsertVenueIdentityAlias({
      aliasVenueId: "child-alias",
      canonicalVenueId: "old-root",
      identityKey: "child",
      expectedUpdatedAt: null,
      now: BASE_TIME,
    });
    raw.exec(`
      CREATE TRIGGER fail_old_root_alias
      BEFORE INSERT ON venue_identity_aliases
      WHEN NEW.alias_venue_id = 'old-root'
      BEGIN
        SELECT RAISE(ABORT, 'forced alias failure');
      END;
    `);

    await expectCode(repository.upsertVenueIdentityAlias({
      aliasVenueId: "old-root",
      canonicalVenueId: "new-root",
      identityKey: "merge-root",
      expectedUpdatedAt: null,
      now: MINUTE_1,
    }), "persistence_failure");
    expect(await repository.getCanonicalVenueId("child-alias")).toBe("old-root");
    expect(await repository.getCanonicalVenueId("old-root")).toBe("old-root");
  });

  it("round-trips location provider fields with OCC, idempotency, and one concurrent winner", async () => {
    const { repository } = fixture();
    const inserted = await repository.upsertVenueLocationCache(locationInput({ now: OFFSET_BASE_TIME }));
    expect(inserted).toEqual({
      venueId: "venue-location",
      venueName: "Location Hotel",
      suburb: "Fitzroy",
      latitude: -37.798,
      longitude: 144.978,
      updatedAt: BASE_TIME,
    });
    expect(await repository.getVenueLocationCache("venue-location")).toEqual(inserted);
    expect(await repository.upsertVenueLocationCache(locationInput({ now: MINUTE_1 }))).toEqual(inserted);

    const race = await Promise.allSettled([
      repository.upsertVenueLocationCache(locationInput({
        venueName: "Location Hotel North",
        expectedUpdatedAt: inserted.updatedAt,
        now: BASE_TIME,
      })),
      repository.upsertVenueLocationCache(locationInput({
        venueName: "Location Hotel South",
        expectedUpdatedAt: inserted.updatedAt,
        now: BASE_TIME,
      })),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((race.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "location_version_conflict" });
    expect((await repository.getVenueLocationCache("venue-location"))?.updatedAt)
      .toBe("2026-08-08T00:00:00.001Z");
  });

  it("rejects invalid inputs and fails closed on malformed native cache rows", async () => {
    const { raw, repository } = fixture();
    await expectCode(repository.upsertVenueLocationCache(locationInput({
      longitude: null,
    })), "invalid_input");
    await expectCode(repository.upsertVenueLocationCache(locationInput({
      latitude: 91,
    })), "invalid_input");
    await expectCode(repository.upsertVenueLocationCache(locationInput({
      now: "2026-02-30T00:00:00.000Z",
    })), "invalid_input");
    await expectCode(repository.getCanonicalVenueId("x".repeat(201)), "invalid_input");

    await repository.upsertVenueLocationCache(locationInput());
    raw.prepare("UPDATE venue_location_cache SET latitude = 'not-a-coordinate' WHERE venue_id = ?")
      .run("venue-location");
    await expectCode(repository.getVenueLocationCache("venue-location"), "malformed_record");
  });

  it("propagates closed-database failures only as stable persistence errors", async () => {
    const { database, repository } = fixture();
    await database.close();
    await expectCode(repository.getCanonicalVenueId("venue-a"), "persistence_failure");
    await expectCode(repository.getVenueLocationCache("venue-a"), "persistence_failure");
  });
});
