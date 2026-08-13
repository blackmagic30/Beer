import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ID_LENGTH = 200;
const MAX_VENUE_ID_LENGTH = 180;
const MAX_VENUE_NAME_LENGTH = 180;
const MAX_MANAGER_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 320;
const MAX_PHONE_LENGTH = 200;
const MAX_ROLE_LENGTH = 80;
const MAX_SUBURB_LENGTH = 160;
const MAX_CONTACT_NAME_LENGTH = 160;
const MAX_NOTES_LENGTH = 2_000;
const MAX_NEXT_ACTION_LENGTH = 2_000;
const MAX_RESOLUTION_NOTE_LENGTH = 2_000;
const MAX_PAGE_SIZE = 100;
const MAX_RELATIONSHIP_VENUES = 100;

export const VENUE_PARTNER_LOCK_CONTRACT = Object.freeze({
  version: 1,
  accountPrefix: "venue-partner:account:",
  interestPrefix: "venue-partner:interest:",
  outreachVenuePrefix: "venue-partner:outreach:venue:",
  outreachIdentityPrefix: "venue-partner:outreach:id:",
  order: "sorted-advisory-locks-before-account-rows-before-record-rows-before-conditional-writes",
} as const);

export function venuePartnerAccountLockKey(accountId: string): string {
  return `${VENUE_PARTNER_LOCK_CONTRACT.accountPrefix}${inputIdentifier(accountId)}`;
}

export function venuePartnerInterestLockKey(interestId: string): string {
  return `${VENUE_PARTNER_LOCK_CONTRACT.interestPrefix}${inputIdentifier(interestId)}`;
}

export function venuePartnerOutreachLockKey(venueId: string): string {
  return `${VENUE_PARTNER_LOCK_CONTRACT.outreachVenuePrefix}${inputIdentifier(venueId, MAX_VENUE_ID_LENGTH)}`;
}

export function venuePartnerOutreachIdentityLockKey(outreachId: string): string {
  return `${VENUE_PARTNER_LOCK_CONTRACT.outreachIdentityPrefix}${inputIdentifier(outreachId)}`;
}

export type VenueInterestStatus =
  | "open"
  | "contacted"
  | "interested"
  | "partner"
  | "not_interested"
  | "closed";

export type VenueOutreachStatus =
  | "lead"
  | "contacted"
  | "interested"
  | "partner"
  | "not_interested"
  | "closed";

export type VenueOutreachTierFit = "basic" | "pro";

