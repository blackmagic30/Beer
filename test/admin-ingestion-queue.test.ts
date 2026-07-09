import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import type { AdminIngestionStatus } from "../src/db/models.js";
import { AdminService } from "../src/modules/admin/admin.service.js";

let database: BetterSqlite3.Database | null = null;
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]).toString("base64")}`;

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("bulk rejects pending source ingestion rows for quick admin cleanup", () => {
    const repository = createRepository();
    const first = queueSource(repository, 1);
    const second = queueSource(repository, 2);
    const service = new AdminService(repository);

    const result = service.rejectQueuedIngestions({
      ids: [first.id, second.id],
      note: "Fast rejected during admin source cleanup.",
    });

    expect(result.rejectedCount).toBe(2);
    expect(result.queueItems.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(repository.count("pending_review")).toBe(0);
    expect(repository.count("rejected")).toBe(2);
    expect(repository.getById(first.id)).toEqual(expect.objectContaining({
      status: "rejected",
      imageDataUrl: null,
      note: "Fast rejected during admin source cleanup.",
      rejectedAt: expect.any(String),
    }));
  });

  it("redacts completed source images while keeping pending review previews", () => {
    const repository = createRepository();
    const pending = repository.create({
      venueId: "venue-pending",
      venueName: "Pending Venue",
      sourceType: "menu_photo_upload",
      sourceUrl: null,
      imageDataUrl: JPEG_DATA_URL,
      note: null,
      status: "pending_review",
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: 0.9,
      extractedBeers: [],
      errorMessage: null,
    });
    const published = repository.create({
      venueId: "venue-published",
      venueName: "Published Venue",
      sourceType: "menu_photo_upload",
      sourceUrl: null,
      imageDataUrl: JPEG_DATA_URL,
      note: null,
      status: "pending_review",
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: 0.9,
      extractedBeers: [],
      errorMessage: null,
    });

    repository.markPublished(
      published.id,
      [],
      "Approved.",
      {
        outcome: "published",
        rewardScore: 1,
        acceptedRowCount: 0,
        extractedRowCount: 0,
        rejectedRowCount: 0,
        correctedRowCount: 0,
        cleanRowCount: 0,
        note: "Approved.",
        generatedAt: "2026-06-30T00:00:00.000Z",
        signals: [],
      },
      "2026-06-30T00:00:00.000Z",
    );

    expect(repository.getById(pending.id)?.imageDataUrl).toBe(JPEG_DATA_URL);
    expect(repository.getById(published.id)).toEqual(expect.objectContaining({
      status: "published",
      imageDataUrl: null,
    }));
  });

  it("redacts older completed source-review images during schema initialization", () => {
    const repository = createRepository();
    const item = repository.create({
      venueId: "venue-old-complete",
      venueName: "Old Complete Venue",
      sourceType: "menu_photo_upload",
      sourceUrl: null,
      imageDataUrl: JPEG_DATA_URL,
      note: null,
      status: "published",
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: 0.9,
      extractedBeers: [],
      errorMessage: null,
    });

    expect(repository.getById(item.id)?.imageDataUrl).toBe(JPEG_DATA_URL);
    initializeDatabaseSchema(database!);

    expect(repository.getById(item.id)?.imageDataUrl).toBeNull();
  });

  it("rejects unsafe admin source image URLs before fetch or OCR", async () => {
    const repository = createRepository();
    const service = new AdminService(repository);
    attachFakeSupabase(service, "venue-private-url");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.queueSourceIngestion({
      venueId: "venue-private-url",
      sourceType: "source_image_url",
      sourceUrl: "http://127.0.0.1:8080/menu.jpg",
      imageDataUrl: null,
      note: null,
    })).rejects.toThrow("local, private, or metadata network hosts");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized admin source images before OCR", async () => {
    const repository = createRepository();
    const service = new AdminService(repository);
    attachFakeSupabase(service, "venue-oversized-url");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(7 * 1024 * 1024),
      },
    })));

    await expect(service.queueSourceIngestion({
      venueId: "venue-oversized-url",
      sourceType: "source_image_url",
      sourceUrl: "https://93.184.216.34/menu.jpg",
      imageDataUrl: null,
      note: null,
    })).rejects.toThrow("6MB or smaller");
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
    expect(result.inventoryBeerCount).toBe(1);
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
    expect(businessRepository.listBarBeers(queueItem.venueId)).toEqual([
      expect.objectContaining({
        id: `admin-reviewed:${queueItem.venueId}:carlton-draft:pint`,
        barId: queueItem.venueId,
        beerName: "Carlton Draught",
        serveSize: "pint",
        price: 13.5,
        onTap: true,
        inStock: true,
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
    expect(result.inventoryBeerCount).toBe(1);
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
    expect(businessRepository.listBarBeers(queueItem.venueId)).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13.5,
        onTap: true,
        inStock: true,
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
