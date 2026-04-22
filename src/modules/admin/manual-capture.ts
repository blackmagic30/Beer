import type { BeerAvailabilityStatus, BeerUnavailableReason } from "../../db/models.js";
import { formatBeerAvailabilityLabel } from "../../lib/beer-availability.js";

const RESERVED_CLEANED_KEYS = new Set([
  "beers",
  "menu_capture",
  "menu_items",
  "happy_hour",
  "parse_confidence",
  "parse_status",
  "needs_review",
]);

export interface ManualBeerInput {
  name: string;
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
  needsReview: boolean;
}

export interface ManualBeerEntry {
  label: string;
  price: number | null;
  price_numeric: number | null;
  price_text: string;
  availability_status: BeerAvailabilityStatus;
  available_on_tap: boolean | null;
  available_package_only: boolean;
  unavailable_reason: BeerUnavailableReason;
  availability: {
    status: BeerAvailabilityStatus;
    on_tap: boolean | null;
    package_only: boolean;
    reason: BeerUnavailableReason;
    label: string;
  };
  confidence: number;
  needs_review: boolean;
}

export interface AdminVenueSnapshot {
  id: string;
  name: string;
  suburb: string | null;
}

export interface ExistingCallResultSnapshot {
  raw: Record<string, unknown> | null;
  cleaned: Record<string, unknown> | null;
}

