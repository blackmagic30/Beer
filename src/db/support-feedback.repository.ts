import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FEEDBACK_TYPES = new Set([
  "bug",
  "wrong_data",
  "feature_idea",
  "venue_suggestion",
  "venue_partner_interest",
  "general_feedback",
  "privacy_request",
  "data_export_request",
  "account_deletion_request",
  "moderation_appeal",
  "security_report",
  "abuse_report",
  "billing_support",
] as const);
const FEEDBACK_PRIORITIES = new Set(["low", "normal", "medium", "high"] as const);
const TRUST_STATUSES = new Set(["open", "in_progress", "resolved", "rejected"] as const);
const WRONG_PRICE_REASONS = new Set([
  "price_changed",
  "beer_not_available",
  "happy_hour_changed",
  "wrong_serving_size",
  "other",
] as const);
const MAX_PAGE_SIZE = 100;

export type FeedbackType =
  | "bug"
  | "wrong_data"
  | "feature_idea"
  | "venue_suggestion"
  | "venue_partner_interest"
  | "general_feedback"
  | "privacy_request"
  | "data_export_request"
  | "account_deletion_request"
  | "moderation_appeal"
  | "security_report"
  | "abuse_report"
  | "billing_support";
export type FeedbackPriority = "low" | "normal" | "medium" | "high";
export type TrustWorkflowStatus = "open" | "in_progress" | "resolved" | "rejected";
export type WrongPriceReason =
  | "price_changed"
  | "beer_not_available"
  | "happy_hour_changed"
  | "wrong_serving_size"
  | "other";

export type SupportFeedbackRepositoryErrorCode =
  | "account_not_found"
  | "feedback_conflict"
  | "invalid_input"
  | "persistence_failure"
  | "price_record_not_found"
  | "stored_record_invalid"
  | "wrong_price_report_conflict";

const ERROR_MESSAGES: Readonly<Record<SupportFeedbackRepositoryErrorCode, string>> = {
  account_not_found: "The support record references an account that does not exist.",
  feedback_conflict: "The feedback identifier is already assigned to different data.",
  invalid_input: "The support or wrong-price persistence input is invalid.",
  persistence_failure: "Support or wrong-price persistence could not be completed.",
  price_record_not_found: "The referenced price record does not exist.",
  stored_record_invalid: "A stored support or wrong-price record is invalid.",
  wrong_price_report_conflict: "The wrong-price report identifier is already assigned to different data.",
};

/** Stable, secret-free persistence failures for service and HTTP mapping. */
export class SupportFeedbackRepositoryError extends Error {
  readonly code: SupportFeedbackRepositoryErrorCode;

  constructor(code: SupportFeedbackRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SupportFeedbackRepositoryError";
    this.code = code;
  }
}

