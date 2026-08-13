import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  resolveBeerNameForSqliteBootstrap,
} from "../src/db/beer-catalog.repository.js";
import type {
  AdminIngestionBeerRecord,
  AdminIngestionCrawlerFeedback,
  BeerAvailabilityStatus,
} from "../src/db/models.js";
import {
  crawlerQueueDuplicateKey,
  crawlerQueueRowKey,
  crawlerQueueRowOverlapRatio,
  crawlerQueueSourceUrlCandidates,
  normalizeCrawlerQueueText,
  normalizeSqlComparableText,
} from "../src/lib/menu-source-dedupe.js";
import { isTimeLimitedMenuSource } from "../src/lib/menu-source-filter.js";
import { selectLabeledPintPrice } from "../src/lib/menu-price-selection.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

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

interface CrawlerFeedbackScores {
  bySourceUrl: Map<string, number>;
  byDomain: Map<string, number>;
  count: number;
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
    return { availableOnTap: false, availablePackageOnly: true, unavailableReason: "cans_or_bottles" };
  }
  if (row.availabilityStatus === "unavailable") {
    return { availableOnTap: false, availablePackageOnly: false, unavailableReason: "not_stocked" };
  }
  return { availableOnTap: null, availablePackageOnly: false, unavailableReason: null };
}

function mapBeerRow(input: {
  row: ExtractedBeerRow;
  beerCatalogDatabase: Database.Database | null;
  now: string;
}): AdminIngestionBeerRecord {
  const row = input.row;
  const labeledPintPrice = selectLabeledPintPrice(row.priceText);
  const priceText = cleanText(labeledPintPrice?.priceText ?? row.priceText, 40);
  const priceNumeric = labeledPintPrice?.priceNumeric ?? (Number.isFinite(row.priceNumeric ?? Number.NaN) ? Number(row.priceNumeric) : null);
  const availability = mapAvailability(row);
  const rawName = cleanText(row.name, 120) ?? "Unknown beer";
  const resolvedBeer = input.beerCatalogDatabase
    ? resolveBeerNameForSqliteBootstrap(input.beerCatalogDatabase, {
        name: rawName,
        source: "menu_crawler_import",
        now: input.now,
      })
    : null;
  const systemNote =
    resolvedBeer?.created
      ? `Added to system beer catalog as pending review: ${resolvedBeer.name}.`
      : resolvedBeer?.status === "pending_review"
        ? `System beer catalog review needed: ${resolvedBeer.name}.`
        : null;

  return {
    name: resolvedBeer?.name ?? rawName,
    servingSize: "pint",
    priceNumeric,
    priceText: priceText ?? (priceNumeric == null ? null : `$${priceNumeric.toFixed(2)}`),
    availabilityStatus: row.availabilityStatus,
    ...availability,
    confidence: clampConfidence(row.confidence),
    needsReview: true,
    notes: [cleanText(row.notes, 260), systemNote].filter(Boolean).join(" ") || null,
  };
}

function isUsableRow(row: ExtractedBeerRow, includePackageOnly: boolean, maxPrice: number): boolean {
  if (!cleanText(row.name, 120)) {
    return false;
  }
  if (!includePackageOnly && row.availabilityStatus === "package_only") {
    return false;
  }
  const priceNumeric = selectLabeledPintPrice(row.priceText)?.priceNumeric ?? Number(row.priceNumeric);
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

function ensureBeerCatalogTables(db: Database.Database): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'beer_catalog_items'")
    .get();
  if (!table) {
    throw new Error("beer_catalog_items table was not found. Start the app once so the database schema is initialized.");
  }
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function sourceDomain(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function parseCrawlerFeedback(value: string | null): AdminIngestionCrawlerFeedback | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<AdminIngestionCrawlerFeedback> | null;
    return parsed && typeof parsed.rewardScore === "number" && Number.isFinite(parsed.rewardScore)
      ? (parsed as AdminIngestionCrawlerFeedback)
      : null;
  } catch {
    return null;
  }
}

function loadCrawlerFeedbackScores(db: Database.Database): CrawlerFeedbackScores {
  if (!tableHasColumn(db, "admin_ingestion_queue", "crawler_feedback_json")) {
    return { bySourceUrl: new Map(), byDomain: new Map(), count: 0 };
  }

  const rows = db
    .prepare(
      `SELECT source_url AS sourceUrl, crawler_feedback_json AS crawlerFeedbackJson
         FROM admin_ingestion_queue
        WHERE crawler_feedback_json IS NOT NULL
          AND trim(crawler_feedback_json) != ''`,
    )
    .all() as Array<{ sourceUrl: string | null; crawlerFeedbackJson: string | null }>;
  const bySourceUrl = new Map<string, number>();
  const domainTotals = new Map<string, { total: number; count: number }>();
  let count = 0;

  for (const row of rows) {
    const feedback = parseCrawlerFeedback(row.crawlerFeedbackJson);
    if (!feedback) {
      continue;
    }

    count += 1;
    if (row.sourceUrl) {
      bySourceUrl.set(row.sourceUrl, feedback.rewardScore);
    }

    const domain = sourceDomain(row.sourceUrl);
    if (domain) {
      const current = domainTotals.get(domain) ?? { total: 0, count: 0 };
      current.total += feedback.rewardScore;
      current.count += 1;
      domainTotals.set(domain, current);
    }
  }

  return {
    bySourceUrl,
    byDomain: new Map(
      Array.from(domainTotals.entries()).map(([domain, value]) => [domain, value.total / value.count]),
    ),
    count,
  };
}

