import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository, type SubmissionType } from "../src/db/business.repository.js";
import { createSubmissionSchema } from "../src/modules/business/business.schemas.js";
import { BusinessService } from "../src/modules/business/business.service.js";

const NOW = "2026-05-04T08:00:00.000Z";
const MONTH_KEY = "2026-05";
const PREMIUM_UNTIL = "2026-06-03T08:00:00.000Z";

let openDatabases: BetterSqlite3.Database[] = [];

function createRepository() {
  const database = new BetterSqlite3(":memory:");
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  database.exec(fs.readFileSync(schemaPath, "utf8"));
  openDatabases.push(database);

  return {
    database,
    repository: new BusinessRepository(database),
  };
}

function createBusinessService(repository: BusinessRepository) {
  return new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    FREE_PRICE_REVEALS_PER_DAY: 5,
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    ADMIN_EMAILS: "admin@example.com",
  });
}

function createAccount(repository: BusinessRepository, id: string, role: "user" | "admin" = "user") {
  const account = repository.createAccount({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    role,
    subscriptionStatus: role === "admin" ? "admin" : "free",
    now: NOW,
  });

  return repository.updateAgeConfirmed(account.id, NOW);
}

function createSubmission(
  repository: BusinessRepository,
  input: {
    id: string;
    userId: string;
    venueId: string;
    venueName?: string;
    submissionType?: SubmissionType;
    beerName?: string;
    price?: number | null;
    sourcePhotoUrl?: string | null;
  },
) {
  return repository.createSubmission({
    id: input.id,
    userId: input.userId,
    venueId: input.venueId,
    venueName: input.venueName ?? "Test Bar",
    suburb: "Melbourne",
    submissionType: input.submissionType ?? "full_venue_update",
    observedAt: NOW,
    sourcePhotoUrl: input.sourcePhotoUrl ?? "data:image/jpeg;base64,abc",
    notes: "Menu board photo supplied.",
    now: NOW,
    items: [
      {
        id: `${input.id}:item-1`,
        beerName: input.beerName ?? "Carlton Draft",
        normalizedBeerId: null,
        servingSize: "pint",
        price: input.price ?? 14,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
        confidence: 0.88,
      },
    ],
  });
}

function approve(
  repository: BusinessRepository,
  submissionId: string,
  reviewerId: string,
  pointsAwarded = 5,
) {
  return repository.reviewSubmission({
    submissionId,
    reviewerId,
    status: "approved",
    rejectionReason: null,
    fraudFlagged: false,
    pointsAwarded,
    confidence: "photo_verified",
    now: NOW,
    monthKey: MONTH_KEY,
    premiumUntil: PREMIUM_UNTIL,
    contributorUnlockPoints: 15,
  });
}

function flagFraud(repository: BusinessRepository, submissionId: string, reviewerId: string) {
  return repository.reviewSubmission({
    submissionId,
    reviewerId,
    status: "fraud_flagged",
    rejectionReason: "Fraud flagged in review.",
    fraudFlagged: true,
    pointsAwarded: 0,
    confidence: "disputed",
    now: NOW,
    monthKey: MONTH_KEY,
    premiumUntil: PREMIUM_UNTIL,
    contributorUnlockPoints: 15,
  });
}

afterEach(() => {
  openDatabases.forEach((database) => database.close());
  openDatabases = [];
});

