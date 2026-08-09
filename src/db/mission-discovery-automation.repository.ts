import {
  MISSION_LIFECYCLE_LOCK_CONTRACT,
  missionLifecycleMissionLockKey,
  type MissionLifecycleMission,
  type MissionPriority,
  type MissionProgressStatus,
} from "./mission-lifecycle.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ID_LENGTH = 255;
const MAX_VENUE_NAME_LENGTH = 240;
const MAX_SUBURB_LENGTH = 160;
const MAX_REASON_LENGTH = 2_000;
const MAX_ADDRESS_LENGTH = 2_000;
const MAX_SEARCH_TERMS = 8;
const MAX_SEARCH_TERM_LENGTH = 100;
const MAX_SAVED_SUBURBS = 100;
const MAX_PAGE_SIZE = 200;
const MAX_CANDIDATE_PAGE_SIZE = 500;
const MAX_FEED_SCAN_ROWS = 5_000;
const MAX_CANDIDATE_SCAN_ROWS = 5_000;
const MAX_REPLACE_MISSIONS = 5_000;
const MAX_AUTOMATION_OWNER_SET = 10_000;
const MAX_MAINTENANCE_BATCH_SIZE = 500;
const MAX_BATCH_INSERT_ROWS = 200;
const MAX_POINTS = 1_000_000;
const MAX_MULTIPLIER = 100;
const DECIMAL_SCALE = 1_000_000;
const EARTH_MAX_DISTANCE_METERS = 50_000_000;

const AUTOMATION_WRITER_LOCK_KEY = "mission-discovery-automation:writer";

export const MISSION_DISCOVERY_AUTOMATION_LOCK_CONTRACT = Object.freeze({
  version: 1,
  writerKey: AUTOMATION_WRITER_LOCK_KEY,
  missionLifecycleVersion: MISSION_LIFECYCLE_LOCK_CONTRACT.version,
  order: "automation-writer-before-sorted-mission-lifecycle-keys-before-mission-rows-before-link-recheck-before-writes",
} as const);

export function missionDiscoveryAutomationWriterLockKey(): string {
  return AUTOMATION_WRITER_LOCK_KEY;
}

export type MissionFeedSort =
  | "points"
  | "saved"
  | "stale"
  | "no_data"
  | "missing_happy_hour"
  | "most_requested"
  | "high_demand"
  | "nearby";

export interface MissionDiscoveryFeedMission extends MissionLifecycleMission {
  venueAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  userProgress: MissionProgressStatus | null;
  reservationAcceptedAt: string | null;
}

export interface MissionDiscoveryFeedPage {
  missions: MissionDiscoveryFeedMission[];
  total: number;
}

export interface MissionFeedPageInput {
  userId?: string | null | undefined;
  suburb?: string | undefined;
  searchTerms: string[];
  savedSuburbs: string[];
  savedOnly: boolean;
  latitude?: number | undefined;
  longitude?: number | undefined;
  radiusMeters: number;
  sort: MissionFeedSort;
  limit: number;
  offset: number;
  acceptedAfter: string;
  veryFreshCutoff: string;
  weekOldCutoff: string;
  veryFreshPoints: number;
  weekOldPoints: number;
  stalePoints: number;
  newVenuePoints: number;
  excludeHappyHourMissions?: boolean | undefined;
}

export interface MissionVenueCandidate {
  venueId: string;
  venueName: string;
  suburb: string | null;
  latestVerifiedAt: string | null;
  recordCount: number;
  happyHourLastVerifiedAt: string | null;
}

export interface AutoMissionDefinition {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  reason: string;
  priority: MissionPriority;
  points: number;
  multiplier: number;
  active?: boolean | undefined;
  sponsorFlag?: boolean | undefined;
  lastVerifiedAt: string | null;
}

export interface MissionAutomationBatchResult {
  changed: number;
  hasMore: boolean;
}

export type MissionDiscoveryAutomationRepositoryErrorCode =
  | "invalid_input"
  | "malformed_record"
  | "owner_set_changed"
  | "owner_set_too_large"
  | "persistence_failure"
  | "timestamp_conflict";

const ERROR_MESSAGES: Readonly<Record<MissionDiscoveryAutomationRepositoryErrorCode, string>> = {
  invalid_input: "The mission discovery or automation input is invalid.",
  malformed_record: "Stored mission discovery or automation data is malformed.",
  owner_set_changed: "The automation mission set changed before it could be replaced.",
  owner_set_too_large: "The automation mission set exceeds the bounded maintenance limit.",
  persistence_failure: "Mission discovery or automation persistence could not be completed.",
  timestamp_conflict: "An automation timestamp is older than the mission state it would replace.",
};

/** Stable, secret-free failures for the future service/HTTP adapter. */
export class MissionDiscoveryAutomationRepositoryError extends Error {
  readonly code: MissionDiscoveryAutomationRepositoryErrorCode;

  constructor(code: MissionDiscoveryAutomationRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MissionDiscoveryAutomationRepositoryError";
    this.code = code;
  }
}

type RawRow = Record<string, unknown>;

