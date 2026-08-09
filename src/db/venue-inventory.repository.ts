import {
  OptimisticConcurrencyError,
  type BarBeer,
  type BarHappyHour,
  type BarHappyHourBeer,
  type BarMembershipTier,
  type BarProfile,
  type BarSpecial,
  type ServingSize,
} from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const MAX_ID_LENGTH = 200;
const MAX_PROFILE_NAME_LENGTH = 180;
const MAX_BEER_NAME_LENGTH = 160;
const MAX_TITLE_LENGTH = 140;
const MAX_OPTIONAL_TEXT_LENGTH = 2_000;
const MAX_HAPPY_HOUR_DESCRIPTION_LENGTH = 800;
const MAX_SPECIAL_DESCRIPTION_LENGTH = 1_000;
const MAX_VENUE_TAGS = 20;
const MAX_VENUE_TAG_LENGTH = 80;
const MAX_HAPPY_HOUR_BEERS = 60;
const MAX_REPORTABLE_PROFILES = 1_000;
const MAX_TIMESTAMP_LOOKUP_VENUES = 1_000;
const MAX_TIMESTAMP_LOOKUP_NAMES = 200;
const MAX_JSON_BYTES = 65_536;

const SERVING_SIZES = new Set<ServingSize>([
  "pint",
  "pot",
  "schooner",
  "jug",
  "bottle",
  "can",
  "other",
]);
const DAYS_OF_WEEK = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const PROFILE_COLUMNS = [
  ["venue_id", "barId"],
  ["name", "name"],
  ["address", "address"],
  ["suburb", "suburb"],
  ["area", "area"],
  ["phone", "phone"],
  ["website", "website"],
  ["instagram", "instagram"],
  ["description", "description"],
  ["opening_hours_json", "openingHoursJson"],
  ["venue_tags_json", "venueTagsJson"],
  ["membership_tier", "membershipTier"],
  ["highlighted_name", "highlightedName"],
  ["premium_badge", "premiumBadge"],
  ["promoted", "promoted"],
  ["featured_special_eligible", "featuredSpecialEligible"],
  ["stripe_customer_id", "stripeCustomerId"],
  ["stripe_subscription_id", "stripeSubscriptionId"],
  ["subscription_status", "subscriptionStatus"],
  ["subscription_current_period_end", "subscriptionCurrentPeriodEnd"],
  ["stripe_paid_membership_tier", "stripePaidMembershipTier"],
  ["tier_manual_override", "tierManualOverride"],
  ["accepts_pint_path_codes", "acceptsPintPathCodes"],
  ["stripe_event_created_at", "stripeEventCreatedAt"],
  ["pos_webhook_token_version", "posWebhookTokenVersion"],
  ["pos_previous_token_version", "posPreviousTokenVersion"],
  ["pos_previous_token_valid_until", "posPreviousTokenValidUntil"],
  ["pos_last_success_at", "posLastSuccessAt"],
  ["pos_last_terminal_id", "posLastTerminalId"],
  ["active", "active"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
] as const;
const BEER_COLUMNS = [
  ["id", "id"],
  ["venue_id", "barId"],
  ["beer_name", "beerName"],
  ["normalized_beer_id", "normalizedBeerId"],
  ["brewery", "brewery"],
  ["style", "style"],
  ["abv", "abv"],
  ["serve_size", "serveSize"],
  ["price", "price"],
  ["currency", "currency"],
  ["on_tap", "onTap"],
  ["in_stock", "inStock"],
  ["notes", "notes"],
  ["price_verified_at", "priceVerifiedAt"],
  ["stock_verified_at", "stockVerifiedAt"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
] as const;
const HAPPY_HOUR_COLUMNS = [
  ["id", "id"],
  ["venue_id", "barId"],
  ["title", "title"],
  ["days_of_week_json", "daysOfWeekJson"],
  ["start_time", "startTime"],
  ["end_time", "endTime"],
  ["description", "description"],
  ["happy_hour_beers_json", "happyHourBeersJson"],
  ["active", "active"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
] as const;
const SPECIAL_COLUMNS = [
  ["id", "id"],
  ["venue_id", "barId"],
  ["title", "title"],
  ["description", "description"],
  ["price", "price"],
  ["discount", "discount"],
  ["savings_amount_cents", "savingsAmountCents"],
  ["starts_at", "startsAt"],
  ["ends_at", "endsAt"],
  ["start_time", "startTime"],
  ["end_time", "endTime"],
  ["recurrence_frequency", "recurrenceFrequency"],
  ["days_of_week_json", "daysOfWeekJson"],
  ["timezone", "timezone"],
  ["schedule_note", "scheduleNote"],
  ["exclusive", "exclusive"],
  ["active", "active"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
] as const;

type RawRow = Record<string, unknown>;

function projection(
  columns: readonly (readonly [column: string, result: string])[],
  qualifier = "",
): string {
  return columns.map(([column, result]) => `${qualifier}${column} AS "${result}"`).join(",\n       ");
}

function invalidInput(field: string): never {
  throw new Error(`Invalid venue inventory input: ${field}.`);
}

function invalidRecord(field: string): never {
  throw new Error(`Invalid venue inventory database record: ${field}.`);
}

function isIdentifierField(field: string): boolean {
  return field === "id" || /(?:Id|Ids)(?:\[\d+\])?$/.test(field);
}

function cleanRequiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") invalidInput(field);
  const cleaned = value.trim();
  if (
    !cleaned
    || cleaned.length > maximum
    || /\0/.test(cleaned)
    || isIdentifierField(field) && /[\r\n]/.test(cleaned)
  ) {
    invalidInput(field);
  }
  return cleaned;
}

function cleanOptionalText(value: unknown, field: string, maximum = MAX_OPTIONAL_TEXT_LENGTH): string | null {
  if (value == null) return null;
  if (typeof value !== "string") invalidInput(field);
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (
    cleaned.length > maximum
    || /\0/.test(cleaned)
    || isIdentifierField(field) && /[\r\n]/.test(cleaned)
  ) invalidInput(field);
  return cleaned;
}

function readRequiredText(value: unknown, field: string, maximum = MAX_OPTIONAL_TEXT_LENGTH): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || /\0/.test(value)
    || isIdentifierField(field) && /[\r\n]/.test(value)
  ) {
    invalidRecord(field);
  }
  return value;
}

function readOptionalText(value: unknown, field: string, maximum = MAX_OPTIONAL_TEXT_LENGTH): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length > maximum
    || /\0/.test(value)
    || isIdentifierField(field) && /[\r\n]/.test(value)
  ) invalidRecord(field);
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  invalidRecord(field);
}

