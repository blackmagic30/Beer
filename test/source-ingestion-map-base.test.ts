import { describe, expect, it } from "vitest";

import type { AdminIngestionQueueRecord } from "../src/db/models.js";
import {
  isLikelyBaselineMenuSource,
  selectPublishableMapBaseRows,
} from "../scripts/publish-source-ingestion-map-base.js";

function queueItem(overrides: Partial<AdminIngestionQueueRecord> = {}): AdminIngestionQueueRecord {
  return {
    id: "queue-1",
    venueId: "11111111-1111-4111-8111-111111111111",
    venueName: "Test Venue",
    sourceType: "source_reference",
    sourceUrl: "https://example.com/drinks-menu.pdf",
    imageDataUrl: null,
    note: "Crawler import for admin review only.",
    status: "pending_review",
    venueNameGuess: "Test Venue",
    capturedNotes: "Source: https://example.com/drinks-menu.pdf",
    overallConfidence: 0.88,
    extractedBeers: [
      {
        name: "Carlton Draught",
        servingSize: "pint",
        priceNumeric: 13.5,
        priceText: "$13.50 pint",
        availabilityStatus: "on_tap",
        availableOnTap: true,
        availablePackageOnly: false,
        unavailableReason: null,
        confidence: 0.9,
        needsReview: true,
        notes: null,
      },
    ],
    reviewBeers: null,
    crawlerFeedback: null,
    errorMessage: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    publishedAt: null,
    rejectedAt: null,
    ...overrides,
  };
}

describe("source ingestion map-base publisher selection", () => {
  it("accepts regular menu sources with clear on-tap pint prices", () => {
    const selected = selectPublishableMapBaseRows(queueItem());

    expect(selected.reasons).toEqual([]);
    expect(selected.beers).toEqual([
      expect.objectContaining({
        name: "Carlton Draught",
        priceNumeric: 13.5,
        availabilityStatus: "on_tap",
        availableOnTap: true,
        needsReview: false,
      }),
    ]);
  });

  it("rejects happy-hour and event sources unless explicitly allowed", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/drinks-menu",
      capturedNotes: "Discovery: homepage_link; happy hour page",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
    expect(isLikelyBaselineMenuSource(item, { allowHomepage: false, allowSpecialSources: true })).toBe(true);
  });

  it("does not accept generic images only because captured notes mention menu candidates", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/wp-content/uploads/logo.png",
      capturedNotes: "Menu source candidate. Text extraction is best-effort; review source before using any prices.",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
  });

  it("does not auto-publish direct raster menu image assets", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/wp-content/uploads/2026/07/drinks-menu-1024x1024.png",
      capturedNotes: "Menu source candidate. Text extraction is best-effort; review source before using any prices.",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
  });

  it("drops ambiguous duplicate prices for the same beer", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 11,
          priceText: "$11",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 14,
          priceText: "$14",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.beers).toEqual([]);
    expect(selected.reasons).toContain("ambiguous_duplicate_prices");
  });

  it("drops non-beer tap drinks while preserving valid beer rows", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 14,
          priceText: "$14 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Bulmers Original Cider",
          servingSize: "pint",
          priceNumeric: 15,
          priceText: "$15 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Brookvale Union Whisky & Dry",
          servingSize: "pint",
          priceNumeric: 18,
          priceText: "$18 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.reasons).toEqual([]);
    expect(selected.beers).toEqual([
      expect.objectContaining({
        name: "Carlton Draught",
        priceNumeric: 14,
      }),
    ]);
  });

  it("rejects package-only, low-confidence, and special-price-looking rows", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Guinness",
          servingSize: "pint",
          priceNumeric: 7,
          priceText: "$7",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Stone & Wood Pacific Ale",
          servingSize: "pint",
          priceNumeric: 16,
          priceText: "$16",
          availabilityStatus: "package_only",
          availableOnTap: false,
          availablePackageOnly: true,
          unavailableReason: "cans_or_bottles",
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Balter XPA",
          servingSize: "pint",
          priceNumeric: 15,
          priceText: "$15",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.7,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.beers).toEqual([]);
    expect(selected.reasons).toContain("no_usable_on_tap_pint_rows");
  });
});
