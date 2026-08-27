import { findTrackedBeerByName } from "../constants/beers.js";
import { redactSecrets } from "../lib/redact.js";
import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MACHINE_NAME = /^[a-z][a-z0-9_.:-]{0,159}$/;
const REQUEST_HASH = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 2_000;
const MAX_ACTIVITY_PAGE_SIZE = 200;
const MAX_AUDIT_PAGE_SIZE = 500;
const MAX_PRICE_CONFIRMATION_RECORD_IDS = 500;
const PRICE_VERSION_FINGERPRINT = /^[a-f0-9]{64}$/;

export type ActivityAuditRepositoryErrorCode =
  | "account_not_found"
  | "activity_conflict"
  | "audit_conflict"
  | "event_conflict"
  | "invalid_input"
  | "persistence_failure"
  | "stored_record_invalid";

const ERROR_MESSAGES: Readonly<Record<ActivityAuditRepositoryErrorCode, string>> = {
  account_not_found: "The activity or analytics event references an account that does not exist.",
  activity_conflict: "The activity event identifier is already assigned to different data.",
  audit_conflict: "The security audit identifier is already assigned to different data.",
  event_conflict: "The analytics event identifier is already assigned to different data.",
  invalid_input: "The activity or audit persistence input is invalid.",
  persistence_failure: "Activity or audit persistence could not be completed.",
  stored_record_invalid: "A stored activity or audit record is invalid.",
};

/** Stable, secret-free failures for service/HTTP mapping. */
export class ActivityAuditRepositoryError extends Error {
  readonly code: ActivityAuditRepositoryErrorCode;

  constructor(code: ActivityAuditRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ActivityAuditRepositoryError";
    this.code = code;
  }
}

export interface ActivityAuditCursor {
  createdAt: string;
  id: string;
}

export interface ActivityAuditPage<RecordType> {
  items: RecordType[];
  nextCursor: ActivityAuditCursor | null;
}

export interface ActivityAuditWriteResult<RecordType> {
  outcome: "inserted" | "duplicate";
  record: RecordType;
}

export interface UserActivityEventRecord {
  id: string;
  userId: string;
  eventType: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GeneralAnalyticsEventRecord {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  eventType: string;
  venueId: string | null;
  beerId: string | null;
  suburb: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Durable positive confirmation evidence. This is deliberately a signal-only
 * projection: callers must not treat it as public verification authority.
 */
export interface PositivePriceConfirmationEvidenceRecord {
  eventId: string;
  priceRecordId: string;
  priceVersion: string;
  venueId: string;
  beerId: string | null;
  suburb: string | null;
  sourceType: string;
  confirmedAt: string;
  verificationEffect: "signal_only";
}

export interface SecurityAuditLogRecord {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipHash: string | null;
  userAgentHash: string | null;
  createdAt: string;
}

export interface SecurityAuditFilters {
  action?: string | null | undefined;
  actorUserId?: string | null | undefined;
}

interface UserActivityRow {
  id: unknown;
  userId: unknown;
  eventType: unknown;
  relatedEntityType: unknown;
  relatedEntityId: unknown;
  metadataJson: unknown;
  createdAt: unknown;
}

interface GeneralEventRow {
  id: unknown;
  userId: unknown;
  anonymousSessionId: unknown;
  eventType: unknown;
  venueId: unknown;
  beerId: unknown;
  suburb: unknown;
  metadataJson: unknown;
  createdAt: unknown;
}

interface SecurityAuditRow {
  id: unknown;
  actorUserId: unknown;
  actorRole: unknown;
  action: unknown;
  targetType: unknown;
  targetId: unknown;
  metadataJson: unknown;
  ipHash: unknown;
  userAgentHash: unknown;
  createdAt: unknown;
}

interface MetadataBudget {
  nodes: number;
}

function repositoryError(code: ActivityAuditRepositoryErrorCode): never {
  throw new ActivityAuditRepositoryError(code);
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

function requireMachineName(value: unknown): string {
  const normalized = requireText(value, 160);
  if (!MACHINE_NAME.test(normalized)) return repositoryError("invalid_input");
  return normalized;
}

function persistedMachineName(value: unknown): string {
  const normalized = persistedText(value, 160);
  if (!MACHINE_NAME.test(normalized)) return repositoryError("stored_record_invalid");
  return normalized;
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

function optionalRequestHash(value: unknown): string | null {
  if (value == null) return null;
  const normalized = requireText(value, 64);
  if (!REQUEST_HASH.test(normalized)) return repositoryError("invalid_input");
  return normalized;
}

function optionalPersistedRequestHash(value: unknown): string | null {
  if (value == null) return null;
  const normalized = persistedText(value, 64);
  if (!REQUEST_HASH.test(normalized)) return repositoryError("stored_record_invalid");
  return normalized;
}

function requirePageSize(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return repositoryError("invalid_input");
  }
  return value as number;
}

function requireCursor(value: ActivityAuditCursor | null | undefined): ActivityAuditCursor | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return repositoryError("invalid_input");
  return {
    createdAt: requireCanonicalUtc(value.createdAt),
    id: requireText(value.id),
  };
}

function validateJsonValue(
  value: unknown,
  budget: MetadataBudget,
  depth: number,
  failure: "invalid_input" | "stored_record_invalid",
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) return repositoryError(failure);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return repositoryError(failure);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonValue(entry, budget, depth + 1, failure);
    return;
  }
  if (!value || typeof value !== "object") return repositoryError(failure);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return repositoryError(failure);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 120 || /[\r\n\0]/.test(key)) return repositoryError(failure);
    validateJsonValue(entry, budget, depth + 1, failure);
  }
}

