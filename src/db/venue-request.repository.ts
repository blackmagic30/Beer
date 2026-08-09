import crypto from "node:crypto";

import {
  missionLifecycleMissionLockKey,
  type MissionLifecycleMission,
} from "./mission-lifecycle.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ID_LENGTH = 255;
const MAX_REQUEST_ID_LENGTH = 255;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_GOOGLE_PLACE_ID_LENGTH = 255;
const MAX_VENUE_NAME_LENGTH = 240;
const MAX_BEER_NAME_LENGTH = 240;
const MAX_SUBURB_LENGTH = 160;
const MAX_NOTES_LENGTH = 2_000;
const MAX_RESOLUTION_NOTE_LENGTH = 2_000;
const MAX_PAGE_SIZE = 100;
const MAX_POINTS = 1_000_000;
const MAX_MULTIPLIER = 100;
const DECIMAL_SCALE = 1_000_000;

export const VENUE_REQUEST_LOCK_CONTRACT = Object.freeze({
  version: 1,
  accountPrefix: "venue-request:account:",
  requestPrefix: "venue-request:request:",
  duplicatePrefix: "venue-request:duplicate:",
  order: "sorted-advisory-locks-before-account-rows-before-request-row-before-mission-insert",
} as const);

export function venueRequestAccountLockKey(accountId: string): string {
  return `${VENUE_REQUEST_LOCK_CONTRACT.accountPrefix}${inputIdentifier(accountId)}`;
}

export function venueRequestLockKey(requestId: string): string {
  return `${VENUE_REQUEST_LOCK_CONTRACT.requestPrefix}${inputIdentifier(requestId, MAX_REQUEST_ID_LENGTH)}`;
}

export type VenueRequestType =
  | "missing_venue"
  | "missing_beer"
  | "verify_venue"
  | "verify_beer_at_venue";

export type VenueRequestTrustStatus = "open" | "in_progress" | "resolved" | "rejected";
export type VenueRequestStatus = VenueRequestTrustStatus | "mission_created";

export interface VenueRequestRecord {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  requestType: VenueRequestType;
  venueId: string | null;
  venueName: string | null;
  googlePlaceId: string | null;
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  status: VenueRequestStatus;
  missionId: string | null;
  sourceSubmissionId: string | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrGetVenueRequestInput {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  requestType: VenueRequestType;
  venueId: string | null;
  venueName: string | null;
  googlePlaceId: string | null;
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  now: string;
}

export interface CreateOrGetVenueRequestResult {
  request: VenueRequestRecord;
  duplicate: boolean;
  ownershipPromoted: boolean;
}

export interface VenueRequestListCursor {
  createdAt: string;
  id: string;
}

export interface VenueRequestListPage {
  requests: VenueRequestRecord[];
  nextCursor: VenueRequestListCursor | null;
}

export interface VenueRequestMissionCreationResult {
  request: VenueRequestRecord;
  mission: MissionLifecycleMission;
}

export type VenueRequestRepositoryErrorCode =
  | "account_not_eligible"
  | "account_not_found"
  | "admin_not_authorized"
  | "deletion_locked"
  | "invalid_input"
  | "malformed_record"
  | "mission_id_conflict"
  | "persistence_failure"
  | "request_id_conflict"
  | "request_not_found"
  | "request_state_conflict"
  | "request_version_conflict";

const ERROR_MESSAGES: Readonly<Record<VenueRequestRepositoryErrorCode, string>> = {
  account_not_eligible: "The account is not eligible to create or change venue requests.",
  account_not_found: "The venue-request account does not exist.",
  admin_not_authorized: "The account is not authorised to administer venue requests.",
  deletion_locked: "Venue-request changes are unavailable while account deletion is being processed.",
  invalid_input: "The venue-request persistence input is invalid.",
  malformed_record: "Stored venue-request data is malformed.",
  mission_id_conflict: "The requested mission identity is already in use.",
  persistence_failure: "Venue-request persistence could not be completed.",
  request_id_conflict: "The venue-request identity is already assigned to different data.",
  request_not_found: "The venue request does not exist.",
  request_state_conflict: "The venue request is no longer in the required workflow state.",
  request_version_conflict: "The venue request changed before this operation completed.",
};

/** Stable, secret-free failures for future service and HTTP error mapping. */
export class VenueRequestRepositoryError extends Error {
  readonly code: VenueRequestRepositoryErrorCode;