export interface VenueInterestRecord {
  id: string;
  userId: string | null;
  venueId: string | null;
  venueName: string;
  managerName: string;
  email: string;
  phone: string | null;
  role: string;
  notes: string | null;
  status: VenueInterestStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenuePartnerOutreachRecord {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: VenueOutreachStatus;
  tierFit: VenueOutreachTierFit | null;
  nextAction: string | null;
  lastContactedAt: string | null;
  contactName: string | null;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVenueInterestInput {
  id: string;
  userId: string | null;
  venueId: string | null;
  venueName: string;
  managerName: string;
  email: string;
  phone: string | null;
  role: string;
  notes: string | null;
  now: string;
}

export interface VenueInterestListCursor {
  createdAt: string;
  id: string;
}

export interface VenueInterestListPage {
  interests: VenueInterestRecord[];
  nextCursor: VenueInterestListCursor | null;
}

export interface UpdateVenueInterestWorkflowInput {
  actorAccountId: string;
  interestId: string;
  status: VenueInterestStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  expectedUpdatedAt: string;
  now: string;
}

export interface UpsertVenuePartnerOutreachInput {
  actorAccountId: string;
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: VenueOutreachStatus;
  tierFit: VenueOutreachTierFit | null;
  nextAction: string | null;
  lastContactedAt: string | null;
  contactName: string | null;
  notes: string | null;
  expectedUpdatedAt: string | null;
  now: string;
}

export interface UpsertVenuePartnerOutreachResult {
  outreach: VenuePartnerOutreachRecord;
  created: boolean;
  replayed: boolean;
}

export interface VenuePartnerOutreachListCursor {
  updatedAt: string;
  venueId: string;
}

export interface VenuePartnerOutreachListPage {
  outreach: VenuePartnerOutreachRecord[];
  nextCursor: VenuePartnerOutreachListCursor | null;
}

export type VenuePartnerRepositoryErrorCode =
  | "account_not_eligible"
  | "account_not_found"
  | "admin_not_authorized"
  | "deletion_locked"
  | "interest_id_conflict"
  | "interest_not_found"
  | "interest_version_conflict"
  | "invalid_input"
  | "malformed_record"
  | "outreach_id_conflict"
  | "outreach_not_found"
  | "outreach_version_conflict"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<VenuePartnerRepositoryErrorCode, string>> = {
  account_not_eligible: "The account is not eligible to change venue-partner records.",
  account_not_found: "The venue-partner account does not exist.",
  admin_not_authorized: "The account is not authorised to administer venue-partner records.",
  deletion_locked: "Venue-partner changes are unavailable while account deletion is being processed.",
  interest_id_conflict: "The venue-interest identity is already assigned to different data.",
  interest_not_found: "The venue-interest record does not exist.",
  interest_version_conflict: "The venue-interest record changed before this operation completed.",
  invalid_input: "The venue-partner persistence input is invalid.",
  malformed_record: "Stored venue-partner data is malformed.",
  outreach_id_conflict: "The venue-outreach identity is already assigned to a different venue.",
  outreach_not_found: "The venue-outreach record does not exist.",
  outreach_version_conflict: "The venue-outreach record changed before this operation completed.",
  persistence_failure: "Venue-partner persistence could not be completed.",
};

/** Stable, secret-free failures for service and HTTP error mapping. */
export class VenuePartnerRepositoryError extends Error {
  readonly code: VenuePartnerRepositoryErrorCode;

  constructor(code: VenuePartnerRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenuePartnerRepositoryError";
    this.code = code;
  }
}

type RawRow = Record<string, unknown>;

interface VenueInterestRow extends RawRow {
  id: unknown;
  userId: unknown;
  venueId: unknown;
  venueName: unknown;
  managerName: unknown;
  email: unknown;
  phone: unknown;
  role: unknown;
  notes: unknown;
  status: unknown;
  assignedTo: unknown;
  resolutionNote: unknown;
  resolvedAt: unknown;
  resolvedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface VenueOutreachRow extends RawRow {
  id: unknown;
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  status: unknown;
  tierFit: unknown;
  nextAction: unknown;
  lastContactedAt: unknown;
  contactName: unknown;
  notes: unknown;
  updatedBy: unknown;
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

interface NormalizedVenueInterestCreate {
  id: string;
  userId: string | null;
  venueId: string | null;
  venueName: string;
  managerName: string;
  email: string;
  phone: string | null;
  role: string;
  notes: string | null;
  now: string;
}

interface NormalizedVenueOutreachUpsert {
  actorAccountId: string;
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: VenueOutreachStatus;
  tierFit: VenueOutreachTierFit | null;
  nextAction: string | null;
  lastContactedAt: string | null;
  contactName: string | null;
  notes: string | null;
  expectedUpdatedAt: string | null;
  now: string;
}

const INTEREST_PROJECTION = `
  interest.id AS "id",
  interest.user_id AS "userId",
  interest.venue_id AS "venueId",
  interest.venue_name AS "venueName",
  interest.manager_name AS "managerName",
  interest.email AS "email",
  interest.phone AS "phone",
  interest.role AS "role",
  interest.notes AS "notes",
  interest.status AS "status",
  interest.assigned_to AS "assignedTo",
  interest.resolution_note AS "resolutionNote",
  interest.resolved_at AS "resolvedAt",
  interest.resolved_by AS "resolvedBy",
  interest.created_at AS "createdAt",
  interest.updated_at AS "updatedAt"`;

const OUTREACH_PROJECTION = `
  outreach.id AS "id",
  outreach.venue_id AS "venueId",
  outreach.venue_name AS "venueName",
  outreach.suburb AS "suburb",
  outreach.status AS "status",
  outreach.tier_fit AS "tierFit",
  outreach.next_action AS "nextAction",
  outreach.last_contacted_at AS "lastContactedAt",
  outreach.contact_name AS "contactName",
  outreach.notes AS "notes",
  outreach.updated_by AS "updatedBy",
  outreach.created_at AS "createdAt",
  outreach.updated_at AS "updatedAt"`;

function fail(code: VenuePartnerRepositoryErrorCode): never {
  throw new VenuePartnerRepositoryError(code);
}

function inputIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return fail("invalid_input");
  }
  return normalized;
}

function optionalInputIdentifier(value: unknown, maximum = MAX_ID_LENGTH): string | null {
  if (value === null) return null;
  return inputIdentifier(value, maximum);
}

function inputText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
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

function inputEmail(value: unknown): string {
  const email = inputText(value, MAX_EMAIL_LENGTH).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return fail("invalid_input");
  return email;
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

function optionalInputTimestamp(value: unknown): string | null {
  return value === null ? null : inputTimestamp(value);
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
  return value === null ? null : recordIdentifier(value, maximum);
}

function recordText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /\0/.test(value)
  ) return fail("malformed_record");
  return value;
}

function optionalRecordText(value: unknown, maximum: number): string | null {
  return value === null ? null : recordText(value, maximum);
}

function recordEmail(value: unknown): string {
  const email = recordText(value, MAX_EMAIL_LENGTH);
  if (email !== email.toLowerCase() || !EMAIL_PATTERN.test(email)) return fail("malformed_record");
  return email;
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

function inputInterestStatus(value: unknown): VenueInterestStatus {
  if (
    value !== "open"
    && value !== "contacted"
    && value !== "interested"
    && value !== "partner"
    && value !== "not_interested"
    && value !== "closed"
  ) return fail("invalid_input");
  return value;
}

function recordInterestStatus(value: unknown): VenueInterestStatus {
  try {
    return inputInterestStatus(value);
  } catch (error) {
    if (error instanceof VenuePartnerRepositoryError) return fail("malformed_record");
    throw error;
  }
}

function inputOutreachStatus(value: unknown): VenueOutreachStatus {
  if (
    value !== "lead"
    && value !== "contacted"
    && value !== "interested"
    && value !== "partner"
    && value !== "not_interested"
    && value !== "closed"
  ) return fail("invalid_input");
  return value;
}

function recordOutreachStatus(value: unknown): VenueOutreachStatus {
  try {
    return inputOutreachStatus(value);
  } catch (error) {
    if (error instanceof VenuePartnerRepositoryError) return fail("malformed_record");
    throw error;
  }
}

function inputTierFit(value: unknown): VenueOutreachTierFit | null {
  if (value === null || value === "basic" || value === "pro") return value;
  return fail("invalid_input");
}

function recordTierFit(value: unknown): VenueOutreachTierFit | null {
  if (value === null || value === "basic" || value === "pro") return value;
  return fail("malformed_record");
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function pageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    return fail("invalid_input");
  }
  return value;
}

function relationshipVenueIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIP_VENUES) return fail("invalid_input");
  return [...new Set(value.map((venueId) => inputIdentifier(venueId, MAX_VENUE_ID_LENGTH)))].sort();
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  if (!/^\d+$/.test(String(value))) return fail("malformed_record");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail("malformed_record");
  return parsed;
}

