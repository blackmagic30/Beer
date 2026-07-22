import { env } from "../config/env.js";
import { BEER_CATALOG, type BeerCatalogItem } from "./beer-catalog.js";

export const SUPPORTED_TARGET_KEYS = ["guinness", "carlton_draft", "stone_and_wood", "happy_hour"] as const;
export const SUPPORTED_BEER_KEYS = SUPPORTED_TARGET_KEYS;

export const SUPPORTED_BEERS = {
  guinness: {
    key: "guinness",
    name: "Guinness",
    aliases: ["guinness"],
    kind: "beer",
  },
  carlton_draft: {
    key: "carlton_draft",
    name: "Carlton Draught",
    aliases: ["carlton draft", "carlton draught"],
    kind: "beer",
  },
  stone_and_wood: {
    key: "stone_and_wood",
    name: "Stone & Wood Pacific Ale",
    aliases: ["stone and wood", "stone & wood", "stone wood", "pacific ale"],
    kind: "beer",
  },
  happy_hour: {
    key: "happy_hour",
    name: "Happy Hour",
    aliases: ["happy hour", "happyhour", "happy-hour"],
    kind: "happy_hour",
  },
} as const;

export type TargetBeerKey = keyof typeof SUPPORTED_BEERS;
export type BeerDefinition = (typeof SUPPORTED_BEERS)[TargetBeerKey];
export type TrackedBeerDefinition = Extract<BeerDefinition, { kind: "beer" }>;
export type BeerName = TrackedBeerDefinition["name"];
export interface ViewerTrackedBeerDefinition extends BeerCatalogItem {}

export const DEFAULT_TARGET_BEER_KEY: TargetBeerKey = "guinness";
export const ACTIVE_TARGET_BEER_KEY: TargetBeerKey = env.TARGET_BEER;
export const ACTIVE_TARGET_BEER: BeerDefinition = SUPPORTED_BEERS[ACTIVE_TARGET_BEER_KEY];
export const TARGET_BEERS: readonly TrackedBeerDefinition[] =
  ACTIVE_TARGET_BEER.kind === "beer" ? [ACTIVE_TARGET_BEER] : [SUPPORTED_BEERS[DEFAULT_TARGET_BEER_KEY]];
export const VIEWER_TRACKED_BEERS: readonly ViewerTrackedBeerDefinition[] = BEER_CATALOG;
const TRACKED_BEER_LOOKUP = new Map<string, ViewerTrackedBeerDefinition>();

for (const beer of VIEWER_TRACKED_BEERS) {
  for (const candidate of [beer.key, beer.name, ...beer.aliases]) {
    const normalized = normalizeBeerSearchKey(candidate);

    if (normalized) {
      TRACKED_BEER_LOOKUP.set(normalized, beer);
    }
  }
}

export function getBeerByKey(key: TargetBeerKey): BeerDefinition {
  return SUPPORTED_BEERS[key];
}

export function normalizeBeerSearchKey(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return normalized.startsWith("_") ? normalized.slice(1) : normalized.endsWith("_") ? normalized.slice(0, -1) : normalized;
}

export function findTrackedBeerByName(value: string | null | undefined): ViewerTrackedBeerDefinition | null {
  const normalized = normalizeBeerSearchKey(value);
  return normalized ? TRACKED_BEER_LOOKUP.get(normalized) ?? null : null;
}

const NON_BEER_NAME_KEYS = new Set([
  "happy_hour",
  "happy_hour_special",
  "happy_hour_specials",
  "venue_special",
  "venue_specials",
  "pint_path_special",
  "pint_path_specials",
  "weekly_special",
  "weekly_specials",
  "special",
  "specials",
  "included",
  "includes",
  "included_you_ll_find",
  "included_you_ll_find_cocktails",
  "included_you_ll_find_cocktails_spirits",
  "house_wine",
  "house_wines",
  "basic_spirits",
  "selected_tap_beer",
  "selected_taps",
  "home_hero",
  "beer",
  "pint",
  "pints",
  "pot",
  "pots",
  "schooner",
  "schooners",
  "draught",
  "draft",
  "lager",
  "ale",
  "pale_ale",
  "ipa",
  "xpa",
  "stout",
  "cider",
  "pilsner",
  "cocktail",
  "cocktails",
  "negroni",
  "negronis",
  "spirits",
  "wines",
]);

