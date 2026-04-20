import type BetterSqlite3 from "better-sqlite3";

import type {
  CallRunRecord,
  CallRunsFilters,
  CallStatus,
  NewCallRunInput,
  ParseStatus,
} from "./models.js";

interface RawCallRunRecord extends Omit<CallRunRecord, "isTest"> {
  isTest: number;
}

interface UpdateCallRunStatusInput {
  callStatus: CallStatus;
  endedAt?: string | null;
  durationSeconds?: number | null;
  errorMessage?: string | null;
  updatedAt: string;
}

interface SaveTranscriptParseInput {
  conversationId?: string | null;
  rawTranscript: string | null;
  parseConfidence: number | null;
  parseStatus: ParseStatus;
  errorMessage?: string | null;
  endedAt?: string | null;
  updatedAt: string;
}

export class CallRunsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: NewCallRunInput): CallRunRecord {
    this.db
      .prepare(
        `INSERT INTO call_runs (
          id,
          venue_id,
          venue_name,
          phone_number,
          suburb,
          started_at,
          call_status,
          parse_status,
          is_test,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @venueId,
          @venueName,
          @phoneNumber,
          @suburb,
          @startedAt,
          @callStatus,
          @parseStatus,
          @isTest,
          @createdAt,
          @updatedAt
        )`,
      )
      .run({
        ...input,
        isTest: input.isTest ? 1 : 0,
      });

    return this.getById(input.id)!;
  }

  getById(id: string): CallRunRecord | undefined {
    return this.selectOne("id = ?", id);
  }

  getByCallSid(callSid: string): CallRunRecord | undefined {
    return this.selectOne("call_sid = ?", callSid);
  }

  getByConversationId(conversationId: string): CallRunRecord | undefined {
    return this.selectOne("conversation_id = ?", conversationId);
  }

  updateDialSuccess(id: string, callSid: string, callStatus: CallStatus, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET call_sid = @callSid,
             call_status = @callStatus,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        callSid,
        callStatus,
        updatedAt,
      });
  }

  markDialFailure(id: string, errorMessage: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET call_status = 'failed',
             parse_status = CASE WHEN parse_status = 'pending' THEN 'failed' ELSE parse_status END,
             error_message = @errorMessage,
             ended_at = COALESCE(ended_at, @updatedAt),
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        errorMessage,
        updatedAt,
      });
  }

  setConversationId(id: string, conversationId: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET conversation_id = @conversationId,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        conversationId,
        updatedAt,
      });
  }

  updateStatusByCallSid(callSid: string, input: UpdateCallRunStatusInput): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET call_status = @callStatus,
             ended_at = COALESCE(@endedAt, ended_at),
             duration_seconds = COALESCE(@durationSeconds, duration_seconds),
             error_message = COALESCE(@errorMessage, error_message),
             updated_at = @updatedAt
         WHERE call_sid = @callSid`,
      )
      .run({
        callSid,
        ...input,
        endedAt: input.endedAt ?? null,
        durationSeconds: input.durationSeconds ?? null,
        errorMessage: input.errorMessage ?? null,
      });
  }

  updateStatusById(id: string, input: UpdateCallRunStatusInput): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET call_status = @callStatus,
             ended_at = COALESCE(@endedAt, ended_at),
             duration_seconds = COALESCE(@durationSeconds, duration_seconds),
             error_message = COALESCE(@errorMessage, error_message),
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        ...input,
        endedAt: input.endedAt ?? null,
        durationSeconds: input.durationSeconds ?? null,
        errorMessage: input.errorMessage ?? null,
      });
  }

  saveTranscriptParseById(id: string, input: SaveTranscriptParseInput): void {
    this.db
      .prepare(
        `UPDATE call_runs
         SET conversation_id = COALESCE(@conversationId, conversation_id),
             raw_transcript = COALESCE(@rawTranscript, raw_transcript),
             parse_confidence = @parseConfidence,
             parse_status = @parseStatus,
             error_message = @errorMessage,
             ended_at = COALESCE(@endedAt, ended_at),
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        ...input,
        conversationId: input.conversationId ?? null,
        errorMessage: input.errorMessage ?? null,
        endedAt: input.endedAt ?? null,
      });
  }

  hasRecentAttempt(phoneNumber: string, startedAfter: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM call_runs
         WHERE phone_number = ?
           AND started_at >= ?
         LIMIT 1`,
      )
      .get(phoneNumber, startedAfter);

    return Boolean(row);
  }

  list(filters: CallRunsFilters): CallRunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.callSid) {
      clauses.push("call_sid = ?");
      params.push(filters.callSid);
    }

    if (filters.venueName) {
      clauses.push("venue_name LIKE ?");
      params.push(`%${filters.venueName}%`);
    }

    if (filters.suburb) {
      clauses.push("suburb LIKE ?");
      params.push(`%${filters.suburb}%`);
    }

    if (filters.testMode !== undefined) {
      clauses.push("is_test = ?");
      params.push(filters.testMode ? 1 : 0);
    }

    params.push(filters.limit);

    const rows = this.db
      .prepare(
        `SELECT
          id,
          call_sid AS callSid,
          conversation_id AS conversationId,
          venue_id AS venueId,
          venue_name AS venueName,
          phone_number AS phoneNumber,
          suburb,
          started_at AS startedAt,
          ended_at AS endedAt,
          duration_seconds AS durationSeconds,
          call_status AS callStatus,
          raw_transcript AS rawTranscript,
          parse_confidence AS parseConfidence,
          parse_status AS parseStatus,
          error_message AS errorMessage,
          is_test AS isTest,
          created_at AS createdAt,
          updated_at AS updatedAt
         FROM call_runs
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params) as RawCallRunRecord[];

    return rows.map((row) => this.mapRow(row));
  }

  private selectOne(whereClause: string, value: string): CallRunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          id,
          call_sid AS callSid,
          conversation_id AS conversationId,
          venue_id AS venueId,
          venue_name AS venueName,
          phone_number AS phoneNumber,
          suburb,
          started_at AS startedAt,
          ended_at AS endedAt,
          duration_seconds AS durationSeconds,
          call_status AS callStatus,
          raw_transcript AS rawTranscript,
          parse_confidence AS parseConfidence,
          parse_status AS parseStatus,
          error_message AS errorMessage,
          is_test AS isTest,
          created_at AS createdAt,
          updated_at AS updatedAt
         FROM call_runs
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(value) as RawCallRunRecord | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: RawCallRunRecord): CallRunRecord {
    return {
      ...row,
      isTest: Boolean(row.isTest),
    };
  }
}
