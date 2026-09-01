import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAustralianPostcode,
  normalizeVenueKey,
  normalizeGoogleVenueBusinessStatus,
  shouldImportBarOrPubPlace,
  type GoogleAddressComponent,
  type GooglePlaceCandidate,
  type GoogleVenueBusinessStatus,
} from "../src/lib/venue-directory.js";
import { createServerSupabaseClient } from "../src/lib/supabase-client.js";
import { redactKnownSecretValues } from "../src/lib/redact.js";
import { assertSupabaseServerApiKey } from "../src/lib/supabase-key-format.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import {
  PRODUCTION_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "./validate-production-supabase-transport.js";

const GOOGLE_PLACES_API_URL =
  "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_TEXT_SEARCH_API_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.primaryType",
  "places.types",
].join(",");
const GOOGLE_PLACE_DETAILS_FIELD_MASK = GOOGLE_FIELD_MASK.replaceAll(
  "places.",
  "",
);
const PERMANENT_STAGING_SUPABASE_ORIGIN =
  "https://bbfibbadwjxzrcdncavy.supabase.co";
export const PERMANENT_STAGING_SUPABASE_PROJECT_REF = "bbfibbadwjxzrcdncavy";
export const VENUE_IMPORT_PLAN_SCHEMA =
  "pintpath-permanent-staging-venue-import-plan/v1";
export const VENUE_IMPORT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-venue-import-terminal/v1";
export const VENUE_IMPORT_DATABASE_CONTRACT = Object.freeze({
  migrationVersion: "20260901032339",
  migrationPath:
    "supabase/migrations/20260901032339_validate_external_venue_directory_constraints.sql",
  migrationSha256:
    "5068c2a678813e57fde83b29d3cb5e438ce9070705f246827b7ee8e2a70ee96c",
  migrationBytes: 161,
  validatedConstraints: Object.freeze([
    "venues_australian_postcode_check",
    "venues_business_status_check",
  ]),
});
let loadedSupabaseServiceRoleKey: string | null = null;

const DEFAULT_BOUNDS = {
  minLat: -38.2,
  maxLat: -37.55,
  minLng: 144.55,
  maxLng: 145.3,
};

const DEFAULT_STEP_LAT = 0.09;
const DEFAULT_STEP_LNG = 0.09;
const DEFAULT_RADIUS_METERS = 3200;
const DEFAULT_CITY_RADIUS_METERS = 4500;
const DEFAULT_SUBURB_RADIUS_METERS = 2600;
const DEFAULT_CITY_CENTER = {
  latitude: -37.8136,
  longitude: 144.9631,
};
const DEFAULT_TEXT_SEARCH_PAGE_SIZE = 20;
const DEFAULT_TEXT_SEARCH_MAX_PAGES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const VENUE_MANAGED_SELECT = [
  "id",
  "google_place_id",
  "name",
  "address",
  "suburb",
  "state",
  "postcode",
  "phone",
  "website",
  "latitude",
  "longitude",
  "business_status",
  "last_checked_at",
  "directory_eligible",
  "source",
].join(",");

