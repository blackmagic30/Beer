import type { SystemStateRepository } from "../db/system-state.repository.js";
import type { SqlDatabase } from "../db/sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_COMPARE_AND_SET_ATTEMPTS = 64;
const ROLLING_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const BUDGET_STATE_KEY =
  "external-provider-budget:permanent-staging:openai-menu-ocr:rolling-31-day";

const POSTGRES_DATABASE_CLOCK_SQL = `/* external-provider-cost-budget:clock:postgres */
  SELECT pg_catalog.clock_timestamp() AS "now"`;
const SQLITE_DATABASE_CLOCK_SQL = `/* external-provider-cost-budget:clock:sqlite */
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS "now"`;

export const OPENAI_MENU_OCR_COST_BOUND_MODEL =
  "gpt-4.1-mini-2025-04-14" as const;
export const OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS = 100 as const;
export const OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS = 5 as const;
export const OPENAI_MENU_OCR_COST_BOUND_MAX_PROMPT_BYTES = 49_152 as const;
export const OPENAI_MENU_OCR_COST_BOUND_MAX_IMAGES = 6 as const;
export const OPENAI_MENU_OCR_COST_BOUND_IMAGE_PATCH_BUDGET = 1_536 as const;
export const OPENAI_MENU_OCR_COST_BOUND_IMAGE_TOKEN_MULTIPLIER_HUNDREDTHS = 162 as const;
export const OPENAI_MENU_OCR_COST_BOUND_PROTOCOL_TOKEN_HEADROOM = 10_000 as const;
export const OPENAI_MENU_OCR_COST_BOUND_INPUT_CENTS_PER_MILLION = 40 as const;
export const OPENAI_MENU_OCR_COST_BOUND_OUTPUT_CENTS_PER_MILLION = 160 as const;
export const OPENAI_MENU_OCR_COST_BOUND_MAX_OUTPUT_TOKENS = 8_192 as const;

const maximumImageTokenUnits = Math.ceil(
  OPENAI_MENU_OCR_COST_BOUND_IMAGE_PATCH_BUDGET
    * OPENAI_MENU_OCR_COST_BOUND_IMAGE_TOKEN_MULTIPLIER_HUNDREDTHS
    / 100,
) * OPENAI_MENU_OCR_COST_BOUND_MAX_IMAGES;
export const OPENAI_MENU_OCR_COST_BOUND_WORST_CASE_CENTS = Math.ceil((
  (
    OPENAI_MENU_OCR_COST_BOUND_MAX_PROMPT_BYTES
    + maximumImageTokenUnits
    + OPENAI_MENU_OCR_COST_BOUND_PROTOCOL_TOKEN_HEADROOM
  ) * OPENAI_MENU_OCR_COST_BOUND_INPUT_CENTS_PER_MILLION
  + OPENAI_MENU_OCR_COST_BOUND_MAX_OUTPUT_TOKENS
    * OPENAI_MENU_OCR_COST_BOUND_OUTPUT_CENTS_PER_MILLION
) / 1_000_000);

if (
  OPENAI_MENU_OCR_COST_BOUND_WORST_CASE_CENTS
  !== OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS
) {
  throw new Error("OpenAI menu OCR cost reservation no longer matches its reviewed bound.");
}

export interface ExternalProviderRollingBudgetState {
  readonly schemaVersion: "pintpath-external-provider-rolling-budget/v1";
  readonly environment: "permanent-staging";
  readonly providerSurface: "openai-menu-ocr";
  readonly window: "rolling-31-day";
  readonly maximumCents: typeof OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS;
  readonly reservationUnitCents: typeof OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS;
  readonly reservationTimestamps: readonly string[];
}

export interface ExternalProviderBudgetReservation {
  readonly allowed: boolean;
  readonly stateKey: string;
  readonly reservedCents: number;
  readonly remainingCents: number;
  readonly reservationCount: number;
}

const EXPECTED_STATE_KEYS = [
  "environment",
  "maximumCents",
  "providerSurface",
  "reservationTimestamps",
  "reservationUnitCents",
  "schemaVersion",
  "window",
] as const;

function canonicalUtc(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new Error(`${label} must be a canonical UTC timestamp.`);
    }
  } catch {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function exactKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === EXPECTED_STATE_KEYS.length
    && keys.every((key, index) => key === EXPECTED_STATE_KEYS[index]);
}

function normalizeState(
  value: unknown,
): ExternalProviderRollingBudgetState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value)) {
    throw new Error("External-provider rolling budget state is invalid.");
  }
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.reservationTimestamps)) {
    throw new Error("External-provider rolling budget state is invalid.");
  }
  const reservationTimestamps = state.reservationTimestamps.map((timestamp, index) =>
    canonicalUtc(timestamp, `reservationTimestamps[${index}]`));
  if (
    state.schemaVersion !== "pintpath-external-provider-rolling-budget/v1"
    || state.environment !== "permanent-staging"
    || state.providerSurface !== "openai-menu-ocr"
    || state.window !== "rolling-31-day"
    || state.maximumCents !== OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS
    || state.reservationUnitCents !== OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS
    || reservationTimestamps.length < 1
    || reservationTimestamps.length
      > OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS
        / OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS
    || reservationTimestamps.some((timestamp, index) =>
      index > 0 && reservationTimestamps[index - 1]! > timestamp)
  ) {
    throw new Error("External-provider rolling budget state is invalid.");
  }
  return Object.freeze({
    schemaVersion: state.schemaVersion,
    environment: state.environment,
    providerSurface: state.providerSurface,
    window: state.window,
    maximumCents: state.maximumCents,
    reservationUnitCents: state.reservationUnitCents,
    reservationTimestamps: Object.freeze(reservationTimestamps),
  });
}

