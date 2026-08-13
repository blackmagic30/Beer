import { createHash } from "node:crypto";
import { URL as NodeUrl } from "node:url";

import type {
  AdminIngestionBeerRecord,
  AdminIngestionQueueRecord,
} from "../db/models.js";
import type { AdminBeerInput } from "../modules/admin/admin.schemas.js";

// Selection runs after database and dependency callbacks. Keep every semantic
// decision on captured primitives so a post-import prototype/global mutation
// cannot turn an ineligible source or row into publishable map data.
const ARRAY_IS_ARRAY = Array.isArray;
const DECODE_URI_COMPONENT = decodeURIComponent;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = NUMBER_CONSTRUCTOR.isFinite;
const NUMBER_IS_SAFE_INTEGER = NUMBER_CONSTRUCTOR.isSafeInteger;
const NUMBER_TO_FIXED = NUMBER_CONSTRUCTOR.prototype.toFixed;
const NUMBER_TO_STRING = NUMBER_CONSTRUCTOR.prototype.toString;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = OBJECT_CONSTRUCTOR.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = OBJECT_CONSTRUCTOR.hasOwn;
const REFLECT_OBJECT = Reflect;
const REFLECT_APPLY = REFLECT_OBJECT.apply;
const REFLECT_CONSTRUCT = REFLECT_OBJECT.construct;
const REFLECT_DEFINE_PROPERTY = REFLECT_OBJECT.defineProperty;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_CHAR_AT = String.prototype.charAt;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const URL_PROTOCOL_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "protocol",
)!.get!;
const URL_PATHNAME_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  NodeUrl.prototype,
  "pathname",
)!.get!;

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
const WHITESPACE_CHARACTER_RE = /^\s$/;

function ownDataDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | null {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [value, key],
  ) as PropertyDescriptor | undefined;
  return descriptor !== undefined
    && REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"]) === true
    ? descriptor
    : null;
}

function arrayLength(value: unknown): number | null {
  if (ARRAY_IS_ARRAY(value) !== true) return null;
  const descriptor = ownDataDescriptor(value, "length");
  return descriptor !== null
    && typeof descriptor.value === "number"
    && NUMBER_IS_SAFE_INTEGER(descriptor.value)
    && descriptor.value >= 0
    ? descriptor.value
    : null;
}

function arrayValue<T>(value: readonly T[], index: number): T | undefined {
  const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
  const descriptor = ownDataDescriptor(value, key);
  return descriptor !== null && descriptor.enumerable === true
    ? descriptor.value as T
    : undefined;
}

function defineDenseArrayValue<T>(target: T[], index: number, value: T): boolean {
  const key = REFLECT_APPLY(NUMBER_TO_STRING, index, []) as string;
  const defined = REFLECT_APPLY(
    REFLECT_DEFINE_PROPERTY,
    REFLECT_OBJECT,
    [target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    }],
  );
  const descriptor = ownDataDescriptor(target, key);
  return defined === true
    && descriptor !== null
    && descriptor.enumerable === true
    && descriptor.value === value
    && arrayLength(target) === index + 1;
}

function appendDenseArrayValue<T>(target: T[], value: T): boolean {
  const length = arrayLength(target);
  return length !== null && defineDenseArrayValue(target, length, value);
}

function matches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function trimmed(value: string): string {
  return REFLECT_APPLY(STRING_TRIM, value, []) as string;
}

function lowerCase(value: string): string {
  return REFLECT_APPLY(STRING_TO_LOWER_CASE, value, []) as string;
}

function numeric(value: unknown): number {
  return REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [value]) as number;
}

function sourceHaystack(queueItem: ReviewedPriceSourceItem): string {
  let output = "";
  const append = (value: string | null): void => {
    if (!value) return;
    if (output !== "") output += "\n";
    output += value;
  };
  append(queueItem.sourceUrl);
  append(queueItem.note);
  append(queueItem.capturedNotes);
  return output;
}

