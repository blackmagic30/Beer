import crypto from "node:crypto";
import { TextEncoder, types as utilTypes } from "node:util";

import type BetterSqlite3 from "better-sqlite3";

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_SORT = Array.prototype.sort;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_BUFFER_OBJECT = ArrayBuffer;
const BUFFER_OBJECT = Buffer;
const BUFFER_ALLOC = BUFFER_OBJECT.alloc;
const BUFFER_IS_BUFFER = BUFFER_OBJECT.isBuffer;
const CRYPTO_CREATE_HASH = crypto.createHash;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_CHAR_AT = String.prototype.charAt;
const TEXT_ENCODER = new TextEncoder();
const TEXT_ENCODER_ENCODE = TEXT_ENCODER.encode;
const TYPE_ERROR = TypeError;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const UTIL_IS_PROXY = utilTypes.isProxy;
const WEAK_SET_CONSTRUCTOR = WeakSet;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
const HASH_UPDATE = HASH_PROBE.update;
const HASH_DIGEST = HASH_PROBE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);
const LOWERCASE_HEX = "0123456789abcdef";
const MAX_CANONICAL_JSON_DEPTH = 128;
const MAX_CANONICAL_JSON_NODES = 1_000_000;

export const POSTGRES_MIGRATION_CONTRACT_KIND = "pint-path-postgres-migration-contract" as const;
export const POSTGRES_MIGRATION_CONTRACT_VERSION = 1 as const;
export const POSTGRES_MIGRATION_SOURCE_SCHEMA_VERSION = 16 as const;

// These tags are the reviewed semantic target contract. Phase A validates and
// commits to them without writing Postgres; the later apply/DDL phase must map
// them to native boolean/jsonb/timestamptz/time/numeric/float8/bytea types.
export type PostgresMigrationConversion =
  | "binary"
  | "boolean"
  | "calendar-month"
  | "decimal"
  | "float64"
  | "integer"
  | "json-array"
  | "json-object"
  | "local-time"
  | "text"
  | "utc-instant";

export type PostgresMigrationColumnContract = readonly [
  name: string,
  declaredType: "BLOB" | "INTEGER" | "REAL" | "TEXT",
  conversion: PostgresMigrationConversion,
  nullable: boolean,
  primaryKeyPosition: number,
];

export interface PostgresMigrationTableContract {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly columns: readonly PostgresMigrationColumnContract[];
}

export interface PostgresMigrationContract {
  readonly kind: typeof POSTGRES_MIGRATION_CONTRACT_KIND;
  readonly version: typeof POSTGRES_MIGRATION_CONTRACT_VERSION;
  readonly sourceSchemaVersion: typeof POSTGRES_MIGRATION_SOURCE_SCHEMA_VERSION;
  readonly expectedSchemaFingerprint: string;
  readonly expectedCounts: {
    readonly tables: number;
    readonly columns: number;
    readonly foreignKeys: number;
    readonly explicitIndexes: number;
    readonly automaticIndexes: number;
    readonly triggers: number;
  };
  readonly importOrder: readonly string[];
  readonly tables: readonly PostgresMigrationTableContract[];
}

type SchemaMasterRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden?: number;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

type IndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type IndexInfoRow = {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string | null;
  key: number;
};

export interface PostgresMigrationSchemaDescriptor {
  readonly userVersion: number;
  readonly objects: readonly SchemaMasterRow[];
  readonly tables: readonly {
    name: string;
    columns: readonly TableInfoRow[];
    foreignKeys: readonly ForeignKeyRow[];
    indexes: readonly {
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
      columns: readonly IndexInfoRow[];
    }[];
  }[];
}

