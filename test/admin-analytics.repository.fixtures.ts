import type { SqlDatabase } from "../src/db/sql-database.js";

export const ANALYTICS_SINCE = "2026-07-01T00:00:00.000Z";
export const ANALYTICS_SEVEN_DAYS_AGO = "2026-07-25T00:00:00.000Z";
export const ANALYTICS_THIRTY_DAYS_AGO = "2026-07-02T00:00:00.000Z";
export const ANALYTICS_STALE_BEFORE = "2026-05-01T00:00:00.000Z";
export const ANALYTICS_AS_OF = "2026-08-01T00:00:00.000Z";
export const ANALYTICS_TOTAL_VENUES = 14;

export const KPI_INPUT = Object.freeze({
  since: ANALYTICS_SINCE,
  sevenDaysAgo: ANALYTICS_SEVEN_DAYS_AGO,
  thirtyDaysAgo: ANALYTICS_THIRTY_DAYS_AGO,
  staleBefore: ANALYTICS_STALE_BEFORE,
  totalVenues: ANALYTICS_TOTAL_VENUES,
});

export const EXPECTED_KPI_METRICS = Object.freeze({
  totalUsers: 5,
  newUsers: 2,
  weeklyActiveUsers: 2,
  monthlyActiveUsers: 3,
  returningUsers: 3,
  freeUsers: 2,
  paidUsers: 2,
  contributorUnlockedUsers: 1,
  subscriptionConversionCount: 1,
  subscriptionConversionRate: 0.5,
  totalVenueSearches: 2,
  totalBeerSearches: 3,
  totalVenueDetailViews: 8,
  totalFreePreviewViews: 2,
  totalMapFilterUses: 8,
  totalNearMeUses: 1,
  totalHappyHourNearMeUses: 1,
  totalDistanceSortUses: 1,
  totalSubmissionStarts: 1,
  totalSubmissionCompletions: 1,
  totalPendingSubmissions: 1,
  totalApprovedSubmissions: 1,
  totalRejectedSubmissions: 1,
  submissionApprovalRate: 0.5,
  totalContributorPointsAwarded: 10.5,
  contributorAccessEarnedUsers: 1,
  venuesWithVerifiedData: 2,
  venuesWithStaleData: 2,
  venuesWithNoBeerPriceData: 12,
  activeMissions: 2,
  missionCompletionCount: 1,
  potentialPartnerLeadCount: 4,
  yearlyPaidUsers: 1,
  usersTried: 27,
  returnedThirtyDays: 3,
  usersSubmitted: 4,
  verifiedPricesAdded: 4,
});

export const EXPECTED_KPI_BUCKETS = Object.freeze({
  topSearchedBeers: [{ key: "guinness", count: 3 }],
  topSearchedSuburbs: [
    { key: "Richmond", count: 3 },
    { key: "Brighton", count: 1 },
    { key: "Melbourne", count: 1 },
  ],
  topClickedVenues: [
    { key: "venue-alpha", label: "Alpha Hotel", count: 3 },
    { key: "b9714e3b-fece-4f0e-a04b-534c3e57519d", label: "Half Moon", count: 2 },
    { key: "venue-stale", label: "Stale Pub", count: 2 },
    { key: "venue-fresh", label: "Fresh Bar", count: 1 },
  ],
  topVenuesNeedingData: [
    { key: "Alpha Hotel", count: 8 },
    { key: "Beta Bar", count: 8 },
  ],
  highDemandVenuesWithStaleOrMissingData: [
    { key: "b9714e3b-fece-4f0e-a04b-534c3e57519d", label: "Half Moon", count: 2 },
    { key: "venue-profile-fallback", label: "Profile Fallback Bar", count: 1 },
  ],
});

export const EXPECTED_WEEK_COHORTS = Object.freeze([
  { cohort: "2026-W30", users: 1, returned7: 0, returned30: 0, retention7: 0, retention30: 0 },
  { cohort: "2026-W26", users: 2, returned7: 0, returned30: 1, retention7: 0, retention30: 0.5 },
  { cohort: "2026-W01", users: 1, returned7: 0, returned30: 1, retention7: 0, retention30: 1 },
  { cohort: "2026-W00", users: 1, returned7: 1, returned30: 1, retention7: 1, retention30: 1 },
]);

