import { describe, expect, it } from "vitest";

import { buildReparseCallRunResult } from "../src/modules/parsing/reparse-call-run.js";

describe("buildReparseCallRunResult", () => {
  it("uses the requested beer from beer results when reparsing a hosted call view", () => {
    const result = buildReparseCallRunResult(
      {
        id: "run-1",
        callSid: "CA123",
        conversationId: null,
        venueId: "venue-1",
        requestedBeer: null,
        venueName: "1806",
        phoneNumber: "+61400000000",
        suburb: "Melbourne",
        startedAt: "2026-04-23T10:12:18.464Z",
        endedAt: "2026-04-23T10:13:07.300Z",
        durationSeconds: 14,
        callStatus: "completed",
        rawTranscript:
          "AGENT: Hey mate, quick one, how much is a pint of Carlton Draft there?\nUSER: Fourteen dollars beautifully.",
        parseConfidence: 0.05,
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
        createdAt: "2026-04-23T10:12:18.464Z",
        updatedAt: "2026-04-23T10:13:07.300Z",
        beerResults: [{ beerName: "Carlton Draft" }],
      },
      0.72,
    );

    expect(result.requestedBeer).toBe("carlton_draft");
    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beerName: "Carlton Draft",
          priceNumeric: 14,
        }),
      ]),
    );
  });

  it("falls back to the agent prompt when requested beer metadata is missing", () => {
    const result = buildReparseCallRunResult(
      {
        id: "run-2",
        callSid: "CA456",
        conversationId: null,
        venueId: "venue-2",
        requestedBeer: null,
        venueName: "Some Bar",
        phoneNumber: "+61300000000",
        suburb: "Richmond",
        startedAt: "2026-04-23T10:12:18.464Z",
        endedAt: "2026-04-23T10:13:07.300Z",
        durationSeconds: 14,
        callStatus: "completed",
        rawTranscript:
          "AGENT: Hey mate, quick one, how much is a pint of Stone & Wood there?\nUSER: Fifteen dollars.",
        parseConfidence: 0.05,
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
        createdAt: "2026-04-23T10:12:18.464Z",
        updatedAt: "2026-04-23T10:13:07.300Z",
      },
      0.72,
    );

    expect(result.requestedBeer).toBe("stone_and_wood");
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beerName: "Stone & Wood",
          priceNumeric: 15,
        }),
      ]),
    );
  });
});