export interface PostgresMigrationSchemaInspection {
  readonly descriptor: PostgresMigrationSchemaDescriptor;
  readonly fingerprint: string;
  readonly counts: PostgresMigrationContract["expectedCounts"];
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function encodeJsonPrimitive(value: string | number): string {
  const encoded = REFLECT_APPLY(JSON_STRINGIFY, JSON_OBJECT, [value]);
  if (typeof encoded !== "string") throw new TYPE_ERROR("Canonical JSON value is invalid.");
  return encoded;
}

function canonicalIndent(depth: number): string {
  let output = "";
  for (let index = 0; index < depth; index += 1) output += "  ";
  return output;
}

function canonicalJsonText(value: unknown): string {
  let nodes = 0;
  const seen = new WEAK_SET_CONSTRUCTOR<object>();

  const serialize = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_JSON_NODES || depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new TYPE_ERROR("Canonical JSON value exceeds its structural bound.");
    }
    if (candidate === null) return "null";
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "string") return encodeJsonPrimitive(candidate);
    if (typeof candidate === "number") {
      if (!NUMBER_IS_FINITE(candidate)) {
        throw new TYPE_ERROR("Canonical JSON numbers must be finite.");
      }
      return encodeJsonPrimitive(candidate);
    }
    if (typeof candidate !== "object") {
      throw new TYPE_ERROR("Canonical JSON contains an unsupported value.");
    }
    if (UTIL_IS_PROXY(candidate)) {
      throw new TYPE_ERROR("Canonical JSON cannot contain a proxy.");
    }
    if (REFLECT_APPLY(WEAK_SET_HAS, seen, [candidate]) === true) {
      throw new TYPE_ERROR("Canonical JSON cannot contain a cycle.");
    }
    REFLECT_APPLY(WEAK_SET_ADD, seen, [candidate]);

    try {
      const prototype = OBJECT_GET_PROTOTYPE_OF(candidate);
      const ownKeys = REFLECT_OWN_KEYS(candidate);
      if (ARRAY_IS_ARRAY(candidate)) {
        if (prototype !== ARRAY_PROTOTYPE) {
          throw new TYPE_ERROR("Canonical JSON arrays must be ordinary arrays.");
        }
        const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, "length");
        const length = lengthDescriptor?.value;
        if (
          !lengthDescriptor
          || !OBJECT_HAS_OWN(lengthDescriptor, "value")
          || !NUMBER_IS_SAFE_INTEGER(length)
          || length < 0
          || ownKeys.length !== length + 1
        ) {
          throw new TYPE_ERROR("Canonical JSON arrays must be dense own-data arrays.");
        }
        if (length === 0) return "[]";
        let output = "[\n";
        for (let index = 0; index < length; index += 1) {
          const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, `${index}`);
          if (
            !descriptor
            || !OBJECT_HAS_OWN(descriptor, "value")
            || descriptor.enumerable !== true
          ) {
            throw new TYPE_ERROR("Canonical JSON arrays must be dense own-data arrays.");
          }
          output += canonicalIndent(depth + 1);
          output += serialize(descriptor.value, depth + 1);
          output += index + 1 === length ? "\n" : ",\n";
        }
        output += `${canonicalIndent(depth)}]`;
        return output;
      }

      if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
        throw new TYPE_ERROR("Canonical JSON objects must be ordinary objects.");
      }
      const keys: string[] = [];
      let keyCount = 0;
      for (let index = 0; index < ownKeys.length; index += 1) {
        const key = ownKeys[index];
        if (typeof key !== "string") {
          throw new TYPE_ERROR("Canonical JSON objects cannot contain symbols.");
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, key);
        if (
          !descriptor
          || !OBJECT_HAS_OWN(descriptor, "value")
          || descriptor.enumerable !== true
        ) {
          throw new TYPE_ERROR("Canonical JSON objects must contain enumerable own data.");
        }
        OBJECT_DEFINE_PROPERTY(keys, `${keyCount}`, {
          configurable: true,
          enumerable: true,
          value: key,
          writable: true,
        });
        keyCount += 1;
      }
      REFLECT_APPLY(ARRAY_SORT, keys, [
        (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0,
      ]);
      if (keyCount === 0) return "{}";
      let output = "{\n";
      for (let index = 0; index < keyCount; index += 1) {
        const key = keys[index];
        if (typeof key !== "string") {
          throw new TYPE_ERROR("Canonical JSON object key is invalid.");
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, key);
        if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value")) {
          throw new TYPE_ERROR("Canonical JSON object changed during serialization.");
        }
        output += `${canonicalIndent(depth + 1)}${encodeJsonPrimitive(key)}: `;
        output += serialize(descriptor.value, depth + 1);
        output += index + 1 === keyCount ? "\n" : ",\n";
      }
      output += `${canonicalIndent(depth)}}`;
      return output;
    } finally {
      REFLECT_APPLY(WEAK_SET_DELETE, seen, [candidate]);
    }
  };

  return serialize(value, 0);
}

function canonicalUtf8Buffer(value: string): Buffer {
  const encoded = REFLECT_APPLY(TEXT_ENCODER_ENCODE, TEXT_ENCODER, [value]);
  if (
    typeof TYPED_ARRAY_BYTE_LENGTH !== "function"
    || !REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_OBJECT, [encoded])
    || OBJECT_GET_PROTOTYPE_OF(encoded) !== UINT8_ARRAY_PROTOTYPE
  ) {
    throw new TYPE_ERROR("Canonical UTF-8 encoding failed.");
  }
  const length = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, encoded, []);
  if (!NUMBER_IS_SAFE_INTEGER(length) || length < 0) {
    throw new TYPE_ERROR("Canonical UTF-8 encoding failed.");
  }
  const output = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_OBJECT, [length]);
  if (!REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [output])) {
    throw new TYPE_ERROR("Canonical UTF-8 allocation failed.");
  }
  REFLECT_APPLY(TYPED_ARRAY_SET, output, [encoded, 0]);
  return output;
}

