import type {
  BarHappyHourBeer,
  BarMembershipTier,
  ConfidenceLabel,
  PublicVenuePriceRecord,
  ServingSize,
  TapStatus,
} from "./business.repository.js";
import type { SqlDatabase } from "./sql-database.js";

const MAX_FILTER_VENUE_IDS = 500;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SQL_LIMIT = 2_147_483_647;

interface PriceRecordRow {
  id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  beer_name: string;
  normalized_beer_id: string | null;
  serving_size: ServingSize;
  price: number | string | null;
  is_happy_hour_price: boolean | number;
  happy_hour_details: string | null;
  is_on_tap: TapStatus;
  confidence: ConfidenceLabel;
  source_type: string;
  source_submission_id: string | null;
  source_ingestion_id: string | null;
  source_evidence_reference: string | null;
  source_evidence_verified_at: string | null;
  last_verified_at: string;
  created_at: string;
  updated_at: string;
}

interface ManagerProfileProjection {
  profile_name: string | null;
  profile_suburb: string | null;
  profile_address: string | null;
  profile_membership_tier: string;
  profile_highlighted_name: boolean | number;
  profile_premium_badge: string | null;
  profile_promoted: boolean | number;
  profile_featured_special_eligible: boolean | number;
  profile_accepts_pint_path_codes: boolean | number;
}

interface ManagerBeerRow extends ManagerProfileProjection {
  id: string;
  venue_id: string;
  beer_name: string;
  normalized_beer_id: string | null;
  serve_size: ServingSize | null;
  price: number | string | null;
  on_tap: boolean | number;
  in_stock: boolean | number;
  price_verified_at: string | null;
  source_ingestion_id: string | null;
  created_at: string;
  updated_at: string;
  authority_verified_at: string;
}

interface ManagerHappyHourRow extends ManagerProfileProjection {
  id: string;
  venue_id: string;
  title: string;
  days_of_week_json: unknown;
  start_time: string;
  end_time: string;
  description: string;
  happy_hour_beers_json: unknown;
  active: boolean | number;
  created_at: string;
  updated_at: string;
}

interface ManagerSpecialRow extends ManagerProfileProjection {
  id: string;
  venue_id: string;
  title: string;
  description: string;
  price: number | string | null;
  discount: string | null;
  starts_at: string | null;
  ends_at: string | null;
  start_time: string | null;
  end_time: string | null;
  schedule_note: string | null;
  exclusive: boolean | number;
  active: boolean | number;
  created_at: string;
  updated_at: string;
}

const MANAGER_PROFILE_PROJECTION = `
  "profile".name AS profile_name,
  "profile".suburb AS profile_suburb,
  "profile".address AS profile_address,
  "profile".membership_tier AS profile_membership_tier,
  "profile".highlighted_name AS profile_highlighted_name,
  "profile".premium_badge AS profile_premium_badge,
  "profile".promoted AS profile_promoted,
  "profile".featured_special_eligible AS profile_featured_special_eligible,
  "profile".accepts_pint_path_codes AS profile_accepts_pint_path_codes`;

export interface PublicPriceCursor {
  verifiedAt: string;
  id: string;
}