function booleanBinding(database: SqlDatabase, value: boolean): boolean | number {
  return database.dialect === "postgres" ? value : value ? 1 : 0;
}

function cleanFiniteNumber(
  value: unknown,
  field: string,
  options: { minimum: number; maximum: number; integer?: boolean; nullable?: boolean },
): number | null {
  if (value == null && options.nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalidInput(field);
  if (value < options.minimum || value > options.maximum || options.integer && !Number.isInteger(value)) {
    invalidInput(field);
  }
  return value;
}

function readFiniteNumber(
  value: unknown,
  field: string,
  options: { minimum: number; maximum: number; integer?: boolean; nullable?: boolean },
): number | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "number" && typeof value !== "string") invalidRecord(field);
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) invalidRecord(field);
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric)
    || numeric < options.minimum
    || numeric > options.maximum
    || options.integer && !Number.isInteger(numeric)
  ) invalidRecord(field);
  return numeric;
}

function cleanPrice(value: unknown, field: string): number | null {
  const price = cleanFiniteNumber(value, field, { minimum: Number.EPSILON, maximum: 250, nullable: true });
  if (price !== null && Math.abs(price * 100 - Math.round(price * 100)) >= 1e-8) invalidInput(field);
  return price;
}

function readPrice(value: unknown, field: string): number | null {
  const price = readFiniteNumber(value, field, { minimum: Number.EPSILON, maximum: 250, nullable: true });
  if (price !== null && Math.abs(price * 100 - Math.round(price * 100)) >= 1e-8) invalidRecord(field);
  return price;
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

function validateTimestamp(value: unknown, field: string, source: "input" | "record"): string {
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
  ) {
    if (source === "input") invalidInput(field);
    invalidRecord(field);
  }
  return new Date(parsed).toISOString();
}

function cleanOptionalTimestamp(value: unknown, field: string): string | null {
  return value == null ? null : validateTimestamp(value, field, "input");
}

function readOptionalTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : validateTimestamp(value, field, "record");
}

function cleanLocalTime(value: unknown, field: string, nullable = false): string | null {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalidInput(field);
  return value;
}

function readLocalTime(value: unknown, field: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") invalidRecord(field);
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value);
  if (
    !match
    || Number(match[1]) > 23
    || Number(match[2]) > 59
    || Number(match[3] ?? "0") !== 0
    || Number(match[4] ?? "0") !== 0
  ) invalidRecord(field);
  return `${match[1]}:${match[2]}`;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    invalidRecord(field);
  }
}

function assertJsonValue(value: unknown, field: string, depth = 0, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidInput(field);
    return;
  }
  if (typeof value !== "object" || depth > 12 || seen.has(value)) invalidInput(field);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) invalidInput(field);
    for (const item of value) assertJsonValue(item, field, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidInput(field);
    const entries = Object.entries(value);
    if (entries.length > 1_000) invalidInput(field);
    for (const [key, item] of entries) {
      if (!key || key.length > 200 || /\0/.test(key)) invalidInput(field);
      assertJsonValue(item, field, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function serializeJson(value: unknown, field: string): string {
  assertJsonValue(value, field);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) invalidInput(field);
  return serialized;
}

function readJsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidRecord(field);
  try {
    assertJsonValue(parsed, field);
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_JSON_BYTES) invalidRecord(field);
  } catch {
    invalidRecord(field);
  }
  return parsed as Record<string, unknown>;
}

function cleanStringArray(
  value: unknown,
  field: string,
  options: { maximumItems: number; maximumLength: number; allowed?: ReadonlySet<string> },
): string[] {
  if (!Array.isArray(value) || value.length > options.maximumItems) invalidInput(field);
  const result = value.map((item) => cleanRequiredText(item, field, options.maximumLength));
  if (options.allowed && result.some((item) => !options.allowed!.has(item))) invalidInput(field);
  if (new Set(result).size !== result.length) invalidInput(field);
  return result;
}

function readStringArray(
  value: unknown,
  field: string,
  options: { maximumItems: number; maximumLength: number; allowed?: ReadonlySet<string> },
): string[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed) || parsed.length > options.maximumItems) invalidRecord(field);
  const result = parsed.map((item) => readRequiredText(item, field, options.maximumLength));
  if (options.allowed && result.some((item) => !options.allowed!.has(item))) invalidRecord(field);
  if (new Set(result).size !== result.length) invalidRecord(field);
  return result;
}

function cleanServingSize(value: unknown, field: string): ServingSize | null {
  if (value == null) return null;
  if (typeof value !== "string" || !SERVING_SIZES.has(value as ServingSize)) invalidInput(field);
  return value as ServingSize;
}

function readServingSize(value: unknown, field: string): ServingSize | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SERVING_SIZES.has(value as ServingSize)) invalidRecord(field);
  return value as ServingSize;
}

function normalizeMembershipTier(value: unknown, field: string): BarMembershipTier {
  if (typeof value !== "string") invalidRecord(field);
  if (value === "pro" || value === "plus" || value === "super_premium") return "pro";
  if (value === "basic" || value === "free") return "basic";
  invalidRecord(field);
}

function cleanMembershipTier(value: unknown, field: string): BarMembershipTier {
  if (value !== "basic" && value !== "pro") invalidInput(field);
  return value;
}

