import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { env } from "../src/config/env.js";
import { redactSecrets } from "../src/lib/redact.js";
import {
  REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
  isLikelyBaselineMenuSource,
  selectPublishableMapBaseRows,
  type ReviewedPriceSelectionOptions,
} from "../src/lib/reviewed-price-selection-policy.js";
import { AdminService } from "../src/modules/admin/admin.service.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

export { isLikelyBaselineMenuSource, selectPublishableMapBaseRows };
export type PublishMapBaseOptions = ReviewedPriceSelectionOptions;

interface ScriptOptions extends ReviewedPriceSelectionOptions {
  databasePath: string;
  dryRun: boolean;
  includeCoveredVenues: boolean;
  limit: number;
  queueLimit: number;
  skipSourceCheck: boolean;
  sourceCheckTimeoutMs: number;
}

const DEFAULT_OPTIONS = REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS;

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
  if (!options.dryRun) {
    assertOperatorMutationAllowed("Menu review publication");
  }
  const database = new Database(options.databasePath);
  const queueDatabase = asAsyncSqliteDatabase(database);
  const repository = new AdminIngestionQueueRepository(queueDatabase);
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
    queueDatabase,
  );
  await adminService.initializeIngestionQueue();

  const pending = await repository.list("pending_review", options.queueLimit, 0);
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