function feedbackScoreFor(candidate: MenuCrawlerCandidate, scores: CrawlerFeedbackScores): number {
  const exactScore =
    scores.bySourceUrl.get(candidate.canonicalSourceUrl) ??
    scores.bySourceUrl.get(candidate.sourceUrl);
  if (typeof exactScore === "number" && Number.isFinite(exactScore)) {
    return exactScore;
  }

  const domain = candidate.sourceDomain || sourceDomain(candidate.sourceUrl);
  return domain ? scores.byDomain.get(domain) ?? 0 : 0;
}

const inputPath = resolvePath(getArg("file", "data/runs/menu-source-discovery-latest.json")!);
const databasePath = resolvePath(getArg("database", process.env.DATABASE_PATH ?? "data/pint-path.sqlite")!);
const dryRun = hasFlag("dry-run");
const includePackageOnly = hasFlag("include-package-only");
const includeExternal = hasFlag("include-external");
const maxPrice = numberArg("max-price", 40);
const limit = numberArg("limit", Number.POSITIVE_INFINITY);

// This utility performs schema/table setup before evaluating candidates, even
// in dry-run mode, so every invocation is a database mutation.
assertOperatorMutationAllowed("Menu crawler review queue import");

const rawReport = JSON.parse(fs.readFileSync(inputPath, "utf8")) as MenuCrawlerReport;
const candidates = rawReport.candidates.filter((candidate) => sourceRows(candidate).length > 0);
const db = new Database(databasePath);

ensureQueueTable(db);
ensureBeerCatalogTables(db);
const crawlerFeedbackScores = loadCrawlerFeedbackScores(db);
const importStartedAt = new Date().toISOString();
const beerCatalogDatabase = dryRun ? null : db;

const duplicateQuery = db.prepare(
  `SELECT id
     FROM admin_ingestion_queue
    WHERE source_url IN (@sourceUrl, @candidateSourceUrl, @normalizedSourceUrl)
      AND (
        venue_id = @venueId
        OR lower(trim(venue_name)) = @venueName
        OR lower(trim(COALESCE(venue_name_guess, ''))) = @venueName
      )
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
let skippedTimeLimited = 0;
let skippedNoUsableRows = 0;
let skippedByLimit = 0;
let queuedRows = 0;
const queuedVenues = new Set<string>();
const queuedCandidateKeys = new Set<string>();
const queuedRowKeysByVenue = new Map<string, Set<string>>();
const queueCandidates = candidates
  .filter((candidate) => {
    if (!isTimeLimitedMenuSource(candidate.sourceUrl, `${candidate.reviewNote || ""} ${candidate.signals.join(" ")}`)) {
      return true;
    }
    skippedTimeLimited += 1;
    return false;
  })
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
        .map((row) => mapBeerRow({ row, beerCatalogDatabase, now: importStartedAt })),
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
    const leftScore =
      left.rows.length * 10 +
      left.candidate.confidence +
      feedbackScoreFor(left.candidate, crawlerFeedbackScores) / 10;
    const rightScore =
      right.rows.length * 10 +
      right.candidate.confidence +
      feedbackScoreFor(right.candidate, crawlerFeedbackScores) / 10;
    return rightScore - leftScore;
  });

const transaction = db.transaction(() => {
  for (const { candidate, rows } of queueCandidates) {
    if (inserted >= limit) {
      skippedByLimit += 1;
      continue;
    }

    const sourceUrlCandidates = crawlerQueueSourceUrlCandidates(candidate);
    const sourceUrl = sourceUrlCandidates[0] ?? (candidate.canonicalSourceUrl || candidate.sourceUrl);
    const candidateSourceUrl = sourceUrlCandidates[1] ?? sourceUrl;
    const normalizedSourceUrl = sourceUrlCandidates[2] ?? sourceUrl;
    const candidateKey = crawlerQueueDuplicateKey(candidate);
    if (queuedCandidateKeys.has(candidateKey)) {
      skippedDuplicate += 1;
      continue;
    }

    const venueRowsKey = normalizeCrawlerQueueText(candidate.venueName);
    const queuedVenueRowKeys = queuedRowKeysByVenue.get(venueRowsKey);
    if (queuedVenueRowKeys && crawlerQueueRowOverlapRatio(queuedVenueRowKeys, rows) >= 0.75) {
      skippedDuplicate += 1;
      continue;
    }

    if (duplicateQuery.get({
      venueId: candidate.venueId,
      venueName: normalizeSqlComparableText(candidate.venueName),
      sourceUrl,
      candidateSourceUrl,
      normalizedSourceUrl,
    })) {
      skippedDuplicate += 1;
      continue;
    }

    queuedCandidateKeys.add(candidateKey);
    const rowKeys = queuedVenueRowKeys ?? new Set<string>();
    for (const row of rows) {
      rowKeys.add(crawlerQueueRowKey(row));
    }
    queuedRowKeysByVenue.set(venueRowsKey, rowKeys);

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
      crawlerFeedbackSignals: crawlerFeedbackScores.count,
      skippedDuplicate,
      skippedExternal,
      skippedTimeLimited,
      skippedNoUsableRows,
      skippedByLimit,
    },
    null,
    2,
  ),
);