interface BackfillArea {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

interface TextSearchQuery {
  textQuery: string;
  includedType: "bar" | "pub" | "brewery";
  latitude: number;
  longitude: number;
  radiusMeters: number;
  tag: string;
}

const DEFAULT_CITY_BACKFILL_QUERIES: TextSearchQuery[] = [
  {
    textQuery: "bars in Melbourne CBD",
    includedType: "bar",
    latitude: DEFAULT_CITY_CENTER.latitude,
    longitude: DEFAULT_CITY_CENTER.longitude,
    radiusMeters: DEFAULT_CITY_RADIUS_METERS,
    tag: "Melbourne CBD",
  },
  {
    textQuery: "pubs in Melbourne CBD",
    includedType: "pub",
    latitude: DEFAULT_CITY_CENTER.latitude,
    longitude: DEFAULT_CITY_CENTER.longitude,
    radiusMeters: DEFAULT_CITY_RADIUS_METERS,
    tag: "Melbourne CBD",
  },
  {
    textQuery: "cocktail bars in Melbourne CBD",
    includedType: "bar",
    latitude: DEFAULT_CITY_CENTER.latitude,
    longitude: DEFAULT_CITY_CENTER.longitude,
    radiusMeters: DEFAULT_CITY_RADIUS_METERS,
    tag: "Melbourne CBD",
  },
  {
    textQuery: "rooftop bars in Melbourne CBD",
    includedType: "bar",
    latitude: DEFAULT_CITY_CENTER.latitude,
    longitude: DEFAULT_CITY_CENTER.longitude,
    radiusMeters: DEFAULT_CITY_RADIUS_METERS,
    tag: "Melbourne CBD",
  },
];

const DEFAULT_INNER_RING_BACKFILL_AREAS: BackfillArea[] = [
  {
    name: "Fitzroy",
    latitude: -37.7987,
    longitude: 144.9788,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "Collingwood",
    latitude: -37.8022,
    longitude: 144.9867,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "Richmond",
    latitude: -37.8232,
    longitude: 144.9988,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "Carlton",
    latitude: -37.8005,
    longitude: 144.9669,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "South Yarra",
    latitude: -37.8396,
    longitude: 144.9915,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "St Kilda",
    latitude: -37.8677,
    longitude: 144.9801,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "Brunswick",
    latitude: -37.7682,
    longitude: 144.9629,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "Prahran",
    latitude: -37.8512,
    longitude: 144.9936,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
  {
    name: "South Melbourne",
    latitude: -37.8336,
    longitude: 144.9607,
    radiusMeters: DEFAULT_SUBURB_RADIUS_METERS,
  },
];

export interface VenueRow {
  id: string;
  google_place_id: string | null;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  business_status: GoogleVenueBusinessStatus | null;
  last_checked_at: string | null;
  directory_eligible: boolean | null;
  source: string | null;
}

export interface VenueManagedState {
  google_place_id: string | null;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  business_status: GoogleVenueBusinessStatus | null;
  last_checked_at: string | null;
  directory_eligible: boolean;
  source: string | null;
}

export interface VenueImportTransition {
  ordinal: number;
  operation: "insert" | "update" | "exclude";
  identity: {
    venueId: string | null;
    googlePlaceId: string | null;
    normalizedNameAddressSha256: string;
  };
  expectedBefore: (VenueManagedState & { id: string }) | null;
  desiredAfter: VenueManagedState;
}

export interface VenueImportPlan {
  schemaVersion: typeof VENUE_IMPORT_PLAN_SCHEMA;
  planSha256: string;
  candidateSha: string;
  supabaseProjectRef: typeof PERMANENT_STAGING_SUPABASE_PROJECT_REF;
  databaseContract: typeof VENUE_IMPORT_DATABASE_CONTRACT;
  operation:
    "existing-place-status-refresh" | "directory-discovery-and-status-refresh";
  startedAt: string;
  completedAt: string;
  checkedAt: string;
  inputSnapshot: VenueSnapshot;
  collection: {
    discoveryCellAttemptedCount: number;
    discoveryCellSuccessfulCount: number;
    discoveryCellFailureCount: number;
    discoveryQueryAttemptedCount: number;
    discoveryQuerySuccessfulCount: number;
    discoveryQueryFailureCount: number;
    existingPlaceIdAttemptedCount: number;
    existingPlaceIdSuccessfulCount: number;
    existingPlaceIdFailureCount: number;
    existingPlaceIdSatisfiedByDiscoveryCount: number;
    existingRowMissingPlaceIdCount: number;
    quarantinedVenueCount: number;
  };
  projected: {
    insertCount: number;
    updateCount: number;
    exclusionCount: number;
    totalTransitionCount: number;
  };
  transitions: VenueImportTransition[];
}

export interface VenueSnapshot {
  rowCount: number;
  sha256: string;
}

export interface VenueImportTerminalReceipt {
  schemaVersion: typeof VENUE_IMPORT_TERMINAL_SCHEMA;
  status: "succeeded" | "failed";
  outcome:
    | "applied"
    | "preflight_failed"
    | "partial_write_unretryable"
    | "postflight_failed";
  candidateSha: string;
  supabaseProjectRef: string;
  databaseContract: typeof VENUE_IMPORT_DATABASE_CONTRACT;
  planSha256: string | null;
  startedAt: string;
  completedAt: string;
  preflightSnapshot: VenueSnapshot | null;
  finalSnapshot: VenueSnapshot | null;
  attemptedWriteCount: number;
  successfulWriteCount: number;
  insertedCount: number;
  updatedCount: number;
  excludedCount: number;
  partialWrite: boolean;
  samePlanRetryAllowed: false;
  failure: {
    phase: "input" | "preflight" | "write" | "postflight";
    code: string;
    message: string;
  } | null;
}

export interface VenuePayload {
  google_place_id: string | null;
  name: string;
  address: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  business_status: GoogleVenueBusinessStatus;
  last_checked_at: string;
  directory_eligible: true;
  source: string;
}

export type VenueMappingResult =
  | { outcome: "venue"; venue: VenuePayload }
  | { outcome: "skipped"; reason: "not_eligible" }
  | {
      outcome: "quarantined";
      reason: "invalid_postcode" | "missing_or_invalid_business_status";
      googlePlaceId: string | null;
      venueName: string | null;
    };

export function assertVenueDiscoveryComplete(
  failedCells: readonly string[],
  failedQueries: readonly string[],
): void {
  if (failedCells.length === 0 && failedQueries.length === 0) {
    return;
  }

  throw new Error(
    "Venue discovery was incomplete; refusing to write a partial directory refresh. " +
      `Failed grid cells: ${failedCells.length}. Failed text-search queries: ${failedQueries.length}.`,
  );
}

export function assertVenueStatusRefreshComplete(
  failedGooglePlaceIds: readonly string[],
): void {
  if (failedGooglePlaceIds.length === 0) {
    return;
  }

  throw new Error(
    "Existing venue status refresh was incomplete; refusing to write a directory with stale business statuses. " +
      `Failed Google Place detail checks: ${failedGooglePlaceIds.length}.`,
  );
}

export function assertSupabaseProjectTarget(
  supabaseUrl: string,
  expectedProjectRef: string | undefined,
): string {
  const approved =
    (supabaseUrl === PRODUCTION_SUPABASE_ORIGIN &&
      expectedProjectRef === PRODUCTION_SUPABASE_PROJECT_REF) ||
    (supabaseUrl === PERMANENT_STAGING_SUPABASE_ORIGIN &&
      expectedProjectRef === PERMANENT_STAGING_SUPABASE_PROJECT_REF);
  if (!approved) {
    throw new Error(
      "Supabase importer target mismatch; no configured value is emitted.",
    );
  }
  return expectedProjectRef;
}

interface TextSearchPage {
  places: GooglePlaceCandidate[];
  nextPageToken: string | null;
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  const inlineMatch = args.find((arg) => arg.startsWith(prefix));
  if (inlineMatch) {
    return inlineMatch.slice(prefix.length);
  }
  const flagIndex = args.indexOf(`--${name}`);
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    const value = args[flagIndex + 1];
    return value && !value.startsWith("--") ? value : fallback;
  }
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical JSON only accepts JSON-compatible values.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTimestamp(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Venue snapshot contains an invalid timestamp.");
  }
  return parsed.toISOString();
}

export function normalizeVenueRow(
  row: VenueRow,
): VenueManagedState & { id: string } {
  if (typeof row.directory_eligible !== "boolean") {
    throw new Error(
      "Venue snapshot contains a non-boolean directory eligibility value.",
    );
  }
  return {
    id: row.id,
    google_place_id: row.google_place_id,
    name: row.name,
    address: row.address,
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    phone: row.phone,
    website: row.website,
    latitude: row.latitude,
    longitude: row.longitude,
    business_status: row.business_status,
    last_checked_at: normalizeTimestamp(row.last_checked_at),
    directory_eligible: row.directory_eligible,
    source: row.source,
  };
}

export function snapshotVenueRows(rows: readonly VenueRow[]): VenueSnapshot {
  const normalizedRows = rows
    .map((row) => normalizeVenueRow(row))
    .sort((left, right) => left.id.localeCompare(right.id));
  const uniqueIds = new Set(normalizedRows.map((row) => row.id));
  if (uniqueIds.size !== normalizedRows.length) {
    throw new Error("Venue snapshot contains duplicate row IDs.");
  }
  return {
    rowCount: normalizedRows.length,
    sha256: sha256(canonicalJson(normalizedRows)),
  };
}

function assertCandidateSha(candidateSha: string): void {
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error(
      "Venue import candidate SHA must be exactly 40 lowercase hexadecimal characters.",
    );
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC ISO timestamp.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} has an unexpected shape.`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

async function writeCanonicalJsonFile(
  filePath: string,
  value: JsonValue,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAreaBackfillQueries(areas: BackfillArea[]): TextSearchQuery[] {
  return areas.flatMap((area) => [
    {
      textQuery: `bars in ${area.name} Melbourne`,
      includedType: "bar" as const,
      latitude: area.latitude,
      longitude: area.longitude,
      radiusMeters: area.radiusMeters,
      tag: area.name,
    },
    {
      textQuery: `pubs in ${area.name} Melbourne`,
      includedType: "pub" as const,
      latitude: area.latitude,
      longitude: area.longitude,
      radiusMeters: area.radiusMeters,
      tag: area.name,
    },
    {
      textQuery: `breweries in ${area.name} Melbourne`,
      includedType: "brewery" as const,
      latitude: area.latitude,
      longitude: area.longitude,
      radiusMeters: area.radiusMeters,
      tag: area.name,
    },
  ]);
}

const DEFAULT_INNER_RING_BACKFILL_QUERIES = buildAreaBackfillQueries(
  DEFAULT_INNER_RING_BACKFILL_AREAS,
);

function buildGridCenters() {
  const centers: Array<{ latitude: number; longitude: number }> = [];

  for (
    let lat = DEFAULT_BOUNDS.minLat;
    lat <= DEFAULT_BOUNDS.maxLat;
    lat += DEFAULT_STEP_LAT
  ) {
    for (
      let lng = DEFAULT_BOUNDS.minLng;
      lng <= DEFAULT_BOUNDS.maxLng;
      lng += DEFAULT_STEP_LNG
    ) {
      centers.push({
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
      });
    }
  }

  return centers;
}

function getAddressComponent(
  place: GooglePlaceCandidate,
  wantedTypes: string[],
  preferShort = false,
): string | null {
  for (const component of place.addressComponents ?? []) {
    const types = (component as GoogleAddressComponent).types ?? [];

    if (wantedTypes.some((type) => types.includes(type))) {
      return preferShort
        ? (component.shortText ?? component.longText ?? null)
        : (component.longText ?? component.shortText ?? null);
    }
  }

  return null;
}

function parseAddressFallback(address: string): {
  suburb: string | null;
  state: string | null;
  postcode: string | null;
} {
  const statePostcodeMatch = address.match(
    /\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s+(\d{4})\b/i,
  );
  const state = statePostcodeMatch?.[1]?.toUpperCase() ?? null;
  const postcode = statePostcodeMatch?.[2] ?? null;
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const suburbPart = parts.at(-2) ?? parts[0] ?? "";
  const suburb = suburbPart
    .replace(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b.*$/i, "")
    .replace(/\d{4}/g, "")
    .trim();

  return {
    suburb: suburb || null,
    state,
    postcode,
  };
}

export function mapPlaceToVenue(
  place: GooglePlaceCandidate,
  checkedAt = new Date().toISOString(),
): VenueMappingResult {
  if (!shouldImportBarOrPubPlace(place)) {
    return { outcome: "skipped", reason: "not_eligible" };
  }

  const name = place.displayName?.text?.trim()!;
  const address = place.formattedAddress?.trim() ?? "";
  const googlePlaceId = place.id?.trim() ?? null;
  const businessStatus = normalizeGoogleVenueBusinessStatus(
    place.businessStatus,
  );

  if (!businessStatus) {
    return {
      outcome: "quarantined",
      reason: "missing_or_invalid_business_status",
      googlePlaceId,
      venueName: name || null,
    };
  }

  const fallbackAddress = parseAddressFallback(address);
  const suburb =
    getAddressComponent(place, [
      "locality",
      "postal_town",
      "administrative_area_level_2",
    ]) ?? fallbackAddress.suburb;
  const state =
    getAddressComponent(place, ["administrative_area_level_1"], true) ??
    fallbackAddress.state;
  const structuredPostcode = getAddressComponent(place, ["postal_code"]);
  if (
    structuredPostcode !== null &&
    !isAustralianPostcode(structuredPostcode)
  ) {
    return {
      outcome: "quarantined",
      reason: "invalid_postcode",
      googlePlaceId,
      venueName: name || null,
    };
  }
  const postcode = structuredPostcode ?? fallbackAddress.postcode;

  return {
    outcome: "venue",
    venue: {
      google_place_id: googlePlaceId,
      name,
      address,
      suburb,
      state,
      postcode,
      phone:
        place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
      business_status: businessStatus,
      last_checked_at: checkedAt,
      directory_eligible: true,
      source: "google_places_bar_pub",
    },
  };
}

async function searchNearbyPlaces(
  apiKey: string,
  latitude: number,
  longitude: number,
): Promise<GooglePlaceCandidate[]> {
  const response = await fetch(GOOGLE_PLACES_API_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
    },
    body: JSON.stringify({
      includedPrimaryTypes: ["bar", "pub"],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: {
            latitude,
            longitude,
          },
          radius: DEFAULT_RADIUS_METERS,
        },
      },
      languageCode: "en",
      regionCode: "AU",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Places API error at ${latitude},${longitude}: ${JSON.stringify(payload)}`,
    );
  }

  return Array.isArray(payload.places) ? payload.places : [];
}

