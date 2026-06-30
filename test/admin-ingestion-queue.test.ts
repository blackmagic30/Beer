import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import type { AdminIngestionStatus } from "../src/db/models.js";

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
});
