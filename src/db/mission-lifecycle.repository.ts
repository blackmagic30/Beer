import crypto from "node:crypto";

import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ID_LENGTH = 255;
const MAX_VENUE_NAME_LENGTH = 240;
const MAX_SUBURB_LENGTH = 160;
const MAX_REASON_LENGTH = 2_000;
const MAX_PAGE_SIZE = 200;
const MAX_ADMIN_PAGE_SIZE = 1_000;
const MAX_ADMIN_OFFSET = 5_000;
const MAX_EXPIRY_BATCH_SIZE = 500;
const MAX_POINTS = 1_000_000;
const MAX_MULTIPLIER = 100;
const DECIMAL_SCALE = 1_000_000;

export const MISSION_LIFECYCLE_LOCK_CONTRACT = Object.freeze({
  version: 1,
  accountPrefix: "mission-lifecycle:account:",
  missionPrefix: "mission-lifecycle:mission:",
  order: "sorted-advisory-locks-before-mission-row-before-account-row-before-progress-rows",
} as const);

export function missionLifecycleAccountLockKey(accountId: string): string {
  return `${MISSION_LIFECYCLE_LOCK_CONTRACT.accountPrefix}${inputIdentifier(accountId)}`;
}

export function missionLifecycleMissionLockKey(missionId: string): string {
  return `${MISSION_LIFECYCLE_LOCK_CONTRACT.missionPrefix}${inputIdentifier(missionId)}`;
}

export type MissionPriority = "low" | "normal" | "high";
export type MissionProgressStatus = "accepted" | "submitted" | "completed" | "needs_revision" | "cancelled";

export interface MissionLifecycleMission {
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
  createdAt: string;
  updatedAt: string;
}

export interface MissionLifecycleProgress {
  id: string;
  missionId: string;
  userId: string;
  submissionId: string | null;
  status: MissionProgressStatus;
  acceptedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface CreateMissionInput {
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
  createdAt: string;
  updatedAt: string;
}

export interface MissionListCursor {
  updatedAt: string;
  id: string;
}

export interface MissionProgressListCursor {
  updatedAt: string;
  id: string;
}

export interface MissionListPage {
  missions: MissionLifecycleMission[];
  nextCursor: MissionListCursor | null;
}

export interface MissionProgressListPage {
  progress: MissionLifecycleProgress[];
  nextCursor: MissionProgressListCursor | null;
}

export interface UnavailableMissionIdPage {
  missionIds: string[];
  nextCursor: string | null;
}

export interface MissionExpiryBatchResult {
  expired: number;
  hasMore: boolean;
}

export type MissionLifecycleRepositoryErrorCode =
  | "account_not_eligible"
  | "account_not_found"
  | "deletion_locked"
  | "invalid_input"
  | "malformed_record"
  | "mission_in_use"
  | "mission_inactive"
  | "mission_not_found"
  | "mission_reserved"
  | "mission_version_conflict"
  | "persistence_failure"
  | "progress_not_found"
  | "progress_not_releasable"
  | "progress_version_conflict";

const ERROR_MESSAGES: Readonly<Record<MissionLifecycleRepositoryErrorCode, string>> = {
  account_not_eligible: "The account is not eligible to accept missions.",
  account_not_found: "The mission account does not exist.",
  deletion_locked: "Mission changes are unavailable while account deletion is being processed.",
  invalid_input: "The mission lifecycle input is invalid.",
  malformed_record: "Stored mission lifecycle data is malformed.",
  mission_in_use: "The mission has linked history and cannot be deleted.",
  mission_inactive: "The mission is not active.",
  mission_not_found: "The mission does not exist.",
  mission_reserved: "The mission is already reserved by another contributor.",
  mission_version_conflict: "The mission changed before this operation completed.",
  persistence_failure: "Mission lifecycle persistence could not be completed.",
  progress_not_found: "The mission progress record does not exist.",
  progress_not_releasable: "Only an accepted mission reservation can be released.",
  progress_version_conflict: "The mission reservation changed before it could be released.",
};

/** Stable, secret-free failures for future service and HTTP error mapping. */
export class MissionLifecycleRepositoryError extends Error {
  readonly code: MissionLifecycleRepositoryErrorCode;

