import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RETENTION_COHORTS = 24;
const MAX_PARTNER_LEADS = 100;
const MAX_TOTAL_VENUES = 10_000_000;
const MAX_TEXT_LENGTH = 500;

const VERIFIED_CONFIDENCES = [
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
] as const;

const PARTNER_LEAD_CONFIDENCES = new Set([
  ...VERIFIED_CONFIDENCES,
  "user_reported_pending",
  "stale",
  "disputed",
  "missing",
]);

export interface AdminKpiDashboardInput {
  since: string | null;
  sevenDaysAgo: string;
  thirtyDaysAgo: string;
  staleBefore: string;
  totalVenues: number;
}

export interface AdminAnalyticsBucket {
  key: string;
  count: number;
}

export interface AdminAnalyticsLabeledBucket extends AdminAnalyticsBucket {
  label: string;
}

export interface AdminAnalyticsPreview {
  topSearchedBeers: AdminAnalyticsBucket[];
  topClickedVenues: AdminAnalyticsLabeledBucket[];
  topSuburbs: AdminAnalyticsBucket[];
  missionConversionCount: number;
}

export interface AdminKpiMetrics {
  totalUsers: number;
  newUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  returningUsers: number;
  freeUsers: number;
  paidUsers: number;
  contributorUnlockedUsers: number;
  subscriptionConversionCount: number;
  subscriptionConversionRate: number;
  totalVenueSearches: number;
  totalBeerSearches: number;
  totalVenueDetailViews: number;
  totalFreePreviewViews: number;
  totalMapFilterUses: number;
  totalNearMeUses: number;
  totalHappyHourNearMeUses: number;
  totalDistanceSortUses: number;
  totalSubmissionStarts: number;
  totalSubmissionCompletions: number;
  totalPendingSubmissions: number;
  totalApprovedSubmissions: number;
  totalRejectedSubmissions: number;
  submissionApprovalRate: number;
  totalContributorPointsAwarded: number;
  contributorAccessEarnedUsers: number;
  venuesWithVerifiedData: number;
  venuesWithStaleData: number;
  venuesWithNoBeerPriceData: number;
  activeMissions: number;
  missionCompletionCount: number;
  potentialPartnerLeadCount: number;
  yearlyPaidUsers: number;
  usersTried: number;
  returnedThirtyDays: number;
  usersSubmitted: number;
  verifiedPricesAdded: number;
}

export type AdminScorecardStatus = "not started" | "in progress" | "hit";

export interface AdminScorecardItem {
  label: string;
  current: number;
  target: number;
  progress: number;
  status: AdminScorecardStatus;
}

export interface AdminKpiDashboard {
  metrics: AdminKpiMetrics;
  scorecard: AdminScorecardItem[];
  topSearchedBeers: AdminAnalyticsBucket[];
  topSearchedSuburbs: AdminAnalyticsBucket[];
  topClickedVenues: AdminAnalyticsLabeledBucket[];
  topVenuesNeedingData: AdminAnalyticsBucket[];
  highDemandVenuesWithStaleOrMissingData: AdminAnalyticsLabeledBucket[];
}

export interface RetentionCohortInput {
  groupBy: "week" | "month";
  limit: number;
}

export interface RetentionCohort {
  cohort: string;
  users: number;
  returned7: number;
  returned30: number;
  retention7: number;
  retention30: number;
}

export interface CoverageDashboardInput {
  staleBefore: string;
  asOf: string;
  totalVenues: number;
}

export interface CoverageBySuburb {
  suburb: string;
  venuesWithPrices: number;
  priceRecords: number;
}

export interface CoverageDashboard {
  totalVenues: number;
  venuesWithAtLeastOneVerifiedPrice: number;
  venuesWithThreePlusVerifiedPrices: number;
  venuesWithHappyHourData: number;
  venuesWithStaleData: number;
  venuesWithNoData: number;
  averagePriceRecordAgeDays: number;
  disputedRecords: number;
  coverageBySuburb: CoverageBySuburb[];
}

export type PartnerLeadConfidence =
  | "admin_verified"
  | "venue_confirmed"
  | "photo_verified"
  | "community_confirmed"
  | "user_reported_pending"
  | "stale"
  | "disputed"
  | "missing";

export interface PotentialPartnerLeadInput {
  staleBefore: string;
  limit: number;
}

export interface PotentialPartnerLead {
  venueId: string;
  venueName: string;
  suburb: string;
  mapViews: number;
  venueClicks: number;
  searchesNearby: number;
  requests: number;
  dataFreshness: "fresh" | "stale_or_missing";
  currentConfidence: PartnerLeadConfidence;
  suggestedReason: "users requested this" | "popular happy hour or beer interest" | "missing data" | "high demand";
}

export type AdminAnalyticsRepositoryErrorCode =
  | "invalid_input"
  | "malformed_record"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<AdminAnalyticsRepositoryErrorCode, string>> = {
  invalid_input: "The admin-analytics persistence input is invalid.",
  malformed_record: "Stored admin-analytics data is malformed.",
  persistence_failure: "Admin analytics could not be loaded.",
};

/** Stable, secret-free failures for service and HTTP error mapping. */
export class AdminAnalyticsRepositoryError extends Error {
  readonly code: AdminAnalyticsRepositoryErrorCode;

  constructor(code: AdminAnalyticsRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AdminAnalyticsRepositoryError";
    this.code = code;
  }
}

type RawRow = Record<string, unknown>;

