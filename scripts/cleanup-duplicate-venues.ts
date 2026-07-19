import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";

import { createServerSupabaseClient } from "../src/lib/supabase-client.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

type JsonRow = Record<string, unknown>;

interface VenueRow extends JsonRow {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  google_place_id: string | null;
}

interface DuplicatePair {
  legacy: VenueRow;
  canonical: VenueRow;
  identityKey: string;
}

interface SupabaseReference {
  table: string;
  column: string;
}

interface CleanupSummary {
  sqlite: Record<string, number>;
  supabase: Record<string, number>;
}

const NAMED_VENUES = [
  "North Port Hotel",
  "Urban Ground Mordialloc",
  "Sandringham Hotel",
] as const;

const AUDITED_DUPLICATE_PAIRS = new Map<string, string>([
  ["c41dab48-8eca-4269-b5c6-a97cde74e7f3", "50ec752f-388e-4c1e-863c-8b04c62ae090"],
  ["ff3c18d6-1102-48fe-bc43-fac6b494712b", "d6fb2001-2f90-40e9-aef5-8910a17a8a0c"],
  ["7904bf7d-4f54-4891-93c1-98889fa733f0", "16318cc0-b7d3-4084-a7f7-95a4bd682554"],
  ["78607de7-4009-47ca-975d-b33e753806ec", "f88d136f-41a8-4e33-b1cf-bbc7f2f2b78e"],
  ["2bcd16c0-20ef-4736-aa05-1ce32bf51aa0", "c713c53b-94c8-43bd-ad9c-a5fa35c04d69"],
  ["b508f533-35b6-4ff4-a0d4-1edce0521423", "75ee7c75-9853-4806-8bc1-ea731cf628cf"],
  ["27b97227-2735-4a9c-ad7c-d1047f3f225e", "03721fdc-740e-4dc5-a98c-5e7e1f16a978"],
  ["836a7959-12d2-4f09-8b66-c5458694c746", "be043bfa-cfe6-46af-9cfa-c318fa75c030"],
  ["e9455a65-4b0d-45ec-9b31-ee49284598f9", "f3b10521-2ed4-46b2-b5a4-f4a1654a9d4e"],
  ["777df545-1dd9-4eb9-9e72-1a26c770d11d", "c772a759-147a-4acb-9881-de6f9be6ba90"],
  ["2c9eedfd-f91f-4b0d-b761-323148ceb76c", "25b9f385-6127-4f9d-ab52-8103611d7ba4"],
  ["fc60fef2-0e34-4702-85e5-c3504d11528f", "c1cb9fa3-2b78-4641-8741-61814701a7e5"],
  ["def35fb3-dc37-4549-bf10-9324721d4d06", "ab568647-2a67-4322-8969-ac0950ad87d4"],
  ["f85daf75-1b1c-453c-8849-737908bff4db", "07372810-f83d-4f10-90ed-c16b822ad448"],
  ["9338ed63-72c4-4eb8-9e81-287fe9a45ff3", "24fb4438-7317-4c8d-8bb4-23f55472769e"],
  ["f7a62b21-43f0-445b-8e41-af9cb5e78168", "c72b66eb-c39b-4c0c-859c-7a8a366f926b"],
  ["3c62cdcb-fecc-41e6-8ef0-0158d6f46d49", "a1d56295-d777-481d-81ed-53742de45d7d"],
  ["f4d57fbf-1e99-4f87-9f6d-56e2d144a9a4", "b6f99eff-3ab6-43e4-9d79-d34140e8bc71"],
]);

const AUDITED_DUPLICATE_SUBMISSIONS = new Map<string, {
  id: string;
  clientSubmissionId: string;
  priceRows: number;
}>([
  ["3c62cdcb-fecc-41e6-8ef0-0158d6f46d49", {
    id: "071adf71-9a55-56a2-8061-14a9812c96ce",
    clientSubmissionId: "codex-arbory-tap-list-duplicate-20260705",
    priceRows: 11,
  }],
  ["78607de7-4009-47ca-975d-b33e753806ec", {
    id: "5da8378f-d933-5e0b-8e7f-82b35d53ca6c",
    clientSubmissionId: "codex-garden-state-guinness-pint-duplicate-20260705",
    priceRows: 1,
  }],
  ["f7a62b21-43f0-445b-8e41-af9cb5e78168", {
    id: "1a9eef96-1b70-5a16-a652-fbc15b9f7c30",
    clientSubmissionId: "codex-natural-history-tap-pints-duplicate-20260705",
    priceRows: 10,
  }],
  ["27b97227-2735-4a9c-ad7c-d1047f3f225e", {
    id: "b141083f-3bb3-505e-a506-50e3c547d201",
    clientSubmissionId: "codex-duke-wellington-tap-range-duplicate-20260705",
    priceRows: 13,
  }],
]);

const AUDITED_STALE_INVENTORY = [
  {
    staleId: "admin-reviewed:61072025-0d4d-4938-9364-5d630e985dc3:guinness-stout:pint",
    currentId: "admin-reviewed:61072025-0d4d-4938-9364-5d630e985dc3:guinness:pint",
    latestPriceRecordId: "source-ingestion:6b4bbbfb-f4d6-4969-8880-410560d0322b:0",
    venueId: "61072025-0d4d-4938-9364-5d630e985dc3",
    stalePrice: 18,
    currentPrice: 17,
  },
  {
    staleId: "admin-reviewed:9102aedc-de45-4784-a2ce-f89b7d194c01:guinness-stout:pint",
    currentId: "admin-reviewed:9102aedc-de45-4784-a2ce-f89b7d194c01:guinness:pint",
    latestPriceRecordId: "source-ingestion:4ebb8b24-04ec-4d33-91ad-4ff2fbf09480:5",
    venueId: "9102aedc-de45-4784-a2ce-f89b7d194c01",
    stalePrice: 18,
    currentPrice: 16,
  },
] as const;