interface MissionRow extends RawRow {
  id: unknown;
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  reason: unknown;
  priority: unknown;
  points: unknown;
  multiplier: unknown;
  active: unknown;
  sponsorFlag: unknown;
  lastVerifiedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface MissionFeedRow extends MissionRow {
  venueAddress: unknown;
  latitude: unknown;
  longitude: unknown;
  userProgress: unknown;
  reservationAcceptedAt: unknown;
  effectiveLastVerifiedAt: unknown;
  dynamicPoints: unknown;
  distanceMeters: unknown;
  total: unknown;
}

interface CandidateRow extends RawRow {
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  latestVerifiedAt: unknown;
  recordCount: unknown;
  happyHourLastVerifiedAt: unknown;
}

interface IdentifierRow extends RawRow {
  id: unknown;
}

interface LinkedMissionRow extends RawRow {
  missionId: unknown;
}

interface CountRow extends RawRow {
  present: unknown;
}

const MISSION_PROJECTION = `
  mission.id AS "id",
  mission.venue_id AS "venueId",
  mission.venue_name AS "venueName",
  mission.suburb AS "suburb",
  mission.reason AS "reason",
  mission.priority AS "priority",
  mission.points AS "points",
  mission.multiplier AS "multiplier",
  mission.active AS "active",
  mission.sponsor_flag AS "sponsorFlag",
  mission.last_verified_at AS "lastVerifiedAt",
  mission.created_at AS "createdAt",
  mission.updated_at AS "updatedAt"`;

function fail(code: MissionDiscoveryAutomationRepositoryErrorCode): never {
  throw new MissionDiscoveryAutomationRepositoryError(code);
}

function inputIdentifier(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\r\n\0]/.test(normalized)) {
    return fail("invalid_input");
  }
  return normalized;
}

function inputText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function inputOptionalText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function inputTimestamp(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_input");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return fail("invalid_input");
    }
  } catch {
    return fail("invalid_input");
  }
  return value;
}

function inputOptionalTimestamp(value: unknown): string | null {
  return value === null ? null : inputTimestamp(value);
}

function inputBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") return fail("invalid_input");
  return value;
}

function inputPriority(value: unknown): MissionPriority {
  if (value !== "low" && value !== "normal" && value !== "high") return fail("invalid_input");
  return value;
}

function inputDecimal(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  if (!Number.isSafeInteger(value * DECIMAL_SCALE)) return fail("invalid_input");
  return Object.is(value, -0) ? 0 : value;
}

function inputCoordinate(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return Object.is(value, -0) ? 0 : value;
}

function inputPageSize(value: unknown, maximum = MAX_PAGE_SIZE): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function inputOffset(value: unknown, limit: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("invalid_input");
  const end = value + limit;
  if (!Number.isSafeInteger(end) || end > maximum) return fail("invalid_input");
  return value;
}

function inputSort(value: unknown): MissionFeedSort {
  if (
    value !== "points"
    && value !== "saved"
    && value !== "stale"
    && value !== "no_data"
    && value !== "missing_happy_hour"
    && value !== "most_requested"
    && value !== "high_demand"
    && value !== "nearby"
  ) return fail("invalid_input");
  return value;
}

function recordIdentifier(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_ID_LENGTH
    || /[\r\n\0]/.test(value)
  ) return fail("malformed_record");
  return value;
}

function recordText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /\0/.test(value)
  ) return fail("malformed_record");
  return value;
}

function recordOptionalText(value: unknown, maximum: number): string | null {
  return value === null ? null : recordText(value, maximum);
}

function recordTimestamp(value: unknown): string {
  if (typeof value !== "string") return fail("malformed_record");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return fail("malformed_record");
    }
  } catch {
    return fail("malformed_record");
  }
  return value;
}

function recordOptionalTimestamp(value: unknown): string | null {
  return value === null ? null : recordTimestamp(value);
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function recordPriority(value: unknown): MissionPriority {
  if (value !== "low" && value !== "normal" && value !== "high") return fail("malformed_record");
  return value;
}

function recordProgressStatus(value: unknown): MissionProgressStatus | null {
  if (value === null) return null;
  if (
    value !== "accepted"
    && value !== "submitted"
    && value !== "completed"
    && value !== "needs_revision"
    && value !== "cancelled"
  ) return fail("malformed_record");
  return value;
}

function recordDecimal(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" && typeof value !== "string"
    || typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
  ) return fail("malformed_record");
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || parsed < minimum
    || parsed > maximum
    || !Number.isSafeInteger(parsed * DECIMAL_SCALE)
  ) return fail("malformed_record");
  return Object.is(parsed, -0) ? 0 : parsed;
}

function recordFiniteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fail("malformed_record");
  return Object.is(parsed, -0) ? 0 : parsed;
}

function recordOptionalFiniteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : recordFiniteNumber(value, minimum, maximum);
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  const text = String(value);
  if (!/^\d+$/.test(text)) return fail("malformed_record");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail("malformed_record");
  return parsed;
}

function missionRecord(row: MissionRow): MissionLifecycleMission {
  const createdAt = recordTimestamp(row.createdAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  if (updatedAt < createdAt) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id),
    venueId: recordIdentifier(row.venueId),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: recordOptionalText(row.suburb, MAX_SUBURB_LENGTH),
    reason: recordText(row.reason, MAX_REASON_LENGTH),
    priority: recordPriority(row.priority),
    points: recordDecimal(row.points, 0, MAX_POINTS),
    multiplier: recordDecimal(row.multiplier, 0, MAX_MULTIPLIER),
    active: recordBoolean(row.active),
    sponsorFlag: recordBoolean(row.sponsorFlag),
    lastVerifiedAt: recordOptionalTimestamp(row.lastVerifiedAt),
    createdAt,
    updatedAt,
  };
}

