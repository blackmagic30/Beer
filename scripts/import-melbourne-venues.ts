import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import {
  normalizeVenueKey,
  shouldImportBarOrPubPlace,
  type GoogleAddressComponent,
  type GooglePlaceCandidate,
} from "../src/lib/venue-directory.js";

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
}

interface VenuePayload {
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
  source: string;
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

function mapPlaceToVenue(place: GooglePlaceCandidate): VenuePayload | null {
  if (!shouldImportBarOrPubPlace(place)) {
    return null;
  }

  const name = place.displayName?.text?.trim()!;
  const address = place.formattedAddress?.trim() ?? "";

  const fallbackAddress = parseAddressFallback(address);
  const suburb =
    getAddressComponent(place, ["locality", "postal_town", "administrative_area_level_2"]) ??
    fallbackAddress.suburb;
  const state =
    getAddressComponent(place, ["administrative_area_level_1"], true) ??
    fallbackAddress.state;
  const postcode =
    getAddressComponent(place, ["postal_code"]) ??
    fallbackAddress.postcode;

  return {
    google_place_id: place.id?.trim() ?? null,
    name,
    address,
    suburb,
    state,
    postcode,
    phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    source: "google_places_bar_pub",
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

function collectDiscoveredVenue(
  discovered: Map<string, VenuePayload>,
  place: GooglePlaceCandidate,
) {
  const venue = mapPlaceToVenue(place);

  if (!venue) {
    return;
  }

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

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const rows: VenueRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("venues")
      .select("id, google_place_id, name, address")
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
  const googleApiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;

  if (!googleApiKey) {
    throw new Error("Missing GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY");
  }

  const dryRun = hasFlag("dry-run");
  const cityBackfill = hasFlag("city-backfill");
  const cityOnly = hasFlag("city-only");
  const innerRingBackfill = hasFlag("inner-ring-backfill");
  const innerRingOnly = hasFlag("inner-ring-only");
  const maxCells = Number.parseInt(getArg("max-cells", "") ?? "", 10);
  const centers = buildGridCenters();
  const cellsToScan = cityOnly || innerRingOnly
    ? []
    : Number.isFinite(maxCells) && maxCells > 0
      ? centers.slice(0, maxCells)
      : centers;
  const discovered = new Map<string, VenuePayload>();
  const failedCells: string[] = [];
  const failedQueries: string[] = [];
  const textBackfillQueries: TextSearchQuery[] = [
    ...(cityBackfill || cityOnly ? DEFAULT_CITY_BACKFILL_QUERIES : []),
    ...(innerRingBackfill || innerRingOnly ? DEFAULT_INNER_RING_BACKFILL_QUERIES : []),
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
      collectDiscoveredVenue(discovered, place);
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
            collectDiscoveredVenue(discovered, place);
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

  console.log(`Discovered ${discovered.size} unique venue candidates.`);

  const { supabase, rows: existingRows } = await fetchExistingVenues();
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

  for (const venue of discovered.values()) {
    const existing =
      (venue.google_place_id ? byGooglePlaceId.get(venue.google_place_id) : undefined) ??
      byNameAddress.get(`${normalizeVenueKey(venue.name)}|${normalizeVenueKey(venue.address)}`);

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
        continue;
      }

      updated += 1;
      continue;
    }

    const { error } = await supabase.from("venues").insert(venue);

    if (error) {
      console.error(`Insert failed for ${venue.name}: ${error.message}`);
      continue;
    }

    inserted += 1;
  }

  console.log(
    dryRun
      ? "Dry run complete."
      : `Venue import complete. Inserted: ${inserted}. Updated: ${updated}.`,
  );

  if (failedCells.length > 0) {
    console.log(`Skipped ${failedCells.length} cells due to Google API errors.`);
  }

  if (failedQueries.length > 0) {
    console.log(`Skipped ${failedQueries.length} text-search queries due to Google API errors.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