  constructor(code: VenueRequestRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueRequestRepositoryError";
    this.code = code;
  }
}

type RawRow = Record<string, unknown>;

interface VenueRequestRow extends RawRow {
  id: unknown;
  userId: unknown;
  anonymousSessionId: unknown;
  requestType: unknown;
  venueId: unknown;
  venueName: unknown;
  googlePlaceId: unknown;
  beerName: unknown;
  suburb: unknown;
  notes: unknown;
  status: unknown;
  missionId: unknown;
  sourceSubmissionId: unknown;
  assignedTo: unknown;
  resolutionNote: unknown;
  resolvedAt: unknown;
  resolvedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface AccountFenceRow extends RawRow {
  id: unknown;
  status: unknown;
  authProvider: unknown;
  role: unknown;
  subscriptionStatus: unknown;
  deletionLocked: unknown;
}

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

interface NormalizedCreateInput {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  requestType: VenueRequestType;
  venueId: string | null;
  venueName: string | null;
  googlePlaceId: string | null;
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  now: string;
}

const REQUEST_PROJECTION = `
  request.id AS "id",
  request.user_id AS "userId",
  request.anonymous_session_id AS "anonymousSessionId",
  request.request_type AS "requestType",
  request.venue_id AS "venueId",
  request.venue_name AS "venueName",
  request.google_place_id AS "googlePlaceId",
  request.beer_name AS "beerName",
  request.suburb AS "suburb",
  request.notes AS "notes",
  request.status AS "status",
  request.mission_id AS "missionId",
  request.source_submission_id AS "sourceSubmissionId",
  request.assigned_to AS "assignedTo",
  request.resolution_note AS "resolutionNote",
  request.resolved_at AS "resolvedAt",
  request.resolved_by AS "resolvedBy",
  request.created_at AS "createdAt",
  request.updated_at AS "updatedAt"`;

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

function fail(code: VenueRequestRepositoryErrorCode): never {
  throw new VenueRequestRepositoryError(code);
}

function inputIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\r\n\0]/.test(normalized)
  ) return fail("invalid_input");
  return normalized;
}

function optionalInputIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\r\n\0]/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function optionalInputText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function recordIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\r\n\0]/.test(value)
  ) return fail("malformed_record");
  return value;
}

function optionalRecordIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string | null {
  if (value === null) return null;
  return recordIdentifier(value, maximum);
}

function optionalRecordText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function recordText(value: unknown, maximum: number): string {
  const parsed = optionalRecordText(value, maximum);
  if (parsed === null) return fail("malformed_record");
  return parsed;
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

function optionalRecordTimestamp(value: unknown): string | null {
  return value === null ? null : recordTimestamp(value);
}

function inputRequestType(value: unknown): VenueRequestType {
  if (
    value !== "missing_venue"
    && value !== "missing_beer"
    && value !== "verify_venue"
    && value !== "verify_beer_at_venue"
  ) return fail("invalid_input");
  return value;
}

function recordRequestType(value: unknown): VenueRequestType {
  try {
    return inputRequestType(value);
  } catch (error) {
    if (error instanceof VenueRequestRepositoryError) return fail("malformed_record");
    throw error;
  }
}

function inputTrustStatus(value: unknown): VenueRequestTrustStatus {
  if (value !== "open" && value !== "in_progress" && value !== "resolved" && value !== "rejected") {
    return fail("invalid_input");
  }
  return value;
}

function inputStatus(value: unknown): VenueRequestStatus {
  if (value === "mission_created") return value;
  return inputTrustStatus(value);
}

function recordStatus(value: unknown): VenueRequestStatus {
  if (
    value !== "open"
    && value !== "in_progress"
    && value !== "resolved"
    && value !== "rejected"
    && value !== "mission_created"
  ) return fail("malformed_record");
  return value;
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
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

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  const text = String(value);
  if (!/^\d+$/.test(text)) return fail("malformed_record");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail("malformed_record");
  return parsed;
}

function pageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    return fail("invalid_input");
  }
  return value;
}

function mutationTimestamp(now: string, previous: readonly string[]): string {
  const latest = previous.reduce((maximum, value) => Math.max(maximum, Date.parse(value)), -Infinity);
  if (Date.parse(now) > latest) return now;
  const next = new Date(latest + 1).toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(next)) return fail("invalid_input");
  return next;
}

