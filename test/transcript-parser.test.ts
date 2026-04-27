import { describe, expect, it } from "vitest";

import { getBeerByKey } from "../src/constants/beers.js";
import {
  extractBeerContextText,
  extractHappyHourContextText,
  parseBeerPrices,
  parseHappyHourInfo,
  summariseParseOutcome,
} from "../src/modules/parsing/transcript-parser.js";

describe("parseBeerPrices", () => {
  it("extracts a direct Guinness price", () => {
    const results = parseBeerPrices("Guinness is $12.");

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 12,
        needsReview: false,
        availabilityStatus: "on_tap",
        availableOnTap: true,
      }),
    ]);
  });

  it("extracts a direct Carlton Draft price when that beer is targeted", () => {
    const results = parseBeerPrices("Carlton Draught is $14.", {
      targetBeers: [getBeerByKey("carlton_draft")],
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draft",
        priceNumeric: 14,
        needsReview: false,
      }),
    ]);
  });

  it("extracts a direct Stone & Wood price when that beer is targeted", () => {
    const results = parseBeerPrices("Stone and Wood is 15 dollars.", {
      targetBeers: [getBeerByKey("stone_and_wood")],
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Stone & Wood",
        priceNumeric: 15,
        needsReview: false,
      }),
    ]);
  });

  it("extracts a direct Carlton Draft price when the amount is spoken in words", () => {
    const results = parseBeerPrices("Carlton Draft is fourteen dollars.", {
      targetBeers: [getBeerByKey("carlton_draft")],
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draft",
        priceNumeric: 14,
        needsReview: false,
      }),
    ]);
  });

  it("keeps missing Guinness as a low-confidence review item", () => {
    const results = parseBeerPrices("Not sure on Guinness.");

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: true,
      }),
    ]);
  });

  it("handles alias-level direct pricing for Guinness", () => {
    const results = parseBeerPrices("A pint of Guinness is 13.5 dollars.");

    expect(results[0]).toEqual(
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 13.5,
      }),
    );
  });

  it("uses beer-question context when the user only says the price", () => {
    const results = parseBeerPrices("Uh, $10. But why did you sound Irish?", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 10,
        needsReview: false,
      }),
    ]);
  });

  it("uses beer-question context when the user answers with a spoken number", () => {
    const results = parseBeerPrices("Fourteen dollars beautifully.", {
      assumeBeerContext: true,
      targetBeers: [getBeerByKey("carlton_draft")],
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draft",
        priceNumeric: 14,
        needsReview: false,
      }),
    ]);
  });

  it("treats explicit unavailability as a useful Guinness result", () => {
    const results = parseBeerPrices("We don't have Guinness on tap here, unfortunately.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        priceText: "We don't have Guinness on tap here, unfortunately",
        needsReview: false,
        isUnavailable: true,
        availabilityStatus: "unavailable",
        availableOnTap: false,
        unavailableReason: "not_on_tap",
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.72);
  });

  it("treats schooners-only wording as a strong no-pints result", () => {
    const results = parseBeerPrices("Carlton Draft? We only do schooners for that one.", {
      assumeBeerContext: true,
      targetBeers: [getBeerByKey("carlton_draft")],
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draft",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
        availabilityStatus: "unavailable",
        availableOnTap: true,
        unavailableReason: "no_pints",
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("prefers cans-only over no-pints when both are mentioned", () => {
    const results = parseBeerPrices("We don't have Guinness in pints, only cans.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
        availabilityStatus: "package_only",
        availableOnTap: false,
        availablePackageOnly: true,
        unavailableReason: "cans_only",
      }),
    ]);
  });

  it("keeps the main price when a day-specific special is also mentioned", () => {
    const results = parseBeerPrices("Um, 15 bucks, 12 on Sundays.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 15,
        priceText: "Um, 15 bucks, 12 on Sundays.",
        needsReview: false,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.72);
  });

  it("does not treat a voicemail recording as beer unavailability", () => {
    const results = parseBeerPrices(
      "This number is not available. Record your message at the tone. Press any key or stop talking to end the recording.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        priceText: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
  });

  it("does not turn emergency broadcast recordings into Guinness prices", () => {
    const results = parseBeerPrices(
      "Thank you for calling 911. This is a test of the emergency broadcast system. Please check your local radio or television station for further instructions.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        priceText: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
  });

  it("does not treat digits embedded in words as prices", () => {
    const results = parseBeerPrices(
      "You can reach the team at O2V Melbourne on melbourne@o2v.com.au for reservations.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        priceText: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
  });

  it("captures a hedged single-price answer with surcharge context", () => {
    const results = parseBeerPrices("Probably closer to like $20 with Sunday surcharge.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 20,
        priceText: "Probably closer to like $20 with Sunday surcharge.",
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.55);
  });

  it("treats on-tap unavailability plus cans as a strong unavailable result", () => {
    const results = parseBeerPrices(
      "A pint? Uh, well, no, we've only got the cans in there. No, we don't have it on tap.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
        availabilityStatus: "package_only",
        availableOnTap: false,
        availablePackageOnly: true,
        unavailableReason: "cans_only",
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("treats big-can-only phrasing as a strong unavailable result", () => {
    const results = parseBeerPrices("Uh, Guinness? Let me just check for you. We do like the big cans.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
        availabilityStatus: "package_only",
        availableOnTap: false,
        availablePackageOnly: true,
        unavailableReason: "cans_only",
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("treats just-do-it-on-the-cans phrasing as unavailable", () => {
    const results = parseBeerPrices("Uh, we just do it on the cans.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("treats do-not-have phrasing as unavailable", () => {
    const results = parseBeerPrices("Uh, we do not have Guinness.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("treats disfluent do-not-have phrasing as unavailable", () => {
    const results = parseBeerPrices("Uh, we do not, uh, have Guinness.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: false,
        isUnavailable: true,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("prefers the regular price over a volunteered happy hour price", () => {
    const results = parseBeerPrices(
      "Uh, on Happy Hour, mate, which is every day from 3:00 to 6:00, it's 12, and just regular's 15.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 15,
        needsReview: false,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.72);
  });

  it("prefers a later corrected price over an earlier guess", () => {
    const results = parseBeerPrices(
      "Uh, 15, 15 I guess. Let me just have a check. Don't wanna give you the wrong price. Uh.... Pardon? Uh, 15.50, yeah.",
      {
        assumeBeerContext: true,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: 15.5,
        needsReview: false,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBeGreaterThan(0.72);
  });

  it("does not treat hourly bay pricing as a Guinness price", () => {
    const results = parseBeerPrices("You would like to know how much for the bay? It's 65 for an hour.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBe(0.05);
  });

  it("does not treat non-dollar currency symbols as valid Guinness prices", () => {
    const results = parseBeerPrices("£1.50.", {
      assumeBeerContext: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Guinness",
        priceNumeric: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBe(0.05);
  });

  it("does not treat venue-name numbers in a greeting as a beer price", () => {
    const results = parseBeerPrices(
      "Thanks for calling 81 Bay. Meagan speaking. Hello? Hey Meagan, quick one, how much is a pint of Carlton Draft there? Good.",
      {
        assumeBeerContext: true,
        targetBeers: [getBeerByKey("carlton_draft")],
      },
    );

    expect(results).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draft",
        priceNumeric: null,
        needsReview: true,
        isUnavailable: false,
      }),
    ]);
    expect(results[0]?.confidence).toBe(0.24);
  });
});

describe("parseHappyHourInfo", () => {
  it("extracts happy hour days, times, and price", () => {
    const result = parseHappyHourInfo(
      "We do happy hour weekdays 4-6pm and the pints are $7 then.",
    );

    expect(result).toEqual(
      expect.objectContaining({
        happyHour: true,
        happyHourDays: "weekdays",
        happyHourStart: "16:00",
        happyHourEnd: "18:00",
        happyHourPrice: 7,
        needsReview: false,
      }),
    );
    expect(result.confidence).toBeGreaterThan(0.72);
  });

  it("allows partial extraction when some happy hour fields are missing", () => {
    const result = parseHappyHourInfo("Friday only, 16:00-18:00.", {
      assumeHappyHourContext: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        happyHour: true,
        happyHourDays: "Friday only",
        happyHourStart: "16:00",
        happyHourEnd: "18:00",
        happyHourPrice: null,
        needsReview: true,
      }),
    );
  });

  it("captures explicit no-happy-hour answers", () => {
    const result = parseHappyHourInfo("No happy hour at the moment.");

    expect(result).toEqual(
      expect.objectContaining({
        happyHour: false,
        happyHourDays: null,
        happyHourStart: null,
        happyHourEnd: null,
        happyHourPrice: null,
        needsReview: false,
      }),
    );
    expect(result.confidence).toBeGreaterThan(0.85);
  });
});

describe("extractHappyHourContextText", () => {
  it("pulls the user answer after the agent beer question", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "Uh, $10. But why did you sound Irish?",
      },
      {
        role: "agent",
        message:
          "And do you have any happy hour deals at the moment? If so, what times and what are the prices during that?",
      },
    ]);

    expect(result).toBe("Uh, $10. But why did you sound Irish?");
  });

  it("keeps listening after a clarification prompt and captures the real answer", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "Uh...",
      },
      {
        role: "agent",
        message: "Sorry, what was that mate?",
      },
      {
        role: "user",
        message: "Probably closer to like $20 with Sunday surcharge.",
      },
      {
        role: "agent",
        message: "Thanks, bye.",
      },
    ]);

    expect(result).toBe("Uh.... Probably closer to like $20 with Sunday surcharge.");
  });

  it("keeps listening past a non-substantive agent placeholder", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "A pint of Guinness?",
      },
      {
        role: "agent",
        message: "...",
      },
      {
        role: "user",
        message: "We don't have Guinness on tap. We only have it in cans.",
      },
      {
        role: "agent",
        message: "Thanks, bye.",
      },
    ]);

    expect(result).toBe("A pint of Guinness?. We don't have Guinness on tap. We only have it in cans.");
  });

  it("returns the latest answer after a later repeated Guinness question", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "We'll get back to you as soon as possible.",
      },
      {
        role: "agent",
        message: "Thanks, goodbye.",
      },
      {
        role: "user",
        message: "Hello, Sadie from Cross Keys Hotel. How can I help?",
      },
      {
        role: "agent",
        message: "Hi Sadie, I was just wondering how much a pint of Guinness is there?",
      },
      {
        role: "user",
        message: "Uh, $16.40.",
      },
      {
        role: "agent",
        message: "Thanks, goodbye.",
      },
    ]);

    expect(result).toBe("Uh, $16.40.");
  });

  it("keeps listening after an early goodbye if the user comes back with the price", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "I'll just double-check. Hold on, give me one second.",
      },
      {
        role: "agent",
        message: "Thanks.",
      },
      {
        role: "user",
        message: "...",
      },
      {
        role: "agent",
        message: "Thanks, goodbye.",
      },
      {
        role: "user",
        message: "It's 17, but we have a 10% surcharge on Sundays.",
      },
      {
        role: "agent",
        message: "Thanks, goodbye.",
      },
    ]);

    expect(result).toBe("I'll just double-check. Hold on, give me one second.. .... It's 17, but we have a 10% surcharge on Sundays.");
  });

  it("prefers the stronger unavailable sequence over a later bare no", () => {
    const result = extractBeerContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "Uh, we don't do tap on Guinness, we only do cans.",
      },
      {
        role: "agent",
        message: "Do you have a pint price for Guinness at all?",
      },
      {
        role: "user",
        message: "Uh, no.",
      },
      {
        role: "agent",
        message: "Thanks, bye.",
      },
    ]);

    expect(result).toBe("Uh, we don't do tap on Guinness, we only do cans.");
  });

  it("pulls the user answer after the agent happy hour question", () => {
    const result = extractHappyHourContextText([
      {
        role: "agent",
        message: "Hey mate, quick one, how much is a pint of Guinness there?",
      },
      {
        role: "user",
        message: "Guinness is 12.",
      },
      {
        role: "agent",
        message:
          "And do you have any happy hour deals at the moment? If so, what times and what are the prices during that?",
      },
      {
        role: "user",
        message: "Yeah weekdays 4-6pm and they're $7.",
      },
      {
        role: "agent",
        message: "Perfect, thanks.",
      },
    ]);

    expect(result).toBe("Yeah weekdays 4-6pm and they're $7.");
  });
});

describe("summariseParseOutcome", () => {
  it("marks complete high-confidence beer-only parses as parsed", () => {
    const beerPrices = parseBeerPrices("Guinness is $12.");
    const summary = summariseParseOutcome(beerPrices, null, 0.72);

    expect(summary).toEqual({
      parseConfidence: expect.any(Number),
      parseStatus: "parsed",
      needsReview: false,
    });
    expect(summary.parseConfidence).toBeGreaterThan(0.72);
  });

  it("marks unavailable Guinness answers as parsed", () => {
    const beerPrices = parseBeerPrices("We don't have Guinness on tap here, unfortunately.", {
      assumeBeerContext: true,
    });
    const summary = summariseParseOutcome(beerPrices, null, 0.72);

    expect(summary).toEqual({
      parseConfidence: expect.any(Number),
      parseStatus: "parsed",
      needsReview: false,
    });
  });

  it("marks missing beer-only extractions as failed", () => {
    const beerPrices = parseBeerPrices("Not sure on Guinness.");
    const summary = summariseParseOutcome(beerPrices, null, 0.72);

    expect(summary).toEqual({
      parseConfidence: expect.any(Number),
      parseStatus: "failed",
      needsReview: true,
    });
  });
});
