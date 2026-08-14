import crypto from "node:crypto";

import type {
  BusinessSubmission,
  BusinessSubmissionItem,
  ConfidenceLabel,
  PendingVenueDetails,
  ServingSize,
  SubmissionItemCaptureSource,
  SubmissionOcrStatus,
  SubmissionOcrSummary,
  SubmissionStatus,
  SubmissionType,
  TapStatus,
  UserVerification,
} from "./business.repository.js";
import {
  missionLifecycleAccountLockKey,
  missionLifecycleMissionLockKey,
} from "./mission-lifecycle.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CALENDAR_MONTH = /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/;
const CATALOG_KEY = /^[a-z0-9][a-z0-9_]{0,159}$/;
const MAX_ITEMS = 60;
const MAX_EVIDENCE = 10;
const MAX_LIST_LIMIT = 100;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_MISSION_AUTHORITY_OWNERS = 1_000;
const COMMUNITY_CONFIDENCE_CONFIRMATION_THRESHOLD = 2;

export type CommunitySubmissionRepositoryErrorCode =
  | "account_not_eligible"
  | "account_not_found"
  | "approval_conflict"
  | "catalog_conflict"
  | "catalog_decision_stale"
  | "catalog_not_active"
  | "evidence_not_found"
  | "evidence_not_owned"
  | "idempotency_conflict"
  | "invalid_input"
  | "mission_reservation_invalid"
  | "mission_decision_stale"
  | "own_verification"
  | "persistence_failure"
  | "publication_required"
  | "publication_conflict"
  | "review_forbidden"
  | "submission_not_found"
  | "submission_not_reviewable"
  | "venue_decision_stale"
  | "verification_conflict";

const ERROR_MESSAGES: Readonly<Record<CommunitySubmissionRepositoryErrorCode, string>> = {
  account_not_eligible: "The account is not eligible to contribute community data.",
  account_not_found: "The account does not exist.",
  approval_conflict: "The submission was approved with a different review decision.",
  catalog_conflict: "The proposed beer catalogue identity conflicts with existing data.",
  catalog_decision_stale: "The reviewed beer catalogue decision is no longer current.",
  catalog_not_active: "The selected beer catalogue item is not active.",
  evidence_not_found: "The source evidence does not exist or is no longer available.",
  evidence_not_owned: "The source evidence is not owned by the submitting account.",
  idempotency_conflict: "The client submission identifier was already used for different content.",
  invalid_input: "The community persistence input is invalid.",
  mission_reservation_invalid: "The mission reservation is no longer available.",
  mission_decision_stale: "The reviewed mission state is no longer current.",
  own_verification: "An account cannot verify its own submission.",
  persistence_failure: "Community persistence could not be completed.",
  publication_required: "Approval requires the atomic publication repository before it can proceed.",
  publication_conflict: "The approved public record conflicts with existing publication state.",
  review_forbidden: "The account is not allowed to review this submission.",
  submission_not_found: "The submission does not exist.",
  submission_not_reviewable: "The submission is no longer reviewable.",
  venue_decision_stale: "The reviewed venue publication decision is no longer current.",
  verification_conflict: "This account has already verified the submission.",
};

/** Stable, deliberately detail-free failures for future service/HTTP mapping. */
export class CommunitySubmissionRepositoryError extends Error {
  readonly code: CommunitySubmissionRepositoryErrorCode;

  constructor(code: CommunitySubmissionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CommunitySubmissionRepositoryError";
    this.code = code;
  }
}

export type CommunityCatalogDecision =
  | { kind: "active_existing"; key: string }
  | {
      kind: "active_create" | "pending_create";
      key: string;
      canonicalName: string;
      aliasKey: string;
      alias: string;
      source: string;
      brewery?: string | null | undefined;
      style?: string | null | undefined;
      abv?: number | null | undefined;
    };

export interface CommunitySourceEvidence {
  id: string;
  ownerUserId: string | null;
  storageProvider: string;
  objectPath: string;
  mimeType: string | null;
  byteSize: number | null;
  externalUrl: string | null;
  retentionExpiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface CommunitySubmissionRecord {
  submission: BusinessSubmission;
  items: BusinessSubmissionItem[];
  evidence: Array<{ sortOrder: number; object: CommunitySourceEvidence }>;
}

export interface CommunityVerificationCandidate {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: Extract<SubmissionStatus, "pending" | "needs_more_evidence">;
  submissionType: Exclude<SubmissionType, "happy_hour_update">;
  observedAt: string;
  ocrStatus: SubmissionOcrStatus;
  createdAt: string;
  hasSourceEvidence: boolean;
  items: BusinessSubmissionItem[];
}

export interface CommunityReviewResult {
  submission: BusinessSubmission;
  submitter: {
    id: string;
    status: string;
    trustScore: number;
    rejectedSubmissionCount: number;
    fraudStrikeCount: number;
  };
}

export interface CommunityApprovalCatalogDecision {
  itemId: string;
  expectedCatalogKey: string;
  expectedCatalogUpdatedAt: string;
  activeCatalogKey: string;
  activeCatalogName: string;
  activeCatalogUpdatedAt: string;
}

export interface CommunityApprovalMissionDecision {
  missionId: string;
  missionUpdatedAt: string;
  progressId: string;
  progressUpdatedAt: string;
}

export interface CommunityApprovalVenueRequestDecision {
  requestId: string;
  status: "open" | "in_progress" | "mission_created";
  updatedAt: string;
  missionId: string | null;
  missionUpdatedAt: string | null;
}

export interface CommunityApprovalVenueDecision {
  pendingVenueHash: string;
  expectedVenueProfileUpdatedAt: string | null;
  expectedLocationUpdatedAt: string | null;
  requests: CommunityApprovalVenueRequestDecision[];
}

export interface CommunityApprovalEvidenceDecision {
  evidenceId: string;
  sortOrder: number;
  createdAt: string;
  retentionExpiresAt: string | null;
}

export interface CommunityApprovalSnapshot {
  record: CommunitySubmissionRecord;
  catalogDecisions: CommunityApprovalCatalogDecision[];
  missionDecision: CommunityApprovalMissionDecision | null;
  venueDecision: CommunityApprovalVenueDecision | null;
  evidenceDecisions: CommunityApprovalEvidenceDecision[];
}

export type CommunityApprovalFailureStage =
  | "after_locks"
  | "after_catalog"
  | "after_venue"
  | "after_public_prices"
  | "after_rewards"
  | "after_missions"
  | "before_finalize";

export interface CommunityApprovalResult {
  outcome: "applied" | "already_applied";
  submission: BusinessSubmission;
  pointsAwarded: number;
  submitter: {
    id: string;
    status: string;
    subscriptionStatus: string;
    trustScore: number;
    contributionPointsCurrentMonth: number;
    approvedSubmissionCount: number;
  };
  priceRecordIds: string[];
  resolvedVenueRequestIds: string[];
}

interface SubmissionRow {
  id: string;
  clientSubmissionId: string | null;
  missionId: string | null;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: string;
  submissionType: string;
  observedAt: string;
  sourcePhotoUrl: string | null;
  ocrStatus: string;
  ocrSummaryJson: unknown;
  notes: string | null;
  pointsAwarded: number | string;
  uploadLatitude: number | string | null;
  uploadLongitude: number | string | null;
  uploadAccuracyMeters: number | string | null;
  uploadLocationCapturedAt: string | null;
  distanceToVenueMeters: number | string | null;
  pointsEligibleByLocation: boolean | number;
  pointsEligibilityReason: string | null;
  pendingVenueJson: unknown;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  fraudFlagged: boolean | number;
  createdAt: string;
  updatedAt: string;
}

interface SubmissionItemRow {
  id: string;
  submissionId: string;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: string;
  price: number | string | null;
  isHappyHourPrice: boolean | number;
  happyHourDetails: string | null;
  isOnTap: string;
  confidence: number | string;
  captureSource: string;
  sourceText: string | null;
  requiresCatalogApproval: boolean | number;
  createdAt: string;
}

interface EvidenceRow {
  id: string;
  ownerUserId: string | null;
  storageProvider: string;
  objectPath: string;
  mimeType: string | null;
  byteSize: number | string | null;
  externalUrl: string | null;
  retentionExpiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  sortOrder?: number | string | undefined;
}

interface AccountRow {
  id: string;
  role: string;
  subscriptionStatus: string;
  authProvider: string;
  status: string;
  trustScore: number | string;
  contributionPointsCurrentMonth: number | string;
  approvedSubmissionCount: number | string;
  rejectedSubmissionCount: number | string;
  fraudStrikeCount: number | string;
  deletionLocked: boolean | number;
}

interface CatalogRow {
  key: string;
  name: string;
  brewery: string | null;
  style: string | null;
  abv: number | string | null;
  status: string;
  source: string;
  updatedAt: string;
}

interface MissionRow {
  id: string;
  venueId: string;
  active: boolean | number;
  updatedAt: string;
}

interface MissionProgressRow {
  id: string;
  missionId: string;
  userId: string;
  submissionId: string | null;
  status: string;
  updatedAt: string;
}

interface VenueProfileFenceRow {
  venueId: string;
  updatedAt: string;
}

interface VenueLocationFenceRow {
  venueId: string;
  updatedAt: string;
}

interface VenueRequestRow {
  id: string;
  googlePlaceId: string | null;
  status: string;
  missionId: string | null;
  updatedAt: string;
}

interface VerificationRow {
  id: string;
  verifierUserId: string;
  uploadId: string;
  targetEntityType: string;
  targetEntityId: string;
  result: string;
  notes: string | null;
  createdAt: string;
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

const EVIDENCE_PROJECTION = `
  evidence.id AS "id",
  evidence.owner_user_id AS "ownerUserId",
  evidence.storage_provider AS "storageProvider",
  evidence.object_path AS "objectPath",
  evidence.mime_type AS "mimeType",
  evidence.byte_size AS "byteSize",
  evidence.external_url AS "externalUrl",
  evidence.retention_expires_at AS "retentionExpiresAt",
  evidence.deleted_at AS "deletedAt",
  evidence.created_at AS "createdAt"`;

const VERIFICATION_PROJECTION = `
  verification.id AS "id",
  verification.verifier_user_id AS "verifierUserId",
  verification.upload_id AS "uploadId",
  verification.target_entity_type AS "targetEntityType",
  verification.target_entity_id AS "targetEntityId",
  verification.result AS "result",
  verification.notes AS "notes",
  verification.created_at AS "createdAt"`;

function fail(code: CommunitySubmissionRepositoryErrorCode): never {
  throw new CommunitySubmissionRepositoryError(code);
}

function requiredText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim().replace(/[ \t]+/g, " ");
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function optionalText(value: unknown, maximum = 255): string | null {
  return value == null ? null : requiredText(value, maximum);
}

function canonicalUtc(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_input");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) return fail("invalid_input");
    return value;
  } catch {
    return fail("invalid_input");
  }
}

function optionalCanonicalUtc(value: unknown): string | null {
  return value == null ? null : canonicalUtc(value);
}

function persistedUtc(value: unknown): string {
  if (typeof value !== "string") return fail("persistence_failure");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) return fail("persistence_failure");
    return value;
  } catch {
    return fail("persistence_failure");
  }
}

function optionalPersistedUtc(value: unknown): string | null {
  return value == null ? null : persistedUtc(value);
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function optionalFiniteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value == null ? null : finiteNumber(value, minimum, maximum);
}

function persistedNumber(value: number | string | null, minimum: number, maximum: number): number | null {
  if (value == null) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return fail("persistence_failure");
  return number;
}

function safeInteger(value: number | string, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) return fail("persistence_failure");
  return number;
}

function persistedBoolean(value: boolean | number): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("persistence_failure");
}

function inputInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return fail("persistence_failure"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("persistence_failure");
  return parsed as Record<string, unknown>;
}

function jsonText(value: Record<string, unknown> | null): string | null {
  if (value == null) return null;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) return fail("invalid_input");
    return serialized;
  } catch {
    return fail("invalid_input");
  }
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function communityPendingVenueFingerprint(value: PendingVenueDetails | null): string {
  return sha256(stableJson(value));
}

function approvalAuditId(submissionId: string): string {
  return `community-approval-${sha256(submissionId).slice(0, 40)}`;
}

function persistedNullableText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > maximum || /[\0]/.test(value)) return fail("persistence_failure");
  return value;
}