function cleanHappyHourBeers(value: unknown): BarHappyHourBeer[] {
  if (!Array.isArray(value) || value.length > MAX_HAPPY_HOUR_BEERS) invalidInput("happyHourBeers");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidInput(`happyHourBeers[${index}]`);
    const raw = item as Record<string, unknown>;
    if (typeof raw.onTap !== "boolean" || typeof raw.inStock !== "boolean") {
      invalidInput(`happyHourBeers[${index}]`);
    }
    return {
      beerId: cleanOptionalText(raw.beerId, `happyHourBeers[${index}].beerId`, MAX_ID_LENGTH),
      beerName: cleanRequiredText(raw.beerName, `happyHourBeers[${index}].beerName`, MAX_BEER_NAME_LENGTH),
      normalizedBeerId: cleanOptionalText(raw.normalizedBeerId, `happyHourBeers[${index}].normalizedBeerId`, MAX_ID_LENGTH),
      servingSize: cleanServingSize(raw.servingSize, `happyHourBeers[${index}].servingSize`),
      happyHourPrice: cleanPrice(raw.happyHourPrice, `happyHourBeers[${index}].happyHourPrice`),
      offerText: cleanOptionalText(raw.offerText, `happyHourBeers[${index}].offerText`, 160),
      onTap: raw.onTap,
      inStock: raw.inStock,
    };
  });
}

function readHappyHourBeers(value: unknown): BarHappyHourBeer[] {
  const parsed = parseJson(value, "happyHourBeersJson");
  if (!Array.isArray(parsed) || parsed.length > MAX_HAPPY_HOUR_BEERS) invalidRecord("happyHourBeersJson");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidRecord(`happyHourBeersJson[${index}]`);
    const raw = item as Record<string, unknown>;
    return {
      beerId: readOptionalText(raw.beerId, `happyHourBeersJson[${index}].beerId`, MAX_ID_LENGTH),
      beerName: readRequiredText(raw.beerName, `happyHourBeersJson[${index}].beerName`, MAX_BEER_NAME_LENGTH),
      normalizedBeerId: readOptionalText(raw.normalizedBeerId, `happyHourBeersJson[${index}].normalizedBeerId`, MAX_ID_LENGTH),
      servingSize: readServingSize(raw.servingSize, `happyHourBeersJson[${index}].servingSize`),
      happyHourPrice: readPrice(raw.happyHourPrice, `happyHourBeersJson[${index}].happyHourPrice`),
      offerText: readOptionalText(raw.offerText, `happyHourBeersJson[${index}].offerText`, 160),
      onTap: readBoolean(raw.onTap, `happyHourBeersJson[${index}].onTap`),
      inStock: readBoolean(raw.inStock, `happyHourBeersJson[${index}].inStock`),
    };
  });
}

function mutationTimestamp(now: string, expectedUpdatedAt: string | null): string {
  if (!expectedUpdatedAt || Date.parse(now) > Date.parse(expectedUpdatedAt)) return now;
  const next = new Date(Date.parse(expectedUpdatedAt) + 1).toISOString();
  if (!Number.isFinite(Date.parse(next))) invalidInput("now");
  return next;
}

function mapProfile(row: RawRow): BarProfile {
  const paidTier = row.stripePaidMembershipTier === null
    ? null
    : normalizeMembershipTier(row.stripePaidMembershipTier, "stripePaidMembershipTier");
  return {
    barId: readRequiredText(row.barId, "barId", MAX_ID_LENGTH),
    name: readRequiredText(row.name, "name", MAX_PROFILE_NAME_LENGTH),
    address: readOptionalText(row.address, "address"),
    suburb: readOptionalText(row.suburb, "suburb"),
    area: readOptionalText(row.area, "area"),
    phone: readOptionalText(row.phone, "phone"),
    website: readOptionalText(row.website, "website"),
    instagram: readOptionalText(row.instagram, "instagram"),
    description: readOptionalText(row.description, "description"),
    openingHours: readJsonObject(row.openingHoursJson, "openingHoursJson"),
    venueTags: readStringArray(row.venueTagsJson, "venueTagsJson", {
      maximumItems: MAX_VENUE_TAGS,
      maximumLength: MAX_VENUE_TAG_LENGTH,
    }),
    membershipTier: normalizeMembershipTier(row.membershipTier, "membershipTier"),
    highlightedName: readBoolean(row.highlightedName, "highlightedName"),
    premiumBadge: readOptionalText(row.premiumBadge, "premiumBadge"),
    promoted: readBoolean(row.promoted, "promoted"),
    featuredSpecialEligible: readBoolean(row.featuredSpecialEligible, "featuredSpecialEligible"),
    stripeCustomerId: readOptionalText(row.stripeCustomerId, "stripeCustomerId", MAX_ID_LENGTH),
    stripeSubscriptionId: readOptionalText(row.stripeSubscriptionId, "stripeSubscriptionId", MAX_ID_LENGTH),
    subscriptionStatus: readOptionalText(row.subscriptionStatus, "subscriptionStatus", 120),
    subscriptionCurrentPeriodEnd: readOptionalTimestamp(row.subscriptionCurrentPeriodEnd, "subscriptionCurrentPeriodEnd"),
    stripePaidMembershipTier: paidTier,
    tierManualOverride: readBoolean(row.tierManualOverride, "tierManualOverride"),
    acceptsPintPathCodes: readBoolean(row.acceptsPintPathCodes, "acceptsPintPathCodes"),
    stripeEventCreatedAt: readOptionalTimestamp(row.stripeEventCreatedAt, "stripeEventCreatedAt"),
    posWebhookTokenVersion: readFiniteNumber(row.posWebhookTokenVersion, "posWebhookTokenVersion", {
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    })!,
    posPreviousTokenVersion: readFiniteNumber(row.posPreviousTokenVersion, "posPreviousTokenVersion", {
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
      nullable: true,
    }),
    posPreviousTokenValidUntil: readOptionalTimestamp(row.posPreviousTokenValidUntil, "posPreviousTokenValidUntil"),
    posLastSuccessAt: readOptionalTimestamp(row.posLastSuccessAt, "posLastSuccessAt"),
    posLastTerminalId: readOptionalText(row.posLastTerminalId, "posLastTerminalId", MAX_ID_LENGTH),
    active: readBoolean(row.active, "active"),
    createdAt: validateTimestamp(row.createdAt, "createdAt", "record"),
    updatedAt: validateTimestamp(row.updatedAt, "updatedAt", "record"),
  };
}

