import type {
  BusinessSubmission,
  PendingVenueDetails,
  PublicVenuePriceRecord,
  SubmissionOcrSummary,
} from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 4_000;
const MAX_JSON_LENGTH = 64_000;
const MAX_PRICE_RECORDS = 500;
const MAX_HAPPY_HOUR_DAYS = 7;
const MAX_HAPPY_HOUR_BEERS = 60;
const DETAIL_LIMIT = 25;
const TOP_BEER_LIMIT = 8;
const MISSING_BEER_LIMIT = 5;

const VERIFIED_CONFIDENCES = new Set([
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
]);
const CONFIDENCES = new Set([
  ...VERIFIED_CONFIDENCES,
  "user_reported_pending",
  "stale",
  "disputed",
]);
const SERVING_SIZES = new Set([
  "pint",
  "pot",
  "schooner",
  "jug",
  "bottle",
  "can",
  "other",
]);
const TAP_STATUSES = new Set(["yes", "no", "unknown"]);
const MEMBERSHIP_TIERS = new Set(["basic", "pro"]);
const DISPLAY_KINDS = new Set(["beer", "happy_hour", "special"]);
const SUBMISSION_STATUSES = new Set([
  "pending",
  "needs_more_evidence",
  "approved",
  "rejected",
  "disputed",
  "fraud_flagged",
]);
const SUBMISSION_TYPES = new Set([
  "single_beer_price",
  "full_venue_update",
  "happy_hour_update",
  "photo_upload",
]);
const OCR_STATUSES = new Set([
  "not_requested",
  "processed",
  "manual_review_required",
  "failed",
]);
const WORKFLOW_STATUSES = new Set([
  "open",
  "in_progress",
  "resolved",
  "rejected",
]);
const VENUE_REQUEST_STATUSES = new Set([
  ...WORKFLOW_STATUSES,
  "mission_created",
]);
const REQUEST_TYPES = new Set([
  "missing_venue",
  "missing_beer",
  "verify_venue",
  "verify_beer_at_venue",
]);

export type VenueManagerInsightsRepositoryErrorCode =
  "invalid_input" | "malformed_result" | "persistence_failure";

const ERROR_MESSAGES: Readonly<
  Record<VenueManagerInsightsRepositoryErrorCode, string>
> = {
  invalid_input: "The venue-manager insights input is invalid.",
  malformed_result: "Stored venue-manager insights data is invalid.",
  persistence_failure: "Venue-manager insights could not be loaded.",
};

/** Stable failures deliberately omit SQL, identifiers, and stored values. */
export class VenueManagerInsightsRepositoryError extends Error {
  readonly code: VenueManagerInsightsRepositoryErrorCode;

  constructor(code: VenueManagerInsightsRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueManagerInsightsRepositoryError";
    this.code = code;
  }
}

export interface VenueManagerInsightsInput {
  venueId: string;
  suburb: string | null;
  staleBefore: string;
  priceRecords: readonly PublicVenuePriceRecord[];
  startIso?: string | undefined;
  endIso?: string | undefined;
}

export interface VenueManagerInsightsBucket {
  key: string;
  count: number;
}

export interface VenueManagerAggregateInsights {
  venueViews: number;
  pricePreviewViews: number;
  happyHourClicks: number;
  markerClicks: number;
  wrongPriceReports: number;
  verifyRequests: number;
  updatesReceived: number;
  topSearchedBeersNearby: VenueManagerInsightsBucket[];
  missingBeerSearches: VenueManagerInsightsBucket[];
}

export interface VenueListingQualityItem {
  label: string;
  complete: boolean;
  points: number;
}

export type VenueManagerTrustWorkflowStatus =
  "open" | "in_progress" | "resolved" | "rejected";