function feedMissionRecord(row: MissionFeedRow): MissionDiscoveryFeedMission {
  const mission = missionRecord({ ...row, points: row.dynamicPoints, lastVerifiedAt: row.effectiveLastVerifiedAt });
  if (!mission.active) return fail("malformed_record");
  const latitude = recordOptionalFiniteNumber(row.latitude, -90, 90);
  const longitude = recordOptionalFiniteNumber(row.longitude, -180, 180);
  if ((latitude === null) !== (longitude === null)) return fail("malformed_record");
  const distance = recordOptionalFiniteNumber(row.distanceMeters, 0, EARTH_MAX_DISTANCE_METERS);
  const userProgress = recordProgressStatus(row.userProgress);
  const acceptedAt = recordOptionalTimestamp(row.reservationAcceptedAt);
  if (userProgress !== null && acceptedAt === null) return fail("malformed_record");
  const distanceMeters = distance === null ? null : Math.round(distance);
  return {
    ...mission,
    venueAddress: recordOptionalText(row.venueAddress, MAX_ADDRESS_LENGTH),
    latitude,
    longitude,
    distanceMeters,
    distanceKm: distance === null ? null : Math.round((distance / 1_000) * 10) / 10,
    userProgress,
    reservationAcceptedAt: userProgress === "accepted" ? acceptedAt : null,
  };
}

function candidateRecord(row: CandidateRow): MissionVenueCandidate {
  return {
    venueId: recordIdentifier(row.venueId),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: recordOptionalText(row.suburb, MAX_SUBURB_LENGTH),
    latestVerifiedAt: recordOptionalTimestamp(row.latestVerifiedAt),
    recordCount: safeCount(row.recordCount),
    happyHourLastVerifiedAt: recordOptionalTimestamp(row.happyHourLastVerifiedAt),
  };
}

interface NormalizedAutoMissionDefinition {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  reason: string;
  priority: MissionPriority;
  points: number;
  multiplier: number;
  active: boolean;
  sponsorFlag: boolean;
  lastVerifiedAt: string | null;
}