function mutationTimestamp(now: string, previous: readonly string[]): string {
  const latest = previous.reduce((maximum, value) => Math.max(maximum, Date.parse(value)), -Infinity);
  if (Date.parse(now) > latest) return now;
  const next = new Date(latest + 1).toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(next)) return fail("invalid_input");
  return next;
}

function interestRecord(row: VenueInterestRow): VenueInterestRecord {
  const createdAt = recordTimestamp(row.createdAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  const resolvedAt = optionalRecordTimestamp(row.resolvedAt);
  const resolvedBy = optionalRecordIdentifier(row.resolvedBy);
  if (
    updatedAt < createdAt
    // Privacy anonymisation may retain the resolution timestamp while
    // intentionally clearing the identifying resolver reference.
    || resolvedBy !== null && resolvedAt === null
    || resolvedAt !== null && updatedAt < resolvedAt
  ) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id),
    userId: optionalRecordIdentifier(row.userId),
    venueId: optionalRecordIdentifier(row.venueId, MAX_VENUE_ID_LENGTH),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    managerName: recordText(row.managerName, MAX_MANAGER_NAME_LENGTH),
    email: recordEmail(row.email),
    phone: optionalRecordText(row.phone, MAX_PHONE_LENGTH),
    role: recordText(row.role, MAX_ROLE_LENGTH),
    notes: optionalRecordText(row.notes, MAX_NOTES_LENGTH),
    status: recordInterestStatus(row.status),
    assignedTo: optionalRecordIdentifier(row.assignedTo),
    resolutionNote: optionalRecordText(row.resolutionNote, MAX_RESOLUTION_NOTE_LENGTH),
    resolvedAt,
    resolvedBy,
    createdAt,
    updatedAt,
  };
}

