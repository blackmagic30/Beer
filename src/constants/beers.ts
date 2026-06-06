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
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function findTrackedBeerByName(value: string | null | undefined): ViewerTrackedBeerDefinition | null {
  const normalized = normalizeBeerSearchKey(value);
  return normalized ? TRACKED_BEER_LOOKUP.get(normalized) ?? null : null;
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