export const EXPECTED_MONTH_COHORTS = Object.freeze([
  { cohort: "2026-07", users: 2, returned7: 0, returned30: 0, retention7: 0, retention30: 0 },
  { cohort: "2026-06", users: 1, returned7: 0, returned30: 1, retention7: 0, retention30: 1 },
  { cohort: "2026-01", users: 2, returned7: 1, returned30: 2, retention7: 0.5, retention30: 1 },
]);

export const EXPECTED_COVERAGE_WITHOUT_AGE = Object.freeze({
  totalVenues: 14,
  venuesWithAtLeastOneVerifiedPrice: 2,
  venuesWithThreePlusVerifiedPrices: 1,
  venuesWithHappyHourData: 1,
  venuesWithStaleData: 2,
  venuesWithNoData: 12,
  disputedRecords: 1,
  coverageBySuburb: [
    { suburb: "Richmond", venuesWithPrices: 2, priceRecords: 2 },
    { suburb: "Carlton", venuesWithPrices: 1, priceRecords: 1 },
    { suburb: "Fitzroy", venuesWithPrices: 1, priceRecords: 3 },
    { suburb: "Melbourne", venuesWithPrices: 1, priceRecords: 1 },
  ],
});

export const EXPECTED_PARTNER_LEADS = Object.freeze([
  {
    venueId: "venue-alpha",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    mapViews: 3,
    venueClicks: 6,
    searchesNearby: 0,
    requests: 1,
    dataFreshness: "fresh",
    currentConfidence: "photo_verified",
    suggestedReason: "users requested this",
  },
  {
    venueId: "venue-null-suburb",
    venueName: "Null Suburb Bar",
    suburb: "Melbourne",
    mapViews: 0,
    venueClicks: 0,
    searchesNearby: 4,
    requests: 0,
    dataFreshness: "fresh",
    currentConfidence: "stale",
    suggestedReason: "popular happy hour or beer interest",
  },
  {
    venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
    venueName: "Half Moon",
    suburb: "Brighton",
    mapViews: 0,
    venueClicks: 2,
    searchesNearby: 1,
    requests: 0,
    dataFreshness: "stale_or_missing",
    currentConfidence: "missing",
    suggestedReason: "missing data",
  },
  {
    venueId: "venue-stale",
    venueName: "Stale Pub",
    suburb: "Richmond",
    mapViews: 0,
    venueClicks: 2,
    searchesNearby: 0,
    requests: 0,
    dataFreshness: "stale_or_missing",
    currentConfidence: "disputed",
    suggestedReason: "missing data",
  },
  {
    venueId: "venue-boundary",
    venueName: "Boundary Bar",
    suburb: "Richmond",
    mapViews: 0,
    venueClicks: 0,
    searchesNearby: 0,
    requests: 0,
    dataFreshness: "fresh",
    currentConfidence: "user_reported_pending",
    suggestedReason: "high demand",
  },
  {
    venueId: "venue-fresh",
    venueName: "Fresh Bar",
    suburb: "Carlton",
    mapViews: 0,
    venueClicks: 0,
    searchesNearby: 0,
    requests: 0,
    dataFreshness: "fresh",
    currentConfidence: "venue_confirmed",
    suggestedReason: "high demand",
  },
  {
    venueId: "venue-profile-fallback",
    venueName: "venue-profile-fallback",
    suburb: "Carlton",
    mapViews: 0,
    venueClicks: 0,
    searchesNearby: 0,
    requests: 0,
    dataFreshness: "stale_or_missing",
    currentConfidence: "missing",
    suggestedReason: "missing data",
  },
]);

interface AccountFixture {
  id: string;
  subscriptionStatus: string;
  createdAt: string;
}

