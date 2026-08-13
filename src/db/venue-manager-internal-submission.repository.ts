import crypto from "node:crypto";

import {
  MISSION_LIFECYCLE_LOCK_CONTRACT,
  missionLifecycleAccountLockKey,
  missionLifecycleMissionLockKey,
} from "./mission-lifecycle.repository.js";
import {
  SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT,
  sourceEvidenceAccountLockKey,
} from "./source-evidence-object.repository.js";
import type { SqlDatabase } from "./sql-database.js";
import {
  VENUE_ACCESS_LOCK_CONTRACT,
  venueAccessAccountLockKey,
} from "./venue-access.repository.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLIENT_SUBMISSION_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const NORMALIZED_BEER_ID = /^[a-z0-9][a-z0-9_:-]{0,159}$/;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_SUBMISSION_ID_LENGTH = 200;
const MAX_ITEMS = 20;
const MAX_EVIDENCE = 7;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_OBSERVATION_AGE_MS = 31 * 24 * 60 * 60_000;
const MAX_LOCATION_AGE_MS = 12 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 15 * 60_000;
const INTERNAL_POINTS_REASON = "venue_manager_not_reward_eligible";
const PRIVATE_EVIDENCE_PREFIX = "private:evidence:";
const CLIENT_LOCK_PREFIX = "venue-manager-internal-submission:client:";
const SUBMISSION_LOCK_PREFIX = "venue-manager-internal-submission:id:";

const LOCK_ROW_ORDER = Object.freeze([
  "sorted_shared_and_idempotency_advisory_keys",
  "manager_account_row",
  "active_manager_assignment_row",
  "mission_row",
  "mission_progress_row",
  "sorted_source_evidence_rows",
  "submission_row_then_child_rows",
  "conditional_mission_transition",
  "deletion_and_assignment_recheck",
] as const);

/**
 * Versioned lock and publication-safety contract for the sole Free-launch
 * venue-manager happy-hour intake path.
 *
 * VenueAccess v1 deliberately exposes only an account key. That is sufficient
 * to serialize this actor's assignment revocation/regrant, but it cannot fence
 * same-venue identity changes or assignments owned by a different manager.
 * Future shared wiring must add a VenueAccess venue key before relying on this
 * repository for a transaction that mutates venue identity or public venue
 * state. This repository performs neither operation.
 */
export const VENUE_MANAGER_INTERNAL_SUBMISSION_LOCK_CONTRACT = Object.freeze({
  version: 1,
  internalOnly: true,
  clientKeyPrefix: CLIENT_LOCK_PREFIX,
  submissionKeyPrefix: SUBMISSION_LOCK_PREFIX,
  keyOrder: "distinct-lexicographic-ascending",
  hashFunction: "pg_catalog.hashtext",
  lockFunction: "pg_catalog.pg_advisory_xact_lock",
  sharedVersions: Object.freeze({
    venueAccess: VENUE_ACCESS_LOCK_CONTRACT.version,
    sourceEvidence: SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT.version,
    missionLifecycle: MISSION_LIFECYCLE_LOCK_CONTRACT.version,
  }),
  rowOrder: LOCK_ROW_ORDER,
  venueAccessVenueLockGap:
    "VenueAccess v1 has no venue-scoped advisory key; this operation fences only the submitting manager account and assignment.",
} as const);

export type VenueManagerInternalSubmissionRepositoryErrorCode =
  | "account_ineligible"
  | "account_not_found"
  | "assignment_not_active"
  | "assignment_not_found"
  | "deletion_locked"
  | "evidence_not_found"
  | "evidence_not_live"
  | "evidence_not_owned"
  | "forbidden"
  | "invalid_input"
  | "malformed_record"
  | "mission_inactive"
  | "mission_not_accepted"
  | "mission_not_happy_hour"
  | "mission_not_found"
  | "mission_stale"
  | "mission_wrong_venue"
  | "persistence_failure"
  | "submission_conflict"
  | "wrong_venue";

const ERROR_MESSAGES: Readonly<Record<VenueManagerInternalSubmissionRepositoryErrorCode, string>> = {
  account_ineligible: "The account is not eligible to create an internal venue-manager submission.",
  account_not_found: "The venue-manager account does not exist.",
  assignment_not_active: "The venue-manager assignment is no longer active.",
  assignment_not_found: "The venue-manager assignment does not exist.",
  deletion_locked: "Internal venue submissions are unavailable while account deletion is being processed.",
  evidence_not_found: "The source evidence does not exist.",
  evidence_not_live: "The source evidence is no longer live.",
  evidence_not_owned: "The source evidence is not owned by the venue manager.",
  forbidden: "The account is not authorized for this internal venue submission.",
  invalid_input: "The internal venue submission input is invalid.",
  malformed_record: "Stored internal venue submission data is malformed.",
  mission_inactive: "The selected happy-hour mission is no longer active.",
  mission_not_accepted: "The happy-hour mission is not an accepted current reservation.",
  mission_not_happy_hour: "The selected mission is not a happy-hour mission.",
  mission_not_found: "The selected happy-hour mission does not exist.",
  mission_stale: "The happy-hour mission decision is stale.",
  mission_wrong_venue: "The selected happy-hour mission belongs to a different venue.",
  persistence_failure: "The internal venue submission could not be persisted.",
  submission_conflict: "The client submission identifier conflicts with existing content.",
  wrong_venue: "The venue submission does not match the manager assignment.",
};

/** Stable, secret-free persistence failures for later HTTP/service mapping. */
export class VenueManagerInternalSubmissionRepositoryError extends Error {
  readonly code: VenueManagerInternalSubmissionRepositoryErrorCode;

  constructor(code: VenueManagerInternalSubmissionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueManagerInternalSubmissionRepositoryError";
    this.code = code;
  }
}

export type VenueManagerInternalServingSize =
  | "pint"
  | "pot"
  | "schooner"
  | "jug"
  | "bottle"
  | "can"
  | "other";
export type VenueManagerInternalTapStatus = "yes" | "no" | "unknown";
export type VenueManagerInternalCaptureSource = "manual" | "photo_ocr";
export type VenueManagerInternalOcrStatus =
  | "not_requested"
  | "processed"
  | "manual_review_required"
  | "failed";

export interface VenueManagerInternalOcrSummary {
  model: string | null;
  imageCount: number;
  extractedRowCount: number;
  rejectedCandidateCount: number;
  pendingCatalogCount: number;
  message: string | null;
}

