import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ID_LENGTH = 255;
// Supabase Storage currently caps object names at 1,024 bytes and the path is
// also covered by a PostgreSQL btree uniqueness constraint. Restricting this
// API to safe ASCII makes the character and byte limits identical.
const MAX_OBJECT_PATH_LENGTH = 1_024;
const MAX_MIME_TYPE_LENGTH = 160;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4;
const MAX_RETENTION_MS = 10 * 366 * 24 * 60 * 60 * 1_000;

const STORAGE_PROVIDERS = [
  "sqlite_private",
  "filesystem_private",
  "supabase_private",
] as const;
const MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export type SourceEvidenceStorageProvider = typeof STORAGE_PROVIDERS[number];

export const SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT = Object.freeze({
  version: 1,
  accountPrefix: "source-evidence:account:",
  keyOrder: "distinct-lexicographic-ascending",
  hashFunction: "pg_catalog.hashtext",
  lockFunction: "pg_catalog.pg_advisory_xact_lock",
  order: "sorted-transaction-advisory-locks-before-account-row-before-source-evidence-row",
  deletionCoordination:
    "account-deletion-and-account-privacy-mutations-must-acquire-the-same-account-key-before-account-or-evidence-rows",
} as const);

export type SourceEvidenceObjectRepositoryErrorCode =
  | "account_ineligible"
  | "account_not_found"
  | "deletion_locked"
  | "evidence_conflict"
  | "invalid_input"
  | "malformed_record"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<SourceEvidenceObjectRepositoryErrorCode, string>> = {
  account_ineligible: "The source-evidence owner is not eligible to register evidence.",
  account_not_found: "The source-evidence owner account does not exist.",
  deletion_locked: "Source evidence cannot be registered while account deletion is being processed.",
  evidence_conflict: "The source-evidence identity conflicts with an existing record.",
  invalid_input: "The source-evidence persistence input is invalid.",
  malformed_record: "The stored source-evidence record is malformed.",
  persistence_failure: "Source-evidence persistence could not be completed.",
};

/** Stable, deliberately detail-free failures for future service/HTTP mapping. */
export class SourceEvidenceObjectRepositoryError extends Error {
  readonly code: SourceEvidenceObjectRepositoryErrorCode;

  constructor(code: SourceEvidenceObjectRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SourceEvidenceObjectRepositoryError";
    this.code = code;
  }
}

export interface SourceEvidenceObject {
  id: string;
  ownerUserId: string | null;
  storageProvider: SourceEvidenceStorageProvider;
  objectPath: string;
  mimeType: string;
  /** Cleared only after a valid retention/deletion tombstone is recorded. */
  byteSize: number | null;
  dataBase64: string | null;
  externalUrl: null;
  retentionExpiresAt: string;
  deletedAt: string | null;
  createdAt: string;
}

export interface RegisterSourceEvidenceObjectInput {
  id: string;
  ownerUserId: string | null;
  storageProvider: SourceEvidenceStorageProvider;
  objectPath: string;
  mimeType: string;
  byteSize: number;
  dataBase64: string | null;
  externalUrl: null;
  retentionExpiresAt: string;
  createdAt: string;
}

export interface RegisterSourceEvidenceObjectResult {
  state: "created" | "replayed";
  object: SourceEvidenceObject;
}

interface EvidenceRow {
  id: unknown;
  ownerUserId: unknown;
  storageProvider: unknown;
  objectPath: unknown;
  mimeType: unknown;
  byteSize: unknown;
  dataBase64: unknown;
  externalUrl: unknown;
  retentionExpiresAt: unknown;
  deletedAt: unknown;
  createdAt: unknown;
}

interface AccountEligibilityRow {
  id: unknown;
  status: unknown;
  authProvider: unknown;
  deletionLocked: unknown;
}