const SUPABASE_REFERENCES: SupabaseReference[] = [
  { table: "venue_menu_captures", column: "venue_id" },
  { table: "call_logs", column: "venue_id" },
  { table: "user_price_submissions", column: "venue_id" },
  { table: "discount_redemptions", column: "venue_id" },
  { table: "free_pint_reward_redemptions", column: "venue_id" },
  { table: "pint_point_drink_records", column: "venue_id" },
  { table: "beermap_uploads", column: "venue_id" },
  { table: "call_results", column: "venue_id" },
  { table: "guinness_prices", column: "venue_id" },
  { table: "venue_billing", column: "venue_id" },
  { table: "pint_point_ledger", column: "venue_id" },
  { table: "call_queue", column: "venue_id" },
  { table: "free_pint_reward_codes", column: "redeemed_venue_id" },
];

const SUPABASE_ZERO_ONLY_REFERENCES: SupabaseReference[] = [
  { table: "user_activity_events", column: "related_entity_id" },
  { table: "beermap_verifications", column: "target_entity_id" },
];

const ALL_SUPABASE_REFERENCES = [
  ...SUPABASE_REFERENCES,
  ...SUPABASE_ZERO_ONLY_REFERENCES,
];

const SQLITE_SPECIAL_REFERENCES: SupabaseReference[] = [
  { table: "venue_identity_aliases", column: "canonical_venue_id" },
  { table: "free_pint_reward_codes", column: "redeemed_venue_id" },
  { table: "user_activity_events", column: "related_entity_id" },
  { table: "verifications", column: "target_entity_id" },
];

const SQLITE_DIRECT_REFERENCE_TABLES = [
  "beer_price_results",
  "call_runs",
  "events",
  "submissions",
  "wrong_price_reports",
] as const;

const SQLITE_HANDLED_VENUE_TABLES = new Set<string>([
  ...SQLITE_DIRECT_REFERENCE_TABLES,
  "missions",
  "venue_beers",
  "venue_identity_aliases",
  "venue_location_cache",
  "venue_price_records",
  "venue_profiles",
  "venue_identity_aliases.canonical_venue_id",
]);

let backupRootForError: string | null = null;

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function argumentValue(name: string): string | null {
  const inline = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requiredExpectedPairCount(): number {
  const raw = argumentValue("expected-pairs");
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Pass --expected-pairs=<count> so the cleanup cannot silently expand scope.");
  }
  return parsed;
}

function requiredEnvironment(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("en-AU")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeAddress(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("en-AU")
    .replace(/,?\s*australia\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeValue(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function venueIdentityKey(venue: Pick<VenueRow, "name" | "address">): string {
  return `${normalizeName(venue.name)}|${normalizeAddress(venue.address)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function addCount(target: Record<string, number>, key: string, count: number): void {
  target[key] = (target[key] ?? 0) + count;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function asVenueRow(row: JsonRow): VenueRow {
  if (typeof row.id !== "string" || typeof row.name !== "string") {
    throw new Error("Supabase returned a venue without a string id and name.");
  }
  return {
    ...row,
    id: row.id,
    name: row.name,
    address: typeof row.address === "string" ? row.address : null,
    suburb: typeof row.suburb === "string" ? row.suburb : null,
    state: typeof row.state === "string" ? row.state : null,
    postcode: typeof row.postcode === "string" ? row.postcode : null,
    latitude: typeof row.latitude === "number" ? row.latitude : null,
    longitude: typeof row.longitude === "number" ? row.longitude : null,
    google_place_id: typeof row.google_place_id === "string" ? row.google_place_id : null,
  };
}

async function fetchAllRows(
  client: SupabaseClient,
  table: string,
  select = "*",
): Promise<JsonRow[]> {
  const output: JsonRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Unable to read ${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as JsonRow[];
    output.push(...rows);
    if (rows.length < pageSize) return output;
  }
}

async function fetchRowsForIds(
  client: SupabaseClient,
  reference: SupabaseReference,
  ids: string[],
): Promise<JsonRow[]> {
  if (ids.length === 0) return [];
  const output: JsonRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(reference.table)
      .select("*")
      .in(reference.column, ids)
      .order(reference.column, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`Unable to audit ${reference.table}.${reference.column}: ${error.message}`);
    }
    const rows = (data ?? []) as JsonRow[];
    output.push(...rows);
    if (rows.length < pageSize) return output;
  }
}

function findDuplicatePairs(venues: VenueRow[]): {
  pairs: DuplicatePair[];
  unresolved: Array<{ identityKey: string; rows: VenueRow[] }>;
} {
  const groups = new Map<string, VenueRow[]>();
  for (const venue of venues) {
    const identityKey = venueIdentityKey(venue);
    if (!normalizeName(venue.name) || !normalizeAddress(venue.address)) continue;
    const group = groups.get(identityKey) ?? [];
    group.push(venue);
    groups.set(identityKey, group);
  }

  const pairs: DuplicatePair[] = [];
  const unresolved: Array<{ identityKey: string; rows: VenueRow[] }> = [];
  for (const [identityKey, rows] of groups) {
    if (rows.length < 2) continue;
    const legacy = rows.filter((row) => !row.google_place_id);
    const canonical = rows.filter((row) => Boolean(row.google_place_id));
    if (rows.length === 2 && legacy.length === 1 && canonical.length === 1) {
      pairs.push({ legacy: legacy[0]!, canonical: canonical[0]!, identityKey });
    } else {
      unresolved.push({ identityKey, rows });
    }
  }
  pairs.sort((left, right) => left.legacy.name.localeCompare(right.legacy.name));
  return { pairs, unresolved };
}

function findNamedVenues(venues: VenueRow[]): VenueRow[] {
  return NAMED_VENUES.map((name) => {
    const matches = venues.filter((venue) => normalizeName(venue.name) === normalizeName(name));
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one Supabase row for ${name}; found ${matches.length}.`);
    }
    return matches[0]!;
  });
}

