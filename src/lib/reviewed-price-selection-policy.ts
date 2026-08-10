import { createHash } from "node:crypto";

import type {
  AdminIngestionBeerRecord,
  AdminIngestionQueueRecord,
} from "../db/models.js";
import type { AdminBeerInput } from "../modules/admin/admin.schemas.js";

export interface ReviewedPriceSelectionOptions {
  minOverallConfidence: number;
  minRowConfidence: number;
  minPrice: number;
  maxPrice: number;
  allowHomepage: boolean;
  allowSpecialSources: boolean;
}

export interface ReviewedPriceSelectionResult {
  beers: AdminBeerInput[];
  reasons: string[];
}

export type ReviewedPriceSelectionQueueItem = Pick<
  AdminIngestionQueueRecord,
  | "capturedNotes"
  | "extractedBeers"
  | "note"
  | "overallConfidence"
  | "sourceType"
  | "sourceUrl"
>;

type ReviewedPriceSourceItem = Pick<
  ReviewedPriceSelectionQueueItem,
  "capturedNotes" | "note" | "sourceUrl"
>;

export const REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS: Readonly<
  ReviewedPriceSelectionOptions
> = Object.freeze({
  minOverallConfidence: 0.72,
  minRowConfidence: 0.82,
  minPrice: 8,
  maxPrice: 25,
  allowHomepage: false,
  allowSpecialSources: false,
});

const REVIEWED_PRICE_SELECTION_PATTERNS = Object.freeze({
  baselineMenuPath: Object.freeze({
    flags: "i",
    source: String.raw`(?:^|[-_\s/])(?:menu|menus|drink|drinks|beverage|beverages|beer|beers)(?:[-_\s/.]|$)|\.pdf(?:$|[?#])`,
  }),
  directRasterImage: Object.freeze({
    flags: "i",
    source: String.raw`\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])`,
  }),
  excludedSourcePath: Object.freeze({
    flags: "i",
    source: String.raw`\b(?:cocktails?|wine-list|wine_list)\b`,
  }),
  homepageMenuSignal: Object.freeze({
    flags: "i",
    source: String.raw`\b(?:drink price text|html text rows|menu page|drinks? menu|beverage menu|beer menu)\b`,
  }),
  noisyBeerName: Object.freeze({
    flags: "i",
    source: String.raw`\b(?:cocktail|wine|spritz|margarita|negroni|espresso|martini|parma|burger|pizza|steak|wings|coffee|tea|soft drink|soda|mocktail|flight|tasting paddle|cider|ginger\s+beer|hard\s+rated|seltzer|rtd|whisk(?:e)?y|bourbon|vodka|rum|gin|tequila|mezcal)\b`,
  }),
  nonBaselineRowContext: Object.freeze({
    flags: "i",
    source: String.raw`\b(?:schooners?|pots?|middys?|jugs?|cans?|bottles?|stubby|stubbies|pie\s*&?\s*pint|pint\s*&?\s*pie|parma\s*&?\s*pot|pot\s*&?\s*parma|happy[-_\s]?hour|specials?|deal|offer|promo|cocktails?|gin|rum|vodka|tequila|mezcal|whisk(?:e)?y|bourbon|vermouth|liqueur|agave|yuzu|grapefruit|mint|served\s+on\s+ice|tasty\s+pale\s+ale|captain\s+sensible)\b`,
  }),
  specialSource: Object.freeze({
    flags: "i",
    source: String.raw`\b(?:happy[-_\s]?hour|what'?s[-_\s]?on|events?|specials?|mates[-_\s]?rates|parma|roast|beer[-_\s]?of[-_\s]?the[-_\s]?month|drinks?[-_\s]?of[-_\s]?the[-_\s]?month|good[-_\s]?beer[-_\s]?week|big[-_\s]?bash|promo|promotion|deal|offer|blog|post|news|weekly[-_\s]?specials?)\b`,
  }),
});

