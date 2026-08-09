import crypto from "node:crypto";

import type { SqlDatabase } from "./sql-database.js";

const MAX_ID_LENGTH = 200;
const MAX_STORAGE_PROVIDER_LENGTH = 80;
const MAX_OBJECT_PATH_LENGTH = 4_096;
const MAX_MIME_TYPE_LENGTH = 160;
const MAX_EXTERNAL_URL_LENGTH = 8_192;
const MAX_BATCH_LIMIT = 500;
const MAX_SUBMISSION_EVIDENCE = 1_000;
const MAX_BYTE_SIZE = 100 * 1024 * 1024;
const DELETION_TOKEN = /^[a-f0-9]{64}$/;
const STORAGE_PROVIDERS = new Set(["sqlite_private", "filesystem_private", "supabase_private"]);

const EVIDENCE_COLUMNS = [
  ["id", "id"],
  ["owner_user_id", "ownerUserId"],
  ["storage_provider", "storageProvider"],
  ["object_path", "objectPath"],
  ["mime_type", "mimeType"],
  ["byte_size", "byteSize"],
  ["external_url", "externalUrl"],
  ["retention_expires_at", "retentionExpiresAt"],
  ["deleted_at", "deletedAt"],
  ["created_at", "createdAt"],
] as const;

export type SourceEvidenceRetentionRepositoryErrorCode =
  | "invalid_input"
  | "malformed_record"
  | "evidence_not_found"
  | "retention_candidate_conflict"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<SourceEvidenceRetentionRepositoryErrorCode, string>> = {
  invalid_input: "The source-evidence retention input is invalid.",
  malformed_record: "The stored source-evidence retention record is malformed.",
  evidence_not_found: "The source-evidence record does not exist.",
  retention_candidate_conflict: "The source-evidence retention candidate is stale or no longer eligible.",
  persistence_failure: "Source-evidence retention persistence could not be completed.",
};

/** Stable, deliberately detail-free failures for future service/HTTP mapping. */
export class SourceEvidenceRetentionRepositoryError extends Error {
  readonly code: SourceEvidenceRetentionRepositoryErrorCode;

  constructor(code: SourceEvidenceRetentionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SourceEvidenceRetentionRepositoryError";
    this.code = code;
  }
}

/**
 * Retention deliberately never reads or returns inline evidence bytes. Provider
 * deletion only needs this metadata, reducing accidental exposure and batch
 * memory usage while retaining the existing domain field types.
 */
export interface SourceEvidenceRetentionRecord {
  id: string;
  ownerUserId: string | null;
  storageProvider: string;
  objectPath: string;
  mimeType: string | null;
  byteSize: number | null;
  externalUrl: string | null;
  retentionExpiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface SourceEvidenceRetentionCursor {
  retentionExpiresAt: string;
  createdAt: string;
  id: string;
}

export interface SourceEvidenceOwnerCursor {
  createdAt: string;
  id: string;
}

export interface SourceEvidenceRetentionCandidate extends SourceEvidenceRetentionRecord {
  deletedAt: null;
  retentionExpiresAt: string;
  heldForOpenReview: boolean;
  reason: "retention_expired" | "hard_cap";
  /** Snapshot fence supplied unchanged to `markSourceEvidenceDeleted`. */
  deletionToken: string;
}

export interface ListExpiredSourceEvidenceInput {
  now: string;
  hardCutoff: string;
  limit: number;
  cursor?: SourceEvidenceRetentionCursor | null | undefined;
}

export interface ListSourceEvidenceForOwnerInput {
  ownerUserId: string;
  limit: number;
  cursor?: SourceEvidenceOwnerCursor | null | undefined;
}

export interface MarkSourceEvidenceDeletedInput {
  id: string;
  deletionToken: string;
  now: string;
  hardCutoff: string;
  deletedAt: string;
}

export interface SourceEvidenceRetentionCounts {
  heldForOpenReview: number;
  pastHardCap: number;
}

type RawRow = Record<string, unknown>;

interface EvidenceRow extends RawRow {
  id: unknown;
  ownerUserId: unknown;
  storageProvider: unknown;
  objectPath: unknown;
  mimeType: unknown;
  byteSize: unknown;
  externalUrl: unknown;
  retentionExpiresAt: unknown;
  deletedAt: unknown;
  createdAt: unknown;
  heldForOpenReview?: unknown;
}

function fail(code: SourceEvidenceRetentionRepositoryErrorCode): never {
  throw new SourceEvidenceRetentionRepositoryError(code);
}

function projection(
  columns: readonly (readonly [column: string, result: string])[],
  qualifier = "",
): string {
  return columns.map(([column, result]) => `${qualifier}${column} AS "${result}"`).join(",\n       ");
}

function requiredInputText(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (typeof value !== "string") return fail("invalid_input");
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum || /[\0\r\n]/.test(cleaned)) return fail("invalid_input");
  return cleaned;
}