interface KpiMetricRow extends RawRow {
  totalUsers: unknown;
  newUsers: unknown;
  weeklyActiveUsers: unknown;
  monthlyActiveUsers: unknown;
  returningUsers: unknown;
  freeUsers: unknown;
  paidUsers: unknown;
  contributorUnlockedUsers: unknown;
  subscriptionConversionCount: unknown;
  totalVenueSearches: unknown;
  totalBeerSearches: unknown;
  totalVenueDetailViews: unknown;
  totalFreePreviewViews: unknown;
  totalMapFilterUses: unknown;
  totalNearMeUses: unknown;
  totalHappyHourNearMeUses: unknown;
  totalDistanceSortUses: unknown;
  totalSubmissionStarts: unknown;
  totalSubmissionCompletions: unknown;
  totalPendingSubmissions: unknown;
  totalApprovedSubmissions: unknown;
  totalRejectedSubmissions: unknown;
  totalContributorPointsAwarded: unknown;
  venuesWithVerifiedData: unknown;
  venuesWithStaleData: unknown;
  activeMissions: unknown;
  potentialPartnerLeadCount: unknown;
  yearlyPaidUsers: unknown;
  usersTried: unknown;
  returnedThirtyDays: unknown;
  usersSubmitted: unknown;
  verifiedPricesAdded: unknown;
}

interface BucketRow extends RawRow {
  key: unknown;
  count: unknown;
}

interface LabeledBucketRow extends BucketRow {
  label: unknown;
}

interface RetentionRow extends RawRow {
  cohort: unknown;
  users: unknown;
  returned7: unknown;
  returned30: unknown;
}

interface CoverageMetricRow extends RawRow {
  venuesWithVerified: unknown;
  venuesWithThreePlusVerified: unknown;
  venuesWithHappyHour: unknown;
  venuesWithStale: unknown;
  averageAgeDays: unknown;
  disputedRecords: unknown;
  invalidHappyHourBooleans: unknown;
}

interface CoverageSuburbRow extends RawRow {
  suburb: unknown;
  venuesWithPrices: unknown;
  priceRecords: unknown;
}

interface PotentialPartnerLeadRow extends RawRow {
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  mapViews: unknown;
  venueClicks: unknown;
  searchesNearby: unknown;
  requests: unknown;
  lastVerifiedAt: unknown;
  confidence: unknown;
}

interface DecodedPotentialPartnerLeadRow {
  venueId: string;
  venueName: string;
  suburb: string;
  mapViews: number;
  venueClicks: number;
  searchesNearby: number;
  requests: number;
  lastVerifiedAt: string | null;
  confidence: PartnerLeadConfidence;
}

function fail(code: AdminAnalyticsRepositoryErrorCode): never {
  throw new AdminAnalyticsRepositoryError(code);
}

function inputTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return fail("invalid_input");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return fail("invalid_input");
  return value;
}

function optionalInputTimestamp(value: unknown): string | null {
  return value === null ? null : inputTimestamp(value);
}

function inputSafeInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function inputLimit(value: unknown, maximum: number): number {
  const parsed = inputSafeInteger(value, maximum);
  if (parsed < 1) return fail("invalid_input");
  return parsed;
}

function recordText(value: unknown, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function recordTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return fail("malformed_record");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return fail("malformed_record");
  return value;
}

function optionalRecordTimestamp(value: unknown): string | null {
  return value === null ? null : recordTimestamp(value);
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  const text = String(value);
  if (!/^\d+$/.test(text)) return fail("malformed_record");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail("malformed_record");
  return parsed;
}

