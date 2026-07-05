import "dotenv/config";

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import Database from "better-sqlite3";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName } from "../src/constants/beers.js";
import {
  extractOnTapCardRowsFromHtml,
  extractStructuredBeerRowsFromText,
  splitCollapsedMenuRowsForExtraction,
} from "../src/lib/menu-text-extraction.js";
import { isTimeLimitedMenuSource } from "../src/lib/menu-source-filter.js";
import {
  normalizeVenueKey,
  shouldImportBarOrPubPlace,
  type GooglePlaceCandidate,
} from "../src/lib/venue-directory.js";

const GOOGLE_TEXT_SEARCH_API_URL = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.websiteUri",
  "places.businessStatus",
  "places.primaryType",
  "places.types",
].join(",");

const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_PDF_BYTES = 20_000_000;
const MAX_TEXT_EXTRACTION_CHARS = 80_000;
const MAX_JSON_SCRIPT_CHARS = 500_000;
const MAX_ROWS_PER_TEXT_SOURCE = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_LINKS_PER_VENUE = 8;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_SECONDARY_LINKS_PER_SOURCE = 4;
const DEFAULT_MAX_PROBE_URLS_PER_SITE = 8;
const MAX_SITEMAP_URLS_PER_SITE = 14;
const MAX_SITEMAP_FILES_PER_SITE = 6;
const MAX_ROBOTS_SITEMAPS_PER_SITE = 4;
const DEFAULT_MAX_WORDPRESS_LINKS_PER_SITE = 8;
const FETCH_RETRY_ATTEMPTS = 2;
const FETCH_RETRY_DELAY_MS = 450;

const execFileAsync = promisify(execFile);
const textFetchCache = new Map<string, Promise<{ contentType: string; text: string }>>();
const imageDataUrlCache = new Map<string, Promise<string>>();

const COMMON_MENU_PATHS = [
  "/menu",
  "/menus",
  "/drinks",
  "/drink",
  "/drinks-menu",
  "/food-drinks",
  "/food-and-drinks",
  "/eat-drink",
  "/eat-and-drink",
  "/bar-menu",
  "/beer",
] as const;

type SourceKind = "menu_page" | "menu_image" | "menu_pdf" | "homepage_menu_signal";
type DiscoveryMethod =
  | "homepage"
  | "homepage_link"
  | "json_ld"
  | "embedded_json"
  | "sitemap"
  | "robots_sitemap"
  | "wordpress_rest"
  | "common_path_probe"
  | "nested_asset"
  | "css_asset"
  | "quoted_asset"
  | "trusted_external_menu_host";
type SourceOrigin = "official_host" | "trusted_external_menu_host";

interface VenueCandidate {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  website: string | null;
  source: string;
  googlePlaceId: string | null;
}

interface MenuSourceCandidate {
  venueId: string;
  venueName: string;
  venueAddress: string | null;
  venueSuburb: string | null;
  officialWebsite: string;
  sourceUrl: string;
  canonicalSourceUrl: string;
  sourceDomain: string;
  sourceOrigin: SourceOrigin;
  sourceKind: SourceKind;
  discoveryMethod: DiscoveryMethod;
  confidence: number;
  canQueueOcr: boolean;
  freshness: "within_last_year" | "older_than_year" | "unknown";
  publishedAt: string | null;
  signals: string[];
  reviewNote: string;
  ocr: MenuImageOcrResult | null;
  textExtraction: MenuTextExtractionResult | null;
}

interface MenuImageOcrBeer {
  name: string;
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: "on_tap" | "package_only" | "unavailable" | "unknown";
  notes: string | null;
  confidence: number | null;
}

interface MenuImageOcrResult {
  attemptedAt: string;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  beers: MenuImageOcrBeer[];
  error: string | null;
}

type TextExtractionMethod = "html_text" | "pdf_text";

interface MenuTextExtractionResult {
  attemptedAt: string;
  method: TextExtractionMethod;
  rows: MenuImageOcrBeer[];
  notes: string[];
  error: string | null;
}

interface DiscoveryReport {
  generatedAt: string;
  safety: {
    googleReviewPhotos: "skipped";
    autoPublish: false;
    ocrQueued: boolean;
    note: string;
  };
  totals: {
    venuesLoaded: number;
    venuesScanned: number;
    venuesWithOfficialWebsite: number;
    venuesResolvedWithGooglePlaces: number;
    sourceCandidates: number;
    sourcesWithExtractedRows: number;
    discoveryMethodCounts: Partial<Record<DiscoveryMethod, number>>;
    sourceKindCounts: Partial<Record<SourceKind, number>>;
    directImageCandidates: number;
    textExtractionCandidatesAttempted: number;
    textExtractionCandidatesSucceeded: number;
    textBeerRowsExtracted: number;
    pdfCandidatesParsed: number;
    htmlCandidatesParsed: number;
    ocrImageCandidatesAttempted: number;
    ocrImageCandidatesSucceeded: number;
    ocrBeerRowsExtracted: number;
    queuedForOcr: number;
    skippedWithoutWebsite: number;
    fetchErrors: number;
    fetchCacheEntries: number;
  };
  skippedWithoutWebsite: Array<Pick<VenueCandidate, "id" | "name" | "address" | "suburb" | "source">>;
  candidates: MenuSourceCandidate[];
  errors: Array<{ venueId: string; venueName: string; url: string; error: string }>;
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const raw = getArg(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  return JSON.parse(withoutFence);
}

function normalizeConfidence(value: unknown, fallback: number | null = null): number | null {
  if (value == null || value === "") {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, numeric));
}