function normalizedAutoMission(input: AutoMissionDefinition): NormalizedAutoMissionDefinition {
  const id = inputIdentifier(input.id);
  if (!id.startsWith("auto:")) return fail("invalid_input");
  return {
    id,
    venueId: inputIdentifier(input.venueId),
    venueName: inputText(input.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: inputOptionalText(input.suburb, MAX_SUBURB_LENGTH),
    reason: inputText(input.reason, MAX_REASON_LENGTH),
    priority: inputPriority(input.priority),
    points: inputDecimal(input.points, 0, MAX_POINTS),
    multiplier: inputDecimal(input.multiplier, 0, MAX_MULTIPLIER),
    active: inputBoolean(input.active, true),
    sponsorFlag: inputBoolean(input.sponsorFlag, false),
    lastVerifiedAt: inputOptionalTimestamp(input.lastVerifiedAt),
  };
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Async mission feed and automatic/demo mission persistence for the native
 * PostgreSQL runtime and SQLite rehearsal. All database mutations are short,
 * provider-free transactions. The automation writer key sorts before every
 * shared MissionLifecycle mission key; affected mission keys are acquired
 * before rows and link ownership is rechecked before any write.
 */
export class MissionDiscoveryAutomationRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MissionDiscoveryAutomationRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new MissionDiscoveryAutomationRepositoryError("owner_set_changed");
      throw new MissionDiscoveryAutomationRepositoryError("persistence_failure");
    }
  }

  private booleanValue(value: boolean): boolean | number {
    return this.database.dialect === "postgres" ? value : value ? 1 : 0;
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    const sorted = [...new Set(keys)].sort();
    if (!sorted.length) return;
    await this.database.prepare(
      `WITH ordered_keys AS MATERIALIZED (
         SELECT lock_key
           FROM unnest(?::text[]) AS locks(lock_key)
          ORDER BY lock_key ASC
       )
       SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(lock_key)) AS "locked"
         FROM ordered_keys
        ORDER BY lock_key ASC`,
    ).all(sorted);
  }

  private placeholders(
    prefix: string,
    values: readonly string[],
    bindings: Record<string, unknown>,
  ): string {
    return values.map((value, index) => {
      const name = `${prefix}${index}`;
      bindings[name] = value;
      return `@${name}`;
    }).join(", ");
  }

  private buildFeedSql(input: {
    searchTerms: readonly string[];
    savedSuburbs: readonly string[];
    savedOnly: boolean;
    sort: MissionFeedSort;
    hasLocation: boolean;
  }, bindings: Record<string, unknown>): string {
    const searchClauses = input.searchTerms.map((term, index) => {
      bindings[`search${index}`] = `%${term}%`;
      return `lower(mission.venue_name || ' ' || COALESCE(mission.suburb, '') || ' ' || COALESCE(profile.address, '') || ' ' || mission.reason) LIKE @search${index}`;
    });
    const savedClause = input.savedOnly
      ? `AND lower(COALESCE(mission.suburb, '')) IN (${input.savedSuburbs.map((suburb, index) => {
          bindings[`saved${index}`] = suburb;
          return `@saved${index}`;
        }).join(", ")})`
      : "";
    const haversineInner = `
      pow(sin(radians(latitude - @latitude) / 2), 2) +
      cos(radians(@latitude)) * cos(radians(latitude)) *
      pow(sin(radians(longitude - @longitude) / 2), 2)`;
    const clampedDistance = this.database.dialect === "postgres"
      ? `least(1::double precision, ${haversineInner})`
      : `min(1, ${haversineInner})`;
    const distanceExpression = `2 * 6371000 * asin(sqrt(${clampedDistance}))`;
    const staleOrder = this.database.dialect === "postgres"
      ? "effective_last_verified_at ASC NULLS FIRST, id ASC"
      : "COALESCE(effective_last_verified_at, '') ASC, id ASC";
    const orderBy = input.sort === "nearby" && input.hasLocation
      ? "distance_meters ASC, (dynamic_points * multiplier) DESC, updated_at DESC, id ASC"
      : input.sort === "stale"
        ? staleOrder
        : input.sort === "no_data"
          ? "CASE WHEN effective_last_verified_at IS NULL THEN 0 ELSE 1 END ASC, (dynamic_points * multiplier) DESC, id ASC"
          : input.sort === "missing_happy_hour"
            ? "CASE WHEN lower(reason) LIKE '%happy%' THEN 0 ELSE 1 END ASC, (dynamic_points * multiplier) DESC, id ASC"
            : "(dynamic_points * multiplier) DESC, updated_at DESC, id ASC";

    return `WITH price_freshness AS (
      SELECT record.venue_id, max(record.last_verified_at) AS latest_verified_at
        FROM venue_price_records record
       GROUP BY record.venue_id
    ), base AS (
      SELECT mission.*,
        profile.address AS venue_address,
        location.latitude,
        location.longitude,
        progress.status AS user_progress,
        progress.accepted_at AS reservation_accepted_at,
        CASE WHEN mission.id LIKE 'auto:%'
          THEN mission.last_verified_at
          ELSE COALESCE(price_freshness.latest_verified_at, mission.last_verified_at)
        END AS effective_last_verified_at
      FROM missions mission
      LEFT JOIN venue_profiles profile ON profile.venue_id = mission.venue_id
      LEFT JOIN venue_location_cache location ON location.venue_id = mission.venue_id
      LEFT JOIN price_freshness ON price_freshness.venue_id = mission.venue_id
      LEFT JOIN mission_progress progress
        ON progress.mission_id = mission.id AND progress.user_id = CAST(@userId AS TEXT)
      WHERE mission.active = @truth
        AND (
          CAST(@excludeHappyHourMissions AS BOOLEAN) = CAST(@falsity AS BOOLEAN)
          OR (
            lower(mission.reason) NOT LIKE '%happy%'
            AND (' ' || lower(replace(replace(mission.reason, '-', ' '), '_', ' ')) || ' ') NOT LIKE '% hh %'
          )
        )
        AND (CAST(@suburb AS TEXT) IS NULL
          OR lower(COALESCE(mission.suburb, '')) = lower(CAST(@suburb AS TEXT)))
        ${savedClause}
        ${searchClauses.length ? `AND ${searchClauses.join(" AND ")}` : ""}
        AND NOT EXISTS (
          SELECT 1 FROM mission_progress unavailable
          WHERE unavailable.mission_id = mission.id
            AND (
              unavailable.status = 'submitted'
              OR (unavailable.status = 'accepted' AND unavailable.accepted_at > @acceptedAfter)
            )
            AND (CAST(@userId AS TEXT) IS NULL
              OR unavailable.user_id <> CAST(@userId AS TEXT))
        )
    ), scored AS (
      SELECT base.*,
        CASE
          WHEN effective_last_verified_at IS NULL
            OR lower(reason) LIKE '%no data%'
            OR lower(reason) LIKE '%no prices%'
            OR lower(reason) LIKE '%new venue%'
            OR ((lower(reason) LIKE '%new%' OR lower(reason) LIKE '%missing%')
                AND (lower(reason) LIKE '%beer%' OR lower(reason) LIKE '%drink%' OR lower(reason) LIKE '%price%'))
            THEN CAST(@newVenuePoints AS NUMERIC)
          WHEN effective_last_verified_at >= @veryFreshCutoff THEN CAST(@veryFreshPoints AS NUMERIC)
          WHEN effective_last_verified_at >= @weekOldCutoff THEN CAST(@weekOldPoints AS NUMERIC)
          ELSE CAST(@stalePoints AS NUMERIC)
        END AS dynamic_points,
        CASE WHEN CAST(@latitude AS DOUBLE PRECISION) IS NOT NULL
          AND CAST(@longitude AS DOUBLE PRECISION) IS NOT NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          THEN ${distanceExpression}
          ELSE NULL
        END AS distance_meters
      FROM base
    ), eligible AS (
      SELECT * FROM scored
      WHERE CAST(@latitude AS DOUBLE PRECISION) IS NULL
        OR CAST(@longitude AS DOUBLE PRECISION) IS NULL
        OR (distance_meters IS NOT NULL
          AND distance_meters <= CAST(@radiusMeters AS DOUBLE PRECISION))
    ), total AS (
      SELECT count(*) AS total_count FROM eligible
    ), page AS (
      SELECT eligible.*, row_number() OVER (ORDER BY ${orderBy}) AS page_position
        FROM eligible
       ORDER BY ${orderBy}
       LIMIT @limit OFFSET @offset
    )
    SELECT
      page.id AS "id",
      page.venue_id AS "venueId",
      page.venue_name AS "venueName",
      page.suburb AS "suburb",
      page.reason AS "reason",
      page.priority AS "priority",
      page.points AS "points",
      page.multiplier AS "multiplier",
      page.active AS "active",
      page.sponsor_flag AS "sponsorFlag",
      page.last_verified_at AS "lastVerifiedAt",
      page.created_at AS "createdAt",
      page.updated_at AS "updatedAt",
      page.venue_address AS "venueAddress",
      page.latitude AS "latitude",
      page.longitude AS "longitude",
      page.user_progress AS "userProgress",
      page.reservation_accepted_at AS "reservationAcceptedAt",
      page.effective_last_verified_at AS "effectiveLastVerifiedAt",
      page.dynamic_points AS "dynamicPoints",
      page.distance_meters AS "distanceMeters",
      total.total_count AS "total"
    FROM total
    LEFT JOIN page ON 1 = 1
    ORDER BY page.page_position ASC`;
  }

  async listMissionFeedPage(input: MissionFeedPageInput): Promise<MissionDiscoveryFeedPage> {
    const userId = input.userId == null ? null : inputIdentifier(input.userId);
    const suburb = input.suburb === undefined ? null : inputText(input.suburb, MAX_SUBURB_LENGTH);
    if (!Array.isArray(input.searchTerms) || input.searchTerms.length > MAX_SEARCH_TERMS) return fail("invalid_input");
    if (!Array.isArray(input.savedSuburbs) || input.savedSuburbs.length > MAX_SAVED_SUBURBS) return fail("invalid_input");
    const searchTerms = input.searchTerms.map((term) => inputText(term, MAX_SEARCH_TERM_LENGTH).toLowerCase());
    const savedSuburbs = [...new Set(input.savedSuburbs.map((value) => inputText(value, MAX_SUBURB_LENGTH).toLowerCase()))];
    if (typeof input.savedOnly !== "boolean") return fail("invalid_input");
    const hasLatitude = input.latitude !== undefined;
    const hasLongitude = input.longitude !== undefined;
    if (hasLatitude !== hasLongitude) return fail("invalid_input");
    const latitude = hasLatitude ? inputCoordinate(input.latitude, -90, 90) : null;
    const longitude = hasLongitude ? inputCoordinate(input.longitude, -180, 180) : null;
    const radiusMeters = inputDecimal(input.radiusMeters, 100, 50_000);
    const sort = inputSort(input.sort);
    const limit = inputPageSize(input.limit);
    const offset = inputOffset(input.offset, limit, MAX_FEED_SCAN_ROWS);
    const acceptedAfter = inputTimestamp(input.acceptedAfter);
    const veryFreshCutoff = inputTimestamp(input.veryFreshCutoff);
    const weekOldCutoff = inputTimestamp(input.weekOldCutoff);
    if (veryFreshCutoff < weekOldCutoff) return fail("invalid_input");
    const veryFreshPoints = inputDecimal(input.veryFreshPoints, 0, MAX_POINTS);
    const weekOldPoints = inputDecimal(input.weekOldPoints, 0, MAX_POINTS);
    const stalePoints = inputDecimal(input.stalePoints, 0, MAX_POINTS);
    const newVenuePoints = inputDecimal(input.newVenuePoints, 0, MAX_POINTS);
    if (typeof input.excludeHappyHourMissions !== "undefined" && typeof input.excludeHappyHourMissions !== "boolean") {
      return fail("invalid_input");
    }
    if (input.savedOnly && savedSuburbs.length === 0) return { missions: [], total: 0 };

    return this.guarded(async () => {
      const bindings: Record<string, unknown> = {
        userId,
        suburb,
        acceptedAfter,
        latitude,
        longitude,
        radiusMeters,
        veryFreshCutoff,
        weekOldCutoff,
        veryFreshPoints,
        weekOldPoints,
        stalePoints,
        newVenuePoints,
        excludeHappyHourMissions: this.booleanValue(input.excludeHappyHourMissions === true),
        truth: this.booleanValue(true),
        falsity: this.booleanValue(false),
        limit,
        offset,
      };
      const sql = this.buildFeedSql({
        searchTerms,
        savedSuburbs,
        savedOnly: input.savedOnly,
        sort,
        hasLocation: latitude !== null,
      }, bindings);
      const rows = await this.database.prepare(sql).all<MissionFeedRow>(bindings);
      if (!rows.length) return fail("persistence_failure");
      const total = safeCount(rows[0]!.total);
      if (rows.some((row) => safeCount(row.total) !== total)) return fail("malformed_record");
      const dataRows = rows.filter((row) => row.id !== null);
      if (dataRows.length !== rows.length && !(rows.length === 1 && dataRows.length === 0)) {
        return fail("malformed_record");
      }
      const missions = dataRows.map(feedMissionRecord);
      if (missions.length > limit || missions.length > 0 && total < offset + missions.length) {
        return fail("malformed_record");
      }
      return { missions, total };
    });
  }

  private candidateSql(): string {
    const nameOrder = this.database.dialect === "postgres"
      ? `candidate_venue_name COLLATE "C" ASC`
      : "candidate_venue_name COLLATE BINARY ASC";
    return `WITH price_rollup AS (
      SELECT record.venue_id,
             record.venue_name,
             record.suburb,
             max(record.last_verified_at) OVER (PARTITION BY record.venue_id) AS latest_verified_at,
             count(*) OVER (PARTITION BY record.venue_id) AS record_count,
             max(CASE WHEN record.is_happy_hour_price = @truth
                       OR (record.happy_hour_details IS NOT NULL AND trim(record.happy_hour_details) <> '')
                      THEN record.last_verified_at ELSE NULL END)
               OVER (PARTITION BY record.venue_id) AS price_happy_hour_last_verified_at,
             row_number() OVER (
               PARTITION BY record.venue_id
               ORDER BY record.last_verified_at DESC, record.id ASC
             ) AS source_rank
        FROM venue_price_records record
       WHERE record.venue_id IS NOT NULL AND record.venue_id <> ''
    ), latest_price AS (
      SELECT * FROM price_rollup WHERE source_rank = 1
    ), request_ranked AS (
      SELECT request.venue_id, request.venue_name, request.suburb,
             row_number() OVER (
               PARTITION BY request.venue_id
               ORDER BY request.created_at DESC, request.id ASC
             ) AS source_rank
        FROM venue_requests request
       WHERE request.venue_id IS NOT NULL AND request.venue_id <> ''
    ), latest_request AS (
      SELECT * FROM request_ranked WHERE source_rank = 1
    ), manual_mission_ranked AS (
      SELECT mission.venue_id, mission.venue_name, mission.suburb,
             row_number() OVER (
               PARTITION BY mission.venue_id
               ORDER BY mission.updated_at DESC, mission.id ASC
             ) AS source_rank
        FROM missions mission
       WHERE mission.venue_id IS NOT NULL AND mission.venue_id <> ''
         AND mission.id NOT LIKE 'auto:%' AND mission.active = @truth
    ), latest_manual_mission AS (
      SELECT * FROM manual_mission_ranked WHERE source_rank = 1
    ), happy_hour_rollup AS (
      SELECT happy.venue_id, max(happy.updated_at) AS happy_hour_last_verified_at
        FROM venue_happy_hours happy
       WHERE happy.active = @truth
       GROUP BY happy.venue_id
    ), known_venue_ids AS (
      SELECT location.venue_id FROM venue_location_cache location
       WHERE location.venue_id IS NOT NULL AND location.venue_id <> ''
      UNION
      SELECT price.venue_id FROM latest_price price
      UNION
      SELECT profile.venue_id FROM venue_profiles profile
       WHERE profile.venue_id IS NOT NULL AND profile.venue_id <> '' AND profile.active = @truth
      UNION
      SELECT request.venue_id FROM latest_request request
      UNION
      SELECT mission.venue_id FROM latest_manual_mission mission
    ), candidates AS (
      SELECT ids.venue_id,
             COALESCE(profile.name, location.venue_name, price.venue_name,
                      request.venue_name, mission.venue_name, ids.venue_id) AS candidate_venue_name,
             COALESCE(profile.suburb, location.suburb, price.suburb,
                      request.suburb, mission.suburb) AS candidate_suburb,
             price.latest_verified_at,
             COALESCE(price.record_count, 0) AS record_count,
             CASE
               WHEN price.price_happy_hour_last_verified_at IS NULL THEN happy.happy_hour_last_verified_at
               WHEN happy.happy_hour_last_verified_at IS NULL THEN price.price_happy_hour_last_verified_at
               WHEN price.price_happy_hour_last_verified_at >= happy.happy_hour_last_verified_at
                 THEN price.price_happy_hour_last_verified_at
               ELSE happy.happy_hour_last_verified_at
             END AS candidate_happy_hour_last_verified_at
        FROM known_venue_ids ids
        LEFT JOIN venue_profiles profile
          ON profile.venue_id = ids.venue_id AND profile.active = @truth
        LEFT JOIN venue_location_cache location ON location.venue_id = ids.venue_id
        LEFT JOIN latest_price price ON price.venue_id = ids.venue_id
        LEFT JOIN latest_request request ON request.venue_id = ids.venue_id
        LEFT JOIN latest_manual_mission mission ON mission.venue_id = ids.venue_id
        LEFT JOIN happy_hour_rollup happy ON happy.venue_id = ids.venue_id
    )
    SELECT venue_id AS "venueId",
           candidate_venue_name AS "venueName",
           candidate_suburb AS "suburb",
           latest_verified_at AS "latestVerifiedAt",
           record_count AS "recordCount",
           candidate_happy_hour_last_verified_at AS "happyHourLastVerifiedAt"
      FROM candidates
     ORDER BY latest_verified_at IS NOT NULL ASC,
              latest_verified_at ASC,
              ${nameOrder},
              venue_id ASC
     LIMIT @limit OFFSET @offset`;
  }

  async listMissionVenueCandidates(input: { limit: number; offset?: number | undefined }): Promise<MissionVenueCandidate[]> {
    const limit = inputPageSize(input.limit, MAX_CANDIDATE_PAGE_SIZE);
    const offset = inputOffset(input.offset ?? 0, limit, MAX_CANDIDATE_SCAN_ROWS);
    return this.guarded(async () => {
      const rows = await this.database.prepare(this.candidateSql()).all<CandidateRow>({
        truth: this.booleanValue(true),
        limit,
        offset,
      });
      return rows.map(candidateRecord);
    });
  }

  private async discoverAutoMissionIds(): Promise<string[]> {
    const rows = await this.database.prepare(
      `SELECT mission.id AS "id"
         FROM missions mission
        WHERE mission.id LIKE 'auto:%'
        ORDER BY mission.id ASC
        LIMIT ?`,
    ).all<IdentifierRow>(MAX_AUTOMATION_OWNER_SET + 1);
    if (rows.length > MAX_AUTOMATION_OWNER_SET) return fail("owner_set_too_large");
    return rows.map((row) => recordIdentifier(row.id));
  }

  private async missionRows(ids: readonly string[], lock = false): Promise<MissionLifecycleMission[]> {
    if (!ids.length) return [];
    const bindings: Record<string, unknown> = {};
    const inList = this.placeholders("mission", ids, bindings);
    const rows = await this.database.prepare(
      `SELECT ${MISSION_PROJECTION}
         FROM missions mission
        WHERE mission.id IN (${inList})
        ORDER BY mission.id ASC${lock ? this.lockSuffix("mission") : ""}`,
    ).all<MissionRow>(bindings);
    return rows.map(missionRecord);
  }

  private async linkedMissionIds(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const bindings: Record<string, unknown> = {};
    const inList = this.placeholders("linked", ids, bindings);
    const rows = await this.database.prepare(
      `SELECT linked.mission_id AS "missionId"
         FROM (
           SELECT progress.mission_id
             FROM mission_progress progress
            WHERE progress.mission_id IN (${inList})
           UNION
           SELECT submission.mission_id
             FROM submissions submission
            WHERE submission.mission_id IN (${inList})
           UNION
           SELECT request.mission_id
             FROM venue_requests request
            WHERE request.mission_id IN (${inList})
         ) linked
        WHERE linked.mission_id IS NOT NULL
        ORDER BY linked.mission_id ASC`,
    ).all<LinkedMissionRow>(bindings);
    return new Set(rows.map((row) => recordIdentifier(row.missionId)));
  }

  private requireCurrentTimestamp(now: string, missions: readonly MissionLifecycleMission[]): void {
    if (missions.some((mission) => now < mission.updatedAt || now < mission.createdAt)) {
      return fail("timestamp_conflict");
    }
  }

  private async deactivateMissionIds(ids: readonly string[], now: string): Promise<number> {
    if (!ids.length) return 0;
    const bindings: Record<string, unknown> = {
      active: this.booleanValue(false),
      now,
    };
    const inList = this.placeholders("deactivate", ids, bindings);
    const result = await this.database.prepare(
      `UPDATE missions
          SET active = @active, updated_at = @now
        WHERE id IN (${inList})
          AND NOT EXISTS (
            SELECT 1 FROM mission_progress progress WHERE progress.mission_id = missions.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM submissions submission WHERE submission.mission_id = missions.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM venue_requests request WHERE request.mission_id = missions.id
          )`,
    ).run(bindings);
    return result.changes;
  }

  private async upsertMissionBatch(
    definitions: ReadonlyArray<NormalizedAutoMissionDefinition & { createdAt: string; updatedAt: string }>,
  ): Promise<void> {
    for (let start = 0; start < definitions.length; start += MAX_BATCH_INSERT_ROWS) {
      const chunk = definitions.slice(start, start + MAX_BATCH_INSERT_ROWS);
      const bindings: Record<string, unknown> = {};
      const values = chunk.map((mission, index) => {
        const prefix = `row${index}`;
        Object.assign(bindings, {
          [`${prefix}Id`]: mission.id,
          [`${prefix}VenueId`]: mission.venueId,
          [`${prefix}VenueName`]: mission.venueName,
          [`${prefix}Suburb`]: mission.suburb,
          [`${prefix}Reason`]: mission.reason,
          [`${prefix}Priority`]: mission.priority,
          [`${prefix}Points`]: mission.points,
          [`${prefix}Multiplier`]: mission.multiplier,
          [`${prefix}Active`]: this.booleanValue(mission.active),
          [`${prefix}SponsorFlag`]: this.booleanValue(mission.sponsorFlag),
          [`${prefix}LastVerifiedAt`]: mission.lastVerifiedAt,
          [`${prefix}CreatedAt`]: mission.createdAt,
          [`${prefix}UpdatedAt`]: mission.updatedAt,
        });
        return `(
          @${prefix}Id, @${prefix}VenueId, @${prefix}VenueName, @${prefix}Suburb,
          @${prefix}Reason, @${prefix}Priority, @${prefix}Points, @${prefix}Multiplier,
          @${prefix}Active, @${prefix}SponsorFlag, @${prefix}LastVerifiedAt,
          @${prefix}CreatedAt, @${prefix}UpdatedAt
        )`;
      });
      await this.database.prepare(
        `INSERT INTO missions (
           id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
           active, sponsor_flag, last_verified_at, created_at, updated_at
         ) VALUES ${values.join(", ")}
         ON CONFLICT(id) DO UPDATE SET
           venue_id = excluded.venue_id,
           venue_name = excluded.venue_name,
           suburb = excluded.suburb,
           reason = excluded.reason,
           priority = excluded.priority,
           points = excluded.points,
           multiplier = excluded.multiplier,
           active = excluded.active,
           sponsor_flag = excluded.sponsor_flag,
           last_verified_at = excluded.last_verified_at,
           updated_at = excluded.updated_at`,
      ).run(bindings);
    }
  }

  async replaceAutoMissions(input: {
    missions: AutoMissionDefinition[];
    now: string;
  }): Promise<number> {
    if (!Array.isArray(input.missions) || input.missions.length > MAX_REPLACE_MISSIONS) {
      return fail("invalid_input");
    }
    const now = inputTimestamp(input.now);
    const definitions = input.missions.map(normalizedAutoMission);
    if (new Set(definitions.map((mission) => mission.id)).size !== definitions.length) return fail("invalid_input");

    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionDiscoveryAutomationWriterLockKey()]);
      const discoveredIds = await this.discoverAutoMissionIds();
      const ownerIds = [...new Set([...discoveredIds, ...definitions.map((mission) => mission.id)])].sort();
      if (ownerIds.length > MAX_AUTOMATION_OWNER_SET) return fail("owner_set_too_large");
      await this.advisoryLocks(ownerIds.map(missionLifecycleMissionLockKey));
      const lockedMissions = await this.missionRows(ownerIds, true);
      const recheckedIds = await this.discoverAutoMissionIds();
      if (!sameIdentifierSet(discoveredIds, recheckedIds)) return fail("owner_set_changed");
      const existingById = new Map(lockedMissions.map((mission) => [mission.id, mission]));
      const linkedIds = await this.linkedMissionIds(ownerIds);
      const desiredIds = new Set(definitions.map((mission) => mission.id));
      const stale = lockedMissions.filter((mission) =>
        mission.id.startsWith("auto:")
        && mission.active
        && !desiredIds.has(mission.id)
        && !linkedIds.has(mission.id),
      );
      const existingDesired = definitions.flatMap((mission) => {
        const existing = existingById.get(mission.id);
        return existing ? [existing] : [];
      });
      this.requireCurrentTimestamp(now, [...stale, ...existingDesired]);
      await this.deactivateMissionIds(stale.map((mission) => mission.id), now);

      const persistedDefinitions = definitions.map((mission) => {
        const existing = existingById.get(mission.id);
        const active = existing && linkedIds.has(mission.id) && !mission.active
          ? existing.active
          : mission.active;
        return { ...mission, active, createdAt: now, updatedAt: now };
      });
      await this.upsertMissionBatch(persistedDefinitions);

      const verified = await this.missionRows(definitions.map((mission) => mission.id));
      if (verified.length !== definitions.length) return fail("persistence_failure");
      const expectedById = new Map(persistedDefinitions.map((mission) => [mission.id, mission]));
      for (const mission of verified) {
        const expected = expectedById.get(mission.id);
        if (
          !expected
          || mission.venueId !== expected.venueId
          || mission.venueName !== expected.venueName
          || mission.suburb !== expected.suburb
          || mission.reason !== expected.reason
          || mission.priority !== expected.priority
          || mission.points !== expected.points
          || mission.multiplier !== expected.multiplier
          || mission.active !== expected.active
          || mission.sponsorFlag !== expected.sponsorFlag
          || mission.lastVerifiedAt !== expected.lastVerifiedAt
          || mission.updatedAt !== now
        ) return fail("persistence_failure");
      }
      return definitions.length;
    }));
  }

  private async discoverMaintenanceIds(input: {
    mode: "inactive_auto" | "active_demo";
    limit: number;
  }): Promise<string[]> {
    const condition = input.mode === "inactive_auto"
      ? "mission.id LIKE 'auto:%' AND mission.active = @falsity"
      : "mission.venue_id LIKE 'demo:%' AND mission.active = @truth";
    const rows = await this.database.prepare(
      `SELECT mission.id AS "id"
         FROM missions mission
        WHERE ${condition}
          AND NOT EXISTS (
            SELECT 1 FROM mission_progress progress WHERE progress.mission_id = mission.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM submissions submission WHERE submission.mission_id = mission.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM venue_requests request WHERE request.mission_id = mission.id
          )
        ORDER BY mission.id ASC
        LIMIT @limit`,
    ).all<IdentifierRow>({
      truth: this.booleanValue(true),
      falsity: this.booleanValue(false),
      limit: input.limit,
    });
    return rows.map((row) => recordIdentifier(row.id));
  }

  private async maintenanceHasMore(mode: "inactive_auto" | "active_demo"): Promise<boolean> {
    const condition = mode === "inactive_auto"
      ? "mission.id LIKE 'auto:%' AND mission.active = @falsity"
      : "mission.venue_id LIKE 'demo:%' AND mission.active = @truth";
    const row = await this.database.prepare(
      `SELECT 1 AS "present"
         FROM missions mission
        WHERE ${condition}
          AND NOT EXISTS (
            SELECT 1 FROM mission_progress progress WHERE progress.mission_id = mission.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM submissions submission WHERE submission.mission_id = mission.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM venue_requests request WHERE request.mission_id = mission.id
          )
        LIMIT 1`,
    ).get<CountRow>({ truth: this.booleanValue(true), falsity: this.booleanValue(false) });
    return row !== undefined;
  }

  async pruneInactiveAutoMissions(input: { limit: number }): Promise<MissionAutomationBatchResult> {
    const limit = inputPageSize(input.limit, MAX_MAINTENANCE_BATCH_SIZE);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionDiscoveryAutomationWriterLockKey()]);
      const ids = await this.discoverMaintenanceIds({ mode: "inactive_auto", limit });
      await this.advisoryLocks(ids.map(missionLifecycleMissionLockKey));
      const locked = await this.missionRows(ids, true);
      const linked = await this.linkedMissionIds(ids);
      const eligible = locked.filter((mission) =>
        mission.id.startsWith("auto:") && !mission.active && !linked.has(mission.id),
      );
      if (eligible.length) {
        const bindings: Record<string, unknown> = { falsity: this.booleanValue(false) };
        const inList = this.placeholders("prune", eligible.map((mission) => mission.id), bindings);
        await this.database.prepare(
          `DELETE FROM missions
            WHERE id IN (${inList}) AND active = @falsity
              AND NOT EXISTS (
                SELECT 1 FROM mission_progress progress WHERE progress.mission_id = missions.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM submissions submission WHERE submission.mission_id = missions.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM venue_requests request WHERE request.mission_id = missions.id
              )`,
        ).run(bindings);
      }
      return {
        changed: eligible.length,
        hasMore: await this.maintenanceHasMore("inactive_auto"),
      };
    }));
  }

  async deactivateDemoMissions(input: { now: string; limit: number }): Promise<MissionAutomationBatchResult> {
    const now = inputTimestamp(input.now);
    const limit = inputPageSize(input.limit, MAX_MAINTENANCE_BATCH_SIZE);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionDiscoveryAutomationWriterLockKey()]);
      const ids = await this.discoverMaintenanceIds({ mode: "active_demo", limit });
      await this.advisoryLocks(ids.map(missionLifecycleMissionLockKey));
      const locked = await this.missionRows(ids, true);
      const linked = await this.linkedMissionIds(ids);
      const eligible = locked.filter((mission) =>
        mission.active && mission.venueId.startsWith("demo:") && !linked.has(mission.id),
      );
      this.requireCurrentTimestamp(now, eligible);
      const changed = await this.deactivateMissionIds(eligible.map((mission) => mission.id), now);
      return {
        changed,
        hasMore: await this.maintenanceHasMore("active_demo"),
      };
    }));
  }
}