export interface VenueManagerInternalPendingVenue {
  googlePlaceId: string | null;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface VenueManagerInternalLocationEvidence {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: string;
  distanceToVenueMeters: number | null;
}

export interface VenueManagerInternalMissionFence {
  id: string;
  progressId: string;
  expectedMissionUpdatedAt: string;
  expectedProgressUpdatedAt: string;
  acceptedAfter: string;
}

export interface VenueManagerInternalSubmissionItemInput {
  id: string;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: VenueManagerInternalServingSize;
  price: number | null;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
  isOnTap: VenueManagerInternalTapStatus;
  confidence: number;
  captureSource: VenueManagerInternalCaptureSource;
  sourceText: string | null;
  /** Must remain false; internal happy-hour rows never create catalogue work. */
  requiresCatalogApproval: false;
}

export interface CreateVenueManagerInternalSubmissionInput {
  id: string;
  clientSubmissionId: string;
  managerAccountId: string;
  managerAssignmentId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  submissionType: "happy_hour_update";
  observedAt: string;
  evidenceIds?: readonly string[] | undefined;
  ocrStatus?: VenueManagerInternalOcrStatus | undefined;
  ocrSummary?: VenueManagerInternalOcrSummary | null | undefined;
  notes: string | null;
  location?: VenueManagerInternalLocationEvidence | null | undefined;
  pendingVenue?: VenueManagerInternalPendingVenue | null | undefined;
  mission?: VenueManagerInternalMissionFence | null | undefined;
  items: readonly VenueManagerInternalSubmissionItemInput[];
  safety: {
    internalOnly: true;
    publicationEligible: false;
    rewardEligible: false;
    pointsAwarded: 0;
  };
  now: string;
}

export interface VenueManagerInternalSubmission {
  id: string;
  clientSubmissionId: string;
  missionId: string | null;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: "pending";
  submissionType: "happy_hour_update";
  observedAt: string;
  sourcePhotoUrl: string | null;
  ocrStatus: VenueManagerInternalOcrStatus;
  ocrSummary: VenueManagerInternalOcrSummary | null;
  notes: string | null;
  pointsAwarded: 0;
  uploadLatitude: number | null;
  uploadLongitude: number | null;
  uploadAccuracyMeters: number | null;
  uploadLocationCapturedAt: string | null;
  distanceToVenueMeters: number | null;
  pointsEligibleByLocation: false;
  pointsEligibilityReason: typeof INTERNAL_POINTS_REASON;
  pendingVenue: VenueManagerInternalPendingVenue | null;
  reviewedBy: null;
  reviewedAt: null;
  rejectionReason: null;
  fraudFlagged: false;
  internalOnly: true;
  createdAt: string;
  updatedAt: string;
}

export interface VenueManagerInternalSubmissionItem {
  id: string;
  submissionId: string;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: VenueManagerInternalServingSize;
  price: number | null;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
  isOnTap: VenueManagerInternalTapStatus;
  confidence: number;
  captureSource: VenueManagerInternalCaptureSource;
  sourceText: string | null;
  requiresCatalogApproval: false;
  createdAt: string;
}

export interface VenueManagerInternalSubmissionRecord {
  submission: VenueManagerInternalSubmission;
  items: VenueManagerInternalSubmissionItem[];
  evidenceIds: string[];
}

export interface CreateVenueManagerInternalSubmissionResult {
  outcome: "created" | "replayed";
  record: VenueManagerInternalSubmissionRecord;
}

interface AccountRow {
  id: unknown;
  role: unknown;
  status: unknown;
  authProvider: unknown;
  deletionLocked: unknown;
}

interface AssignmentRow {
  id: unknown;
  userId: unknown;
  venueId: unknown;
  accessLevel: unknown;
  status: unknown;
  expiresAt: unknown;
}

interface MissionRow {
  id: unknown;
  venueId: unknown;
  reason: unknown;
  active: unknown;
  updatedAt: unknown;
}

interface ProgressRow {
  id: unknown;
  missionId: unknown;
  userId: unknown;
  submissionId: unknown;
  status: unknown;
  acceptedAt: unknown;
  submittedAt: unknown;
  completedAt: unknown;
  updatedAt: unknown;
}

interface EvidenceRow {
  id: unknown;
  ownerUserId: unknown;
  retentionExpiresAt: unknown;
  deletedAt: unknown;
  createdAt: unknown;
}

interface SubmissionRow {
  id: unknown;
  clientSubmissionId: unknown;
  missionId: unknown;
  userId: unknown;
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  status: unknown;
  submissionType: unknown;
  observedAt: unknown;
  sourcePhotoUrl: unknown;
  ocrStatus: unknown;
  ocrSummaryJson: unknown;
  notes: unknown;
  pointsAwarded: unknown;
  uploadLatitude: unknown;
  uploadLongitude: unknown;
  uploadAccuracyMeters: unknown;
  uploadLocationCapturedAt: unknown;
  distanceToVenueMeters: unknown;
  pointsEligibleByLocation: unknown;
  pointsEligibilityReason: unknown;
  pendingVenueJson: unknown;
  reviewedBy: unknown;
  reviewedAt: unknown;
  rejectionReason: unknown;
  fraudFlagged: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ItemRow {
  id: unknown;
  submissionId: unknown;
  beerName: unknown;
  normalizedBeerId: unknown;
  servingSize: unknown;
  price: unknown;
  isHappyHourPrice: unknown;
  happyHourDetails: unknown;
  isOnTap: unknown;
  confidence: unknown;
  captureSource: unknown;
  sourceText: unknown;
  requiresCatalogApproval: unknown;
  createdAt: unknown;
}

interface LinkRow {
  evidenceId: unknown;
  sortOrder: unknown;
  createdAt: unknown;
}

interface NormalizedItem extends VenueManagerInternalSubmissionItemInput {}

interface NormalizedInput {
  id: string;
  clientSubmissionId: string;
  managerAccountId: string;
  managerAssignmentId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  observedAt: string;
  evidenceIds: string[];
  ocrStatus: VenueManagerInternalOcrStatus;
  ocrSummary: VenueManagerInternalOcrSummary | null;
  ocrSummaryJson: string | null;
  notes: string | null;
  location: VenueManagerInternalLocationEvidence | null;
  pendingVenue: VenueManagerInternalPendingVenue | null;
  pendingVenueJson: string | null;
  mission: VenueManagerInternalMissionFence | null;
  items: NormalizedItem[];
  now: string;
}

const SUBMISSION_PROJECTION = `
  submission.id AS "id",
  submission.client_submission_id AS "clientSubmissionId",
  submission.mission_id AS "missionId",
  submission.user_id AS "userId",
  submission.venue_id AS "venueId",
  submission.venue_name AS "venueName",
  submission.suburb AS "suburb",
  submission.status AS "status",
  submission.submission_type AS "submissionType",
  submission.observed_at AS "observedAt",
  submission.source_photo_url AS "sourcePhotoUrl",
  submission.ocr_status AS "ocrStatus",
  submission.ocr_summary_json AS "ocrSummaryJson",
  submission.notes AS "notes",
  submission.points_awarded AS "pointsAwarded",
  submission.upload_latitude AS "uploadLatitude",
  submission.upload_longitude AS "uploadLongitude",
  submission.upload_accuracy_meters AS "uploadAccuracyMeters",
  submission.upload_location_captured_at AS "uploadLocationCapturedAt",
  submission.distance_to_venue_meters AS "distanceToVenueMeters",
  submission.points_eligible_by_location AS "pointsEligibleByLocation",
  submission.points_eligibility_reason AS "pointsEligibilityReason",
  submission.pending_venue_json AS "pendingVenueJson",
  submission.reviewed_by AS "reviewedBy",
  submission.reviewed_at AS "reviewedAt",
  submission.rejection_reason AS "rejectionReason",
  submission.fraud_flagged AS "fraudFlagged",
  submission.created_at AS "createdAt",
  submission.updated_at AS "updatedAt"`;

const ITEM_PROJECTION = `
  item.id AS "id",
  item.submission_id AS "submissionId",
  item.beer_name AS "beerName",
  item.normalized_beer_id AS "normalizedBeerId",
  item.serving_size AS "servingSize",
  item.price AS "price",
  item.is_happy_hour_price AS "isHappyHourPrice",
  item.happy_hour_details AS "happyHourDetails",
  item.is_on_tap AS "isOnTap",
  item.confidence AS "confidence",
  item.capture_source AS "captureSource",
  item.source_text AS "sourceText",
  item.requires_catalog_approval AS "requiresCatalogApproval",
  item.created_at AS "createdAt"`;

function fail(code: VenueManagerInternalSubmissionRepositoryErrorCode): never {
  throw new VenueManagerInternalSubmissionRepositoryError(code);
}

function inputText(value: unknown, maximum = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function inputOptionalText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\0]/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function inputUtc(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return fail("invalid_input");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail("invalid_input");
  return value;
}

function inputNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function inputOptionalNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value == null ? null : inputNumber(value, minimum, maximum);
}

function inputInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) return fail("invalid_input");
}

