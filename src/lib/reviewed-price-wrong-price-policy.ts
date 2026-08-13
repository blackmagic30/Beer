import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../db/postgres-migration-schema.js";

export const REVIEWED_PRICE_WRONG_PRICE_POLICY_KIND =
  "pintpath-reviewed-price-wrong-price-policy" as const;
export const REVIEWED_PRICE_WRONG_PRICE_POLICY_VERSION = 1 as const;

export const REVIEWED_PRICE_WRONG_PRICE_REASONS = Object.freeze([
  "beer_not_available",
  "happy_hour_changed",
  "other",
  "price_changed",
  "wrong_serving_size",
] as const);

export const REVIEWED_PRICE_WRONG_PRICE_STATUSES = Object.freeze([
  "in_progress",
  "open",
  "rejected",
  "resolved",
] as const);

export const REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES = Object.freeze([
  "in_progress",
  "open",
] as const);

export const REVIEWED_PRICE_WRONG_PRICE_POLICY = Object.freeze({
  blockingReasonSemantics: "all_known_reasons_when_unresolved",
  blockingStatuses: REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
  knownReasons: REVIEWED_PRICE_WRONG_PRICE_REASONS,
  knownStatuses: REVIEWED_PRICE_WRONG_PRICE_STATUSES,
  kind: REVIEWED_PRICE_WRONG_PRICE_POLICY_KIND,
  noSeverityInference: true,
  terminalStatuses: Object.freeze(["rejected", "resolved"] as const),
  version: REVIEWED_PRICE_WRONG_PRICE_POLICY_VERSION,
});

export const REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256 =
  sha256PostgresMigrationBytes(
    serializeCanonicalPostgresMigrationJson(REVIEWED_PRICE_WRONG_PRICE_POLICY),
  );

export type ReviewedPriceWrongPriceStatus =
  typeof REVIEWED_PRICE_WRONG_PRICE_STATUSES[number];

export function reviewedPriceWrongPriceStatusBlocksPromotion(
  status: ReviewedPriceWrongPriceStatus,
): boolean {
  return status === "in_progress" || status === "open";
}
