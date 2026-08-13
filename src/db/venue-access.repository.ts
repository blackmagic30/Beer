import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INVITATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{31,127}$/;
const MAX_CLAIM_PAGE = 200;
const MAX_ASSIGNMENT_PAGE = 200;
const MAX_RELATIONSHIP_VENUES = 100;
const MAX_EXPIRY_BATCH = 500;
const MAX_INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

const VENUE_ACCESS_ACCOUNT_LOCK_PREFIX = "venue-access:account:";

/**
 * Immutable cross-repository contract for venue-access/account-deletion
 * serialization. Deletion writers must acquire the account key before they
 * create or transition a request into a deletion-locking status.
 */
export const VENUE_ACCESS_LOCK_CONTRACT = Object.freeze({
  version: 1,
  accountKeyPrefix: VENUE_ACCESS_ACCOUNT_LOCK_PREFIX,
  deletionLockStatuses: Object.freeze(["processing", "failed", "completed"] as const),
  lockOrder: Object.freeze([
    "sorted_advisory_keys",
    "sorted_account_rows",
    "claim_row",
    "sorted_assignment_rows",
    "conditional_write",
    "deletion_recheck",
  ] as const),
} as const);

export type VenueClaimStatus = "pending" | "approved" | "rejected";
export type VenueAccessLevel = "manager" | "counter_staff";
export type VenueAccessStatus = "active" | "pending" | "revoked";

export type VenueAccessRepositoryErrorCode =
  | "account_not_active"
  | "account_not_found"
  | "assignment_conflict"
  | "assignment_not_found"
  | "claim_conflict"
  | "claim_not_found"
  | "deletion_locked"
  | "forbidden"
  | "invalid_input"
  | "invitation_expired"
  | "invitation_not_found"
  | "invitation_stale"
  | "invitation_token_conflict"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<VenueAccessRepositoryErrorCode, string>> = {
  account_not_active: "The account is not active for venue access changes.",
  account_not_found: "The account does not exist.",
  assignment_conflict: "The venue access assignment conflicts with existing state.",
  assignment_not_found: "The venue access assignment does not exist.",
  claim_conflict: "The venue claim conflicts with existing review state.",
  claim_not_found: "The venue claim does not exist.",
  deletion_locked: "Venue access changes are unavailable while account deletion is being processed.",
  forbidden: "The account is not authorized for this venue access persistence operation.",
  invalid_input: "The venue access persistence input is invalid.",
  invitation_expired: "The counter-staff invitation has expired.",
  invitation_not_found: "The counter-staff invitation does not exist.",
  invitation_stale: "The counter-staff invitation is no longer current.",
  invitation_token_conflict: "The counter-staff invitation token conflicts with existing state.",
  persistence_failure: "Venue access persistence could not be completed.",
};

/** Stable, secret-free failures for future service and HTTP mapping. */
export class VenueAccessRepositoryError extends Error {
  readonly code: VenueAccessRepositoryErrorCode;

  constructor(code: VenueAccessRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueAccessRepositoryError";
    this.code = code;
  }
}

export interface VenueClaimRecord {
  id: string;
  userId: string;
  venueId: string | null;
  venueName: string;
  address: string | null;
  suburb: string | null;
  requesterName: string;
  requesterRole: string;
  contactEmail: string;
  contactPhone: string | null;
  message: string | null;
  status: VenueClaimStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenueAccessAssignmentRecord {
  /** For counter staff this is also the opaque invitation token. */
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  accessLevel: VenueAccessLevel;
  status: VenueAccessStatus;
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenueClaimCursor {
  createdAt: string;
  id: string;
}

export interface VenueAssignmentCursor {
  updatedAt: string;
  id: string;
}

export interface VenueClaimPage {
  claims: VenueClaimRecord[];
  nextCursor: VenueClaimCursor | null;
}

export interface VenueAssignmentPage {
  assignments: VenueAccessAssignmentRecord[];
  nextCursor: VenueAssignmentCursor | null;
}

interface AccountRow {
  id: unknown;
  status: unknown;
  authProvider: unknown;
  role: unknown;
  subscriptionStatus: unknown;
  deletionLocked: unknown;
}

interface VenueClaimRow {
  id: unknown;
  userId: unknown;
  venueId: unknown;
  venueName: unknown;
  address: unknown;
  suburb: unknown;
  requesterName: unknown;
  requesterRole: unknown;
  contactEmail: unknown;
  contactPhone: unknown;
  message: unknown;
  status: unknown;
  reviewNote: unknown;
  reviewedBy: unknown;
  reviewedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface VenueAssignmentRow {
  id: unknown;
  userId: unknown;
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  accessLevel: unknown;
  status: unknown;
  approvedBy: unknown;
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

function repositoryError(code: VenueAccessRepositoryErrorCode): never {
  throw new VenueAccessRepositoryError(code);
}

function requireText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("invalid_input");
  }
  return normalized;
}

/** Shared validated advisory-lock key for account/deletion coordination. */
export function venueAccessAccountLockKey(accountId: string): string {
  return `${VENUE_ACCESS_ACCOUNT_LOCK_PREFIX}${requireText(accountId)}`;
}

function optionalText(value: unknown, maximum = 1_000): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return repositoryError("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || value.includes("\0")) return repositoryError("invalid_input");
  return normalized;
}

function persistedText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("persistence_failure");
  }
  return normalized;
}

function optionalPersistedText(value: unknown, maximum = 1_000): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    return repositoryError("persistence_failure");
  }
  return value;
}

function requireCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("invalid_input");
    }
    return value;
  } catch {
    return repositoryError("invalid_input");
  }
}

function persistedCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("persistence_failure");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("persistence_failure");
    }
    return value;
  } catch {
    return repositoryError("persistence_failure");
  }
}

function optionalPersistedCanonicalUtc(value: unknown): string | null {
  return value == null ? null : persistedCanonicalUtc(value);
}

function persistedBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return repositoryError("persistence_failure");
}