function buildAuditedDuplicatePairs(venues: VenueRow[], detectedPairs: DuplicatePair[]): {
  pairs: DuplicatePair[];
  activePairs: DuplicatePair[];
} {
  const venuesById = new Map(venues.map((venue) => [venue.id, venue]));
  const detectedByLegacyId = new Map(detectedPairs.map((pair) => [pair.legacy.id, pair]));
  const unexpected = detectedPairs.filter(
    (pair) => AUDITED_DUPLICATE_PAIRS.get(pair.legacy.id) !== pair.canonical.id,
  );
  if (unexpected.length > 0) {
    throw new Error(`Detected duplicate pairs differ from the reviewed manifest: ${JSON.stringify(unexpected.map((pair) => ({
      legacyId: pair.legacy.id,
      canonicalId: pair.canonical.id,
    })))}.`);
  }

  const pairs: DuplicatePair[] = [];
  const activePairs: DuplicatePair[] = [];
  for (const [legacyId, canonicalId] of AUDITED_DUPLICATE_PAIRS) {
    const canonical = venuesById.get(canonicalId);
    if (!canonical?.google_place_id) {
      throw new Error(`Audited canonical venue ${canonicalId} is missing or no longer Google-backed.`);
    }
    const legacy = venuesById.get(legacyId);
    if (legacy) {
      if (legacy.google_place_id || venueIdentityKey(legacy) !== venueIdentityKey(canonical)) {
        throw new Error(`Audited legacy venue ${legacyId} no longer matches canonical venue ${canonicalId}.`);
      }
      const detected = detectedByLegacyId.get(legacyId);
      if (!detected || detected.canonical.id !== canonicalId) {
        throw new Error(`Audited duplicate ${legacyId} -> ${canonicalId} was not detected as expected.`);
      }
      pairs.push(detected);
      activePairs.push(detected);
      continue;
    }
    pairs.push({
      legacy: { ...canonical, id: legacyId, google_place_id: null },
      canonical,
      identityKey: venueIdentityKey(canonical),
    });
  }
  return { pairs, activePairs };
}