export interface FeedbackItem {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  feedbackType: FeedbackType;
  message: string;
  venueId: string | null;
  venueName: string | null;
  contactEmail: string | null;
  status: TrustWorkflowStatus;
  priority: FeedbackPriority;
  triageReason: string | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WrongPriceReport {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  venueId: string;
  venueName: string;
  priceRecordId: string | null;
  beerName: string | null;
  reason: WrongPriceReason;
  notes: string | null;
  sourcePhotoUrl: string | null;
  status: TrustWorkflowStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrustWorkflowUpdateInput {
  id: string;
  status: TrustWorkflowStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedBy: string;
  expectedUpdatedAt: string;
  now: string;
}

export type TrustWorkflowUpdateResult<RecordType> =
  | { state: "updated"; item: RecordType }
  | { state: "not_found" }
  | { state: "conflict" };

export interface WrongPriceReportWriteResult {
  report: WrongPriceReport;
  markedDisputed: boolean;
  duplicate: boolean;
}

interface FeedbackRow {
  id: unknown;
  userId: unknown;
  anonymousSessionId: unknown;
  feedbackType: unknown;
  message: unknown;
  venueId: unknown;
  venueName: unknown;
  contactEmail: unknown;
  status: unknown;
  priority: unknown;
  triageReason: unknown;
  assignedTo: unknown;
  resolutionNote: unknown;
  resolvedAt: unknown;
  resolvedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface WrongPriceReportRow {
  id: unknown;
  userId: unknown;
  anonymousSessionId: unknown;
  venueId: unknown;
  venueName: unknown;
  priceRecordId: unknown;
  beerName: unknown;
  reason: unknown;
  notes: unknown;
  sourcePhotoUrl: unknown;
  status: unknown;
  assignedTo: unknown;
  resolutionNote: unknown;
  resolvedAt: unknown;
  resolvedBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

function repositoryError(code: SupportFeedbackRepositoryErrorCode): never {
  throw new SupportFeedbackRepositoryError(code);
}

function requireText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("invalid_input");
  }
  return normalized;
}

function optionalText(value: unknown, maximum = 255): string | null {
  return value == null ? null : requireText(value, maximum);
}

function persistedText(value: unknown, maximum = 255): string {
  if (typeof value !== "string") return repositoryError("stored_record_invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return repositoryError("stored_record_invalid");
  }
  return normalized;
}

function optionalPersistedText(value: unknown, maximum = 255): string | null {
  return value == null ? null : persistedText(value, maximum);
}

function requireCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("invalid_input");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("invalid_input");
    }
    return value;
  } catch {
    return repositoryError("invalid_input");
  }
}

function persistedCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") return repositoryError("stored_record_invalid");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return repositoryError("stored_record_invalid");
    }
    return value;
  } catch {
    return repositoryError("stored_record_invalid");
  }
}

function optionalPersistedCanonicalUtc(value: unknown): string | null {
  return value == null ? null : persistedCanonicalUtc(value);
}

function requireEnum<Value extends string>(value: unknown, allowed: ReadonlySet<Value>): Value {
  if (typeof value !== "string" || !allowed.has(value as Value)) return repositoryError("invalid_input");
  return value as Value;
}

function persistedEnum<Value extends string>(value: unknown, allowed: ReadonlySet<Value>): Value {
  if (typeof value !== "string" || !allowed.has(value as Value)) return repositoryError("stored_record_invalid");
  return value as Value;
}

function requirePage(input: { limit: unknown; offset?: unknown }): { limit: number; offset: number } {
  if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > MAX_PAGE_SIZE) {
    return repositoryError("invalid_input");
  }
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000) {
    return repositoryError("invalid_input");
  }
  return { limit: input.limit as number, offset: offset as number };
}

function countValue(value: unknown): number {
  const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) return repositoryError("stored_record_invalid");
  return count as number;
}

