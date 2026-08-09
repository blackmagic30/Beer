import crypto from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

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

export function canonicalizePostgresMigrationJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePostgresMigrationJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalizePostgresMigrationJson(nested)]),
    );
  }
  return value;
}

export function serializeCanonicalPostgresMigrationJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalizePostgresMigrationJson(value), null, 2)}\n`, "utf8");
}

export function sha256PostgresMigrationBytes(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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