export interface VenueManagerWrongPriceReport {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  venueId: string;
  venueName: string;
  priceRecordId: string | null;
  beerName: string | null;
  reason: string;
  notes: string | null;
  sourcePhotoUrl: string | null;
  status: VenueManagerTrustWorkflowStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VenueManagerRequestType =
  "missing_venue" | "missing_beer" | "verify_venue" | "verify_beer_at_venue";

export interface VenueManagerRequest {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  requestType: VenueManagerRequestType;
  venueId: string | null;
  venueName: string | null;
  googlePlaceId: string | null;
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  status: VenueManagerTrustWorkflowStatus | "mission_created";
  missionId: string | null;
  sourceSubmissionId: string | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenueManagerInsights {
  venueId: string;
  priceRecords: PublicVenuePriceRecord[];
  wrongPriceReports: VenueManagerWrongPriceReport[];
  requests: VenueManagerRequest[];
  submissions: BusinessSubmission[];
  aggregateInsights: VenueManagerAggregateInsights;
  listingQuality: {
    score: number;
    checklist: VenueListingQualityItem[];
    latestVerifiedAt: string | null;
  };
}

interface NormalizedInput {
  venueId: string;
  suburb: string | null;
  staleBefore: string;
  priceRecords: PublicVenuePriceRecord[];
  startIso: string | null;
  endIso: string | null;
}

interface WrongPriceReportRow extends Record<string, unknown> {
  id: unknown;
  user_id: unknown;
  anonymous_session_id: unknown;
  venue_id: unknown;
  venue_name: unknown;
  price_record_id: unknown;
  beer_name: unknown;
  reason: unknown;
  notes: unknown;
  source_photo_url: unknown;
  status: unknown;
  assigned_to: unknown;
  resolution_note: unknown;
  resolved_at: unknown;
  resolved_by: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface VenueRequestRow extends Record<string, unknown> {
  id: unknown;
  user_id: unknown;
  anonymous_session_id: unknown;
  request_type: unknown;
  venue_id: unknown;
  venue_name: unknown;
  google_place_id: unknown;
  beer_name: unknown;
  suburb: unknown;
  notes: unknown;
  status: unknown;
  mission_id: unknown;
  source_submission_id: unknown;
  assigned_to: unknown;
  resolution_note: unknown;
  resolved_at: unknown;
  resolved_by: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface SubmissionRow extends Record<string, unknown> {
  id: unknown;
  client_submission_id: unknown;
  mission_id: unknown;
  user_id: unknown;
  venue_id: unknown;
  venue_name: unknown;
  suburb: unknown;
  status: unknown;
  submission_type: unknown;
  observed_at: unknown;
  source_photo_url: unknown;
  ocr_status: unknown;
  ocr_summary_json: unknown;
  notes: unknown;
  points_awarded: unknown;
  upload_latitude: unknown;
  upload_longitude: unknown;
  upload_accuracy_meters: unknown;
  upload_location_captured_at: unknown;
  distance_to_venue_meters: unknown;
  points_eligible_by_location: unknown;
  points_eligibility_reason: unknown;
  pending_venue_json: unknown;
  reviewed_by: unknown;
  reviewed_at: unknown;
  rejection_reason: unknown;
  fraud_flagged: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface AggregateRow extends Record<string, unknown> {
  venueViews: unknown;
  pricePreviewViews: unknown;
  happyHourClicks: unknown;
  markerClicks: unknown;
}

interface BucketRow extends Record<string, unknown> {
  key: unknown;
  count: unknown;
}

function fail(code: VenueManagerInsightsRepositoryErrorCode): never {
  throw new VenueManagerInsightsRepositoryError(code);
}

function canonicalTimestamp(
  value: unknown,
  code: VenueManagerInsightsRepositoryErrorCode,
): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value))
    return fail(code);
  try {
    if (new Date(value).toISOString() !== value) return fail(code);
  } catch {
    return fail(code);
  }
  return value;
}

function requiredText(
  value: unknown,
  code: VenueManagerInsightsRepositoryErrorCode,
  maximum = MAX_TEXT_LENGTH,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    return fail(code);
  return value;
}

function nullableText(
  value: unknown,
  code: VenueManagerInsightsRepositoryErrorCode,
  maximum = MAX_TEXT_LENGTH,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) return fail(code);
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value, "malformed_result");
}

