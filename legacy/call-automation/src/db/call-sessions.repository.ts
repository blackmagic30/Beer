import type BetterSqlite3 from "better-sqlite3";

import type { CallSessionRecord, NewCallSessionRecord, UpsertWebhookSessionInput } from "./models.js";

export class CallSessionsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: NewCallSessionRecord): CallSessionRecord {
    this.db
      .prepare(
        `INSERT INTO call_sessions (
          session_id,
          venue_name,
          phone_number,
          suburb,
          call_status,
          transcript_status,
          requested_at,
          updated_at
        ) VALUES (
          @sessionId,
          @venueName,
          @phoneNumber,
          @suburb,
          @callStatus,
          'pending',
          @requestedAt,
          @updatedAt
        )`,
      )
      .run(input);

    return this.getBySessionId(input.sessionId)!;
  }

  getBySessionId(sessionId: string): CallSessionRecord | undefined {
    return this.selectOne("session_id = ?", sessionId);
  }

  getByCallSid(callSid: string): CallSessionRecord | undefined {
    return this.selectOne("call_sid = ?", callSid);
  }

  getByConversationId(conversationId: string): CallSessionRecord | undefined {
    return this.selectOne("conversation_id = ?", conversationId);
  }

  updateTwilioCall(sessionId: string, callSid: string, callStatus: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_sessions
         SET call_sid = @callSid,
             call_status = @callStatus,
             updated_at = @updatedAt
         WHERE session_id = @sessionId`,
      )
      .run({
        sessionId,
        callSid,
        callStatus,
        updatedAt,
      });
  }

  updateCallStatusByCallSid(callSid: string, callStatus: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_sessions
         SET call_status = @callStatus,
             updated_at = @updatedAt
         WHERE call_sid = @callSid`,
      )
      .run({
        callSid,
        callStatus,
        updatedAt,
      });
  }

  markFailed(sessionId: string, notes: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE call_sessions
         SET call_status = 'failed',
             notes = @notes,
             updated_at = @updatedAt
         WHERE session_id = @sessionId`,
      )
      .run({
        sessionId,
        notes,
        updatedAt,
      });
  }

  saveTranscript(input: {
    sessionId: string;
    callSid: string | null;
    conversationId: string | null;
    rawTranscript: string;
    callStatus: string;
    transcriptReceivedAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `UPDATE call_sessions
         SET call_sid = COALESCE(@callSid, call_sid),
             conversation_id = COALESCE(@conversationId, conversation_id),
             raw_transcript = @rawTranscript,
             call_status = @callStatus,
             transcript_status = 'received',
             transcript_received_at = @transcriptReceivedAt,
             updated_at = @updatedAt
         WHERE session_id = @sessionId`,
      )
      .run(input);
  }

  upsertFromWebhookFallback(input: UpsertWebhookSessionInput): CallSessionRecord {
    this.db
      .prepare(
        `INSERT INTO call_sessions (
          session_id,
          conversation_id,
          call_sid,
          venue_name,
          phone_number,
          suburb,
          call_status,
          transcript_status,
          requested_at,
          updated_at,
          transcript_received_at,
          raw_transcript,
          notes
        ) VALUES (
          @sessionId,
          @conversationId,
          @callSid,
          @venueName,
          @phoneNumber,
          @suburb,
          @callStatus,
          CASE WHEN @transcriptReceivedAt IS NULL THEN 'pending' ELSE 'received' END,
          @requestedAt,
          @updatedAt,
          @transcriptReceivedAt,
          @rawTranscript,
          @notes
        )
        ON CONFLICT(session_id) DO UPDATE SET
          conversation_id = COALESCE(excluded.conversation_id, call_sessions.conversation_id),
          call_sid = COALESCE(excluded.call_sid, call_sessions.call_sid),
          venue_name = excluded.venue_name,
          phone_number = excluded.phone_number,
          suburb = excluded.suburb,
          call_status = excluded.call_status,
          transcript_status = CASE
            WHEN excluded.transcript_received_at IS NULL THEN call_sessions.transcript_status
            ELSE 'received'
          END,
          updated_at = excluded.updated_at,
          transcript_received_at = COALESCE(excluded.transcript_received_at, call_sessions.transcript_received_at),
          raw_transcript = COALESCE(excluded.raw_transcript, call_sessions.raw_transcript),
          notes = COALESCE(excluded.notes, call_sessions.notes)`,
      )
      .run(input);

    return this.getBySessionId(input.sessionId)!;
  }

  private selectOne(whereClause: string, value: string): CallSessionRecord | undefined {
    return this.db
      .prepare(
        `SELECT
          session_id AS sessionId,
          conversation_id AS conversationId,
          call_sid AS callSid,
          venue_name AS venueName,
          phone_number AS phoneNumber,
          suburb AS suburb,
          call_status AS callStatus,
          transcript_status AS transcriptStatus,
          requested_at AS requestedAt,
          updated_at AS updatedAt,
          transcript_received_at AS transcriptReceivedAt,
          raw_transcript AS rawTranscript,
          notes AS notes
         FROM call_sessions
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(value) as CallSessionRecord | undefined;
  }
}