const EVIDENCE_PROJECTION = `
  evidence.id AS "id",
  evidence.owner_user_id AS "ownerUserId",
  evidence.storage_provider AS "storageProvider",
  evidence.object_path AS "objectPath",
  evidence.mime_type AS "mimeType",
  evidence.byte_size AS "byteSize",
  evidence.data_base64 AS "dataBase64",
  evidence.external_url AS "externalUrl",
  evidence.retention_expires_at AS "retentionExpiresAt",
  evidence.deleted_at AS "deletedAt",
  evidence.created_at AS "createdAt"`;

function fail(code: SourceEvidenceObjectRepositoryErrorCode): never {
  throw new SourceEvidenceObjectRepositoryError(code);
}

function inputText(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    return fail("invalid_input");
  }
  return normalized;
}

function recordText(value: unknown, maximum = MAX_ID_LENGTH): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\0\r\n]/.test(value)
  ) {
    return fail("malformed_record");
  }
  return value;
}

function optionalRecordText(value: unknown, maximum = MAX_ID_LENGTH): string | null {
  return value === null ? null : recordText(value, maximum);
}

function canonicalTimestamp(value: unknown, source: "input" | "record"): string {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  if (typeof value !== "string") return invalid();
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) return invalid();
    return value;
  } catch {
    return invalid();
  }
}

function optionalRecordTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value, "record");
}

function safeByteSize(value: unknown, source: "input" | "record"): number {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  if (typeof value !== "number" && typeof value !== "string") return invalid();
  if (typeof value === "string" && !/^\d+$/.test(value)) return invalid();
  let exact: bigint;
  try {
    exact = typeof value === "number" ? BigInt(value) : BigInt(value);
  } catch {
    return invalid();
  }
  if (
    (typeof value === "number" && !Number.isSafeInteger(value))
    || exact < 1n
    || exact > BigInt(MAX_EVIDENCE_BYTES)
  ) return invalid();
  return Number(exact);
}

function storageProvider(value: unknown, source: "input" | "record"): SourceEvidenceStorageProvider {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  if (typeof value !== "string" || !(STORAGE_PROVIDERS as readonly string[]).includes(value)) return invalid();
  return value as SourceEvidenceStorageProvider;
}

function mimeType(value: unknown, source: "input" | "record"): string {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  const normalized = source === "input"
    ? (typeof value === "string" ? value.trim().toLowerCase() : "")
    : typeof value === "string" ? value : "";
  if (
    !normalized
    || normalized.length > MAX_MIME_TYPE_LENGTH
    || !MIME_TYPES.has(normalized)
    || /[\0\r\n]/.test(normalized)
  ) return invalid();
  return normalized;
}

function objectPath(value: unknown, source: "input" | "record"): string {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  const normalized = source === "input" && typeof value === "string" ? value.trim() : value;
  if (
    typeof normalized !== "string"
    || !normalized
    || normalized.length > MAX_OBJECT_PATH_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
    || /[\0\r\n\\?#]/.test(normalized)
    || normalized.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) return invalid();
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return invalid();
  return normalized;
}

function canonicalBase64(value: unknown, source: "input" | "record"): string {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_BASE64_LENGTH
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return invalid();
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) return invalid();
  return value;
}

function assertRetention(createdAt: string, retentionExpiresAt: string, source: "input" | "record"): void {
  const invalid = () => source === "input" ? fail("invalid_input") : fail("malformed_record");
  const duration = Date.parse(retentionExpiresAt) - Date.parse(createdAt);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_RETENTION_MS) invalid();
}

