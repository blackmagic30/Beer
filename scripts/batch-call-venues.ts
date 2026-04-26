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
import {
  buildSuppressedPhoneSet,
  classifyBatchAttemptOutcome,
  isRetryableVenueOutcome,
  type BatchAttemptOutcome,
} from "../src/lib/call-batch.js";
import { normalizeAustralianPhoneToE164 } from "../src/lib/phone.js";
import {
  buildAreaFilterTerms,
  buildReviewVenueRow,
  dedupeReviewVenueRowsByPhone,
  matchesAreaFilter,
  type ReviewVenueRow,
} from "../src/lib/venue-directory.js";
import { getVenueLikelyOpenMap } from "../src/lib/venue-open-hours.js";
import { recoverStaleCallRuns } from "../src/modules/calls/stale-call-recovery.js";

interface VenueRow {
  id: string;
  google_place_id: string | null;
  name: string;
  address: string | null;
  suburb: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
}

interface LocalCallRunRow {
  phoneNumber: string;
  venueId: string | null;
  requestedBeer: string | null;
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage: string | null;
  createdAt: string;
}

interface HostedCallListRow {
  phoneNumber: string | null;
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage: string | null;
  isTest: boolean;
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
  consecutiveLowSignalOutcomes: number;
  venues: ReviewVenueRow[];
  attempts: BatchAttemptRecord[];
}

interface VenueOpenFilterResult {
  venues: ReviewVenueRow[];
  skippedClosedCount: number;
}

const ACTIVE_STALE_MINUTES = 20;
const COMPLETED_STALE_MINUTES = 15;
const TERMINAL_STALE_MINUTES = 5;
const UNRESOLVED_CALL_GRACE_MS = 45000;
const UNRESOLVED_CALL_POLL_MS = 5000;
const OUTBOUND_FETCH_RETRY_ATTEMPTS = 4;
const OUTBOUND_FETCH_RETRY_DELAY_MS = 3000;
const REMOTE_OUTCOME_FETCH_RETRY_ATTEMPTS = 2;
const REMOTE_OUTCOME_FETCH_RETRY_DELAY_MS = 1000;

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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMessage = cause ? describeError(cause) : null;

    if (causeMessage && causeMessage !== error.message) {
      return `${error.message} (cause: ${causeMessage})`;
    }

    return error.message;
  }

  return String(error);
}

async function fetchWithRetries(
  input: URL | string,
  init: RequestInit,
  options: {
    label: string;
    attempts: number;
    retryDelayMs: number;
  },
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      console.warn(`${options.label} failed on attempt ${attempt}/${options.attempts}: ${describeError(error)}`);

      if (attempt < options.attempts) {
        await delay(options.retryDelayMs);
      }
    }
  }

  throw new Error(`${options.label} failed after ${options.attempts} attempts: ${describeError(lastError)}`);
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