  constructor(code: MissionLifecycleRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MissionLifecycleRepositoryError";
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

interface ProgressRow extends RawRow {
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

interface AccountFenceRow extends RawRow {
  id: unknown;
  status: unknown;
  authProvider: unknown;
  deletionLocked: unknown;
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

const PROGRESS_PROJECTION = `
  progress.id AS "id",
  progress.mission_id AS "missionId",
  progress.user_id AS "userId",
  progress.submission_id AS "submissionId",
  progress.status AS "status",
  progress.accepted_at AS "acceptedAt",
  progress.submitted_at AS "submittedAt",
  progress.completed_at AS "completedAt",
  progress.updated_at AS "updatedAt"`;

function fail(code: MissionLifecycleRepositoryErrorCode): never {
  throw new MissionLifecycleRepositoryError(code);
}

function inputIdentifier(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_ID_LENGTH
    || /[\r\n\0]/.test(normalized)
  ) return fail("invalid_input");
  return normalized;
}

function inputText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function inputOptionalText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\0/.test(normalized)) return fail("invalid_input");
  return normalized;
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
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function recordOptionalText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) {
    return fail("malformed_record");
  }
  return value;
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

function inputOptionalTimestamp(value: unknown): string | null {
  return value === null ? null : inputTimestamp(value);
}

function recordOptionalTimestamp(value: unknown): string | null {
  return value === null ? null : recordTimestamp(value);
}

function inputBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") return fail("invalid_input");
  return value;
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function inputPriority(value: unknown): MissionPriority {
  if (value !== "low" && value !== "normal" && value !== "high") return fail("invalid_input");
  return value;
}

function recordPriority(value: unknown): MissionPriority {
  if (value !== "low" && value !== "normal" && value !== "high") return fail("malformed_record");
  return value;
}

function recordProgressStatus(value: unknown): MissionProgressStatus {
  if (
    value !== "accepted"
    && value !== "submitted"
    && value !== "completed"
    && value !== "needs_revision"
    && value !== "cancelled"
  ) return fail("malformed_record");
  return value;
}

function decimalInput(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  const scaled = value * DECIMAL_SCALE;
  if (!Number.isSafeInteger(scaled)) return fail("invalid_input");
  return Object.is(value, -0) ? 0 : value;
}

function decimalRecord(value: unknown, minimum: number, maximum: number): number {
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

function pageSize(value: unknown, maximum = MAX_PAGE_SIZE): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return fail("invalid_input");
  }
  return value;
}

function boundedOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ADMIN_OFFSET) {
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
    points: decimalRecord(row.points, 0, MAX_POINTS),
    multiplier: decimalRecord(row.multiplier, 0, MAX_MULTIPLIER),
    active: recordBoolean(row.active),
    sponsorFlag: recordBoolean(row.sponsorFlag),
    lastVerifiedAt: recordOptionalTimestamp(row.lastVerifiedAt),
    createdAt,
    updatedAt,
  };
}

function progressRecord(row: ProgressRow): MissionLifecycleProgress {
  const acceptedAt = recordTimestamp(row.acceptedAt);
  const submittedAt = recordOptionalTimestamp(row.submittedAt);
  const completedAt = recordOptionalTimestamp(row.completedAt);
  const updatedAt = recordTimestamp(row.updatedAt);
  if (
    updatedAt < acceptedAt
    || submittedAt !== null && submittedAt < acceptedAt
    || submittedAt !== null && updatedAt < submittedAt
    || completedAt !== null && completedAt < acceptedAt
    || completedAt !== null && updatedAt < completedAt
  ) return fail("malformed_record");
  return {
    id: recordIdentifier(row.id),
    missionId: recordIdentifier(row.missionId),
    userId: recordIdentifier(row.userId),
    submissionId: row.submissionId === null ? null : recordIdentifier(row.submissionId),
    status: recordProgressStatus(row.status),
    acceptedAt,
    submittedAt,
    completedAt,
    updatedAt,
  };
}