function mapBeer(row: RawRow): BarBeer {
  return {
    id: readRequiredText(row.id, "id", MAX_ID_LENGTH),
    barId: readRequiredText(row.barId, "barId", MAX_ID_LENGTH),
    beerName: readRequiredText(row.beerName, "beerName", MAX_BEER_NAME_LENGTH),
    normalizedBeerId: readOptionalText(row.normalizedBeerId, "normalizedBeerId", MAX_ID_LENGTH),
    brewery: readOptionalText(row.brewery, "brewery"),
    style: readOptionalText(row.style, "style"),
    abv: readFiniteNumber(row.abv, "abv", { minimum: 0, maximum: 25, nullable: true }),
    serveSize: readServingSize(row.serveSize, "serveSize"),
    price: readPrice(row.price, "price"),
    currency: readRequiredText(row.currency, "currency", 3),
    onTap: readBoolean(row.onTap, "onTap"),
    inStock: readBoolean(row.inStock, "inStock"),
    notes: readOptionalText(row.notes, "notes"),
    priceVerifiedAt: readOptionalTimestamp(row.priceVerifiedAt, "priceVerifiedAt"),
    stockVerifiedAt: readOptionalTimestamp(row.stockVerifiedAt, "stockVerifiedAt"),
    createdAt: validateTimestamp(row.createdAt, "createdAt", "record"),
    updatedAt: validateTimestamp(row.updatedAt, "updatedAt", "record"),
  };
}

function mapHappyHour(row: RawRow): BarHappyHour {
  return {
    id: readRequiredText(row.id, "id", MAX_ID_LENGTH),
    barId: readRequiredText(row.barId, "barId", MAX_ID_LENGTH),
    title: readRequiredText(row.title, "title", MAX_TITLE_LENGTH),
    daysOfWeek: readStringArray(row.daysOfWeekJson, "daysOfWeekJson", {
      maximumItems: 7,
      maximumLength: 3,
      allowed: DAYS_OF_WEEK,
    }),
    startTime: readLocalTime(row.startTime, "startTime")!,
    endTime: readLocalTime(row.endTime, "endTime")!,
    description: readRequiredText(row.description, "description", MAX_HAPPY_HOUR_DESCRIPTION_LENGTH),
    happyHourBeers: readHappyHourBeers(row.happyHourBeersJson),
    active: readBoolean(row.active, "active"),
    createdAt: validateTimestamp(row.createdAt, "createdAt", "record"),
    updatedAt: validateTimestamp(row.updatedAt, "updatedAt", "record"),
  };
}

function mapSpecial(row: RawRow): BarSpecial {
  const frequency = readRequiredText(row.recurrenceFrequency, "recurrenceFrequency", 20);
  if (frequency !== "none" && frequency !== "weekly") invalidRecord("recurrenceFrequency");
  const daysOfWeek = readStringArray(row.daysOfWeekJson, "daysOfWeekJson", {
    maximumItems: 7,
    maximumLength: 3,
    allowed: DAYS_OF_WEEK,
  });
  if (frequency === "weekly" && daysOfWeek.length === 0) invalidRecord("daysOfWeekJson");
  return {
    id: readRequiredText(row.id, "id", MAX_ID_LENGTH),
    barId: readRequiredText(row.barId, "barId", MAX_ID_LENGTH),
    title: readRequiredText(row.title, "title", MAX_TITLE_LENGTH),
    description: readRequiredText(row.description, "description", MAX_SPECIAL_DESCRIPTION_LENGTH),
    price: readPrice(row.price, "price"),
    discount: readOptionalText(row.discount, "discount"),
    savingsAmountCents: readFiniteNumber(row.savingsAmountCents, "savingsAmountCents", {
      minimum: 0,
      maximum: 100_000,
      integer: true,
      nullable: true,
    }),
    startsAt: readOptionalTimestamp(row.startsAt, "startsAt"),
    endsAt: readOptionalTimestamp(row.endsAt, "endsAt"),
    startTime: readLocalTime(row.startTime, "startTime", true),
    endTime: readLocalTime(row.endTime, "endTime", true),
    recurrence: {
      frequency,
      daysOfWeek,
      timezone: readRequiredText(row.timezone, "timezone", 80),
    },
    scheduleNote: readOptionalText(row.scheduleNote, "scheduleNote"),
    exclusive: readBoolean(row.exclusive, "exclusive"),
    active: readBoolean(row.active, "active"),
    createdAt: validateTimestamp(row.createdAt, "createdAt", "record"),
    updatedAt: validateTimestamp(row.updatedAt, "updatedAt", "record"),
  };
}

export interface UpsertBarProfileInput {
  barId: string;
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
  membershipTier: BarMembershipTier;
  highlightedName: boolean;
  premiumBadge: string | null;
  promoted: boolean;
  featuredSpecialEligible: boolean;
  stripeCustomerId?: string | null | undefined;
  stripeSubscriptionId?: string | null | undefined;
  subscriptionStatus?: string | null | undefined;
  tierManualOverride?: boolean | undefined;
  acceptsPintPathCodes?: boolean | undefined;
  active: boolean;
  expectedUpdatedAt?: string | null | undefined;
  now: string;
}

export interface UpsertBarBeerInput {
  id: string;
  barId: string;
  beerName: string;
  normalizedBeerId?: string | null | undefined;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  serveSize: ServingSize | null;
  price: number | null;
  currency: string;
  onTap: boolean;
  inStock: boolean;
  notes: string | null;
  priceVerifiedAt?: string | null | undefined;
  stockVerifiedAt?: string | null | undefined;
  expectedUpdatedAt?: string | null | undefined;
  now: string;
}

export interface UpsertBarHappyHourInput {
  id: string;
  barId: string;
  title: string;
  daysOfWeek: string[];
  startTime: string;
  endTime: string;
  description: string;
  happyHourBeers: BarHappyHourBeer[];
  active: boolean;
  expectedUpdatedAt?: string | null | undefined;
  now: string;
}

export interface UpsertBarSpecialInput {
  id: string;
  barId: string;
  title: string;
  description: string;
  price: number | null;
  discount: string | null;
  savingsAmountCents?: number | null | undefined;
  startsAt: string | null;
  endsAt: string | null;
  startTime: string | null;
  endTime: string | null;
  recurrenceFrequency?: "none" | "weekly" | undefined;
  daysOfWeek?: string[] | undefined;
  timezone?: string | undefined;
  scheduleNote: string | null;
  exclusive: boolean;
  active: boolean;
  expectedUpdatedAt?: string | null | undefined;
  now: string;
}

/**
 * Native async venue-profile and manager-inventory persistence. Public display
 * eligibility stays in the public query layer; this class only stores and
 * returns venue-scoped manager data.
 */