function requireEmail(value: unknown): string {
  const email = requireText(value, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return repositoryError("invalid_input");
  return email;
}

function requireClaimStatus(value: unknown): VenueClaimStatus {
  if (value !== "pending" && value !== "approved" && value !== "rejected") {
    return repositoryError("invalid_input");
  }
  return value;
}

function requireReviewDecision(value: unknown): Exclude<VenueClaimStatus, "pending"> {
  if (value !== "approved" && value !== "rejected") return repositoryError("invalid_input");
  return value;
}

function persistedClaimStatus(value: unknown): VenueClaimStatus {
  if (value !== "pending" && value !== "approved" && value !== "rejected") {
    return repositoryError("persistence_failure");
  }
  return value;
}

function requireAccessLevel(value: unknown): VenueAccessLevel {
  if (value !== "manager" && value !== "counter_staff") return repositoryError("invalid_input");
  return value;
}

function requireAccessStatus(value: unknown): VenueAccessStatus {
  if (value !== "active" && value !== "pending" && value !== "revoked") {
    return repositoryError("invalid_input");
  }
  return value;
}

function persistedAccessLevel(value: unknown): VenueAccessLevel {
  if (value !== "manager" && value !== "counter_staff") return repositoryError("persistence_failure");
  return value;
}

function persistedAccessStatus(value: unknown): VenueAccessStatus {
  if (value !== "active" && value !== "pending" && value !== "revoked") {
    return repositoryError("persistence_failure");
  }
  return value;
}

function requireInvitationToken(value: unknown): string {
  const token = requireText(value, 128);
  if (!INVITATION_TOKEN.test(token)) return repositoryError("invalid_input");
  return token;
}

function requireLimit(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return repositoryError("invalid_input");
  }
  return value as number;
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    return repositoryError("persistence_failure");
  }
  if (!/^\d+$/.test(String(value))) return repositoryError("persistence_failure");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return repositoryError("persistence_failure");
  return count;
}

function relationshipVenueIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIP_VENUES) {
    return repositoryError("invalid_input");
  }
  return [...new Set(value.map((venueId) => requireText(venueId)))].sort();
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