function persistedOcrSummary(value: unknown): SubmissionOcrSummary | null {
  const object = jsonObject(value);
  if (!object) return null;
  const integers = ["imageCount", "extractedRowCount", "rejectedCandidateCount", "pendingCatalogCount"] as const;
  for (const key of integers) {
    if (typeof object[key] !== "number" || !Number.isSafeInteger(object[key]) || (object[key] as number) < 0) {
      return fail("persistence_failure");
    }
  }
  return {
    model: persistedNullableText(object.model, 120),
    imageCount: object.imageCount as number,
    extractedRowCount: object.extractedRowCount as number,
    rejectedCandidateCount: object.rejectedCandidateCount as number,
    pendingCatalogCount: object.pendingCatalogCount as number,
    message: persistedNullableText(object.message, 500),
  };
}

function persistedPendingVenue(value: unknown): PendingVenueDetails | null {
  const object = jsonObject(value);
  if (!object) return null;
  if (typeof object.name !== "string" || !object.name || object.name.length > 200) return fail("persistence_failure");
  const persistedCoordinate = (coordinate: unknown, minimum: number, maximum: number): number | null => {
    if (coordinate == null) return null;
    const number = typeof coordinate === "number" ? coordinate : Number(coordinate);
    if (!Number.isFinite(number) || number < minimum || number > maximum) return fail("persistence_failure");
    return number;
  };
  return {
    googlePlaceId: persistedNullableText(object.googlePlaceId, 255),
    name: object.name,
    address: persistedNullableText(object.address, 500),
    suburb: persistedNullableText(object.suburb, 120),
    state: persistedNullableText(object.state, 80),
    postcode: persistedNullableText(object.postcode, 20),
    phone: persistedNullableText(object.phone, 40),
    website: persistedNullableText(object.website, 500),
    latitude: persistedCoordinate(object.latitude, -90, 90),
    longitude: persistedCoordinate(object.longitude, -180, 180),
  };
}

function booleanBinding(dialect: SqlDatabase["dialect"], value: boolean): boolean | number {
  return dialect === "postgres" ? value : value ? 1 : 0;
}

function normalizeCatalogKey(value: unknown): string {
  const key = requiredText(value, 160).toLowerCase();
  if (!CATALOG_KEY.test(key)) return fail("invalid_input");
  return key;
}

function normalizeOcrSummary(value: SubmissionOcrSummary | null | undefined): SubmissionOcrSummary | null {
  if (value == null) return null;
  const result = {
    model: optionalText(value.model, 120),
    imageCount: inputInteger(value.imageCount, 0, MAX_EVIDENCE),
    extractedRowCount: inputInteger(value.extractedRowCount, 0, MAX_ITEMS),
    rejectedCandidateCount: inputInteger(value.rejectedCandidateCount, 0, 1_000),
    pendingCatalogCount: inputInteger(value.pendingCatalogCount, 0, MAX_ITEMS),
    message: optionalText(value.message, 500),
  };
  jsonText(result as unknown as Record<string, unknown>);
  return result;
}

function normalizePendingVenue(value: PendingVenueDetails | null | undefined): PendingVenueDetails | null {
  if (value == null) return null;
  const normalized: PendingVenueDetails = {
    googlePlaceId: optionalText(value.googlePlaceId, 255),
    name: requiredText(value.name, 200),
    address: optionalText(value.address, 500),
    suburb: optionalText(value.suburb, 120),
    state: optionalText(value.state, 80),
    postcode: optionalText(value.postcode, 20),
    phone: optionalText(value.phone, 40),
    website: optionalText(value.website, 500),
    latitude: optionalFiniteNumber(value.latitude, -90, 90),
    longitude: optionalFiniteNumber(value.longitude, -180, 180),
  };
  jsonText(normalized as unknown as Record<string, unknown>);
  return normalized;
}

function persistedSubmission(row: SubmissionRow): BusinessSubmission {
  const statuses: SubmissionStatus[] = ["pending", "needs_more_evidence", "approved", "rejected", "disputed", "fraud_flagged"];
  const types: SubmissionType[] = ["single_beer_price", "full_venue_update", "happy_hour_update", "photo_upload"];
  const ocrStatuses: SubmissionOcrStatus[] = ["not_requested", "processed", "manual_review_required", "failed"];
  if (!statuses.includes(row.status as SubmissionStatus) || !types.includes(row.submissionType as SubmissionType)
      || !ocrStatuses.includes(row.ocrStatus as SubmissionOcrStatus)) return fail("persistence_failure");
  return {
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    missionId: row.missionId,
    userId: row.userId,
    venueId: row.venueId,
    venueName: row.venueName,
    suburb: row.suburb,
    status: row.status as SubmissionStatus,
    submissionType: row.submissionType as SubmissionType,
    observedAt: persistedUtc(row.observedAt),
    sourcePhotoUrl: row.sourcePhotoUrl,
    ocrStatus: row.ocrStatus as SubmissionOcrStatus,
    ocrSummary: persistedOcrSummary(row.ocrSummaryJson),
    notes: row.notes,
    pointsAwarded: persistedNumber(row.pointsAwarded, 0, 1_000_000) ?? 0,
    uploadLatitude: persistedNumber(row.uploadLatitude, -90, 90),
    uploadLongitude: persistedNumber(row.uploadLongitude, -180, 180),
    uploadAccuracyMeters: persistedNumber(row.uploadAccuracyMeters, 0, 100_000),
    uploadLocationCapturedAt: optionalPersistedUtc(row.uploadLocationCapturedAt),
    distanceToVenueMeters: persistedNumber(row.distanceToVenueMeters, 0, 10_000_000),
    pointsEligibleByLocation: persistedBoolean(row.pointsEligibleByLocation),
    pointsEligibilityReason: row.pointsEligibilityReason,
    pendingVenue: persistedPendingVenue(row.pendingVenueJson),
    reviewedBy: row.reviewedBy,
    reviewedAt: optionalPersistedUtc(row.reviewedAt),
    rejectionReason: row.rejectionReason,
    fraudFlagged: persistedBoolean(row.fraudFlagged),
    createdAt: persistedUtc(row.createdAt),
    updatedAt: persistedUtc(row.updatedAt),
  };
}

function persistedItem(row: SubmissionItemRow): BusinessSubmissionItem {
  const sizes: ServingSize[] = ["pint", "pot", "schooner", "jug", "bottle", "can", "other"];
  const taps: TapStatus[] = ["yes", "no", "unknown"];
  const sources: SubmissionItemCaptureSource[] = ["manual", "photo_ocr"];
  if (!sizes.includes(row.servingSize as ServingSize) || !taps.includes(row.isOnTap as TapStatus)
      || !sources.includes(row.captureSource as SubmissionItemCaptureSource)) return fail("persistence_failure");
  return {
    id: row.id,
    submissionId: row.submissionId,
    beerName: row.beerName,
    normalizedBeerId: row.normalizedBeerId,
    servingSize: row.servingSize as ServingSize,
    price: persistedNumber(row.price, 0, 10_000),
    isHappyHourPrice: persistedBoolean(row.isHappyHourPrice),
    happyHourDetails: row.happyHourDetails,
    isOnTap: row.isOnTap as TapStatus,
    confidence: persistedNumber(row.confidence, 0, 1) ?? 0,
    captureSource: row.captureSource as SubmissionItemCaptureSource,
    sourceText: row.sourceText,
    requiresCatalogApproval: persistedBoolean(row.requiresCatalogApproval),
    createdAt: persistedUtc(row.createdAt),
  };
}

function persistedEvidence(row: EvidenceRow): CommunitySourceEvidence {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    storageProvider: row.storageProvider,
    objectPath: row.objectPath,
    mimeType: row.mimeType,
    byteSize: row.byteSize == null ? null : safeInteger(row.byteSize),
    externalUrl: row.externalUrl,
    retentionExpiresAt: optionalPersistedUtc(row.retentionExpiresAt),
    deletedAt: optionalPersistedUtc(row.deletedAt),
    createdAt: persistedUtc(row.createdAt),
  };
}

function persistedVerification(row: VerificationRow): UserVerification {
  if (!["confirmed", "disputed", "needs_more_evidence"].includes(row.result)
      || row.targetEntityType !== "submission" || row.targetEntityId !== row.uploadId) {
    return fail("persistence_failure");
  }
  return {
    id: row.id,
    verifierUserId: row.verifierUserId,
    uploadId: row.uploadId,
    targetEntityType: row.targetEntityType,
    targetEntityId: row.targetEntityId,
    result: row.result,
    notes: persistedNullableText(row.notes, 1_000),
    createdAt: persistedUtc(row.createdAt),
  };
}

interface NormalizedItem {
  id: string;
  servingSize: ServingSize;
  price: number | null;
  isOnTap: TapStatus;
  confidence: number;
  captureSource: SubmissionItemCaptureSource;
  sourceText: string | null;
  catalog: CommunityCatalogDecision;
}

function normalizeItem(input: {
  id: string;
  catalog: CommunityCatalogDecision;
  servingSize: ServingSize;
  price: number | null;
  isHappyHourPrice?: boolean | undefined;
  happyHourDetails?: string | null | undefined;
  isOnTap: TapStatus;
  confidence: number;
  captureSource?: SubmissionItemCaptureSource | undefined;
  sourceText?: string | null | undefined;
}): NormalizedItem {
  if (input.isHappyHourPrice || input.happyHourDetails != null) return fail("invalid_input");
  if (!["pint", "pot", "schooner", "jug", "bottle", "can", "other"].includes(input.servingSize)) return fail("invalid_input");
  if (!["yes", "no", "unknown"].includes(input.isOnTap)) return fail("invalid_input");
  const captureSource = input.captureSource ?? "manual";
  if (captureSource !== "manual" && captureSource !== "photo_ocr") return fail("invalid_input");
  const key = normalizeCatalogKey(input.catalog.key);
  let catalog: CommunityCatalogDecision;
  if (input.catalog.kind === "active_existing") {
    catalog = { kind: "active_existing", key };
  } else if (input.catalog.kind === "active_create" || input.catalog.kind === "pending_create") {
    catalog = {
      kind: input.catalog.kind,
      key,
      canonicalName: requiredText(input.catalog.canonicalName, 200),
      aliasKey: normalizeCatalogKey(input.catalog.aliasKey),
      alias: requiredText(input.catalog.alias, 200),
      source: requiredText(input.catalog.source, 120),
      brewery: optionalText(input.catalog.brewery, 160),
      style: optionalText(input.catalog.style, 160),
      abv: optionalFiniteNumber(input.catalog.abv, 0, 30),
    };
  } else {
    return fail("invalid_input");
  }
  return {
    id: requiredText(input.id),
    catalog,
    servingSize: input.servingSize,
    price: optionalFiniteNumber(input.price, 0, 10_000),
    isOnTap: input.isOnTap,
    confidence: finiteNumber(input.confidence, 0, 1),
    captureSource,
    sourceText: optionalText(input.sourceText, 500),
  };
}

/**
 * Async, PostgreSQL-ready persistence for private community intake and
 * fail-closed moderation. Provider/storage/OCR/geocoding calls must finish
 * before these methods are invoked. Generic review rejects approval; callers
 * must use the explicit approval operation so catalog mapping, venue and price
 * publication, rewards, and mission completion share one SqlDatabase
 * transaction.
 */