function normalizeLimit(limit: number): number {
  if (limit === Number.NEGATIVE_INFINITY || limit < 0) return MAX_SQL_LIMIT;
  if (!Number.isFinite(limit)) return limit === Number.POSITIVE_INFINITY ? MAX_SQL_LIMIT : 1;
  return Math.min(MAX_SQL_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${label} exceeds the supported length.`);
  }
  return normalized;
}

function normalizeOptionalVenueId(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  return normalizeIdentifier(value, "Venue ID");
}

function normalizeVenueIds(values: readonly string[]): string[] {
  const normalized = Array.from(new Set(
    values
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  if (normalized.length > MAX_FILTER_VENUE_IDS) {
    throw new Error(`At most ${MAX_FILTER_VENUE_IDS} venue IDs can be queried at once.`);
  }
  for (const venueId of normalized) normalizeIdentifier(venueId, "Venue ID");
  return normalized;
}

function normalizeCursor(value: PublicPriceCursor | null | undefined): PublicPriceCursor | null {
  if (!value) return null;
  const verifiedAt = value.verifiedAt.trim();
  if (!verifiedAt || verifiedAt.length > 64) {
    throw new Error("Price cursor timestamp is invalid.");
  }
  return {
    verifiedAt,
    id: normalizeIdentifier(value.id, "Price cursor ID"),
  };
}

function normalizeBoolean(value: boolean | number, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`Database returned an invalid ${field} value.`);
}

function normalizeNullableNumber(value: number | string | null, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Database returned an invalid ${field} value.`);
    }
    return value;
  }
  const canonical = value.trim();
  if (!/^[+-]?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(canonical)) {
    throw new Error(`Database returned an invalid ${field} value.`);
  }
  const significantDigits = canonical
    .replace(/^[+-]/, "")
    .replace(/[eE].*$/, "")
    .replace(".", "")
    .replace(/^0+/, "")
    .length;
  const numeric = Number(canonical);
  if (
    !Number.isFinite(numeric)
    || significantDigits > 15
    || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric))
  ) {
    throw new Error(`Database returned an inexact ${field} value.`);
  }
  return numeric;
}

function normalizeMembershipTier(value: string | null | undefined): BarMembershipTier {
  return value === "pro" || value === "plus" || value === "super_premium" ? "pro" : "basic";
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

function parseHappyHourBeers(value: unknown): BarHappyHourBeer[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(
        item && typeof item === "object" && !Array.isArray(item),
      ))
      .map((item) => ({
        beerId: typeof item.beerId === "string" && item.beerId.trim() ? item.beerId.trim() : null,
        beerName: typeof item.beerName === "string" ? item.beerName.trim() : "",
        normalizedBeerId: typeof item.normalizedBeerId === "string" && item.normalizedBeerId.trim()
          ? item.normalizedBeerId.trim()
          : null,
        servingSize: typeof item.servingSize === "string" && item.servingSize.trim()
          ? item.servingSize.trim() as ServingSize
          : null,
        happyHourPrice: typeof item.happyHourPrice === "number" && Number.isFinite(item.happyHourPrice)
          ? item.happyHourPrice
          : null,
        offerText: typeof item.offerText === "string" && item.offerText.trim()
          ? item.offerText.trim()
          : null,
        onTap: typeof item.onTap === "boolean" ? item.onTap : false,
        inStock: typeof item.inStock === "boolean" ? item.inStock : true,
      }))
      .filter((item) => item.beerName.length > 0)
      .slice(0, 60);
  } catch {
    return [];
  }
}

