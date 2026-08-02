import "dotenv/config";

import { createHash } from "node:crypto";
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
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

const GOOGLE_PLACES_API_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_TEXT_SEARCH_API_URL = "https://places.googleapis.com/v1/places:searchText";
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
const GOOGLE_PLACE_DETAILS_FIELD_MASK = GOOGLE_FIELD_MASK.replaceAll("places.", "");

const DEFAULT_BOUNDS = {
  minLat: -38.20,
  maxLat: -37.55,
  minLng: 144.55,
  maxLng: 145.30,
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
  { name: "Fitzroy", latitude: -37.7987, longitude: 144.9788, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "Collingwood", latitude: -37.8022, longitude: 144.9867, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "Richmond", latitude: -37.8232, longitude: 144.9988, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "Carlton", latitude: -37.8005, longitude: 144.9669, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "South Yarra", latitude: -37.8396, longitude: 144.9915, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "St Kilda", latitude: -37.8677, longitude: 144.9801, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "Brunswick", latitude: -37.7682, longitude: 144.9629, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "Prahran", latitude: -37.8512, longitude: 144.9936, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
  { name: "South Melbourne", latitude: -37.8336, longitude: 144.9607, radiusMeters: DEFAULT_SUBURB_RADIUS_METERS },
];

interface VenueRow {
  id: string;
  google_place_id: string | null;
  name: string;
  address: string | null;
  business_status: GoogleVenueBusinessStatus | null;
  last_checked_at: string | null;
  directory_eligible: boolean | null;
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

export function assertVenueStatusRefreshComplete(failedGooglePlaceIds: readonly string[]): void {
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
  const normalizedExpected = expectedProjectRef?.trim().toLowerCase() ?? "";
  if (!normalizedExpected) {
    throw new Error(
      "Missing --expected-project-ref (or PINTPATH_EXPECTED_SUPABASE_PROJECT_REF); refusing an unpinned venue-directory operation.",
    );
  }

  let actualProjectRef: string;
  try {
    const hostname = new URL(supabaseUrl).hostname.toLowerCase();
    actualProjectRef = hostname.endsWith(".supabase.co")
      ? hostname.slice(0, -".supabase.co".length)
      : "";
  } catch {
    actualProjectRef = "";
  }
  if (!actualProjectRef || actualProjectRef !== normalizedExpected) {
    throw new Error(
      `Supabase project target mismatch. Expected ${normalizedExpected}; SUPABASE_URL resolves to ${actualProjectRef || "an unsupported host"}.`,
    );
  }
  return actualProjectRef;
}

interface TextSearchPage {
  places: GooglePlaceCandidate[];
  nextPageToken: string | null;
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
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

const DEFAULT_INNER_RING_BACKFILL_QUERIES = buildAreaBackfillQueries(DEFAULT_INNER_RING_BACKFILL_AREAS);

function buildGridCenters() {
  const centers: Array<{ latitude: number; longitude: number }> = [];

  for (let lat = DEFAULT_BOUNDS.minLat; lat <= DEFAULT_BOUNDS.maxLat; lat += DEFAULT_STEP_LAT) {
    for (let lng = DEFAULT_BOUNDS.minLng; lng <= DEFAULT_BOUNDS.maxLng; lng += DEFAULT_STEP_LNG) {
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
      return preferShort ? component.shortText ?? component.longText ?? null : component.longText ?? component.shortText ?? null;
    }
  }

  return null;
}

function parseAddressFallback(address: string): { suburb: string | null; state: string | null; postcode: string | null } {
  const statePostcodeMatch = address.match(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s+(\d{4})\b/i);
  const state = statePostcodeMatch?.[1]?.toUpperCase() ?? null;
  const postcode = statePostcodeMatch?.[2] ?? null;
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
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
  const businessStatus = normalizeGoogleVenueBusinessStatus(place.businessStatus);

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
    getAddressComponent(place, ["locality", "postal_town", "administrative_area_level_2"]) ??
    fallbackAddress.suburb;
  const state =
    getAddressComponent(place, ["administrative_area_level_1"], true) ??
    fallbackAddress.state;
  const structuredPostcode = getAddressComponent(place, ["postal_code"]);
  if (structuredPostcode !== null && !isAustralianPostcode(structuredPostcode)) {
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
      phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
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

async function searchNearbyPlaces(apiKey: string, latitude: number, longitude: number): Promise<GooglePlaceCandidate[]> {
  const response = await fetch(GOOGLE_PLACES_API_URL, {
    method: "POST",
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
    throw new Error(`Google Places API error at ${latitude},${longitude}: ${JSON.stringify(payload)}`);
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
    throw new Error(`Google Places Text Search error for "${query.textQuery}": ${JSON.stringify(payload)}`);
  }

  return {
    places: Array.isArray(payload.places) ? payload.places : [],
    nextPageToken: typeof payload.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : null,
  };
}

async function fetchPlaceDetails(apiKey: string, googlePlaceId: string): Promise<GooglePlaceCandidate> {
  const response = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`,
    {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_PLACE_DETAILS_FIELD_MASK,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Google Place details refresh failed with HTTP ${response.status}.`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Google Place details refresh returned an invalid payload.");
  }
  return payload as GooglePlaceCandidate;
}

function collectDiscoveredVenue(
  discovered: Map<string, VenuePayload>,
  quarantined: Map<string, Exclude<VenueMappingResult, { outcome: "venue" | "skipped" }>>,
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

async function fetchExistingVenues() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createServerSupabaseClient(supabaseUrl, supabaseKey);

  const rows: VenueRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("venues")
      .select("id, google_place_id, name, address, business_status, last_checked_at, directory_eligible")
      .range(from, to);

    if (error) {
      throw new Error(`Failed to fetch existing venues: ${error.message}`);
    }

    const batch = (data ?? []) as VenueRow[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  return { supabase, rows };
}

async function main() {
  const dryRun = hasFlag("dry-run");
  if (!dryRun) {
    assertOperatorMutationAllowed("Venue directory import");
  }

  const googleApiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!googleApiKey) {
    throw new Error("Missing GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY");
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Missing SUPABASE_URL");
  }
  const targetProjectRef = assertSupabaseProjectTarget(
    supabaseUrl,
    getArg("expected-project-ref", process.env.PINTPATH_EXPECTED_SUPABASE_PROJECT_REF),
  );
  const { supabase, rows: existingRows } = await fetchExistingVenues();
  console.log(`Pinned Supabase venue-directory target: ${targetProjectRef}. Existing rows: ${existingRows.length}.`);

  const cityBackfill = hasFlag("city-backfill");
  const cityOnly = hasFlag("city-only");
  const innerRingBackfill = hasFlag("inner-ring-backfill");
  const innerRingOnly = hasFlag("inner-ring-only");
  const statusOnly = hasFlag("status-only");
  const maxCellsArg = getArg("max-cells");
  if (
    statusOnly &&
    (cityBackfill || cityOnly || innerRingBackfill || innerRingOnly || maxCellsArg !== undefined)
  ) {
    throw new Error(
      "--status-only cannot be combined with discovery, backfill, or --max-cells options.",
    );
  }
  const maxCells = Number.parseInt(maxCellsArg ?? "", 10);
  const centers = buildGridCenters();
  const cellsToScan = statusOnly || cityOnly || innerRingOnly
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
  const statusOnlyUpdates = new Map<
    string,
    {
      business_status: GoogleVenueBusinessStatus | null;
      last_checked_at: string;
      directory_eligible: false;
    }
  >();
  const textBackfillQueries: TextSearchQuery[] = [
    ...(!statusOnly && (cityBackfill || cityOnly) ? DEFAULT_CITY_BACKFILL_QUERIES : []),
    ...(!statusOnly && (innerRingBackfill || innerRingOnly)
      ? DEFAULT_INNER_RING_BACKFILL_QUERIES
      : []),
  ];

  console.log(`Scanning ${cellsToScan.length} Melbourne grid cells for bars and pubs...`);

  for (const [index, center] of cellsToScan.entries()) {
    console.log(`Cell ${index + 1}/${cellsToScan.length}: ${center.latitude}, ${center.longitude}`);
    let places: GooglePlaceCandidate[] = [];

    try {
      places = await searchNearbyPlaces(googleApiKey, center.latitude, center.longitude);
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
    console.log(`Running text-search backfill across ${textBackfillQueries.length} queries...`);

    for (const query of textBackfillQueries) {
      console.log(`Backfill query [${query.tag}]: ${query.textQuery}`);
      let pageToken: string | undefined;

      for (let pageNumber = 1; pageNumber <= DEFAULT_TEXT_SEARCH_MAX_PAGES; pageNumber += 1) {
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
          const message = error instanceof Error ? error.message : String(error);
          failedQueries.push(query.textQuery);
          console.error(message);
          break;
        }
      }
    }
  }

  assertVenueDiscoveryComplete(failedCells, failedQueries);

  console.log(`Refreshing every existing Google Place ID not already observed by the complete discovery pass...`);
  for (const existing of existingRows) {
    const googlePlaceId = existing.google_place_id?.trim() ?? "";
    if (!googlePlaceId) {
      statusOnlyUpdates.set(existing.id, {
        business_status: null,
        last_checked_at: checkedAt,
        directory_eligible: false,
      });
      continue;
    }
    if (discovered.has(googlePlaceId)) {
      continue;
    }

    try {
      const place = {
        ...(await fetchPlaceDetails(googleApiKey, googlePlaceId)),
        id: googlePlaceId,
      };
      const mapped = mapPlaceToVenue(place, checkedAt);
      if (mapped.outcome === "venue") {
        discovered.set(googlePlaceId, mapped.venue);
        continue;
      }

      statusOnlyUpdates.set(existing.id, {
        business_status: normalizeGoogleVenueBusinessStatus(place.businessStatus),
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

  console.log(`Discovered or revalidated ${discovered.size} unique eligible venue candidates.`);
  if (quarantined.size > 0) {
    const reasonCounts = Array.from(quarantined.values()).reduce<Record<string, number>>((counts, item) => {
      counts[item.reason] = (counts[item.reason] ?? 0) + 1;
      return counts;
    }, {});
    console.warn(
      `Quarantined ${quarantined.size} malformed Google venue rows without publishing them: ${JSON.stringify(reasonCounts)}.`,
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
    next: { business_status: GoogleVenueBusinessStatus | null; directory_eligible: boolean },
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
      (venue.google_place_id ? byGooglePlaceId.get(venue.google_place_id) : undefined) ??
      byNameAddress.get(`${normalizeVenueKey(venue.name)}|${normalizeVenueKey(venue.address)}`);
    if (existing) {
      touchedExistingIds.add(existing.id);
      recordTransition(existing, venue);
    }

    if (dryRun) {
      console.log(`${existing ? "Would update" : "Would insert"}: ${venue.name}`);
      continue;
    }

    if (existing) {
      const { error } = await supabase
        .from("venues")
        .update(venue)
        .eq("id", existing.id);

      if (error) {
        console.error(`Update failed for ${venue.name}: ${error.message}`);
        writeFailures.push(`update:${existing.id}`);
        continue;
      }

      updated += 1;
      continue;
    }

    const { error } = await supabase.from("venues").insert(venue);

    if (error) {
      console.error(`Insert failed for ${venue.name}: ${error.message}`);
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
      throw new Error(`Internal importer error: existing venue ${existing.id} has no completed refresh outcome.`);
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
      console.error(`Fail-closed status update failed for ${existing.name}: ${error.message}`);
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

  const transitionSummary = transitions.reduce<Record<string, number>>((counts, item) => {
    const key = `${item.fromDirectoryEligible === true ? "eligible" : "excluded"}:${item.fromBusinessStatus ?? "UNKNOWN"}` +
      `->${item.toDirectoryEligible ? "eligible" : "excluded"}:${item.toBusinessStatus ?? "UNKNOWN"}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
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
  console.log(JSON.stringify({
    venueDirectoryTransitionManifest: manifest,
    manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
  }));

  console.log(
    dryRun
      ? "Dry run complete."
      : `Venue import complete. Inserted: ${inserted}. Updated: ${updated}. Excluded/rechecked: ${excluded}.`,
  );

}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