function safeFiniteNumber(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  const text = String(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return fail("malformed_record");
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return fail("malformed_record");
  return parsed;
}

function booleanBinding(database: SqlDatabase, value: boolean): boolean | number {
  return database.dialect === "postgres" ? value : value ? 1 : 0;
}

function bucket(row: BucketRow): AdminAnalyticsBucket {
  return { key: recordText(row.key), count: safeCount(row.count) };
}

function labeledBucket(row: LabeledBucketRow): AdminAnalyticsLabeledBucket {
  return { key: recordText(row.key), label: recordText(row.label), count: safeCount(row.count) };
}

function partnerLeadConfidence(value: unknown): PartnerLeadConfidence {
  if (typeof value !== "string" || !PARTNER_LEAD_CONFIDENCES.has(value)) return fail("malformed_record");
  return value as PartnerLeadConfidence;
}

function normalizePartnerLeadKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Async, read-only persistence boundary for aggregate admin analytics.
 * Authorization, privacy-threshold suppression, provider I/O, assignments,
 * outreach, and public-feed publication remain outside this repository.
 */
export class AdminAnalyticsRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AdminAnalyticsRepositoryError) throw error;
      throw new AdminAnalyticsRepositoryError("persistence_failure");
    }
  }

  private metadataVenueName(expression: string): string {
    const extracted = this.database.dialect === "postgres"
      ? `(${expression} ->> 'venueName')`
      : `json_extract(${expression}, '$.venueName')`;
    return this.collatedText(extracted);
  }

  private collatedText(expression: string): string {
    return this.database.dialect === "postgres"
      ? `(${expression}) COLLATE "C"`
      : `(${expression}) COLLATE BINARY`;
  }

  private venueLabelExpression(keyExpression: string, metadataExpression = "NULL"): string {
    return `COALESCE(
      NULLIF(${metadataExpression}, ''),
      (SELECT profile.name FROM venue_profiles profile WHERE profile.venue_id = ${keyExpression} LIMIT 1),
      (SELECT location.venue_name FROM venue_location_cache location WHERE location.venue_id = ${keyExpression} LIMIT 1),
      (SELECT record.venue_name FROM venue_price_records record WHERE record.venue_id = ${keyExpression}
        ORDER BY record.last_verified_at DESC, record.id ASC LIMIT 1),
      (SELECT request.venue_name FROM venue_requests request WHERE request.venue_id = ${keyExpression}
        ORDER BY request.created_at DESC, request.id ASC LIMIT 1),
      (SELECT mission.venue_name FROM missions mission WHERE mission.venue_id = ${keyExpression}
        ORDER BY mission.updated_at DESC, mission.id ASC LIMIT 1),
      ${keyExpression}
    )`;
  }

  private async requireStringVenueNameMetadata(input: {
    eventTypes?: readonly string[];
    since?: string | null;
  } = {}): Promise<void> {
    const jsonType = this.database.dialect === "postgres"
      ? "jsonb_typeof(metadata_json -> 'venueName')"
      : "json_type(metadata_json, '$.venueName')";
    const stringType = this.database.dialect === "postgres" ? "string" : "text";
    const eventTypes = input.eventTypes ?? [];
    const eventTypeClause = eventTypes.length
      ? `AND event_type IN (${eventTypes.map(() => "?").join(", ")})`
      : "";
    const rangeClause = input.since ? "AND created_at >= ?" : "";
    const row = await this.database.prepare(
      `SELECT count(*) AS "count"
         FROM events
        WHERE venue_id IS NOT NULL
          AND venue_id != ''
          ${eventTypeClause}
          ${rangeClause}
          AND ${jsonType} IS NOT NULL
          AND ${jsonType} NOT IN ('${stringType}', 'null')`,
    ).get<{ count: unknown }>(
      ...eventTypes,
      ...(input.since ? [input.since] : []),
    );
    if (!row || safeCount(row.count) !== 0) return fail("malformed_record");
  }

  async countKnownVenues(): Promise<number> {
    return this.guarded(async () => {
      const row = await this.database.prepare(
        `SELECT count(DISTINCT venue_id) AS "count"
           FROM (
             SELECT venue_id FROM missions WHERE venue_id IS NOT NULL AND venue_id != ''
             UNION ALL
             SELECT venue_id FROM venue_price_records WHERE venue_id IS NOT NULL AND venue_id != ''
             UNION ALL
             SELECT venue_id FROM events WHERE venue_id IS NOT NULL AND venue_id != ''
             UNION ALL
             SELECT venue_id FROM venue_requests WHERE venue_id IS NOT NULL AND venue_id != ''
             UNION ALL
             SELECT venue_id FROM venue_profiles WHERE venue_id IS NOT NULL AND venue_id != ''
           ) known_venues`,
      ).get<{ count: unknown }>();
      if (!row) return fail("malformed_record");
      return safeCount(row.count);
    });
  }

  async getAnalyticsPreview(): Promise<AdminAnalyticsPreview> {
    return this.guarded(async () => {
      const venueEventTypes = [
        "map_pin_click",
        "venue_card_viewed",
        "venue_detail_opened",
        "venue_lookup",
      ] as const;
      await this.requireStringVenueNameMetadata({ eventTypes: venueEventTypes });
      const topSearchedBeers = await this.topEventGroup(["beer_search_performed"], "beer_id", null, 10);
      const topClickedVenues = await this.topVenueEventGroup(venueEventTypes, null, 10);
      const topSuburbs = await this.topEventGroup([
          "search_performed",
          "beer_search_performed",
          "venue_card_viewed",
          "venue_detail_opened",
          "map_filter_used",
          "submission_completed",
        ], "suburb", null, 10);
      const missionRow = await this.database.prepare(
        "SELECT count(*) AS \"count\" FROM events WHERE event_type = 'submission_completed'",
      ).get<{ count: unknown }>();
      if (!missionRow) return fail("malformed_record");
      return {
        topSearchedBeers,
        topClickedVenues,
        topSuburbs,
        missionConversionCount: safeCount(missionRow.count),
      };
    });
  }

  async getAdminKpiDashboard(input: AdminKpiDashboardInput): Promise<AdminKpiDashboard> {
    return this.guarded(async () => {
      const since = optionalInputTimestamp(input.since);
      const sevenDaysAgo = inputTimestamp(input.sevenDaysAgo);
      const thirtyDaysAgo = inputTimestamp(input.thirtyDaysAgo);
      const staleBefore = inputTimestamp(input.staleBefore);
      const totalVenues = inputSafeInteger(input.totalVenues, MAX_TOTAL_VENUES);
      const active = booleanBinding(this.database, true);
      await this.requireStringVenueNameMetadata({
        eventTypes: [
          "map_pin_click",
          "venue_card_viewed",
          "venue_detail_opened",
          "venue_lookup",
          "free_preview_viewed",
          "price_view_revealed",
        ],
        since,
      });
      const returnedThirtyDaysCondition = this.database.dialect === "postgres"
        ? "e.created_at > a.created_at AND e.created_at <= a.created_at + INTERVAL '30 days'"
        : "julianday(e.created_at) > julianday(a.created_at) AND julianday(e.created_at) <= julianday(a.created_at) + 30";
      const returningCondition = this.database.dialect === "postgres"
        ? "e.created_at > a.created_at"
        : "julianday(e.created_at) > julianday(a.created_at)";
      const accountRangeCondition = since === null ? "1 = 1" : "created_at >= @since";
      const eventRangeCondition = since === null ? "1 = 1" : "created_at >= @since";
      const returningRangeCondition = since === null ? "1 = 1" : "e.created_at >= @since";
      const reviewedRangeCondition = since === null ? "1 = 1" : "reviewed_at >= @since";
      const contributionRangeCondition = since === null ? "1 = 1" : "created_at >= @since";

      const metricRow = await this.database.prepare(
        `WITH account_metrics AS (
           SELECT count(*) AS "totalUsers",
                  count(CASE WHEN ${accountRangeCondition} THEN 1 END) AS "newUsers",
                  count(CASE WHEN subscription_status = 'free' THEN 1 END) AS "freeUsers",
                  count(CASE WHEN subscription_status IN ('premium_monthly', 'premium_yearly') THEN 1 END) AS "paidUsers",
                  count(CASE WHEN subscription_status = 'contributor_unlocked' THEN 1 END) AS "contributorUnlockedUsers",
                  count(CASE WHEN subscription_status = 'premium_yearly' THEN 1 END) AS "yearlyPaidUsers"
             FROM accounts
         ), event_metrics AS (
           SELECT count(DISTINCT CASE WHEN user_id IS NOT NULL AND created_at >= @sevenDaysAgo THEN user_id END) AS "weeklyActiveUsers",
                  count(DISTINCT CASE WHEN user_id IS NOT NULL AND created_at >= @thirtyDaysAgo THEN user_id END) AS "monthlyActiveUsers",
                  count(CASE WHEN event_type = 'subscription_created' AND ${eventRangeCondition} THEN 1 END) AS "subscriptionConversionCount",
                  count(CASE WHEN event_type IN ('search_performed', 'suburb_search_performed') AND ${eventRangeCondition} THEN 1 END) AS "totalVenueSearches",
                  count(CASE WHEN event_type = 'beer_search_performed' AND ${eventRangeCondition} THEN 1 END) AS "totalBeerSearches",
                  count(CASE WHEN event_type IN ('map_pin_click', 'venue_card_viewed', 'venue_detail_opened', 'venue_lookup') AND ${eventRangeCondition} THEN 1 END) AS "totalVenueDetailViews",
                  count(CASE WHEN event_type IN ('free_preview_viewed', 'price_view_revealed') AND ${eventRangeCondition} THEN 1 END) AS "totalFreePreviewViews",
                  count(CASE WHEN event_type IN (
                    'map_filter_used', 'cheapest_sort_used', 'happy_hour_active_now_used',
                    'happy_hour_near_me_used', 'distance_sort_used', 'verified_only_filter_used',
                    'under_10_filter_used', 'near_me_enabled', 'radius_filter_changed'
                  ) AND ${eventRangeCondition} THEN 1 END) AS "totalMapFilterUses",
                  count(CASE WHEN event_type = 'near_me_enabled' AND ${eventRangeCondition} THEN 1 END) AS "totalNearMeUses",
                  count(CASE WHEN event_type = 'happy_hour_near_me_used' AND ${eventRangeCondition} THEN 1 END) AS "totalHappyHourNearMeUses",
                  count(CASE WHEN event_type = 'distance_sort_used' AND ${eventRangeCondition} THEN 1 END) AS "totalDistanceSortUses",
                  count(CASE WHEN event_type = 'submission_started' AND ${eventRangeCondition} THEN 1 END) AS "totalSubmissionStarts",
                  count(CASE WHEN event_type = 'submission_completed' AND ${eventRangeCondition} THEN 1 END) AS "totalSubmissionCompletions",
                  count(DISTINCT CASE WHEN venue_id IS NOT NULL AND event_type IN (
                    'map_pin_click', 'venue_detail_opened', 'venue_card_viewed', 'venue_lookup'
                  ) THEN venue_id END) AS "potentialPartnerLeadCount",
                  count(DISTINCT COALESCE(user_id, anonymous_session_id)) AS "usersTried"
             FROM events
         ), returning_metrics AS (
           SELECT count(DISTINCT CASE WHEN ${returningCondition}
                                      AND ${returningRangeCondition}
                                      THEN e.user_id END) AS "returningUsers",
                  count(DISTINCT CASE WHEN ${returnedThirtyDaysCondition}
                                      AND e.event_type IN (
                                        'search_performed', 'beer_search_performed', 'venue_detail_opened',
                                        'free_preview_viewed', 'price_view_revealed', 'submission_completed',
                                        'mission_opened', 'map_filter_used'
                                      ) THEN a.id END) AS "returnedThirtyDays"
             FROM accounts a
             LEFT JOIN events e ON e.user_id = a.id
         ), submission_metrics AS (
           SELECT count(CASE WHEN status = 'pending' THEN 1 END) AS "totalPendingSubmissions",
                  count(CASE WHEN status = 'approved' AND ${reviewedRangeCondition} THEN 1 END) AS "totalApprovedSubmissions",
                  count(CASE WHEN status IN ('rejected', 'fraud_flagged') AND ${reviewedRangeCondition} THEN 1 END) AS "totalRejectedSubmissions",
                  count(DISTINCT user_id) AS "usersSubmitted"
             FROM submissions
         ), price_metrics AS (
           SELECT count(DISTINCT CASE WHEN confidence IN (
                    'admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed'
                  ) THEN venue_id END) AS "venuesWithVerifiedData",
                  count(DISTINCT CASE WHEN last_verified_at < @staleBefore OR confidence IN ('stale', 'disputed')
                                      THEN venue_id END) AS "venuesWithStaleData",
                  count(CASE WHEN confidence IN (
                    'admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed'
                  ) THEN 1 END) AS "verifiedPricesAdded"
             FROM venue_price_records
         ), contribution_metrics AS (
           SELECT COALESCE(sum(CASE WHEN ${contributionRangeCondition} THEN points ELSE 0 END), 0)
                    AS "totalContributorPointsAwarded"
             FROM contribution_ledger
         ), mission_metrics AS (
           SELECT count(CASE WHEN active = @active THEN 1 END) AS "activeMissions"
             FROM missions
         )
         SELECT account_metrics.*, event_metrics.*, returning_metrics.*,
                submission_metrics.*, price_metrics.*, contribution_metrics.*, mission_metrics.*
           FROM account_metrics
           CROSS JOIN event_metrics
           CROSS JOIN returning_metrics
           CROSS JOIN submission_metrics
           CROSS JOIN price_metrics
           CROSS JOIN contribution_metrics
           CROSS JOIN mission_metrics`,
      ).get<KpiMetricRow>({
        ...(since === null ? {} : { since }),
        sevenDaysAgo,
        thirtyDaysAgo,
        staleBefore,
        active,
      });

      const topSearchedBeers = await this.topEventGroup(
        ["beer_search_performed"],
        "beer_id",
        since,
        8,
      );
      const topSearchedSuburbs = await this.topEventGroup(
        ["search_performed", "suburb_search_performed", "beer_search_performed"],
        "suburb",
        since,
        8,
      );
      const topClickedVenues = await this.topVenueEventGroup(
        ["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"],
        since,
        8,
      );
      const topVenuesNeedingData = await this.topVenuesNeedingData(active);
      const highDemandVenuesWithStaleOrMissingData = await this.highDemandMissing(since, staleBefore);
      if (!metricRow) return fail("malformed_record");

      const totalUsers = safeCount(metricRow.totalUsers);
      const newUsers = safeCount(metricRow.newUsers);
      const subscriptionConversionCount = safeCount(metricRow.subscriptionConversionCount);
      const totalApprovedSubmissions = safeCount(metricRow.totalApprovedSubmissions);
      const totalRejectedSubmissions = safeCount(metricRow.totalRejectedSubmissions);
      const totalReviewed = totalApprovedSubmissions + totalRejectedSubmissions;
      if (!Number.isSafeInteger(totalReviewed)) return fail("malformed_record");
      const venuesWithVerifiedData = safeCount(metricRow.venuesWithVerifiedData);

      const metrics: AdminKpiMetrics = {
        totalUsers,
        newUsers,
        weeklyActiveUsers: safeCount(metricRow.weeklyActiveUsers),
        monthlyActiveUsers: safeCount(metricRow.monthlyActiveUsers),
        returningUsers: safeCount(metricRow.returningUsers),
        freeUsers: safeCount(metricRow.freeUsers),
        paidUsers: safeCount(metricRow.paidUsers),
        contributorUnlockedUsers: safeCount(metricRow.contributorUnlockedUsers),
        subscriptionConversionCount,
        subscriptionConversionRate: newUsers > 0
          ? subscriptionConversionCount / newUsers
          : totalUsers > 0 ? subscriptionConversionCount / totalUsers : 0,
        totalVenueSearches: safeCount(metricRow.totalVenueSearches),
        totalBeerSearches: safeCount(metricRow.totalBeerSearches),
        totalVenueDetailViews: safeCount(metricRow.totalVenueDetailViews),
        totalFreePreviewViews: safeCount(metricRow.totalFreePreviewViews),
        totalMapFilterUses: safeCount(metricRow.totalMapFilterUses),
        totalNearMeUses: safeCount(metricRow.totalNearMeUses),
        totalHappyHourNearMeUses: safeCount(metricRow.totalHappyHourNearMeUses),
        totalDistanceSortUses: safeCount(metricRow.totalDistanceSortUses),
        totalSubmissionStarts: safeCount(metricRow.totalSubmissionStarts),
        totalSubmissionCompletions: safeCount(metricRow.totalSubmissionCompletions),
        totalPendingSubmissions: safeCount(metricRow.totalPendingSubmissions),
        totalApprovedSubmissions,
        totalRejectedSubmissions,
        submissionApprovalRate: totalReviewed > 0 ? totalApprovedSubmissions / totalReviewed : 0,
        totalContributorPointsAwarded: safeFiniteNumber(metricRow.totalContributorPointsAwarded),
        contributorAccessEarnedUsers: safeCount(metricRow.contributorUnlockedUsers),
        venuesWithVerifiedData,
        venuesWithStaleData: safeCount(metricRow.venuesWithStaleData),
        venuesWithNoBeerPriceData: Math.max(0, totalVenues - venuesWithVerifiedData),
        activeMissions: safeCount(metricRow.activeMissions),
        missionCompletionCount: safeCount(metricRow.totalSubmissionCompletions),
        potentialPartnerLeadCount: safeCount(metricRow.potentialPartnerLeadCount),
        yearlyPaidUsers: safeCount(metricRow.yearlyPaidUsers),
        usersTried: safeCount(metricRow.usersTried),
        returnedThirtyDays: safeCount(metricRow.returnedThirtyDays),
        usersSubmitted: safeCount(metricRow.usersSubmitted),
        verifiedPricesAdded: safeCount(metricRow.verifiedPricesAdded),
      };

      const scorecard = [
        { label: "100 users tried the app", current: metrics.usersTried, target: 100 },
        { label: "30 users returned within 30 days", current: metrics.returnedThirtyDays, target: 30 },
        { label: "20 users submitted data", current: metrics.usersSubmitted, target: 20 },
        { label: "100 verified prices added", current: metrics.verifiedPricesAdded, target: 100 },
        { label: "10 users paid for yearly access", current: metrics.yearlyPaidUsers, target: 10 },
        { label: "3 venues flagged as potential partner leads", current: metrics.potentialPartnerLeadCount, target: 3 },
      ].map<AdminScorecardItem>((item) => ({
        ...item,
        progress: item.target > 0 ? Math.min(1, item.current / item.target) : 0,
        status: item.current <= 0 ? "not started" : item.current >= item.target ? "hit" : "in progress",
      }));

      return {
        metrics,
        scorecard,
        topSearchedBeers,
        topSearchedSuburbs,
        topClickedVenues,
        topVenuesNeedingData,
        highDemandVenuesWithStaleOrMissingData,
      };
    });
  }

  private async topEventGroup(
    eventTypes: readonly string[],
    column: "beer_id" | "suburb",
    since: string | null,
    limit: number,
  ): Promise<AdminAnalyticsBucket[]> {
    const placeholders = eventTypes.map(() => "?").join(", ");
    const rangeClause = since === null ? "" : "AND created_at >= ?";
    const groupedColumn = this.collatedText(column);
    const rows = await this.database.prepare(
      `SELECT ${groupedColumn} AS "key", count(*) AS "count"
         FROM events
        WHERE event_type IN (${placeholders})
          AND ${column} IS NOT NULL
          AND ${column} != ''
          ${rangeClause}
        GROUP BY ${groupedColumn}
        ORDER BY count(*) DESC, ${groupedColumn} ASC
        LIMIT ?`,
    ).all<BucketRow>(...eventTypes, ...(since === null ? [] : [since]), limit);
    return rows.map(bucket);
  }

  private async topVenueEventGroup(
    eventTypes: readonly string[],
    since: string | null,
    limit: number,
  ): Promise<AdminAnalyticsLabeledBucket[]> {
    const placeholders = eventTypes.map(() => "?").join(", ");
    const metadataLabel = this.metadataVenueName("metadata_json");
    const rangeClause = since === null ? "" : "AND created_at >= ?";
    const venueKey = this.collatedText("venue_id");
    const rows = await this.database.prepare(
      `WITH grouped AS (
         SELECT ${venueKey} AS "key",
                count(*) AS "count",
                max(${metadataLabel}) AS metadata_label
           FROM events
          WHERE event_type IN (${placeholders})
            AND venue_id IS NOT NULL
            AND venue_id != ''
            ${rangeClause}
          GROUP BY ${venueKey}
          ORDER BY count(*) DESC, ${venueKey} ASC
          LIMIT ?
       )
       SELECT key AS "key", count AS "count",
              ${this.venueLabelExpression("key", "metadata_label")} AS "label"
         FROM grouped
        ORDER BY count DESC, key ASC`,
    ).all<LabeledBucketRow>(...eventTypes, ...(since === null ? [] : [since]), limit);
    return rows.map(labeledBucket);
  }

  private async topVenuesNeedingData(active: boolean | number): Promise<AdminAnalyticsBucket[]> {
    const pointsExpression = this.database.dialect === "postgres"
      ? "CAST(trunc(points * multiplier) AS bigint)"
      : "CAST(points * multiplier AS INTEGER)";
    const rows = await this.database.prepare(
      `SELECT venue_name AS "key", ${pointsExpression} AS "count"
         FROM missions
        WHERE active = ?
        ORDER BY (points * multiplier) DESC, updated_at DESC, id ASC
        LIMIT 8`,
    ).all<BucketRow>(active);
    return rows.map(bucket);
  }

  private async highDemandMissing(
    since: string | null,
    staleBefore: string,
  ): Promise<AdminAnalyticsLabeledBucket[]> {
    const metadataLabel = this.metadataVenueName("e.metadata_json");
    const rangeClause = since === null ? "" : "AND e.created_at >= ?";
    const venueKey = this.collatedText("e.venue_id");
    const rows = await this.database.prepare(
      `WITH grouped AS (
         SELECT ${venueKey} AS "key",
                count(*) AS "count",
                max(${metadataLabel}) AS metadata_label
           FROM events e
          WHERE e.event_type IN ('venue_card_viewed', 'venue_detail_opened', 'free_preview_viewed', 'price_view_revealed')
            AND e.venue_id IS NOT NULL
            AND e.venue_id != ''
            ${rangeClause}
          GROUP BY ${venueKey}
       ), stale AS (
         SELECT grouped.*,
                (SELECT max(record.last_verified_at)
                   FROM venue_price_records record
                  WHERE record.venue_id = grouped.key) AS latest_verified_at
           FROM grouped
       )
       SELECT key AS "key", count AS "count",
              ${this.venueLabelExpression("key", "metadata_label")} AS "label"
         FROM stale
        WHERE latest_verified_at IS NULL OR latest_verified_at < ?
        ORDER BY count DESC, key ASC
        LIMIT 8`,
    ).all<LabeledBucketRow>(...(since === null ? [] : [since]), staleBefore);
    return rows.map(labeledBucket);
  }

  private retentionBucketExpression(column: string, groupBy: "week" | "month"): string {
    if (this.database.dialect === "sqlite") {
      return groupBy === "week"
        ? `strftime('%Y-W%W', ${column})`
        : `strftime('%Y-%m', ${column})`;
    }
    const utc = `timezone('UTC', ${column})`;
    if (groupBy === "month") return `to_char(${utc}, 'YYYY-MM')`;
    const dayOfYear = `(EXTRACT(DOY FROM ${utc})::integer - 1)`;
    const firstMondayOffset = `mod(8 - EXTRACT(ISODOW FROM date_trunc('year', ${utc}))::integer, 7)`;
    const week = `(CASE WHEN ${dayOfYear} < ${firstMondayOffset} THEN 0
      ELSE 1 + ((${dayOfYear} - ${firstMondayOffset}) / 7) END)`;
    return `(EXTRACT(YEAR FROM ${utc})::integer::text || '-W' || lpad(${week}::text, 2, '0'))`;
  }

  async getRetentionCohorts(input: RetentionCohortInput): Promise<RetentionCohort[]> {
    return this.guarded(async () => {
      if (input.groupBy !== "week" && input.groupBy !== "month") return fail("invalid_input");
      const limit = inputLimit(input.limit, MAX_RETENTION_COHORTS);
      const bucketExpression = this.retentionBucketExpression("created_at", input.groupBy);
      const withinSeven = this.database.dialect === "postgres"
        ? "e.created_at > cohort_accounts.created_at AND e.created_at <= cohort_accounts.created_at + INTERVAL '7 days'"
        : "julianday(e.created_at) > julianday(cohort_accounts.created_at) AND julianday(e.created_at) <= julianday(cohort_accounts.created_at) + 7";
      const withinThirty = this.database.dialect === "postgres"
        ? "e.created_at > cohort_accounts.created_at AND e.created_at <= cohort_accounts.created_at + INTERVAL '30 days'"
        : "julianday(e.created_at) > julianday(cohort_accounts.created_at) AND julianday(e.created_at) <= julianday(cohort_accounts.created_at) + 30";
      const rows = await this.database.prepare(
        `WITH cohort_accounts AS (
           SELECT id, created_at, ${bucketExpression} AS cohort
             FROM accounts
         ), limited_cohorts AS (
           SELECT cohort, count(*) AS users
             FROM cohort_accounts
            GROUP BY cohort
            ORDER BY cohort DESC
            LIMIT ?
         )
         SELECT limited_cohorts.cohort AS "cohort",
                limited_cohorts.users AS "users",
                count(DISTINCT CASE WHEN ${withinSeven} THEN cohort_accounts.id END) AS "returned7",
                count(DISTINCT CASE WHEN ${withinThirty} THEN cohort_accounts.id END) AS "returned30"
           FROM limited_cohorts
           JOIN cohort_accounts ON cohort_accounts.cohort = limited_cohorts.cohort
           LEFT JOIN events e
             ON e.user_id = cohort_accounts.id
            AND e.event_type IN (
              'search_performed', 'beer_search_performed', 'venue_detail_opened',
              'free_preview_viewed', 'price_view_revealed', 'submission_completed',
              'mission_opened', 'map_filter_used'
            )
          GROUP BY limited_cohorts.cohort, limited_cohorts.users
          ORDER BY limited_cohorts.cohort DESC`,
      ).all<RetentionRow>(limit);

      const pattern = input.groupBy === "week" ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/;
      return rows.map((row) => {
        const cohort = recordText(row.cohort, 8);
        if (!pattern.test(cohort)) return fail("malformed_record");
        const users = safeCount(row.users);
        const returned7 = safeCount(row.returned7);
        const returned30 = safeCount(row.returned30);
        if (returned7 > returned30 || returned30 > users) return fail("malformed_record");
        return {
          cohort,
          users,
          returned7,
          returned30,
          retention7: users > 0 ? returned7 / users : 0,
          retention30: users > 0 ? returned30 / users : 0,
        };
      });
    });
  }

  async getCoverageDashboard(input: CoverageDashboardInput): Promise<CoverageDashboard> {
    return this.guarded(async () => {
      const staleBefore = inputTimestamp(input.staleBefore);
      const asOf = inputTimestamp(input.asOf);
      const totalVenues = inputSafeInteger(input.totalVenues, MAX_TOTAL_VENUES);
      const happyHour = booleanBinding(this.database, true);
      const averageAgeExpression = this.database.dialect === "postgres"
        ? "avg(EXTRACT(EPOCH FROM (CAST(@asOf AS timestamptz) - last_verified_at)) / 86400.0)"
        : "avg(julianday(@asOf) - julianday(last_verified_at))";
      const invalidBooleanExpression = this.database.dialect === "postgres"
        ? "0"
        : "count(CASE WHEN is_happy_hour_price NOT IN (0, 1) THEN 1 END)";
      const coverageSuburb = this.collatedText("COALESCE(suburb, 'Melbourne')");

      const [metricRow, suburbRows] = await Promise.all([
        this.database.prepare(
          `SELECT count(DISTINCT CASE WHEN confidence IN (
                    'admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed'
                  ) THEN venue_id END) AS "venuesWithVerified",
                  (SELECT count(*) FROM (
                    SELECT venue_id
                      FROM venue_price_records
                     WHERE confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')
                     GROUP BY venue_id
                    HAVING count(*) >= 3
                  ) verified_three) AS "venuesWithThreePlusVerified",
                  count(DISTINCT CASE WHEN is_happy_hour_price = @happyHour OR happy_hour_details IS NOT NULL
                                      THEN venue_id END) AS "venuesWithHappyHour",
                  count(DISTINCT CASE WHEN last_verified_at < @staleBefore OR confidence IN ('stale', 'disputed')
                                      THEN venue_id END) AS "venuesWithStale",
                  ${averageAgeExpression} AS "averageAgeDays",
                  count(CASE WHEN confidence = 'disputed' THEN 1 END) AS "disputedRecords",
                  ${invalidBooleanExpression} AS "invalidHappyHourBooleans"
             FROM venue_price_records`,
        ).get<CoverageMetricRow>({ happyHour, staleBefore, asOf }),
        this.database.prepare(
          `SELECT ${coverageSuburb} AS "suburb",
                  count(DISTINCT venue_id) AS "venuesWithPrices",
                  count(*) AS "priceRecords"
             FROM venue_price_records
            GROUP BY ${coverageSuburb}
            ORDER BY count(DISTINCT venue_id) DESC, ${coverageSuburb} ASC
            LIMIT 20`,
        ).all<CoverageSuburbRow>(),
      ]);
      if (!metricRow) return fail("malformed_record");
      if (safeCount(metricRow.invalidHappyHourBooleans) !== 0) return fail("malformed_record");
      const venuesWithVerified = safeCount(metricRow.venuesWithVerified);
      const averageAge = metricRow.averageAgeDays === null ? 0 : safeFiniteNumber(metricRow.averageAgeDays);

      return {
        totalVenues,
        venuesWithAtLeastOneVerifiedPrice: venuesWithVerified,
        venuesWithThreePlusVerifiedPrices: safeCount(metricRow.venuesWithThreePlusVerified),
        venuesWithHappyHourData: safeCount(metricRow.venuesWithHappyHour),
        venuesWithStaleData: safeCount(metricRow.venuesWithStale),
        venuesWithNoData: Math.max(0, totalVenues - venuesWithVerified),
        averagePriceRecordAgeDays: Math.round(averageAge * 10) / 10,
        disputedRecords: safeCount(metricRow.disputedRecords),
        coverageBySuburb: suburbRows.map((row) => ({
          suburb: recordText(row.suburb, 160),
          venuesWithPrices: safeCount(row.venuesWithPrices),
          priceRecords: safeCount(row.priceRecords),
        })),
      };
    });
  }

  async getPotentialPartnerLeads(input: PotentialPartnerLeadInput): Promise<PotentialPartnerLead[]> {
    return this.guarded(async () => {
      const staleBefore = inputTimestamp(input.staleBefore);
      const limit = inputLimit(input.limit, MAX_PARTNER_LEADS);
      const queryLimit = limit * 4;
      await this.requireStringVenueNameMetadata();
      const metadataVenueName = this.metadataVenueName("e.metadata_json");
      const eventVenueId = this.collatedText("e.venue_id");
      const priceVenueName = this.collatedText("r.venue_name");
      const requestVenueName = this.collatedText("req.venue_name");
      const eventSuburb = this.collatedText("e.suburb");
      const priceSuburb = this.collatedText("r.suburb");
      const priceConfidence = this.collatedText("r.confidence");
      const rows = await this.database.prepare(
        `WITH request_counts AS (
           SELECT COALESCE(venue_id, venue_name) AS request_key,
                  max(venue_name) AS venue_name,
                  count(*) AS request_count
             FROM venue_requests
            GROUP BY COALESCE(venue_id, venue_name)
         ), aggregated AS (
           SELECT ${eventVenueId} AS "venueId",
                  COALESCE(max(${metadataVenueName}), max(${priceVenueName}), max(${requestVenueName}), ${eventVenueId}) AS "venueName",
                  COALESCE(max(${eventSuburb}), max(${priceSuburb}), 'Melbourne') AS "suburb",
                  count(CASE WHEN e.event_type = 'map_viewed' THEN 1 END) AS "mapViews",
                  count(CASE WHEN e.event_type IN ('venue_card_viewed', 'venue_detail_opened') THEN 1 END) AS "venueClicks",
                  count(CASE WHEN e.event_type IN ('beer_search_performed', 'happy_hour_active_now_used') THEN 1 END) AS "searchesNearby",
                  COALESCE(max(req.request_count), 0) AS "requests",
                  max(r.last_verified_at) AS "lastVerifiedAt",
                  COALESCE(max(${priceConfidence}), 'missing') AS "confidence"
             FROM events e
             LEFT JOIN venue_price_records r ON r.venue_id = e.venue_id
             LEFT JOIN request_counts req ON req.request_key = e.venue_id
            WHERE e.venue_id IS NOT NULL AND e.venue_id != ''
            GROUP BY ${eventVenueId}
         )
         SELECT *
           FROM aggregated
          ORDER BY ("venueClicks" + "searchesNearby" + "requests") DESC, "venueId" ASC
          LIMIT ?`,
      ).all<PotentialPartnerLeadRow>(queryLimit);

      const decodedRows = rows.map<DecodedPotentialPartnerLeadRow>((row) => ({
        venueId: recordText(row.venueId, 200),
        venueName: recordText(row.venueName, 180),
        suburb: recordText(row.suburb, 160),
        mapViews: safeCount(row.mapViews),
        venueClicks: safeCount(row.venueClicks),
        searchesNearby: safeCount(row.searchesNearby),
        requests: safeCount(row.requests),
        lastVerifiedAt: optionalRecordTimestamp(row.lastVerifiedAt),
        confidence: partnerLeadConfidence(row.confidence),
      }));

      const mergedRows = new Map<string, DecodedPotentialPartnerLeadRow>();
      for (const row of decodedRows) {
        const hasHumanReadableName = normalizePartnerLeadKeyPart(row.venueName)
          !== normalizePartnerLeadKeyPart(row.venueId);
        const key = hasHumanReadableName
          ? `${normalizePartnerLeadKeyPart(row.venueName)}|${normalizePartnerLeadKeyPart(row.suburb)}`
          : `id:${row.venueId}`;
        const existing = mergedRows.get(key);
        if (!existing) {
          mergedRows.set(key, { ...row });
          continue;
        }
        existing.mapViews += row.mapViews;
        existing.venueClicks += row.venueClicks;
        existing.searchesNearby += row.searchesNearby;
        existing.requests += row.requests;
        if (
          !Number.isSafeInteger(existing.mapViews)
          || !Number.isSafeInteger(existing.venueClicks)
          || !Number.isSafeInteger(existing.searchesNearby)
          || !Number.isSafeInteger(existing.requests)
        ) return fail("malformed_record");
        if (!existing.lastVerifiedAt || row.lastVerifiedAt && row.lastVerifiedAt > existing.lastVerifiedAt) {
          existing.lastVerifiedAt = row.lastVerifiedAt;
        }
        if (existing.confidence !== "disputed" && row.confidence === "disputed") {
          existing.confidence = "disputed";
        } else if (existing.confidence === "missing" && row.confidence !== "missing") {
          existing.confidence = row.confidence;
        }
      }

      return [...mergedRows.values()]
        .sort((left, right) => {
          const scoreDifference = (right.venueClicks + right.searchesNearby + right.requests)
            - (left.venueClicks + left.searchesNearby + left.requests);
          return scoreDifference
            || compareUtf8(left.venueName, right.venueName)
            || compareUtf8(left.suburb, right.suburb)
            || compareUtf8(left.venueId, right.venueId);
        })
        .slice(0, limit)
        .map((row) => {
          const stale = !row.lastVerifiedAt
            || row.lastVerifiedAt < staleBefore
            || row.confidence === "disputed";
          const suggestedReason = row.requests > 0
            ? "users requested this" as const
            : row.searchesNearby > row.venueClicks
              ? "popular happy hour or beer interest" as const
              : stale
                ? "missing data" as const
                : "high demand" as const;
          return {
            venueId: row.venueId,
            venueName: row.venueName,
            suburb: row.suburb,
            mapViews: row.mapViews,
            venueClicks: row.venueClicks,
            searchesNearby: row.searchesNearby,
            requests: row.requests,
            dataFreshness: stale ? "stale_or_missing" as const : "fresh" as const,
            currentConfidence: row.confidence,
            suggestedReason,
          };
        });
    });
  }
}
