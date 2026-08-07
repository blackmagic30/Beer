import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

type CheckStatus = "pass" | "fail" | "unknown";
type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://pintpath.au";
const VENUE_PAGE_SIZE = 250;
const PRICE_PAGE_SIZE = 500;
const MAX_VENUE_ROWS = 5_000;
const MAX_PRICE_ROWS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;
const TRUSTED_CONFIDENCE = new Set([
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
]);
const CLOSED_BUSINESS_STATUSES = new Set([
  "closed",
  "closed_permanently",
  "closed_temporarily",
  "permanently_closed",
  "temporarily_closed",
]);

interface PublicVenue {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  active?: boolean;
  businessStatus?: string | null;
  business_status?: string | null;
  lastCheckedAt?: string | null;
  last_checked_at?: string | null;
}

interface PublicPriceRecord {
  id: string;
  venueId: string;
  displayKind: string | null;
  isHappyHourPrice: boolean;
  confidence: string;
  sourceType: string;
  sourceSubmissionId: string | null;
  lastVerifiedAt: string;
  priceVerifiedAt: string | null;
  hasSourceLinkage?: boolean;
  hasSourceEvidence?: boolean;
  hasEvidence?: boolean;
}

interface CollectionResult<T> {
  rows: T[];
  pages: number;
  complete: boolean;
  truncated: boolean;
  consistent: boolean;
  reportedTotal: number | null;
}

export interface DataReadinessConfig {
  baseUrl: string;
  strict: boolean;
  marketedSuburbs: string[];
  minimumMarketedVenueCoveragePercent: number;
  minimumCurrentPricesPerVenue: number;
  maximumCoreFreshnessHours: number;
  maximumVenueStatusAgeHours: number;
  maximumTrustedRowAgeDays: number;
  minimumHappyHourCoveragePercent: number;
  noHappyHourLaunchScope: boolean;
  noHappyHourScopeReferenceProvided: boolean;
}

interface DataReadinessCheck {
  id: string;
  status: CheckStatus;
  blockingInStrictMode: true;
  detail: string;
  observed: number | string | boolean | null;
  threshold: number | string | null;
}

export interface ProductionDataReadinessReport {
  schemaVersion: 1;
  ok: boolean;
  mode: "observe" | "strict";
  generatedAt: string;
  source: {
    baseOrigin: string;
    readOnly: true;
    publicApisOnly: true;
    bounded: true;
    venueRowLimit: number;
    priceRowLimit: number;
  };
  thresholds: {
    marketedSuburbScopeMode: "configured" | "all_nonblank_public_directory";
    configuredMarketedSuburbCount: number;
    configuredMarketedSuburbScopeHashSha256: string | null;
    minimumMarketedVenueCoveragePercent: number;
    minimumCurrentPricesPerVenue: number;
    maximumCoreFreshnessHours: number;
    maximumVenueStatusAgeHours: number;
    maximumTrustedRowAgeDays: number;
    minimumHappyHourCoveragePercent: number;
    documentedNoHappyHourScopeEnabled: boolean;
    documentedNoHappyHourScopeReferenceProvided: boolean;
  };
  metrics: {
    collection: {
      complete: boolean;
      venuePages: number;
      pricePages: number;
      venueRows: number;
      priceRows: number;
      venueReportedTotal: number | null;
      venueTruncated: boolean;
      priceTruncated: boolean;
    };
    marketedSuburbScope: {
      configured: boolean;
      configuredSuburbCount: number;
      directorySuburbCount: number;
      matchedSuburbCount: number;
      missingConfiguredSuburbCount: number;
      marketedSuburbCount: number;
      scopeHashSha256: string | null;
      missingConfiguredScopeHashSha256: string | null;
    };
    venues: {
      publicDirectoryVenueCount: number;
      marketedVenueCount: number;
      duplicateIdRows: number;
      malformedDirectoryRows: number;
      malformedStructuredAddresses: number;
      businessStatusKnownCount: number;
      statusLastCheckedKnownCount: number;
      invalidStatusLastCheckedCount: number;
      staleStatusCount: number;
      closedActiveVenueCount: number;
      explicitlyInactivePublishedVenueCount: number;
    };
    prices: {
      uniqueCurrentRowCount: number;
      duplicateIdRows: number;
      trustedRowCount: number;
      trustedRowsWithInvalidVerificationTime: number;
      trustedRowsOlderThanMaximum: number;
      qualifyingCurrentVerifiedPriceRows: number;
      orphanQualifyingPriceRows: number;
    };
    marketedVenuePriceCoverage: {
      coveredVenueCount: number;
      coveragePercent: number;
    };
    marketedSuburbPriceCoverage: {
      evaluatedSuburbCount: number;
      passingSuburbCount: number;
      failingSuburbCount: number;
      minimumCoveragePercent: number | null;
    };
    trustedEvidence: {
      eligibleNonManagerRowCount: number;
      publiclyLinkedRowCount: number;
      publicLinkageCoveragePercent: number;
      evidencePresenceInferableRowCount: number;
      evidencePresentRowCount: number;
      evidencePresenceCoveragePercent: number | null;
    };
    freshness: {
      newestCoreVerifiedAt: string | null;
      newestCoreAgeHours: number | null;
      oldestTrustedVerifiedAt: string | null;
      oldestTrustedAgeDays: number | null;
    };
    happyHours: {
      coveredVenueCount: number;
      coveragePercent: number;
    };
  };
  checks: DataReadinessCheck[];
  summary: {
    passed: number;
    failed: number;
    unknown: number;
    strictBlockingIssues: number;
    strictReleaseReady: boolean;
    processExitCode: 0 | 1;
  };
}