function requiredRecordText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /\0/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function optionalRecordText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum || /\0/.test(value)) {
    return fail("malformed_record");
  }
  return value;
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function safeInteger(value: unknown, source: "input" | "record", maximum = Number.MAX_SAFE_INTEGER): number {
  const malformed = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  if (typeof value !== "number" && typeof value !== "string") return malformed();
  if (typeof value === "string" && !/^\d+$/.test(value)) return malformed();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) return malformed();
  return numeric;
}

const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function normalizeTimestamp(value: unknown, source: "input" | "record"): string {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  const match = typeof value === "string" ? OFFSET_TIMESTAMP.exec(value) : null;
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === "Z" ? 0 : Number(match?.[10]);
  const offsetMinute = match?.[8] === "Z" ? 0 : Number(match?.[11]);
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    !match
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || offsetHour === 14 && offsetMinute !== 0
    || !Number.isFinite(parsed)
  ) return invalid();
  return new Date(parsed).toISOString();
}

function optionalRecordTimestamp(value: unknown): string | null {
  return value === null ? null : normalizeTimestamp(value, "record");
}

function validatePolicyTimes(nowValue: unknown, hardCutoffValue: unknown): {
  now: string;
  hardCutoff: string;
} {
  const now = normalizeTimestamp(nowValue, "input");
  const hardCutoff = normalizeTimestamp(hardCutoffValue, "input");
  if (hardCutoff > now) return fail("invalid_input");
  return { now, hardCutoff };
}

function mapEvidence(row: EvidenceRow): SourceEvidenceRetentionRecord {
  const storageProvider = requiredRecordText(row.storageProvider, MAX_STORAGE_PROVIDER_LENGTH);
  if (!STORAGE_PROVIDERS.has(storageProvider)) return fail("malformed_record");
  const byteSize = row.byteSize === null ? null : safeInteger(row.byteSize, "record", MAX_BYTE_SIZE);
  const record: SourceEvidenceRetentionRecord = {
    id: requiredRecordText(row.id, MAX_ID_LENGTH),
    ownerUserId: optionalRecordText(row.ownerUserId, MAX_ID_LENGTH),
    storageProvider,
    objectPath: requiredRecordText(row.objectPath, MAX_OBJECT_PATH_LENGTH),
    mimeType: optionalRecordText(row.mimeType, MAX_MIME_TYPE_LENGTH),
    byteSize,
    externalUrl: optionalRecordText(row.externalUrl, MAX_EXTERNAL_URL_LENGTH),
    retentionExpiresAt: optionalRecordTimestamp(row.retentionExpiresAt),
    deletedAt: optionalRecordTimestamp(row.deletedAt),
    createdAt: normalizeTimestamp(row.createdAt, "record"),
  };
  if (
    record.retentionExpiresAt !== null && record.retentionExpiresAt <= record.createdAt
    || record.deletedAt !== null && record.deletedAt < record.createdAt
  ) return fail("malformed_record");
  return record;
}

function snapshotToken(record: SourceEvidenceRetentionRecord, heldForOpenReview: boolean): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    record.id,
    record.ownerUserId,
    record.storageProvider,
    record.objectPath,
    record.mimeType,
    record.byteSize,
    record.externalUrl,
    record.retentionExpiresAt,
    record.deletedAt,
    record.createdAt,
    heldForOpenReview,
  ])).digest("hex");
}

function mapCandidate(row: EvidenceRow): SourceEvidenceRetentionCandidate {
  const record = mapEvidence(row);
  if (record.deletedAt !== null || record.retentionExpiresAt === null) return fail("malformed_record");
  const heldForOpenReview = recordBoolean(row.heldForOpenReview);
  return {
    ...record,
    deletedAt: null,
    retentionExpiresAt: record.retentionExpiresAt,
    heldForOpenReview,
    reason: heldForOpenReview ? "hard_cap" : "retention_expired",
    deletionToken: snapshotToken(record, heldForOpenReview),
  };
}

function normalizeRetentionCursor(value: unknown): SourceEvidenceRetentionCursor | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_input");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["retentionExpiresAt", "createdAt", "id"].includes(key))) {
    return fail("invalid_input");
  }
  return {
    retentionExpiresAt: normalizeTimestamp(raw.retentionExpiresAt, "input"),
    createdAt: normalizeTimestamp(raw.createdAt, "input"),
    id: requiredInputText(raw.id),
  };
}