export class VenueInventoryRepository {
  constructor(private readonly database: SqlDatabase) {}

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.database.transaction(work)();
  }

  private binaryCollation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private async withWriteLock<T>(kind: string, id: string, work: () => Promise<T>): Promise<T> {
    return this.database.transaction(async () => {
      if (this.database.dialect === "postgres") {
        await this.database.prepare(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0)) AS \"locked\"",
        ).get(`venue-inventory:${kind}:${id}`);
      }
      return work();
    })();
  }

  private async getProfile(barId: string): Promise<BarProfile | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(PROFILE_COLUMNS, "profile.")}
       FROM venue_profiles profile
       WHERE profile.venue_id = ?
       LIMIT 1`,
    ).get<RawRow>(barId);
    return row ? mapProfile(row) : null;
  }

  async getBarProfile(barId: string): Promise<BarProfile | null> {
    return this.getProfile(cleanRequiredText(barId, "barId", MAX_ID_LENGTH));
  }

  async listReportableBarProfiles(input: {
    venueId?: string | null | undefined;
    limit: number;
  }): Promise<BarProfile[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_REPORTABLE_PROFILES) {
      invalidInput("limit");
    }
    const venueId = cleanOptionalText(input.venueId, "venueId", MAX_ID_LENGTH);
    const collation = this.binaryCollation();
    const rows = venueId
      ? await this.database.prepare(
          `SELECT ${projection(PROFILE_COLUMNS, "profile.")}
           FROM venue_profiles profile
           WHERE profile.active = TRUE
             AND profile.membership_tier = 'pro'
             AND profile.venue_id = ?
           ORDER BY profile.updated_at DESC, profile.venue_id ${collation} ASC
           LIMIT ?`,
        ).all<RawRow>(venueId, input.limit)
      : await this.database.prepare(
          `SELECT ${projection(PROFILE_COLUMNS, "profile.")}
           FROM venue_profiles profile
           WHERE profile.active = TRUE
             AND profile.membership_tier = 'pro'
           ORDER BY profile.updated_at DESC, profile.venue_id ${collation} ASC
           LIMIT ?`,
        ).all<RawRow>(input.limit);
    return rows.map(mapProfile);
  }

  async upsertBarProfile(input: UpsertBarProfileInput): Promise<BarProfile> {
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const name = cleanRequiredText(input.name, "name", MAX_PROFILE_NAME_LENGTH);
    const address = cleanOptionalText(input.address, "address");
    const suburb = cleanOptionalText(input.suburb, "suburb");
    const area = cleanOptionalText(input.area, "area");
    const phone = cleanOptionalText(input.phone, "phone");
    const website = cleanOptionalText(input.website, "website");
    const instagram = cleanOptionalText(input.instagram, "instagram");
    const description = cleanOptionalText(input.description, "description");
    const openingHoursJson = serializeJson(input.openingHours, "openingHours");
    const venueTags = cleanStringArray(input.venueTags, "venueTags", {
      maximumItems: MAX_VENUE_TAGS,
      maximumLength: MAX_VENUE_TAG_LENGTH,
    });
    const membershipTier = cleanMembershipTier(input.membershipTier, "membershipTier");
    if (
      typeof input.highlightedName !== "boolean"
      || typeof input.promoted !== "boolean"
      || typeof input.featuredSpecialEligible !== "boolean"
      || typeof input.active !== "boolean"
      || input.tierManualOverride !== undefined && typeof input.tierManualOverride !== "boolean"
      || input.acceptsPintPathCodes !== undefined && typeof input.acceptsPintPathCodes !== "boolean"
    ) invalidInput("profile boolean");
    const stripeCustomerId = cleanOptionalText(input.stripeCustomerId, "stripeCustomerId", MAX_ID_LENGTH);
    const stripeSubscriptionId = cleanOptionalText(input.stripeSubscriptionId, "stripeSubscriptionId", MAX_ID_LENGTH);
    const subscriptionStatus = cleanOptionalText(input.subscriptionStatus, "subscriptionStatus", 120);
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    const requestedNow = validateTimestamp(input.now, "now", "input");
    const now = mutationTimestamp(requestedNow, expectedUpdatedAt);

    return this.withWriteLock("profile", barId, async () => {
      const row = await this.database.prepare(
        `INSERT INTO venue_profiles (
           venue_id, name, address, suburb, area, phone, website, instagram, description,
           opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
           promoted, featured_special_eligible, stripe_customer_id, stripe_subscription_id,
           subscription_status, tier_manual_override, accepts_pint_path_codes, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(venue_id) DO UPDATE SET
           name = excluded.name,
           address = excluded.address,
           suburb = excluded.suburb,
           area = excluded.area,
           phone = excluded.phone,
           website = excluded.website,
           instagram = excluded.instagram,
           description = excluded.description,
           opening_hours_json = excluded.opening_hours_json,
           venue_tags_json = excluded.venue_tags_json,
           membership_tier = excluded.membership_tier,
           highlighted_name = excluded.highlighted_name,
           premium_badge = excluded.premium_badge,
           promoted = excluded.promoted,
           featured_special_eligible = excluded.featured_special_eligible,
           stripe_customer_id = COALESCE(excluded.stripe_customer_id, venue_profiles.stripe_customer_id),
           stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, venue_profiles.stripe_subscription_id),
           subscription_status = COALESCE(excluded.subscription_status, venue_profiles.subscription_status),
           tier_manual_override = excluded.tier_manual_override,
           accepts_pint_path_codes = excluded.accepts_pint_path_codes,
           active = excluded.active,
           updated_at = excluded.updated_at
         WHERE (CAST(? AS TEXT) IS NULL OR venue_profiles.updated_at = ?)
         RETURNING ${projection(PROFILE_COLUMNS)}`,
      ).get<RawRow>(
        barId,
        name,
        address,
        suburb,
        area,
        phone,
        website,
        instagram,
        description,
        openingHoursJson,
        JSON.stringify(venueTags),
        membershipTier,
        booleanBinding(this.database, input.highlightedName),
        cleanOptionalText(input.premiumBadge, "premiumBadge"),
        booleanBinding(this.database, input.promoted),
        booleanBinding(this.database, input.featuredSpecialEligible),
        stripeCustomerId,
        stripeSubscriptionId,
        subscriptionStatus,
        booleanBinding(this.database, input.tierManualOverride ?? false),
        booleanBinding(this.database, input.acceptsPintPathCodes ?? false),
        booleanBinding(this.database, input.active),
        now,
        now,
        expectedUpdatedAt,
        expectedUpdatedAt,
      );
      if (row) return mapProfile(row);
      if (await this.getProfile(barId)) {
        throw new OptimisticConcurrencyError("Venue profile changed before this update could be saved.");
      }
      throw new Error("Venue profile write did not return its persisted row.");
    });
  }

  private async getBeer(id: string): Promise<BarBeer | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(BEER_COLUMNS, "beer.")}
       FROM venue_beers beer
       WHERE beer.id = ?
       LIMIT 1`,
    ).get<RawRow>(id);
    return row ? mapBeer(row) : null;
  }

  async listBarBeers(barId: string): Promise<BarBeer[]> {
    const normalizedBarId = cleanRequiredText(barId, "barId", MAX_ID_LENGTH);
    const collation = this.binaryCollation();
    const rows = await this.database.prepare(
      `SELECT ${projection(BEER_COLUMNS, "beer.")}
       FROM venue_beers beer
       WHERE beer.venue_id = ?
       ORDER BY beer.on_tap DESC,
                beer.in_stock DESC,
                lower(beer.beer_name) ${collation} ASC,
                beer.beer_name ${collation} ASC,
                beer.id ${collation} ASC`,
    ).all<RawRow>(normalizedBarId);
    return rows.map(mapBeer);
  }

  async getBarBeerById(id: string): Promise<BarBeer | null> {
    return this.getBeer(cleanRequiredText(id, "id", MAX_ID_LENGTH));
  }

  async upsertBarBeer(input: UpsertBarBeerInput): Promise<BarBeer> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const beerName = cleanRequiredText(input.beerName, "beerName", MAX_BEER_NAME_LENGTH);
    const normalizedBeerId = cleanOptionalText(input.normalizedBeerId, "normalizedBeerId", MAX_ID_LENGTH);
    const brewery = cleanOptionalText(input.brewery, "brewery");
    const style = cleanOptionalText(input.style, "style");
    const abv = cleanFiniteNumber(input.abv, "abv", { minimum: 0, maximum: 25, nullable: true });
    const serveSize = cleanServingSize(input.serveSize, "serveSize");
    const price = cleanPrice(input.price, "price");
    const currency = cleanRequiredText(input.currency, "currency", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) invalidInput("currency");
    if (typeof input.onTap !== "boolean" || typeof input.inStock !== "boolean") invalidInput("beer boolean");
    const notes = cleanOptionalText(input.notes, "notes");
    const priceVerifiedAt = cleanOptionalTimestamp(input.priceVerifiedAt, "priceVerifiedAt");
    const stockVerifiedAt = cleanOptionalTimestamp(input.stockVerifiedAt, "stockVerifiedAt");
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    const requestedNow = validateTimestamp(input.now, "now", "input");
    const now = mutationTimestamp(requestedNow, expectedUpdatedAt);

    return this.withWriteLock("beer", id, async () => {
      const row = await this.database.prepare(
        `INSERT INTO venue_beers (
           id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size, price, currency,
           on_tap, in_stock, notes, price_verified_at, stock_verified_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           beer_name = excluded.beer_name,
           normalized_beer_id = excluded.normalized_beer_id,
           brewery = excluded.brewery,
           style = excluded.style,
           abv = excluded.abv,
           serve_size = excluded.serve_size,
           price = excluded.price,
           currency = excluded.currency,
           on_tap = excluded.on_tap,
           in_stock = excluded.in_stock,
           notes = excluded.notes,
           price_verified_at = excluded.price_verified_at,
           stock_verified_at = excluded.stock_verified_at,
           updated_at = excluded.updated_at
         WHERE venue_beers.venue_id = excluded.venue_id
           AND (CAST(? AS TEXT) IS NULL OR venue_beers.updated_at = ?)
         RETURNING ${projection(BEER_COLUMNS)}`,
      ).get<RawRow>(
        id,
        barId,
        beerName,
        normalizedBeerId,
        brewery,
        style,
        abv,
        serveSize,
        price,
        currency,
        booleanBinding(this.database, input.onTap),
        booleanBinding(this.database, input.inStock),
        notes,
        priceVerifiedAt,
        stockVerifiedAt,
        now,
        now,
        expectedUpdatedAt,
        expectedUpdatedAt,
      );
      if (row) return mapBeer(row);
      const existing = await this.getBeer(id);
      if (existing?.barId === barId) {
        throw new OptimisticConcurrencyError("Beer row changed before this update could be saved.");
      }
      if (existing) throw new Error("Beer row belongs to another venue");
      throw new Error("Beer write did not return its persisted row.");
    });
  }

  async deleteBarBeer(input: {
    id: string;
    barId: string;
    expectedUpdatedAt?: string | null | undefined;
  }): Promise<boolean> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    return this.withWriteLock("beer", id, async () => {
      const row = expectedUpdatedAt
        ? await this.database.prepare(
            `DELETE FROM venue_beers
             WHERE id = ? AND venue_id = ? AND updated_at = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId, expectedUpdatedAt)
        : await this.database.prepare(
            `DELETE FROM venue_beers
             WHERE id = ? AND venue_id = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId);
      if (row) return true;
      if (expectedUpdatedAt && await this.getBeer(id)) {
        throw new OptimisticConcurrencyError("Beer row changed before it could be deleted.");
      }
      return false;
    });
  }

  private async getHappyHour(id: string): Promise<BarHappyHour | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(HAPPY_HOUR_COLUMNS, "happy.")}
       FROM venue_happy_hours happy
       WHERE happy.id = ?
       LIMIT 1`,
    ).get<RawRow>(id);
    return row ? mapHappyHour(row) : null;
  }

  async listBarHappyHours(barId: string): Promise<BarHappyHour[]> {
    const normalizedBarId = cleanRequiredText(barId, "barId", MAX_ID_LENGTH);
    const collation = this.binaryCollation();
    const rows = await this.database.prepare(
      `SELECT ${projection(HAPPY_HOUR_COLUMNS, "happy.")}
       FROM venue_happy_hours happy
       WHERE happy.venue_id = ?
       ORDER BY happy.active DESC,
                happy.start_time ASC,
                lower(happy.title) ${collation} ASC,
                happy.title ${collation} ASC,
                happy.id ${collation} ASC`,
    ).all<RawRow>(normalizedBarId);
    return rows.map(mapHappyHour);
  }

  async getBarHappyHourById(id: string): Promise<BarHappyHour | null> {
    return this.getHappyHour(cleanRequiredText(id, "id", MAX_ID_LENGTH));
  }

  async upsertBarHappyHour(input: UpsertBarHappyHourInput): Promise<BarHappyHour> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const title = cleanRequiredText(input.title, "title", MAX_TITLE_LENGTH);
    const daysOfWeek = cleanStringArray(input.daysOfWeek, "daysOfWeek", {
      maximumItems: 7,
      maximumLength: 3,
      allowed: DAYS_OF_WEEK,
    });
    if (daysOfWeek.length === 0) invalidInput("daysOfWeek");
    const startTime = cleanLocalTime(input.startTime, "startTime")!;
    const endTime = cleanLocalTime(input.endTime, "endTime")!;
    const description = cleanRequiredText(input.description, "description", MAX_HAPPY_HOUR_DESCRIPTION_LENGTH);
    const happyHourBeers = cleanHappyHourBeers(input.happyHourBeers);
    if (typeof input.active !== "boolean") invalidInput("active");
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    const requestedNow = validateTimestamp(input.now, "now", "input");
    const now = mutationTimestamp(requestedNow, expectedUpdatedAt);

    return this.withWriteLock("happy-hour", id, async () => {
      const row = await this.database.prepare(
        `INSERT INTO venue_happy_hours (
           id, venue_id, title, days_of_week_json, start_time, end_time, description,
           happy_hour_beers_json, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           days_of_week_json = excluded.days_of_week_json,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           description = excluded.description,
           happy_hour_beers_json = excluded.happy_hour_beers_json,
           active = excluded.active,
           updated_at = excluded.updated_at
         WHERE venue_happy_hours.venue_id = excluded.venue_id
           AND (CAST(? AS TEXT) IS NULL OR venue_happy_hours.updated_at = ?)
         RETURNING ${projection(HAPPY_HOUR_COLUMNS)}`,
      ).get<RawRow>(
        id,
        barId,
        title,
        JSON.stringify(daysOfWeek),
        startTime,
        endTime,
        description,
        JSON.stringify(happyHourBeers),
        booleanBinding(this.database, input.active),
        now,
        now,
        expectedUpdatedAt,
        expectedUpdatedAt,
      );
      if (row) return mapHappyHour(row);
      const existing = await this.getHappyHour(id);
      if (existing?.barId === barId) {
        throw new OptimisticConcurrencyError("Happy hour changed before this update could be saved.");
      }
      if (existing) throw new Error("Happy-hour row belongs to another venue");
      throw new Error("Happy-hour write did not return its persisted row.");
    });
  }

  async deleteBarHappyHour(input: {
    id: string;
    barId: string;
    expectedUpdatedAt?: string | null | undefined;
  }): Promise<boolean> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    return this.withWriteLock("happy-hour", id, async () => {
      const row = expectedUpdatedAt
        ? await this.database.prepare(
            `DELETE FROM venue_happy_hours
             WHERE id = ? AND venue_id = ? AND updated_at = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId, expectedUpdatedAt)
        : await this.database.prepare(
            `DELETE FROM venue_happy_hours
             WHERE id = ? AND venue_id = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId);
      if (row) return true;
      if (expectedUpdatedAt && await this.getHappyHour(id)) {
        throw new OptimisticConcurrencyError("Happy hour changed before it could be deleted.");
      }
      return false;
    });
  }

  private async getSpecial(id: string): Promise<BarSpecial | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(SPECIAL_COLUMNS, "special.")}
       FROM venue_specials special
       WHERE special.id = ?
       LIMIT 1`,
    ).get<RawRow>(id);
    return row ? mapSpecial(row) : null;
  }

  async listBarSpecials(barId: string): Promise<BarSpecial[]> {
    const normalizedBarId = cleanRequiredText(barId, "barId", MAX_ID_LENGTH);
    const collation = this.binaryCollation();
    const rows = await this.database.prepare(
      `SELECT ${projection(SPECIAL_COLUMNS, "special.")}
       FROM venue_specials special
       WHERE special.venue_id = ?
       ORDER BY special.active DESC,
                special.exclusive DESC,
                (special.starts_at IS NULL) ASC,
                special.starts_at DESC,
                lower(special.title) ${collation} ASC,
                special.title ${collation} ASC,
                special.id ${collation} ASC`,
    ).all<RawRow>(normalizedBarId);
    return rows.map(mapSpecial);
  }

  async getBarSpecialById(id: string): Promise<BarSpecial | null> {
    return this.getSpecial(cleanRequiredText(id, "id", MAX_ID_LENGTH));
  }

  async upsertBarSpecial(input: UpsertBarSpecialInput): Promise<BarSpecial> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const title = cleanRequiredText(input.title, "title", MAX_TITLE_LENGTH);
    const description = cleanRequiredText(input.description, "description", MAX_SPECIAL_DESCRIPTION_LENGTH);
    const price = cleanPrice(input.price, "price");
    const discount = cleanOptionalText(input.discount, "discount");
    const savingsAmountCents = cleanFiniteNumber(input.savingsAmountCents ?? null, "savingsAmountCents", {
      minimum: 0,
      maximum: 100_000,
      integer: true,
      nullable: true,
    });
    const startsAt = cleanOptionalTimestamp(input.startsAt, "startsAt");
    const endsAt = cleanOptionalTimestamp(input.endsAt, "endsAt");
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) invalidInput("endsAt");
    const startTime = cleanLocalTime(input.startTime, "startTime", true);
    const endTime = cleanLocalTime(input.endTime, "endTime", true);
    if (startTime && endTime && startTime === endTime) invalidInput("endTime");
    const recurrenceFrequency = input.recurrenceFrequency ?? "none";
    if (recurrenceFrequency !== "none" && recurrenceFrequency !== "weekly") invalidInput("recurrenceFrequency");
    const daysOfWeek = cleanStringArray(input.daysOfWeek ?? [], "daysOfWeek", {
      maximumItems: 7,
      maximumLength: 3,
      allowed: DAYS_OF_WEEK,
    });
    if (recurrenceFrequency === "weekly" && daysOfWeek.length === 0) invalidInput("daysOfWeek");
    const timezone = cleanRequiredText(input.timezone ?? "Australia/Melbourne", "timezone", 80);
    const scheduleNote = cleanOptionalText(input.scheduleNote, "scheduleNote");
    if (typeof input.exclusive !== "boolean" || typeof input.active !== "boolean") invalidInput("special boolean");
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    const requestedNow = validateTimestamp(input.now, "now", "input");
    const now = mutationTimestamp(requestedNow, expectedUpdatedAt);

    return this.withWriteLock("special", id, async () => {
      const row = await this.database.prepare(
        `INSERT INTO venue_specials (
           id, venue_id, title, description, price, discount, savings_amount_cents, starts_at, ends_at,
           start_time, end_time, recurrence_frequency, days_of_week_json, timezone, schedule_note,
           exclusive, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           price = excluded.price,
           discount = excluded.discount,
           savings_amount_cents = excluded.savings_amount_cents,
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           recurrence_frequency = excluded.recurrence_frequency,
           days_of_week_json = excluded.days_of_week_json,
           timezone = excluded.timezone,
           schedule_note = excluded.schedule_note,
           exclusive = excluded.exclusive,
           active = excluded.active,
           updated_at = excluded.updated_at
         WHERE venue_specials.venue_id = excluded.venue_id
           AND (CAST(? AS TEXT) IS NULL OR venue_specials.updated_at = ?)
         RETURNING ${projection(SPECIAL_COLUMNS)}`,
      ).get<RawRow>(
        id,
        barId,
        title,
        description,
        price,
        discount,
        savingsAmountCents,
        startsAt,
        endsAt,
        startTime,
        endTime,
        recurrenceFrequency,
        JSON.stringify(daysOfWeek),
        timezone,
        scheduleNote,
        booleanBinding(this.database, input.exclusive),
        booleanBinding(this.database, input.active),
        now,
        now,
        expectedUpdatedAt,
        expectedUpdatedAt,
      );
      if (row) return mapSpecial(row);
      const existing = await this.getSpecial(id);
      if (existing?.barId === barId) {
        throw new OptimisticConcurrencyError("Special changed before this update could be saved.");
      }
      if (existing) throw new Error("Special row belongs to another venue");
      throw new Error("Special write did not return its persisted row.");
    });
  }

  async deleteBarSpecial(input: {
    id: string;
    barId: string;
    expectedUpdatedAt?: string | null | undefined;
  }): Promise<boolean> {
    const id = cleanRequiredText(input.id, "id", MAX_ID_LENGTH);
    const barId = cleanRequiredText(input.barId, "barId", MAX_ID_LENGTH);
    const expectedUpdatedAt = cleanOptionalTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    return this.withWriteLock("special", id, async () => {
      const row = expectedUpdatedAt
        ? await this.database.prepare(
            `DELETE FROM venue_specials
             WHERE id = ? AND venue_id = ? AND updated_at = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId, expectedUpdatedAt)
        : await this.database.prepare(
            `DELETE FROM venue_specials
             WHERE id = ? AND venue_id = ?
             RETURNING id AS "id"`,
          ).get<{ id: string }>(id, barId);
      if (row) return true;
      if (expectedUpdatedAt && await this.getSpecial(id)) {
        throw new OptimisticConcurrencyError("Special changed before it could be deleted.");
      }
      return false;
    });
  }

  async getLatestVenueBeerTimestamp(input: {
    venueId: string;
    venueIds?: readonly string[] | undefined;
    normalizedBeerId?: string | null | undefined;
    beerNames: readonly string[];
  }): Promise<string | null> {
    const primaryVenueId = cleanRequiredText(input.venueId, "venueId", MAX_ID_LENGTH);
    const requestedVenueIds = input.venueIds?.length ? input.venueIds : [primaryVenueId];
    if (requestedVenueIds.length > MAX_TIMESTAMP_LOOKUP_VENUES) invalidInput("venueIds");
    let venueIds = Array.from(new Set(requestedVenueIds.map((value) =>
      cleanRequiredText(value, "venueIds", MAX_ID_LENGTH))));
    if (venueIds.length === 0) venueIds = [primaryVenueId];
    const normalizedBeerId = cleanOptionalText(input.normalizedBeerId, "normalizedBeerId", MAX_ID_LENGTH);
    if (!Array.isArray(input.beerNames) || input.beerNames.length > MAX_TIMESTAMP_LOOKUP_NAMES) {
      invalidInput("beerNames");
    }
    const names = Array.from(new Set(input.beerNames.map((name) =>
      cleanRequiredText(name, "beerNames", MAX_BEER_NAME_LENGTH).toLowerCase())));
    const clauses: string[] = [];
    const bindings: unknown[] = [...venueIds];
    if (normalizedBeerId) {
      clauses.push("record.normalized_beer_id = ?");
      bindings.push(normalizedBeerId);
    }
    if (names.length) {
      clauses.push(`lower(trim(record.beer_name)) IN (${names.map(() => "?").join(", ")})`);
      bindings.push(...names);
    }
    if (!clauses.length) return null;
    const row = await this.database.prepare(
      `SELECT max(record.last_verified_at) AS "lastVerifiedAt"
       FROM venue_price_records record
       WHERE record.venue_id IN (${venueIds.map(() => "?").join(", ")})
         AND (${clauses.join(" OR ")})`,
    ).get<{ lastVerifiedAt: unknown }>(...bindings);
    if (!row || row.lastVerifiedAt === null) return null;
    return validateTimestamp(row.lastVerifiedAt, "lastVerifiedAt", "record");
  }
}

export const venueInventoryRepositoryLimits = {
  maxHappyHourBeers: MAX_HAPPY_HOUR_BEERS,
  maxReportableProfiles: MAX_REPORTABLE_PROFILES,
  maxTimestampLookupVenues: MAX_TIMESTAMP_LOOKUP_VENUES,
  maxVenueTags: MAX_VENUE_TAGS,
} as const;