function result(
  allowed: boolean,
  state: ExternalProviderRollingBudgetState,
): ExternalProviderBudgetReservation {
  const reservationCount = state.reservationTimestamps.length;
  const reservedCents =
    reservationCount * OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS;
  return Object.freeze({
    allowed,
    stateKey: BUDGET_STATE_KEY,
    reservedCents,
    remainingCents: OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS - reservedCents,
    reservationCount,
  });
}

/**
 * Reserves the full reviewed worst-case cost before a provider attempt. A
 * failed or uncertain request is never refunded. The rolling 31-day window is
 * stricter than any calendar month and avoids a provider-billing rollover
 * race. Compare-and-set makes the counter shared across replicas without
 * adding a new database relation.
 * Serialized state is evidence, not a provider price or account receipt.
 */
async function reserveOpenAiMenuOcrRollingBudgetAt(
  repository: Pick<SystemStateRepository, "get" | "compareAndSet">,
  nowInput: string,
): Promise<ExternalProviderBudgetReservation> {
  const now = canonicalUtc(nowInput, "now");
  const cutoff = new Date(Date.parse(now) - ROLLING_WINDOW_MS).toISOString();

  for (let attempt = 0; attempt < MAX_COMPARE_AND_SET_ATTEMPTS; attempt += 1) {
    const existing = await repository.get<ExternalProviderRollingBudgetState>(BUDGET_STATE_KEY);
    if (existing) {
      const state = normalizeState(existing.value);
      const activeTimestamps = state.reservationTimestamps
        .filter((timestamp) => timestamp >= cutoff);
      if (
        (activeTimestamps.length + 1) * OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS
          > OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS
      ) {
        return result(false, { ...state, reservationTimestamps: activeTimestamps });
      }
      const lastReservedAt = activeTimestamps.at(-1);
      const reservationAt = lastReservedAt && lastReservedAt > now
        ? lastReservedAt
        : now;
      const next: ExternalProviderRollingBudgetState = {
        ...state,
        // A competing session can commit after this session reads the database
        // clock but before its CAS read. Preserve the later persisted clock
        // value rather than rejecting safe contention.
        reservationTimestamps: [...activeTimestamps, reservationAt],
      };
      const updated = await repository.compareAndSet(
        BUDGET_STATE_KEY,
        existing.revision,
        next,
        reservationAt,
      );
      if (updated) {
        return result(true, normalizeState(updated.value));
      }
      continue;
    }

    const initial: ExternalProviderRollingBudgetState = {
      schemaVersion: "pintpath-external-provider-rolling-budget/v1",
      environment: "permanent-staging",
      providerSurface: "openai-menu-ocr",
      window: "rolling-31-day",
      maximumCents: OPENAI_MENU_OCR_COST_BOUND_MONTHLY_CENTS,
      reservationUnitCents: OPENAI_MENU_OCR_COST_BOUND_RESERVATION_CENTS,
      reservationTimestamps: [now],
    };
    const created = await repository.compareAndSet(BUDGET_STATE_KEY, null, initial, now);
    if (created) {
      return result(true, normalizeState(created.value));
    }
  }

  throw new Error("External-provider rolling budget reservation was contended.");
}

/**
 * Uses the shared database clock as the rolling-window authority before
 * reserving. This prevents host-clock skew across application replicas from
 * opening a second ledger window. The database query is read-only; the CAS
 * that follows remains the serialization boundary.
 */
export async function reserveOpenAiMenuOcrRollingBudget(
  repository: Pick<SystemStateRepository, "get" | "compareAndSet">,
  database: Pick<SqlDatabase, "dialect" | "prepare">,
): Promise<ExternalProviderBudgetReservation> {
  const query = database.dialect === "postgres"
    ? POSTGRES_DATABASE_CLOCK_SQL
    : SQLITE_DATABASE_CLOCK_SQL;
  const row = await database.prepare(query).get<{ now: unknown }>();
  if (!row) {
    throw new Error("External-provider database clock returned no row.");
  }
  const now = canonicalUtc(row.now, "database clock");
  return reserveOpenAiMenuOcrRollingBudgetAt(repository, now);
}

export function assertOpenAiMenuOcrCostBoundRequest(input: {
  readonly model: string;
  readonly prompt: string;
  readonly imageCount: number;
  readonly documentCount: number;
}): void {
  if (input.model !== OPENAI_MENU_OCR_COST_BOUND_MODEL) {
    throw new Error("Cost-bound menu OCR requires the exact reviewed model snapshot.");
  }
  if (
    !Number.isSafeInteger(input.imageCount)
    || input.imageCount < 1
    || input.imageCount > OPENAI_MENU_OCR_COST_BOUND_MAX_IMAGES
    || input.documentCount !== 0
  ) {
    throw new Error("Cost-bound menu OCR requires one to six images and forbids PDF input.");
  }
  if (
    typeof input.prompt !== "string"
    || input.prompt.length === 0
    || Buffer.byteLength(input.prompt, "utf8")
      > OPENAI_MENU_OCR_COST_BOUND_MAX_PROMPT_BYTES
  ) {
    throw new Error("Cost-bound menu OCR prompt exceeds its reviewed byte ceiling.");
  }
}

export const externalProviderCostBudgetInternals = Object.freeze({
  normalizeState,
  budgetStateKey: BUDGET_STATE_KEY,
  postgresDatabaseClockSql: POSTGRES_DATABASE_CLOCK_SQL,
  reserveOpenAiMenuOcrRollingBudgetAt,
  rollingWindowMs: ROLLING_WINDOW_MS,
  sqliteDatabaseClockSql: SQLITE_DATABASE_CLOCK_SQL,
});