function exactNumber(
  value: unknown,
  code: VenueManagerInsightsRepositoryErrorCode = "malformed_result",
): number {
  if (typeof value !== "number" && typeof value !== "string") return fail(code);
  if (
    typeof value === "string" &&
    !/^[+-]?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    return fail(code);
  }
  const numeric = Number(value);
  const significantDigits =
    typeof value === "string"
      ? value
          .replace(/^[+-]/, "")
          .replace(/[eE].*$/, "")
          .replace(".", "")
          .replace(/^0+/, "").length
      : 0;
  if (
    !Number.isFinite(numeric) ||
    (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) ||
    significantDigits > 15
  )
    return fail(code);
  return numeric;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : exactNumber(value);
}

function countValue(value: unknown): number {
  const count = exactNumber(value);
  if (!Number.isSafeInteger(count) || count < 0)
    return fail("malformed_result");
  return count;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_result");
}

function enumValue<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): Value {
  if (typeof value !== "string" || !allowed.has(value))
    return fail("malformed_result");
  return value as Value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > MAX_JSON_LENGTH)
    return fail("malformed_result");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return fail("malformed_result");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof VenueManagerInsightsRepositoryError) throw error;
    return fail("malformed_result");
  }
}

function optionalObjectString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return nullableText(value, "malformed_result");
}

function optionalObjectNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return exactNumber(value);
}

function parseOcrSummary(value: unknown): SubmissionOcrSummary | null {
  if (value === null) return null;
  const parsed = jsonObject(value);
  const nonNegativeInteger = (field: string): number => {
    if (parsed[field] === undefined) return 0;
    const number = exactNumber(parsed[field]);
    if (!Number.isSafeInteger(number) || number < 0)
      return fail("malformed_result");
    return number;
  };
  return {
    model: optionalObjectString(parsed.model),
    imageCount: nonNegativeInteger("imageCount"),
    extractedRowCount: nonNegativeInteger("extractedRowCount"),
    rejectedCandidateCount: nonNegativeInteger("rejectedCandidateCount"),
    pendingCatalogCount: nonNegativeInteger("pendingCatalogCount"),
    message: optionalObjectString(parsed.message),
  };
}

function parsePendingVenue(value: unknown): PendingVenueDetails | null {
  if (value === null) return null;
  const parsed = jsonObject(value);
  const name = optionalObjectString(parsed.name);
  if (!name?.trim()) return null;
  return {
    googlePlaceId: optionalObjectString(parsed.googlePlaceId),
    name: name.trim(),
    address: optionalObjectString(parsed.address),
    suburb: optionalObjectString(parsed.suburb),
    state: optionalObjectString(parsed.state),
    postcode: optionalObjectString(parsed.postcode),
    phone: optionalObjectString(parsed.phone),
    website: optionalObjectString(parsed.website),
    latitude: optionalObjectNumber(parsed.latitude),
    longitude: optionalObjectNumber(parsed.longitude),
  };
}

function optionalInputText(value: unknown, maximum = MAX_TEXT_LENGTH): void {
  if (value !== undefined && value !== null)
    nullableText(value, "invalid_input", maximum);
}

function optionalInputBoolean(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean")
    return fail("invalid_input");
}

function optionalInputTimestamp(value: unknown): void {
  if (value !== undefined && value !== null)
    canonicalTimestamp(value, "invalid_input");
}

function inputEnum(value: unknown, allowed: ReadonlySet<string>): void {
  if (typeof value !== "string" || !allowed.has(value))
    return fail("invalid_input");
}