function recordText(value: unknown, maximum = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum || /[\r\n\0]/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function recordOptionalText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > maximum || /\0/.test(value)) return fail("malformed_record");
  return value;
}

function recordUtc(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return fail("malformed_record");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail("malformed_record");
  return value;
}

function recordOptionalUtc(value: unknown): string | null {
  return value == null ? null : recordUtc(value);
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function recordNumber(value: unknown, minimum: number, maximum: number): number {
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) return fail("malformed_record");
  return normalized;
}

function recordOptionalNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value == null ? null : recordNumber(value, minimum, maximum);
}

function recordInteger(value: unknown, minimum: number, maximum: number): number {
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) return fail("malformed_record");
  return normalized;
}

function booleanBinding(dialect: SqlDatabase["dialect"], value: boolean): boolean | number {
  return dialect === "postgres" ? value : value ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonText(value: Record<string, unknown> | null): string | null {
  if (value == null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail("invalid_input");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) return fail("invalid_input");
  return serialized;
}

function recordJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fail("malformed_record");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("malformed_record");
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    return fail("malformed_record");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) return fail("malformed_record");
  return parsed as Record<string, unknown>;
}

function normalizeOcrSummary(value: VenueManagerInternalOcrSummary | null | undefined): VenueManagerInternalOcrSummary | null {
  if (value == null) return null;
  assertExactKeys(value, [
    "model",
    "imageCount",
    "extractedRowCount",
    "rejectedCandidateCount",
    "pendingCatalogCount",
    "message",
  ]);
  const result: VenueManagerInternalOcrSummary = {
    model: inputOptionalText(value.model, 120),
    imageCount: inputInteger(value.imageCount, 0, MAX_EVIDENCE),
    extractedRowCount: inputInteger(value.extractedRowCount, 0, MAX_ITEMS),
    rejectedCandidateCount: inputInteger(value.rejectedCandidateCount, 0, 1_000),
    pendingCatalogCount: inputInteger(value.pendingCatalogCount, 0, MAX_ITEMS),
    message: inputOptionalText(value.message, 500),
  };
  jsonText(result as unknown as Record<string, unknown>);
  return result;
}

function recordOcrSummary(value: unknown): VenueManagerInternalOcrSummary | null {
  const object = recordJsonObject(value);
  if (!object) return null;
  return {
    model: recordOptionalText(object.model, 120),
    imageCount: recordInteger(object.imageCount, 0, MAX_EVIDENCE),
    extractedRowCount: recordInteger(object.extractedRowCount, 0, MAX_ITEMS),
    rejectedCandidateCount: recordInteger(object.rejectedCandidateCount, 0, 1_000),
    pendingCatalogCount: recordInteger(object.pendingCatalogCount, 0, MAX_ITEMS),
    message: recordOptionalText(object.message, 500),
  };
}

function normalizePendingVenue(value: VenueManagerInternalPendingVenue | null | undefined): VenueManagerInternalPendingVenue | null {
  if (value == null) return null;
  assertExactKeys(value, [
    "googlePlaceId",
    "name",
    "address",
    "suburb",
    "state",
    "postcode",
    "phone",
    "website",
    "latitude",
    "longitude",
  ]);
  const normalized: VenueManagerInternalPendingVenue = {
    googlePlaceId: inputOptionalText(value.googlePlaceId, 255),
    name: inputText(value.name, 180),
    address: inputOptionalText(value.address, 500),
    suburb: inputOptionalText(value.suburb, 120),
    state: inputOptionalText(value.state, 80),
    postcode: inputOptionalText(value.postcode, 20),
    phone: inputOptionalText(value.phone, 40),
    website: inputOptionalText(value.website, 500),
    latitude: inputOptionalNumber(value.latitude, -90, 90),
    longitude: inputOptionalNumber(value.longitude, -180, 180),
  };
  if ((normalized.latitude == null) !== (normalized.longitude == null)) return fail("invalid_input");
  if (!normalized.address && normalized.latitude == null) return fail("invalid_input");
  if (normalized.website) {
    try {
      const parsed = new URL(normalized.website);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail("invalid_input");
    } catch (error) {
      if (error instanceof VenueManagerInternalSubmissionRepositoryError) throw error;
      return fail("invalid_input");
    }
  }
  jsonText(normalized as unknown as Record<string, unknown>);
  return normalized;
}

