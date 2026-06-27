import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { AdminIngestionBeerRecord, BeerAvailabilityStatus } from "../src/db/models.js";

type SourceKind = "menu_page" | "menu_image" | "menu_pdf" | "homepage_menu_signal";
type SourceOrigin = "official_host" | "trusted_external_menu_host";
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

interface ExtractedBeerRow {
  name: string;
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: BeerAvailabilityStatus;
  notes: string | null;
  confidence: number | null;
}

interface MenuCrawlerCandidate {
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
  freshness: "within_last_year" | "older_than_year" | "unknown";
  publishedAt: string | null;
  signals: string[];
  reviewNote: string;
  ocr: {
    attemptedAt: string;
    venueNameGuess: string | null;
    capturedNotes: string | null;
    overallConfidence: number | null;
    beers: ExtractedBeerRow[];
    error: string | null;
  } | null;
  textExtraction: {
    attemptedAt: string;
    method: "html_text" | "pdf_text";
    rows: ExtractedBeerRow[];
    notes: string[];
    error: string | null;
  } | null;
}

interface MenuCrawlerReport {
  generatedAt: string;
  totals?: Record<string, unknown>;
  candidates: MenuCrawlerCandidate[];
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

function resolvePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function clampConfidence(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, Number(value)));
}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
}

function sourceRows(candidate: MenuCrawlerCandidate): ExtractedBeerRow[] {
  if (candidate.textExtraction?.rows.length) {
    return candidate.textExtraction.rows;
  }
  if (candidate.ocr?.beers.length) {
    return candidate.ocr.beers;
  }
  return [];
}

function mapAvailability(row: ExtractedBeerRow): Pick<
  AdminIngestionBeerRecord,
  "availableOnTap" | "availablePackageOnly" | "unavailableReason"
> {
  if (row.availabilityStatus === "on_tap") {
    return { availableOnTap: true, availablePackageOnly: false, unavailableReason: null };
  }
  if (row.availabilityStatus === "package_only") {
    return { availableOnTap: false, availablePackageOnly: true, unavailableReason: "cans_only" };
  }
  if (row.availabilityStatus === "unavailable") {
    return { availableOnTap: false, availablePackageOnly: false, unavailableReason: "not_stocked" };
  }
  return { availableOnTap: null, availablePackageOnly: false, unavailableReason: null };
}

function mapBeerRow(row: ExtractedBeerRow): AdminIngestionBeerRecord {
  const priceText = cleanText(row.priceText, 40);
  const priceNumeric = Number.isFinite(row.priceNumeric ?? Number.NaN) ? Number(row.priceNumeric) : null;
  const availability = mapAvailability(row);

  return {
    name: cleanText(row.name, 120) ?? "Unknown beer",
    servingSize: "pint",
    priceNumeric,
    priceText: priceText ?? (priceNumeric == null ? null : `$${priceNumeric.toFixed(2)}`),
    availabilityStatus: row.availabilityStatus,
    ...availability,
    confidence: clampConfidence(row.confidence),
    needsReview: true,
    notes: cleanText(row.notes, 360),
  };
}

function isUsableRow(row: ExtractedBeerRow, includePackageOnly: boolean, maxPrice: number): boolean {
  if (!cleanText(row.name, 120)) {
    return false;
  }
  if (!includePackageOnly && row.availabilityStatus === "package_only") {
    return false;
  }
  const priceNumeric = Number(row.priceNumeric);
  if (!Number.isFinite(priceNumeric) || priceNumeric <= 0 || priceNumeric > maxPrice) {
    return false;
  }
  return true;
}