function venueRequestRecord(row: VenueRequestRow): VenueRequestRecord {
  const status = recordStatus(row.status);
  const missionId = optionalRecordIdentifier(row.missionId);
  const resolvedAt = optionalRecordTimestamp(row.resolvedAt);
  const resolvedBy = optionalRecordIdentifier(row.resolvedBy);
  const createdAt = recordTimestamp(row.createdAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  if (
    updatedAt < createdAt
    || status === "mission_created" && missionId === null
    || (status === "resolved" || status === "rejected") && resolvedAt === null
    || (status === "open" || status === "in_progress" || status === "mission_created") && resolvedAt !== null
    || resolvedBy !== null && resolvedAt === null
    || resolvedAt !== null && updatedAt < resolvedAt
  ) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id, MAX_REQUEST_ID_LENGTH),
    userId: optionalRecordIdentifier(row.userId),
    anonymousSessionId: optionalRecordIdentifier(row.anonymousSessionId, MAX_SESSION_ID_LENGTH),
    requestType: recordRequestType(row.requestType),
    venueId: optionalRecordIdentifier(row.venueId),
    venueName: optionalRecordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    googlePlaceId: optionalRecordIdentifier(row.googlePlaceId, MAX_GOOGLE_PLACE_ID_LENGTH),
    beerName: optionalRecordText(row.beerName, MAX_BEER_NAME_LENGTH),
    suburb: optionalRecordText(row.suburb, MAX_SUBURB_LENGTH),
    notes: optionalRecordText(row.notes, MAX_NOTES_LENGTH),
    status,
    missionId,
    sourceSubmissionId: optionalRecordIdentifier(row.sourceSubmissionId),
    assignedTo: optionalRecordIdentifier(row.assignedTo),
    resolutionNote: optionalRecordText(row.resolutionNote, MAX_RESOLUTION_NOTE_LENGTH),
    resolvedAt,
    resolvedBy,
    createdAt,
    updatedAt,
  };
}

function missionRecord(row: MissionRow): MissionLifecycleMission {
  const priority = row.priority;
  if (priority !== "low" && priority !== "normal" && priority !== "high") return fail("malformed_record");
  const createdAt = recordTimestamp(row.createdAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  if (updatedAt < createdAt) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id),
    venueId: recordIdentifier(row.venueId),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: optionalRecordText(row.suburb, MAX_SUBURB_LENGTH),
    reason: recordText(row.reason, 2_000),
    priority,
    points: recordDecimal(row.points, 0, MAX_POINTS),
    multiplier: recordDecimal(row.multiplier, 0, MAX_MULTIPLIER),
    active: recordBoolean(row.active),
    sponsorFlag: recordBoolean(row.sponsorFlag),
    lastVerifiedAt: optionalRecordTimestamp(row.lastVerifiedAt),
    createdAt,
    updatedAt,
  };
}

function normalizedCreateInput(input: CreateOrGetVenueRequestInput): NormalizedCreateInput {
  const requestType = inputRequestType(input.requestType);
  const normalized: NormalizedCreateInput = {
    id: inputIdentifier(input.id, MAX_REQUEST_ID_LENGTH),
    userId: optionalInputIdentifier(input.userId),
    anonymousSessionId: optionalInputIdentifier(input.anonymousSessionId, MAX_SESSION_ID_LENGTH),
    requestType,
    venueId: optionalInputIdentifier(input.venueId),
    venueName: optionalInputText(input.venueName, MAX_VENUE_NAME_LENGTH),
    googlePlaceId: optionalInputIdentifier(input.googlePlaceId, MAX_GOOGLE_PLACE_ID_LENGTH),
    beerName: optionalInputText(input.beerName, MAX_BEER_NAME_LENGTH),
    suburb: optionalInputText(input.suburb, MAX_SUBURB_LENGTH),
    notes: optionalInputText(input.notes, MAX_NOTES_LENGTH),
    now: inputTimestamp(input.now),
  };
  if (
    requestType !== "missing_beer"
    && normalized.venueId === null
    && normalized.venueName === null
  ) return fail("invalid_input");
  if (
    (requestType === "missing_beer" || requestType === "verify_beer_at_venue")
    && normalized.beerName === null
  ) return fail("invalid_input");
  return normalized;
}

function sameCreateCore(existing: VenueRequestRecord, desired: NormalizedCreateInput): boolean {
  return existing.id === desired.id
    && existing.requestType === desired.requestType
    && existing.venueId === desired.venueId
    && existing.venueName === desired.venueName
    && existing.googlePlaceId === desired.googlePlaceId
    && existing.beerName === desired.beerName
    && existing.suburb === desired.suburb
    && existing.notes === desired.notes;
}

