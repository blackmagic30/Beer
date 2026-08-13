import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  AccountProfilePreferencesRepository,
  type AccountPrivacySettings,
  type UpsertAccountPrivacySettingsInput,
} from "../src/db/account-profile-preferences.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const T0 = "2026-08-08T02:00:00.000Z";
const T1 = "2026-08-08T02:01:00.000Z";
const T2 = "2026-08-08T02:02:00.000Z";
const T3 = "2026-08-08T02:03:00.000Z";
const T4 = "2026-08-08T02:04:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AccountProfilePreferencesRepository;
}

function insertAccount(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', 'user', 'free', 'active', ?, ?)`,
  ).run(id, `PP-${id}`, `${id}@example.test`, T0, T0);
}

function insertEvent(
  raw: BetterSqlite3.Database,
  input: {
    id: string;
    userId: string;
    eventType?: string;
    suburb?: string | null;
    metadataJson?: string;
    createdAt?: string;
  },
): void {
  raw.prepare(
    `INSERT INTO events (
       id, user_id, event_type, suburb, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.eventType ?? "search_performed",
    input.suburb ?? null,
    input.metadataJson ?? "{}",
    input.createdAt ?? T0,
  );
}

function privacyInput(
  userId: string,
  overrides: Partial<UpsertAccountPrivacySettingsInput> = {},
): UpsertAccountPrivacySettingsInput {
  return {
    userId,
    optionalAnalyticsEnabled: true,
    venueReportInclusionEnabled: true,
    productResearchEnabled: false,
    emailUpdatesEnabled: false,
    consentVersion: "2026-08-03",
    now: T0,
    expectedUpdatedAt: null,
    ...overrides,
  };
}

function successfulResult<T>(results: PromiseSettledResult<T>[]): T {
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<T> => result.status === "fulfilled",
  );
  expect(fulfilled).toHaveLength(1);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({
    code: "write_conflict",
    message: "The account preference revision has changed.",
  });
  return fulfilled[0]!.value;
}

describe("AccountProfilePreferencesRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    const database = new AsyncSqliteDatabase(raw);
    databases.push(database);
    return {
      raw,
      database,
      repository: new AccountProfilePreferencesRepository(database),
    };
  }

  it("atomically upserts profiles while preserving legacy public-id and username semantics", async () => {
    const created = fixture();
    insertAccount(created.raw, "profile-user");

    const first = await created.repository.upsertProfile({
      id: "profile-user",
      publicAccountId: "PP-profile-user",
      email: "profile-user@example.test",
      displayName: "First name",
      displayNameKey: "first-name",
      username: "original_username",
      avatarUrl: "https://images.example.test/avatar.png",
      role: "user",
      accountStatus: "active",
      ageVerificationStatus: "pending",
      isOver18Verified: false,
      now: T0,
    });
    expect(first).toEqual({
      id: "profile-user",
      publicAccountId: "PP-profile-user",
      email: "profile-user@example.test",
      displayName: "First name",
      displayNameKey: "first-name",
      username: "original_username",
      avatarUrl: "https://images.example.test/avatar.png",
      role: "user",
      accountStatus: "active",
      ageVerificationStatus: "pending",
      isOver18Verified: false,
      createdAt: T0,
      updatedAt: T0,
    });

    const updated = await created.repository.upsertProfile({
      id: "profile-user",
      publicAccountId: null,
      email: "new-profile-user@example.test",
      displayName: "Second name",
      displayNameKey: "second-name",
      username: "ignored_on_existing_profile",
      avatarUrl: null,
      role: "venue_manager",
      accountStatus: "warned",
      ageVerificationStatus: "verified",
      isOver18Verified: true,
      now: T1,
    });
    expect(updated).toMatchObject({
      publicAccountId: "PP-profile-user",
      username: "original_username",
      email: "new-profile-user@example.test",
      displayName: "Second name",
      role: "venue_manager",
      accountStatus: "warned",
      ageVerificationStatus: "verified",
      isOver18Verified: true,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(await created.repository.getProfileById("profile-user")).toEqual(updated);
    await expect(created.repository.upsertProfile({
      ...updated,
      id: "missing-account",
      publicAccountId: null,
      displayNameKey: null,
      now: T2,
    })).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("uses timestamp OCC for preferences and preserves completed onboarding on null updates", async () => {
    const created = fixture();
    insertAccount(created.raw, "preference-user");
    expect(await created.repository.getAccountPreferences("preference-user")).toBeNull();

    const first = await created.repository.upsertAccountPreferences({
      userId: "preference-user",
      preferredSuburbs: ["Fitzroy"],
      preferredBeers: ["Lager"],
      preferredUseCases: ["cheapest_beer"],
      onboardingCompletedAt: T0,
      now: T0,
      expectedUpdatedAt: null,
    });
    expect(first).toMatchObject({
      preferredSuburbs: ["Fitzroy"],
      preferredBeers: ["Lager"],
      preferredUseCases: ["cheapest_beer"],
      onboardingCompletedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });

    const second = await created.repository.upsertAccountPreferences({
      userId: "preference-user",
      preferredSuburbs: ["Carlton"],
      preferredBeers: ["Stout"],
      preferredUseCases: ["recently_verified"],
      onboardingCompletedAt: null,
      now: T1,
      expectedUpdatedAt: T0,
    });
    expect(second.onboardingCompletedAt).toBe(T0);
    expect(second.createdAt).toBe(T0);

    const contention = await Promise.allSettled([
      created.repository.upsertAccountPreferences({
        userId: "preference-user",
        preferredSuburbs: ["Richmond"],
        preferredBeers: ["Pale Ale"],
        preferredUseCases: ["happy_hours"],
        onboardingCompletedAt: null,
        now: T2,
        expectedUpdatedAt: T1,
      }),
      created.repository.upsertAccountPreferences({
        userId: "preference-user",
        preferredSuburbs: ["Brunswick"],
        preferredBeers: ["Porter"],
        preferredUseCases: ["specific_beers"],
        onboardingCompletedAt: null,
        now: T3,
        expectedUpdatedAt: T1,
      }),
    ]);
    const winner = successfulResult(contention);
    expect(await created.repository.getAccountPreferences("preference-user")).toEqual(winner);
    expect(winner.onboardingCompletedAt).toBe(T0);

    await expect(created.repository.upsertAccountPreferences({
      userId: "preference-user",
      preferredSuburbs: [],
      preferredBeers: [],
      preferredUseCases: [],
      onboardingCompletedAt: null,
      now: winner.updatedAt,
      expectedUpdatedAt: winner.updatedAt,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("updates privacy settings and purges required event scopes in one transaction", async () => {
    const created = fixture();
    insertAccount(created.raw, "privacy-user");
    insertAccount(created.raw, "other-user");
    insertEvent(created.raw, {
      id: "optional-event",
      userId: "privacy-user",
      metadataJson: '{"privacyScope":"optional_analytics"}',
    });
    insertEvent(created.raw, {
      id: "venue-event",
      userId: "privacy-user",
      metadataJson: '{"privacyScope":"venue_insight"}',
    });
    insertEvent(created.raw, {
      id: "essential-event",
      userId: "privacy-user",
      metadataJson: '{"privacyScope":"essential"}',
    });
    insertEvent(created.raw, {
      id: "invalid-json-event",
      userId: "privacy-user",
      metadataJson: "{bad-json",
    });
    insertEvent(created.raw, {
      id: "other-user-event",
      userId: "other-user",
      metadataJson: '{"privacyScope":"optional_analytics"}',
    });

    await created.repository.upsertAccountPrivacySettings(privacyInput("privacy-user"));
    expect((created.raw.prepare("SELECT count(*) AS count FROM events").get() as { count: number }).count)
      .toBe(5);

    const settings = await created.repository.upsertAccountPrivacySettings(privacyInput(
      "privacy-user",
      {
        optionalAnalyticsEnabled: false,
        venueReportInclusionEnabled: false,
        productResearchEnabled: true,
        emailUpdatesEnabled: true,
        now: T1,
        expectedUpdatedAt: T0,
      },
    ));
    expect(settings).toEqual<AccountPrivacySettings>({
      userId: "privacy-user",
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: true,
      emailUpdatesEnabled: true,
      consentVersion: "2026-08-03",
      consentedAt: T1,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(created.raw.prepare("SELECT id FROM events ORDER BY id").all()).toEqual([
      { id: "essential-event" },
      { id: "other-user-event" },
    ]);

    insertAccount(created.raw, "venue-only-user");
    await created.repository.upsertAccountPrivacySettings(privacyInput("venue-only-user"));
    insertEvent(created.raw, {
      id: "venue-only-optional",
      userId: "venue-only-user",
      metadataJson: '{"privacyScope":"optional_analytics"}',
    });
    insertEvent(created.raw, {
      id: "venue-only-venue",
      userId: "venue-only-user",
      metadataJson: '{"privacyScope":"venue_insight"}',
    });
    await created.repository.upsertAccountPrivacySettings(privacyInput("venue-only-user", {
      venueReportInclusionEnabled: false,
      now: T1,
      expectedUpdatedAt: T0,
    }));
    expect(created.raw.prepare(
      "SELECT id FROM events WHERE user_id = 'venue-only-user' ORDER BY id",
    ).all()).toEqual([{ id: "venue-only-optional" }]);
  });

  it("fences concurrent privacy changes and performs the winning purge exactly once", async () => {
    const created = fixture();
    insertAccount(created.raw, "privacy-contention-user");
    await created.repository.upsertAccountPrivacySettings(privacyInput("privacy-contention-user"));
    insertEvent(created.raw, {
      id: "contention-optional",
      userId: "privacy-contention-user",
      metadataJson: '{"privacyScope":"optional_analytics"}',
    });
    insertEvent(created.raw, {
      id: "contention-venue",
      userId: "privacy-contention-user",
      metadataJson: '{"privacyScope":"venue_insight"}',
    });

    const results = await Promise.allSettled([
      created.repository.upsertAccountPrivacySettings(privacyInput("privacy-contention-user", {
        optionalAnalyticsEnabled: false,
        venueReportInclusionEnabled: false,
        now: T1,
        expectedUpdatedAt: T0,
      })),
      created.repository.upsertAccountPrivacySettings(privacyInput("privacy-contention-user", {
        optionalAnalyticsEnabled: false,
        venueReportInclusionEnabled: false,
        productResearchEnabled: true,
        now: T2,
        expectedUpdatedAt: T0,
      })),
    ]);
    const winner = successfulResult(results);
    expect(await created.repository.getAccountPrivacySettings("privacy-contention-user"))
      .toEqual(winner);
    expect(created.raw.prepare(
      "SELECT id FROM events WHERE user_id = 'privacy-contention-user'",
    ).all()).toEqual([]);
  });

  it("rolls the settings write back when the required privacy purge fails", async () => {
    const created = fixture();
    insertAccount(created.raw, "rollback-user");
    await created.repository.upsertAccountPrivacySettings(privacyInput("rollback-user"));
    insertEvent(created.raw, {
      id: "rollback-event",
      userId: "rollback-user",
      metadataJson: '{"privacyScope":"optional_analytics"}',
    });
    created.raw.exec(
      `CREATE TRIGGER fail_privacy_purge
       BEFORE DELETE ON events
       BEGIN
         SELECT RAISE(ABORT, 'DO-NOT-LEAK-ROLLBACK-SENTINEL');
       END`,
    );

    await expect(created.repository.upsertAccountPrivacySettings(privacyInput("rollback-user", {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      now: T1,
      expectedUpdatedAt: T0,
    }))).rejects.toMatchObject({
      code: "persistence_failed",
      message: "The account profile or preference change could not be persisted.",
    });
    expect(await created.repository.getAccountPrivacySettings("rollback-user"))
      .toMatchObject({ optionalAnalyticsEnabled: true, updatedAt: T0 });
    expect(created.raw.prepare("SELECT id FROM events WHERE id = 'rollback-event'").get())
      .toEqual({ id: "rollback-event" });
    expect(created.database.metrics().transactionFailures).toBe(1);
  });

  it("converges concurrent saves onto one identity, redacts secrets, orders deterministically, and removes idempotently", async () => {
    const created = fixture();
    insertAccount(created.raw, "saved-user");

    const saves = await Promise.all([
      created.repository.saveItem({
        id: "save-one",
        userId: "saved-user",
        itemType: "venue",
        itemId: "venue-1",
        label: "Test Venue",
        suburb: "Fitzroy",
        metadata: { apiKey: "DO-NOT-STORE", nested: { password: "DO-NOT-STORE" } },
        now: T0,
      }),
      created.repository.saveItem({
        id: "save-two",
        userId: "saved-user",
        itemType: "venue",
        itemId: "venue-1",
        label: "Test Venue",
        suburb: "Fitzroy",
        metadata: { apiKey: "DO-NOT-STORE", nested: { password: "DO-NOT-STORE" } },
        now: T1,
      }),
    ]);
    expect(saves[0]!.id).toBe(saves[1]!.id);
    expect(saves[0]!.createdAt).toBe(saves[1]!.createdAt);
    expect(saves[1]!.metadata).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    expect((created.raw.prepare("SELECT count(*) AS count FROM saved_items").get() as { count: number }).count)
      .toBe(1);

    const durableId = saves[0]!.id;
    await created.repository.saveItem({
      id: "replacement-id",
      userId: "saved-user",
      itemType: "venue",
      itemId: "venue-1",
      label: "Updated Venue",
      suburb: null,
      metadata: { source: "account" },
      now: T2,
    });
    await created.repository.saveItem({
      id: "save-z",
      userId: "saved-user",
      itemType: "beer",
      itemId: "beer-z",
      label: "Beer Z",
      suburb: null,
      metadata: {},
      now: T3,
    });
    await created.repository.saveItem({
      id: "save-a",
      userId: "saved-user",
      itemType: "beer",
      itemId: "beer-a",
      label: "Beer A",
      suburb: null,
      metadata: {},
      now: T3,
    });
    const listed = await created.repository.listSavedItems("saved-user");
    expect(listed.map((item) => item.id)).toEqual(["save-z", "save-a", durableId]);
    expect(listed[2]).toMatchObject({ id: durableId, label: "Updated Venue", createdAt: saves[0]!.createdAt });
    expect(await created.repository.removeSavedItem({
      userId: "saved-user",
      itemType: "venue",
      itemId: "venue-1",
    })).toBe(true);
    expect(await created.repository.removeSavedItem({
      userId: "saved-user",
      itemType: "venue",
      itemId: "venue-1",
    })).toBe(false);
  });

  it("returns safe defaults and portable deterministic recent-search limits", async () => {
    const created = fixture();
    insertAccount(created.raw, "search-user");
    expect(await created.repository.getDefaultAccountPrivacySettings("search-user", T0)).toEqual({
      userId: "search-user",
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: "2026-08-03",
      consentedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    insertEvent(created.raw, {
      id: "search-a",
      userId: "search-user",
      metadataJson: '{"query":"Query A"}',
      createdAt: T1,
    });
    insertEvent(created.raw, {
      id: "search-z",
      userId: "search-user",
      eventType: "beer_search_performed",
      metadataJson: '{"label":"Beer Z"}',
      createdAt: T1,
    });
    insertEvent(created.raw, {
      id: "search-old",
      userId: "search-user",
      eventType: "suburb_search_performed",
      suburb: "Carlton",
      createdAt: T0,
    });
    insertEvent(created.raw, {
      id: "not-a-search",
      userId: "search-user",
      eventType: "venue_profile_viewed",
      createdAt: T4,
    });

    expect(await created.repository.listRecentSearches("search-user", 2)).toEqual([
      { eventType: "beer_search_performed", label: "Beer Z", suburb: null, createdAt: T1 },
      { eventType: "search_performed", label: "Query A", suburb: null, createdAt: T1 },
    ]);
    expect(await created.repository.listRecentSearches("search-user", 0)).toEqual([]);
    expect(await created.repository.listRecentSearches("search-user", -1)).toHaveLength(3);
    await expect(created.repository.listRecentSearches("search-user", 101))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fails with stable errors for invalid inputs and malformed stored JSON", async () => {
    const created = fixture();
    insertAccount(created.raw, "invalid-user");
    await created.repository.upsertAccountPreferences({
      userId: "invalid-user",
      preferredSuburbs: [],
      preferredBeers: [],
      preferredUseCases: [],
      onboardingCompletedAt: null,
      now: T0,
      expectedUpdatedAt: null,
    });
    created.raw.prepare(
      "UPDATE account_preferences SET preferred_suburbs_json = '{bad-json' WHERE user_id = 'invalid-user'",
    ).run();
    await expect(created.repository.getAccountPreferences("invalid-user"))
      .rejects.toMatchObject({ code: "stored_data_invalid" });
    await expect(created.repository.saveItem({
      id: "invalid-metadata",
      userId: "invalid-user",
      itemType: "venue",
      itemId: "venue-1",
      label: "Venue",
      suburb: null,
      metadata: { invalid: Number.POSITIVE_INFINITY },
      now: T0,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(created.repository.upsertAccountPrivacySettings(privacyInput("invalid-user", {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: true,
    }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});