function serializeMetadata(value: unknown): { serialized: string; metadata: Record<string, unknown> } {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return repositoryError("invalid_input");
    validateJsonValue(value, { nodes: 0 }, 0, "invalid_input");
    const rawSerialized = JSON.stringify(value);
    if (!rawSerialized || Buffer.byteLength(rawSerialized, "utf8") > MAX_METADATA_BYTES) {
      return repositoryError("invalid_input");
    }
    const serialized = JSON.stringify(redactSecrets(value));
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
      return repositoryError("invalid_input");
    }
    const metadata = JSON.parse(serialized) as unknown;
    validateJsonValue(metadata, { nodes: 0 }, 0, "invalid_input");
    return { serialized, metadata: metadata as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ActivityAuditRepositoryError) throw error;
    return repositoryError("invalid_input");
  }
}

function decodeMetadata(value: unknown): Record<string, unknown> {
  try {
    let parsed = value;
    if (typeof parsed === "string") {
      if (Buffer.byteLength(parsed, "utf8") > MAX_METADATA_BYTES) {
        return repositoryError("stored_record_invalid");
      }
      parsed = JSON.parse(parsed) as unknown;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return repositoryError("stored_record_invalid");
    }
    validateJsonValue(parsed, { nodes: 0 }, 0, "stored_record_invalid");
    const serialized = JSON.stringify(parsed);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
      return repositoryError("stored_record_invalid");
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ActivityAuditRepositoryError) throw error;
    return repositoryError("stored_record_invalid");
  }
}

function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function recordsMatch(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function safeCount(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return repositoryError("stored_record_invalid");
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return repositoryError("stored_record_invalid");
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) return repositoryError("stored_record_invalid");
  return Number(count);
}

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "23503" || code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

function toUserActivity(row: UserActivityRow): UserActivityEventRecord {
  return {
    id: persistedText(row.id),
    userId: persistedText(row.userId),
    eventType: persistedMachineName(row.eventType),
    relatedEntityType: row.relatedEntityType == null ? null : persistedMachineName(row.relatedEntityType),
    relatedEntityId: optionalPersistedText(row.relatedEntityId),
    metadata: decodeMetadata(row.metadataJson),
    createdAt: persistedCanonicalUtc(row.createdAt),
  };
}

function toGeneralEvent(row: GeneralEventRow): GeneralAnalyticsEventRecord {
  return {
    id: persistedText(row.id),
    userId: optionalPersistedText(row.userId),
    anonymousSessionId: optionalPersistedText(row.anonymousSessionId),
    eventType: persistedMachineName(row.eventType),
    venueId: optionalPersistedText(row.venueId),
    beerId: optionalPersistedText(row.beerId),
    suburb: optionalPersistedText(row.suburb, 160),
    metadata: decodeMetadata(row.metadataJson),
    createdAt: persistedCanonicalUtc(row.createdAt),
  };
}