export function isLikelyBeerName(value: string | null | undefined): boolean {
  const trimmed = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed || !/[a-z]/i.test(trimmed)) {
    return false;
  }

  if (findTrackedBeerByName(trimmed)) {
    return true;
  }

  const normalizedValue = trimmed.replace(/&amp;/gi, "&");
  const key = normalizeBeerSearchKey(normalizedValue);
  if (!key || NON_BEER_NAME_KEYS.has(key)) {
    return false;
  }

  if (
    /^(?:https?:|www\.|\/\/|\/|[+$])/i.test(normalizedValue) ||
    /[/?=*$%]/.test(normalizedValue) ||
    /&amp\b/i.test(trimmed)
  ) {
    return false;
  }

  const isClearlyPackagedRtd =
    /\b(?:rtd|ready\s+to\s+drink|pre[-\s]?mix(?:ed)?|hard\s+seltzer)\b/i.test(normalizedValue) ||
    /\b(?:gin|vodka|rum|whisk(?:e)?y|bourbon)\s*(?:&|and|\+)\s*(?:dry|cola|coke|soda|lemon|ginger|lime)\b/i.test(normalizedValue) ||
    /\b(?:canadian\s+club|jim\s+beam|jack\s+daniel'?s|suntory)\b.*\b(?:dry|cola|coke|soda|lemon)\b/i.test(normalizedValue);

  if (
    /\b(?:happy\s*hour|included|includes|cocktails?|negronis?|spirits?|house\s*wines?|basic\s*spirits?|selected\s*taps?|weekly\s*specials?|grab\s+a|for\s+just|blogs?|event|source|menu)\b/i.test(normalizedValue) ||
    (!isClearlyPackagedRtd && /\b(?:gin|vodka|rum|tequila|mezcal|whisk(?:e)?y|bourbon|brandy|cognac|vermouth|liqueur|amaro|aperol|campari|martini|margarita|spritz|mojito|daiquiri|poor\s+tom'?s|archie\s+rose|four\s+pillars|mgc\s+dry|78\s+degrees|hellyer'?s)\b/i.test(normalizedValue)) ||
    /\b(?:wine|shiraz|pinot|chardonnay|sauvignon|riesling|merlot|cabernet|prosecco|champagne|ros[eé]|grigio|moscato)\b/i.test(normalizedValue) ||
    /\b(?:steak|t\s?-?\s?bone|sirloin|ribeye|burger|fries|chips|parma|parmi|schnitzel|oysters?|calamari|prawns?|salad|dessert|chicken|beef|pork|lamb|fish|pizza|pasta|tacos?|sandwich|cheese|wings?|sauce|gravy|garlic\s+bread)\b/i.test(normalizedValue) ||
    /\b(?:welcome|we\s+believe|please\s+ask|ask\s+staff|book\s+a\s+table|available\s+from|served\s+with|our\s+range|tap(?:s)?\s+will\s+pour|for\s+everyone|contact\s+us|learn\s+more|terms\s+and\s+conditions)\b/i.test(normalizedValue) ||
    /\byou\W?ll\s+find\b/i.test(normalizedValue) ||
    /\b(?:pints?|pots?|schooners?)\s+(?:of|and|selected|house)\b/i.test(normalizedValue) ||
    /\b\d{1,2}(?::?\d{2})?\s*(?:am|pm)\b/i.test(normalizedValue) ||
    /^\d{3,4}\s*(?:am|pm)?\b/i.test(normalizedValue)
  ) {
    return false;
  }

  const words = normalizedValue.split(/\s+/).filter(Boolean);
  if (words.length > 7 || /[.!?]$/.test(normalizedValue)) {
    return false;
  }

  if (words.length === 1 && normalizedValue === normalizedValue.toUpperCase()) {
    return false;
  }

  return normalizedValue.length <= 64;
}

export function canonicalizeTrackedBeerName(value: string | null | undefined): string {
  return findTrackedBeerByName(value)?.name ?? String(value ?? "").trim();
}

export function isTargetBeerKey(value: string): value is TargetBeerKey {
  return SUPPORTED_TARGET_KEYS.includes(value as TargetBeerKey);
}

export function normalizeTargetBeerKey(value: string | null | undefined): TargetBeerKey {
  if (!value) {
    return DEFAULT_TARGET_BEER_KEY;
  }

  const normalized = normalizeBeerSearchKey(value);
  return isTargetBeerKey(normalized) ? normalized : DEFAULT_TARGET_BEER_KEY;
}