function validatePriceRecord(
  record: PublicVenuePriceRecord,
): PublicVenuePriceRecord {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return fail("invalid_input");
  requiredText(record.id, "invalid_input", MAX_IDENTIFIER_LENGTH);
  requiredText(record.venueId, "invalid_input", MAX_IDENTIFIER_LENGTH);
  requiredText(record.venueName, "invalid_input");
  nullableText(record.suburb, "invalid_input");
  optionalInputText(record.venueAddress);
  if (record.membershipTier !== undefined)
    inputEnum(record.membershipTier, MEMBERSHIP_TIERS);
  optionalInputBoolean(record.highlightedName);
  optionalInputText(record.premiumBadge);
  optionalInputBoolean(record.promoted);
  optionalInputBoolean(record.featuredSpecialEligible);
  optionalInputBoolean(record.acceptsPintPathCodes);
  requiredText(record.beerName, "invalid_input");
  nullableText(record.normalizedBeerId, "invalid_input", MAX_IDENTIFIER_LENGTH);
  inputEnum(record.servingSize, SERVING_SIZES);
  if (record.price !== null) exactNumber(record.price, "invalid_input");
  if (typeof record.isHappyHourPrice !== "boolean")
    return fail("invalid_input");
  nullableText(record.happyHourDetails, "invalid_input");
  optionalInputText(record.happyHourTitle);
  if (record.happyHourDays !== undefined) {
    if (
      !Array.isArray(record.happyHourDays) ||
      record.happyHourDays.length > MAX_HAPPY_HOUR_DAYS
    ) {
      return fail("invalid_input");
    }
    for (const day of record.happyHourDays)
      requiredText(day, "invalid_input", 64);
  }
  optionalInputText(record.happyHourStartTime, 64);
  optionalInputText(record.happyHourEndTime, 64);
  if (record.happyHourBeers !== undefined) {
    if (
      !Array.isArray(record.happyHourBeers) ||
      record.happyHourBeers.length > MAX_HAPPY_HOUR_BEERS
    ) {
      return fail("invalid_input");
    }
    for (const beer of record.happyHourBeers) {
      if (!beer || typeof beer !== "object" || Array.isArray(beer))
        return fail("invalid_input");
      nullableText(beer.beerId, "invalid_input", MAX_IDENTIFIER_LENGTH);
      requiredText(beer.beerName, "invalid_input");
      nullableText(
        beer.normalizedBeerId,
        "invalid_input",
        MAX_IDENTIFIER_LENGTH,
      );
      if (beer.servingSize !== null) inputEnum(beer.servingSize, SERVING_SIZES);
      if (beer.happyHourPrice !== null)
        exactNumber(beer.happyHourPrice, "invalid_input");
      nullableText(beer.offerText, "invalid_input");
      if (typeof beer.onTap !== "boolean" || typeof beer.inStock !== "boolean")
        return fail("invalid_input");
    }
  }
  if (record.displayKind !== undefined)
    inputEnum(record.displayKind, DISPLAY_KINDS);
  optionalInputText(record.specialTitle);
  optionalInputText(record.specialDescription);
  optionalInputText(record.specialDiscount);
  optionalInputTimestamp(record.specialStartsAt);
  optionalInputTimestamp(record.specialEndsAt);
  optionalInputText(record.specialStartTime, 64);
  optionalInputText(record.specialEndTime, 64);
  optionalInputText(record.specialScheduleNote);
  optionalInputBoolean(record.specialExclusive);
  inputEnum(record.isOnTap, TAP_STATUSES);
  inputEnum(record.confidence, CONFIDENCES);
  requiredText(record.sourceType, "invalid_input", 256);
  nullableText(
    record.sourceSubmissionId,
    "invalid_input",
    MAX_IDENTIFIER_LENGTH,
  );
  optionalInputBoolean(record.hasSourceLinkage);
  optionalInputBoolean(record.hasSourceEvidence);
  canonicalTimestamp(record.lastVerifiedAt, "invalid_input");
  optionalInputTimestamp(record.priceVerifiedAt);
  canonicalTimestamp(record.createdAt, "invalid_input");
  canonicalTimestamp(record.updatedAt, "invalid_input");
  const copy = { ...record };
  if (record.happyHourDays) copy.happyHourDays = [...record.happyHourDays];
  if (record.happyHourBeers)
    copy.happyHourBeers = record.happyHourBeers.map((beer) => ({ ...beer }));
  return copy;
}

