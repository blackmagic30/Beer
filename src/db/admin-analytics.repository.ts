import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RETENTION_COHORTS = 24;
const MAX_PARTNER_LEADS = 100;
const MAX_TOTAL_VENUES = 10_000_000;
const MAX_CLIENT_REPORTED_USEFUL_RESULTS = 10_000;
const USEFUL_SEARCH_RESULT_THRESHOLD = 3;
const MAX_TEXT_LENGTH = 500;

const VERIFIED_CONFIDENCES = [
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
] as const;

const RETENTION_LOOP_EVENT_TYPES = [
  "account_dashboard_viewed",
  "map_viewed",
  "search_performed",
  "beer_search_performed",
  "suburb_search_performed",
  "venue_card_viewed",
  "venue_detail_opened",
  "free_preview_viewed",
  "price_view_revealed",
  "map_filter_used",
  "saved_venue_added",
  "saved_beer_added",
  "saved_suburb_added",
  "saved_night_plan_added",
  "tonight_plan_created",
  "submission_completed",
  "data_verified",
  "price_confirmation_answered",
  "wrong_price_reported",
  "mission_opened",
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
  asOf: string;
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
  searchUsefulness: ClientReportedSearchUsefulness;
  scorecard: AdminScorecardItem[];
  topSearchedBeers: AdminAnalyticsBucket[];
  topSearchedSuburbs: AdminAnalyticsBucket[];
  topClickedVenues: AdminAnalyticsLabeledBucket[];
  topVenuesNeedingData: AdminAnalyticsBucket[];
  highDemandVenuesWithStaleOrMissingData: AdminAnalyticsLabeledBucket[];
}

export interface ClientReportedSearchUsefulness {
  definition: "client_reported_search_usefulness_v1";
  evidenceStatus: "client_reported_non_formal";
  formalReleaseEvidence: false;
  population: "currently_opted_in_accounts_and_consented_anonymous_sessions";
  caveat: string;
  usefulResultThreshold: number;
  searchEventCount: number;
  measuredSearchCount: number;
  unmeasuredSearchCount: number;
  successfulSearchCount: number;
  successfulSearchRate: number | null;
  averageUsefulResultCount: number | null;
  inconsistentSuccessFlagCount: number;
  distribution: {
    zero: number;
    one: number;
    two: number;
    threeOrMore: number;
  };
}

export interface RetentionCohortInput {
  groupBy: "week" | "month";
  limit: number;
  asOf: string;
}

export interface RetentionCohort {
  cohort: string;
  users: number;
  eligibleUsers7: number;
  eligibleUsers30: number;
  returned7: number;
  returned30: number;
  retention7: number | null;
  retention30: number | null;
}

export type SavedUpdatesExperimentVariant = "control" | "treatment";

export interface SavedUpdatesExperimentInput {
  experimentVersion: string;
  asOf: string;
}

export interface SavedUpdatesExperimentVariantMetrics {
  variant: SavedUpdatesExperimentVariant;
  assignedAccounts: number;
  assignedShare: number | null;
  eligibleAtAssignmentAccounts: number;
  eligibilityRateAtAssignment: number | null;
  exposedAccounts: number;
  exposureRate: number | null;
  maturedAccounts7: number;
  maturityRate7: number | null;
  returnedAccounts7: number;
  retentionRate7: number | null;
}

