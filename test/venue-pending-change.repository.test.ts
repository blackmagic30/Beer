import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import {
  VenuePendingChangeRepository,
  VenuePendingChangeRepositoryError,
  type CreateBarPendingChangeInput,
} from "../src/db/venue-pending-change.repository.js";

const BASE_TIME = "2026-08-08T00:00:00.000Z";

function atMinute(minute: number): string {
  return new Date(Date.parse(BASE_TIME) + minute * 60_000).toISOString();
}

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: VenuePendingChangeRepository;
  inventory: VenueInventoryRepository;
}

function insertAccount(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, auth_provider, role,
       subscription_status, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', 'local', 'admin', 'admin', 'active', ?, ?)`,
  ).run(id, `public-${id}`, `${id}@example.test`, BASE_TIME, BASE_TIME);
}

function profilePayload(expectedUpdatedAt: string | null, name = "Venue A"): Record<string, unknown> {
  return {
    name,
    address: "1 Test Street",
    suburb: "Fitzroy",
    area: "Inner North",
    phone: "03 9000 0000",
    website: "https://example.test",
    instagram: "https://instagram.test/example",
    description: "Private manager profile",
    openingHours: { fri: { open: "12:00", close: "23:00" } },
    venueTags: ["craft beer", "beer garden"],
    active: true,
    expectedUpdatedAt,
  };
}

function beerPayload(
  id: string,
  expectedUpdatedAt: string | null,
  name = "Carlton Draught",
): Record<string, unknown> {
  return {
    id,
    beerName: name,
    normalizedBeerId: "carlton_draft",
    brewery: "Carlton & United",
    style: "Lager",
    abv: 4.6,
    serveSize: "pint",
    price: 12.5,
    onTap: true,
    inStock: true,
    notes: "Front tap",
    priceConfirmed: true,
    stockConfirmed: true,
    expectedUpdatedAt,
  };
}

function happyHourPayload(
  id: string,
  expectedUpdatedAt: string | null,
  title = "Weekday pints",
): Record<string, unknown> {
  return {
    id,
    title,
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
    expectedUpdatedAt,
  };
}

function specialPayload(
  id: string,
  expectedUpdatedAt: string | null,
  title = "Tuesday special",
): Record<string, unknown> {
  return {
    id,
    title,
    description: "Private manager inventory promotion",
    price: 15,
    discount: "$3 off",
    savingsAmountCents: 300,
    startsAt: atMinute(60),
    endsAt: atMinute(180),
    startTime: "17:00",
    endTime: "20:00",
    recurrence: {
      frequency: "weekly",
      daysOfWeek: ["tue"],
      timezone: "Australia/Melbourne",
    },
    scheduleNote: "While stock lasts",
    exclusive: false,
    active: true,
    expectedUpdatedAt,
  };
}

async function seedProfile(
  inventory: VenueInventoryRepository,
  barId: string,
  options: { tier?: "basic" | "pro"; now?: string } = {},
) {
  return inventory.upsertBarProfile({
    barId,
    name: `Venue ${barId}`,
    address: null,
    suburb: "Fitzroy",
    area: "Inner North",
    phone: null,
    website: null,
    instagram: null,
    description: null,
    openingHours: {},
    venueTags: [],
    membershipTier: options.tier ?? "basic",
    highlightedName: false,
    premiumBadge: null,
    promoted: false,
    featuredSpecialEligible: false,
    tierManualOverride: false,
    acceptsPintPathCodes: false,
    active: true,
    now: options.now ?? BASE_TIME,
  });
}

async function create(
  repository: VenuePendingChangeRepository,
  input: Omit<CreateBarPendingChangeInput, "submittedBy">,
) {
  return repository.createBarPendingChange({ ...input, submittedBy: "submitter" });
}

async function approve(
  repository: VenuePendingChangeRepository,
  id: string,
  expectedUpdatedAt: string,
  minute: number,
  reviewedBy = "reviewer-a",
) {
  return repository.reviewBarPendingChange({
    id,
    status: "approved",
    reviewedBy,
    expectedUpdatedAt,
    reviewedAt: atMinute(minute),
    rejectionReason: null,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "VenuePendingChangeRepositoryError",
    code,
  });
}

