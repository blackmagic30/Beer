import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_VENUE_ID_LENGTH = 200;
const MAX_VENUE_NAME_LENGTH = 240;
const MAX_SUBURB_LENGTH = 160;
const MAX_BEER_NAME_LENGTH = 160;
const MAX_NORMALIZED_BEER_ID_LENGTH = 200;

export type VenueDuplicateSource = "location_cache" | "price_record" | "venue_profile";

export interface VenueDuplicateCandidate {
  venueId: string;
  venueName: string;
  suburb: string | null;
  source: VenueDuplicateSource;
}

export interface VenuePublishedBeerLookup {
  venueId: string;
  beerName: string;
  normalizedBeerId?: string | null | undefined;
}

export type VenueDataReadRepositoryErrorCode =
  | "invalid_input"
  | "malformed_record"
  | "persistence_failure";

const ERROR_MESSAGES: Readonly<Record<VenueDataReadRepositoryErrorCode, string>> = {
  invalid_input: "The venue-data lookup input is invalid.",
  malformed_record: "Stored venue data is malformed.",
  persistence_failure: "Venue data could not be loaded.",
};

/** Stable, secret-free failures for service and HTTP error mapping. */
export class VenueDataReadRepositoryError extends Error {
  readonly code: VenueDataReadRepositoryErrorCode;

  constructor(code: VenueDataReadRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VenueDataReadRepositoryError";
    this.code = code;
  }
}

interface DuplicateCandidateRow extends Record<string, unknown> {
  venueId: unknown;
  venueName: unknown;
  suburb: unknown;
  source: unknown;
}

interface LatestVenueDataRow extends Record<string, unknown> {
  lastVerifiedAt: unknown;
}

interface ExistsRow extends Record<string, unknown> {
  existsFlag: unknown;
}

function fail(code: VenueDataReadRepositoryErrorCode): never {
  throw new VenueDataReadRepositoryError(code);
}

function inputText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") return fail("invalid_input");
  const normalized = value.trim();
  if (
    (!allowEmpty && !normalized)
    || normalized.length > maximum
    || /[\r\n\0]/.test(normalized)
  ) {
    return fail("invalid_input");
  }
  return normalized;
}

function optionalInputText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  const normalized = inputText(value, maximum, true);
  return normalized || null;
}

function recordText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return fail("malformed_record");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    return fail("malformed_record");
  }
  return normalized;
}

function optionalRecordText(value: unknown, maximum: number): string | null {
  if (value == null) return null;
  return recordText(value, maximum);
}

function recordSource(value: unknown): VenueDuplicateSource {
  if (value === "location_cache" || value === "price_record" || value === "venue_profile") {
    return value;
  }
  return fail("malformed_record");
}

function recordBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fail("malformed_record");
}

function recordTimestamp(value: unknown): string {
  if (typeof value !== "string") return fail("malformed_record");
  try {
    if (!CANONICAL_UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
      return fail("malformed_record");
    }
  } catch {
    return fail("malformed_record");
  }
  return value;
}

function toDuplicateCandidate(row: DuplicateCandidateRow): VenueDuplicateCandidate {
  return {
    venueId: recordText(row.venueId, MAX_VENUE_ID_LENGTH),
    venueName: recordText(row.venueName, MAX_VENUE_NAME_LENGTH),
    suburb: optionalRecordText(row.suburb, MAX_SUBURB_LENGTH),
    source: recordSource(row.source),
  };
}

/**
 * Async, read-only persistence boundary for venue duplicate detection and the
 * two venue-data checks used while scoring community submissions.
 */
export class VenueDataReadRepository {
  constructor(private readonly database: SqlDatabase) {}