function dedupeRows(rows: AdminIngestionBeerRecord[]): AdminIngestionBeerRecord[] {
  const seen = new Set<string>();
  const output: AdminIngestionBeerRecord[] = [];
  for (const row of rows) {
    const key = `${row.name.toLowerCase()}|${row.priceNumeric ?? row.priceText ?? ""}|${row.availabilityStatus}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(row);
  }
  return output;
}

function buildNote(candidate: MenuCrawlerCandidate, rows: AdminIngestionBeerRecord[]): string {
  const method = candidate.textExtraction?.method ?? (candidate.ocr ? "ocr" : "unknown");
  const freshness =
    candidate.freshness === "within_last_year"
      ? "fresh source"
      : candidate.freshness === "older_than_year"
        ? "older source"
        : "unknown source date";

  return [
    `Crawler import for admin review only.`,
    `${rows.length} candidate row${rows.length === 1 ? "" : "s"} from ${candidate.sourceKind}/${method}.`,
    `Confidence ${Math.round(candidate.confidence * 100)}%, ${freshness}.`,
  ].join(" ");
}

function buildCapturedNotes(candidate: MenuCrawlerCandidate): string {
  const extraction = candidate.textExtraction;
  const notes = extraction?.notes ?? [];
  return [
    `Venue: ${candidate.venueName}${candidate.venueSuburb ? `, ${candidate.venueSuburb}` : ""}`,
    `Website: ${candidate.officialWebsite}`,
    `Source: ${candidate.sourceUrl}`,
    `Discovery: ${candidate.discoveryMethod}; ${candidate.signals.join("; ")}`,
    candidate.reviewNote,
    ...notes,
  ]
    .map((line) => cleanText(line, 500))
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function ensureQueueTable(db: Database.Database): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_ingestion_queue'")
    .get();
  if (!table) {
    throw new Error("admin_ingestion_queue table was not found. Start the app once so the database schema is initialized.");
  }
}

const inputPath = resolvePath(getArg("file", "data/runs/menu-source-discovery-latest.json")!);
const databasePath = resolvePath(getArg("database", process.env.DATABASE_PATH ?? "data/pint-path.sqlite")!);
const dryRun = hasFlag("dry-run");
const includePackageOnly = hasFlag("include-package-only");
const includeExternal = hasFlag("include-external");
const maxPrice = numberArg("max-price", 40);
const limit = numberArg("limit", Number.POSITIVE_INFINITY);

const rawReport = JSON.parse(fs.readFileSync(inputPath, "utf8")) as MenuCrawlerReport;
const candidates = rawReport.candidates.filter((candidate) => sourceRows(candidate).length > 0);
const db = new Database(databasePath);

ensureQueueTable(db);

const duplicateQuery = db.prepare(
  `SELECT id
     FROM admin_ingestion_queue
    WHERE venue_id = ?
      AND source_url = ?
      AND status IN ('pending_review', 'published')
    LIMIT 1`,
);

const insertQueueItem = db.prepare(
  `INSERT INTO admin_ingestion_queue (
    id,
    venue_id,
    venue_name,
    source_type,
    source_url,
    image_data_url,
    note,
    status,
    venue_name_guess,
    captured_notes,
    overall_confidence,
    extracted_beers_json,
    error_message,
    created_at,
    updated_at
  ) VALUES (
    @id,
    @venueId,
    @venueName,
    'source_reference',
    @sourceUrl,
    NULL,
    @note,
    'pending_review',
    @venueNameGuess,
    @capturedNotes,
    @overallConfidence,
    @extractedBeersJson,
    NULL,
    @createdAt,
    @updatedAt
  )`,
);

let inserted = 0;
let skippedDuplicate = 0;
let skippedExternal = 0;
let skippedNoUsableRows = 0;
let skippedByLimit = 0;
let queuedRows = 0;
const queuedVenues = new Set<string>();

const importStartedAt = new Date().toISOString();
const queueCandidates = candidates
  .filter((candidate) => {
    if (includeExternal || candidate.sourceOrigin === "official_host") {
      return true;
    }
    skippedExternal += 1;
    return false;
  })
  .map((candidate) => {
    const rows = dedupeRows(
      sourceRows(candidate)
        .filter((row) => isUsableRow(row, includePackageOnly, maxPrice))
        .map(mapBeerRow),
    );
    return { candidate, rows };
  })
  .filter(({ rows }) => {
    if (rows.length > 0) {
      return true;
    }
    skippedNoUsableRows += 1;
    return false;
  })
  .sort((left, right) => {
    const leftScore = left.rows.length * 10 + left.candidate.confidence;
    const rightScore = right.rows.length * 10 + right.candidate.confidence;
    return rightScore - leftScore;
  });

const transaction = db.transaction(() => {
  for (const { candidate, rows } of queueCandidates) {
    if (inserted >= limit) {
      skippedByLimit += 1;
      continue;
    }

    const sourceUrl = candidate.canonicalSourceUrl || candidate.sourceUrl;
    if (duplicateQuery.get(candidate.venueId, sourceUrl)) {
      skippedDuplicate += 1;
      continue;
    }

    if (!dryRun) {
      insertQueueItem.run({
        id: randomUUID(),
        venueId: candidate.venueId,
        venueName: candidate.venueName,
        sourceUrl,
        note: buildNote(candidate, rows),
        venueNameGuess: candidate.venueName,
        capturedNotes: buildCapturedNotes(candidate),
        overallConfidence: Number(
          (rows.reduce((total, row) => total + row.confidence, 0) / Math.max(1, rows.length)).toFixed(3),
        ),
        extractedBeersJson: JSON.stringify(rows),
        createdAt: importStartedAt,
        updatedAt: importStartedAt,
      });
    }

    inserted += 1;
    queuedRows += rows.length;
    queuedVenues.add(candidate.venueId);
  }
});

transaction();
db.close();

console.log(
  JSON.stringify(
    {
      mode: dryRun ? "dry-run" : "inserted",
      inputPath,
      databasePath,
      generatedAt: rawReport.generatedAt,
      packageOnlyIncluded: includePackageOnly,
      externalSourcesIncluded: includeExternal,
      maxPrice,
      queueItems: inserted,
      queuedRows,
      queuedVenues: queuedVenues.size,
      skippedDuplicate,
      skippedExternal,
      skippedNoUsableRows,
      skippedByLimit,
    },
    null,
    2,
  ),
);
