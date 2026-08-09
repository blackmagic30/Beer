import {
  OptimisticConcurrencyError,
  type BarBeer,
  type BarHappyHour,
  type BarHappyHourBeer,
  type BarPendingChange,
  type BarPendingChangeAction,
  type BarPendingChangeStatus,
  type BarPendingChangeType,
  type BarProfile,
  type BarSpecial,
  type ServingSize,
} from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";
import { VenueInventoryRepository } from "./venue-inventory.repository.js";

const MAX_ID_LENGTH = 200;
const MAX_LIST_LIMIT = 200;
const MAX_OFFSET = Number.MAX_SAFE_INTEGER;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 2_000;
const MAX_PROFILE_NAME_LENGTH = 180;
const MAX_BEER_NAME_LENGTH = 160;
const MAX_TITLE_LENGTH = 140;
const MAX_HAPPY_HOUR_DESCRIPTION_LENGTH = 800;
const MAX_SPECIAL_DESCRIPTION_LENGTH = 1_000;
const MAX_REJECTION_REASON_LENGTH = 1_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ITEMS = 1_000;
const MAX_JSON_KEY_LENGTH = 200;
const MAX_VENUE_TAGS = 20;
const MAX_VENUE_TAG_LENGTH = 80;
const MAX_HAPPY_HOUR_BEERS = 60;

const DAYS_OF_WEEK = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const SERVING_SIZES = new Set<ServingSize>([
  "pint",
  "pot",
  "schooner",
  "jug",
  "bottle",
  "can",
  "other",
]);
const CHANGE_TYPES = new Set<BarPendingChangeType>(["profile", "beer", "happy_hour", "special"]);
const ACTIONS = new Set<BarPendingChangeAction>(["upsert", "delete"]);
const STATUSES = new Set<BarPendingChangeStatus>(["pending", "approved", "rejected"]);