function normalizeOcrBeer(value: unknown): MenuImageOcrBeer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? canonicalizeTrackedBeerName(record.name.trim()) : "";
  if (!name) {
    return null;
  }

  const availabilityStatus =
    typeof record.availability_status === "string" &&
    ["on_tap", "package_only", "unavailable", "unknown"].includes(record.availability_status)
      ? (record.availability_status as MenuImageOcrBeer["availabilityStatus"])
      : "unknown";

  return {
    name,
    priceNumeric:
      record.price_numeric == null || Number.isNaN(Number(record.price_numeric))
        ? null
        : Number(record.price_numeric),
    priceText: typeof record.price_text === "string" && record.price_text.trim() ? record.price_text.trim() : null,
    availabilityStatus,
    notes: typeof record.notes === "string" && record.notes.trim() ? record.notes.trim() : null,
    confidence: normalizeConfidence(record.confidence, null),
  };
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await worker(item, currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function ensureRunsDir(): string {
  const runsDir = path.resolve(process.cwd(), "data/runs");
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

function timestampForFile(): string {
  return new Date().toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function candidatesToCsv(candidates: MenuSourceCandidate[]): string {
  const headers = [
    "venueName",
    "venueAddress",
    "venueArea",
    "sourceKind",
    "discoveryMethod",
    "sourceOrigin",
    "sourceDomain",
    "confidence",
    "canQueueOcr",
    "sourceUrl",
    "canonicalSourceUrl",
    "officialWebsite",
    "freshness",
    "signals",
    "ocrBeerCount",
    "ocrError",
    "textExtractionMethod",
    "textExtractionBeerCount",
    "textExtractionError",
    "textExtractionPreview",
    "reviewNote",
  ];
  const rows = candidates.map((candidate) => [
    candidate.venueName,
    candidate.venueAddress,
    candidate.venueSuburb,
    candidate.sourceKind,
    candidate.discoveryMethod,
    candidate.sourceOrigin,
    candidate.sourceDomain,
    candidate.confidence,
    candidate.canQueueOcr,
    candidate.sourceUrl,
    candidate.canonicalSourceUrl,
    candidate.officialWebsite,
    candidate.freshness,
    candidate.signals.join("; "),
    candidate.ocr?.beers.length ?? 0,
    candidate.ocr?.error ?? "",
    candidate.textExtraction?.method ?? "",
    candidate.textExtraction?.rows.length ?? 0,
    candidate.textExtraction?.error ?? "",
    candidate.textExtraction?.rows
      .slice(0, 5)
      .map((row) => `${row.name}${row.priceText ? ` ${row.priceText}` : ""}`)
      .join("; ") ?? "",
    candidate.reviewNote,
  ]);

  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n");
}

function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeWebsite(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return isHttpUrl(withProtocol) ? withProtocol : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function venueKey(venue: Pick<VenueCandidate, "name" | "address" | "suburb">): string {
  return [
    normalizeVenueKey(venue.name),
    normalizeVenueKey(venue.address),
    normalizeVenueKey(venue.suburb),
  ]
    .filter(Boolean)
    .join("|");
}

function venueMergeKey(venue: VenueCandidate): string {
  const naturalKey = venueKey(venue);
  const naturalKeyParts = naturalKey.split("|").filter(Boolean);
  return naturalKey && naturalKeyParts.length >= 2 ? naturalKey : venue.id || naturalKey;
}

function mergeVenues(venues: VenueCandidate[]): VenueCandidate[] {
  const merged = new Map<string, VenueCandidate>();

  for (const venue of venues) {
    const key = venueMergeKey(venue);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, venue);
      continue;
    }

    merged.set(key, {
      ...existing,
      address: existing.address ?? venue.address,
      suburb: existing.suburb ?? venue.suburb,
      state: existing.state ?? venue.state,
      postcode: existing.postcode ?? venue.postcode,
      latitude: existing.latitude ?? venue.latitude,
      longitude: existing.longitude ?? venue.longitude,
      website: existing.website ?? venue.website,
      googlePlaceId: existing.googlePlaceId ?? venue.googlePlaceId,
      source: existing.source.includes(venue.source) ? existing.source : `${existing.source},${venue.source}`,
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSupabaseVenues(limit: number): Promise<VenueCandidate[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return [];
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
  const venues: VenueCandidate[] = [];
  const pageSize = 500;
  let includeWebsite = true;

  for (let offset = 0; offset < limit; offset += pageSize) {
    const selectWithWebsite =
      "id, google_place_id, name, address, suburb, state, postcode, latitude, longitude, website";
    const selectWithoutWebsite =
      "id, google_place_id, name, address, suburb, state, postcode, latitude, longitude";
    const { data, error } = await supabase
      .from("venues")
      .select(includeWebsite ? selectWithWebsite : selectWithoutWebsite)
      .range(offset, Math.min(offset + pageSize - 1, limit - 1));

    if (error && includeWebsite && /website/i.test(error.message)) {
      includeWebsite = false;
      offset -= pageSize;
      continue;
    }

    if (error) {
      throw new Error(`Failed to load Supabase venues: ${error.message}`);
    }

    const rows = (Array.isArray(data) ? data : []) as unknown[];
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = normalizeString(row.id);
      const name = normalizeString(row.name);
      if (!id || !name) {
        continue;
      }
      venues.push({
        id,
        name,
        address: normalizeString(row.address),
        suburb: normalizeString(row.suburb),
        state: normalizeString(row.state),
        postcode: normalizeString(row.postcode),
        latitude: normalizeNumber(row.latitude),
        longitude: normalizeNumber(row.longitude),
        website: normalizeWebsite(normalizeString(row.website)),
        source: "supabase:venues",
        googlePlaceId: normalizeString(row.google_place_id),
      });
    }

    if (rows.length < pageSize || venues.length >= limit) {
      break;
    }
  }

  return venues.slice(0, limit);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqlColumn(columns: Set<string>, name: string, alias = name): string {
  return columns.has(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`;
}

function loadSqliteVenues(limit: number): VenueCandidate[] {
  const dbPaths = [
    process.env.DATABASE_PATH,
    "data/pint-path.sqlite",
    "data/melb-beer-bot.sqlite",
    "data/melb-beer-bot.db",
    "data/app.db",
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(process.cwd(), value));

  const venues: VenueCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const dbPath of dbPaths) {
    if (seenPaths.has(dbPath) || !fs.existsSync(dbPath)) {
      continue;
    }
    seenPaths.add(dbPath);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (!tableExists(db, "venue_profiles")) {
        continue;
      }

      const columns = tableColumns(db, "venue_profiles");
      const rows = db
        .prepare(
          `SELECT
            ${sqlColumn(columns, "id")},
            ${sqlColumn(columns, "name")},
            ${sqlColumn(columns, "address")},
            ${sqlColumn(columns, "suburb")},
            ${sqlColumn(columns, "state")},
            ${sqlColumn(columns, "postcode")},
            ${sqlColumn(columns, "latitude")},
            ${sqlColumn(columns, "longitude")},
            ${sqlColumn(columns, "website")},
            ${sqlColumn(columns, "google_place_id", "googlePlaceId")}
           FROM venue_profiles
           WHERE name IS NOT NULL
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;

      for (const row of rows) {
        const id = normalizeString(row.id);
        const name = normalizeString(row.name);
        if (!id || !name) {
          continue;
        }
        venues.push({
          id,
          name,
          address: normalizeString(row.address),
          suburb: normalizeString(row.suburb),
          state: normalizeString(row.state),
          postcode: normalizeString(row.postcode),
          latitude: normalizeNumber(row.latitude),
          longitude: normalizeNumber(row.longitude),
          website: normalizeWebsite(normalizeString(row.website)),
          source: `sqlite:${path.basename(dbPath)}`,
          googlePlaceId: normalizeString(row.googlePlaceId),
        });
      }
    } finally {
      db.close();
    }
  }

  return venues;
}

function loadArtifactVenues(limit: number): VenueCandidate[] {
  const artifactPaths = [
    "data/venue-call-review.json",
    "data/south-melbourne-call-review.json",
    "data/runs/venue-call-batch-state.json",
  ];
  const venues: VenueCandidate[] = [];

  for (const artifactPath of artifactPaths) {
    const absolutePath = path.resolve(process.cwd(), artifactPath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "venues" in parsed && Array.isArray((parsed as { venues: unknown }).venues)
        ? (parsed as { venues: unknown[] }).venues
        : [];

    for (const item of rows) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const name = normalizeString(row.venueName) ?? normalizeString(row.name);
      if (!name) {
        continue;
      }
      const id = normalizeString(row.venueId) ?? normalizeString(row.id) ?? normalizeVenueKey(`${name}-${normalizeString(row.suburb) ?? ""}`);
      venues.push({
        id,
        name,
        address: normalizeString(row.address),
        suburb: normalizeString(row.suburb),
        state: normalizeString(row.state),
        postcode: normalizeString(row.postcode),
        latitude: normalizeNumber(row.latitude),
        longitude: normalizeNumber(row.longitude),
        website: normalizeWebsite(normalizeString(row.website)),
        source: `artifact:${artifactPath}`,
        googlePlaceId: normalizeString(row.googlePlaceId),
      });
    }
  }

  return venues.slice(0, limit);
}

function getAddressComponent(place: GooglePlaceCandidate, type: string): string | null {
  const component = (place.addressComponents ?? []).find((item) => item.types?.includes(type));
  return component?.longText ?? component?.shortText ?? null;
}

function looksLikeSameVenue(venue: VenueCandidate, place: GooglePlaceCandidate): boolean {
  const placeName = place.displayName?.text ?? "";
  const placeAddress = place.formattedAddress ?? "";
  const venueName = normalizeVenueKey(venue.name);
  const candidateName = normalizeVenueKey(placeName);

  if (!venueName || !candidateName) {
    return false;
  }

  if (candidateName === venueName || candidateName.includes(venueName) || venueName.includes(candidateName)) {
    return true;
  }

  const nameTokens = venueName.split(/\s+/).filter((token) => token.length >= 4);
  const matchedTokens = nameTokens.filter((token) => candidateName.includes(token)).length;
  const suburb = normalizeVenueKey(venue.suburb);
  const address = normalizeVenueKey(venue.address);
  const placeAddressKey = normalizeVenueKey(placeAddress);

  return (
    matchedTokens >= Math.min(2, nameTokens.length) &&
    Boolean((suburb && placeAddressKey.includes(suburb)) || (address && placeAddressKey.includes(address.split(/\s+/)[0] ?? "")))
  );
}

async function resolveWebsiteWithGooglePlaces(venue: VenueCandidate): Promise<string | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return null;
  }

  const textQuery = [venue.name, venue.address, venue.suburb, "Melbourne"].filter(Boolean).join(" ");
  const response = await fetch(GOOGLE_TEXT_SEARCH_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      pageSize: 5,
      locationBias: venue.latitude && venue.longitude
        ? {
            circle: {
              center: { latitude: venue.latitude, longitude: venue.longitude },
              radius: 1500,
            },
          }
        : undefined,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { places?: GooglePlaceCandidate[] };
  const places = payload.places ?? [];
  const match = places.find((place) => looksLikeSameVenue(venue, place) && shouldImportBarOrPubPlace(place));
  return normalizeWebsite(match?.websiteUri);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function withTimeoutFetch(url: string): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,application/json,application/pdf,image/*;q=0.9,*/*;q=0.5",
          "User-Agent": "PintPathMenuDiscovery/1.0 (+https://pintpath.au)",
        },
        redirect: "follow",
      });
      if (attempt < FETCH_RETRY_ATTEMPTS && isRetryableFetchStatus(response.status)) {
        await delay(FETCH_RETRY_DELAY_MS * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= FETCH_RETRY_ATTEMPTS) {
        break;
      }
      await delay(FETCH_RETRY_DELAY_MS * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Fetch failed");
}

function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(url);
}

function isPdfUrl(url: string): boolean {
  return /\.pdf(\?.*)?$/i.test(url);
}

function isBogusAssetReference(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return (
      /^\/\.(?:png|jpe?g|webp|gif|pdf)$/i.test(pathname) ||
      /\/(?:undefined|null|false|true)\.(?:png|jpe?g|webp|gif|pdf)$/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function isMenuTerm(value: string): boolean {
  return /\b(menu|menus|drinks?|beverages?|beer|tap\s?list)\b/i.test(value);
}

function isExcludedMenuSourceUrl(url: string, text: string): boolean {
  if (isBogusAssetReference(url)) {
    return true;
  }
  if (isTimeLimitedMenuSource(url, text)) {
    return true;
  }
  const haystack = `${url} ${text}`.replace(/[-_]+/g, " ");
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\.(?:css|js|woff2?|ttf|otf|eot|mp4|webm|mov|avi)(?:$|\?)/i.test(pathname)) {
      return true;
    }
    if (/\/sitemap[^/]*\.xml$/i.test(pathname)) {
      return true;
    }
    if (/\/(?:shop|product|products|product-category|collections?|cart|checkout)(?:\/|$)/i.test(pathname) && !/\bmenus?\b/i.test(pathname)) {
      return true;
    }
    if (/\/(?:blogs?|news|articles?|members)(?:\/|$)/i.test(pathname) && !/\b(?:menus?|tap-?list|beer-menu|drinks?-menu)\b/i.test(pathname)) {
      return true;
    }
    if (/\/(?:wine|wines|redwines?|whitewines?|cocktails?)(?:\/|$)/i.test(pathname) && !/\b(?:menus?|drinks?-menu|beer-menu)\b/i.test(pathname)) {
      return true;
    }
    if (/\b(?:faq|trivia|answers?|lunch|guided-tour|beer-trail|bookings?|competition|corporate)\b/i.test(pathname) && !/\b(?:pints?|schooners?|tap-?list|beer-menu|drinks?-menu)\b/i.test(pathname)) {
      return true;
    }
    if (/\/events?(?:\/|$)/i.test(pathname) && !/\b(?:tap-?list|beer-menu|drinks?-menu)\b/i.test(pathname)) {
      return true;
    }
  } catch {
    // Fall through to text-based exclusions below.
  }
  return /\b(masterclass|gift cards?|careers?|jobs?|functions?|weddings?|events packages?|private dining|reservations?|bookings?|accommodation|rooms?|stay|hotel rooms?|privacy|terms|accessibility|newsletter|login|cart|checkout|delivery|gallery|press)\b/i.test(
    haystack,
  );
}

function isLikelyMenuImageCandidate(url: string, text: string): boolean {
  if (!isImageUrl(url) || isBogusAssetReference(url)) {
    return false;
  }

  const decodedUrl = (() => {
    try {
      return decodeURIComponent(url);
    } catch {
      return url;
    }
  })();
  const haystack = `${decodedUrl} ${text}`.replace(/[-_]+/g, " ");
  const pathname = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
      return decodedUrl.toLowerCase();
    }
  })();
  const filename = pathname.split("/").pop() ?? pathname;
  const pathSignal = pathname.replace(/[-_+%]+/g, " ");
  const textSignal = text.replace(/[-_+%]+/g, " ");

  const strongPathSignal =
    /\b(?:drinks?|beverage|beer|bar|cocktail|tap)\s*menu\b/i.test(pathSignal) ||
    /\b(?:beer|tap)\s*list\b/i.test(pathSignal) ||
    /\bmenu\s*(?:single\s*page|graphic|qr|board|page)\b/i.test(pathSignal) ||
    /\b(?:qr\s*code|menu\s*qr)\b/i.test(pathSignal);
  const strongTextSignal =
    /\b(?:drinks?|beverage|beer|bar|cocktail|tap)\s*menu\b/i.test(textSignal) ||
    /\b(?:beer|tap)\s*list\b/i.test(textSignal) ||
    /\b(?:qr\s*code|menu\s*qr)\b/i.test(textSignal);
  const strongMenuAsset = strongPathSignal || strongTextSignal;
  const negative =
    /\b(logo|favicon|apple touch icon|brand|banner|hero|venue|slider|home page|home img|mobile menu|mockup|where to buy|buy now|beer taps?|beer tanks?|pouring|private dining|shareboards?|product|thumbnail|cropped|symbol|screenshot|gallery|interior|internal|walk through|meat|food photo|kitchen|dining|tile|navitem|lensaloft|unknown)\b/i.test(
      haystack,
    );
  const uploadYear = pathname.match(/\/(20\d{2})\//)?.[1];
  const oldGenericUpload =
    uploadYear != null &&
    Number(uploadYear) < new Date().getUTCFullYear() - 1 &&
    !/\b(?:drinks?|beverage|beer|cocktail|tap)\b/i.test(pathSignal);

  if (negative || oldGenericUpload) {
    return false;
  }
  if (/\b(?:favicon|apple-touch-icon|cropped-|logo|symbol|screenshot|home_img|unknown)\b/i.test(filename) && !strongMenuAsset) {
    return false;
  }

  return strongMenuAsset;
}

function hasDrinkPriceSignals(text: string): boolean {
  const hasDrinkText =
    /\b(beer|pint|tap|draught|draft|guinness|carlton|stone\s*&\s*wood|lager|ale|stout|happy\s?hour|schooner|pot|jug|tin|tins|tinnies)\b/i.test(
      text,
    );
  if (!hasDrinkText) {
    return false;
  }

  return (
    /(?:\$|A\$|AUD\s*)\s*\d{1,3}(?:\.\d{1,2})?/.test(text) ||
    /\b(?:pint|schooner|pot|jug|tap|draught|draft|beer|lager|ale|stout|ipa|xpa|cider)\b[^\n$]{0,80}\b\d{1,2}(?:\.\d{1,2})?\b/i.test(
      text,
    )
  );
}

function inferFreshness(text: string): { freshness: MenuSourceCandidate["freshness"]; publishedAt: string | null } {
  const match = text.match(/(?:datePublished|dateModified|updated|published)["':\s]+(\d{4}-\d{2}-\d{2})/i);
  if (!match?.[1]) {
    return { freshness: "unknown", publishedAt: null };
  }

  const publishedAt = match[1];
  const publishedTime = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedTime)) {
    return { freshness: "unknown", publishedAt: null };
  }

  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return {
    freshness: publishedTime >= oneYearAgo ? "within_last_year" : "older_than_year",
    publishedAt,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&middot;/g, " ")
    .replace(/&bull;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToPlainText(html: string): string {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenJsonStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) {
      output.push(value.trim());
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJsonStrings(item, output);
    }
    return output;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      flattenJsonStrings(item, output);
    }
  }

  return output;
}

function extractJsonLdText(html: string): string {
  const chunks: string[] = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const raw = decodeHtml(match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      chunks.push(...flattenJsonStrings(parsed));
    } catch {
      chunks.push(raw.replace(/[{}[\]",:]+/g, " "));
    }
  }

  return chunks.join("\n");
}

function textForExtraction(input: string): string {
  return input.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT_EXTRACTION_CHARS);
}

function getAttributeValue(tag: string, attribute: string): string | null {
  const pattern = new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "i");
  return decodeHtml(tag.match(pattern)?.[1] ?? "").trim() || null;
}

function extractSrcSetUrls(value: string, baseUrl: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url): url is string => Boolean(url))
    .flatMap((url) => {
      try {
        const parsed = new URL(decodeHtml(url), baseUrl);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? [parsed.toString()] : [];
      } catch {
        return [];
      }
    });
}

function looksLikeUrlReference(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(?:https?:)?\/\//i.test(value) || value.startsWith("/") || /\.(?:pdf|png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value);
}

function extractJsonLdLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const raw = decodeHtml(match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const value of flattenJsonStrings(parsed)) {
        if (looksLikeUrlReference(value)) {
          addUrlLink(links, value, baseUrl, "json ld menu url");
        }
      }
    } catch {
      for (const urlMatch of raw.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        addUrlLink(links, urlMatch[0], baseUrl, "json ld menu url");
      }
    }
  }

  return links;
}

function normalizeEscapedUrlReference(value: string): string {
  return decodeHtml(value)
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
}

function maybeAddMenuAssetReference(
  links: Array<{ url: string; text: string }>,
  rawValue: string,
  baseUrl: string,
  text: string,
): void {
  const normalized = normalizeEscapedUrlReference(rawValue);
  if (!normalized || normalized.startsWith("//")) {
    return;
  }
  if (!looksLikeUrlReference(normalized)) {
    return;
  }
  if (!isMenuTerm(normalized) && !isPdfUrl(normalized) && !isImageUrl(normalized)) {
    return;
  }
  addUrlLink(links, normalized, baseUrl, text);
}

function extractEmbeddedJsonMenuLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const pattern = /<script\b(?=[^>]*(?:type=["']application\/json["']|id=["']__NEXT_DATA__["']))[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const raw = decodeHtml(match[1] ?? "").trim().slice(0, MAX_JSON_SCRIPT_CHARS);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const value of flattenJsonStrings(parsed)) {
        maybeAddMenuAssetReference(links, value, baseUrl, "embedded json menu asset");
      }
    } catch {
      const quotedUrlPattern = /["'`]((?:https?:\\?\/\\?\/|\/)[^"'`<>{}\s]{3,})["'`]/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = quotedUrlPattern.exec(raw))) {
        maybeAddMenuAssetReference(links, urlMatch[1] ?? "", baseUrl, "embedded json menu asset");
      }
    }
  }

  return links;
}

function extractQuotedMenuLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const quotedUrlPattern = /["'`]((?:https?:\\?\/\\?\/|\/)[^"'`<>{}\s]{3,})["'`]/gi;
  let match: RegExpExecArray | null;

  while ((match = quotedUrlPattern.exec(html))) {
    maybeAddMenuAssetReference(links, match[1] ?? "", baseUrl, "quoted url menu asset");
  }

  return links;
}

function addUrlLink(
  links: Array<{ url: string; text: string }>,
  rawUrl: string | null | undefined,
  baseUrl: string,
  text: string,
): void {
  if (!rawUrl) {
    return;
  }

  try {
    const url = new URL(decodeHtml(rawUrl), baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      links.push({ url: url.toString(), text: decodeHtml(text) });
    }
  } catch {
    // Ignore malformed links.
  }
}

function extractLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const mediaPattern = /<(?:img|source)\b[^>]*>/gi;
  const embeddedLinkPattern = /<(?:meta|link|iframe|embed|object)\b[^>]*>/gi;
  const cssUrlPattern = /url\((["']?)([^"')]+)\1\)/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const href = match[1];
    if (!href) {
      continue;
    }
    addUrlLink(links, href, baseUrl, stripHtml(match[2] ?? ""));
  }

  while ((match = mediaPattern.exec(html))) {
    const tag = match[0] ?? "";
    const text = [
      getAttributeValue(tag, "alt"),
      getAttributeValue(tag, "title"),
      getAttributeValue(tag, "aria-label"),
      getAttributeValue(tag, "class"),
    ]
      .filter(Boolean)
      .join(" ");

    for (const attribute of ["src", "data-src", "data-lazy-src", "data-original", "data-image", "data-bg"]) {
      addUrlLink(links, getAttributeValue(tag, attribute), baseUrl, text);
    }

    const srcset = getAttributeValue(tag, "srcset") ?? getAttributeValue(tag, "data-srcset");
    if (srcset) {
      for (const srcsetUrl of extractSrcSetUrls(srcset, baseUrl)) {
        links.push({ url: srcsetUrl, text });
      }
    }
  }

  while ((match = embeddedLinkPattern.exec(html))) {
    const tag = match[0] ?? "";
    const text = [
      getAttributeValue(tag, "rel"),
      getAttributeValue(tag, "property"),
      getAttributeValue(tag, "name"),
      getAttributeValue(tag, "type"),
      getAttributeValue(tag, "title"),
      getAttributeValue(tag, "aria-label"),
      getAttributeValue(tag, "class"),
      getAttributeValue(tag, "id"),
    ]
      .filter(Boolean)
      .join(" ");

    for (const attribute of ["href", "src", "data"]) {
      addUrlLink(links, getAttributeValue(tag, attribute), baseUrl, text);
    }

    const content = getAttributeValue(tag, "content");
    if (looksLikeUrlReference(content)) {
      addUrlLink(links, content, baseUrl, text);
    }
  }

  while ((match = cssUrlPattern.exec(html))) {
    addUrlLink(links, match[2], baseUrl, "css image");
  }

  links.push(...extractJsonLdLinks(html, baseUrl));
  links.push(...extractEmbeddedJsonMenuLinks(html, baseUrl));
  links.push(...extractQuotedMenuLinks(html, baseUrl));

  return links;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    const hostA = urlA.hostname.replace(/^www\./i, "");
    const hostB = urlB.hostname.replace(/^www\./i, "");
    return hostA === hostB;
  } catch {
    return false;
  }
}

function hostMatches(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isTrustedExternalMenuHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostMatches(hostname, [
      "mryum.com",
      "mr-yum.com",
      "meandu.app",
      "meandu.com",
      "bopple.app",
      "bopple.com",
      "hungryhungry.com",
      "nowbookit.com",
      "opentable.com",
      "quandoo.com.au",
      "resdiary.com",
      "sevenrooms.com",
      "square.site",
      "untappd.com",
      "wixstatic.com",
      "squarespace-cdn.com",
      "shopifycdn.net",
      "cdn.shopify.com",
      "cloudfront.net",
      "amazonaws.com",
    ]);
  } catch {
    return false;
  }
}

function isAllowedMenuSourceUrl(officialWebsite: string, sourceUrl: string, text: string): boolean {
  if (sameOrigin(officialWebsite, sourceUrl)) {
    return true;
  }

  const signalText = `${text} ${sourceUrl}`;
  if ((isPdfUrl(sourceUrl) || isLikelyMenuImageCandidate(sourceUrl, text)) && isTrustedExternalMenuHost(sourceUrl)) {
    return true;
  }

  return isTrustedExternalMenuHost(sourceUrl) && isMenuTerm(signalText);
}

function shouldSuppressDiscoveryFetchError(linkText: string, errorMessage: string): boolean {
  if (!/\b(common menu path probe|sitemap menu url|robots sitemap menu url|wordpress rest menu url)\b/i.test(linkText)) {
    return false;
  }
  return /^HTTP (?:403|404|410)\b/i.test(errorMessage);
}

function sourceHasMenuSignal(linkText: string, sourceUrl: string): boolean {
  const humanLinkText = linkText
    .replace(/\bcommon menu path probe\b/gi, "")
    .replace(/\brobots sitemap menu url\b/gi, "")
    .replace(/\bsitemap menu url\b/gi, "")
    .replace(/\bwordpress rest menu url\b/gi, "")
    .replace(/\bquoted url menu asset\b/gi, "")
    .replace(/\bembedded json menu asset\b/gi, "")
    .replace(/\bjson ld menu url\b/gi, "")
    .replace(/\bmenu page asset\b/gi, "")
    .replace(/\bcss image\b/gi, "")
    .trim();
  return isMenuTerm(`${humanLinkText} ${sourceUrl}`);
}

function isLowIntentMenuSourceUrl(sourceUrl: string): boolean {
  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    if (/\b(?:drink|drinks|menu|food|beer|eat-drink|eat-and-drink)\b/i.test(pathname)) {
      return false;
    }
    return /\/(?:about|history|faqs?|contact|privacy|terms|careers?|jobs?|blog|news)(?:\/|$)/i.test(pathname);
  } catch {
    return false;
  }
}

function discoveryMethodFromLinkText(
  linkText: string,
  officialWebsite: string,
  sourceUrl: string,
): DiscoveryMethod {
  if (linkText === "homepage") {
    return "homepage";
  }
  if (/\brobots sitemap menu url\b/i.test(linkText)) {
    return "robots_sitemap";
  }
  if (/\bsitemap menu url\b/i.test(linkText)) {
    return "sitemap";
  }
  if (/\bwordpress rest menu url\b/i.test(linkText)) {
    return "wordpress_rest";
  }
  if (/\bcommon menu path probe\b/i.test(linkText)) {
    return "common_path_probe";
  }
  if (/\bjson ld menu url\b/i.test(linkText)) {
    return "json_ld";
  }
  if (/\bembedded json menu asset\b/i.test(linkText)) {
    return "embedded_json";
  }
  if (/\bmenu page asset\b/i.test(linkText)) {
    return "nested_asset";
  }
  if (/\bcss image\b/i.test(linkText)) {
    return "css_asset";
  }
  if (/\bquoted url menu asset\b/i.test(linkText)) {
    return "quoted_asset";
  }
  if (!sameOrigin(officialWebsite, sourceUrl) && isTrustedExternalMenuHost(sourceUrl)) {
    return "trusted_external_menu_host";
  }
  return "homepage_link";
}

function canonicalDiscoveryUrl(value: string): string {
  try {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./i, "");
    url.port = "";
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_|fbclid$|gclid$|gbraid$|wbraid$|mc_cid$|mc_eid$|igshid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }
    url.pathname = url.pathname.replace(/\/index\.html?$/i, "");
    return url.toString();
  } catch {
    return value;
  }
}

function sourceDomainFor(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function sourceOriginFor(officialWebsite: string, sourceUrl: string): SourceOrigin {
  return sameOrigin(officialWebsite, sourceUrl) ? "official_host" : "trusted_external_menu_host";
}

function addUniqueDiscoveryLink(
  links: Array<{ url: string; text: string }>,
  seenUrls: Set<string>,
  link: { url: string; text: string },
  officialWebsite: string,
): boolean {
  const canonicalUrl = canonicalDiscoveryUrl(link.url);
  if (seenUrls.has(canonicalUrl) || isExcludedMenuSourceUrl(link.url, link.text)) {
    return false;
  }
  if (!isAllowedMenuSourceUrl(officialWebsite, link.url, link.text)) {
    return false;
  }
  seenUrls.add(canonicalUrl);
  links.push(link);
  return true;
}

function venueNameSignals(venue: VenueCandidate, text: string): string[] {
  const normalizedText = normalizeVenueKey(text);
  const tokens = normalizeVenueKey(venue.name)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["hotel", "venue", "restaurant", "bar", "pub"].includes(token));
  const matches = tokens.filter((token) => normalizedText.includes(token));
  if (venue.suburb && normalizedText.includes(normalizeVenueKey(venue.suburb))) {
    matches.push(`area:${venue.suburb}`);
  }
  return Array.from(new Set(matches));
}

function trimPdfStreamBuffer(buffer: Buffer): Buffer {
  let start = 0;
  let end = buffer.length;
  while (start < end && (buffer[start] === 0x0a || buffer[start] === 0x0d)) {
    start += 1;
  }
  while (end > start && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
    end -= 1;
  }
  return buffer.subarray(start, end);
}