function recordPendingVenue(value: unknown): VenueManagerInternalPendingVenue | null {
  const object = recordJsonObject(value);
  if (!object) return null;
  const normalized: VenueManagerInternalPendingVenue = {
    googlePlaceId: recordOptionalText(object.googlePlaceId, 255),
    name: recordText(object.name, 180),
    address: recordOptionalText(object.address, 500),
    suburb: recordOptionalText(object.suburb, 120),
    state: recordOptionalText(object.state, 80),
    postcode: recordOptionalText(object.postcode, 20),
    phone: recordOptionalText(object.phone, 40),
    website: recordOptionalText(object.website, 500),
    latitude: recordOptionalNumber(object.latitude, -90, 90),
    longitude: recordOptionalNumber(object.longitude, -180, 180),
  };
  if ((normalized.latitude == null) !== (normalized.longitude == null)) return fail("malformed_record");
  if (!normalized.address && normalized.latitude == null) return fail("malformed_record");
  if (normalized.website) {
    try {
      const parsed = new URL(normalized.website);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail("malformed_record");
    } catch (error) {
      if (error instanceof VenueManagerInternalSubmissionRepositoryError) throw error;
      return fail("malformed_record");
    }
  }
  return normalized;
}

function normalizeLocation(
  value: VenueManagerInternalLocationEvidence | null | undefined,
  now: string,
): VenueManagerInternalLocationEvidence | null {
  if (value == null) return null;
  assertExactKeys(value, [
    "latitude",
    "longitude",
    "accuracyMeters",
    "capturedAt",
    "distanceToVenueMeters",
  ]);
  const normalized: VenueManagerInternalLocationEvidence = {
    latitude: inputNumber(value.latitude, -90, 90),
    longitude: inputNumber(value.longitude, -180, 180),
    accuracyMeters: inputOptionalNumber(value.accuracyMeters, 0, 100_000),
    capturedAt: inputUtc(value.capturedAt),
    distanceToVenueMeters: inputOptionalNumber(value.distanceToVenueMeters, 0, 10_000_000),
  };
  const ageMs = Date.parse(now) - Date.parse(normalized.capturedAt);
  if (ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_LOCATION_AGE_MS) return fail("invalid_input");
  return normalized;
}

function normalizeItem(
  value: VenueManagerInternalSubmissionItemInput,
  submissionId: string,
  index: number,
): NormalizedItem {
  if (!value || typeof value !== "object") return fail("invalid_input");
  assertExactKeys(value, [
    "id",
    "beerName",
    "normalizedBeerId",
    "servingSize",
    "price",
    "isHappyHourPrice",
    "happyHourDetails",
    "isOnTap",
    "confidence",
    "captureSource",
    "sourceText",
    "requiresCatalogApproval",
  ]);
  const id = inputText(value.id);
  if (id !== `${submissionId}:item:${index}`) return fail("invalid_input");
  const beerName = inputText(value.beerName, 120);
  const normalizedBeerId = inputOptionalText(value.normalizedBeerId, 160);
  if (normalizedBeerId != null && !NORMALIZED_BEER_ID.test(normalizedBeerId)) return fail("invalid_input");
  if (!["pint", "pot", "schooner", "jug", "bottle", "can", "other"].includes(value.servingSize)) {
    return fail("invalid_input");
  }
  const price = inputOptionalNumber(value.price, 0.01, 250);
  if (price != null && Math.abs(price * 100 - Math.round(price * 100)) >= 1e-8) return fail("invalid_input");
  if (typeof value.isHappyHourPrice !== "boolean") return fail("invalid_input");
  const happyHourDetails = inputOptionalText(value.happyHourDetails, 1_000);
  if (!value.isHappyHourPrice && !happyHourDetails) return fail("invalid_input");
  if (!["yes", "no", "unknown"].includes(value.isOnTap)) return fail("invalid_input");
  if (!["manual", "photo_ocr"].includes(value.captureSource)) return fail("invalid_input");
  if (value.requiresCatalogApproval !== false) return fail("invalid_input");
  return {
    id,
    beerName,
    normalizedBeerId,
    servingSize: value.servingSize,
    price,
    isHappyHourPrice: value.isHappyHourPrice,
    happyHourDetails,
    isOnTap: value.isOnTap,
    confidence: inputNumber(value.confidence, 0, 1),
    captureSource: value.captureSource,
    sourceText: inputOptionalText(value.sourceText, 500),
    requiresCatalogApproval: false,
  };
}

function normalizeMission(value: VenueManagerInternalMissionFence | null | undefined): VenueManagerInternalMissionFence | null {
  if (value == null) return null;
  assertExactKeys(value, [
    "id",
    "progressId",
    "expectedMissionUpdatedAt",
    "expectedProgressUpdatedAt",
    "acceptedAfter",
  ]);
  return {
    id: inputText(value.id),
    progressId: inputText(value.progressId),
    expectedMissionUpdatedAt: inputUtc(value.expectedMissionUpdatedAt),
    expectedProgressUpdatedAt: inputUtc(value.expectedProgressUpdatedAt),
    acceptedAfter: inputUtc(value.acceptedAfter),
  };
}

const FORBIDDEN_EFFECT_FIELDS = Object.freeze([
  "publish",
  "publication",
  "publicationEffects",
  "venuePriceRecords",
  "venueHappyHours",
  "reward",
  "rewardPoints",
  "contributionLedger",
  "pointsEligibleByLocation",
  "pointsAwarded",
  "rewardEligible",
  "publicationEligible",
  "publicEligible",
  "internalOnly",
] as const);