const PENDING_COLUMNS = [
  ["id", "id"],
  ["venue_id", "barId"],
  ["change_type", "changeType"],
  ["action", "action"],
  ["target_id", "targetId"],
  ["payload_json", "payloadJson"],
  ["status", "status"],
  ["submitted_by", "submittedBy"],
  ["submitted_at", "submittedAt"],
  ["reviewed_by", "reviewedBy"],
  ["reviewed_at", "reviewedAt"],
  ["rejection_reason", "rejectionReason"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
] as const;

const PROFILE_PAYLOAD_KEYS = new Set([
  "name",
  "address",
  "suburb",
  "area",
  "phone",
  "website",
  "instagram",
  "description",
  "openingHours",
  "venueTags",
  "active",
  "expectedUpdatedAt",
]);
const BEER_PAYLOAD_KEYS = new Set([
  "id",
  "beerName",
  "normalizedBeerId",
  "brewery",
  "style",
  "abv",
  "serveSize",
  "price",
  "onTap",
  "inStock",
  "notes",
  "priceConfirmed",
  "stockConfirmed",
  "expectedUpdatedAt",
]);
const RESOLVED_BEER_PAYLOAD_KEYS = new Set(
  [...BEER_PAYLOAD_KEYS].filter((key) => key !== "id" && key !== "expectedUpdatedAt"),
);
const HAPPY_HOUR_PAYLOAD_KEYS = new Set([
  "id",
  "title",
  "daysOfWeek",
  "startTime",
  "endTime",
  "description",
  "happyHourBeers",
  "active",
  "expectedUpdatedAt",
]);
const SPECIAL_PAYLOAD_KEYS = new Set([
  "id",
  "title",
  "description",
  "price",
  "discount",
  "savingsAmountCents",
  "startsAt",
  "endsAt",
  "startTime",
  "endTime",
  "recurrence",
  "scheduleNote",
  "exclusive",
  "active",
  "expectedUpdatedAt",
]);
const DELETE_PAYLOAD_KEYS: Readonly<Record<Exclude<BarPendingChangeType, "profile">, ReadonlySet<string>>> = {
  beer: new Set(["id", "beerName", "serveSize", "price", "expectedUpdatedAt"]),
  happy_hour: new Set([
    "id",
    "title",
    "daysOfWeek",
    "startTime",
    "endTime",
    "happyHourBeers",
    "expectedUpdatedAt",
  ]),
  special: new Set(["id", "title", "price", "discount", "expectedUpdatedAt"]),
};

export type VenuePendingChangeRepositoryErrorCode =
  | "invalid_input"
  | "malformed_payload"
  | "malformed_record"
  | "pending_change_not_found"
  | "pending_change_not_reviewable"
  | "pending_change_version_conflict"
  | "target_not_found"
  | "target_version_conflict"
  | "target_venue_conflict"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<VenuePendingChangeRepositoryErrorCode, string>> = {
  invalid_input: "The venue pending-change input is invalid.",
  malformed_payload: "The stored venue pending-change payload is malformed.",
  malformed_record: "The stored venue pending-change record is malformed.",
  pending_change_not_found: "The venue pending change does not exist.",
  pending_change_not_reviewable: "The venue pending change is no longer reviewable.",
  pending_change_version_conflict: "The venue pending change was modified before review.",
  target_not_found: "The venue inventory target does not exist.",
  target_version_conflict: "The venue inventory target changed after submission.",
  target_venue_conflict: "The venue inventory target belongs to another venue.",
  persistence_failure: "Venue pending-change persistence could not be completed.",
};

/** Stable, deliberately detail-free failures for future service/HTTP mapping. */
export class VenuePendingChangeRepositoryError extends Error {
  readonly code: VenuePendingChangeRepositoryErrorCode;

  constructor(code: VenuePendingChangeRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenuePendingChangeRepositoryError";
    this.code = code;
  }
}

export interface VenueProfilePendingPayload {
  name: string;
  address: string | null;
  suburb: string | null;
  area: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  description: string | null;
  openingHours: Record<string, unknown>;
  venueTags: string[];
  active: boolean;
  expectedUpdatedAt: string | null;
}

export interface VenueBeerPendingPayload {
  id: string;
  beerName: string;
  normalizedBeerId: string | null;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  serveSize: ServingSize | null;
  price: number | null;
  onTap: boolean;
  inStock: boolean;
  notes: string | null;
  priceConfirmed: boolean;
  stockConfirmed: boolean;
  expectedUpdatedAt: string | null;
}

/** Provider/catalog normalization performed before the short review transaction. */
export type ResolvedVenueBeerPendingPayload = Omit<
  VenueBeerPendingPayload,
  "id" | "expectedUpdatedAt"
>;

export interface VenueHappyHourPendingPayload {
  id: string;
  title: string;
  daysOfWeek: string[];
  startTime: string;
  endTime: string;
  description: string;
  happyHourBeers: BarHappyHourBeer[];
  active: boolean;
  expectedUpdatedAt: string | null;
}

export interface VenueSpecialPendingPayload {
  id: string;
  title: string;
  description: string;
  price: number | null;
  discount: string | null;
  savingsAmountCents: number | null;
  startsAt: string | null;
  endsAt: string | null;
  startTime: string | null;
  endTime: string | null;
  recurrence: {
    frequency: "none" | "weekly";
    daysOfWeek: string[];
    timezone: string;
  };
  scheduleNote: string | null;
  exclusive: boolean;
  active: boolean;
  expectedUpdatedAt: string | null;
}

export interface VenueDeletePendingPayload {
  expectedUpdatedAt: string;
}

export type VenuePendingChangePayload =
  | VenueProfilePendingPayload
  | VenueBeerPendingPayload
  | VenueHappyHourPendingPayload
  | VenueSpecialPendingPayload
  | VenueDeletePendingPayload;

export interface CreateBarPendingChangeInput {
  id: string;
  barId: string;
  changeType: BarPendingChangeType;
  action: BarPendingChangeAction;
  targetId: string | null;
  payload: Record<string, unknown>;
  submittedBy: string;
  now: string;
}

export interface ListBarPendingChangesInput {
  barId?: string | undefined;
  submittedBy?: string | undefined;
  status?: BarPendingChangeStatus | undefined;
  limit: number;
  offset?: number | undefined;
}

export interface CountBarPendingChangesInput {
  barId?: string | undefined;
  submittedBy?: string | undefined;
  status?: BarPendingChangeStatus | undefined;
}

export interface ReviewBarPendingChangeInput {
  id: string;
  status: Exclude<BarPendingChangeStatus, "pending">;
  reviewedBy: string;
  /** Exact `updatedAt` observed by the reviewer before beginning review. */
  expectedUpdatedAt: string;
  reviewedAt: string;
  rejectionReason: string | null;
  /**
   * Optional provider/catalog result computed before calling this repository.
   * Target identity and OCC version remain pinned to the persisted payload.
   */
  resolvedBeerPayload?: ResolvedVenueBeerPendingPayload | undefined;
}

export type AppliedVenuePendingChange =
  | { changeType: "profile"; action: "upsert"; targetId: string; value: BarProfile }
  | { changeType: "beer"; action: "upsert"; targetId: string; value: BarBeer }
  | { changeType: "beer"; action: "delete"; targetId: string; deleted: true }
  | { changeType: "happy_hour"; action: "upsert"; targetId: string; value: BarHappyHour }
  | { changeType: "happy_hour"; action: "delete"; targetId: string; deleted: true }
  | { changeType: "special"; action: "upsert"; targetId: string; value: BarSpecial }
  | { changeType: "special"; action: "delete"; targetId: string; deleted: true };

export interface ReviewBarPendingChangeResult {
  pendingChange: BarPendingChange;
  appliedChange: AppliedVenuePendingChange | null;
}

type ValidationSource = "input" | "payload" | "record";
type RawRow = Record<string, unknown>;

interface PendingRow extends RawRow {
  id: unknown;
  barId: unknown;
  changeType: unknown;
  action: unknown;
  targetId: unknown;
  payloadJson: unknown;
  status: unknown;
  submittedBy: unknown;
  submittedAt: unknown;
  reviewedBy: unknown;
  reviewedAt: unknown;
  rejectionReason: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

type NormalizedDescriptor =
  | {
      changeType: "profile";
      action: "upsert";
      targetId: null;
      payload: VenueProfilePendingPayload;
    }
  | {
      changeType: "beer";
      action: "upsert";
      targetId: string;
      payload: VenueBeerPendingPayload;
    }
  | {
      changeType: "happy_hour";
      action: "upsert";
      targetId: string;
      payload: VenueHappyHourPendingPayload;
    }
  | {
      changeType: "special";
      action: "upsert";
      targetId: string;
      payload: VenueSpecialPendingPayload;
    }
  | {
      changeType: Exclude<BarPendingChangeType, "profile">;
      action: "delete";
      targetId: string;
      payload: VenueDeletePendingPayload;
    };

interface PersistedPendingChange {
  change: BarPendingChange;
  descriptor: NormalizedDescriptor;
}

function fail(code: VenuePendingChangeRepositoryErrorCode): never {
  throw new VenuePendingChangeRepositoryError(code);
}

function validationFailure(source: ValidationSource): never {
  if (source === "payload") return fail("malformed_payload");
  if (source === "record") return fail("malformed_record");
  return fail("invalid_input");
}

function projection(
  columns: readonly (readonly [column: string, result: string])[],
  qualifier = "",
): string {
  return columns.map(([column, result]) => `${qualifier}${column} AS "${result}"`).join(",\n       ");
}

function requiredText(
  value: unknown,
  source: ValidationSource,
  maximum = MAX_TEXT_LENGTH,
  identifier = false,
): string {
  if (typeof value !== "string") return validationFailure(source);
  const cleaned = source === "record" ? value : value.trim();
  if (
    !cleaned
    || cleaned.length > maximum
    || /\0/.test(cleaned)
    || identifier && /[\r\n]/.test(cleaned)
  ) return validationFailure(source);
  return cleaned;
}

function optionalText(
  value: unknown,
  source: ValidationSource,
  maximum = MAX_TEXT_LENGTH,
  identifier = false,
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return validationFailure(source);
  const cleaned = source === "record" ? value : value.trim();
  if (!cleaned && source !== "record") return null;
  if (
    cleaned.length > maximum
    || /\0/.test(cleaned)
    || identifier && /[\r\n]/.test(cleaned)
  ) return validationFailure(source);
  return cleaned;
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("malformed_record");
  if (!/^\d+$/.test(String(value))) return fail("malformed_record");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return fail("malformed_record");
  return count;
}

function requiredBoolean(value: unknown, source: ValidationSource): boolean {
  if (typeof value !== "boolean") return validationFailure(source);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, source: ValidationSource): boolean {
  return value === undefined ? fallback : requiredBoolean(value, source);
}

function finiteNumber(
  value: unknown,
  source: ValidationSource,
  options: { minimum: number; maximum: number; integer?: boolean; nullable?: boolean },
): number | null {
  if (value == null && options.nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return validationFailure(source);
  if (
    value < options.minimum
    || value > options.maximum
    || options.integer && !Number.isInteger(value)
  ) return validationFailure(source);
  return value;
}

function price(value: unknown, source: ValidationSource): number | null {
  const result = finiteNumber(value, source, { minimum: Number.EPSILON, maximum: 250, nullable: true });
  if (result !== null && Math.abs(result * 100 - Math.round(result * 100)) >= 1e-8) {
    return validationFailure(source);
  }
  return result;
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

function timestamp(value: unknown, source: ValidationSource): string {
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
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || offsetHour === 14 && offsetMinute !== 0
    || !Number.isFinite(parsed)
  ) return validationFailure(source);
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value: unknown, source: ValidationSource): string | null {
  return value == null ? null : timestamp(value, source);
}

function localTime(value: unknown, source: ValidationSource, nullable = false): string | null {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return validationFailure(source);
  }
  return value;
}

function assertJsonValue(
  value: unknown,
  source: ValidationSource,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) validationFailure(source);
    return;
  }
  if (typeof value !== "object" || depth > MAX_JSON_DEPTH || seen.has(value)) validationFailure(source);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ITEMS) validationFailure(source);
    for (const item of value) assertJsonValue(item, source, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) validationFailure(source);
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_ITEMS) validationFailure(source);
    for (const [key, item] of entries) {
      if (!key || key.length > MAX_JSON_KEY_LENGTH || /\0/.test(key)) validationFailure(source);
      assertJsonValue(item, source, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function plainObject(value: unknown, source: ValidationSource): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return validationFailure(source);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return validationFailure(source);
  assertJsonValue(value, source);
  return value as Record<string, unknown>;
}

function clonedJsonObject(value: unknown, source: ValidationSource): Record<string, unknown> {
  const object = plainObject(value, source);
  const serialized = JSON.stringify(object);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) return validationFailure(source);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function payloadObject(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return fail("malformed_payload");
    }
  }
  return clonedJsonObject(parsed, "payload");
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  source: ValidationSource,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) validationFailure(source);
}