interface BuildManualCallResultRowInput {
  venue: AdminVenueSnapshot;
  latestResult: ExistingCallResultSnapshot | null;
  beers: ManualBeerInput[];
  source: "manual_entry" | "menu_photo_ocr";
  note?: string | null;
  savedAt: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeBeerName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

function formatPriceText(priceNumeric: number | null, priceText: string | null): string {
  if (priceText && priceText.trim().length > 0) {
    return priceText.trim();
  }

  if (priceNumeric !== null) {
    return `$${Number(priceNumeric).toFixed(2).replace(/\.00$/, "")}`;
  }

  return "Price unavailable";
}

export function toBeerKey(beerName: string): string {
  return sanitizeBeerName(beerName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildManualBeerEntry(input: ManualBeerInput): ManualBeerEntry {
  const label = sanitizeBeerName(input.name);
  const priceNumeric = input.priceNumeric === null ? null : Number(input.priceNumeric);

  return {
    label,
    price: priceNumeric,
    price_numeric: priceNumeric,
    price_text: formatPriceText(priceNumeric, input.priceText),
    availability_status: input.availabilityStatus,
    available_on_tap: input.availableOnTap,
    available_package_only: input.availablePackageOnly,
    unavailable_reason: input.unavailableReason,
    availability: {
      status: input.availabilityStatus,
      on_tap: input.availableOnTap,
      package_only: input.availablePackageOnly,
      reason: input.unavailableReason,
      label: formatBeerAvailabilityLabel({
        availabilityStatus: input.availabilityStatus,
        unavailableReason: input.unavailableReason,
      }),
    },
    confidence: 1,
    needs_review: input.needsReview,
  };
}

export function extractBeerEntriesFromCleaned(
  cleaned: Record<string, unknown> | null | undefined,
): Record<string, ManualBeerEntry> {
  if (!cleaned) {
    return {};
  }

  const nestedBeers = isObjectRecord(cleaned.beers) ? cleaned.beers : null;
  const sourceEntries = nestedBeers
    ? Object.entries(nestedBeers)
    : Object.entries(cleaned).filter(([key, value]) => !RESERVED_CLEANED_KEYS.has(key) && isObjectRecord(value));

  return Object.fromEntries(
    sourceEntries
      .filter(([, value]) => isObjectRecord(value))
      .map(([key, value]) => {
        const beerValue = value as Record<string, unknown>;
        const priceNumericValue = beerValue.price_numeric ?? beerValue.price;
        const priceNumeric =
          priceNumericValue == null || Number.isNaN(Number(priceNumericValue))
            ? null
            : Number(priceNumericValue);
        const availabilityStatus = String(
          beerValue.availability_status ?? beerValue.status ?? "unknown",
        ) as BeerAvailabilityStatus;
        const availableOnTap =
          beerValue.available_on_tap == null ? null : Boolean(beerValue.available_on_tap);
        const availablePackageOnly = Boolean(beerValue.available_package_only);
        const unavailableReason = (beerValue.unavailable_reason ?? null) as BeerUnavailableReason;
        const label =
          typeof beerValue.label === "string" && beerValue.label.trim().length > 0
            ? beerValue.label.trim()
            : sanitizeBeerName(key.replace(/_/g, " "));

        return [
          key,
          {
            label,
            price: priceNumeric,
            price_numeric: priceNumeric,
            price_text: formatPriceText(
              priceNumeric,
              typeof beerValue.price_text === "string" ? beerValue.price_text : null,
            ),
            availability_status: availabilityStatus,
            available_on_tap: availableOnTap,
            available_package_only: availablePackageOnly,
            unavailable_reason: unavailableReason,
            availability: {
              status: availabilityStatus,
              on_tap: availableOnTap,
              package_only: availablePackageOnly,
              reason: unavailableReason,
              label: formatBeerAvailabilityLabel({
                availabilityStatus,
                unavailableReason,
              }),
            },
            confidence:
              beerValue.confidence == null || Number.isNaN(Number(beerValue.confidence))
                ? 1
                : Number(beerValue.confidence),
            needs_review: Boolean(beerValue.needs_review),
          } satisfies ManualBeerEntry,
        ];
      }),
  );
}

export function buildMenuItemsFromBeerEntries(
  beerEntries: Record<string, ManualBeerEntry>,
): Array<Record<string, unknown>> {
  return Object.values(beerEntries)
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((beer) => ({
      label: beer.label,
      category: "beer",
      price: beer.price_numeric,
      price_text: beer.price_text,
      availability_status: beer.availability_status,
      available_on_tap: beer.available_on_tap,
      available_package_only: beer.available_package_only,
      unavailable_reason: beer.unavailable_reason,
      availability_label: beer.availability.label,
      confidence: beer.confidence,
      needs_review: beer.needs_review,
    }));
}

export function buildManualCallResultRow(input: BuildManualCallResultRowInput): Record<string, unknown> {
  const existingRaw = isObjectRecord(input.latestResult?.raw) ? input.latestResult.raw : {};
  const existingCleaned = isObjectRecord(input.latestResult?.cleaned) ? input.latestResult.cleaned : {};
  const existingBeers = extractBeerEntriesFromCleaned(existingCleaned);
  const incomingBeers = Object.fromEntries(
    input.beers.map((beer) => [toBeerKey(beer.name), buildManualBeerEntry(beer)]),
  );
  const mergedBeers = {
    ...existingBeers,
    ...incomingBeers,
  };
  const menuItems = buildMenuItemsFromBeerEntries(mergedBeers);
  const existingHappyHour = isObjectRecord(existingCleaned.happy_hour) ? existingCleaned.happy_hour : undefined;
  const needsReview =
    menuItems.some((item) => Boolean(item.needs_review)) ||
    Boolean(existingHappyHour?.needs_review);
  const menuCapture = {
    source: input.source,
    completeness: "manual_edit",
    known_items_count: menuItems.length,
    crowdsource_full_menu_planned: true,
    note: input.note ?? null,
  };

  return {
    venue_id: input.venue.id,
    venue_name: input.venue.name,
    suburb: input.venue.suburb ?? "",
    saved_at: input.savedAt,
    raw: {
      ...existingRaw,
      venue_id: input.venue.id,
      venue_name: input.venue.name,
      suburb: input.venue.suburb ?? "",
      timestamp: input.savedAt,
      source: input.source,
      menu_capture: menuCapture,
      admin_capture: {
        source: input.source,
        submitted_at: input.savedAt,
        note: input.note ?? null,
        beer_count: input.beers.length,
      },
      beer_results: menuItems,
    },
    cleaned: {
      ...existingCleaned,
      ...mergedBeers,
      beers: mergedBeers,
      menu_capture: menuCapture,
      menu_items: menuItems,
      ...(existingHappyHour ? { happy_hour: existingHappyHour } : {}),
      parse_confidence: needsReview ? 0.9 : 1,
      parse_status: needsReview ? "needs_review" : "parsed",
      needs_review: needsReview,
    },
  };
}