function decodePdfLiteralString(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
      const replacements: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };
      return replacements[escaped] ?? escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function decodePdfTextLikeContent(value: string): string {
  const chunks: string[] = [];
  const boundedValue = value.slice(0, MAX_TEXT_EXTRACTION_CHARS * 4);
  const literalPattern = /\((?:\\.|[^\\)]){2,}\)/g;
  const hexPattern = /<([0-9a-fA-F\s]{4,})>/g;
  let match: RegExpExecArray | null;

  while ((match = literalPattern.exec(boundedValue))) {
    const raw = match[0]?.slice(1, -1) ?? "";
    chunks.push(decodePdfLiteralString(raw));
  }

  while ((match = hexPattern.exec(boundedValue))) {
    const hex = (match[1] ?? "").replace(/\s+/g, "");
    if (!hex || hex.length % 2 !== 0) {
      continue;
    }
    try {
      const decoded = Buffer.from(hex, "hex").toString("utf8");
      if (/[A-Za-z]{3}/.test(decoded)) {
        chunks.push(decoded);
      }
    } catch {
      // Ignore malformed PDF hex strings.
    }
  }

  chunks.push(boundedValue.replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " "));
  return chunks
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfTextWithPdftotext(buffer: Buffer): Promise<string> {
  const tempPath = path.join(os.tmpdir(), `pintpath-menu-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tempPath, buffer);
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", tempPath, "-"], {
      encoding: "utf8",
      maxBuffer: MAX_TEXT_EXTRACTION_CHARS * 4,
      timeout: 15_000,
    });
    return stdout.trim();
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup only.
    }
  }
}

function extractPdfTextFallback(buffer: Buffer): string {
  const latin = buffer.toString("latin1");
  const chunks: string[] = [latin.slice(0, MAX_TEXT_EXTRACTION_CHARS)];
  const streamPattern = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match: RegExpExecArray | null;
  let streamCount = 0;
  let capturedChars = chunks[0]?.length ?? 0;

  while ((match = streamPattern.exec(latin)) && streamCount < 80 && capturedChars < MAX_TEXT_EXTRACTION_CHARS * 4) {
    streamCount += 1;
    const rawStream = trimPdfStreamBuffer(Buffer.from(match[1] ?? "", "latin1"));
    const dictionary = latin.slice(Math.max(0, match.index - 3000), match.index);
    let nextChunk = "";
    if (/\/FlateDecode\b/i.test(dictionary)) {
      try {
        const inflated = zlib.inflateSync(rawStream);
        nextChunk = inflated.toString("latin1");
      } catch {
        nextChunk = rawStream.toString("latin1");
      }
    } else {
      nextChunk = rawStream.toString("latin1");
    }
    const remaining = MAX_TEXT_EXTRACTION_CHARS * 4 - capturedChars;
    chunks.push(nextChunk.slice(0, remaining));
    capturedChars += Math.min(nextChunk.length, remaining);
  }

  return decodePdfTextLikeContent(chunks.join("\n")).slice(0, MAX_TEXT_EXTRACTION_CHARS);
}

function pdfFallbackTextIsUsable(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 60) {
    return false;
  }

  const strangeChars = compact.match(/[^\x20-\x7e\u00a0-\u024f]/g)?.length ?? 0;
  if (strangeChars >= 8 && strangeChars / compact.length > 0.04) {
    return false;
  }

  const words = value.match(/\b[A-Za-z][A-Za-z'&-]{2,}\b/g)?.length ?? 0;
  return words >= 8;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const preferred = await extractPdfTextWithPdftotext(buffer);
  const fallback = extractPdfTextFallback(buffer);
  const chunks = preferred ? [preferred] : [];
  if (pdfFallbackTextIsUsable(fallback) && (!preferred || !hasDrinkPriceSignals(preferred) || hasDrinkPriceSignals(fallback))) {
    chunks.push(fallback);
  }
  return textForExtraction(chunks.filter(Boolean).join("\n"));
}

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTrackedBeerInText(value: string): string | null {
  const normalized = normalizeLooseText(value);
  const aliases = VIEWER_TRACKED_BEERS.flatMap((beer) =>
    [beer.name, ...beer.aliases].map((alias) => ({
      canonical: beer.name,
      normalizedAlias: normalizeLooseText(alias),
    })),
  )
    .filter((item) => item.normalizedAlias.length >= 3)
    .sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length);

  return aliases.find((item) => new RegExp(`(?:^|\\s)${escapeRegExp(item.normalizedAlias)}(?:\\s|$)`).test(normalized))?.canonical ?? null;
}

function inferGenericDrinkName(line: string, priceIndex: number): string | null {
  const beforePrice = line.slice(0, Math.max(0, priceIndex)).replace(/\s+/g, " ").trim();
  const afterPrice = line.slice(priceIndex).replace(/\s+/g, " ").trim();
  const genericMatch = `${beforePrice} ${afterPrice}`.match(
    /\b(guinness|lager|pale ale|pacific ale|ipa|xpa|stout|porter|pilsner|draught|draft|cider|ginger beer)\b/i,
  );
  if (genericMatch?.[1]) {
    const maybeName = beforePrice
      .split(/(?:\||•|·| - | – | — |:)/)
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (maybeName && maybeName.length >= 3 && maybeName.length <= 80 && /[A-Za-z]/.test(maybeName)) {
      return maybeName
        .replace(/\b\d{1,3}(?:\.\d{1,2})?\b/g, "")
        .replace(/[\s([{:;,/\\-]+$/g, "")
        .trim();
    }
    return genericMatch[1].replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  return null;
}

const EXTRACTION_FOOD_EVENT_NOISE_PATTERN =
  /\b(?:beer[-\s]?battered|sour\s+cream|sweet\s+chilli|red\s+wine\s+vinegar|red\s+wine\s+jus|white\s+wine\s+jus|wedges?|chips?|fries|salad|fish|prawns?|oysters?|calamari|seafood|steak|t[-\s]?bone|rib[-\s]?eye|porterhouse|sirloin|scotch\s+fillet|eye\s+fillet|tenderloin|wagyu|angus|beef|chicken|pork|lamb|brisket|ribs?|cutlets?|roast|charcuterie|platter|grazing|cheese|tart|msa\s*\d?\s*grade|\d+\s*day\s+aged|dry[-\s]?aged|grass[-\s]?fed|grain[-\s]?fed|burger|burgers?|parmas?|parma|parmigiana|schnitzel|sandwich|toastie|share\s+plates?|pub\s+meal|dessert|festival|tickets?|tix|birthday|olympics?|carols|wrestling|run|km|food\s+and\s+beverage\s+stalls?|bottomless|course\s+meal|vegetarian|vegan|fine\s+sugar|fresh\s+ginger|honey\s+with\s+ginger)\b/i;
const EXTRACTION_ARTICLE_OR_JSON_NOISE_PATTERN =
  /\b(?:description|urlslug|structured_data|utm_|blogs?\/|\/news\/|\/articles?\/|cdn\/shop|width=|join\s+us|hosting|celebrate|soak\s+up|grab\s+a\s+free|served\s+with|glass\s+of\s+house\s+wine|house\s+wine|soft\s+drink|official\s+beer\s+(?:and\s+cider\s+)?partner|bookings?|reservations?|guests?|time\s+slots?|security|confiscated|litres?\s+of\s+beer|beer\s+mugs?|million\s+litres?|guided\s+tour|terminal\s+\d|first\s+working\s+brewery|fourth\s+in\s+the\s+world)\b/i;

function isReadableExtractionText(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 3) {
    return false;
  }

  const strangeChars = compact.match(/[^\x20-\x7e\u00a0-\u024f]/g)?.length ?? 0;
  if (strangeChars >= 3 && strangeChars / compact.length > 0.08) {
    return false;
  }

  const letters = compact.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 3;
}

function isLikelyMenuNoiseText(value: string): boolean {
  if (!isReadableExtractionText(value)) {
    return true;
  }
  const hasBeerServingSignal = /\b(?:beer|pint|schooner|pot|jug|tap|draught|draft|lager|ale|ipa|xpa|stout|porter|pilsner|cider)\b/i.test(value);
  const hasHardNonBeerDrinkSignal =
    /\b(?:cocktails?|spritz|margarita|negroni|amaretto|mini\s+beer|baby\s+guinness|gin|vodka|rum|tequila|mezcal|vermouth|amaro|aperitif|liqueur|whisk(?:e)?y|bourbon|scotch|rye|brandy|cognac|sambuca|ouzo|pisco|campari|aperol)\b/i.test(
      value,
    );
  const hasWineOnlySignal = /\bwine\b/i.test(value) && !hasBeerServingSignal;
  return (
    EXTRACTION_FOOD_EVENT_NOISE_PATTERN.test(value) ||
    EXTRACTION_ARTICLE_OR_JSON_NOISE_PATTERN.test(value) ||
    hasHardNonBeerDrinkSignal ||
    hasWineOnlySignal
  );
}

function isUsableExtractedDrinkName(name: string, trackedBeer: string | null): boolean {
  const trimmed = name.trim();
  const loose = normalizeLooseText(trimmed);
  if (!trimmed || !loose || !/[a-z]/i.test(trimmed)) {
    return false;
  }
  if (/^\+/.test(trimmed)) {
    return false;
  }
  if (/^(?:https?:)?\/\//i.test(trimmed) || /^\//.test(trimmed) || /\b(?:cdn\/shop|\.com\/|\.com\.au\/|width=|[?&]v=)\b/i.test(trimmed)) {
    return false;
  }
  if (/^\(/.test(trimmed) || /\b\d{3,4}\s*ml\b/i.test(trimmed) || /\b\d{2,4}\s*ml\b/i.test(trimmed) && /\b\d{1,4}\s*g\b/i.test(trimmed)) {
    return false;
  }
  if (!trackedBeer && (trimmed.length > 70 || loose.split(/\s+/).length > 9)) {
    return false;
  }
  if (/[[\]{}\\]/.test(trimmed)) {
    return false;
  }
  if (
    !trackedBeer &&
    /\b(?:wine|cocktails?|spritz|margarita|negroni|amaretto|mini\s+beer|baby\s+guinness|gin|vodka|rum|tequila|mezcal|vermouth|amaro|aperitif|liqueur|whisk(?:e)?y|bourbon|scotch|rye|brandy|cognac|sambuca|ouzo|pisco|campari|aperol|tanqueray|poor\s+tom'?s|archie\s+rose|aviation|four\s+pillars|mgc|hellyer'?s|noilly\s+prat|marionette|bulleit|bitter\s+orange|dry\s+cassis|single\s+shot)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (isLikelyMenuNoiseText(trimmed)) {
    return false;
  }
  if (
    /\b(?:we offer|with over|rotating selection|across|generally|increase quantity|decrease quantity|add to cart|sold out|years?|source line|served with|from \d{1,2}(?:am|pm)|happy hour from)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  const letterCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const punctuationCount = (trimmed.match(/[^A-Za-z0-9\s&'.-]/g) ?? []).length;
  if (!trackedBeer && punctuationCount > Math.max(2, letterCount / 5)) {
    return false;
  }

  return true;
}

type TextExtractionSection = {
  label: string;
  availabilityStatus: MenuImageOcrBeer["availabilityStatus"];
};

const TEXT_TAP_SECTION_PATTERN = /^(?:on\s+tap|tap|tap\s+beers?|beers?\s+on\s+tap|draught|draft)$/i;
const TEXT_TAP_SECTION_PREFIX_PATTERN = /^(?:on\s+tap|tap|tap\s+beers?|beers?\s+on\s+tap|draught|draft)\b/i;
const TEXT_PACKAGE_SECTION_PATTERN =
  /^(?:tins?\s*(?:&|and|or)\s*bottles?|bottles?\s*(?:&|and|or)\s*(?:cans?|tins?)|cans?\s*(?:&|and|or)\s*bottles?|cans?|bottles?|tinnies?|packaged(?:\s+(?:beer|drinks?))?)$/i;
const TEXT_PACKAGE_SECTION_PREFIX_PATTERN =
  /^(?:tins?\s*(?:&|and|or)\s*bottles?|bottles?\s*(?:&|and|or)\s*(?:cans?|tins?)|cans?\s*(?:&|and|or)\s*bottles?|tinnies?|packaged(?:\s+(?:beer|drinks?))?)\b/i;
const TEXT_NON_BEER_SECTION_PATTERN =
  /^(?:red(?:\s+wine)?|white(?:\s+wine)?|sparkling(?:\s*&\s*|\s+and\s+)ros[eé]|ros[eé]|cocktails?|spirits?|food|snacks?|kitchen|desserts?)$/i;
const TEXT_ABV_PATTERN = /\b(?:ABV\s*)?(<\s*)?\d{1,2}(?:\.\d+)?\s*%/i;
const TEXT_DETAIL_LINE_PATTERN =
  /\b(?:brewing|brewery|brewers?|beer|co|company|stone\s*&\s*wood|mountain\s+culture|bonehead|guinness|asahi|pabst|heaps\s+normal|two\s+bays|bad\s+shepherd|venom|brick\s+lane|hargraves?|hargreaves?)\b/i;

function sectionFromExtractionLine(line: string): TextExtractionSection | "reset" | null {
  const cleaned = line
    .replace(/[^\w\s&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return null;
  }
  if (TEXT_TAP_SECTION_PATTERN.test(cleaned) || TEXT_TAP_SECTION_PREFIX_PATTERN.test(cleaned)) {
    return { label: "ON TAP", availabilityStatus: "on_tap" };
  }
  if (TEXT_PACKAGE_SECTION_PATTERN.test(cleaned) || TEXT_PACKAGE_SECTION_PREFIX_PATTERN.test(cleaned)) {
    return { label: "CANS OR BOTTLES", availabilityStatus: "package_only" };
  }
  if (TEXT_NON_BEER_SECTION_PATTERN.test(cleaned)) {
    return "reset";
  }
  return null;
}

function isTextBeerDetailLine(line: string): boolean {
  if (!line || extractPriceMatchesFromLine(line).length > 0) {
    return false;
  }
  return TEXT_ABV_PATTERN.test(line) || (TEXT_DETAIL_LINE_PATTERN.test(line) && /\s+-\s+/.test(line));
}

function detailLineAfter(lines: string[], index: number): string | null {
  for (let offset = 1; offset <= 2; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate) {
      return null;
    }
    if (sectionFromExtractionLine(candidate)) {
      return null;
    }
    if (extractPriceMatchesFromLine(candidate).length > 0) {
      return null;
    }
    if (isTextBeerDetailLine(candidate)) {
      return candidate.length <= 180 ? candidate : `${candidate.slice(0, 177)}...`;
    }
    if (!/^(?:ask\s+staff|rotating|specials?|lager|ipa|dark\s+beer|sour\s+beer|ginger\s+beer|seltzers?|ciders?)\b/i.test(candidate)) {
      return null;
    }
  }
  return null;
}

function abvNoteFromText(value: string | null): string | null {
  const match = value?.match(TEXT_ABV_PATTERN);
  if (!match?.[0]) {
    return null;
  }
  return `ABV: ${match[0].replace(/^ABV\s*/i, "").replace(/\s+/g, "")}`;
}

function inferAvailabilityStatus(
  line: string,
  section: TextExtractionSection | null = null,
): MenuImageOcrBeer["availabilityStatus"] {
  if (/\b(can|cans|bottle|bottles|tin|tins|tinnie|tinnies|bucket|pack|takeaway)\b/i.test(line)) {
    return "package_only";
  }
  if (/\b(tap|draught|draft|pint|schooner|pot|jug|500\s?ml|425\s?ml|285\s?ml)\b/i.test(line)) {
    return "on_tap";
  }
  if (section?.availabilityStatus === "on_tap") {
    return "on_tap";
  }
  if (section?.availabilityStatus === "package_only") {
    return "package_only";
  }
  if (/\d\s*\/\s*\d/.test(line) && !/\b(wine|cocktail|spritz|margarita|negroni)\b/i.test(line)) {
    return "on_tap";
  }
  return "unknown";
}

function inferServingNote(line: string): string | null {
  const match = line.match(/\b(pint|schooner|pot|jug|can|tin|tinnie|bottle|bucket|500\s?ml|425\s?ml|285\s?ml|570\s?ml)\b/i);
  return match?.[1] ? `Serving hint: ${match[1]}` : null;
}

function priceContext(line: string, priceIndex: number): string {
  return line.slice(Math.max(0, priceIndex - 90), Math.min(line.length, priceIndex + 90));
}

function isLikelyFoodOrMerchPrice(line: string, priceIndex: number): boolean {
  const context = priceContext(line, priceIndex);
  const nearPrice = line.slice(Math.max(0, priceIndex - 45), Math.min(line.length, priceIndex + 55));
  const immediatelyAfterPrice = line.slice(priceIndex, Math.min(line.length, priceIndex + 40));
  if (isLikelyMenuNoiseText(context)) {
    return true;
  }
  if (/\b(prawn cocktail|shrimp cocktail|seafood cocktail|oyster shooter|calamari|garlic prawns)\b/i.test(context)) {
    return true;
  }
  if (/\b(red wine jus|white wine jus|jus|aioli|mayo|gravy|dipping sauce|sauce)\b/i.test(context)) {
    return true;
  }
  if (/\b(pizza|pie|gravy|jus|aioli|mayo|sauce|steak|t[-\s]?bone|rib[-\s]?eye|porterhouse|sirloin|scotch\s+fillet|eye\s+fillet|tenderloin|wagyu|angus|msa\s*\d?\s*grade|striploin|burger|chips|fries|salad|pasta|risotto|chicken|beef|pork|lamb|fish|prawn|prawns|oyster|oysters|calamari|seafood|taco|tacos|nachos|parma|parmigiana|schnitzel|sandwich|toastie|dessert|cake|pudding|roast|charcuterie|platter|grazing|cheese|tart|gift card|voucher)\b/i.test(immediatelyAfterPrice)) {
    return true;
  }

  const foodNearPrice =
    /\b(pizza|pie|gravy|jus|aioli|mayo|sauce|steak|t[-\s]?bone|rib[-\s]?eye|porterhouse|sirloin|scotch\s+fillet|eye\s+fillet|tenderloin|wagyu|angus|msa\s*\d?\s*grade|striploin|burger|chips|fries|salad|pasta|risotto|chicken|beef|pork|lamb|fish|prawn|prawns|oyster|oysters|calamari|seafood|taco|tacos|nachos|parma|parmigiana|schnitzel|sandwich|toastie|dessert|cake|pudding|roast|charcuterie|platter|grazing|cheese|tart|tasting paddle|gift card|voucher|function|booking|room hire)\b/i.test(
      nearPrice,
    );
  const drinkNearPrice =
    /\b(pint|schooner|pot|jug|tap|draught|draft|can|tin|tinnie|bottle|cocktail|wine|spritz|margarita|happy\s?hour|beer\s+(?:special|deal|price))\b/i.test(
      nearPrice,
    );
  const mealWithDrinkBundle =
    foodNearPrice &&
    /\b(served with|with fries|with chips|with a glass|with (?:a )?(?:pot|schooner|pint) of beer|with (?:a )?schooner of beer|glass of house wine|house wine|soft drink|paired with|includes|meal with|dish with)\b/i.test(
      context,
    );
  if (mealWithDrinkBundle) {
    return true;
  }
  if (foodNearPrice && !drinkNearPrice) {
    return true;
  }

  const hasStrongDrinkFormat =
    /\b(pint|schooner|pot|jug|tap|draught|draft|can|tin|tinnie|bottle|cocktail|wine|spritz|margarita|happy\s?hour|beer\s+(?:special|deal|price))\b/i.test(
      context,
    );
  if (hasStrongDrinkFormat) {
    return false;
  }

  return /\b(pizza|pie|gravy|jus|aioli|mayo|sauce|steak|t[-\s]?bone|rib[-\s]?eye|porterhouse|sirloin|scotch\s+fillet|eye\s+fillet|tenderloin|wagyu|angus|msa\s*\d?\s*grade|striploin|burger|chips|fries|salad|pasta|risotto|chicken|beef|pork|lamb|fish|prawn|prawns|oyster|oysters|calamari|seafood|taco|tacos|nachos|parma|parmigiana|schnitzel|sandwich|toastie|dessert|cake|pudding|roast|charcuterie|platter|grazing|cheese|tart|tasting paddle|gift card|voucher|function|booking|room hire)\b/i.test(
    context,
  );
}

interface TextPriceMatch {
  index: number;
  priceNumeric: number;
  priceText: string;
  hadCurrency: boolean;
}

function hasDrinkExtractionTerm(line: string): boolean {
  return /\b(beer|pint|tap|draught|draft|lager|ale|ipa|xpa|stout|porter|pilsner|cider|guinness|carlton|stone|wood|happy\s?hour|schooner|pot|jug|can|tin|tinnie|bottle)\b/i.test(
    line,
  );
}

function formatCurrencyPrice(value: number): string {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function overlapsExistingSpan(start: number, end: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function isEmbeddedInMeasurementToken(line: string, start: number, end: number): boolean {
  const before = line.slice(Math.max(0, start - 1), start);
  const after = line.slice(end, Math.min(line.length, end + 6));
  if (/\d/.test(before)) {
    return true;
  }
  return /^\s*(?:ml|l\b|oz|cl|g\b|kg\b|%|days?\b|years?\b|yrs?\b|packs?\b|grade\b)/i.test(after);
}

function isBarePriceTokenAllowed(line: string, start: number, end: number, value: number): boolean {
  if (value < 2 || value > 80) {
    return false;
  }
  if (value < 5 && !/\b(happy\s?hour|special|pot|middy|sample|taster|schooner)\b/i.test(priceContext(line, start))) {
    return false;
  }

  const before = line.slice(Math.max(0, start - 2), start);
  const after = line.slice(end, Math.min(line.length, end + 14));
  if (/[.$:#]$/.test(before) || /^[:.%A-Za-z]/.test(after) || /^[-/]\d/.test(after) || /^-\s*(?:hour|hours?|hrs?)\b/i.test(after) || /-\s*$/.test(before)) {
    return false;
  }
  if (/^\s*(?:am|pm|hrs?|hours?|mins?|minutes?|kg|g|ml|l\b|oz|people|guests|days?|packs?|for\b|off\b|%)/i.test(after)) {
    return false;
  }
  if (/^\s*(?:\+?\s*)?(?:beers?\s+on\s+tap|tap\s+beers?|beers?\s+including|different\s+(?:draught|draft|tap\s+)?beers?|(?:draught|draft|tap)\s+(?:beers?|bar|taps?)(?:\s+(?:to\s+choose|available|on\s+tap))?|taps?\s+(?:will\s+pour|to\s+choose|available))\b/i.test(after)) {
    return false;
  }
  if (/\b(?:19|20)\d{2}\b/.test(line.slice(Math.max(0, start - 8), Math.min(line.length, end + 8)))) {
    return false;
  }
  if (/\b(?:years?|founded|established|opened|serving locals|bar scene|groups?\s+of|how\s+many|bookings?|guests?|litres?|mugs?|glasses?|mouthwatering|pub\s+meal)\b/i.test(priceContext(line, start))) {
    return false;
  }

  const context = priceContext(line, start);
  return /\b(pint|schooner|pot|jug|tap|draught|draft|can|tin|tinnie|bottle|beer|lager|ale|stout|ipa|xpa|cider)\b/i.test(
    context,
  );
}

function isPlausibleDrinkPrice(line: string, match: TextPriceMatch): boolean {
  if (match.priceNumeric <= 0 || match.priceNumeric > 40) {
    return false;
  }
  if (!match.hadCurrency && match.priceNumeric > 30) {
    return false;
  }
  if (match.priceNumeric > 28 && /\b(can|cans|tin|tins|tinnie|tinnies|bottle|bottles|375\s?ml|355\s?ml|330\s?ml|carton|case|pack)\b/i.test(line)) {
    return false;
  }
  if (/\b(?:million|billion)\s+(?:venue|fitout|renovation|development|project)\b/i.test(line)) {
    return false;
  }
  if (/\bwith\s+over\s+\d{1,2}\s+beers?\s+on\s+tap\b/i.test(line)) {
    return false;
  }
  if (/\b\d{1,2}\+?\s+(?:different\s+)?(?:draught|draft|tap\s+)?(?:beers?|taps?|tap\s+bar)(?:\s+(?:to\s+choose|available|on\s+tap|will\s+pour))?\b/i.test(line)) {
    return false;
  }
  if (/\b(?:groups?\s+of\s+\d|how\s+many|litres?\s+of\s+beer|beer\s+mugs?|million\s+litres?|glasses?|bookings?|guests?|mouthwatering\s+burgers?|pub\s+meal|fave\s+dish|pot\s+of\s+beer\s+or\s+house\s+wine)\b/i.test(line)) {
    return false;
  }
  if (/\b\d{1,2}\s+tap\s+beers?\b/i.test(line) && !/\b(?:pint|schooner|pot|jug)\b/i.test(line)) {
    return false;
  }
  if (
    /\b(?:festival|tickets?|tix|birthday|olympics?|carols|wrestling|run|km|bottomless|beer\s+tasting|food\s+and\s+beverage\s+stalls?)\b/i.test(line) &&
    !/\b(?:pint|schooner|pot|jug|tap|draught|draft)\b/i.test(line)
  ) {
    return false;
  }
  return true;
}

function isUsableExtractionLine(line: string): boolean {
  if (isLikelyMenuNoiseText(line)) {
    return false;
  }
  if (/(?:\\[()])|(?:\]\s*TJ\b)|(?:\)\s*Tj\b)/i.test(line)) {
    return false;
  }
  if (/\b(?:urlSlug|qtyInStock|allowMultiplePurchase|mightHavePaymentPlan|published|productId)\b/i.test(line)) {
    return false;
  }
  if (/\b(?:increase quantity|decrease quantity|add to cart|checkout|subtotal|variant|unit price|regular price)\b/i.test(line)) {
    return false;
  }
  if (/\/blogs?\//i.test(line) || /\/news\//i.test(line) || /\/articles?\//i.test(line) || /utm_campaign=structured_data_events|event\/|\/events?\//i.test(line)) {
    return false;
  }
  if (/https?:\/\/|(?:^|[\s"'])\/\/|cdn\/shop|width=\d|[?&]v=\d/i.test(line)) {
    return false;
  }
  return true;
}

function extractPriceMatchesFromLine(line: string): TextPriceMatch[] {
  const matches: TextPriceMatch[] = [];
  const currencySpans: Array<{ start: number; end: number }> = [];
  const currencyPattern = /(?:A\$|AUD\s*|\$)\s*(\d{1,3}(?:\.\d{1,2})?)/gi;
  let currencyMatch: RegExpExecArray | null;

  while ((currencyMatch = currencyPattern.exec(line))) {
    const numericRaw = currencyMatch[1];
    if (!numericRaw) {
      continue;
    }
    const priceNumeric = Number(numericRaw);
    if (!Number.isFinite(priceNumeric) || priceNumeric <= 0 || priceNumeric > 200) {
      continue;
    }
    const start = currencyMatch.index;
    const end = currencyMatch.index + currencyMatch[0].length;
    if (isEmbeddedInMeasurementToken(line, start, end)) {
      continue;
    }
    currencySpans.push({ start, end });
    matches.push({
      index: start,
      priceNumeric,
      priceText: formatCurrencyPrice(priceNumeric),
      hadCurrency: true,
    });
  }

  if (!hasDrinkExtractionTerm(line)) {
    return matches;
  }

  const barePattern = /(?:^|[^\w$])(\d{1,2}(?:\.\d{1,2})?)(?!\d)/gi;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = barePattern.exec(line))) {
    const numericRaw = bareMatch[1];
    if (!numericRaw) {
      continue;
    }
    const start = bareMatch.index + bareMatch[0].indexOf(numericRaw);
    const end = start + numericRaw.length;
    if (isEmbeddedInMeasurementToken(line, start, end)) {
      continue;
    }
    if (overlapsExistingSpan(start, end, currencySpans)) {
      continue;
    }
    const priceNumeric = Number(numericRaw);
    if (!Number.isFinite(priceNumeric) || !isBarePriceTokenAllowed(line, start, end, priceNumeric)) {
      continue;
    }
    matches.push({
      index: start,
      priceNumeric,
      priceText: formatCurrencyPrice(priceNumeric),
      hadCurrency: false,
    });
  }

  return matches.sort((a, b) => a.index - b.index);
}

function splitTextIntoExtractionLines(text: string): string[] {
  const normalized = splitCollapsedMenuRowsForExtraction(text)
    .replace(/\r/g, "\n")
    .replace(/[•·]/g, "\n")
    .replace(/\s+\|\s+/g, "\n");

  return normalized
    .split(/\n|(?<=\d)\s{2,}(?=[A-Z])|(?<=[.!?])\s+(?=[A-Z])/)
    .flatMap((line) => {
      const trimmed = line.replace(/[ \t]+/g, " ").trim();
      if (trimmed.length <= 240) {
        return trimmed ? [trimmed] : [];
      }
      return trimmed.match(/.{1,220}(?:\s|$)/g)?.map((chunk) => chunk.trim()).filter(Boolean) ?? [];
    })
    .filter(Boolean);
}

function normalizeTextRowAvailabilityFromSectionNote(row: MenuImageOcrBeer): MenuImageOcrBeer {
  if (row.availabilityStatus !== "unknown" || !row.notes) {
    return row;
  }
  if (/\bSection:\s*ON TAP\b/i.test(row.notes)) {
    return { ...row, availabilityStatus: "on_tap" };
  }
  if (/\bSection:\s*CANS OR BOTTLES\b/i.test(row.notes)) {
    return { ...row, availabilityStatus: "package_only" };
  }
  return row;
}

function extractBeerRowsFromText(text: string): MenuImageOcrBeer[] {
  const structuredRows = extractStructuredBeerRowsFromText(text).slice(0, MAX_ROWS_PER_TEXT_SOURCE);
  const rows: MenuImageOcrBeer[] = [...structuredRows];
  const seen = new Set(
    structuredRows.map((row) => `${normalizeLooseText(row.name)}|${row.priceNumeric ?? ""}|${row.availabilityStatus}`),
  );
  const structuredNames = new Set(structuredRows.map((row) => normalizeLooseText(row.name)));
  const structuredNameAvailability = new Set(
    structuredRows.map((row) => `${normalizeLooseText(row.name)}|${row.availabilityStatus}`),
  );

  let currentSection: TextExtractionSection | null = null;
  const extractionLines = splitTextIntoExtractionLines(text);
  for (let lineIndex = 0; lineIndex < extractionLines.length; lineIndex += 1) {
    const line = extractionLines[lineIndex]!;
    const section = sectionFromExtractionLine(line);
    if (section === "reset") {
      currentSection = null;
      continue;
    }
    if (section) {
      currentSection = section;
      continue;
    }

    const lower = line.toLowerCase();
    if (!hasDrinkExtractionTerm(lower) || !isUsableExtractionLine(line)) {
      continue;
    }

    const priceMatches = extractPriceMatchesFromLine(line);
    const lineNameServingKeys = new Set<string>();
    for (const match of priceMatches) {
      if (rows.length >= MAX_ROWS_PER_TEXT_SOURCE) {
        break;
      }
      if (!isPlausibleDrinkPrice(line, match)) {
        continue;
      }
      if (isLikelyFoodOrMerchPrice(line, match.index)) {
        continue;
      }

      const localPriceContext = priceContext(line, match.index);
      const detailLine = detailLineAfter(extractionLines, lineIndex);
      const trackedBeer = findTrackedBeerInText(`${localPriceContext} ${detailLine ?? ""}`);
      const genericName = trackedBeer ? null : inferGenericDrinkName(line, match.index);
      const name = canonicalizeTrackedBeerName(trackedBeer ?? genericName ?? "");
      if (!name || name.length < 3 || !isUsableExtractedDrinkName(name, trackedBeer)) {
        continue;
      }

      const inferredAvailabilityStatus = inferAvailabilityStatus(line, currentSection);
      const availabilityStatus =
        inferredAvailabilityStatus === "unknown" && currentSection?.availabilityStatus
          ? currentSection.availabilityStatus
          : inferredAvailabilityStatus;
      const nameAvailabilityKey = `${normalizeLooseText(name)}|${availabilityStatus}`;
      if (structuredNameAvailability.has(nameAvailabilityKey) || (availabilityStatus === "unknown" && structuredNames.has(normalizeLooseText(name)))) {
        continue;
      }

      const servingNote = inferServingNote(line);
      const lineNameServingKey = `${normalizeLooseText(name)}|${availabilityStatus}|${normalizeLooseText(servingNote ?? "")}`;
      if (priceMatches.length > 1 && lineNameServingKeys.has(lineNameServingKey)) {
        continue;
      }
      lineNameServingKeys.add(lineNameServingKey);
      const notes = [
        currentSection ? `Section: ${currentSection.label}` : null,
        servingNote,
        line.length <= 180 ? `Source line: ${line}` : `Source line: ${line.slice(0, 177)}...`,
        detailLine ? `Beer details: ${detailLine}` : null,
        abvNoteFromText(`${line} ${detailLine ?? ""}`),
      ]
        .filter(Boolean)
        .join(" | ");
      const key = `${normalizeLooseText(name)}|${match.priceNumeric}|${availabilityStatus}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      rows.push({
        name,
        priceNumeric: match.priceNumeric,
        priceText: match.priceText,
        availabilityStatus,
        notes,
        confidence: trackedBeer ? (match.hadCurrency ? 0.82 : 0.76) : (match.hadCurrency ? 0.62 : 0.55),
      });
    }
  }

  return rows.map(normalizeTextRowAvailabilityFromSectionNote);
}