describe("VenuePendingChangeRepository with AsyncSqliteDatabase", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ database }) => {
      if (database.metrics().totalConnections > 0) await database.close();
    }));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    insertAccount(raw, "submitter");
    insertAccount(raw, "reviewer-a");
    insertAccount(raw, "reviewer-b");
    const database = new AsyncSqliteDatabase(raw);
    const created = {
      raw,
      database,
      repository: new VenuePendingChangeRepository(database),
      inventory: new VenueInventoryRepository(database),
    };
    fixtures.push(created);
    return created;
  }

  it("creates, decodes, targets, filters, paginates, and orders pending rows with canonical payloads", async () => {
    const { raw, repository, inventory } = fixture();
    await seedProfile(inventory, "venue-basic", { tier: "basic", now: atMinute(1) });
    await seedProfile(inventory, "venue-pro", { tier: "pro", now: atMinute(1) });

    const basic = await create(repository, {
      id: "pending-basic",
      barId: "venue-basic",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-basic",
      payload: beerPayload("beer-basic", null),
      now: "2026-08-08T10:02:00+10:00",
    });
    const pro = await create(repository, {
      id: "pending-pro",
      barId: "venue-pro",
      changeType: "beer",
      action: "upsert",
      targetId: null,
      payload: beerPayload("beer-pro", null, "Pro beer"),
      now: atMinute(1),
    });

    expect(basic).toMatchObject({
      targetId: "beer-basic",
      submittedAt: atMinute(2),
      createdAt: atMinute(2),
      updatedAt: atMinute(2),
      status: "pending",
      reviewedBy: null,
    });
    expect(basic.payload).toMatchObject({
      id: "beer-basic",
      beerName: "Carlton Draught",
      price: 12.5,
      priceConfirmed: true,
      expectedUpdatedAt: null,
    });
    const rawPayload = raw.prepare(
      "SELECT payload_json FROM venue_pending_changes WHERE id = ?",
    ).get("pending-basic") as { payload_json: string };
    expect(JSON.parse(rawPayload.payload_json)).toEqual(basic.payload);
    expect(await repository.getBarPendingChangeById("pending-basic")).toEqual(basic);
    expect(await repository.getPendingBarChangeForTarget({
      barId: "venue-basic",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-basic",
    })).toEqual(basic);

    expect((await repository.listBarPendingChanges({ status: "pending", limit: 10 })).map((row) => row.id))
      .toEqual([pro.id, basic.id]);
    expect(await repository.listBarPendingChanges({ barId: "venue-basic", submittedBy: "submitter", limit: 1 }))
      .toEqual([basic]);
    expect(await repository.listBarPendingChanges({ status: "pending", limit: 1, offset: 1 }))
      .toEqual([basic]);
    await expect(repository.countBarPendingChanges()).resolves.toBe(2);
    await expect(repository.countBarPendingChanges({ status: "pending" })).resolves.toBe(2);
    await expect(repository.countBarPendingChanges({ barId: "venue-basic" })).resolves.toBe(1);
    await expect(repository.countBarPendingChanges({ submittedBy: "submitter" })).resolves.toBe(2);
    await expect(repository.countBarPendingChanges({ status: "unknown" as never }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("atomically applies profile, beer, happy-hour, and special creates and updates", async () => {
    const { repository, inventory } = fixture();

    const profileCreate = await create(repository, {
      id: "profile-create",
      barId: "venue-a",
      changeType: "profile",
      action: "upsert",
      targetId: null,
      payload: profilePayload(null),
      now: atMinute(1),
    });
    const createdProfile = await approve(repository, profileCreate.id, profileCreate.updatedAt, 2);
    expect(createdProfile.appliedChange).toMatchObject({
      changeType: "profile",
      action: "upsert",
      targetId: "venue-a",
      value: { name: "Venue A", membershipTier: "basic" },
    });
    const profile = await inventory.getBarProfile("venue-a");
    const profileUpdate = await create(repository, {
      id: "profile-update",
      barId: "venue-a",
      changeType: "profile",
      action: "upsert",
      targetId: null,
      payload: profilePayload(profile!.updatedAt, "Venue A Updated"),
      now: atMinute(3),
    });
    await approve(repository, profileUpdate.id, profileUpdate.updatedAt, 4);
    expect((await inventory.getBarProfile("venue-a"))?.name).toBe("Venue A Updated");

    const beerCreate = await create(repository, {
      id: "beer-create",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-a",
      payload: beerPayload("beer-a", null),
      now: atMinute(5),
    });
    await repository.reviewBarPendingChange({
      id: beerCreate.id,
      status: "approved",
      reviewedBy: "reviewer-a",
      expectedUpdatedAt: beerCreate.updatedAt,
      reviewedAt: atMinute(6),
      rejectionReason: null,
      resolvedBeerPayload: {
        beerName: "Provider Canonical Lager",
        normalizedBeerId: "provider_canonical_lager",
        brewery: "Canonical Brewery",
        style: "Lager",
        abv: 4.6,
        serveSize: "pint",
        price: 12.5,
        onTap: true,
        inStock: true,
        notes: "Provider-normalized before transaction",
        priceConfirmed: true,
        stockConfirmed: true,
      },
    });
    const beer = await inventory.getBarBeerById("beer-a");
    expect(beer).toMatchObject({
      beerName: "Provider Canonical Lager",
      normalizedBeerId: "provider_canonical_lager",
      priceVerifiedAt: atMinute(6),
      stockVerifiedAt: atMinute(6),
    });
    const beerUpdate = await create(repository, {
      id: "beer-update",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-a",
      payload: beerPayload("beer-a", beer!.updatedAt, "Carlton Updated"),
      now: atMinute(7),
    });
    await approve(repository, beerUpdate.id, beerUpdate.updatedAt, 8);
    expect((await inventory.getBarBeerById("beer-a"))?.beerName).toBe("Carlton Updated");

    const happyCreate = await create(repository, {
      id: "happy-create",
      barId: "venue-a",
      changeType: "happy_hour",
      action: "upsert",
      targetId: "happy-a",
      payload: happyHourPayload("happy-a", null),
      now: atMinute(9),
    });
    await approve(repository, happyCreate.id, happyCreate.updatedAt, 10);
    const happy = await inventory.getBarHappyHourById("happy-a");
    const happyUpdate = await create(repository, {
      id: "happy-update",
      barId: "venue-a",
      changeType: "happy_hour",
      action: "upsert",
      targetId: "happy-a",
      payload: happyHourPayload("happy-a", happy!.updatedAt, "Happy updated"),
      now: atMinute(11),
    });
    await approve(repository, happyUpdate.id, happyUpdate.updatedAt, 12);
    expect((await inventory.getBarHappyHourById("happy-a"))?.title).toBe("Happy updated");

    const specialCreate = await create(repository, {
      id: "special-create",
      barId: "venue-a",
      changeType: "special",
      action: "upsert",
      targetId: "special-a",
      payload: specialPayload("special-a", null),
      now: atMinute(13),
    });
    await approve(repository, specialCreate.id, specialCreate.updatedAt, 14);
    const special = await inventory.getBarSpecialById("special-a");
    expect(special).toMatchObject({
      title: "Tuesday special",
      recurrence: { frequency: "weekly", daysOfWeek: ["tue"], timezone: "Australia/Melbourne" },
    });
    const specialUpdate = await create(repository, {
      id: "special-update",
      barId: "venue-a",
      changeType: "special",
      action: "upsert",
      targetId: "special-a",
      payload: specialPayload("special-a", special!.updatedAt, "Special updated"),
      now: atMinute(15),
    });
    await approve(repository, specialUpdate.id, specialUpdate.updatedAt, 16);
    expect((await inventory.getBarSpecialById("special-a"))?.title).toBe("Special updated");

    // Commercial and public eligibility are intentionally not decided here.
    expect(await inventory.getBarProfile("venue-a")).toMatchObject({
      membershipTier: "basic",
      featuredSpecialEligible: false,
      promoted: false,
    });
  });

  it("atomically deletes each supported inventory type and rejects profile deletion", async () => {
    const { repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    const beer = await inventory.upsertBarBeer({
      id: "beer-delete",
      barId: "venue-a",
      beerName: "Delete beer",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 10,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: atMinute(1),
    });
    const happy = await inventory.upsertBarHappyHour({
      id: "happy-delete",
      barId: "venue-a",
      title: "Delete happy",
      daysOfWeek: ["fri"],
      startTime: "17:00",
      endTime: "18:00",
      description: "Delete me",
      happyHourBeers: [],
      active: true,
      now: atMinute(1),
    });
    const special = await inventory.upsertBarSpecial({
      id: "special-delete",
      barId: "venue-a",
      title: "Delete special",
      description: "Delete me",
      price: 10,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: null,
      endTime: null,
      scheduleNote: null,
      exclusive: false,
      active: true,
      now: atMinute(1),
    });

    const deletes = [
      { id: "pending-delete-beer", changeType: "beer" as const, targetId: beer.id, version: beer.updatedAt },
      { id: "pending-delete-happy", changeType: "happy_hour" as const, targetId: happy.id, version: happy.updatedAt },
      { id: "pending-delete-special", changeType: "special" as const, targetId: special.id, version: special.updatedAt },
    ];
    for (const [index, item] of deletes.entries()) {
      const pending = await create(repository, {
        id: item.id,
        barId: "venue-a",
        changeType: item.changeType,
        action: "delete",
        targetId: item.targetId,
        payload: { id: item.targetId, expectedUpdatedAt: item.version },
        now: atMinute(index + 2),
      });
      expect((await approve(repository, pending.id, pending.updatedAt, index + 5)).appliedChange)
        .toMatchObject({ changeType: item.changeType, action: "delete", targetId: item.targetId, deleted: true });
    }
    expect(await inventory.getBarBeerById(beer.id)).toBeNull();
    expect(await inventory.getBarHappyHourById(happy.id)).toBeNull();
    expect(await inventory.getBarSpecialById(special.id)).toBeNull();

    await expectCode(create(repository, {
      id: "profile-delete",
      barId: "venue-a",
      changeType: "profile",
      action: "delete",
      targetId: "venue-a",
      payload: { expectedUpdatedAt: BASE_TIME },
      now: atMinute(10),
    }), "invalid_input");
  });

  it("rejects without mutating inventory", async () => {
    const { repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    const beer = await inventory.upsertBarBeer({
      id: "beer-a",
      barId: "venue-a",
      beerName: "Original",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 10,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: atMinute(1),
    });
    const pending = await create(repository, {
      id: "pending-reject",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: beer.id,
      payload: beerPayload(beer.id, beer.updatedAt, "Rejected name"),
      now: atMinute(2),
    });
    const result = await repository.reviewBarPendingChange({
      id: pending.id,
      status: "rejected",
      reviewedBy: "reviewer-a",
      expectedUpdatedAt: pending.updatedAt,
      reviewedAt: atMinute(3),
      rejectionReason: "Data could not be verified.",
    });
    expect(result.appliedChange).toBeNull();
    expect(result.pendingChange).toMatchObject({
      status: "rejected",
      reviewedBy: "reviewer-a",
      rejectionReason: "Data could not be verified.",
    });
    expect((await inventory.getBarBeerById(beer.id))?.beerName).toBe("Original");
  });

  it("rolls back stale target and pending versions without partially approving", async () => {
    const { raw, repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    const beer = await inventory.upsertBarBeer({
      id: "beer-a",
      barId: "venue-a",
      beerName: "Original",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 10,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: atMinute(1),
    });
    const staleTarget = await create(repository, {
      id: "stale-target",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: beer.id,
      payload: beerPayload(beer.id, beer.updatedAt, "Pending writer"),
      now: atMinute(2),
    });
    await inventory.upsertBarBeer({
      id: beer.id,
      barId: "venue-a",
      beerName: "Concurrent writer",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 11,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      expectedUpdatedAt: beer.updatedAt,
      now: atMinute(3),
    });
    await expectCode(approve(repository, staleTarget.id, staleTarget.updatedAt, 4), "target_version_conflict");
    expect(await repository.getBarPendingChangeById(staleTarget.id)).toMatchObject({ status: "pending" });
    expect(await inventory.getBarBeerById(beer.id)).toMatchObject({ beerName: "Concurrent writer", price: 11 });

    const stalePending = await create(repository, {
      id: "stale-pending",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-new",
      payload: beerPayload("beer-new", null),
      now: atMinute(5),
    });
    raw.prepare("UPDATE venue_pending_changes SET updated_at = ? WHERE id = ?")
      .run(atMinute(6), stalePending.id);
    await expectCode(approve(repository, stalePending.id, stalePending.updatedAt, 7), "pending_change_version_conflict");
    expect(await inventory.getBarBeerById("beer-new")).toBeNull();
    expect(await repository.getBarPendingChangeById(stalePending.id)).toMatchObject({
      status: "pending",
      updatedAt: atMinute(6),
    });
  });

  it("allows exactly one overlapping reviewer to win", async () => {
    const { repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    const pending = await create(repository, {
      id: "concurrent-review",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-race",
      payload: beerPayload("beer-race", null),
      now: atMinute(1),
    });
    const results = await Promise.allSettled([
      approve(repository, pending.id, pending.updatedAt, 2, "reviewer-a"),
      approve(repository, pending.id, pending.updatedAt, 2, "reviewer-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "pending_change_not_reviewable" },
    });
    expect(await inventory.getBarBeerById("beer-race")).toMatchObject({ beerName: "Carlton Draught" });
    const reviewed = await repository.getBarPendingChangeById(pending.id);
    expect(reviewed?.status).toBe("approved");
    expect(["reviewer-a", "reviewer-b"]).toContain(reviewed?.reviewedBy);
  });

  it("denies a cross-venue target and keeps both rows untouched", async () => {
    const { repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    await seedProfile(inventory, "venue-b");
    const foreign = await inventory.upsertBarBeer({
      id: "foreign-beer",
      barId: "venue-b",
      beerName: "Foreign",
      normalizedBeerId: null,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 10,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: atMinute(1),
    });
    const pending = await create(repository, {
      id: "cross-venue",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: foreign.id,
      payload: beerPayload(foreign.id, foreign.updatedAt, "Hijacked"),
      now: atMinute(2),
    });
    await expectCode(approve(repository, pending.id, pending.updatedAt, 3), "target_venue_conflict");
    expect(await repository.getBarPendingChangeById(pending.id)).toMatchObject({ status: "pending" });
    expect(await inventory.getBarBeerById(foreign.id)).toMatchObject({ barId: "venue-b", beerName: "Foreign" });
  });

  it("fails closed for malformed stored payloads and strictly bounds inputs", async () => {
    const { raw, repository, inventory } = fixture();
    await seedProfile(inventory, "venue-a");
    const pending = await create(repository, {
      id: "malformed",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-malformed",
      payload: beerPayload("beer-malformed", null),
      now: atMinute(1),
    });
    raw.prepare("UPDATE venue_pending_changes SET payload_json = ? WHERE id = ?")
      .run('{"beerName":', pending.id);
    await expectCode(repository.getBarPendingChangeById(pending.id), "malformed_payload");
    await expectCode(approve(repository, pending.id, pending.updatedAt, 2), "malformed_payload");
    expect(await inventory.getBarBeerById("beer-malformed")).toBeNull();

    await expectCode(create(repository, {
      id: "bad-date",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-date",
      payload: beerPayload("beer-date", null),
      now: "2026-02-30T00:00:00.000Z",
    }), "invalid_input");
    await expectCode(create(repository, {
      id: "unknown-key",
      barId: "venue-a",
      changeType: "beer",
      action: "upsert",
      targetId: "beer-unknown",
      payload: { ...beerPayload("beer-unknown", null), public: true },
      now: atMinute(3),
    }), "invalid_input");
    await expectCode(repository.listBarPendingChanges({ limit: 201 }), "invalid_input");
    await expectCode(repository.reviewBarPendingChange({
      id: "missing",
      status: "rejected",
      reviewedBy: "reviewer-a",
      expectedUpdatedAt: BASE_TIME,
      reviewedAt: atMinute(4),
      rejectionReason: null,
    }), "invalid_input");
    expect(new VenuePendingChangeRepositoryError("target_version_conflict").message)
      .toBe("The venue inventory target changed after submission.");
  });
});
