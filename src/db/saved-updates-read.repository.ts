import type { SqlDatabase } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_SCOPES = 20;
const MAX_RESULTS = 100;
const MAX_TEXT_LENGTH = 512;

export type SavedUpdateReadScopeType = "venue" | "beer";

export interface SavedUpdateReadScope {
  savedItemId: string;
  scopeType: SavedUpdateReadScopeType;
  itemId: string;
  beerKey: string;
  label: string;
  savedAt: string;
  staleEligibleAfter: string;
}

export interface SavedUpdateCandidate {
  savedItemId: string;
  scopeType: SavedUpdateReadScopeType;
  scopeLabel: string;
  savedAt: string;
  recordId: string;
  canonicalVenueId: string;
  venueName: string;
  suburb: string | null;
  beerName: string;
  freshnessVerifiedAt: string;
  authorityVerifiedAt: string | null;
}

export interface SavedUpdateCandidatePage {
  candidates: SavedUpdateCandidate[];
  truncated: boolean;
}

interface CandidateRow extends Record<string, unknown> {
  saved_item_id: unknown;
  scope_type: unknown;
  scope_label: unknown;
  saved_at: unknown;
  record_id: unknown;
  canonical_venue_id: unknown;
  venue_name: unknown;
  suburb: unknown;
  beer_name: unknown;
  freshness_verified_at: unknown;
  authority_verified_at: unknown;
}

function requiredText(value: unknown, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new Error("Saved Updates input is invalid.");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error("Saved Updates input is invalid.");
  }
  return normalized;
}

function canonicalUtc(value: unknown): string {
  const normalized = requiredText(value, 32);
  if (!CANONICAL_UTC_TIMESTAMP.test(normalized)) throw new Error("Saved Updates input is invalid.");
  try {
    if (new Date(normalized).toISOString() !== normalized) throw new Error();
  } catch {
    throw new Error("Saved Updates input is invalid.");
  }
  return normalized;
}

function optionalStoredText(value: unknown, maximum = MAX_TEXT_LENGTH): string | null {
  if (value == null) return null;
  return requiredText(value, maximum);
}

function decodeCandidate(row: CandidateRow): SavedUpdateCandidate {
  const scopeType = requiredText(row.scope_type, 16);
  if (scopeType !== "venue" && scopeType !== "beer") {
    throw new Error("Stored Saved Updates evidence is invalid.");
  }
  return {
    savedItemId: requiredText(row.saved_item_id),
    scopeType,
    scopeLabel: requiredText(row.scope_label, 180),
    savedAt: canonicalUtc(row.saved_at),
    recordId: requiredText(row.record_id),
    canonicalVenueId: requiredText(row.canonical_venue_id),
    venueName: requiredText(row.venue_name, 180),
    suburb: optionalStoredText(row.suburb, 180),
    beerName: requiredText(row.beer_name, 180),
    freshnessVerifiedAt: canonicalUtc(row.freshness_verified_at),
    authorityVerifiedAt: row.authority_verified_at == null
      ? null
      : canonicalUtc(row.authority_verified_at),
  };
}

export class SavedUpdatesReadRepository {
  constructor(private readonly database: SqlDatabase) {}