export const REVIEWED_PRICE_SELECTION_POLICY = Object.freeze({
  canonicalOutput: Object.freeze({
    fieldOrder: Object.freeze([
      "name",
      "servingSize",
      "priceNumeric",
      "priceText",
      "availabilityStatus",
      "availableOnTap",
      "availablePackageOnly",
      "unavailableReason",
      "needsReview",
    ]),
    fixedValues: Object.freeze({
      availabilityStatus: "on_tap",
      availableOnTap: true,
      availablePackageOnly: false,
      needsReview: false,
      servingSize: "pint",
      unavailableReason: null,
    }),
    preservedFields: Object.freeze(["name", "priceText"]),
    priceNumericCoercion: "Number",
  }),
  deduplication: Object.freeze({
    ambiguousPriceGroup: "drop_entire_group",
    groupOrder: "first_key_insertion_order",
    nameKey: "trim_collapse_whitespace_lowercase",
    priceKey: "Number(priceNumeric).toFixed(2)",
    retainedRow: "first_input_row",
  }),
  defaultOptions: REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
  kind: "pintpath-reviewed-price-selection-policy",
  patterns: REVIEWED_PRICE_SELECTION_PATTERNS,
  reasonOrder: Object.freeze([
    "source_type_not_reference",
    "not_baseline_menu_source",
    "low_overall_confidence",
    "no_usable_on_tap_pint_rows",
    "ambiguous_duplicate_prices",
  ]),
  resultSemantics: Object.freeze({
    ambiguousReason: "usable_rows_present_and_all_groups_dropped",
    noUsableReason: "filtered_row_count_is_zero",
    suppressSelectedRowsWhenAnyReasonExists: true,
  }),
  rowEligibility: Object.freeze({
    availableOnTap: "not_false",
    availablePackageOnly: "not_true",
    availabilityStatus: "on_tap",
    confidenceCoercion: "Number",
    confidenceMustBeFinite: true,
    contextFields: Object.freeze(["priceText", "notes"]),
    contextSeparator: "space",
    minimumTrimmedNameLength: 3,
    nameValidation: "trim_for_validation_preserve_original_for_output",
    priceCoercion: "Number",
    priceMustBeFinite: true,
    thresholdComparison: "inclusive",
    servingSize: "pint",
  }),
  sourceEligibility: Object.freeze({
    allowedProtocols: Object.freeze(["http:", "https:"]),
    baselinePatternInput: "decoded_normalized_pathname",
    directRasterPatternInput: "original_url_pathname",
    excludedPathPatternInput: "decoded_normalized_pathname",
    haystackFields: Object.freeze(["sourceUrl", "note", "capturedNotes"]),
    haystackSeparator: "newline",
    homepagePath: "/",
    invalidUrl: "reject",
    malformedEncodedPath: "throw_URIError",
    pathnameNormalization: "decodeURIComponent_then_replace_hyphen_or_underscore_runs_with_space",
    specialPatternInput: "haystack_before_pathname_decoding",
    sourceType: "source_reference",
  }),
  version: 1,
});

function canonicalizePolicy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePolicy);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalizePolicy(nested)]),
    );
  }
  return value;
}

export const REVIEWED_PRICE_SELECTION_POLICY_CANONICAL_JSON =
  `${JSON.stringify(canonicalizePolicy(REVIEWED_PRICE_SELECTION_POLICY), null, 2)}\n`;

export const REVIEWED_PRICE_SELECTION_POLICY_SHA256 = createHash("sha256")
  .update(REVIEWED_PRICE_SELECTION_POLICY_CANONICAL_JSON, "utf8")
  .digest("hex");

const BASELINE_MENU_PATH_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.baselineMenuPath.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.baselineMenuPath.flags,
);
const HOMEPAGE_MENU_SIGNAL_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.homepageMenuSignal.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.homepageMenuSignal.flags,
);
const EXCLUDED_SOURCE_PATH_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.excludedSourcePath.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.excludedSourcePath.flags,
);
const EVENT_OR_SPECIAL_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.specialSource.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.specialSource.flags,
);
const DIRECT_RASTER_IMAGE_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.directRasterImage.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.directRasterImage.flags,
);
const NOISY_BEER_NAME_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.noisyBeerName.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.noisyBeerName.flags,
);
const NON_BASELINE_ROW_CONTEXT_RE = new RegExp(
  REVIEWED_PRICE_SELECTION_PATTERNS.nonBaselineRowContext.source,
  REVIEWED_PRICE_SELECTION_PATTERNS.nonBaselineRowContext.flags,
);

