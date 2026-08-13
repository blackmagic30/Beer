import crypto from "node:crypto";
import { TextDecoder, types as utilTypes } from "node:util";

import {
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  type PostgresLogicalBackupV4TableDataDescriptor,
} from "./postgres-logical-backup-v4-table-data-contract.js";

export const POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES = 64 * 1024;
export const POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINES = 96;
export const POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINE_BYTES = 512;

const EXPECTED_TOC_ENTRIES = 63;
const EXPECTED_LISTED_ENTRIES = 59;
const FIXED_HEADER_LINES = 15;
const MAX_UINT32 = 4_294_967_295;
const MAX_TOOL_VERSION_BYTES = 128;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const BUFFER_OBJECT = Buffer;
const BUFFER_ALLOC = BUFFER_OBJECT.alloc;
const BUFFER_IS_BUFFER = BUFFER_OBJECT.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_OBJECT.prototype;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_IS_UINT8_ARRAY = utilTypes.isUint8Array;

const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const OWNER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/;
const ARCHIVE_CREATED_PATTERN = /^; Archive created at ([0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] (?:[A-Za-z][A-Za-z0-9+:-]{0,15}|[+-][0-9]{2}(?::?[0-9]{2})?))$/;
const NUMERIC_TIME_ZONE_PATTERN = / ([+-])([0-9]{2})(?::?([0-9]{2}))?$/;
const ENTRY_PATTERN = /^([0-9]+); ([0-9]+) ([0-9]+) TABLE DATA (pintpath_app|pintpath_ops) ([a-z_][a-z0-9_]*) ([A-Za-z_][A-Za-z0-9_$]*)$/;

export interface PostgresLogicalBackupV4UnauthenticatedListingProjectionOnly {
  readonly classification: "UNAUTHENTICATED_LISTING_PROJECTION_ONLY";
  readonly operationalAuthorityGranted: false;
  readonly unmetRequiredBindings: {
    readonly sameRetainedArchiveInodeBound: false;
    readonly archiveSha256Bound: false;
    readonly authenticatedPgRestoreExecutableBound: false;
    readonly authenticatedPgDumpExecutableBound: false;
    readonly sourceDatabaseIdentityBound: false;
  };
  readonly observedTableDataShape: {
    readonly observedTocEntries: 63;
    readonly observedListedEntries: 59;
    readonly observedTableDataEntries: 59;
    readonly observedTableDataSetSha256: typeof POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256;
    readonly observedEntries: readonly PostgresLogicalBackupV4TableDataDescriptor[];
  };
}

export interface PostgresLogicalBackupV4TocParseResult {
  readonly listingSha256: string;
  readonly archiveCreatedAt: string;
  readonly databaseName: string;
  readonly dumpedFromDatabaseVersion: string;
  readonly dumpedByPgDumpVersion: string;
  readonly unauthenticatedListingProjectionOnly:
    PostgresLogicalBackupV4UnauthenticatedListingProjectionOnly;
}

export class PostgresLogicalBackupV4TocError extends Error {
  readonly code = "archive_listing_invalid" as const;

  constructor() {
    super("archive_listing_invalid");
    this.name = "PostgresLogicalBackupV4TocError";
  }
}