function buildTextExtraction(method: TextExtractionMethod, text: string, rawSourceText: string = text): MenuTextExtractionResult | null {
  const sourceText = textForExtraction(text);
  if (!sourceText || !hasDrinkPriceSignals(sourceText)) {
    return null;
  }

  const cardRows =
    method === "html_text" ? extractOnTapCardRowsFromHtml(rawSourceText).slice(0, MAX_ROWS_PER_TEXT_SOURCE) : [];
  const rows = cardRows.length >= 3 ? cardRows : extractBeerRowsFromText(sourceText);
  if (rows.length === 0) {
    return {
      attemptedAt: new Date().toISOString(),
      method,
      rows,
      notes: ["Drink-price text was present, but no confident beer rows were extracted."],
      error: null,
    };
  }

  return {
    attemptedAt: new Date().toISOString(),
    method,
    rows,
    notes: [
      cardRows.length >= 3
        ? `Extracted ${rows.length} row${rows.length === 1 ? "" : "s"} from structured on-tap HTML cards.`
        : `Extracted ${rows.length} row${rows.length === 1 ? "" : "s"} from ${method.replace("_", " ")}.`,
    ],
    error: null,
  };
}

function classifySource(url: string, contentType: string): SourceKind {
  const lowerContentType = contentType.toLowerCase();
  if (lowerContentType.startsWith("image/") || isImageUrl(url)) {
    return "menu_image";
  }
  if (lowerContentType.includes("pdf") || isPdfUrl(url)) {
    return "menu_pdf";
  }
  return "menu_page";
}

