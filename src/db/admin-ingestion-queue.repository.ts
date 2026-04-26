import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import type {
  AdminIngestionBeerRecord,
  AdminIngestionQueueRecord,
  AdminIngestionSourceType,
  AdminIngestionStatus,
} from "./models.js";

interface RawAdminIngestionQueueRecord {
  id: string;
  venueId: string;
  venueName: string;
  sourceType: AdminIngestionSourceType;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  extractedBeersJson: string;
  reviewBeersJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  rejectedAt: string | null;
}

interface CreateAdminIngestionInput {
  venueId: string;
  venueName: string;
  sourceType: AdminIngestionSourceType;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  extractedBeers: AdminIngestionBeerRecord[];
  errorMessage: string | null;
}

function parseBeerRecords(value: string | null): AdminIngestionBeerRecord[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as AdminIngestionBeerRecord[]) : null;
  } catch {
    return null;
  }
}

export class AdminIngestionQueueRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: CreateAdminIngestionInput): AdminIngestionQueueRecord {
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO admin_ingestion_queue (
          id,
          venue_id,
          venue_name,
          source_type,
          source_url,
          image_data_url,
          note,
          status,
          venue_name_guess,
          captured_notes,
          overall_confidence,
          extracted_beers_json,
          error_message,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @venueId,
          @venueName,
          @sourceType,
          @sourceUrl,
          @imageDataUrl,
          @note,
          @status,
          @venueNameGuess,
          @capturedNotes,
          @overallConfidence,
          @extractedBeersJson,
          @errorMessage,
          @createdAt,
          @updatedAt
        )`,
      )
      .run({
        id,
        venueId: input.venueId,
        venueName: input.venueName,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        imageDataUrl: input.imageDataUrl,
        note: input.note,
        status: input.status,
        venueNameGuess: input.venueNameGuess,
        capturedNotes: input.capturedNotes,
        overallConfidence: input.overallConfidence,
        extractedBeersJson: JSON.stringify(input.extractedBeers),
        errorMessage: input.errorMessage,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

    return this.getById(id)!;
  }

  getById(id: string): AdminIngestionQueueRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          venue_id AS venueId,
          venue_name AS venueName,
          source_type AS sourceType,
          source_url AS sourceUrl,
          image_data_url AS imageDataUrl,
          note,
          status,
          venue_name_guess AS venueNameGuess,
          captured_notes AS capturedNotes,
          overall_confidence AS overallConfidence,
          extracted_beers_json AS extractedBeersJson,
          review_beers_json AS reviewBeersJson,
          error_message AS errorMessage,
          created_at AS createdAt,
          updated_at AS updatedAt,
          published_at AS publishedAt,
          rejected_at AS rejectedAt
         FROM admin_ingestion_queue
         WHERE id = ?`,
      )
      .get(id) as RawAdminIngestionQueueRecord | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  list(status?: AdminIngestionStatus, limit = 50): AdminIngestionQueueRecord[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT
                id,
                venue_id AS venueId,
                venue_name AS venueName,
                source_type AS sourceType,
                source_url AS sourceUrl,
                image_data_url AS imageDataUrl,
                note,
                status,
                venue_name_guess AS venueNameGuess,
                captured_notes AS capturedNotes,
                overall_confidence AS overallConfidence,
                extracted_beers_json AS extractedBeersJson,
                review_beers_json AS reviewBeersJson,
                error_message AS errorMessage,
                created_at AS createdAt,
                updated_at AS updatedAt,
                published_at AS publishedAt,
                rejected_at AS rejectedAt
               FROM admin_ingestion_queue
               WHERE status = ?
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(status, limit)
        : this.db
            .prepare(
              `SELECT
                id,
                venue_id AS venueId,
                venue_name AS venueName,
                source_type AS sourceType,
                source_url AS sourceUrl,
                image_data_url AS imageDataUrl,
                note,
                status,
                venue_name_guess AS venueNameGuess,
                captured_notes AS capturedNotes,
                overall_confidence AS overallConfidence,
                extracted_beers_json AS extractedBeersJson,
                review_beers_json AS reviewBeersJson,
                error_message AS errorMessage,
                created_at AS createdAt,
                updated_at AS updatedAt,
                published_at AS publishedAt,
                rejected_at AS rejectedAt
               FROM admin_ingestion_queue
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(limit)
    ) as RawAdminIngestionQueueRecord[];

    return rows.map((row) => this.mapRow(row));
  }

  markPublished(id: string, reviewBeers: AdminIngestionBeerRecord[], updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE admin_ingestion_queue
         SET status = 'published',
             review_beers_json = @reviewBeersJson,
             updated_at = @updatedAt,
             published_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        reviewBeersJson: JSON.stringify(reviewBeers),
        updatedAt,
      });
  }

  markRejected(id: string, note: string | null, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE admin_ingestion_queue
         SET status = 'rejected',
             note = COALESCE(@note, note),
             updated_at = @updatedAt,
             rejected_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        note,
        updatedAt,
      });
  }

  private mapRow(row: RawAdminIngestionQueueRecord): AdminIngestionQueueRecord {
    return {
      id: row.id,
      venueId: row.venueId,
      venueName: row.venueName,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      imageDataUrl: row.imageDataUrl,
      note: row.note,
      status: row.status,
      venueNameGuess: row.venueNameGuess,
      capturedNotes: row.capturedNotes,
      overallConfidence: row.overallConfidence,
      extractedBeers: parseBeerRecords(row.extractedBeersJson) ?? [],
      reviewBeers: parseBeerRecords(row.reviewBeersJson),
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      rejectedAt: row.rejectedAt,
    };
  }
}