  async listEligibleCandidates(input: {
    scopes: readonly SavedUpdateReadScope[];
    asOf: string;
    eventWindowStart: string;
    staleWindowStart: string;
    staleBefore: string;
  }): Promise<SavedUpdateCandidatePage> {
    if (!Array.isArray(input.scopes) || input.scopes.length > MAX_SCOPES) {
      throw new Error("Saved Updates input is invalid.");
    }
    const asOf = canonicalUtc(input.asOf);
    const eventWindowStart = canonicalUtc(input.eventWindowStart);
    const staleWindowStart = canonicalUtc(input.staleWindowStart);
    const staleBefore = canonicalUtc(input.staleBefore);
    if (eventWindowStart > asOf || staleWindowStart > staleBefore || staleBefore > asOf) {
      throw new Error("Saved Updates input is invalid.");
    }
    if (input.scopes.length === 0) return { candidates: [], truncated: false };

    const bindings: Record<string, unknown> = {
      asOf,
      eventWindowStart,
      staleWindowStart,
      staleBefore,
      fetchLimit: MAX_RESULTS + 1,
    };
    const scopeRows = input.scopes.map((scope, index) => {
      if (scope.scopeType !== "venue" && scope.scopeType !== "beer") {
        throw new Error("Saved Updates input is invalid.");
      }
      const values = {
        savedItemId: requiredText(scope.savedItemId),
        scopeType: scope.scopeType,
        itemId: requiredText(scope.itemId, 180),
        beerKey: requiredText(scope.beerKey, 180),
        label: requiredText(scope.label, 180),
        savedAt: canonicalUtc(scope.savedAt),
        staleEligibleAfter: canonicalUtc(scope.staleEligibleAfter),
      };
      for (const [key, value] of Object.entries(values)) bindings[`${key}${index}`] = value;
      const savedAtBinding = this.database.dialect === "postgres"
        ? `CAST(@savedAt${index} AS timestamptz)`
        : `@savedAt${index}`;
      const staleEligibleAfterBinding = this.database.dialect === "postgres"
        ? `CAST(@staleEligibleAfter${index} AS timestamptz)`
        : `@staleEligibleAfter${index}`;
      return `(@savedItemId${index}, @scopeType${index}, @itemId${index}, @beerKey${index},
               @label${index}, ${savedAtBinding}, ${staleEligibleAfterBinding})`;
    });

    const rows = await this.database.prepare(
      `WITH input_scopes (
         saved_item_id, scope_type, item_id, beer_key, label, saved_at, stale_eligible_after
       ) AS (VALUES ${scopeRows.join(", ")}),
       saved_canonical_venues AS (
         SELECT scope.saved_item_id,
                COALESCE(identity.canonical_venue_id, scope.item_id) AS canonical_venue_id
           FROM input_scopes scope
           LEFT JOIN venue_identity_aliases identity
             ON identity.alias_venue_id = scope.item_id
          WHERE scope.scope_type = 'venue'
       ),
       saved_venue_ids AS (
         SELECT saved.saved_item_id, saved.canonical_venue_id AS venue_id
           FROM saved_canonical_venues saved
         UNION
         SELECT saved.saved_item_id, identity.alias_venue_id AS venue_id
           FROM saved_canonical_venues saved
           JOIN venue_identity_aliases identity
             ON identity.canonical_venue_id = saved.canonical_venue_id
       ),
       community_scope_records AS (
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                price.id, price.venue_id, price.venue_name, price.suburb, price.beer_name,
                price.normalized_beer_id, price.serving_size, price.price, price.is_happy_hour_price,
                price.is_on_tap, price.confidence, price.source_type,
                price.source_submission_id, price.source_evidence_verified_at,
                price.last_verified_at, price.updated_at
           FROM input_scopes scope
           JOIN saved_venue_ids saved_venue ON saved_venue.saved_item_id = scope.saved_item_id
           JOIN venue_price_records price ON price.venue_id = saved_venue.venue_id
          WHERE scope.scope_type = 'venue'
         UNION ALL
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                price.id, price.venue_id, price.venue_name, price.suburb, price.beer_name,
                price.normalized_beer_id, price.serving_size, price.price, price.is_happy_hour_price,
                price.is_on_tap, price.confidence, price.source_type,
                price.source_submission_id, price.source_evidence_verified_at,
                price.last_verified_at, price.updated_at
           FROM input_scopes scope
           JOIN venue_price_records price ON price.normalized_beer_id = scope.beer_key
          WHERE scope.scope_type = 'beer'
         UNION ALL
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                price.id, price.venue_id, price.venue_name, price.suburb, price.beer_name,
                price.normalized_beer_id, price.serving_size, price.price, price.is_happy_hour_price,
                price.is_on_tap, price.confidence, price.source_type,
                price.source_submission_id, price.source_evidence_verified_at,
                price.last_verified_at, price.updated_at
           FROM input_scopes scope
           JOIN venue_price_records price
             ON (price.normalized_beer_id IS NULL OR price.normalized_beer_id = '')
            AND lower(trim(price.beer_name)) = scope.beer_key
          WHERE scope.scope_type = 'beer'
       ),
       community_candidates AS (
         SELECT price.saved_item_id, price.scope_type, price.scope_label,
                price.saved_at, price.stale_eligible_after,
                price.id AS record_id,
                COALESCE(identity.canonical_venue_id, price.venue_id) AS canonical_venue_id,
                price.venue_name, price.suburb, price.beer_name,
                COALESCE(NULLIF(price.normalized_beer_id, ''), lower(trim(price.beer_name))) AS beer_key,
                price.serving_size, price.price, price.is_on_tap, price.confidence,
                price.last_verified_at AS authority_sort_at,
                price.last_verified_at AS freshness_verified_at,
                CASE
                  WHEN submission.status = 'approved' AND submission.reviewed_at IS NOT NULL
                    THEN submission.reviewed_at
                  WHEN price.source_evidence_verified_at IS NOT NULL
                    THEN price.source_evidence_verified_at
                  ELSE NULL
                END AS authority_verified_at,
                price.updated_at, 1 AS authority_priority, 'community' AS candidate_type
           FROM community_scope_records price
           LEFT JOIN venue_identity_aliases identity ON identity.alias_venue_id = price.venue_id
          LEFT JOIN submissions submission ON submission.id = price.source_submission_id
          WHERE price.source_type <> 'source_ingestion_quarantined'
            AND price.is_happy_hour_price = FALSE
       ),
       manager_scope_records AS (
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                beer.id, beer.venue_id, beer.beer_name, beer.normalized_beer_id,
                beer.serve_size, beer.price, beer.on_tap, beer.in_stock,
                beer.price_verified_at, beer.source_ingestion_id, beer.created_at, beer.updated_at
           FROM input_scopes scope
           JOIN saved_venue_ids saved_venue ON saved_venue.saved_item_id = scope.saved_item_id
           JOIN venue_beers beer ON beer.venue_id = saved_venue.venue_id
          WHERE scope.scope_type = 'venue'
         UNION ALL
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                beer.id, beer.venue_id, beer.beer_name, beer.normalized_beer_id,
                beer.serve_size, beer.price, beer.on_tap, beer.in_stock,
                beer.price_verified_at, beer.source_ingestion_id, beer.created_at, beer.updated_at
           FROM input_scopes scope
           JOIN venue_beers beer ON beer.normalized_beer_id = scope.beer_key
          WHERE scope.scope_type = 'beer'
         UNION ALL
         SELECT scope.saved_item_id, scope.scope_type, scope.label AS scope_label,
                scope.saved_at, scope.stale_eligible_after,
                beer.id, beer.venue_id, beer.beer_name, beer.normalized_beer_id,
                beer.serve_size, beer.price, beer.on_tap, beer.in_stock,
                beer.price_verified_at, beer.source_ingestion_id, beer.created_at, beer.updated_at
           FROM input_scopes scope
           JOIN venue_beers beer
             ON (beer.normalized_beer_id IS NULL OR beer.normalized_beer_id = '')
            AND lower(trim(beer.beer_name)) = scope.beer_key
          WHERE scope.scope_type = 'beer'
       ),
       manager_candidates AS (
         SELECT beer.saved_item_id, beer.scope_type, beer.scope_label,
                beer.saved_at, beer.stale_eligible_after,
                ('bar_beer:' || beer.id) AS record_id,
                COALESCE(identity.canonical_venue_id, beer.venue_id) AS canonical_venue_id,
                profile.name AS venue_name, profile.suburb, beer.beer_name,
                COALESCE(NULLIF(beer.normalized_beer_id, ''), lower(trim(beer.beer_name))) AS beer_key,
                COALESCE(NULLIF(beer.serve_size, ''), 'other') AS serving_size,
                beer.price, 'yes' AS is_on_tap, '' AS confidence,
                COALESCE(beer.price_verified_at, beer.created_at) AS authority_sort_at,
                COALESCE(beer.price_verified_at, beer.created_at) AS freshness_verified_at,
                beer.price_verified_at AS authority_verified_at,
                beer.updated_at, 2 AS authority_priority, 'manager' AS candidate_type
           FROM manager_scope_records beer
           JOIN venue_profiles profile ON profile.venue_id = beer.venue_id
           LEFT JOIN venue_identity_aliases identity ON identity.alias_venue_id = beer.venue_id
          WHERE beer.on_tap = TRUE AND beer.in_stock = TRUE AND profile.active = TRUE
            AND (beer.source_ingestion_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM venue_price_records quarantined
               WHERE quarantined.source_ingestion_id = beer.source_ingestion_id
                 AND quarantined.source_type = 'source_ingestion_quarantined'
            ))
       ),
       ranked AS (
         SELECT candidate.*,
                row_number() OVER (
                  PARTITION BY candidate.saved_item_id, candidate.canonical_venue_id,
                               candidate.beer_key, candidate.serving_size
                  ORDER BY candidate.authority_sort_at DESC,
                           candidate.authority_priority DESC,
                           candidate.updated_at DESC,
                           candidate.record_id DESC
                ) AS authority_rank
           FROM (
             SELECT * FROM community_candidates
             UNION ALL
             SELECT * FROM manager_candidates
           ) candidate
       )
       SELECT saved_item_id, scope_type, scope_label, saved_at, record_id,
              canonical_venue_id, venue_name, suburb, beer_name,
              freshness_verified_at, authority_verified_at
        FROM ranked
        WHERE authority_rank = 1
          AND authority_sort_at <= @asOf
          AND lower(trim(serving_size)) = 'pint'
          AND price IS NOT NULL AND price > 0
          AND (
            (candidate_type = 'community'
             AND confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')
             AND is_on_tap = 'yes')
            OR
            (candidate_type = 'manager' AND authority_verified_at IS NOT NULL)
          )
          AND (
            (authority_verified_at IS NOT NULL
             AND authority_verified_at > saved_at
             AND authority_verified_at > @eventWindowStart
             AND authority_verified_at <= @asOf)
            OR
            (freshness_verified_at > stale_eligible_after
             AND freshness_verified_at > @staleWindowStart
             AND freshness_verified_at <= @staleBefore)
          )
        ORDER BY COALESCE(authority_verified_at, freshness_verified_at) DESC,
                 saved_item_id, record_id
        LIMIT @fetchLimit`,
    ).all<CandidateRow>(bindings);

    return {
      candidates: rows.slice(0, MAX_RESULTS).map(decodeCandidate),
      truncated: rows.length > MAX_RESULTS,
    };
  }
}

export const SAVED_UPDATES_MAX_SCOPES = MAX_SCOPES;
export const SAVED_UPDATES_MAX_RESULTS = MAX_RESULTS;
