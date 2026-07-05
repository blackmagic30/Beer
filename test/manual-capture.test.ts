import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  buildManualBeerEntry,
  buildManualVenueCaptureRow,
  extractBeerEntriesFromCleaned,
  toBeerKey,
} from "../src/modules/admin/manual-capture.js";
import { AdminService, buildCrawlerFeedback } from "../src/modules/admin/admin.service.js";

let database: BetterSqlite3.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

function attachManualCaptureSupabase(
  service: AdminService,
  options: { menuCaptureError?: { message: string; code: string } } = {},
) {
  const insertedCaptures: unknown[] = [];
  const venue = {
    id: "venue-ocr-1",
    name: "OCR Arms",
    address: "1 OCR Lane",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
    phone: null,
    website: "https://example.com",
    latitude: -37.8136,
    longitude: 144.9631,
  };

  (service as unknown as { supabase: unknown }).supabase = {
    from(tableName: string) {
      if (tableName === "venues") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: venue, error: null }),
            }),
          }),
        };
      }

      if (tableName === "venue_menu_captures") {
        if (options.menuCaptureError) {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: null, error: options.menuCaptureError }),
                }),
              }),
            }),
            insert: async () => ({ error: options.menuCaptureError }),
          };
        }

        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          insert: async (row: unknown) => {
            insertedCaptures.push(row);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected Supabase table ${tableName}`);
    },
  };

  return { insertedCaptures, venue };
}

describe("manual capture helpers", () => {
  it("normalizes beer keys safely", () => {
    expect(toBeerKey("Stone & Wood")).toBe("stone_and_wood_pacific_ale");
    expect(toBeerKey("Carlton   Draft")).toBe("carlton_draft");
    expect(toBeerKey("Carlton Draught")).toBe("carlton_draft");
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
    const row = buildManualVenueCaptureRow({
      venue: {
        id: "venue-1",
        name: "The Duke of Wellington",
        suburb: "Melbourne",
      },
      latestCapture: {
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
          name: "Carlton Draught",
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
              label: "Carlton Draught",
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
      name: "Carlton Draught",
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

  it("reports standalone menu OCR as available when OpenAI is configured", () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
    );

    expect(service.getStatus()).toEqual({
      enabled: false,
      ocrEnabled: true,
      ocrReason: null,
      googlePlacesEnabled: false,
      googlePlacesReason: "missing_google_places_api_key",
      queueEnabled: false,
    });
  });

  it("publishes manual OCR capture rows to map records and venue inventory", async () => {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    const repository = new BusinessRepository(database);
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      undefined,
      database,
    );
    const { insertedCaptures, venue } = attachManualCaptureSupabase(service);

    const result = await service.saveManualCapture({
      venueId: venue.id,
      source: "menu_photo_ocr",
      note: "Admin checked OCR.",
      beers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 13.5,
          priceText: "$13.50",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          needsReview: false,
        },
      ],
    });

    expect(result.beerCount).toBe(1);
    expect(result.mapPriceRecordCount).toBe(1);
    expect(result.inventoryBeerCount).toBe(1);
    expect(result.captureSaved).toBe(true);
    expect(insertedCaptures).toHaveLength(1);
    expect(repository.listLatestPriceRecords(10, venue.id)).toEqual([
      expect.objectContaining({
        id: `admin-capture:${venue.id}:carlton-draft:pint`,
        venueId: venue.id,
        venueName: "OCR Arms",
        beerName: "Carlton Draught",
        price: 13.5,
        isOnTap: "yes",
        confidence: "photo_verified",
        sourceType: "menu_photo_ocr",
      }),
    ]);
    expect(repository.listBarBeers(venue.id)).toEqual([
      expect.objectContaining({
        id: `admin-reviewed:${venue.id}:carlton-draft:pint`,
        barId: venue.id,
        beerName: "Carlton Draught",
        price: 13.5,
        onTap: true,
        inStock: true,
      }),
    ]);
  });

  it("still publishes manual capture rows locally when capture history is unavailable", async () => {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    const repository = new BusinessRepository(database);
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      undefined,
      database,
    );
    const { insertedCaptures, venue } = attachManualCaptureSupabase(service, {
      menuCaptureError: {
        message: "Could not find the table 'public.venue_menu_captures' in the schema cache",
        code: "PGRST205",
      },
    });

    const result = await service.saveManualCapture({
      venueId: venue.id,
      source: "menu_photo_ocr",
      note: "Admin checked OCR.",
      beers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 13.5,
          priceText: "$13.50",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          needsReview: false,
        },
      ],
    });

    expect(result.mapPriceRecordCount).toBe(1);
    expect(result.inventoryBeerCount).toBe(1);
    expect(result.captureSaved).toBe(false);
    expect(result.captureWarning).toContain("live venue data was still published");
    expect(insertedCaptures).toHaveLength(0);
    expect(repository.listBarBeers(venue.id)).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13.5,
        onTap: true,
      }),
    ]);
  });

  it("turns source review decisions into crawler feedback scores", () => {
    const extractedBeer = {
      name: "Stomping Ground Pale Ale",
      servingSize: "pint" as const,
      priceNumeric: 13,
      priceText: "$13",
      availabilityStatus: "on_tap" as const,
      availableOnTap: true,
      availablePackageOnly: false,
      unavailableReason: null,
      confidence: 0.76,
      needsReview: true,
      notes: "OCR row",
    };
    const reviewedBeer = {
      name: "Stomping Ground Pale Ale",
      servingSize: "pint" as const,
      priceNumeric: 14,
      priceText: "$14",
      availabilityStatus: "on_tap" as const,
      availableOnTap: true,
      availablePackageOnly: false,
      unavailableReason: null,
      needsReview: false,
    };

    expect(buildCrawlerFeedback({
      outcome: "published",
      extractedBeers: [extractedBeer],
      reviewBeers: [reviewedBeer],
      note: "Corrected price",
      generatedAt: "2026-06-29T10:00:00.000Z",
    })).toEqual(expect.objectContaining({
      rewardScore: 85,
      acceptedRowCount: 1,
      extractedRowCount: 1,
      correctedRowCount: 1,
      cleanRowCount: 1,
      signals: expect.arrayContaining(["1/1 rows accepted", "1 manual correction"]),
    }));

    expect(buildCrawlerFeedback({
      outcome: "rejected",
      extractedBeers: [extractedBeer],
      note: "Wrong venue",
      generatedAt: "2026-06-29T10:05:00.000Z",
    })).toEqual(expect.objectContaining({
      rewardScore: -70,
      acceptedRowCount: 0,
      rejectedRowCount: 1,
      signals: expect.arrayContaining(["1 row rejected", "Reviewer note: Wrong venue"]),
    }));
  });
});
