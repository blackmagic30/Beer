import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import type { AdminIngestionBeerRecord, AdminIngestionQueueRecord } from "../src/db/models.js";
import { env } from "../src/config/env.js";
import { redactSecrets } from "../src/lib/redact.js";
import { AdminService } from "../src/modules/admin/admin.service.js";
import type { AdminBeerInput } from "../src/modules/admin/admin.schemas.js";

const BASELINE_MENU_PATH_RE = /(?:^|[-_\s/])(?:menu|menus|drink|drinks|beverage|beverages|beer|beers)(?:[-_\s/.]|$)|\.pdf(?:$|[?#])/i;
const HOMEPAGE_MENU_SIGNAL_RE = /\b(?:drink price text|html text rows|menu page|drinks? menu|beverage menu|beer menu)\b/i;
const EXCLUDED_SOURCE_PATH_RE = /\b(?:cocktails?|wine-list|wine_list)\b/i;
const EVENT_OR_SPECIAL_RE =
  /\b(?:happy[-_\s]?hour|what'?s[-_\s]?on|events?|specials?|mates[-_\s]?rates|parma|roast|beer[-_\s]?of[-_\s]?the[-_\s]?month|drinks?[-_\s]?of[-_\s]?the[-_\s]?month|good[-_\s]?beer[-_\s]?week|big[-_\s]?bash|promo|promotion|deal|offer|blog|post|news|weekly[-_\s]?specials?)\b/i;
const DIRECT_RASTER_IMAGE_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
const NOISY_BEER_NAME_RE =
  /\b(?:cocktail|wine|spritz|margarita|negroni|espresso|martini|parma|burger|pizza|steak|wings|coffee|tea|soft drink|soda|mocktail|flight|tasting paddle|cider|ginger\s+beer|hard\s+rated|seltzer|rtd|whisk(?:e)?y|bourbon|vodka|rum|gin|tequila|mezcal)\b/i;
const NON_BASELINE_ROW_CONTEXT_RE =
  /\b(?:schooners?|pots?|middys?|jugs?|cans?|bottles?|stubby|stubbies|pie\s*&?\s*pint|pint\s*&?\s*pie|parma\s*&?\s*pot|pot\s*&?\s*parma|happy[-_\s]?hour|specials?|deal|offer|promo|cocktails?|gin|rum|vodka|tequila|mezcal|whisk(?:e)?y|bourbon|vermouth|liqueur|agave|yuzu|grapefruit|mint|served\s+on\s+ice|tasty\s+pale\s+ale|captain\s+sensible)\b/i;

export interface PublishMapBaseOptions {
  minOverallConfidence: number;
  minRowConfidence: number;
  minPrice: number;
  maxPrice: number;
  allowHomepage: boolean;
  allowSpecialSources: boolean;
}

interface SelectionResult {
  beers: AdminBeerInput[];
  reasons: string[];
}

interface ScriptOptions extends PublishMapBaseOptions {
  databasePath: string;
  dryRun: boolean;
  includeCoveredVenues: boolean;
  limit: number;
  queueLimit: number;
  skipSourceCheck: boolean;
  sourceCheckTimeoutMs: number;
}

const DEFAULT_OPTIONS: PublishMapBaseOptions = {
  minOverallConfidence: 0.72,
  minRowConfidence: 0.82,
  minPrice: 8,
  maxPrice: 25,
  allowHomepage: false,
  allowSpecialSources: false,
};

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
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolvePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function parseOptions(): ScriptOptions {
  return {
    ...DEFAULT_OPTIONS,
    databasePath: resolvePath(getArg("database", process.env.DATABASE_PATH ?? "data/pint-path.sqlite")!),
    dryRun: hasFlag("dry-run"),
    includeCoveredVenues: hasFlag("include-covered-venues"),
    limit: numberArg("limit", 25),
    queueLimit: numberArg("queue-limit", 500),
    minOverallConfidence: numberArg("min-overall-confidence", DEFAULT_OPTIONS.minOverallConfidence),
    minRowConfidence: numberArg("min-row-confidence", DEFAULT_OPTIONS.minRowConfidence),
    minPrice: numberArg("min-price", DEFAULT_OPTIONS.minPrice),
    maxPrice: numberArg("max-price", DEFAULT_OPTIONS.maxPrice),
    allowHomepage: hasFlag("allow-homepage"),
    allowSpecialSources: hasFlag("allow-special-sources"),
    skipSourceCheck: hasFlag("skip-source-check"),
    sourceCheckTimeoutMs: numberArg("source-check-timeout-ms", 8000),
  };
}

function sourceHaystack(queueItem: Pick<AdminIngestionQueueRecord, "sourceUrl" | "note" | "capturedNotes">): string {
  return [queueItem.sourceUrl, queueItem.note, queueItem.capturedNotes].filter(Boolean).join("\n");
}

export function isLikelyBaselineMenuSource(
  queueItem: Pick<AdminIngestionQueueRecord, "sourceUrl" | "note" | "capturedNotes">,
  options: Pick<PublishMapBaseOptions, "allowHomepage" | "allowSpecialSources"> = DEFAULT_OPTIONS,
): boolean {
  if (!queueItem.sourceUrl) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(queueItem.sourceUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }

  const haystack = sourceHaystack(queueItem);
  if (!options.allowSpecialSources && EVENT_OR_SPECIAL_RE.test(haystack)) {
    return false;
  }

  const pathname = decodeURIComponent(url.pathname).replace(/[-_]+/g, " ");
  if (EXCLUDED_SOURCE_PATH_RE.test(pathname)) {
    return false;
  }

  if (DIRECT_RASTER_IMAGE_RE.test(url.pathname)) {
    return false;
  }

  if (pathname === "/" || pathname.trim() === "") {
    return options.allowHomepage && HOMEPAGE_MENU_SIGNAL_RE.test(haystack);
  }

  return BASELINE_MENU_PATH_RE.test(pathname);
}

function isUsableBeerRow(row: AdminIngestionBeerRecord, options: PublishMapBaseOptions): boolean {
  const name = row.name.trim();
  const price = Number(row.priceNumeric);
  const confidence = Number(row.confidence);
  const context = [row.priceText, row.notes].filter(Boolean).join(" ");

  return Boolean(name) &&
    name.length >= 3 &&
    !NOISY_BEER_NAME_RE.test(name) &&
    !NON_BASELINE_ROW_CONTEXT_RE.test(context) &&
    row.servingSize === "pint" &&
    row.availabilityStatus === "on_tap" &&
    row.availablePackageOnly !== true &&
    row.availableOnTap !== false &&
    Number.isFinite(price) &&
    price >= options.minPrice &&
    price <= options.maxPrice &&
    Number.isFinite(confidence) &&
    confidence >= options.minRowConfidence;
}

function beerKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupeAndDropAmbiguousRows(rows: AdminIngestionBeerRecord[]): AdminIngestionBeerRecord[] {
  const grouped = new Map<string, AdminIngestionBeerRecord[]>();
  for (const row of rows) {
    const key = beerKey(row.name);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const output: AdminIngestionBeerRecord[] = [];
  for (const groupRows of grouped.values()) {
    const prices = new Set(groupRows.map((row) => Number(row.priceNumeric).toFixed(2)));
    if (prices.size > 1) {
      continue;
    }
    output.push(groupRows[0]!);
  }

  return output;
}

function toAdminBeerInput(row: AdminIngestionBeerRecord): AdminBeerInput {
  return {
    name: row.name,
    servingSize: "pint",
    priceNumeric: Number(row.priceNumeric),
    priceText: row.priceText,
    availabilityStatus: "on_tap",
    availableOnTap: true,
    availablePackageOnly: false,
    unavailableReason: null,
    needsReview: false,
  };
}

export function selectPublishableMapBaseRows(
  queueItem: AdminIngestionQueueRecord,
  options: PublishMapBaseOptions = DEFAULT_OPTIONS,
): SelectionResult {
  const reasons: string[] = [];

  if (queueItem.sourceType !== "source_reference") {
    reasons.push("source_type_not_reference");
  }

  if (!isLikelyBaselineMenuSource(queueItem, options)) {
    reasons.push("not_baseline_menu_source");
  }

  if ((queueItem.overallConfidence ?? 0) < options.minOverallConfidence) {
    reasons.push("low_overall_confidence");
  }

  const usableRows = queueItem.extractedBeers.filter((row) => isUsableBeerRow(row, options));
  if (usableRows.length === 0) {
    reasons.push("no_usable_on_tap_pint_rows");
  }

  const dedupedRows = dedupeAndDropAmbiguousRows(usableRows);
  if (usableRows.length > 0 && dedupedRows.length === 0) {
    reasons.push("ambiguous_duplicate_prices");
  }

  if (reasons.length > 0) {
    return { beers: [], reasons };
  }

  return {
    beers: dedupedRows.map(toAdminBeerInput),
    reasons: [],
  };
}

async function sourceUrlStillReachable(sourceUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "PintPathMapBasePublisher/1.0 (+https://pintpath.au)",
        Range: "bytes=0-8191",
      },
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const database = new Database(options.databasePath);
  const repository = new AdminIngestionQueueRepository(database);
  const coveredVenueIds = options.includeCoveredVenues
    ? new Set<string>()
    : new Set(
        (
          database
            .prepare(
              `SELECT DISTINCT venue_id AS venueId
                 FROM venue_price_records
                WHERE confidence IN ('venue_confirmed', 'photo_verified', 'community_confirmed')`,
            )
            .all() as Array<{ venueId: string }>
        ).map((row) => row.venueId),
      );
  const adminService = new AdminService(
    repository,
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_MENU_CAPTURE_TABLE,
    env.OPENAI_API_KEY,
    env.GOOGLE_PLACES_API_KEY ?? env.GOOGLE_MAPS_API_KEY,
    database,
  );

  const pending = repository.list("pending_review", options.queueLimit, 0);
  const candidates = pending
    .map((queueItem) => ({
      queueItem,
      selection: selectPublishableMapBaseRows(queueItem, options),
    }))
    .sort((left, right) => {
      const confidenceDelta = (right.queueItem.overallConfidence ?? 0) - (left.queueItem.overallConfidence ?? 0);
      return confidenceDelta || right.selection.beers.length - left.selection.beers.length;
    });

  const skipped: Record<string, number> = {};
  const published: Array<{ id: string; venueName: string; sourceUrl: string | null; rows: number }> = [];
  const publishableDryRun: Array<{ id: string; venueName: string; sourceUrl: string | null; rows: number }> = [];
  const failed: Array<{ id: string; venueName: string; error: string }> = [];
  let sourceCheckFailed = 0;

  for (const { queueItem, selection } of candidates) {
    if (published.length + publishableDryRun.length >= options.limit) {
      break;
    }

    if (coveredVenueIds.has(queueItem.venueId)) {
      skipped.venue_already_has_live_records = (skipped.venue_already_has_live_records ?? 0) + 1;
      continue;
    }

    if (selection.reasons.length > 0) {
      for (const reason of selection.reasons) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      }
      continue;
    }

    if (!options.skipSourceCheck && queueItem.sourceUrl) {
      const reachable = await sourceUrlStillReachable(queueItem.sourceUrl, options.sourceCheckTimeoutMs);
      if (!reachable) {
        sourceCheckFailed += 1;
        skipped.source_check_failed = (skipped.source_check_failed ?? 0) + 1;
        continue;
      }
    }

    const summary = {
      id: queueItem.id,
      venueName: queueItem.venueName,
      sourceUrl: queueItem.sourceUrl,
      rows: selection.beers.length,
    };

    if (options.dryRun) {
      publishableDryRun.push(summary);
      continue;
    }

    try {
      const result = await adminService.publishQueuedIngestion(queueItem.id, {
        beers: selection.beers,
        note: [
          "Bulk map-base publish.",
          "Criteria: regular menu source, reachable source URL, numeric on-tap pint rows, non-ambiguous duplicate prices.",
        ].join(" "),
      });
      published.push({ ...summary, rows: result.mapPriceRecordCount });
    } catch (error) {
      failed.push({
        id: queueItem.id,
        venueName: queueItem.venueName,
        error: error instanceof Error ? redactSecrets(error.message) : "unknown",
      });
    }
  }

  database.close();

  console.log(JSON.stringify(
    {
      mode: options.dryRun ? "dry-run" : "published",
      databasePath: options.databasePath,
      pendingQueueItems: pending.length,
      publishLimit: options.limit,
      selection: {
        minOverallConfidence: options.minOverallConfidence,
        minRowConfidence: options.minRowConfidence,
        minPrice: options.minPrice,
        maxPrice: options.maxPrice,
        allowHomepage: options.allowHomepage,
        allowSpecialSources: options.allowSpecialSources,
        includeCoveredVenues: options.includeCoveredVenues,
        sourceCheckEnabled: !options.skipSourceCheck,
        sourceCheckFailed,
      },
      publishedCount: published.length,
      publishedRows: published.reduce((total, item) => total + item.rows, 0),
      publishableDryRunCount: publishableDryRun.length,
      publishableDryRunRows: publishableDryRun.reduce((total, item) => total + item.rows, 0),
      skipped,
      failed,
      published,
      publishableDryRun,
    },
    null,
    2,
  ));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? redactSecrets(error.message) : error);
    process.exitCode = 1;
  });
}