function sourceHaystack(queueItem: ReviewedPriceSourceItem): string {
  return [queueItem.sourceUrl, queueItem.note, queueItem.capturedNotes]
    .filter(Boolean)
    .join("\n");
}

export function isLikelyBaselineMenuSource(
  queueItem: ReviewedPriceSourceItem,
  options: Pick<ReviewedPriceSelectionOptions, "allowHomepage" | "allowSpecialSources">
    = REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
): boolean {
  if (!queueItem.sourceUrl) return false;

  let url: URL;
  try {
    url = new URL(queueItem.sourceUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) return false;

  const haystack = sourceHaystack(queueItem);
  if (!options.allowSpecialSources && EVENT_OR_SPECIAL_RE.test(haystack)) return false;

  const pathname = decodeURIComponent(url.pathname).replace(/[-_]+/g, " ");
  if (EXCLUDED_SOURCE_PATH_RE.test(pathname)) return false;
  if (DIRECT_RASTER_IMAGE_RE.test(url.pathname)) return false;

  if (pathname === "/" || pathname.trim() === "") {
    return options.allowHomepage && HOMEPAGE_MENU_SIGNAL_RE.test(haystack);
  }

  return BASELINE_MENU_PATH_RE.test(pathname);
}

function isUsableBeerRow(
  row: AdminIngestionBeerRecord,
  options: ReviewedPriceSelectionOptions,
): boolean {
  const name = row.name.trim();
  const price = Number(row.priceNumeric);
  const confidence = Number(row.confidence);
  const context = [row.priceText, row.notes].filter(Boolean).join(" ");

  return Boolean(name)
    && name.length >= 3
    && !NOISY_BEER_NAME_RE.test(name)
    && !NON_BASELINE_ROW_CONTEXT_RE.test(context)
    && row.servingSize === "pint"
    && row.availabilityStatus === "on_tap"
    && row.availablePackageOnly !== true
    && row.availableOnTap !== false
    && Number.isFinite(price)
    && price >= options.minPrice
    && price <= options.maxPrice
    && Number.isFinite(confidence)
    && confidence >= options.minRowConfidence;
}

function beerKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupeAndDropAmbiguousRows(
  rows: readonly AdminIngestionBeerRecord[],
): AdminIngestionBeerRecord[] {
  const grouped = new Map<string, AdminIngestionBeerRecord[]>();
  for (const row of rows) {
    const key = beerKey(row.name);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const output: AdminIngestionBeerRecord[] = [];
  for (const groupRows of grouped.values()) {
    const prices = new Set(groupRows.map((row) => Number(row.priceNumeric).toFixed(2)));
    if (prices.size > 1) continue;
    output.push(groupRows[0]!);
  }
  return output;
}

function toAdminBeerInput(row: AdminIngestionBeerRecord): AdminBeerInput {
  return {
    name: row.name,
    servingSize: "pint",
    priceNumeric: Number(row.priceNumeric),
    priceText: row.priceText,
    availabilityStatus: "on_tap",
    availableOnTap: true,
    availablePackageOnly: false,
    unavailableReason: null,
    needsReview: false,
  };
}

export function selectPublishableMapBaseRows(
  queueItem: ReviewedPriceSelectionQueueItem,
  options: ReviewedPriceSelectionOptions = REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
): ReviewedPriceSelectionResult {
  const reasons: string[] = [];

  if (queueItem.sourceType !== "source_reference") {
    reasons.push("source_type_not_reference");
  }
  if (!isLikelyBaselineMenuSource(queueItem, options)) {
    reasons.push("not_baseline_menu_source");
  }
  if ((queueItem.overallConfidence ?? 0) < options.minOverallConfidence) {
    reasons.push("low_overall_confidence");
  }

  const usableRows = queueItem.extractedBeers.filter((row) => isUsableBeerRow(row, options));
  if (usableRows.length === 0) {
    reasons.push("no_usable_on_tap_pint_rows");
  }

  const dedupedRows = dedupeAndDropAmbiguousRows(usableRows);
  if (usableRows.length > 0 && dedupedRows.length === 0) {
    reasons.push("ambiguous_duplicate_prices");
  }

  if (reasons.length > 0) return { beers: [], reasons };
  return { beers: dedupedRows.map(toAdminBeerInput), reasons: [] };
}