function normalizeOwnerCursor(value: unknown): SourceEvidenceOwnerCursor | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_input");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["createdAt", "id"].includes(key))) return fail("invalid_input");
  return {
    createdAt: normalizeTimestamp(raw.createdAt, "input"),
    id: requiredInputText(raw.id),
  };
}

function normalizeLimit(value: unknown, maximum = MAX_BATCH_LIMIT): number {
  const limit = safeInteger(value, "input", maximum);
  if (limit < 1) return fail("invalid_input");
  return limit;
}

/**
 * Async retention metadata and deletion-finalization authority. Filesystem and
 * Supabase Storage deletion must happen outside this class. A finalizer holds a
 * database row lock only long enough to revalidate its snapshot/open-review
 * state and write the tombstone.
 */
export class SourceEvidenceRetentionRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SourceEvidenceRetentionRepositoryError) throw error;
      return fail("persistence_failure");
    }
  }

  private collation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  private rowLock(): string {
    return this.database.dialect === "postgres" ? " FOR UPDATE OF evidence" : "";
  }

  private openReviewExpression(): string {
    return `EXISTS (
      SELECT 1
      FROM submission_source_evidence link
      INNER JOIN submissions submission ON submission.id = link.submission_id
      WHERE link.evidence_id = evidence.id
        AND submission.status IN ('pending', 'needs_more_evidence')
    )`;
  }

  private async evidenceById(id: string, lock = false): Promise<EvidenceRow | null> {
    const row = await this.database.prepare(
      `SELECT ${projection(EVIDENCE_COLUMNS, "evidence.")},
              ${this.openReviewExpression()} AS "heldForOpenReview"
       FROM source_evidence_objects evidence
       WHERE evidence.id = ?
       LIMIT 1${lock ? this.rowLock() : ""}`,
    ).get<EvidenceRow>(id);
    return row ?? null;
  }

  async listExpiredSourceEvidence(
    input: ListExpiredSourceEvidenceInput,
  ): Promise<SourceEvidenceRetentionCandidate[]> {
    const { now, hardCutoff } = validatePolicyTimes(input.now, input.hardCutoff);
    const limit = normalizeLimit(input.limit);
    const cursor = normalizeRetentionCursor(input.cursor);
    const cursorClause = cursor
      ? `AND (
           evidence.retention_expires_at > ?
           OR (
             evidence.retention_expires_at = ?
             AND evidence.created_at > ?
           )
           OR (
             evidence.retention_expires_at = ?
             AND evidence.created_at = ?
             AND evidence.id ${this.collation()} > ?
           )
         )`
      : "";
    const bindings: unknown[] = [now, hardCutoff];
    if (cursor) {
      bindings.push(
        cursor.retentionExpiresAt,
        cursor.retentionExpiresAt,
        cursor.createdAt,
        cursor.retentionExpiresAt,
        cursor.createdAt,
        cursor.id,
      );
    }
    bindings.push(limit);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${projection(EVIDENCE_COLUMNS, "evidence.")},
                ${this.openReviewExpression()} AS "heldForOpenReview"
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND (
             evidence.created_at <= ?
             OR NOT ${this.openReviewExpression()}
           )
           ${cursorClause}
         ORDER BY evidence.retention_expires_at ASC,
                  evidence.created_at ASC,
                  evidence.id ${this.collation()} ASC
         LIMIT ?`,
      ).all<EvidenceRow>(...bindings);
      return rows.map(mapCandidate);
    });
  }

  async countExpiredSourceEvidence(nowValue: string, hardCutoffValue: string): Promise<number> {
    const { now, hardCutoff } = validatePolicyTimes(nowValue, hardCutoffValue);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count"
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND (
             evidence.created_at <= ?
             OR NOT ${this.openReviewExpression()}
           )`,
      ).get<{ count: unknown }>(now, hardCutoff);
      return safeInteger(row?.count ?? 0, "record");
    });
  }

  async countOverdueHeldSourceEvidence(
    nowValue: string,
    hardCutoffValue: string,
  ): Promise<SourceEvidenceRetentionCounts> {
    const { now, hardCutoff } = validatePolicyTimes(nowValue, hardCutoffValue);
    return this.translate(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "heldForOpenReview",
                COALESCE(sum(CASE WHEN evidence.created_at <= ? THEN 1 ELSE 0 END), 0) AS "pastHardCap"
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND ${this.openReviewExpression()}`,
      ).get<{ heldForOpenReview: unknown; pastHardCap: unknown }>(hardCutoff, now);
      return {
        heldForOpenReview: safeInteger(row?.heldForOpenReview ?? 0, "record"),
        pastHardCap: safeInteger(row?.pastHardCap ?? 0, "record"),
      };
    });
  }

  async listSourceEvidenceForOwner(
    input: ListSourceEvidenceForOwnerInput,
  ): Promise<SourceEvidenceRetentionRecord[]> {
    const ownerUserId = requiredInputText(input.ownerUserId);
    const limit = normalizeLimit(input.limit);
    const cursor = normalizeOwnerCursor(input.cursor);
    const cursorClause = cursor
      ? `AND (
           evidence.created_at > ?
           OR (evidence.created_at = ? AND evidence.id ${this.collation()} > ?)
         )`
      : "";
    const bindings: unknown[] = [ownerUserId];
    if (cursor) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    bindings.push(limit);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT ${projection(EVIDENCE_COLUMNS, "evidence.")}
         FROM source_evidence_objects evidence
         WHERE evidence.owner_user_id = ?
           AND evidence.deleted_at IS NULL
           ${cursorClause}
         ORDER BY evidence.created_at ASC, evidence.id ${this.collation()} ASC
         LIMIT ?`,
      ).all<EvidenceRow>(...bindings);
      return rows.map(mapEvidence);
    });
  }

  async listSubmissionSourceEvidenceIds(input: {
    submissionId: string;
    limit: number;
  }): Promise<string[]> {
    const submissionId = requiredInputText(input.submissionId);
    const limit = normalizeLimit(input.limit, MAX_SUBMISSION_EVIDENCE);
    return this.translate(async () => {
      const rows = await this.database.prepare(
        `SELECT link.evidence_id AS "evidenceId"
         FROM submission_source_evidence link
         WHERE link.submission_id = ?
         ORDER BY link.sort_order ASC, link.evidence_id ${this.collation()} ASC
         LIMIT ?`,
      ).all<{ evidenceId: unknown }>(submissionId, limit);
      return rows.map((row) => requiredRecordText(row.evidenceId, MAX_ID_LENGTH));
    });
  }

  async isSourceEvidenceLinked(id: string): Promise<boolean> {
    const evidenceId = requiredInputText(id);
    return this.translate(async () => Boolean(await this.database.prepare(
      `SELECT 1 AS "linked"
       FROM submission_source_evidence link
       WHERE link.evidence_id = ?
       LIMIT 1`,
    ).get(evidenceId)));
  }

  async markSourceEvidenceDeleted(
    input: MarkSourceEvidenceDeletedInput,
  ): Promise<SourceEvidenceRetentionRecord> {
    const id = requiredInputText(input.id);
    const token = requiredInputText(input.deletionToken, 64);
    if (!DELETION_TOKEN.test(token)) return fail("invalid_input");
    const { now, hardCutoff } = validatePolicyTimes(input.now, input.hardCutoff);
    const deletedAt = normalizeTimestamp(input.deletedAt, "input");
    if (deletedAt < now) return fail("invalid_input");

    return this.translate(this.database.transaction(async () => {
      const row = await this.evidenceById(id, true);
      if (!row) return fail("evidence_not_found");
      const record = mapEvidence(row);
      const heldForOpenReview = recordBoolean(row.heldForOpenReview);
      if (
        record.deletedAt !== null
        || record.retentionExpiresAt === null
        || record.retentionExpiresAt > now
        || heldForOpenReview && record.createdAt > hardCutoff
        || snapshotToken(record, heldForOpenReview) !== token
      ) return fail("retention_candidate_conflict");
      if (deletedAt < record.createdAt) return fail("invalid_input");

      const updated = await this.database.prepare(
        `UPDATE source_evidence_objects
         SET data_base64 = NULL,
             external_url = NULL,
             byte_size = NULL,
             deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      ).run(deletedAt, id);
      if (updated.changes !== 1) return fail("retention_candidate_conflict");
      const tombstoneRow = await this.database.prepare(
        `SELECT ${projection(EVIDENCE_COLUMNS, "evidence.")},
                (evidence.data_base64 IS NULL) AS "payloadCleared"
         FROM source_evidence_objects evidence
         WHERE evidence.id = ?`,
      ).get<EvidenceRow & { payloadCleared: unknown }>(id);
      if (!tombstoneRow || !recordBoolean(tombstoneRow.payloadCleared)) return fail("persistence_failure");
      const tombstone = mapEvidence(tombstoneRow);
      if (
        tombstone.deletedAt !== deletedAt
        || tombstone.objectPath !== record.objectPath
        || tombstone.storageProvider !== record.storageProvider
        || tombstone.externalUrl !== null
        || tombstone.byteSize !== null
      ) return fail("persistence_failure");
      return tombstone;
    }));
  }
}
