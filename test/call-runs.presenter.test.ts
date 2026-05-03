import { describe, expect, it } from "vitest";

import type { BeerPriceResultRecord, CallRunRecord } from "../src/db/models.js";
import { buildCallRunViews } from "../src/modules/calls/call-runs.presenter.js";

function baseCallRun(overrides: Partial<CallRunRecord> = {}): CallRunRecord {
  return {
    id: "run-1",
    callSid: "CA123",
    conversationId: null,
    venueId: "venue-1",
    requestedBeer: "happy_hour",
    scriptVariant: "days_times_first",
    venueName: "Goldy's! Tavern",
    phoneNumber: "+61390072282",
    suburb: "Collingwood",
    startedAt: "2026-05-02T10:14:32.134Z",
    endedAt: "2026-05-02T10:15:32.134Z",
    durationSeconds: 60,
    callStatus: "completed",
    rawTranscript:
      "USER: To speak to us about a booking of 20 or under, please press one. Have a gold one.",
    parseConfidence: 0.05,
    parseStatus: "failed",
    errorMessage: "Automated menu or IVR detected",
    isTest: false,
    createdAt: "2026-05-02T10:14:32.134Z",
    updatedAt: "2026-05-02T10:15:32.134Z",
    ...overrides,
  };
}

describe("buildCallRunViews", () => {
  it("does not derive happy-hour details from failed transcripts", () => {
    const [view] = buildCallRunViews([baseCallRun()], [], 0.72);

    expect(view?.happyHour).toBeNull();
  });

  it("can derive happy-hour details from non-failed transcripts when no result row exists", () => {
    const [view] = buildCallRunViews(
      [
        baseCallRun({
          parseConfidence: 0.74,
          parseStatus: "needs_review",
          errorMessage: null,
          rawTranscript: "USER: Happy hour is weekdays from 4 to 6 with $7 pints.",
        }),
      ],
      [],
      0.72,
    );

    expect(view?.happyHour).toMatchObject({
      happyHour: true,
      happyHourDays: "weekdays",
      happyHourStart: "16:00",
      happyHourEnd: "18:00",
      happyHourPrice: 7,
    });
  });

  it("uses stored happy-hour result rows before deriving from the transcript", () => {
    const resultRow: BeerPriceResultRecord = {
      id: 1,
      venueId: "venue-1",
      venueName: "Goldy's! Tavern",
      phoneNumber: "+61390072282",
      suburb: "Collingwood",
      beerName: "Happy Hour",
      priceText: null,
      priceNumeric: null,
      availabilityStatus: "unknown",
      availableOnTap: null,
      availablePackageOnly: false,
      unavailableReason: null,
      timestamp: "2026-05-02T10:14:32.134Z",
      rawTranscript: "",
      confidence: 0.05,
      happyHour: false,
      happyHourDays: null,
      happyHourStart: null,
      happyHourEnd: null,
      happyHourPrice: null,
      happyHourConfidence: 0,
      happyHourSpecials: null,
      callSid: "CA123",
      conversationId: null,
      needsReview: true,
      createdAt: "2026-05-02T10:15:32.134Z",
    };

    const [view] = buildCallRunViews([baseCallRun({ parseStatus: "parsed", errorMessage: null })], [resultRow], 0.72);

    expect(view?.happyHour).toMatchObject({
      happyHour: false,
      happyHourPrice: null,
      happyHourSpecials: null,
    });
  });
});