function normalizeInput(value: VenueManagerInsightsInput): NormalizedInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid_input");
  const venueId = requiredText(
    value.venueId?.trim(),
    "invalid_input",
    MAX_IDENTIFIER_LENGTH,
  );
  const suburb =
    value.suburb === null
      ? null
      : requiredText(value.suburb?.trim(), "invalid_input", MAX_TEXT_LENGTH);
  const staleBefore = canonicalTimestamp(value.staleBefore, "invalid_input");
  if (
    !Array.isArray(value.priceRecords) ||
    value.priceRecords.length > MAX_PRICE_RECORDS
  ) {
    return fail("invalid_input");
  }
  const priceRecords = value.priceRecords.map(validatePriceRecord);
  const startIso =
    value.startIso === undefined
      ? null
      : canonicalTimestamp(value.startIso, "invalid_input");
  const endIso =
    value.endIso === undefined
      ? null
      : canonicalTimestamp(value.endIso, "invalid_input");
  if (startIso && endIso && startIso >= endIso) return fail("invalid_input");
  return {
    venueId,
    suburb,
    staleBefore,
    priceRecords,
    startIso,
    endIso,
  };
}

function mapWrongPriceReport(
  row: WrongPriceReportRow,
): VenueManagerWrongPriceReport {
  return {
    id: requiredText(row.id, "malformed_result", MAX_IDENTIFIER_LENGTH),
    userId: nullableText(
      row.user_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    anonymousSessionId: nullableText(
      row.anonymous_session_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    venueId: requiredText(
      row.venue_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    venueName: requiredText(row.venue_name, "malformed_result"),
    priceRecordId: nullableText(
      row.price_record_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    beerName: nullableText(row.beer_name, "malformed_result"),
    reason: requiredText(row.reason, "malformed_result"),
    notes: nullableText(row.notes, "malformed_result"),
    sourcePhotoUrl: nullableText(row.source_photo_url, "malformed_result"),
    status: enumValue(row.status, WORKFLOW_STATUSES),
    assignedTo: nullableText(
      row.assigned_to,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    resolutionNote: nullableText(row.resolution_note, "malformed_result"),
    resolvedAt: optionalTimestamp(row.resolved_at),
    resolvedBy: nullableText(
      row.resolved_by,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    createdAt: canonicalTimestamp(row.created_at, "malformed_result"),
    updatedAt: canonicalTimestamp(row.updated_at, "malformed_result"),
  };
}

function mapVenueRequest(row: VenueRequestRow): VenueManagerRequest {
  return {
    id: requiredText(row.id, "malformed_result", MAX_IDENTIFIER_LENGTH),
    userId: nullableText(
      row.user_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    anonymousSessionId: nullableText(
      row.anonymous_session_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    requestType: enumValue(row.request_type, REQUEST_TYPES),
    venueId: nullableText(
      row.venue_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    venueName: nullableText(row.venue_name, "malformed_result"),
    googlePlaceId: nullableText(
      row.google_place_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    beerName: nullableText(row.beer_name, "malformed_result"),
    suburb: nullableText(row.suburb, "malformed_result"),
    notes: nullableText(row.notes, "malformed_result"),
    status: enumValue(row.status, VENUE_REQUEST_STATUSES),
    missionId: nullableText(
      row.mission_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    sourceSubmissionId: nullableText(
      row.source_submission_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    assignedTo: nullableText(
      row.assigned_to,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    resolutionNote: nullableText(row.resolution_note, "malformed_result"),
    resolvedAt: optionalTimestamp(row.resolved_at),
    resolvedBy: nullableText(
      row.resolved_by,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    createdAt: canonicalTimestamp(row.created_at, "malformed_result"),
    updatedAt: canonicalTimestamp(row.updated_at, "malformed_result"),
  };
}

function mapSubmission(row: SubmissionRow): BusinessSubmission {
  return {
    id: requiredText(row.id, "malformed_result", MAX_IDENTIFIER_LENGTH),
    clientSubmissionId: nullableText(
      row.client_submission_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    missionId: nullableText(
      row.mission_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    userId: requiredText(
      row.user_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    venueId: requiredText(
      row.venue_id,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    venueName: requiredText(row.venue_name, "malformed_result"),
    suburb: nullableText(row.suburb, "malformed_result"),
    status: enumValue(row.status, SUBMISSION_STATUSES),
    submissionType: enumValue(row.submission_type, SUBMISSION_TYPES),
    observedAt: canonicalTimestamp(row.observed_at, "malformed_result"),
    sourcePhotoUrl: nullableText(row.source_photo_url, "malformed_result"),
    ocrStatus: enumValue(row.ocr_status, OCR_STATUSES),
    ocrSummary: parseOcrSummary(row.ocr_summary_json),
    notes: nullableText(row.notes, "malformed_result"),
    pointsAwarded: exactNumber(row.points_awarded),
    uploadLatitude: nullableNumber(row.upload_latitude),
    uploadLongitude: nullableNumber(row.upload_longitude),
    uploadAccuracyMeters: nullableNumber(row.upload_accuracy_meters),
    uploadLocationCapturedAt: optionalTimestamp(
      row.upload_location_captured_at,
    ),
    distanceToVenueMeters: nullableNumber(row.distance_to_venue_meters),
    pointsEligibleByLocation: booleanValue(row.points_eligible_by_location),
    pointsEligibilityReason: nullableText(
      row.points_eligibility_reason,
      "malformed_result",
    ),
    pendingVenue: parsePendingVenue(row.pending_venue_json),
    reviewedBy: nullableText(
      row.reviewed_by,
      "malformed_result",
      MAX_IDENTIFIER_LENGTH,
    ),
    reviewedAt: optionalTimestamp(row.reviewed_at),
    rejectionReason: nullableText(row.rejection_reason, "malformed_result"),
    fraudFlagged: booleanValue(row.fraud_flagged),
    createdAt: canonicalTimestamp(row.created_at, "malformed_result"),
    updatedAt: canonicalTimestamp(row.updated_at, "malformed_result"),
  };
}

const WRONG_PRICE_COLUMNS = `id, user_id, anonymous_session_id, venue_id, venue_name,
  price_record_id, beer_name, reason, notes, source_photo_url, status, assigned_to,
  resolution_note, resolved_at, resolved_by, created_at, updated_at`;
const VENUE_REQUEST_COLUMNS = `id, user_id, anonymous_session_id, request_type, venue_id,
  venue_name, google_place_id, beer_name, suburb, notes, status, mission_id,
  source_submission_id, assigned_to, resolution_note, resolved_at, resolved_by,
  created_at, updated_at`;
const SUBMISSION_COLUMNS = `id, client_submission_id, mission_id, user_id, venue_id,
  venue_name, suburb, status, submission_type, observed_at, source_photo_url,
  ocr_status, ocr_summary_json, notes, points_awarded, upload_latitude,
  upload_longitude, upload_accuracy_meters, upload_location_captured_at,
  distance_to_venue_meters, points_eligible_by_location, points_eligibility_reason,
  pending_venue_json, reviewed_by, reviewed_at, rejection_reason, fraud_flagged,
  created_at, updated_at`;

/** Read-only, bounded venue-manager aggregate authority. */
export class VenueManagerInsightsRepository {
  constructor(private readonly database: SqlDatabase) {}

  private collation(): string {
    return this.database.dialect === "postgres"
      ? 'COLLATE "C"'
      : "COLLATE BINARY";
  }

  private jsonQueryExpression(): string {
    return this.database.dialect === "postgres"
      ? "metadata_json ->> 'query'"
      : "CAST(json_extract(metadata_json, '$.query') AS TEXT)";
  }

  private caseFold(expression: string): string {
    return this.database.dialect === "postgres"
      ? `lower((${expression}) COLLATE "C")`
      : `lower(${expression})`;
  }

  private range(input: NormalizedInput): {
    clause: string;
    bindings: string[];
  } {
    return {
      clause: `${input.startIso ? " AND created_at >= ?" : ""}${input.endIso ? " AND created_at < ?" : ""}`,
      bindings: [
        ...(input.startIso ? [input.startIso] : []),
        ...(input.endIso ? [input.endIso] : []),
      ],
    };
  }

  private async translate<Result>(
    work: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueManagerInsightsRepositoryError) throw error;
      return fail("persistence_failure");
    }
  }

  async getVenueManagerInsights(
    inputValue: VenueManagerInsightsInput,
  ): Promise<VenueManagerInsights> {
    const input = normalizeInput(inputValue);
    return this.translate(async () => {
      const range = this.range(input);
      // Current rows are snapshots, not a history table. Preserve the legacy
      // historical rule: only the report end excludes snapshots; start does not.
      const priceRecords = input.priceRecords.filter(
        (record) =>
          !input.endIso ||
          (record.createdAt < input.endIso &&
            record.lastVerifiedAt < input.endIso),
      );
      const requestVenueName = priceRecords[0]?.venueName ?? input.venueId;

      const wrongPriceRows = await this.database
        .prepare(
          `SELECT ${WRONG_PRICE_COLUMNS}
           FROM wrong_price_reports
          WHERE venue_id = ?${range.clause}
          ORDER BY created_at DESC, id ${this.collation()} ASC
          LIMIT ?`,
        )
        .all<WrongPriceReportRow>(
          input.venueId,
          ...range.bindings,
          DETAIL_LIMIT,
        );
      const requestRows = await this.database
        .prepare(
          `SELECT ${VENUE_REQUEST_COLUMNS}
           FROM venue_requests
          WHERE (
            venue_id = ?
            OR (venue_name IS NOT NULL AND ${this.caseFold("venue_name")} = ${this.caseFold("?")})
          )
            ${range.clause}
          ORDER BY created_at DESC, id ${this.collation()} ASC
          LIMIT ?`,
        )
        .all<VenueRequestRow>(
          input.venueId,
          requestVenueName,
          ...range.bindings,
          DETAIL_LIMIT,
        );
      const submissionRows = await this.database
        .prepare(
          `SELECT ${SUBMISSION_COLUMNS}
           FROM submissions
          WHERE venue_id = ?${range.clause}
          ORDER BY created_at DESC, id ${this.collation()} ASC
          LIMIT ?`,
        )
        .all<SubmissionRow>(input.venueId, ...range.bindings, DETAIL_LIMIT);

      const wrongPriceReports = wrongPriceRows.map(mapWrongPriceReport);
      const requests = requestRows.map(mapVenueRequest);
      const submissions = submissionRows.map(mapSubmission);
      const actor = `CASE
        WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
        WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
        ELSE NULL
      END`;
      const aggregateRow = await this.database
        .prepare(
          `SELECT
           count(DISTINCT CASE
             WHEN event_type IN ('venue_card_viewed', 'venue_detail_opened') THEN ${actor}
           END) AS "venueViews",
           count(DISTINCT CASE
             WHEN event_type IN ('free_preview_viewed', 'price_view_revealed') THEN ${actor}
           END) AS "pricePreviewViews",
           count(DISTINCT CASE
             WHEN event_type IN ('happy_hour_active_now_used', 'happy_hour_near_me_used') THEN ${actor}
           END) AS "happyHourClicks",
           count(DISTINCT CASE WHEN event_type = 'map_pin_click' THEN ${actor} END) AS "markerClicks"
         FROM events
        WHERE venue_id = ?
          AND event_type IN (
            'venue_card_viewed', 'venue_detail_opened',
            'free_preview_viewed', 'price_view_revealed',
            'happy_hour_active_now_used', 'happy_hour_near_me_used',
            'map_pin_click'
          )${range.clause}`,
        )
        .get<AggregateRow>(input.venueId, ...range.bindings);
      if (!aggregateRow) return fail("malformed_result");

      const beerKey = `COALESCE(beer_id, ${this.jsonQueryExpression()}, 'beer')`;
      const topBeersNearby = input.suburb
        ? (
            await this.database
              .prepare(
                `SELECT ${beerKey} AS key,
                    count(DISTINCT ${actor}) AS count
              FROM events
              WHERE event_type = 'beer_search_performed'
                AND suburb IS NOT NULL
                AND ${this.caseFold("suburb")} = ${this.caseFold("?")}${range.clause}
              GROUP BY ${beerKey}
              ORDER BY count DESC, ${beerKey} ${this.collation()} ASC
              LIMIT ?`,
              )
              .all<BucketRow>(input.suburb, ...range.bindings, TOP_BEER_LIMIT)
          ).map((row) => ({
            key: requiredText(
              row.key,
              "malformed_result",
              MAX_IDENTIFIER_LENGTH,
            ),
            count: countValue(row.count),
          }))
        : [];

      const beerIds = new Set(
        priceRecords
          .map((record) => record.normalizedBeerId)
          .filter((value): value is string => Boolean(value)),
      );
      const missingBeerSearches = topBeersNearby
        .filter((row) => !beerIds.has(row.key))
        .slice(0, MISSING_BEER_LIMIT);
      const latestVerifiedAt = priceRecords.reduce<string | null>(
        (latest, record) =>
          latest === null || record.lastVerifiedAt > latest
            ? record.lastVerifiedAt
            : latest,
        null,
      );
      const verifiedRecords = priceRecords.filter((record) =>
        VERIFIED_CONFIDENCES.has(record.confidence),
      );
      const scoreItems: VenueListingQualityItem[] = [
        {
          label: "At least one verified price",
          complete: verifiedRecords.length >= 1,
          points: 20,
        },
        {
          label: "At least 3 verified beers",
          complete: verifiedRecords.length >= 3,
          points: 20,
        },
        {
          label: "Happy hour listed",
          complete: priceRecords.some(
            (record) =>
              record.isHappyHourPrice || Boolean(record.happyHourDetails),
          ),
          points: 15,
        },
        {
          label: "Verified within 30 days",
          complete: Boolean(
            latestVerifiedAt && latestVerifiedAt >= input.staleBefore,
          ),
          points: 15,
        },
        {
          label: "No unresolved disputes",
          complete: wrongPriceReports.every(
            (report) => report.status !== "open",
          ),
          points: 15,
        },
        {
          label: "Venue-submitted or photo source present",
          complete: priceRecords.some((record) =>
            ["venue", "photo", "submission"].some((source) =>
              record.sourceType.includes(source),
            ),
          ),
          points: 10,
        },
        {
          label: "Coordinates present in venue directory",
          complete: false,
          points: 5,
        },
      ];
      const possiblePoints = scoreItems.reduce(
        (sum, item) => sum + item.points,
        0,
      );
      const earnedPoints = scoreItems.reduce(
        (sum, item) => sum + (item.complete ? item.points : 0),
        0,
      );

      return {
        venueId: input.venueId,
        priceRecords,
        wrongPriceReports,
        requests,
        submissions,
        aggregateInsights: {
          venueViews: countValue(aggregateRow.venueViews),
          pricePreviewViews: countValue(aggregateRow.pricePreviewViews),
          happyHourClicks: countValue(aggregateRow.happyHourClicks),
          markerClicks: countValue(aggregateRow.markerClicks),
          wrongPriceReports: wrongPriceReports.length,
          verifyRequests: requests.length,
          updatesReceived: submissions.length,
          topSearchedBeersNearby: topBeersNearby,
          missingBeerSearches,
        },
        listingQuality: {
          score: Math.round((earnedPoints / possiblePoints) * 100),
          checklist: scoreItems,
          latestVerifiedAt,
        },
      };
    });
  }
}