function ownsExistingRequest(existing: VenueRequestRecord, desired: NormalizedCreateInput): boolean {
  if (desired.userId !== null) {
    return existing.userId === desired.userId
      || existing.userId === null
        && desired.anonymousSessionId !== null
        && existing.anonymousSessionId === desired.anonymousSessionId;
  }
  if (desired.anonymousSessionId !== null) {
    return existing.userId === null && existing.anonymousSessionId === desired.anonymousSessionId;
  }
  return existing.userId === null && existing.anonymousSessionId === null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

function duplicateLockKey(kind: "user" | "anonymous", owner: string, googlePlaceId: string): string {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([kind, owner, googlePlaceId]))
    .digest("hex");
  return `${VENUE_REQUEST_LOCK_CONTRACT.duplicatePrefix}${digest}`;
}

function requestMissionVenueId(request: VenueRequestRecord): string {
  if (request.venueId !== null) return request.venueId;
  const legacyId = `request:${request.id}`;
  if (legacyId.length <= MAX_ID_LENGTH) return legacyId;
  return `request:${crypto.createHash("sha256").update(request.id).digest("hex")}`;
}

/**
 * Async venue-request persistence for SQLite rehearsal and native PostgreSQL.
 * Provider calls and security audit/event publication remain outside the short
 * database transactions.
 *
 * Google-submission resolution deliberately remains with
 * CommunitySubmissionRepository because its authority also cancels linked
 * mission progress, detaches competing submissions, and deactivates missions.
 * Generic workflow updates refuse `mission_created` rows for the same reason.
 *
 * Account-deletion writers must adopt `venue-request:account:<id>` (or lock the
 * account row first) to close the remaining cross-repository deletion race.
 */
