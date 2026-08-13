import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { OptimisticConcurrencyError } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  VenueInventoryRepository,
  type UpsertBarBeerInput,
  type UpsertBarHappyHourInput,
  type UpsertBarProfileInput,
  type UpsertBarSpecialInput,
} from "../src/db/venue-inventory.repository.js";

const BASE_TIME = "2026-08-08T00:00:00.000Z";
const NEXT_MILLISECOND = "2026-08-08T00:00:00.001Z";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";
const MINUTE_2 = "2026-08-08T00:02:00.000Z";
const MINUTE_3 = "2026-08-08T00:03:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenueInventoryRepository;
}

function profileInput(
  barId: string,
  overrides: Partial<UpsertBarProfileInput> = {},
): UpsertBarProfileInput {
  return {
    barId,
    name: `Venue ${barId}`,
    address: "1 Test Street",
    suburb: "Fitzroy",
    area: "Inner North",
    phone: "03 9000 0000",
    website: "https://example.test",
    instagram: "https://instagram.test/example",
    description: "Independent test venue",
    openingHours: { fri: { open: "12:00", close: "23:00" } },
    venueTags: ["craft beer", "beer garden"],
    membershipTier: "basic",
    highlightedName: false,
    premiumBadge: null,
    promoted: false,
    featuredSpecialEligible: false,
    tierManualOverride: false,
    acceptsPintPathCodes: false,
    active: true,
    now: BASE_TIME,
    ...overrides,
  };
}

function beerInput(
  id: string,
  overrides: Partial<UpsertBarBeerInput> = {},
): UpsertBarBeerInput {
  return {
    id,
    barId: "venue-a",
    beerName: "Carlton Draught",
    normalizedBeerId: "carlton_draft",
    brewery: "Carlton & United",
    style: "Lager",
    abv: 4.6,
    serveSize: "pint",
    price: 12.5,
    currency: "AUD",
    onTap: true,
    inStock: true,
    notes: "Front tap",
    priceVerifiedAt: BASE_TIME,
    stockVerifiedAt: BASE_TIME,
    now: BASE_TIME,
    ...overrides,
  };
}

function happyHourInput(
  id: string,
  overrides: Partial<UpsertBarHappyHourInput> = {},
): UpsertBarHappyHourInput {
  return {
    id,
    barId: "venue-a",
    title: "Weekday pints",
    daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
    startTime: "16:30",
    endTime: "18:30",
    description: "Selected taps",
    happyHourBeers: [{
      beerId: "beer-a",
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draft",
      servingSize: "pint",
      happyHourPrice: 9.5,
      offerText: "One per customer",
      onTap: true,
      inStock: true,
    }],
    active: true,
    now: BASE_TIME,
    ...overrides,
  };
}

function specialInput(
  id: string,
  overrides: Partial<UpsertBarSpecialInput> = {},
): UpsertBarSpecialInput {
  return {
    id,
    barId: "venue-a",
    title: "Tuesday special",
    description: "A manager-only inventory promotion",
    price: 15,
    discount: "$3 off",
    savingsAmountCents: 300,
    startsAt: MINUTE_1,
    endsAt: MINUTE_3,
    startTime: "17:00",
    endTime: "20:00",
    recurrenceFrequency: "weekly",
    daysOfWeek: ["tue"],
    timezone: "Australia/Melbourne",
    scheduleNote: "While stock lasts",
    exclusive: false,
    active: true,
    now: BASE_TIME,
    ...overrides,
  };
}

