import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { getBeerByKey, normalizeTargetBeerKey } from "../src/constants/beers.js";
import { env } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import type { CallStatus, ParseStatus } from "../src/db/models.js";
import { isRetryableVenueOutcome } from "../src/lib/call-batch.js";
import { normalizeAustralianPhoneToE164 } from "../src/lib/phone.js";
import { buildReviewVenueRow } from "../src/lib/venue-directory.js";

interface VenueRow {
  id: string;
  name: string;
  suburb: string | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
}

interface LocalCallRunRow {
  venueId: string | null;
  requestedBeer: string | null;
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage: string | null;
  createdAt: string;
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function fetchAllRows<T>(table: string, select: string): Promise<T[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const rows: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to fetch ${table}: ${error.message}`);
    }

    const batch = (data ?? []) as T[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  return rows;
}

function escapeCsv(value: string | number | boolean | null): string {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

async function main() {
  const targetBeer = normalizeTargetBeerKey(getArg("beer", env.TARGET_BEER));
  const limit = Number.parseInt(getArg("limit", "0") ?? "0", 10);
  const suburbFilter = getArg("suburb")?.trim().toLowerCase();
  const includeCalled = hasFlag("include-called");
  const includeNotReady = hasFlag("include-not-ready");
  const outputBase = path.resolve(
    process.cwd(),
    getArg("output", "./data/venue-call-review")!,
  );
  const database = createDatabase();

  try {
    const venues = await fetchAllRows<VenueRow>(
      "venues",
      "id, name, suburb, address, phone, latitude, longitude, source",
    );
    const latestCallByVenueId = new Map<string, string>();
    const localRuns = database
      .prepare(
        `SELECT
           venue_id AS venueId,
           requested_beer AS requestedBeer,
           call_status AS callStatus,
           parse_status AS parseStatus,
           error_message AS errorMessage,
           created_at AS createdAt
         FROM call_runs
         WHERE is_test = 0
           AND venue_id IS NOT NULL
         ORDER BY created_at DESC`,
      )
      .all() as LocalCallRunRow[];

    for (const row of localRuns) {
      if (!row.venueId || normalizeTargetBeerKey(row.requestedBeer) !== targetBeer) {
        continue;
      }

      const alreadyResolved = !isRetryableVenueOutcome({
        callStatus: row.callStatus,
        parseStatus: row.parseStatus,
        errorMessage: row.errorMessage,
      });

      if (alreadyResolved && !latestCallByVenueId.has(row.venueId)) {
        latestCallByVenueId.set(row.venueId, row.createdAt);
      }
    }

    const reviewRows = venues
      .map((venue) =>
        buildReviewVenueRow({
          id: venue.id,
          name: venue.name,
          suburb: venue.suburb,
          address: venue.address,
          phone: venue.phone,
          normalizedPhone: normalizeAustralianPhoneToE164(venue.phone),
          latitude: venue.latitude,
          longitude: venue.longitude,
          source: venue.source,
          alreadyCalled: latestCallByVenueId.has(venue.id),
          latestCallAt: latestCallByVenueId.get(venue.id) ?? null,
        }),
      )
      .filter((row) =>
        suburbFilter
          ? `${row.suburb ?? ""} ${row.address ?? ""}`.toLowerCase().includes(suburbFilter)
          : true,
      )
      .filter((row) => (includeCalled ? true : !row.alreadyCalled))
      .filter((row) => (includeNotReady ? true : row.callEligible))
      .sort((left, right) => left.venueName.localeCompare(right.venueName));

    const selectedRows = limit > 0 ? reviewRows.slice(0, limit) : reviewRows;
    const jsonPath = `${outputBase}.json`;
    const csvPath = `${outputBase}.csv`;

    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(selectedRows, null, 2));

    const csvHeader = [
      "venueId",
      "venueName",
      "suburb",
      "address",
      "phone",
      "normalizedPhone",
      "latitude",
      "longitude",
      "source",
      "alreadyCalled",
      "latestCallAt",
      "callEligible",
      "issues",
    ];
    const csvRows = [
      csvHeader.join(","),
      ...selectedRows.map((row) =>
        [
          row.venueId,
          row.venueName,
          row.suburb,
          row.address,
          row.phone,
          row.normalizedPhone,
          row.latitude,
          row.longitude,
          row.source,
          row.alreadyCalled,
          row.latestCallAt,
          row.callEligible,
          row.issues.join("|"),
        ]
          .map((value) => escapeCsv(value ?? null))
          .join(","),
      ),
    ];

    fs.writeFileSync(csvPath, `${csvRows.join("\n")}\n`);

    console.log(`Exported ${selectedRows.length} review rows for ${getBeerByKey(targetBeer).name}.`);
    console.log(`JSON: ${jsonPath}`);
    console.log(`CSV: ${csvPath}`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
