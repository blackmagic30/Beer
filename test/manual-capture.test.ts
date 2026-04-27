import { describe, expect, it } from "vitest";

import {
  buildManualBeerEntry,
  buildManualCallResultRow,
  extractBeerEntriesFromCleaned,
  toBeerKey,
} from "../src/modules/admin/manual-capture.js";

describe("manual capture helpers", () => {
  it("normalizes beer keys safely", () => {
    expect(toBeerKey("Stone & Wood")).toBe("stone_wood");
    expect(toBeerKey("Carlton   Draft")).toBe("carlton_draft");
  });

  it("extracts nested cleaned beer entries", () => {
    const entries = extractBeerEntriesFromCleaned({
      beers: {
        guinness: {
          label: "Guinness",
          serving_size: "pint",
          price_numeric: 14,
          price_text: "$14",
          availability_status: "on_tap",
          available_on_tap: true,
          available_package_only: false,
          unavailable_reason: null,
          confidence: 0.8,
          needs_review: false,
        },
      },
    });

    expect(entries.guinness).toEqual(
      expect.objectContaining({
        label: "Guinness",
        serving_size: "pint",
        price_numeric: 14,
        availability_status: "on_tap",
      }),
    );
  });

  it("merges new manual beers into the latest venue snapshot", () => {
    const row = buildManualCallResultRow({
      venue: {
        id: "venue-1",
        name: "The Duke of Wellington",
        suburb: "Melbourne",
      },
      latestResult: {
        raw: {
          venue_id: "venue-1",
        },
        cleaned: {
          beers: {
            guinness: buildManualBeerEntry({
              name: "Guinness",
              servingSize: "pint",
              priceNumeric: 14,
              priceText: "$14",
              availabilityStatus: "on_tap",
              availableOnTap: true,
              availablePackageOnly: false,
              unavailableReason: null,
              needsReview: false,
            }),
          },
        },
      },
      beers: [
        {
          name: "Carlton Draft",
          servingSize: "pint",
          priceNumeric: 12,
          priceText: "$12",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          needsReview: false,
        },
      ],
      source: "manual_entry",
      savedAt: "2026-04-22T10:00:00.000Z",
    });

    expect(row).toEqual(
      expect.objectContaining({
        venue_id: "venue-1",
        venue_name: "The Duke of Wellington",
        cleaned: expect.objectContaining({
          beers: expect.objectContaining({
            guinness: expect.objectContaining({
              label: "Guinness",
            }),
            carlton_draft: expect.objectContaining({
              label: "Carlton Draft",
              serving_size: "pint",
              price_numeric: 12,
              price_text: "$12 pint",
            }),
          }),
          menu_capture: expect.objectContaining({
            source: "manual_entry",
            known_items_count: 2,
          }),
        }),
      }),
    );
  });

  it("formats no-pints entries as a distinct unavailable outcome", () => {
    const entry = buildManualBeerEntry({
      name: "Carlton Draft",
      servingSize: "pint",
      priceNumeric: null,
      priceText: null,
      availabilityStatus: "unavailable",
      availableOnTap: true,
      availablePackageOnly: false,
      unavailableReason: "no_pints",
      needsReview: false,
    });

    expect(entry).toEqual(
      expect.objectContaining({
        price_text: "No pints",
        available_on_tap: true,
        unavailable_reason: "no_pints",
        availability: expect.objectContaining({
          label: "No pints",
        }),
      }),
    );
  });
});