function normalizeInput(input: CreateVenueManagerInternalSubmissionInput): NormalizedInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
  assertExactKeys(input, [
    "id",
    "clientSubmissionId",
    "managerAccountId",
    "managerAssignmentId",
    "venueId",
    "venueName",
    "suburb",
    "submissionType",
    "observedAt",
    "evidenceIds",
    "ocrStatus",
    "ocrSummary",
    "notes",
    "location",
    "pendingVenue",
    "mission",
    "items",
    "safety",
    "now",
  ]);
  for (const field of FORBIDDEN_EFFECT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) return fail("invalid_input");
  }
  if (!input.safety || typeof input.safety !== "object" || Array.isArray(input.safety)) {
    return fail("invalid_input");
  }
  assertExactKeys(input.safety, ["internalOnly", "publicationEligible", "rewardEligible", "pointsAwarded"]);
  if (
    input.safety.internalOnly !== true
    || input.safety.publicationEligible !== false
    || input.safety.rewardEligible !== false
    || input.safety.pointsAwarded !== 0
  ) return fail("invalid_input");
  if (input.submissionType !== "happy_hour_update") return fail("invalid_input");

  const id = inputText(input.id, MAX_SUBMISSION_ID_LENGTH);
  const clientSubmissionId = inputText(input.clientSubmissionId, 100);
  if (!CLIENT_SUBMISSION_ID.test(clientSubmissionId)) return fail("invalid_input");
  const managerAccountId = inputText(input.managerAccountId);
  const managerAssignmentId = inputText(input.managerAssignmentId);
  const venueId = inputText(input.venueId);
  const venueName = inputText(input.venueName, 180);
  const suburb = inputOptionalText(input.suburb, 120);
  const now = inputUtc(input.now);
  const observedAt = inputUtc(input.observedAt);
  const observationAgeMs = Date.parse(now) - Date.parse(observedAt);
  if (observationAgeMs < -MAX_FUTURE_SKEW_MS || observationAgeMs > MAX_OBSERVATION_AGE_MS) {
    return fail("invalid_input");
  }

  const evidenceIds = [...(input.evidenceIds ?? [])].map((value) => inputText(value));
  if (evidenceIds.length > MAX_EVIDENCE || new Set(evidenceIds).size !== evidenceIds.length) return fail("invalid_input");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) return fail("invalid_input");
  const items = input.items.map((item, index) => normalizeItem(item, id, index));
  if (new Set(items.map((item) => item.id)).size !== items.length) return fail("invalid_input");
  const beerServingKeys = new Set<string>();
  for (const item of items) {
    const key = `${(item.normalizedBeerId ?? item.beerName.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}:${item.servingSize}`;
    if (beerServingKeys.has(key)) return fail("invalid_input");
    beerServingKeys.add(key);
  }

  const ocrStatus = input.ocrStatus ?? "not_requested";
  if (!["not_requested", "processed", "manual_review_required", "failed"].includes(ocrStatus)) {
    return fail("invalid_input");
  }
  const ocrSummary = normalizeOcrSummary(input.ocrSummary);
  const pendingVenue = normalizePendingVenue(input.pendingVenue);
  const mission = normalizeMission(input.mission);
  if (mission && Date.parse(mission.acceptedAfter) >= Date.parse(now)) return fail("invalid_input");

  return {
    id,
    clientSubmissionId,
    managerAccountId,
    managerAssignmentId,
    venueId,
    venueName,
    suburb,
    observedAt,
    evidenceIds,
    ocrStatus,
    ocrSummary,
    ocrSummaryJson: jsonText(ocrSummary as unknown as Record<string, unknown> | null),
    notes: inputOptionalText(input.notes, 2_000),
    location: normalizeLocation(input.location, now),
    pendingVenue,
    pendingVenueJson: jsonText(pendingVenue as unknown as Record<string, unknown> | null),
    mission,
    items,
    now,
  };
}

function toSubmission(row: SubmissionRow): VenueManagerInternalSubmission {
  const id = recordText(row.id, MAX_SUBMISSION_ID_LENGTH);
  const clientSubmissionId = recordText(row.clientSubmissionId, 100);
  if (!CLIENT_SUBMISSION_ID.test(clientSubmissionId)) return fail("malformed_record");
  if (recordText(row.status, 32) !== "pending" || recordText(row.submissionType, 64) !== "happy_hour_update") {
    return fail("malformed_record");
  }
  if (recordNumber(row.pointsAwarded, 0, 1_000_000) !== 0) return fail("malformed_record");
  if (recordBoolean(row.pointsEligibleByLocation)) return fail("malformed_record");
  if (recordText(row.pointsEligibilityReason, 500) !== INTERNAL_POINTS_REASON) return fail("malformed_record");
  if (row.reviewedBy != null || row.reviewedAt != null || row.rejectionReason != null || recordBoolean(row.fraudFlagged)) {
    return fail("malformed_record");
  }
  const ocrStatus = recordText(row.ocrStatus, 64);
  if (!["not_requested", "processed", "manual_review_required", "failed"].includes(ocrStatus)) {
    return fail("malformed_record");
  }
  const sourcePhotoUrl = recordOptionalText(row.sourcePhotoUrl, 600);
  if (sourcePhotoUrl != null && !sourcePhotoUrl.startsWith(PRIVATE_EVIDENCE_PREFIX)) return fail("malformed_record");
  return {
    id,
    clientSubmissionId,
    missionId: recordOptionalText(row.missionId, MAX_IDENTIFIER_LENGTH),
    userId: recordText(row.userId),
    venueId: recordText(row.venueId),
    venueName: recordText(row.venueName, 180),
    suburb: recordOptionalText(row.suburb, 120),
    status: "pending",
    submissionType: "happy_hour_update",
    observedAt: recordUtc(row.observedAt),
    sourcePhotoUrl,
    ocrStatus: ocrStatus as VenueManagerInternalOcrStatus,
    ocrSummary: recordOcrSummary(row.ocrSummaryJson),
    notes: recordOptionalText(row.notes, 2_000),
    pointsAwarded: 0,
    uploadLatitude: recordOptionalNumber(row.uploadLatitude, -90, 90),
    uploadLongitude: recordOptionalNumber(row.uploadLongitude, -180, 180),
    uploadAccuracyMeters: recordOptionalNumber(row.uploadAccuracyMeters, 0, 100_000),
    uploadLocationCapturedAt: recordOptionalUtc(row.uploadLocationCapturedAt),
    distanceToVenueMeters: recordOptionalNumber(row.distanceToVenueMeters, 0, 10_000_000),
    pointsEligibleByLocation: false,
    pointsEligibilityReason: INTERNAL_POINTS_REASON,
    pendingVenue: recordPendingVenue(row.pendingVenueJson),
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    fraudFlagged: false,
    internalOnly: true,
    createdAt: recordUtc(row.createdAt),
    updatedAt: recordUtc(row.updatedAt),
  };
}

