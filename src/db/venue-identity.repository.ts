import type { VenueLocationCache } from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const MAX_ID_LENGTH = 200;
const MAX_IDENTITY_KEY_LENGTH = 500;
const MAX_SOURCE_LENGTH = 80;
const MAX_VENUE_NAME_LENGTH = 240;
const MAX_SUBURB_LENGTH = 160;
const MAX_IDENTITY_IDS = 257;
const MAX_CANONICAL_DEPTH = 32;

const ALIAS_PROJECTION = `
  alias.alias_venue_id AS "aliasVenueId",
  alias.canonical_venue_id AS "canonicalVenueId",
  alias.identity_key AS "identityKey",
  alias.source AS "source",
  alias.created_at AS "createdAt",
  alias.updated_at AS "updatedAt"`;

const LOCATION_PROJECTION = `
  location.venue_id AS "venueId",
  location.venue_name AS "venueName",
  location.suburb AS "suburb",
  location.latitude AS "latitude",
  location.longitude AS "longitude",
  location.updated_at AS "updatedAt"`;

export const VENUE_IDENTITY_LOCK_CONTRACT = Object.freeze({
  billingVenueSubjectPrefix: "billing-checkout:subject:venue:",
  locationPrefix: "venue-identity:location:",
  order: "sorted-old-new-billing-subject-keys-before-alias-rows",
} as const);

export function billingCheckoutVenueSubjectLockKey(venueId: string): string {
  return `${VENUE_IDENTITY_LOCK_CONTRACT.billingVenueSubjectPrefix}${inputText(
    venueId,
    "venueId",
    MAX_ID_LENGTH,
  )}`;
}

export type VenueIdentityRepositoryErrorCode =
  | "alias_version_conflict"
  | "identity_cycle"
  | "identity_limit_exceeded"
  | "invalid_input"
  | "location_version_conflict"
  | "malformed_record"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<VenueIdentityRepositoryErrorCode, string>> = {
  alias_version_conflict: "The venue identity alias changed before it could be saved.",
  identity_cycle: "The venue identity alias would create a cycle.",
  identity_limit_exceeded: "The venue identity group exceeds the supported size.",
  invalid_input: "The venue identity input is invalid.",
  location_version_conflict: "The venue location cache changed before it could be saved.",
  malformed_record: "The stored venue identity record is malformed.",
  persistence_failure: "Venue identity persistence could not be completed.",
};

export class VenueIdentityRepositoryError extends Error {
  readonly code: VenueIdentityRepositoryErrorCode;

  constructor(code: VenueIdentityRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueIdentityRepositoryError";
    this.code = code;
  }
}

export interface VenueIdentityAliasRecord {
  aliasVenueId: string;
  canonicalVenueId: string;
  identityKey: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertVenueIdentityAliasInput {
  aliasVenueId: string;
  canonicalVenueId: string;
  identityKey: string;
  source?: string | undefined;
  /** Null is insert-only; an existing row requires its exact current token. */
  expectedUpdatedAt: string | null;
  now: string;
}

export interface UpsertVenueLocationCacheInput {
  venueId: string;
  venueName: string;
  suburb: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Null is insert-only; an existing row requires its exact current token. */
  expectedUpdatedAt: string | null;
  now: string;
}

type RawRow = Record<string, unknown>;

interface AliasRow extends RawRow {
  aliasVenueId: unknown;
  canonicalVenueId: unknown;
  identityKey: unknown;
  source: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface LocationRow extends RawRow {
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  latitude: unknown;
  longitude: unknown;
  updatedAt: unknown;
}

function fail(code: VenueIdentityRepositoryErrorCode): never {
  throw new VenueIdentityRepositoryError(code);
}

function inputText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\0]/.test(normalized)
    || (field.endsWith("Id") && /[\r\n]/.test(normalized))
  ) return fail("invalid_input");
  return normalized;
}

function inputOptionalText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\0]/.test(normalized)) return fail("invalid_input");
  return normalized;
}

function recordText(value: unknown, maximum: number, identifier = false): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || /[\0]/.test(value)
    || (identifier && /[\r\n]/.test(value))
  ) return fail("malformed_record");
  return value;
}

function recordOptionalText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum || /[\0]/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function timestamp(value: unknown, source: "input" | "record"): string {
  const match = typeof value === "string" ? OFFSET_TIMESTAMP.exec(value) : null;
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === "Z" ? 0 : Number(match?.[10]);
  const offsetMinute = match?.[8] === "Z" ? 0 : Number(match?.[11]);
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    !match
    || year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
    || !Number.isFinite(parsed)
  ) return fail(source === "input" ? "invalid_input" : "malformed_record");
  return new Date(parsed).toISOString();
}

function inputCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail("invalid_input");
  }
  return Object.is(value, -0) ? 0 : value;
}

function recordCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" && typeof value !== "string"
    || typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
  ) return fail("malformed_record");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fail("malformed_record");
  return Object.is(parsed, -0) ? 0 : parsed;
}

function mutationTimestamp(now: string, priorTokens: readonly string[]): string {
  const latest = priorTokens.reduce((maximum, value) => Math.max(maximum, Date.parse(value)), -Infinity);
  if (Date.parse(now) > latest) return now;
  const next = new Date(latest + 1).toISOString();
  if (!Number.isFinite(Date.parse(next))) return fail("invalid_input");
  return next;
}

function aliasRecord(row: AliasRow): VenueIdentityAliasRecord {
  const aliasVenueId = recordText(row.aliasVenueId, MAX_ID_LENGTH, true);
  const canonicalVenueId = recordText(row.canonicalVenueId, MAX_ID_LENGTH, true);
  if (aliasVenueId === canonicalVenueId) return fail("identity_cycle");
  return {
    aliasVenueId,
    canonicalVenueId,
    identityKey: recordText(row.identityKey, MAX_IDENTITY_KEY_LENGTH),
    source: recordText(row.source, MAX_SOURCE_LENGTH),
    createdAt: timestamp(row.createdAt, "record"),
    updatedAt: timestamp(row.updatedAt, "record"),
  };
}

function locationRecord(row: LocationRow): VenueLocationCache {
  const latitude = recordCoordinate(row.latitude, -90, 90);
  const longitude = recordCoordinate(row.longitude, -180, 180);
  if ((latitude === null) !== (longitude === null)) return fail("malformed_record");
  return {
    venueId: recordText(row.venueId, MAX_ID_LENGTH, true),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: recordOptionalText(row.suburb, MAX_SUBURB_LENGTH),
    latitude,
    longitude,
    updatedAt: timestamp(row.updatedAt, "record"),
  };
}

function sameAlias(
  row: VenueIdentityAliasRecord,
  desired: { canonicalVenueId: string; identityKey: string; source: string },
): boolean {
  return row.canonicalVenueId === desired.canonicalVenueId
    && row.identityKey === desired.identityKey
    && row.source === desired.source;
}

function sameLocation(
  row: VenueLocationCache,
  desired: Omit<VenueLocationCache, "updatedAt">,
): boolean {
  return row.venueId === desired.venueId
    && row.venueName === desired.venueName
    && row.suburb === desired.suburb
    && row.latitude === desired.latitude
    && row.longitude === desired.longitude;
}

/**
 * Async canonical-venue identity and location-cache persistence.
 *
 * Alias mutation lock contract shared with BillingCheckoutRepository:
 *   1. resolve candidate old/new canonical venue IDs without holding locks;
 *   2. acquire both `billing-checkout:subject:venue:<id>` transaction advisory
 *      locks in sorted order (missing-alias insertion uses the alias ID as old);
 *   3. lock and re-resolve all affected alias rows;
 *   4. mutate only if the roots and optimistic token are still exact.
 *
 * No provider, network, billing, or public-eligibility decisions occur here.
 */
