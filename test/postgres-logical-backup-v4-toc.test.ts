import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  type PostgresLogicalBackupV4TableDataDescriptor,
} from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";
import type {
  PostgresLogicalBackupV4TocEvidence,
} from "../src/lib/postgres-logical-backup-v4.js";
import {
  parsePostgresLogicalBackupV4TocListing,
  POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES,
  POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINE_BYTES,
  POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINES,
  PostgresLogicalBackupV4TocError,
} from "../src/lib/postgres-logical-backup-v4-toc.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ListingOptions {
  readonly entries?: readonly PostgresLogicalBackupV4TableDataDescriptor[];
  readonly lineEnding?: "\n" | "\r\n";
}

function entryLine(
  entry: PostgresLogicalBackupV4TableDataDescriptor,
  index: number,
): string {
  const dumpId = index === 0 ? "4294967295" : String(4_000 + index);
  const catalogTableOid = index % 2 === 0 ? "0" : String(1_259 + index);
  const catalogObjectOid = index === 0 ? "0" : String(16_384 + index);
  const owner = index % 2 === 0 ? "postgres" : `pintpath_owner_${index}`;
  return `${dumpId}; ${catalogTableOid} ${catalogObjectOid} TABLE DATA ${entry.schemaName} ${entry.tableName} ${owner}`;
}

function listing(options: ListingOptions = {}): Buffer {
  const entries = options.entries ?? [...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS].reverse();
  const lineEnding = options.lineEnding ?? "\n";
  const lines = [
    ";",
    "; Archive created at 2026-08-12 20:38:04 AEST",
    ";     dbname: postgres",
    ";     TOC Entries: 63",
    ";     Compression: gzip",
    ";     Dump Version: 1.16-0",
    ";     Format: CUSTOM",
    ";     Integer: 4 bytes",
    ";     Offset: 8 bytes",
    ";     Dumped from database version: 17.6 (Supabase)",
    ";     Dumped by pg_dump version: 17.10 (Homebrew)",
    ";",
    ";",
    "; Selected TOC Entries:",
    ";",
    ...entries.map(entryLine),
  ];
  return Buffer.from(`${lines.join(lineEnding)}${lineEnding}`, "utf8");
}

function replaceOnce(bytes: Buffer, from: string, to: string): Buffer {
  const text = bytes.toString("utf8");
  expect(text.includes(from)).toBe(true);
  return Buffer.from(text.replace(from, to), "utf8");
}

function expectInvalid(input: unknown): void {
  expect(() => parsePostgresLogicalBackupV4TocListing(input)).toThrowError(
    PostgresLogicalBackupV4TocError,
  );
  try {
    parsePostgresLogicalBackupV4TocListing(input);
  } catch (error) {
    expect(error).toMatchObject({
      name: "PostgresLogicalBackupV4TocError",
      code: "archive_listing_invalid",
      message: "archive_listing_invalid",
    });
  }
}