describe("VenueInventoryRepository with AsyncSqliteDatabase", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ database }) => {
      if (database.metrics().totalConnections > 0) await database.close();
    }));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    const database = new AsyncSqliteDatabase(raw);
    const created = { raw, database, repository: new VenueInventoryRepository(database) };
    fixtures.push(created);
    return created;
  }

  it("round-trips full profile metadata, legacy tiers, JSON text, and bounded reportable ordering", async () => {
    const { raw, repository } = fixture();
    const basic = await repository.upsertBarProfile(profileInput("venue-basic"));
    expect(basic).toEqual(expect.objectContaining({
      barId: "venue-basic",
      membershipTier: "basic",
      openingHours: { fri: { open: "12:00", close: "23:00" } },
      venueTags: ["craft beer", "beer garden"],
      posWebhookTokenVersion: 1,
      posPreviousTokenVersion: null,
      tierManualOverride: false,
      acceptsPintPathCodes: false,
      active: true,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    }));

    const proA = await repository.upsertBarProfile(profileInput("venue-pro-a", {
      name: "Alpha Pro",
      membershipTier: "pro",
      highlightedName: true,
      premiumBadge: "Partner",
      promoted: true,
      featuredSpecialEligible: true,
      stripeCustomerId: "cus_test_a",
      stripeSubscriptionId: "sub_test_a",
      subscriptionStatus: "trialing",
      tierManualOverride: true,
      acceptsPintPathCodes: true,
      now: MINUTE_2,
    }));
    await repository.upsertBarProfile(profileInput("venue-pro-b", {
      name: "Bravo Pro",
      membershipTier: "pro",
      now: MINUTE_2,
    }));
    await repository.upsertBarProfile(profileInput("venue-inactive", {
      membershipTier: "pro",
      active: false,
      now: MINUTE_3,
    }));

    expect(proA).toMatchObject({
      highlightedName: true,
      premiumBadge: "Partner",
      promoted: true,
      featuredSpecialEligible: true,
      stripeCustomerId: "cus_test_a",
      stripeSubscriptionId: "sub_test_a",
      subscriptionStatus: "trialing",
      tierManualOverride: true,
      acceptsPintPathCodes: true,
    });
    raw.prepare(
      `UPDATE venue_profiles
       SET subscription_current_period_end = ?,
           stripe_paid_membership_tier = 'plus',
           stripe_event_created_at = ?,
           pos_webhook_token_version = 2,
           pos_previous_token_version = 1,
           pos_previous_token_valid_until = ?,
           pos_last_success_at = ?,
           pos_last_terminal_id = 'terminal-a'
       WHERE venue_id = ?`,
    ).run(MINUTE_3, MINUTE_1, MINUTE_2, MINUTE_2, "venue-pro-a");
    expect(await repository.getBarProfile("venue-pro-a")).toMatchObject({
      subscriptionCurrentPeriodEnd: MINUTE_3,
      stripePaidMembershipTier: "pro",
      stripeEventCreatedAt: MINUTE_1,
      posWebhookTokenVersion: 2,
      posPreviousTokenVersion: 1,
      posPreviousTokenValidUntil: MINUTE_2,
      posLastSuccessAt: MINUTE_2,
      posLastTerminalId: "terminal-a",
    });
    expect((await repository.listReportableBarProfiles({ limit: 10 })).map((profile) => profile.barId))
      .toEqual(["venue-pro-a", "venue-pro-b"]);
    expect(await repository.listReportableBarProfiles({ venueId: "venue-pro-b", limit: 1 }))
      .toEqual([expect.objectContaining({ barId: "venue-pro-b" })]);

    raw.prepare(
      `UPDATE venue_profiles
       SET membership_tier = 'plus', opening_hours_json = ?, venue_tags_json = ?
       WHERE venue_id = ?`,
    ).run(JSON.stringify({ nativeParity: true }), JSON.stringify(["legacy tier"]), "venue-basic");
    expect(await repository.getBarProfile("venue-basic")).toMatchObject({
      membershipTier: "pro",
      openingHours: { nativeParity: true },
      venueTags: ["legacy tier"],
    });
  });

  it("makes profile versions strictly advance and rejects stale same-clock updates", async () => {
    const { repository } = fixture();
    const created = await repository.upsertBarProfile(profileInput("venue-a"));
    const updated = await repository.upsertBarProfile(profileInput("venue-a", {
      name: "Updated venue",
      expectedUpdatedAt: created.updatedAt,
      now: created.updatedAt,
    }));
    expect(updated.updatedAt).toBe(NEXT_MILLISECOND);
    await expect(repository.upsertBarProfile(profileInput("venue-a", {
      name: "Stale venue",
      expectedUpdatedAt: created.updatedAt,
      now: MINUTE_1,
    }))).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    expect((await repository.getBarProfile("venue-a"))?.name).toBe("Updated venue");
  });

  it("atomically fences overlapping beer writers, preserves verification times, orders, and deletes", async () => {
    const { repository } = fixture();
    await repository.upsertBarProfile(profileInput("venue-a"));
    const created = await repository.upsertBarBeer(beerInput("beer-a"));
    expect(created).toMatchObject({
      price: 12.5,
      abv: 4.6,
      priceVerifiedAt: BASE_TIME,
      stockVerifiedAt: BASE_TIME,
      onTap: true,
      inStock: true,
    });

    const contenders = await Promise.allSettled([
      repository.upsertBarBeer(beerInput("beer-a", {
        beerName: "Writer Z",
        price: 13,
        expectedUpdatedAt: created.updatedAt,
        now: MINUTE_1,
      })),
      repository.upsertBarBeer(beerInput("beer-a", {
        beerName: "Writer A",
        price: 14,
        expectedUpdatedAt: created.updatedAt,
        now: MINUTE_1,
      })),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = contenders.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(OptimisticConcurrencyError);

    await repository.upsertBarBeer(beerInput("beer-z", {
      beerName: "zebra lager",
      onTap: true,
      inStock: false,
      price: null,
      priceVerifiedAt: null,
      now: MINUTE_2,
    }));
    await repository.upsertBarBeer(beerInput("beer-b", {
      beerName: "Bravo Lager",
      onTap: true,
      inStock: false,
      now: MINUTE_2,
    }));
    await repository.upsertBarBeer(beerInput("beer-c", {
      beerName: "alpha can",
      onTap: false,
      inStock: true,
      now: MINUTE_2,
    }));
    expect((await repository.listBarBeers("venue-a")).map((beer) => beer.id))
      .toEqual(["beer-a", "beer-b", "beer-z", "beer-c"]);

    const current = await repository.getBarBeerById("beer-a");
    await expect(repository.deleteBarBeer({
      id: "beer-a",
      barId: "venue-a",
      expectedUpdatedAt: BASE_TIME,
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    await expect(repository.deleteBarBeer({
      id: "beer-a",
      barId: "venue-a",
      expectedUpdatedAt: current!.updatedAt,
    })).resolves.toBe(true);
    await expect(repository.deleteBarBeer({ id: "beer-a", barId: "venue-a" })).resolves.toBe(false);
  });

  it("round-trips internal happy-hour and special inventory with deterministic ordering and conflicts", async () => {
    const { repository } = fixture();
    await repository.upsertBarProfile(profileInput("venue-a"));
    await repository.upsertBarBeer(beerInput("beer-a"));
    const happy = await repository.upsertBarHappyHour(happyHourInput("happy-a"));
    expect(happy).toEqual(expect.objectContaining({
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "16:30",
      endTime: "18:30",
      happyHourBeers: [expect.objectContaining({
        beerName: "Carlton Draught",
        happyHourPrice: 9.5,
        onTap: true,
      })],
    }));
    const updatedHappy = await repository.upsertBarHappyHour(happyHourInput("happy-a", {
      title: "Updated weekday pints",
      expectedUpdatedAt: happy.updatedAt,
      now: MINUTE_1,
    }));
    expect(updatedHappy).toMatchObject({ title: "Updated weekday pints", updatedAt: MINUTE_1 });
    await repository.upsertBarHappyHour(happyHourInput("happy-b", {
      title: "alpha later",
      startTime: "18:00",
      active: false,
      now: MINUTE_1,
    }));
    expect((await repository.listBarHappyHours("venue-a")).map((item) => item.id))
      .toEqual(["happy-a", "happy-b"]);
    await expect(repository.upsertBarHappyHour(happyHourInput("happy-a", {
      title: "stale",
      expectedUpdatedAt: happy.updatedAt,
      now: MINUTE_2,
    }))).rejects.toBeInstanceOf(OptimisticConcurrencyError);

    const special = await repository.upsertBarSpecial(specialInput("special-a"));
    expect(special).toEqual(expect.objectContaining({
      price: 15,
      savingsAmountCents: 300,
      startTime: "17:00",
      recurrence: {
        frequency: "weekly",
        daysOfWeek: ["tue"],
        timezone: "Australia/Melbourne",
      },
      exclusive: false,
    }));
    const updatedSpecial = await repository.upsertBarSpecial(specialInput("special-a", {
      title: "Updated Tuesday special",
      price: 16,
      expectedUpdatedAt: special.updatedAt,
      now: MINUTE_1,
    }));
    expect(updatedSpecial).toMatchObject({ title: "Updated Tuesday special", price: 16, updatedAt: MINUTE_1 });
    await expect(repository.upsertBarSpecial(specialInput("special-a", {
      title: "Stale Tuesday special",
      expectedUpdatedAt: special.updatedAt,
      now: MINUTE_2,
    }))).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    await repository.upsertBarSpecial(specialInput("special-exclusive", {
      title: "Exclusive",
      startsAt: null,
      endsAt: null,
      exclusive: true,
      now: MINUTE_2,
    }));
    await repository.upsertBarSpecial(specialInput("special-inactive", {
      title: "Inactive",
      active: false,
      now: MINUTE_3,
    }));
    expect((await repository.listBarSpecials("venue-a")).map((item) => item.id))
      .toEqual(["special-exclusive", "special-a", "special-inactive"]);

    await expect(repository.deleteBarSpecial({
      id: updatedSpecial.id,
      barId: updatedSpecial.barId,
      expectedUpdatedAt: special.updatedAt,
    })).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    await expect(repository.deleteBarHappyHour({
      id: updatedHappy.id,
      barId: updatedHappy.barId,
      expectedUpdatedAt: updatedHappy.updatedAt,
    })).resolves.toBe(true);
    await expect(repository.deleteBarSpecial({
      id: updatedSpecial.id,
      barId: updatedSpecial.barId,
      expectedUpdatedAt: updatedSpecial.updatedAt,
    })).resolves.toBe(true);
    await expect(repository.getBarHappyHourById(updatedHappy.id)).resolves.toBeNull();
    await expect(repository.getBarSpecialById(updatedSpecial.id)).resolves.toBeNull();
  });

  it("finds the latest matching community timestamp across bounded venue/name alternatives", async () => {
    const { raw, repository } = fixture();
    const insert = raw.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, beer_name, normalized_beer_id, serving_size,
         source_type, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, 'Test Venue', ?, ?, 'pint', 'community_verified', ?, ?, ?)`,
    );
    insert.run("price-a", "venue-a", "Carlton Draught", "carlton_draft", MINUTE_1, BASE_TIME, MINUTE_1);
    insert.run("price-b", "venue-alias", "Carlton Draft", null, MINUTE_3, BASE_TIME, MINUTE_3);
    insert.run("price-other", "venue-a", "Guinness", "guinness", MINUTE_2, BASE_TIME, MINUTE_2);

    await expect(repository.getLatestVenueBeerTimestamp({
      venueId: "venue-a",
      venueIds: ["venue-a", "venue-alias", "venue-a"],
      normalizedBeerId: "carlton_draft",
      beerNames: [" Carlton Draft ", "carlton draught"],
    })).resolves.toBe(MINUTE_3);
    await expect(repository.getLatestVenueBeerTimestamp({
      venueId: "venue-a",
      beerNames: [],
    })).resolves.toBeNull();
  });

  it("rejects invalid input and malformed persisted JSON/native values instead of widening them", async () => {
    const { raw, repository } = fixture();
    await repository.upsertBarProfile(profileInput("venue-a"));
    await expect(repository.upsertBarBeer(beerInput("bad-price", { price: 12.345 })))
      .rejects.toThrow("Invalid venue inventory input: price");
    await expect(repository.upsertBarHappyHour(happyHourInput("bad-time", { startTime: "25:00" })))
      .rejects.toThrow("Invalid venue inventory input: startTime");
    await expect(repository.upsertBarSpecial(specialInput("bad-days", {
      recurrenceFrequency: "weekly",
      daysOfWeek: [],
    }))).rejects.toThrow("Invalid venue inventory input: daysOfWeek");

    raw.prepare("UPDATE venue_profiles SET opening_hours_json = ? WHERE venue_id = ?")
      .run("not-json", "venue-a");
    await expect(repository.getBarProfile("venue-a"))
      .rejects.toThrow("Invalid venue inventory database record: openingHoursJson");
  });

  it("canonicalizes valid offsets and rejects impossible calendar dates and oversized offsets", async () => {
    const { raw, repository } = fixture();
    const profile = await repository.upsertBarProfile(profileInput("venue-offset", {
      now: "2026-08-08T10:00:00+10:00",
    }));
    expect(profile).toMatchObject({ createdAt: BASE_TIME, updatedAt: BASE_TIME });

    raw.prepare(
      `UPDATE venue_profiles
       SET subscription_current_period_end = ?, updated_at = ?
       WHERE venue_id = ?`,
    ).run("2026-08-08T10:03:00+10:00", "2026-08-08T10:01:00+10:00", profile.barId);
    expect(await repository.getBarProfile(profile.barId)).toMatchObject({
      subscriptionCurrentPeriodEnd: MINUTE_3,
      updatedAt: MINUTE_1,
    });

    await expect(repository.upsertBarProfile(profileInput("venue-february-30", {
      now: "2026-02-30T00:00:00.000Z",
    }))).rejects.toThrow("Invalid venue inventory input: now");
    await expect(repository.upsertBarProfile(profileInput("venue-offset-14-01", {
      now: "2026-08-08T00:00:00+14:01",
    }))).rejects.toThrow("Invalid venue inventory input: now");
    await expect(repository.upsertBarProfile(profileInput("venue-offset-15", {
      now: "2026-08-08T00:00:00+15:00",
    }))).rejects.toThrow("Invalid venue inventory input: now");

    raw.prepare("UPDATE venue_profiles SET updated_at = ? WHERE venue_id = ?")
      .run("2026-04-31T00:00:00.000Z", profile.barId);
    await expect(repository.getBarProfile(profile.barId))
      .rejects.toThrow("Invalid venue inventory database record: updatedAt");
  });

  it("propagates closed-database failures without a synchronous fallback", async () => {
    const created = fixture();
    await created.database.close();
    await expect(created.repository.getBarProfile("venue-a")).rejects.toThrow(/database (?:connection )?is not open|Database is closed/i);
  });
});