function scoreSource(input: {
  venue: VenueCandidate;
  officialWebsite: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  text: string;
  linkText: string;
}): MenuSourceCandidate | null {
  const signals: string[] = [];
  let confidence = 0;
  if (isTimeLimitedMenuSource(input.sourceUrl, input.linkText)) {
    return null;
  }

  const hasStrongDrinkText = hasDrinkPriceSignals(input.text) || /\b(beer|drinks?|tap\s?list)\b/i.test(input.text);
  const isGeneratedDiscoveryLink = /\b(common menu path probe|sitemap menu url|robots sitemap menu url|wordpress rest menu url|quoted url menu asset|embedded json menu asset)\b/i.test(input.linkText);
  const discoveryMethod = discoveryMethodFromLinkText(input.linkText, input.officialWebsite, input.sourceUrl);
  const trustedExternalMenuHost = !sameOrigin(input.officialWebsite, input.sourceUrl) && isTrustedExternalMenuHost(input.sourceUrl);
  const hasMenuLinkSignal = sourceHasMenuSignal(input.linkText, input.sourceUrl);

  if (isGeneratedDiscoveryLink && input.sourceKind === "menu_page" && !hasStrongDrinkText) {
    return null;
  }
  if (input.sourceKind === "menu_page" && isLowIntentMenuSourceUrl(input.sourceUrl) && !hasMenuLinkSignal) {
    return null;
  }

  if (sameOrigin(input.officialWebsite, input.sourceUrl)) {
    signals.push("same official host");
    confidence += 0.35;
  } else if (trustedExternalMenuHost) {
    signals.push("trusted external menu host");
    confidence += 0.2;
  }

  if (hasMenuLinkSignal) {
    signals.push("menu link");
    confidence += 0.25;
  }

  if (hasDrinkPriceSignals(input.text)) {
    signals.push("drink price text");
    confidence += 0.25;
  } else if (hasStrongDrinkText) {
    signals.push("drink menu text");
    confidence += 0.12;
  }

  const venueSignals = venueNameSignals(input.venue, `${input.linkText} ${input.text} ${input.sourceUrl}`);
  if (venueSignals.length > 0) {
    signals.push(`venue match: ${venueSignals.join(", ")}`);
    confidence += 0.15;
  }

  if (input.sourceKind === "menu_image") {
    if (!isLikelyMenuImageCandidate(input.sourceUrl, input.linkText)) {
      return null;
    }
    signals.push("direct image OCR eligible");
    confidence += 0.12;
  }

  confidence = Math.min(1, Number(confidence.toFixed(2)));
  if (confidence < 0.48) {
    return null;
  }

  const freshness = inferFreshness(input.text);
  return {
    venueId: input.venue.id,
    venueName: input.venue.name,
    venueAddress: input.venue.address,
    venueSuburb: input.venue.suburb,
    officialWebsite: input.officialWebsite,
    sourceUrl: input.sourceUrl,
    canonicalSourceUrl: canonicalDiscoveryUrl(input.sourceUrl),
    sourceDomain: sourceDomainFor(input.sourceUrl),
    sourceOrigin: sourceOriginFor(input.officialWebsite, input.sourceUrl),
    sourceKind: input.sourceKind,
    discoveryMethod,
    confidence,
    canQueueOcr: input.sourceKind === "menu_image",
    freshness: freshness.freshness,
    publishedAt: freshness.publishedAt,
    signals,
    reviewNote:
      input.sourceKind === "menu_image"
        ? "Direct menu image candidate. Queue OCR only after checking it belongs to this venue."
        : input.sourceKind === "menu_pdf"
          ? "PDF menu candidate. Text extraction is best-effort; review source before using any prices."
          : "Menu source candidate. Text extraction is best-effort; review source before using any prices.",
    ocr: null,
    textExtraction: null,
  };
}

function contentLengthBytes(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function maxBytesForResponse(url: string, contentType: string): number {
  const lowerContentType = contentType.toLowerCase();
  if (lowerContentType.startsWith("image/") || isImageUrl(url)) {
    return MAX_IMAGE_BYTES;
  }
  if (lowerContentType.includes("pdf") || isPdfUrl(url)) {
    return MAX_PDF_BYTES;
  }
  return MAX_HTML_BYTES;
}

function assertResponseSizeAllowed(url: string, contentType: string, bytes: number | null): void {
  if (bytes == null) {
    return;
  }
  const maxBytes = maxBytesForResponse(url, contentType);
  if (bytes > maxBytes) {
    throw new Error(`Source is too large for discovery extraction (${Math.round(bytes / 1024 / 1024)} MB)`);
  }
}

async function fetchTextForCandidateUncached(url: string): Promise<{ contentType: string; text: string }> {
  const response = await withTimeoutFetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  assertResponseSizeAllowed(url, contentType, contentLengthBytes(response));

  if (contentType.toLowerCase().startsWith("image/") || isImageUrl(url)) {
    return { contentType, text: "" };
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  assertResponseSizeAllowed(url, contentType, buffer.length);

  if (contentType.toLowerCase().includes("pdf") || isPdfUrl(url)) {
    return { contentType, text: await extractPdfText(buffer) };
  }

  const limited = buffer.subarray(0, Math.min(buffer.length, MAX_HTML_BYTES));
  return { contentType, text: limited.toString("utf8") };
}

async function fetchTextForCandidate(url: string): Promise<{ contentType: string; text: string }> {
  const cacheKey = canonicalDiscoveryUrl(url);
  const cached = textFetchCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetchTextForCandidateUncached(url).catch((error) => {
    textFetchCache.delete(cacheKey);
    throw error;
  });
  textFetchCache.set(cacheKey, request);
  return request;
}

async function fetchImageDataUrlForOcrUncached(sourceUrl: string): Promise<string> {
  const response = await withTimeoutFetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  assertResponseSizeAllowed(sourceUrl, contentType, contentLengthBytes(response));
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Expected image content, got ${contentType || "unknown content type"}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  assertResponseSizeAllowed(sourceUrl, contentType, buffer.length);

  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function fetchImageDataUrlForOcr(sourceUrl: string): Promise<string> {
  const cacheKey = canonicalDiscoveryUrl(sourceUrl);
  const cached = imageDataUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetchImageDataUrlForOcrUncached(sourceUrl).catch((error) => {
    imageDataUrlCache.delete(cacheKey);
    throw error;
  });
  imageDataUrlCache.set(cacheKey, request);
  return request;
}

async function maybeExtractImageOcr(candidate: MenuSourceCandidate, openai: OpenAI | null): Promise<MenuImageOcrResult | null> {
  if (!envFlag("MENU_DISCOVERY_OCR_IMAGES")) {
    return null;
  }

  if (!openai || candidate.sourceKind !== "menu_image") {
    return null;
  }

  const attemptedAt = new Date().toISOString();
  try {
    const imageDataUrl = await fetchImageDataUrlForOcr(candidate.sourceUrl);
    const prompt = [
      "Extract regular beer and drink-price information from this pub or bar menu image.",
      "Return JSON only.",
      "Schema:",
      "{",
      '  "venue_name_guess": string | null,',
      '  "captured_notes": string | null,',
      '  "overall_confidence": number | null,',
      '  "beers": [',
      "    {",
      '      "name": string,',
      '      "price_numeric": number | null,',
      '      "price_text": string | null,',
      '      "availability_status": "on_tap" | "package_only" | "unavailable" | "unknown",',
      '      "notes": string | null,',
      '      "confidence": number | null',
      "    }",
      "  ]",
      "}",
      "Only include rows that are readable and useful for a regular pub beer map price review.",
      "Do not include happy-hour, weekly-special, event, promo, deal, limited-time, or discounted special prices.",
      `If a beer clearly matches one of these tracked beers, use the exact canonical name: ${VIEWER_TRACKED_BEERS.map((beer) => beer.name).join(", ")}.`,
      "Keep each menu row separate. Do not carry a beer name or price from the previous or next row.",
      "Many PDF menus put the beer name and price on one line, then brewery, location, and ABV on the next line. Pair that following detail line with the beer above it in notes; do not emit the detail line as its own beer.",
      "Never use package volume, serving size, ABV, years, counts, or measurements such as 330ml, 335ml, 355ml, 375ml, 440ml, 500ml, 4.2%, 2025, 4 pack, grams, or litres as price_numeric.",
      "If a package row only shows size and ABV, with no actual price or currency, omit the row instead of inventing a price from the size.",
      "When a row shows labelled prices such as $8.5 POT, $17 PINT, choose the PINT price for price_numeric and price_text.",
      "When a table heading says Pots / Pints / Jugs, choose the Pints price as price_numeric and price_text.",
      "When a section heading says ON TAP, mark every readable beer row under that heading as availability_status 'on_tap' until the next major section heading, even if the row only shows prices like 9/16.5, 7.5/14, or /16.",
      "When a section heading says TINS & BOTTLES, TINS, TINNIES, BOTTLES & CANS, CANS OR BOTTLES, CANS, BOTTLES, or PACKAGED, mark rows under that heading as availability_status 'package_only'. In Australian menus, tins means cans.",
      "If an ABV percentage is printed beside a beer, include it in notes with the brewery/source wording.",
      "Do not include category headings such as Lager, IPA, Sour Beer, Red Wine, or White Wine as beer rows.",
      "If the row price/name pairing is ambiguous after checking the row and heading, omit the row instead of guessing.",
      `Venue hint: ${candidate.venueName}`,
      `Source URL: ${candidate.sourceUrl}`,
    ].join("\n");

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl, detail: "auto" },
          ],
        },
      ],
    });

    if (!response.output_text || !response.output_text.trim()) {
      throw new Error("OCR returned an empty response");
    }

    const parsed = parseJsonResponse(response.output_text);
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    const beers = Array.isArray(record.beers)
      ? record.beers.map(normalizeOcrBeer).filter((beer): beer is MenuImageOcrBeer => Boolean(beer))
      : [];

    return {
      attemptedAt,
      venueNameGuess: typeof record.venue_name_guess === "string" && record.venue_name_guess.trim()
        ? record.venue_name_guess.trim()
        : null,
      capturedNotes: typeof record.captured_notes === "string" && record.captured_notes.trim()
        ? record.captured_notes.trim()
        : null,
      overallConfidence: normalizeConfidence(record.overall_confidence, beers.length > 0 ? 0.7 : null),
      beers,
      error: null,
    };
  } catch (error) {
    return {
      attemptedAt,
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: null,
      beers: [],
      error: error instanceof Error ? error.message : "Unknown OCR error",
    };
  }
}