describe("submission payload validation", () => {
  const baseSubmission = {
    venueId: "venue-1",
    venueName: "Test Bar",
    suburb: "Melbourne",
    observedAt: NOW,
    sourcePhotoDataUrl: "data:image/jpeg;base64,abc",
    sourcePhotoUrl: null,
    notes: null,
  };

  it("allows photo/source uploads without manual beer rows", () => {
    const parsed = createSubmissionSchema.parse({
      ...baseSubmission,
      submissionType: "photo_upload",
      items: [],
    });

    expect(parsed.items).toEqual([]);
  });

  it("still requires a beer row for single beer price submissions", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("requires source evidence for photo/source uploads", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "photo_upload",
      sourcePhotoDataUrl: null,
      items: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("submission queue access checks", () => {
  it("defaults non-admin submission listing to the caller's own queue", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "user");
    const otherUser = createAccount(repository, "other-user");
    const admin = createAccount(repository, "admin", "admin");

    const ownSubmission = createSubmission(repository, {
      id: "own-submission",
      userId: user.id,
      venueId: "venue-1",
    });
    createSubmission(repository, {
      id: "other-submission",
      userId: otherUser.id,
      venueId: "venue-2",
    });

    expect(() => service.listSubmissions(null, { mine: false, limit: 10 })).toThrow("Login required.");
    expect(service.listSubmissions(user, { mine: false, limit: 10 })).toEqual([ownSubmission]);
    expect(service.listSubmissions(admin, { mine: false, limit: 10 })).toHaveLength(2);
  });
});

describe("business demo contribution model", () => {
  it("unlocks contributor access after enough approved unique-venue points", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "contributor");
    const admin = createAccount(repository, "admin", "admin");

    ["venue-1", "venue-2", "venue-3"].forEach((venueId, index) => {
      const submission = createSubmission(repository, {
        id: `submission-${index + 1}`,
        userId: user.id,
        venueId,
        venueName: `Venue ${index + 1}`,
      });

      const result = approve(repository, submission.id, admin.id);
      expect(result.pointsAwarded).toBe(5);
    });

    const updated = repository.getAccountById(user.id);
    expect(updated?.contributionPointsCurrentMonth).toBe(15);
    expect(updated?.subscriptionStatus).toBe("contributor_unlocked");
    expect(updated?.premiumUntil).toBe(PREMIUM_UNTIL);
  });

  it("caps reward points to one approved submission per user, venue, and month", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "repeat-user");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: user.id, venueId: "venue-1" });
    const second = createSubmission(repository, { id: "submission-2", userId: user.id, venueId: "venue-1" });

    expect(approve(repository, first.id, admin.id).pointsAwarded).toBe(5);
    expect(approve(repository, second.id, admin.id).pointsAwarded).toBe(0);
    expect(repository.getAccountById(user.id)?.contributionPointsCurrentMonth).toBe(5);
  });

  it("publishes approved submission items as photo-verified public price records", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const submission = createSubmission(repository, {
      id: "submission-1",
      userId: user.id,
      venueId: "venue-1",
      beerName: "Stone & Wood",
      price: 15.5,
    });

    approve(repository, submission.id, admin.id);

    expect(repository.listLatestPriceRecords(10)).toEqual([
      expect.objectContaining({
        venueId: "venue-1",
        beerName: "Stone & Wood",
        servingSize: "pint",
        price: 15.5,
        confidence: "photo_verified",
        sourceSubmissionId: submission.id,
      }),
    ]);
  });

  it("increments fraud strikes and suspends reward earning after three fraud flags", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "fraud-user");
    const admin = createAccount(repository, "admin", "admin");

    ["venue-1", "venue-2", "venue-3"].forEach((venueId, index) => {
      const submission = createSubmission(repository, {
        id: `submission-${index + 1}`,
        userId: user.id,
        venueId,
      });
      flagFraud(repository, submission.id, admin.id);
    });

    const updated = repository.getAccountById(user.id);
    expect(updated?.fraudStrikeCount).toBe(3);
    expect(updated?.status).toBe("suspended");
    expect(updated?.contributionPointsCurrentMonth).toBe(0);
  });

  it("sorts high-value missions by weighted points", () => {
    const { repository } = createRepository();

    repository.createMission({
      id: "mission-normal",
      venueId: "venue-1",
      venueName: "Known Venue",
      suburb: "Fitzroy",
      reason: "stale prices",
      priority: "normal",
      points: 2,
      multiplier: 1,
      lastVerifiedAt: "2026-04-01T00:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.createMission({
      id: "mission-high",
      venueId: "venue-2",
      venueName: "Missing Venue",
      suburb: "South Melbourne",
      reason: "no prices",
      priority: "high",
      points: 5,
      multiplier: 2,
      lastVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const missions = repository.listMissions({ activeOnly: true, limit: 10 });
    expect(missions.map((mission) => mission.id)).toEqual(["mission-high", "mission-normal"]);
  });

  it("stores only aggregate analytics preview counts for admin review", () => {
    const { repository } = createRepository();

    repository.recordEvent({
      id: "event-1",
      userId: null,
      anonymousSessionId: "anon-1",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "carlton_draft",
      suburb: "Richmond",
      metadata: { query: "Carlton Draft" },
      createdAt: NOW,
    });
    repository.recordEvent({
      id: "event-2",
      userId: null,
      anonymousSessionId: "anon-2",
      eventType: "venue_detail_opened",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });

    const preview = repository.getAnalyticsPreview();
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 1 }]);
    expect(preview.topClickedVenues).toEqual([{ key: "venue-1", count: 1 }]);
    expect(preview.topSuburbs).toEqual([{ key: "Richmond", count: 2 }]);
  });

  it("stores onboarding preferences and saved items for retention shortcuts", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "saved-user");

    const preferences = repository.upsertAccountPreferences({
      userId: user.id,
      preferredSuburbs: ["Fitzroy", "Richmond"],
      preferredBeers: ["Guinness"],
      preferredUseCases: ["happy_hours"],
      onboardingCompletedAt: NOW,
      now: NOW,
    });
    const saved = repository.saveItem({
      id: "saved-1",
      userId: user.id,
      itemType: "suburb",
      itemId: "fitzroy",
      label: "Fitzroy",
      suburb: "Fitzroy",
      metadata: {},
      now: NOW,
    });

    expect(preferences.preferredSuburbs).toEqual(["Fitzroy", "Richmond"]);
    expect(saved.label).toBe("Fitzroy");
    expect(repository.listSavedItems(user.id)).toHaveLength(1);
    expect(repository.removeSavedItem({ userId: user.id, itemType: "suburb", itemId: "fitzroy" })).toBe(true);
    expect(repository.listSavedItems(user.id)).toHaveLength(0);
  });

  it("marks a price record disputed after multiple wrong-price reports", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "wrong-price-user");
    const otherUser = createAccount(repository, "wrong-price-user-2");
    const admin = createAccount(repository, "admin", "admin");
    const submission = createSubmission(repository, {
      id: "submission-price-report",
      userId: user.id,
      venueId: "venue-1",
      venueName: "Price Report Bar",
    });

    approve(repository, submission.id, admin.id);
    const priceRecord = repository.listLatestPriceRecords(1)[0]!;
    repository.createWrongPriceReport({
      id: "report-1",
      userId: user.id,
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Price Report Bar",
      priceRecordId: priceRecord.id,
      beerName: priceRecord.beerName,
      reason: "price_changed",
      notes: "Board showed a different price.",
      sourcePhotoUrl: null,
      now: NOW,
    });
    const second = repository.createWrongPriceReport({
      id: "report-2",
      userId: otherUser.id,
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Price Report Bar",
      priceRecordId: priceRecord.id,
      beerName: priceRecord.beerName,
      reason: "price_changed",
      notes: "Confirmed changed.",
      sourcePhotoUrl: null,
      now: NOW,
    });

    expect(second.markedDisputed).toBe(true);
    expect(repository.listLatestPriceRecords(1)[0]?.confidence).toBe("disputed");
  });

  it("records requests, KPI counts, retention cohorts, and partner lead signals", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "retention-user");

    repository.createVenueRequest({
      id: "request-1",
      userId: user.id,
      anonymousSessionId: null,
      requestType: "verify_venue",
      venueId: "venue-1",
      venueName: "Requested Bar",
      beerName: null,
      suburb: "Richmond",
      notes: "Popular venue.",
      now: NOW,
    });
    repository.recordEvent({
      id: "event-map",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "map_viewed",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });
    repository.recordEvent({
      id: "event-beer",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: "venue-1",
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { query: "Guinness" },
      createdAt: "2026-05-06T08:00:00.000Z",
    });
    repository.recordEvent({
      id: "event-detail",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "venue_detail_opened",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: "2026-05-06T08:05:00.000Z",
    });

    const dashboard = repository.getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 3,
    });
    const cohorts = repository.getRetentionCohorts({ groupBy: "week", limit: 4 });
    const leads = repository.getPotentialPartnerLeads({
      staleBefore: "2026-02-04T00:00:00.000Z",
      limit: 5,
    });

    expect(repository.listVenueRequests(10)).toHaveLength(1);
    expect(dashboard.metrics.totalBeerSearches).toBe(1);
    expect(dashboard.topSearchedBeers).toEqual([{ key: "guinness", count: 1 }]);
    expect(cohorts[0]).toEqual(expect.objectContaining({ users: 1, returned7: 1, returned30: 1 }));
    expect(leads[0]).toEqual(expect.objectContaining({
      venueId: "venue-1",
      requests: 1,
      dataFreshness: "stale_or_missing",
    }));
  });
});
