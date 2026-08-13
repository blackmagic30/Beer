import { randomUUID } from "node:crypto";

import type { SqlDatabase } from "./sql-database.js";

const MAX_KEY_LENGTH = 255;
const MAX_OWNER_LENGTH = 255;
const MAX_LEASE_TOKEN_LENGTH = 255;
const MAX_REVISION_LENGTH = 512;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SystemStateRecord<T extends object = Record<string, unknown>> {
  value: T;
  updatedAt: string;
  revision: string;
}

export interface SystemLeaseValue {
  owner: string;
  leaseToken: string;
  leaseUntil: string;
  acquiredAt?: string;
  releasedAt?: string;
}

export interface AcquireSystemLeaseInput {
  key: string;
  owner: string;
  leaseToken: string;
  now: string;
  leaseUntil: string;
}

export interface ReleaseSystemLeaseInput {
  key: string;
  owner: string;
  leaseToken: string;
  now: string;
}

interface SystemStateRow {
  valueJson: unknown;
  updatedAt: unknown;
  revision: unknown;
}

const getSystemState = `/* system-state:get */
  SELECT value_json AS "valueJson",
         updated_at AS "updatedAt",
         revision
    FROM system_state
   WHERE key = @key`;

const setSystemState = `/* system-state:set */
  INSERT INTO system_state (key, value_json, updated_at, revision)
  VALUES (@key, @valueJson, @now, @revision)
  ON CONFLICT (key) DO UPDATE
     SET value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         revision = excluded.revision
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const createSystemState = `/* system-state:compare-and-set-create */
  INSERT INTO system_state (key, value_json, updated_at, revision)
  VALUES (@key, @valueJson, @now, @revision)
  ON CONFLICT (key) DO NOTHING
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const updateSystemState = `/* system-state:compare-and-set-update */
  UPDATE system_state
     SET value_json = @valueJson,
         updated_at = @now,
         revision = @revision
   WHERE key = @key
     AND revision = @expectedRevision
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const acquirePostgresSystemLease = `/* system-state:acquire-lease:postgres */
  INSERT INTO system_state (key, value_json, updated_at, revision)
  VALUES (@key, @valueJson::jsonb, @now::timestamptz, @revision)
  ON CONFLICT (key) DO UPDATE
     SET value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         revision = excluded.revision
   WHERE jsonb_typeof(system_state.value_json) = 'object'
     AND CASE
       WHEN system_state.value_json -> 'leaseUntil' IS NULL THEN TRUE
       WHEN jsonb_typeof(system_state.value_json -> 'leaseUntil') <> 'string' THEN FALSE
       WHEN (system_state.value_json ->> 'leaseUntil')
              !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
         THEN FALSE
       WHEN NOT pg_input_is_valid(
         system_state.value_json ->> 'leaseUntil',
         'timestamp with time zone'
       ) THEN FALSE
       ELSE (system_state.value_json ->> 'leaseUntil')::timestamptz <= @now::timestamptz
     END
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const releasePostgresSystemLease = `/* system-state:release-lease:postgres */
  UPDATE system_state
     SET value_json = @valueJson::jsonb,
         updated_at = @now::timestamptz,
         revision = @revision
   WHERE key = @key
     AND jsonb_typeof(value_json) = 'object'
     AND jsonb_typeof(value_json -> 'owner') = 'string'
     AND jsonb_typeof(value_json -> 'leaseToken') = 'string'
     AND value_json ->> 'owner' = @owner
     AND value_json ->> 'leaseToken' = @leaseToken
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const acquireSqliteSystemLease = `/* system-state:acquire-lease:sqlite */
  INSERT INTO system_state (key, value_json, updated_at, revision)
  VALUES (@key, @valueJson, @now, @revision)
  ON CONFLICT (key) DO UPDATE
     SET value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         revision = excluded.revision
   WHERE CASE
     WHEN json_valid(system_state.value_json) <> 1 THEN 0
     WHEN json_type(system_state.value_json) <> 'object' THEN 0
     WHEN json_type(system_state.value_json, '$.leaseUntil') IS NULL THEN 1
     WHEN json_type(system_state.value_json, '$.leaseUntil') <> 'text' THEN 0
     WHEN length(json_extract(system_state.value_json, '$.leaseUntil')) <> 24 THEN 0
     WHEN json_extract(system_state.value_json, '$.leaseUntil') NOT GLOB
       '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
       THEN 0
     WHEN strftime(
       '%Y-%m-%dT%H:%M:%fZ',
       json_extract(system_state.value_json, '$.leaseUntil')
     ) IS NULL THEN 0
     WHEN strftime(
       '%Y-%m-%dT%H:%M:%fZ',
       json_extract(system_state.value_json, '$.leaseUntil')
     ) <> json_extract(system_state.value_json, '$.leaseUntil') THEN 0
     ELSE json_extract(system_state.value_json, '$.leaseUntil') <= @now
   END = 1
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

