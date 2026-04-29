import "dotenv/config";

import { getBeerByKey, isTargetBeerKey } from "../src/constants/beers.js";
import { SupabaseResultsSyncService } from "../src/lib/supabase-results-sync.js";
import { buildReparseCallRunResult, type ReparsableCallRunLike } from "../src/modules/parsing/reparse-call-run.js";

interface HostedBeerResultView {
  beerName: string;
}

interface HostedCallRunView {
  id: string;
  callSid: string | null;
  venueId: string | null;
  requestedBeer?: string | null;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  callStatus: string;
  parseConfidence: number | null;
  parseStatus: string;
  rawTranscript: string | null;
  errorMessage: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
  needsReview: boolean;
  beerResults?: HostedBeerResultView[];
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function getParseThreshold(): number {
  const raw = process.env.PARSE_CONFIDENCE_THRESHOLD;
  if (!raw) {
    return 0.72;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.72;
}

function normalizeRequestedBeer(value: string | null | undefined) {
  return value && isTargetBeerKey(value) ? value : null;
}

function toReparsableCallRun(call: HostedCallRunView): ReparsableCallRunLike {
  return {
    id: call.id,
    callSid: call.callSid,
    conversationId: null,
    venueId: call.venueId,
    requestedBeer: normalizeRequestedBeer(call.requestedBeer),
    venueName: call.venueName,
    phoneNumber: call.phoneNumber,
    suburb: call.suburb,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    callStatus: call.callStatus as ReparsableCallRunLike["callStatus"],
    rawTranscript: call.rawTranscript,
    parseConfidence: call.parseConfidence,
    parseStatus: call.parseStatus as ReparsableCallRunLike["parseStatus"],
    errorMessage: call.errorMessage,
    isTest: call.isTest,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    ...(call.beerResults ? { beerResults: call.beerResults } : {}),
  };
}

function parseCallsResponse(payload: unknown): HostedCallRunView[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    !("data" in payload) ||
    !(payload as { ok: unknown }).ok
  ) {
    throw new Error("Hosted calls API returned an unexpected response.");
  }

  const data = (payload as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("calls" in data) || !Array.isArray((data as { calls: unknown }).calls)) {
    throw new Error("Hosted calls API response did not include a calls array.");
  }

  return (data as { calls: HostedCallRunView[] }).calls;
}

async function fetchHostedCalls(baseUrl: string, limit: number): Promise<HostedCallRunView[]> {
  const url = new URL("/api/calls", baseUrl);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hosted calls API returned ${response.status} ${response.statusText}.`);
  }

  return parseCallsResponse(await response.json());
}

async function main() {
  const baseUrl = getArg("base-url", "https://beer.splitseconds.app") ?? "https://beer.splitseconds.app";
  const limit = Number.parseInt(getArg("limit", "50") ?? "50", 10);
  const callSids = (getArg("call-sids", "") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const failedOnly = hasFlag("failed-only");
  const includeTests = hasFlag("include-tests");
  const threshold = getParseThreshold();

  const supabaseResultsSyncService = new SupabaseResultsSyncService(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_RESULTS_TABLE,
  );

  if (!supabaseResultsSyncService.isConfigured()) {
    throw new Error("Supabase sync is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const hostedCalls = await fetchHostedCalls(baseUrl, limit);
  const filteredCalls = hostedCalls.filter((call) => {
    if (!includeTests && call.isTest) {
      return false;
    }

    if (call.rawTranscript == null) {
      return false;
    }

    if (callSids.length > 0 && (!call.callSid || !callSids.includes(call.callSid))) {
      return false;
    }

    if (failedOnly && call.parseStatus !== "failed") {
      return false;
    }

    return true;
  });

  console.log(`Hosted reparse targeting ${filteredCalls.length} call runs from ${baseUrl}.`);

  for (const call of filteredCalls) {
    const timestamp = new Date().toISOString();
    const reparsableCall = toReparsableCallRun(call);
    const reparse = buildReparseCallRunResult(reparsableCall, threshold);

    await supabaseResultsSyncService.saveCallResult({
      run: {
        ...reparsableCall,
        requestedBeer: reparse.requestedBeer,
      },
      callSid: call.callSid ?? `missing-${call.id}`,
      conversationId: null,
      resultTimestamp: call.startedAt,
      savedAt: timestamp,
      rawTranscript: call.rawTranscript ?? "",
      parseConfidence: reparse.parseConfidence,
      parseStatus: reparse.parseStatus,
      needsReview: reparse.needsReview,
      items: reparse.items,
      happyHour: reparse.happyHour,
    });

    console.log(
      JSON.stringify({
        callSid: call.callSid,
        venueName: call.venueName,
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