function sourceTextForScoring(sourceKind: SourceKind, fetchedText: string, linkText: string, sourceUrl: string): string {
  if (sourceKind === "menu_page" || sourceKind === "homepage_menu_signal") {
    return `${htmlToPlainText(fetchedText)}\n${extractJsonLdText(fetchedText)}`;
  }

  if (sourceKind === "menu_pdf") {
    return fetchedText;
  }

  return `${linkText} ${sourceUrl}`;
}

function textExtractionMethodForSource(sourceKind: SourceKind): TextExtractionMethod | null {
  if (sourceKind === "menu_pdf") {
    return "pdf_text";
  }
  if (sourceKind === "menu_page" || sourceKind === "homepage_menu_signal") {
    return "html_text";
  }
  return null;
}

function attachTextExtraction(candidate: MenuSourceCandidate, sourceText: string, rawSourceText: string = sourceText): void {
  const method = textExtractionMethodForSource(candidate.sourceKind);
  if (!method) {
    return;
  }

  candidate.textExtraction = buildTextExtraction(method, sourceText, rawSourceText);
  if (candidate.textExtraction?.rows.length) {
    candidate.signals.push(`${method.replace("_", " ")} rows`);
    candidate.confidence = Math.min(1, Number((candidate.confidence + 0.08).toFixed(2)));
  }
}

function siteRoot(officialWebsite: string): string | null {
  try {
    return new URL("/", officialWebsite).toString();
  } catch {
    return null;
  }
}

function buildCommonMenuProbeLinks(
  officialWebsite: string,
  seenUrls: Set<string>,
  limit: number,
): Array<{ url: string; text: string }> {
  const root = siteRoot(officialWebsite);
  if (!root) {
    return [];
  }

  const links: Array<{ url: string; text: string }> = [];
  for (const pathname of COMMON_MENU_PATHS) {
    if (links.length >= limit) {
      break;
    }
    const url = new URL(pathname, root).toString();
    addUniqueDiscoveryLink(links, seenUrls, { url, text: "common menu path probe" }, officialWebsite);
  }
  return links;
}

function extractSitemapUrls(xml: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const locPattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = locPattern.exec(xml))) {
    const raw = decodeHtml(stripHtml(match[1] ?? "")).trim();
    if (!raw) {
      continue;
    }
    try {
      const url = new URL(raw, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        urls.push(url.toString());
      }
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return urls;
}

function isLikelySitemapUrl(url: string): boolean {
  return /(?:sitemap|post-sitemap|page-sitemap|wp-sitemap).*\.(?:xml|xml\.gz)(?:[?#].*)?$/i.test(url);
}

async function fetchSitemapText(url: string): Promise<string> {
  const fetched = await fetchTextForCandidate(url);
  return fetched.text;
}

async function discoverSitemapQueueMenuLinks(
  officialWebsite: string,
  seenUrls: Set<string>,
  sitemapQueue: string[],
  limit: number,
  linkText: string,
): Promise<Array<{ url: string; text: string }>> {
  const visitedSitemaps = new Set<string>();
  const links: Array<{ url: string; text: string }> = [];

  while (sitemapQueue.length > 0 && visitedSitemaps.size < MAX_SITEMAP_FILES_PER_SITE && links.length < limit) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || visitedSitemaps.has(canonicalDiscoveryUrl(sitemapUrl))) {
      continue;
    }
    visitedSitemaps.add(canonicalDiscoveryUrl(sitemapUrl));

    let sitemapText = "";
    try {
      sitemapText = await fetchSitemapText(sitemapUrl);
    } catch {
      continue;
    }

    for (const url of extractSitemapUrls(sitemapText, sitemapUrl)) {
      if (!sameOrigin(officialWebsite, url)) {
        continue;
      }
      if (isLikelySitemapUrl(url) && visitedSitemaps.size + sitemapQueue.length < MAX_SITEMAP_FILES_PER_SITE) {
        sitemapQueue.push(url);
        continue;
      }
      if (sourceHasMenuSignal(linkText, url) || isPdfUrl(url) || isLikelyMenuImageCandidate(url, linkText)) {
        addUniqueDiscoveryLink(links, seenUrls, { url, text: linkText }, officialWebsite);
        if (links.length >= limit) {
          break;
        }
      }
    }
  }

  return links;
}

async function discoverSitemapMenuLinks(
  officialWebsite: string,
  seenUrls: Set<string>,
  limit: number,
): Promise<Array<{ url: string; text: string }>> {
  const root = siteRoot(officialWebsite);
  if (!root) {
    return [];
  }

  return discoverSitemapQueueMenuLinks(
    officialWebsite,
    seenUrls,
    [new URL("/sitemap.xml", root).toString(), new URL("/sitemap_index.xml", root).toString()],
    limit,
    "sitemap menu url",
  );
}

function extractRobotsSitemapUrls(text: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (!match?.[1]) {
      continue;
    }
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        urls.push(url.toString());
      }
    } catch {
      // Ignore malformed robots sitemap hints.
    }
  }
  return Array.from(new Set(urls.map(canonicalDiscoveryUrl))).slice(0, MAX_ROBOTS_SITEMAPS_PER_SITE);
}

async function discoverRobotsSitemapMenuLinks(
  officialWebsite: string,
  seenUrls: Set<string>,
  limit: number,
): Promise<Array<{ url: string; text: string }>> {
  const root = siteRoot(officialWebsite);
  if (!root) {
    return [];
  }

  try {
    const robots = await fetchTextForCandidate(new URL("/robots.txt", root).toString());
    const sitemapUrls = extractRobotsSitemapUrls(robots.text, root).filter((url) => sameOrigin(officialWebsite, url));
    if (sitemapUrls.length === 0) {
      return [];
    }
    return discoverSitemapQueueMenuLinks(officialWebsite, seenUrls, sitemapUrls, limit, "robots sitemap menu url");
  } catch {
    return [];
  }
}