async function searchTextPlaces(
  apiKey: string,
  query: TextSearchQuery,
  pageToken?: string,
): Promise<TextSearchPage> {
  const response = await fetch(GOOGLE_TEXT_SEARCH_API_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": `${GOOGLE_FIELD_MASK},nextPageToken`,
    },
    body: JSON.stringify({
      textQuery: query.textQuery,
      includedType: query.includedType,
      strictTypeFiltering: true,
      pageSize: DEFAULT_TEXT_SEARCH_PAGE_SIZE,
      locationBias: {
        circle: {
          center: {
            latitude: query.latitude,
            longitude: query.longitude,
          },
          radius: query.radiusMeters,
        },
      },
      pageToken,
      languageCode: "en",
      regionCode: "AU",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Places Text Search error for "${query.textQuery}": ${JSON.stringify(payload)}`,
    );
  }

  return {
    places: Array.isArray(payload.places) ? payload.places : [],
    nextPageToken:
      typeof payload.nextPageToken === "string" && payload.nextPageToken
        ? payload.nextPageToken
        : null,
  };
}

async function fetchPlaceDetails(
  apiKey: string,
  googlePlaceId: string,
): Promise<GooglePlaceCandidate> {
  const response = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`,
    {
      method: "GET",
      redirect: "error",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_PLACE_DETAILS_FIELD_MASK,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `Google Place details refresh failed with HTTP ${response.status}.`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      "Google Place details refresh returned an invalid payload.",
    );
  }
  return payload as GooglePlaceCandidate;
}

function collectDiscoveredVenue(
  discovered: Map<string, VenuePayload>,
  quarantined: Map<
    string,
    Exclude<VenueMappingResult, { outcome: "venue" | "skipped" }>
  >,
  place: GooglePlaceCandidate,
  checkedAt: string,
) {
  const mapped = mapPlaceToVenue(place, checkedAt);

  if (mapped.outcome === "skipped") {
    return;
  }
  if (mapped.outcome === "quarantined") {
    const quarantineKey =
      mapped.googlePlaceId ??
      `${normalizeVenueKey(mapped.venueName)}|${mapped.reason}`;
    quarantined.set(quarantineKey, mapped);
    return;
  }

  const venue = mapped.venue;

  const dedupeKey =
    venue.google_place_id ??
    `${normalizeVenueKey(venue.name)}|${normalizeVenueKey(venue.address)}`;

  if (!discovered.has(dedupeKey)) {
    discovered.set(dedupeKey, venue);
  }
}

interface VenueExclusionUpdate {
  business_status: GoogleVenueBusinessStatus | null;
  last_checked_at: string;
  directory_eligible: false;
}

export interface BuildVenueImportPlanInput {
  candidateSha: string;
  supabaseProjectRef: string;
  operation: VenueImportPlan["operation"];
  startedAt: string;
  completedAt: string;
  checkedAt: string;
  existingRows: readonly VenueRow[];
  discoveredVenues: readonly VenuePayload[];
  statusOnlyUpdates: ReadonlyMap<string, VenueExclusionUpdate>;
  collection: VenueImportPlan["collection"];
}

function desiredStateFromVenue(venue: VenuePayload): VenueManagedState {
  return {
    google_place_id: venue.google_place_id,
    name: venue.name,
    address: venue.address,
    suburb: venue.suburb,
    state: venue.state,
    postcode: venue.postcode,
    phone: venue.phone,
    website: venue.website,
    latitude: venue.latitude,
    longitude: venue.longitude,
    business_status: venue.business_status,
    last_checked_at: normalizeTimestamp(venue.last_checked_at),
    directory_eligible: true,
    source: venue.source,
  };
}

function transitionIdentity(
  venueId: string | null,
  state: VenueManagedState,
): VenueImportTransition["identity"] {
  return {
    venueId,
    googlePlaceId: state.google_place_id,
    normalizedNameAddressSha256: sha256(
      canonicalJson([
        normalizeVenueKey(state.name),
        normalizeVenueKey(state.address),
      ]),
    ),
  };
}

function planDigest(plan: Omit<VenueImportPlan, "planSha256">): string {
  return sha256(canonicalJson(plan));
}

export function buildVenueImportPlan(
  input: BuildVenueImportPlanInput,
): VenueImportPlan {
  assertCandidateSha(input.candidateSha);
  if (input.supabaseProjectRef !== PERMANENT_STAGING_SUPABASE_PROJECT_REF) {
    throw new Error(
      "Venue import evidence plans are restricted to permanent staging.",
    );
  }
  assertIsoTimestamp(input.startedAt, "Plan start timestamp");
  assertIsoTimestamp(input.completedAt, "Plan completion timestamp");
  assertIsoTimestamp(input.checkedAt, "Venue check timestamp");
  if (Date.parse(input.completedAt) < Date.parse(input.startedAt)) {
    throw new Error("Venue import plan completion cannot precede its start.");
  }
  for (const [key, count] of Object.entries(input.collection)) {
    assertNonNegativeInteger(count, `Collection count ${key}`);
  }
  if (
    input.collection.discoveryCellSuccessfulCount +
      input.collection.discoveryCellFailureCount !==
      input.collection.discoveryCellAttemptedCount ||
    input.collection.discoveryQuerySuccessfulCount +
      input.collection.discoveryQueryFailureCount !==
      input.collection.discoveryQueryAttemptedCount ||
    input.collection.existingPlaceIdSuccessfulCount +
      input.collection.existingPlaceIdFailureCount !==
      input.collection.existingPlaceIdAttemptedCount
  ) {
    throw new Error("Venue import collection attempt counts do not reconcile.");
  }
  if (
    input.collection.discoveryCellFailureCount !== 0 ||
    input.collection.discoveryQueryFailureCount !== 0 ||
    input.collection.existingPlaceIdFailureCount !== 0
  ) {
    throw new Error(
      "Incomplete venue evidence cannot be converted into an apply plan.",
    );
  }

  const existingRows = [...input.existingRows].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const existingPlaceIdCount = existingRows.filter((row) =>
    Boolean(row.google_place_id?.trim()),
  ).length;
  if (
    input.collection.existingPlaceIdAttemptedCount +
      input.collection.existingPlaceIdSatisfiedByDiscoveryCount !==
      existingPlaceIdCount ||
    input.collection.existingRowMissingPlaceIdCount !==
      existingRows.length - existingPlaceIdCount
  ) {
    throw new Error(
      "Existing venue Place-ID collection counts do not reconcile.",
    );
  }
  const byGooglePlaceId = new Map(
    existingRows
      .filter((row) => row.google_place_id)
      .map((row) => [row.google_place_id!, row]),
  );
  const byNameAddress = new Map(
    existingRows.map((row) => [
      `${normalizeVenueKey(row.name)}|${normalizeVenueKey(row.address)}`,
      row,
    ]),
  );
  const discovered = [...input.discoveredVenues].sort((left, right) => {
    const leftKey =
      left.google_place_id ??
      `${normalizeVenueKey(left.name)}|${normalizeVenueKey(left.address)}`;
    const rightKey =
      right.google_place_id ??
      `${normalizeVenueKey(right.name)}|${normalizeVenueKey(right.address)}`;
    return leftKey.localeCompare(rightKey);
  });
  const touchedExistingIds = new Set<string>();
  const transitions: VenueImportTransition[] = [];

  for (const venue of discovered) {
    const existing =
      (venue.google_place_id
        ? byGooglePlaceId.get(venue.google_place_id)
        : undefined) ??
      byNameAddress.get(
        `${normalizeVenueKey(venue.name)}|${normalizeVenueKey(venue.address)}`,
      );
    if (existing && touchedExistingIds.has(existing.id)) {
      throw new Error(
        "Venue plan maps multiple discovered rows to one existing venue.",
      );
    }
    if (existing) {
      touchedExistingIds.add(existing.id);
    }
    const desiredAfter = desiredStateFromVenue(venue);
    transitions.push({
      ordinal: transitions.length + 1,
      operation: existing ? "update" : "insert",
      identity: transitionIdentity(existing?.id ?? null, desiredAfter),
      expectedBefore: existing ? normalizeVenueRow(existing) : null,
      desiredAfter,
    });
  }

  for (const existing of existingRows) {
    if (touchedExistingIds.has(existing.id)) {
      continue;
    }
    const update = input.statusOnlyUpdates.get(existing.id);
    if (!update) {
      throw new Error(
        `Internal importer error: existing venue ${existing.id} has no completed refresh outcome.`,
      );
    }
    const expectedBefore = normalizeVenueRow(existing);
    const { id: _expectedId, ...preservedState } = expectedBefore;
    const desiredAfter: VenueManagedState = {
      ...preservedState,
      business_status: update.business_status,
      last_checked_at: normalizeTimestamp(update.last_checked_at),
      directory_eligible: false,
    };
    transitions.push({
      ordinal: transitions.length + 1,
      operation: "exclude",
      identity: transitionIdentity(existing.id, desiredAfter),
      expectedBefore,
      desiredAfter,
    });
  }

  const projected = {
    insertCount: transitions.filter((item) => item.operation === "insert")
      .length,
    updateCount: transitions.filter((item) => item.operation === "update")
      .length,
    exclusionCount: transitions.filter((item) => item.operation === "exclude")
      .length,
    totalTransitionCount: transitions.length,
  };
  const planWithoutDigest: Omit<VenueImportPlan, "planSha256"> = {
    schemaVersion: VENUE_IMPORT_PLAN_SCHEMA,
    candidateSha: input.candidateSha,
    supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
    databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
    operation: input.operation,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    checkedAt: input.checkedAt,
    inputSnapshot: snapshotVenueRows(existingRows),
    collection: input.collection,
    projected,
    transitions,
  };
  const plan: VenueImportPlan = {
    ...planWithoutDigest,
    planSha256: planDigest(planWithoutDigest),
  };
  return parseVenueImportPlan(`${canonicalJson(plan)}\n`);
}

const MANAGED_STATE_KEYS = [
  "google_place_id",
  "name",
  "address",
  "suburb",
  "state",
  "postcode",
  "phone",
  "website",
  "latitude",
  "longitude",
  "business_status",
  "last_checked_at",
  "directory_eligible",
  "source",
] as const;

function assertNullableString(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null.`);
  }
}

function assertManagedState(
  value: unknown,
  label: string,
  withId: boolean,
): asserts value is VenueManagedState & { id?: string } {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    withId ? ["id", ...MANAGED_STATE_KEYS] : MANAGED_STATE_KEYS,
    label,
  );
  if (withId && (typeof value.id !== "string" || value.id.length === 0)) {
    throw new Error(`${label}.id must be a non-empty string.`);
  }
  assertNullableString(value.google_place_id, `${label}.google_place_id`);
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${label}.name must be a non-empty string.`);
  }
  for (const key of [
    "address",
    "suburb",
    "state",
    "postcode",
    "phone",
    "website",
    "business_status",
    "last_checked_at",
    "source",
  ] as const) {
    assertNullableString(value[key], `${label}.${key}`);
  }
  for (const key of ["latitude", "longitude"] as const) {
    if (
      value[key] !== null &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    ) {
      throw new Error(`${label}.${key} must be a finite number or null.`);
    }
  }
  const businessStatus = value.business_status;
  assertNullableString(businessStatus, `${label}.business_status`);
  if (
    businessStatus !== null &&
    ![
      "OPERATIONAL",
      "CLOSED_TEMPORARILY",
      "CLOSED_PERMANENTLY",
      "FUTURE_OPENING",
    ].includes(businessStatus)
  ) {
    throw new Error(`${label}.business_status is invalid.`);
  }
  const postcode = value.postcode;
  assertNullableString(postcode, `${label}.postcode`);
  if (postcode !== null && !/^[0-9]{4}$/.test(postcode)) {
    throw new Error(`${label}.postcode must be null or exactly four digits.`);
  }
  const lastCheckedAt = value.last_checked_at;
  assertNullableString(lastCheckedAt, `${label}.last_checked_at`);
  if (lastCheckedAt !== null) {
    assertIsoTimestamp(lastCheckedAt, `${label}.last_checked_at`);
  }
  if (typeof value.directory_eligible !== "boolean") {
    throw new Error(`${label}.directory_eligible must be boolean.`);
  }
}

