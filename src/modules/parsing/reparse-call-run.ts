import {
  DEFAULT_TARGET_BEER_KEY,
  SUPPORTED_BEERS,
  getBeerByKey,
  type TargetBeerKey,
} from "../../constants/beers.js";
import type {
  CallRunRecord,
  ParseStatus,
  PersistedBeerPriceResultInput,
  PersistedHappyHourInput,
} from "../../db/models.js";

import {
  detectTranscriptFailureReason,
  shouldOverrideParsedOutcome,
} from "./transcript-failure-reason.js";
import {
  extractBeerContextText,
  parseBeerPrices,
  summariseParseOutcome,
  type TranscriptTurnLike,
} from "./transcript-parser.js";

type ReparseBeerResultLike = {
  beerName: string;
};

export interface ReparsableCallRunLike
  extends Pick<
    CallRunRecord,
    | "id"
    | "callSid"
    | "conversationId"
    | "venueId"
    | "requestedBeer"
    | "venueName"
    | "phoneNumber"
    | "suburb"
    | "startedAt"
    | "endedAt"
    | "durationSeconds"
    | "callStatus"
    | "rawTranscript"
    | "parseConfidence"
    | "parseStatus"
    | "errorMessage"
    | "isTest"
    | "createdAt"
    | "updatedAt"
  > {
  beerResults?: ReparseBeerResultLike[];
}

export interface ReparseCallRunResult {
  requestedBeer: TargetBeerKey;
  parseConfidence: number;
  parseStatus: ParseStatus;
  needsReview: boolean;
  errorMessage: string | null;
  items: PersistedBeerPriceResultInput[];
  happyHour: PersistedHappyHourInput;
}

function normalizeBeerLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function inferBeerKeyFromLabel(value: string | null | undefined): TargetBeerKey | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeBeerLabel(value);

  for (const beer of Object.values(SUPPORTED_BEERS)) {
    if (normalizeBeerLabel(beer.name) === normalized) {
      return beer.key;
    }

    if (beer.aliases.some((alias) => normalizeBeerLabel(alias) === normalized)) {
      return beer.key;
    }
  }

  return null;
}

function inferBeerKeyFromTranscript(rawTranscript: string | null): TargetBeerKey | null {
  if (!rawTranscript) {
    return null;
  }

  const promptMatch = rawTranscript.match(/pint of\s+(.+?)\s+there\?/i);
  return inferBeerKeyFromLabel(promptMatch?.[1]);
}

function inferRequestedBeerKey(run: ReparsableCallRunLike): TargetBeerKey {
  if (run.requestedBeer) {
    return run.requestedBeer;
  }

  const beerResultBeerKey = run.beerResults
    ?.map((beerResult) => inferBeerKeyFromLabel(beerResult.beerName))
    .find((beerKey): beerKey is TargetBeerKey => Boolean(beerKey));

  if (beerResultBeerKey) {
    return beerResultBeerKey;
  }

  return inferBeerKeyFromTranscript(run.rawTranscript) ?? DEFAULT_TARGET_BEER_KEY;
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

export function buildReparseCallRunResult(
  run: ReparsableCallRunLike,
  parseConfidenceThreshold: number,
): ReparseCallRunResult {
  if (!run.rawTranscript) {
    throw new Error("Cannot reparse a call run without a transcript.");
  }

  const requestedBeer = inferRequestedBeerKey(run);
  const targetBeer = getBeerByKey(requestedBeer);
  const turns = parseTurns(run.rawTranscript);
  const beerTranscript = extractBeerContextText(turns, [targetBeer]);
  const userTranscript = flattenRoleTranscript(turns, "user");
  const parsedPrices = parseBeerPrices(beerTranscript || userTranscript || run.rawTranscript, {
    assumeBeerContext: Boolean(beerTranscript),
    targetBeers: [targetBeer],
  });
  const detectedFailureReason = detectTranscriptFailureReason(userTranscript, run.rawTranscript);
  const baseParseSummary = summariseParseOutcome(parsedPrices, null, parseConfidenceThreshold);
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
  const items: PersistedBeerPriceResultInput[] = persistedItemsSource.map(
    ({ evidence: _evidence, isUnavailable: _isUnavailable, ...item }) => ({
      ...item,
      needsReview: item.needsReview || parseSummary.needsReview,
    }),
  );

  return {
    requestedBeer,
    parseConfidence: parseSummary.parseConfidence,
    parseStatus: parseSummary.parseStatus,
    needsReview: parseSummary.needsReview,
    errorMessage: failureReason,
    items,
    happyHour: buildHappyHourDefaults(),
  };
}
