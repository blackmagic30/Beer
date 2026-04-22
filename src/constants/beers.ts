import { env } from "../config/env.js";

export const SUPPORTED_BEER_KEYS = ["guinness", "carlton_draft", "stone_and_wood"] as const;

export const SUPPORTED_BEERS = {
  guinness: {
    key: "guinness",
    name: "Guinness",
    aliases: ["guinness"],
  },
  carlton_draft: {
    key: "carlton_draft",
    name: "Carlton Draft",
    aliases: ["carlton draft", "carlton draught"],
  },
  stone_and_wood: {
    key: "stone_and_wood",
    name: "Stone & Wood",
    aliases: ["stone and wood", "stone & wood"],
  },
} as const;

export type TargetBeerKey = keyof typeof SUPPORTED_BEERS;
export type BeerDefinition = (typeof SUPPORTED_BEERS)[TargetBeerKey];
export type BeerName = BeerDefinition["name"];

export const DEFAULT_TARGET_BEER_KEY: TargetBeerKey = "guinness";
export const ACTIVE_TARGET_BEER_KEY: TargetBeerKey = env.TARGET_BEER;
export const ACTIVE_TARGET_BEER: BeerDefinition = SUPPORTED_BEERS[ACTIVE_TARGET_BEER_KEY];
export const TARGET_BEERS: readonly BeerDefinition[] = [ACTIVE_TARGET_BEER];

export function getBeerByKey(key: TargetBeerKey): BeerDefinition {
  return SUPPORTED_BEERS[key];
}

export function isTargetBeerKey(value: string): value is TargetBeerKey {
  return SUPPORTED_BEER_KEYS.includes(value as TargetBeerKey);
}

export function normalizeTargetBeerKey(value: string | null | undefined): TargetBeerKey {
  if (!value) {
    return DEFAULT_TARGET_BEER_KEY;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return isTargetBeerKey(normalized) ? normalized : DEFAULT_TARGET_BEER_KEY;
}