function assertSnapshot(
  value: unknown,
  label: string,
): asserts value is VenueSnapshot {
  assertPlainObject(value, label);
  assertExactKeys(value, ["rowCount", "sha256"], label);
  assertNonNegativeInteger(value.rowCount as number, `${label}.rowCount`);
  assertSha256(value.sha256 as string, `${label}.sha256`);
}

export function parseVenueImportPlan(source: string): VenueImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Venue import plan is not valid JSON.");
  }
  assertPlainObject(parsed, "Venue import plan");
  assertExactKeys(
    parsed,
    [
      "schemaVersion",
      "planSha256",
      "candidateSha",
      "supabaseProjectRef",
      "databaseContract",
      "operation",
      "startedAt",
      "completedAt",
      "checkedAt",
      "inputSnapshot",
      "collection",
      "projected",
      "transitions",
    ],
    "Venue import plan",
  );
  if (parsed.schemaVersion !== VENUE_IMPORT_PLAN_SCHEMA) {
    throw new Error("Venue import plan schema version is invalid.");
  }
  if (typeof parsed.candidateSha !== "string") {
    throw new Error("Venue import plan candidate SHA is invalid.");
  }
  assertCandidateSha(parsed.candidateSha);
  if (parsed.supabaseProjectRef !== PERMANENT_STAGING_SUPABASE_PROJECT_REF) {
    throw new Error("Venue import plan is not bound to permanent staging.");
  }
  if (
    canonicalJson(parsed.databaseContract) !==
    canonicalJson(VENUE_IMPORT_DATABASE_CONTRACT)
  ) {
    throw new Error("Venue import plan database contract is invalid.");
  }
  if (
    ![
      "existing-place-status-refresh",
      "directory-discovery-and-status-refresh",
    ].includes(parsed.operation as string)
  ) {
    throw new Error("Venue import plan operation is invalid.");
  }
  for (const [key, label] of [
    ["startedAt", "Plan start timestamp"],
    ["completedAt", "Plan completion timestamp"],
    ["checkedAt", "Venue check timestamp"],
  ] as const) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`${label} is invalid.`);
    }
    assertIsoTimestamp(parsed[key] as string, label);
  }
  if (
    Date.parse(parsed.completedAt as string) <
    Date.parse(parsed.startedAt as string)
  ) {
    throw new Error("Venue import plan completion cannot precede its start.");
  }
  assertSnapshot(parsed.inputSnapshot, "Venue import plan input snapshot");

  assertPlainObject(parsed.collection, "Venue import plan collection counts");
  const collectionKeys = [
    "discoveryCellAttemptedCount",
    "discoveryCellSuccessfulCount",
    "discoveryCellFailureCount",
    "discoveryQueryAttemptedCount",
    "discoveryQuerySuccessfulCount",
    "discoveryQueryFailureCount",
    "existingPlaceIdAttemptedCount",
    "existingPlaceIdSuccessfulCount",
    "existingPlaceIdFailureCount",
    "existingPlaceIdSatisfiedByDiscoveryCount",
    "existingRowMissingPlaceIdCount",
    "quarantinedVenueCount",
  ] as const;
  assertExactKeys(
    parsed.collection,
    collectionKeys,
    "Venue import plan collection counts",
  );
  for (const key of collectionKeys) {
    assertNonNegativeInteger(
      parsed.collection[key] as number,
      `Venue import plan collection.${key}`,
    );
  }
  if (
    (parsed.collection.discoveryCellSuccessfulCount as number) +
      (parsed.collection.discoveryCellFailureCount as number) !==
      parsed.collection.discoveryCellAttemptedCount ||
    (parsed.collection.discoveryQuerySuccessfulCount as number) +
      (parsed.collection.discoveryQueryFailureCount as number) !==
      parsed.collection.discoveryQueryAttemptedCount ||
    (parsed.collection.existingPlaceIdSuccessfulCount as number) +
      (parsed.collection.existingPlaceIdFailureCount as number) !==
      parsed.collection.existingPlaceIdAttemptedCount ||
    parsed.collection.discoveryCellFailureCount !== 0 ||
    parsed.collection.discoveryQueryFailureCount !== 0 ||
    parsed.collection.existingPlaceIdFailureCount !== 0
  ) {
    throw new Error(
      "Venue import plan collection counts do not prove a complete read.",
    );
  }

  assertPlainObject(parsed.projected, "Venue import plan projected counts");
  const projectedKeys = [
    "insertCount",
    "updateCount",
    "exclusionCount",
    "totalTransitionCount",
  ] as const;
  assertExactKeys(
    parsed.projected,
    projectedKeys,
    "Venue import plan projected counts",
  );
  for (const key of projectedKeys) {
    assertNonNegativeInteger(
      parsed.projected[key] as number,
      `Venue import plan projected.${key}`,
    );
  }
  if (!Array.isArray(parsed.transitions)) {
    throw new Error("Venue import plan transitions must be an array.");
  }
  const existingRows: VenueRow[] = [];
  const venueIds = new Set<string>();
  const identities = new Set<string>();
  const operationCounts = { insert: 0, update: 0, exclude: 0 };
  for (const [index, transitionValue] of parsed.transitions.entries()) {
    const label = `Venue import transition ${index + 1}`;
    assertPlainObject(transitionValue, label);
    assertExactKeys(
      transitionValue,
      ["ordinal", "operation", "identity", "expectedBefore", "desiredAfter"],
      label,
    );
    if (transitionValue.ordinal !== index + 1) {
      throw new Error(`${label} has a non-canonical ordinal.`);
    }
    if (
      !["insert", "update", "exclude"].includes(
        transitionValue.operation as string,
      )
    ) {
      throw new Error(`${label} operation is invalid.`);
    }
    const operation = transitionValue.operation as keyof typeof operationCounts;
    operationCounts[operation] += 1;
    assertPlainObject(transitionValue.identity, `${label} identity`);
    assertExactKeys(
      transitionValue.identity,
      ["venueId", "googlePlaceId", "normalizedNameAddressSha256"],
      `${label} identity`,
    );
    assertNullableString(
      transitionValue.identity.venueId,
      `${label} identity.venueId`,
    );
    assertNullableString(
      transitionValue.identity.googlePlaceId,
      `${label} identity.googlePlaceId`,
    );
    assertSha256(
      transitionValue.identity.normalizedNameAddressSha256 as string,
      `${label} identity.normalizedNameAddressSha256`,
    );
    assertManagedState(
      transitionValue.desiredAfter,
      `${label} desiredAfter`,
      false,
    );
    if (transitionValue.desiredAfter.last_checked_at !== parsed.checkedAt) {
      throw new Error(
        `${label} desiredAfter is not bound to the plan check timestamp.`,
      );
    }
    if (
      transitionValue.identity.googlePlaceId !==
        transitionValue.desiredAfter.google_place_id ||
      transitionValue.identity.normalizedNameAddressSha256 !==
        sha256(
          canonicalJson([
            normalizeVenueKey(transitionValue.desiredAfter.name),
            normalizeVenueKey(transitionValue.desiredAfter.address),
          ]),
        )
    ) {
      throw new Error(`${label} identity does not match desiredAfter.`);
    }
    if (operation === "insert") {
      if (
        transitionValue.identity.venueId !== null ||
        transitionValue.expectedBefore !== null
      ) {
        throw new Error(`${label} insert precondition is invalid.`);
      }
    } else {
      assertManagedState(
        transitionValue.expectedBefore,
        `${label} expectedBefore`,
        true,
      );
      if (
        transitionValue.identity.venueId !==
          transitionValue.expectedBefore.id ||
        venueIds.has(transitionValue.expectedBefore.id as string)
      ) {
        throw new Error(
          `${label} existing row identity is invalid or duplicated.`,
        );
      }
      venueIds.add(transitionValue.expectedBefore.id as string);
      existingRows.push(transitionValue.expectedBefore as VenueRow);
    }
    const identityKey = canonicalJson(transitionValue.identity);
    if (identities.has(identityKey)) {
      throw new Error(`${label} identity is duplicated.`);
    }
    identities.add(identityKey);
  }
  if (
    parsed.projected.insertCount !== operationCounts.insert ||
    parsed.projected.updateCount !== operationCounts.update ||
    parsed.projected.exclusionCount !== operationCounts.exclude ||
    parsed.projected.totalTransitionCount !== parsed.transitions.length ||
    parsed.inputSnapshot.rowCount !== existingRows.length ||
    canonicalJson(parsed.inputSnapshot) !==
      canonicalJson(snapshotVenueRows(existingRows))
  ) {
    throw new Error(
      "Venue import plan counts or input snapshot do not reconcile.",
    );
  }
  const existingPlaceIdCount = existingRows.filter((row) =>
    Boolean(row.google_place_id?.trim()),
  ).length;
  if (
    (parsed.collection.existingPlaceIdAttemptedCount as number) +
      (parsed.collection.existingPlaceIdSatisfiedByDiscoveryCount as number) !==
      existingPlaceIdCount ||
    (parsed.collection.existingRowMissingPlaceIdCount as number) !==
      existingRows.length - existingPlaceIdCount
  ) {
    throw new Error(
      "Venue import plan existing Place-ID counts do not reconcile.",
    );
  }
  if (typeof parsed.planSha256 !== "string") {
    throw new Error("Venue import plan digest is invalid.");
  }
  assertSha256(parsed.planSha256, "Venue import plan digest");
  const { planSha256, ...withoutDigest } = parsed;
  if (
    planSha256 !==
    planDigest(withoutDigest as Omit<VenueImportPlan, "planSha256">)
  ) {
    throw new Error(
      "Venue import plan digest does not match its canonical content.",
    );
  }
  if (source !== `${canonicalJson(parsed)}\n`) {
    throw new Error(
      "Venue import plan file is not exact canonical JSON with one trailing LF.",
    );
  }
  return parsed as unknown as VenueImportPlan;
}