export interface SavedUpdatesExperimentRollup {
  experimentVersion: string;
  observedD7RetentionDifference: number | null;
  variants: SavedUpdatesExperimentVariantMetrics[];
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

interface SearchUsefulnessRow extends RawRow {
  searchEventCount: unknown;
  measuredSearchCount: unknown;
  successfulSearchCount: unknown;
  averageUsefulResultCount: unknown;
  inconsistentSuccessFlagCount: unknown;
  zeroUsefulResults: unknown;
  oneUsefulResult: unknown;
  twoUsefulResults: unknown;
  threeOrMoreUsefulResults: unknown;
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
  eligibleUsers7: unknown;
  eligibleUsers30: unknown;
  returned7: unknown;
  returned30: unknown;
}

interface SavedUpdatesExperimentRow extends RawRow {
  variant: unknown;
  assignedAccounts: unknown;
  eligibleAtAssignmentAccounts: unknown;
  exposedAccounts: unknown;
  maturedAccounts7: unknown;
  returnedAccounts7: unknown;
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

function inputExperimentVersion(value: unknown): string {
  if (typeof value !== "string" || !/^v[1-9]\d{0,8}$/.test(value)) return fail("invalid_input");
  return value;
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

function savedUpdatesExperimentVariant(value: unknown): SavedUpdatesExperimentVariant {
  if (value !== "control" && value !== "treatment") return fail("malformed_record");
  return value;
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

  private privacyAnchorCtes(): string {
    const validBoolean = this.database.dialect === "postgres"
      ? "jsonb_typeof(activity.metadata_json -> 'optionalAnalyticsEnabled') = 'boolean'"
      : "json_type(activity.metadata_json, '$.optionalAnalyticsEnabled') IN ('true', 'false')";
    const enabledValue = this.database.dialect === "postgres"
      ? "CAST(activity.metadata_json ->> 'optionalAnalyticsEnabled' AS boolean)"
      : "json_extract(activity.metadata_json, '$.optionalAnalyticsEnabled')";
    return `privacy_activity AS (
      SELECT activity.user_id, activity.created_at, ${enabledValue} AS analytics_enabled
        FROM user_activity_events activity
       WHERE activity.event_type = 'account_privacy_settings_updated'
         AND ${validBoolean}
    ), privacy_last_disabled AS (
      SELECT user_id, max(created_at) AS disabled_at
        FROM privacy_activity
       WHERE analytics_enabled = @analyticsDisabled
       GROUP BY user_id
    ), privacy_anchors AS (
      SELECT privacy.*,
             COALESCE((
               SELECT min(enabled.created_at)
                 FROM privacy_activity enabled
                WHERE enabled.user_id = privacy.user_id
                  AND enabled.analytics_enabled = @analyticsEnabled
                  AND (last_disabled.disabled_at IS NULL OR enabled.created_at > last_disabled.disabled_at)
             ), privacy.consented_at) AS analytics_opt_in_at
        FROM account_privacy_settings privacy
        LEFT JOIN privacy_last_disabled last_disabled ON last_disabled.user_id = privacy.user_id
    )`;
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

  private async getClientReportedSearchUsefulness(input: {
    since: string | null;
    asOf: string;
  }): Promise<ClientReportedSearchUsefulness> {
    const eventRangeCondition = input.since === null
      ? "1 = 1"
      : this.database.dialect === "postgres"
        ? "e.created_at >= CAST(@since AS timestamptz)"
        : "e.created_at >= @since";
    const eventObservedByAsOf = this.database.dialect === "postgres"
      ? "e.created_at <= CAST(@asOf AS timestamptz)"
      : "e.created_at <= @asOf";
    const usefulResultCount = this.database.dialect === "postgres"
      ? `CASE
           WHEN jsonb_typeof(metadata_json -> 'usefulResultCount') = 'number'
            AND (metadata_json ->> 'usefulResultCount') ~ '^(0|[1-9][0-9]*)$'
            AND CAST(metadata_json ->> 'usefulResultCount' AS numeric) <= @maximumUsefulResults
           THEN CAST(metadata_json ->> 'usefulResultCount' AS bigint)
           ELSE NULL
         END`
      : `CASE
           WHEN json_type(metadata_json, '$.usefulResultCount') = 'integer'
            AND json_extract(metadata_json, '$.usefulResultCount') >= 0
            AND json_extract(metadata_json, '$.usefulResultCount') <= @maximumUsefulResults
           THEN CAST(json_extract(metadata_json, '$.usefulResultCount') AS INTEGER)
           ELSE NULL
         END`;
    const reportedSuccessful = this.database.dialect === "postgres"
      ? `CASE
           WHEN jsonb_typeof(metadata_json -> 'searchSuccessful') = 'boolean'
           THEN CAST(metadata_json ->> 'searchSuccessful' AS boolean)
           ELSE NULL
         END`
      : `CASE
           WHEN json_type(metadata_json, '$.searchSuccessful') IN ('true', 'false')
           THEN json_extract(metadata_json, '$.searchSuccessful')
           ELSE NULL
         END`;
    const successFlagMismatch = this.database.dialect === "postgres"
      ? "reported_successful != (useful_result_count >= @usefulThreshold)"
      : `reported_successful != CASE
           WHEN useful_result_count >= @usefulThreshold THEN 1 ELSE 0
         END`;
    const analyticsEnabled = booleanBinding(this.database, true);
    const row = await this.database.prepare(
      `WITH ${this.privacyAnchorCtes()}, scoped_searches AS (
         SELECT e.metadata_json
           FROM events e
           LEFT JOIN privacy_anchors privacy ON privacy.user_id = e.user_id
          WHERE e.event_type IN ('search_performed', 'beer_search_performed')
            AND ${eventRangeCondition}
            AND ${eventObservedByAsOf}
            AND (
              (e.user_id IS NULL AND e.anonymous_session_id IS NOT NULL)
              OR (
                e.user_id IS NOT NULL
                AND privacy.optional_analytics_enabled = @analyticsEnabled
                AND privacy.analytics_opt_in_at IS NOT NULL
                AND privacy.analytics_opt_in_at <= e.created_at
              )
            )
       ), decoded_searches AS (
         SELECT ${usefulResultCount} AS useful_result_count,
                ${reportedSuccessful} AS reported_successful
           FROM scoped_searches
       ), measured_searches AS (
         SELECT useful_result_count, reported_successful
           FROM decoded_searches
          WHERE useful_result_count IS NOT NULL
            AND reported_successful IS NOT NULL
       )
       SELECT (SELECT count(*) FROM scoped_searches) AS "searchEventCount",
              count(*) AS "measuredSearchCount",
              count(CASE WHEN useful_result_count >= @usefulThreshold THEN 1 END)
                AS "successfulSearchCount",
              avg(useful_result_count) AS "averageUsefulResultCount",
              count(CASE WHEN ${successFlagMismatch} THEN 1 END)
                AS "inconsistentSuccessFlagCount",
              count(CASE WHEN useful_result_count = 0 THEN 1 END) AS "zeroUsefulResults",
              count(CASE WHEN useful_result_count = 1 THEN 1 END) AS "oneUsefulResult",
              count(CASE WHEN useful_result_count = 2 THEN 1 END) AS "twoUsefulResults",
              count(CASE WHEN useful_result_count >= @usefulThreshold THEN 1 END)
                AS "threeOrMoreUsefulResults"
         FROM measured_searches`,
    ).get<SearchUsefulnessRow>({
      ...(input.since === null ? {} : { since: input.since }),
      asOf: input.asOf,
      analyticsEnabled,
      analyticsDisabled: booleanBinding(this.database, false),
      maximumUsefulResults: MAX_CLIENT_REPORTED_USEFUL_RESULTS,
      usefulThreshold: USEFUL_SEARCH_RESULT_THRESHOLD,
    });
    if (!row) return fail("malformed_record");

    const searchEventCount = safeCount(row.searchEventCount);
    const measuredSearchCount = safeCount(row.measuredSearchCount);
    const successfulSearchCount = safeCount(row.successfulSearchCount);
    const inconsistentSuccessFlagCount = safeCount(row.inconsistentSuccessFlagCount);
    const distribution = {
      zero: safeCount(row.zeroUsefulResults),
      one: safeCount(row.oneUsefulResult),
      two: safeCount(row.twoUsefulResults),
      threeOrMore: safeCount(row.threeOrMoreUsefulResults),
    };
    const distributionCount = Object.values(distribution).reduce((total, count) => total + count, 0);
    const averageUsefulResultCount = row.averageUsefulResultCount === null
      ? null
      : safeFiniteNumber(row.averageUsefulResultCount);
    if (
      measuredSearchCount > searchEventCount
      || successfulSearchCount > measuredSearchCount
      || inconsistentSuccessFlagCount > measuredSearchCount
      || distributionCount !== measuredSearchCount
      || distribution.threeOrMore !== successfulSearchCount
      || (averageUsefulResultCount !== null && (
        averageUsefulResultCount < 0
        || averageUsefulResultCount > MAX_CLIENT_REPORTED_USEFUL_RESULTS
      ))
    ) return fail("malformed_record");

    return {
      definition: "client_reported_search_usefulness_v1",
      evidenceStatus: "client_reported_non_formal",
      formalReleaseEvidence: false,
      population: "currently_opted_in_accounts_and_consented_anonymous_sessions",
      caveat: "Client-reported visible-result counts from consented web sessions; useful-result consistency is server-checked, but this is directional product telemetry and not formal release evidence.",
      usefulResultThreshold: USEFUL_SEARCH_RESULT_THRESHOLD,
      searchEventCount,
      measuredSearchCount,
      unmeasuredSearchCount: searchEventCount - measuredSearchCount,
      successfulSearchCount,
      successfulSearchRate: measuredSearchCount > 0
        ? successfulSearchCount / measuredSearchCount
        : null,
      averageUsefulResultCount,
      inconsistentSuccessFlagCount,
      distribution,
    };
  }

  async getAdminKpiDashboard(input: AdminKpiDashboardInput): Promise<AdminKpiDashboard> {
    return this.guarded(async () => {
      const since = optionalInputTimestamp(input.since);
      const asOf = inputTimestamp(input.asOf);
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
      const searchUsefulness = await this.getClientReportedSearchUsefulness({ since, asOf });
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
        searchUsefulness,
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
      const asOf = inputTimestamp(input.asOf);
      const analyticsEnabled = booleanBinding(this.database, true);
      const analyticsDisabled = booleanBinding(this.database, false);
      // `consented_at` is a mutable legal-consent revision. Reconstruct the
      // current analytics opt-in episode from the existing privacy activity
      // audit, falling back to consented_at for legacy or failed audit writes.
      const analyticsOptInExpression = "privacy.analytics_opt_in_at";
      const cohortStartExpression = `CASE
        WHEN ${analyticsOptInExpression} > account.created_at THEN ${analyticsOptInExpression}
        ELSE account.created_at
      END`;
      const bucketExpression = this.retentionBucketExpression(cohortStartExpression, input.groupBy);
      const retentionEventTypes = RETENTION_LOOP_EVENT_TYPES
        .map((eventType) => `'${eventType}'`)
        .join(", ");
      const accountObservedByAsOf = this.database.dialect === "postgres"
        ? "account.created_at <= CAST(@asOf AS timestamptz)"
        : "account.created_at <= @asOf";
      const consentObservedByAsOf = this.database.dialect === "postgres"
        ? `${analyticsOptInExpression} <= CAST(@asOf AS timestamptz)`
        : `${analyticsOptInExpression} <= @asOf`;
      const eventObservedByAsOf = this.database.dialect === "postgres"
        ? "e.created_at <= CAST(@asOf AS timestamptz)"
        : "e.created_at <= @asOf";
      // A D1-D7 cohort is mature only after the whole seventh UTC calendar day
      // has elapsed. The same rule applies to D1-D30 and avoids partial-day
      // right-censoring when this query runs during the final observation day.
      const matureSeven = this.database.dialect === "postgres"
        ? `timezone('UTC', cohort_accounts.created_at)::date + 7
           < timezone('UTC', CAST(@asOf AS timestamptz))::date`
        : `date(cohort_accounts.created_at, '+7 days') < date(@asOf)`;
      const matureThirty = this.database.dialect === "postgres"
        ? `timezone('UTC', cohort_accounts.created_at)::date + 30
           < timezone('UTC', CAST(@asOf AS timestamptz))::date`
        : `date(cohort_accounts.created_at, '+30 days') < date(@asOf)`;
      const withinSeven = this.database.dialect === "postgres"
        ? `timezone('UTC', e.created_at)::date > timezone('UTC', cohort_accounts.created_at)::date
           AND timezone('UTC', e.created_at)::date <= timezone('UTC', cohort_accounts.created_at)::date + 7`
        : `date(e.created_at) > date(cohort_accounts.created_at)
           AND date(e.created_at) <= date(cohort_accounts.created_at, '+7 days')`;
      const withinThirty = this.database.dialect === "postgres"
        ? `timezone('UTC', e.created_at)::date > timezone('UTC', cohort_accounts.created_at)::date
           AND timezone('UTC', e.created_at)::date <= timezone('UTC', cohort_accounts.created_at)::date + 30`
        : `date(e.created_at) > date(cohort_accounts.created_at)
           AND date(e.created_at) <= date(cohort_accounts.created_at, '+30 days')`;
      const rows = await this.database.prepare(
        `WITH ${this.privacyAnchorCtes()}, cohort_accounts AS (
           SELECT account.id, ${cohortStartExpression} AS created_at, ${bucketExpression} AS cohort
             FROM accounts account
             JOIN privacy_anchors privacy
               ON privacy.user_id = account.id
              AND privacy.optional_analytics_enabled = @analyticsEnabled
            WHERE ${accountObservedByAsOf}
              AND ${analyticsOptInExpression} IS NOT NULL
              AND ${consentObservedByAsOf}
         ), limited_cohorts AS (
           SELECT cohort, count(*) AS users
             FROM cohort_accounts
            GROUP BY cohort
            ORDER BY cohort DESC
            LIMIT @limit
         )
         SELECT limited_cohorts.cohort AS "cohort",
                limited_cohorts.users AS "users",
                count(DISTINCT CASE WHEN ${matureSeven} THEN cohort_accounts.id END) AS "eligibleUsers7",
                count(DISTINCT CASE WHEN ${matureThirty} THEN cohort_accounts.id END) AS "eligibleUsers30",
                count(DISTINCT CASE WHEN ${matureSeven} AND ${withinSeven}
                                    THEN cohort_accounts.id END) AS "returned7",
                count(DISTINCT CASE WHEN ${matureThirty} AND ${withinThirty}
                                    THEN cohort_accounts.id END) AS "returned30"
           FROM limited_cohorts
           JOIN cohort_accounts ON cohort_accounts.cohort = limited_cohorts.cohort
           LEFT JOIN events e
             ON e.user_id = cohort_accounts.id
            AND e.event_type IN (${retentionEventTypes})
            AND ${eventObservedByAsOf}
          GROUP BY limited_cohorts.cohort, limited_cohorts.users
          ORDER BY limited_cohorts.cohort DESC`,
      ).all<RetentionRow>({ limit, asOf, analyticsEnabled, analyticsDisabled });

      const pattern = input.groupBy === "week" ? /^\d{4}-W\d{2}$/ : /^\d{4}-\d{2}$/;
      return rows.map((row) => {
        const cohort = recordText(row.cohort, 8);
        if (!pattern.test(cohort)) return fail("malformed_record");
        const users = safeCount(row.users);
        const eligibleUsers7 = safeCount(row.eligibleUsers7);
        const eligibleUsers30 = safeCount(row.eligibleUsers30);
        const returned7 = safeCount(row.returned7);
        const returned30 = safeCount(row.returned30);
        if (
          eligibleUsers7 > users ||
          eligibleUsers30 > eligibleUsers7 ||
          returned7 > eligibleUsers7 ||
          returned30 > eligibleUsers30
        ) return fail("malformed_record");
        return {
          cohort,
          users,
          eligibleUsers7,
          eligibleUsers30,
          returned7,
          returned30,
          retention7: eligibleUsers7 > 0 ? returned7 / eligibleUsers7 : null,
          retention30: eligibleUsers30 > 0 ? returned30 / eligibleUsers30 : null,
        };
      });
    });
  }

  async getSavedUpdatesExperimentRollup(
    input: SavedUpdatesExperimentInput,
  ): Promise<SavedUpdatesExperimentRollup> {
    return this.guarded(async () => {
      const experimentVersion = inputExperimentVersion(input.experimentVersion);
      const asOf = inputTimestamp(input.asOf);
      const analyticsEnabled = booleanBinding(this.database, true);
      const analyticsDisabled = booleanBinding(this.database, false);
      const versionType = this.database.dialect === "postgres"
        ? "jsonb_typeof(assignment.metadata_json -> 'savedUpdatesExperimentVersion') = 'string'"
        : "json_type(assignment.metadata_json, '$.savedUpdatesExperimentVersion') = 'text'";
      const variantType = this.database.dialect === "postgres"
        ? "jsonb_typeof(assignment.metadata_json -> 'savedUpdatesVariant') = 'string'"
        : "json_type(assignment.metadata_json, '$.savedUpdatesVariant') = 'text'";
      const assignmentVersion = this.database.dialect === "postgres"
        ? "assignment.metadata_json ->> 'savedUpdatesExperimentVersion'"
        : "json_extract(assignment.metadata_json, '$.savedUpdatesExperimentVersion')";
      const assignmentVariant = this.database.dialect === "postgres"
        ? "assignment.metadata_json ->> 'savedUpdatesVariant'"
        : "json_extract(assignment.metadata_json, '$.savedUpdatesVariant')";
      const assignmentRoleType = this.database.dialect === "postgres"
        ? "jsonb_typeof(assignment.metadata_json -> 'accountRole') = 'string'"
        : "json_type(assignment.metadata_json, '$.accountRole') = 'text'";
      const assignmentRole = this.database.dialect === "postgres"
        ? "assignment.metadata_json ->> 'accountRole'"
        : "json_extract(assignment.metadata_json, '$.accountRole')";
      const assignmentSubscriptionType = this.database.dialect === "postgres"
        ? "jsonb_typeof(assignment.metadata_json -> 'accountSubscriptionStatus') = 'string'"
        : "json_type(assignment.metadata_json, '$.accountSubscriptionStatus') = 'text'";
      const assignmentSubscription = this.database.dialect === "postgres"
        ? "assignment.metadata_json ->> 'accountSubscriptionStatus'"
        : "json_extract(assignment.metadata_json, '$.accountSubscriptionStatus')";
      const assignmentEligibilityType = this.database.dialect === "postgres"
        ? "jsonb_typeof(assignment.metadata_json -> 'savedUpdatesEligibleAtAssignment') = 'boolean'"
        : "json_type(assignment.metadata_json, '$.savedUpdatesEligibleAtAssignment') IN ('true', 'false')";
      const assignmentEligibility = this.database.dialect === "postgres"
        ? `CASE WHEN ${assignmentEligibilityType}
             THEN CAST(assignment.metadata_json ->> 'savedUpdatesEligibleAtAssignment' AS boolean)
             ELSE NULL END`
        : `CASE WHEN ${assignmentEligibilityType}
             THEN json_extract(assignment.metadata_json, '$.savedUpdatesEligibleAtAssignment')
             ELSE NULL END`;
      const exposureVersionType = this.database.dialect === "postgres"
        ? "jsonb_typeof(exposure.metadata_json -> 'savedUpdatesExperimentVersion') = 'string'"
        : "json_type(exposure.metadata_json, '$.savedUpdatesExperimentVersion') = 'text'";
      const exposureVariantType = this.database.dialect === "postgres"
        ? "jsonb_typeof(exposure.metadata_json -> 'savedUpdatesVariant') = 'string'"
        : "json_type(exposure.metadata_json, '$.savedUpdatesVariant') = 'text'";
      const exposureVersion = this.database.dialect === "postgres"
        ? "exposure.metadata_json ->> 'savedUpdatesExperimentVersion'"
        : "json_extract(exposure.metadata_json, '$.savedUpdatesExperimentVersion')";
      const exposureVariant = this.database.dialect === "postgres"
        ? "exposure.metadata_json ->> 'savedUpdatesVariant'"
        : "json_extract(exposure.metadata_json, '$.savedUpdatesVariant')";
      const observedByAsOf = (column: string) => this.database.dialect === "postgres"
        ? `${column} <= CAST(@asOf AS timestamptz)`
        : `${column} <= @asOf`;
      const matureSeven = this.database.dialect === "postgres"
        ? `timezone('UTC', assigned.assigned_at)::date + 7
           < timezone('UTC', CAST(@asOf AS timestamptz))::date`
        : "date(assigned.assigned_at, '+7 days') < date(@asOf)";
      const withinSeven = (eventTimestamp: string) => this.database.dialect === "postgres"
        ? `timezone('UTC', ${eventTimestamp})::date > timezone('UTC', assigned.assigned_at)::date
           AND timezone('UTC', ${eventTimestamp})::date <= timezone('UTC', assigned.assigned_at)::date + 7`
        : `date(${eventTimestamp}) > date(assigned.assigned_at)
           AND date(${eventTimestamp}) <= date(assigned.assigned_at, '+7 days')`;
      const exposureWithinSeven = this.database.dialect === "postgres"
        ? `exposure.created_at >= assigned.assigned_at
           AND timezone('UTC', exposure.created_at)::date >= timezone('UTC', assigned.assigned_at)::date
           AND timezone('UTC', exposure.created_at)::date <= timezone('UTC', assigned.assigned_at)::date + 7`
        : `exposure.created_at >= assigned.assigned_at
           AND date(exposure.created_at) >= date(assigned.assigned_at)
           AND date(exposure.created_at) <= date(assigned.assigned_at, '+7 days')`;
      const retentionEventTypes = RETENTION_LOOP_EVENT_TYPES
        .map((eventType) => `'${eventType}'`)
        .join(", ");
      const rows = await this.database.prepare(
        `WITH ${this.privacyAnchorCtes()}, assignment_candidates AS (
           SELECT assignment.user_id,
                  assignment.created_at AS assigned_at,
                  ${assignmentVariant} AS variant,
                  ${assignmentRole} AS account_role,
                  ${assignmentSubscription} AS account_subscription_status,
                  CASE WHEN ${assignmentEligibility} = @analyticsEnabled THEN 1 ELSE 0 END
                    AS eligible_at_assignment,
                  CASE WHEN ${variantType} THEN 1 ELSE 0 END AS variant_is_string,
                  CASE WHEN ${assignmentRoleType} THEN 1 ELSE 0 END AS account_role_is_string,
                  CASE WHEN ${assignmentSubscriptionType} THEN 1 ELSE 0 END AS subscription_is_string,
                  CASE WHEN ${assignmentEligibilityType} THEN 1 ELSE 0 END AS eligibility_is_boolean,
                  row_number() OVER (
                    PARTITION BY assignment.user_id
                    ORDER BY assignment.created_at ASC, assignment.id ASC
                  ) AS assignment_rank
             FROM events assignment
             JOIN privacy_anchors privacy
               ON privacy.user_id = assignment.user_id
              AND privacy.optional_analytics_enabled = @analyticsEnabled
            WHERE assignment.event_type = 'account_dashboard_viewed'
              AND privacy.analytics_opt_in_at IS NOT NULL
              AND assignment.created_at >= privacy.analytics_opt_in_at
              AND ${observedByAsOf("assignment.created_at")}
              AND ${versionType}
              AND ${assignmentVersion} = @experimentVersion
         ), assigned_accounts AS (
           SELECT candidate.user_id,
                  candidate.assigned_at,
                  candidate.variant,
                  candidate.eligible_at_assignment
             FROM assignment_candidates candidate
            WHERE candidate.assignment_rank = 1
              AND candidate.variant_is_string = 1
              AND candidate.variant IN ('control', 'treatment')
              AND candidate.account_role_is_string = 1
              AND candidate.account_role = 'user'
              AND candidate.subscription_is_string = 1
              AND candidate.account_subscription_status IN ('free', 'contributor_unlocked')
              AND candidate.eligibility_is_boolean = 1
         ), exposed_accounts AS (
           SELECT DISTINCT assigned.user_id
             FROM assigned_accounts assigned
             JOIN events exposure
               ON exposure.user_id = assigned.user_id
              AND exposure.event_type = 'saved_updates_viewed'
              AND ${observedByAsOf("exposure.created_at")}
              AND ${exposureWithinSeven}
              AND ${exposureVersionType}
              AND ${exposureVariantType}
              AND ${exposureVersion} = @experimentVersion
              AND ${exposureVariant} = 'treatment'
            WHERE assigned.variant = 'treatment'
         ), returned_accounts AS (
           SELECT DISTINCT assigned.user_id
             FROM assigned_accounts assigned
             JOIN events return_event
               ON return_event.user_id = assigned.user_id
              AND return_event.event_type IN (${retentionEventTypes})
              AND ${observedByAsOf("return_event.created_at")}
              AND ${withinSeven("return_event.created_at")}
         )
         SELECT assigned.variant AS "variant",
                count(*) AS "assignedAccounts",
                count(CASE WHEN assigned.eligible_at_assignment = 1 THEN 1 END)
                  AS "eligibleAtAssignmentAccounts",
                count(CASE WHEN exposed.user_id IS NOT NULL THEN 1 END) AS "exposedAccounts",
                count(CASE WHEN ${matureSeven} THEN 1 END) AS "maturedAccounts7",
                count(CASE WHEN ${matureSeven} AND returned.user_id IS NOT NULL THEN 1 END)
                  AS "returnedAccounts7"
           FROM assigned_accounts assigned
           LEFT JOIN exposed_accounts exposed ON exposed.user_id = assigned.user_id
           LEFT JOIN returned_accounts returned ON returned.user_id = assigned.user_id
          GROUP BY assigned.variant
          ORDER BY assigned.variant ASC`,
      ).all<SavedUpdatesExperimentRow>({
        experimentVersion,
        asOf,
        analyticsEnabled,
        analyticsDisabled,
      });

      const decoded = new Map<SavedUpdatesExperimentVariant, {
        assignedAccounts: number;
        eligibleAtAssignmentAccounts: number;
        exposedAccounts: number;
        maturedAccounts7: number;
        returnedAccounts7: number;
      }>();
      for (const row of rows) {
        const variant = savedUpdatesExperimentVariant(row.variant);
        if (decoded.has(variant)) return fail("malformed_record");
        const assignedAccounts = safeCount(row.assignedAccounts);
        const eligibleAtAssignmentAccounts = safeCount(row.eligibleAtAssignmentAccounts);
        const exposedAccounts = safeCount(row.exposedAccounts);
        const maturedAccounts7 = safeCount(row.maturedAccounts7);
        const returnedAccounts7 = safeCount(row.returnedAccounts7);
        if (
          eligibleAtAssignmentAccounts > assignedAccounts
          || exposedAccounts > assignedAccounts
          || maturedAccounts7 > assignedAccounts
          || returnedAccounts7 > maturedAccounts7
          || (variant === "control" && exposedAccounts !== 0)
        ) return fail("malformed_record");
        decoded.set(variant, {
          assignedAccounts,
          eligibleAtAssignmentAccounts,
          exposedAccounts,
          maturedAccounts7,
          returnedAccounts7,
        });
      }

      const variants = (["control", "treatment"] as const).map((variant) => ({
        variant,
        ...(decoded.get(variant) ?? {
          assignedAccounts: 0,
          eligibleAtAssignmentAccounts: 0,
          exposedAccounts: 0,
          maturedAccounts7: 0,
          returnedAccounts7: 0,
        }),
      }));
      const totalAssigned = variants.reduce((total, variant) => total + variant.assignedAccounts, 0);
      const variantMetrics = variants.map((variant) => ({
        ...variant,
        assignedShare: totalAssigned > 0 ? variant.assignedAccounts / totalAssigned : null,
        eligibilityRateAtAssignment: variant.assignedAccounts > 0
          ? variant.eligibleAtAssignmentAccounts / variant.assignedAccounts
          : null,
        exposureRate: variant.variant === "treatment" && variant.assignedAccounts > 0
          ? variant.exposedAccounts / variant.assignedAccounts
          : null,
        maturityRate7: variant.assignedAccounts > 0
          ? variant.maturedAccounts7 / variant.assignedAccounts
          : null,
        retentionRate7: variant.maturedAccounts7 > 0
          ? variant.returnedAccounts7 / variant.maturedAccounts7
          : null,
      }));
      const control = variantMetrics.find((variant) => variant.variant === "control")!;
      const treatment = variantMetrics.find((variant) => variant.variant === "treatment")!;
      return {
        experimentVersion,
        observedD7RetentionDifference: control.retentionRate7 !== null && treatment.retentionRate7 !== null
          ? treatment.retentionRate7 - control.retentionRate7
          : null,
        variants: variantMetrics,
      };
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