function normalizedMission(input: CreateMissionInput): MissionLifecycleMission {
  const createdAt = inputTimestamp(input.createdAt);
  const updatedAt = inputTimestamp(input.updatedAt);
  if (updatedAt < createdAt) return fail("invalid_input");
  return {
    id: inputIdentifier(input.id),
    venueId: inputIdentifier(input.venueId),
    venueName: inputText(input.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: inputOptionalText(input.suburb, MAX_SUBURB_LENGTH),
    reason: inputText(input.reason, MAX_REASON_LENGTH),
    priority: inputPriority(input.priority),
    points: decimalInput(input.points, 0, MAX_POINTS),
    multiplier: decimalInput(input.multiplier, 0, MAX_MULTIPLIER),
    active: inputBoolean(input.active, true),
    sponsorFlag: inputBoolean(input.sponsorFlag, false),
    lastVerifiedAt: inputOptionalTimestamp(input.lastVerifiedAt),
    createdAt,
    updatedAt,
  };
}

function sameMission(left: MissionLifecycleMission, right: MissionLifecycleMission): boolean {
  return left.id === right.id
    && left.venueId === right.venueId
    && left.venueName === right.venueName
    && left.suburb === right.suburb
    && left.reason === right.reason
    && left.priority === right.priority
    && left.points === right.points
    && left.multiplier === right.multiplier
    && left.active === right.active
    && left.sponsorFlag === right.sponsorFlag
    && left.lastVerifiedAt === right.lastVerifiedAt
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Async lifecycle/admin mission persistence for SQLite rehearsal and native
 * PostgreSQL runtime.
 *
 * Mutations hold only short database transactions. There is no provider I/O.
 * Mission reservation, mission lifecycle, and account advisory keys are sorted
 * before row locks. Account-deletion writers must adopt the matching
 * `mission-lifecycle:account:<id>` key (or lock the account row first) to close
 * the cross-repository deletion race; this repository also re-checks deletion
 * state immediately before an acceptance commits.
 *
 * Submission progress transitions, venue-request conversion, feed/scoring,
 * contribution points, and auto-mission generation intentionally remain in
 * their existing atomic owners and are not implemented here.
 */
export class MissionLifecycleRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly createProgressId: () => string = () => crypto.randomUUID(),
  ) {}

  private async guarded<Result>(
    work: () => Promise<Result>,
    uniqueCode: MissionLifecycleRepositoryErrorCode = "persistence_failure",
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MissionLifecycleRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new MissionLifecycleRepositoryError(uniqueCode);
      throw new MissionLifecycleRepositoryError("persistence_failure");
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

  private async missionRow(id: string, lock = false): Promise<MissionRow | null> {
    const row = await this.database.prepare(
      `SELECT ${MISSION_PROJECTION}
         FROM missions mission
        WHERE mission.id = ?${lock ? this.lockSuffix("mission") : ""}`,
    ).get<MissionRow>(id);
    return row ?? null;
  }

  private async progressRow(missionId: string, userId: string, lock = false): Promise<ProgressRow | null> {
    const row = await this.database.prepare(
      `SELECT ${PROGRESS_PROJECTION}
         FROM mission_progress progress
        WHERE progress.mission_id = ? AND progress.user_id = ?
        LIMIT 1${lock ? this.lockSuffix("progress") : ""}`,
    ).get<ProgressRow>(missionId, userId);
    return row ?? null;
  }

  private async accountFence(userId: string, lock: boolean): Promise<AccountFenceRow | null> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id", account.status AS "status",
              account.auth_provider AS "authProvider",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${lock ? this.lockSuffix("account") : ""}`,
    ).get<AccountFenceRow>(userId);
    return row ?? null;
  }

  private requireEligibleAccount(row: AccountFenceRow | null): void {
    if (!row) return fail("account_not_found");
    recordIdentifier(row.id);
    const status = recordText(row.status, 32);
    const authProvider = recordText(row.authProvider, 64);
    if (status !== "active" && status !== "warned" && status !== "suspended") {
      return fail("malformed_record");
    }
    if (recordBoolean(row.deletionLocked) || authProvider === "deleted") return fail("deletion_locked");
    if (status !== "active" && status !== "warned") return fail("account_not_eligible");
  }

  private async requireAccountStillEligible(userId: string): Promise<void> {
    this.requireEligibleAccount(await this.accountFence(userId, false));
  }

  async createMission(input: CreateMissionInput): Promise<MissionLifecycleMission> {
    const desired = normalizedMission(input);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionLifecycleMissionLockKey(desired.id)]);
      const existingRow = await this.missionRow(desired.id, true);
      if (existingRow) {
        const existing = missionRecord(existingRow);
        if (!sameMission(existing, desired)) return fail("mission_version_conflict");
        return existing;
      }

      const inserted = await this.database.prepare(
        `INSERT INTO missions (
           id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
           active, sponsor_flag, last_verified_at, created_at, updated_at
         ) VALUES (
           @id, @venueId, @venueName, @suburb, @reason, @priority, @points, @multiplier,
           @active, @sponsorFlag, @lastVerifiedAt, @createdAt, @updatedAt
         ) ON CONFLICT DO NOTHING`,
      ).run({
        ...desired,
        active: this.booleanValue(desired.active),
        sponsorFlag: this.booleanValue(desired.sponsorFlag),
      });
      if (inserted.changes !== 1) return fail("mission_version_conflict");
      const created = await this.missionRow(desired.id);
      if (!created) return fail("persistence_failure");
      const record = missionRecord(created);
      if (!sameMission(record, desired)) return fail("persistence_failure");
      return record;
    }), "mission_version_conflict");
  }

  async getMissionById(id: string): Promise<MissionLifecycleMission | null> {
    const missionId = inputIdentifier(id);
    return this.guarded(async () => {
      const row = await this.missionRow(missionId);
      return row ? missionRecord(row) : null;
    });
  }

  async listMissions(input: {
    activeOnly: boolean;
    suburb?: string | undefined;
    limit: number;
    cursor?: MissionListCursor | null | undefined;
  }): Promise<MissionListPage> {
    if (typeof input.activeOnly !== "boolean") return fail("invalid_input");
    const limit = pageSize(input.limit);
    const suburb = input.suburb === undefined ? null : inputText(input.suburb, MAX_SUBURB_LENGTH);
    const cursor = input.cursor == null ? null : {
      updatedAt: inputTimestamp(input.cursor.updatedAt),
      id: inputIdentifier(input.cursor.id),
    };
    return this.guarded(async () => {
      const conditions: string[] = [];
      const bindings: Record<string, unknown> = {
        active: this.booleanValue(true),
        suburb,
        limit: limit + 1,
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        cursorId: cursor?.id ?? null,
      };
      if (input.activeOnly) conditions.push("mission.active = @active");
      if (suburb !== null) conditions.push("lower(mission.suburb) = lower(@suburb)");
      if (cursor) {
        conditions.push(`(
          mission.updated_at < @cursorUpdatedAt
          OR (mission.updated_at = @cursorUpdatedAt AND mission.id > @cursorId)
        )`);
      }
      const rows = await this.database.prepare(
        `SELECT ${MISSION_PROJECTION}
           FROM missions mission
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY mission.updated_at DESC, mission.id ASC
          LIMIT @limit`,
      ).all<MissionRow>(bindings);
      const records = rows.map(missionRecord);
      const hasMore = records.length > limit;
      const missions = hasMore ? records.slice(0, limit) : records;
      const last = missions.at(-1);
      return {
        missions,
        nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
      };
    });
  }

  async listAdminMissions(input: { limit: number; offset: number }): Promise<MissionLifecycleMission[]> {
    const limit = pageSize(input.limit, MAX_ADMIN_PAGE_SIZE);
    const offset = boundedOffset(input.offset);
    return this.guarded(async () => {
      const rows = await this.database.prepare(
        `SELECT ${MISSION_PROJECTION}
           FROM missions mission
          ORDER BY (mission.points * mission.multiplier) DESC,
                   mission.updated_at DESC,
                   mission.id ASC
          LIMIT @limit OFFSET @offset`,
      ).all<MissionRow>({ limit, offset });
      return rows.map(missionRecord);
    });
  }

  async countMissions(input: {
    activeOnly: boolean;
    suburb?: string | undefined;
  }): Promise<number> {
    if (typeof input.activeOnly !== "boolean") return fail("invalid_input");
    const suburb = input.suburb === undefined ? null : inputText(input.suburb, MAX_SUBURB_LENGTH);
    return this.guarded(async () => {
      const conditions: string[] = [];
      if (input.activeOnly) conditions.push("mission.active = @active");
      if (suburb !== null) conditions.push("lower(mission.suburb) = lower(@suburb)");
      const row = await this.database.prepare(
        `SELECT count(*) AS "count" FROM missions mission
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
      ).get<{ count: unknown }>({ active: this.booleanValue(true), suburb });
      return safeCount(row?.count);
    });
  }

  async acceptMission(input: {
    missionId: string;
    userId: string;
    now: string;
    acceptedAfter: string;
  }): Promise<MissionLifecycleProgress> {
    const missionId = inputIdentifier(input.missionId);
    const userId = inputIdentifier(input.userId);
    const now = inputTimestamp(input.now);
    const acceptedAfter = inputTimestamp(input.acceptedAfter);
    if (acceptedAfter > now) return fail("invalid_input");

    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        missionLifecycleMissionLockKey(missionId),
        missionLifecycleAccountLockKey(userId),
      ]);
      const missionRow = await this.missionRow(missionId, true);
      if (!missionRow) return fail("mission_not_found");
      const mission = missionRecord(missionRow);
      if (!mission.active) return fail("mission_inactive");
      this.requireEligibleAccount(await this.accountFence(userId, true));

      await this.database.prepare(
        `UPDATE mission_progress
            SET status = 'cancelled', completed_at = NULL, updated_at = @now
          WHERE mission_id = @missionId AND status = 'accepted'
            AND accepted_at <= @acceptedAfter`,
      ).run({ missionId, acceptedAfter, now });

      const competitor = await this.database.prepare(
        `SELECT ${PROGRESS_PROJECTION}
           FROM mission_progress progress
          WHERE progress.mission_id = @missionId
            AND progress.user_id <> @userId
            AND progress.status IN ('accepted', 'submitted')
          ORDER BY progress.updated_at ASC, progress.id ASC
          LIMIT 1${this.lockSuffix("progress")}`,
      ).get<ProgressRow>({ missionId, userId });
      if (competitor) {
        progressRecord(competitor);
        return fail("mission_reserved");
      }

      const existingRow = await this.progressRow(missionId, userId, true);
      if (existingRow) {
        const existing = progressRecord(existingRow);
        if (existing.status === "accepted" || existing.status === "submitted" || existing.status === "completed") {
          await this.requireAccountStillEligible(userId);
          return existing;
        }
        const updatedAt = mutationTimestamp(now, [existing.updatedAt]);
        const updated = await this.database.prepare(
          `UPDATE mission_progress
              SET submission_id = NULL, status = 'accepted', accepted_at = @now,
                  submitted_at = NULL, completed_at = NULL, updated_at = @updatedAt
            WHERE id = @id AND mission_id = @missionId AND user_id = @userId
              AND updated_at = @expectedUpdatedAt
              AND status IN ('cancelled', 'needs_revision')`,
        ).run({
          id: existing.id,
          missionId,
          userId,
          now,
          updatedAt,
          expectedUpdatedAt: existing.updatedAt,
        });
        if (updated.changes !== 1) return fail("mission_reserved");
      } else {
        const progressId = inputIdentifier(this.createProgressId());
        const inserted = await this.database.prepare(
          `INSERT INTO mission_progress (
             id, mission_id, user_id, submission_id, status,
             accepted_at, submitted_at, completed_at, updated_at
           ) VALUES (
             @id, @missionId, @userId, NULL, 'accepted',
             @now, NULL, NULL, @now
           ) ON CONFLICT DO NOTHING`,
        ).run({ id: progressId, missionId, userId, now });
        if (inserted.changes !== 1) return fail("mission_reserved");
      }

      const currentMission = await this.missionRow(missionId);
      if (!currentMission || !missionRecord(currentMission).active) return fail("mission_inactive");
      await this.requireAccountStillEligible(userId);
      const acceptedRow = await this.progressRow(missionId, userId);
      if (!acceptedRow) return fail("persistence_failure");
      const accepted = progressRecord(acceptedRow);
      if (accepted.status !== "accepted" || accepted.submissionId !== null) return fail("mission_reserved");
      return accepted;
    }), "mission_reserved");
  }

  async getMissionProgress(input: {
    missionId: string;
    userId: string;
  }): Promise<MissionLifecycleProgress | null> {
    const missionId = inputIdentifier(input.missionId);
    const userId = inputIdentifier(input.userId);
    return this.guarded(async () => {
      const row = await this.progressRow(missionId, userId);
      return row ? progressRecord(row) : null;
    });
  }

  async listMissionProgressForUser(input: {
    userId: string;
    limit: number;
    cursor?: MissionProgressListCursor | null | undefined;
  }): Promise<MissionProgressListPage> {
    const userId = inputIdentifier(input.userId);
    const limit = pageSize(input.limit);
    const cursor = input.cursor == null ? null : {
      updatedAt: inputTimestamp(input.cursor.updatedAt),
      id: inputIdentifier(input.cursor.id),
    };
    return this.guarded(async () => {
      const cursorCondition = cursor
        ? `AND (
              progress.updated_at < @cursorUpdatedAt
              OR (progress.updated_at = @cursorUpdatedAt AND progress.id > @cursorId)
            )`
        : "";
      const bindings: Record<string, unknown> = {
        userId,
        limit: limit + 1,
      };
      if (cursor) {
        bindings.cursorUpdatedAt = cursor.updatedAt;
        bindings.cursorId = cursor.id;
      }
      const rows = await this.database.prepare(
        `SELECT ${PROGRESS_PROJECTION}
           FROM mission_progress progress
          WHERE progress.user_id = @userId
            ${cursorCondition}
          ORDER BY progress.updated_at DESC, progress.id ASC
          LIMIT @limit`,
      ).all<ProgressRow>(bindings);
      const records = rows.map(progressRecord);
      const hasMore = records.length > limit;
      const progress = hasMore ? records.slice(0, limit) : records;
      const last = progress.at(-1);
      return {
        progress,
        nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
      };
    });
  }

  async releaseAcceptedMission(input: {
    missionId: string;
    userId: string;
    expectedAcceptedAt: string;
    expectedUpdatedAt: string;
    now: string;
  }): Promise<MissionLifecycleProgress> {
    const missionId = inputIdentifier(input.missionId);
    const userId = inputIdentifier(input.userId);
    const expectedAcceptedAt = inputTimestamp(input.expectedAcceptedAt);
    const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
    const now = inputTimestamp(input.now);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([
        missionLifecycleMissionLockKey(missionId),
        missionLifecycleAccountLockKey(userId),
      ]);
      const row = await this.progressRow(missionId, userId, true);
      if (!row) return fail("progress_not_found");
      const existing = progressRecord(row);
      if (existing.status !== "accepted") return fail("progress_not_releasable");
      if (existing.acceptedAt !== expectedAcceptedAt || existing.updatedAt !== expectedUpdatedAt) {
        return fail("progress_version_conflict");
      }
      const updatedAt = mutationTimestamp(now, [existing.updatedAt]);
      const changed = await this.database.prepare(
        `UPDATE mission_progress
            SET status = 'cancelled', completed_at = NULL, updated_at = @updatedAt
          WHERE id = @id AND mission_id = @missionId AND user_id = @userId
            AND status = 'accepted' AND accepted_at = @expectedAcceptedAt
            AND updated_at = @expectedUpdatedAt`,
      ).run({
        id: existing.id,
        missionId,
        userId,
        expectedAcceptedAt,
        expectedUpdatedAt,
        updatedAt,
      });
      if (changed.changes !== 1) return fail("progress_version_conflict");
      const released = await this.progressRow(missionId, userId);
      if (!released) return fail("persistence_failure");
      const record = progressRecord(released);
      if (record.status !== "cancelled") return fail("progress_version_conflict");
      return record;
    }));
  }

  async expireAcceptedMissionProgress(input: {
    acceptedBefore: string;
    now: string;
    limit: number;
  }): Promise<MissionExpiryBatchResult> {
    const acceptedBefore = inputTimestamp(input.acceptedBefore);
    const now = inputTimestamp(input.now);
    const limit = pageSize(input.limit, MAX_EXPIRY_BATCH_SIZE);
    if (acceptedBefore > now) return fail("invalid_input");
    return this.guarded(this.database.transaction(async () => {
      const lockClause = this.database.dialect === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";
      const changed = await this.database.prepare(
        `WITH candidates AS (
           SELECT progress.id
             FROM mission_progress progress
            WHERE progress.status = 'accepted' AND progress.accepted_at <= @acceptedBefore
            ORDER BY progress.accepted_at ASC, progress.id ASC
            LIMIT @limit${lockClause}
         )
         UPDATE mission_progress
            SET status = 'cancelled', completed_at = NULL, updated_at = @now
          WHERE id IN (SELECT id FROM candidates)
            AND status = 'accepted' AND accepted_at <= @acceptedBefore`,
      ).run({ acceptedBefore, now, limit });
      const remaining = await this.database.prepare(
        `SELECT 1 AS "present" FROM mission_progress
          WHERE status = 'accepted' AND accepted_at <= ? LIMIT 1`,
      ).get<{ present: unknown }>(acceptedBefore);
      return { expired: changed.changes, hasMore: Boolean(remaining) };
    }));
  }

  async listUnavailableMissionIds(input: {
    userId?: string | undefined;
    acceptedAfter: string;
    limit: number;
    cursor?: string | null | undefined;
  }): Promise<UnavailableMissionIdPage> {
    const userId = input.userId === undefined ? null : inputIdentifier(input.userId);
    const acceptedAfter = inputTimestamp(input.acceptedAfter);
    const limit = pageSize(input.limit);
    const cursor = input.cursor == null ? null : inputIdentifier(input.cursor);
    return this.guarded(async () => {
      const ownerCondition = userId === null ? "" : "AND progress.user_id <> @userId";
      const cursorCondition = cursor === null ? "" : "AND progress.mission_id > @cursor";
      const bindings: Record<string, unknown> = { acceptedAfter, limit: limit + 1 };
      if (userId !== null) bindings.userId = userId;
      if (cursor !== null) bindings.cursor = cursor;
      const rows = await this.database.prepare(
        `SELECT DISTINCT progress.mission_id AS "missionId"
           FROM mission_progress progress
          WHERE (
            progress.status = 'submitted'
            OR (progress.status = 'accepted' AND progress.accepted_at > @acceptedAfter)
          )
            ${ownerCondition}
            ${cursorCondition}
          ORDER BY progress.mission_id ASC
          LIMIT @limit`,
      ).all<{ missionId: unknown }>(bindings);
      const missionIds = rows.map((row) => recordIdentifier(row.missionId));
      const hasMore = missionIds.length > limit;
      const page = hasMore ? missionIds.slice(0, limit) : missionIds;
      return { missionIds: page, nextCursor: hasMore ? page.at(-1) ?? null : null };
    });
  }

  async setMissionActive(input: {
    missionId: string;
    active: boolean;
    expectedUpdatedAt: string;
    now: string;
  }): Promise<MissionLifecycleMission> {
    const missionId = inputIdentifier(input.missionId);
    if (typeof input.active !== "boolean") return fail("invalid_input");
    const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
    const now = inputTimestamp(input.now);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionLifecycleMissionLockKey(missionId)]);
      const row = await this.missionRow(missionId, true);
      if (!row) return fail("mission_not_found");
      const existing = missionRecord(row);
      if (existing.updatedAt !== expectedUpdatedAt) return fail("mission_version_conflict");
      if (existing.active === input.active) return existing;
      const updatedAt = mutationTimestamp(now, [existing.updatedAt]);
      const changed = await this.database.prepare(
        `UPDATE missions SET active = @active, updated_at = @updatedAt
          WHERE id = @missionId AND updated_at = @expectedUpdatedAt`,
      ).run({
        active: this.booleanValue(input.active),
        updatedAt,
        missionId,
        expectedUpdatedAt,
      });
      if (changed.changes !== 1) return fail("mission_version_conflict");
      const updated = await this.missionRow(missionId);
      if (!updated) return fail("persistence_failure");
      const record = missionRecord(updated);
      if (record.active !== input.active || record.updatedAt !== updatedAt) {
        return fail("mission_version_conflict");
      }
      return record;
    }));
  }

  async deleteMissionIfUnused(input: {
    missionId: string;
    expectedUpdatedAt: string;
  }): Promise<MissionLifecycleMission> {
    const missionId = inputIdentifier(input.missionId);
    const expectedUpdatedAt = inputTimestamp(input.expectedUpdatedAt);
    return this.guarded(this.database.transaction(async () => {
      await this.advisoryLocks([missionLifecycleMissionLockKey(missionId)]);
      const row = await this.missionRow(missionId, true);
      if (!row) return fail("mission_not_found");
      const existing = missionRecord(row);
      if (existing.updatedAt !== expectedUpdatedAt) return fail("mission_version_conflict");
      const deleted = await this.database.prepare(
        `DELETE FROM missions
          WHERE id = @missionId AND updated_at = @expectedUpdatedAt
            AND NOT EXISTS (
              SELECT 1 FROM mission_progress progress
               WHERE progress.mission_id = missions.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.mission_id = missions.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM venue_requests request
               WHERE request.mission_id = missions.id
            )`,
      ).run({ missionId, expectedUpdatedAt });
      if (deleted.changes !== 1) return fail("mission_in_use");
      return existing;
    }));
  }
}