function invalid(): never {
  throw new PostgresLogicalBackupV4TocError();
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function qualifiedName(entry: PostgresLogicalBackupV4TableDataDescriptor): string {
  return `${entry.schemaName}.${entry.tableName}`;
}

function parseBoundedUint32(value: string): number {
  if (!CANONICAL_UNSIGNED_INTEGER_PATTERN.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_UINT32) invalid();
  return parsed;
}

function parsePg17Version(line: string, prefix: string): string {
  if (!line.startsWith(prefix)) invalid();
  const version = line.slice(prefix.length);
  if (
    !version
    || version.trim() !== version
    || Buffer.byteLength(version, "utf8") > MAX_TOOL_VERSION_BYTES
    || !VERSION_PATTERN.test(version)
    || Number.parseInt(version, 10) !== 17
  ) invalid();
  return version;
}

function snapshotBoundedPlainBuffer(input: unknown): Buffer {
  if (typeof input !== "object" || input === null || UTIL_IS_PROXY(input)) invalid();
  if (!TYPED_ARRAY_BYTE_LENGTH) invalid();

  const byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, input, []) as unknown;
  if (!Number.isSafeInteger(byteLength)
    || (byteLength as number) === 0
    || (byteLength as number) > POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES) invalid();

  if (!UTIL_IS_UINT8_ARRAY(input)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [input]) !== BUFFER_PROTOTYPE
    || REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [input]) !== true) invalid();

  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [input]) as PropertyKey[];
  const descriptors = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [input],
  ) as PropertyDescriptorMap;
  if (keys.length !== byteLength) invalid();
  for (let index = 0; index < byteLength; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[String(index)];
    if (key !== String(index)
      || !descriptor
      || !("value" in descriptor)
      || !Number.isInteger(descriptor.value)
      || descriptor.value < 0
      || descriptor.value > 255
      || descriptor.enumerable !== true) invalid();
  }

  const snapshot = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_OBJECT, [byteLength]) as Buffer;
  REFLECT_APPLY(TYPED_ARRAY_SET, snapshot, [input, 0]);
  return snapshot;
}

function parseArchiveCreatedAt(line: string): string {
  const match = ARCHIVE_CREATED_PATTERN.exec(line);
  const archiveCreatedAt = match?.[1];
  if (!archiveCreatedAt) invalid();
  const numericTimeZone = NUMERIC_TIME_ZONE_PATTERN.exec(archiveCreatedAt);
  if (numericTimeZone) {
    const hourText = numericTimeZone[2];
    const minuteText = numericTimeZone[3] ?? "00";
    if (hourText === undefined) invalid();
    const hours = Number(hourText);
    const minutes = Number(minuteText);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) invalid();
  }
  return archiveCreatedAt;
}

function parseLines(bytes: Buffer): readonly string[] {
  if (
    bytes.length >= UTF8_BOM.length && bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  ) invalid();

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) invalid();

  const withoutCrlf = text.replace(/\r\n/g, "");
  if (withoutCrlf.includes("\r")) invalid();
  const hasCrlf = text.includes("\r\n");
  if (hasCrlf && withoutCrlf.includes("\n")) invalid();

  const normalized = hasCrlf ? text.replace(/\r\n/g, "\n") : text;
  if (!normalized.endsWith("\n") || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)) {
    invalid();
  }
  const lines = normalized.slice(0, -1).split("\n");
  if (
    lines.length > POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINES
    || lines.some((line) => (
      Buffer.byteLength(line, "utf8") > POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINE_BYTES
    ))
  ) invalid();
  return lines;
}

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) invalid();
  return line;
}

function expectLine(lines: readonly string[], index: number, expected: string): void {
  if (lineAt(lines, index) !== expected) invalid();
}

function parseEntry(
  line: string,
  dumpIds: Set<number>,
): PostgresLogicalBackupV4TableDataDescriptor {
  const match = ENTRY_PATTERN.exec(line);
  if (!match) invalid();
  const dumpIdText = match[1];
  const catalogTableOidText = match[2];
  const catalogObjectOidText = match[3];
  const schemaName = match[4];
  const tableName = match[5];
  const owner = match[6];
  if (
    dumpIdText === undefined
    || catalogTableOidText === undefined
    || catalogObjectOidText === undefined
    || (schemaName !== "pintpath_app" && schemaName !== "pintpath_ops")
    || tableName === undefined
    || owner === undefined
    || !TABLE_NAME_PATTERN.test(tableName)
    || !OWNER_PATTERN.test(owner)
  ) invalid();

  const dumpId = parseBoundedUint32(dumpIdText);
  parseBoundedUint32(catalogTableOidText);
  parseBoundedUint32(catalogObjectOidText);
  if (dumpIds.has(dumpId)) invalid();
  dumpIds.add(dumpId);

  return Object.freeze({
    description: "TABLE DATA" as const,
    schemaName,
    tableName,
  });
}