function getSqliteVenueReferenceCounts(database: Database.Database, ids: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "venue_id")) continue;
    const row = database.prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)} WHERE venue_id IN (${placeholders(ids.length)})`,
    ).get(...ids) as { count: number };
    if (row.count > 0) counts[name] = row.count;
  }
  for (const reference of SQLITE_SPECIAL_REFERENCES) {
    const tableExists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(reference.table);
    if (!tableExists) continue;
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(reference.table)})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === reference.column)) continue;
    const row = database.prepare(
      `SELECT COUNT(*) AS count
         FROM ${quoteIdentifier(reference.table)}
        WHERE ${quoteIdentifier(reference.column)} IN (${placeholders(ids.length)})`,
    ).get(...ids) as { count: number };
    if (row.count > 0) counts[`${reference.table}.${reference.column}`] = row.count;
  }
  return counts;
}

function assertHandledSqliteReferences(counts: Record<string, number>): void {
  const unexpected = Object.entries(counts).filter(([table]) => !SQLITE_HANDLED_VENUE_TABLES.has(table));
  if (unexpected.length > 0) {
    throw new Error(`Refusing cleanup with unhandled SQLite references: ${JSON.stringify(unexpected)}.`);
  }
}

function priceIdentity(row: JsonRow): string {
  const beer = normalizeValue(row.normalized_beer_id) || normalizeName(row.beer_name);
  const price = typeof row.price === "number" ? row.price.toFixed(4) : "null";
  return [
    beer,
    normalizeValue(row.serving_size),
    price,
    Number(row.is_happy_hour_price ?? 0),
    normalizeValue(row.happy_hour_details),
    normalizeValue(row.is_on_tap),
    normalizeValue(row.confidence),
    normalizeValue(row.source_type),
  ].join("|");
}

function inventoryIdentity(row: JsonRow): string {
  const beer = normalizeValue(row.normalized_beer_id) || normalizeName(row.beer_name);
  const price = typeof row.price === "number" ? row.price.toFixed(4) : "null";
  return [
    beer,
    normalizeValue(row.serve_size),
    price,
    normalizeValue(row.currency),
    Number(row.on_tap ?? 0),
    Number(row.in_stock ?? 0),
  ].join("|");
}

function mergePriceRows(
  database: Database.Database,
  pair: DuplicatePair,
  summary: Record<string, number>,
): void {
  const duplicateSubmission = AUDITED_DUPLICATE_SUBMISSIONS.get(pair.legacy.id);
  const oldRows = database.prepare("SELECT * FROM venue_price_records WHERE venue_id = ?").all(pair.legacy.id) as JsonRow[];
  if (duplicateSubmission) {
    const submissionExists = Boolean(
      database.prepare("SELECT 1 FROM submissions WHERE id = ?").get(duplicateSubmission.id),
    );
    if (
      (submissionExists && oldRows.length !== duplicateSubmission.priceRows) ||
      (!submissionExists && oldRows.length > 0) ||
      oldRows.some((row) => row.source_submission_id !== duplicateSubmission.id)
    ) {
      throw new Error(`Legacy price provenance changed for ${pair.legacy.name}; refusing to delete it.`);
    }
  }
  const canonicalRows = database.prepare("SELECT * FROM venue_price_records WHERE venue_id = ?").all(pair.canonical.id) as JsonRow[];
  const canonicalByIdentity = new Map<string, JsonRow[]>();
  for (const row of canonicalRows) {
    const key = priceIdentity(row);
    canonicalByIdentity.set(key, [...canonicalByIdentity.get(key) ?? [], row]);
  }

  for (const row of oldRows) {
    const oldId = String(row.id);
    const transformedId = oldId.includes(pair.legacy.id)
      ? oldId.replace(pair.legacy.id, pair.canonical.id)
      : null;
    const exactIdMatch = transformedId
      ? canonicalRows.find((candidate) => candidate.id === transformedId)
      : null;
    if (exactIdMatch && priceIdentity(exactIdMatch) !== priceIdentity(row)) {
      throw new Error(`Canonical price ${String(exactIdMatch.id)} changed and no longer matches ${oldId}.`);
    }
    const logicalMatches = canonicalByIdentity.get(priceIdentity(row)) ?? [];
    const match = exactIdMatch ?? (logicalMatches.length === 1 ? logicalMatches[0] : null);
    if (!match && logicalMatches.length > 1) {
      throw new Error(`Ambiguous canonical price match for ${oldId}.`);
    }
    if (!match && duplicateSubmission) {
      throw new Error(`Audited duplicate price ${oldId} no longer has one canonical equivalent.`);
    }
    if (match) {
      database.prepare("UPDATE wrong_price_reports SET price_record_id = ? WHERE price_record_id = ?")
        .run(String(match.id), oldId);
      addCount(summary, "priceRowsDeleted", database.prepare("DELETE FROM venue_price_records WHERE id = ?").run(oldId).changes);
      continue;
    }
    addCount(
      summary,
      "priceRowsRetargeted",
      database.prepare(
        "UPDATE venue_price_records SET venue_id = ?, venue_name = ?, suburb = ? WHERE id = ?",
      ).run(pair.canonical.id, pair.canonical.name, pair.canonical.suburb, oldId).changes,
    );
  }
}

function removeDuplicateSubmission(
  database: Database.Database,
  pair: DuplicatePair,
  summary: Record<string, number>,
): void {
  const spec = AUDITED_DUPLICATE_SUBMISSIONS.get(pair.legacy.id);
  if (!spec) return;
  const row = database.prepare(
    "SELECT id, client_submission_id, venue_id, status, submission_type FROM submissions WHERE id = ?",
  ).get(spec.id) as JsonRow | undefined;
  if (!row) return;
  if (
    row.client_submission_id !== spec.clientSubmissionId ||
    row.venue_id !== pair.legacy.id ||
    row.status !== "approved" ||
    row.submission_type !== "photo_upload"
  ) {
    throw new Error(`Audited duplicate submission ${spec.id} no longer matches its reviewed provenance.`);
  }
  const dependencyChecks = [
    ["venue_price_records", "source_submission_id"],
    ["submission_items", "submission_id"],
    ["contribution_ledger", "submission_id"],
    ["verifications", "upload_id"],
    ["submission_source_evidence", "submission_id"],
    ["mission_progress", "submission_id"],
  ] as const;
  for (const [table, column] of dependencyChecks) {
    const dependency = database.prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
    ).get(spec.id) as { count: number };
    if (dependency.count > 0) {
      throw new Error(`Duplicate submission ${spec.id} still has ${dependency.count} ${table} dependencies.`);
    }
  }
  addCount(
    summary,
    "duplicateSubmissionsDeleted",
    database.prepare("DELETE FROM submissions WHERE id = ?").run(spec.id).changes,
  );
}

function mergeInventoryRows(
  database: Database.Database,
  pair: DuplicatePair,
  summary: Record<string, number>,
): void {
  const oldRows = database.prepare("SELECT * FROM venue_beers WHERE venue_id = ?").all(pair.legacy.id) as JsonRow[];
  const canonicalRows = database.prepare("SELECT * FROM venue_beers WHERE venue_id = ?").all(pair.canonical.id) as JsonRow[];
  const canonicalByIdentity = new Map<string, JsonRow[]>();
  for (const row of canonicalRows) {
    const key = inventoryIdentity(row);
    canonicalByIdentity.set(key, [...canonicalByIdentity.get(key) ?? [], row]);
  }

  for (const row of oldRows) {
    const oldId = String(row.id);
    const transformedId = oldId.includes(pair.legacy.id)
      ? oldId.replace(pair.legacy.id, pair.canonical.id)
      : null;
    const exactIdMatch = transformedId
      ? canonicalRows.find((candidate) => candidate.id === transformedId)
      : null;
    if (exactIdMatch && inventoryIdentity(exactIdMatch) !== inventoryIdentity(row)) {
      throw new Error(`Canonical inventory ${String(exactIdMatch.id)} changed and no longer matches ${oldId}.`);
    }
    const logicalMatches = canonicalByIdentity.get(inventoryIdentity(row)) ?? [];
    const match = exactIdMatch ?? (logicalMatches.length === 1 ? logicalMatches[0] : null);
    if (!match && logicalMatches.length > 1) {
      throw new Error(`Ambiguous canonical inventory match for ${oldId}.`);
    }
    if (match) {
      addCount(summary, "inventoryRowsDeleted", database.prepare("DELETE FROM venue_beers WHERE id = ?").run(oldId).changes);
      continue;
    }
    addCount(
      summary,
      "inventoryRowsRetargeted",
      database.prepare("UPDATE venue_beers SET venue_id = ? WHERE id = ?").run(pair.canonical.id, oldId).changes,
    );
  }
}

function assertSafeProfileRemoval(database: Database.Database, pair: DuplicatePair): void {
  const legacy = database.prepare("SELECT * FROM venue_profiles WHERE venue_id = ?").get(pair.legacy.id) as JsonRow | undefined;
  if (!legacy) return;
  const canonical = database.prepare("SELECT * FROM venue_profiles WHERE venue_id = ?").get(pair.canonical.id) as JsonRow | undefined;
  if (!canonical) {
    throw new Error(`Legacy SQLite profile ${pair.legacy.id} has no canonical profile to merge into.`);
  }

  const protectedColumns = [
    "membership_tier",
    "highlighted_name",
    "premium_badge",
    "promoted",
    "featured_special_eligible",
    "stripe_customer_id",
    "stripe_subscription_id",
    "subscription_status",
    "tier_manual_override",
    "accepts_pint_path_codes",
  ];
  for (const column of protectedColumns) {
    const oldValue = legacy[column];
    const newValue = canonical[column];
    const legacyHasValue = oldValue != null && oldValue !== "" && oldValue !== 0 && oldValue !== "basic";
    if (legacyHasValue && oldValue !== newValue) {
      throw new Error(`Refusing to discard conflicting venue_profiles.${column} for ${pair.legacy.name}.`);
    }
  }
}

function mergeLocationCache(database: Database.Database, pair: DuplicatePair, summary: Record<string, number>): void {
  const legacy = database.prepare("SELECT * FROM venue_location_cache WHERE venue_id = ?").get(pair.legacy.id) as JsonRow | undefined;
  if (!legacy) return;
  const canonical = database.prepare("SELECT * FROM venue_location_cache WHERE venue_id = ?").get(pair.canonical.id) as JsonRow | undefined;
  if (canonical) {
    for (const coordinate of ["latitude", "longitude"] as const) {
      const legacyValue = legacy[coordinate];
      const canonicalValue = canonical[coordinate];
      if (
        typeof legacyValue === "number" &&
        typeof canonicalValue === "number" &&
        Math.abs(legacyValue - canonicalValue) > 0.002
      ) {
        throw new Error(`Conflicting ${coordinate} values for ${pair.legacy.name}; refusing location merge.`);
      }
    }
    database.prepare(
      `UPDATE venue_location_cache
          SET venue_name = ?, suburb = ?,
              latitude = COALESCE(latitude, ?), longitude = COALESCE(longitude, ?), updated_at = ?
        WHERE venue_id = ?`,
    ).run(
      pair.canonical.name,
      pair.canonical.suburb,
      legacy.latitude,
      legacy.longitude,
      new Date().toISOString(),
      pair.canonical.id,
    );
    addCount(summary, "locationRowsDeleted", database.prepare("DELETE FROM venue_location_cache WHERE venue_id = ?").run(pair.legacy.id).changes);
  } else {
    addCount(
      summary,
      "locationRowsRetargeted",
      database.prepare(
        "UPDATE venue_location_cache SET venue_id = ?, venue_name = ?, suburb = ? WHERE venue_id = ?",
      ).run(pair.canonical.id, pair.canonical.name, pair.canonical.suburb, pair.legacy.id).changes,
    );
  }
}

function removeAutoMissions(database: Database.Database, pair: DuplicatePair, summary: Record<string, number>): void {
  const missions = database.prepare(
    `SELECT m.id,
            COUNT(DISTINCT mp.id) AS progress,
            COUNT(DISTINCT s.id) AS submissions,
            COUNT(DISTINCT vr.id) AS requests
       FROM missions m
       LEFT JOIN mission_progress mp ON mp.mission_id = m.id
       LEFT JOIN submissions s ON s.mission_id = m.id
       LEFT JOIN venue_requests vr ON vr.mission_id = m.id
      WHERE m.venue_id = ?
      GROUP BY m.id`,
  ).all(pair.legacy.id) as Array<{ id: string; progress: number; submissions: number; requests: number }>;
  for (const mission of missions) {
    if (
      mission.id.startsWith("auto:") &&
      mission.progress === 0 &&
      mission.submissions === 0 &&
      mission.requests === 0
    ) {
      addCount(summary, "autoMissionsDeleted", database.prepare("DELETE FROM missions WHERE id = ?").run(mission.id).changes);
    } else {
      addCount(
        summary,
        "missionsRetargeted",
        database.prepare("UPDATE missions SET venue_id = ?, venue_name = ?, suburb = ? WHERE id = ?")
          .run(pair.canonical.id, pair.canonical.name, pair.canonical.suburb, mission.id).changes,
      );
    }
  }
}

function upsertAliases(database: Database.Database, pair: DuplicatePair, now: string): void {
  database.prepare(
    "UPDATE venue_identity_aliases SET canonical_venue_id = ?, updated_at = ? WHERE canonical_venue_id = ?",
  ).run(pair.canonical.id, now, pair.legacy.id);
  const upsert = database.prepare(
    `INSERT INTO venue_identity_aliases (
       alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
     ) VALUES (?, ?, ?, 'manual_data_cleanup', ?, ?)
     ON CONFLICT(alias_venue_id) DO UPDATE SET
       canonical_venue_id = excluded.canonical_venue_id,
       identity_key = excluded.identity_key,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  );
  upsert.run(pair.legacy.id, pair.canonical.id, pair.identityKey, now, now);
  upsert.run(pair.canonical.id, pair.canonical.id, pair.identityKey, now, now);
}

