import { randomUUID } from "node:crypto";

import type {
  AdminIngestionBeerRecord,
  AdminIngestionCrawlerFeedback,
  AdminIngestionQueueRecord,
  AdminIngestionSourceType,
  AdminIngestionStatus,
} from "./models.js";
import type { SqlDatabase } from "./sql-database.js";

interface RawAdminIngestionQueueRecord {
  id: string;
  venueId: string;
  venueName: string;
  sourceType: AdminIngestionSourceType;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  hasImageData: number;
  imageRetentionExpiresAt: string | null;
  imageRedactedAt: string | null;
  imageRedactionReason: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | string | null;
  extractedBeersJson: unknown;
  reviewBeersJson: unknown;
  crawlerFeedbackJson: unknown;
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
  imageRetentionExpiresAt?: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  extractedBeers: AdminIngestionBeerRecord[];
  errorMessage: string | null;
}

const DEFAULT_PENDING_IMAGE_RETENTION_DAYS = 90;

function defaultImageRetentionExpiry(createdAt: string): string {
  const expiry = new Date(createdAt);
  expiry.setUTCDate(expiry.getUTCDate() + DEFAULT_PENDING_IMAGE_RETENTION_DAYS);
  return expiry.toISOString();
}

function parseBeerRecords(value: unknown): AdminIngestionBeerRecord[] | null {
  if (Array.isArray(value)) {
    return value as AdminIngestionBeerRecord[];
  }
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as AdminIngestionBeerRecord[]) : null;
  } catch {
    return null;
  }
}

function parseCrawlerFeedback(value: unknown): AdminIngestionCrawlerFeedback | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AdminIngestionCrawlerFeedback;
  }
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AdminIngestionCrawlerFeedback;
  } catch {
    return null;
  }
}