function normalizeInput(input: RegisterSourceEvidenceObjectInput): RegisterSourceEvidenceObjectInput {
  if (!input || typeof input !== "object") return fail("invalid_input");
  const normalizedProvider = storageProvider(input.storageProvider, "input");
  const normalizedByteSize = safeByteSize(input.byteSize, "input");
  const normalizedCreatedAt = canonicalTimestamp(input.createdAt, "input");
  const normalizedRetentionExpiresAt = canonicalTimestamp(input.retentionExpiresAt, "input");
  assertRetention(normalizedCreatedAt, normalizedRetentionExpiresAt, "input");
  if (input.externalUrl !== null) fail("invalid_input");
  let dataBase64: string | null = null;
  if (normalizedProvider === "sqlite_private") {
    dataBase64 = canonicalBase64(input.dataBase64, "input");
    if (Buffer.byteLength(dataBase64, "base64") !== normalizedByteSize) fail("invalid_input");
  } else if (input.dataBase64 !== null) {
    fail("invalid_input");
  }
  return {
    id: inputText(input.id),
    ownerUserId: input.ownerUserId === null ? null : inputText(input.ownerUserId),
    storageProvider: normalizedProvider,
    objectPath: objectPath(input.objectPath, "input"),
    mimeType: mimeType(input.mimeType, "input"),
    byteSize: normalizedByteSize,
    dataBase64,
    externalUrl: null,
    retentionExpiresAt: normalizedRetentionExpiresAt,
    createdAt: normalizedCreatedAt,
  };
}

function decodeRow(row: EvidenceRow): SourceEvidenceObject {
  const provider = storageProvider(row.storageProvider, "record");
  const createdAt = canonicalTimestamp(row.createdAt, "record");
  const retentionExpiresAt = canonicalTimestamp(row.retentionExpiresAt, "record");
  assertRetention(createdAt, retentionExpiresAt, "record");
  if (row.externalUrl !== null) fail("malformed_record");
  const deletedAt = optionalRecordTimestamp(row.deletedAt);
  if (deletedAt && deletedAt < createdAt) fail("malformed_record");
  let bytes: number | null;
  let dataBase64: string | null = null;
  if (deletedAt) {
    // Both retention owners clear the payload and byte count but retain the
    // immutable provider/path/MIME/retention lineage as a valid tombstone.
    if (row.byteSize !== null || row.dataBase64 !== null) fail("malformed_record");
    bytes = null;
  } else {
    bytes = safeByteSize(row.byteSize, "record");
    if (provider === "sqlite_private") {
      dataBase64 = canonicalBase64(row.dataBase64, "record");
      if (Buffer.byteLength(dataBase64, "base64") !== bytes) fail("malformed_record");
    } else if (row.dataBase64 !== null) {
      fail("malformed_record");
    }
  }
  return {
    id: recordText(row.id),
    ownerUserId: optionalRecordText(row.ownerUserId),
    storageProvider: provider,
    objectPath: objectPath(row.objectPath, "record"),
    mimeType: mimeType(row.mimeType, "record"),
    byteSize: bytes,
    dataBase64,
    externalUrl: null,
    retentionExpiresAt,
    deletedAt,
    createdAt,
  };
}

function exactReplay(record: SourceEvidenceObject, input: RegisterSourceEvidenceObjectInput): boolean {
  return record.deletedAt === null
    && record.id === input.id
    && record.ownerUserId === input.ownerUserId
    && record.storageProvider === input.storageProvider
    && record.objectPath === input.objectPath
    && record.mimeType === input.mimeType
    && record.byteSize === input.byteSize
    && record.dataBase64 === input.dataBase64
    && record.externalUrl === input.externalUrl
    && record.retentionExpiresAt === input.retentionExpiresAt
    && record.createdAt === input.createdAt;
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("persistence_failure");
}

export function sourceEvidenceAccountLockKey(accountId: string): string {
  return `${SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT.accountPrefix}${inputText(accountId)}`;
}

/**
 * Provider-free persistence for private source-evidence metadata and optional
 * development-only inline bytes. Storage upload/delete/read calls must happen
 * outside this repository and outside its short transaction.
 *
 * Deletion coordination is intentionally cooperative until every deletion and
 * privacy transition also acquires `sourceEvidenceAccountLockKey(userId)`.
 */