function outreachRecord(row: VenueOutreachRow): VenuePartnerOutreachRecord {
  const createdAt = recordTimestamp(row.createdAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  if (updatedAt < createdAt) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id),
    venueId: recordIdentifier(row.venueId, MAX_VENUE_ID_LENGTH),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: optionalRecordText(row.suburb, MAX_SUBURB_LENGTH),
    status: recordOutreachStatus(row.status),
    tierFit: recordTierFit(row.tierFit),
    nextAction: optionalRecordText(row.nextAction, MAX_NEXT_ACTION_LENGTH),
    lastContactedAt: optionalRecordTimestamp(row.lastContactedAt),
    contactName: optionalRecordText(row.contactName, MAX_CONTACT_NAME_LENGTH),
    notes: optionalRecordText(row.notes, MAX_NOTES_LENGTH),
    updatedBy: optionalRecordIdentifier(row.updatedBy),
    createdAt,
    updatedAt,
  };
}

function normalizedInterest(input: CreateVenueInterestInput): NormalizedVenueInterestCreate {
  return {
    id: inputIdentifier(input.id),
    userId: optionalInputIdentifier(input.userId),
    venueId: optionalInputIdentifier(input.venueId, MAX_VENUE_ID_LENGTH),
    venueName: inputText(input.venueName, MAX_VENUE_NAME_LENGTH),
    managerName: inputText(input.managerName, MAX_MANAGER_NAME_LENGTH),
    email: inputEmail(input.email),
    phone: optionalInputText(input.phone, MAX_PHONE_LENGTH),
    role: inputText(input.role, MAX_ROLE_LENGTH),
    notes: optionalInputText(input.notes, MAX_NOTES_LENGTH),
    now: inputTimestamp(input.now),
  };
}

