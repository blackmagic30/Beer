import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { PublicVenuePriceRecord } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  asAsyncSqliteDatabase,
  type SqlDatabase,
} from "../src/db/sql-database.js";
import {
  VenueManagerInsightsRepository,
  VenueManagerInsightsRepositoryError,
  type VenueManagerInsights,
  type VenueManagerInsightsInput,
} from "../src/db/venue-manager-insights.repository.js";

const START = "2026-05-01T00:00:00.000Z";
const END = "2026-06-01T00:00:00.000Z";
const STALE_BEFORE = "2026-05-02T00:00:00.000Z";
const CREATED = "2026-05-10T00:00:00.000Z";

const openDatabases: SqlDatabase[] = [];

function fixture() {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const database = asAsyncSqliteDatabase(raw);
  openDatabases.push(database);
  return {
    raw,
    database,
    repository: new VenueManagerInsightsRepository(database),
  };
}

afterEach(async () => {
  while (openDatabases.length > 0)
    await openDatabases
      .pop()
      ?.close()
      .catch(() => undefined);
});

function insertAccount(raw: BetterSqlite3.Database, id = "insights-user") {
  raw
    .prepare(
      `INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
     VALUES (?, ?, 'hash', ?, ?)`,
    )
    .run(id, `${id}@example.test`, START, START);
}