function normalizedPathname(pathname: string): string {
  const decoded = REFLECT_APPLY(
    DECODE_URI_COMPONENT,
    undefined,
    [pathname],
  ) as string;
  let output = "";
  let separatorOpen = false;
  for (let index = 0; index < decoded.length; index += 1) {
    const character = REFLECT_APPLY(STRING_CHAR_AT, decoded, [index]) as string;
    if (character === "-" || character === "_") {
      if (!separatorOpen) output += " ";
      separatorOpen = true;
      continue;
    }
    separatorOpen = false;
    output += character;
  }
  return output;
}

export function isLikelyBaselineMenuSource(
  queueItem: ReviewedPriceSourceItem,
  options: Pick<ReviewedPriceSelectionOptions, "allowHomepage" | "allowSpecialSources">
    = REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
): boolean {
  if (!queueItem.sourceUrl) return false;

  let url: NodeUrl;
  try {
    url = REFLECT_CONSTRUCT(NodeUrl, [queueItem.sourceUrl]) as NodeUrl;
  } catch {
    return false;
  }

  const protocol = REFLECT_APPLY(URL_PROTOCOL_GETTER, url, []) as string;
  if (protocol !== "http:" && protocol !== "https:") return false;

  const haystack = sourceHaystack(queueItem);
  if (!options.allowSpecialSources && matches(EVENT_OR_SPECIAL_RE, haystack)) return false;

  const rawPathname = REFLECT_APPLY(URL_PATHNAME_GETTER, url, []) as string;
  const pathname = normalizedPathname(rawPathname);
  if (matches(EXCLUDED_SOURCE_PATH_RE, pathname)) return false;
  if (matches(DIRECT_RASTER_IMAGE_RE, rawPathname)) return false;

  if (pathname === "/" || trimmed(pathname) === "") {
    return options.allowHomepage && matches(HOMEPAGE_MENU_SIGNAL_RE, haystack);
  }

  return matches(BASELINE_MENU_PATH_RE, pathname);
}

function isUsableBeerRow(
  row: AdminIngestionBeerRecord,
  options: ReviewedPriceSelectionOptions,
): boolean {
  const name = trimmed(row.name);
  const price = numeric(row.priceNumeric);
  const confidence = numeric(row.confidence);
  let context = "";
  if (row.priceText) context = row.priceText;
  if (row.notes) context += `${context === "" ? "" : " "}${row.notes}`;

  return name !== ""
    && name.length >= 3
    && !matches(NOISY_BEER_NAME_RE, name)
    && !matches(NON_BASELINE_ROW_CONTEXT_RE, context)
    && row.servingSize === "pint"
    && row.availabilityStatus === "on_tap"
    && row.availablePackageOnly !== true
    && row.availableOnTap !== false
    && NUMBER_IS_FINITE(price)
    && price >= options.minPrice
    && price <= options.maxPrice
    && NUMBER_IS_FINITE(confidence)
    && confidence >= options.minRowConfidence;
}

function beerKey(name: string): string {
  const source = trimmed(name);
  let output = "";
  let whitespaceOpen = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = REFLECT_APPLY(STRING_CHAR_AT, source, [index]) as string;
    if (matches(WHITESPACE_CHARACTER_RE, character)) {
      if (!whitespaceOpen) output += " ";
      whitespaceOpen = true;
      continue;
    }
    whitespaceOpen = false;
    output += character;
  }
  return lowerCase(output);
}