export interface VenueImportApplyAdapter {
  readRows(): Promise<VenueRow[]>;
  insert(desiredAfter: VenueManagedState): Promise<VenueRow>;
  update(
    expectedBefore: VenueManagedState & { id: string },
    desiredAfter: VenueManagedState,
  ): Promise<VenueRow>;
}

function managedStateMatches(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

class VenueApplyFailure extends Error {
  constructor(
    readonly phase: VenueImportTerminalReceipt["failure"] extends infer Failure
      ? Failure extends { phase: infer Phase }
        ? Phase
        : never
      : never,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function applyVenueImportPlan(
  plan: VenueImportPlan,
  adapter: VenueImportApplyAdapter,
  now: () => Date = () => new Date(),
): Promise<VenueImportTerminalReceipt> {
  const startedAt = now().toISOString();
  let preflightSnapshot: VenueSnapshot | null = null;
  let finalSnapshot: VenueSnapshot | null = null;
  let attemptedWriteCount = 0;
  let successfulWriteCount = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let excludedCount = 0;
  let phase: "preflight" | "write" | "postflight" = "preflight";

  const terminal = (
    status: VenueImportTerminalReceipt["status"],
    outcome: VenueImportTerminalReceipt["outcome"],
    failure: VenueImportTerminalReceipt["failure"],
    partialWrite: boolean,
  ): VenueImportTerminalReceipt => ({
    schemaVersion: VENUE_IMPORT_TERMINAL_SCHEMA,
    status,
    outcome,
    candidateSha: plan.candidateSha,
    supabaseProjectRef: plan.supabaseProjectRef,
    databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
    planSha256: plan.planSha256,
    startedAt,
    completedAt: now().toISOString(),
    preflightSnapshot,
    finalSnapshot,
    attemptedWriteCount,
    successfulWriteCount,
    insertedCount,
    updatedCount,
    excludedCount,
    partialWrite,
    samePlanRetryAllowed: false,
    failure,
  });

  try {
    const beforeRows = await adapter.readRows();
    preflightSnapshot = snapshotVenueRows(beforeRows);
    if (!managedStateMatches(preflightSnapshot, plan.inputSnapshot)) {
      throw new VenueApplyFailure(
        "preflight",
        "INPUT_SNAPSHOT_DRIFT",
        "Current venue rows do not match the exact plan input snapshot.",
      );
    }
    const beforeById = new Map(
      beforeRows.map((row) => [row.id, normalizeVenueRow(row)]),
    );
    for (const transition of plan.transitions) {
      if (transition.operation === "insert") {
        continue;
      }
      const current = beforeById.get(transition.identity.venueId!);
      if (
        !current ||
        !managedStateMatches(current, transition.expectedBefore)
      ) {
        throw new VenueApplyFailure(
          "preflight",
          "ROW_PRECONDITION_DRIFT",
          `Venue transition ${transition.ordinal} no longer matches expectedBefore.`,
        );
      }
    }

    const expectedFinalRows = new Map(beforeById);
    phase = "write";
    for (const transition of plan.transitions) {
      attemptedWriteCount += 1;
      const written =
        transition.operation === "insert"
          ? await adapter.insert(transition.desiredAfter)
          : await adapter.update(
              transition.expectedBefore!,
              transition.desiredAfter,
            );
      const normalizedWritten = normalizeVenueRow(written);
      if (
        !managedStateMatches(
          (({ id: _id, ...state }) => state)(normalizedWritten),
          transition.desiredAfter,
        ) ||
        (transition.operation !== "insert" &&
          normalizedWritten.id !== transition.identity.venueId)
      ) {
        throw new VenueApplyFailure(
          "write",
          "WRITE_POSTCONDITION_MISMATCH",
          `Venue transition ${transition.ordinal} did not return desiredAfter.`,
        );
      }
      successfulWriteCount += 1;
      expectedFinalRows.set(normalizedWritten.id, normalizedWritten);
      if (transition.operation === "insert") {
        insertedCount += 1;
      } else if (transition.operation === "update") {
        updatedCount += 1;
      } else {
        excludedCount += 1;
      }
    }

    phase = "postflight";
    const afterRows = await adapter.readRows();
    finalSnapshot = snapshotVenueRows(afterRows);
    const expectedRows = [...expectedFinalRows.values()] as VenueRow[];
    const expectedFinalSnapshot = snapshotVenueRows(expectedRows);
    if (!managedStateMatches(finalSnapshot, expectedFinalSnapshot)) {
      throw new VenueApplyFailure(
        "postflight",
        "FINAL_SNAPSHOT_MISMATCH",
        "Venue rows do not match the exact expected final snapshot.",
      );
    }
    return terminal("succeeded", "applied", null, false);
  } catch (error) {
    const failure =
      error instanceof VenueApplyFailure
        ? error
        : new VenueApplyFailure(
            phase,
            phase === "preflight"
              ? "PREFLIGHT_ERROR"
              : phase === "write"
                ? "WRITE_ERROR"
                : "POSTFLIGHT_ERROR",
            error instanceof Error ? error.message : String(error),
          );
    const partialWrite = attemptedWriteCount > 0 || phase === "postflight";
    return terminal(
      "failed",
      phase === "postflight"
        ? "postflight_failed"
        : partialWrite
          ? "partial_write_unretryable"
          : "preflight_failed",
      {
        phase: failure.phase,
        code: failure.code,
        message: failure.message,
      },
      partialWrite,
    );
  }
}

async function fetchExistingVenues() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  assertSupabaseServerApiKey(supabaseKey, "SUPABASE_SERVICE_ROLE_KEY");
  loadedSupabaseServiceRoleKey = supabaseKey;

  const supabase = createServerSupabaseClient(supabaseUrl, supabaseKey);

  const rows: VenueRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("venues")
      .select(VENUE_MANAGED_SELECT)
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(
        `Failed to fetch existing venues: ${redactKnownSecretValues(
          error.message,
          [supabaseKey],
        )}`,
      );
    }

    const batch = (data ?? []) as unknown as VenueRow[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  return { supabase, rows };
}

function supabaseApplyAdapter(
  supabase: Awaited<ReturnType<typeof fetchExistingVenues>>["supabase"],
): VenueImportApplyAdapter {
  const readRows = async () => (await fetchExistingVenues()).rows;
  return {
    readRows,
    async insert(desiredAfter) {
      const { data, error } = await supabase
        .from("venues")
        .insert(desiredAfter)
        .select(VENUE_MANAGED_SELECT)
        .single();
      if (error || !data) {
        throw new Error(
          `Venue insert failed: ${redactKnownSecretValues(
            error?.message ?? "no row returned",
            [loadedSupabaseServiceRoleKey],
          )}`,
        );
      }
      return data as unknown as VenueRow;
    },
    async update(expectedBefore, desiredAfter) {
      let query = supabase
        .from("venues")
        .update(desiredAfter)
        .eq("id", expectedBefore.id);
      for (const key of MANAGED_STATE_KEYS) {
        const value = expectedBefore[key];
        query = value === null ? query.is(key, null) : query.eq(key, value);
      }
      const { data, error } = await query
        .select(VENUE_MANAGED_SELECT)
        .maybeSingle();
      if (error) {
        throw new Error(
          `Conditional venue update failed: ${redactKnownSecretValues(
            error.message,
            [loadedSupabaseServiceRoleKey],
          )}`,
        );
      }
      if (!data) {
        throw new Error(
          "Conditional venue update matched no exact expected-before row.",
        );
      }
      return data as unknown as VenueRow;
    },
  };
}

async function runApplyMode(): Promise<void> {
  const receiptOutput = getArg("receipt-output");
  if (!receiptOutput) {
    throw new Error(
      "--receipt-output is required for venue import apply mode.",
    );
  }
  const startedAt = new Date().toISOString();
  const candidateSha = getArg("candidate-sha") ?? "";
  const expectedProjectRef =
    getArg(
      "expected-project-ref",
      process.env.PINTPATH_EXPECTED_SUPABASE_PROJECT_REF,
    ) ?? "";
  let receipt: VenueImportTerminalReceipt | null = null;
  let parsedPlan: VenueImportPlan | null = null;
  try {
    for (const incompatible of [
      "dry-run",
      "status-only",
      "city-backfill",
      "city-only",
      "inner-ring-backfill",
      "inner-ring-only",
    ]) {
      if (hasFlag(incompatible)) {
        throw new Error(
          `--${incompatible} cannot be combined with --mode=apply.`,
        );
      }
    }
    if (
      getArg("max-cells") !== undefined ||
      getArg("plan-output") !== undefined
    ) {
      throw new Error(
        "Discovery and plan-output options cannot be combined with --mode=apply.",
      );
    }
    assertCandidateSha(candidateSha);
    if (expectedProjectRef !== PERMANENT_STAGING_SUPABASE_PROJECT_REF) {
      throw new Error(
        "Venue import apply evidence is restricted to permanent staging.",
      );
    }
    const planInput = getArg("plan-input");
    if (!planInput) {
      throw new Error("--plan-input is required for venue import apply mode.");
    }
    const plan = parseVenueImportPlan(await readFile(planInput, "utf8"));
    parsedPlan = plan;
    if (
      plan.candidateSha !== candidateSha ||
      plan.supabaseProjectRef !== expectedProjectRef
    ) {
      throw new Error(
        "Venue import plan does not match the exact apply authority.",
      );
    }
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error("Missing SUPABASE_URL");
    }
    assertSupabaseProjectTarget(supabaseUrl, expectedProjectRef);
    assertOperatorMutationAllowed(
      "Permanent staging venue directory planned apply",
    );
    const { supabase } = await fetchExistingVenues();
    receipt = await applyVenueImportPlan(plan, supabaseApplyAdapter(supabase));
  } catch (error) {
    receipt = {
      schemaVersion: VENUE_IMPORT_TERMINAL_SCHEMA,
      status: "failed",
      outcome: "preflight_failed",
      candidateSha,
      supabaseProjectRef: expectedProjectRef,
      databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
      planSha256: parsedPlan?.planSha256 ?? null,
      startedAt,
      completedAt: new Date().toISOString(),
      preflightSnapshot: null,
      finalSnapshot: null,
      attemptedWriteCount: 0,
      successfulWriteCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      excludedCount: 0,
      partialWrite: false,
      samePlanRetryAllowed: false,
      failure: {
        phase: "input",
        code: "APPLY_INPUT_INVALID",
        message: redactKnownSecretValues(
          error instanceof Error ? error.message : String(error),
          [loadedSupabaseServiceRoleKey],
        ),
      },
    };
  }
  await writeCanonicalJsonFile(receiptOutput, receipt as unknown as JsonValue);
  if (receipt.status === "failed") {
    throw new Error(
      `Venue import apply failed closed (${receipt.failure?.code ?? "UNKNOWN"}); terminal receipt written.`,
    );
  }
}

async function main() {
  const mode = getArg("mode");
  if (mode !== undefined && mode !== "plan" && mode !== "apply") {
    throw new Error("--mode must be either plan or apply.");
  }
  if (mode === "apply") {
    await runApplyMode();
    return;
  }
  const planning = mode === "plan";
  const planStartedAt = new Date().toISOString();
  const dryRun = planning || hasFlag("dry-run");
  if (!dryRun) {
    assertOperatorMutationAllowed("Venue directory import");
  }

  const googleApiKey =
    process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!googleApiKey) {
    throw new Error("Missing GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY");
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Missing SUPABASE_URL");
  }
  const targetProjectRef = assertSupabaseProjectTarget(
    supabaseUrl,
    getArg(
      "expected-project-ref",
      process.env.PINTPATH_EXPECTED_SUPABASE_PROJECT_REF,
    ),
  );
  if (planning && targetProjectRef !== PERMANENT_STAGING_SUPABASE_PROJECT_REF) {
    throw new Error(
      "Venue import evidence plans are restricted to permanent staging.",
    );
  }
  const candidateSha = planning ? getArg("candidate-sha") : undefined;
  const planOutput = planning ? getArg("plan-output") : undefined;
  if (planning && (!candidateSha || !planOutput)) {
    throw new Error(
      "--candidate-sha and --plan-output are required for venue import plan mode.",
    );
  }
  if (planning) {
    assertCandidateSha(candidateSha!);
  }
  const { supabase, rows: existingRows } = await fetchExistingVenues();
  console.log(
    `Pinned Supabase venue-directory target: ${targetProjectRef}. Existing rows: ${existingRows.length}.`,
  );

  const cityBackfill = hasFlag("city-backfill");
  const cityOnly = hasFlag("city-only");
  const innerRingBackfill = hasFlag("inner-ring-backfill");
  const innerRingOnly = hasFlag("inner-ring-only");
  const statusOnly = hasFlag("status-only");
  const maxCellsArg = getArg("max-cells");
  if (
    statusOnly &&
    (cityBackfill ||
      cityOnly ||
      innerRingBackfill ||
      innerRingOnly ||
      maxCellsArg !== undefined)
  ) {
    throw new Error(
      "--status-only cannot be combined with discovery, backfill, or --max-cells options.",
    );
  }
  const maxCells = Number.parseInt(maxCellsArg ?? "", 10);
  const centers = buildGridCenters();
  const cellsToScan =
    statusOnly || cityOnly || innerRingOnly
      ? []
      : Number.isFinite(maxCells) && maxCells > 0
        ? centers.slice(0, maxCells)
        : centers;
  const discovered = new Map<string, VenuePayload>();
  const quarantined = new Map<
    string,
    Exclude<VenueMappingResult, { outcome: "venue" | "skipped" }>
  >();
  const checkedAt = new Date().toISOString();
  const failedCells: string[] = [];
  const failedQueries: string[] = [];
  const failedExistingPlaceIds: string[] = [];
  let successfulCellCount = 0;
  let successfulQueryCount = 0;
  let existingPlaceIdAttemptedCount = 0;
  let existingPlaceIdSuccessfulCount = 0;
  let existingPlaceIdSatisfiedByDiscoveryCount = 0;
  let existingRowMissingPlaceIdCount = 0;
  const statusOnlyUpdates = new Map<
    string,
    {
      business_status: GoogleVenueBusinessStatus | null;
      last_checked_at: string;
      directory_eligible: false;
    }
  >();
  const textBackfillQueries: TextSearchQuery[] = [
    ...(!statusOnly && (cityBackfill || cityOnly)
      ? DEFAULT_CITY_BACKFILL_QUERIES
      : []),
    ...(!statusOnly && (innerRingBackfill || innerRingOnly)
      ? DEFAULT_INNER_RING_BACKFILL_QUERIES
      : []),
  ];

  console.log(
    `Scanning ${cellsToScan.length} Melbourne grid cells for bars and pubs...`,
  );

  for (const [index, center] of cellsToScan.entries()) {
    console.log(
      `Cell ${index + 1}/${cellsToScan.length}: ${center.latitude}, ${center.longitude}`,
    );
    let places: GooglePlaceCandidate[] = [];

    try {
      places = await searchNearbyPlaces(
        googleApiKey,
        center.latitude,
        center.longitude,
      );
      successfulCellCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedCells.push(`${center.latitude},${center.longitude}`);
      console.error(message);
      continue;
    }

    for (const place of places) {
      collectDiscoveredVenue(discovered, quarantined, place, checkedAt);
    }
  }

  if (textBackfillQueries.length > 0) {
    console.log(
      `Running text-search backfill across ${textBackfillQueries.length} queries...`,
    );

    for (const query of textBackfillQueries) {
      console.log(`Backfill query [${query.tag}]: ${query.textQuery}`);
      let pageToken: string | undefined;
      let queryFailed = false;

      for (
        let pageNumber = 1;
        pageNumber <= DEFAULT_TEXT_SEARCH_MAX_PAGES;
        pageNumber += 1
      ) {
        try {
          if (pageToken) {
            await sleep(1500);
          }

          const page = await searchTextPlaces(googleApiKey, query, pageToken);

          for (const place of page.places) {
            collectDiscoveredVenue(discovered, quarantined, place, checkedAt);
          }

          if (!page.nextPageToken) {
            break;
          }

          pageToken = page.nextPageToken;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failedQueries.push(query.textQuery);
          queryFailed = true;
          console.error(message);
          break;
        }
      }
      if (!queryFailed) {
        successfulQueryCount += 1;
      }
    }
  }

  assertVenueDiscoveryComplete(failedCells, failedQueries);

  console.log(
    `Refreshing every existing Google Place ID not already observed by the complete discovery pass...`,
  );
  for (const existing of existingRows) {
    const googlePlaceId = existing.google_place_id?.trim() ?? "";
    if (!googlePlaceId) {
      existingRowMissingPlaceIdCount += 1;
      statusOnlyUpdates.set(existing.id, {
        business_status: null,
        last_checked_at: checkedAt,
        directory_eligible: false,
      });
      continue;
    }
    if (discovered.has(googlePlaceId)) {
      existingPlaceIdSatisfiedByDiscoveryCount += 1;
      continue;
    }

    existingPlaceIdAttemptedCount += 1;
    try {
      const place = {
        ...(await fetchPlaceDetails(googleApiKey, googlePlaceId)),
        id: googlePlaceId,
      };
      existingPlaceIdSuccessfulCount += 1;
      const mapped = mapPlaceToVenue(place, checkedAt);
      if (mapped.outcome === "venue") {
        discovered.set(googlePlaceId, mapped.venue);
        continue;
      }

      statusOnlyUpdates.set(existing.id, {
        business_status: normalizeGoogleVenueBusinessStatus(
          place.businessStatus,
        ),
        last_checked_at: checkedAt,
        directory_eligible: false,
      });
      if (mapped.outcome === "quarantined") {
        quarantined.set(googlePlaceId, mapped);
      }
    } catch (error) {
      failedExistingPlaceIds.push(
        createHash("sha256").update(googlePlaceId).digest("hex").slice(0, 16),
      );
      console.error(
        `Existing venue detail refresh failed for ${existing.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  assertVenueStatusRefreshComplete(failedExistingPlaceIds);

  console.log(
    `Discovered or revalidated ${discovered.size} unique eligible venue candidates.`,
  );
  if (quarantined.size > 0) {
    const reasonCounts = Array.from(quarantined.values()).reduce<
      Record<string, number>
    >((counts, item) => {
      counts[item.reason] = (counts[item.reason] ?? 0) + 1;
      return counts;
    }, {});
    console.warn(
      `Quarantined ${quarantined.size} malformed Google venue rows without publishing them: ${JSON.stringify(reasonCounts)}.`,
    );
  }

  if (planning) {
    const plan = buildVenueImportPlan({
      candidateSha: candidateSha!,
      supabaseProjectRef: targetProjectRef,
      operation: statusOnly
        ? "existing-place-status-refresh"
        : "directory-discovery-and-status-refresh",
      startedAt: planStartedAt,
      completedAt: new Date().toISOString(),
      checkedAt,
      existingRows,
      discoveredVenues: [...discovered.values()],
      statusOnlyUpdates,
      collection: {
        discoveryCellAttemptedCount: cellsToScan.length,
        discoveryCellSuccessfulCount: successfulCellCount,
        discoveryCellFailureCount: failedCells.length,
        discoveryQueryAttemptedCount: textBackfillQueries.length,
        discoveryQuerySuccessfulCount: successfulQueryCount,
        discoveryQueryFailureCount: failedQueries.length,
        existingPlaceIdAttemptedCount,
        existingPlaceIdSuccessfulCount,
        existingPlaceIdFailureCount: failedExistingPlaceIds.length,
        existingPlaceIdSatisfiedByDiscoveryCount,
        existingRowMissingPlaceIdCount,
        quarantinedVenueCount: quarantined.size,
      },
    });
    await writeCanonicalJsonFile(planOutput!, plan as unknown as JsonValue);
    console.log(
      JSON.stringify({
        venueImportPlanWritten: true,
        planSha256: plan.planSha256,
        candidateSha: plan.candidateSha,
        supabaseProjectRef: plan.supabaseProjectRef,
        projected: plan.projected,
      }),
    );
    return;
  }

  const byGooglePlaceId = new Map(
    existingRows
      .filter((row) => row.google_place_id)
      .map((row) => [row.google_place_id!, row]),
  );
  const byNameAddress = new Map(
    existingRows.map((row) => [
      `${normalizeVenueKey(row.name)}|${normalizeVenueKey(row.address)}`,
      row,
    ]),
  );

  let inserted = 0;
  let updated = 0;
  let excluded = 0;
  const touchedExistingIds = new Set<string>();
  const writeFailures: string[] = [];
  const transitions: Array<{
    venueIdHashSha256: string;
    fromBusinessStatus: GoogleVenueBusinessStatus | null;
    toBusinessStatus: GoogleVenueBusinessStatus | null;
    fromDirectoryEligible: boolean | null;
    toDirectoryEligible: boolean;
  }> = [];
  const recordTransition = (
    existing: VenueRow,
    next: {
      business_status: GoogleVenueBusinessStatus | null;
      directory_eligible: boolean;
    },
  ) => {
    transitions.push({
      venueIdHashSha256: createHash("sha256").update(existing.id).digest("hex"),
      fromBusinessStatus: existing.business_status,
      toBusinessStatus: next.business_status,
      fromDirectoryEligible: existing.directory_eligible,
      toDirectoryEligible: next.directory_eligible,
    });
  };

  for (const venue of discovered.values()) {
    const existing =
      (venue.google_place_id
        ? byGooglePlaceId.get(venue.google_place_id)
        : undefined) ??
      byNameAddress.get(
        `${normalizeVenueKey(venue.name)}|${normalizeVenueKey(venue.address)}`,
      );
    if (existing) {
      touchedExistingIds.add(existing.id);
      recordTransition(existing, venue);
    }

    if (dryRun) {
      console.log(
        `${existing ? "Would update" : "Would insert"}: ${venue.name}`,
      );
      continue;
    }

    if (existing) {
      const { error } = await supabase
        .from("venues")
        .update(venue)
        .eq("id", existing.id);

      if (error) {
        console.error(
          `Update failed for ${venue.name}: ${redactKnownSecretValues(
            error.message,
            [loadedSupabaseServiceRoleKey],
          )}`,
        );
        writeFailures.push(`update:${existing.id}`);
        continue;
      }

      updated += 1;
      continue;
    }

    const { error } = await supabase.from("venues").insert(venue);

    if (error) {
      console.error(
        `Insert failed for ${venue.name}: ${redactKnownSecretValues(
          error.message,
          [loadedSupabaseServiceRoleKey],
        )}`,
      );
      writeFailures.push(`insert:${venue.google_place_id ?? venue.name}`);
      continue;
    }

    inserted += 1;
  }

  for (const existing of existingRows) {
    if (touchedExistingIds.has(existing.id)) {
      continue;
    }
    const update = statusOnlyUpdates.get(existing.id);
    if (!update) {
      throw new Error(
        `Internal importer error: existing venue ${existing.id} has no completed refresh outcome.`,
      );
    }
    recordTransition(existing, update);
    if (dryRun) {
      console.log(`Would exclude or keep excluded: ${existing.name}`);
      continue;
    }
    const { error } = await supabase
      .from("venues")
      .update(update)
      .eq("id", existing.id);
    if (error) {
      console.error(
        `Fail-closed status update failed for ${existing.name}: ${redactKnownSecretValues(
          error.message,
          [loadedSupabaseServiceRoleKey],
        )}`,
      );
      writeFailures.push(`exclude:${existing.id}`);
      continue;
    }
    excluded += 1;
  }

  if (writeFailures.length > 0) {
    throw new Error(
      `Venue import completed with ${writeFailures.length} failed database write(s); the run is not successful and must be rerun.`,
    );
  }

  const transitionSummary = transitions.reduce<Record<string, number>>(
    (counts, item) => {
      const key =
        `${item.fromDirectoryEligible === true ? "eligible" : "excluded"}:${item.fromBusinessStatus ?? "UNKNOWN"}` +
        `->${item.toDirectoryEligible ? "eligible" : "excluded"}:${item.toBusinessStatus ?? "UNKNOWN"}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const manifest = {
    schemaVersion: 1,
    checkedAt,
    mode: dryRun ? "dry-run" : "write",
    operation: statusOnly
      ? "existing-place-status-refresh"
      : "directory-discovery-and-status-refresh",
    supabaseProjectRef: targetProjectRef,
    existingVenueCount: existingRows.length,
    eligibleVenueCount: discovered.size,
    quarantinedVenueCount: quarantined.size,
    failedDiscoveryCellCount: failedCells.length,
    failedDiscoveryQueryCount: failedQueries.length,
    failedExistingPlaceDetailCount: failedExistingPlaceIds.length,
    failedWriteCount: writeFailures.length,
    transitionSummary,
    transitions,
  };
  const manifestJson = JSON.stringify(manifest);
  console.log(
    JSON.stringify({
      venueDirectoryTransitionManifest: manifest,
      manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
    }),
  );

  console.log(
    dryRun
      ? "Dry run complete."
      : `Venue import complete. Inserted: ${inserted}. Updated: ${updated}. Excluded/rechecked: ${excluded}.`,
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main()
    .catch((error) => {
      console.error(
        redactKnownSecretValues(
          error instanceof Error ? error.message : String(error),
          [loadedSupabaseServiceRoleKey],
        ),
      );
      process.exitCode = 1;
    })
    .finally(() => {
      loadedSupabaseServiceRoleKey = null;
    });
}