async function discoverWordPressRestMenuLinks(
  officialWebsite: string,
  seenUrls: Set<string>,
  limit: number,
): Promise<Array<{ url: string; text: string }>> {
  const root = siteRoot(officialWebsite);
  if (!root) {
    return [];
  }

  const links: Array<{ url: string; text: string }> = [];
  const searchTerms = ["menu", "drinks", "beer"];
  for (const term of searchTerms) {
    if (links.length >= limit) {
      break;
    }

    const restUrl = new URL("/wp-json/wp/v2/search", root);
    restUrl.searchParams.set("search", term);
    restUrl.searchParams.set("per_page", "10");
    restUrl.searchParams.set("_fields", "url,title,type,subtype");

    let text = "";
    try {
      text = (await fetchTextForCandidate(restUrl.toString())).text;
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    for (const record of parsed) {
      if (links.length >= limit || !record || typeof record !== "object") {
        continue;
      }
      const item = record as Record<string, unknown>;
      const url = typeof item.url === "string" ? item.url : "";
      const title = typeof item.title === "string" ? item.title : "";
      if (!url || !sameOrigin(officialWebsite, url)) {
        continue;
      }
      if (!sourceHasMenuSignal(`wordpress rest menu url ${title}`, url) && !isPdfUrl(url)) {
        continue;
      }
      addUniqueDiscoveryLink(links, seenUrls, { url, text: `wordpress rest menu url ${title}`.trim() }, officialWebsite);
    }
  }

  return links;
}

function nestedMenuAssetLinks(html: string, pageUrl: string, officialWebsite: string, limit: number): Array<{ url: string; text: string }> {
  const seen = new Set<string>();
  return extractLinks(html, pageUrl)
    .map((link) => ({
      ...link,
      text: `${link.text} menu page asset`.trim(),
    }))
    .filter((link) => {
      const canonicalUrl = canonicalDiscoveryUrl(link.url);
      if (seen.has(canonicalUrl) || isExcludedMenuSourceUrl(link.url, link.text)) {
        return false;
      }
      if (!isAllowedMenuSourceUrl(officialWebsite, link.url, link.text)) {
        return false;
      }
      seen.add(canonicalUrl);
      return isPdfUrl(link.url) || isLikelyMenuImageCandidate(link.url, link.text) || sourceHasMenuSignal(link.text, link.url);
    })
    .slice(0, limit);
}

async function buildCandidateFromFetchedSource(input: {
  venue: VenueCandidate;
  officialWebsite: string;
  sourceUrl: string;
  fetched: { contentType: string; text: string };
  linkText: string;
}): Promise<{ candidate: MenuSourceCandidate | null; childLinks: Array<{ url: string; text: string }> }> {
  const sourceKind = classifySource(input.sourceUrl, input.fetched.contentType);
  const scoringText = sourceTextForScoring(sourceKind, input.fetched.text, input.linkText, input.sourceUrl);
  const candidate = scoreSource({
    venue: input.venue,
    officialWebsite: input.officialWebsite,
    sourceUrl: input.sourceUrl,
    sourceKind,
    text: scoringText,
    linkText: input.linkText,
  });

  if (candidate) {
    attachTextExtraction(candidate, scoringText, input.fetched.text);
  }

  const childLinks =
    sourceKind === "menu_page"
      ? nestedMenuAssetLinks(input.fetched.text, input.sourceUrl, input.officialWebsite, DEFAULT_MAX_SECONDARY_LINKS_PER_SOURCE)
      : [];

  return { candidate, childLinks };
}

function candidateRankScore(candidate: MenuSourceCandidate): number {
  const extractedRows = candidate.textExtraction?.rows.length ?? candidate.ocr?.beers.length ?? 0;
  const sourceKindScore =
    candidate.sourceKind === "menu_pdf" ? 12 : candidate.sourceKind === "menu_image" ? 10 : candidate.sourceKind === "homepage_menu_signal" ? 4 : 8;
  const freshnessScore = candidate.freshness === "within_last_year" ? 8 : candidate.freshness === "unknown" ? 3 : 0;
  const originScore = candidate.sourceOrigin === "official_host" ? 8 : 4;
  return extractedRows * 40 + candidate.confidence * 25 + sourceKindScore + freshnessScore + originScore;
}

function dedupeAndRankCandidates(candidates: MenuSourceCandidate[]): MenuSourceCandidate[] {
  const bestByUrl = new Map<string, MenuSourceCandidate>();
  for (const candidate of candidates) {
    const key = candidate.canonicalSourceUrl || canonicalDiscoveryUrl(candidate.sourceUrl);
    const existing = bestByUrl.get(key);
    if (!existing || candidateRankScore(candidate) > candidateRankScore(existing)) {
      bestByUrl.set(key, candidate);
    }
  }

  return Array.from(bestByUrl.values()).sort(
    (a, b) => candidateRankScore(b) - candidateRankScore(a) || b.confidence - a.confidence || a.sourceUrl.localeCompare(b.sourceUrl),
  );
}

async function discoverSourcesForVenue(
  venue: VenueCandidate,
  maxLinksPerVenue: number,
): Promise<{ candidates: MenuSourceCandidate[]; errors: Array<{ url: string; error: string }> }> {
  const officialWebsite = normalizeWebsite(venue.website);
  if (!officialWebsite) {
    return { candidates: [], errors: [] };
  }

  const candidates: MenuSourceCandidate[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  const seenUrls = new Set<string>();
  seenUrls.add(canonicalDiscoveryUrl(officialWebsite));

  try {
    const homepage = await fetchTextForCandidate(officialWebsite);
    const homepageText = `${htmlToPlainText(homepage.text)}\n${extractJsonLdText(homepage.text)}`;
    if (hasDrinkPriceSignals(homepageText) || /\b(menu|drinks?)\b/i.test(homepageText)) {
      const candidate = scoreSource({
        venue,
        officialWebsite,
        sourceUrl: officialWebsite,
        sourceKind: "homepage_menu_signal",
        text: homepageText,
        linkText: "homepage",
      });
      if (candidate) {
        attachTextExtraction(candidate, homepageText, homepage.text);
        candidates.push(candidate);
      }
    }

    const links: Array<{ url: string; text: string }> = [];
    for (const link of extractLinks(homepage.text, officialWebsite)) {
      if (links.length >= maxLinksPerVenue) {
        break;
      }
      const menuSignal = sourceHasMenuSignal(link.text, link.url);
      if (menuSignal || isPdfUrl(link.url) || isLikelyMenuImageCandidate(link.url, link.text)) {
        addUniqueDiscoveryLink(links, seenUrls, link, officialWebsite);
      }
    }

    const sitemapLinks = await discoverSitemapMenuLinks(officialWebsite, seenUrls, MAX_SITEMAP_URLS_PER_SITE);
    links.push(...sitemapLinks);

    const robotsSitemapLinks = await discoverRobotsSitemapMenuLinks(officialWebsite, seenUrls, MAX_SITEMAP_URLS_PER_SITE);
    links.push(...robotsSitemapLinks);

    const wordpressRestLinks = await discoverWordPressRestMenuLinks(officialWebsite, seenUrls, DEFAULT_MAX_WORDPRESS_LINKS_PER_SITE);
    links.push(...wordpressRestLinks);

    const probeLinks = buildCommonMenuProbeLinks(officialWebsite, seenUrls, DEFAULT_MAX_PROBE_URLS_PER_SITE);
    links.push(...probeLinks);

    const filteredLinks = links
      .filter((link) => {
        const menuSignal = sourceHasMenuSignal(link.text, link.url);
        if (isExcludedMenuSourceUrl(link.url, link.text)) {
          return false;
        }
        return menuSignal || isPdfUrl(link.url) || isLikelyMenuImageCandidate(link.url, link.text);
      });

    for (const link of filteredLinks) {
      try {
        const fetched = await fetchTextForCandidate(link.url);
        const { candidate, childLinks } = await buildCandidateFromFetchedSource({
          venue,
          officialWebsite,
          sourceUrl: link.url,
          fetched,
          linkText: link.text,
        });
        if (candidate) {
          candidates.push(candidate);
        }

        for (const childLink of childLinks) {
          const canonicalChildUrl = canonicalDiscoveryUrl(childLink.url);
          if (seenUrls.has(canonicalChildUrl)) {
            continue;
          }
          seenUrls.add(canonicalChildUrl);
          try {
            const childFetched = await fetchTextForCandidate(childLink.url);
            const child = await buildCandidateFromFetchedSource({
              venue,
              officialWebsite,
              sourceUrl: childLink.url,
              fetched: childFetched,
              linkText: childLink.text,
            });
            if (child.candidate) {
              candidates.push(child.candidate);
            }
          } catch (error) {
            errors.push({ url: childLink.url, error: error instanceof Error ? error.message : "Unknown fetch error" });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown fetch error";
        if (!shouldSuppressDiscoveryFetchError(link.text, errorMessage)) {
          errors.push({ url: link.url, error: errorMessage });
        }
      }
    }
  } catch (error) {
    errors.push({ url: officialWebsite, error: error instanceof Error ? error.message : "Unknown fetch error" });
  }

  return { candidates: dedupeAndRankCandidates(candidates), errors };
}

async function maybeQueueDirectImage(candidate: MenuSourceCandidate): Promise<boolean> {
  if (!envFlag("MENU_DISCOVERY_QUEUE_OCR") || !envFlag("ALLOW_MENU_DISCOVERY_QUEUE")) {
    return false;
  }

  if (!candidate.canQueueOcr) {
    return false;
  }

  const baseUrl = process.env.MENU_DISCOVERY_ADMIN_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const adminBearer = process.env.MENU_DISCOVERY_ADMIN_BEARER ?? process.env.ADMIN_BEARER_TOKEN;
  if (!adminBearer) {
    throw new Error("MENU_DISCOVERY_QUEUE_OCR is enabled, but MENU_DISCOVERY_ADMIN_BEARER is missing.");
  }

  const response = await fetch(new URL("/api/admin/ingestions/queue", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: adminBearer.startsWith("Bearer ") ? adminBearer : `Bearer ${adminBearer}`,
    },
    body: JSON.stringify({
      venueId: candidate.venueId,
      sourceType: "source_image_url",
      sourceUrl: candidate.sourceUrl,
      note: `Menu discovery candidate from official website. Confidence ${candidate.confidence}. Signals: ${candidate.signals.join("; ")}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Queue OCR failed with HTTP ${response.status}`);
  }

  return true;
}

async function main(): Promise<void> {
  const limit = numberArg("limit", DEFAULT_LIMIT);
  const maxLinksPerVenue = numberArg("max-links-per-venue", DEFAULT_MAX_LINKS_PER_VENUE);
  const concurrency = numberArg("concurrency", Number(process.env.MENU_DISCOVERY_CONCURRENCY ?? DEFAULT_CONCURRENCY));
  const resolvePlaces = hasFlag("resolve-places") || envFlag("MENU_DISCOVERY_RESOLVE_PLACES");
  const venueQuery = normalizeVenueKey(getArg("venue-query") ?? getArg("venue") ?? "");
  const ocrEnabled = envFlag("MENU_DISCOVERY_OCR_IMAGES");
  const openai = ocrEnabled && process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  const loadedVenues = mergeVenues([
    ...(await loadSupabaseVenues(limit)),
    ...loadSqliteVenues(limit),
    ...loadArtifactVenues(limit),
  ]);
  const venues = (venueQuery
    ? loadedVenues.filter((venue) =>
        normalizeVenueKey([venue.name, venue.address, venue.suburb, venue.website].filter(Boolean).join(" ")).includes(venueQuery),
      )
    : loadedVenues).slice(0, limit);

  let resolvedWithGooglePlaces = 0;
  if (resolvePlaces) {
    const missingWebsiteVenues = venues.filter((venue) => !venue.website);
    const resolved = await mapLimit(missingWebsiteVenues, concurrency, async (venue) => {
      const resolvedWebsite = await resolveWebsiteWithGooglePlaces(venue);
      if (!resolvedWebsite) {
        return false;
      }

      venue.website = resolvedWebsite;
      venue.source = `${venue.source},google_places_text_search`;
      return true;
    });
    resolvedWithGooglePlaces = resolved.filter(Boolean).length;
  }

  const report: DiscoveryReport = {
    generatedAt: new Date().toISOString(),
    safety: {
      googleReviewPhotos: "skipped",
      autoPublish: false,
      ocrQueued: envFlag("MENU_DISCOVERY_QUEUE_OCR") && envFlag("ALLOW_MENU_DISCOVERY_QUEUE"),
      note:
        "Google review photos are not bulk-ingested. This job uses official venue websites/menu sources and writes candidates for admin review before any publish action.",
    },
    totals: {
      venuesLoaded: venues.length,
      venuesScanned: 0,
      venuesWithOfficialWebsite: venues.filter((venue) => Boolean(venue.website)).length,
      venuesResolvedWithGooglePlaces: resolvedWithGooglePlaces,
      sourceCandidates: 0,
      sourcesWithExtractedRows: 0,
      discoveryMethodCounts: {},
      sourceKindCounts: {},
      directImageCandidates: 0,
      textExtractionCandidatesAttempted: 0,
      textExtractionCandidatesSucceeded: 0,
      textBeerRowsExtracted: 0,
      pdfCandidatesParsed: 0,
      htmlCandidatesParsed: 0,
      ocrImageCandidatesAttempted: 0,
      ocrImageCandidatesSucceeded: 0,
      ocrBeerRowsExtracted: 0,
      queuedForOcr: 0,
      skippedWithoutWebsite: 0,
      fetchErrors: 0,
      fetchCacheEntries: 0,
    },
    skippedWithoutWebsite: [],
    candidates: [],
    errors: [],
  };

  const scanResults = await mapLimit(venues, concurrency, async (venue) => {
    if (!venue.website) {
      return {
        venue,
        skipped: {
          id: venue.id,
          name: venue.name,
          address: venue.address,
          suburb: venue.suburb,
          source: venue.source,
        },
        candidates: [] as MenuSourceCandidate[],
        errors: [] as Array<{ venueId: string; venueName: string; url: string; error: string }>,
      };
    }

    const discovered = await discoverSourcesForVenue(venue, maxLinksPerVenue);
    return {
      venue,
      skipped: null,
      candidates: discovered.candidates,
      errors: discovered.errors.map((error) => ({
        id: venue.id,
        name: venue.name,
        venueId: venue.id,
        venueName: venue.name,
        url: error.url,
        error: error.error,
      })),
    };
  });

  for (const result of scanResults) {
    if (result.skipped) {
      report.skippedWithoutWebsite.push(result.skipped);
      continue;
    }
    report.totals.venuesScanned += 1;
    for (const candidate of result.candidates) {
      report.candidates.push(candidate);
      report.totals.discoveryMethodCounts[candidate.discoveryMethod] =
        (report.totals.discoveryMethodCounts[candidate.discoveryMethod] ?? 0) + 1;
      report.totals.sourceKindCounts[candidate.sourceKind] =
        (report.totals.sourceKindCounts[candidate.sourceKind] ?? 0) + 1;
      if ((candidate.textExtraction?.rows.length ?? 0) > 0 || (candidate.ocr?.beers.length ?? 0) > 0) {
        report.totals.sourcesWithExtractedRows += 1;
      }
      if (candidate.textExtraction) {
        report.totals.textExtractionCandidatesAttempted += 1;
        if (!candidate.textExtraction.error) {
          report.totals.textExtractionCandidatesSucceeded += 1;
        }
        report.totals.textBeerRowsExtracted += candidate.textExtraction.rows.length;
        if (candidate.textExtraction.method === "pdf_text") {
          report.totals.pdfCandidatesParsed += 1;
        } else if (candidate.textExtraction.method === "html_text") {
          report.totals.htmlCandidatesParsed += 1;
        }
      }
      if (candidate.canQueueOcr) {
        report.totals.directImageCandidates += 1;
        const ocr = await maybeExtractImageOcr(candidate, openai);
        if (ocr) {
          candidate.ocr = ocr;
          report.totals.ocrImageCandidatesAttempted += 1;
          if (!ocr.error) {
            report.totals.ocrImageCandidatesSucceeded += 1;
          }
          report.totals.ocrBeerRowsExtracted += ocr.beers.length;
        }
        try {
          if (await maybeQueueDirectImage(candidate)) {
            report.totals.queuedForOcr += 1;
          }
        } catch (error) {
          report.errors.push({
            venueId: result.venue.id,
            venueName: result.venue.name,
            url: candidate.sourceUrl,
            error: error instanceof Error ? error.message : "Unknown queue error",
          });
        }
      }
    }

    report.errors.push(...result.errors);
  }

  report.candidates.sort((a, b) => b.confidence - a.confidence || a.venueName.localeCompare(b.venueName));
  report.totals.sourceCandidates = report.candidates.length;
  report.totals.sourcesWithExtractedRows = report.candidates.filter(
    (candidate) => (candidate.textExtraction?.rows.length ?? 0) > 0 || (candidate.ocr?.beers.length ?? 0) > 0,
  ).length;
  report.totals.skippedWithoutWebsite = report.skippedWithoutWebsite.length;
  report.totals.fetchErrors = report.errors.length;
  report.totals.fetchCacheEntries = textFetchCache.size + imageDataUrlCache.size;

  const runsDir = ensureRunsDir();
  const outputPath = path.join(runsDir, `menu-source-discovery-${timestampForFile()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const latestPath = path.join(runsDir, "menu-source-discovery-latest.json");
  fs.writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`);

  const csvOutputPath = outputPath.replace(/\.json$/i, ".csv");
  fs.writeFileSync(csvOutputPath, `${candidatesToCsv(report.candidates)}\n`);

  const latestCsvPath = path.join(runsDir, "menu-source-discovery-latest.csv");
  fs.writeFileSync(latestCsvPath, `${candidatesToCsv(report.candidates)}\n`);

  console.info("Menu source discovery complete");
  console.info(`Output: ${outputPath}`);
  console.info(`CSV: ${csvOutputPath}`);
  console.info(JSON.stringify(report.totals, null, 2));
  if (report.candidates.length > 0) {
    console.info("Top candidates:");
    for (const candidate of report.candidates.slice(0, 10)) {
      console.info(
        `- ${candidate.venueName} [${candidate.sourceKind}/${candidate.discoveryMethod}, ${candidate.confidence}] ${candidate.sourceUrl}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