export class SourceEvidenceObjectRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async translate<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SourceEvidenceObjectRepositoryError) throw error;
      throw new SourceEvidenceObjectRepositoryError("persistence_failure");
    }
  }

  private lockSuffix(alias: string): string {
    return this.database.dialect === "postgres" ? ` FOR UPDATE OF ${alias}` : "";
  }

  private async advisoryLocks(keys: readonly string[]): Promise<void> {
    if (this.database.dialect !== "postgres") return;
    for (const key of Array.from(new Set(keys)).sort()) {
      await this.database.prepare(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(?)) AS \"locked\"",
      ).get(key);
    }
  }

  private async assertEligibleOwner(ownerUserId: string): Promise<void> {
    const row = await this.database.prepare(
      `SELECT account.id AS "id",
              account.status AS "status",
              account.auth_provider AS "authProvider",
              EXISTS (
                SELECT 1 FROM account_deletion_requests deletion
                 WHERE deletion.user_id = account.id
                   AND deletion.status IN ('processing', 'failed', 'completed')
              ) AS "deletionLocked"
         FROM accounts account
        WHERE account.id = ?${this.lockSuffix("account")}`,
    ).get<AccountEligibilityRow>(ownerUserId);
    if (!row) fail("account_not_found");
    if (recordText(row.id) !== ownerUserId) fail("persistence_failure");
    const authProvider = recordText(row.authProvider, 64);
    const status = recordText(row.status, 32);
    if (!(["active", "warned", "suspended"] as const).includes(
      status as "active" | "warned" | "suspended",
    )) fail("malformed_record");
    if (authProvider === "deleted") fail("deletion_locked");
    if (status === "suspended") {
      fail("account_ineligible");
    }
    if (recordBoolean(row.deletionLocked)) fail("deletion_locked");
  }

  private async evidenceById(id: string, lock = false): Promise<SourceEvidenceObject | null> {
    const row = await this.database.prepare(
      `SELECT ${EVIDENCE_PROJECTION}
         FROM source_evidence_objects evidence
        WHERE evidence.id = ?${lock ? this.lockSuffix("evidence") : ""}`,
    ).get<EvidenceRow>(id);
    return row ? decodeRow(row) : null;
  }

  private async evidenceByPath(path: string, lock = false): Promise<SourceEvidenceObject | null> {
    const row = await this.database.prepare(
      `SELECT ${EVIDENCE_PROJECTION}
         FROM source_evidence_objects evidence
        WHERE evidence.object_path = ?${lock ? this.lockSuffix("evidence") : ""}`,
    ).get<EvidenceRow>(path);
    return row ? decodeRow(row) : null;
  }

  async getSourceEvidenceObject(id: string): Promise<SourceEvidenceObject | null> {
    const normalizedId = inputText(id);
    return this.translate(() => this.evidenceById(normalizedId));
  }

  async registerSourceEvidenceObject(
    input: RegisterSourceEvidenceObjectInput,
  ): Promise<RegisterSourceEvidenceObjectResult> {
    const normalized = normalizeInput(input);
    return this.translate(this.database.transaction(async () => {
      if (normalized.ownerUserId) {
        await this.advisoryLocks([sourceEvidenceAccountLockKey(normalized.ownerUserId)]);
        await this.assertEligibleOwner(normalized.ownerUserId);
      }

      const inserted = await this.database.prepare(
        `INSERT OR IGNORE INTO source_evidence_objects (
           id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
           data_base64, external_url, retention_expires_at, deleted_at, created_at
         ) VALUES (
           @id, @ownerUserId, @storageProvider, @objectPath, @mimeType, @byteSize,
           @dataBase64, NULL, @retentionExpiresAt, NULL, @createdAt
         )`,
      ).run(normalized);

      const byId = await this.evidenceById(normalized.id, true);
      if (inserted.changes === 1) {
        if (!byId || !exactReplay(byId, normalized)) fail("persistence_failure");
        return { state: "created", object: byId };
      }
      if (byId) {
        if (!exactReplay(byId, normalized)) fail("evidence_conflict");
        return { state: "replayed", object: byId };
      }
      const byPath = await this.evidenceByPath(normalized.objectPath, true);
      if (byPath) fail("evidence_conflict");
      return fail("persistence_failure");
    }));
  }
}
