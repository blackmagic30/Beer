import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { TargetBeerKey } from "../src/constants/beers.js";
import { getBeerByKey, normalizeTargetBeerKey } from "../src/constants/beers.js";
import { isEligibleForFollowUpBeer } from "../src/lib/callback-batch.js";

interface ReviewVenueRow {
  venueId: string;
  venueName: string;
  suburb: string | null;
  address: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
  callEligible: boolean;
  alreadyCalled: boolean;
  latestCallAt: string | null;
}

interface BatchAttemptRecord {
  venueId: string;
  venueName: string;
  phoneNumber: string | null;
  queuedAt: string;
  callRunId: string | null;
  callSid: string | null;
}

interface SourceBatchState {
  targetBeer: TargetBeerKey;
  baseUrl: string;
  delayMs: number;
  limit: number;
  suburbFilter: string | null;
  testMode: boolean;
  includeAlreadyCalled: boolean;
  circuitBreakerThreshold: number;
  consecutiveLowSignalOutcomes?: number;
  recoveredStaleCalls: number;
  venues: ReviewVenueRow[];
  attempts: BatchAttemptRecord[];
}

interface HostedCallView {
  venueId: string | null;
  requestedBeer: string | null;
  venueName: string;
  callStatus: string;
  parseStatus: string;
  rawTranscript: string | null;
  errorMessage: string | null;
  isTest: boolean;
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function isHumanPickup(call: HostedCallView): boolean {
  return isEligibleForFollowUpBeer(call);
}

async function fetchCall(callSid: string, baseUrl: string): Promise<HostedCallView | null> {
  const response = await fetch(new URL(`/api/calls/${encodeURIComponent(callSid)}`, baseUrl));

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as { data?: { call?: HostedCallView } };
  return body.data?.call ?? null;
}

async function main() {
  const root = process.cwd();
  const sourceStatePath = path.resolve(root, getArg("source-state-file", "./data/runs/priority-areas-carlton-draft-batch.json")!);
  const outputStatePath = path.resolve(root, getArg("output-state-file", "./data/runs/callback-batch.json")!);
  const targetBeer = normalizeTargetBeerKey(getArg("beer", "stone_and_wood"));
  const baseUrl = getArg("base-url", "https://beer-production-aad4.up.railway.app")!;

  const sourceState = readJsonFile<SourceBatchState>(sourceStatePath);
  const venuesById = new Map(sourceState.venues.map((venue) => [venue.venueId, venue]));
  const callbackVenueIds = new Set<string>();

  for (const attempt of sourceState.attempts) {
    if (!attempt.callSid) {
      continue;
    }

    const call = await fetchCall(attempt.callSid, baseUrl);

    if (!call || !isHumanPickup(call) || !call.venueId) {
      continue;
    }

    callbackVenueIds.add(call.venueId);
  }

  const selectedVenues = Array.from(callbackVenueIds)
    .map((venueId) => venuesById.get(venueId))
    .filter((venue): venue is ReviewVenueRow => Boolean(venue))
    .sort((left, right) => left.venueName.localeCompare(right.venueName));

  const state = {
    runId: randomUUID(),
    status: "paused" as const,
    targetBeer,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stopReason: `Prepared callback batch from ${getBeerByKey(sourceState.targetBeer).name} pickups.`,
    dryRun: false,
    baseUrl,
    delayMs: sourceState.delayMs,
    limit: 0,
    suburbFilter: sourceState.suburbFilter,
    testMode: false,
    includeAlreadyCalled: true,
    circuitBreakerThreshold: sourceState.circuitBreakerThreshold,
    recoveredStaleCalls: 0,
    cursor: 0,
    total: selectedVenues.length,
    successCount: 0,
    failureCount: 0,
    consecutiveBadOutcomes: 0,
    consecutiveLowSignalOutcomes: 0,
    venues: selectedVenues,
    attempts: [],
  };

  fs.mkdirSync(path.dirname(outputStatePath), { recursive: true });
  fs.writeFileSync(outputStatePath, `${JSON.stringify(state, null, 2)}\n`);

  console.log(`Prepared ${selectedVenues.length} callback venues for ${getBeerByKey(targetBeer).name}.`);
  console.log(`Source batch: ${sourceStatePath}`);
  console.log(`Output state: ${outputStatePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