interface EventFixture {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  eventType: string;
  venueId: string | null;
  beerId: string | null;
  suburb: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface PriceFixture {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  confidence: string;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
  lastVerifiedAt: string;
}

const ACCOUNTS: readonly AccountFixture[] = [
  { id: "user-a", subscriptionStatus: "free", createdAt: "2026-01-04T00:00:00.000Z" },
  { id: "user-b", subscriptionStatus: "premium_monthly", createdAt: "2026-01-05T00:00:00.000Z" },
  { id: "user-c", subscriptionStatus: "contributor_unlocked", createdAt: ANALYTICS_SINCE },
  { id: "user-d", subscriptionStatus: "premium_yearly", createdAt: "2026-06-30T23:59:59.999Z" },
  { id: "user-e", subscriptionStatus: "free", createdAt: "2026-07-31T00:00:00.000Z" },
];

const EVENTS: readonly EventFixture[] = [
  {
    id: "event-a-same-time",
    userId: "user-a",
    anonymousSessionId: null,
    eventType: "search_performed",
    venueId: null,
    beerId: null,
    suburb: "Oldtown",
    metadata: {},
    createdAt: "2026-01-04T00:00:00.000Z",
  },
  {
    id: "event-a-seven-boundary",
    userId: "user-a",
    anonymousSessionId: null,
    eventType: "search_performed",
    venueId: null,
    beerId: null,
    suburb: "Oldtown",
    metadata: {},
    createdAt: "2026-01-11T00:00:00.000Z",
  },
  {
    id: "event-a-thirty-boundary",
    userId: "user-a",
    anonymousSessionId: null,
    eventType: "mission_opened",
    venueId: null,
    beerId: null,
    suburb: null,
    metadata: {},
    createdAt: "2026-02-03T00:00:00.000Z",
  },
  {
    id: "event-b-after-seven",
    userId: "user-b",
    anonymousSessionId: null,
    eventType: "beer_search_performed",
    venueId: null,
    beerId: "old_beer",
    suburb: "Oldtown",
    metadata: {},
    createdAt: "2026-01-12T00:00:00.001Z",
  },
  {
    id: "event-c-after-thirty",
    userId: "user-c",
    anonymousSessionId: null,
    eventType: "map_filter_used",
    venueId: "venue-boundary",
    beerId: null,
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-31T00:00:00.001Z",
  },
  {
    id: "event-d-thirty-range-boundary",
    userId: "user-d",
    anonymousSessionId: null,
    eventType: "map_pin_click",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: { venueName: "Alpha Hotel" },
    createdAt: ANALYTICS_THIRTY_DAYS_AGO,
  },
  {
    id: "event-d-seven-range-boundary",
    userId: "user-d",
    anonymousSessionId: null,
    eventType: "venue_detail_opened",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: { venueName: "Alpha Hotel" },
    createdAt: ANALYTICS_SEVEN_DAYS_AGO,
  },
  {
    id: "event-subscription-boundary",
    userId: null,
    anonymousSessionId: "anon-subscription",
    eventType: "subscription_created",
    venueId: null,
    beerId: null,
    suburb: null,
    metadata: {},
    createdAt: ANALYTICS_SINCE,
  },
  {
    id: "event-subscription-before",
    userId: null,
    anonymousSessionId: "anon-subscription-before",
    eventType: "subscription_created",
    venueId: null,
    beerId: null,
    suburb: null,
    metadata: {},
    createdAt: "2026-06-30T23:59:59.999Z",
  },
  {
    id: "event-search",
    userId: null,
    anonymousSessionId: "anon-search",
    eventType: "search_performed",
    venueId: null,
    beerId: null,
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-10T00:00:00.000Z",
  },
  {
    id: "event-suburb-search",
    userId: null,
    anonymousSessionId: "anon-suburb-search",
    eventType: "suburb_search_performed",
    venueId: null,
    beerId: null,
    suburb: "Melbourne",
    metadata: {},
    createdAt: "2026-07-11T00:00:00.000Z",
  },
  {
    id: "event-beer-one",
    userId: null,
    anonymousSessionId: "anon-beer-one",
    eventType: "beer_search_performed",
    venueId: null,
    beerId: "guinness",
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-12T00:00:00.000Z",
  },
  {
    id: "event-beer-two",
    userId: null,
    anonymousSessionId: "anon-beer-two",
    eventType: "beer_search_performed",
    venueId: null,
    beerId: "guinness",
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-13T00:00:00.000Z",
  },
  {
    id: "event-alpha-card",
    userId: null,
    anonymousSessionId: "anon-alpha-card",
    eventType: "venue_card_viewed",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: { venueName: "Alpha Hotel" },
    createdAt: "2026-07-14T00:00:00.000Z",
  },
  {
    id: "event-alpha-map",
    userId: null,
    anonymousSessionId: "anon-alpha-map",
    eventType: "map_viewed",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: { venueName: "Alpha Hotel" },
    createdAt: "2026-07-15T00:00:00.000Z",
  },
  {
    id: "event-stale-card",
    userId: null,
    anonymousSessionId: "anon-stale-card",
    eventType: "venue_card_viewed",
    venueId: "venue-stale",
    beerId: null,
    suburb: "Richmond",
    metadata: { venueName: "Stale Pub" },
    createdAt: "2026-07-16T00:00:00.000Z",
  },
  {
    id: "event-stale-detail",
    userId: null,
    anonymousSessionId: "anon-stale-detail",
    eventType: "venue_detail_opened",
    venueId: "venue-stale",
    beerId: null,
    suburb: "Richmond",
    metadata: { venueName: "Stale Pub" },
    createdAt: "2026-07-17T00:00:00.000Z",
  },
  {
    id: "event-stale-preview",
    userId: null,
    anonymousSessionId: "anon-stale-preview",
    eventType: "price_view_revealed",
    venueId: "venue-stale",
    beerId: null,
    suburb: "Richmond",
    metadata: { venueName: "Stale Pub" },
    createdAt: "2026-07-18T00:00:00.000Z",
  },
  {
    id: "event-profile-preview",
    userId: null,
    anonymousSessionId: "anon-profile-preview",
    eventType: "free_preview_viewed",
    venueId: "venue-profile-fallback",
    beerId: null,
    suburb: "Carlton",
    metadata: {},
    createdAt: "2026-07-19T00:00:00.000Z",
  },
  {
    id: "event-near-me",
    userId: null,
    anonymousSessionId: "anon-near-me",
    eventType: "near_me_enabled",
    venueId: null,
    beerId: null,
    suburb: "Richmond",
    metadata: { radiusKm: 2, locationStatus: "granted" },
    createdAt: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "event-happy-near-me",
    userId: null,
    anonymousSessionId: "anon-happy-near-me",
    eventType: "happy_hour_near_me_used",
    venueId: null,
    beerId: null,
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-20T00:05:00.000Z",
  },
  {
    id: "event-distance-sort",
    userId: null,
    anonymousSessionId: "anon-distance",
    eventType: "distance_sort_used",
    venueId: null,
    beerId: null,
    suburb: "Richmond",
    metadata: {},
    createdAt: "2026-07-20T00:10:00.000Z",
  },
  {
    id: "event-submission-start",
    userId: "user-a",
    anonymousSessionId: null,
    eventType: "submission_started",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: {},
    createdAt: "2026-07-20T00:15:00.000Z",
  },
  {
    id: "event-submission-complete",
    userId: "user-a",
    anonymousSessionId: null,
    eventType: "submission_completed",
    venueId: "venue-alpha",
    beerId: null,
    suburb: "Fitzroy",
    metadata: {},
    createdAt: "2026-07-20T00:20:00.000Z",
  },
  {
    id: "event-half-uuid-detail",
    userId: null,
    anonymousSessionId: "anon-half-uuid-1",
    eventType: "venue_detail_opened",
    venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
    beerId: null,
    suburb: "Brighton",
    metadata: { venueName: "Half Moon" },
    createdAt: "2026-07-21T00:00:00.000Z",
  },
  {
    id: "event-half-uuid-card",
    userId: null,
    anonymousSessionId: "anon-half-uuid-2",
    eventType: "venue_card_viewed",
    venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
    beerId: null,
    suburb: "Brighton",
    metadata: { venueName: "Half Moon" },
    createdAt: "2026-07-22T00:00:00.000Z",
  },
  {
    id: "event-half-slug-search",
    userId: null,
    anonymousSessionId: "anon-half-slug",
    eventType: "beer_search_performed",
    venueId: "half-moon-brighton",
    beerId: "guinness",
    suburb: "Brighton",
    metadata: { venueName: "Half Moon" },
    createdAt: "2026-07-23T00:00:00.000Z",
  },
  {
    id: "event-null-interest-1",
    userId: null,
    anonymousSessionId: "anon-null-1",
    eventType: "happy_hour_active_now_used",
    venueId: "venue-null-suburb",
    beerId: null,
    suburb: null,
    metadata: { venueName: "Null Suburb Bar" },
    createdAt: "2026-07-24T00:00:00.000Z",
  },
  {
    id: "event-null-interest-2",
    userId: null,
    anonymousSessionId: "anon-null-2",
    eventType: "happy_hour_active_now_used",
    venueId: "venue-null-suburb",
    beerId: null,
    suburb: null,
    metadata: { venueName: "Null Suburb Bar" },
    createdAt: "2026-07-24T00:01:00.000Z",
  },
  {
    id: "event-null-interest-3",
    userId: null,
    anonymousSessionId: "anon-null-3",
    eventType: "happy_hour_active_now_used",
    venueId: "venue-null-suburb",
    beerId: null,
    suburb: null,
    metadata: { venueName: "Null Suburb Bar" },
    createdAt: "2026-07-24T00:02:00.000Z",
  },
  {
    id: "event-null-interest-4",
    userId: null,
    anonymousSessionId: "anon-null-4",
    eventType: "happy_hour_active_now_used",
    venueId: "venue-null-suburb",
    beerId: null,
    suburb: null,
    metadata: { venueName: "Null Suburb Bar" },
    createdAt: "2026-07-24T00:03:00.000Z",
  },
  {
    id: "event-fresh-lookup",
    userId: null,
    anonymousSessionId: "anon-fresh",
    eventType: "venue_lookup",
    venueId: "venue-fresh",
    beerId: null,
    suburb: "Carlton",
    metadata: { venueName: "Fresh Bar" },
    createdAt: "2026-07-26T00:00:00.000Z",
  },
];

const PRICES: readonly PriceFixture[] = [
  {
    id: "price-alpha-1",
    venueId: "venue-alpha",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    confidence: "admin_verified",
    isHappyHourPrice: true,
    happyHourDetails: null,
    lastVerifiedAt: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "price-alpha-2",
    venueId: "venue-alpha",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    confidence: "photo_verified",
    isHappyHourPrice: false,
    happyHourDetails: "Weekdays 4-6pm",
    lastVerifiedAt: "2026-07-21T00:00:00.000Z",
  },
  {
    id: "price-alpha-3",
    venueId: "venue-alpha",
    venueName: "Alpha Hotel",
    suburb: "Fitzroy",
    confidence: "community_confirmed",
    isHappyHourPrice: false,
    happyHourDetails: null,
    lastVerifiedAt: "2026-07-22T00:00:00.000Z",
  },
  {
    id: "price-stale",
    venueId: "venue-stale",
    venueName: "Stale Pub",
    suburb: "Richmond",
    confidence: "disputed",
    isHappyHourPrice: false,
    happyHourDetails: null,
    lastVerifiedAt: ANALYTICS_STALE_BEFORE,
  },
  {
    id: "price-boundary",
    venueId: "venue-boundary",
    venueName: "Boundary Bar",
    suburb: "Richmond",
    confidence: "user_reported_pending",
    isHappyHourPrice: false,
    happyHourDetails: null,
    lastVerifiedAt: ANALYTICS_STALE_BEFORE,
  },
  {
    id: "price-fresh",
    venueId: "venue-fresh",
    venueName: "Fresh Bar",
    suburb: "Carlton",
    confidence: "venue_confirmed",
    isHappyHourPrice: false,
    happyHourDetails: null,
    lastVerifiedAt: "2026-07-28T00:00:00.000Z",
  },
  {
    id: "price-null-suburb",
    venueId: "venue-null-suburb",
    venueName: "Null Suburb Bar",
    suburb: null,
    confidence: "stale",
    isHappyHourPrice: false,
    happyHourDetails: null,
    lastVerifiedAt: "2026-07-29T00:00:00.000Z",
  },
];

function nativeBoolean(database: SqlDatabase, value: boolean): boolean | number {
  return database.dialect === "postgres" ? value : value ? 1 : 0;
}

export async function seedAdminAnalyticsFixture(database: SqlDatabase): Promise<void> {
  for (const account of ACCOUNTS) {
    await database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES (?, ?, 'hash', 'user', ?, 'active', ?, ?)`,
    ).run(account.id, `${account.id}@example.test`, account.subscriptionStatus, account.createdAt, account.createdAt);
  }

  const active = nativeBoolean(database, true);
  const inactive = nativeBoolean(database, false);
  await database.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
       active, sponsor_flag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'fixture', 'normal', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "mission-alpha",
    "venue-alpha",
    "Alpha Hotel",
    "Fitzroy",
    5.9,
    1.5,
    active,
    inactive,
    "2026-06-01T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z",
  );
  await database.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
       active, sponsor_flag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'fixture', 'normal', ?, ?, ?, ?, ?, ?)`,
  ).run(
    "mission-beta",
    "venue-beta",
    "Beta Bar",
    "Carlton",
    8,
    1,
    active,
    inactive,
    "2026-06-01T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
  );
  await database.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
       active, sponsor_flag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'fixture', 'normal', 20, 1, ?, ?, ?, ?)`,
  ).run(
    "mission-inactive",
    "venue-inactive",
    "Inactive Bar",
    "Melbourne",
    inactive,
    inactive,
    "2026-06-01T00:00:00.000Z",
    "2026-07-31T00:00:00.000Z",
  );

  await database.prepare(
    `INSERT INTO venue_profiles (venue_id, name, suburb, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "venue-profile-fallback",
    "Profile Fallback Bar",
    "Carlton",
    "2026-06-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  );
  await database.prepare(
    `INSERT INTO venue_profiles (venue_id, name, suburb, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "venue-profile-only",
    "Profile Only Bar",
    "Melbourne",
    "2026-06-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  );

  await database.prepare(
    `INSERT INTO venue_location_cache (venue_id, venue_name, suburb, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run("venue-location-only", "Location Only Bar", "Melbourne", "2026-07-01T00:00:00.000Z");

  await database.prepare(
    `INSERT INTO venue_requests (
       id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
       suburb, status, created_at, updated_at
     ) VALUES (?, ?, NULL, 'verify_venue', ?, ?, ?, 'open', ?, ?)`,
  ).run(
    "request-alpha",
    "user-a",
    "venue-alpha",
    "Alpha Hotel",
    "Fitzroy",
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  );
  await database.prepare(
    `INSERT INTO venue_requests (
       id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
       suburb, status, created_at, updated_at
     ) VALUES (?, ?, NULL, 'missing_venue', ?, ?, ?, 'open', ?, ?)`,
  ).run(
    "request-only",
    "user-b",
    "venue-request-only",
    "Request Only Bar",
    "Melbourne",
    "2026-07-02T00:00:00.000Z",
    "2026-07-02T00:00:00.000Z",
  );

  for (const price of PRICES) {
    await database.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, happy_hour_details, is_on_tap,
         confidence, source_type, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'Fixture Beer', 'fixture_beer', 'pint', 12, ?, ?, 'yes', ?, 'fixture', ?, ?, ?)`,
    ).run(
      price.id,
      price.venueId,
      price.venueName,
      price.suburb,
      nativeBoolean(database, price.isHappyHourPrice),
      price.happyHourDetails,
      price.confidence,
      price.lastVerifiedAt,
      price.lastVerifiedAt,
      price.lastVerifiedAt,
    );
  }

  const submissions = [
    ["submission-pending", "user-a", "venue-alpha", "pending", null, "2026-07-10T00:00:00.000Z"],
    ["submission-approved", "user-b", "venue-alpha", "approved", ANALYTICS_SINCE, "2026-06-20T00:00:00.000Z"],
    ["submission-rejected", "user-c", "venue-stale", "rejected", "2026-07-02T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    ["submission-fraud-before", "user-d", "venue-boundary", "fraud_flagged", "2026-06-30T23:59:59.999Z", "2026-06-20T00:00:00.000Z"],
  ] as const;
  for (const [id, userId, venueId, status, reviewedAt, createdAt] of submissions) {
    await database.prepare(
      `INSERT INTO submissions (
         id, user_id, venue_id, venue_name, status, submission_type, observed_at,
         points_awarded, reviewed_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'Fixture Venue', ?, 'price', ?, 0, ?, ?, ?)`,
    ).run(id, userId, venueId, status, createdAt, reviewedAt, createdAt, createdAt);
  }

  await database.prepare(
    `INSERT INTO contribution_ledger (
       id, user_id, submission_id, venue_id, points, reason, month_key, created_at
     ) VALUES (?, ?, NULL, ?, ?, 'fixture', ?, ?)`,
  ).run("ledger-boundary", "user-a", "venue-alpha", 10.5, "2026-07", ANALYTICS_SINCE);
  await database.prepare(
    `INSERT INTO contribution_ledger (
       id, user_id, submission_id, venue_id, points, reason, month_key, created_at
     ) VALUES (?, ?, NULL, ?, ?, 'fixture', ?, ?)`,
  ).run("ledger-before", "user-b", "venue-alpha", 4, "2026-06", "2026-06-30T23:59:59.999Z");

  for (const event of EVENTS) {
    await database.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
         suburb, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.userId,
      event.anonymousSessionId,
      event.eventType,
      event.venueId,
      event.beerId,
      event.suburb,
      JSON.stringify(event.metadata),
      event.createdAt,
    );
  }
}
