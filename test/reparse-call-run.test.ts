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

  it("falls back to the full staff transcript when the first beer-context answer is only clarification", () => {
    const result = buildReparseCallRunResult(
      {
        id: "run-clarification-price",
        callSid: "CAPRICE",
        conversationId: null,
        venueId: "venue-price",
        requestedBeer: "carlton_draft",
        venueName: "The Oxford Scholar",
        phoneNumber: "+61300000002",
        suburb: "Melbourne",
        startedAt: "2026-04-29T08:00:00.000Z",
        endedAt: "2026-04-29T08:00:50.000Z",
        durationSeconds: 50,
        callStatus: "completed",
        rawTranscript:
          "AGENT: Hey mate, quick one, how much is a pint of Carlton Draft there?\nUSER: Sorry, what was that?\nAGENT: Just the regular pint price, thanks mate.\nUSER: The regular pint is 16.50. With the discount, it's 14.05.",
        parseConfidence: 0.05,
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
        createdAt: "2026-04-29T08:00:00.000Z",
        updatedAt: "2026-04-29T08:00:50.000Z",
      },
      0.72,
    );

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beerName: "Carlton Draft",
          priceNumeric: 16.5,
          needsReview: false,
        }),
      ]),
    );
  });

  it("reparses explicit don't-stock replies as useful unavailable results", () => {
    const result = buildReparseCallRunResult(
      {
        id: "run-not-stocked",
        callSid: "CANOSTOCK",
        conversationId: null,
        venueId: "venue-not-stocked",
        requestedBeer: "carlton_draft",
        venueName: "The Elysian Whisky Bar",
        phoneNumber: "+61300000003",
        suburb: "Fitzroy",
        startedAt: "2026-04-29T08:00:00.000Z",
        endedAt: "2026-04-29T08:00:40.000Z",
        durationSeconds: 40,
        callStatus: "completed",
        rawTranscript:
          "AGENT: Hey mate, quick one, how much is a pint of Carlton Draft there?\nUSER: We don't stock our own draft there.\nAGENT: Sorry, do you have Carlton Draft at all?\nUSER: No, we just don't do Carlton Draft yet.",
        parseConfidence: 0.05,
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
        createdAt: "2026-04-29T08:00:00.000Z",
        updatedAt: "2026-04-29T08:00:40.000Z",
      },
      0.72,
    );

    expect(result.parseStatus).toBe("parsed");
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beerName: "Carlton Draft",
          priceNumeric: null,
          availabilityStatus: "unavailable",
          unavailableReason: "not_stocked",
          needsReview: false,
        }),
      ]),
    );
  });

  it("reparses happy hour campaign calls into happy hour details without beer items", () => {
    const result = buildReparseCallRunResult(
      {
        id: "run-3",
        callSid: "CA789",
        conversationId: null,
        venueId: "venue-3",
        requestedBeer: "happy_hour",
        venueName: "Some Rooftop",
        phoneNumber: "+61300000001",
        suburb: "Melbourne",
        startedAt: "2026-04-28T08:00:00.000Z",
        endedAt: "2026-04-28T08:00:45.000Z",
        durationSeconds: 45,
        callStatus: "completed",
        rawTranscript:
          "AGENT: Hey mate, quick one, what days and times is your happy hour, and what specials do you run during it?\nUSER: Weekdays 4 to 6, seven dollar pints and half-price wings.",
        parseConfidence: 0.05,
        parseStatus: "failed",
        errorMessage: "Parsing produced no useful data",
        isTest: false,
        createdAt: "2026-04-28T08:00:00.000Z",
        updatedAt: "2026-04-28T08:00:45.000Z",
      },
      0.72,
    );

    expect(result.requestedBeer).toBe("happy_hour");
    expect(result.items).toEqual([]);
    expect(result.parseStatus).toBe("parsed");
    expect(result.happyHour).toEqual(
      expect.objectContaining({
        happyHour: true,
        happyHourDays: "weekdays",
        happyHourStart: "16:00",
        happyHourEnd: "18:00",
        happyHourPrice: 7,
        happyHourSpecials: expect.stringContaining("half-price wings"),
      }),
    );
  });
});
