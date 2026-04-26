import { describe, expect, it } from "vitest";

import { isEligibleForFollowUpBeer } from "../src/lib/callback-batch.js";

describe("isEligibleForFollowUpBeer", () => {
  it("includes real human pickups for follow-up beer batches", () => {
    expect(
      isEligibleForFollowUpBeer({
        callStatus: "completed",
        parseStatus: "parsed",
        rawTranscript: "USER: We don't have Carlton Draft, mate.",
        errorMessage: null,
        isTest: false,
      }),
    ).toBe(true);
  });

  it("excludes hard failures and no-signal outcomes from follow-up beer batches", () => {
    expect(
      isEligibleForFollowUpBeer({
        callStatus: "failed",
        parseStatus: "failed",
        rawTranscript: null,
        errorMessage: "Call ended with status failed",
        isTest: false,
      }),
    ).toBe(false);

    expect(
      isEligibleForFollowUpBeer({
        callStatus: "completed",
        parseStatus: "failed",
        rawTranscript: "USER: Press 1 for reservations.",
        errorMessage: "Automated menu or IVR detected",
        isTest: false,
      }),
    ).toBe(false);

    expect(
      isEligibleForFollowUpBeer({
        callStatus: "completed",
        parseStatus: "failed",
        rawTranscript: "USER: ...",
        errorMessage: "No clear human response detected",
        isTest: false,
      }),
    ).toBe(false);

    expect(
      isEligibleForFollowUpBeer({
        callStatus: "completed",
        parseStatus: "failed",
        rawTranscript: "USER: You've reached the reservations team.",
        errorMessage: "Booking line or switchboard reached",
        isTest: false,
      }),
    ).toBe(false);
  });

  it("excludes test calls from follow-up beer batches", () => {
    expect(
      isEligibleForFollowUpBeer({
        callStatus: "completed",
        parseStatus: "parsed",
        rawTranscript: "USER: Fourteen dollars beautifully.",
        errorMessage: null,
        isTest: true,
      }),
    ).toBe(false);
  });
});