function toItem(row: ItemRow): VenueManagerInternalSubmissionItem {
  const servingSize = recordText(row.servingSize, 32);
  if (!["pint", "pot", "schooner", "jug", "bottle", "can", "other"].includes(servingSize)) {
    return fail("malformed_record");
  }
  const isOnTap = recordText(row.isOnTap, 16);
  if (!["yes", "no", "unknown"].includes(isOnTap)) return fail("malformed_record");
  const captureSource = recordText(row.captureSource, 32);
  if (!["manual", "photo_ocr"].includes(captureSource)) return fail("malformed_record");
  const normalizedBeerId = recordOptionalText(row.normalizedBeerId, 160);
  if (normalizedBeerId != null && !NORMALIZED_BEER_ID.test(normalizedBeerId)) return fail("malformed_record");
  const isHappyHourPrice = recordBoolean(row.isHappyHourPrice);
  const happyHourDetails = recordOptionalText(row.happyHourDetails, 1_000);
  if (!isHappyHourPrice && !happyHourDetails) return fail("malformed_record");
  if (recordBoolean(row.requiresCatalogApproval)) return fail("malformed_record");
  const price = recordOptionalNumber(row.price, 0.01, 250);
  if (price != null && Math.abs(price * 100 - Math.round(price * 100)) >= 1e-8) return fail("malformed_record");
  return {
    id: recordText(row.id),
    submissionId: recordText(row.submissionId, MAX_SUBMISSION_ID_LENGTH),
    beerName: recordText(row.beerName, 120),
    normalizedBeerId,
    servingSize: servingSize as VenueManagerInternalServingSize,
    price,
    isHappyHourPrice,
    happyHourDetails,
    isOnTap: isOnTap as VenueManagerInternalTapStatus,
    confidence: recordNumber(row.confidence, 0, 1),
    captureSource: captureSource as VenueManagerInternalCaptureSource,
    sourceText: recordOptionalText(row.sourceText, 500),
    requiresCatalogApproval: false,
    createdAt: recordUtc(row.createdAt),
  };
}

function isHappyHourMissionReason(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[-_]+/g, " ");
  return normalized.includes("happy") || /\bhh\b/.test(normalized);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT";
}

function clientLockKey(userId: string, clientSubmissionId: string): string {
  const digest = crypto.createHash("sha256").update(`${userId}\0${clientSubmissionId}`).digest("hex");
  return `${CLIENT_LOCK_PREFIX}${digest}`;
}

function submissionLockKey(submissionId: string): string {
  const digest = crypto.createHash("sha256").update(submissionId).digest("hex");
  return `${SUBMISSION_LOCK_PREFIX}${digest}`;
}

/**
 * Provider-free, publication-free persistence for venue-manager happy-hour
 * intake. OCR, Storage/filesystem, geocoding, audit, analytics, and event work
 * must finish before or run after this short transaction.
 */