function normalizedExactEntries(
  entries: readonly PostgresLogicalBackupV4TableDataDescriptor[],
): readonly PostgresLogicalBackupV4TableDataDescriptor[] {
  const normalized = [...entries].sort((left, right) => (
    compareText(qualifiedName(left), qualifiedName(right))
  ));
  if (normalized.length !== POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.length) invalid();
  for (let index = 0; index < normalized.length; index += 1) {
    const observed = normalized[index];
    const expected = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS[index];
    if (
      observed === undefined
      || expected === undefined
      || observed.description !== expected.description
      || observed.schemaName !== expected.schemaName
      || observed.tableName !== expected.tableName
    ) invalid();
  }
  return Object.freeze(normalized.map((entry) => Object.freeze({ ...entry })));
}

/**
 * Parses the raw stdout bytes emitted by PostgreSQL 17 `pg_restore --list` for
 * the Pint Path V4 data-only archive. OIDs, dump IDs, and owners are syntax
 * checked but intentionally omitted. The result is only an unauthenticated
 * listing projection. A future operational caller must separately bind it to
 * the same retained archive inode, archive digest, authenticated pg_restore
 * and pg_dump executables, and source database identity before it can inform
 * any authority-bearing evidence.
 */
export function parsePostgresLogicalBackupV4TocListing(
  input: unknown,
): PostgresLogicalBackupV4TocParseResult {
  try {
    const bytes = snapshotBoundedPlainBuffer(input);
    const lines = parseLines(bytes);
    if (lines.length !== FIXED_HEADER_LINES + EXPECTED_LISTED_ENTRIES) invalid();

    expectLine(lines, 0, ";");
    const archiveCreatedAt = parseArchiveCreatedAt(lineAt(lines, 1));
    const databaseMatch = /^; {5}dbname: (.+)$/.exec(lineAt(lines, 2));
    if (!databaseMatch?.[1] || !DATABASE_NAME_PATTERN.test(databaseMatch[1])) invalid();
    const databaseName = databaseMatch[1];
    expectLine(lines, 3, `;     TOC Entries: ${EXPECTED_TOC_ENTRIES}`);
    expectLine(lines, 4, ";     Compression: gzip");
    expectLine(lines, 5, ";     Dump Version: 1.16-0");
    expectLine(lines, 6, ";     Format: CUSTOM");
    expectLine(lines, 7, ";     Integer: 4 bytes");
    expectLine(lines, 8, ";     Offset: 8 bytes");
    const dumpedFromDatabaseVersion = parsePg17Version(
      lineAt(lines, 9),
      ";     Dumped from database version: ",
    );
    const dumpedByPgDumpVersion = parsePg17Version(
      lineAt(lines, 10),
      ";     Dumped by pg_dump version: ",
    );
    expectLine(lines, 11, ";");
    expectLine(lines, 12, ";");
    expectLine(lines, 13, "; Selected TOC Entries:");
    expectLine(lines, 14, ";");

    const dumpIds = new Set<number>();
    const observedEntries = lines.slice(FIXED_HEADER_LINES).map((line) => (
      parseEntry(line, dumpIds)
    ));
    const entries = normalizedExactEntries(observedEntries);
    const unauthenticatedListingProjectionOnly = Object.freeze({
      classification: "UNAUTHENTICATED_LISTING_PROJECTION_ONLY",
      operationalAuthorityGranted: false,
      unmetRequiredBindings: Object.freeze({
        sameRetainedArchiveInodeBound: false,
        archiveSha256Bound: false,
        authenticatedPgRestoreExecutableBound: false,
        authenticatedPgDumpExecutableBound: false,
        sourceDatabaseIdentityBound: false,
      }),
      observedTableDataShape: Object.freeze({
        observedTocEntries: EXPECTED_TOC_ENTRIES as 63,
        observedListedEntries: EXPECTED_LISTED_ENTRIES as 59,
        observedTableDataEntries: EXPECTED_LISTED_ENTRIES as 59,
        observedTableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
        observedEntries: entries,
      }),
    }) satisfies PostgresLogicalBackupV4UnauthenticatedListingProjectionOnly;

    return Object.freeze({
      listingSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      archiveCreatedAt,
      databaseName,
      dumpedFromDatabaseVersion,
      dumpedByPgDumpVersion,
      unauthenticatedListingProjectionOnly,
    });
  } catch {
    invalid();
  }
}