async function fetchRecentHostedCalls(baseUrl: string): Promise<HostedCallListRow[]> {
  try {
    const response = await fetchWithRetries(
      new URL("/api/calls?limit=200", baseUrl),
      {},
      {
        label: "Fetch recent hosted calls",
        attempts: REMOTE_OUTCOME_FETCH_RETRY_ATTEMPTS,
        retryDelayMs: REMOTE_OUTCOME_FETCH_RETRY_DELAY_MS,
      },
    );

    if (!response.ok) {
      return [];
    }

    const body = (await response.json().catch(() => null)) as
      | {
          data?: {
            calls?: HostedCallListRow[];
          };
        }
      | null;

    return body?.data?.calls ?? [];
  } catch (error) {
    console.warn(`Could not fetch recent hosted calls for suppression: ${describeError(error)}`);
    return [];
  }
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
    const response = await fetchWithRetries(
      new URL(`/api/calls/${encodeURIComponent(attempt.callSid)}`, baseUrl),
      {},
      {
        label: `Fetch hosted outcome for ${attempt.venueName}`,
        attempts: REMOTE_OUTCOME_FETCH_RETRY_ATTEMPTS,
        retryDelayMs: REMOTE_OUTCOME_FETCH_RETRY_DELAY_MS,
      },
    );

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
  } catch (error) {
    console.warn(`Falling back to local call state for ${attempt.venueName}: ${describeError(error)}`);
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
  let badStreak = 0;
  let lowSignalStreak = 0;

  for (const attempt of state.attempts) {
    if (attempt.resolvedOutcome === "good") {
      badStreak = 0;
      lowSignalStreak = 0;
    } else if (attempt.resolvedOutcome === "soft") {
      badStreak = 0;
      lowSignalStreak += 1;
    } else if (attempt.resolvedOutcome === "bad") {
      badStreak += 1;
      lowSignalStreak += 1;
    }
  }

  state.consecutiveBadOutcomes = badStreak;
  state.consecutiveLowSignalOutcomes = lowSignalStreak;
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
  baseUrl: string,
  targetBeer: TargetBeerKey,
  includeAlreadyCalled: boolean,
  suburbFilterTerms: string[],
  limit: number,
): Promise<ReviewVenueRow[]> {
  const venues = await fetchAllRows<VenueRow>(
    "venues",
    "id, google_place_id, name, address, suburb, phone, latitude, longitude, source",
  );
  const localRuns = includeAlreadyCalled
    ? []
    : (database
        .prepare(
          `SELECT
             phone_number AS phoneNumber,
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

  const recentHostedCalls = includeAlreadyCalled ? [] : await fetchRecentHostedCalls(baseUrl);
  const suppressedPhones = buildSuppressedPhoneSet([
    ...localRuns.map((row) => ({
      phoneNumber: row.phoneNumber,
      callStatus: row.callStatus,
      parseStatus: row.parseStatus,
      errorMessage: row.errorMessage,
      isTest: false,
    })),
    ...recentHostedCalls,
  ]);

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
        googlePlaceId: venue.google_place_id,
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
    .filter((venue) => !venue.normalizedPhone || !suppressedPhones.has(venue.normalizedPhone))
    .sort((left, right) => left.venueName.localeCompare(right.venueName));

  const dedupedCandidates = dedupeReviewVenueRowsByPhone(candidates);
  const openFilteredCandidates = await filterLikelyClosedVenues(dedupedCandidates);

  if (openFilteredCandidates.skippedClosedCount > 0) {
    console.log(`Skipped ${openFilteredCandidates.skippedClosedCount} venues that look closed right now.`);
  }

  return limit > 0 ? openFilteredCandidates.venues.slice(0, limit) : openFilteredCandidates.venues;
}

async function filterLikelyClosedVenues(venues: ReviewVenueRow[]): Promise<VenueOpenFilterResult> {
  const googleApiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;

  if (!googleApiKey) {
    return {
      venues,
      skippedClosedCount: 0,
    };
  }

  const likelyOpenByPlaceId = await getVenueLikelyOpenMap(
    venues
      .map((venue) => venue.googlePlaceId)
      .filter((googlePlaceId): googlePlaceId is string => Boolean(googlePlaceId)),
    {
      apiKey: googleApiKey,
      timezone: env.OUTBOUND_CALL_TIMEZONE,
    },
  );

  let skippedClosedCount = 0;
  const filteredVenues = venues.filter((venue) => {
    if (!venue.googlePlaceId) {
      return true;
    }

    const likelyOpen = likelyOpenByPlaceId.get(venue.googlePlaceId);

    if (likelyOpen === false) {
      skippedClosedCount += 1;
      return false;
    }

    return true;
  });

  return {
    venues: filteredVenues,
    skippedClosedCount,
  };
}

function pruneRemainingVenuesOnResume(state: BatchRunState): number {
  const attemptedPhones = new Set(
    state.attempts
      .map((attempt) => attempt.phoneNumber?.trim())
      .filter((phoneNumber): phoneNumber is string => Boolean(phoneNumber)),
  );
  const seenRemainingPhones = new Set<string>();
  const attemptedVenues = state.venues.slice(0, state.cursor);
  const remainingVenues = state.venues.slice(state.cursor);
  const dedupedRemaining: ReviewVenueRow[] = [];
  let removed = 0;

  for (const venue of remainingVenues) {
    const phoneNumber = venue.normalizedPhone?.trim() ?? null;

    if (phoneNumber && (attemptedPhones.has(phoneNumber) || seenRemainingPhones.has(phoneNumber))) {
      removed += 1;
      continue;
    }

    if (phoneNumber) {
      seenRemainingPhones.add(phoneNumber);
    }

    dedupedRemaining.push(venue);
  }

  if (removed > 0) {
    state.venues = [...attemptedVenues, ...dedupedRemaining];
    state.total = state.venues.length;
  }

  return removed;
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
  lowSignalThreshold: number;
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
    consecutiveLowSignalOutcomes: 0,
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
  const lowSignalThreshold = Number.parseInt(
    getArg("low-signal-threshold", String(env.BATCH_CALL_LOW_SIGNAL_THRESHOLD)) ??
      String(env.BATCH_CALL_LOW_SIGNAL_THRESHOLD),
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
          consecutiveLowSignalOutcomes: existingState.consecutiveLowSignalOutcomes ?? 0,
        };
        const removedDuplicatePhones = pruneRemainingVenuesOnResume(state);
        await refreshResolvedAttempts(callRunsRepository, baseUrl, state);

        if (removedDuplicatePhones > 0) {
          console.log(`Pruned ${removedDuplicatePhones} duplicate or already-attempted phone numbers from the remaining queue.`);
        }

        writeState(statePath, state);
        console.log(
          `Resuming ${getBeerByKey(state.targetBeer).name} batch ${state.runId} at ${state.cursor + 1}/${state.total}.`,
        );
      }
    }

    if (!state) {
      const selected = await buildSelectedVenues(
        database,
        baseUrl,
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
        lowSignalThreshold,
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

      let response: Response;

      try {
        response = await fetchWithRetries(
          new URL("/api/calls/outbound", baseUrl),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
          {
            label: `Queue call for ${venue.venueName}`,
            attempts: OUTBOUND_FETCH_RETRY_ATTEMPTS,
            retryDelayMs: OUTBOUND_FETCH_RETRY_DELAY_MS,
          },
        );
      } catch (error) {
        state.failureCount += 1;
        state.consecutiveBadOutcomes += 1;
        state.consecutiveLowSignalOutcomes += 1;
        state.status = "paused";
        state.updatedAt = nowIso();
        state.stopReason = `Network error while queueing ${venue.venueName}: ${describeError(error)}`;
        writeState(statePath, state);
        console.error(state.stopReason);
        break;
      }

      const body = await response.json().catch(() => null);
      const attempt = buildAttemptRecord(venue, response.status, body, response.ok);
      state.attempts.push(attempt);
      state.cursor = index + 1;
      state.updatedAt = nowIso();

      if (!response.ok) {
        state.failureCount += 1;
        state.consecutiveBadOutcomes += 1;
        state.consecutiveLowSignalOutcomes += 1;
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

        if (state.consecutiveLowSignalOutcomes >= lowSignalThreshold) {
          state.status = "paused";
          state.stopReason = `Low-signal breaker tripped after ${state.consecutiveLowSignalOutcomes} consecutive failed queue attempts.`;
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
        state.consecutiveLowSignalOutcomes = 0;
      } else if (resolvedOutcome === "soft") {
        state.consecutiveBadOutcomes = 0;
        state.consecutiveLowSignalOutcomes += 1;
      } else {
        state.consecutiveBadOutcomes += 1;
        state.consecutiveLowSignalOutcomes += 1;
      }

      writeState(statePath, state);

      if (state.consecutiveBadOutcomes >= state.circuitBreakerThreshold) {
        state.status = "paused";
        state.stopReason = `Circuit breaker tripped after ${state.consecutiveBadOutcomes} consecutive bad call outcomes.`;
        writeState(statePath, state);
        console.log(`Pausing batch: ${state.stopReason}`);
        break;
      }

      if (state.consecutiveLowSignalOutcomes >= lowSignalThreshold) {
        state.status = "paused";
        state.stopReason = `Low-signal breaker tripped after ${state.consecutiveLowSignalOutcomes} consecutive no-signal outcomes.`;
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