const releaseSqliteSystemLease = `/* system-state:release-lease:sqlite */
  UPDATE system_state
     SET value_json = @valueJson,
         updated_at = @now,
         revision = @revision
   WHERE key = @key
     AND CASE
       WHEN json_valid(value_json) <> 1 THEN 0
       WHEN json_type(value_json) <> 'object' THEN 0
       WHEN json_type(value_json, '$.owner') <> 'text' THEN 0
       WHEN json_type(value_json, '$.leaseToken') <> 'text' THEN 0
       ELSE json_extract(value_json, '$.owner') = @owner
        AND json_extract(value_json, '$.leaseToken') = @leaseToken
     END = 1
  RETURNING value_json AS "valueJson",
            updated_at AS "updatedAt",
            revision`;

export const systemStateRepositoryQueries = Object.freeze({
  getSystemState,
  setSystemState,
  createSystemState,
  updateSystemState,
  acquirePostgresSystemLease,
  releasePostgresSystemLease,
  acquireSqliteSystemLease,
  releaseSqliteSystemLease,
});

function assertBoundedValue(label: string, value: string, maximumLength: number): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `${label} must be a trimmed, non-empty value of at most ${maximumLength} characters without control characters.`,
    );
  }
}

function assertCanonicalTimestamp(label: string, value: string): void {
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      throw new Error("non-canonical");
    }
  } catch {
    throw new Error(`${label} must be a canonical UTC ISO timestamp with millisecond precision.`);
  }
}

function canonicalJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("System state JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("System state values must contain only JSON-compatible values.");
  }
  if (ancestors.has(value)) throw new Error("System state values must not contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error("System state JSON arrays must not contain sparse entries.");
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("System state values must use plain JSON objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("System state values must not contain symbol keys.");
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
        ancestors,
      )}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeJsonObject(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("System state value must be a JSON object.");
  }
  const serialized = canonicalJson(value);
  if (!serialized.startsWith("{")) throw new Error("System state value must be a JSON object.");
  return serialized;
}

function parseJsonObject<T extends object>(value: unknown): T {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("system_state contains invalid JSON.");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("system_state must contain a JSON object.");
  }
  // Re-serialize object-valued adapter results so alternate pg adapters cannot
  // return class instances, sparse arrays, cycles, or non-JSON values.
  return JSON.parse(serializeJsonObject(parsed)) as T;
}

