import { describe, expect, it } from "vitest";

import { buildSupabaseCallResultRow } from "../src/lib/supabase-results-sync.js";

describe("buildSupabaseCallResultRow", () => {
  it("builds a Supabase-ready payload with venue linkage and cleaned beer keys", () => {
    const row = buildSupabaseCallResultRow({
      run: {
        id: "run-1",
        callSid: "CA123",
        conversationId: "conv-1",
        venueId: "27b97227-2735-4a9c-ad7c-d1047f3f225e",
        requestedBeer: "carlton_draft",
        venueName: "The Duke of Wellington",
        phoneNumber: "+61398100066",
        suburb: "Melbourne",
        startedAt: "2026-04-13T10:00:00.000Z",
        endedAt: "2026-04-13T10:03:00.000Z",
        durationSeconds: 180,
        callStatus: "completed",
        rawTranscript: null,
        parseConfidence: 0.91,
        parseStatus: "parsed",
        errorMessage: null,
        isTest: false,
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:03:00.000Z",
      },
      callSid: "CA123",
      conversationId: "conv-1",
      resultTimestamp: "2026-04-13T10:00:00.000Z",
      savedAt: "2026-04-13T10:03:05.000Z",
      rawTranscript: "USER: Carlton Draft is 12. Asahi is 14. Furphy is 13.",
      parseConfidence: 0.91,
      parseStatus: "parsed",
      needsReview: false,
      items: [
        {
          beerName: "Carlton Draft",
          priceText: "$12",
          priceNumeric: 12,
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.94,
          needsReview: false,
        },
        {
          beerName: "Asahi",
          priceText: "$14",
          priceNumeric: 14,
          availabilityStatus: "package_only",
          availableOnTap: false,
          availablePackageOnly: true,
          unavailableReason: "cans_only",
          confidence: 0.93,
          needsReview: false,
        },
      ],
      happyHour: {
        happyHour: true,
        happyHourDays: "weekdays",
        happyHourStart: "16:00",
        happyHourEnd: "18:00",
        happyHourPrice: 7,
        happyHourConfidence: 0.88,
        happyHourSpecials: "$7 pints and half-price wings",
      },
    });

    expect(row).toEqual(
      expect.objectContaining({
        venue_id: "27b97227-2735-4a9c-ad7c-d1047f3f225e",
        venue_name: "The Duke of Wellington",
        suburb: "Melbourne",
      }),
    );
    expect(row.cleaned).toEqual(
      expect.objectContaining({
        beers: expect.objectContaining({
          carlton_draft: expect.objectContaining({
            label: "Carlton Draft",
            price: 12,
            availability_status: "on_tap",
            available_on_tap: true,
          }),
          asahi: expect.objectContaining({
            label: "Asahi",
            price: 14,
            availability_status: "package_only",
            available_package_only: true,
            availability: expect.objectContaining({
              label: "Cans only",
            }),
          }),
        }),
        menu_capture: expect.objectContaining({
          source: "phone_agent",
          completeness: "single_beer_probe",
          crowdsource_full_menu_planned: true,
        }),
        happy_hour: expect.objectContaining({
          exists: true,
          days: "weekdays",
          start: "16:00",
          end: "18:00",
          price: 7,
          specials: "$7 pints and half-price wings",
        }),
      }),
    );
    expect(row.raw).toEqual(
      expect.objectContaining({
        venue_id: "27b97227-2735-4a9c-ad7c-d1047f3f225e",
        parse_status: "parsed",
      }),
    );
  });
});
