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

        const saveCapture = async (row: unknown) => {
          const evidenceReference = (row as { evidence_reference?: unknown }).evidence_reference;
          const existingIndex = insertedCaptures.findIndex(
            (capture) =>
              (capture as { evidence_reference?: unknown }).evidence_reference === evidenceReference,
          );
          if (existingIndex >= 0) {
            insertedCaptures[existingIndex] = row;
          } else {
            insertedCaptures.push(row);
          }
          return { error: null };
        };
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          upsert: saveCapture,
          insert: saveCapture,
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

  it("prevalidates bulk rejection so a conflicting row leaves every other row untouched", () => {
    const repository = createRepository();
    const pending = queueSource(repository, 1);
    const alreadyRejected = queueSource(repository, 2);
    const service = new AdminService(repository);
    service.rejectQueuedIngestion(alreadyRejected.id, { note: "Already reviewed." });

    expect(() => service.rejectQueuedIngestions({
      ids: [pending.id, alreadyRejected.id],
      note: "Must be all or nothing.",
    })).toThrow("Every bulk-rejected source must still be pending");
    expect(repository.getById(pending.id)?.status).toBe("pending_review");
    expect(repository.getById(alreadyRejected.id)?.status).toBe("rejected");
  });

  it("recovers expired review claims on startup but preserves fresh claims", () => {
    const repository = createRepository();
    const stale = queueSource(repository, 1);
    const fresh = queueSource(repository, 2);
    database!.prepare(
      `UPDATE admin_ingestion_queue
       SET status = 'publishing', review_claim_token = 'stale-token',
           review_claimed_at = '2026-01-01T00:00:00.000Z'
       WHERE id = ?`,
    ).run(stale.id);
    database!.prepare(
      `UPDATE admin_ingestion_queue
       SET status = 'publishing', review_claim_token = 'fresh-token',
           review_claimed_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), fresh.id);

    new AdminService(repository);

    expect(repository.getById(stale.id)).toEqual(expect.objectContaining({
      status: "pending_review",
      errorMessage: expect.stringContaining("stale review claim"),
    }));
    expect(repository.getById(fresh.id)?.status).toBe("publishing");
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

    expect(repository.claimPendingReview(
      published.id,
      "publish",
      "test-publish-claim",
      "2026-06-30T00:00:00.000Z",
    )).toBe(true);
    repository.markPublished(
      published.id,
      "test-publish-claim",
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

  it("keeps image bytes out of queue pages and serves one bounded item on demand", () => {
    const repository = createRepository();
    const item = repository.create({
      venueId: "venue-lazy-image",
      venueName: "Lazy Image Venue",
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
    const service = new AdminService(repository);

    const page = repository.list("pending_review", 12, 0);
    expect(page[0]).toEqual(expect.objectContaining({
      id: item.id,
      imageDataUrl: null,
      hasImageData: true,
    }));
    expect(JSON.stringify(page)).not.toContain(JPEG_DATA_URL);
    expect(service.getQueuedIngestionEvidence(item.id)).toEqual({
      mimeType: "image/jpeg",
      bytes: Buffer.from(JPEG_DATA_URL.split(",")[1]!, "base64"),
    });

    const oversized = `data:image/jpeg;base64,${Buffer.alloc((6 * 1024 * 1024) + 1).toString("base64")}`;
    database!.prepare("UPDATE admin_ingestion_queue SET image_data_url = ? WHERE id = ?")
      .run(oversized, item.id);
    expect(() => service.getQueuedIngestionEvidence(item.id)).toThrow("6MB or smaller");
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
        confidence: "admin_verified",
        sourceType: "source_ingestion",
        sourceSubmissionId: null,
        hasSourceLinkage: true,
        hasSourceEvidence: true,
      }),
    ]);
    expect(database!.prepare(
      `SELECT source_ingestion_id, source_evidence_reference, source_evidence_verified_at
       FROM venue_price_records
       WHERE id = ?`,
    ).get(`source-ingestion:${queueItem.id}:0`)).toEqual({
      source_ingestion_id: queueItem.id,
      source_evidence_reference: `source-ingestion:${queueItem.id}`,
      source_evidence_verified_at: expect.any(String),
    });
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

  it("keeps source ingestion pending without local rows when capture history is unavailable", async () => {
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
    })).rejects.toThrow("no live venue data was published");

    expect(insertedCaptures).toHaveLength(0);
    expect(repository.count("pending_review")).toBe(1);
    expect(repository.getById(queueItem.id)?.status).toBe("pending_review");
    expect(businessRepository.listLatestPriceRecords(10, queueItem.venueId)).toEqual([]);
    expect(businessRepository.listBarBeers(queueItem.venueId)).toEqual([]);
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

  it("allows only one publisher to claim a review and blocks a concurrent reject", async () => {
    const repository = createRepository();
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
    attachFakeSupabase(service, queueItem.venueId);
    const input = {
      beers: [{
        name: "Carlton Draught",
        servingSize: "pint" as const,
        priceNumeric: 13.5,
        priceText: "$13.50",
        availabilityStatus: "on_tap" as const,
        availableOnTap: true,
        availablePackageOnly: false,
        unavailableReason: null,
        needsReview: false,
      }],
      note: "Race-safe publish.",
    };

    const firstPublish = service.publishQueuedIngestion(queueItem.id, input);
    expect(repository.getById(queueItem.id)?.status).toBe("publishing");
    expect(() => service.rejectQueuedIngestion(queueItem.id, { note: "Losing reject." }))
      .toThrow("no longer pending review");
    await expect(service.publishQueuedIngestion(queueItem.id, input))
      .rejects.toThrow("no longer pending review");
    await expect(firstPublish).resolves.toEqual(expect.objectContaining({
      queueItem: expect.objectContaining({ status: "published" }),
    }));

    expect(database!.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE id LIKE ?",
    ).get(`source-ingestion:${queueItem.id}:%`)).toEqual({ count: 1 });
    expect(repository.getById(queueItem.id)?.status).toBe("published");
  });

  it("keeps an idempotent private snapshot but rolls back all local rows when publishing fails", async () => {
    const repository = createRepository();
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
    const serviceInternals = service as unknown as {
      publishIngestionPriceRecords: (...args: unknown[]) => number;
    };
    const publishRows = serviceInternals.publishIngestionPriceRecords.bind(service);
    serviceInternals.publishIngestionPriceRecords = () => {
      throw new Error("forced local publish failure");
    };
    const input = {
      beers: [{
        name: "Rollback Test Pale Ale",
        servingSize: "pint" as const,
        priceNumeric: 15,
        priceText: "$15",
        availabilityStatus: "on_tap" as const,
        availableOnTap: true,
        availablePackageOnly: false,
        unavailableReason: null,
        needsReview: false,
      }],
      note: "Failure ordering test.",
    };

    await expect(service.publishQueuedIngestion(queueItem.id, input))
      .rejects.toThrow("forced local publish failure");
    expect(repository.getById(queueItem.id)?.status).toBe("pending_review");
    expect(database!.prepare("SELECT count(*) AS count FROM beer_catalog_items WHERE name = ?")
      .get("Rollback Test Pale Ale")).toEqual({ count: 0 });
    expect(insertedCaptures).toHaveLength(1);
    expect(database!.prepare("SELECT count(*) AS count FROM venue_price_records WHERE venue_id = ?")
      .get(queueItem.venueId)).toEqual({ count: 0 });

    serviceInternals.publishIngestionPriceRecords = publishRows;
    await expect(service.publishQueuedIngestion(queueItem.id, input)).resolves.toEqual(
      expect.objectContaining({ captureSaved: true }),
    );
    expect(insertedCaptures).toHaveLength(1);
    expect(database!.prepare("SELECT count(*) AS count FROM beer_catalog_items WHERE name = ?")
      .get("Rollback Test Pale Ale")).toEqual({ count: 1 });
  });

  it("releases a rejection claim if finalization fails", () => {
    const repository = createRepository();
    const queueItem = queueSource(repository, 1);
    const service = new AdminService(repository);
    const original = repository.markRejected.bind(repository);
    repository.markRejected = (() => {
      throw new Error("forced rejection failure");
    }) as typeof repository.markRejected;

    expect(() => service.rejectQueuedIngestion(queueItem.id, { note: "Failure test." }))
      .toThrow("forced rejection failure");
    expect(repository.getById(queueItem.id)?.status).toBe("pending_review");
    repository.markRejected = original;
  });

  it("atomically replaces every live row owned by an ingestion on a shorter retry", async () => {
    const repository = createRepository();
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
    attachFakeSupabase(service, queueItem.venueId);
    const beer = (name: string, price: number) => ({
      name,
      servingSize: "pint" as const,
      priceNumeric: price,
      priceText: `$${price}`,
      availabilityStatus: "on_tap" as const,
      availableOnTap: true,
      availablePackageOnly: false,
      unavailableReason: null,
      needsReview: false,
    });

    await service.publishQueuedIngestion(queueItem.id, {
      beers: [beer("Carlton Draught", 13), beer("Victoria Bitter", 14)],
      note: "First attempt.",
    });
    database!.prepare(
      `UPDATE admin_ingestion_queue
       SET status = 'pending_review', published_at = NULL,
           review_claim_token = NULL, review_claimed_at = NULL
       WHERE id = ?`,
    ).run(queueItem.id);

    await service.publishQueuedIngestion(queueItem.id, {
      beers: [beer("Carlton Draught", 12)],
      note: "Corrected shorter retry.",
    });

    expect(database!.prepare(
      "SELECT id, price FROM venue_price_records WHERE id LIKE ? ORDER BY id",
    ).all(`source-ingestion:${queueItem.id}:%`)).toEqual([
      { id: `source-ingestion:${queueItem.id}:0`, price: 12 },
    ]);
    expect(database!.prepare(
      "SELECT beer_name FROM venue_beers WHERE source_ingestion_id = ? ORDER BY beer_name",
    ).all(queueItem.id)).toEqual([{ beer_name: "Carlton Draught" }]);
  });

  it("hard-caps stale pending review image bytes while preserving review metadata", () => {
    const repository = createRepository();
    const staleIds: string[] = [];
    for (let index = 0; index < 125; index += 1) {
      const item = repository.create({
        venueId: `stale-venue-${index}`,
        venueName: `Stale Venue ${index}`,
        sourceType: "menu_photo_upload",
        sourceUrl: `https://example.com/stale-${index}.jpg`,
        imageDataUrl: JPEG_DATA_URL,
        note: "Review metadata must survive.",
        status: "pending_review",
        venueNameGuess: "Stale venue guess",
        capturedNotes: "OCR notes",
        overallConfidence: 0.8,
        extractedBeers: [],
        errorMessage: null,
      });
      staleIds.push(item.id);
    }
    const held = repository.create({
      venueId: "held-venue",
      venueName: "Held Venue",
      sourceType: "menu_photo_upload",
      sourceUrl: "https://example.com/held.jpg",
      imageDataUrl: JPEG_DATA_URL,
      imageRetentionExpiresAt: "2026-06-01T00:00:00.000Z",
      note: null,
      status: "pending_review",
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: 0.7,
      extractedBeers: [],
      errorMessage: null,
    });
    database!.prepare(
      `UPDATE admin_ingestion_queue
       SET created_at = '2025-12-01T00:00:00.000Z',
           image_retention_expires_at = '2026-03-01T00:00:00.000Z'
       WHERE id IN (${staleIds.map(() => "?").join(",")})`,
    ).run(...staleIds);
    database!.prepare(
      "UPDATE admin_ingestion_queue SET created_at = '2026-03-01T00:00:00.000Z' WHERE id = ?",
    ).run(held.id);

    const result = serviceForRetention(repository).purgeQueuedIngestionImages("2026-07-14T00:00:00.000Z");

    expect(result).toEqual(expect.objectContaining({
      purged: 125,
      heldForOpenReview: 1,
      pastHardCap: 125,
    }));
    expect(repository.getById(staleIds[0]!)).toEqual(expect.objectContaining({
      imageDataUrl: null,
      imageRedactionReason: "open_review_hard_cap",
      sourceUrl: "https://example.com/stale-0.jpg",
      capturedNotes: "OCR notes",
      status: "pending_review",
    }));
    expect(repository.getById(held.id)?.imageDataUrl).toBe(JPEG_DATA_URL);
    expect(result.retainedCharacters).toBe(JPEG_DATA_URL.length);
  });
});

function serviceForRetention(repository: AdminIngestionQueueRepository): AdminService {
  return new AdminService(repository);
}