function removeStaleInventoryRows(database: Database.Database, summary: Record<string, number>): void {
  for (const spec of AUDITED_STALE_INVENTORY) {
    const stale = database.prepare(
      "SELECT id, venue_id, beer_name, normalized_beer_id, serve_size, price, on_tap, in_stock, notes FROM venue_beers WHERE id = ?",
    ).get(spec.staleId) as JsonRow | undefined;
    if (!stale) continue;
    const current = database.prepare(
      "SELECT id, venue_id, beer_name, normalized_beer_id, serve_size, price, on_tap, in_stock FROM venue_beers WHERE id = ?",
    ).get(spec.currentId) as JsonRow | undefined;
    const latest = database.prepare(
      `SELECT id, price, normalized_beer_id, serving_size, is_happy_hour_price, confidence
         FROM venue_price_records
        WHERE venue_id = ? AND normalized_beer_id = 'guinness' AND serving_size = 'pint'
          AND is_happy_hour_price = 0
        ORDER BY last_verified_at DESC, updated_at DESC
        LIMIT 1`,
    ).get(spec.venueId) as JsonRow | undefined;
    const staleValid =
      stale.venue_id === spec.venueId &&
      stale.beer_name === "Guinness" &&
      stale.normalized_beer_id === "guinness" &&
      stale.serve_size === "pint" &&
      stale.price === spec.stalePrice &&
      stale.on_tap === 1 &&
      stale.in_stock === 1 &&
      stale.notes === "Backfilled from approved live price record.";
    const currentValid =
      current?.venue_id === spec.venueId &&
      current.beer_name === "Guinness" &&
      current.normalized_beer_id === "guinness" &&
      current.serve_size === "pint" &&
      current.price === spec.currentPrice &&
      current.on_tap === 1 &&
      current.in_stock === 1;
    const latestValid =
      latest?.id === spec.latestPriceRecordId &&
      latest.price === spec.currentPrice &&
      latest.normalized_beer_id === "guinness" &&
      latest.serving_size === "pint" &&
      latest.is_happy_hour_price === 0 &&
      latest.confidence === "photo_verified";
    if (!staleValid || !currentValid || !latestValid) {
      throw new Error(`Audited stale inventory invariants changed for ${spec.staleId}; refusing deletion.`);
    }
    addCount(
      summary,
      "staleInventoryRowsDeleted",
      database.prepare("DELETE FROM venue_beers WHERE id = ?").run(spec.staleId).changes,
    );
  }
}