function toFeedback(row: FeedbackRow): FeedbackItem {
  return {
    id: persistedText(row.id),
    userId: optionalPersistedText(row.userId),
    anonymousSessionId: optionalPersistedText(row.anonymousSessionId),
    feedbackType: persistedEnum(row.feedbackType, FEEDBACK_TYPES),
    message: persistedText(row.message, 1_200),
    venueId: optionalPersistedText(row.venueId, 180),
    venueName: optionalPersistedText(row.venueName, 180),
    contactEmail: optionalPersistedText(row.contactEmail, 320),
    status: persistedEnum(row.status, TRUST_STATUSES),
    priority: persistedEnum(row.priority, FEEDBACK_PRIORITIES),
    triageReason: optionalPersistedText(row.triageReason, 2_000),
    assignedTo: optionalPersistedText(row.assignedTo),
    resolutionNote: optionalPersistedText(row.resolutionNote, 2_000),
    resolvedAt: optionalPersistedCanonicalUtc(row.resolvedAt),
    resolvedBy: optionalPersistedText(row.resolvedBy),
    createdAt: persistedCanonicalUtc(row.createdAt),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

function toWrongPriceReport(row: WrongPriceReportRow): WrongPriceReport {
  return {
    id: persistedText(row.id),
    userId: optionalPersistedText(row.userId),
    anonymousSessionId: optionalPersistedText(row.anonymousSessionId),
    venueId: persistedText(row.venueId, 180),
    venueName: persistedText(row.venueName, 180),
    priceRecordId: optionalPersistedText(row.priceRecordId),
    beerName: optionalPersistedText(row.beerName, 2_000),
    reason: persistedEnum(row.reason, WRONG_PRICE_REASONS),
    notes: optionalPersistedText(row.notes, 2_000),
    sourcePhotoUrl: optionalPersistedText(row.sourcePhotoUrl, 4_096),
    status: persistedEnum(row.status, TRUST_STATUSES),
    assignedTo: optionalPersistedText(row.assignedTo),
    resolutionNote: optionalPersistedText(row.resolutionNote, 2_000),
    resolvedAt: optionalPersistedCanonicalUtc(row.resolvedAt),
    resolvedBy: optionalPersistedText(row.resolvedBy),
    createdAt: persistedCanonicalUtc(row.createdAt),
    updatedAt: persistedCanonicalUtc(row.updatedAt),
  };
}

function feedbackSelect(where: string): string {
  return `SELECT
    id AS "id",
    user_id AS "userId",
    anonymous_session_id AS "anonymousSessionId",
    feedback_type AS "feedbackType",
    message AS "message",
    venue_id AS "venueId",
    venue_name AS "venueName",
    contact_email AS "contactEmail",
    status AS "status",
    priority AS "priority",
    triage_reason AS "triageReason",
    assigned_to AS "assignedTo",
    resolution_note AS "resolutionNote",
    resolved_at AS "resolvedAt",
    resolved_by AS "resolvedBy",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM feedback ${where}`;
}

function wrongPriceSelect(where: string): string {
  return `SELECT
    id AS "id",
    user_id AS "userId",
    anonymous_session_id AS "anonymousSessionId",
    venue_id AS "venueId",
    venue_name AS "venueName",
    price_record_id AS "priceRecordId",
    beer_name AS "beerName",
    reason AS "reason",
    notes AS "notes",
    source_photo_url AS "sourcePhotoUrl",
    status AS "status",
    assigned_to AS "assignedTo",
    resolution_note AS "resolutionNote",
    resolved_at AS "resolvedAt",
    resolved_by AS "resolvedBy",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM wrong_price_reports ${where}`;
}

function equalFeedback(left: FeedbackItem, right: FeedbackItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalWrongPrice(left: WrongPriceReport, right: WrongPriceReport): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SupportFeedbackRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async advisoryLock(key: string): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    await this.database
      .prepare("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0)) AS \"locked\"")
      .get(key);
  }

  private async accountExists(userId: string | null): Promise<boolean> {
    if (!userId) return true;
    return Boolean(await this.database.prepare("SELECT 1 AS \"present\" FROM accounts WHERE id = ?").get(userId));
  }

  private async getFeedbackRow(id: string): Promise<FeedbackRow | undefined> {
    return this.database.prepare(feedbackSelect("WHERE id = ?")).get<FeedbackRow>(id);
  }

  private async getWrongPriceRow(id: string): Promise<WrongPriceReportRow | undefined> {
    return this.database.prepare(wrongPriceSelect("WHERE id = ?")).get<WrongPriceReportRow>(id);
  }

  async createFeedback(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    feedbackType: FeedbackType;
    message: string;
    venueId: string | null;
    venueName: string | null;
    contactEmail?: string | null;
    priority: FeedbackPriority;
    triageReason: string | null;
    now: string;
  }): Promise<FeedbackItem> {
    const normalized = {
      id: requireText(input.id),
      userId: optionalText(input.userId),
      anonymousSessionId: optionalText(input.anonymousSessionId),
      feedbackType: requireEnum(input.feedbackType, FEEDBACK_TYPES),
      message: requireText(input.message, 1_200),
      venueId: optionalText(input.venueId, 180),
      venueName: optionalText(input.venueName, 180),
      contactEmail: optionalText(input.contactEmail, 320)?.toLowerCase() ?? null,
      priority: requireEnum(input.priority, FEEDBACK_PRIORITIES),
      triageReason: optionalText(input.triageReason, 2_000),
      now: requireCanonicalUtc(input.now),
    };

    return this.database.transaction<FeedbackItem>(async () => {
      await this.advisoryLock(`support-feedback:id:${normalized.id}`);
      const existingRow = await this.getFeedbackRow(normalized.id);
      if (existingRow) {
        const existing = toFeedback(existingRow);
        const expected: FeedbackItem = {
          id: normalized.id,
          userId: normalized.userId,
          anonymousSessionId: normalized.anonymousSessionId,
          feedbackType: normalized.feedbackType,
          message: normalized.message,
          venueId: normalized.venueId,
          venueName: normalized.venueName,
          contactEmail: normalized.contactEmail,
          status: "open",
          priority: normalized.priority,
          triageReason: normalized.triageReason,
          assignedTo: null,
          resolutionNote: null,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: normalized.now,
          updatedAt: normalized.now,
        };
        if (!equalFeedback(existing, expected)) return repositoryError("feedback_conflict");
        return existing;
      }
      if (!await this.accountExists(normalized.userId)) return repositoryError("account_not_found");
      try {
        await this.database.prepare(
          `INSERT INTO feedback (
             id, user_id, anonymous_session_id, feedback_type, message, venue_id, venue_name,
             contact_email, status, priority, triage_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        ).run(
          normalized.id,
          normalized.userId,
          normalized.anonymousSessionId,
          normalized.feedbackType,
          normalized.message,
          normalized.venueId,
          normalized.venueName,
          normalized.contactEmail,
          normalized.priority,
          normalized.triageReason,
          normalized.now,
          normalized.now,
        );
      } catch (error) {
        if (error instanceof SupportFeedbackRepositoryError) throw error;
        return repositoryError("persistence_failure");
      }
      const created = await this.getFeedbackRow(normalized.id);
      if (!created) return repositoryError("persistence_failure");
      return toFeedback(created);
    })();
  }

  async listFeedback(input: { limit: number; offset?: number }): Promise<FeedbackItem[]> {
    const page = requirePage(input);
    const rows = await this.database.prepare(feedbackSelect(
      `ORDER BY
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_at DESC,
         id DESC
       LIMIT ? OFFSET ?`,
    )).all<FeedbackRow>(page.limit, page.offset);
    return rows.map(toFeedback);
  }

  async countFeedback(): Promise<number> {
    const row = await this.database.prepare("SELECT count(*) AS \"count\" FROM feedback").get<{ count: unknown }>();
    return countValue(row?.count ?? 0);
  }

  async createWrongPriceReport(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    venueId: string;
    venueName: string;
    priceRecordId: string | null;
    beerName: string | null;
    reason: WrongPriceReason;
    notes: string | null;
    sourcePhotoUrl: string | null;
    now: string;
  }): Promise<WrongPriceReportWriteResult> {
    const normalized = {
      id: requireText(input.id),
      userId: optionalText(input.userId),
      anonymousSessionId: optionalText(input.anonymousSessionId),
      venueId: requireText(input.venueId, 180),
      venueName: requireText(input.venueName, 180),
      priceRecordId: optionalText(input.priceRecordId),
      beerName: optionalText(input.beerName, 2_000),
      reason: requireEnum(input.reason, WRONG_PRICE_REASONS),
      notes: optionalText(input.notes, 2_000),
      sourcePhotoUrl: optionalText(input.sourcePhotoUrl, 4_096),
      now: requireCanonicalUtc(input.now),
    };
    if (!normalized.userId && !normalized.anonymousSessionId) return repositoryError("invalid_input");
    const reporterKey = normalized.userId
      ? `user:${normalized.userId}`
      : `anonymous:${normalized.anonymousSessionId}`;

    return this.database.transaction<WrongPriceReportWriteResult>(async () => {
      await this.advisoryLock(`wrong-price:id:${normalized.id}`);
      if (normalized.priceRecordId) {
        await this.advisoryLock(`wrong-price:record:${normalized.priceRecordId}`);
        await this.advisoryLock(`wrong-price:reporter:${normalized.priceRecordId}:${reporterKey}`);
      }
      const sameId = await this.getWrongPriceRow(normalized.id);
      if (sameId) {
        const existing = toWrongPriceReport(sameId);
        const expected: WrongPriceReport = {
          id: normalized.id,
          userId: normalized.userId,
          anonymousSessionId: normalized.anonymousSessionId,
          venueId: normalized.venueId,
          venueName: normalized.venueName,
          priceRecordId: normalized.priceRecordId,
          beerName: normalized.beerName,
          reason: normalized.reason,
          notes: normalized.notes,
          sourcePhotoUrl: normalized.sourcePhotoUrl,
          status: "open",
          assignedTo: null,
          resolutionNote: null,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: normalized.now,
          updatedAt: normalized.now,
        };
        if (!equalWrongPrice(existing, expected)) return repositoryError("wrong_price_report_conflict");
        return { report: existing, markedDisputed: false, duplicate: true };
      }
      if (!await this.accountExists(normalized.userId)) return repositoryError("account_not_found");
      if (normalized.priceRecordId) {
        const priceExists = await this.database
          .prepare("SELECT 1 AS \"present\" FROM venue_price_records WHERE id = ?")
          .get(normalized.priceRecordId);
        if (!priceExists) return repositoryError("price_record_not_found");
        const existing = normalized.userId
          ? await this.database.prepare(wrongPriceSelect(
              "WHERE price_record_id = ? AND user_id = ? AND status IN ('open', 'in_progress') ORDER BY created_at DESC, id DESC LIMIT 1",
            )).get<WrongPriceReportRow>(normalized.priceRecordId, normalized.userId)
          : await this.database.prepare(wrongPriceSelect(
              "WHERE price_record_id = ? AND user_id IS NULL AND anonymous_session_id = ? AND status IN ('open', 'in_progress') ORDER BY created_at DESC, id DESC LIMIT 1",
            )).get<WrongPriceReportRow>(normalized.priceRecordId, normalized.anonymousSessionId);
        if (existing) {
          return { report: toWrongPriceReport(existing), markedDisputed: false, duplicate: true };
        }
      }

      try {
        await this.database.prepare(
          `INSERT INTO wrong_price_reports (
             id, user_id, anonymous_session_id, venue_id, venue_name, price_record_id, beer_name,
             reason, notes, source_photo_url, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          normalized.id,
          normalized.userId,
          normalized.anonymousSessionId,
          normalized.venueId,
          normalized.venueName,
          normalized.priceRecordId,
          normalized.beerName,
          normalized.reason,
          normalized.notes,
          normalized.sourcePhotoUrl,
          normalized.now,
          normalized.now,
        );
      } catch (error) {
        if (error instanceof SupportFeedbackRepositoryError) throw error;
        return repositoryError("persistence_failure");
      }

      let markedDisputed = false;
      if (normalized.priceRecordId) {
        const row = await this.database.prepare(
          `SELECT count(DISTINCT user_id) AS "count"
             FROM wrong_price_reports
            WHERE price_record_id = ? AND status = 'open' AND user_id IS NOT NULL`,
        ).get<{ count: unknown }>(normalized.priceRecordId);
        if (countValue(row?.count ?? 0) >= 2) {
          const updated = await this.database.prepare(
            `UPDATE venue_price_records
                SET confidence = 'disputed', updated_at = ?
              WHERE id = ? AND confidence != 'venue_confirmed'`,
          ).run(normalized.now, normalized.priceRecordId);
          markedDisputed = updated.changes === 1;
        }
      }
      const created = await this.getWrongPriceRow(normalized.id);
      if (!created) return repositoryError("persistence_failure");
      return { report: toWrongPriceReport(created), markedDisputed, duplicate: false };
    })();
  }

  async listWrongPriceReports(input: { limit: number; offset?: number }): Promise<WrongPriceReport[]> {
    const page = requirePage(input);
    const rows = await this.database.prepare(wrongPriceSelect(
      "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )).all<WrongPriceReportRow>(page.limit, page.offset);
    return rows.map(toWrongPriceReport);
  }

  async countWrongPriceReports(): Promise<number> {
    const row = await this.database
      .prepare("SELECT count(*) AS \"count\" FROM wrong_price_reports")
      .get<{ count: unknown }>();
    return countValue(row?.count ?? 0);
  }

  async updateFeedbackWorkflow(input: TrustWorkflowUpdateInput): Promise<TrustWorkflowUpdateResult<FeedbackItem>> {
    return this.updateWorkflow("feedback", input);
  }

  async updateWrongPriceWorkflow(
    input: TrustWorkflowUpdateInput,
  ): Promise<TrustWorkflowUpdateResult<WrongPriceReport>> {
    return this.updateWorkflow("wrong_price", input);
  }

  private async updateWorkflow(
    kind: "feedback",
    input: TrustWorkflowUpdateInput,
  ): Promise<TrustWorkflowUpdateResult<FeedbackItem>>;
  private async updateWorkflow(
    kind: "wrong_price",
    input: TrustWorkflowUpdateInput,
  ): Promise<TrustWorkflowUpdateResult<WrongPriceReport>>;
  private async updateWorkflow(
    kind: "feedback" | "wrong_price",
    input: TrustWorkflowUpdateInput,
  ): Promise<TrustWorkflowUpdateResult<FeedbackItem | WrongPriceReport>> {
    const normalized = {
      id: requireText(input.id),
      status: requireEnum(input.status, TRUST_STATUSES),
      assignedTo: optionalText(input.assignedTo),
      resolutionNote: optionalText(input.resolutionNote, 2_000),
      resolvedBy: requireText(input.resolvedBy),
      expectedUpdatedAt: requireCanonicalUtc(input.expectedUpdatedAt),
      now: requireCanonicalUtc(input.now),
    };
    if (normalized.now <= normalized.expectedUpdatedAt) return repositoryError("invalid_input");
    const table = kind === "feedback" ? "feedback" : "wrong_price_reports";
    const terminal = normalized.status === "resolved" || normalized.status === "rejected";
    return this.database.transaction<TrustWorkflowUpdateResult<FeedbackItem | WrongPriceReport>>(async () => {
      await this.advisoryLock(`trust-workflow:${kind}:${normalized.id}`);
      if (!await this.accountExists(normalized.resolvedBy) || !await this.accountExists(normalized.assignedTo)) {
        return repositoryError("account_not_found");
      }
      const result = await this.database.prepare(
        `UPDATE ${table}
            SET status = ?,
                assigned_to = ?,
                resolution_note = ?,
                resolved_at = ?,
                resolved_by = ?,
                updated_at = ?
          WHERE id = ? AND updated_at = ?`,
      ).run(
        normalized.status,
        normalized.assignedTo,
        normalized.resolutionNote,
        terminal ? normalized.now : null,
        terminal ? normalized.resolvedBy : null,
        normalized.now,
        normalized.id,
        normalized.expectedUpdatedAt,
      );
      if (result.changes !== 1) {
        const exists = await this.database.prepare(`SELECT 1 AS "present" FROM ${table} WHERE id = ?`).get(normalized.id);
        return exists ? { state: "conflict" } : { state: "not_found" };
      }
      if (kind === "feedback") {
        const row = await this.getFeedbackRow(normalized.id);
        if (!row) return repositoryError("persistence_failure");
        return { state: "updated", item: toFeedback(row) };
      }
      const row = await this.getWrongPriceRow(normalized.id);
      if (!row) return repositoryError("persistence_failure");
      return { state: "updated", item: toWrongPriceReport(row) };
    })();
  }
}
