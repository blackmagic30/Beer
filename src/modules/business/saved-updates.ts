import crypto from "node:crypto";

import type { SavedItem } from "../../db/account-profile-preferences.repository.js";
import {
  SAVED_UPDATES_MAX_SCOPES,
  SavedUpdatesReadRepository,
  type SavedUpdateCandidate,
  type SavedUpdateReadScope,
} from "../../db/saved-updates-read.repository.js";
import { findTrackedBeerByName, normalizeBeerSearchKey } from "../../constants/beers.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const EVENT_WINDOW_DAYS = 7;
const FRESHNESS_DAYS = 30;
const MAX_VISIBLE_UPDATES = 20;

export type SavedUpdatesExperimentVariant = "control" | "treatment";
export type SavedUpdateType = "verified_after_save" | "became_stale";

export interface SavedUpdateItem {
  id: string;
  type: SavedUpdateType;
  title: string;
  summary: string;
  effectiveAt: string;
  mapHref: string;
}

export interface SavedUpdatesFeed {
  enabled: boolean;
  variant: SavedUpdatesExperimentVariant;
  asOf: string;
  windowDays: number;
  revision: string | null;
  updates: SavedUpdateItem[];
  eligibleResultCount: number;
  copy: string;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function subtractDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * DAY_MS).toISOString();
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function beerKey(value: string): string {
  return findTrackedBeerByName(value)?.key ?? normalizeBeerSearchKey(value);
}

function safeScopeLabel(value: string): string {
  return value.trim().slice(0, 180);
}

export function savedUpdatesExperimentVariant(accountId: string): SavedUpdatesExperimentVariant {
  const digest = crypto.createHash("sha256")
    .update(`pintpath:saved-updates:experiment:v1\0${accountId}`)
    .digest();
  return (digest[0]! & 1) === 0 ? "control" : "treatment";
}

function toScope(item: SavedItem): SavedUpdateReadScope | null {
  if (item.itemType !== "venue" && item.itemType !== "beer") return null;
  const normalizedBeerKey = beerKey(item.itemType === "beer" ? item.label : item.itemId);
  if (!normalizedBeerKey) return null;
  return {
    savedItemId: item.id,
    scopeType: item.itemType,
    itemId: item.itemId,
    beerKey: normalizedBeerKey,
    label: safeScopeLabel(item.label),
    savedAt: item.createdAt,
    staleEligibleAfter: subtractDays(item.createdAt, FRESHNESS_DAYS),
  };
}

function updateId(accountId: string, type: SavedUpdateType, candidate: SavedUpdateCandidate, effectiveAt: string): string {
  return sha256([
    "pintpath:saved-update:v1",
    accountId,
    type,
    candidate.savedItemId,
    candidate.recordId,
    effectiveAt,
  ].join("\0"));
}

function deepLink(candidate: SavedUpdateCandidate): string {
  const query = new URLSearchParams({
    venueId: candidate.canonicalVenueId,
    venueName: candidate.venueName,
    beer: candidate.beerName,
  });
  return `/?${query.toString()}`;
}

function toUpdate(accountId: string, candidate: SavedUpdateCandidate, eventWindowStart: string, asOf: string): SavedUpdateItem | null {
  const authorityVerifiedAt = candidate.authorityVerifiedAt;
  if (
    authorityVerifiedAt
    && authorityVerifiedAt > candidate.savedAt
    && authorityVerifiedAt > eventWindowStart
    && authorityVerifiedAt <= asOf
  ) {
    return {
      id: updateId(accountId, "verified_after_save", candidate, authorityVerifiedAt),
      type: "verified_after_save",
      title: `${candidate.beerName} was verified after you saved ${candidate.scopeLabel}`,
      summary: `Trusted price data for ${candidate.beerName} at ${candidate.venueName} was verified after this ${candidate.scopeType} was saved.`,
      effectiveAt: authorityVerifiedAt,
      mapHref: deepLink(candidate),
    };
  }

  const staleAt = addDays(candidate.freshnessVerifiedAt, FRESHNESS_DAYS);
  if (staleAt > candidate.savedAt && staleAt > eventWindowStart && staleAt <= asOf) {
    return {
      id: updateId(accountId, "became_stale", candidate, staleAt),
      type: "became_stale",
      title: `${candidate.beerName} price data needs a fresh check`,
      summary: `Price data for ${candidate.beerName} at ${candidate.venueName} crossed Pint Path’s ${FRESHNESS_DAYS}-day freshness limit. Check the map before heading out.`,
      effectiveAt: staleAt,
      mapHref: deepLink(candidate),
    };
  }
  return null;
}

export async function buildSavedUpdatesFeed(input: {
  accountId: string;
  savedItems: readonly SavedItem[];
  asOf: string;
  repository: SavedUpdatesReadRepository;
}): Promise<SavedUpdatesFeed> {
  const variant = savedUpdatesExperimentVariant(input.accountId);
  const eventWindowStart = subtractDays(input.asOf, EVENT_WINDOW_DAYS);
  const scopes = input.savedItems
    .map(toScope)
    .filter((scope): scope is SavedUpdateReadScope => scope !== null)
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt) || left.savedItemId.localeCompare(right.savedItemId))
    .slice(0, SAVED_UPDATES_MAX_SCOPES);

  if (variant === "control" || scopes.length === 0) {
    return {
      enabled: true,
      variant,
      asOf: input.asOf,
      windowDays: EVENT_WINDOW_DAYS,
      revision: null,
      updates: [],
      eligibleResultCount: 0,
      copy: "Saved Updates is being evaluated in-app. No email or push notifications are sent.",
    };
  }

  const page = await input.repository.listEligibleCandidates({
    scopes,
    asOf: input.asOf,
    eventWindowStart,
    staleWindowStart: subtractDays(eventWindowStart, FRESHNESS_DAYS),
    staleBefore: subtractDays(input.asOf, FRESHNESS_DAYS),
  });
  if (page.truncated) {
    return {
      enabled: false,
      variant,
      asOf: input.asOf,
      windowDays: EVENT_WINDOW_DAYS,
      revision: null,
      updates: [],
      eligibleResultCount: 0,
      copy: "Saved Updates is temporarily unavailable for this account.",
    };
  }

  const updates = page.candidates
    .map((candidate) => toUpdate(input.accountId, candidate, eventWindowStart, input.asOf))
    .filter((update): update is SavedUpdateItem => update !== null)
    .sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt) || left.id.localeCompare(right.id));
  const visibleUpdates = updates.slice(0, MAX_VISIBLE_UPDATES);
  const revision = visibleUpdates.length
    ? sha256(["pintpath:saved-updates:feed:v1", input.accountId, ...visibleUpdates.map((update) => update.id)].join("\0"))
    : null;

  return {
    enabled: true,
    variant,
    asOf: input.asOf,
    windowDays: EVENT_WINDOW_DAYS,
    revision,
    updates: visibleUpdates,
    eligibleResultCount: updates.length,
    copy: "Only recent verification and freshness changes are shown. No email or push notifications are sent.",
  };
}

export const SAVED_UPDATES_EVENT_WINDOW_DAYS = EVENT_WINDOW_DAYS;
export const SAVED_UPDATES_FRESHNESS_DAYS = FRESHNESS_DAYS;