  private async guarded<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VenueDataReadRepositoryError) throw error;
      throw new VenueDataReadRepositoryError("persistence_failure");
    }
  }

  private binaryCollation(): string {
    return this.database.dialect === "postgres" ? 'COLLATE "C"' : "COLLATE BINARY";
  }

  async findLikelyVenueDuplicate(input: {
    name: string;
    suburb?: string | null | undefined;
  }): Promise<VenueDuplicateCandidate | null> {
    return this.guarded(async () => {
      const name = inputText(input.name, MAX_VENUE_NAME_LENGTH, true).toLowerCase();
      if (!name) return null;
      const suburb = optionalInputText(input.suburb, MAX_SUBURB_LENGTH)?.toLowerCase() ?? null;
      const binaryCollation = this.binaryCollation();
      const row = await this.database.prepare(
        `WITH profile_candidate AS (
           SELECT profile.venue_id AS "venueId",
                  profile.name AS "venueName",
                  profile.suburb AS "suburb",
                  'venue_profile' AS "source"
             FROM venue_profiles profile
            WHERE profile.active = TRUE
              AND lower(trim(profile.name)) = @name
            ORDER BY
              CASE
                WHEN CAST(@suburb AS TEXT) IS NOT NULL
                 AND lower(trim(COALESCE(profile.suburb, ''))) = CAST(@suburb AS TEXT) THEN 0
                ELSE 1
              END ASC,
              profile.venue_id ${binaryCollation} ASC,
              profile.name ${binaryCollation} ASC
            LIMIT 1
         ), location_candidate AS (
           SELECT location.venue_id AS "venueId",
                  location.venue_name AS "venueName",
                  location.suburb AS "suburb",
                  'location_cache' AS "source"
             FROM venue_location_cache location
            WHERE lower(trim(location.venue_name)) = @name
            ORDER BY
              CASE
                WHEN CAST(@suburb AS TEXT) IS NOT NULL
                 AND lower(trim(COALESCE(location.suburb, ''))) = CAST(@suburb AS TEXT) THEN 0
                ELSE 1
              END ASC,
              location.venue_id ${binaryCollation} ASC,
              location.venue_name ${binaryCollation} ASC
            LIMIT 1
         ), price_candidate AS (
           SELECT record.venue_id AS "venueId",
                  record.venue_name AS "venueName",
                  record.suburb AS "suburb",
                  'price_record' AS "source"
             FROM venue_price_records record
            WHERE lower(trim(record.venue_name)) = @name
            ORDER BY
              CASE
                WHEN CAST(@suburb AS TEXT) IS NOT NULL
                 AND lower(trim(COALESCE(record.suburb, ''))) = CAST(@suburb AS TEXT) THEN 0
                ELSE 1
              END ASC,
              record.venue_id ${binaryCollation} ASC,
              record.venue_name ${binaryCollation} ASC,
              record.id ${binaryCollation} ASC
            LIMIT 1
         ), candidates AS (
           SELECT * FROM profile_candidate
           UNION ALL
           SELECT * FROM location_candidate
           UNION ALL
           SELECT * FROM price_candidate
         )
         SELECT candidate."venueId", candidate."venueName", candidate."suburb", candidate."source"
           FROM candidates candidate
          ORDER BY
            CASE
              WHEN CAST(@suburb AS TEXT) IS NOT NULL
               AND lower(trim(COALESCE(candidate."suburb", ''))) = CAST(@suburb AS TEXT) THEN 0
              ELSE 1
            END ASC,
            candidate."source" ${binaryCollation} ASC,
            candidate."venueId" ${binaryCollation} ASC,
            candidate."venueName" ${binaryCollation} ASC
          LIMIT 1`,
      ).get<DuplicateCandidateRow>({ name, suburb });
      return row ? toDuplicateCandidate(row) : null;
    });
  }

  async getLatestVenueDataTimestamp(venueIdInput: string): Promise<string | null> {
    return this.guarded(async () => {
      const venueId = inputText(venueIdInput, MAX_VENUE_ID_LENGTH);
      const row = await this.database.prepare(
        `SELECT record.last_verified_at AS "lastVerifiedAt"
           FROM venue_price_records record
          WHERE record.venue_id = ?
          ORDER BY record.last_verified_at DESC
          LIMIT 1`,
      ).get<LatestVenueDataRow>(venueId);
      return row ? recordTimestamp(row.lastVerifiedAt) : null;
    });
  }

  async venueHasPublishedBeerRecord(input: VenuePublishedBeerLookup): Promise<boolean> {
    return this.guarded(async () => {
      const venueId = inputText(input.venueId, MAX_VENUE_ID_LENGTH);
      const normalizedBeerId = optionalInputText(
        input.normalizedBeerId,
        MAX_NORMALIZED_BEER_ID_LENGTH,
      );
      const beerName = inputText(input.beerName, MAX_BEER_NAME_LENGTH, true).toLowerCase() || null;
      if (!normalizedBeerId && !beerName) return false;

      const row = await this.database.prepare(
        `SELECT EXISTS (
           SELECT 1
             FROM venue_price_records record
            WHERE CAST(@normalizedBeerId AS TEXT) IS NOT NULL
              AND record.venue_id = CAST(@venueId AS TEXT)
              AND record.normalized_beer_id = CAST(@normalizedBeerId AS TEXT)
           UNION ALL
           SELECT 1
             FROM venue_price_records record
            WHERE CAST(@beerName AS TEXT) IS NOT NULL
              AND record.venue_id = CAST(@venueId AS TEXT)
              AND lower(trim(record.beer_name)) = CAST(@beerName AS TEXT)
           LIMIT 1
         ) AS "existsFlag"`,
      ).get<ExistsRow>({ venueId, normalizedBeerId, beerName });
      if (!row) return fail("malformed_record");
      return recordBoolean(row.existsFlag);
    });
  }
}

export const venueDataReadRepositoryLimits = Object.freeze({
  maxVenueIdLength: MAX_VENUE_ID_LENGTH,
  maxVenueNameLength: MAX_VENUE_NAME_LENGTH,
  maxSuburbLength: MAX_SUBURB_LENGTH,
  maxBeerNameLength: MAX_BEER_NAME_LENGTH,
  maxNormalizedBeerIdLength: MAX_NORMALIZED_BEER_ID_LENGTH,
});