export type ReadinessFetch = typeof fetch;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized || null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function coveragePercentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : percentage(numerator, denominator);
}

function finiteAge(nowMs: number, timestamp: string): { ageMs: number; timestampMs: number } | null {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs + FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return null;
  }
  return { ageMs: Math.max(0, nowMs - timestampMs), timestampMs };
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function normalizedSuburb(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizedSuburbs(values: string[]): string[] {
  return [...new Set(values.map(normalizedSuburb).filter(Boolean))].sort();
}

function suburbScopeHash(suburbs: string[]): string | null {
  if (suburbs.length === 0) return null;
  return createHash("sha256")
    .update(JSON.stringify([...suburbs].sort()))
    .digest("hex");
}

function numberSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { minimum: number; maximum: number; integer?: boolean },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed)
    || parsed < bounds.minimum
    || parsed > bounds.maximum
    || (bounds.integer && !Number.isInteger(parsed))
  ) {
    throw new Error(
      `${name} must be ${bounds.integer ? "an integer" : "a number"} between ${bounds.minimum} and ${bounds.maximum}.`,
    );
  }
  return parsed;
}

function normalizedBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !["", "/"].includes(parsed.pathname)) {
    throw new Error("PINTPATH_DATA_BASE_URL must be an HTTPS origin (HTTP is allowed only for localhost).");
  }
  return parsed.origin;
}

export function resolveDataReadinessConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
): DataReadinessConfig {
  const scopeReference = env.PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE?.trim() ?? "";
  return {
    baseUrl: normalizedBaseUrl(env.PINTPATH_DATA_BASE_URL?.trim() || DEFAULT_BASE_URL),
    strict: parseBoolean(env.PINTPATH_DATA_STRICT) || args.includes("--strict"),
    marketedSuburbs: normalizedSuburbs(
      (env.PINTPATH_DATA_MARKETED_SUBURBS ?? "").split(","),
    ),
    minimumMarketedVenueCoveragePercent: numberSetting(
      env,
      "PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT",
      70,
      { minimum: 70, maximum: 100 },
    ),
    minimumCurrentPricesPerVenue: numberSetting(
      env,
      "PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE",
      3,
      { minimum: 3, maximum: 20, integer: true },
    ),
    maximumCoreFreshnessHours: numberSetting(
      env,
      "PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS",
      48,
      { minimum: 1, maximum: 48 },
    ),
    maximumVenueStatusAgeHours: numberSetting(
      env,
      "PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS",
      168,
      { minimum: 1, maximum: 168 },
    ),
    maximumTrustedRowAgeDays: numberSetting(
      env,
      "PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS",
      30,
      { minimum: 1, maximum: 30 },
    ),
    minimumHappyHourCoveragePercent: numberSetting(
      env,
      "PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT",
      25,
      { minimum: 25, maximum: 100 },
    ),
    noHappyHourLaunchScope: parseBoolean(env.PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE),
    noHappyHourScopeReferenceProvided: scopeReference.length >= 8,
  };
}