function toClaim(row: VenueClaimRow): VenueClaimRecord {
  const status = persistedClaimStatus(row.status);
  const reviewedAt = optionalPersistedCanonicalUtc(row.reviewedAt);
  const reviewedBy = optionalPersistedText(row.reviewedBy);
  if (
    (status === "pending" && (reviewedAt !== null || reviewedBy !== null))
    || (status !== "pending" && reviewedAt === null)
  ) return repositoryError("persistence_failure");
  return {
    id: persistedText(row.id),
    userId: persistedText(row.userId),
    venueId: optionalPersistedText(row.venueId),
    venueName: persistedText(row.venueName, 240),
    address: optionalPersistedText(row.address, 512),
    suburb: optionalPersistedText(row.suburb, 160),
    requesterName: persistedText(row.requesterName, 160),
    requesterRole: persistedText(row.requesterRole, 120),
    contactEmail: persistedText(row.contactEmail, 320),
    contactPhone: optionalPersistedText(row.contactPhone, 80),
    message: optionalPersistedText(row.message, 2_000),
    status,
    reviewNote: optionalPersistedText(row.reviewNote, 2_000),
    reviewedBy,
    reviewedAt,
    createdAt: persistedCanonicalUtc(row.createdAt),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

function toAssignment(row: VenueAssignmentRow): VenueAccessAssignmentRecord {
  const accessLevel = persistedAccessLevel(row.accessLevel);
  const status = persistedAccessStatus(row.status);
  const expiresAt = optionalPersistedCanonicalUtc(row.expiresAt);
  if (
    (status === "pending" && (accessLevel !== "counter_staff" || expiresAt === null))
    || (status !== "pending" && expiresAt !== null)
  ) return repositoryError("persistence_failure");
  const id = persistedText(row.id);
  // Legacy active/revoked counter assignments predate opaque invitation-token
  // validation. Only a live pending invitation must carry the new token shape;
  // fresh invitations rotate the row id before returning to pending.
  if (accessLevel === "counter_staff" && status === "pending" && !INVITATION_TOKEN.test(id)) {
    return repositoryError("persistence_failure");
  }
  return {
    id,
    userId: persistedText(row.userId),
    venueId: persistedText(row.venueId),
    venueName: persistedText(row.venueName, 240),
    suburb: optionalPersistedText(row.suburb, 160),
    accessLevel,
    status,
    approvedBy: optionalPersistedText(row.approvedBy),
    expiresAt,
    createdAt: persistedCanonicalUtc(row.createdAt),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

const CLAIM_PROJECTION = `
  claim.id AS "id", claim.user_id AS "userId", claim.venue_id AS "venueId",
  claim.venue_name AS "venueName", claim.address AS "address", claim.suburb AS "suburb",
  claim.requester_name AS "requesterName", claim.requester_role AS "requesterRole",
  claim.contact_email AS "contactEmail", claim.contact_phone AS "contactPhone",
  claim.message AS "message", claim.status AS "status", claim.review_note AS "reviewNote",
  claim.reviewed_by AS "reviewedBy", claim.reviewed_at AS "reviewedAt",
  claim.created_at AS "createdAt", claim.updated_at AS "updatedAt"`;

const ASSIGNMENT_PROJECTION = `
  assignment.id AS "id", assignment.user_id AS "userId", assignment.venue_id AS "venueId",
  assignment.venue_name AS "venueName", assignment.suburb AS "suburb",
  assignment.access_level AS "accessLevel", assignment.status AS "status",
  assignment.approved_by AS "approvedBy", assignment.expires_at AS "expiresAt",
  assignment.created_at AS "createdAt", assignment.updated_at AS "updatedAt"`;

/**
 * PostgreSQL-native venue claim and assignment persistence.
 *
 * Lock contract for mutations:
 *   1. acquire every known `venue-access:*` transaction advisory lock in sorted order;
 *   2. lock involved account rows in sorted account-id order;
 *   3. lock a claim row, when present;
 *   4. lock assignment rows in sorted `userId/venueId` order;
 *   5. apply conditional state changes and re-check deletion locks before commit.
 *
 * Reads used to discover immutable claim/assignment identities happen before
 * the locks and are always re-read and validated after locking. Provider,
 * email, storage and commercial-launch decisions do not belong in this class.
 *
 * Account-deletion request creation/state transitions import the shared
 * `venueAccessAccountLockKey` helper and acquire that advisory key before the
 * account row. The final in-transaction recheck remains a fail-closed defence
 * after this cross-repository serialization boundary.
 */
export class VenueAccessRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translateFailure<Result>(
    work: () => Promise<Result>,
    uniqueCode: VenueAccessRepositoryErrorCode = "persistence_failure",
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueAccessRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new VenueAccessRepositoryError(uniqueCode);
      throw new VenueAccessRepositoryError("persistence_failure");
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

  private async lockAccounts(ids: readonly string[]): Promise<Map<string, AccountRow>> {
    const rows = new Map<string, AccountRow>();
    for (const id of [...new Set(ids)].sort()) {
      const row = await this.database.prepare(
        `SELECT account.id AS "id", account.status AS "status",
                account.auth_provider AS "authProvider", account.role AS "role",
                account.subscription_status AS "subscriptionStatus",
                EXISTS (
                  SELECT 1 FROM account_deletion_requests deletion
                   WHERE deletion.user_id = account.id
                     AND deletion.status IN ('processing', 'failed', 'completed')
                ) AS "deletionLocked"
           FROM accounts account WHERE account.id = ?${this.lockSuffix("account")}`,
      ).get<AccountRow>(id);
      if (row) rows.set(id, row);
    }
    return rows;
  }

  private requireEligibleAccount(rows: Map<string, AccountRow>, id: string): AccountRow {
    const row = rows.get(id);
    if (!row) return repositoryError("account_not_found");
    if (persistedText(row.id) !== id) return repositoryError("persistence_failure");
    const authProvider = persistedText(row.authProvider, 64);
    const status = persistedText(row.status, 32);
    if (authProvider === "deleted" || persistedBoolean(row.deletionLocked)) {
      return repositoryError("deletion_locked");
    }
    if (status !== "active") return repositoryError("account_not_active");
    return row;
  }

  private requireAdminAccount(rows: Map<string, AccountRow>, id: string): AccountRow {
    const row = this.requireEligibleAccount(rows, id);
    const role = persistedText(row.role, 64);
    const subscriptionStatus = persistedText(row.subscriptionStatus, 64);
    if (role !== "admin" && subscriptionStatus !== "admin") return repositoryError("forbidden");
    return row;
  }

  private async assertDeletionStillUnlocked(ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) {
      const row = await this.database.prepare(
        `SELECT account.status AS "status", account.auth_provider AS "authProvider",
                EXISTS (
                  SELECT 1 FROM account_deletion_requests deletion
                   WHERE deletion.user_id = account.id
                     AND deletion.status IN ('processing', 'failed', 'completed')
                ) AS "deletionLocked"
           FROM accounts account WHERE account.id = ?`,
      ).get<{ status: unknown; authProvider: unknown; deletionLocked: unknown }>(id);
      if (!row) return repositoryError("account_not_found");
      if (persistedText(row.authProvider, 64) === "deleted" || persistedBoolean(row.deletionLocked)) {
        return repositoryError("deletion_locked");
      }
      if (persistedText(row.status, 32) !== "active") return repositoryError("account_not_active");
    }
  }

  private async claimById(id: string, lock = false): Promise<VenueClaimRow | null> {
    const row = await this.database.prepare(
      `SELECT ${CLAIM_PROJECTION} FROM venue_claim_requests claim
        WHERE claim.id = ?${lock ? this.lockSuffix("claim") : ""}`,
    ).get<VenueClaimRow>(id);
    return row ?? null;
  }

  private async pendingClaim(userId: string, venueId: string, lock = false): Promise<VenueClaimRow | null> {
    const row = await this.database.prepare(
      `SELECT ${CLAIM_PROJECTION} FROM venue_claim_requests claim
        WHERE claim.user_id = ? AND claim.venue_id = ? AND claim.status = 'pending'
        ORDER BY claim.created_at DESC, claim.id DESC LIMIT 1${lock ? this.lockSuffix("claim") : ""}`,
    ).get<VenueClaimRow>(userId, venueId);
    return row ?? null;
  }

  private async assignmentByPair(userId: string, venueId: string, lock = false): Promise<VenueAssignmentRow | null> {
    const row = await this.database.prepare(
      `SELECT ${ASSIGNMENT_PROJECTION} FROM venue_manager_assignments assignment
        WHERE assignment.user_id = ? AND assignment.venue_id = ?
        LIMIT 1${lock ? this.lockSuffix("assignment") : ""}`,
    ).get<VenueAssignmentRow>(userId, venueId);
    return row ?? null;
  }

  private async assignmentByToken(token: string): Promise<VenueAssignmentRow | null> {
    const row = await this.database.prepare(
      `SELECT ${ASSIGNMENT_PROJECTION} FROM venue_manager_assignments assignment
        WHERE assignment.id = ? LIMIT 1`,
    ).get<VenueAssignmentRow>(token);
    return row ?? null;
  }

  private async lockAssignments(
    pairs: ReadonlyArray<{ userId: string; venueId: string }>,
  ): Promise<Map<string, VenueAssignmentRow>> {
    const rows = new Map<string, VenueAssignmentRow>();
    const unique = new Map(pairs.map((pair) => [`${pair.userId}\0${pair.venueId}`, pair]));
    for (const [key, pair] of [...unique.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const row = await this.assignmentByPair(pair.userId, pair.venueId, true);
      if (row) rows.set(key, row);
    }
    return rows;
  }

  private async upsertManagerAssignment(input: {
    assignmentId: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    approvedBy: string;
    now: string;
    existing: VenueAssignmentRow | null;
  }): Promise<VenueAccessAssignmentRecord> {
    if (input.existing) {
      const existing = toAssignment(input.existing);
      const updated = await this.database.prepare(
        `UPDATE venue_manager_assignments
            SET venue_name = @venueName, suburb = @suburb, access_level = 'manager',
                status = 'active', approved_by = @approvedBy, expires_at = NULL,
                updated_at = @now
          WHERE user_id = @userId AND venue_id = @venueId AND id = @expectedId`,
      ).run({ ...input, expectedId: existing.id });
      if (updated.changes !== 1) return repositoryError("assignment_conflict");
    } else {
      const inserted = await this.database.prepare(
        `INSERT INTO venue_manager_assignments (
           id, user_id, venue_id, venue_name, suburb, access_level, status,
           approved_by, expires_at, created_at, updated_at
         ) VALUES (
           @assignmentId, @userId, @venueId, @venueName, @suburb, 'manager', 'active',
           @approvedBy, NULL, @now, @now
         ) ON CONFLICT(user_id, venue_id) DO NOTHING`,
      ).run(input);
      if (inserted.changes !== 1) return repositoryError("assignment_conflict");
    }
    await this.database.prepare(
      "UPDATE accounts SET role = 'venue_manager', updated_at = ? WHERE id = ? AND role = 'user'",
    ).run(input.now, input.userId);
    const row = await this.assignmentByPair(input.userId, input.venueId);
    if (!row) return repositoryError("persistence_failure");
    const assignment = toAssignment(row);
    if (assignment.accessLevel !== "manager" || assignment.status !== "active") {
      return repositoryError("assignment_conflict");
    }
    return assignment;
  }

  async createVenueClaim(input: {
    id: string;
    userId: string;
    venueId: string;
    venueName: string;
    address: string | null;
    suburb: string | null;
    requesterName: string;
    requesterRole: string;
    contactEmail: string;
    contactPhone: string | null;
    message: string | null;
    now: string;
  }): Promise<{ claim: VenueClaimRecord; outcome: "created" | "existing" }> {
    const normalized = {
      id: requireText(input.id),
      userId: requireText(input.userId),
      venueId: requireText(input.venueId),
      venueName: requireText(input.venueName, 240),
      address: optionalText(input.address, 512),
      suburb: optionalText(input.suburb, 160),
      requesterName: requireText(input.requesterName, 160),
      requesterRole: requireText(input.requesterRole, 120),
      contactEmail: requireEmail(input.contactEmail),
      contactPhone: optionalText(input.contactPhone, 80),
      message: optionalText(input.message, 2_000),
      now: requireCanonicalUtc(input.now),
    };

    return this.translateFailure(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueAccessAccountLockKey(normalized.userId),
        `venue-access:claim:${normalized.id}`,
        `venue-access:claim-pair:${normalized.userId}:${normalized.venueId}`,
      ]);
      const accounts = await this.lockAccounts([normalized.userId]);
      this.requireEligibleAccount(accounts, normalized.userId);

      const sameId = await this.claimById(normalized.id, true);
      if (sameId) {
        const claim = toClaim(sameId);
        if (
          claim.userId !== normalized.userId || claim.venueId !== normalized.venueId
          || claim.venueName !== normalized.venueName || claim.address !== normalized.address
          || claim.suburb !== normalized.suburb || claim.requesterName !== normalized.requesterName
          || claim.requesterRole !== normalized.requesterRole || claim.contactEmail !== normalized.contactEmail
          || claim.contactPhone !== normalized.contactPhone || claim.message !== normalized.message
        ) return repositoryError("claim_conflict");
        await this.assertDeletionStillUnlocked([normalized.userId]);
        return { claim, outcome: "existing" as const };
      }

      const pending = await this.pendingClaim(normalized.userId, normalized.venueId, true);
      if (pending) {
        await this.assertDeletionStillUnlocked([normalized.userId]);
        return { claim: toClaim(pending), outcome: "existing" as const };
      }

      const inserted = await this.database.prepare(
        `INSERT INTO venue_claim_requests (
           id, user_id, venue_id, venue_name, address, suburb, requester_name,
           requester_role, contact_email, contact_phone, message, status,
           review_note, reviewed_by, reviewed_at, created_at, updated_at
         ) VALUES (
           @id, @userId, @venueId, @venueName, @address, @suburb, @requesterName,
           @requesterRole, @contactEmail, @contactPhone, @message, 'pending',
           NULL, NULL, NULL, @now, @now
         ) ON CONFLICT(id) DO NOTHING`,
      ).run(normalized);
      if (inserted.changes !== 1) return repositoryError("claim_conflict");
      await this.assertDeletionStillUnlocked([normalized.userId]);
      const row = await this.claimById(normalized.id);
      if (!row) return repositoryError("persistence_failure");
      return { claim: toClaim(row), outcome: "created" as const };
    }), "claim_conflict");
  }

  async getVenueClaim(id: string): Promise<VenueClaimRecord | null> {
    const claimId = requireText(id);
    return this.translateFailure(async () => {
      const row = await this.claimById(claimId);
      return row ? toClaim(row) : null;
    });
  }

  async getPendingVenueClaim(input: { userId: string; venueId: string }): Promise<VenueClaimRecord | null> {
    const userId = requireText(input.userId);
    const venueId = requireText(input.venueId);
    return this.translateFailure(async () => {
      const row = await this.pendingClaim(userId, venueId);
      return row ? toClaim(row) : null;
    });
  }

  async listVenueClaims(input: {
    userId?: string | undefined;
    status?: VenueClaimStatus | undefined;
    limit: number;
    cursor?: VenueClaimCursor | null | undefined;
  }): Promise<VenueClaimPage> {
    const limit = requireLimit(input.limit, MAX_CLAIM_PAGE);
    const userId = input.userId === undefined ? null : requireText(input.userId);
    const status = input.status === undefined ? null : requireClaimStatus(input.status);
    const cursor = input.cursor == null ? null : {
      createdAt: requireCanonicalUtc(input.cursor.createdAt),
      id: requireText(input.cursor.id),
    };
    return this.translateFailure(async () => {
      const cursorPredicate = this.database.dialect === "postgres"
        ? `(CAST(@cursorCreatedAt AS timestamptz) IS NULL
            OR claim.created_at < CAST(@cursorCreatedAt AS timestamptz)
            OR (claim.created_at = CAST(@cursorCreatedAt AS timestamptz) AND claim.id < @cursorId))`
        : `(@cursorCreatedAt IS NULL
            OR claim.created_at < @cursorCreatedAt
            OR (claim.created_at = @cursorCreatedAt AND claim.id < @cursorId))`;
      const rows = await this.database.prepare(
        `SELECT ${CLAIM_PROJECTION} FROM venue_claim_requests claim
          WHERE (CAST(@userId AS TEXT) IS NULL OR claim.user_id = @userId)
            AND (CAST(@status AS TEXT) IS NULL OR claim.status = @status)
            AND ${cursorPredicate}
          ORDER BY claim.created_at DESC, claim.id DESC LIMIT @rowLimit`,
      ).all<VenueClaimRow>({
        userId,
        status,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        rowLimit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const claims = rows.slice(0, limit).map(toClaim);
      const last = hasMore ? claims.at(-1) ?? null : null;
      return {
        claims,
        nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async countVenueClaims(input: { status?: VenueClaimStatus | undefined } = {}): Promise<number> {
    const status = input.status === undefined ? null : requireClaimStatus(input.status);
    return this.translateFailure(async () => {
      const row = status === null
        ? await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_claim_requests claim`,
          ).get<{ count: unknown }>()
        : await this.database.prepare(
            `SELECT count(*) AS "count" FROM venue_claim_requests claim WHERE claim.status = ?`,
          ).get<{ count: unknown }>(status);
      return safeCount(row?.count ?? 0);
    });
  }

  async reviewVenueClaimAndAssignManager(input: {
    claimId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    reviewNote: string | null;
    expectedUpdatedAt: string;
    assignmentId: string | null;
    now: string;
  }): Promise<{
    claim: VenueClaimRecord;
    assignment: VenueAccessAssignmentRecord | null;
    outcome: "reviewed" | "duplicate";
  }> {
    const claimId = requireText(input.claimId);
    const reviewerAccountId = requireText(input.reviewerAccountId);
    const decision = requireReviewDecision(input.decision);
    const reviewNote = optionalText(input.reviewNote, 2_000);
    const expectedUpdatedAt = requireCanonicalUtc(input.expectedUpdatedAt);
    const assignmentId = input.assignmentId == null ? null : requireText(input.assignmentId);
    const now = requireCanonicalUtc(input.now);
    if ((decision === "approved") !== (assignmentId !== null)) return repositoryError("invalid_input");

    return this.translateFailure(this.database.transaction(async () => {
      const snapshotRow = await this.claimById(claimId);
      if (!snapshotRow) return repositoryError("claim_not_found");
      const snapshot = toClaim(snapshotRow);
      const assignmentKey = snapshot.venueId
        ? `venue-access:assignment:${snapshot.userId}:${snapshot.venueId}`
        : null;
      await this.advisoryLocks([
        venueAccessAccountLockKey(reviewerAccountId),
        venueAccessAccountLockKey(snapshot.userId),
        `venue-access:claim:${claimId}`,
        ...(assignmentKey ? [assignmentKey] : []),
      ]);
      const accounts = await this.lockAccounts([reviewerAccountId, snapshot.userId]);
      this.requireAdminAccount(accounts, reviewerAccountId);
      const lockedRow = await this.claimById(claimId, true);
      if (!lockedRow) return repositoryError("claim_not_found");
      const claim = toClaim(lockedRow);
      if (claim.userId !== snapshot.userId || claim.venueId !== snapshot.venueId) {
        return repositoryError("claim_conflict");
      }
      if (claim.status !== "pending") {
        if (claim.status !== decision) return repositoryError("claim_conflict");
        const existingAssignment = decision === "approved" && claim.venueId
          ? await this.assignmentByPair(claim.userId, claim.venueId)
          : null;
        await this.assertDeletionStillUnlocked([reviewerAccountId]);
        return {
          claim,
          assignment: existingAssignment ? toAssignment(existingAssignment) : null,
          outcome: "duplicate" as const,
        };
      }
      this.requireEligibleAccount(accounts, claim.userId);
      if (claim.updatedAt !== expectedUpdatedAt) return repositoryError("claim_conflict");
      if (decision === "approved" && !claim.venueId) return repositoryError("invalid_input");

      const reviewed = await this.database.prepare(
        `UPDATE venue_claim_requests
            SET status = @decision, review_note = @reviewNote, reviewed_by = @reviewerAccountId,
                reviewed_at = @now, updated_at = @now
          WHERE id = @claimId AND status = 'pending' AND updated_at = @expectedUpdatedAt`,
      ).run({ claimId, decision, reviewNote, reviewerAccountId, now, expectedUpdatedAt });
      if (reviewed.changes !== 1) return repositoryError("claim_conflict");

      let assignment: VenueAccessAssignmentRecord | null = null;
      if (decision === "approved" && claim.venueId && assignmentId) {
        const existing = await this.assignmentByPair(claim.userId, claim.venueId, true);
        assignment = await this.upsertManagerAssignment({
          assignmentId,
          userId: claim.userId,
          venueId: claim.venueId,
          venueName: claim.venueName,
          suburb: claim.suburb,
          approvedBy: reviewerAccountId,
          now,
          existing,
        });
      }
      await this.assertDeletionStillUnlocked([reviewerAccountId, claim.userId]);
      const finalRow = await this.claimById(claimId);
      if (!finalRow) return repositoryError("persistence_failure");
      return { claim: toClaim(finalRow), assignment, outcome: "reviewed" as const };
    }), "assignment_conflict");
  }

  async assignVenueManager(input: {
    assignmentId: string;
    adminAccountId: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    now: string;
  }): Promise<VenueAccessAssignmentRecord> {
    const normalized = {
      assignmentId: requireText(input.assignmentId),
      adminAccountId: requireText(input.adminAccountId),
      userId: requireText(input.userId),
      venueId: requireText(input.venueId),
      venueName: requireText(input.venueName, 240),
      suburb: optionalText(input.suburb, 160),
      now: requireCanonicalUtc(input.now),
    };
    return this.translateFailure(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueAccessAccountLockKey(normalized.adminAccountId),
        venueAccessAccountLockKey(normalized.userId),
        `venue-access:assignment:${normalized.userId}:${normalized.venueId}`,
      ]);
      const accounts = await this.lockAccounts([normalized.adminAccountId, normalized.userId]);
      this.requireAdminAccount(accounts, normalized.adminAccountId);
      this.requireEligibleAccount(accounts, normalized.userId);
      const existing = await this.assignmentByPair(normalized.userId, normalized.venueId, true);
      const assignment = await this.upsertManagerAssignment({
        assignmentId: normalized.assignmentId,
        userId: normalized.userId,
        venueId: normalized.venueId,
        venueName: normalized.venueName,
        suburb: normalized.suburb,
        approvedBy: normalized.adminAccountId,
        now: normalized.now,
        existing,
      });
      await this.assertDeletionStillUnlocked([normalized.adminAccountId, normalized.userId]);
      return assignment;
    }), "assignment_conflict");
  }

  async getVenueAssignment(input: {
    userId: string;
    venueId: string;
    activeOnly?: boolean | undefined;
  }): Promise<VenueAccessAssignmentRecord | null> {
    const userId = requireText(input.userId);
    const venueId = requireText(input.venueId);
    return this.translateFailure(async () => {
      const row = await this.assignmentByPair(userId, venueId);
      if (!row) return null;
      const assignment = toAssignment(row);
      return input.activeOnly && assignment.status !== "active" ? null : assignment;
    });
  }

  async listVenueAssignments(input: {
    userId?: string | undefined;
    venueId?: string | undefined;
    accessLevel?: VenueAccessLevel | undefined;
    status?: VenueAccessStatus | undefined;
    currentOnly?: boolean | undefined;
    limit: number;
    cursor?: VenueAssignmentCursor | null | undefined;
  }): Promise<VenueAssignmentPage> {
    const limit = requireLimit(input.limit, MAX_ASSIGNMENT_PAGE);
    const userId = input.userId === undefined ? null : requireText(input.userId);
    const venueId = input.venueId === undefined ? null : requireText(input.venueId);
    const accessLevel = input.accessLevel === undefined ? null : requireAccessLevel(input.accessLevel);
    const status = input.status === undefined ? null : requireAccessStatus(input.status);
    if (input.currentOnly && status === "revoked") return repositoryError("invalid_input");
    const cursor = input.cursor == null ? null : {
      updatedAt: requireCanonicalUtc(input.cursor.updatedAt),
      id: requireText(input.cursor.id),
    };
    return this.translateFailure(async () => {
      const cursorPredicate = this.database.dialect === "postgres"
        ? `(CAST(@cursorUpdatedAt AS timestamptz) IS NULL
            OR assignment.updated_at < CAST(@cursorUpdatedAt AS timestamptz)
            OR (assignment.updated_at = CAST(@cursorUpdatedAt AS timestamptz) AND assignment.id < @cursorId))`
        : `(@cursorUpdatedAt IS NULL
            OR assignment.updated_at < @cursorUpdatedAt
            OR (assignment.updated_at = @cursorUpdatedAt AND assignment.id < @cursorId))`;
      const rows = await this.database.prepare(
        `SELECT ${ASSIGNMENT_PROJECTION} FROM venue_manager_assignments assignment
          WHERE (CAST(@userId AS TEXT) IS NULL OR assignment.user_id = @userId)
            AND (CAST(@venueId AS TEXT) IS NULL OR assignment.venue_id = @venueId)
            AND (CAST(@accessLevel AS TEXT) IS NULL OR assignment.access_level = @accessLevel)
            AND (CAST(@status AS TEXT) IS NULL OR assignment.status = @status)
            AND (@currentOnly = 0 OR assignment.status <> 'revoked')
            AND ${cursorPredicate}
          ORDER BY assignment.updated_at DESC, assignment.id DESC LIMIT @rowLimit`,
      ).all<VenueAssignmentRow>({
        userId,
        venueId,
        accessLevel,
        status,
        currentOnly: input.currentOnly ? 1 : 0,
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        cursorId: cursor?.id ?? null,
        rowLimit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const assignments = rows.slice(0, limit).map(toAssignment);
      const last = hasMore ? assignments.at(-1) ?? null : null;
      return {
        assignments,
        nextCursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
      };
    });
  }

  async countVenueAssignments(input: {
    status?: VenueAccessStatus | undefined;
    currentOnly?: boolean | undefined;
  } = {}): Promise<number> {
    const status = input.status === undefined ? null : requireAccessStatus(input.status);
    if (input.currentOnly && status === "revoked") return repositoryError("invalid_input");
    return this.translateFailure(async () => {
      const conditions = [
        ...(status === null ? [] : ["assignment.status = @status"]),
        ...(input.currentOnly ? ["assignment.status <> 'revoked'"] : []),
      ];
      const statement = this.database.prepare(
        `SELECT count(*) AS "count"
           FROM venue_manager_assignments assignment
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
      );
      const row = status === null
        ? await statement.get<{ count: unknown }>()
        : await statement.get<{ count: unknown }>({ status });
      return safeCount(row?.count ?? 0);
    });
  }

  /**
   * Bounded relationship lookup for partner leads. Active counter-staff rows
   * intentionally count as assigned, preserving the existing admin UI rule.
   */
  async listActiveAssignedVenueIds(input: {
    venueIds: readonly string[];
  }): Promise<string[]> {
    const venueIds = relationshipVenueIds(input.venueIds);
    if (!venueIds.length) return [];
    return this.translateFailure(async () => {
      const placeholders = venueIds.map(() => "?").join(", ");
      const rows = await this.database.prepare(
        `SELECT DISTINCT assignment.venue_id AS "venueId"
           FROM venue_manager_assignments assignment
          WHERE assignment.status = 'active'
            AND assignment.venue_id IN (${placeholders})
          ORDER BY assignment.venue_id ASC`,
      ).all<{ venueId: unknown }>(...venueIds);
      const requested = new Set(venueIds);
      const result = rows.map((row) => persistedText(row.venueId));
      if (new Set(result).size !== result.length || result.some((venueId) => !requested.has(venueId))) {
        return repositoryError("persistence_failure");
      }
      return result;
    });
  }

  async revokeVenueAssignment(input: {
    actorAccountId: string;
    userId: string;
    venueId: string;
    expectedAccessLevel: VenueAccessLevel;
    now: string;
  }): Promise<{ assignment: VenueAccessAssignmentRecord; outcome: "revoked" | "duplicate" }> {
    const actorAccountId = requireText(input.actorAccountId);
    const userId = requireText(input.userId);
    const venueId = requireText(input.venueId);
    const expectedAccessLevel = requireAccessLevel(input.expectedAccessLevel);
    const now = requireCanonicalUtc(input.now);
    return this.translateFailure(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueAccessAccountLockKey(actorAccountId),
        venueAccessAccountLockKey(userId),
        `venue-access:assignment:${actorAccountId}:${venueId}`,
        `venue-access:assignment:${userId}:${venueId}`,
      ]);
      const accounts = await this.lockAccounts([actorAccountId, userId]);
      const actor = this.requireEligibleAccount(accounts, actorAccountId);
      const assignments = await this.lockAssignments([
        { userId: actorAccountId, venueId },
        { userId, venueId },
      ]);
      const targetRow = assignments.get(`${userId}\0${venueId}`);
      if (!targetRow) return repositoryError("assignment_not_found");
      const target = toAssignment(targetRow);
      if (target.accessLevel !== expectedAccessLevel) return repositoryError("assignment_conflict");

      const actorIsAdmin = persistedText(actor.role, 64) === "admin"
        || persistedText(actor.subscriptionStatus, 64) === "admin";
      const actorAssignmentRow = assignments.get(`${actorAccountId}\0${venueId}`);
      const actorAssignment = actorAssignmentRow ? toAssignment(actorAssignmentRow) : null;
      if (
        !actorIsAdmin
        && !(
          expectedAccessLevel === "counter_staff"
          && actorAssignment?.accessLevel === "manager"
          && actorAssignment.status === "active"
        )
      ) return repositoryError("forbidden");

      if (target.status === "revoked") {
        await this.assertDeletionStillUnlocked([actorAccountId]);
        return { assignment: target, outcome: "duplicate" as const };
      }
      const revoked = await this.database.prepare(
        `UPDATE venue_manager_assignments
            SET status = 'revoked', expires_at = NULL, updated_at = @now
          WHERE id = @id AND user_id = @userId AND venue_id = @venueId
            AND access_level = @expectedAccessLevel AND status IN ('active', 'pending')`,
      ).run({ id: target.id, userId, venueId, expectedAccessLevel, now });
      if (revoked.changes !== 1) return repositoryError("assignment_conflict");

      if (expectedAccessLevel === "manager") {
        const active = await this.database.prepare(
          `SELECT 1 AS "active" FROM venue_manager_assignments
            WHERE user_id = ? AND access_level = 'manager' AND status = 'active' LIMIT 1`,
        ).get(userId);
        if (!active) {
          await this.database.prepare(
            "UPDATE accounts SET role = 'user', updated_at = ? WHERE id = ? AND role = 'venue_manager'",
          ).run(now, userId);
        }
      }
      await this.assertDeletionStillUnlocked([actorAccountId]);
      const row = await this.assignmentByPair(userId, venueId);
      if (!row) return repositoryError("persistence_failure");
      return { assignment: toAssignment(row), outcome: "revoked" as const };
    }));
  }

  async inviteCounterStaff(input: {
    invitationToken: string;
    inviterAccountId: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    now: string;
    expiresAt: string;
  }): Promise<{ assignment: VenueAccessAssignmentRecord; outcome: "invited" | "existing" }> {
    const normalized = {
      invitationToken: requireInvitationToken(input.invitationToken),
      inviterAccountId: requireText(input.inviterAccountId),
      userId: requireText(input.userId),
      venueId: requireText(input.venueId),
      venueName: requireText(input.venueName, 240),
      suburb: optionalText(input.suburb, 160),
      now: requireCanonicalUtc(input.now),
      expiresAt: requireCanonicalUtc(input.expiresAt),
    };
    const ttl = Date.parse(normalized.expiresAt) - Date.parse(normalized.now);
    if (ttl <= 0 || ttl > MAX_INVITATION_TTL_MS || normalized.inviterAccountId === normalized.userId) {
      return repositoryError("invalid_input");
    }

    return this.translateFailure(this.database.transaction(async () => {
      await this.advisoryLocks([
        venueAccessAccountLockKey(normalized.inviterAccountId),
        venueAccessAccountLockKey(normalized.userId),
        `venue-access:assignment:${normalized.inviterAccountId}:${normalized.venueId}`,
        `venue-access:assignment:${normalized.userId}:${normalized.venueId}`,
        `venue-access:invitation:${normalized.invitationToken}`,
      ]);
      const accounts = await this.lockAccounts([normalized.inviterAccountId, normalized.userId]);
      const inviter = this.requireEligibleAccount(accounts, normalized.inviterAccountId);
      this.requireEligibleAccount(accounts, normalized.userId);
      const assignments = await this.lockAssignments([
        { userId: normalized.inviterAccountId, venueId: normalized.venueId },
        { userId: normalized.userId, venueId: normalized.venueId },
      ]);
      const inviterIsAdmin = persistedText(inviter.role, 64) === "admin"
        || persistedText(inviter.subscriptionStatus, 64) === "admin";
      const inviterAssignmentRow = assignments.get(`${normalized.inviterAccountId}\0${normalized.venueId}`);
      const inviterAssignment = inviterAssignmentRow ? toAssignment(inviterAssignmentRow) : null;
      if (
        !inviterIsAdmin
        && !(inviterAssignment?.accessLevel === "manager" && inviterAssignment.status === "active")
      ) return repositoryError("forbidden");

      const key = `${normalized.userId}\0${normalized.venueId}`;
      const existingRow = assignments.get(key) ?? null;
      if (existingRow) {
        const existing = toAssignment(existingRow);
        if (existing.status === "active") {
          return repositoryError("assignment_conflict");
        }
        if (existing.status === "pending" && existing.expiresAt && existing.expiresAt > normalized.now) {
          if (existing.id !== normalized.invitationToken) return repositoryError("assignment_conflict");
          if (
            existing.venueName !== normalized.venueName
            || existing.suburb !== normalized.suburb
            || existing.approvedBy !== normalized.inviterAccountId
            || existing.expiresAt !== normalized.expiresAt
          ) return repositoryError("invitation_token_conflict");
          await this.assertDeletionStillUnlocked([normalized.inviterAccountId, normalized.userId]);
          return { assignment: existing, outcome: "existing" as const };
        }
        if (existing.id === normalized.invitationToken) return repositoryError("invitation_stale");
        const updated = await this.database.prepare(
          `UPDATE venue_manager_assignments
              SET id = @invitationToken, venue_name = @venueName, suburb = @suburb,
                  access_level = 'counter_staff', status = 'pending',
                  approved_by = @inviterAccountId, expires_at = @expiresAt,
                  created_at = @now, updated_at = @now
            WHERE user_id = @userId AND venue_id = @venueId AND id = @expectedId
              AND (status = 'revoked' OR (status = 'pending' AND expires_at <= @now))`,
        ).run({ ...normalized, expectedId: existing.id });
        if (updated.changes !== 1) return repositoryError("assignment_conflict");
      } else {
        const inserted = await this.database.prepare(
          `INSERT INTO venue_manager_assignments (
             id, user_id, venue_id, venue_name, suburb, access_level, status,
             approved_by, expires_at, created_at, updated_at
           ) VALUES (
             @invitationToken, @userId, @venueId, @venueName, @suburb,
             'counter_staff', 'pending', @inviterAccountId, @expiresAt, @now, @now
           ) ON CONFLICT(user_id, venue_id) DO NOTHING`,
        ).run(normalized);
        if (inserted.changes !== 1) return repositoryError("assignment_conflict");
      }
      await this.assertDeletionStillUnlocked([normalized.inviterAccountId, normalized.userId]);
      const row = await this.assignmentByPair(normalized.userId, normalized.venueId);
      if (!row) return repositoryError("persistence_failure");
      const assignment = toAssignment(row);
      if (
        assignment.id !== normalized.invitationToken
        || assignment.accessLevel !== "counter_staff"
        || assignment.status !== "pending"
        || assignment.expiresAt !== normalized.expiresAt
      ) return repositoryError("assignment_conflict");
      return { assignment, outcome: "invited" as const };
    }), "invitation_token_conflict");
  }

  async respondToCounterStaffInvitation(input: {
    invitationToken: string;
    userId: string;
    decision: "accept" | "decline";
    now: string;
  }): Promise<{
    assignment: VenueAccessAssignmentRecord;
    outcome: "accepted" | "declined" | "duplicate";
  }> {
    const invitationToken = requireInvitationToken(input.invitationToken);
    const userId = requireText(input.userId);
    if (input.decision !== "accept" && input.decision !== "decline") return repositoryError("invalid_input");
    const decision = input.decision;
    const now = requireCanonicalUtc(input.now);

    return this.translateFailure(this.database.transaction(async () => {
      const snapshotRow = await this.assignmentByToken(invitationToken);
      if (!snapshotRow) return repositoryError("invitation_not_found");
      const snapshot = toAssignment(snapshotRow);
      if (snapshot.userId !== userId || snapshot.accessLevel !== "counter_staff") {
        return repositoryError("invitation_not_found");
      }
      await this.advisoryLocks([
        venueAccessAccountLockKey(userId),
        `venue-access:assignment:${userId}:${snapshot.venueId}`,
        `venue-access:invitation:${invitationToken}`,
      ]);
      const accounts = await this.lockAccounts([userId]);
      this.requireEligibleAccount(accounts, userId);
      const row = await this.assignmentByPair(userId, snapshot.venueId, true);
      if (!row) return repositoryError("invitation_not_found");
      const assignment = toAssignment(row);
      if (assignment.id !== invitationToken || assignment.accessLevel !== "counter_staff") {
        return repositoryError("invitation_stale");
      }
      if (assignment.status !== "pending") {
        // `revoked` can mean an explicit decline, expiry sweep, or manager/admin
        // revocation. The current schema has no terminal-reason column, so a
        // revoked row cannot be safely reported as an idempotent user decline.
        // Accepted rows are unambiguous and can support an exact accept retry.
        if (assignment.status !== "active" || decision !== "accept") {
          return repositoryError("invitation_stale");
        }
        await this.assertDeletionStillUnlocked([userId]);
        return { assignment, outcome: "duplicate" as const };
      }
      if (!assignment.expiresAt || assignment.expiresAt <= now) return repositoryError("invitation_expired");
      const status: VenueAccessStatus = decision === "accept" ? "active" : "revoked";
      const updated = await this.database.prepare(
        `UPDATE venue_manager_assignments
            SET status = @status, expires_at = NULL, updated_at = @now
          WHERE id = @invitationToken AND user_id = @userId
            AND access_level = 'counter_staff' AND status = 'pending' AND expires_at > @now`,
      ).run({ invitationToken, userId, status, now });
      if (updated.changes !== 1) return repositoryError("invitation_stale");
      await this.assertDeletionStillUnlocked([userId]);
      const finalRow = await this.assignmentByPair(userId, assignment.venueId);
      if (!finalRow) return repositoryError("persistence_failure");
      return {
        assignment: toAssignment(finalRow),
        outcome: decision === "accept" ? "accepted" as const : "declined" as const,
      };
    }));
  }

  async expireCounterStaffInvitations(input: {
    asOf: string;
    limit: number;
  }): Promise<{ expiredCount: number; invitationTokens: string[] }> {
    const asOf = requireCanonicalUtc(input.asOf);
    const limit = requireLimit(input.limit, MAX_EXPIRY_BATCH);
    return this.translateFailure(this.database.transaction(async () => {
      const lock = this.database.dialect === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";
      const rows = await this.database.prepare(
        `SELECT ${ASSIGNMENT_PROJECTION} FROM venue_manager_assignments assignment
          WHERE assignment.access_level = 'counter_staff' AND assignment.status = 'pending'
            AND assignment.expires_at <= ?
          ORDER BY assignment.expires_at ASC, assignment.id ASC LIMIT ?${lock}`,
      ).all<VenueAssignmentRow>(asOf, limit);
      const invitations = rows.map(toAssignment);
      const invitationTokens: string[] = [];
      for (const invitation of invitations) {
        const updated = await this.database.prepare(
          `UPDATE venue_manager_assignments
              SET status = 'revoked', expires_at = NULL, updated_at = @asOf
            WHERE id = @id AND access_level = 'counter_staff' AND status = 'pending'
              AND expires_at <= @asOf`,
        ).run({ id: invitation.id, asOf });
        if (updated.changes === 1) invitationTokens.push(invitation.id);
      }
      return { expiredCount: invitationTokens.length, invitationTokens };
    }));
  }
}