function stringArray(
  value: unknown,
  source: ValidationSource,
  options: { maximumItems: number; maximumLength: number; allowed?: ReadonlySet<string> },
): string[] {
  if (!Array.isArray(value) || value.length > options.maximumItems) return validationFailure(source);
  const result = value.map((item) => requiredText(item, source, options.maximumLength));
  if (options.allowed && result.some((item) => !options.allowed!.has(item))) validationFailure(source);
  if (new Set(result).size !== result.length) validationFailure(source);
  return result;
}

function servingSize(value: unknown, source: ValidationSource): ServingSize | null {
  if (value == null) return null;
  if (typeof value !== "string" || !SERVING_SIZES.has(value as ServingSize)) return validationFailure(source);
  return value as ServingSize;
}

function happyHourBeers(value: unknown, source: ValidationSource): BarHappyHourBeer[] {
  if (!Array.isArray(value) || value.length > MAX_HAPPY_HOUR_BEERS) return validationFailure(source);
  return value.map((item) => {
    const raw = plainObject(item, source);
    assertAllowedKeys(raw, new Set([
      "beerId",
      "beerName",
      "normalizedBeerId",
      "servingSize",
      "happyHourPrice",
      "offerText",
      "onTap",
      "inStock",
    ]), source);
    return {
      beerId: optionalText(raw.beerId, source, MAX_ID_LENGTH, true),
      beerName: requiredText(raw.beerName, source, MAX_BEER_NAME_LENGTH),
      normalizedBeerId: optionalText(raw.normalizedBeerId, source, MAX_ID_LENGTH, true),
      servingSize: servingSize(raw.servingSize, source),
      happyHourPrice: price(raw.happyHourPrice, source),
      offerText: optionalText(raw.offerText, source, 160),
      onTap: optionalBoolean(raw.onTap, false, source),
      inStock: optionalBoolean(raw.inStock, true, source),
    };
  });
}

