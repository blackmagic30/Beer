import { describe, expect, it } from "vitest";

import { classifyBatchAttemptOutcome, isRetryableVenueOutcome } from "../src/lib/call-batch.js";

describe("isRetryableVenueOutcome", () => {
  it("does not retry resolved parsed outcomes", () => {
    expect(
      isRetryableVenueOutcome({
        callStatus: "completed",
        parseStatus: "parsed",
        errorMessage: null,
      }),
    ).toBe(false);
  });

  it("retries busy and no-answer outcomes", () => {
    expect(
      isRetryableVenueOutcome({
        callStatus: "busy",
        parseStatus: "failed",
        errorMessage: "Call ended with status busy",
      }),
    ).toBe(true);
  });

  it("does not retry wrong-business failures", () => {
    expect(
      isRetryableVenueOutcome({
        callStatus: "failed",
        parseStatus: "failed",
        errorMessage: "Wrong business reached",
      }),
    ).toBe(false);
  });
});

describe("classifyBatchAttemptOutcome", () => {
  it("treats parsed outcomes as good", () => {
    expect(
      classifyBatchAttemptOutcome({
        callStatus: "completed",
        parseStatus: "parsed",
        errorMessage: null,
      }),
    ).toBe("good");
  });

  it("treats failed outcomes as bad", () => {
    expect(
      classifyBatchAttemptOutcome({
        callStatus: "failed",
        parseStatus: "failed",
        errorMessage: "Voicemail detected",
      }),
    ).toBe("bad");
  });

  it("treats active pending outcomes as pending", () => {
    expect(
      classifyBatchAttemptOutcome({
        callStatus: "in-progress",
        parseStatus: "pending",
        errorMessage: null,
      }),
    ).toBe("pending");
  });
});
