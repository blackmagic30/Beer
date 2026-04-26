import { describe, expect, it } from "vitest";

import {
  buildSuppressedPhoneSet,
  classifyBatchAttemptOutcome,
  isRetryableVenueOutcome,
  shouldSuppressPhoneFromFutureDialing,
} from "../src/lib/call-batch.js";

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

  it("does not retry booking-line failures", () => {
    expect(
      isRetryableVenueOutcome({
        callStatus: "completed",
        parseStatus: "failed",
        errorMessage: "Booking line or switchboard reached",
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
    ).toBe("soft");
  });

  it("treats busy outcomes as soft", () => {
    expect(
      classifyBatchAttemptOutcome({
        callStatus: "busy",
        parseStatus: "failed",
        errorMessage: "Call ended with status busy",
      }),
    ).toBe("soft");
  });

  it("keeps hard failures as bad", () => {
    expect(
      classifyBatchAttemptOutcome({
        callStatus: "failed",
        parseStatus: "failed",
        errorMessage: "Call ended with status failed",
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

describe("shouldSuppressPhoneFromFutureDialing", () => {
  it("suppresses strongly automated outcomes after one clear detection", () => {
    expect(
      shouldSuppressPhoneFromFutureDialing([
        {
          callStatus: "completed",
          parseStatus: "failed",
          errorMessage: "Automated menu or IVR detected",
        },
      ]),
    ).toBe(true);
  });

  it("suppresses booking-line outcomes after one clear detection", () => {
    expect(
      shouldSuppressPhoneFromFutureDialing([
        {
          callStatus: "completed",
          parseStatus: "failed",
          errorMessage: "Booking line or switchboard reached",
        },
      ]),
    ).toBe(true);
  });

  it("suppresses repeated ambiguous low-signal outcomes", () => {
    expect(
      shouldSuppressPhoneFromFutureDialing([
        {
          callStatus: "completed",
          parseStatus: "failed",
          errorMessage: "Parsing produced no useful data",
        },
        {
          callStatus: "completed",
          parseStatus: "failed",
          errorMessage: "No clear human response detected",
        },
      ]),
    ).toBe(true);
  });

  it("does not suppress a phone if it later had a real human pickup", () => {
    expect(
      shouldSuppressPhoneFromFutureDialing([
        {
          callStatus: "completed",
          parseStatus: "failed",
          errorMessage: "Voicemail detected",
        },
        {
          callStatus: "completed",
          parseStatus: "parsed",
          errorMessage: null,
        },
      ]),
    ).toBe(false);
  });
});

describe("buildSuppressedPhoneSet", () => {
  it("builds a phone-level suppression set from recent outcomes", () => {
    const suppressed = buildSuppressedPhoneSet([
      {
        phoneNumber: "+61399990001",
        callStatus: "completed",
        parseStatus: "failed",
        errorMessage: "Automated menu or IVR detected",
        isTest: false,
      },
      {
        phoneNumber: "+61399990002",
        callStatus: "completed",
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
      },
      {
        phoneNumber: "+61399990002",
        callStatus: "completed",
        parseStatus: "failed",
        errorMessage: "No clear human response detected",
        isTest: false,
      },
      {
        phoneNumber: "+61399990003",
        callStatus: "completed",
        parseStatus: "parsed",
        errorMessage: null,
        isTest: false,
      },
    ]);

    expect(suppressed.has("+61399990001")).toBe(true);
    expect(suppressed.has("+61399990002")).toBe(true);
    expect(suppressed.has("+61399990003")).toBe(false);
  });
});