function normalizeProfilePayload(
  raw: Record<string, unknown>,
  source: ValidationSource,
): VenueProfilePendingPayload {
  assertAllowedKeys(raw, PROFILE_PAYLOAD_KEYS, source);
  const openingHours = raw.openingHours === undefined ? {} : clonedJsonObject(raw.openingHours, source);
  const venueTags = raw.venueTags === undefined
    ? []
    : stringArray(raw.venueTags, source, {
        maximumItems: MAX_VENUE_TAGS,
        maximumLength: MAX_VENUE_TAG_LENGTH,
      });
  return {
    name: requiredText(raw.name, source, MAX_PROFILE_NAME_LENGTH),
    address: optionalText(raw.address, source),
    suburb: optionalText(raw.suburb, source),
    area: optionalText(raw.area, source),
    phone: optionalText(raw.phone, source),
    website: optionalText(raw.website, source),
    instagram: optionalText(raw.instagram, source),
    description: optionalText(raw.description, source),
    openingHours,
    venueTags,
    active: optionalBoolean(raw.active, true, source),
    expectedUpdatedAt: optionalTimestamp(raw.expectedUpdatedAt, source),
  };
}

function normalizeTargetId(
  targetId: unknown,
  payloadId: unknown,
  source: ValidationSource,
): string {
  const normalizedTarget = optionalText(targetId, source, MAX_ID_LENGTH, true);
  const normalizedPayload = optionalText(payloadId, source, MAX_ID_LENGTH, true);
  if (normalizedTarget && normalizedPayload && normalizedTarget !== normalizedPayload) validationFailure(source);
  return normalizedTarget ?? normalizedPayload ?? validationFailure(source);
}

function normalizeBeerPayload(
  targetId: unknown,
  raw: Record<string, unknown>,
  source: ValidationSource,
): { targetId: string; payload: VenueBeerPendingPayload } {
  assertAllowedKeys(raw, BEER_PAYLOAD_KEYS, source);
  const id = normalizeTargetId(targetId, raw.id, source);
  return {
    targetId: id,
    payload: {
      id,
      beerName: requiredText(raw.beerName, source, MAX_BEER_NAME_LENGTH),
      normalizedBeerId: optionalText(raw.normalizedBeerId, source, MAX_ID_LENGTH, true),
      brewery: optionalText(raw.brewery, source),
      style: optionalText(raw.style, source),
      abv: finiteNumber(raw.abv, source, { minimum: 0, maximum: 25, nullable: true }),
      serveSize: servingSize(raw.serveSize, source),
      price: price(raw.price, source),
      onTap: optionalBoolean(raw.onTap, false, source),
      inStock: optionalBoolean(raw.inStock, true, source),
      notes: optionalText(raw.notes, source),
      priceConfirmed: optionalBoolean(raw.priceConfirmed, false, source),
      stockConfirmed: optionalBoolean(raw.stockConfirmed, false, source),
      expectedUpdatedAt: optionalTimestamp(raw.expectedUpdatedAt, source),
    },
  };
}

function normalizeResolvedBeerPayload(
  value: unknown,
  source: ValidationSource,
): ResolvedVenueBeerPendingPayload {
  const raw = clonedJsonObject(value, source);
  assertAllowedKeys(raw, RESOLVED_BEER_PAYLOAD_KEYS, source);
  const normalized = normalizeBeerPayload("resolved-placeholder", {
    ...raw,
    id: "resolved-placeholder",
    expectedUpdatedAt: null,
  }, source).payload;
  const { id: _id, expectedUpdatedAt: _expectedUpdatedAt, ...resolved } = normalized;
  return resolved;
}

function normalizeHappyHourPayload(
  targetId: unknown,
  raw: Record<string, unknown>,
  source: ValidationSource,
): { targetId: string; payload: VenueHappyHourPendingPayload } {
  assertAllowedKeys(raw, HAPPY_HOUR_PAYLOAD_KEYS, source);
  const id = normalizeTargetId(targetId, raw.id, source);
  const days = stringArray(raw.daysOfWeek, source, {
    maximumItems: 7,
    maximumLength: 3,
    allowed: DAYS_OF_WEEK,
  });
  if (days.length === 0) validationFailure(source);
  return {
    targetId: id,
    payload: {
      id,
      title: requiredText(raw.title, source, MAX_TITLE_LENGTH),
      daysOfWeek: days,
      startTime: localTime(raw.startTime, source)!,
      endTime: localTime(raw.endTime, source)!,
      description: requiredText(raw.description, source, MAX_HAPPY_HOUR_DESCRIPTION_LENGTH),
      happyHourBeers: raw.happyHourBeers === undefined ? [] : happyHourBeers(raw.happyHourBeers, source),
      active: optionalBoolean(raw.active, true, source),
      expectedUpdatedAt: optionalTimestamp(raw.expectedUpdatedAt, source),
    },
  };
}

function normalizeRecurrence(
  value: unknown,
  source: ValidationSource,
): VenueSpecialPendingPayload["recurrence"] {
  const raw = value === undefined ? {} : plainObject(value, source);
  assertAllowedKeys(raw, new Set(["frequency", "daysOfWeek", "timezone"]), source);
  const frequency = raw.frequency === undefined ? "none" : raw.frequency;
  if (frequency !== "none" && frequency !== "weekly") return validationFailure(source);
  const days = raw.daysOfWeek === undefined
    ? []
    : stringArray(raw.daysOfWeek, source, { maximumItems: 7, maximumLength: 3, allowed: DAYS_OF_WEEK });
  if (frequency === "weekly" && days.length === 0) validationFailure(source);
  return {
    frequency,
    daysOfWeek: days,
    timezone: raw.timezone === undefined
      ? "Australia/Melbourne"
      : requiredText(raw.timezone, source, 80),
  };
}