async function fetchPublicJson(fetchImpl: ReadinessFetch, url: URL, label: string): Promise<JsonObject> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned unreadable JSON.`);
  }
  if (!isObject(payload) || payload.ok !== true || !isObject(payload.data)) {
    throw new Error(`${label} returned an unexpected public API envelope.`);
  }
  return payload.data;
}

function publicVenue(value: unknown): PublicVenue | null {
  if (!isObject(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id || !name) return null;
  const active = typeof value.active === "boolean" ? value.active : undefined;
  return {
    id,
    name,
    address: nullableString(value.address),
    suburb: nullableString(value.suburb),
    state: nullableString(value.state),
    postcode: nullableString(value.postcode),
    latitude: nullableNumber(value.latitude),
    longitude: nullableNumber(value.longitude),
    ...(active === undefined ? {} : { active }),
    ...(value.businessStatus !== undefined ? { businessStatus: nullableString(value.businessStatus) } : {}),
    ...(value.business_status !== undefined ? { business_status: nullableString(value.business_status) } : {}),
    ...(value.lastCheckedAt !== undefined ? { lastCheckedAt: nullableString(value.lastCheckedAt) } : {}),
    ...(value.last_checked_at !== undefined ? { last_checked_at: nullableString(value.last_checked_at) } : {}),
  };
}

function publicPriceRecord(value: unknown): PublicPriceRecord | null {
  if (!isObject(value)) return null;
  const id = stringValue(value.id);
  const venueId = stringValue(value.venueId);
  const confidence = stringValue(value.confidence).toLowerCase();
  const sourceType = stringValue(value.sourceType).toLowerCase();
  const lastVerifiedAt = stringValue(value.lastVerifiedAt);
  if (!id || !venueId || !confidence || !sourceType || !lastVerifiedAt) return null;
  const hasSourceEvidence = typeof value.hasSourceEvidence === "boolean"
    ? value.hasSourceEvidence
    : undefined;
  const hasEvidence = typeof value.hasEvidence === "boolean"
    ? value.hasEvidence
    : undefined;
  return {
    id,
    venueId,
    displayKind: nullableString(value.displayKind)?.toLowerCase() ?? null,
    isHappyHourPrice: value.isHappyHourPrice === true,
    confidence,
    sourceType,
    sourceSubmissionId: nullableString(value.sourceSubmissionId),
    lastVerifiedAt,
    priceVerifiedAt: nullableString(value.priceVerifiedAt),
    ...(typeof value.hasSourceLinkage === "boolean"
      ? { hasSourceLinkage: value.hasSourceLinkage }
      : {}),
    ...(hasSourceEvidence === undefined ? {} : { hasSourceEvidence }),
    ...(hasEvidence === undefined ? {} : { hasEvidence }),
  };
}

async function collectVenues(fetchImpl: ReadinessFetch, baseUrl: string): Promise<CollectionResult<PublicVenue>> {
  const rows: PublicVenue[] = [];
  let offset = 0;
  let pages = 0;
  let complete = false;
  let truncated = false;
  let consistent = true;
  let reportedTotal: number | null = null;

  while (rows.length < MAX_VENUE_ROWS) {
    const url = new URL("/api/business/venues", baseUrl);
    url.searchParams.set("limit", String(VENUE_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const data = await fetchPublicJson(fetchImpl, url, "Venue directory");
    pages += 1;
    const rawRows = Array.isArray(data.venues) ? data.venues : null;
    const pagination = isObject(data.pagination) ? data.pagination : null;
    if (!rawRows || !pagination) {
      throw new Error("Venue directory returned an invalid pagination contract.");
    }
    const parsedRows = rawRows.map(publicVenue);
    consistent = consistent && parsedRows.every((row) => row !== null);
    const validRows = parsedRows.filter((row): row is PublicVenue => row !== null);
    const pageTotal = typeof pagination.total === "number" && Number.isInteger(pagination.total)
      ? pagination.total
      : null;
    if (reportedTotal === null) {
      reportedTotal = pageTotal;
    } else if (pageTotal !== null && pageTotal !== reportedTotal) {
      consistent = false;
    }
    const remaining = MAX_VENUE_ROWS - rows.length;
    rows.push(...validRows.slice(0, remaining));
    if (validRows.length > remaining) {
      truncated = true;
      break;
    }
    const hasMore = pagination.hasMore === true;
    if (!hasMore) {
      complete = true;
      break;
    }
    if (rawRows.length === 0) {
      consistent = false;
      break;
    }
    offset += rawRows.length;
  }

  if (!complete && rows.length >= MAX_VENUE_ROWS) truncated = true;
  if (reportedTotal !== null && complete && reportedTotal !== rows.length) consistent = false;
  return { rows, pages, complete, truncated, consistent, reportedTotal };
}

async function collectPrices(fetchImpl: ReadinessFetch, baseUrl: string): Promise<CollectionResult<PublicPriceRecord>> {
  const rows: PublicPriceRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let complete = false;
  let truncated = false;
  let consistent = true;

  while (rows.length < MAX_PRICE_ROWS) {
    const url = new URL("/api/business/price-records", baseUrl);
    url.searchParams.set("limit", String(PRICE_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = await fetchPublicJson(fetchImpl, url, "Current price records");
    pages += 1;
    const rawRows = Array.isArray(data.records) ? data.records : null;
    if (!rawRows) {
      throw new Error("Current price records returned an invalid pagination contract.");
    }
    const parsedRows = rawRows.map(publicPriceRecord);
    consistent = consistent && parsedRows.every((row) => row !== null);
    const validRows = parsedRows.filter((row): row is PublicPriceRecord => row !== null);
    const remaining = MAX_PRICE_ROWS - rows.length;
    rows.push(...validRows.slice(0, remaining));
    if (validRows.length > remaining) {
      truncated = true;
      break;
    }
    const nextCursor = nullableString(data.nextCursor);
    if (!nextCursor) {
      complete = true;
      break;
    }
    if (rawRows.length === 0 || seenCursors.has(nextCursor)) {
      consistent = false;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!complete && rows.length >= MAX_PRICE_ROWS) truncated = true;
  return { rows, pages, complete, truncated, consistent, reportedTotal: null };
}

function structuredAddressIsMalformed(venue: PublicVenue): boolean {
  const addressOk = Boolean(venue.address && venue.address.length >= 5);
  const suburbOk = Boolean(venue.suburb && venue.suburb.length >= 2);
  const stateOk = Boolean(venue.state && /^[A-Za-z][A-Za-z .'-]{1,29}$/.test(venue.state));
  const postcodeOk = Boolean(venue.postcode && /^\d{4}$/.test(venue.postcode));
  const coordinatesAbsent = venue.latitude === null && venue.longitude === null;
  const coordinatesValid = venue.latitude !== null
    && venue.longitude !== null
    && venue.latitude >= -90
    && venue.latitude <= 90
    && venue.longitude >= -180
    && venue.longitude <= 180;
  return !(addressOk && suburbOk && stateOk && postcodeOk && (coordinatesAbsent || coordinatesValid));
}

function evidencePresence(record: PublicPriceRecord): boolean | null {
  if (typeof record.hasSourceEvidence === "boolean") return record.hasSourceEvidence;
  if (typeof record.hasEvidence === "boolean") return record.hasEvidence;
  return null;
}

function isManagerRecord(record: PublicPriceRecord): boolean {
  return record.sourceType.startsWith("venue_manager_portal");
}

function isTrusted(record: PublicPriceRecord): boolean {
  return TRUSTED_CONFIDENCE.has(record.confidence);
}

function isBeerPrice(record: PublicPriceRecord): boolean {
  return record.displayKind !== "special"
    && record.displayKind !== "happy_hour"
    && !record.isHappyHourPrice;
}

function statusKnown(venue: PublicVenue): string | null {
  return nullableString(venue.businessStatus ?? venue.business_status)?.toLowerCase() ?? null;
}

function statusLastChecked(venue: PublicVenue): string | null {
  return nullableString(venue.lastCheckedAt ?? venue.last_checked_at);
}

function check(
  id: string,
  status: CheckStatus,
  detail: string,
  observed: number | string | boolean | null,
  threshold: number | string | null,
): DataReadinessCheck {
  return { id, status, blockingInStrictMode: true, detail, observed, threshold };
}

function zeroDefectsStatus(defects: number, proofComplete: boolean): CheckStatus {
  if (defects > 0) return "fail";
  return proofComplete ? "pass" : "unknown";
}

export async function runProductionDataReadiness(input: {
  config: DataReadinessConfig;
  fetchImpl?: ReadinessFetch;
  now?: Date;
}): Promise<ProductionDataReadinessReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("The readiness evaluation time is invalid.");

  const venuesCollection = await collectVenues(fetchImpl, input.config.baseUrl);
  const pricesCollection = await collectPrices(fetchImpl, input.config.baseUrl);
  const collectionComplete = venuesCollection.complete
    && venuesCollection.consistent
    && !venuesCollection.truncated
    && pricesCollection.complete
    && pricesCollection.consistent
    && !pricesCollection.truncated;

  const venuesById = new Map<string, PublicVenue>();
  let duplicateVenueIdRows = 0;
  for (const venue of venuesCollection.rows) {
    if (venuesById.has(venue.id)) {
      duplicateVenueIdRows += 1;
    } else {
      venuesById.set(venue.id, venue);
    }
  }
  const malformedDirectoryRows = venuesCollection.rows.length - venuesById.size - duplicateVenueIdRows;
  const venues = [...venuesById.values()];
  const malformedStructuredAddresses = venues.filter(structuredAddressIsMalformed).length;
  const businessStatusKnownCount = venues.filter((venue) => statusKnown(venue) !== null).length;
  const maximumVenueStatusAgeMs = input.config.maximumVenueStatusAgeHours * 60 * 60 * 1_000;
  const venueStatusAges = venues.map((venue) => {
    const timestamp = statusLastChecked(venue);
    return { timestamp, age: timestamp ? finiteAge(nowMs, timestamp) : null };
  });
  const statusLastCheckedKnownCount = venueStatusAges.filter(({ timestamp }) => timestamp !== null).length;
  const invalidStatusLastCheckedCount = venueStatusAges.filter(
    ({ timestamp, age }) => timestamp !== null && age === null,
  ).length;
  const staleStatusCount = venueStatusAges.filter(
    ({ age }) => age !== null && age.ageMs > maximumVenueStatusAgeMs,
  ).length;
  const closedActiveVenueCount = venues.filter((venue) => {
    const status = statusKnown(venue);
    return venue.active !== false && status !== null && CLOSED_BUSINESS_STATUSES.has(status);
  }).length;
  const explicitlyInactivePublishedVenueCount = venues.filter((venue) => venue.active === false).length;

  const directoryVenueIdsBySuburb = new Map<string, string[]>();
  for (const venue of venues) {
    const suburb = normalizedSuburb(venue.suburb ?? "");
    if (!suburb) continue;
    const venueIds = directoryVenueIdsBySuburb.get(suburb) ?? [];
    venueIds.push(venue.id);
    directoryVenueIdsBySuburb.set(suburb, venueIds);
  }
  const directorySuburbs = [...directoryVenueIdsBySuburb.keys()].sort();
  const configuredSuburbs = normalizedSuburbs(input.config.marketedSuburbs);
  const configuredSuburbScope = configuredSuburbs.length > 0;
  const missingConfiguredSuburbs = configuredSuburbScope
    ? configuredSuburbs.filter((suburb) => !directoryVenueIdsBySuburb.has(suburb))
    : [];
  const marketedSuburbs = configuredSuburbScope
    ? configuredSuburbs.filter((suburb) => directoryVenueIdsBySuburb.has(suburb))
    : directorySuburbs;
  const marketedVenueIds = new Set(
    marketedSuburbs.flatMap((suburb) => directoryVenueIdsBySuburb.get(suburb) ?? []),
  );
  const marketedVenues = venues.filter((venue) => marketedVenueIds.has(venue.id));

  const priceById = new Map<string, PublicPriceRecord>();
  let duplicatePriceIdRows = 0;
  for (const record of pricesCollection.rows) {
    if (priceById.has(record.id)) {
      duplicatePriceIdRows += 1;
    } else {
      priceById.set(record.id, record);
    }
  }
  const prices = [...priceById.values()];
  const trustedRows = prices.filter(isTrusted);
  const maximumTrustedAgeMs = input.config.maximumTrustedRowAgeDays * 24 * 60 * 60 * 1_000;
  const trustedAges = trustedRows.map((record) => ({
    record,
    age: finiteAge(nowMs, record.lastVerifiedAt),
  }));
  const invalidTrustedTimestampCount = trustedAges.filter(({ age }) => age === null).length;
  const trustedRowsOlderThanMaximum = trustedAges.filter(
    ({ age }) => age !== null && age.ageMs > maximumTrustedAgeMs,
  ).length;
  const currentTrustedRows = trustedAges.filter(
    (item): item is { record: PublicPriceRecord; age: { ageMs: number; timestampMs: number } } =>
      item.age !== null && item.age.ageMs <= maximumTrustedAgeMs,
  );

  const qualifyingPrices: Array<{ record: PublicPriceRecord; verifiedAtMs: number }> = [];
  for (const { record } of currentTrustedRows) {
    if (!isBeerPrice(record)) continue;
    const verificationTimestamp = isManagerRecord(record)
      ? record.priceVerifiedAt
      : record.lastVerifiedAt;
    if (!verificationTimestamp) continue;
    const age = finiteAge(nowMs, verificationTimestamp);
    if (!age || age.ageMs > maximumTrustedAgeMs) continue;
    qualifyingPrices.push({ record, verifiedAtMs: age.timestampMs });
  }

  const qualifyingPricesByVenue = new Map<string, number>();
  let orphanQualifyingPriceRows = 0;
  for (const { record } of qualifyingPrices) {
    if (!venuesById.has(record.venueId)) {
      orphanQualifyingPriceRows += 1;
      continue;
    }
    qualifyingPricesByVenue.set(record.venueId, (qualifyingPricesByVenue.get(record.venueId) ?? 0) + 1);
  }
  const venuesWithMinimumPrices = marketedVenues.filter(
    (venue) => (qualifyingPricesByVenue.get(venue.id) ?? 0) >= input.config.minimumCurrentPricesPerVenue,
  ).length;
  const marketedVenueCoveragePercent = percentage(venuesWithMinimumPrices, marketedVenues.length);
  const suburbPriceCoverage = marketedSuburbs.map((suburb) => {
    const venueIds = directoryVenueIdsBySuburb.get(suburb) ?? [];
    const coveredVenueCount = venueIds.filter(
      (venueId) => (qualifyingPricesByVenue.get(venueId) ?? 0) >= input.config.minimumCurrentPricesPerVenue,
    ).length;
    return {
      coveragePercent: percentage(coveredVenueCount, venueIds.length),
    };
  });
  const passingSuburbCount = suburbPriceCoverage.filter(
    (item) => item.coveragePercent >= input.config.minimumMarketedVenueCoveragePercent,
  ).length;
  const failingSuburbCount = suburbPriceCoverage.length - passingSuburbCount;
  const minimumSuburbCoveragePercent = suburbPriceCoverage.length === 0
    ? null
    : Math.min(...suburbPriceCoverage.map((item) => item.coveragePercent));

  const evidenceEligibleRows = currentTrustedRows
    .map(({ record }) => record)
    .filter((record) => !isManagerRecord(record));
  const publiclyLinkedEvidenceRows = evidenceEligibleRows.filter(
    (record) => record.sourceSubmissionId !== null || record.hasSourceLinkage === true,
  ).length;
  const inferredEvidenceRows = evidenceEligibleRows
    .map((record) => evidencePresence(record))
    .filter((value): value is boolean => value !== null);
  const evidencePresentRows = inferredEvidenceRows.filter(Boolean).length;
  const evidencePresenceCoveragePercent = inferredEvidenceRows.length === evidenceEligibleRows.length
    ? coveragePercentage(evidencePresentRows, evidenceEligibleRows.length)
    : null;

  const newestCoreVerifiedAtMs = qualifyingPrices
    .filter(({ record }) => marketedVenueIds.has(record.venueId))
    .reduce<number | null>(
    (latest, item) => latest === null || item.verifiedAtMs > latest ? item.verifiedAtMs : latest,
    null,
  );
  const oldestTrustedVerifiedAtMs = trustedAges.reduce<number | null>((oldest, item) => {
    if (!item.age) return oldest;
    return oldest === null || item.age.timestampMs < oldest ? item.age.timestampMs : oldest;
  }, null);
  const newestCoreAgeHours = newestCoreVerifiedAtMs === null
    ? null
    : Number(((nowMs - newestCoreVerifiedAtMs) / (60 * 60 * 1_000)).toFixed(2));
  const oldestTrustedAgeDays = oldestTrustedVerifiedAtMs === null
    ? null
    : Number(((nowMs - oldestTrustedVerifiedAtMs) / (24 * 60 * 60 * 1_000)).toFixed(2));

  const happyHourVenueIds = new Set(
    currentTrustedRows
      .map(({ record }) => record)
      .filter((record) => record.displayKind === "happy_hour" || record.isHappyHourPrice)
      .map((record) => record.venueId)
      .filter((venueId) => marketedVenueIds.has(venueId)),
  );
  const happyHourCoveragePercent = percentage(happyHourVenueIds.size, marketedVenues.length);

  const checks: DataReadinessCheck[] = [
    check(
      "public_api_collection_complete",
      collectionComplete ? "pass" : "unknown",
      collectionComplete
        ? "Every bounded venue and current-price page completed with a stable pagination contract."
        : "At least one public collection was truncated, incomplete, or pagination-inconsistent; partial rates are not release evidence.",
      collectionComplete,
      "complete",
    ),
    check(
      "marketed_suburb_scope_resolved",
      !collectionComplete
        ? "unknown"
        : missingConfiguredSuburbs.length > 0 || marketedSuburbs.length === 0
          ? "fail"
          : "pass",
      !collectionComplete
        ? "The public directory collection is incomplete, so the configured marketed-suburb scope cannot be proved."
        : missingConfiguredSuburbs.length > 0
          ? "At least one configured marketed suburb is absent from the complete public directory. Only aggregate counts and deterministic scope hashes are reported."
          : marketedSuburbs.length === 0
            ? "No nonblank public-directory suburb is available for the marketed launch scope."
            : configuredSuburbScope
              ? "Every configured marketed suburb resolves case-insensitively to the complete public directory."
              : "Every nonblank suburb in the complete public directory is included in the marketed launch scope.",
      missingConfiguredSuburbs.length,
      0,
    ),
    check(
      "marketed_venue_ids_unique",
      zeroDefectsStatus(duplicateVenueIdRows, collectionComplete),
      "The marketed venue denominator must not contain duplicate IDs.",
      duplicateVenueIdRows,
      0,
    ),
    check(
      "marketed_venue_directory_rows_valid",
      zeroDefectsStatus(malformedDirectoryRows, collectionComplete),
      "Every counted venue must expose a non-empty public ID and name.",
      malformedDirectoryRows,
      0,
    ),
    check(
      "structured_addresses_valid",
      zeroDefectsStatus(malformedStructuredAddresses, collectionComplete),
      "Public structured addresses require address, suburb, state, four-digit postcode, and either no coordinates or a valid coordinate pair.",
      malformedStructuredAddresses,
      0,
    ),
    check(
      "closed_active_venues_absent",
      closedActiveVenueCount > 0
        ? "fail"
        : collectionComplete && businessStatusKnownCount === venues.length
          ? "pass"
          : "unknown",
      closedActiveVenueCount > 0
        ? "The public directory contains a marketed venue explicitly marked closed."
        : businessStatusKnownCount === venues.length
          ? "Every marketed venue exposes a public business status and none is closed."
          : "The public venue API does not expose business status for every marketed venue, so closed-active venue absence cannot be proved.",
      closedActiveVenueCount,
      0,
    ),
    check(
      "venue_business_status_freshness",
      invalidStatusLastCheckedCount > 0 || staleStatusCount > 0
        ? "fail"
        : collectionComplete && statusLastCheckedKnownCount === venues.length
          ? "pass"
          : "unknown",
      invalidStatusLastCheckedCount > 0
        ? "At least one published venue has an invalid or future business-status check timestamp."
        : staleStatusCount > 0
          ? `At least one published venue business status is older than ${input.config.maximumVenueStatusAgeHours} hours.`
          : statusLastCheckedKnownCount === venues.length
            ? "Every published venue exposes a current business-status check timestamp."
            : "The public venue API does not expose a business-status check timestamp for every published venue.",
      invalidStatusLastCheckedCount + staleStatusCount,
      0,
    ),
    check(
      "inactive_venues_not_marketed",
      zeroDefectsStatus(explicitlyInactivePublishedVenueCount, collectionComplete),
      "A venue explicitly marked inactive must not remain in the marketed public directory.",
      explicitlyInactivePublishedVenueCount,
      0,
    ),
    check(
      "current_price_ids_unique",
      zeroDefectsStatus(duplicatePriceIdRows, collectionComplete),
      "Cursor pagination must not return duplicate current-price IDs.",
      duplicatePriceIdRows,
      0,
    ),
    check(
      "qualifying_prices_reference_marketed_venues",
      zeroDefectsStatus(orphanQualifyingPriceRows, collectionComplete),
      "Every qualifying current verified price must resolve to a marketed venue.",
      orphanQualifyingPriceRows,
      0,
    ),
    check(
      "trusted_verification_timestamps_valid",
      zeroDefectsStatus(invalidTrustedTimestampCount, collectionComplete),
      "Every trusted public row must have a parseable, non-future verification timestamp.",
      invalidTrustedTimestampCount,
      0,
    ),
    check(
      "marketed_venue_price_coverage",
      !collectionComplete
        ? "unknown"
        : missingConfiguredSuburbs.length > 0
          ? "unknown"
          : marketedVenues.length > 0
          && marketedVenueCoveragePercent >= input.config.minimumMarketedVenueCoveragePercent
          ? "pass"
          : "fail",
      `Aggregate share of scoped marketed venues with at least ${input.config.minimumCurrentPricesPerVenue} trusted beer prices verified within ${input.config.maximumTrustedRowAgeDays} days. This aggregate does not replace the every-suburb check.`,
      marketedVenueCoveragePercent,
      input.config.minimumMarketedVenueCoveragePercent,
    ),
    check(
      "every_marketed_suburb_price_coverage",
      !collectionComplete || missingConfiguredSuburbs.length > 0
        ? "unknown"
        : marketedSuburbs.length > 0 && failingSuburbCount === 0
          ? "pass"
          : "fail",
      `Every marketed suburb must independently have at least ${input.config.minimumMarketedVenueCoveragePercent}% of its venues covered by ${input.config.minimumCurrentPricesPerVenue} current verified beer prices. The report emits only aggregate counts and scope hashes.`,
      minimumSuburbCoveragePercent,
      input.config.minimumMarketedVenueCoveragePercent,
    ),
    check(
      "trusted_non_manager_evidence_linkage",
      !collectionComplete
        ? "unknown"
        : evidenceEligibleRows.length === 0 || publiclyLinkedEvidenceRows === evidenceEligibleRows.length
          ? "pass"
          : "fail",
      "Every current trusted non-manager row must expose either an opaque source linkage attestation or a source-submission linkage. This proves linkage only, not that private evidence bytes still exist.",
      coveragePercentage(publiclyLinkedEvidenceRows, evidenceEligibleRows.length),
      100,
    ),
    check(
      "trusted_non_manager_evidence_presence",
      !collectionComplete
        ? "unknown"
        : evidenceEligibleRows.length === 0
          ? "pass"
          : inferredEvidenceRows.length < evidenceEligibleRows.length
            ? "unknown"
            : evidencePresentRows === evidenceEligibleRows.length
              ? "pass"
              : "fail",
      evidenceEligibleRows.length === 0
        ? "There are no current trusted non-manager rows requiring public evidence confirmation."
        : inferredEvidenceRows.length < evidenceEligibleRows.length
          ? "The public price API does not expose evidence-presence metadata for every current trusted non-manager row; private evidence existence cannot be proved."
          : "Public evidence-presence metadata is available for every current trusted non-manager row.",
      evidencePresenceCoveragePercent,
      100,
    ),
    check(
      "core_data_freshness",
      !collectionComplete || missingConfiguredSuburbs.length > 0
        ? "unknown"
        : newestCoreAgeHours !== null && newestCoreAgeHours <= input.config.maximumCoreFreshnessHours
          ? "pass"
          : "fail",
      "The newest qualifying core beer-price verification must be recent enough to prove the core feed is moving.",
      newestCoreAgeHours,
      input.config.maximumCoreFreshnessHours,
    ),
    check(
      "trusted_rows_within_maximum_age",
      zeroDefectsStatus(trustedRowsOlderThanMaximum, collectionComplete),
      "No row still labelled trusted may be older than the maximum trusted-row age.",
      trustedRowsOlderThanMaximum,
      0,
    ),
    check(
      "happy_hour_coverage_or_documented_scope",
      !collectionComplete || missingConfiguredSuburbs.length > 0
        ? "unknown"
        : input.config.noHappyHourLaunchScope && !input.config.noHappyHourScopeReferenceProvided
          ? "fail"
          : happyHourCoveragePercent >= input.config.minimumHappyHourCoveragePercent
            || (input.config.noHappyHourLaunchScope && input.config.noHappyHourScopeReferenceProvided)
            ? "pass"
            : "fail",
      input.config.noHappyHourLaunchScope
        ? input.config.noHappyHourScopeReferenceProvided
          ? "Happy-hour coverage is waived only for the explicitly enabled launch scope with a documented reference."
          : "The no-happy-hour launch escape is enabled without a documented scope reference."
        : "Share of marketed venues with a trusted happy-hour row verified within the maximum trusted-row age.",
      happyHourCoveragePercent,
      input.config.noHappyHourLaunchScope
        ? "documented launch scope"
        : input.config.minimumHappyHourCoveragePercent,
    ),
  ];

  const passed = checks.filter((item) => item.status === "pass").length;
  const failed = checks.filter((item) => item.status === "fail").length;
  const unknown = checks.filter((item) => item.status === "unknown").length;
  const strictBlockingIssues = failed + unknown;
  const strictReleaseReady = strictBlockingIssues === 0;

  return {
    schemaVersion: 1,
    ok: strictReleaseReady,
    mode: input.config.strict ? "strict" : "observe",
    generatedAt: now.toISOString(),
    source: {
      baseOrigin: new URL(input.config.baseUrl).origin,
      readOnly: true,
      publicApisOnly: true,
      bounded: true,
      venueRowLimit: MAX_VENUE_ROWS,
      priceRowLimit: MAX_PRICE_ROWS,
    },
    thresholds: {
      marketedSuburbScopeMode: configuredSuburbScope
        ? "configured"
        : "all_nonblank_public_directory",
      configuredMarketedSuburbCount: configuredSuburbs.length,
      configuredMarketedSuburbScopeHashSha256: suburbScopeHash(configuredSuburbs),
      minimumMarketedVenueCoveragePercent: input.config.minimumMarketedVenueCoveragePercent,
      minimumCurrentPricesPerVenue: input.config.minimumCurrentPricesPerVenue,
      maximumCoreFreshnessHours: input.config.maximumCoreFreshnessHours,
      maximumVenueStatusAgeHours: input.config.maximumVenueStatusAgeHours,
      maximumTrustedRowAgeDays: input.config.maximumTrustedRowAgeDays,
      minimumHappyHourCoveragePercent: input.config.minimumHappyHourCoveragePercent,
      documentedNoHappyHourScopeEnabled: input.config.noHappyHourLaunchScope,
      documentedNoHappyHourScopeReferenceProvided: input.config.noHappyHourScopeReferenceProvided,
    },
    metrics: {
      collection: {
        complete: collectionComplete,
        venuePages: venuesCollection.pages,
        pricePages: pricesCollection.pages,
        venueRows: venuesCollection.rows.length,
        priceRows: pricesCollection.rows.length,
        venueReportedTotal: venuesCollection.reportedTotal,
        venueTruncated: venuesCollection.truncated,
        priceTruncated: pricesCollection.truncated,
      },
      marketedSuburbScope: {
        configured: configuredSuburbScope,
        configuredSuburbCount: configuredSuburbs.length,
        directorySuburbCount: directorySuburbs.length,
        matchedSuburbCount: marketedSuburbs.length,
        missingConfiguredSuburbCount: missingConfiguredSuburbs.length,
        marketedSuburbCount: marketedSuburbs.length,
        scopeHashSha256: suburbScopeHash(marketedSuburbs),
        missingConfiguredScopeHashSha256: suburbScopeHash(missingConfiguredSuburbs),
      },
      venues: {
        publicDirectoryVenueCount: venues.length,
        marketedVenueCount: marketedVenues.length,
        duplicateIdRows: duplicateVenueIdRows,
        malformedDirectoryRows,
        malformedStructuredAddresses,
        businessStatusKnownCount,
        statusLastCheckedKnownCount,
        invalidStatusLastCheckedCount,
        staleStatusCount,
        closedActiveVenueCount,
        explicitlyInactivePublishedVenueCount,
      },
      prices: {
        uniqueCurrentRowCount: prices.length,
        duplicateIdRows: duplicatePriceIdRows,
        trustedRowCount: trustedRows.length,
        trustedRowsWithInvalidVerificationTime: invalidTrustedTimestampCount,
        trustedRowsOlderThanMaximum,
        qualifyingCurrentVerifiedPriceRows: qualifyingPrices.length,
        orphanQualifyingPriceRows,
      },
      marketedVenuePriceCoverage: {
        coveredVenueCount: venuesWithMinimumPrices,
        coveragePercent: marketedVenueCoveragePercent,
      },
      marketedSuburbPriceCoverage: {
        evaluatedSuburbCount: suburbPriceCoverage.length,
        passingSuburbCount,
        failingSuburbCount,
        minimumCoveragePercent: minimumSuburbCoveragePercent,
      },
      trustedEvidence: {
        eligibleNonManagerRowCount: evidenceEligibleRows.length,
        publiclyLinkedRowCount: publiclyLinkedEvidenceRows,
        publicLinkageCoveragePercent: coveragePercentage(publiclyLinkedEvidenceRows, evidenceEligibleRows.length),
        evidencePresenceInferableRowCount: inferredEvidenceRows.length,
        evidencePresentRowCount: evidencePresentRows,
        evidencePresenceCoveragePercent,
      },
      freshness: {
        newestCoreVerifiedAt: newestCoreVerifiedAtMs === null ? null : new Date(newestCoreVerifiedAtMs).toISOString(),
        newestCoreAgeHours,
        oldestTrustedVerifiedAt: oldestTrustedVerifiedAtMs === null ? null : new Date(oldestTrustedVerifiedAtMs).toISOString(),
        oldestTrustedAgeDays,
      },
      happyHours: {
        coveredVenueCount: happyHourVenueIds.size,
        coveragePercent: happyHourCoveragePercent,
      },
    },
    checks,
    summary: {
      passed,
      failed,
      unknown,
      strictBlockingIssues,
      strictReleaseReady,
      processExitCode: input.config.strict && !strictReleaseReady ? 1 : 0,
    },
  };
}

async function main(): Promise<void> {
  const config = resolveDataReadinessConfig();
  try {
    const report = await runProductionDataReadiness({ config });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.summary.processExitCode;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown public data-readiness error.";
    const failedReport = {
      schemaVersion: 1,
      ok: false,
      mode: config.strict ? "strict" : "observe",
      generatedAt: new Date().toISOString(),
      source: {
        baseOrigin: new URL(config.baseUrl).origin,
        readOnly: true,
        publicApisOnly: true,
        bounded: true,
      },
      checks: [{
        id: "public_api_collection_complete",
        status: "unknown",
        blockingInStrictMode: true,
        detail,
      }],
      summary: {
        strictBlockingIssues: 1,
        strictReleaseReady: false,
        processExitCode: config.strict ? 1 : 0,
      },
    };
    process.stdout.write(`${JSON.stringify(failedReport, null, 2)}\n`);
    process.exitCode = config.strict ? 1 : 0;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await main();
}