function toPositivePriceConfirmationEvidence(
  row: GeneralEventRow,
): PositivePriceConfirmationEvidenceRecord {
  const event = toGeneralEvent(row);
  const priceRecordId = persistedText(event.metadata.priceRecordId, 512);
  const priceVersion = persistedText(event.metadata.priceVersion, 64);
  const sourceType = persistedText(event.metadata.sourceType);
  if (
    event.eventType !== "price_confirmation_answered"
    || event.userId === null
    || event.anonymousSessionId !== null
    || event.venueId === null
    || event.metadata.outcome !== "yes"
    || !PRICE_VERSION_FINGERPRINT.test(priceVersion)
  ) {
    return repositoryError("stored_record_invalid");
  }
  return {
    eventId: event.id,
    priceRecordId,
    priceVersion,
    venueId: event.venueId,
    beerId: event.beerId,
    suburb: event.suburb,
    sourceType,
    confirmedAt: event.createdAt,
    verificationEffect: "signal_only",
  };
}

function toSecurityAudit(row: SecurityAuditRow): SecurityAuditLogRecord {
  return {
    id: persistedText(row.id),
    actorUserId: optionalPersistedText(row.actorUserId),
    actorRole: row.actorRole == null ? null : persistedMachineName(row.actorRole),
    action: persistedMachineName(row.action),
    targetType: row.targetType == null ? null : persistedMachineName(row.targetType),
    targetId: optionalPersistedText(row.targetId),
    metadata: decodeMetadata(row.metadataJson),
    ipHash: optionalPersistedRequestHash(row.ipHash),
    userAgentHash: optionalPersistedRequestHash(row.userAgentHash),
    createdAt: persistedCanonicalUtc(row.createdAt),
  };
}

const USER_ACTIVITY_PROJECTION = `
  activity.id AS "id",
  activity.user_id AS "userId",
  activity.event_type AS "eventType",
  activity.related_entity_type AS "relatedEntityType",
  activity.related_entity_id AS "relatedEntityId",
  activity.metadata_json AS "metadataJson",
  activity.created_at AS "createdAt"`;

const GENERAL_EVENT_PROJECTION = `
  event.id AS "id",
  event.user_id AS "userId",
  event.anonymous_session_id AS "anonymousSessionId",
  event.event_type AS "eventType",
  event.venue_id AS "venueId",
  event.beer_id AS "beerId",
  event.suburb AS "suburb",
  event.metadata_json AS "metadataJson",
  event.created_at AS "createdAt"`;

const SECURITY_AUDIT_PROJECTION = `
  audit.id AS "id",
  audit.actor_user_id AS "actorUserId",
  audit.actor_role AS "actorRole",
  audit.action AS "action",
  audit.target_type AS "targetType",
  audit.target_id AS "targetId",
  audit.metadata_json AS "metadataJson",
  audit.ip_hash AS "ipHash",
  audit.user_agent_hash AS "userAgentHash",
  audit.created_at AS "createdAt"`;

/**
 * Async activity, analytics-event, and general security-audit persistence over
 * the shared SqlDatabase. Inserts are short idempotent transactions. This
 * repository performs no provider I/O, authorization, best-effort swallowing,
 * or privacy-scope deletion.
 */