export class AdminIngestionQueueRepository {
  constructor(private readonly db: SqlDatabase) {}

  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work)();
  }

  async create(input: CreateAdminIngestionInput): Promise<AdminIngestionQueueRecord> {
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    await this.db
      .prepare(
        `INSERT INTO admin_ingestion_queue (
          id,
          venue_id,
          venue_name,
          source_type,
          source_url,
          image_data_url,
          image_retention_expires_at,
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
          @imageRetentionExpiresAt,
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
        imageRetentionExpiresAt: input.imageDataUrl
          ? input.imageRetentionExpiresAt ?? defaultImageRetentionExpiry(timestamp)
          : null,
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

    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<AdminIngestionQueueRecord | undefined> {
    const row = await this.db
      .prepare(
        `SELECT
          id,
          venue_id AS "venueId",
          venue_name AS "venueName",
          source_type AS "sourceType",
          source_url AS "sourceUrl",
          image_data_url AS "imageDataUrl",
          CASE WHEN image_data_url IS NULL THEN 0 ELSE 1 END AS "hasImageData",
          image_retention_expires_at AS "imageRetentionExpiresAt",
          image_redacted_at AS "imageRedactedAt",
          image_redaction_reason AS "imageRedactionReason",
          note,
          status,
          venue_name_guess AS "venueNameGuess",
          captured_notes AS "capturedNotes",
          overall_confidence AS "overallConfidence",
          extracted_beers_json AS "extractedBeersJson",
          review_beers_json AS "reviewBeersJson",
          crawler_feedback_json AS "crawlerFeedbackJson",
          error_message AS "errorMessage",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          published_at AS "publishedAt",
          rejected_at AS "rejectedAt"
         FROM admin_ingestion_queue
         WHERE id = ?`,
      )
      .get<RawAdminIngestionQueueRecord>(id);

    return row ? this.mapRow(row) : undefined;
  }

  async list(
    status?: AdminIngestionStatus,
    limit = 50,
    offset = 0,
  ): Promise<AdminIngestionQueueRecord[]> {
    const rows = await (
      status
        ? this.db
            .prepare(
              `SELECT
                id,
                venue_id AS "venueId",
                venue_name AS "venueName",
                source_type AS "sourceType",
                source_url AS "sourceUrl",
                NULL AS "imageDataUrl",
                CASE WHEN image_data_url IS NULL THEN 0 ELSE 1 END AS "hasImageData",
                image_retention_expires_at AS "imageRetentionExpiresAt",
                image_redacted_at AS "imageRedactedAt",
                image_redaction_reason AS "imageRedactionReason",
                note,
                status,
                venue_name_guess AS "venueNameGuess",
                captured_notes AS "capturedNotes",
                overall_confidence AS "overallConfidence",
                extracted_beers_json AS "extractedBeersJson",
                review_beers_json AS "reviewBeersJson",
                crawler_feedback_json AS "crawlerFeedbackJson",
                error_message AS "errorMessage",
                created_at AS "createdAt",
                updated_at AS "updatedAt",
                published_at AS "publishedAt",
                rejected_at AS "rejectedAt"
               FROM admin_ingestion_queue
               WHERE status = ?
               ORDER BY created_at DESC
               LIMIT ?
               OFFSET ?`,
            )
            .all<RawAdminIngestionQueueRecord>(status, limit, offset)
        : this.db
            .prepare(
              `SELECT
                id,
                venue_id AS "venueId",
                venue_name AS "venueName",
                source_type AS "sourceType",
                source_url AS "sourceUrl",
                NULL AS "imageDataUrl",
                CASE WHEN image_data_url IS NULL THEN 0 ELSE 1 END AS "hasImageData",
                image_retention_expires_at AS "imageRetentionExpiresAt",
                image_redacted_at AS "imageRedactedAt",
                image_redaction_reason AS "imageRedactionReason",
                note,
                status,
                venue_name_guess AS "venueNameGuess",
                captured_notes AS "capturedNotes",
                overall_confidence AS "overallConfidence",
                extracted_beers_json AS "extractedBeersJson",
                review_beers_json AS "reviewBeersJson",
                crawler_feedback_json AS "crawlerFeedbackJson",
                error_message AS "errorMessage",
                created_at AS "createdAt",
                updated_at AS "updatedAt",
                published_at AS "publishedAt",
                rejected_at AS "rejectedAt"
               FROM admin_ingestion_queue
               ORDER BY created_at DESC
               LIMIT ?
               OFFSET ?`,
            )
            .all<RawAdminIngestionQueueRecord>(limit, offset)
    );

    return rows.map((row) => this.mapRow(row));
  }

  async count(status?: AdminIngestionStatus): Promise<number> {
    const row = await (
      status
        ? this.db
            .prepare("SELECT COUNT(*) AS total FROM admin_ingestion_queue WHERE status = ?")
            .get<{ total: number }>(status)
        : this.db.prepare("SELECT COUNT(*) AS total FROM admin_ingestion_queue").get<{ total: number }>()
    );

    return Number(row?.total || 0);
  }

  async recoverStaleReviewClaims(input: { staleBefore: string; now: string }): Promise<number> {
    return (await this.db.prepare(
      `UPDATE admin_ingestion_queue
       SET status = 'pending_review',
           review_claim_token = NULL,
           review_claimed_at = NULL,
           updated_at = @now,
           error_message = 'A stale review claim was recovered; review and retry.'
       WHERE status IN ('publishing', 'rejecting')
         AND (review_claimed_at IS NULL OR review_claimed_at <= @staleBefore)`,
    ).run(input)).changes;
  }

  async claimPendingReview(
    id: string,
    action: "publish" | "reject",
    claimToken: string,
    claimedAt: string,
    staleBefore?: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE admin_ingestion_queue
       SET status = @status,
           review_claim_token = @claimToken,
           review_claimed_at = @claimedAt,
           updated_at = @claimedAt
       WHERE id = @id
         AND (
           (status = 'pending_review' AND review_claim_token IS NULL)
           OR (
             status IN ('publishing', 'rejecting')
             AND (review_claimed_at IS NULL OR review_claimed_at <= @staleBefore)
           )
         )`,
    ).run({
      id,
      status: action === "publish" ? "publishing" : "rejecting",
      claimToken,
      claimedAt,
      staleBefore: staleBefore ?? claimedAt,
    });
    return result.changes === 1;
  }

  async releaseReviewClaim(id: string, claimToken: string, updatedAt: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE admin_ingestion_queue
       SET status = 'pending_review',
           review_claim_token = NULL,
           review_claimed_at = NULL,
           updated_at = @updatedAt
       WHERE id = @id
         AND status IN ('publishing', 'rejecting')
         AND review_claim_token = @claimToken`,
    ).run({ id, claimToken, updatedAt });
    return result.changes === 1;
  }

  async markPublished(
    id: string,
    claimToken: string,
    reviewBeers: AdminIngestionBeerRecord[],
    note: string | null,
    crawlerFeedback: AdminIngestionCrawlerFeedback,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE admin_ingestion_queue
         SET status = 'published',
             review_beers_json = @reviewBeersJson,
             crawler_feedback_json = @crawlerFeedbackJson,
             image_data_url = NULL,
             image_redacted_at = @updatedAt,
             image_redaction_reason = 'review_completed',
             review_claim_token = NULL,
             review_claimed_at = NULL,
             error_message = NULL,
             note = COALESCE(@note, note),
             updated_at = @updatedAt,
             published_at = @updatedAt
         WHERE id = @id
           AND status = 'publishing'
           AND review_claim_token = @claimToken`,
      )
      .run({
        id,
        claimToken,
        reviewBeersJson: JSON.stringify(reviewBeers),
        crawlerFeedbackJson: JSON.stringify(crawlerFeedback),
        note,
        updatedAt,
      });
    if (result.changes !== 1) {
      throw new Error("Source ingestion publish claim is no longer current");
    }
  }

  async markRejected(
    id: string,
    claimToken: string,
    note: string | null,
    crawlerFeedback: AdminIngestionCrawlerFeedback,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE admin_ingestion_queue
         SET status = 'rejected',
             image_data_url = NULL,
             image_redacted_at = @updatedAt,
             image_redaction_reason = 'review_completed',
             review_claim_token = NULL,
             review_claimed_at = NULL,
             error_message = NULL,
             note = COALESCE(@note, note),
             crawler_feedback_json = @crawlerFeedbackJson,
             updated_at = @updatedAt,
             rejected_at = @updatedAt
         WHERE id = @id
           AND status = 'rejecting'
           AND review_claim_token = @claimToken`,
      )
      .run({
        id,
        claimToken,
        note,
        crawlerFeedbackJson: JSON.stringify(crawlerFeedback),
        updatedAt,
      });
    if (result.changes !== 1) {
      throw new Error("Source ingestion rejection claim is no longer current");
    }
  }

  async purgePendingReviewImages(input: { now: string; hardCutoff: string }): Promise<{
    purged: number;
    purgedCharacters: number;
    heldForOpenReview: number;
    pastHardCap: number;
    retainedCharacters: number;
  }> {
    const before = await this.getPendingReviewImageRetentionStats(input);
    const purge = await this.db.transaction(async () => {
      const size = await this.db.prepare(
        `SELECT COALESCE(sum(length(image_data_url)), 0) AS characters
         FROM admin_ingestion_queue
         WHERE status = 'pending_review'
           AND image_data_url IS NOT NULL
           AND created_at <= ?`,
      ).get<{ characters: number }>(input.hardCutoff);
      const result = await this.db.prepare(
        `UPDATE admin_ingestion_queue
         SET image_data_url = NULL,
             image_redacted_at = @now,
             image_redaction_reason = 'open_review_hard_cap',
             updated_at = @now
         WHERE status = 'pending_review'
           AND image_data_url IS NOT NULL
           AND created_at <= @hardCutoff`,
      ).run(input);
      return { purged: result.changes, purgedCharacters: Number(size?.characters ?? 0) };
    })();
    const after = await this.getPendingReviewImageRetentionStats(input);
    return {
      ...purge,
      heldForOpenReview: after.heldForOpenReview,
      pastHardCap: before.pastHardCap,
      retainedCharacters: after.retainedCharacters,
    };
  }

  async getPendingReviewImageRetentionStats(input: { now: string; hardCutoff: string }): Promise<{
    heldForOpenReview: number;
    pastHardCap: number;
    retainedCharacters: number;
  }> {
    const row = await this.db.prepare(
      `SELECT
         sum(CASE
           WHEN image_retention_expires_at IS NOT NULL
            AND image_retention_expires_at <= @now
            AND created_at > @hardCutoff
           THEN 1 ELSE 0 END) AS held,
         sum(CASE WHEN created_at <= @hardCutoff THEN 1 ELSE 0 END) AS past_hard_cap,
         COALESCE(sum(length(image_data_url)), 0) AS retained_characters
       FROM admin_ingestion_queue
       WHERE status = 'pending_review'
         AND image_data_url IS NOT NULL`,
    ).get<{ held: number | null; past_hard_cap: number | null; retained_characters: number | null }>(input);
    return {
      heldForOpenReview: Number(row?.held ?? 0),
      pastHardCap: Number(row?.past_hard_cap ?? 0),
      retainedCharacters: Number(row?.retained_characters ?? 0),
    };
  }

  private mapRow(row: RawAdminIngestionQueueRecord): AdminIngestionQueueRecord {
    return {
      id: row.id,
      venueId: row.venueId,
      venueName: row.venueName,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      imageDataUrl: row.imageDataUrl,
      hasImageData: Boolean(row.hasImageData),
      imageRetentionExpiresAt: row.imageRetentionExpiresAt,
      imageRedactedAt: row.imageRedactedAt,
      imageRedactionReason: row.imageRedactionReason,
      note: row.note,
      status: row.status,
      venueNameGuess: row.venueNameGuess,
      capturedNotes: row.capturedNotes,
      overallConfidence: row.overallConfidence === null ? null : Number(row.overallConfidence),
      extractedBeers: parseBeerRecords(row.extractedBeersJson) ?? [],
      reviewBeers: parseBeerRecords(row.reviewBeersJson),
      crawlerFeedback: parseCrawlerFeedback(row.crawlerFeedbackJson),
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      rejectedAt: row.rejectedAt,
    };
  }
}