function normalizedOutreach(input: UpsertVenuePartnerOutreachInput): NormalizedVenueOutreachUpsert {
  return {
    actorAccountId: inputIdentifier(input.actorAccountId),
    id: inputIdentifier(input.id),
    venueId: inputIdentifier(input.venueId, MAX_VENUE_ID_LENGTH),
    venueName: inputText(input.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: optionalInputText(input.suburb, MAX_SUBURB_LENGTH),
    status: inputOutreachStatus(input.status),
    tierFit: inputTierFit(input.tierFit),
    nextAction: optionalInputText(input.nextAction, MAX_NEXT_ACTION_LENGTH),
    lastContactedAt: optionalInputTimestamp(input.lastContactedAt),
    contactName: optionalInputText(input.contactName, MAX_CONTACT_NAME_LENGTH),
    notes: optionalInputText(input.notes, MAX_NOTES_LENGTH),
    expectedUpdatedAt: optionalInputTimestamp(input.expectedUpdatedAt),
    now: inputTimestamp(input.now),
  };
}

function sameInterestCreateCore(
  existing: VenueInterestRecord,
  desired: NormalizedVenueInterestCreate,
): boolean {
  return existing.id === desired.id
    && existing.userId === desired.userId
    && existing.venueId === desired.venueId
    && existing.venueName === desired.venueName
    && existing.managerName === desired.managerName
    && existing.email === desired.email
    && existing.phone === desired.phone
    && existing.role === desired.role
    && existing.notes === desired.notes;
}

function sameOutreachDesired(
  existing: VenuePartnerOutreachRecord,
  desired: NormalizedVenueOutreachUpsert,
): boolean {
  return existing.venueId === desired.venueId
    && existing.venueName === desired.venueName
    && existing.suburb === desired.suburb
    && existing.status === desired.status
    && existing.tierFit === desired.tierFit
    && existing.nextAction === desired.nextAction
    && existing.lastContactedAt === desired.lastContactedAt
    && existing.contactName === desired.contactName
    && existing.notes === desired.notes
    && existing.updatedBy === desired.actorAccountId;
}

function terminalInterestStatus(status: VenueInterestStatus): boolean {
  return status === "partner" || status === "not_interested" || status === "closed";
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Async persistence boundary for venue-interest and venue-outreach records.
 * Provider calls, audit/event publication, VenueAccess assignments, pending
 * changes, and broad partner-lead analytics deliberately remain outside.
 *
 * Account-deletion writers must join `venue-partner:account:<id>` before the
 * account row when this boundary is wired into shared production traffic.
 */
export class VenuePartnerRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(
    work: () => Promise<Result>,
    uniqueCode: VenuePartnerRepositoryErrorCode = "persistence_failure",
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenuePartnerRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new VenuePartnerRepositoryError(uniqueCode);
      throw new VenuePartnerRepositoryError("persistence_failure");
    }
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

  private requireEligibleAccount(row: AccountFenceRow | null): void {
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

  private async requireEligibleAccountStillEligible(accountId: string): Promise<void> {
    this.requireEligibleAccount(await this.accountRow(accountId, false));
  }

  private async requireAdminsStillEligible(accountIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(accountIds)].sort()) {
      this.requireAdmin(await this.accountRow(id, false));
    }
  }

  private async interestRow(id: string, lock = false): Promise<VenueInterestRow | null> {
    const row = await this.database.prepare(
      `SELECT ${INTEREST_PROJECTION}
         FROM venue_interest_requests interest
        WHERE interest.id = ?${lock ? this.lockSuffix("interest") : ""}`,
    ).get<VenueInterestRow>(id);
    return row ?? null;
  }

  private async outreachRowByVenue(
    venueId: string,
    lock = false,
  ): Promise<VenueOutreachRow | null> {
    const row = await this.database.prepare(
      `SELECT ${OUTREACH_PROJECTION}
         FROM venue_partner_outreach outreach
        WHERE outreach.venue_id = ?${lock ? this.lockSuffix("outreach") : ""}`,
    ).get<VenueOutreachRow>(venueId);
    return row ?? null;
  }

  private async outreachRowById(id: string): Promise<VenueOutreachRow | null> {
    const row = await this.database.prepare(
      `SELECT ${OUTREACH_PROJECTION}
         FROM venue_partner_outreach outreach
        WHERE outreach.id = ?`,
    ).get<VenueOutreachRow>(id);
    return row ?? null;
  }

  async createVenueInterest(input: CreateVenueInterestInput): Promise<VenueInterestRecord> {
    const desired = normalizedInterest(input);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        venuePartnerInterestLockKey(desired.id),
        ...(desired.userId ? [venuePartnerAccountLockKey(desired.userId)] : []),
      ]);
      if (desired.userId) this.requireEligibleAccount(await this.accountRow(desired.userId, true));

      const existingRow = await this.interestRow(desired.id, true);
      if (existingRow) {
        const existing = interestRecord(existingRow);
        if (!sameInterestCreateCore(existing, desired)) return fail("interest_id_conflict");
        if (desired.userId) await this.requireEligibleAccountStillEligible(desired.userId);
        return existing;
      }

      const inserted = await this.database.prepare(
        `INSERT INTO venue_interest_requests (
           id, user_id, venue_id, venue_name, manager_name, email, phone, role,
           notes, status, assigned_to, resolution_note, resolved_at, resolved_by,
           created_at, updated_at
         ) VALUES (
           @id, @userId, @venueId, @venueName, @managerName, @email, @phone, @role,
           @notes, 'open', NULL, NULL, NULL, NULL, @now, @now
         ) ON CONFLICT DO NOTHING`,
      ).run(desired);
      if (inserted.changes !== 1) {
        const conflict = await this.interestRow(desired.id, true);
        if (!conflict || !sameInterestCreateCore(interestRecord(conflict), desired)) {
          return fail("interest_id_conflict");
        }
      }
      if (desired.userId) await this.requireEligibleAccountStillEligible(desired.userId);
      const createdRow = await this.interestRow(desired.id);
      if (!createdRow) return fail("persistence_failure");
      const created = interestRecord(createdRow);
      if (!sameInterestCreateCore(created, desired)) return fail("persistence_failure");
      return created;
    }), "interest_id_conflict");
  }

  async getVenueInterestById(id: string): Promise<VenueInterestRecord | null> {
    const interestId = inputIdentifier(id);
    return this.guarded(async () => {
      const row = await this.interestRow(interestId);
      return row ? interestRecord(row) : null;
    });
  }

  async listVenueInterests(input: {
    limit: number;
    cursor?: VenueInterestListCursor | null | undefined;
    status?: VenueInterestStatus | undefined;
  }): Promise<VenueInterestListPage> {
    const limit = pageSize(input.limit);
    const cursor = input.cursor == null ? null : {
      createdAt: inputTimestamp(input.cursor.createdAt),
      id: inputIdentifier(input.cursor.id),
    };
    const status = input.status === undefined ? null : inputInterestStatus(input.status);
    return this.guarded(async () => {
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = { limit: limit + 1 };
      if (status !== null) {
        conditions.push("interest.status = @status");
        bindings.status = status;
      }
      if (cursor !== null) {
        conditions.push(`(
          interest.created_at < @cursorCreatedAt
          OR (interest.created_at = @cursorCreatedAt AND interest.id > @cursorId)
        )`);
        bindings.cursorCreatedAt = cursor.createdAt;
        bindings.cursorId = cursor.id;
      }
      const rows = await this.database.prepare(
        `SELECT ${INTEREST_PROJECTION}
           FROM venue_interest_requests interest
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY interest.created_at DESC, interest.id ASC
          LIMIT @limit`,
      ).all<VenueInterestRow>(bindings);
      const records = rows.map(interestRecord);
      const hasMore = records.length > limit;
      const interests = hasMore ? records.slice(0, limit) : records;
      const last = interests.at(-1);
      return {
        interests,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async countVenueInterests(input: { status?: VenueInterestStatus | undefined } = {}): Promise<number> {
    const status = input.status === undefined ? null : inputInterestStatus(input.status);
    return this.guarded(async () => {
      const row = status === null
        ? await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_interest_requests interest`,
          ).get<{ count: unknown }>()
        : await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_interest_requests interest
              WHERE interest.status = ?`,
          ).get<{ count: unknown }>(status);
      return safeCount(row?.count ?? 0);
    });
  }

  async updateVenueInterestWorkflow(
    input: UpdateVenueInterestWorkflowInput,
  ): Promise<VenueInterestRecord> {
    const actorAccountId = inputIdentifier(input.actorAccountId);
    const interestId = inputIdentifier(input.interestId);
    const status = inputInterestStatus(input.status);
    const assignedTo = optionalInputIdentifier(input.assignedTo);
    const resolutionNote = optionalInputText(input.resolutionNote, MAX_RESOLUTION_NOTE_LENGTH);
    const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
    const now = inputTimestamp(input.now);
    const accountIds = assignedTo === null ? [actorAccountId] : [actorAccountId, assignedTo];
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        venuePartnerInterestLockKey(interestId),
        ...accountIds.map(venuePartnerAccountLockKey),
      ]);
      const accounts = await this.lockAccounts(accountIds);
      for (const id of accountIds) this.requireAdmin(accounts.get(id) ?? null);

      const row = await this.interestRow(interestId, true);
      if (!row) return fail("interest_not_found");
      const existing = interestRecord(row);
      if (existing.updatedAt !== expectedUpdatedAt) return fail("interest_version_conflict");
      const terminal = terminalInterestStatus(status);
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
        `UPDATE venue_interest_requests
            SET status = @status, assigned_to = @assignedTo,
                resolution_note = @resolutionNote,
                resolved_at = @resolvedAt, resolved_by = @resolvedBy,
                updated_at = @updatedAt
          WHERE id = @interestId AND updated_at = @expectedUpdatedAt`,
      ).run({
        status,
        assignedTo,
        resolutionNote,
        resolvedAt: terminal ? updatedAt : null,
        resolvedBy: terminal ? actorAccountId : null,
        updatedAt,
        interestId,
        expectedUpdatedAt,
      });
      if (changed.changes !== 1) return fail("interest_version_conflict");
      await this.requireAdminsStillEligible(accountIds);
      const updatedRow = await this.interestRow(interestId);
      if (!updatedRow) return fail("persistence_failure");
      const updated = interestRecord(updatedRow);
      if (
        updated.status !== status
        || updated.assignedTo !== assignedTo
        || updated.resolutionNote !== resolutionNote
        || terminal && (updated.resolvedAt !== updatedAt || updated.resolvedBy !== actorAccountId)
        || !terminal && (updated.resolvedAt !== null || updated.resolvedBy !== null)
      ) return fail("interest_version_conflict");
      return updated;
    }));
  }

  async upsertVenuePartnerOutreach(
    input: UpsertVenuePartnerOutreachInput,
  ): Promise<UpsertVenuePartnerOutreachResult> {
    const desired = normalizedOutreach(input);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        venuePartnerAccountLockKey(desired.actorAccountId),
        venuePartnerOutreachLockKey(desired.venueId),
        venuePartnerOutreachIdentityLockKey(desired.id),
      ]);
      this.requireAdmin(await this.accountRow(desired.actorAccountId, true));

      const identityRow = await this.outreachRowById(desired.id);
      if (identityRow && outreachRecord(identityRow).venueId !== desired.venueId) {
        return fail("outreach_id_conflict");
      }
      const existingRow = await this.outreachRowByVenue(desired.venueId, true);
      if (existingRow) {
        const existing = outreachRecord(existingRow);
        if (sameOutreachDesired(existing, desired)) {
          await this.requireAdminsStillEligible([desired.actorAccountId]);
          return { outreach: existing, created: false, replayed: true };
        }
        if (desired.expectedUpdatedAt === null || existing.updatedAt !== desired.expectedUpdatedAt) {
          return fail("outreach_version_conflict");
        }
        const updatedAt = mutationTimestamp(desired.now, [existing.updatedAt]);
        const changed = await this.database.prepare(
          `UPDATE venue_partner_outreach
              SET venue_name = @venueName, suburb = @suburb, status = @status,
                  tier_fit = @tierFit, next_action = @nextAction,
                  last_contacted_at = @lastContactedAt, contact_name = @contactName,
                  notes = @notes, updated_by = @actorAccountId, updated_at = @updatedAt
            WHERE venue_id = @venueId AND updated_at = @expectedUpdatedAt`,
        ).run({ ...desired, updatedAt, expectedUpdatedAt: existing.updatedAt });
        if (changed.changes !== 1) return fail("outreach_version_conflict");
        await this.requireAdminsStillEligible([desired.actorAccountId]);
        const updatedRow = await this.outreachRowByVenue(desired.venueId);
        if (!updatedRow) return fail("persistence_failure");
        const updated = outreachRecord(updatedRow);
        if (!sameOutreachDesired(updated, desired) || updated.updatedAt !== updatedAt) {
          return fail("outreach_version_conflict");
        }
        return { outreach: updated, created: false, replayed: false };
      }

      if (desired.expectedUpdatedAt !== null) return fail("outreach_not_found");
      const inserted = await this.database.prepare(
        `INSERT INTO venue_partner_outreach (
           id, venue_id, venue_name, suburb, status, tier_fit, next_action,
           last_contacted_at, contact_name, notes, updated_by, created_at, updated_at
         ) VALUES (
           @id, @venueId, @venueName, @suburb, @status, @tierFit, @nextAction,
           @lastContactedAt, @contactName, @notes, @actorAccountId, @now, @now
         ) ON CONFLICT DO NOTHING`,
      ).run(desired);
      if (inserted.changes !== 1) {
        const conflict = await this.outreachRowByVenue(desired.venueId, true);
        if (conflict && sameOutreachDesired(outreachRecord(conflict), desired)) {
          await this.requireAdminsStillEligible([desired.actorAccountId]);
          return { outreach: outreachRecord(conflict), created: false, replayed: true };
        }
        const idConflict = await this.outreachRowById(desired.id);
        if (idConflict && outreachRecord(idConflict).venueId !== desired.venueId) {
          return fail("outreach_id_conflict");
        }
        return fail("outreach_version_conflict");
      }
      await this.requireAdminsStillEligible([desired.actorAccountId]);
      const createdRow = await this.outreachRowByVenue(desired.venueId);
      if (!createdRow) return fail("persistence_failure");
      const created = outreachRecord(createdRow);
      if (!sameOutreachDesired(created, desired) || created.id !== desired.id) {
        return fail("persistence_failure");
      }
      return { outreach: created, created: true, replayed: false };
    }), "outreach_version_conflict");
  }

  async getVenuePartnerOutreachByVenueId(
    venueId: string,
  ): Promise<VenuePartnerOutreachRecord | null> {
    const normalizedVenueId = inputIdentifier(venueId, MAX_VENUE_ID_LENGTH);
    return this.guarded(async () => {
      const row = await this.outreachRowByVenue(normalizedVenueId);
      return row ? outreachRecord(row) : null;
    });
  }

  async getVenuePartnerOutreachById(id: string): Promise<VenuePartnerOutreachRecord | null> {
    const outreachId = inputIdentifier(id);
    return this.guarded(async () => {
      const row = await this.outreachRowById(outreachId);
      return row ? outreachRecord(row) : null;
    });
  }

  /** Bounded, deterministic relationship lookup for the admin partner-lead page. */
  async listVenuePartnerOutreachByVenueIds(input: {
    venueIds: readonly string[];
  }): Promise<VenuePartnerOutreachRecord[]> {
    const venueIds = relationshipVenueIds(input.venueIds);
    if (!venueIds.length) return [];
    return this.guarded(async () => {
      const placeholders = venueIds.map(() => "?").join(", ");
      const rows = await this.database.prepare(
        `SELECT ${OUTREACH_PROJECTION}
           FROM venue_partner_outreach outreach
          WHERE outreach.venue_id IN (${placeholders})
          ORDER BY outreach.venue_id ASC`,
      ).all<VenueOutreachRow>(...venueIds);
      const outreach = rows.map(outreachRecord);
      const requested = new Set(venueIds);
      const returned = outreach.map((record) => record.venueId);
      if (
        new Set(returned).size !== returned.length
        || returned.some((venueId) => !requested.has(venueId))
      ) return fail("malformed_record");
      return outreach;
    });
  }

  async listVenuePartnerOutreach(input: {
    limit: number;
    cursor?: VenuePartnerOutreachListCursor | null | undefined;
    status?: VenueOutreachStatus | undefined;
  }): Promise<VenuePartnerOutreachListPage> {
    const limit = pageSize(input.limit);
    const cursor = input.cursor == null ? null : {
      updatedAt: inputTimestamp(input.cursor.updatedAt),
      venueId: inputIdentifier(input.cursor.venueId, MAX_VENUE_ID_LENGTH),
    };
    const status = input.status === undefined ? null : inputOutreachStatus(input.status);
    return this.guarded(async () => {
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = { limit: limit + 1 };
      if (status !== null) {
        conditions.push("outreach.status = @status");
        bindings.status = status;
      }
      if (cursor !== null) {
        conditions.push(`(
          outreach.updated_at < @cursorUpdatedAt
          OR (outreach.updated_at = @cursorUpdatedAt AND outreach.venue_id > @cursorVenueId)
        )`);
        bindings.cursorUpdatedAt = cursor.updatedAt;
        bindings.cursorVenueId = cursor.venueId;
      }
      const rows = await this.database.prepare(
        `SELECT ${OUTREACH_PROJECTION}
           FROM venue_partner_outreach outreach
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY outreach.updated_at DESC, outreach.venue_id ASC
          LIMIT @limit`,
      ).all<VenueOutreachRow>(bindings);
      const records = rows.map(outreachRecord);
      const hasMore = records.length > limit;
      const outreach = hasMore ? records.slice(0, limit) : records;
      const last = outreach.at(-1);
      return {
        outreach,
        nextCursor: hasMore && last ? { updatedAt: last.updatedAt, venueId: last.venueId } : null,
      };
    });
  }

  async countVenuePartnerOutreach(input: { status?: VenueOutreachStatus | undefined } = {}): Promise<number> {
    const status = input.status === undefined ? null : inputOutreachStatus(input.status);
    return this.guarded(async () => {
      const row = status === null
        ? await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_partner_outreach outreach`,
          ).get<{ count: unknown }>()
        : await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_partner_outreach outreach
              WHERE outreach.status = ?`,
          ).get<{ count: unknown }>(status);
      return safeCount(row?.count ?? 0);
    });
  }
}