export function canonicalizePostgresMigrationJson(value: unknown): unknown {
  return REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [canonicalJsonText(value)]);
}

export function serializeCanonicalPostgresMigrationJson(value: unknown): Buffer {
  return canonicalUtf8Buffer(`${canonicalJsonText(value)}\n`);
}

export function sha256PostgresMigrationBytes(value: string | Buffer): string {
  if (typeof value !== "string" && !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [value])) {
    throw new TYPE_ERROR("SHA-256 input must be a string or Buffer.");
  }
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [value]);
  const digest = REFLECT_APPLY(HASH_DIGEST, hash, []);
  if (
    typeof TYPED_ARRAY_BYTE_LENGTH !== "function"
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [digest])
    || REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, digest, []) !== 32
  ) {
    throw new TYPE_ERROR("SHA-256 digest is invalid.");
  }
  let output = "";
  for (let index = 0; index < 32; index += 1) {
    const byte = digest[index];
    if (typeof byte !== "number" || !NUMBER_IS_SAFE_INTEGER(byte) || byte < 0 || byte > 0xff) {
      throw new TYPE_ERROR("SHA-256 digest is invalid.");
    }
    output += REFLECT_APPLY(STRING_CHAR_AT, LOWERCASE_HEX, [byte >>> 4]);
    output += REFLECT_APPLY(STRING_CHAR_AT, LOWERCASE_HEX, [byte & 0x0f]);
  }
  if (output.length !== 64) throw new TYPE_ERROR("SHA-256 digest is invalid.");
  return output;
}

export function buildPostgresMigrationSchemaDescriptor(
  database: BetterSqlite3.Database,
): PostgresMigrationSchemaDescriptor {
  const objects = database.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
        AND type IN ('index', 'table', 'trigger', 'view')
      ORDER BY type COLLATE BINARY, name COLLATE BINARY`,
  ).all() as SchemaMasterRow[];
  const tableNames = objects
    .filter((object) => object.type === "table")
    .map((object) => object.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  return {
    userVersion: Number(database.pragma("user_version", { simple: true }) ?? 0),
    objects,
    tables: tableNames.map((name) => {
      const identifier = quoteSqliteIdentifier(name);
      const indexes = (database.pragma(`index_list(${identifier})`) as IndexListRow[])
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .map((index) => ({
          seq: index.seq,
          name: index.name,
          unique: index.unique,
          origin: index.origin,
          partial: index.partial,
          columns: (database.pragma(`index_xinfo(${quoteSqliteIdentifier(index.name)})`) as IndexInfoRow[])
            .sort((left, right) => left.seqno - right.seqno),
        }));
      return {
        name,
        columns: (database.pragma(`table_xinfo(${identifier})`) as TableInfoRow[])
          .sort((left, right) => left.cid - right.cid),
        foreignKeys: (database.pragma(`foreign_key_list(${identifier})`) as ForeignKeyRow[])
          .sort((left, right) => left.id - right.id || left.seq - right.seq),
        indexes,
      };
    }),
  };
}

export function inspectPostgresMigrationSchema(
  database: BetterSqlite3.Database,
): PostgresMigrationSchemaInspection {
  const descriptor = buildPostgresMigrationSchemaDescriptor(database);
  const explicitIndexes = descriptor.objects.filter(
    (object) => object.type === "index" && object.sql !== null,
  ).length;
  const allIndexes = descriptor.tables.reduce((total, table) => total + table.indexes.length, 0);
  const automaticIndexes = allIndexes - explicitIndexes;
  return {
    descriptor,
    fingerprint: sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(descriptor)),
    counts: {
      tables: descriptor.tables.length,
      columns: descriptor.tables.reduce((total, table) => total + table.columns.length, 0),
      foreignKeys: descriptor.tables.reduce((total, table) => total + table.foreignKeys.length, 0),
      explicitIndexes,
      automaticIndexes,
      triggers: descriptor.objects.filter((object) => object.type === "trigger").length,
    },
  };
}

export function sha256PostgresMigrationContract(contract: PostgresMigrationContract): string {
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(contract));
}
