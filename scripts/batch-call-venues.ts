import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { getBeerByKey, normalizeTargetBeerKey, type TargetBeerKey } from "../src/constants/beers.js";
import { env } from "../src/config/env.js";
import { CallRunsRepository } from "../src/db/call-runs.repository.js";
import { createDatabase } from "../src/db/database.js";
import type { CallRunRecord, CallStatus, ParseStatus } from "../src/db/models.js";
import { getCallingWindowStatus } from "../src/lib/business-hours.js";
import { classifyBatchAttemptOutcome, isRetryableVenueOutcome, type BatchAttemptOutcome } from "../src/lib/call-batch.js";
import { normalizeAustralianPhoneToE164 } from "../src/lib/phone.js";
import {
  buildAreaFilterTerms,
  buildReviewVenueRow,
  matchesAreaFilter,
  type ReviewVenueRow,
} from "../src/lib/venue-directory.js";
import { recoverStaleCallRuns } from "../src/modules/calls/stale-call-recovery.js";

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
}

interface LocalCallRunRow {
  venueId: string | null;
  requestedBeer: string | null;
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage: string | null;
  createdAt: string;
}

interface BatchAttemptRecord {
  venueId: string;
  venueName: string;
  phoneNumber: string | null;
  queuedAt: string;
  callRunId: string | null;
  callSid: string | null;
  requestOk: boolean;
  responseStatus: number;
  responseBody: unknown;
  resolvedOutcome: BatchAttemptOutcome | null;
  resolvedAt: string | null;
}

interface BatchRunState {
  runId: string;
  status: "running" | "paused" | "completed";
  targetBeer: TargetBeerKey;
  createdAt: string;
  updatedAt: string;
  stopReason: string | null;
  dryRun: boolean;
  baseUrl: string;
  delayMs: number;
  limit: number;
  suburbFilter: string | null;
  testMode: boolean;
  includeAlreadyCalled: boolean;
  circuitBreakerThreshold: number;
  recoveredStaleCalls: number;
  cursor: number;
  total: number;
  successCount: number;
  failureCount: number;
  consecutiveBadOutcomes: number;
  venues: ReviewVenueRow[];
  attempts: BatchAttemptRecord[];
}

