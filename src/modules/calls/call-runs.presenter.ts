import type { BeerPriceResultRecord, CallRunRecord } from "../../db/models.js";
import { extractHappyHourContextText, parseHappyHourInfo } from "../parsing/transcript-parser.js";

export interface CallRunView {
  id: string;
  callSid: string | null;
  venueId: string | null;
  requestedBeer: string | null;
  scriptVariant: string | null;
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
  beerResults: Array<{
    beerName: string;
    priceText: string | null;
    priceNumeric: number | null;
    availabilityStatus: string;
    availableOnTap: boolean | null;
    availablePackageOnly: boolean;
    unavailableReason: string | null;
    confidence: number;
    needsReview: boolean;
  }>;
  happyHour: {
    happyHour: boolean;
    happyHourDays: string | null;
    happyHourStart: string | null;
    happyHourEnd: string | null;
    happyHourPrice: number | null;
    confidence: number | null;
    happyHourSpecials: string | null;
  } | null;
}

interface PresenterTranscriptTurn {
  role: string | undefined;
  message: string;
  originalMessage: string;
}

function parseTurns(rawTranscript: string) {
  return rawTranscript
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
    })
    .filter((turn): turn is PresenterTranscriptTurn => turn !== null);
}

export function buildCallRunViews(
  callRuns: CallRunRecord[],
  resultRows: BeerPriceResultRecord[],
  confidenceThreshold: number,
): CallRunView[] {
  const resultsByCallSid = new Map<string, BeerPriceResultRecord[]>();

  for (const row of resultRows) {
    const rows = resultsByCallSid.get(row.callSid) ?? [];
    rows.push(row);
    resultsByCallSid.set(row.callSid, rows);
  }

  return callRuns.map((callRun) => {
    const callRows = callRun.callSid ? resultsByCallSid.get(callRun.callSid) ?? [] : [];
    const happyHourSource = callRows[0];
    const derivedHappyHour =
      !happyHourSource && callRun.requestedBeer === "happy_hour" && callRun.rawTranscript
        ? parseHappyHourInfo(extractHappyHourContextText(parseTurns(callRun.rawTranscript)) || callRun.rawTranscript, {
            assumeHappyHourContext: true,
          })
        : null;
    const needsReview =
      callRun.parseStatus !== "parsed" ||
      (callRun.parseConfidence !== null && callRun.parseConfidence < confidenceThreshold);

    return {
      id: callRun.id,
      callSid: callRun.callSid,
      venueId: callRun.venueId,
      requestedBeer: callRun.requestedBeer,
      scriptVariant: callRun.scriptVariant,
      venueName: callRun.venueName,
      phoneNumber: callRun.phoneNumber,
      suburb: callRun.suburb,
      startedAt: callRun.startedAt,
      endedAt: callRun.endedAt,
      durationSeconds: callRun.durationSeconds,
      callStatus: callRun.callStatus,
      parseConfidence: callRun.parseConfidence,
      parseStatus: callRun.parseStatus,
      rawTranscript: callRun.rawTranscript,
      errorMessage: callRun.errorMessage,
      isTest: callRun.isTest,
      createdAt: callRun.createdAt,
      updatedAt: callRun.updatedAt,
      needsReview,
      beerResults: callRows.map((row) => ({
        beerName: row.beerName,
        priceText: row.priceText,
        priceNumeric: row.priceNumeric,
        availabilityStatus: row.availabilityStatus,
        availableOnTap: row.availableOnTap,
        availablePackageOnly: row.availablePackageOnly,
        unavailableReason: row.unavailableReason,
        confidence: row.confidence,
        needsReview: row.needsReview,
      })),
      happyHour: happyHourSource
        ? {
            happyHour: happyHourSource.happyHour,
            happyHourDays: happyHourSource.happyHourDays,
            happyHourStart: happyHourSource.happyHourStart,
            happyHourEnd: happyHourSource.happyHourEnd,
            happyHourPrice: happyHourSource.happyHourPrice,
            confidence: happyHourSource.happyHourConfidence,
            happyHourSpecials: happyHourSource.happyHourSpecials,
          }
        : derivedHappyHour
          ? {
              happyHour: derivedHappyHour.happyHour,
              happyHourDays: derivedHappyHour.happyHourDays,
              happyHourStart: derivedHappyHour.happyHourStart,
              happyHourEnd: derivedHappyHour.happyHourEnd,
              happyHourPrice: derivedHappyHour.happyHourPrice,
              confidence: derivedHappyHour.confidence,
              happyHourSpecials: derivedHappyHour.happyHourSpecials,
            }
          : null,
    };
  });
}
