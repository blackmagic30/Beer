import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import type { AdminIngestionStatus } from "../src/db/models.js";
import { AdminService } from "../src/modules/admin/admin.service.js";

let database: BetterSqlite3.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

function createRepository(): AdminIngestionQueueRepository {
  database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  return new AdminIngestionQueueRepository(database);
}

function queueSource(repository: AdminIngestionQueueRepository, index: number, status: AdminIngestionStatus = "pending_review") {
  const item = repository.create({
    venueId: `venue-${index}`,
    venueName: `Venue ${index}`,
    sourceType: "source_reference",
    sourceUrl: `https://example.com/menu-${index}`,
    imageDataUrl: null,
    note: null,
    status,
    venueNameGuess: null,
    capturedNotes: null,
    overallConfidence: 0.9,
    extractedBeers: [
      {
        name: `Beer ${index}`,
        servingSize: "pint",
        priceNumeric: 12 + index,
        priceText: `$${12 + index}`,
        availabilityStatus: "on_tap",
        availableOnTap: true,
        availablePackageOnly: false,
        unavailableReason: null,
        confidence: 0.9,
        needsReview: false,
        notes: null,
      },
    ],
    errorMessage: null,
  });
  const timestamp = `2026-06-30T00:${String(index).padStart(2, "0")}:00.000Z`;
  database
    ?.prepare("UPDATE admin_ingestion_queue SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(timestamp, timestamp, item.id);
  return item;
}

function attachFakeSupabase(
  service: AdminService,
  venueId: string,
  options: { menuCaptureError?: { message: string; code: string } } = {},
) {
  const insertedCaptures: unknown[] = [];
  const venue = {
    id: venueId,
    name: "Venue 1",
    address: "1 Test St",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
    phone: null,
    website: null,
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

  return { insertedCaptures };
}

describe("AdminIngestionQueueRepository", () => {
  it("returns paged ingestion rows with accurate status counts", () => {
    const repository = createRepository();
    for (let index = 0; index < 15; index += 1) {
      queueSource(repository, index);
    }
    queueSource(repository, 99, "rejected");

    expect(repository.count("pending_review")).toBe(15);
    expect(repository.count("rejected")).toBe(1);
    expect(repository.count()).toBe(16);

    expect(repository.list("pending_review", 5, 0).map((item) => item.venueName)).toEqual([
      "Venue 14",
      "Venue 13",
      "Venue 12",
      "Venue 11",
      "Venue 10",
    ]);
    expect(repository.list("pending_review", 5, 5).map((item) => item.venueName)).toEqual([
      "Venue 9",
      "Venue 8",
      "Venue 7",
      "Venue 6",
      "Venue 5",
    ]);
  });

  it("publishes approved source ingestion rows to live map records and removes them from pending review", async () => {
    const repository = createRepository();
    const businessRepository = new BusinessRepository(database!);
    const queueItem = queueSource(repository, 1);
    const service = new AdminService(
      repository,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      undefined,
      database!,
    );
    const { insertedCaptures } = attachFakeSupabase(service, queueItem.venueId);

    const result = await service.publishQueuedIngestion(queueItem.id, {
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
      note: "Verified against source image.",
    });

    expect(result.queueItem.status).toBe("published");
    expect(result.beerCount).toBe(1);
    expect(result.mapPriceRecordCount).toBe(1);
    expect(insertedCaptures).toHaveLength(1);
    expect(repository.getById(queueItem.id)).toEqual(expect.objectContaining({
      status: "published",
      publishedAt: expect.any(String),
    }));
    expect(repository.count("pending_review")).toBe(0);
    expect(repository.list("pending_review", 10, 0).map((item) => item.id)).not.toContain(queueItem.id);
    expect(repository.list("published", 10, 0).map((item) => item.id)).toContain(queueItem.id);

    expect(businessRepository.listLatestPriceRecords(10, queueItem.venueId)).toEqual([
      expect.objectContaining({
        id: `source-ingestion:${queueItem.id}:0`,
        venueId: queueItem.venueId,
        venueName: "Venue 1",
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 13.5,
        isOnTap: "yes",
        confidence: "photo_verified",
        sourceType: "source_ingestion",
        sourceSubmissionId: null,
      }),
    ]);
  });

  it("publishes source ingestion rows locally when capture history table is unavailable", async () => {
    const repository = createRepository();
    const businessRepository = new BusinessRepository(database!);
    const queueItem = queueSource(repository, 1);
    const service = new AdminService(
      repository,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      undefined,
      database!,
    );
    const { insertedCaptures } = attachFakeSupabase(service, queueItem.venueId, {
      menuCaptureError: {
        message: "Could not find the table 'public.venue_menu_captures' in the schema cache",
        code: "PGRST205",
      },
    });

    const result = await service.publishQueuedIngestion(queueItem.id, {
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
      note: "Verified against source image.",
    });

    expect(result.queueItem.status).toBe("published");
    expect(result.mapPriceRecordCount).toBe(1);
    expect(result.captureSaved).toBe(false);
    expect(result.captureWarning).toContain("live map rows were still published");
    expect(insertedCaptures).toHaveLength(0);
    expect(repository.count("pending_review")).toBe(0);
    expect(businessRepository.listLatestPriceRecords(10, queueItem.venueId)).toEqual([
      expect.objectContaining({
        id: `source-ingestion:${queueItem.id}:0`,
        venueName: "Venue 1",
        beerName: "Carlton Draught",
        price: 13.5,
        isOnTap: "yes",
      }),
    ]);
  });

  it("keeps source ingestion pending when priced rows cannot be written to the live map", async () => {
    const repository = createRepository();
    const queueItem = queueSource(repository, 1);
    const service = new AdminService(
      repository,
      undefined,
      undefined,
      "venue_menu_captures",
    );
    attachFakeSupabase(service, queueItem.venueId);

    await expect(service.publishQueuedIngestion(queueItem.id, {
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
      note: "Verified against source image.",
    })).rejects.toThrow("Live map price database is unavailable");

    expect(repository.getById(queueItem.id)).toEqual(expect.objectContaining({
      status: "pending_review",
      publishedAt: null,
      reviewBeers: null,
    }));
    expect(repository.count("pending_review")).toBe(1);
  });
});