function normalizeSpecialPayload(
  targetId: unknown,
  raw: Record<string, unknown>,
  source: ValidationSource,
): { targetId: string; payload: VenueSpecialPendingPayload } {
  assertAllowedKeys(raw, SPECIAL_PAYLOAD_KEYS, source);
  const id = normalizeTargetId(targetId, raw.id, source);
  const startsAt = optionalTimestamp(raw.startsAt, source);
  const endsAt = optionalTimestamp(raw.endsAt, source);
  if (startsAt && endsAt && endsAt <= startsAt) validationFailure(source);
  const startTime = localTime(raw.startTime, source, true);
  const endTime = localTime(raw.endTime, source, true);
  if (startTime && endTime && startTime === endTime) validationFailure(source);
  return {
    targetId: id,
    payload: {
      id,
      title: requiredText(raw.title, source, MAX_TITLE_LENGTH),
      description: requiredText(raw.description, source, MAX_SPECIAL_DESCRIPTION_LENGTH),
      price: price(raw.price, source),
      discount: optionalText(raw.discount, source),
      savingsAmountCents: finiteNumber(raw.savingsAmountCents, source, {
        minimum: 0,
        maximum: 100_000,
        integer: true,
        nullable: true,
      }),
      startsAt,
      endsAt,
      startTime,
      endTime,
      recurrence: normalizeRecurrence(raw.recurrence, source),
      scheduleNote: optionalText(raw.scheduleNote, source),
      exclusive: optionalBoolean(raw.exclusive, false, source),
      active: optionalBoolean(raw.active, true, source),
      expectedUpdatedAt: optionalTimestamp(raw.expectedUpdatedAt, source),
    },
  };
}

function normalizeDeletePayload(
  changeType: Exclude<BarPendingChangeType, "profile">,
  targetId: unknown,
  raw: Record<string, unknown>,
  source: ValidationSource,
): { targetId: string; payload: VenueDeletePendingPayload } {
  assertAllowedKeys(raw, DELETE_PAYLOAD_KEYS[changeType], source);
  const normalizedTarget = normalizeTargetId(targetId, raw.id, source);
  const expectedUpdatedAt = optionalTimestamp(raw.expectedUpdatedAt, source);
  if (!expectedUpdatedAt) validationFailure(source);
  return { targetId: normalizedTarget, payload: { expectedUpdatedAt } };
}

function normalizeDescriptor(
  changeTypeValue: unknown,
  actionValue: unknown,
  targetId: unknown,
  payloadValue: unknown,
  source: "input" | "payload",
): NormalizedDescriptor {
  if (typeof changeTypeValue !== "string" || !CHANGE_TYPES.has(changeTypeValue as BarPendingChangeType)) {
    return validationFailure(source);
  }
  if (typeof actionValue !== "string" || !ACTIONS.has(actionValue as BarPendingChangeAction)) {
    return validationFailure(source);
  }
  const changeType = changeTypeValue as BarPendingChangeType;
  const action = actionValue as BarPendingChangeAction;
  const raw = source === "payload" ? payloadObject(payloadValue) : clonedJsonObject(payloadValue, source);

  if (changeType === "profile") {
    if (action !== "upsert" || optionalText(targetId, source, MAX_ID_LENGTH, true) !== null) {
      return validationFailure(source);
    }
    return { changeType, action, targetId: null, payload: normalizeProfilePayload(raw, source) };
  }

  if (action === "delete") {
    const normalized = normalizeDeletePayload(changeType, targetId, raw, source);
    return { changeType, action, ...normalized };
  }

  if (changeType === "beer") {
    return { changeType, action, ...normalizeBeerPayload(targetId, raw, source) };
  }
  if (changeType === "happy_hour") {
    return { changeType, action, ...normalizeHappyHourPayload(targetId, raw, source) };
  }
  return { changeType, action, ...normalizeSpecialPayload(targetId, raw, source) };
}

function descriptorPayload(descriptor: NormalizedDescriptor): Record<string, unknown> {
  return descriptor.payload as unknown as Record<string, unknown>;
}

function serializePayload(descriptor: NormalizedDescriptor): string {
  const serialized = JSON.stringify(descriptor.payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) return fail("invalid_input");
  return serialized;
}

function persistedPending(row: PendingRow): PersistedPendingChange {
  const id = requiredText(row.id, "record", MAX_ID_LENGTH, true);
  const barId = requiredText(row.barId, "record", MAX_ID_LENGTH, true);
  const submittedBy = requiredText(row.submittedBy, "record", MAX_ID_LENGTH, true);
  const reviewedBy = optionalText(row.reviewedBy, "record", MAX_ID_LENGTH, true);
  const submittedAt = timestamp(row.submittedAt, "record");
  const reviewedAt = optionalTimestamp(row.reviewedAt, "record");
  const createdAt = timestamp(row.createdAt, "record");
  const updatedAt = timestamp(row.updatedAt, "record");
  const rejectionReason = optionalText(row.rejectionReason, "record", MAX_REJECTION_REASON_LENGTH);
  if (typeof row.status !== "string" || !STATUSES.has(row.status as BarPendingChangeStatus)) {
    return fail("malformed_record");
  }
  const status = row.status as BarPendingChangeStatus;
  if (
    (status === "pending" && (reviewedBy !== null || reviewedAt !== null || rejectionReason !== null))
    || (status !== "pending" && (reviewedBy === null || reviewedAt === null))
    || status === "approved" && rejectionReason !== null
    || status === "rejected" && rejectionReason === null
    || createdAt > submittedAt
    || updatedAt < createdAt
  ) return fail("malformed_record");
  const descriptor = normalizeDescriptor(row.changeType, row.action, row.targetId, row.payloadJson, "payload");
  return {
    descriptor,
    change: {
      id,
      barId,
      changeType: descriptor.changeType,
      action: descriptor.action,
      targetId: descriptor.targetId,
      payload: descriptorPayload(descriptor),
      status,
      submittedBy,
      submittedAt,
      reviewedBy,
      reviewedAt,
      rejectionReason,
      createdAt,
      updatedAt,
    },
  };
}

function mutationTimestamp(now: string, previous: string): string {
  if (Date.parse(now) > Date.parse(previous)) return now;
  const next = new Date(Date.parse(previous) + 1).toISOString();
  if (!Number.isFinite(Date.parse(next))) return fail("invalid_input");
  return next;
}