export class VenueRequestRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(
    work: () => Promise<Result>,
    uniqueCode: VenueRequestRepositoryErrorCode = "persistence_failure",
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueRequestRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new VenueRequestRepositoryError(uniqueCode);
      throw new VenueRequestRepositoryError("persistence_failure");
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
    for (const key of [...new Set(keys)].sort()) {
      await this.database.prepare(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private async requestRowById(id: string, lock = false): Promise<VenueRequestRow | null> {
    const row = await this.database.prepare(
      `SELECT ${REQUEST_PROJECTION}
         FROM venue_requests request
        WHERE request.id = ?${lock ? this.lockSuffix("request") : ""}`,
    ).get<VenueRequestRow>(id);
    return row ?? null;
  }

  private async userGoogleDuplicate(
    userId: string,
    googlePlaceId: string,
    lock: boolean,
  ): Promise<VenueRequestRow | null> {
    const row = await this.database.prepare(
      `SELECT ${REQUEST_PROJECTION}
         FROM venue_requests request
        WHERE request.request_type = 'missing_venue'
          AND request.google_place_id = ? AND request.user_id = ?
          AND request.status IN ('open', 'in_progress', 'mission_created')
        ORDER BY request.created_at ASC, request.id ASC
        LIMIT 1${lock ? this.lockSuffix("request") : ""}`,
    ).get<VenueRequestRow>(googlePlaceId, userId);
    return row ?? null;
  }

  private async anonymousGoogleDuplicate(
    anonymousSessionId: string,
    googlePlaceId: string,
    lock: boolean,
  ): Promise<VenueRequestRow | null> {
    const row = await this.database.prepare(
      `SELECT ${REQUEST_PROJECTION}
         FROM venue_requests request
        WHERE request.request_type = 'missing_venue'
          AND request.google_place_id = ?
          AND request.user_id IS NULL AND request.anonymous_session_id = ?
          AND request.status IN ('open', 'in_progress', 'mission_created')
        ORDER BY request.created_at ASC, request.id ASC
        LIMIT 1${lock ? this.lockSuffix("request") : ""}`,
    ).get<VenueRequestRow>(googlePlaceId, anonymousSessionId);
    return row ?? null;
  }

  private async accountRow(id: string, lock: boolean): Promise<AccountFenceRow | null> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id", account.status AS "status",
              account.auth_provider AS "authProvider", account.role AS "role",
              account.subscription_status AS "subscriptionStatus",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${lock ? this.lockSuffix("account") : ""}`,
    ).get<AccountFenceRow>(id);
    return row ?? null;
  }

  private async lockAccounts(ids: readonly string[]): Promise<Map<string, AccountFenceRow>> {
    const rows = new Map<string, AccountFenceRow>();
    for (const id of [...new Set(ids)].sort()) {
      const row = await this.accountRow(id, true);
      if (row) rows.set(id, row);
    }
    return rows;
  }

  private accountSnapshot(row: AccountFenceRow | null): {
    id: string;
    status: "active" | "warned" | "suspended";
    authProvider: string;
    role: string;
    subscriptionStatus: string;
    deletionLocked: boolean;
  } {
    if (!row) return fail("account_not_found");
    const status = recordText(row.status, 32);
    if (status !== "active" && status !== "warned" && status !== "suspended") {
      return fail("malformed_record");
    }
    return {
      id: recordIdentifier(row.id),
      status,
      authProvider: recordText(row.authProvider, 64),
      role: recordText(row.role, 64),
      subscriptionStatus: recordText(row.subscriptionStatus, 64),
      deletionLocked: recordBoolean(row.deletionLocked),
    };
  }

  private requireEligibleOwner(row: AccountFenceRow | null): void {
    const account = this.accountSnapshot(row);
    if (account.deletionLocked || account.authProvider === "deleted") return fail("deletion_locked");
    if (account.status !== "active" && account.status !== "warned") return fail("account_not_eligible");
  }

  private requireAdmin(row: AccountFenceRow | null): void {
    const account = this.accountSnapshot(row);
    if (account.deletionLocked || account.authProvider === "deleted") return fail("deletion_locked");
    if (
      account.status !== "active"
      || account.role !== "admin" && account.subscriptionStatus !== "admin"
    ) return fail("admin_not_authorized");
  }

  private async requireOwnerStillEligible(userId: string): Promise<void> {
    this.requireEligibleOwner(await this.accountRow(userId, false));
  }

  private async requireAdminsStillEligible(accountIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(accountIds)].sort()) {
      this.requireAdmin(await this.accountRow(id, false));
    }
  }

  private createLockKeys(input: NormalizedCreateInput): string[] {
    const keys = [venueRequestLockKey(input.id)];
    if (input.userId) keys.push(venueRequestAccountLockKey(input.userId));
    if (input.requestType === "missing_venue" && input.googlePlaceId) {
      if (input.userId) keys.push(duplicateLockKey("user", input.userId, input.googlePlaceId));
      if (input.anonymousSessionId) {
        keys.push(duplicateLockKey("anonymous", input.anonymousSessionId, input.googlePlaceId));
      }
    }
    return keys;
  }

  private async promoteOwnership(
    existing: VenueRequestRecord,
    userId: string,
    now: string,
  ): Promise<VenueRequestRecord> {
    if (existing.userId === userId) return existing;
    if (existing.userId !== null || existing.anonymousSessionId === null) return fail("request_id_conflict");
    const updatedAt = mutationTimestamp(now, [existing.updatedAt]);
    const changed = await this.database.prepare(
      `UPDATE venue_requests SET user_id = @userId, updated_at = @updatedAt
        WHERE id = @id AND user_id IS NULL AND updated_at = @expectedUpdatedAt`,
    ).run({ id: existing.id, userId, updatedAt, expectedUpdatedAt: existing.updatedAt });
    if (changed.changes !== 1) return fail("request_version_conflict");
    const row = await this.requestRowById(existing.id);
    if (!row) return fail("persistence_failure");
    const promoted = venueRequestRecord(row);
    if (promoted.userId !== userId) return fail("request_version_conflict");
    return promoted;
  }

  private async existingDuplicate(input: NormalizedCreateInput): Promise<VenueRequestRecord | null> {
    if (input.requestType !== "missing_venue" || input.googlePlaceId === null) return null;
    if (input.userId !== null) {
      const user = await this.userGoogleDuplicate(input.userId, input.googlePlaceId, true);
      if (user) return venueRequestRecord(user);
      if (input.anonymousSessionId !== null) {
        const anonymous = await this.anonymousGoogleDuplicate(
          input.anonymousSessionId,
          input.googlePlaceId,
          true,
        );
        if (anonymous) return venueRequestRecord(anonymous);
      }
      return null;
    }
    if (input.anonymousSessionId === null) return null;
    const anonymous = await this.anonymousGoogleDuplicate(
      input.anonymousSessionId,
      input.googlePlaceId,
      true,
    );
    return anonymous ? venueRequestRecord(anonymous) : null;
  }

  private async duplicateResult(
    existing: VenueRequestRecord,
    input: NormalizedCreateInput,
    requireSameCore: boolean,
  ): Promise<CreateOrGetVenueRequestResult> {
    if (requireSameCore && (!sameCreateCore(existing, input) || !ownsExistingRequest(existing, input))) {
      return fail("request_id_conflict");
    }
    if (input.userId !== null && existing.userId === null) {
      if (
        input.anonymousSessionId === null
        || existing.anonymousSessionId !== input.anonymousSessionId
      ) return fail("request_id_conflict");
      const promoted = await this.promoteOwnership(existing, input.userId, input.now);
      await this.requireOwnerStillEligible(input.userId);
      return { request: promoted, duplicate: true, ownershipPromoted: true };
    }
    if (input.userId !== null) await this.requireOwnerStillEligible(input.userId);
    return { request: existing, duplicate: true, ownershipPromoted: false };
  }

  async createOrGetVenueRequest(
    input: CreateOrGetVenueRequestInput,
  ): Promise<CreateOrGetVenueRequestResult> {
    const normalized = normalizedCreateInput(input);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks(this.createLockKeys(normalized));
      if (normalized.userId) {
        this.requireEligibleOwner(await this.accountRow(normalized.userId, true));
      }

      const existingIdRow = await this.requestRowById(normalized.id, true);
      if (existingIdRow) {
        return this.duplicateResult(venueRequestRecord(existingIdRow), normalized, true);
      }

      const duplicate = await this.existingDuplicate(normalized);
      if (duplicate) return this.duplicateResult(duplicate, normalized, false);

      const inserted = await this.database.prepare(
        `INSERT INTO venue_requests (
           id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
           google_place_id, beer_name, suburb, notes, status, mission_id,
           source_submission_id, assigned_to, resolution_note, resolved_at,
           resolved_by, created_at, updated_at
         ) VALUES (
           @id, @userId, @anonymousSessionId, @requestType, @venueId, @venueName,
           @googlePlaceId, @beerName, @suburb, @notes, 'open', NULL,
           NULL, NULL, NULL, NULL, NULL, @now, @now
         ) ON CONFLICT DO NOTHING`,
      ).run(normalized);
      if (inserted.changes !== 1) {
        const conflictById = await this.requestRowById(normalized.id, true);
        if (conflictById) return this.duplicateResult(venueRequestRecord(conflictById), normalized, true);
        const conflictDuplicate = await this.existingDuplicate(normalized);
        if (conflictDuplicate) return this.duplicateResult(conflictDuplicate, normalized, false);
        return fail("request_id_conflict");
      }

      if (normalized.userId) await this.requireOwnerStillEligible(normalized.userId);
      const row = await this.requestRowById(normalized.id);
      if (!row) return fail("persistence_failure");
      const request = venueRequestRecord(row);
      if (!sameCreateCore(request, normalized) || !ownsExistingRequest(request, normalized)) {
        return fail("persistence_failure");
      }
      return { request, duplicate: false, ownershipPromoted: false };
    }), "request_id_conflict");
  }

  async getVenueRequestById(id: string): Promise<VenueRequestRecord | null> {
    const requestId = inputIdentifier(id, MAX_REQUEST_ID_LENGTH);
    return this.guarded(async () => {
      const row = await this.requestRowById(requestId);
      return row ? venueRequestRecord(row) : null;
    });
  }

  async listVenueRequests(input: {
    limit: number;
    cursor?: VenueRequestListCursor | null | undefined;
    status?: VenueRequestStatus | undefined;
    requestType?: VenueRequestType | undefined;
  }): Promise<VenueRequestListPage> {
    const limit = pageSize(input.limit);
    const cursor = input.cursor == null ? null : {
      createdAt: inputTimestamp(input.cursor.createdAt),
      id: inputIdentifier(input.cursor.id, MAX_REQUEST_ID_LENGTH),
    };
    const status = input.status === undefined ? null : inputStatus(input.status);
    const requestType = input.requestType === undefined ? null : inputRequestType(input.requestType);
    return this.guarded(async () => {
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = { limit: limit + 1 };
      if (status !== null) {
        conditions.push("request.status = @status");
        bindings.status = status;
      }
      if (requestType !== null) {
        conditions.push("request.request_type = @requestType");
        bindings.requestType = requestType;
      }
      if (cursor !== null) {
        conditions.push(`(
          request.created_at < @cursorCreatedAt
          OR (request.created_at = @cursorCreatedAt AND request.id > @cursorId)
        )`);
        bindings.cursorCreatedAt = cursor.createdAt;
        bindings.cursorId = cursor.id;
      }
      const rows = await this.database.prepare(
        `SELECT ${REQUEST_PROJECTION}
           FROM venue_requests request
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY request.created_at DESC, request.id ASC
          LIMIT @limit`,
      ).all<VenueRequestRow>(bindings);
      const records = rows.map(venueRequestRecord);
      const hasMore = records.length > limit;
      const requests = hasMore ? records.slice(0, limit) : records;
      const last = requests.at(-1);
      return {
        requests,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async countVenueRequests(input: {
    status?: VenueRequestStatus | undefined;
    requestType?: VenueRequestType | undefined;
  } = {}): Promise<number> {
    const status = input.status === undefined ? null : inputStatus(input.status);
    const requestType = input.requestType === undefined ? null : inputRequestType(input.requestType);
    return this.guarded(async () => {
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = {};
      if (status !== null) {
        conditions.push("request.status = @status");
        bindings.status = status;
      }
      if (requestType !== null) {
        conditions.push("request.request_type = @requestType");
        bindings.requestType = requestType;
      }
      const row = await this.database.prepare(
        `SELECT count(*) AS "count" FROM venue_requests request
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
      ).get<{ count: unknown }>(bindings);
      return safeCount(row?.count);
    });
  }

  async updateTrustWorkflow(input: {
    actorAccountId: string;
    requestId: string;
    status: VenueRequestTrustStatus;
    assignedTo: string | null;
    resolutionNote: string | null;
    expectedUpdatedAt: string;
    now: string;
  }): Promise<VenueRequestRecord> {
    const actorAccountId = inputIdentifier(input.actorAccountId);
    const requestId = inputIdentifier(input.requestId, MAX_REQUEST_ID_LENGTH);
    const status = inputTrustStatus(input.status);
    const assignedTo = optionalInputIdentifier(input.assignedTo);
    const resolutionNote = optionalInputText(input.resolutionNote, MAX_RESOLUTION_NOTE_LENGTH);
    const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
    const now = inputTimestamp(input.now);
    const accountIds = assignedTo === null ? [actorAccountId] : [actorAccountId, assignedTo];
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueRequestLockKey(requestId),
        ...accountIds.map(venueRequestAccountLockKey),
      ]);
      const accounts = await this.lockAccounts(accountIds);
      for (const id of accountIds) this.requireAdmin(accounts.get(id) ?? null);
      const row = await this.requestRowById(requestId, true);
      if (!row) return fail("request_not_found");
      const existing = venueRequestRecord(row);
      if (existing.updatedAt !== expectedUpdatedAt) return fail("request_version_conflict");
      if (existing.status === "mission_created" || existing.missionId !== null) {
        return fail("request_state_conflict");
      }

      const terminal = status === "resolved" || status === "rejected";
      if (
        existing.status === status
        && existing.assignedTo === assignedTo
        && existing.resolutionNote === resolutionNote
        && (terminal
          ? existing.resolvedAt !== null && existing.resolvedBy === actorAccountId
          : existing.resolvedAt === null && existing.resolvedBy === null)
      ) {
        await this.requireAdminsStillEligible(accountIds);
        return existing;
      }

      const updatedAt = mutationTimestamp(now, [existing.updatedAt]);
      const changed = await this.database.prepare(
        `UPDATE venue_requests
            SET status = @status, assigned_to = @assignedTo,
                resolution_note = @resolutionNote,
                resolved_at = @resolvedAt, resolved_by = @resolvedBy,
                updated_at = @updatedAt
          WHERE id = @requestId AND updated_at = @expectedUpdatedAt
            AND status <> 'mission_created' AND mission_id IS NULL`,
      ).run({
        status,
        assignedTo,
        resolutionNote,
        resolvedAt: terminal ? updatedAt : null,
        resolvedBy: terminal ? actorAccountId : null,
        updatedAt,
        requestId,
        expectedUpdatedAt,
      });
      if (changed.changes !== 1) return fail("request_version_conflict");
      await this.requireAdminsStillEligible(accountIds);
      const updated = await this.requestRowById(requestId);
      if (!updated) return fail("persistence_failure");
      const record = venueRequestRecord(updated);
      if (
        record.status !== status
        || record.assignedTo !== assignedTo
        || record.resolutionNote !== resolutionNote
        || terminal && (record.resolvedAt !== updatedAt || record.resolvedBy !== actorAccountId)
        || !terminal && (record.resolvedAt !== null || record.resolvedBy !== null)
      ) return fail("request_version_conflict");
      return record;
    }));
  }

  async createMissionFromVenueRequest(input: {
    actorAccountId: string;
    requestId: string;
    missionId: string;
    expectedRequestUpdatedAt: string;
    now: string;
  }): Promise<VenueRequestMissionCreationResult> {
    const actorAccountId = inputIdentifier(input.actorAccountId);
    const requestId = inputIdentifier(input.requestId, MAX_REQUEST_ID_LENGTH);
    const missionId = inputIdentifier(input.missionId);
    const expectedRequestUpdatedAt = inputTimestamp(input.expectedRequestUpdatedAt);
    const now = inputTimestamp(input.now);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueRequestAccountLockKey(actorAccountId),
        venueRequestLockKey(requestId),
        missionLifecycleMissionLockKey(missionId),
      ]);
      this.requireAdmin(await this.accountRow(actorAccountId, true));
      const row = await this.requestRowById(requestId, true);
      if (!row) return fail("request_not_found");
      const request = venueRequestRecord(row);
      if (request.updatedAt !== expectedRequestUpdatedAt) return fail("request_version_conflict");
      if (request.missionId !== null || request.status !== "open" && request.status !== "in_progress") {
        return fail("request_state_conflict");
      }

      const existingMission = await this.database.prepare(
        `SELECT ${MISSION_PROJECTION} FROM missions mission WHERE mission.id = ?`,
      ).get<MissionRow>(missionId);
      if (existingMission) {
        missionRecord(existingMission);
        return fail("mission_id_conflict");
      }

      const operationAt = mutationTimestamp(now, [request.updatedAt]);
      const mission = {
        id: missionId,
        venueId: requestMissionVenueId(request),
        venueName: request.venueName ?? request.beerName ?? "Requested venue",
        suburb: request.suburb,
        reason: request.requestType.replaceAll("_", " "),
        priority: "normal" as const,
        points: request.requestType === "verify_beer_at_venue" ? 2 : 4,
        multiplier: 1,
        active: true,
        sponsorFlag: false,
        lastVerifiedAt: null,
        createdAt: operationAt,
        updatedAt: operationAt,
      };
      const inserted = await this.database.prepare(
        `INSERT INTO missions (
           id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
           active, sponsor_flag, last_verified_at, created_at, updated_at
         ) VALUES (
           @id, @venueId, @venueName, @suburb, @reason, @priority, @points, @multiplier,
           @active, @sponsorFlag, @lastVerifiedAt, @createdAt, @updatedAt
         ) ON CONFLICT DO NOTHING`,
      ).run({
        ...mission,
        active: this.booleanValue(true),
        sponsorFlag: this.booleanValue(false),
      });
      if (inserted.changes !== 1) return fail("mission_id_conflict");

      const claimed = await this.database.prepare(
        `UPDATE venue_requests
            SET status = 'mission_created', mission_id = @missionId, updated_at = @operationAt
          WHERE id = @requestId AND updated_at = @expectedRequestUpdatedAt
            AND mission_id IS NULL AND status IN ('open', 'in_progress')`,
      ).run({ missionId, operationAt, requestId, expectedRequestUpdatedAt });
      if (claimed.changes !== 1) return fail("request_state_conflict");
      await this.requireAdminsStillEligible([actorAccountId]);

      const updatedRequestRow = await this.requestRowById(requestId);
      const createdMissionRow = await this.database.prepare(
        `SELECT ${MISSION_PROJECTION} FROM missions mission WHERE mission.id = ?`,
      ).get<MissionRow>(missionId);
      if (!updatedRequestRow || !createdMissionRow) return fail("persistence_failure");
      const updatedRequest = venueRequestRecord(updatedRequestRow);
      const createdMission = missionRecord(createdMissionRow);
      if (
        updatedRequest.status !== "mission_created"
        || updatedRequest.missionId !== missionId
        || createdMission.id !== missionId
        || createdMission.venueId !== mission.venueId
        || createdMission.venueName !== mission.venueName
      ) return fail("request_state_conflict");
      return { request: updatedRequest, mission: createdMission };
    }), "mission_id_conflict");
  }
}