function toPriceRecord(row: PriceRecordRow): PublicVenuePriceRecord {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    beerName: row.beer_name,
    normalizedBeerId: row.normalized_beer_id,
    servingSize: row.serving_size,
    price: normalizeNullableNumber(row.price, "price"),
    isHappyHourPrice: normalizeBoolean(row.is_happy_hour_price, "happy-hour flag"),
    happyHourDetails: row.happy_hour_details,
    isOnTap: row.is_on_tap,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceSubmissionId: row.source_submission_id,
    hasSourceLinkage: Boolean(
      row.source_submission_id
      || row.source_ingestion_id
      || row.source_evidence_reference
    ),
    hasSourceEvidence: Boolean(row.source_evidence_verified_at),
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function managerMetadata(row: ManagerProfileProjection) {
  return {
    venueName: row.profile_name,
    venueAddress: row.profile_address,
    suburb: row.profile_suburb,
    membershipTier: normalizeMembershipTier(row.profile_membership_tier),
    highlightedName: normalizeBoolean(row.profile_highlighted_name, "highlighted-name flag"),
    premiumBadge: row.profile_premium_badge,
    promoted: normalizeBoolean(row.profile_promoted, "promoted flag"),
    featuredSpecialEligible: normalizeBoolean(
      row.profile_featured_special_eligible,
      "featured-special flag",
    ),
    acceptsPintPathCodes: normalizeBoolean(
      row.profile_accepts_pint_path_codes,
      "Pint Path code flag",
    ),
  };
}

function toManagerBeerPriceRecord(row: ManagerBeerRow): PublicVenuePriceRecord {
  return {
    id: `bar_beer:${row.id}`,
    venueId: row.venue_id,
    ...managerMetadata(row),
    venueName: row.profile_name || row.venue_id,
    beerName: row.beer_name,
    normalizedBeerId: row.normalized_beer_id,
    servingSize: row.serve_size || "other",
    price: normalizeNullableNumber(row.price, "manager price"),
    isHappyHourPrice: false,
    happyHourDetails: null,
    displayKind: "beer",
    isOnTap: normalizeBoolean(row.on_tap, "on-tap flag")
      ? "yes"
      : normalizeBoolean(row.in_stock, "in-stock flag") ? "unknown" : "no",
    confidence: row.price_verified_at ? "venue_confirmed" : "stale",
    sourceType: "venue_manager_portal",
    sourceSubmissionId: null,
    lastVerifiedAt: row.price_verified_at ?? row.created_at,
    priceVerifiedAt: row.price_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareNewest(left: PublicVenuePriceRecord, right: PublicVenuePriceRecord): number {
  const timestampDifference = Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt);
  if (timestampDifference) return timestampDifference;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function venueFilterSql(venueIds: readonly string[], alias: string): string {
  return venueIds.length
    ? ` AND ${alias}.venue_id IN (${venueIds.map(() => "?").join(", ")})`
    : "";
}

function cursorSql(
  cursor: PublicPriceCursor | null,
  verifiedExpression: string,
  idExpression: string,
): string {
  return cursor
    ? ` AND (${verifiedExpression} < ? OR (${verifiedExpression} = ? AND ${idExpression} < ?))`
    : "";
}

function queryBindings(
  venueIds: readonly string[],
  cursor: PublicPriceCursor | null,
  limit?: number,
): unknown[] {
  return [
    ...venueIds,
    ...(cursor ? [cursor.verifiedAt, cursor.verifiedAt, cursor.id] : []),
    ...(limit === undefined ? [] : [limit]),
  ];
}

/**
 * Async, read-only public/current price access for both SQLite rehearsal and
 * native PostgreSQL. Happy-hour rows intentionally remain available to
 * internal callers; the BusinessService owns Free-launch public eligibility.
 */
export class PublicPriceRepository {
  constructor(private readonly database: SqlDatabase) {}

  async listLatestPriceRecords(
    limit: number,
    venueId?: string | null,
  ): Promise<PublicVenuePriceRecord[]> {
    const normalizedVenueId = normalizeOptionalVenueId(venueId);
    const rows = await this.database.prepare(
      `SELECT "price_record".*
       FROM venue_price_records AS "price_record"
       WHERE "price_record".source_type <> 'source_ingestion_quarantined'
         ${normalizedVenueId ? 'AND "price_record".venue_id = ?' : ""}
       ORDER BY "price_record".last_verified_at DESC,
                "price_record".updated_at DESC,
                "price_record".id DESC
       LIMIT ?`,
    ).all<PriceRecordRow>(
      ...(normalizedVenueId ? [normalizedVenueId] : []),
      normalizeLimit(limit),
    );
    return rows.map(toPriceRecord);
  }

  async getPriceRecordById(id: string): Promise<PublicVenuePriceRecord | null> {
    const row = await this.database.prepare(
      `SELECT "price_record".*
       FROM venue_price_records AS "price_record"
       WHERE "price_record".id = ?
         AND "price_record".source_type <> 'source_ingestion_quarantined'
       LIMIT 1`,
    ).get<PriceRecordRow>(normalizeIdentifier(id, "Price record ID"));
    return row ? toPriceRecord(row) : null;
  }

  /**
   * Resolves an exact venue-manager beer ID only when that row is still the
   * current public authority for its canonical venue/beer/serve identity.
   */
  async getCurrentVenueManagerPriceRecordById(id: string): Promise<PublicVenuePriceRecord | null> {
    const normalizedId = normalizeIdentifier(id, "Price record ID");
    if (!normalizedId.startsWith("bar_beer:")) return null;
    const managerBeerId = normalizedId.slice("bar_beer:".length);
    if (!managerBeerId) return null;
    normalizeIdentifier(managerBeerId, "Venue-manager beer ID");

    const row = await this.database.prepare(
      `WITH "ranked_beers" AS (
         SELECT
           "beer".*,
           ${MANAGER_PROFILE_PROJECTION},
           COALESCE("identity".canonical_venue_id, "beer".venue_id) AS canonical_venue_id,
           COALESCE("beer".price_verified_at, "beer".created_at) AS authority_verified_at,
           row_number() OVER (
             PARTITION BY COALESCE("identity".canonical_venue_id, "beer".venue_id),
               COALESCE(NULLIF("beer".normalized_beer_id, ''), lower(trim("beer".beer_name))),
               COALESCE(NULLIF("beer".serve_size, ''), 'other')
             ORDER BY COALESCE("beer".price_verified_at, "beer".created_at) DESC,
                      "beer".updated_at DESC,
                      "beer".id DESC
           ) AS authority_rank
         FROM venue_beers AS "beer"
         INNER JOIN venue_profiles AS "profile"
           ON "profile".venue_id = "beer".venue_id
         LEFT JOIN venue_identity_aliases AS "identity"
           ON "identity".alias_venue_id = "beer".venue_id
         WHERE "beer".on_tap = TRUE
           AND "beer".in_stock = TRUE
           AND "profile".active = TRUE
           AND (
             "beer".source_ingestion_id IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM venue_price_records AS "quarantined"
               WHERE "quarantined".source_ingestion_id = "beer".source_ingestion_id
                 AND "quarantined".source_type = 'source_ingestion_quarantined'
             )
           )
       )
       SELECT "ranked_beer".*
       FROM "ranked_beers" AS "ranked_beer"
       WHERE "ranked_beer".authority_rank = 1
         AND "ranked_beer".id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM venue_price_records AS "community"
           LEFT JOIN venue_identity_aliases AS "community_identity"
             ON "community_identity".alias_venue_id = "community".venue_id
           WHERE "community".is_happy_hour_price = FALSE
             AND "community".source_type <> 'source_ingestion_quarantined'
             AND COALESCE("community_identity".canonical_venue_id, "community".venue_id) =
                 "ranked_beer".canonical_venue_id
             AND COALESCE(NULLIF("community".normalized_beer_id, ''), lower(trim("community".beer_name))) =
                 COALESCE(NULLIF("ranked_beer".normalized_beer_id, ''), lower(trim("ranked_beer".beer_name)))
             AND COALESCE(NULLIF("community".serving_size, ''), 'other') =
                 COALESCE(NULLIF("ranked_beer".serve_size, ''), 'other')
             AND "community".last_verified_at > "ranked_beer".authority_verified_at
         )
       LIMIT 1`,
    ).get<ManagerBeerRow>(managerBeerId);
    return row ? toManagerBeerPriceRecord(row) : null;
  }

  async listCurrentPriceRecords(
    venueIds: readonly string[] = [],
  ): Promise<PublicVenuePriceRecord[]> {
    const normalizedVenueIds = normalizeVenueIds(venueIds);
    const rows = await this.database.prepare(
      `WITH "price_candidates" AS (
         SELECT
           "price_record".*,
           COALESCE("identity".canonical_venue_id, "price_record".venue_id) AS canonical_venue_id
         FROM venue_price_records AS "price_record"
         LEFT JOIN venue_identity_aliases AS "identity"
           ON "identity".alias_venue_id = "price_record".venue_id
         WHERE "price_record".source_type <> 'source_ingestion_quarantined'
           ${venueFilterSql(normalizedVenueIds, '"price_record"')}
       ), "ranked" AS (
         SELECT
           "candidate".*,
           row_number() OVER (
             PARTITION BY "candidate".canonical_venue_id,
               COALESCE(NULLIF("candidate".normalized_beer_id, ''), lower(trim("candidate".beer_name))),
               "candidate".serving_size,
               "candidate".is_happy_hour_price,
               COALESCE("candidate".happy_hour_details, '')
             ORDER BY "candidate".last_verified_at DESC,
                      "candidate".updated_at DESC,
                      "candidate".id DESC
           ) AS current_rank
         FROM "price_candidates" AS "candidate"
       )
       SELECT "ranked".*
       FROM "ranked"
       WHERE "ranked".current_rank = 1
       ORDER BY "ranked".last_verified_at DESC, "ranked".id DESC`,
    ).all<PriceRecordRow>(...normalizedVenueIds);
    return rows.map(toPriceRecord);
  }

  async listCurrentPriceRecordPage(input: {
    venueIds?: readonly string[] | undefined;
    limit: number;
    before?: PublicPriceCursor | null | undefined;
  }): Promise<PublicVenuePriceRecord[]> {
    const normalizedVenueIds = normalizeVenueIds(input.venueIds ?? []);
    const cursor = normalizeCursor(input.before);
    const rows = await this.database.prepare(
      `WITH "price_candidates" AS (
         SELECT
           "price_record".*,
           COALESCE("identity".canonical_venue_id, "price_record".venue_id) AS canonical_venue_id
         FROM venue_price_records AS "price_record"
         LEFT JOIN venue_identity_aliases AS "identity"
           ON "identity".alias_venue_id = "price_record".venue_id
         WHERE "price_record".source_type <> 'source_ingestion_quarantined'
           ${venueFilterSql(normalizedVenueIds, '"price_record"')}
       ), "ranked" AS (
         SELECT
           "candidate".*,
           row_number() OVER (
             PARTITION BY "candidate".canonical_venue_id,
               COALESCE(NULLIF("candidate".normalized_beer_id, ''), lower(trim("candidate".beer_name))),
               "candidate".serving_size,
               "candidate".is_happy_hour_price,
               COALESCE("candidate".happy_hour_details, '')
             ORDER BY "candidate".last_verified_at DESC,
                      "candidate".updated_at DESC,
                      "candidate".id DESC
           ) AS current_rank
         FROM "price_candidates" AS "candidate"
       ), "current_records" AS (
         SELECT "ranked".*
         FROM "ranked"
         WHERE "ranked".current_rank = 1
       ), "authoritative_records" AS (
         SELECT "current_record".*
         FROM "current_records" AS "current_record"
         WHERE "current_record".is_happy_hour_price = TRUE
            OR NOT EXISTS (
              SELECT 1
              FROM venue_beers AS "manager_beer"
              INNER JOIN venue_profiles AS "manager_profile"
                ON "manager_profile".venue_id = "manager_beer".venue_id
              LEFT JOIN venue_identity_aliases AS "manager_identity"
                ON "manager_identity".alias_venue_id = "manager_beer".venue_id
              WHERE "manager_beer".on_tap = TRUE
                AND "manager_beer".in_stock = TRUE
                AND "manager_profile".active = TRUE
                AND COALESCE("manager_identity".canonical_venue_id, "manager_beer".venue_id) =
                    "current_record".canonical_venue_id
                AND COALESCE(NULLIF("manager_beer".normalized_beer_id, ''), lower(trim("manager_beer".beer_name))) =
                    COALESCE(NULLIF("current_record".normalized_beer_id, ''), lower(trim("current_record".beer_name)))
                AND COALESCE(NULLIF("manager_beer".serve_size, ''), 'other') =
                    COALESCE(NULLIF("current_record".serving_size, ''), 'other')
                AND COALESCE("manager_beer".price_verified_at, "manager_beer".created_at) >=
                    "current_record".last_verified_at
            )
       )
       SELECT "authoritative_record".*
       FROM "authoritative_records" AS "authoritative_record"
       WHERE TRUE
         ${cursorSql(
           cursor,
           '"authoritative_record".last_verified_at',
           '"authoritative_record".id',
         )}
       ORDER BY "authoritative_record".last_verified_at DESC,
                "authoritative_record".id DESC
       LIMIT ?`,
    ).all<PriceRecordRow>(
      ...queryBindings(normalizedVenueIds, cursor, normalizeLimit(input.limit)),
    );
    return rows.map(toPriceRecord);
  }

  async listVenueManagerPriceRecords(
    limit: number,
    venueId?: string | null,
    before?: PublicPriceCursor | null,
  ): Promise<PublicVenuePriceRecord[]> {
    const normalizedVenueId = normalizeOptionalVenueId(venueId);
    const venueIds = normalizedVenueId ? [normalizedVenueId] : [];
    const cursor = normalizeCursor(before);
    const boundedLimit = normalizeLimit(limit);
    const managerBindings = queryBindings(venueIds, cursor, boundedLimit);
    const [beerRows, happyRows, specialRows] = await Promise.all([
      this.database.prepare(
        `WITH "ranked_beers" AS (
           SELECT
             "beer".*,
             ${MANAGER_PROFILE_PROJECTION},
             COALESCE("identity".canonical_venue_id, "beer".venue_id) AS canonical_venue_id,
             COALESCE("beer".price_verified_at, "beer".created_at) AS authority_verified_at,
             row_number() OVER (
               PARTITION BY COALESCE("identity".canonical_venue_id, "beer".venue_id),
                 COALESCE(NULLIF("beer".normalized_beer_id, ''), lower(trim("beer".beer_name))),
                 COALESCE(NULLIF("beer".serve_size, ''), 'other')
               ORDER BY COALESCE("beer".price_verified_at, "beer".created_at) DESC,
                        "beer".updated_at DESC,
                        "beer".id DESC
             ) AS authority_rank
           FROM venue_beers AS "beer"
           INNER JOIN venue_profiles AS "profile"
             ON "profile".venue_id = "beer".venue_id
           LEFT JOIN venue_identity_aliases AS "identity"
             ON "identity".alias_venue_id = "beer".venue_id
           WHERE "beer".on_tap = TRUE
             AND "beer".in_stock = TRUE
             AND "profile".active = TRUE
             ${venueFilterSql(venueIds, '"beer"')}
             AND (
               "beer".source_ingestion_id IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM venue_price_records AS "quarantined"
                 WHERE "quarantined".source_ingestion_id = "beer".source_ingestion_id
                   AND "quarantined".source_type = 'source_ingestion_quarantined'
               )
             )
         )
         SELECT "ranked_beer".*
         FROM "ranked_beers" AS "ranked_beer"
         WHERE "ranked_beer".authority_rank = 1
           AND NOT EXISTS (
             SELECT 1
             FROM venue_price_records AS "community"
             LEFT JOIN venue_identity_aliases AS "community_identity"
               ON "community_identity".alias_venue_id = "community".venue_id
             WHERE "community".is_happy_hour_price = FALSE
               AND "community".source_type <> 'source_ingestion_quarantined'
               AND COALESCE("community_identity".canonical_venue_id, "community".venue_id) =
                   "ranked_beer".canonical_venue_id
               AND COALESCE(NULLIF("community".normalized_beer_id, ''), lower(trim("community".beer_name))) =
                   COALESCE(NULLIF("ranked_beer".normalized_beer_id, ''), lower(trim("ranked_beer".beer_name)))
               AND COALESCE(NULLIF("community".serving_size, ''), 'other') =
                   COALESCE(NULLIF("ranked_beer".serve_size, ''), 'other')
               AND "community".last_verified_at > "ranked_beer".authority_verified_at
           )
           ${cursorSql(cursor, '"ranked_beer".authority_verified_at', "'bar_beer:' || \"ranked_beer\".id")}
         ORDER BY "ranked_beer".authority_verified_at DESC,
                  ('bar_beer:' || "ranked_beer".id) DESC
         LIMIT ?`,
      ).all<ManagerBeerRow>(...managerBindings),
      this.database.prepare(
         `SELECT
           "happy".*,
           ${MANAGER_PROFILE_PROJECTION}
         FROM venue_happy_hours AS "happy"
         INNER JOIN venue_profiles AS "profile"
           ON "profile".venue_id = "happy".venue_id
         WHERE "happy".active = TRUE
           AND "profile".active = TRUE
           ${venueFilterSql(venueIds, '"happy"')}
           ${cursorSql(cursor, '"happy".updated_at', "'bar_happy_hour:' || \"happy\".id")}
         ORDER BY "happy".updated_at DESC, ('bar_happy_hour:' || "happy".id) DESC
         LIMIT ?`,
      ).all<ManagerHappyHourRow>(...managerBindings),
      this.database.prepare(
         `SELECT
           "special".*,
           ${MANAGER_PROFILE_PROJECTION}
         FROM venue_specials AS "special"
         INNER JOIN venue_profiles AS "profile"
           ON "profile".venue_id = "special".venue_id
         WHERE "special".active = TRUE
           AND "profile".active = TRUE
           AND "profile".membership_tier IN ('plus', 'pro')
           ${venueFilterSql(venueIds, '"special"')}
           ${cursorSql(cursor, '"special".updated_at', "'venue_special:' || \"special\".id")}
         ORDER BY "special".updated_at DESC, ('venue_special:' || "special".id) DESC
         LIMIT ?`,
      ).all<ManagerSpecialRow>(...managerBindings),
    ]);

    const beerRecords = beerRows.map(toManagerBeerPriceRecord);
    const happyRecords: PublicVenuePriceRecord[] = happyRows.map((row) => ({
      id: `bar_happy_hour:${row.id}`,
      venueId: row.venue_id,
      ...managerMetadata(row),
      venueName: row.profile_name || row.venue_id,
      beerName: row.title || "Happy hour",
      normalizedBeerId: null,
      servingSize: "other",
      price: null,
      isHappyHourPrice: true,
      happyHourDetails: row.description,
      happyHourTitle: row.title,
      happyHourDays: parseJsonArray(row.days_of_week_json),
      happyHourStartTime: row.start_time,
      happyHourEndTime: row.end_time,
      happyHourBeers: parseHappyHourBeers(row.happy_hour_beers_json),
      displayKind: "happy_hour",
      isOnTap: "unknown",
      confidence: "venue_confirmed",
      sourceType: "venue_manager_portal",
      sourceSubmissionId: null,
      lastVerifiedAt: row.updated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const specialRecords: PublicVenuePriceRecord[] = specialRows.map((row) => ({
      id: `venue_special:${row.id}`,
      venueId: row.venue_id,
      ...managerMetadata(row),
      venueName: row.profile_name || row.venue_id,
      beerName: normalizeBoolean(row.exclusive, "exclusive flag")
        ? "Pint Path exclusive"
        : row.title || "Venue special",
      normalizedBeerId: null,
      servingSize: "other",
      price: normalizeNullableNumber(row.price, "special price"),
      isHappyHourPrice: false,
      happyHourDetails: null,
      specialTitle: row.title,
      specialDescription: row.description,
      specialDiscount: row.discount,
      specialStartsAt: row.starts_at,
      specialEndsAt: row.ends_at,
      specialStartTime: row.start_time,
      specialEndTime: row.end_time,
      specialScheduleNote: row.schedule_note,
      specialExclusive: normalizeBoolean(row.exclusive, "exclusive flag"),
      displayKind: "special",
      isOnTap: "unknown",
      confidence: "venue_confirmed",
      sourceType: normalizeBoolean(row.exclusive, "exclusive flag")
        ? "venue_manager_portal:pint_path_exclusive"
        : "venue_manager_portal:special",
      sourceSubmissionId: null,
      lastVerifiedAt: row.updated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return [...beerRecords, ...happyRecords, ...specialRecords]
      .sort(compareNewest)
      .slice(0, boundedLimit);
  }
}

export const publicPriceRepositoryLimits = {
  maxFilterVenueIds: MAX_FILTER_VENUE_IDS,
  maxIdentifierLength: MAX_IDENTIFIER_LENGTH,
  maxSqlLimit: MAX_SQL_LIMIT,
} as const;
