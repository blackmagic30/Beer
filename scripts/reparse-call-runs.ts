import "dotenv/config";

import { getBeerByKey } from "../src/constants/beers.js";
import { BeerPriceResultsRepository } from "../src/db/beer-price-results.repository.js";
import { CallRunsRepository } from "../src/db/call-runs.repository.js";
import { createDatabase } from "../src/db/database.js";
import type { CallRunRecord } from "../src/db/models.js";
import { SupabaseResultsSyncService } from "../src/lib/supabase-results-sync.js";
import { buildReparseCallRunResult } from "../src/modules/parsing/reparse-call-run.js";

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
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

    const timestamp = new Date().toISOString();
    const reparse = buildReparseCallRunResult(run, 0.72);

    callRunsRepository.saveTranscriptParseById(run.id, {
      conversationId: run.conversationId,
      rawTranscript: run.rawTranscript,
      parseConfidence: reparse.parseConfidence,
      parseStatus: reparse.parseStatus,
      errorMessage: reparse.errorMessage,
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
      items: reparse.items,
      happyHour: reparse.happyHour,
    });

    if (supabaseResultsSyncService.isConfigured()) {
      await supabaseResultsSyncService.saveCallResult({
        run: callRunsRepository.getById(run.id) ?? run,
        callSid: run.callSid ?? `missing-${run.id}`,
        conversationId: run.conversationId,
        resultTimestamp: run.startedAt,
        savedAt: timestamp,
        rawTranscript: run.rawTranscript,
        parseConfidence: reparse.parseConfidence,
        parseStatus: reparse.parseStatus,
        needsReview: reparse.needsReview,
        items: reparse.items,
        happyHour: reparse.happyHour,
      });
    }

    console.log(
      JSON.stringify({
        callSid: run.callSid,
        venueName: run.venueName,
        requestedBeer: getBeerByKey(reparse.requestedBeer).name,
        parseStatus: reparse.parseStatus,
        parseConfidence: reparse.parseConfidence,
        errorMessage: reparse.errorMessage,
        items: reparse.items.map((item) => ({
          beerName: item.beerName,
          priceText: item.priceText,
          priceNumeric: item.priceNumeric,
          confidence: item.confidence,
          needsReview: item.needsReview,
        })),
        happyHour: reparse.happyHour,
      }),
    );
  }

  db.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
