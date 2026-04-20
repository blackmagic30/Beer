import "dotenv/config";

import { BeerPriceResultsRepository } from "../src/db/beer-price-results.repository.js";
import { CallRunsRepository } from "../src/db/call-runs.repository.js";
import { createDatabase } from "../src/db/database.js";
import type { CallRunRecord, PersistedHappyHourInput, PersistedBeerPriceResultInput } from "../src/db/models.js";
import { SupabaseResultsSyncService } from "../src/lib/supabase-results-sync.js";
import {
  detectTranscriptFailureReason,
  shouldOverrideParsedOutcome,
} from "../src/modules/parsing/transcript-failure-reason.js";
import {
  extractBeerContextText,
  parseBeerPrices,
  summariseParseOutcome,
  type TranscriptTurnLike,
} from "../src/modules/parsing/transcript-parser.js";

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseTurns(rawTranscript: string): TranscriptTurnLike[] {
  const turns: Array<TranscriptTurnLike | null> = rawTranscript
    .split(/\n+/)
    .map((line) => {
      const match = line.match(/^([A-Z]+):\s*(.*)$/);

      if (!match) {
        return null;
      }

      const message = match[2] ?? "";

      return {
        role: match[1]?.toLowerCase(),
        message,
        originalMessage: message,
      };
    });

  return turns.filter((turn): turn is TranscriptTurnLike => turn !== null);
}

function flattenRoleTranscript(turns: TranscriptTurnLike[], role: string): string {
  return turns
    .filter((turn) => turn.role?.toLowerCase() === role.toLowerCase())
    .map((turn) => turn.message?.trim() || turn.originalMessage?.trim() || "")
    .filter(Boolean)
    .join(". ");
}

function buildHappyHourDefaults(): PersistedHappyHourInput {
  return {
    happyHour: false,
    happyHourDays: null,
    happyHourStart: null,
    happyHourEnd: null,
    happyHourPrice: null,
    happyHourConfidence: 0,
  };
}

function selectRuns(
  repository: CallRunsRepository,
  callSids: string[],
  failedOnly: boolean,
  limit: number,
): CallRunRecord[] {
  if (callSids.length > 0) {
    return callSids
      .map((callSid) => repository.getByCallSid(callSid))
      .filter((run): run is CallRunRecord => Boolean(run));
  }

  const runs = repository.list({
    limit: Math.max(limit * 5, limit),
  });

  const filtered = runs.filter((run) => Boolean(run.rawTranscript) && (failedOnly ? run.parseStatus === "failed" : true));
  return filtered.slice(0, limit);
}

async function main() {
  const callSids = (getArg("call-sids", "") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const failedOnly = hasFlag("failed-only");
  const limit = Number.parseInt(getArg("limit", "25") ?? "25", 10);

  const db = createDatabase();
  const callRunsRepository = new CallRunsRepository(db);
  const beerPriceResultsRepository = new BeerPriceResultsRepository(db);
  const supabaseResultsSyncService = new SupabaseResultsSyncService(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_RESULTS_TABLE,
  );

  const runs = selectRuns(callRunsRepository, callSids, failedOnly, limit);

  console.log(`Reparsing ${runs.length} call runs.`);

  for (const run of runs) {
    if (!run.rawTranscript) {
      continue;
    }

    const turns = parseTurns(run.rawTranscript);
    const beerTranscript = extractBeerContextText(turns);
    const userTranscript = flattenRoleTranscript(turns, "user");
    const parsedPrices = parseBeerPrices(beerTranscript || userTranscript || run.rawTranscript, {
      assumeBeerContext: Boolean(beerTranscript),
    });
    const detectedFailureReason = detectTranscriptFailureReason(userTranscript, run.rawTranscript);
    const baseParseSummary = summariseParseOutcome(parsedPrices, null, 0.72);
    const overrideParsedOutcome = shouldOverrideParsedOutcome(detectedFailureReason);
    const parseSummary = overrideParsedOutcome
      ? {
          parseConfidence: 0.05,
          parseStatus: "failed" as const,
          needsReview: true,
        }
      : baseParseSummary;
    const failureReason =
      parseSummary.parseStatus === "failed"
        ? detectedFailureReason ?? run.errorMessage ?? "Parsing produced no useful data"
        : null;
    const timestamp = new Date().toISOString();
    const persistedItemsSource = overrideParsedOutcome
      ? parsedPrices.map((item) => ({
          ...item,
          priceText: null,
          priceNumeric: null,
          confidence: 0.05,
          needsReview: true,
          availabilityStatus: "unknown" as const,
          availableOnTap: null,
          availablePackageOnly: false,
          unavailableReason: null,
        }))
      : parsedPrices;
    const items: PersistedBeerPriceResultInput[] = persistedItemsSource.map(({ evidence: _evidence, isUnavailable: _isUnavailable, ...item }) => ({
      ...item,
      needsReview: item.needsReview || parseSummary.needsReview,
    }));

    callRunsRepository.saveTranscriptParseById(run.id, {
      conversationId: run.conversationId,
      rawTranscript: run.rawTranscript,
      parseConfidence: parseSummary.parseConfidence,
      parseStatus: parseSummary.parseStatus,
      errorMessage: failureReason,
      endedAt: run.endedAt,
      updatedAt: timestamp,
    });

    beerPriceResultsRepository.replaceForCall({
      venueId: run.venueId,
      venueName: run.venueName,
      phoneNumber: run.phoneNumber,
      suburb: run.suburb,
      timestamp: run.startedAt,
      rawTranscript: run.rawTranscript,
      callSid: run.callSid ?? `missing-${run.id}`,
      conversationId: run.conversationId,
      items,
      happyHour: buildHappyHourDefaults(),
    });

    if (supabaseResultsSyncService.isConfigured()) {
      await supabaseResultsSyncService.saveCallResult({
        run: callRunsRepository.getById(run.id) ?? run,
        callSid: run.callSid ?? `missing-${run.id}`,
        conversationId: run.conversationId,
        resultTimestamp: run.startedAt,
        savedAt: timestamp,
        rawTranscript: run.rawTranscript,
        parseConfidence: parseSummary.parseConfidence,
        parseStatus: parseSummary.parseStatus,
        needsReview: parseSummary.needsReview,
        items,
        happyHour: buildHappyHourDefaults(),
      });
    }

    console.log(
      JSON.stringify({
        callSid: run.callSid,
        venueName: run.venueName,
        parseStatus: parseSummary.parseStatus,
        parseConfidence: parseSummary.parseConfidence,
        errorMessage: failureReason,
        items: items.map((item) => ({
          beerName: item.beerName,
          priceText: item.priceText,
          priceNumeric: item.priceNumeric,
          confidence: item.confidence,
          needsReview: item.needsReview,
        })),
      }),
    );
  }

  db.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