export class CommunitySubmissionRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly options: { allowApprovalFailureInjection?: boolean | undefined } = {},
  ) {}

  private injectApprovalFailure(
    requested: CommunityApprovalFailureStage | null,
    current: CommunityApprovalFailureStage,
  ): void {
    if (requested !== current) return;
    if (!this.options.allowApprovalFailureInjection) return fail("invalid_input");
    throw new Error(`approval rollback injection: ${current}`);
  }

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CommunitySubmissionRepositoryError) throw error;
      return fail("persistence_failure");
    }
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of [...new Set(keys)].sort()) {
      await this.database.prepare("SELECT pg_advisory_xact_lock(hashtext(?)) AS \"locked\"").get(key);
    }
  }

  private async submissionRowById(id: string, lock = false): Promise<SubmissionRow | null> {
    const row = await this.database.prepare(
      `SELECT ${SUBMISSION_PROJECTION}
         FROM submissions submission
        WHERE submission.id = ?${lock ? this.lockSuffix("submission") : ""}`,
    ).get<SubmissionRow>(id);
    return row ?? null;
  }

  private async submissionRowByClient(userId: string, clientSubmissionId: string, lock = false): Promise<SubmissionRow | null> {
    const row = await this.database.prepare(
      `SELECT ${SUBMISSION_PROJECTION}
         FROM submissions submission
        WHERE submission.user_id = ? AND submission.client_submission_id = ?
        LIMIT 1${lock ? this.lockSuffix("submission") : ""}`,
    ).get<SubmissionRow>(userId, clientSubmissionId);
    return row ?? null;
  }

  private async itemRowsForSubmission(id: string, lock = false): Promise<SubmissionItemRow[]> {
    const rows = await this.database.prepare(
      `SELECT ${ITEM_PROJECTION}
         FROM submission_items item
        WHERE item.submission_id = ?
        ORDER BY item.created_at ASC, item.id ASC${lock ? this.lockSuffix("item") : ""}`,
    ).all<SubmissionItemRow>(id);
    return rows;
  }

  private async itemsForSubmission(id: string): Promise<BusinessSubmissionItem[]> {
    return (await this.itemRowsForSubmission(id)).map(persistedItem);
  }

  private async evidenceForSubmission(id: string): Promise<Array<{ sortOrder: number; object: CommunitySourceEvidence }>> {
    const rows = await this.database.prepare(
      `SELECT ${EVIDENCE_PROJECTION}, link.sort_order AS "sortOrder"
         FROM submission_source_evidence link
         INNER JOIN source_evidence_objects evidence ON evidence.id = link.evidence_id
        WHERE link.submission_id = ?
        ORDER BY link.sort_order ASC, evidence.id ASC`,
    ).all<EvidenceRow>(id);
    return rows.map((row) => ({ sortOrder: safeInteger(row.sortOrder ?? 0, MAX_EVIDENCE - 1), object: persistedEvidence(row) }));
  }

  private async recordFromRow(row: SubmissionRow): Promise<CommunitySubmissionRecord> {
    const [items, evidence] = await Promise.all([
      this.itemsForSubmission(row.id),
      this.evidenceForSubmission(row.id),
    ]);
    return { submission: persistedSubmission(row), items, evidence };
  }

  private async accountRows(ids: readonly string[]): Promise<AccountRow[]> {
    const result: AccountRow[] = [];
    for (const id of [...new Set(ids)].sort()) {
      const row = await this.database.prepare(
        `SELECT
           account.id AS "id", account.role AS "role",
           account.subscription_status AS "subscriptionStatus",
           account.auth_provider AS "authProvider", account.status AS "status",
           account.trust_score AS "trustScore",
           account.contribution_points_current_month AS "contributionPointsCurrentMonth",
           account.approved_submission_count AS "approvedSubmissionCount",
           account.rejected_submission_count AS "rejectedSubmissionCount",
           account.fraud_strike_count AS "fraudStrikeCount",
           EXISTS (
             SELECT 1 FROM account_deletion_requests deletion
              WHERE deletion.user_id = account.id
                AND deletion.status IN ('processing', 'failed', 'completed')
           ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${this.lockSuffix("account")}`,
      ).get<AccountRow>(id);
      if (row) result.push(row);
    }
    return result;
  }

  private async catalogRows(keys: readonly string[]): Promise<Map<string, CatalogRow>> {
    const result = new Map<string, CatalogRow>();
    for (const key of [...new Set(keys)].sort()) {
      const row = await this.database.prepare(
        `SELECT catalog.key AS "key", catalog.name AS "name", catalog.brewery AS "brewery",
                catalog.style AS "style", catalog.abv AS "abv", catalog.status AS "status",
                catalog.source AS "source", catalog.updated_at AS "updatedAt"
           FROM beer_catalog_items catalog
          WHERE catalog.key = ?${this.lockSuffix("catalog")}`,
      ).get<CatalogRow>(key);
      if (row) result.set(key, row);
    }
    return result;
  }

  private async missionRows(ids: readonly string[]): Promise<Map<string, MissionRow>> {
    const result = new Map<string, MissionRow>();
    for (const id of [...new Set(ids)].sort()) {
      const row = await this.database.prepare(
        `SELECT mission.id AS "id", mission.venue_id AS "venueId",
                mission.active AS "active", mission.updated_at AS "updatedAt"
           FROM missions mission WHERE mission.id = ?${this.lockSuffix("mission")}`,
      ).get<MissionRow>(id);
      if (row) result.set(id, row);
    }
    return result;
  }

  private async missionProgressRows(ids: readonly string[]): Promise<Map<string, MissionProgressRow[]>> {
    const result = new Map<string, MissionProgressRow[]>();
    for (const id of [...new Set(ids)].sort()) {
      const rows = await this.database.prepare(
        `SELECT progress.id AS "id", progress.mission_id AS "missionId",
                progress.user_id AS "userId", progress.submission_id AS "submissionId",
                progress.status AS "status", progress.updated_at AS "updatedAt"
           FROM mission_progress progress WHERE progress.mission_id = ?
          ORDER BY progress.id ASC${this.lockSuffix("progress")}`,
      ).all<MissionProgressRow>(id);
      result.set(id, rows);
    }
    return result;
  }

  private async missionAuthorityOwnerIds(ids: readonly string[]): Promise<string[]> {
    const owners = new Set<string>();
    for (const id of [...new Set(ids)].sort()) {
      const progressOwners = await this.database.prepare(
        `SELECT DISTINCT progress.user_id AS "userId"
           FROM mission_progress progress
          WHERE progress.mission_id = ?
          ORDER BY progress.user_id ASC
          LIMIT ?`,
      ).all<{ userId: string }>(id, MAX_MISSION_AUTHORITY_OWNERS + 1);
      const submissionOwners = await this.database.prepare(
        `SELECT DISTINCT submission.user_id AS "userId"
           FROM submissions submission
          WHERE submission.mission_id = ?
            AND submission.status IN ('pending', 'needs_more_evidence')
          ORDER BY submission.user_id ASC
          LIMIT ?`,
      ).all<{ userId: string }>(id, MAX_MISSION_AUTHORITY_OWNERS + 1);
      if (
        progressOwners.length > MAX_MISSION_AUTHORITY_OWNERS
        || submissionOwners.length > MAX_MISSION_AUTHORITY_OWNERS
      ) return fail("mission_decision_stale");
      for (const row of [...progressOwners, ...submissionOwners]) {
        owners.add(requiredText(row.userId));
        if (owners.size > MAX_MISSION_AUTHORITY_OWNERS) return fail("mission_decision_stale");
      }
    }
    return [...owners].sort();
  }

  async deleteUnlinkedSourceEvidence(input: { id: string; ownerUserId: string; deletedAt: string }): Promise<boolean> {
    const id = requiredText(input.id);
    const ownerUserId = requiredText(input.ownerUserId);
    const deletedAt = canonicalUtc(input.deletedAt);
    return this.translate(async () => {
      const result = await this.database.prepare(
        `UPDATE source_evidence_objects
            SET data_base64 = NULL,
                external_url = NULL,
                byte_size = NULL,
                deleted_at = @deletedAt
          WHERE id = @id AND owner_user_id = @ownerUserId AND deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM submission_source_evidence link WHERE link.evidence_id = source_evidence_objects.id
            )`,
      ).run({ id, ownerUserId, deletedAt });
      return result.changes === 1;
    });
  }

  async getSubmissionById(id: string): Promise<CommunitySubmissionRecord | null> {
    const submissionId = requiredText(id);
    return this.translate(async () => {
      const row = await this.submissionRowById(submissionId);
      return row ? this.recordFromRow(row) : null;
    });
  }

  /**
   * Captures the immutable database decisions required by approval. This is a
   * read-only preflight: approveAndPublishSubmission locks and revalidates every
   * version before making the first mutation.
   */
  async getApprovalSnapshot(submissionIdInput: string): Promise<CommunityApprovalSnapshot> {
    const submissionId = requiredText(submissionIdInput);
    return this.translate(async () => {
      const row = await this.submissionRowById(submissionId);
      if (!row) return fail("submission_not_found");
      const record = await this.recordFromRow(row);
      const catalogDecisions: CommunityApprovalCatalogDecision[] = [];
      for (const item of [...record.items].sort((left, right) => left.id.localeCompare(right.id))) {
        const key = item.normalizedBeerId ? normalizeCatalogKey(item.normalizedBeerId) : null;
        if (!key) return fail("catalog_decision_stale");
        const catalog = await this.database.prepare(
          `SELECT catalog.key AS "key", catalog.name AS "name", catalog.brewery AS "brewery",
                  catalog.style AS "style", catalog.abv AS "abv", catalog.status AS "status",
                  catalog.source AS "source", catalog.updated_at AS "updatedAt"
             FROM beer_catalog_items catalog WHERE catalog.key = ?`,
        ).get<CatalogRow>(key);
        if (!catalog || catalog.status !== "active") return fail("catalog_decision_stale");
        const updatedAt = persistedUtc(catalog.updatedAt);
        catalogDecisions.push({
          itemId: item.id,
          expectedCatalogKey: key,
          expectedCatalogUpdatedAt: updatedAt,
          activeCatalogKey: key,
          activeCatalogName: catalog.name,
          activeCatalogUpdatedAt: updatedAt,
        });
      }

      let missionDecision: CommunityApprovalMissionDecision | null = null;
      if (record.submission.missionId) {
        const mission = await this.database.prepare(
          `SELECT mission.id AS "id", mission.venue_id AS "venueId",
                  mission.active AS "active", mission.updated_at AS "updatedAt"
             FROM missions mission WHERE mission.id = ?`,
        ).get<MissionRow>(record.submission.missionId);
        const progress = await this.database.prepare(
          `SELECT progress.id AS "id", progress.mission_id AS "missionId",
                  progress.user_id AS "userId", progress.submission_id AS "submissionId",
                  progress.status AS "status", progress.updated_at AS "updatedAt"
             FROM mission_progress progress
            WHERE progress.mission_id = ? AND progress.user_id = ?
              AND progress.submission_id = ?
            ORDER BY progress.id ASC LIMIT 1`,
        ).get<MissionProgressRow>(
          record.submission.missionId,
          record.submission.userId,
          submissionId,
        );
        if (!mission || !progress || !persistedBoolean(mission.active)
            || mission.venueId !== record.submission.venueId || progress.status !== "submitted") {
          return fail("mission_decision_stale");
        }
        missionDecision = {
          missionId: mission.id,
          missionUpdatedAt: persistedUtc(mission.updatedAt),
          progressId: progress.id,
          progressUpdatedAt: persistedUtc(progress.updatedAt),
        };
      }

      let venueDecision: CommunityApprovalVenueDecision | null = null;
      if (record.submission.pendingVenue) {
        const profile = await this.database.prepare(
          `SELECT venue.venue_id AS "venueId", venue.updated_at AS "updatedAt"
             FROM venue_profiles venue WHERE venue.venue_id = ?`,
        ).get<VenueProfileFenceRow>(record.submission.venueId);
        const location = await this.database.prepare(
          `SELECT location.venue_id AS "venueId", location.updated_at AS "updatedAt"
             FROM venue_location_cache location WHERE location.venue_id = ?`,
        ).get<VenueLocationFenceRow>(record.submission.venueId);
        const requests: CommunityApprovalVenueRequestDecision[] = [];
        if (record.submission.pendingVenue.googlePlaceId) {
          const rows = await this.database.prepare(
            `SELECT request.id AS "id", request.google_place_id AS "googlePlaceId",
                    request.status AS "status", request.mission_id AS "missionId",
                    request.updated_at AS "updatedAt"
               FROM venue_requests request
              WHERE request.request_type = 'missing_venue'
                AND request.google_place_id = ?
                AND request.status IN ('open', 'in_progress', 'mission_created')
              ORDER BY request.id ASC`,
          ).all<VenueRequestRow>(record.submission.pendingVenue.googlePlaceId);
          for (const request of rows) {
            if (!['open', 'in_progress', 'mission_created'].includes(request.status)) {
              return fail("venue_decision_stale");
            }
            let missionUpdatedAt: string | null = null;
            if (request.missionId) {
              const mission = await this.database.prepare(
                `SELECT mission.id AS "id", mission.venue_id AS "venueId",
                        mission.active AS "active", mission.updated_at AS "updatedAt"
                   FROM missions mission WHERE mission.id = ?`,
              ).get<MissionRow>(request.missionId);
              if (!mission || !persistedBoolean(mission.active)) return fail("mission_decision_stale");
              missionUpdatedAt = persistedUtc(mission.updatedAt);
            }
            requests.push({
              requestId: request.id,
              status: request.status as CommunityApprovalVenueRequestDecision["status"],
              updatedAt: persistedUtc(request.updatedAt),
              missionId: request.missionId,
              missionUpdatedAt,
            });
          }
        }
        venueDecision = {
          pendingVenueHash: communityPendingVenueFingerprint(record.submission.pendingVenue),
          expectedVenueProfileUpdatedAt: profile ? persistedUtc(profile.updatedAt) : null,
          expectedLocationUpdatedAt: location ? persistedUtc(location.updatedAt) : null,
          requests,
        };
      }

      const evidenceDecisions = record.evidence.map((entry) => ({
        evidenceId: entry.object.id,
        sortOrder: entry.sortOrder,
        createdAt: entry.object.createdAt,
        retentionExpiresAt: entry.object.retentionExpiresAt,
      }));
      return { record, catalogDecisions, missionDecision, venueDecision, evidenceDecisions };
    });
  }

  async getSubmissionByClientSubmissionId(userId: string, clientSubmissionId: string): Promise<CommunitySubmissionRecord | null> {
    const normalizedUser = requiredText(userId);
    const normalizedClient = requiredText(clientSubmissionId, 160);
    return this.translate(async () => {
      const row = await this.submissionRowByClient(normalizedUser, normalizedClient);
      return row ? this.recordFromRow(row) : null;
    });
  }

  async listSubmissions(input: {
    userId?: string | undefined;
    status?: SubmissionStatus | undefined;
    limit: number;
    offset?: number | undefined;
  }): Promise<CommunitySubmissionRecord[]> {
    const userId = input.userId == null ? null : requiredText(input.userId);
    const statuses: SubmissionStatus[] = ["pending", "needs_more_evidence", "approved", "rejected", "disputed", "fraud_flagged"];
    if (input.status != null && !statuses.includes(input.status)) return fail("invalid_input");
    const limit = inputInteger(input.limit, 1, MAX_LIST_LIMIT);
    const offset = inputInteger(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${SUBMISSION_PROJECTION}
           FROM submissions submission
          WHERE (@userId IS NULL OR submission.user_id = @userId)
            AND (@status IS NULL OR submission.status = @status)
          ORDER BY submission.created_at DESC, submission.id DESC
          LIMIT @limit OFFSET @offset`,
      ).all<SubmissionRow>({ userId, status: input.status ?? null, limit, offset });
      const records: CommunitySubmissionRecord[] = [];
      for (const row of rows) records.push(await this.recordFromRow(row));
      return records;
    });
  }

  async countSubmissions(input: { userId?: string | undefined; status?: SubmissionStatus | undefined }): Promise<number> {
    const userId = input.userId == null ? null : requiredText(input.userId);
    const statuses: SubmissionStatus[] = ["pending", "needs_more_evidence", "approved", "rejected", "disputed", "fraud_flagged"];
    if (input.status != null && !statuses.includes(input.status)) return fail("invalid_input");
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count" FROM submissions submission
          WHERE (@userId IS NULL OR submission.user_id = @userId)
            AND (@status IS NULL OR submission.status = @status)`,
      ).get<{ count: number | string }>({ userId, status: input.status ?? null });
      return row ? safeInteger(row.count) : 0;
    });
  }

  async getContributionPointsForMonth(userIdValue: string, monthKeyValue: string): Promise<number> {
    const userId = requiredText(userIdValue);
    const monthKey = requiredText(monthKeyValue, 7);
    if (!CALENDAR_MONTH.test(monthKey)) return fail("invalid_input");
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT COALESCE(sum(ledger.points), 0) AS "points"
           FROM contribution_ledger ledger
          WHERE ledger.user_id = ? AND ledger.month_key = ?`,
      ).get<{ points: number | string }>(userId, monthKey);
      return persistedNumber(row?.points ?? 0, 0, 1_000_000_000) ?? 0;
    });
  }

  async createSubmission(input: {
    id: string;
    clientSubmissionId: string;
    missionId?: string | null | undefined;
    missionAcceptedAfter?: string | undefined;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    submissionType: Exclude<SubmissionType, "happy_hour_update">;
    observedAt: string;
    evidenceIds?: string[] | undefined;
    ocrStatus?: SubmissionOcrStatus | undefined;
    ocrSummary?: SubmissionOcrSummary | null | undefined;
    notes: string | null;
    uploadLatitude?: number | null | undefined;
    uploadLongitude?: number | null | undefined;
    uploadAccuracyMeters?: number | null | undefined;
    uploadLocationCapturedAt?: string | null | undefined;
    distanceToVenueMeters?: number | null | undefined;
    pointsEligibleByLocation?: boolean | undefined;
    pointsEligibilityReason?: string | null | undefined;
    pendingVenue?: PendingVenueDetails | null | undefined;
    items: Array<{
      id: string;
      catalog: CommunityCatalogDecision;
      servingSize: ServingSize;
      price: number | null;
      isHappyHourPrice?: boolean | undefined;
      happyHourDetails?: string | null | undefined;
      isOnTap: TapStatus;
      confidence: number;
      captureSource?: SubmissionItemCaptureSource | undefined;
      sourceText?: string | null | undefined;
    }>;
    now: string;
  }): Promise<{ record: CommunitySubmissionRecord; replayed: boolean }> {
    const id = requiredText(input.id);
    const clientSubmissionId = requiredText(input.clientSubmissionId, 160);
    const userId = requiredText(input.userId);
    const venueId = requiredText(input.venueId);
    const venueName = requiredText(input.venueName, 200);
    const suburb = optionalText(input.suburb, 120);
    if (!["single_beer_price", "full_venue_update", "photo_upload"].includes(input.submissionType)) return fail("invalid_input");
    const observedAt = canonicalUtc(input.observedAt);
    const now = canonicalUtc(input.now);
    const missionId = optionalText(input.missionId);
    const missionAcceptedAfter = input.missionAcceptedAfter == null ? null : canonicalUtc(input.missionAcceptedAfter);
    if (Boolean(missionId) !== Boolean(missionAcceptedAfter)) return fail("invalid_input");
    const evidenceIds = (input.evidenceIds ?? []).map((value) => requiredText(value));
    if (evidenceIds.length > MAX_EVIDENCE || new Set(evidenceIds).size !== evidenceIds.length) return fail("invalid_input");
    if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) return fail("invalid_input");
    if (input.items.length < 1 && (input.submissionType !== "photo_upload" || evidenceIds.length < 1)) {
      return fail("invalid_input");
    }
    const items = input.items.map(normalizeItem).sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(items.map((item) => item.id)).size !== items.length) return fail("invalid_input");
    const ocrStatus = input.ocrStatus ?? "not_requested";
    if (!["not_requested", "processed", "manual_review_required", "failed"].includes(ocrStatus)) return fail("invalid_input");
    const ocrSummary = normalizeOcrSummary(input.ocrSummary);
    const pendingVenue = normalizePendingVenue(input.pendingVenue);
    const notes = optionalText(input.notes, 2_000);
    const uploadLatitude = optionalFiniteNumber(input.uploadLatitude, -90, 90);
    const uploadLongitude = optionalFiniteNumber(input.uploadLongitude, -180, 180);
    if ((uploadLatitude == null) !== (uploadLongitude == null)) return fail("invalid_input");
    const uploadAccuracyMeters = optionalFiniteNumber(input.uploadAccuracyMeters, 0, 100_000);
    const uploadLocationCapturedAt = optionalCanonicalUtc(input.uploadLocationCapturedAt);
    const distanceToVenueMeters = optionalFiniteNumber(input.distanceToVenueMeters, 0, 10_000_000);
    const pointsEligibleByLocation = input.pointsEligibleByLocation ?? false;
    if (typeof pointsEligibleByLocation !== "boolean") return fail("invalid_input");
    const pointsEligibilityReason = optionalText(input.pointsEligibilityReason, 500);
    const ocrSummaryJson = jsonText(ocrSummary as unknown as Record<string, unknown> | null);
    const pendingVenueJson = jsonText(pendingVenue as unknown as Record<string, unknown> | null);

    return this.translate(this.database.transaction(async () => {
      await this.advisoryLocks([
        `community-client:${userId}:${clientSubmissionId}`,
        `community-venue:${venueId}`,
        ...(missionId ? [
          missionLifecycleAccountLockKey(userId),
          missionLifecycleMissionLockKey(missionId),
        ] : []),
        ...items.flatMap((item) => [
          `community-catalog:${item.catalog.key}`,
          ...(item.catalog.kind !== "active_existing" ? [`community-alias:${item.catalog.aliasKey}`] : []),
        ]),
      ]);
      const existing = await this.submissionRowByClient(userId, clientSubmissionId, true);
      if (existing) {
        const record = await this.recordFromRow(existing);
        const persisted = record.submission;
        const sameCore = existing.venueId === venueId
          && existing.venueName === venueName
          && existing.suburb === suburb
          && existing.submissionType === input.submissionType
          && existing.observedAt === observedAt
          && existing.notes === notes
          && existing.missionId === missionId
          && existing.sourcePhotoUrl === (evidenceIds[0] ? `private:evidence:${evidenceIds[0]}` : null)
          && persisted.ocrStatus === ocrStatus
          && stableJson(persisted.ocrSummary) === stableJson(ocrSummary)
          && persisted.uploadLatitude === uploadLatitude
          && persisted.uploadLongitude === uploadLongitude
          && persisted.uploadAccuracyMeters === uploadAccuracyMeters
          && persisted.uploadLocationCapturedAt === uploadLocationCapturedAt
          && persisted.distanceToVenueMeters === distanceToVenueMeters
          && persisted.pointsEligibleByLocation === pointsEligibleByLocation
          && persisted.pointsEligibilityReason === pointsEligibilityReason
          && stableJson(persisted.pendingVenue) === stableJson(pendingVenue)
          && record.evidence.map((entry) => entry.object.id).join("\0") === evidenceIds.join("\0")
          && record.items.length === items.length
          && record.items.every((persisted, index) => {
            const candidate = items[index]!;
            return persisted.normalizedBeerId === candidate.catalog.key
              && persisted.servingSize === candidate.servingSize
              && persisted.price === candidate.price
              && persisted.isOnTap === candidate.isOnTap
              && persisted.confidence === candidate.confidence
              && persisted.captureSource === candidate.captureSource
              && persisted.sourceText === candidate.sourceText
              && persisted.requiresCatalogApproval === (candidate.catalog.kind === "pending_create");
          });
        if (!sameCore) return fail("idempotency_conflict");
        return { record, replayed: true };
      }

      const accounts = await this.accountRows([userId]);
      if (!accounts.length) return fail("account_not_found");
      const account = accounts[0]!;
      if (account.deletionLocked || account.authProvider === "deleted" || !["active", "warned"].includes(account.status)) {
        return fail("account_not_eligible");
      }

      if (missionId && missionAcceptedAfter) {
        const reservation = await this.database.prepare(
          `SELECT progress.id AS "id"
             FROM mission_progress progress
             INNER JOIN missions mission ON mission.id = progress.mission_id
            WHERE progress.mission_id = @missionId AND progress.user_id = @userId
              AND progress.status = 'accepted' AND mission.venue_id = @venueId
              AND mission.active = @truth AND progress.accepted_at > @missionAcceptedAfter
            LIMIT 1${this.database.dialect === "postgres" ? " FOR UPDATE OF progress, mission" : ""}`,
        ).get<{ id: string }>({
          missionId, userId, venueId, missionAcceptedAfter,
          truth: booleanBinding(this.database.dialect, true),
        });
        if (!reservation) return fail("mission_reservation_invalid");
      }

      for (const evidenceId of [...evidenceIds].sort()) {
        const row = await this.database.prepare(
          `SELECT ${EVIDENCE_PROJECTION}
             FROM source_evidence_objects evidence
            WHERE evidence.id = ?${this.lockSuffix("evidence")}`,
        ).get<EvidenceRow>(evidenceId);
        if (!row || row.deletedAt || (row.retentionExpiresAt != null && row.retentionExpiresAt <= now)) {
          return fail("evidence_not_found");
        }
        if (row.ownerUserId !== userId) return fail("evidence_not_owned");
      }

      const resolvedItems: Array<NormalizedItem & { beerName: string; requiresCatalogApproval: boolean }> = [];
      for (const item of items) {
        const catalog = await this.database.prepare(
          `SELECT catalog.key AS "key", catalog.name AS "name", catalog.brewery AS "brewery",
                  catalog.style AS "style", catalog.abv AS "abv", catalog.status AS "status",
                  catalog.source AS "source", catalog.updated_at AS "updatedAt"
             FROM beer_catalog_items catalog WHERE catalog.key = ?${this.lockSuffix("catalog")}`,
        ).get<CatalogRow>(item.catalog.key);
        if (item.catalog.kind === "active_existing") {
          if (!catalog || catalog.status !== "active") return fail("catalog_not_active");
          resolvedItems.push({ ...item, beerName: catalog.name, requiresCatalogApproval: false });
          continue;
        }
        const catalogStatus = item.catalog.kind === "active_create" ? "active" : "pending_review";
        if (catalog) {
          if (catalog.status !== catalogStatus || catalog.name !== item.catalog.canonicalName
              || catalog.brewery !== (item.catalog.brewery ?? null)
              || catalog.style !== (item.catalog.style ?? null)
              || persistedNumber(catalog.abv, 0, 30) !== (item.catalog.abv ?? null)) return fail("catalog_conflict");
        } else {
          await this.database.prepare(
            `INSERT INTO beer_catalog_items (
               key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
             ) VALUES (
               @key, @name, @brewery, @style, @abv, @status, @source, NULL, @now, @now
             )`,
          ).run({
            key: item.catalog.key,
            name: item.catalog.canonicalName,
            brewery: item.catalog.brewery ?? null,
            style: item.catalog.style ?? null,
            abv: item.catalog.abv ?? null,
            status: catalogStatus,
            source: item.catalog.source,
            now,
          });
        }
        const alias = await this.database.prepare(
          `SELECT alias.beer_key AS "beerKey", alias.alias AS "alias"
             FROM beer_catalog_aliases alias WHERE alias.alias_key = ?${this.lockSuffix("alias")}`,
        ).get<{ beerKey: string; alias: string }>(item.catalog.aliasKey);
        // alias_key is the canonical identity. Display casing/punctuation may differ
        // between the immutable reviewed input and a pre-seeded system alias, but
        // it must never be allowed to redirect to a different catalogue item.
        if (alias && alias.beerKey !== item.catalog.key) return fail("catalog_conflict");
        if (!alias) {
          await this.database.prepare(
            `INSERT INTO beer_catalog_aliases (alias_key, beer_key, alias, source, created_at)
             VALUES (@aliasKey, @key, @alias, @source, @now)`,
          ).run({
            aliasKey: item.catalog.aliasKey,
            key: item.catalog.key,
            alias: item.catalog.alias,
            source: item.catalog.source,
            now,
          });
        }
        resolvedItems.push({
          ...item,
          beerName: item.catalog.canonicalName,
          requiresCatalogApproval: item.catalog.kind === "pending_create",
        });
      }

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
           'pending', @submissionType, @observedAt, @sourcePhotoUrl, @ocrStatus, @ocrSummaryJson,
           @notes, 0, @uploadLatitude, @uploadLongitude, @uploadAccuracyMeters,
           @uploadLocationCapturedAt, @distanceToVenueMeters, @pointsEligibleByLocation,
           @pointsEligibilityReason, @pendingVenueJson, NULL, NULL, NULL, @falsity, @now, @now
         )`,
      ).run({
        id, clientSubmissionId, missionId, userId, venueId, venueName, suburb,
        submissionType: input.submissionType, observedAt,
        sourcePhotoUrl: evidenceIds[0] ? `private:evidence:${evidenceIds[0]}` : null,
        ocrStatus, ocrSummaryJson, notes, uploadLatitude, uploadLongitude, uploadAccuracyMeters,
        uploadLocationCapturedAt, distanceToVenueMeters,
        pointsEligibleByLocation: booleanBinding(this.database.dialect, pointsEligibleByLocation),
        pointsEligibilityReason, pendingVenueJson,
        falsity: booleanBinding(this.database.dialect, false), now,
      });

      if (missionId && missionAcceptedAfter) {
        const changed = await this.database.prepare(
          `UPDATE mission_progress
              SET submission_id = @id, status = 'submitted', submitted_at = @now,
                  completed_at = NULL, updated_at = @now
            WHERE mission_id = @missionId AND user_id = @userId AND status = 'accepted'
              AND accepted_at > @missionAcceptedAfter`,
        ).run({ id, now, missionId, userId, missionAcceptedAfter });
        if (changed.changes !== 1) return fail("mission_reservation_invalid");
      }

      for (const item of resolvedItems) {
        await this.database.prepare(
          `INSERT INTO submission_items (
             id, submission_id, beer_name, normalized_beer_id, serving_size, price,
             is_happy_hour_price, happy_hour_details, is_on_tap, confidence, capture_source,
             source_text, requires_catalog_approval, created_at
           ) VALUES (
             @id, @submissionId, @beerName, @normalizedBeerId, @servingSize, @price,
             @falsity, NULL, @isOnTap, @confidence, @captureSource,
             @sourceText, @requiresCatalogApproval, @now
           )`,
        ).run({
          ...item,
          submissionId: id,
          normalizedBeerId: item.catalog.key,
          falsity: booleanBinding(this.database.dialect, false),
          requiresCatalogApproval: booleanBinding(this.database.dialect, item.requiresCatalogApproval),
          now,
        });
      }
      for (const [sortOrder, evidenceId] of evidenceIds.entries()) {
        await this.database.prepare(
          `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(id, evidenceId, sortOrder, now);
      }
      const row = await this.submissionRowById(id, true);
      return { record: row ? await this.recordFromRow(row) : fail("persistence_failure"), replayed: false };
    }));
  }

  async listCommunityVerificationCandidates(input: {
    verifierUserId: string;
    limit: number;
    offset: number;
  }): Promise<CommunityVerificationCandidate[]> {
    const verifierUserId = requiredText(input.verifierUserId);
    const limit = inputInteger(input.limit, 1, MAX_LIST_LIMIT);
    const offset = inputInteger(input.offset, 0, Number.MAX_SAFE_INTEGER);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${SUBMISSION_PROJECTION}
           FROM submissions submission
          WHERE submission.status IN ('pending', 'needs_more_evidence')
            AND submission.submission_type <> 'happy_hour_update'
            AND submission.user_id <> @verifierUserId
            AND NOT EXISTS (
              SELECT 1 FROM verifications verification
               WHERE verification.upload_id = submission.id
                 AND verification.verifier_user_id = @verifierUserId
            )
          ORDER BY submission.created_at ASC, submission.id ASC
          LIMIT @limit OFFSET @offset`,
      ).all<SubmissionRow>({ verifierUserId, limit, offset });
      const candidates: CommunityVerificationCandidate[] = [];
      for (const row of rows) {
        const submission = persistedSubmission(row);
        candidates.push({
          id: submission.id,
          venueId: submission.venueId,
          venueName: submission.venueName,
          suburb: submission.suburb,
          status: submission.status as CommunityVerificationCandidate["status"],
          submissionType: submission.submissionType as CommunityVerificationCandidate["submissionType"],
          observedAt: submission.observedAt,
          ocrStatus: submission.ocrStatus,
          createdAt: submission.createdAt,
          hasSourceEvidence: Boolean(submission.sourcePhotoUrl),
          items: await this.itemsForSubmission(submission.id),
        });
      }
      return candidates;
    });
  }

  async countCommunityVerificationCandidates(verifierUserId: string): Promise<number> {
    const id = requiredText(verifierUserId);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count" FROM submissions submission
          WHERE submission.status IN ('pending', 'needs_more_evidence')
            AND submission.submission_type <> 'happy_hour_update'
            AND submission.user_id <> ?
            AND NOT EXISTS (
              SELECT 1 FROM verifications verification
               WHERE verification.upload_id = submission.id AND verification.verifier_user_id = ?
            )`,
      ).get<{ count: number | string }>(id, id);
      return row ? safeInteger(row.count) : 0;
    });
  }

  async getVerificationById(id: string): Promise<UserVerification | null> {
    const verificationId = requiredText(id);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT ${VERIFICATION_PROJECTION}
           FROM verifications verification WHERE verification.id = ?`,
      ).get<VerificationRow>(verificationId);
      return row ? persistedVerification(row) : null;
    });
  }

  async getVerificationByUserAndSubmission(input: {
    verifierUserId: string;
    submissionId: string;
  }): Promise<UserVerification | null> {
    const verifierUserId = requiredText(input.verifierUserId);
    const submissionId = requiredText(input.submissionId);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT ${VERIFICATION_PROJECTION}
           FROM verifications verification
          WHERE verification.verifier_user_id = ? AND verification.upload_id = ?
          LIMIT 1`,
      ).get<VerificationRow>(verifierUserId, submissionId);
      return row ? persistedVerification(row) : null;
    });
  }

  async countConfirmedVerificationsForSubmission(submissionId: string): Promise<number> {
    const id = requiredText(submissionId);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(DISTINCT verification.verifier_user_id) AS "count"
           FROM verifications verification
          WHERE verification.upload_id = ? AND verification.result = 'confirmed'`,
      ).get<{ count: number | string }>(id);
      return row ? safeInteger(row.count) : 0;
    });
  }

  async listVerificationsForUser(input: {
    verifierUserId: string;
    limit: number;
    offset?: number | undefined;
  }): Promise<UserVerification[]> {
    const verifierUserId = requiredText(input.verifierUserId);
    const limit = inputInteger(input.limit, 1, MAX_LIST_LIMIT);
    const offset = inputInteger(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${VERIFICATION_PROJECTION}
           FROM verifications verification
          WHERE verification.verifier_user_id = ?
          ORDER BY verification.created_at DESC, verification.id DESC
          LIMIT ? OFFSET ?`,
      ).all<VerificationRow>(verifierUserId, limit, offset);
      return rows.map(persistedVerification);
    });
  }

  async createVerification(input: {
    id: string;
    verifierUserId: string;
    submissionId: string;
    result: "confirmed" | "disputed" | "needs_more_evidence";
    notes: string | null;
    now: string;
  }): Promise<UserVerification> {
    const id = requiredText(input.id);
    const verifierUserId = requiredText(input.verifierUserId);
    const submissionId = requiredText(input.submissionId);
    if (!["confirmed", "disputed", "needs_more_evidence"].includes(input.result)) return fail("invalid_input");
    const notes = optionalText(input.notes, 1_000);
    const now = canonicalUtc(input.now);
    return this.translate(this.database.transaction(async () => {
      const initial = await this.submissionRowById(submissionId);
      if (!initial) return fail("submission_not_found");
      const accounts = await this.accountRows([verifierUserId, initial.userId]);
      const submission = await this.submissionRowById(submissionId, true);
      if (!submission) return fail("submission_not_found");
      if (submission.userId === verifierUserId) return fail("own_verification");
      if (!["pending", "needs_more_evidence"].includes(submission.status)) return fail("submission_not_reviewable");
      const verifier = accounts.find((account) => account.id === verifierUserId);
      if (!verifier) return fail("account_not_found");
      if (verifier.deletionLocked || verifier.authProvider === "deleted" || !["active", "warned"].includes(verifier.status)) {
        return fail("account_not_eligible");
      }
      const existing = await this.database.prepare(
        `SELECT id AS "id" FROM verifications
          WHERE verifier_user_id = ? AND upload_id = ? LIMIT 1${this.database.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      ).get<{ id: string }>(verifierUserId, submissionId);
      if (existing) return fail("verification_conflict");
      await this.database.prepare(
        `INSERT INTO verifications (
           id, verifier_user_id, upload_id, target_entity_type, target_entity_id, result, notes, created_at
         ) VALUES (@id, @verifierUserId, @submissionId, 'submission', @submissionId, @result, @notes, @now)`,
      ).run({ id, verifierUserId, submissionId, result: input.result, notes, now });
      return {
        id, verifierUserId, uploadId: submissionId,
        targetEntityType: "submission", targetEntityId: submissionId,
        result: input.result, notes, createdAt: now,
      };
    }));
  }

  async reviewSubmission(input: {
    submissionId: string;
    reviewerId: string;
    status: Extract<SubmissionStatus, "approved" | "rejected" | "needs_more_evidence" | "fraud_flagged" | "disputed">;
    rejectionReason: string | null;
    fraudFlagged?: boolean | undefined;
    monthKey: string;
    now: string;
  }): Promise<CommunityReviewResult> {
    const submissionId = requiredText(input.submissionId);
    const reviewerId = requiredText(input.reviewerId);
    const allowed = ["approved", "rejected", "needs_more_evidence", "fraud_flagged", "disputed"];
    if (!allowed.includes(input.status)) return fail("invalid_input");
    // No transaction starts and no state changes occur for the deliberately
    // unimplemented public approval cluster.
    if (input.status === "approved") return fail("publication_required");
    const rejectionReason = optionalText(input.rejectionReason, 1_000);
    const monthKey = requiredText(input.monthKey, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return fail("invalid_input");
    const now = canonicalUtc(input.now);
    const fraudFlagged = input.status === "fraud_flagged" || input.fraudFlagged === true;
    return this.translate(async () => {
      const initial = await this.submissionRowById(submissionId);
      if (!initial) return fail("submission_not_found");
      return this.database.transaction(async () => {
        await this.advisoryLocks([
          `community-review:${submissionId}`,
          missionLifecycleAccountLockKey(initial.userId),
          missionLifecycleAccountLockKey(reviewerId),
          ...(initial.missionId ? [missionLifecycleMissionLockKey(initial.missionId)] : []),
        ]);
      const accounts = await this.accountRows([initial.userId, reviewerId]);
      const current = await this.submissionRowById(submissionId, true);
      if (!current) return fail("submission_not_found");
      if (current.userId !== initial.userId || current.missionId !== initial.missionId) {
        return fail("submission_not_reviewable");
      }
      if (!["pending", "needs_more_evidence"].includes(current.status)) return fail("submission_not_reviewable");
      if (current.userId === reviewerId) return fail("review_forbidden");
      const reviewer = accounts.find((account) => account.id === reviewerId);
      const submitter = accounts.find((account) => account.id === current.userId);
      if (!reviewer || !submitter) return fail("account_not_found");
      if (reviewer.deletionLocked || reviewer.authProvider === "deleted" || !["active", "warned"].includes(reviewer.status)
          || (reviewer.role !== "admin" && reviewer.subscriptionStatus !== "admin")) return fail("review_forbidden");

      if (input.status !== "needs_more_evidence") {
        const penalty = fraudFlagged ? 20 : input.status === "disputed" ? 2 : 4;
        const strike = fraudFlagged ? 1 : 0;
        await this.database.prepare(
          `UPDATE accounts
              SET rejected_submission_count = rejected_submission_count + 1,
                  fraud_strike_count = fraud_strike_count + @strike,
                  trust_score = max(0, trust_score - @penalty),
                  status = CASE
                    WHEN fraud_strike_count + @strike >= 3 THEN 'suspended'
                    WHEN @strike = 1 THEN 'warned'
                    ELSE status
                  END,
                  updated_at = @now
            WHERE id = @submitterId`,
        ).run({ strike, penalty, now, submitterId: submitter.id });
      }

      const updated = await this.database.prepare(
        `UPDATE submissions
            SET status = @status, points_awarded = 0, reviewed_by = @reviewerId,
                reviewed_at = @now, rejection_reason = @rejectionReason,
                fraud_flagged = @fraudFlagged, updated_at = @now
          WHERE id = @submissionId AND status IN ('pending', 'needs_more_evidence')`,
      ).run({
        status: input.status, reviewerId, now, rejectionReason, submissionId,
        fraudFlagged: booleanBinding(this.database.dialect, fraudFlagged),
      });
      if (updated.changes !== 1) return fail("submission_not_reviewable");

      if (current.missionId) {
        const progress = await this.database.prepare(
          `UPDATE mission_progress
              SET status = 'needs_revision', completed_at = NULL, updated_at = @now
            WHERE mission_id = @missionId AND user_id = @userId
              AND submission_id = @submissionId AND status = 'submitted'`,
        ).run({ now, missionId: current.missionId, userId: current.userId, submissionId });
        if (progress.changes !== 1) return fail("mission_decision_stale");
      }

      await this.database.prepare(
        `UPDATE accounts
            SET contribution_points_current_month = (
              SELECT COALESCE(sum(ledger.points), 0)
                FROM contribution_ledger ledger
               WHERE ledger.user_id = @submitterId AND ledger.month_key = @monthKey
            )
          WHERE id = @submitterId`,
      ).run({ submitterId: submitter.id, monthKey });

      const accountAfter = (await this.accountRows([submitter.id]))[0];
      if (!accountAfter) return fail("persistence_failure");
      if (accountAfter.status === "suspended") {
        await this.database.prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        ).run(now, submitter.id);
        await this.database.prepare(
          `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
            WHERE user_id = ? AND status = 'active'`,
        ).run(now, submitter.id);
        await this.database.prepare(
          `UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ?
            WHERE user_id = ? AND status = 'active'`,
        ).run(now, submitter.id);
        await this.database.prepare(
          "UPDATE profiles SET account_status = 'suspended', updated_at = ? WHERE id = ?",
        ).run(now, submitter.id);
      }
      const finalRow = await this.submissionRowById(submissionId, true);
      return {
        submission: finalRow ? persistedSubmission(finalRow) : fail("persistence_failure"),
        submitter: {
          id: accountAfter.id,
          status: accountAfter.status,
          trustScore: safeInteger(accountAfter.trustScore, 100),
          rejectedSubmissionCount: safeInteger(accountAfter.rejectedSubmissionCount),
          fraudStrikeCount: safeInteger(accountAfter.fraudStrikeCount),
        },
      };
      })();
    });
  }

  async approveAndPublishSubmission(input: {
    approvalId: string;
    submissionId: string;
    reviewerId: string;
    catalogDecisions: CommunityApprovalCatalogDecision[];
    missionDecision: CommunityApprovalMissionDecision | null;
    venueDecision: CommunityApprovalVenueDecision | null;
    evidenceDecisions: CommunityApprovalEvidenceDecision[];
    pointsAwarded: number;
    confidence: ConfidenceLabel;
    monthKey: string;
    premiumUntil: string;
    contributorUnlockPoints: number;
    now: string;
    failureInjection?: CommunityApprovalFailureStage | null | undefined;
  }): Promise<CommunityApprovalResult> {
    const approvalId = requiredText(input.approvalId, 160);
    const submissionId = requiredText(input.submissionId);
    const reviewerId = requiredText(input.reviewerId);
    const pointsAwarded = finiteNumber(input.pointsAwarded, 0, 25);
    const contributorUnlockPoints = finiteNumber(input.contributorUnlockPoints, 1, 1_000_000);
    const monthKey = requiredText(input.monthKey, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return fail("invalid_input");
    const premiumUntil = canonicalUtc(input.premiumUntil);
    const now = canonicalUtc(input.now);
    if (premiumUntil <= now) return fail("invalid_input");
    const allowedConfidence: ConfidenceLabel[] = [
      "admin_verified", "photo_verified", "community_confirmed",
    ];
    if (!allowedConfidence.includes(input.confidence)) return fail("invalid_input");
    const confidence = input.confidence;
    const failureStages: CommunityApprovalFailureStage[] = [
      "after_locks", "after_catalog", "after_venue", "after_public_prices",
      "after_rewards", "after_missions", "before_finalize",
    ];
    const failureInjection = input.failureInjection ?? null;
    if (failureInjection != null && !failureStages.includes(failureInjection)) return fail("invalid_input");
    if (failureInjection != null && !this.options.allowApprovalFailureInjection) return fail("invalid_input");

    if (!Array.isArray(input.catalogDecisions)
        || input.catalogDecisions.length < 1
        || input.catalogDecisions.length > MAX_ITEMS) return fail("invalid_input");
    const catalogDecisions = input.catalogDecisions.map((decision) => ({
      itemId: requiredText(decision.itemId),
      expectedCatalogKey: normalizeCatalogKey(decision.expectedCatalogKey),
      expectedCatalogUpdatedAt: canonicalUtc(decision.expectedCatalogUpdatedAt),
      activeCatalogKey: normalizeCatalogKey(decision.activeCatalogKey),
      activeCatalogName: requiredText(decision.activeCatalogName, 200),
      activeCatalogUpdatedAt: canonicalUtc(decision.activeCatalogUpdatedAt),
    })).sort((left, right) => left.itemId.localeCompare(right.itemId));
    if (new Set(catalogDecisions.map((decision) => decision.itemId)).size !== catalogDecisions.length) {
      return fail("invalid_input");
    }

    const missionDecision = input.missionDecision == null ? null : {
      missionId: requiredText(input.missionDecision.missionId),
      missionUpdatedAt: canonicalUtc(input.missionDecision.missionUpdatedAt),
      progressId: requiredText(input.missionDecision.progressId),
      progressUpdatedAt: canonicalUtc(input.missionDecision.progressUpdatedAt),
    };
    if (input.venueDecision != null && (
      !Array.isArray(input.venueDecision.requests) || input.venueDecision.requests.length > 100
    )) return fail("invalid_input");
    const venueDecision = input.venueDecision == null ? null : {
      pendingVenueHash: requiredText(input.venueDecision.pendingVenueHash, 64).toLowerCase(),
      expectedVenueProfileUpdatedAt: optionalCanonicalUtc(input.venueDecision.expectedVenueProfileUpdatedAt),
      expectedLocationUpdatedAt: optionalCanonicalUtc(input.venueDecision.expectedLocationUpdatedAt),
      requests: input.venueDecision.requests.map((decision) => {
        if (!["open", "in_progress", "mission_created"].includes(decision.status)) return fail("invalid_input");
        if ((decision.missionId == null) !== (decision.missionUpdatedAt == null)) return fail("invalid_input");
        return {
          requestId: requiredText(decision.requestId),
          status: decision.status,
          updatedAt: canonicalUtc(decision.updatedAt),
          missionId: optionalText(decision.missionId),
          missionUpdatedAt: optionalCanonicalUtc(decision.missionUpdatedAt),
        };
      }).sort((left, right) => left.requestId.localeCompare(right.requestId)),
    };
    if (venueDecision) {
      if (!/^[0-9a-f]{64}$/.test(venueDecision.pendingVenueHash)
          || venueDecision.requests.length > 100
          || new Set(venueDecision.requests.map((decision) => decision.requestId)).size !== venueDecision.requests.length) {
        return fail("invalid_input");
      }
      const requestMissions = new Map<string, string>();
      for (const decision of venueDecision.requests) {
        if (!decision.missionId || !decision.missionUpdatedAt) continue;
        const existing = requestMissions.get(decision.missionId);
        if (existing && existing !== decision.missionUpdatedAt) return fail("invalid_input");
        requestMissions.set(decision.missionId, decision.missionUpdatedAt);
      }
    }
    if (!Array.isArray(input.evidenceDecisions) || input.evidenceDecisions.length > MAX_EVIDENCE) {
      return fail("invalid_input");
    }
    const evidenceDecisions = input.evidenceDecisions.map((decision) => ({
      evidenceId: requiredText(decision.evidenceId),
      sortOrder: inputInteger(decision.sortOrder, 0, MAX_EVIDENCE - 1),
      createdAt: canonicalUtc(decision.createdAt),
      retentionExpiresAt: optionalCanonicalUtc(decision.retentionExpiresAt),
    })).sort((left, right) => left.sortOrder - right.sortOrder || left.evidenceId.localeCompare(right.evidenceId));
    if (new Set(evidenceDecisions.map((decision) => decision.evidenceId)).size !== evidenceDecisions.length
        || evidenceDecisions.some((decision, index) => decision.sortOrder !== index)) {
      return fail("invalid_input");
    }

    const fingerprint = sha256(stableJson({
      approvalId,
      submissionId,
      reviewerId,
      catalogDecisions,
      missionDecision,
      venueDecision,
      evidenceDecisions,
      pointsAwarded,
      confidence,
      monthKey,
      premiumUntil,
      contributorUnlockPoints,
    }));
    const auditId = approvalAuditId(submissionId);
    const requestMissionIds = venueDecision?.requests
      .map((decision) => decision.missionId)
      .filter((id): id is string => id != null) ?? [];
    const missionIds = [...new Set([
      ...(missionDecision ? [missionDecision.missionId] : []),
      ...requestMissionIds,
    ])].sort();

    const approvalResult = (
      outcome: CommunityApprovalResult["outcome"],
      submission: BusinessSubmission,
      account: AccountRow,
      itemIds: readonly string[],
    ): CommunityApprovalResult => ({
      outcome,
      submission,
      pointsAwarded: submission.pointsAwarded,
      submitter: {
        id: account.id,
        status: account.status,
        subscriptionStatus: account.subscriptionStatus,
        trustScore: safeInteger(account.trustScore, 100),
        contributionPointsCurrentMonth: persistedNumber(
          account.contributionPointsCurrentMonth,
          0,
          1_000_000_000,
        ) ?? 0,
        approvedSubmissionCount: safeInteger(account.approvedSubmissionCount),
      },
      priceRecordIds: itemIds.map((itemId) => `${submission.id}:${itemId}`),
      resolvedVenueRequestIds: venueDecision?.requests.map((decision) => decision.requestId) ?? [],
    });

    return this.translate(async () => {
      const initial = await this.submissionRowById(submissionId);
      if (!initial) return fail("submission_not_found");
      const authorityOwnerIds = await this.missionAuthorityOwnerIds(missionIds);
      return this.database.transaction(async () => {
        await this.advisoryLocks([
          `community-approval:${submissionId}`,
          `community-venue:${initial.venueId}`,
          missionLifecycleAccountLockKey(initial.userId),
          missionLifecycleAccountLockKey(reviewerId),
          ...authorityOwnerIds.map(missionLifecycleAccountLockKey),
          ...catalogDecisions.flatMap((decision) => [
            `community-catalog:${decision.expectedCatalogKey}`,
            `community-catalog:${decision.activeCatalogKey}`,
          ]),
          ...missionIds.map(missionLifecycleMissionLockKey),
        ]);

        const lockedAuthorityOwnerIds = await this.missionAuthorityOwnerIds(missionIds);
        if (stableJson(lockedAuthorityOwnerIds) !== stableJson(authorityOwnerIds)) {
          return fail("mission_decision_stale");
        }
        const accounts = await this.accountRows([initial.userId, reviewerId, ...authorityOwnerIds]);
        const reviewer = accounts.find((account) => account.id === reviewerId);
        const submitter = accounts.find((account) => account.id === initial.userId);
        if (!reviewer || !submitter) return fail("account_not_found");

        const affectedSubmissionIds = new Set<string>([submissionId]);
        for (const missionId of missionIds) {
          const rows = await this.database.prepare(
            `SELECT submission.id AS "id" FROM submissions submission
              WHERE submission.mission_id = ?
                AND submission.status IN ('pending', 'needs_more_evidence')
              ORDER BY submission.id ASC`,
          ).all<{ id: string }>(missionId);
          rows.forEach((row) => affectedSubmissionIds.add(row.id));
        }
        const lockedSubmissions = new Map<string, SubmissionRow>();
        for (const id of [...affectedSubmissionIds].sort()) {
          const row = await this.submissionRowById(id, true);
          if (row) lockedSubmissions.set(id, row);
        }
        const currentRow = lockedSubmissions.get(submissionId);
        if (!currentRow) return fail("submission_not_found");
        const current = persistedSubmission(currentRow);
        const lockedItemRows = await this.itemRowsForSubmission(submissionId, true);
        const items = lockedItemRows.map(persistedItem);

        if (current.status === "approved") {
          const audit = await this.database.prepare(
            `SELECT audit.metadata_json AS "metadataJson"
               FROM security_audit_log audit WHERE audit.id = ?`,
          ).get<{ metadataJson: unknown }>(auditId);
          const metadata = audit ? jsonObject(audit.metadataJson) : null;
          if (metadata?.fingerprint !== fingerprint || metadata?.approvalId !== approvalId) {
            return fail("approval_conflict");
          }
          return approvalResult("already_applied", current, submitter, items.map((item) => item.id));
        }
        if (!["pending", "needs_more_evidence"].includes(current.status)) {
          return fail("submission_not_reviewable");
        }
        if (current.userId !== initial.userId || current.venueId !== initial.venueId) {
          return fail("submission_not_reviewable");
        }
        if (current.userId === reviewerId) return fail("review_forbidden");
        if (reviewer.deletionLocked || reviewer.authProvider === "deleted"
            || !["active", "warned"].includes(reviewer.status)
            || (reviewer.role !== "admin" && reviewer.subscriptionStatus !== "admin")) {
          return fail("review_forbidden");
        }
        if (submitter.deletionLocked || submitter.authProvider === "deleted") return fail("account_not_eligible");
        if (current.submissionType === "happy_hour_update" || items.length < 1 || items.length !== catalogDecisions.length) {
          return fail("publication_conflict");
        }

        const decisionsByItem = new Map(catalogDecisions.map((decision) => [decision.itemId, decision]));
        const catalog = await this.catalogRows(catalogDecisions.flatMap((decision) => [
          decision.expectedCatalogKey,
          decision.activeCatalogKey,
        ]));
        for (const item of items) {
          const decision = decisionsByItem.get(item.id);
          if (!decision || item.normalizedBeerId !== decision.expectedCatalogKey
              || item.isHappyHourPrice || item.happyHourDetails != null
              || item.price == null || item.price <= 0) return fail("publication_conflict");
          const expected = catalog.get(decision.expectedCatalogKey);
          const active = catalog.get(decision.activeCatalogKey);
          if (!expected || persistedUtc(expected.updatedAt) !== decision.expectedCatalogUpdatedAt
              || !active || active.status !== "active"
              || active.name !== decision.activeCatalogName
              || persistedUtc(active.updatedAt) !== decision.activeCatalogUpdatedAt) {
            return fail("catalog_decision_stale");
          }
        }

        if ((current.missionId == null) !== (missionDecision == null)
            || (missionDecision && current.missionId !== missionDecision.missionId)) {
          return fail("mission_decision_stale");
        }
        const missions = await this.missionRows(missionIds);
        const progressByMission = await this.missionProgressRows(missionIds);
        if (missionDecision) {
          const mission = missions.get(missionDecision.missionId);
          const winning = progressByMission.get(missionDecision.missionId)
            ?.find((progress) => progress.id === missionDecision.progressId);
          if (!mission || !winning || !persistedBoolean(mission.active)
              || mission.venueId !== current.venueId
              || persistedUtc(mission.updatedAt) !== missionDecision.missionUpdatedAt
              || winning.userId !== current.userId || winning.submissionId !== submissionId
              || winning.status !== "submitted"
              || persistedUtc(winning.updatedAt) !== missionDecision.progressUpdatedAt) {
            return fail("mission_decision_stale");
          }
        }
        for (const decision of venueDecision?.requests ?? []) {
          if (!decision.missionId || !decision.missionUpdatedAt) continue;
          const mission = missions.get(decision.missionId);
          if (!mission || !persistedBoolean(mission.active)
              || persistedUtc(mission.updatedAt) !== decision.missionUpdatedAt) {
            return fail("mission_decision_stale");
          }
        }

        const profile = await this.database.prepare(
          `SELECT venue.venue_id AS "venueId", venue.updated_at AS "updatedAt"
             FROM venue_profiles venue WHERE venue.venue_id = ?${this.lockSuffix("venue")}`,
        ).get<VenueProfileFenceRow>(current.venueId);
        const location = await this.database.prepare(
          `SELECT location.venue_id AS "venueId", location.updated_at AS "updatedAt"
             FROM venue_location_cache location WHERE location.venue_id = ?${this.lockSuffix("location")}`,
        ).get<VenueLocationFenceRow>(current.venueId);
        if ((current.pendingVenue == null) !== (venueDecision == null)) return fail("venue_decision_stale");
        if (venueDecision) {
          if (communityPendingVenueFingerprint(current.pendingVenue) !== venueDecision.pendingVenueHash
              || (profile ? persistedUtc(profile.updatedAt) : null) !== venueDecision.expectedVenueProfileUpdatedAt
              || (location ? persistedUtc(location.updatedAt) : null) !== venueDecision.expectedLocationUpdatedAt) {
            return fail("venue_decision_stale");
          }
        }

        let requestRows: VenueRequestRow[] = [];
        const googlePlaceId = current.pendingVenue?.googlePlaceId ?? null;
        if (googlePlaceId) {
          requestRows = await this.database.prepare(
            `SELECT request.id AS "id", request.google_place_id AS "googlePlaceId",
                    request.status AS "status", request.mission_id AS "missionId",
                    request.updated_at AS "updatedAt"
               FROM venue_requests request
              WHERE request.request_type = 'missing_venue'
                AND request.google_place_id = ?
                AND request.status IN ('open', 'in_progress', 'mission_created')
              ORDER BY request.id ASC${this.lockSuffix("request")}`,
          ).all<VenueRequestRow>(googlePlaceId);
        }
        const expectedRequests = venueDecision?.requests ?? [];
        const comparableRequests = requestRows.map((row) => ({
          requestId: row.id,
          status: row.status,
          updatedAt: persistedUtc(row.updatedAt),
          missionId: row.missionId,
        }));
        const comparableExpected = expectedRequests.map((decision) => ({
          requestId: decision.requestId,
          status: decision.status,
          updatedAt: decision.updatedAt,
          missionId: decision.missionId,
        }));
        if (stableJson(comparableRequests) !== stableJson(comparableExpected)) return fail("venue_decision_stale");

        const evidenceRows = await this.database.prepare(
          `SELECT ${EVIDENCE_PROJECTION}, link.sort_order AS "sortOrder"
             FROM submission_source_evidence link
             INNER JOIN source_evidence_objects evidence ON evidence.id = link.evidence_id
            WHERE link.submission_id = ?
            ORDER BY link.sort_order ASC, evidence.id ASC${this.lockSuffix("evidence")}`,
        ).all<EvidenceRow>(submissionId);
        const currentEvidenceDecisions = evidenceRows.map((evidence) => ({
          evidenceId: evidence.id,
          sortOrder: safeInteger(evidence.sortOrder ?? -1, MAX_EVIDENCE - 1),
          createdAt: persistedUtc(evidence.createdAt),
          retentionExpiresAt: evidence.retentionExpiresAt == null
            ? null
            : persistedUtc(evidence.retentionExpiresAt),
        }));
        if (stableJson(currentEvidenceDecisions) !== stableJson(evidenceDecisions)) {
          return fail("evidence_not_found");
        }
        for (const [index, evidence] of evidenceRows.entries()) {
          if (evidence.ownerUserId !== current.userId || evidence.deletedAt
              || (evidence.retentionExpiresAt && evidence.retentionExpiresAt <= now)
              || safeInteger(evidence.sortOrder ?? -1, MAX_EVIDENCE - 1) !== index) {
            return fail("evidence_not_found");
          }
        }
        const verificationCountRow = await this.database.prepare(
          `SELECT count(DISTINCT verification.verifier_user_id) AS "count"
             FROM verifications verification
            WHERE verification.upload_id = ? AND verification.result = 'confirmed'`,
        ).get<{ count: number | string }>(submissionId);
        const confirmedVerificationCount = verificationCountRow
          ? safeInteger(verificationCountRow.count)
          : 0;
        const derivedConfidence: ConfidenceLabel = evidenceRows.length > 0
          ? "photo_verified"
          : confirmedVerificationCount >= COMMUNITY_CONFIDENCE_CONFIRMATION_THRESHOLD
            ? "community_confirmed"
            : "admin_verified";
        if (confidence !== derivedConfidence) return fail("publication_conflict");
        const expectedPrivateSource = evidenceRows[0] ? `private:evidence:${evidenceRows[0].id}` : null;
        if (current.sourcePhotoUrl !== expectedPrivateSource) return fail("evidence_not_found");
        const priceRecordIds = items.map((item) => `${submissionId}:${item.id}`);
        const inventoryIds = current.pendingVenue ? items.map((item) => {
          const beerKey = (decisionsByItem.get(item.id)?.activeCatalogKey ?? item.id)
            .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || item.id;
          return `approved-submission:${current.venueId}:${beerKey}:${item.servingSize}`;
        }) : [];
        if (new Set(inventoryIds).size !== inventoryIds.length) return fail("publication_conflict");
        const existingLineage = await this.database.prepare(
          `SELECT price.id AS "id" FROM venue_price_records price
            WHERE price.source_submission_id = ?
            ORDER BY price.id ASC${this.lockSuffix("price")}`,
        ).all<{ id: string }>(submissionId);
        if (existingLineage.length) return fail("publication_conflict");
        for (const priceId of [...priceRecordIds].sort()) {
          const row = await this.database.prepare(
            `SELECT price.id AS "id" FROM venue_price_records price
              WHERE price.id = ?${this.lockSuffix("price")}`,
          ).get<{ id: string }>(priceId);
          if (row) return fail("publication_conflict");
        }
        for (const inventoryId of [...inventoryIds].sort()) {
          const row = await this.database.prepare(
            `SELECT inventory.id AS "id" FROM venue_beers inventory
              WHERE inventory.id = ?${this.lockSuffix("inventory")}`,
          ).get<{ id: string }>(inventoryId);
          if (row) return fail("publication_conflict");
        }
        this.injectApprovalFailure(failureInjection, "after_locks");

        for (const item of items) {
          const decision = decisionsByItem.get(item.id)!;
          const changed = await this.database.prepare(
            `UPDATE submission_items
                SET beer_name = @beerName, normalized_beer_id = @activeCatalogKey,
                    requires_catalog_approval = @falsity
              WHERE id = @itemId AND submission_id = @submissionId
                AND normalized_beer_id = @expectedCatalogKey`,
          ).run({
            beerName: decision.activeCatalogName,
            activeCatalogKey: decision.activeCatalogKey,
            falsity: booleanBinding(this.database.dialect, false),
            itemId: item.id,
            submissionId,
            expectedCatalogKey: decision.expectedCatalogKey,
          });
          if (changed.changes !== 1) return fail("catalog_decision_stale");
        }
        this.injectApprovalFailure(failureInjection, "after_catalog");

        if (current.pendingVenue && venueDecision) {
          const pending = current.pendingVenue;
          const venueName = pending.name || current.venueName;
          const venueSuburb = pending.suburb ?? current.suburb;
          await this.database.prepare(
            `INSERT INTO venue_profiles (
               venue_id, name, address, suburb, area, phone, website, instagram, description,
               opening_hours_json, venue_tags_json, membership_tier, highlighted_name,
               premium_badge, promoted, featured_special_eligible, active, created_at, updated_at
             ) VALUES (
               @venueId, @name, @address, @suburb, @suburb, @phone, @website, NULL, @description,
               @openingHours, @venueTags, 'basic', @falsity, NULL, @falsity, @falsity,
               @truth, @now, @now
             )
             ON CONFLICT(venue_id) DO UPDATE SET
               name = excluded.name, address = excluded.address, suburb = excluded.suburb,
               area = excluded.area, phone = excluded.phone, website = excluded.website,
               description = excluded.description, opening_hours_json = excluded.opening_hours_json,
               venue_tags_json = excluded.venue_tags_json, active = excluded.active,
               updated_at = excluded.updated_at`,
          ).run({
            venueId: current.venueId,
            name: venueName,
            address: pending.address,
            suburb: venueSuburb,
            phone: pending.phone,
            website: pending.website,
            description: "User-submitted venue. Beer data is reviewed before prices appear publicly.",
            openingHours: "{}",
            venueTags: "[\"user submitted\"]",
            falsity: booleanBinding(this.database.dialect, false),
            truth: booleanBinding(this.database.dialect, true),
            now,
          });
          await this.database.prepare(
            `INSERT INTO venue_location_cache (
               venue_id, venue_name, suburb, latitude, longitude, updated_at
             ) VALUES (@venueId, @venueName, @suburb, @latitude, @longitude, @now)
             ON CONFLICT(venue_id) DO UPDATE SET
               venue_name = excluded.venue_name, suburb = excluded.suburb,
               latitude = excluded.latitude, longitude = excluded.longitude,
               updated_at = excluded.updated_at`,
          ).run({
            venueId: current.venueId,
            venueName,
            suburb: venueSuburb,
            latitude: pending.latitude,
            longitude: pending.longitude,
            now,
          });
        }
        for (const request of requestRows) {
          const changed = await this.database.prepare(
            `UPDATE venue_requests
                SET venue_id = @venueId, source_submission_id = @submissionId,
                    status = 'resolved',
                    resolution_note = 'Resolved by an approved Google-verified venue submission.',
                    resolved_at = @now, resolved_by = @reviewerId, updated_at = @now
              WHERE id = @requestId AND status = @expectedStatus AND updated_at = @expectedUpdatedAt`,
          ).run({
            venueId: current.venueId,
            submissionId,
            now,
            reviewerId,
            requestId: request.id,
            expectedStatus: request.status,
            expectedUpdatedAt: persistedUtc(request.updatedAt),
          });
          if (changed.changes !== 1) return fail("venue_decision_stale");
        }
        this.injectApprovalFailure(failureInjection, "after_venue");

        const firstEvidenceReference = evidenceRows[0]
          ? `community-submission:${submissionId}:evidence:${safeInteger(evidenceRows[0].sortOrder ?? 0)}`
          : null;
        for (const [index, item] of items.entries()) {
          const decision = decisionsByItem.get(item.id)!;
          await this.database.prepare(
            `INSERT INTO venue_price_records (
               id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
               price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
               source_type, source_submission_id, source_ingestion_id,
               source_evidence_reference, source_evidence_verified_at,
               last_verified_at, created_at, updated_at
             ) VALUES (
               @id, @venueId, @venueName, @suburb, @beerName, @normalizedBeerId, @servingSize,
               @price, @falsity, NULL, @isOnTap, @confidence,
               @sourceType, @submissionId, NULL, @sourceEvidenceReference,
               @sourceEvidenceVerifiedAt, @lastVerifiedAt, @now, @now
             )`,
          ).run({
            id: priceRecordIds[index],
            venueId: current.venueId,
            venueName: current.pendingVenue?.name || current.venueName,
            suburb: current.pendingVenue?.suburb ?? current.suburb,
            beerName: decision.activeCatalogName,
            normalizedBeerId: decision.activeCatalogKey,
            servingSize: item.servingSize,
            price: item.price,
            falsity: booleanBinding(this.database.dialect, false),
            isOnTap: item.isOnTap,
            confidence,
            sourceType: evidenceRows.length ? "photo_upload" : "manual_submission",
            submissionId,
            sourceEvidenceReference: firstEvidenceReference,
            sourceEvidenceVerifiedAt: firstEvidenceReference ? now : null,
            lastVerifiedAt: current.observedAt,
            now,
          });
          if (current.pendingVenue) {
            await this.database.prepare(
              `INSERT INTO venue_beers (
                 id, venue_id, beer_name, normalized_beer_id, brewery, style, abv,
                 serve_size, price, currency, on_tap, in_stock, notes,
                 price_verified_at, stock_verified_at, source_ingestion_id, created_at, updated_at
               ) VALUES (
                 @id, @venueId, @beerName, @normalizedBeerId, @brewery, @style, @abv,
                 @serveSize, @price, 'AUD', @onTap, @inStock, @notes,
                 @now, @now, NULL, @now, @now
               )`,
            ).run({
              id: inventoryIds[index],
              venueId: current.venueId,
              beerName: decision.activeCatalogName,
              normalizedBeerId: decision.activeCatalogKey,
              brewery: catalog.get(decision.activeCatalogKey)?.brewery ?? null,
              style: catalog.get(decision.activeCatalogKey)?.style ?? null,
              abv: catalog.get(decision.activeCatalogKey)?.abv ?? null,
              serveSize: item.servingSize,
              price: item.price,
              onTap: booleanBinding(this.database.dialect, item.isOnTap === "yes"),
              inStock: booleanBinding(this.database.dialect, item.isOnTap !== "no"),
              notes: "Approved user-submitted venue launch row.",
              now,
            });
          }
        }
        this.injectApprovalFailure(failureInjection, "after_public_prices");

        const isOwnReview = current.userId === reviewerId;
        const eligiblePoints = current.pointsEligibleByLocation && submitter.status !== "suspended" && !isOwnReview
          ? pointsAwarded
          : 0;
        let awarded = 0;
        if (eligiblePoints > 0) {
          const ledger = await this.database.prepare(
            `INSERT OR IGNORE INTO contribution_ledger (
               id, user_id, submission_id, venue_id, points, reason, month_key, created_at
             ) VALUES (@id, @userId, @submissionId, @venueId, @points, @reason, @monthKey, @now)`,
          ).run({
            id: `${current.userId}:${current.venueId}:${monthKey}`,
            userId: current.userId,
            submissionId,
            venueId: current.venueId,
            points: eligiblePoints,
            reason: current.submissionType,
            monthKey,
            now,
          });
          awarded = ledger.changes === 1 ? eligiblePoints : 0;
        }
        await this.database.prepare(
          `UPDATE accounts
              SET approved_submission_count = approved_submission_count + 1,
                  trust_score = min(100, trust_score + 3), updated_at = @now
            WHERE id = @userId`,
        ).run({ now, userId: current.userId });
        const pointRow = await this.database.prepare(
          `SELECT COALESCE(sum(ledger.points), 0) AS "points"
             FROM contribution_ledger ledger
            WHERE ledger.user_id = ? AND ledger.month_key = ?`,
        ).get<{ points: number | string }>(current.userId, monthKey);
        const currentMonthPoints = persistedNumber(pointRow?.points ?? 0, 0, 1_000_000_000) ?? 0;
        await this.database.prepare(
          `UPDATE accounts SET contribution_points_current_month = @points WHERE id = @userId`,
        ).run({ points: currentMonthPoints, userId: current.userId });
        if (currentMonthPoints >= contributorUnlockPoints
            && submitter.status !== "suspended"
            && !["premium_monthly", "premium_yearly", "admin"].includes(submitter.subscriptionStatus)) {
          await this.database.prepare(
            `UPDATE accounts
                SET subscription_status = 'contributor_unlocked', premium_until = @premiumUntil,
                    updated_at = @now
              WHERE id = @userId AND auth_provider <> 'deleted'
                AND NOT EXISTS (
                  SELECT 1 FROM account_deletion_requests deletion
                   WHERE deletion.user_id = accounts.id
                     AND deletion.status IN ('processing', 'failed', 'completed')
                )`,
          ).run({ premiumUntil, now, userId: current.userId });
        }
        this.injectApprovalFailure(failureInjection, "after_rewards");

        const winningProgressId = missionDecision?.progressId ?? null;
        for (const missionId of missionIds) {
          for (const progress of progressByMission.get(missionId) ?? []) {
            if (progress.id === winningProgressId) {
              const changed = await this.database.prepare(
                `UPDATE mission_progress
                    SET status = 'completed', completed_at = @now, updated_at = @now
                  WHERE id = @id AND status = 'submitted'
                    AND user_id = @userId AND submission_id = @submissionId`,
              ).run({ id: progress.id, now, userId: current.userId, submissionId });
              if (changed.changes !== 1) return fail("mission_decision_stale");
            } else if (["accepted", "submitted"].includes(progress.status)) {
              await this.database.prepare(
                `UPDATE mission_progress
                    SET status = 'cancelled', completed_at = NULL, updated_at = @now
                  WHERE id = @id AND status IN ('accepted', 'submitted')`,
              ).run({ id: progress.id, now });
            }
          }
          for (const submission of lockedSubmissions.values()) {
            if (submission.id === submissionId || submission.missionId !== missionId
                || !["pending", "needs_more_evidence"].includes(submission.status)) continue;
            await this.database.prepare(
              `UPDATE submissions SET mission_id = NULL, updated_at = @now
                WHERE id = @id AND mission_id = @missionId
                  AND status IN ('pending', 'needs_more_evidence')`,
            ).run({ now, id: submission.id, missionId });
          }
          const mission = missions.get(missionId);
          if (!mission) return fail("mission_decision_stale");
          const changed = await this.database.prepare(
            `UPDATE missions SET active = @falsity, updated_at = @now
              WHERE id = @id AND active = @truth AND updated_at = @expectedUpdatedAt`,
          ).run({
            falsity: booleanBinding(this.database.dialect, false),
            truth: booleanBinding(this.database.dialect, true),
            now,
            id: missionId,
            expectedUpdatedAt: persistedUtc(mission.updatedAt),
          });
          if (changed.changes !== 1) return fail("mission_decision_stale");
        }
        this.injectApprovalFailure(failureInjection, "after_missions");

        const metadataJson = jsonText({
          fingerprint,
          approvalId,
          submissionId,
          priceRecordIds,
          resolvedVenueRequestIds: expectedRequests.map((decision) => decision.requestId),
        });
        await this.database.prepare(
          `INSERT INTO security_audit_log (
             id, actor_user_id, actor_role, action, target_type, target_id,
             metadata_json, ip_hash, user_agent_hash, created_at
           ) VALUES (
             @id, @reviewerId, @actorRole, 'community_submission_approved',
             'submission', @submissionId, @metadataJson, NULL, NULL, @now
           )`,
        ).run({
          id: auditId,
          reviewerId,
          actorRole: reviewer.role,
          submissionId,
          metadataJson,
          now,
        });
        this.injectApprovalFailure(failureInjection, "before_finalize");
        const finalized = await this.database.prepare(
          `UPDATE submissions
              SET status = 'approved', points_awarded = @pointsAwarded,
                  reviewed_by = @reviewerId, reviewed_at = @now,
                  rejection_reason = NULL, fraud_flagged = @falsity, updated_at = @now
            WHERE id = @submissionId AND status IN ('pending', 'needs_more_evidence')`,
        ).run({
          pointsAwarded: awarded,
          reviewerId,
          now,
          falsity: booleanBinding(this.database.dialect, false),
          submissionId,
        });
        if (finalized.changes !== 1) return fail("submission_not_reviewable");

        const finalSubmissionRow = await this.submissionRowById(submissionId);
        const finalAccount = (await this.accountRows([current.userId]))[0];
        if (!finalSubmissionRow || !finalAccount) return fail("persistence_failure");
        return approvalResult(
          "applied",
          persistedSubmission(finalSubmissionRow),
          finalAccount,
          items.map((item) => item.id),
        );
      })();
    });
  }
}