const ACTIVE_STALE_MINUTES = 20;
const COMPLETED_STALE_MINUTES = 15;
const TERMINAL_STALE_MINUTES = 5;
const UNRESOLVED_CALL_GRACE_MS = 45000;
const UNRESOLVED_CALL_POLL_MS = 5000;

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchAllRows<T>(table: string, select: string): Promise<T[]> {
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

  const rows: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to fetch ${table}: ${error.message}`);
    }

    const batch = (data ?? []) as T[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  return rows;
}

function getStatePath(): string {
  return path.resolve(process.cwd(), getArg("state-file", "./data/runs/venue-call-batch-state.json")!);
}

function writeState(statePath: string, state: BatchRunState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readState(statePath: string): BatchRunState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8")) as BatchRunState;
}

function buildCallingWindowReason(): string {
  const status = getCallingWindowStatus(new Date(), {
    timezone: env.OUTBOUND_CALL_TIMEZONE,
    start: env.OUTBOUND_CALL_WINDOW_START,
    end: env.OUTBOUND_CALL_WINDOW_END,
    allowedDays: env.OUTBOUND_CALL_ALLOWED_DAYS,
  });

  return status.allowed
    ? `Inside call window ${status.label}`
    : `${status.reason}. Allowed window: ${status.label}`;
}

function ensureCallingWindow(state: BatchRunState, statePath: string): boolean {
  if (state.testMode) {
    return true;
  }

  const status = getCallingWindowStatus(new Date(), {
    timezone: env.OUTBOUND_CALL_TIMEZONE,
    start: env.OUTBOUND_CALL_WINDOW_START,
    end: env.OUTBOUND_CALL_WINDOW_END,
    allowedDays: env.OUTBOUND_CALL_ALLOWED_DAYS,
  });

  if (status.allowed) {
    return true;
  }

  state.status = "paused";
  state.updatedAt = nowIso();
  state.stopReason = `${status.reason}. Resume when the window reopens: ${status.label}`;
  writeState(statePath, state);
  console.log(`Pausing batch: ${state.stopReason}`);
  return false;
}

function buildAttemptRecord(
  venue: ReviewVenueRow,
  responseStatus: number,
  responseBody: unknown,
  requestOk: boolean,
): BatchAttemptRecord {
  const body = responseBody as { data?: { id?: string; callSid?: string } } | null;

  return {
    venueId: venue.venueId,
    venueName: venue.venueName,
    phoneNumber: venue.normalizedPhone,
    queuedAt: nowIso(),
    callRunId: body?.data?.id ?? null,
    callSid: body?.data?.callSid ?? null,
    requestOk,
    responseStatus,
    responseBody,
    resolvedOutcome: requestOk ? null : "bad",
    resolvedAt: requestOk ? null : nowIso(),
  };
}

function getCurrentRunForAttempt(
  repository: CallRunsRepository,
  attempt: BatchAttemptRecord,
): CallRunRecord | undefined {
  if (attempt.callSid) {
    return repository.getByCallSid(attempt.callSid);
  }

  if (attempt.callRunId) {
    return repository.getById(attempt.callRunId);
  }

  return undefined;
}

async function fetchRemoteRunOutcome(
  baseUrl: string,
  attempt: BatchAttemptRecord,
): Promise<{
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage: string | null;
} | null> {
  if (!attempt.callSid) {
    return null;
  }

  try {
    const response = await fetch(new URL(`/api/calls/${encodeURIComponent(attempt.callSid)}`, baseUrl));

    if (!response.ok) {
      return null;
    }

    const body = (await response.json().catch(() => null)) as
      | {
          data?: {
            call?: {
              callStatus?: CallStatus;
              parseStatus?: ParseStatus;
              errorMessage?: string | null;
            };
          };
        }
      | null;
    const call = body?.data?.call;

    if (!call?.callStatus || !call?.parseStatus) {
      return null;
    }

    return {
      callStatus: call.callStatus,
      parseStatus: call.parseStatus,
      errorMessage: call.errorMessage ?? null,
    };
  } catch {
    return null;
  }
}

async function resolveAttemptOutcome(
  repository: CallRunsRepository,
  baseUrl: string,
  attempt: BatchAttemptRecord,
): Promise<BatchAttemptOutcome> {
  if (!attempt.requestOk) {
    attempt.resolvedOutcome = "bad";
    attempt.resolvedAt = attempt.resolvedAt ?? nowIso();
    return "bad";
  }

  const remoteRun = await fetchRemoteRunOutcome(baseUrl, attempt);
  const run =
    remoteRun ??
    (() => {
      const localRun = getCurrentRunForAttempt(repository, attempt);
      return localRun
        ? {
            callStatus: localRun.callStatus,
            parseStatus: localRun.parseStatus,
            errorMessage: localRun.errorMessage,
          }
        : null;
    })();
  const outcome = classifyBatchAttemptOutcome(
    run,
  );

  if (outcome !== "pending") {
    attempt.resolvedOutcome = outcome;
    attempt.resolvedAt = nowIso();
  }

  return outcome;
}

function recomputeConsecutiveBadOutcomes(state: BatchRunState): void {
  let streak = 0;

  for (const attempt of state.attempts) {
    if (attempt.resolvedOutcome === "good") {
      streak = 0;
    } else if (attempt.resolvedOutcome === "bad") {
      streak += 1;
    }
  }

  state.consecutiveBadOutcomes = streak;
}

async function refreshResolvedAttempts(
  repository: CallRunsRepository,
  baseUrl: string,
  state: BatchRunState,
): Promise<void> {
  for (const attempt of state.attempts) {
    if (attempt.resolvedOutcome === "good" || attempt.resolvedOutcome === "bad") {
      continue;
    }

    await resolveAttemptOutcome(repository, baseUrl, attempt);
  }

  recomputeConsecutiveBadOutcomes(state);
}

async function buildSelectedVenues(
  database: ReturnType<typeof createDatabase>,
  targetBeer: TargetBeerKey,
  includeAlreadyCalled: boolean,
  suburbFilterTerms: string[],
  limit: number,
): Promise<ReviewVenueRow[]> {
  const venues = await fetchAllRows<VenueRow>(
    "venues",
    "id, name, address, suburb, phone, latitude, longitude, source",
  );
  const localRuns = includeAlreadyCalled
    ? []
    : (database
        .prepare(
          `SELECT
             venue_id AS venueId,
             requested_beer AS requestedBeer,
             call_status AS callStatus,
             parse_status AS parseStatus,
             error_message AS errorMessage,
             created_at AS createdAt
           FROM call_runs
           WHERE is_test = 0
             AND venue_id IS NOT NULL
           ORDER BY created_at DESC`,
        )
        .all() as LocalCallRunRow[]);
  const latestLocalRunByVenueId = new Map<string, LocalCallRunRow>();

  for (const row of localRuns) {
    const runBeer = normalizeTargetBeerKey(row.requestedBeer);

    if (!row.venueId || runBeer !== targetBeer || latestLocalRunByVenueId.has(row.venueId)) {
      continue;
    }

    latestLocalRunByVenueId.set(row.venueId, row);
  }

  const candidates = venues
    .map((venue) => {
      const latestLocalRun = latestLocalRunByVenueId.get(venue.id);
      const alreadyResolved = includeAlreadyCalled
        ? false
        : latestLocalRun
          ? !isRetryableVenueOutcome({
              callStatus: latestLocalRun.callStatus,
              parseStatus: latestLocalRun.parseStatus,
              errorMessage: latestLocalRun.errorMessage,
            })
          : false;

      return buildReviewVenueRow({
        id: venue.id,
        name: venue.name,
        suburb: venue.suburb,
        address: venue.address,
        phone: venue.phone,
        normalizedPhone: normalizeAustralianPhoneToE164(venue.phone),
        latitude: venue.latitude,
        longitude: venue.longitude,
        source: venue.source,
        alreadyCalled: alreadyResolved,
        latestCallAt: latestLocalRun?.createdAt ?? null,
      });
    })
    .filter((venue) => venue.callEligible)
    .filter((venue) => matchesAreaFilter({ suburb: venue.suburb, address: venue.address }, suburbFilterTerms))
    .sort((left, right) => left.venueName.localeCompare(right.venueName));

  return limit > 0 ? candidates.slice(0, limit) : candidates;
}

function createNewState(input: {
  targetBeer: TargetBeerKey;
  baseUrl: string;
  delayMs: number;
  limit: number;
  suburbFilter: string | null;
  testMode: boolean;
  includeAlreadyCalled: boolean;
  circuitBreakerThreshold: number;
  venues: ReviewVenueRow[];
  dryRun: boolean;
  recoveredStaleCalls: number;
}): BatchRunState {
  const timestamp = nowIso();

  return {
    runId: randomUUID(),
    status: "running",
    targetBeer: input.targetBeer,
    createdAt: timestamp,
    updatedAt: timestamp,
    stopReason: null,
    dryRun: input.dryRun,
    baseUrl: input.baseUrl,
    delayMs: input.delayMs,
    limit: input.limit,
    suburbFilter: input.suburbFilter,
    testMode: input.testMode,
    includeAlreadyCalled: input.includeAlreadyCalled,
    circuitBreakerThreshold: input.circuitBreakerThreshold,
    recoveredStaleCalls: input.recoveredStaleCalls,
    cursor: 0,
    total: input.venues.length,
    successCount: 0,
    failureCount: 0,
    consecutiveBadOutcomes: 0,
    venues: input.venues,
    attempts: [],
  };
}

async function main() {
  const requestedBeerArg = getArg("beer", env.TARGET_BEER);
  const targetBeer = normalizeTargetBeerKey(requestedBeerArg);
  const baseUrl = getArg("base-url", "http://localhost:3000")!;
  const delayMs = Number.parseInt(getArg("delay-ms", "45000") ?? "45000", 10);
  const limit = Number.parseInt(getArg("limit", "0") ?? "0", 10);
  const suburbFilterRaw = getArg("suburb")?.trim() ?? null;
  const suburbFilterTerms = buildAreaFilterTerms(suburbFilterRaw);
  const dryRun = hasFlag("dry-run");
  const testMode = hasFlag("test-mode");
  const includeAlreadyCalled = hasFlag("include-called");
  const fresh = hasFlag("fresh");
  const circuitBreakerThreshold = Number.parseInt(
    getArg("circuit-breaker-threshold", String(env.BATCH_CALL_CIRCUIT_BREAKER_THRESHOLD)) ??
      String(env.BATCH_CALL_CIRCUIT_BREAKER_THRESHOLD),
    10,
  );
  const statePath = getStatePath();
  const database = createDatabase();
  const callRunsRepository = new CallRunsRepository(database);

  try {
    const recoveredStaleCalls = recoverStaleCallRuns(callRunsRepository, {
      activeMinutes: ACTIVE_STALE_MINUTES,
      completedMinutes: COMPLETED_STALE_MINUTES,
      terminalMinutes: TERMINAL_STALE_MINUTES,
      nowIso: nowIso(),
      limit: 5000,
    }).length;

    let state: BatchRunState | null = null;

    if (!dryRun && !fresh) {
      const existingState = readState(statePath);

      if (existingState && existingState.status !== "completed") {
        state = {
          ...existingState,
          targetBeer: existingState.targetBeer ?? targetBeer,
          status: "running",
          updatedAt: nowIso(),
          stopReason: null,
          circuitBreakerThreshold,
          baseUrl,
          delayMs,
          testMode,
          includeAlreadyCalled,
          recoveredStaleCalls: existingState.recoveredStaleCalls + recoveredStaleCalls,
          consecutiveBadOutcomes: 0,
        };
        await refreshResolvedAttempts(callRunsRepository, baseUrl, state);
        writeState(statePath, state);
        console.log(
          `Resuming ${getBeerByKey(state.targetBeer).name} batch ${state.runId} at ${state.cursor + 1}/${state.total}.`,
        );
      }
    }

    if (!state) {
      const selected = await buildSelectedVenues(
        database,
        targetBeer,
        includeAlreadyCalled,
        suburbFilterTerms,
        limit,
      );

      console.log(`Prepared ${selected.length} venues for ${getBeerByKey(targetBeer).name} outbound calling.`);

      if (dryRun) {
        console.log(`Dry run only. Current call window: ${buildCallingWindowReason()}`);
        for (const [index, venue] of selected.entries()) {
          console.log(`Would call ${index + 1}/${selected.length}: ${venue.venueName} (${venue.normalizedPhone})`);
        }
        return;
      }

      state = createNewState({
          baseUrl,
          delayMs,
          limit,
          targetBeer,
          suburbFilter: suburbFilterRaw,
          testMode,
        includeAlreadyCalled,
        circuitBreakerThreshold,
        venues: selected,
        dryRun,
        recoveredStaleCalls,
      });
      writeState(statePath, state);
      console.log(`Created batch state at ${statePath}.`);
    }

    if (state.total === 0) {
      state.status = "completed";
      state.updatedAt = nowIso();
      state.stopReason = "No eligible venues left to call.";
      writeState(statePath, state);
      console.log(state.stopReason);
      return;
    }

    for (let index = state.cursor; index < state.venues.length; index += 1) {
      if (!ensureCallingWindow(state, statePath)) {
        break;
      }

      const venue = state.venues[index]!;
      const payload = {
        venueId: venue.venueId,
        venueName: venue.venueName,
        phoneNumber: venue.normalizedPhone,
        suburb: venue.suburb ?? "Melbourne",
        requestedBeer: state.targetBeer,
        testMode,
      };

      console.log(`Calling ${index + 1}/${state.total}: ${venue.venueName} (${payload.phoneNumber})`);

      const response = await fetch(new URL("/api/calls/outbound", baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => null);
      const attempt = buildAttemptRecord(venue, response.status, body, response.ok);
      state.attempts.push(attempt);
      state.cursor = index + 1;
      state.updatedAt = nowIso();

      if (!response.ok) {
        state.failureCount += 1;
        state.consecutiveBadOutcomes += 1;
        console.error(`Call failed for ${venue.venueName}: ${response.status}`, body);

        if (response.status === 503) {
          const detail = (body as { error?: { message?: string; details?: { reason?: string } } } | null)?.error;
          state.status = "paused";
          state.stopReason = detail?.details?.reason ?? detail?.message ?? "Outbound calling paused by API.";
          writeState(statePath, state);
          console.log(`Pausing batch: ${state.stopReason}`);
          break;
        }

        if (state.consecutiveBadOutcomes >= state.circuitBreakerThreshold) {
          state.status = "paused";
          state.stopReason = `Circuit breaker tripped after ${state.consecutiveBadOutcomes} consecutive failed queue attempts.`;
          writeState(statePath, state);
          console.log(`Pausing batch: ${state.stopReason}`);
          break;
        }

        writeState(statePath, state);
        continue;
      }

      state.successCount += 1;
      writeState(statePath, state);
      console.log(`Queued ${venue.venueName}:`, body);

      if (index >= state.venues.length - 1) {
        continue;
      }

      await delay(state.delayMs);

      let resolvedOutcome = await resolveAttemptOutcome(callRunsRepository, baseUrl, attempt);
      state.updatedAt = nowIso();

      if (resolvedOutcome === "pending") {
        const waitUntil = Date.now() + UNRESOLVED_CALL_GRACE_MS;

        while (Date.now() < waitUntil && resolvedOutcome === "pending") {
          await delay(UNRESOLVED_CALL_POLL_MS);
          resolvedOutcome = await resolveAttemptOutcome(callRunsRepository, baseUrl, attempt);
          state.updatedAt = nowIso();
        }

        if (resolvedOutcome === "pending") {
          state.status = "paused";
          state.stopReason = `Previous call for ${venue.venueName} is still unresolved after ${state.delayMs + UNRESOLVED_CALL_GRACE_MS}ms.`;
          writeState(statePath, state);
          console.log(`Pausing batch: ${state.stopReason}`);
          break;
        }
      }

      if (resolvedOutcome === "good") {
        state.consecutiveBadOutcomes = 0;
      } else {
        state.consecutiveBadOutcomes += 1;
      }

      writeState(statePath, state);

      if (state.consecutiveBadOutcomes >= state.circuitBreakerThreshold) {
        state.status = "paused";
        state.stopReason = `Circuit breaker tripped after ${state.consecutiveBadOutcomes} consecutive bad call outcomes.`;
        writeState(statePath, state);
        console.log(`Pausing batch: ${state.stopReason}`);
        break;
      }
    }

    if (state.status === "running" && state.cursor >= state.total) {
      state.status = "completed";
      state.updatedAt = nowIso();
      state.stopReason = "Batch complete.";
      writeState(statePath, state);
    }

    console.log(
      `Batch state: ${state.status}. Successes: ${state.successCount}. Failures: ${state.failureCount}. Recovered stale calls: ${state.recoveredStaleCalls}.`,
    );
    console.log(`State file: ${statePath}`);
    if (state.stopReason) {
      console.log(`Reason: ${state.stopReason}`);
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