function priceRecord(
  id: string,
  overrides: Partial<PublicVenuePriceRecord> = {},
): PublicVenuePriceRecord {
  return {
    id,
    venueId: "venue-1",
    venueName: "Manager Hotel",
    suburb: "Fitzroy",
    beerName: `Beer ${id}`,
    normalizedBeerId: id,
    servingSize: "pint",
    price: 12,
    isHappyHourPrice: false,
    happyHourDetails: null,
    isOnTap: "yes",
    confidence: "venue_confirmed",
    sourceType: "venue_submission",
    sourceSubmissionId: null,
    lastVerifiedAt: "2026-05-20T00:00:00.000Z",
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function input(
  overrides: Partial<VenueManagerInsightsInput> = {},
): VenueManagerInsightsInput {
  return {
    venueId: "venue-1",
    suburb: "Fitzroy",
    staleBefore: STALE_BEFORE,
    priceRecords: [
      priceRecord("lager"),
      priceRecord("pale-ale", { isHappyHourPrice: true }),
      priceRecord("stout"),
      priceRecord("future", {
        createdAt: END,
        lastVerifiedAt: END,
      }),
    ],
    startIso: START,
    endIso: END,
    ...overrides,
  };
}

function seedParity(raw: BetterSqlite3.Database) {
  insertAccount(raw);
  raw
    .prepare(
      `INSERT INTO wrong_price_reports (
       id, user_id, anonymous_session_id, venue_id, venue_name, beer_name,
       reason, notes, source_photo_url, status, created_at, updated_at
     ) VALUES (?, 'insights-user', 'sensitive-session', 'venue-1', 'Manager Hotel',
       'Lager', 'price_changed', 'private note', 'private:evidence:one', 'resolved', ?, ?)`,
    )
    .run("report-1", CREATED, CREATED);
  raw
    .prepare(
      `INSERT INTO venue_requests (
       id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
       beer_name, suburb, notes, status, created_at, updated_at
     ) VALUES (?, 'insights-user', 'request-session', 'verify_venue', NULL,
       'manager hotel', NULL, 'Fitzroy', 'private request', 'open', ?, ?)`,
    )
    .run("request-1", CREATED, CREATED);
  raw
    .prepare(
      `INSERT INTO submissions (
       id, user_id, venue_id, venue_name, suburb, status, submission_type,
       observed_at, source_photo_url, ocr_status, ocr_summary_json, notes,
       points_awarded, points_eligible_by_location, pending_venue_json,
       fraud_flagged, created_at, updated_at
     ) VALUES (?, 'insights-user', 'venue-1', 'Manager Hotel', 'Fitzroy',
       'approved', 'photo_upload', ?, 'private:evidence:submission', 'processed',
       '{"model":"test","imageCount":1,"extractedRowCount":2,"rejectedCandidateCount":0,"pendingCatalogCount":0,"message":"ok"}',
       'private submission', 4, 1, NULL, 0, ?, ?)`,
    )
    .run("submission-1", CREATED, CREATED, CREATED);

  const insertEvent = raw.prepare(
    `INSERT INTO events (
       id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
       suburb, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    "view-1",
    "insights-user",
    null,
    "venue_card_viewed",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "view-duplicate",
    "insights-user",
    null,
    "venue_detail_opened",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "view-2",
    null,
    "viewer-two",
    "venue_detail_opened",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "preview-1",
    null,
    "preview-one",
    "free_preview_viewed",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "happy-1",
    null,
    "happy-one",
    "happy_hour_near_me_used",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "marker-1",
    null,
    "marker-one",
    "map_pin_click",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "beer-1",
    null,
    "beer-one",
    "beer_search_performed",
    null,
    "lager",
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "beer-2",
    null,
    "beer-two",
    "beer_search_performed",
    null,
    null,
    "Fitzroy",
    '{"query":"porter"}',
    CREATED,
  );
  insertEvent.run(
    "beer-3",
    null,
    "beer-three",
    "beer_search_performed",
    null,
    "porter",
    "Fitzroy",
    "{}",
    CREATED,
  );
  insertEvent.run(
    "outside-range",
    null,
    "outside",
    "venue_card_viewed",
    "venue-1",
    null,
    "Fitzroy",
    "{}",
    END,
  );
}

function parityOracle(): VenueManagerInsights {
  return {
    venueId: "venue-1",
    priceRecords: [
      priceRecord("lager"),
      priceRecord("pale-ale", { isHappyHourPrice: true }),
      priceRecord("stout"),
    ],
    wrongPriceReports: [
      {
        id: "report-1",
        userId: "insights-user",
        anonymousSessionId: "sensitive-session",
        venueId: "venue-1",
        venueName: "Manager Hotel",
        priceRecordId: null,
        beerName: "Lager",
        reason: "price_changed",
        notes: "private note",
        sourcePhotoUrl: "private:evidence:one",
        status: "resolved",
        assignedTo: null,
        resolutionNote: null,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    requests: [
      {
        id: "request-1",
        userId: "insights-user",
        anonymousSessionId: "request-session",
        requestType: "verify_venue",
        venueId: null,
        venueName: "manager hotel",
        googlePlaceId: null,
        beerName: null,
        suburb: "Fitzroy",
        notes: "private request",
        status: "open",
        missionId: null,
        sourceSubmissionId: null,
        assignedTo: null,
        resolutionNote: null,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    submissions: [
      {
        id: "submission-1",
        clientSubmissionId: null,
        missionId: null,
        userId: "insights-user",
        venueId: "venue-1",
        venueName: "Manager Hotel",
        suburb: "Fitzroy",
        status: "approved",
        submissionType: "photo_upload",
        observedAt: CREATED,
        sourcePhotoUrl: "private:evidence:submission",
        ocrStatus: "processed",
        ocrSummary: {
          model: "test",
          imageCount: 1,
          extractedRowCount: 2,
          rejectedCandidateCount: 0,
          pendingCatalogCount: 0,
          message: "ok",
        },
        notes: "private submission",
        pointsAwarded: 4,
        uploadLatitude: null,
        uploadLongitude: null,
        uploadAccuracyMeters: null,
        uploadLocationCapturedAt: null,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: true,
        pointsEligibilityReason: null,
        pendingVenue: null,
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
        fraudFlagged: false,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    aggregateInsights: {
      venueViews: 2,
      pricePreviewViews: 1,
      happyHourClicks: 1,
      markerClicks: 1,
      wrongPriceReports: 1,
      verifyRequests: 1,
      updatesReceived: 1,
      topSearchedBeersNearby: [
        { key: "porter", count: 2 },
        { key: "lager", count: 1 },
      ],
      missingBeerSearches: [{ key: "porter", count: 2 }],
    },
    listingQuality: {
      score: 95,
      checklist: [
        { label: "At least one verified price", complete: true, points: 20 },
        { label: "At least 3 verified beers", complete: true, points: 20 },
        { label: "Happy hour listed", complete: true, points: 15 },
        { label: "Verified within 30 days", complete: true, points: 15 },
        { label: "No unresolved disputes", complete: true, points: 15 },
        {
          label: "Venue-submitted or photo source present",
          complete: true,
          points: 10,
        },
        {
          label: "Coordinates present in venue directory",
          complete: false,
          points: 5,
        },
      ],
      latestVerifiedAt: "2026-05-20T00:00:00.000Z",
    },
  };
}

describe("VenueManagerInsightsRepository on AsyncSQLite", () => {
  it("matches the explicit legacy parity oracle and preserves raw rows for caller-side sanitization", async () => {
    const { raw, repository } = fixture();
    seedParity(raw);
    const query = input();

    const result = await repository.getVenueManagerInsights(query);

    expect(result).toEqual(parityOracle());
    expect(result.priceRecords.map((record) => record.id)).toEqual([
      "lager",
      "pale-ale",
      "stout",
    ]);
    expect(result.aggregateInsights).toMatchObject({
      venueViews: 2,
      pricePreviewViews: 1,
      happyHourClicks: 1,
      markerClicks: 1,
      topSearchedBeersNearby: [
        { key: "porter", count: 2 },
        { key: "lager", count: 1 },
      ],
      missingBeerSearches: [{ key: "porter", count: 2 }],
    });
    expect(result.wrongPriceReports[0]).toMatchObject({
      userId: "insights-user",
      anonymousSessionId: "sensitive-session",
      notes: "private note",
      sourcePhotoUrl: "private:evidence:one",
    });
    expect(result.listingQuality).toMatchObject({
      score: 95,
      latestVerifiedAt: "2026-05-20T00:00:00.000Z",
    });
  });

  it("bounds detail lists and applies deterministic binary tie-break ordering", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw);
    const report = raw.prepare(
      `INSERT INTO wrong_price_reports (
         id, venue_id, venue_name, reason, status, created_at, updated_at
       ) VALUES (?, 'venue-1', 'Manager Hotel', 'price_changed', 'resolved', ?, ?)`,
    );
    for (let index = 29; index >= 0; index -= 1) {
      report.run(`report-${String(index).padStart(2, "0")}`, CREATED, CREATED);
    }
    const event = raw.prepare(
      `INSERT INTO events (
         id, anonymous_session_id, event_type, beer_id, suburb, metadata_json, created_at
       ) VALUES (?, ?, 'beer_search_performed', ?, 'Fitzroy', '{}', ?)`,
    );
    for (let index = 9; index >= 0; index -= 1) {
      const key = `beer-${String(index).padStart(2, "0")}`;
      event.run(`event-${key}`, `actor-${key}`, key, CREATED);
    }

    const result = await repository.getVenueManagerInsights(
      input({ priceRecords: [] }),
    );
    expect(result.wrongPriceReports).toHaveLength(25);
    expect(result.wrongPriceReports.map((row) => row.id)).toEqual(
      Array.from(
        { length: 25 },
        (_, index) => `report-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(
      result.aggregateInsights.topSearchedBeersNearby.map((row) => row.key),
    ).toEqual(
      Array.from(
        { length: 8 },
        (_, index) => `beer-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(
      result.aggregateInsights.missingBeerSearches.map((row) => row.key),
    ).toEqual(
      Array.from(
        { length: 5 },
        (_, index) => `beer-${String(index).padStart(2, "0")}`,
      ),
    );
  });

  it("casts SQLite JSON scalar search keys to the same text shape as PostgreSQL", async () => {
    const { raw, repository } = fixture();
    raw
      .prepare(
        `INSERT INTO events (
         id, anonymous_session_id, event_type, suburb, metadata_json, created_at
       ) VALUES ('numeric-query', 'numeric-actor', 'beer_search_performed',
         'Fitzroy', '{"query":42}', ?)`,
      )
      .run(CREATED);

    await expect(
      repository.getVenueManagerInsights(input({ priceRecords: [] })),
    ).resolves.toMatchObject({
      aggregateInsights: {
        topSearchedBeersNearby: [{ key: "42", count: 1 }],
        missingBeerSearches: [{ key: "42", count: 1 }],
      },
    });
  });

  it("rejects noncanonical, inverted, blank, and unbounded input", async () => {
    const { repository } = fixture();
    const tooMany = Array.from({ length: 501 }, (_, index) =>
      priceRecord(`price-${index}`),
    );
    await expect(
      repository.getVenueManagerInsights(
        input({ staleBefore: "2026-05-02T00:00:00Z" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.getVenueManagerInsights(input({ venueId: "  " })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.getVenueManagerInsights(
        input({ startIso: END, endIso: START }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.getVenueManagerInsights(input({ priceRecords: tooMany })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.getVenueManagerInsights(
        input({
          priceRecords: [priceRecord("invalid-number", { price: Number.NaN })],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.getVenueManagerInsights(
        input({
          priceRecords: [
            priceRecord("unbounded-nested", {
              happyHourDays: Array.from(
                { length: 8 },
                (_, index) => `day-${index}`,
              ),
            }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("contains malformed native state and closed-database failures without leaking values", async () => {
    const malformedFixture = fixture();
    insertAccount(malformedFixture.raw);
    malformedFixture.raw
      .prepare(
        `INSERT INTO submissions (
         id, user_id, venue_id, venue_name, status, submission_type, observed_at,
         ocr_status, points_awarded, points_eligible_by_location, fraud_flagged,
         created_at, updated_at
       ) VALUES ('private-malformed-id', 'insights-user', 'venue-1', 'Manager Hotel',
         'approved', 'photo_upload', ?, 'not_requested', 0, 2, 0, ?, ?)`,
      )
      .run(CREATED, CREATED, CREATED);
    const malformed = await malformedFixture.repository
      .getVenueManagerInsights(input({ priceRecords: [] }))
      .catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(VenueManagerInsightsRepositoryError);
    expect(malformed).toMatchObject({ code: "malformed_result" });
    expect(String(malformed)).not.toContain("private-malformed-id");

    const closedFixture = fixture();
    await closedFixture.database.close();
    const closed = await closedFixture.repository
      .getVenueManagerInsights(input({ priceRecords: [] }))
      .catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(VenueManagerInsightsRepositoryError);
    expect(closed).toMatchObject({ code: "persistence_failure" });
    expect(String(closed)).not.toContain("closed");
  });
});