function updateNamedVenueProfiles(database: Database.Database, venues: VenueRow[], summary: Record<string, number>): void {
  for (const venue of venues) {
    addCount(
      summary,
      "namedProfilesNormalised",
      database.prepare(
        `UPDATE venue_profiles
            SET name = ?, address = ?, suburb = ?, area = COALESCE(?, area), updated_at = ?
          WHERE venue_id = ?
            AND (name != ? OR address IS NOT ? OR suburb IS NOT ?)`,
      ).run(
        venue.name,
        venue.address,
        venue.suburb,
        venue.suburb,
        new Date().toISOString(),
        venue.id,
        venue.name,
        venue.address,
        venue.suburb,
      ).changes,
    );
    const location = database.prepare(
      "SELECT venue_name, suburb, latitude, longitude FROM venue_location_cache WHERE venue_id = ?",
    ).get(venue.id) as JsonRow | undefined;
    const latitude = venue.latitude ?? location?.latitude ?? null;
    const longitude = venue.longitude ?? location?.longitude ?? null;
    if (
      location &&
      (
        location.venue_name !== venue.name ||
        location.suburb !== venue.suburb ||
        location.latitude !== latitude ||
        location.longitude !== longitude
      )
    ) {
      addCount(
        summary,
        "namedLocationsNormalised",
        database.prepare(
          `UPDATE venue_location_cache
              SET venue_name = ?, suburb = ?, latitude = ?, longitude = ?, updated_at = ?
            WHERE venue_id = ?`,
        ).run(
          venue.name,
          venue.suburb,
          latitude,
          longitude,
          new Date().toISOString(),
          venue.id,
        ).changes,
      );
    }
  }
}