function normalizeSystemStateRow<T extends object>(row: SystemStateRow): SystemStateRecord<T> {
  if (typeof row.updatedAt !== "string") {
    throw new Error("system_state returned an invalid updated_at value.");
  }
  assertCanonicalTimestamp("system_state.updated_at", row.updatedAt);
  if (typeof row.revision !== "string") {
    throw new Error("system_state returned an invalid revision.");
  }
  assertBoundedValue("system_state.revision", row.revision, MAX_REVISION_LENGTH);
  return {
    value: parseJsonObject<T>(row.valueJson),
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

function createRevision(now: string): string {
  return `${now}#${randomUUID()}`;
}

export class SystemStateRepository {
  constructor(private readonly database: SqlDatabase) {}

  async get<T extends object = Record<string, unknown>>(
    key: string,
  ): Promise<SystemStateRecord<T> | null> {
    assertBoundedValue("key", key, MAX_KEY_LENGTH);
    const row = await this.database
      .prepare(systemStateRepositoryQueries.getSystemState)
      .get<SystemStateRow>({ key });
    return row ? normalizeSystemStateRow<T>(row) : null;
  }

  async set<T extends object>(
    key: string,
    value: T,
    now: string,
  ): Promise<SystemStateRecord<T>> {
    assertBoundedValue("key", key, MAX_KEY_LENGTH);
    assertCanonicalTimestamp("now", now);
    const revision = createRevision(now);
    const row = await this.database
      .prepare(systemStateRepositoryQueries.setSystemState)
      .get<SystemStateRow>({
        key,
        valueJson: serializeJsonObject(value),
        now,
        revision,
      });
    if (!row) throw new Error("System state write did not return its persisted record.");
    return this.normalizeMutation<T>(row, now, revision);
  }

  async compareAndSet<T extends object>(
    key: string,
    expectedRevision: string | null,
    value: T,
    now: string,
  ): Promise<SystemStateRecord<T> | null> {
    assertBoundedValue("key", key, MAX_KEY_LENGTH);
    assertCanonicalTimestamp("now", now);
    if (expectedRevision !== null) {
      assertBoundedValue("expectedRevision", expectedRevision, MAX_REVISION_LENGTH);
    }
    const revision = createRevision(now);
    const bindings = {
      key,
      valueJson: serializeJsonObject(value),
      now,
      revision,
      expectedRevision,
    };
    const query = expectedRevision === null
      ? systemStateRepositoryQueries.createSystemState
      : systemStateRepositoryQueries.updateSystemState;
    const row = await this.database.prepare(query).get<SystemStateRow>(bindings);
    return row ? this.normalizeMutation<T>(row, now, revision) : null;
  }

  async acquireLease(
    input: AcquireSystemLeaseInput,
  ): Promise<SystemStateRecord<SystemLeaseValue> | null> {
    this.assertLeaseIdentity(input);
    assertCanonicalTimestamp("now", input.now);
    assertCanonicalTimestamp("leaseUntil", input.leaseUntil);
    if (input.leaseUntil <= input.now) {
      throw new Error("leaseUntil must be after now.");
    }
    const value: SystemLeaseValue = {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseUntil: input.leaseUntil,
      acquiredAt: input.now,
    };
    const revision = createRevision(input.now);
    const query = this.database.dialect === "postgres"
      ? systemStateRepositoryQueries.acquirePostgresSystemLease
      : systemStateRepositoryQueries.acquireSqliteSystemLease;
    const row = await this.database.prepare(query).get<SystemStateRow>({
      key: input.key,
      owner: input.owner,
      leaseToken: input.leaseToken,
      valueJson: serializeJsonObject(value),
      now: input.now,
      leaseUntil: input.leaseUntil,
      revision,
    });
    return row ? this.normalizeMutation<SystemLeaseValue>(row, input.now, revision) : null;
  }

  async releaseLease(
    input: ReleaseSystemLeaseInput,
  ): Promise<SystemStateRecord<SystemLeaseValue> | null> {
    this.assertLeaseIdentity(input);
    assertCanonicalTimestamp("now", input.now);
    const value: SystemLeaseValue = {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseUntil: input.now,
      releasedAt: input.now,
    };
    const revision = createRevision(input.now);
    const query = this.database.dialect === "postgres"
      ? systemStateRepositoryQueries.releasePostgresSystemLease
      : systemStateRepositoryQueries.releaseSqliteSystemLease;
    const row = await this.database.prepare(query).get<SystemStateRow>({
      key: input.key,
      owner: input.owner,
      leaseToken: input.leaseToken,
      valueJson: serializeJsonObject(value),
      now: input.now,
      revision,
    });
    return row ? this.normalizeMutation<SystemLeaseValue>(row, input.now, revision) : null;
  }

  private assertLeaseIdentity(input: { key: string; owner: string; leaseToken: string }): void {
    assertBoundedValue("key", input.key, MAX_KEY_LENGTH);
    assertBoundedValue("owner", input.owner, MAX_OWNER_LENGTH);
    assertBoundedValue("leaseToken", input.leaseToken, MAX_LEASE_TOKEN_LENGTH);
  }

  private normalizeMutation<T extends object>(
    row: SystemStateRow,
    now: string,
    revision: string,
  ): SystemStateRecord<T> {
    const record = normalizeSystemStateRow<T>(row);
    if (record.updatedAt !== now || record.revision !== revision) {
      throw new Error("System state mutation returned a record that does not match its write token.");
    }
    return record;
  }
}