export class VenueIdentityRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translated<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueIdentityRepositoryError) throw error;
      return fail("persistence_failure");
    }
  }

  private binaryCollation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of Array.from(new Set(keys)).sort()) {
      await this.database.prepare(
        "SELECT pg_advisory_xact_lock(hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private async aliasById(aliasVenueId: string, lock = false): Promise<VenueIdentityAliasRecord | null> {
    const row = await this.database.prepare(
      `SELECT ${ALIAS_PROJECTION}
         FROM venue_identity_aliases alias
        WHERE alias.alias_venue_id = ?
        LIMIT 1${lock ? this.lockSuffix("alias") : ""}`,
    ).get<AliasRow>(aliasVenueId);
    return row ? aliasRecord(row) : null;
  }

  private async resolveCanonicalVenueId(venueId: string, lock = false): Promise<string> {
    const visited = new Set<string>();
    let current = venueId;
    for (let depth = 0; depth < MAX_CANONICAL_DEPTH; depth += 1) {
      if (visited.has(current)) return fail("identity_cycle");
      visited.add(current);
      const row = await this.aliasById(current, lock);
      if (!row) return current;
      current = row.canonicalVenueId;
    }
    return fail("identity_limit_exceeded");
  }

  private async descendantIds(rootVenueId: string): Promise<string[]> {
    const rows = await this.database.prepare(
      `WITH RECURSIVE identity_tree("venueId") AS (
         SELECT CAST(? AS TEXT)
         UNION
         SELECT alias.alias_venue_id
           FROM venue_identity_aliases alias
           JOIN identity_tree parent
             ON alias.canonical_venue_id = parent."venueId"
       )
       SELECT identity_tree."venueId" AS "venueId"
         FROM identity_tree
        ORDER BY identity_tree."venueId" ${this.binaryCollation()}
        LIMIT ?`,
    ).all<{ venueId: unknown }>(rootVenueId, MAX_IDENTITY_IDS + 1);
    if (rows.length > MAX_IDENTITY_IDS) return fail("identity_limit_exceeded");
    return rows.map((row) => recordText(row.venueId, MAX_ID_LENGTH, true));
  }

  private async lockAliasRows(venueIds: readonly string[]): Promise<VenueIdentityAliasRecord[]> {
    if (venueIds.length === 0) return [];
    const placeholders = venueIds.map(() => "?").join(", ");
    const rows = await this.database.prepare(
      `SELECT ${ALIAS_PROJECTION}
         FROM venue_identity_aliases alias
        WHERE alias.alias_venue_id IN (${placeholders})
        ORDER BY alias.alias_venue_id ${this.binaryCollation()}${this.lockSuffix("alias")}`,
    ).all<AliasRow>(...venueIds);
    return rows.map(aliasRecord);
  }

  async getCanonicalVenueId(venueId: string): Promise<string> {
    const normalized = inputText(venueId, "venueId", MAX_ID_LENGTH);
    return this.translated(() => this.resolveCanonicalVenueId(normalized));
  }

  async listVenueIdentityIds(venueId: string): Promise<string[]> {
    const normalized = inputText(venueId, "venueId", MAX_ID_LENGTH);
    return this.translated(async () => {
      const canonicalVenueId = await this.resolveCanonicalVenueId(normalized);
      return this.descendantIds(canonicalVenueId);
    });
  }

  async upsertVenueIdentityAlias(input: UpsertVenueIdentityAliasInput): Promise<VenueIdentityAliasRecord> {
    const aliasVenueId = inputText(input.aliasVenueId, "aliasVenueId", MAX_ID_LENGTH);
    const requestedCanonicalVenueId = inputText(input.canonicalVenueId, "canonicalVenueId", MAX_ID_LENGTH);
    if (aliasVenueId === requestedCanonicalVenueId) return fail("identity_cycle");
    const identityKey = inputText(input.identityKey, "identityKey", MAX_IDENTITY_KEY_LENGTH);
    const source = inputText(input.source ?? "automatic_exact_match", "source", MAX_SOURCE_LENGTH);
    const expectedUpdatedAt = input.expectedUpdatedAt === null
      ? null
      : timestamp(input.expectedUpdatedAt, "input");
    const now = timestamp(input.now, "input");

    return this.translated(this.database.transaction(async () => {
      const initialOldCanonicalVenueId = await this.resolveCanonicalVenueId(aliasVenueId);
      const initialNewCanonicalVenueId = await this.resolveCanonicalVenueId(requestedCanonicalVenueId);
      if (initialNewCanonicalVenueId === aliasVenueId) return fail("identity_cycle");
      await this.advisoryLocks([
        billingCheckoutVenueSubjectLockKey(initialOldCanonicalVenueId),
        billingCheckoutVenueSubjectLockKey(initialNewCanonicalVenueId),
      ]);

      const currentOldCanonicalVenueId = await this.resolveCanonicalVenueId(aliasVenueId, true);
      const currentNewCanonicalVenueId = await this.resolveCanonicalVenueId(requestedCanonicalVenueId, true);
      if (
        currentOldCanonicalVenueId !== initialOldCanonicalVenueId
        || currentNewCanonicalVenueId !== initialNewCanonicalVenueId
      ) return fail("alias_version_conflict");
      if (currentNewCanonicalVenueId === aliasVenueId) return fail("identity_cycle");

      const movingIds = await this.descendantIds(aliasVenueId);
      if (movingIds.includes(currentNewCanonicalVenueId)) return fail("identity_cycle");
      const targetIds = await this.descendantIds(currentNewCanonicalVenueId);
      if (new Set([...movingIds, ...targetIds]).size > MAX_IDENTITY_IDS) {
        return fail("identity_limit_exceeded");
      }
      const lockedMovingRows = await this.lockAliasRows(movingIds);
      const existing = lockedMovingRows.find((row) => row.aliasVenueId === aliasVenueId) ?? null;
      const desired = { canonicalVenueId: currentNewCanonicalVenueId, identityKey, source };
      const descendants = lockedMovingRows.filter((row) => row.aliasVenueId !== aliasVenueId);
      if (existing && sameAlias(existing, desired) && descendants.length === 0) return existing;
      if (
        existing === null && expectedUpdatedAt !== null
        || existing !== null && existing.updatedAt !== expectedUpdatedAt
      ) return fail("alias_version_conflict");

      const updatedAt = mutationTimestamp(now, lockedMovingRows.map((row) => row.updatedAt));
      if (descendants.length > 0) {
        const descendantIds = descendants.map((row) => row.aliasVenueId);
        const placeholders = descendantIds.map(() => "?").join(", ");
        const moved = await this.database.prepare(
          `UPDATE venue_identity_aliases
              SET canonical_venue_id = ?, updated_at = ?
            WHERE alias_venue_id IN (${placeholders})`,
        ).run(currentNewCanonicalVenueId, updatedAt, ...descendantIds);
        if (moved.changes !== descendantIds.length) return fail("alias_version_conflict");
      }

      if (existing) {
        const updated = await this.database.prepare(
          `UPDATE venue_identity_aliases
              SET canonical_venue_id = ?, identity_key = ?, source = ?, updated_at = ?
            WHERE alias_venue_id = ? AND updated_at = ?`,
        ).run(
          currentNewCanonicalVenueId,
          identityKey,
          source,
          updatedAt,
          aliasVenueId,
          existing.updatedAt,
        );
        if (updated.changes !== 1) return fail("alias_version_conflict");
      } else {
        const inserted = await this.database.prepare(
          `INSERT INTO venue_identity_aliases (
             alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(alias_venue_id) DO NOTHING`,
        ).run(aliasVenueId, currentNewCanonicalVenueId, identityKey, source, now, updatedAt);
        if (inserted.changes !== 1) {
          const raced = await this.aliasById(aliasVenueId, true);
          if (raced && sameAlias(raced, desired)) return raced;
          return fail("alias_version_conflict");
        }
      }

      const saved = await this.aliasById(aliasVenueId);
      if (!saved || !sameAlias(saved, desired) || saved.updatedAt !== updatedAt) {
        return fail("persistence_failure");
      }
      return saved;
    }));
  }

  private async locationById(venueId: string, lock = false): Promise<VenueLocationCache | null> {
    const row = await this.database.prepare(
      `SELECT ${LOCATION_PROJECTION}
         FROM venue_location_cache location
        WHERE location.venue_id = ?
        LIMIT 1${lock ? this.lockSuffix("location") : ""}`,
    ).get<LocationRow>(venueId);
    return row ? locationRecord(row) : null;
  }

  async getVenueLocationCache(venueId: string): Promise<VenueLocationCache | null> {
    const normalized = inputText(venueId, "venueId", MAX_ID_LENGTH);
    return this.translated(() => this.locationById(normalized));
  }

  async upsertVenueLocationCache(input: UpsertVenueLocationCacheInput): Promise<VenueLocationCache> {
    const venueId = inputText(input.venueId, "venueId", MAX_ID_LENGTH);
    const venueName = inputText(input.venueName, "venueName", MAX_VENUE_NAME_LENGTH);
    const suburb = inputOptionalText(input.suburb, MAX_SUBURB_LENGTH);
    const latitude = inputCoordinate(input.latitude, -90, 90);
    const longitude = inputCoordinate(input.longitude, -180, 180);
    if ((latitude === null) !== (longitude === null)) return fail("invalid_input");
    const expectedUpdatedAt = input.expectedUpdatedAt === null
      ? null
      : timestamp(input.expectedUpdatedAt, "input");
    const now = timestamp(input.now, "input");
    const desired = { venueId, venueName, suburb, latitude, longitude };

    return this.translated(this.database.transaction(async () => {
      await this.advisoryLocks([`${VENUE_IDENTITY_LOCK_CONTRACT.locationPrefix}${venueId}`]);
      const existing = await this.locationById(venueId, true);
      if (existing && sameLocation(existing, desired)) return existing;
      if (
        existing === null && expectedUpdatedAt !== null
        || existing !== null && existing.updatedAt !== expectedUpdatedAt
      ) return fail("location_version_conflict");
      const updatedAt = mutationTimestamp(now, existing ? [existing.updatedAt] : []);

      if (existing) {
        const updated = await this.database.prepare(
          `UPDATE venue_location_cache
              SET venue_name = ?, suburb = ?, latitude = ?, longitude = ?, updated_at = ?
            WHERE venue_id = ? AND updated_at = ?`,
        ).run(venueName, suburb, latitude, longitude, updatedAt, venueId, existing.updatedAt);
        if (updated.changes !== 1) return fail("location_version_conflict");
      } else {
        const inserted = await this.database.prepare(
          `INSERT INTO venue_location_cache (
             venue_id, venue_name, suburb, latitude, longitude, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(venue_id) DO NOTHING`,
        ).run(venueId, venueName, suburb, latitude, longitude, updatedAt);
        if (inserted.changes !== 1) {
          const raced = await this.locationById(venueId, true);
          if (raced && sameLocation(raced, desired)) return raced;
          return fail("location_version_conflict");
        }
      }

      const saved = await this.locationById(venueId);
      if (!saved || !sameLocation(saved, desired) || saved.updatedAt !== updatedAt) {
        return fail("persistence_failure");
      }
      return saved;
    }));
  }
}