describe("Postgres logical backup V4 TOC parser", () => {
  it("normalizes a real-shaped PG17 listing only into frozen unauthenticated projection data", () => {
    const bytes = listing();
    const result = parsePostgresLogicalBackupV4TocListing(bytes);
    const projection = result.unauthenticatedListingProjectionOnly;
    // @ts-expect-error An unauthenticated parser projection cannot be passed to the V4 builder.
    const forbiddenAuthorityElevation: PostgresLogicalBackupV4TocEvidence = projection;
    void forbiddenAuthorityElevation;
    // @ts-expect-error Its nested observed shape is deliberately not builder-compatible either.
    const forbiddenObservedElevation: PostgresLogicalBackupV4TocEvidence =
      projection.observedTableDataShape;
    void forbiddenObservedElevation;

    expect(result).not.toHaveProperty("toc");
    expect(projection).toEqual({
      classification: "UNAUTHENTICATED_LISTING_PROJECTION_ONLY",
      operationalAuthorityGranted: false,
      unmetRequiredBindings: {
        sameRetainedArchiveInodeBound: false,
        archiveSha256Bound: false,
        authenticatedPgRestoreExecutableBound: false,
        authenticatedPgDumpExecutableBound: false,
        sourceDatabaseIdentityBound: false,
      },
      observedTableDataShape: {
        observedTocEntries: 63,
        observedListedEntries: 59,
        observedTableDataEntries: 59,
        observedTableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
        observedEntries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
      },
    });
    expect(result).toMatchObject({
      listingSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      archiveCreatedAt: "2026-08-12 20:38:04 AEST",
      databaseName: "postgres",
      dumpedFromDatabaseVersion: "17.6 (Supabase)",
      dumpedByPgDumpVersion: "17.10 (Homebrew)",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.unmetRequiredBindings)).toBe(true);
    expect(Object.isFrozen(projection.observedTableDataShape)).toBe(true);
    expect(Object.isFrozen(projection.observedTableDataShape.observedEntries)).toBe(true);
    expect(projection.observedTableDataShape.observedEntries.every(
      (entry) => Object.isFrozen(entry),
    )).toBe(true);
  });

  it("keeps normalized evidence and its set hash stable across listing order and line endings", () => {
    const forward = parsePostgresLogicalBackupV4TocListing(listing({
      entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
    }));
    const reversedCrlfBytes = listing({ lineEnding: "\r\n" });
    const reversed = parsePostgresLogicalBackupV4TocListing(reversedCrlfBytes);

    expect(reversed.unauthenticatedListingProjectionOnly)
      .toEqual(forward.unauthenticatedListingProjectionOnly);
    expect(reversed.unauthenticatedListingProjectionOnly.observedTableDataShape
      .observedTableDataSetSha256).toBe(
      "505d42cd7ffbe6809aea3e3ed02b33968bf625bde882cdbc0f1a3c69cc94f6d8",
    );
    expect(reversed.listingSha256).toBe(
      crypto.createHash("sha256").update(reversedCrlfBytes).digest("hex"),
    );
    expect(reversed.listingSha256).not.toBe(forward.listingSha256);
  });

  it("rejects duplicate, missing, extra, wrong-description, and kernel entries", () => {
    const bytes = listing({ entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS });
    const first = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS[0];
    const second = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstLine = entryLine(first!, 0);
    const secondLine = entryLine(second!, 1);

    expectInvalid(replaceOnce(
      bytes,
      secondLine,
      entryLine(first!, 1),
    ));
    const missingText = bytes.toString("utf8").replace(`${firstLine}\n`, "");
    expectInvalid(Buffer.from(missingText, "utf8"));
    expectInvalid(replaceOnce(
      bytes,
      secondLine,
      secondLine.replace(` ${second!.tableName} `, " unexpected_table "),
    ));
    expectInvalid(replaceOnce(bytes, " TABLE DATA ", " TABLE "));
    expectInvalid(replaceOnce(
      bytes,
      secondLine,
      secondLine.replace(
        ` ${second!.schemaName} ${second!.tableName} `,
        " pintpath_ops reviewed_price_promotion_operations ",
      ),
    ));
  });

  it.each([
    ["TOC count", ";     TOC Entries: 63", ";     TOC Entries: 62"],
    ["compression", ";     Compression: gzip", ";     Compression: zstd"],
    ["dump version", ";     Dump Version: 1.16-0", ";     Dump Version: 1.15-0"],
    ["format", ";     Format: CUSTOM", ";     Format: TAR"],
    ["integer width", ";     Integer: 4 bytes", ";     Integer: 8 bytes"],
    ["offset width", ";     Offset: 8 bytes", ";     Offset: 4 bytes"],
    ["selector", "; Selected TOC Entries:", "; TOC Entries:"],
    ["database name", ";     dbname: postgres", ";     dbname: postgres db"],
    [
      "archive timestamp",
      "; Archive created at 2026-08-12 20:38:04 AEST",
      "; Archive created at yesterday",
    ],
  ])("rejects a wrong PG17 %s header field", (_name, from, to) => {
    expectInvalid(replaceOnce(listing(), from, to));
  });

  it.each(["+10", "-10", "+10:30", "+1030", "+1245"])(
    "accepts the real PG17 numeric archive timezone %s",
    (timeZone) => {
      const bytes = replaceOnce(
        listing(),
        "2026-08-12 20:38:04 AEST",
        `2026-08-12 20:38:04 ${timeZone}`,
      );
      expect(parsePostgresLogicalBackupV4TocListing(bytes).archiveCreatedAt)
        .toBe(`2026-08-12 20:38:04 ${timeZone}`);
    },
  );

  it.each(["+15", "-14:01", "+10:60", "+1460", "+1401", "+1", "+100"])(
    "rejects the unsafe or noncanonical numeric archive timezone %s",
    (timeZone) => {
      expectInvalid(replaceOnce(
        listing(),
        "2026-08-12 20:38:04 AEST",
        `2026-08-12 20:38:04 ${timeZone}`,
      ));
    },
  );

  it.each([
    ["source major", "17.6 (Supabase)", "16.9 (Supabase)"],
    ["dump-tool major", "17.10 (Homebrew)", "18.0 (Homebrew)"],
    ["leading whitespace", "17.10 (Homebrew)", " 17.10 (Homebrew)"],
    ["unsafe suffix", "17.10 (Homebrew)", "17.10 [Homebrew]"],
  ])("rejects a non-PG17 or unsafe %s version", (_name, from, to) => {
    expectInvalid(replaceOnce(listing(), from, to));
  });

  it("syntax-checks but does not elevate dump IDs, catalog OIDs, or safe owners", () => {
    const bytes = listing();
    expect(() => parsePostgresLogicalBackupV4TocListing(bytes)).not.toThrow();
    expectInvalid(replaceOnce(bytes, "4294967295;", "4294967296;"));
    expectInvalid(replaceOnce(bytes, "4294967295;", "04294967295;"));
    expectInvalid(replaceOnce(bytes, "0 0 TABLE DATA", "00 0 TABLE DATA"));
    const firstListedDescriptor = [...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS]
      .reverse()[0];
    expect(firstListedDescriptor).toBeDefined();
    const safeOwnerLine = entryLine(firstListedDescriptor!, 0);
    expectInvalid(replaceOnce(bytes, safeOwnerLine, safeOwnerLine.replace(/ postgres$/, " bad-owner")));

    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const firstEntryIndex = 15;
    const secondEntryIndex = 16;
    const firstEntry = lines[firstEntryIndex];
    const secondEntry = lines[secondEntryIndex];
    expect(firstEntry).toBeDefined();
    expect(secondEntry).toBeDefined();
    const duplicateDumpId = firstEntry!.slice(0, firstEntry!.indexOf(";"));
    lines[secondEntryIndex] = secondEntry!.replace(/^[0-9]+;/, `${duplicateDumpId};`);
    expectInvalid(Buffer.from(lines.join("\n"), "utf8"));
  });

  it("rejects invalid UTF-8, BOMs, controls, mixed newlines, and missing final newline", () => {
    expectInvalid(Buffer.from([0xc3, 0x28]));
    expectInvalid(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), listing()]));
    expectInvalid(replaceOnce(listing(), " TABLE DATA ", "\tTABLE DATA "));
    expectInvalid(replaceOnce(listing(), " TABLE DATA ", "\u0000TABLE DATA "));
    expectInvalid(replaceOnce(listing(), ";\n; Selected", ";\r\n; Selected"));
    expectInvalid(listing().subarray(0, listing().length - 1));
  });

  it("enforces listing byte, line-count, and per-line byte bounds", () => {
    let oversizedValueOfReads = 0;
    const oversized = Buffer.alloc(
      POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES + 1,
      0x20,
    );
    Object.defineProperty(oversized, "valueOf", {
      configurable: true,
      get() {
        oversizedValueOfReads += 1;
        throw new Error("attacker_value_of_must_not_run");
      },
    });
    expectInvalid(oversized);
    expect(oversizedValueOfReads).toBe(0);
    expectInvalid(Buffer.from(
      ";\n".repeat(POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINES + 1),
      "utf8",
    ));
    const hugeDatabaseName = "a".repeat(
      POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_LINE_BYTES + 1,
    );
    expectInvalid(replaceOnce(listing(), "dbname: postgres", `dbname: ${hugeDatabaseName}`));
  });

  it("rejects proxies without invoking any attacker trap and normalizes the failure", () => {
    let traps = 0;
    const proxy = new Proxy(listing(), {
      get() {
        traps += 1;
        throw new Error("attacker_get_must_not_run");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("attacker_get_prototype_must_not_run");
      },
      ownKeys() {
        traps += 1;
        throw new Error("attacker_own_keys_must_not_run");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("attacker_descriptor_must_not_run");
      },
    });
    expectInvalid(proxy);
    expect(traps).toBe(0);
  });

  it("rejects own valueOf/length accessors and exotic Buffer prototypes without getters", () => {
    let ownValueOfReads = 0;
    const ownValueOf = listing();
    Object.defineProperty(ownValueOf, "valueOf", {
      configurable: true,
      get() {
        ownValueOfReads += 1;
        throw new Error("attacker_value_of_must_not_run");
      },
    });
    expectInvalid(ownValueOf);
    expect(ownValueOfReads).toBe(0);

    let ownLengthReads = 0;
    const ownLength = listing();
    Object.defineProperty(ownLength, "length", {
      configurable: true,
      get() {
        ownLengthReads += 1;
        throw new Error("attacker_length_must_not_run");
      },
    });
    expectInvalid(ownLength);
    expect(ownLengthReads).toBe(0);

    let exoticLengthReads = 0;
    const exotic = listing();
    Object.setPrototypeOf(exotic, Object.create(Buffer.prototype, {
      length: {
        configurable: true,
        get() {
          exoticLengthReads += 1;
          throw new Error("attacker_length_must_not_run");
        },
      },
    }));
    expectInvalid(exotic);
    expect(exoticLengthReads).toBe(0);
  });

  it("rejects non-Buffer input without inspecting attacker properties", () => {
    let reads = 0;
    const candidate = Object.create(null, {
      byteLength: {
        get() {
          reads += 1;
          throw new Error("attacker_byte_length_must_not_run");
        },
      },
      valueOf: {
        get() {
          reads += 1;
          throw new Error("attacker_value_of_must_not_run");
        },
      },
    });
    expectInvalid(candidate);
    expect(reads).toBe(0);
    expectInvalid("not-bytes");
  });

  it("has a passive TOC runtime import graph with only the literal table-data leaf", () => {
    const tocSource = fs.readFileSync(path.join(
      repositoryRoot,
      "src/lib/postgres-logical-backup-v4-toc.ts",
    ), "utf8");
    const leafSource = fs.readFileSync(path.join(
      repositoryRoot,
      "src/lib/postgres-logical-backup-v4-table-data-contract.ts",
    ), "utf8");
    const tocImports = [...tocSource.matchAll(/\bfrom\s+"([^"]+)"/g)]
      .map((match) => match[1]);

    expect(tocImports).toEqual([
      "node:crypto",
      "node:util",
      "./postgres-logical-backup-v4-table-data-contract.js",
    ]);
    expect(leafSource).not.toMatch(/\bfrom\s+["']/);
    expect(`${tocSource}\n${leafSource}`).not.toMatch(
      /postgres-migration-source|better-sqlite3|(?:node:)?fs(?:["'])|\bimport\s*\(/,
    );
  });
});