export class VenueManagerInternalSubmissionRepository {
  constructor(private readonly database: SqlDatabase) {}

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of [...new Set(keys)].sort()) {
      await this.database.prepare(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueManagerInternalSubmissionRepositoryError) throw error;
      if (isUniqueViolation(error)) return fail("submission_conflict");
      return fail("persistence_failure");
    }
  }

  private async accountRow(userId: string, lock: boolean): Promise<AccountRow | null> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id", account.role AS "role", account.status AS "status",
              account.auth_provider AS "authProvider",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${lock ? this.lockSuffix("account") : ""}`,
    ).get<AccountRow>(userId);
    return row ?? null;
  }

  private assertManagerAccount(row: AccountRow | null, expectedId: string): void {
    if (!row) return fail("account_not_found");
    if (recordText(row.id) !== expectedId) return fail("malformed_record");
    const authProvider = recordText(row.authProvider, 64);
    if (authProvider === "deleted" || recordBoolean(row.deletionLocked)) return fail("deletion_locked");
    if (recordText(row.status, 32) !== "active") return fail("account_ineligible");
    if (recordText(row.role, 64) !== "venue_manager") return fail("forbidden");
  }

  private async assignmentRow(id: string, lock: boolean): Promise<AssignmentRow | null> {
    const row = await this.database.prepare(
      `SELECT assignment.id AS "id", assignment.user_id AS "userId",
              assignment.venue_id AS "venueId", assignment.access_level AS "accessLevel",
              assignment.status AS "status", assignment.expires_at AS "expiresAt"
         FROM venue_manager_assignments assignment
        WHERE assignment.id = ?${lock ? this.lockSuffix("assignment") : ""}`,
    ).get<AssignmentRow>(id);
    return row ?? null;
  }

  private assertManagerAssignment(row: AssignmentRow | null, input: NormalizedInput): void {
    if (!row) return fail("assignment_not_found");
    if (recordText(row.id) !== input.managerAssignmentId) return fail("malformed_record");
    if (recordText(row.userId) !== input.managerAccountId) return fail("forbidden");
    if (recordText(row.venueId) !== input.venueId) return fail("wrong_venue");
    if (recordText(row.accessLevel, 32) !== "manager" || recordText(row.status, 32) !== "active") {
      return fail("assignment_not_active");
    }
    if (row.expiresAt != null) return fail("malformed_record");
  }

  private async missionRow(id: string): Promise<MissionRow | null> {
    const row = await this.database.prepare(
      `SELECT mission.id AS "id", mission.venue_id AS "venueId", mission.reason AS "reason",
              mission.active AS "active", mission.updated_at AS "updatedAt"
         FROM missions mission WHERE mission.id = ?${this.lockSuffix("mission")}`,
    ).get<MissionRow>(id);
    return row ?? null;
  }

  private async progressRow(missionId: string, userId: string): Promise<ProgressRow | null> {
    const row = await this.database.prepare(
      `SELECT progress.id AS "id", progress.mission_id AS "missionId",
              progress.user_id AS "userId", progress.submission_id AS "submissionId",
              progress.status AS "status", progress.accepted_at AS "acceptedAt",
              progress.submitted_at AS "submittedAt", progress.completed_at AS "completedAt",
              progress.updated_at AS "updatedAt"
         FROM mission_progress progress
        WHERE progress.mission_id = ? AND progress.user_id = ?
        LIMIT 1${this.lockSuffix("progress")}`,
    ).get<ProgressRow>(missionId, userId);
    return row ?? null;
  }

  private assertMission(
    input: NormalizedInput,
    missionRow: MissionRow | null,
    progressRow: ProgressRow | null,
  ): "accepted" | "submitted_replay" | null {
    const fence = input.mission;
    if (!fence) return null;
    if (!missionRow) return fail("mission_not_found");
    if (recordText(missionRow.id) !== fence.id) return fail("malformed_record");
    if (recordText(missionRow.venueId) !== input.venueId) return fail("mission_wrong_venue");
    if (!isHappyHourMissionReason(recordText(missionRow.reason, 2_000))) return fail("mission_not_happy_hour");
    if (!recordBoolean(missionRow.active)) return fail("mission_inactive");
    if (recordUtc(missionRow.updatedAt) !== fence.expectedMissionUpdatedAt) return fail("mission_stale");
    if (!progressRow) return fail("mission_not_accepted");
    if (
      recordText(progressRow.id) !== fence.progressId
      || recordText(progressRow.missionId) !== fence.id
      || recordText(progressRow.userId) !== input.managerAccountId
    ) return fail("mission_stale");
    const status = recordText(progressRow.status, 32);
    const acceptedAt = recordUtc(progressRow.acceptedAt);
    if (acceptedAt <= fence.acceptedAfter) return fail("mission_not_accepted");
    if (status === "accepted") {
      if (recordUtc(progressRow.updatedAt) !== fence.expectedProgressUpdatedAt) return fail("mission_stale");
      if (progressRow.submissionId != null || progressRow.submittedAt != null || progressRow.completedAt != null) {
        return fail("malformed_record");
      }
      return "accepted";
    }
    if (status === "submitted" && recordOptionalText(progressRow.submissionId, MAX_SUBMISSION_ID_LENGTH) === input.id) {
      if (recordOptionalUtc(progressRow.submittedAt) == null || progressRow.completedAt != null) return fail("malformed_record");
      return "submitted_replay";
    }
    return fail("mission_not_accepted");
  }

  private async lockAndValidateEvidence(input: NormalizedInput): Promise<void> {
    for (const id of [...input.evidenceIds].sort()) {
      const row = await this.database.prepare(
        `SELECT evidence.id AS "id", evidence.owner_user_id AS "ownerUserId",
                evidence.retention_expires_at AS "retentionExpiresAt",
                evidence.deleted_at AS "deletedAt", evidence.created_at AS "createdAt"
           FROM source_evidence_objects evidence
          WHERE evidence.id = ?${this.lockSuffix("evidence")}`,
      ).get<EvidenceRow>(id);
      if (!row) return fail("evidence_not_found");
      if (recordText(row.id) !== id) return fail("malformed_record");
      if (recordOptionalText(row.ownerUserId, MAX_IDENTIFIER_LENGTH) !== input.managerAccountId) {
        return fail("evidence_not_owned");
      }
      recordUtc(row.createdAt);
      const retentionExpiresAt = recordOptionalUtc(row.retentionExpiresAt);
      const deletedAt = recordOptionalUtc(row.deletedAt);
      if (deletedAt != null || retentionExpiresAt == null || retentionExpiresAt <= input.now) {
        return fail("evidence_not_live");
      }
    }
  }

  private async submissionCandidates(input: NormalizedInput): Promise<SubmissionRow[]> {
    return this.database.prepare(
      `SELECT ${SUBMISSION_PROJECTION}
         FROM submissions submission
        WHERE submission.id = @id
           OR (submission.user_id = @userId AND submission.client_submission_id = @clientSubmissionId)
        ORDER BY submission.id ASC${this.lockSuffix("submission")}`,
    ).all<SubmissionRow>({
      id: input.id,
      userId: input.managerAccountId,
      clientSubmissionId: input.clientSubmissionId,
    });
  }

  private async recordFromRow(row: SubmissionRow, lockChildren: boolean): Promise<VenueManagerInternalSubmissionRecord> {
    const submission = toSubmission(row);
    const itemRows = await this.database.prepare(
      `SELECT ${ITEM_PROJECTION}
         FROM submission_items item
        WHERE item.submission_id = ?
        ORDER BY item.id ASC${lockChildren ? this.lockSuffix("item") : ""}`,
    ).all<ItemRow>(submission.id);
    const linkRows = await this.database.prepare(
      `SELECT link.evidence_id AS "evidenceId", link.sort_order AS "sortOrder",
              link.created_at AS "createdAt"
         FROM submission_source_evidence link
        WHERE link.submission_id = ?
        ORDER BY link.sort_order ASC, link.evidence_id ASC${lockChildren ? this.lockSuffix("link") : ""}`,
    ).all<LinkRow>(submission.id);
    const evidenceIds = linkRows.map((link, index) => {
      if (recordInteger(link.sortOrder, 0, MAX_EVIDENCE - 1) !== index) return fail("malformed_record");
      recordUtc(link.createdAt);
      return recordText(link.evidenceId);
    });
    return {
      submission,
      items: itemRows.map(toItem),
      evidenceIds,
    };
  }

  private exactReplay(record: VenueManagerInternalSubmissionRecord, input: NormalizedInput): boolean {
    const submission = record.submission;
    const location = input.location;
    if (
      submission.id !== input.id
      || submission.clientSubmissionId !== input.clientSubmissionId
      || submission.userId !== input.managerAccountId
      || submission.venueId !== input.venueId
      || submission.venueName !== input.venueName
      || submission.suburb !== input.suburb
      || submission.missionId !== (input.mission?.id ?? null)
      || submission.observedAt !== input.observedAt
      || submission.sourcePhotoUrl !== (input.evidenceIds[0] ? `${PRIVATE_EVIDENCE_PREFIX}${input.evidenceIds[0]}` : null)
      || submission.ocrStatus !== input.ocrStatus
      || stableJson(submission.ocrSummary) !== stableJson(input.ocrSummary)
      || submission.notes !== input.notes
      || submission.uploadLatitude !== (location?.latitude ?? null)
      || submission.uploadLongitude !== (location?.longitude ?? null)
      || submission.uploadAccuracyMeters !== (location?.accuracyMeters ?? null)
      || submission.uploadLocationCapturedAt !== (location?.capturedAt ?? null)
      || submission.distanceToVenueMeters !== (location?.distanceToVenueMeters ?? null)
      || stableJson(submission.pendingVenue) !== stableJson(input.pendingVenue)
      || record.evidenceIds.join("\0") !== input.evidenceIds.join("\0")
      || record.items.length !== input.items.length
    ) return false;

    const byId = new Map(record.items.map((item) => [item.id, item]));
    return input.items.every((candidate) => {
      const item = byId.get(candidate.id);
      return item != null
        && item.submissionId === input.id
        && item.beerName === candidate.beerName
        && item.normalizedBeerId === candidate.normalizedBeerId
        && item.servingSize === candidate.servingSize
        && item.price === candidate.price
        && item.isHappyHourPrice === candidate.isHappyHourPrice
        && item.happyHourDetails === candidate.happyHourDetails
        && item.isOnTap === candidate.isOnTap
        && item.confidence === candidate.confidence
        && item.captureSource === candidate.captureSource
        && item.sourceText === candidate.sourceText
        && item.requiresCatalogApproval === false;
    });
  }

  private async finalEligibilityRecheck(input: NormalizedInput): Promise<void> {
    this.assertManagerAccount(await this.accountRow(input.managerAccountId, false), input.managerAccountId);
    this.assertManagerAssignment(await this.assignmentRow(input.managerAssignmentId, false), input);
  }

  async createInternalHappyHourSubmission(
    rawInput: CreateVenueManagerInternalSubmissionInput,
  ): Promise<CreateVenueManagerInternalSubmissionResult> {
    const input = normalizeInput(rawInput);
    return this.translate(this.database.transaction(async () => {
      await this.advisoryLocks([
        clientLockKey(input.managerAccountId, input.clientSubmissionId),
        submissionLockKey(input.id),
        venueAccessAccountLockKey(input.managerAccountId),
        sourceEvidenceAccountLockKey(input.managerAccountId),
        missionLifecycleAccountLockKey(input.managerAccountId),
        ...(input.mission ? [missionLifecycleMissionLockKey(input.mission.id)] : []),
      ]);

      this.assertManagerAccount(await this.accountRow(input.managerAccountId, true), input.managerAccountId);
      this.assertManagerAssignment(await this.assignmentRow(input.managerAssignmentId, true), input);

      const missionRow = input.mission ? await this.missionRow(input.mission.id) : null;
      const progressRow = input.mission
        ? await this.progressRow(input.mission.id, input.managerAccountId)
        : null;
      const missionState = this.assertMission(input, missionRow, progressRow);

      await this.lockAndValidateEvidence(input);

      const candidates = await this.submissionCandidates(input);
      if (candidates.length > 1) return fail("submission_conflict");
      const existing = candidates[0] ?? null;
      if (existing) {
        if (
          existing.id !== input.id
          || existing.clientSubmissionId !== input.clientSubmissionId
          || existing.userId !== input.managerAccountId
          || existing.status !== "pending"
          || existing.submissionType !== "happy_hour_update"
        ) return fail("submission_conflict");
        if (missionState === "accepted") return fail("submission_conflict");
        const record = await this.recordFromRow(existing, true);
        if (!this.exactReplay(record, input)) return fail("submission_conflict");
        await this.finalEligibilityRecheck(input);
        return { outcome: "replayed", record };
      }
      if (missionState === "submitted_replay") return fail("submission_conflict");

      const location = input.location;
      await this.database.prepare(
        `INSERT INTO submissions (
           id, client_submission_id, mission_id, user_id, venue_id, venue_name, suburb,
           status, submission_type, observed_at, source_photo_url, ocr_status, ocr_summary_json,
           notes, points_awarded, upload_latitude, upload_longitude, upload_accuracy_meters,
           upload_location_captured_at, distance_to_venue_meters, points_eligible_by_location,
           points_eligibility_reason, pending_venue_json, reviewed_by, reviewed_at,
           rejection_reason, fraud_flagged, created_at, updated_at
         ) VALUES (
           @id, @clientSubmissionId, @missionId, @userId, @venueId, @venueName, @suburb,
           'pending', 'happy_hour_update', @observedAt, @sourcePhotoUrl, @ocrStatus, @ocrSummaryJson,
           @notes, 0, @uploadLatitude, @uploadLongitude, @uploadAccuracyMeters,
           @uploadLocationCapturedAt, @distanceToVenueMeters, @falsity,
           @pointsEligibilityReason, @pendingVenueJson, NULL, NULL, NULL, @falsity, @now, @now
         )`,
      ).run({
        id: input.id,
        clientSubmissionId: input.clientSubmissionId,
        missionId: input.mission?.id ?? null,
        userId: input.managerAccountId,
        venueId: input.venueId,
        venueName: input.venueName,
        suburb: input.suburb,
        observedAt: input.observedAt,
        sourcePhotoUrl: input.evidenceIds[0] ? `${PRIVATE_EVIDENCE_PREFIX}${input.evidenceIds[0]}` : null,
        ocrStatus: input.ocrStatus,
        ocrSummaryJson: input.ocrSummaryJson,
        notes: input.notes,
        uploadLatitude: location?.latitude ?? null,
        uploadLongitude: location?.longitude ?? null,
        uploadAccuracyMeters: location?.accuracyMeters ?? null,
        uploadLocationCapturedAt: location?.capturedAt ?? null,
        distanceToVenueMeters: location?.distanceToVenueMeters ?? null,
        falsity: booleanBinding(this.database.dialect, false),
        pointsEligibilityReason: INTERNAL_POINTS_REASON,
        pendingVenueJson: input.pendingVenueJson,
        now: input.now,
      });

      if (input.mission) {
        const changed = await this.database.prepare(
          `UPDATE mission_progress
              SET submission_id = @submissionId, status = 'submitted', submitted_at = @now,
                  completed_at = NULL, updated_at = @now
            WHERE id = @progressId AND mission_id = @missionId AND user_id = @userId
              AND status = 'accepted' AND accepted_at > @acceptedAfter
              AND updated_at = @expectedProgressUpdatedAt AND submission_id IS NULL`,
        ).run({
          submissionId: input.id,
          progressId: input.mission.progressId,
          missionId: input.mission.id,
          userId: input.managerAccountId,
          acceptedAfter: input.mission.acceptedAfter,
          expectedProgressUpdatedAt: input.mission.expectedProgressUpdatedAt,
          now: input.now,
        });
        if (changed.changes !== 1) return fail("mission_stale");
      }

      for (const item of input.items) {
        await this.database.prepare(
          `INSERT INTO submission_items (
             id, submission_id, beer_name, normalized_beer_id, serving_size, price,
             is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
             capture_source, source_text, requires_catalog_approval, created_at
           ) VALUES (
             @id, @submissionId, @beerName, @normalizedBeerId, @servingSize, @price,
             @isHappyHourPrice, @happyHourDetails, @isOnTap, @confidence,
             @captureSource, @sourceText, @falsity, @now
           )`,
        ).run({
          ...item,
          submissionId: input.id,
          isHappyHourPrice: booleanBinding(this.database.dialect, item.isHappyHourPrice),
          falsity: booleanBinding(this.database.dialect, false),
          now: input.now,
        });
      }

      for (const [sortOrder, evidenceId] of input.evidenceIds.entries()) {
        await this.database.prepare(
          `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(input.id, evidenceId, sortOrder, input.now);
      }

      await this.finalEligibilityRecheck(input);
      const inserted = (await this.submissionCandidates(input))[0];
      if (!inserted) return fail("persistence_failure");
      const record = await this.recordFromRow(inserted, true);
      if (!this.exactReplay(record, input)) return fail("persistence_failure");
      return { outcome: "created", record };
    }));
  }
}