function assertTargetBase(
  current: { updatedAt: string } | null,
  expectedUpdatedAt: string | null,
): void {
  if (!current) {
    if (expectedUpdatedAt !== null) fail("target_version_conflict");
    return;
  }
  if (expectedUpdatedAt === null || current.updatedAt !== expectedUpdatedAt) {
    fail("target_version_conflict");
  }
}

/**
 * Async, PostgreSQL-ready private moderation persistence. Provider resolution,
 * reviewer authorization, commercial tier checks, and public display
 * eligibility must be completed outside this class. The repository stores and
 * applies manager inventory only; happy hours and specials are never published
 * by this layer.
 */
export class VenuePendingChangeRepository {
  private readonly inventory: VenueInventoryRepository;

  constructor(private readonly database: SqlDatabase) {
    // Construction guarantees every composed inventory call participates in
    // this exact SqlDatabase transaction/AsyncLocal context.
    this.inventory = new VenueInventoryRepository(database);
  }

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenuePendingChangeRepositoryError) throw error;
      if (error instanceof OptimisticConcurrencyError) return fail("target_version_conflict");
      return fail("persistence_failure");
    }
  }

  private collation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private lockSuffix(): string {
    return this.database.dialect === "postgres" ? " FOR UPDATE OF pending" : "";
  }

  private async pendingById(id: string, lock = false): Promise<PersistedPendingChange | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(PENDING_COLUMNS, "pending.")}
       FROM venue_pending_changes pending
       WHERE pending.id = ?
       LIMIT 1${lock ? this.lockSuffix() : ""}`,
    ).get<PendingRow>(id);
    return row ? persistedPending(row) : null;
  }

  private async lockInventory(kind: "profile" | "beer" | "happy-hour" | "special", id: string): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    await this.database.prepare(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0)) AS \"locked\"",
    ).get(`venue-inventory:${kind}:${id}`);
  }

  private async lockVenueThenTarget(
    barId: string,
    kind?: "beer" | "happy-hour" | "special",
    targetId?: string,
  ): Promise<void> {
    await this.lockInventory("profile", barId);
    if (kind && targetId) await this.lockInventory(kind, targetId);
  }

  private async ensureProfile(barId: string, now: string): Promise<BarProfile> {
    const current = await this.inventory.getBarProfile(barId);
    if (current) return current;
    return this.inventory.upsertBarProfile({
      barId,
      name: barId,
      address: null,
      suburb: null,
      area: null,
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      tierManualOverride: false,
      acceptsPintPathCodes: false,
      active: true,
      now,
    });
  }

  async createBarPendingChange(input: CreateBarPendingChangeInput): Promise<BarPendingChange> {
    const id = requiredText(input.id, "input", MAX_ID_LENGTH, true);
    const barId = requiredText(input.barId, "input", MAX_ID_LENGTH, true);
    const submittedBy = requiredText(input.submittedBy, "input", MAX_ID_LENGTH, true);
    const now = timestamp(input.now, "input");
    const descriptor = normalizeDescriptor(input.changeType, input.action, input.targetId, input.payload, "input");
    const payloadJson = serializePayload(descriptor);
    return this.translate(this.database.transaction(async () => {
      await this.database.prepare(
        `INSERT INTO venue_pending_changes (
           id, venue_id, change_type, action, target_id, payload_json, status,
           submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        id,
        barId,
        descriptor.changeType,
        descriptor.action,
        descriptor.targetId,
        payloadJson,
        submittedBy,
        now,
        now,
        now,
      );
      const persisted = await this.pendingById(id);
      return persisted?.change ?? fail("persistence_failure");
    }));
  }

  async getBarPendingChangeById(id: string): Promise<BarPendingChange | null> {
    const normalizedId = requiredText(id, "input", MAX_ID_LENGTH, true);
    return this.translate(async () => (await this.pendingById(normalizedId))?.change ?? null);
  }

  async getPendingBarChangeForTarget(input: {
    barId: string;
    changeType: BarPendingChangeType;
    action: BarPendingChangeAction;
    targetId: string | null;
  }): Promise<BarPendingChange | null> {
    const barId = requiredText(input.barId, "input", MAX_ID_LENGTH, true);
    if (!CHANGE_TYPES.has(input.changeType) || !ACTIONS.has(input.action)) return fail("invalid_input");
    const targetId = optionalText(input.targetId, "input", MAX_ID_LENGTH, true);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT ${projection(PENDING_COLUMNS, "pending.")}
         FROM venue_pending_changes pending
         WHERE pending.venue_id = ?
           AND pending.change_type = ?
           AND pending.action = ?
           AND (pending.target_id = ? OR (pending.target_id IS NULL AND CAST(? AS TEXT) IS NULL))
           AND pending.status = 'pending'
         ORDER BY pending.submitted_at DESC, pending.id ${this.collation()} DESC
         LIMIT 1`,
      ).get<PendingRow>(barId, input.changeType, input.action, targetId, targetId);
      return row ? persistedPending(row).change : null;
    });
  }

  async listBarPendingChanges(input: ListBarPendingChangesInput): Promise<BarPendingChange[]> {
    const barId = input.barId === undefined
      ? null
      : requiredText(input.barId, "input", MAX_ID_LENGTH, true);
    const submittedBy = input.submittedBy === undefined
      ? null
      : requiredText(input.submittedBy, "input", MAX_ID_LENGTH, true);
    if (input.status !== undefined && !STATUSES.has(input.status)) return fail("invalid_input");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST_LIMIT) {
      return fail("invalid_input");
    }
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) return fail("invalid_input");
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${projection(PENDING_COLUMNS, "pending.")}
         FROM venue_pending_changes pending
         WHERE (CAST(? AS TEXT) IS NULL OR pending.venue_id = ?)
           AND (CAST(? AS TEXT) IS NULL OR pending.submitted_by = ?)
           AND (CAST(? AS TEXT) IS NULL OR pending.status = ?)
         ORDER BY
           CASE
             WHEN COALESCE(
               (SELECT profile.membership_tier
                FROM venue_profiles profile
                WHERE profile.venue_id = pending.venue_id),
               'basic'
             ) = 'pro' THEN 0
             ELSE 1
           END,
           pending.submitted_at DESC,
           pending.id ${this.collation()} DESC
         LIMIT ? OFFSET ?`,
      ).all<PendingRow>(
        barId,
        barId,
        submittedBy,
        submittedBy,
        input.status ?? null,
        input.status ?? null,
        input.limit,
        offset,
      );
      return rows.map((row) => persistedPending(row).change);
    });
  }

  async countBarPendingChanges(input: CountBarPendingChangesInput = {}): Promise<number> {
    const barId = input.barId === undefined
      ? null
      : requiredText(input.barId, "input", MAX_ID_LENGTH, true);
    const submittedBy = input.submittedBy === undefined
      ? null
      : requiredText(input.submittedBy, "input", MAX_ID_LENGTH, true);
    if (input.status !== undefined && !STATUSES.has(input.status)) return fail("invalid_input");
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count"
           FROM venue_pending_changes pending
          WHERE (CAST(? AS TEXT) IS NULL OR pending.venue_id = ?)
            AND (CAST(? AS TEXT) IS NULL OR pending.submitted_by = ?)
            AND (CAST(? AS TEXT) IS NULL OR pending.status = ?)`,
      ).get<{ count: unknown }>(
        barId,
        barId,
        submittedBy,
        submittedBy,
        input.status ?? null,
        input.status ?? null,
      );
      return safeCount(row?.count ?? 0);
    });
  }

  private async applyApprovedBarChange(
    change: BarPendingChange,
    descriptor: NormalizedDescriptor,
    now: string,
    resolvedBeerPayload: ResolvedVenueBeerPendingPayload | null,
  ): Promise<AppliedVenuePendingChange> {
    if (descriptor.changeType === "profile") {
      await this.lockVenueThenTarget(change.barId);
      const current = await this.inventory.getBarProfile(change.barId);
      assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
      const value = await this.inventory.upsertBarProfile({
        barId: change.barId,
        name: descriptor.payload.name,
        address: descriptor.payload.address,
        suburb: descriptor.payload.suburb,
        area: descriptor.payload.area ?? descriptor.payload.suburb,
        phone: descriptor.payload.phone,
        website: descriptor.payload.website,
        instagram: descriptor.payload.instagram,
        description: descriptor.payload.description,
        openingHours: descriptor.payload.openingHours,
        venueTags: descriptor.payload.venueTags,
        membershipTier: current?.membershipTier ?? "basic",
        highlightedName: current?.highlightedName ?? false,
        premiumBadge: current?.premiumBadge ?? null,
        promoted: current?.promoted ?? false,
        featuredSpecialEligible: current?.featuredSpecialEligible ?? false,
        stripeCustomerId: current?.stripeCustomerId ?? null,
        stripeSubscriptionId: current?.stripeSubscriptionId ?? null,
        subscriptionStatus: current?.subscriptionStatus ?? null,
        tierManualOverride: current?.tierManualOverride ?? false,
        acceptsPintPathCodes: current?.acceptsPintPathCodes ?? false,
        active: descriptor.payload.active,
        expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
        now,
      });
      return { changeType: "profile", action: "upsert", targetId: change.barId, value };
    }

    const targetKind = descriptor.changeType === "happy_hour" ? "happy-hour" : descriptor.changeType;
    await this.lockVenueThenTarget(change.barId, targetKind, descriptor.targetId);

    if (descriptor.action === "delete") {
      if (descriptor.changeType === "beer") {
        const current = await this.inventory.getBarBeerById(descriptor.targetId);
        if (current && current.barId !== change.barId) return fail("target_venue_conflict");
        if (!current) return fail("target_not_found");
        assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
        const deleted = await this.inventory.deleteBarBeer({
          id: descriptor.targetId,
          barId: change.barId,
          expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
        });
        if (!deleted) return fail("target_version_conflict");
        return { changeType: "beer", action: "delete", targetId: descriptor.targetId, deleted: true };
      }
      if (descriptor.changeType === "happy_hour") {
        const current = await this.inventory.getBarHappyHourById(descriptor.targetId);
        if (current && current.barId !== change.barId) return fail("target_venue_conflict");
        if (!current) return fail("target_not_found");
        assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
        const deleted = await this.inventory.deleteBarHappyHour({
          id: descriptor.targetId,
          barId: change.barId,
          expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
        });
        if (!deleted) return fail("target_version_conflict");
        return { changeType: "happy_hour", action: "delete", targetId: descriptor.targetId, deleted: true };
      }
      const current = await this.inventory.getBarSpecialById(descriptor.targetId);
      if (current && current.barId !== change.barId) return fail("target_venue_conflict");
      if (!current) return fail("target_not_found");
      assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
      const deleted = await this.inventory.deleteBarSpecial({
        id: descriptor.targetId,
        barId: change.barId,
        expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
      });
      if (!deleted) return fail("target_version_conflict");
      return { changeType: "special", action: "delete", targetId: descriptor.targetId, deleted: true };
    }

    await this.ensureProfile(change.barId, now);
    if (descriptor.changeType === "beer") {
      const payload = resolvedBeerPayload
        ? {
            ...resolvedBeerPayload,
            id: descriptor.payload.id,
            expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
          }
        : descriptor.payload;
      const current = await this.inventory.getBarBeerById(descriptor.targetId);
      if (current && current.barId !== change.barId) return fail("target_venue_conflict");
      assertTargetBase(current, payload.expectedUpdatedAt);
      const priceChanged = current !== null && current.price !== payload.price;
      const stockChanged = current !== null
        && (current.inStock !== payload.inStock || current.onTap !== payload.onTap);
      const value = await this.inventory.upsertBarBeer({
        id: descriptor.targetId,
        barId: change.barId,
        beerName: payload.beerName,
        normalizedBeerId: payload.normalizedBeerId,
        brewery: payload.brewery,
        style: payload.style,
        abv: payload.abv,
        serveSize: payload.serveSize,
        price: payload.price,
        currency: "AUD",
        onTap: payload.onTap,
        inStock: payload.inStock,
        notes: payload.notes,
        priceVerifiedAt: payload.priceConfirmed
          ? now
          : priceChanged
            ? null
            : current?.priceVerifiedAt ?? null,
        stockVerifiedAt: payload.stockConfirmed
          ? now
          : stockChanged
            ? null
            : current?.stockVerifiedAt ?? null,
        expectedUpdatedAt: payload.expectedUpdatedAt,
        now,
      });
      return { changeType: "beer", action: "upsert", targetId: descriptor.targetId, value };
    }

    if (descriptor.changeType === "happy_hour") {
      const current = await this.inventory.getBarHappyHourById(descriptor.targetId);
      if (current && current.barId !== change.barId) return fail("target_venue_conflict");
      assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
      const value = await this.inventory.upsertBarHappyHour({
        id: descriptor.targetId,
        barId: change.barId,
        title: descriptor.payload.title,
        daysOfWeek: descriptor.payload.daysOfWeek,
        startTime: descriptor.payload.startTime,
        endTime: descriptor.payload.endTime,
        description: descriptor.payload.description,
        happyHourBeers: descriptor.payload.happyHourBeers,
        active: descriptor.payload.active,
        expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
        now,
      });
      return { changeType: "happy_hour", action: "upsert", targetId: descriptor.targetId, value };
    }

    const current = await this.inventory.getBarSpecialById(descriptor.targetId);
    if (current && current.barId !== change.barId) return fail("target_venue_conflict");
    assertTargetBase(current, descriptor.payload.expectedUpdatedAt);
    const value = await this.inventory.upsertBarSpecial({
      id: descriptor.targetId,
      barId: change.barId,
      title: descriptor.payload.title,
      description: descriptor.payload.description,
      price: descriptor.payload.price,
      discount: descriptor.payload.discount,
      savingsAmountCents: descriptor.payload.savingsAmountCents,
      startsAt: descriptor.payload.startsAt,
      endsAt: descriptor.payload.endsAt,
      startTime: descriptor.payload.startTime,
      endTime: descriptor.payload.endTime,
      recurrenceFrequency: descriptor.payload.recurrence.frequency,
      daysOfWeek: descriptor.payload.recurrence.daysOfWeek,
      timezone: descriptor.payload.recurrence.timezone,
      scheduleNote: descriptor.payload.scheduleNote,
      exclusive: descriptor.payload.exclusive,
      active: descriptor.payload.active,
      expectedUpdatedAt: descriptor.payload.expectedUpdatedAt,
      now,
    });
    return { changeType: "special", action: "upsert", targetId: descriptor.targetId, value };
  }

  async reviewBarPendingChange(input: ReviewBarPendingChangeInput): Promise<ReviewBarPendingChangeResult> {
    const id = requiredText(input.id, "input", MAX_ID_LENGTH, true);
    const reviewedBy = requiredText(input.reviewedBy, "input", MAX_ID_LENGTH, true);
    const expectedUpdatedAt = timestamp(input.expectedUpdatedAt, "input");
    const reviewedAt = timestamp(input.reviewedAt, "input");
    if (input.status !== "approved" && input.status !== "rejected") return fail("invalid_input");
    const rejectionReason = optionalText(input.rejectionReason, "input", MAX_REJECTION_REASON_LENGTH);
    if (
      input.status === "rejected" && (!rejectionReason || rejectionReason.length < 4)
      || input.status === "approved" && rejectionReason !== null
    ) return fail("invalid_input");
    const resolvedBeerPayload = input.resolvedBeerPayload === undefined
      ? null
      : normalizeResolvedBeerPayload(input.resolvedBeerPayload, "input");

    return this.translate(this.database.transaction(async () => {
      const persisted = await this.pendingById(id, true);
      if (!persisted) return fail("pending_change_not_found");
      const { change, descriptor } = persisted;
      if (change.status !== "pending") return fail("pending_change_not_reviewable");
      if (change.updatedAt !== expectedUpdatedAt) return fail("pending_change_version_conflict");
      if (reviewedAt < change.submittedAt) return fail("invalid_input");
      if (
        resolvedBeerPayload !== null
        && (input.status !== "approved" || descriptor.changeType !== "beer" || descriptor.action !== "upsert")
      ) return fail("invalid_input");

      const appliedChange = input.status === "approved"
        ? await this.applyApprovedBarChange(change, descriptor, reviewedAt, resolvedBeerPayload)
        : null;
      const updatedAt = mutationTimestamp(reviewedAt, change.updatedAt);
      const update = await this.database.prepare(
        `UPDATE venue_pending_changes
         SET status = ?,
             reviewed_by = ?,
             reviewed_at = ?,
             rejection_reason = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'pending'
           AND reviewed_by IS NULL
           AND updated_at = ?`,
      ).run(input.status, reviewedBy, reviewedAt, rejectionReason, updatedAt, id, expectedUpdatedAt);
      if (update.changes !== 1) return fail("pending_change_not_reviewable");
      const reviewed = await this.pendingById(id);
      if (
        !reviewed
        || reviewed.change.status !== input.status
        || reviewed.change.reviewedBy !== reviewedBy
        || reviewed.change.updatedAt !== updatedAt
      ) return fail("persistence_failure");
      return { pendingChange: reviewed.change, appliedChange };
    }));
  }
}