function dedupeAndDropAmbiguousRows(
  rows: readonly AdminIngestionBeerRecord[],
): AdminIngestionBeerRecord[] {
  const grouped: Array<{
    key: string;
    rows: AdminIngestionBeerRecord[];
  }> = [];
  const rowCount = arrayLength(rows);
  if (rowCount === null) return [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = arrayValue(rows, rowIndex);
    if (row === undefined) return [];
    const key = beerKey(row.name);
    let groupIndex = -1;
    const groupCount = arrayLength(grouped)!;
    for (let index = 0; index < groupCount; index += 1) {
      if (arrayValue(grouped, index)?.key === key) {
        groupIndex = index;
        break;
      }
    }
    if (groupIndex === -1) {
      const group = { key, rows: [] as AdminIngestionBeerRecord[] };
      if (!appendDenseArrayValue(group.rows, row)) return [];
      if (!appendDenseArrayValue(grouped, group)) return [];
      continue;
    }
    const group = arrayValue(grouped, groupIndex);
    if (group === undefined || !appendDenseArrayValue(group.rows, row)) return [];
  }

  const output: AdminIngestionBeerRecord[] = [];
  const groupCount = arrayLength(grouped)!;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const groupRows = arrayValue(grouped, groupIndex)?.rows;
    const groupRowCount = groupRows === undefined ? null : arrayLength(groupRows);
    if (groupRows === undefined || groupRowCount === null || groupRowCount === 0) return [];
    const firstRow = arrayValue(groupRows, 0);
    if (firstRow === undefined) return [];
    const firstPrice = REFLECT_APPLY(
      NUMBER_TO_FIXED,
      numeric(firstRow.priceNumeric),
      [2],
    ) as string;
    let ambiguous = false;
    for (let rowIndex = 1; rowIndex < groupRowCount; rowIndex += 1) {
      const row = arrayValue(groupRows, rowIndex);
      if (row === undefined) return [];
      const price = REFLECT_APPLY(
        NUMBER_TO_FIXED,
        numeric(row.priceNumeric),
        [2],
      ) as string;
      if (price !== firstPrice) ambiguous = true;
    }
    if (ambiguous) continue;
    if (!appendDenseArrayValue(output, firstRow)) return [];
  }
  return output;
}

function toAdminBeerInput(row: AdminIngestionBeerRecord): AdminBeerInput {
  return {
    name: row.name,
    servingSize: "pint",
    priceNumeric: numeric(row.priceNumeric),
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
  const addReason = (reason: string): void => {
    if (!appendDenseArrayValue(reasons, reason)) {
      throw new Error("reviewed_price_selection_array_invalid");
    }
  };

  if (queueItem.sourceType !== "source_reference") {
    addReason("source_type_not_reference");
  }
  if (!isLikelyBaselineMenuSource(queueItem, options)) {
    addReason("not_baseline_menu_source");
  }
  if ((queueItem.overallConfidence ?? 0) < options.minOverallConfidence) {
    addReason("low_overall_confidence");
  }

  const usableRows: AdminIngestionBeerRecord[] = [];
  const extractedCount = arrayLength(queueItem.extractedBeers);
  if (extractedCount !== null) {
    for (let index = 0; index < extractedCount; index += 1) {
      const row = arrayValue(queueItem.extractedBeers, index);
      if (row !== undefined && isUsableBeerRow(row, options)) {
        if (!appendDenseArrayValue(usableRows, row)) {
          throw new Error("reviewed_price_selection_array_invalid");
        }
      }
    }
  }
  const usableRowCount = arrayLength(usableRows)!;
  if (usableRowCount === 0) {
    addReason("no_usable_on_tap_pint_rows");
  }

  const dedupedRows = dedupeAndDropAmbiguousRows(usableRows);
  const dedupedRowCount = arrayLength(dedupedRows)!;
  if (usableRowCount > 0 && dedupedRowCount === 0) {
    addReason("ambiguous_duplicate_prices");
  }

  if (arrayLength(reasons)! > 0) return { beers: [], reasons };
  const beers: AdminBeerInput[] = [];
  for (let index = 0; index < dedupedRowCount; index += 1) {
    const row = arrayValue(dedupedRows, index);
    if (row === undefined || !appendDenseArrayValue(beers, toAdminBeerInput(row))) {
      throw new Error("reviewed_price_selection_array_invalid");
    }
  }
  return { beers, reasons: [] };
}