function cleanSqlite(
  database: Database.Database,
  pairs: DuplicatePair[],
  namedVenues: VenueRow[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  const legacyIds = pairs.map((pair) => pair.legacy.id);
  const cleanup = database.transaction(() => {
    assertHandledSqliteReferences(getSqliteVenueReferenceCounts(database, legacyIds));
    for (const pair of pairs) {
      assertSafeProfileRemoval(database, pair);
      mergePriceRows(database, pair, summary);
      removeDuplicateSubmission(database, pair, summary);
      mergeInventoryRows(database, pair, summary);
      removeAutoMissions(database, pair, summary);
      for (const table of SQLITE_DIRECT_REFERENCE_TABLES) {
        addCount(
          summary,
          `${table}Retargeted`,
          database.prepare(`UPDATE ${quoteIdentifier(table)} SET venue_id = ? WHERE venue_id = ?`)
            .run(pair.canonical.id, pair.legacy.id).changes,
        );
      }
      mergeLocationCache(database, pair, summary);
      addCount(
        summary,
        "legacyProfilesDeleted",
        database.prepare("DELETE FROM venue_profiles WHERE venue_id = ?").run(pair.legacy.id).changes,
      );
    }

    const demoMission = database.prepare(
      `SELECT m.id,
              COUNT(DISTINCT mp.id) AS progress,
              COUNT(DISTINCT s.id) AS submissions,
              COUNT(DISTINCT vr.id) AS requests
         FROM missions m
         LEFT JOIN mission_progress mp ON mp.mission_id = m.id
         LEFT JOIN submissions s ON s.mission_id = m.id
         LEFT JOIN venue_requests vr ON vr.mission_id = m.id
        WHERE m.id = 'mission:sandringham-hotel' OR m.venue_id = 'demo:sandringham-hotel'
        GROUP BY m.id`,
    ).all() as Array<{ id: string; progress: number; submissions: number; requests: number }>;
    for (const mission of demoMission) {
      if (mission.progress === 0 && mission.submissions === 0 && mission.requests === 0) {
        addCount(summary, "demoMissionsDeleted", database.prepare("DELETE FROM missions WHERE id = ?").run(mission.id).changes);
      } else {
        addCount(summary, "demoMissionsDeactivated", database.prepare("UPDATE missions SET active = 0 WHERE id = ?").run(mission.id).changes);
      }
    }

    updateNamedVenueProfiles(database, namedVenues, summary);
    removeStaleInventoryRows(database, summary);
    const remainingReferences = Object.entries(getSqliteVenueReferenceCounts(database, legacyIds))
      .filter(([key]) => key !== "venue_identity_aliases.canonical_venue_id");
    if (remainingReferences.length > 0) {
      throw new Error(`SQLite cleanup left legacy references: ${JSON.stringify(remainingReferences)}.`);
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (foreignKeys.length > 0) throw new Error(`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}.`);
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}.`);
    }
  });
  cleanup.immediate();
  return summary;
}

function normalizeSqliteAliases(database: Database.Database, pairs: DuplicatePair[]): number {
  const now = new Date().toISOString();
  const normalize = database.transaction(() => {
    for (const pair of pairs) upsertAliases(database, pair, now);
    const legacyIds = pairs.map((pair) => pair.legacy.id);
    const remainingReferences = getSqliteVenueReferenceCounts(database, legacyIds);
    if (Object.keys(remainingReferences).length > 0) {
      throw new Error(`Alias normalization left legacy references: ${JSON.stringify(remainingReferences)}.`);
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) throw new Error(`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}.`);
  });
  normalize.immediate();
  return pairs.length * 2;
}

async function createCleanupBackup(input: {
  databasePath: string;
  backupRoot: string;
  pairs: DuplicatePair[];
  supabaseReferences: Record<string, JsonRow[]>;
}): Promise<void> {
  await fs.promises.mkdir(input.backupRoot, { recursive: false, mode: 0o700 });
  const databaseBackupPath = path.join(input.backupRoot, "before-cleanup.sqlite");
  const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(databaseBackupPath);
  } finally {
    database.close();
  }
  await fs.promises.chmod(databaseBackupPath, 0o600);
  const backup = new Database(databaseBackupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = backup.pragma("foreign_key_check") as unknown[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || foreignKeys.length > 0) {
      throw new Error("Cleanup backup failed its SQLite integrity checks.");
    }
  } finally {
    backup.close();
  }
  await fs.promises.writeFile(
    path.join(input.backupRoot, "supabase-before-cleanup.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), pairs: input.pairs, references: input.supabaseReferences }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function cleanSupabase(
  client: SupabaseClient,
  pairs: DuplicatePair[],
): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  const updates = pairs.flatMap((pair) => SUPABASE_REFERENCES.map((reference) => ({ pair, reference })));
  await mapWithConcurrency(updates, 8, async ({ pair, reference }) => {
      const { data, error } = await client
        .from(reference.table)
        .update({ [reference.column]: pair.canonical.id })
        .eq(reference.column, pair.legacy.id)
        .select(reference.column);
      if (error) {
        throw new Error(`Unable to retarget ${reference.table}.${reference.column}: ${error.message}`);
      }
      addCount(summary, `${reference.table}.${reference.column}`, data?.length ?? 0);
  });
  const legacyIds = pairs.map((pair) => pair.legacy.id);
  await mapWithConcurrency(ALL_SUPABASE_REFERENCES, 8, async (reference) => {
    const remaining = await fetchRowsForIds(client, reference, legacyIds);
    if (remaining.length > 0) {
      throw new Error(`${reference.table}.${reference.column} still has ${remaining.length} legacy references; no venues were deleted.`);
    }
  });
  const { data, error } = await client
    .from("venues")
    .delete()
    .in("id", legacyIds)
    .select("id");
  if (error) throw new Error(`Unable to delete legacy venues: ${error.message}`);
  const deletedIds = (data ?? []).map((row) => String((row as JsonRow).id));
  if (deletedIds.some((id) => !legacyIds.includes(id))) {
    throw new Error(`Supabase deleted an unexpected venue ID: ${JSON.stringify(deletedIds)}.`);
  }
  addCount(summary, "venuesDeleted", deletedIds.length);
  return summary;
}

async function verifyCleanup(input: {
  client: SupabaseClient;
  database: Database.Database;
  pairs: DuplicatePair[];
}): Promise<void> {
  const legacyIds = input.pairs.map((pair) => pair.legacy.id);
  const currentVenues = (await fetchAllRows(input.client, "venues")).map(asVenueRow);
  const duplicates = findDuplicatePairs(currentVenues);
  if (duplicates.pairs.length > 0 || duplicates.unresolved.length > 0) {
    throw new Error("Supabase still contains normalized duplicate venue groups after cleanup.");
  }
  await mapWithConcurrency(ALL_SUPABASE_REFERENCES, 8, async (reference) => {
    const rows = await fetchRowsForIds(input.client, reference, legacyIds);
    if (rows.length > 0) throw new Error(`${reference.table}.${reference.column} still references legacy venue IDs.`);
  });
  const oldVenueRows = currentVenues.filter((venue) => legacyIds.includes(venue.id));
  if (oldVenueRows.length > 0) throw new Error("Supabase still contains legacy venue rows.");

  const sqliteCounts = getSqliteVenueReferenceCounts(input.database, legacyIds);
  const nonAliasReferences = Object.entries(sqliteCounts).filter(([table]) => table !== "venue_identity_aliases");
  if (nonAliasReferences.length > 0) {
    throw new Error(`SQLite still references legacy venue IDs: ${JSON.stringify(nonAliasReferences)}.`);
  }
  const invalidAliases = input.database.prepare(
    `SELECT alias_venue_id, canonical_venue_id
       FROM venue_identity_aliases
      WHERE canonical_venue_id IN (${placeholders(legacyIds.length)})`,
  ).all(...legacyIds);
  if (invalidAliases.length > 0) {
    throw new Error(`SQLite aliases still point at legacy IDs: ${JSON.stringify(invalidAliases)}.`);
  }
  for (const pair of input.pairs) {
    const aliases = input.database.prepare(
      `SELECT alias_venue_id, canonical_venue_id, source
         FROM venue_identity_aliases
        WHERE alias_venue_id IN (?, ?)
        ORDER BY alias_venue_id`,
    ).all(pair.legacy.id, pair.canonical.id) as Array<{
      alias_venue_id: string;
      canonical_venue_id: string;
      source: string;
    }>;
    if (
      aliases.length !== 2 ||
      aliases.some((alias) => alias.canonical_venue_id !== pair.canonical.id || alias.source !== "manual_data_cleanup")
    ) {
      throw new Error(`SQLite aliases were not normalized for ${pair.legacy.id} -> ${pair.canonical.id}.`);
    }
  }
  for (const spec of AUDITED_DUPLICATE_SUBMISSIONS.values()) {
    if (input.database.prepare("SELECT 1 FROM submissions WHERE id = ?").get(spec.id)) {
      throw new Error(`Duplicate submission ${spec.id} remains after cleanup.`);
    }
  }
  for (const spec of AUDITED_STALE_INVENTORY) {
    if (input.database.prepare("SELECT 1 FROM venue_beers WHERE id = ?").get(spec.staleId)) {
      throw new Error(`Stale inventory row ${spec.staleId} remains after cleanup.`);
    }
  }
  const demoMission = input.database.prepare(
    "SELECT COUNT(*) AS count FROM missions WHERE active = 1 AND (id = 'mission:sandringham-hotel' OR venue_id = 'demo:sandringham-hotel')",
  ).get() as { count: number };
  if (demoMission.count > 0) throw new Error("The demo Sandringham mission is still active.");
}

async function main(): Promise<void> {
  const apply = hasFlag("apply");
  if (apply) {
    assertOperatorMutationAllowed("Duplicate venue cleanup --apply");
  }
  const expectedPairs = requiredExpectedPairCount();
  const databasePath = path.resolve(process.env.DATABASE_PATH || "./data/melb-beer-bot.sqlite");
  if (!fs.existsSync(databasePath)) throw new Error(`SQLite database does not exist: ${databasePath}`);

  const supabaseUrl = requiredEnvironment("SUPABASE_URL");
  const supabaseServiceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const client = createServerSupabaseClient(supabaseUrl, supabaseServiceRoleKey);
  const venues = (await fetchAllRows(client, "venues")).map(asVenueRow);
  const { pairs: detectedPairs, unresolved } = findDuplicatePairs(venues);
  const namedVenues = findNamedVenues(venues);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved duplicate venue groups require review: ${JSON.stringify(unresolved.map((group) => ({
      identityKey: group.identityKey,
      ids: group.rows.map((row) => row.id),
    })))}.`);
  }
  if (expectedPairs !== AUDITED_DUPLICATE_PAIRS.size) {
    throw new Error(`Expected-pairs must equal the reviewed manifest size of ${AUDITED_DUPLICATE_PAIRS.size}.`);
  }
  const { pairs, activePairs } = buildAuditedDuplicatePairs(venues, detectedPairs);

  const legacyIds = pairs.map((pair) => pair.legacy.id);
  const database = new Database(databasePath, { readonly: !apply, fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const sqliteReferences = getSqliteVenueReferenceCounts(database, legacyIds);
    assertHandledSqliteReferences(sqliteReferences);
    const referenceResults = await mapWithConcurrency(ALL_SUPABASE_REFERENCES, 8, async (reference) => {
      const key = `${reference.table}.${reference.column}`;
      const rows = await fetchRowsForIds(client, reference, legacyIds);
      return { key, rows };
    });
    const supabaseReferences: Record<string, JsonRow[]> = Object.fromEntries(
      referenceResults.filter(({ rows }) => rows.length > 0).map(({ key, rows }) => [key, rows]),
    );
    const unsafePolymorphicReferences = SUPABASE_ZERO_ONLY_REFERENCES.flatMap((reference) => {
      const key = `${reference.table}.${reference.column}`;
      const rows = supabaseReferences[key] ?? [];
      return rows.length > 0 ? [{ key, count: rows.length }] : [];
    });
    if (unsafePolymorphicReferences.length > 0) {
      throw new Error(`Polymorphic Supabase references require manual review: ${JSON.stringify(unsafePolymorphicReferences)}.`);
    }

    const report = {
      mode: apply ? "apply" : "dry-run",
      databasePath,
      activeDuplicatePairs: activePairs.map((pair) => ({
        name: pair.legacy.name,
        legacyId: pair.legacy.id,
        canonicalId: pair.canonical.id,
      })),
      namedVenues: namedVenues.map((venue) => ({ name: venue.name, id: venue.id, address: venue.address })),
      sqliteReferences,
      supabaseReferenceCounts: Object.fromEntries(
        Object.entries(supabaseReferences).map(([key, rows]) => [key, rows.length]),
      ),
    };
    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = path.resolve(
      argumentValue("backup-dir") ?? path.join(path.dirname(databasePath), "backups", `venue-dedupe-${timestamp}`),
    );
    backupRootForError = backupRoot;
    await fs.promises.mkdir(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
    await createCleanupBackup({ databasePath, backupRoot, pairs, supabaseReferences });

    const sqliteSummary = cleanSqlite(database, pairs, namedVenues);
    const supabaseSummary = await cleanSupabase(client, pairs);
    sqliteSummary.aliasRowsNormalised = normalizeSqliteAliases(database, pairs);
    await verifyCleanup({ client, database, pairs });
    const summary: CleanupSummary = { sqlite: sqliteSummary, supabase: supabaseSummary };
    console.log(JSON.stringify({ ok: true, backupRoot, ...report, summary }, null, 2));
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message, backupRoot: backupRootForError }, null, 2));
  process.exitCode = 1;
});