export class ActivityAuditRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translateFailure<Result>(
    work: () => Promise<Result>,
    foreignKeyMeansMissingAccount = false,
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ActivityAuditRepositoryError) throw error;
      if (foreignKeyMeansMissingAccount && isForeignKeyViolation(error)) {
        throw new ActivityAuditRepositoryError("account_not_found");
      }
      throw new ActivityAuditRepositoryError("persistence_failure");
    }
  }

  private async userActivityById(id: string): Promise<UserActivityEventRecord | null> {
    const row = await this.database.prepare(
      `SELECT ${USER_ACTIVITY_PROJECTION}
         FROM user_activity_events activity WHERE activity.id = ?`,
    ).get<UserActivityRow>(id);
    return row ? toUserActivity(row) : null;
  }

  private async generalEventById(id: string): Promise<GeneralAnalyticsEventRecord | null> {
    const row = await this.database.prepare(
      `SELECT ${GENERAL_EVENT_PROJECTION}
         FROM events event WHERE event.id = ?`,
    ).get<GeneralEventRow>(id);
    return row ? toGeneralEvent(row) : null;
  }

  private async securityAuditById(id: string): Promise<SecurityAuditLogRecord | null> {
    const row = await this.database.prepare(
      `SELECT ${SECURITY_AUDIT_PROJECTION}
         FROM security_audit_log audit WHERE audit.id = ?`,
    ).get<SecurityAuditRow>(id);
    return row ? toSecurityAudit(row) : null;
  }

  async createUserActivityEvent(input: {
    id: string;
    userId: string;
    eventType: string;
    relatedEntityType: string | null;
    relatedEntityId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<ActivityAuditWriteResult<UserActivityEventRecord>> {
    const metadata = serializeMetadata(input.metadata);
    const expected: UserActivityEventRecord = {
      id: requireText(input.id),
      userId: requireText(input.userId),
      eventType: requireMachineName(input.eventType),
      relatedEntityType: input.relatedEntityType == null ? null : requireMachineName(input.relatedEntityType),
      relatedEntityId: optionalText(input.relatedEntityId),
      metadata: metadata.metadata,
      createdAt: requireCanonicalUtc(input.createdAt),
    };
    if ((expected.relatedEntityType === null) !== (expected.relatedEntityId === null)) {
      return repositoryError("invalid_input");
    }

    return this.translateFailure(this.database.transaction(async () => {
      const inserted = await this.database.prepare(
        `INSERT INTO user_activity_events (
           id, user_id, event_type, related_entity_type, related_entity_id, metadata_json, created_at
         ) VALUES (
           @id, @userId, @eventType, @relatedEntityType, @relatedEntityId, @metadataJson, @createdAt
         ) ON CONFLICT(id) DO NOTHING`,
      ).run({ ...expected, metadataJson: metadata.serialized });
      if (inserted.changes !== 0 && inserted.changes !== 1) return repositoryError("persistence_failure");
      const record = await this.userActivityById(expected.id);
      if (!record) return repositoryError("persistence_failure");
      if (!recordsMatch(record, expected)) return repositoryError("activity_conflict");
      return { outcome: inserted.changes === 1 ? "inserted" : "duplicate", record };
    }), true);
  }

  async getUserActivityEventById(id: string): Promise<UserActivityEventRecord | null> {
    const normalizedId = requireText(id);
    return this.translateFailure(() => this.userActivityById(normalizedId));
  }

  async listUserActivityEvents(input: {
    userId: string;
    limit: number;
    cursor?: ActivityAuditCursor | null | undefined;
  }): Promise<ActivityAuditPage<UserActivityEventRecord>> {
    const userId = requireText(input.userId);
    const limit = requirePageSize(input.limit, MAX_ACTIVITY_PAGE_SIZE);
    const cursor = requireCursor(input.cursor);
    const cursorClause = cursor
      ? `AND (
           activity.created_at < @cursorCreatedAt
           OR (activity.created_at = @cursorCreatedAt AND activity.id < @cursorId)
         )`
      : "";
    return this.translateFailure(async () => {
      const rows = await this.database.prepare(
        `SELECT ${USER_ACTIVITY_PROJECTION}
           FROM user_activity_events activity
          WHERE activity.user_id = @userId ${cursorClause}
          ORDER BY activity.created_at DESC, activity.id DESC
          LIMIT @fetchLimit`,
      ).all<UserActivityRow>({
        userId,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        fetchLimit: limit + 1,
      });
      const decoded = rows.map(toUserActivity);
      const hasMore = decoded.length > limit;
      const items = hasMore ? decoded.slice(0, limit) : decoded;
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async recordEvent(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    eventType: string;
    venueId: string | null;
    beerId: string | null;
    suburb: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<ActivityAuditWriteResult<GeneralAnalyticsEventRecord>> {
    const metadata = serializeMetadata(input.metadata);
    const rawBeerId = optionalText(input.beerId);
    const expected: GeneralAnalyticsEventRecord = {
      id: requireText(input.id),
      userId: optionalText(input.userId),
      anonymousSessionId: optionalText(input.anonymousSessionId),
      eventType: requireMachineName(input.eventType),
      venueId: optionalText(input.venueId),
      beerId: rawBeerId ? findTrackedBeerByName(rawBeerId)?.key ?? rawBeerId : null,
      suburb: optionalText(input.suburb, 160),
      metadata: metadata.metadata,
      createdAt: requireCanonicalUtc(input.createdAt),
    };

    return this.translateFailure(this.database.transaction(async () => {
      const inserted = await this.database.prepare(
        `INSERT INTO events (
           id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
           suburb, metadata_json, created_at
         ) VALUES (
           @id, @userId, @anonymousSessionId, @eventType, @venueId, @beerId,
           @suburb, @metadataJson, @createdAt
         ) ON CONFLICT(id) DO NOTHING`,
      ).run({ ...expected, metadataJson: metadata.serialized });
      if (inserted.changes !== 0 && inserted.changes !== 1) return repositoryError("persistence_failure");
      const record = await this.generalEventById(expected.id);
      if (!record) return repositoryError("persistence_failure");
      if (!recordsMatch(record, expected)) return repositoryError("event_conflict");
      return { outcome: inserted.changes === 1 ? "inserted" : "duplicate", record };
    }), expected.userId !== null);
  }

  /**
   * Records a caller-keyed event exactly once while preserving the timestamp
   * from the first successful writer. Retried or concurrent writes may supply
   * a later createdAt, but every other persisted field must match exactly.
   */
  async recordIdempotentEvent(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    eventType: string;
    venueId: string | null;
    beerId: string | null;
    suburb: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<ActivityAuditWriteResult<GeneralAnalyticsEventRecord>> {
    const metadata = serializeMetadata(input.metadata);
    const rawBeerId = optionalText(input.beerId);
    const expected: GeneralAnalyticsEventRecord = {
      id: requireText(input.id),
      userId: optionalText(input.userId),
      anonymousSessionId: optionalText(input.anonymousSessionId),
      eventType: requireMachineName(input.eventType),
      venueId: optionalText(input.venueId),
      beerId: rawBeerId ? findTrackedBeerByName(rawBeerId)?.key ?? rawBeerId : null,
      suburb: optionalText(input.suburb, 160),
      metadata: metadata.metadata,
      createdAt: requireCanonicalUtc(input.createdAt),
    };

    return this.translateFailure(this.database.transaction(async () => {
      const inserted = await this.database.prepare(
        `INSERT INTO events (
           id, user_id, anonymous_session_id, event_type, venue_id, beer_id,
           suburb, metadata_json, created_at
         ) VALUES (
           @id, @userId, @anonymousSessionId, @eventType, @venueId, @beerId,
           @suburb, @metadataJson, @createdAt
         ) ON CONFLICT(id) DO NOTHING`,
      ).run({ ...expected, metadataJson: metadata.serialized });
      if (inserted.changes !== 0 && inserted.changes !== 1) return repositoryError("persistence_failure");
      const record = await this.generalEventById(expected.id);
      if (!record) return repositoryError("persistence_failure");
      const { createdAt: _recordedAt, ...recordStableFields } = record;
      const { createdAt: _requestedAt, ...expectedStableFields } = expected;
      if (!recordsMatch(recordStableFields, expectedStableFields)) return repositoryError("event_conflict");
      return { outcome: inserted.changes === 1 ? "inserted" : "duplicate", record };
    }), expected.userId !== null);
  }

  /**
   * Lists the newest still-positive ordinary-account signal for each requested
   * price-record/version pair. `since` is exclusive and `asOf` is inclusive.
   * A later No from the same account suppresses that account's earlier Yes;
   * neither this read nor the underlying event changes public trust/freshness.
   */
  async listLatestPositivePriceConfirmations(input: {
    priceRecordIds: readonly string[];
    since: string;
    asOf: string;
    limit?: number | undefined;
  }): Promise<PositivePriceConfirmationEvidenceRecord[]> {
    if (!Array.isArray(input.priceRecordIds)) return repositoryError("invalid_input");
    const priceRecordIds = Array.from(new Set(
      input.priceRecordIds.map((priceRecordId) => requireText(priceRecordId, 512)),
    ));
    if (priceRecordIds.length > MAX_PRICE_CONFIRMATION_RECORD_IDS) {
      return repositoryError("invalid_input");
    }
    const since = requireCanonicalUtc(input.since);
    const asOf = requireCanonicalUtc(input.asOf);
    if (since > asOf) return repositoryError("invalid_input");
    const limit = requirePageSize(
      input.limit ?? MAX_PRICE_CONFIRMATION_RECORD_IDS,
      MAX_PRICE_CONFIRMATION_RECORD_IDS,
    );
    if (priceRecordIds.length === 0 || since === asOf) return [];

    const priceRecordBindings = Object.fromEntries(
      priceRecordIds.map((priceRecordId, index) => [`priceRecordId${index}`, priceRecordId]),
    );
    const priceRecordPlaceholders = priceRecordIds
      .map((_, index) => `@priceRecordId${index}`)
      .join(", ");

    return this.translateFailure(async () => {
      const rows = await this.database.prepare(
        `WITH "positive_candidates" AS (
           SELECT event.*
             FROM events event
            WHERE event.event_type = 'price_confirmation_answered'
              AND event.user_id IS NOT NULL
              AND event.anonymous_session_id IS NULL
              AND event.created_at > @since
              AND event.created_at <= @asOf
              AND json_extract(event.metadata_json, '$.outcome') = 'yes'
              AND json_extract(event.metadata_json, '$.priceRecordId') IN (${priceRecordPlaceholders})
              AND NOT EXISTS (
                SELECT 1
                  FROM events later_answer
                 WHERE later_answer.event_type = 'price_confirmation_answered'
                   AND later_answer.user_id = event.user_id
                   AND later_answer.anonymous_session_id IS NULL
                   AND later_answer.created_at >= event.created_at
                   AND later_answer.created_at <= @asOf
                   AND json_extract(later_answer.metadata_json, '$.outcome') = 'no'
                   AND json_extract(later_answer.metadata_json, '$.priceRecordId') =
                       json_extract(event.metadata_json, '$.priceRecordId')
                   AND json_extract(later_answer.metadata_json, '$.priceVersion') =
                       json_extract(event.metadata_json, '$.priceVersion')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM wrong_price_reports report
                 WHERE report.user_id = event.user_id
                   AND (
                     report.price_record_id = json_extract(event.metadata_json, '$.priceRecordId')
                     OR (
                       report.price_record_id IS NULL
                       AND json_extract(event.metadata_json, '$.priceRecordId') LIKE 'bar_beer:%'
                       AND report.venue_id = event.venue_id
                       AND report.beer_name = json_extract(event.metadata_json, '$.beerName')
                       AND report.reason = 'price_changed'
                     )
                   )
                   AND report.status <> 'rejected'
                   AND report.created_at >= event.created_at
                   AND report.created_at <= @asOf
              )
         ), "ranked_confirmations" AS (
           SELECT candidate.*,
                  row_number() OVER (
                    PARTITION BY json_extract(candidate.metadata_json, '$.priceRecordId'),
                                 json_extract(candidate.metadata_json, '$.priceVersion')
                    ORDER BY candidate.created_at DESC, candidate.id DESC
                  ) AS confirmation_rank
             FROM "positive_candidates" candidate
         )
         SELECT ${GENERAL_EVENT_PROJECTION}
           FROM "ranked_confirmations" event
          WHERE event.confirmation_rank = 1
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT @limit`,
      ).all<GeneralEventRow>({
        ...priceRecordBindings,
        since,
        asOf,
        limit,
      });
      return rows.map(toPositivePriceConfirmationEvidence);
    });
  }

  async insertSecurityAuditLog(input: {
    id: string;
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    ipHash: string | null;
    userAgentHash: string | null;
    createdAt: string;
  }): Promise<ActivityAuditWriteResult<SecurityAuditLogRecord>> {
    const metadata = serializeMetadata(input.metadata);
    const expected: SecurityAuditLogRecord = {
      id: requireText(input.id),
      actorUserId: optionalText(input.actorUserId),
      actorRole: input.actorRole == null ? null : requireMachineName(input.actorRole),
      action: requireMachineName(input.action),
      targetType: input.targetType == null ? null : requireMachineName(input.targetType),
      targetId: optionalText(input.targetId),
      metadata: metadata.metadata,
      ipHash: optionalRequestHash(input.ipHash),
      userAgentHash: optionalRequestHash(input.userAgentHash),
      createdAt: requireCanonicalUtc(input.createdAt),
    };
    if (expected.actorUserId === null && expected.actorRole !== null) return repositoryError("invalid_input");

    return this.translateFailure(this.database.transaction(async () => {
      const inserted = await this.database.prepare(
        `INSERT INTO security_audit_log (
           id, actor_user_id, actor_role, action, target_type, target_id,
           metadata_json, ip_hash, user_agent_hash, created_at
         ) VALUES (
           @id, @actorUserId, @actorRole, @action, @targetType, @targetId,
           @metadataJson, @ipHash, @userAgentHash, @createdAt
         ) ON CONFLICT(id) DO NOTHING`,
      ).run({ ...expected, metadataJson: metadata.serialized });
      if (inserted.changes !== 0 && inserted.changes !== 1) return repositoryError("persistence_failure");
      const record = await this.securityAuditById(expected.id);
      if (!record) return repositoryError("persistence_failure");
      if (!recordsMatch(record, expected)) return repositoryError("audit_conflict");
      return { outcome: inserted.changes === 1 ? "inserted" : "duplicate", record };
    }));
  }

  private securityFilters(input: SecurityAuditFilters): {
    action: string | null;
    actorUserId: string | null;
  } {
    return {
      action: input.action == null ? null : requireMachineName(input.action),
      actorUserId: optionalText(input.actorUserId),
    };
  }

  async listSecurityAuditLogs(input: SecurityAuditFilters & {
    limit: number;
    cursor?: ActivityAuditCursor | null | undefined;
  }): Promise<ActivityAuditPage<SecurityAuditLogRecord>> {
    const limit = requirePageSize(input.limit, MAX_AUDIT_PAGE_SIZE);
    const cursor = requireCursor(input.cursor);
    const filters = this.securityFilters(input);
    const clauses: string[] = [];
    if (filters.action !== null) clauses.push("audit.action = @action");
    if (filters.actorUserId !== null) clauses.push("audit.actor_user_id = @actorUserId");
    if (cursor) {
      clauses.push(`(
        audit.created_at < @cursorCreatedAt
        OR (audit.created_at = @cursorCreatedAt AND audit.id < @cursorId)
      )`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.translateFailure(async () => {
      const rows = await this.database.prepare(
        `SELECT ${SECURITY_AUDIT_PROJECTION}
           FROM security_audit_log audit
          ${where}
          ORDER BY audit.created_at DESC, audit.id DESC
          LIMIT @fetchLimit`,
      ).all<SecurityAuditRow>({
        ...filters,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        fetchLimit: limit + 1,
      });
      const decoded = rows.map(toSecurityAudit);
      const hasMore = decoded.length > limit;
      const items = hasMore ? decoded.slice(0, limit) : decoded;
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async countSecurityAuditLogs(input: SecurityAuditFilters = {}): Promise<number> {
    const filters = this.securityFilters(input);
    const clauses: string[] = [];
    if (filters.action !== null) clauses.push("audit.action = @action");
    if (filters.actorUserId !== null) clauses.push("audit.actor_user_id = @actorUserId");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.translateFailure(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count" FROM security_audit_log audit ${where}`,
      ).get<{ count: unknown }>({ ...filters });
      if (!row) return repositoryError("persistence_failure");
      return safeCount(row.count);
    });
  }

  /** Exact rate-limit read used by the venue-manager delete workflow. */
  async countRecentVenueManagerDeletes(input: {
    venueId: string;
    since: string;
    changeType?: string | null | undefined;
  }): Promise<number> {
    const venueId = requireText(input.venueId);
    const since = requireCanonicalUtc(input.since);
    const changeType = input.changeType == null ? null : requireMachineName(input.changeType);
    const venueExpression = this.database.dialect === "postgres"
      ? "audit.metadata_json ->> 'venueId'"
      : "CASE WHEN json_valid(audit.metadata_json) THEN json_extract(audit.metadata_json, '$.venueId') ELSE NULL END";
    const changeTypeExpression = this.database.dialect === "postgres"
      ? "audit.metadata_json ->> 'changeType'"
      : "CASE WHEN json_valid(audit.metadata_json) THEN json_extract(audit.metadata_json, '$.changeType') ELSE NULL END";
    const changeTypeClause = changeType === null ? "" : `AND ${changeTypeExpression} = @changeType`;
    return this.translateFailure(async () => {
      const row = await this.database.prepare(
        `SELECT count(*) AS "count"
           FROM security_audit_log audit
          WHERE audit.action = 'venue_manager_delete'
            AND audit.created_at >= @since
            AND ${venueExpression} = @venueId
            ${changeTypeClause}`,
      ).get<{ count: unknown }>({ venueId, since, changeType });
      if (!row) return repositoryError("persistence_failure");
      return safeCount(row.count);
    });
  }
}
