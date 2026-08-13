import { findTrackedBeerByName } from "../constants/beers.js";
import type { LocalVenueLookup } from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const MAX_PUBLIC_VENUE_BEER_SUMMARY_IDS = 1_000;
const EFFECTIVELY_UNBOUNDED_QUERY_LIMIT = 2_147_483_647;

interface PublicVenueDirectoryRow {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  description: string | null;
  opening_hours_json: unknown;
  venue_tags_json: unknown;
}

interface PublicVenueBeerRow {
  venue_id: string;
  normalized_beer_id: string | null;
  beer_name: string;
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeCoordinate(value: number | string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeDirectoryLimit(limit: number): number {
  if (limit < 0) return EFFECTIVELY_UNBOUNDED_QUERY_LIMIT;
  if (!Number.isFinite(limit)) return 1;
  return Math.min(EFFECTIVELY_UNBOUNDED_QUERY_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeDirectoryOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(EFFECTIVELY_UNBOUNDED_QUERY_LIMIT, Math.max(0, Math.trunc(offset)));
}

/**
 * Async public venue-directory reads shared by the SQLite rehearsal runtime and
 * the native Postgres runtime. This repository deliberately owns no writes.
 */
export class PublicVenueDirectoryRepository {
  constructor(private readonly database: SqlDatabase) {}

  async listPublicVenueDirectoryPage(input: {
    query?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ venues: LocalVenueLookup[]; total: number }> {
    const query = input.query?.trim().toLowerCase() ?? "";
    const escapedQuery = query
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const pattern = `%${escapedQuery}%`;
    const binaryCollation = this.database.dialect === "postgres"
      ? 'COLLATE "C"'
      : "COLLATE BINARY";
    const deterministicNameOrder = `lower(name) ${binaryCollation} ASC, name ${binaryCollation} ASC`;
    const directoryCte = `WITH candidates AS (
      SELECT
        profile.venue_id AS id,
        profile.name AS name,
        profile.address AS address,
        profile.suburb AS suburb,
        'VIC' AS state,
        NULL AS postcode,
        location.latitude AS latitude,
        location.longitude AS longitude,
        profile.phone AS phone,
        profile.website AS website,
        profile.instagram AS instagram,
        profile.description AS description,
        profile.opening_hours_json AS opening_hours_json,
        profile.venue_tags_json AS venue_tags_json,
        0 AS source_rank,
        profile.updated_at AS source_updated_at
      FROM venue_profiles profile
      LEFT JOIN venue_location_cache location ON location.venue_id = profile.venue_id
      WHERE profile.active = TRUE
      UNION ALL
      SELECT
        mission.venue_id AS id,
        mission.venue_name AS name,
        NULL AS address,
        mission.suburb AS suburb,
        'VIC' AS state,
        NULL AS postcode,
        NULL AS latitude,
        NULL AS longitude,
        NULL AS phone,
        NULL AS website,
        NULL AS instagram,
        NULL AS description,
        '{}' AS opening_hours_json,
        '[]' AS venue_tags_json,
        1 AS source_rank,
        mission.updated_at AS source_updated_at
      FROM missions mission
      WHERE mission.active = TRUE
    ), ranked AS (
      SELECT candidates.*,
        row_number() OVER (
          PARTITION BY id
          ORDER BY source_rank ASC, source_updated_at DESC, ${deterministicNameOrder}
        ) AS source_row
      FROM candidates
    ), directory AS (
      SELECT * FROM ranked
      WHERE source_row = 1
        AND (? = '' OR lower(
          name || ' ' || COALESCE(suburb, '') || ' ' || COALESCE(address, '')
        ) LIKE ? ESCAPE '\\')
    )`;
    const [rows, countRow] = await Promise.all([
      this.database.prepare(
        `${directoryCte}
         SELECT id, name, address, suburb, state, postcode, latitude, longitude,
                phone, website, instagram, description, opening_hours_json, venue_tags_json
         FROM directory
         ORDER BY ${deterministicNameOrder}, id ${binaryCollation} ASC
         LIMIT ? OFFSET ?`,
      ).all<PublicVenueDirectoryRow>(
        query,
        pattern,
        normalizeDirectoryLimit(input.limit),
        normalizeDirectoryOffset(input.offset),
      ),
      this.database.prepare(
        `${directoryCte} SELECT count(*) AS count FROM directory`,
      ).get<{ count: number | string }>(query, pattern),
    ]);

    return {
      venues: rows.map((row) => {
        const venueTags = parseJsonArray(row.venue_tags_json);
        return {
          id: row.id,
          name: row.name,
          address: row.address,
          suburb: row.suburb,
          state: row.state,
          postcode: row.postcode,
          latitude: normalizeCoordinate(row.latitude),
          longitude: normalizeCoordinate(row.longitude),
          phone: row.phone,
          website: row.website,
          instagram: row.instagram,
          description: row.description,
          openingHours: parseJsonObject(row.opening_hours_json),
          venueTags,
          isUserSubmittedVenue: venueTags.includes("user submitted"),
        };
      }),
      total: Number(countRow?.count ?? 0),
    };
  }

  async listPublicVenueBeerKeys(venueIds: readonly string[]): Promise<Map<string, string[]>> {
    const requestedVenueIds = Array.from(new Set(
      venueIds
        .map((venueId) => venueId.trim())
        .filter(Boolean),
    )).slice(0, MAX_PUBLIC_VENUE_BEER_SUMMARY_IDS);
    const beerKeysByVenue = new Map<string, string[]>(
      requestedVenueIds.map((venueId) => [venueId, []]),
    );
    if (requestedVenueIds.length === 0) {
      return beerKeysByVenue;
    }

    // The VALUES list length is bounded above and contains placeholders only;
    // venue IDs never become SQL text. VALUES is supported by both runtimes.
    const requestedValues = requestedVenueIds.map(() => "(?)").join(", ");
    const binaryCollation = this.database.dialect === "postgres"
      ? 'COLLATE "C"'
      : "COLLATE BINARY";
    const rows = await this.database.prepare(
      `WITH requested(requested_venue_id) AS (
         VALUES ${requestedValues}
       ), requested_canonical AS (
         SELECT
           requested.requested_venue_id,
           COALESCE(identity.canonical_venue_id, requested.requested_venue_id) AS canonical_venue_id
         FROM requested
         LEFT JOIN venue_identity_aliases identity
           ON identity.alias_venue_id = requested.requested_venue_id
       ), source_ids AS (
         SELECT requested_venue_id, canonical_venue_id AS source_venue_id
         FROM requested_canonical
         UNION
         SELECT requested.requested_venue_id, identity.alias_venue_id AS source_venue_id
         FROM requested_canonical requested
         INNER JOIN venue_identity_aliases identity
           ON identity.canonical_venue_id = requested.canonical_venue_id
       ), beer_sources AS (
         SELECT
           sources.requested_venue_id AS venue_id,
           record.normalized_beer_id AS normalized_beer_id,
           record.beer_name AS beer_name
         FROM source_ids sources
         INNER JOIN venue_price_records record
           ON record.venue_id = sources.source_venue_id
         WHERE record.source_type <> 'source_ingestion_quarantined'
           AND trim(record.beer_name) <> ''
         UNION ALL
         SELECT
           sources.requested_venue_id AS venue_id,
           beer.normalized_beer_id AS normalized_beer_id,
           beer.beer_name AS beer_name
         FROM source_ids sources
         INNER JOIN venue_beers beer
           ON beer.venue_id = sources.source_venue_id
         INNER JOIN venue_profiles profile
           ON profile.venue_id = beer.venue_id
         WHERE profile.active = TRUE
           AND beer.in_stock = TRUE
           AND (
             beer.source_ingestion_id IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM venue_price_records quarantined
               WHERE quarantined.source_ingestion_id = beer.source_ingestion_id
                 AND quarantined.source_type = 'source_ingestion_quarantined'
             )
           )
           AND trim(beer.beer_name) <> ''
       )
       SELECT venue_id, normalized_beer_id, beer_name
       FROM beer_sources
       ORDER BY venue_id ${binaryCollation} ASC,
                lower(beer_name) ${binaryCollation} ASC,
                beer_name ${binaryCollation} ASC`,
    ).all<PublicVenueBeerRow>(...requestedVenueIds);

    const uniqueKeysByVenue = new Map<string, Set<string>>(
      requestedVenueIds.map((venueId) => [venueId, new Set<string>()]),
    );
    for (const row of rows) {
      const trackedBeer =
        findTrackedBeerByName(row.normalized_beer_id) ??
        findTrackedBeerByName(row.beer_name);
      if (!trackedBeer) continue;
      uniqueKeysByVenue.get(row.venue_id)?.add(trackedBeer.key);
    }
    for (const venueId of requestedVenueIds) {
      beerKeysByVenue.set(
        venueId,
        Array.from(uniqueKeysByVenue.get(venueId) ?? [])
          .sort((left, right) => left.localeCompare(right)),
      );
    }
    return beerKeysByVenue;
  }
}
