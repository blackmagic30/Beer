import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type BetterSqlite3 from "better-sqlite3";

import type { AdminIngestionQueueRepository } from "../../db/admin-ingestion-queue.repository.js";
import { BeerCatalogRepository, type ResolvedBeerCatalogItem } from "../../db/beer-catalog.repository.js";
import type {
  AdminIngestionBeerRecord,
  AdminIngestionCrawlerFeedback,
  AdminIngestionQueueRecord,
  AdminIngestionStatus,
} from "../../db/models.js";
import {
  VIEWER_TRACKED_BEERS,
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { selectLabeledPintPrice } from "../../lib/menu-price-selection.js";
import { redactSecrets } from "../../lib/redact.js";
import {
  type GoogleAddressComponent,
  type GooglePlaceCandidate,
  hasStrongBarOrPubNameSignal,
  isExcludedVenueName,
  shouldImportBarOrPubPlace,
} from "../../lib/venue-directory.js";

import type {
  AdminBeerInput,
  AdminBulkRejectQueuedIngestionsInput,
  AdminManualCaptureInput,
  AdminMenuPhotoOcrInput,
  AdminPublishQueuedIngestionInput,
  AdminRejectQueuedIngestionInput,
  AdminSourceIngestionQueueInput,
  AdminVenueInput,
} from "./admin.schemas.js";
import {
  buildManualBeerEntry,
  buildManualVenueCaptureRow,
  type AdminVenueSnapshot,
  type ExistingVenueMenuCaptureSnapshot,
  type ManualBeerInput,
} from "./manual-capture.js";

interface VenueRow extends AdminVenueSnapshot {
  address: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface AdminGoogleVenueLookup {
  googlePlaceId: string;
  name: string;
  address: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  businessStatus: string | null;
  primaryType: string | null;
  types: string[];
  recommended: boolean;
  alreadyExists: boolean;
  existingVenue: Pick<VenueRow, "id" | "name" | "address" | "suburb"> | null;
}

interface GooglePlacesSearchResponse {
  places?: GooglePlaceCandidate[];
  error?: { message?: string; code?: number; status?: string };
}

const ADMIN_GOOGLE_VENUE_TYPES = ["bar", "pub", "restaurant", "brewery", "night_club"] as const;
const ADMIN_GOOGLE_VENUE_TYPE_SET = new Set<string>(ADMIN_GOOGLE_VENUE_TYPES);
const MENU_PHOTO_OCR_MODEL = process.env.OPENAI_MENU_OCR_MODEL?.trim() || "gpt-4.1";
const MENU_PHOTO_OCR_REVIEW_PASS_ENABLED =
  (process.env.OPENAI_MENU_OCR_REVIEW_PASS ?? "true").trim().toLowerCase() !== "false";

type MenuPhotoOcrInput = AdminMenuPhotoOcrInput | { venueNameHint: string | null; imageDataUrl: string };

interface MenuPhotoOcrModelItem {
  name: string;
  price_numeric: number | null;
  price_text: string | null;
  availability_status: "on_tap" | "package_only" | "unavailable" | "unknown";
  available_on_tap: boolean | null;
  available_package_only: boolean;
  unavailable_reason: "cans_only" | "bottles_only" | "cans_or_bottles" | "no_pints" | "not_on_tap" | "not_stocked" | "unknown" | null;
  notes: string | null;
  confidence: number | null;
}

interface MenuPhotoOcrModelResponse {
  venue_name_guess: string | null;
  captured_notes: string | null;
  overall_confidence: number | null;
  beers: MenuPhotoOcrModelItem[];
}

interface NormalizedOcrExtraction {
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  beers: AdminIngestionBeerRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  return JSON.parse(withoutFence);
}

function getOcrProviderErrorDetails(error: unknown): Record<string, unknown> {
  const record = isRecord(error) ? error : {};
  return {
    message: error instanceof Error ? redactSecrets(error.message) : "Unknown OCR provider error",
    status: typeof record.status === "number" ? record.status : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    requestId:
      typeof record.request_id === "string"
        ? record.request_id
        : typeof record.requestID === "string"
          ? record.requestID
          : undefined,
  };
}

function getExternalErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AppError && isRecord(error.details)) {
    return error.details;
  }

  return isRecord(error) ? error : {};
}

function getExternalErrorMessage(error: unknown): string {
  const details = getExternalErrorDetails(error);
  if (typeof details.message === "string" && details.message.trim()) {
    return redactSecrets(details.message);
  }

  if (error instanceof Error && error.message) {
    return redactSecrets(error.message);
  }

  return "unknown";
}

function normalizeConfidence(value: unknown, fallback: number | null = null): number | null {
  if (value == null || value === "") {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, numeric));
}

function normalizeOcrResponse(value: unknown): MenuPhotoOcrModelResponse {
  if (!isRecord(value)) {
    throw new AppError("Menu OCR returned an invalid payload", 502);
  }

  const beers = Array.isArray(value.beers)
    ? value.beers
        .filter(isRecord)
        .map((beer) => ({
          name: typeof beer.name === "string" ? beer.name.trim() : "",
          price_numeric:
            beer.price_numeric == null || Number.isNaN(Number(beer.price_numeric))
              ? null
              : Number(beer.price_numeric),
          price_text: typeof beer.price_text === "string" ? beer.price_text.trim() : null,
          availability_status:
            typeof beer.availability_status === "string" &&
            ["on_tap", "package_only", "unavailable", "unknown"].includes(beer.availability_status)
              ? (beer.availability_status as MenuPhotoOcrModelItem["availability_status"])
              : "unknown",
          available_on_tap:
            beer.available_on_tap == null ? null : Boolean(beer.available_on_tap),
          available_package_only: Boolean(beer.available_package_only),
          unavailable_reason:
            typeof beer.unavailable_reason === "string" &&
            ["cans_only", "bottles_only", "cans_or_bottles", "no_pints", "not_on_tap", "not_stocked", "unknown"].includes(beer.unavailable_reason)
              ? (beer.unavailable_reason as MenuPhotoOcrModelItem["unavailable_reason"])
              : null,
          notes: typeof beer.notes === "string" ? beer.notes.trim() : null,
          confidence: normalizeConfidence(beer.confidence, null),
        }))
        .filter((beer) => beer.name.length > 0)
        .map((beer) => ({
          ...beer,
          name: canonicalizeTrackedBeerName(beer.name),
        }))
    : [];

  return {
    venue_name_guess:
      typeof value.venue_name_guess === "string" && value.venue_name_guess.trim().length > 0
        ? value.venue_name_guess.trim()
        : null,
    captured_notes:
      typeof value.captured_notes === "string" && value.captured_notes.trim().length > 0
        ? value.captured_notes.trim()
        : null,
    overall_confidence: normalizeConfidence(value.overall_confidence, beers.length > 0 ? 0.7 : null),
    beers,
  };
}

function normalizedOcrBeerPrice(beer: MenuPhotoOcrModelItem): {
  priceNumeric: number | null;
  priceText: string | null;
} {
  const selectedPint = selectLabeledPintPrice(beer.price_text);
  if (selectedPint) {
    return {
      priceNumeric: selectedPint.priceNumeric,
      priceText: selectedPint.priceText,
    };
  }

  const priceText = beer.price_text?.trim() || null;
  const evidence = `${beer.name} ${priceText ?? ""} ${beer.notes ?? ""}`;
  const priceNumeric = beer.price_numeric == null ? null : Number(beer.price_numeric);
  if (priceNumeric == null || !Number.isFinite(priceNumeric)) {
    return { priceNumeric: null, priceText };
  }

  const escapedPrice = String(priceNumeric).replace(/\.0$/, "").replace(".", "\\.");
  const priceLooksLikeAbv = new RegExp(`\\b${escapedPrice}\\s*%`).test(evidence);
  const hasCurrencyPrice = priceText != null && /(?:A\$|AUD\s*|\$)\s*\d/i.test(priceText);
  if ((priceLooksLikeAbv || /\bABV\b/i.test(evidence)) && priceNumeric < 7 && !hasCurrencyPrice) {
    return { priceNumeric: null, priceText };
  }

  if (priceNumeric > 80 || /\b(?:330|335|355|375|440|500|570)\s?ml\b/i.test(priceText ?? "")) {
    return { priceNumeric: null, priceText };
  }

  return { priceNumeric, priceText };
}

function needsReviewFromConfidence(input: {
  confidence: number | null;
  availabilityStatus: MenuPhotoOcrModelItem["availability_status"];
  priceNumeric: number | null;
}): boolean {
  if (input.confidence == null || input.confidence < 0.82) {
    return true;
  }

  if (input.availabilityStatus === "unknown") {
    return true;
  }

  if (input.availabilityStatus === "on_tap" && input.priceNumeric == null) {
    return true;
  }

  return false;
}

function toAdminBeerInput(beer: AdminIngestionBeerRecord): AdminBeerInput {
  return {
    name: beer.name,
    servingSize: beer.servingSize,
    priceNumeric: beer.priceNumeric,
    priceText: beer.priceText,
    availabilityStatus: beer.availabilityStatus,
    availableOnTap: beer.availableOnTap,
    availablePackageOnly: beer.availablePackageOnly,
    unavailableReason: beer.unavailableReason,
    needsReview: beer.needsReview,
  };
}

function toRecordIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "beer";
}

function clampRewardScore(value: number): number {
  return Math.min(100, Math.max(-100, Math.round(value)));
}

function normalizeFeedbackText(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeFeedbackNumber(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(2));
}

function reviewBeerDiffersFromExtraction(
  reviewBeer: AdminBeerInput,
  extractedBeer: AdminIngestionBeerRecord,
): boolean {
  return (
    normalizeFeedbackText(reviewBeer.name) !== normalizeFeedbackText(extractedBeer.name) ||
    normalizeFeedbackNumber(reviewBeer.priceNumeric) !== normalizeFeedbackNumber(extractedBeer.priceNumeric) ||
    normalizeFeedbackText(reviewBeer.priceText) !== normalizeFeedbackText(extractedBeer.priceText) ||
    reviewBeer.availabilityStatus !== extractedBeer.availabilityStatus ||
    reviewBeer.availableOnTap !== extractedBeer.availableOnTap ||
    reviewBeer.availablePackageOnly !== extractedBeer.availablePackageOnly ||
    reviewBeer.unavailableReason !== extractedBeer.unavailableReason ||
    reviewBeer.needsReview !== extractedBeer.needsReview
  );
}

function countCorrectedReviewRows(
  reviewBeers: AdminBeerInput[],
  extractedBeers: AdminIngestionBeerRecord[],
): number {
  const matchedIndexes = new Set<number>();
  let corrected = 0;

  reviewBeers.forEach((reviewBeer, reviewIndex) => {
    let extractedIndex = extractedBeers.findIndex((extractedBeer, index) =>
      !matchedIndexes.has(index) &&
      normalizeFeedbackText(extractedBeer.name) === normalizeFeedbackText(reviewBeer.name),
    );

    if (extractedIndex < 0 && reviewIndex < extractedBeers.length && !matchedIndexes.has(reviewIndex)) {
      extractedIndex = reviewIndex;
    }

    if (extractedIndex < 0) {
      corrected += 1;
      return;
    }

    matchedIndexes.add(extractedIndex);
    if (reviewBeerDiffersFromExtraction(reviewBeer, extractedBeers[extractedIndex]!)) {
      corrected += 1;
    }
  });

  return corrected;
}

export function buildCrawlerFeedback(input: {
  outcome: AdminIngestionCrawlerFeedback["outcome"];
  extractedBeers: AdminIngestionBeerRecord[];
  reviewBeers?: AdminBeerInput[];
  note: string | null;
  generatedAt: string;
}): AdminIngestionCrawlerFeedback {
  const extractedRowCount = input.extractedBeers.length;
  const reviewBeers = input.reviewBeers ?? [];
  const acceptedRowCount = input.outcome === "published" ? reviewBeers.length : 0;
  const rejectedRowCount = Math.max(0, extractedRowCount - acceptedRowCount);
  const correctedRowCount =
    input.outcome === "published" ? countCorrectedReviewRows(reviewBeers, input.extractedBeers) : 0;
  const cleanRowCount =
    input.outcome === "published"
      ? reviewBeers.filter((beer) => !beer.needsReview).length
      : 0;
  const acceptedRatio = extractedRowCount > 0 ? acceptedRowCount / extractedRowCount : acceptedRowCount > 0 ? 1 : 0;
  const cleanRatio = acceptedRowCount > 0 ? cleanRowCount / acceptedRowCount : 0;
  const correctionRate = acceptedRowCount > 0 ? correctedRowCount / acceptedRowCount : 0;
  const rewardScore =
    input.outcome === "published"
      ? clampRewardScore(10 + acceptedRatio * 70 + cleanRatio * 20 - correctionRate * 15)
      : clampRewardScore(extractedRowCount > 0 ? -70 : -25);
  const signals = [
    input.outcome === "published"
      ? `${acceptedRowCount}/${Math.max(1, extractedRowCount)} rows accepted`
      : `${extractedRowCount} row${extractedRowCount === 1 ? "" : "s"} rejected`,
    correctedRowCount > 0 ? `${correctedRowCount} manual correction${correctedRowCount === 1 ? "" : "s"}` : "No row corrections",
    cleanRowCount > 0 ? `${cleanRowCount} clean row${cleanRowCount === 1 ? "" : "s"}` : null,
    input.note ? `Reviewer note: ${input.note}` : null,
  ].filter((signal): signal is string => Boolean(signal));

  return {
    outcome: input.outcome,
    rewardScore,
    acceptedRowCount,
    extractedRowCount,
    rejectedRowCount,
    correctedRowCount,
    cleanRowCount,
    note: input.note,
    generatedAt: input.generatedAt,
    signals,
  };
}

function getAddressComponent(
  components: GoogleAddressComponent[] | undefined,
  type: string,
  value: "longText" | "shortText" = "longText",
): string | null {
  const component = components?.find((item) => item.types?.includes(type));
  const text = component?.[value]?.trim() || component?.longText?.trim() || component?.shortText?.trim();
  return text && text.length > 0 ? text : null;
}

function cleanGoogleAddress(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/,\s*Australia$/i, "")
    .trim();
}

function getGooglePlaceTypes(place: GooglePlaceCandidate): string[] {
  return [
    place.primaryType,
    ...(place.types ?? []),
  ]
    .filter((type): type is string => Boolean(type))
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedAdminGoogleVenue(place: GooglePlaceCandidate): boolean {
  const name = place.displayName?.text?.trim() ?? "";
  const address = place.formattedAddress?.trim() ?? "";
  const types = getGooglePlaceTypes(place);
  const businessStatus = place.businessStatus ?? "OPERATIONAL";

  if (!name || !address || businessStatus === "CLOSED_PERMANENTLY") {
    return false;
  }

  if (isExcludedVenueName(name)) {
    return false;
  }

  return types.some((type) => ADMIN_GOOGLE_VENUE_TYPE_SET.has(type));
}

function hasVenueAdminPlaceSignal(place: GooglePlaceCandidate): boolean {
  const name = place.displayName?.text?.trim() ?? "";
  return shouldImportBarOrPubPlace(place) ||
    hasStrongBarOrPubNameSignal(name) ||
    isAllowedAdminGoogleVenue(place);
}

export class AdminService {
  private readonly supabase?: SupabaseClient;
  private readonly openai?: OpenAI;
  private readonly beerCatalogRepository?: BeerCatalogRepository;

  constructor(
    private readonly ingestionQueueRepository: AdminIngestionQueueRepository | undefined,
    supabaseUrl?: string,
    supabaseServiceRoleKey?: string,
    private readonly menuCaptureTable = "venue_menu_captures",
    openaiApiKey?: string,
    private readonly googlePlacesApiKey?: string,
    private readonly priceRecordDatabase?: BetterSqlite3.Database,
  ) {
    if (supabaseUrl && supabaseServiceRoleKey) {
      this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }

    if (openaiApiKey) {
      this.openai = new OpenAI({
        apiKey: openaiApiKey,
      });
    }

    if (priceRecordDatabase) {
      this.beerCatalogRepository = new BeerCatalogRepository(priceRecordDatabase);
    }
  }

  getStatus() {
    const ocrEnabled = Boolean(this.openai);
    const googlePlacesEnabled = Boolean(this.googlePlacesApiKey);
    return {
      enabled: Boolean(this.supabase),
      ocrEnabled,
      ocrReason: ocrEnabled ? null : "missing_openai_api_key",
      googlePlacesEnabled,
      googlePlacesReason: googlePlacesEnabled ? null : "missing_google_places_api_key",
      queueEnabled: Boolean(this.supabase && this.ingestionQueueRepository),
    };
  }

  private getSupabase(): SupabaseClient {
    if (!this.supabase) {
      throw new AppError("Supabase admin client is not configured.", 503);
    }

    return this.supabase;
  }

  private getTrackedBeerNamesForOcrPrompt(): string {
    const beers = this.beerCatalogRepository?.listForViewer() ?? VIEWER_TRACKED_BEERS;
    return Array.from(new Set(beers.map((beer) => beer.name.trim()).filter(Boolean))).join(", ");
  }

  private getIngestionQueue(): AdminIngestionQueueRepository {
    if (!this.ingestionQueueRepository) {
      throw new AppError("Source ingestion queue is not configured on this deployment.", 503);
    }

    return this.ingestionQueueRepository;
  }

  private async getVenueById(venueId: string): Promise<VenueRow> {
    const supabase = this.getSupabase();
    const { data, error } = await supabase
      .from("venues")
      .select("id, name, address, suburb, state, postcode, phone, website, latitude, longitude")
      .eq("id", venueId)
      .single();

    if (error || !data) {
      throw new ExternalServiceError("Failed to fetch venue for admin capture", {
        venueId,
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
        code: error?.code,
      });
    }

    return data as VenueRow;
  }

  private async fetchGooglePlaces<T>(
    url: string,
    init: RequestInit & { fieldMask: string },
  ): Promise<T> {
    if (!this.googlePlacesApiKey) {
      throw new AppError("Google Places lookup is not configured. Set GOOGLE_PLACES_API_KEY on the server.", 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    const { fieldMask, headers, ...requestInit } = init;
    try {
      const response = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.googlePlacesApiKey,
          "X-Goog-FieldMask": fieldMask,
          ...(headers ?? {}),
        },
      });

      const payload = await response.json().catch(() => ({})) as T & GooglePlacesSearchResponse;
      if (!response.ok) {
        throw new ExternalServiceError("Google Places lookup failed", {
          status: response.status,
          message: payload.error?.message ? redactSecrets(payload.error.message) : response.statusText,
        });
      }

      return payload as T;
    } catch (error) {
      if (error instanceof AppError || error instanceof ExternalServiceError) {
        throw error;
      }

      logger.warn("Google Places admin lookup failed", {
        error: error instanceof Error ? redactSecrets(error.message) : "unknown",
      });
      throw new ExternalServiceError("Google Places lookup failed. Try again or use manual entry.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findExistingGoogleVenue(place: GooglePlaceCandidate): Promise<AdminGoogleVenueLookup["existingVenue"]> {
    if (!this.supabase) {
      return null;
    }

    const columns = "id, name, address, suburb";
    if (place.id) {
      const { data, error } = await this.supabase
        .from("venues")
        .select(columns)
        .eq("google_place_id", place.id)
        .maybeSingle();

      if (error) {
        logger.warn("Failed to check venue duplicate by Google place ID", {
          error: redactSecrets(error.message),
        });
      } else if (data) {
        return data as AdminGoogleVenueLookup["existingVenue"];
      }
    }

    const name = place.displayName?.text?.trim();
    const address = cleanGoogleAddress(place.formattedAddress);
    if (!name || !address) {
      return null;
    }

    const { data, error } = await this.supabase
      .from("venues")
      .select(columns)
      .eq("name", name)
      .eq("address", address)
      .maybeSingle();

    if (error) {
      logger.warn("Failed to check venue duplicate by name and address", {
        error: redactSecrets(error.message),
      });
      return null;
    }

    return data as AdminGoogleVenueLookup["existingVenue"] | null;
  }

  private async normalizeGoogleVenueLookup(place: GooglePlaceCandidate): Promise<AdminGoogleVenueLookup | null> {
    const googlePlaceId = place.id?.trim();
    const name = place.displayName?.text?.trim();
    const address = cleanGoogleAddress(place.formattedAddress);
    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;

    if (!googlePlaceId || !name || !address) {
      return null;
    }

    const suburb =
      getAddressComponent(place.addressComponents, "locality") ??
      getAddressComponent(place.addressComponents, "postal_town") ??
      getAddressComponent(place.addressComponents, "sublocality") ??
      getAddressComponent(place.addressComponents, "sublocality_level_1") ??
      getAddressComponent(place.addressComponents, "neighborhood");
    const state = getAddressComponent(place.addressComponents, "administrative_area_level_1", "shortText");
    const postcode = getAddressComponent(place.addressComponents, "postal_code");
    const existingVenue = await this.findExistingGoogleVenue(place);

    return {
      googlePlaceId,
      name,
      address,
      suburb,
      state,
      postcode,
      phone: place.internationalPhoneNumber?.trim() || place.nationalPhoneNumber?.trim() || null,
      website: place.websiteUri?.trim() || null,
      latitude: typeof latitude === "number" ? latitude : null,
      longitude: typeof longitude === "number" ? longitude : null,
      businessStatus: place.businessStatus ?? null,
      primaryType: place.primaryType ?? null,
      types: place.types ?? [],
      recommended: hasVenueAdminPlaceSignal(place),
      alreadyExists: Boolean(existingVenue),
      existingVenue,
    };
  }

  async searchGoogleVenuePlaces(query: string): Promise<{
    configured: boolean;
    places: AdminGoogleVenueLookup[];
  }> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 2) {
      throw new AppError("Search a venue name, area, or address.", 400);
    }

    if (!this.googlePlacesApiKey) {
      return { configured: false, places: [] };
    }

    const textQuery = /(?:melbourne|victoria|\bvic\b|australia)/i.test(normalizedQuery)
      ? normalizedQuery
      : `${normalizedQuery}, Melbourne VIC, Australia`;
    const searchByType = async (includedType: typeof ADMIN_GOOGLE_VENUE_TYPES[number]) => {
      const body = {
        textQuery,
        pageSize: 5,
        languageCode: "en-AU",
        regionCode: "AU",
        includedType,
        strictTypeFiltering: true,
        includePureServiceAreaBusinesses: false,
        locationBias: {
          rectangle: {
            low: { latitude: -38.5, longitude: 144.3 },
            high: { latitude: -37.4, longitude: 145.6 },
          },
        },
      };

      const payload = await this.fetchGooglePlaces<GooglePlacesSearchResponse>(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          body: JSON.stringify(body),
          fieldMask: [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.addressComponents",
            "places.location",
            "places.businessStatus",
            "places.primaryType",
            "places.types",
          ].join(","),
        },
      );

      return payload.places ?? [];
    };

    const typedResults = await Promise.all(
      ADMIN_GOOGLE_VENUE_TYPES.map((includedType) => searchByType(includedType)),
    );
    const candidatesById = new Map<string, GooglePlaceCandidate>();
    for (const place of typedResults.flat()) {
      if (!place.id || !isAllowedAdminGoogleVenue(place)) {
        continue;
      }

      if (!candidatesById.has(place.id)) {
        candidatesById.set(place.id, place);
      }
    }

    const ranked = Array.from(candidatesById.values()).sort((left, right) => {
      const leftRecommended = hasVenueAdminPlaceSignal(left) ? 1 : 0;
      const rightRecommended = hasVenueAdminPlaceSignal(right) ? 1 : 0;
      if (leftRecommended !== rightRecommended) {
        return rightRecommended - leftRecommended;
      }

      return (left.displayName?.text ?? "").localeCompare(right.displayName?.text ?? "");
    });
    const normalized = await Promise.all(ranked.slice(0, 8).map((place) => this.normalizeGoogleVenueLookup(place)));

    return {
      configured: true,
      places: normalized.filter((place): place is AdminGoogleVenueLookup => Boolean(place)),
    };
  }

  async getGoogleVenuePlace(placeId: string): Promise<{
    configured: boolean;
    place: AdminGoogleVenueLookup | null;
  }> {
    const normalizedPlaceId = placeId.trim();
    if (!normalizedPlaceId) {
      throw new AppError("Choose a Google venue result first.", 400);
    }

    if (!this.googlePlacesApiKey) {
      return { configured: false, place: null };
    }

    const payload = await this.fetchGooglePlaces<GooglePlaceCandidate>(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`,
      {
        method: "GET",
        fieldMask: [
          "id",
          "displayName",
          "formattedAddress",
          "addressComponents",
          "location",
          "nationalPhoneNumber",
          "internationalPhoneNumber",
          "websiteUri",
          "businessStatus",
          "primaryType",
          "types",
        ].join(","),
      },
    );

    return {
      configured: true,
      place: isAllowedAdminGoogleVenue(payload)
        ? await this.normalizeGoogleVenueLookup(payload)
        : null,
    };
  }

  private async getLatestVenueMenuCapture(venueId: string): Promise<ExistingVenueMenuCaptureSnapshot | null> {
    const supabase = this.getSupabase();
    const { data, error } = await supabase
      .from(this.menuCaptureTable)
      .select("raw, cleaned")
      .eq("venue_id", venueId)
      .order("saved_at", { ascending: false })
      .limit(1);

    if (error) {
      throw new ExternalServiceError("Failed to fetch latest manual merge snapshot", {
        venueId,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    const row = Array.isArray(data) ? data[0] : null;
    return row ? (row as ExistingVenueMenuCaptureSnapshot) : null;
  }

  private resolveSystemBeer(input: {
    name: string;
    source: string;
    now: string;
    createIfMissing?: boolean;
  }): ResolvedBeerCatalogItem {
    if (this.beerCatalogRepository) {
      return this.beerCatalogRepository.resolveBeerName(input);
    }

    const beerName = canonicalizeTrackedBeerName(input.name);
    const trackedBeer = findTrackedBeerByName(beerName);
    return {
      key: trackedBeer?.key ?? normalizeBeerSearchKey(beerName),
      name: trackedBeer?.name ?? beerName,
      brewery: trackedBeer?.brewery ?? null,
      style: trackedBeer?.style ?? null,
      abv: trackedBeer?.abv ?? null,
      status: trackedBeer ? "active" : "pending_review",
      source: trackedBeer ? "system_catalog" : input.source,
      created: false,
      matchedExisting: Boolean(trackedBeer),
    };
  }

  private standardizeAdminBeerInputs(
    beers: AdminBeerInput[],
    source: string,
    now: string,
    createIfMissing = true,
  ): AdminBeerInput[] {
    return beers.map((beer) => {
      const resolved = this.resolveSystemBeer({
        name: beer.name,
        source,
        now,
        createIfMissing,
      });

      return {
        ...beer,
        name: resolved.name,
        needsReview: beer.needsReview || resolved.status === "pending_review" || resolved.created,
      };
    });
  }

  private standardizeIngestionBeerRecords(
    beers: AdminIngestionBeerRecord[],
    source: string,
    now: string,
    createIfMissing = true,
  ): AdminIngestionBeerRecord[] {
    return beers.map((beer) => {
      const resolved = this.resolveSystemBeer({
        name: beer.name,
        source,
        now,
        createIfMissing,
      });
      const systemNote =
        resolved.created
          ? `Added to system beer catalog as pending review: ${resolved.name}.`
          : resolved.status === "pending_review" && !resolved.matchedExisting
            ? `System beer catalog review needed: ${resolved.name}.`
            : null;

      return {
        ...beer,
        name: resolved.name,
        needsReview: beer.needsReview || resolved.status === "pending_review" || resolved.created,
        notes: [beer.notes, systemNote].filter(Boolean).join(" ") || null,
      };
    });
  }

  private async persistManualCapture(input: AdminManualCaptureInput): Promise<{
    venue: VenueRow;
    savedAt: string;
    beerCount: number;
    mapPriceRecordCount: number;
    inventoryBeerCount: number;
    captureSaved: boolean;
    captureWarning: string | null;
  }> {
    const supabase = this.getSupabase();
    const venue = await this.getVenueById(input.venueId);
    const savedAt = new Date().toISOString();
    const beers = this.standardizeAdminBeerInputs(input.beers, input.source, savedAt);
    let latest: ExistingVenueMenuCaptureSnapshot | null = null;
    const warnings: string[] = [];

    try {
      latest = await this.getLatestVenueMenuCapture(input.venueId);
    } catch (error) {
      const message = getExternalErrorMessage(error);
      warnings.push("Previous menu capture snapshot unavailable; published live venue data without merging capture history.");
      logger.warn("Skipping manual capture merge snapshot", {
        venueId: input.venueId,
        error: message,
      });
    }

    const row = buildManualVenueCaptureRow({
      venue,
      latestCapture: latest,
      beers,
      source: input.source,
      note: input.note,
      savedAt,
    });

    let captureSaved = false;
    try {
      const { error } = await supabase.from(this.menuCaptureTable).insert(row);

      if (error) {
        const message = getExternalErrorMessage(error);
        warnings.push("Menu capture history save unavailable; live venue data was still published.");
        logger.warn("Skipping manual capture history save", {
          venueId: input.venueId,
          error: message,
        });
      } else {
        captureSaved = true;
      }
    } catch (error) {
      const message = getExternalErrorMessage(error);
      warnings.push("Menu capture history save unavailable; live venue data was still published.");
      logger.warn("Skipping manual capture history save", {
        venueId: input.venueId,
        error: message,
      });
    }

    let mapPriceRecordCount = 0;
    let inventoryBeerCount = 0;
    if (this.priceRecordDatabase) {
      const publishLocalState = this.priceRecordDatabase.transaction(() => {
        const mapRows = this.publishManualCapturePriceRecords({
          venue,
          savedAt,
          beers,
          source: input.source,
        });
        const inventoryRows = this.syncVenueBeerInventory({
          venue,
          savedAt,
          beers,
          source: input.source,
        });

        return { mapRows, inventoryRows };
      });
      const localState = publishLocalState();
      mapPriceRecordCount = localState.mapRows;
      inventoryBeerCount = localState.inventoryRows;
    }

    logger.info("Saved manual beer capture", {
      venueId: venue.id,
      venueName: venue.name,
      source: input.source,
      beerCount: beers.length,
      mapPriceRecordCount,
      inventoryBeerCount,
    });

    return {
      venue,
      savedAt,
      beerCount: beers.length,
      mapPriceRecordCount,
      inventoryBeerCount,
      captureSaved,
      captureWarning: warnings.join(" ") || null,
    };
  }

  private async persistSourceIngestionCaptureSnapshot(input: {
    venueId: string;
    note: string | null;
    beers: AdminBeerInput[];
    savedAt: string;
  }): Promise<{
    venue: VenueRow;
    captureSaved: boolean;
    captureWarning: string | null;
  }> {
    const supabase = this.getSupabase();
    const venue = await this.getVenueById(input.venueId);
    let latest: ExistingVenueMenuCaptureSnapshot | null = null;
    const warnings: string[] = [];

    try {
      latest = await this.getLatestVenueMenuCapture(input.venueId);
    } catch (error) {
      const message = getExternalErrorMessage(error);
      warnings.push("Previous menu capture snapshot unavailable; published live map rows without merging capture history.");
      logger.warn("Skipping source ingestion capture merge snapshot", {
        venueId: input.venueId,
        error: message,
      });
    }

    const row = buildManualVenueCaptureRow({
      venue,
      latestCapture: latest,
      beers: input.beers,
      source: "source_ingestion",
      note: input.note,
      savedAt: input.savedAt,
    });

    try {
      const { error } = await supabase.from(this.menuCaptureTable).insert(row);

      if (error) {
        const message = getExternalErrorMessage(error);
        warnings.push("Menu capture history save unavailable; live map rows were still published.");
        logger.warn("Skipping source ingestion capture history save", {
          venueId: input.venueId,
          error: message,
        });

        return {
          venue,
          captureSaved: false,
          captureWarning: warnings.join(" "),
        };
      }
    } catch (error) {
      const message = getExternalErrorMessage(error);
      warnings.push("Menu capture history save unavailable; live map rows were still published.");
      logger.warn("Skipping source ingestion capture history save", {
        venueId: input.venueId,
        error: message,
      });

      return {
        venue,
        captureSaved: false,
        captureWarning: warnings.join(" "),
      };
    }

    logger.info("Saved source ingestion capture history", {
      venueId: venue.id,
      venueName: venue.name,
      beerCount: input.beers.length,
    });

    return {
      venue,
      captureSaved: true,
      captureWarning: warnings.join(" ") || null,
    };
  }

  private publishIngestionPriceRecords(input: {
    ingestionId: string;
    venue: VenueRow;
    savedAt: string;
    beers: AdminBeerInput[];
  }): number {
    if (!this.priceRecordDatabase) {
      return 0;
    }

    const now = input.savedAt;
    const upsertPriceRecord = this.priceRecordDatabase.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (
        @id, @venueId, @venueName, @suburb, @beerName, @normalizedBeerId, @servingSize,
        @price, 0, NULL, @isOnTap, 'photo_verified',
        'source_ingestion', NULL, @lastVerifiedAt, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        venue_name = excluded.venue_name,
        suburb = excluded.suburb,
        beer_name = excluded.beer_name,
        normalized_beer_id = excluded.normalized_beer_id,
        serving_size = excluded.serving_size,
        price = excluded.price,
        is_on_tap = excluded.is_on_tap,
        confidence = excluded.confidence,
        source_type = excluded.source_type,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at`,
    );

    const publish = this.priceRecordDatabase.transaction(() => {
      let published = 0;
      input.beers.forEach((beer, index) => {
        if (!Number.isFinite(beer.priceNumeric ?? Number.NaN) || beer.priceNumeric == null) {
          return;
        }

        const resolvedBeer = this.resolveSystemBeer({
          name: beer.name,
          source: "source_ingestion_price_record",
          now,
        });
        const isOnTap = beer.availableOnTap === true
          ? "yes"
          : beer.availableOnTap === false || beer.availabilityStatus === "unavailable"
            ? "no"
            : "unknown";

        upsertPriceRecord.run({
          id: `source-ingestion:${input.ingestionId}:${index}`,
          venueId: input.venue.id,
          venueName: input.venue.name,
          suburb: input.venue.suburb,
          beerName: resolvedBeer.name,
          normalizedBeerId: resolvedBeer.key,
          servingSize: beer.servingSize,
          price: beer.priceNumeric,
          isOnTap,
          lastVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        published += 1;
      });

      return published;
    });

    return publish();
  }

  private publishManualCapturePriceRecords(input: {
    venue: VenueRow;
    savedAt: string;
    beers: AdminBeerInput[];
    source: AdminManualCaptureInput["source"];
  }): number {
    if (!this.priceRecordDatabase) {
      return 0;
    }

    const now = input.savedAt;
    const sourceType = input.source;
    const confidence = input.source === "menu_photo_ocr" ? "photo_verified" : "venue_confirmed";
    const upsertPriceRecord = this.priceRecordDatabase.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (
        @id, @venueId, @venueName, @suburb, @beerName, @normalizedBeerId, @servingSize,
        @price, 0, NULL, @isOnTap, @confidence,
        @sourceType, NULL, @lastVerifiedAt, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        venue_name = excluded.venue_name,
        suburb = excluded.suburb,
        beer_name = excluded.beer_name,
        normalized_beer_id = excluded.normalized_beer_id,
        serving_size = excluded.serving_size,
        price = excluded.price,
        is_on_tap = excluded.is_on_tap,
        confidence = excluded.confidence,
        source_type = excluded.source_type,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at`,
    );

    let published = 0;
    input.beers.forEach((beer) => {
      if (!Number.isFinite(beer.priceNumeric ?? Number.NaN) || beer.priceNumeric == null) {
        return;
      }

      const resolvedBeer = this.resolveSystemBeer({
        name: beer.name,
        source: "admin_manual_capture_price_record",
        now,
      });
      const isOnTap = beer.availableOnTap === true
        ? "yes"
        : beer.availableOnTap === false || beer.availabilityStatus === "unavailable"
          ? "no"
          : "unknown";
      const beerSegment = toRecordIdSegment(resolvedBeer.key || resolvedBeer.name);

      upsertPriceRecord.run({
        id: `admin-capture:${input.venue.id}:${beerSegment}:${beer.servingSize}`,
        venueId: input.venue.id,
        venueName: input.venue.name,
        suburb: input.venue.suburb,
        beerName: resolvedBeer.name,
        normalizedBeerId: resolvedBeer.key,
        servingSize: beer.servingSize,
        price: beer.priceNumeric,
        isOnTap,
        confidence,
        sourceType,
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      published += 1;
    });

    return published;
  }

  private upsertVenueProfileForAdminVenue(venue: VenueRow, now: string): void {
    if (!this.priceRecordDatabase) {
      return;
    }

    this.priceRecordDatabase
      .prepare(
        `INSERT INTO venue_profiles (
          venue_id, name, address, suburb, area, phone, website, opening_hours_json, venue_tags_json, created_at, updated_at
        ) VALUES (
          @venueId, @name, @address, @suburb, @area, @phone, @website, '{}', '[]', @createdAt, @updatedAt
        )
        ON CONFLICT(venue_id) DO UPDATE SET
          name = excluded.name,
          address = COALESCE(excluded.address, venue_profiles.address),
          suburb = COALESCE(excluded.suburb, venue_profiles.suburb),
          area = COALESCE(venue_profiles.area, excluded.area),
          phone = COALESCE(excluded.phone, venue_profiles.phone),
          website = COALESCE(excluded.website, venue_profiles.website),
          active = 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        venueId: venue.id,
        name: venue.name,
        address: venue.address,
        suburb: venue.suburb,
        area: venue.suburb,
        phone: venue.phone,
        website: venue.website,
        createdAt: now,
        updatedAt: now,
      });
  }

  private syncVenueBeerInventory(input: {
    venue: VenueRow;
    savedAt: string;
    beers: AdminBeerInput[];
    source: AdminManualCaptureInput["source"] | "source_ingestion";
  }): number {
    if (!this.priceRecordDatabase) {
      return 0;
    }

    this.upsertVenueProfileForAdminVenue(input.venue, input.savedAt);
    const upsertVenueBeer = this.priceRecordDatabase.prepare(
      `INSERT INTO venue_beers (
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size,
        price, currency, on_tap, in_stock, notes, created_at, updated_at
      ) VALUES (
        @id, @venueId, @beerName, @normalizedBeerId, @brewery, @style, @abv, @serveSize,
        @price, 'AUD', @onTap, @inStock, @notes, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        beer_name = excluded.beer_name,
        normalized_beer_id = excluded.normalized_beer_id,
        brewery = excluded.brewery,
        style = excluded.style,
        abv = excluded.abv,
        serve_size = excluded.serve_size,
        price = excluded.price,
        on_tap = excluded.on_tap,
        in_stock = excluded.in_stock,
        notes = excluded.notes,
        updated_at = excluded.updated_at
      WHERE venue_beers.venue_id = excluded.venue_id`,
    );

    let synced = 0;
    input.beers.forEach((beer) => {
      const name = beer.name.trim();
      if (!name) {
        return;
      }

      const resolvedBeer = this.resolveSystemBeer({
        name,
        source: "admin_reviewed_venue_inventory",
        now: input.savedAt,
      });
      const beerSegment = toRecordIdSegment(resolvedBeer.key || resolvedBeer.name);
      const onTap = beer.availableOnTap === true || beer.availabilityStatus === "on_tap";
      const inStock = beer.availabilityStatus !== "unavailable";
      const notes = [
        input.source === "source_ingestion"
          ? "Published from admin source review."
          : input.source === "menu_photo_ocr"
            ? "Published from admin menu OCR."
            : "Published from admin manual capture.",
        beer.needsReview ? "Beer catalog review may still be needed." : null,
      ].filter(Boolean).join(" ");

      upsertVenueBeer.run({
        id: `admin-reviewed:${input.venue.id}:${beerSegment}:${beer.servingSize}`,
        venueId: input.venue.id,
        beerName: resolvedBeer.name,
        normalizedBeerId: resolvedBeer.key,
        brewery: resolvedBeer.brewery,
        style: resolvedBeer.style,
        abv: resolvedBeer.abv,
        serveSize: beer.servingSize,
        price: beer.priceNumeric,
        onTap: onTap ? 1 : 0,
        inStock: inStock ? 1 : 0,
        notes,
        createdAt: input.savedAt,
        updatedAt: input.savedAt,
      });
      synced += 1;
    });

    return synced;
  }

  private countPublishableMapPriceRows(beers: AdminBeerInput[]): number {
    return beers.filter((beer) => Number.isFinite(beer.priceNumeric ?? Number.NaN) && beer.priceNumeric != null).length;
  }

  private async fetchImageDataUrlFromSourceUrl(sourceUrl: string): Promise<string> {
    let url: URL;

    try {
      url = new URL(sourceUrl);
    } catch {
      throw new AppError("Source URL must be a valid HTTP or HTTPS URL.", 400);
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new AppError("Source URL must be a valid HTTP or HTTPS URL.", 400);
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "pint-path-source-ingestion/1.0",
      },
    });

    if (!response.ok) {
      throw new ExternalServiceError(`Failed to fetch source image (${response.status})`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new AppError("For now, source URLs must point directly to an image.", 400);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return `data:${contentType};base64,${base64}`;
  }

  private async requestMenuPhotoOcrModel(
    input: MenuPhotoOcrInput,
    prompt: string,
  ): Promise<MenuPhotoOcrModelResponse> {
    if (!this.openai) {
      throw new AppError("Menu OCR is not configured. Set OPENAI_API_KEY on the server.", 503);
    }

    let response: Awaited<ReturnType<OpenAI["responses"]["create"]>>;
    try {
      response = await this.openai.responses.create({
        model: MENU_PHOTO_OCR_MODEL,
        temperature: 0,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
              {
                type: "input_image",
                image_url: input.imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
      });
    } catch (error) {
      const details = getOcrProviderErrorDetails(error);
      logger.warn("Menu OCR provider request failed", details);
      throw new ExternalServiceError(
        "Menu OCR provider failed. Try a clearer or smaller photo, or enter the beer rows manually.",
        details,
      );
    }

    if (!response.output_text || response.output_text.trim().length === 0) {
      throw new ExternalServiceError("Menu OCR returned an empty response");
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = parseJsonResponse(response.output_text);
    } catch (error) {
      throw new ExternalServiceError("Menu OCR returned unreadable output. Try again or enter the beer rows manually.", {
        message: error instanceof Error ? redactSecrets(error.message) : "Invalid JSON response",
      });
    }

    return normalizeOcrResponse(parsedPayload);
  }

  private async reviewMenuPhotoOcrExtraction(
    input: MenuPhotoOcrInput,
    firstPass: MenuPhotoOcrModelResponse,
  ): Promise<MenuPhotoOcrModelResponse> {
    if (!MENU_PHOTO_OCR_REVIEW_PASS_ENABLED) {
      return firstPass;
    }

    const prompt = [
      "You are doing a second-pass quality check on beer menu OCR for Pint Path.",
      "Compare the proposed JSON extraction against the image itself. Return corrected JSON only, using the same schema.",
      "Be stricter than the first pass. If a proposed row is not clearly visible in the image as beer, cider, or RTD, remove it.",
      "Remove spirits, gin, whisky, vodka, cocktails, wine, food, steak, welcome copy, category descriptions, promos, happy-hour/event prices, and venue marketing copy.",
      "Correct any row where the first pass used ABV, millilitres, package size, year, count, pot price, or schooner price as the pint price.",
      "For Australian tap rows with pot/schooner/pint slash prices, choose the pint price: the third price for three values, the second/rightmost price for two values.",
      "For labelled prices, only use the value labelled PINT as price_numeric and price_text.",
      "If a beer/cider/RTD row is clearly readable in the image and missing from the proposed JSON, add it.",
      "If a name, price, or availability cannot be verified from the image, remove the row instead of guessing.",
      "Set confidence below 0.8 for corrected rows, below 0.65 for layout-ambiguous rows, and below 0.5 only when the row should normally be omitted.",
      "Keep notes concise and include ABV/brewery text only when visible.",
      "Schema:",
      "{",
      '  "venue_name_guess": string | null,',
      '  "captured_notes": string | null,',
      '  "overall_confidence": number | null,',
      '  "beers": [',
      "    {",
      '      "name": string,',
      '      "price_numeric": number | null,',
      '      "price_text": string | null,',
      '      "availability_status": "on_tap" | "package_only" | "unavailable" | "unknown",',
      '      "available_on_tap": boolean | null,',
      '      "available_package_only": boolean,',
      '      "unavailable_reason": "cans_only" | "bottles_only" | "cans_or_bottles" | "no_pints" | "not_on_tap" | "not_stocked" | "unknown" | null,',
      '      "notes": string | null,',
      '      "confidence": number | null',
      "    }",
      "  ]",
      "}",
      `Canonical tracked beer names to prefer when clearly matched: ${this.getTrackedBeerNamesForOcrPrompt()}.`,
      input.venueNameHint ? `Venue hint: ${input.venueNameHint}` : "Venue hint: none",
      `Proposed first-pass extraction JSON: ${JSON.stringify(firstPass)}`,
    ].join("\n");

    try {
      const reviewed = await this.requestMenuPhotoOcrModel(input, prompt);
      return {
        ...reviewed,
        venue_name_guess: reviewed.venue_name_guess ?? firstPass.venue_name_guess,
        captured_notes: reviewed.captured_notes ?? firstPass.captured_notes,
        overall_confidence: reviewed.overall_confidence ?? firstPass.overall_confidence,
      };
    } catch (error) {
      logger.warn("Menu OCR review pass failed; using first pass extraction", {
        error: getExternalErrorMessage(error),
      });
      return firstPass;
    }
  }

  private async extractMenuPhoto(input: MenuPhotoOcrInput): Promise<NormalizedOcrExtraction> {
    const prompt = [
      "Extract useful beer menu information from this pub or bar menu photo.",
      "Return JSON only.",
      "Schema:",
      "{",
      '  "venue_name_guess": string | null,',
      '  "captured_notes": string | null,',
      '  "overall_confidence": number | null,',
      '  "beers": [',
      "    {",
      '      "name": string,',
      '      "price_numeric": number | null,',
      '      "price_text": string | null,',
      '      "availability_status": "on_tap" | "package_only" | "unavailable" | "unknown",',
      '      "available_on_tap": boolean | null,',
      '      "available_package_only": boolean,',
      '      "unavailable_reason": "cans_only" | "bottles_only" | "cans_or_bottles" | "no_pints" | "not_on_tap" | "not_stocked" | "unknown" | null,',
      '      "notes": string | null,',
      '      "confidence": number | null',
      "    }",
      "  ]",
      "}",
      "Read the whole image first, including all columns and lower sections, before returning JSON. Do not stop after the first readable row.",
      "Only include beer, cider, and RTD products that appear under beer/cider/RTD/on tap/tins/cans/bottles sections and are useful for a regular pub beer map.",
      "Do not include gin, vodka, whisky, bourbon, tequila, cocktails, wine, food, steak, venue welcome copy, promo copy, category descriptions, or event text as beer rows.",
      `If a beer clearly matches one of these tracked beers, use the exact canonical name: ${this.getTrackedBeerNamesForOcrPrompt()}.`,
      "Use confidence values from 0 to 1 based on how readable and reliable each beer item looks.",
      "If a beer has a visible price, put the numeric value in price_numeric and preserve the menu wording in price_text.",
      "Never use package volume, serving size, ABV, years, counts, or measurements such as 330ml, 335ml, 355ml, 375ml, 440ml, 500ml, 4.2%, 2025, 4 pack, grams, or litres as price_numeric.",
      "If a package row only shows size and ABV, with no actual price or currency, omit the row instead of inventing a price from the size.",
      "When a row shows labelled prices such as $8.5 POT, $17 PINT, choose the PINT price for price_numeric and price_text.",
      "When a table heading says Pots / Pints / Jugs, choose the Pints price as price_numeric and price_text.",
      "When a tap section says pot, schooner and pint are available and a beer row shows three slash-separated prices such as $6 / $9 / $12, choose the third/rightmost price as the pint price. For two slash-separated tap prices such as 9/16.5, choose the second/rightmost price.",
      "When an Australian tap menu uses metric columns such as 285ml, 425ml, and 570ml, treat the 570ml column as the pint-equivalent price for price_numeric and price_text.",
      "When a beer name wraps over two lines, combine the wrapped name into one name before pairing it with the price on that row.",
      "Keep each menu row separate. Do not carry a beer name, price, or ABV from the previous row into the next row.",
      "Many PDF menus put the beer name and price on one line, then brewery, location, and ABV on the next line. Pair that following detail line with the beer above it in notes; do not emit the detail line as its own beer.",
      "When a section heading says ON TAP, mark every readable beer row under that heading as availability_status 'on_tap' until the next major section heading, even if the row only shows prices like 9/16.5, 7.5/14, or /16.",
      "When a section heading says TINS & BOTTLES, TINS, TINNIES, BOTTLES & CANS, CANS OR BOTTLES, CANS, BOTTLES, or PACKAGED, mark rows under that heading as availability_status 'package_only'. In Australian menus, tins means cans.",
      "If an ABV percentage is printed beside a beer, include it in notes with the brewery/source wording.",
      "Do not include category headings such as Lager, IPA, Sour Beer, Red Wine, or White Wine as beer rows.",
      "If the row price/name pairing is ambiguous after checking the row, heading, and nearby detail line, omit the row instead of guessing.",
      "If tap or package format is not clear, use availability_status 'unknown'.",
      input.venueNameHint ? `Venue hint: ${input.venueNameHint}` : "Venue hint: none",
    ].join("\n");

    const firstPass = await this.requestMenuPhotoOcrModel(input, prompt);
    const parsed = await this.reviewMenuPhotoOcrExtraction(input, firstPass);
    const rawBeers = parsed.beers.filter((beer) => isLikelyBeerName(beer.name)).map((beer) => {
      const normalizedPrice = normalizedOcrBeerPrice(beer);
      const normalized = buildManualBeerEntry({
        name: beer.name,
        servingSize: "pint",
        priceNumeric: normalizedPrice.priceNumeric,
        priceText: normalizedPrice.priceText,
        availabilityStatus: beer.availability_status,
        availableOnTap: beer.available_on_tap,
        availablePackageOnly: beer.available_package_only,
        unavailableReason: beer.unavailable_reason,
        needsReview: needsReviewFromConfidence({
          confidence: beer.confidence,
          availabilityStatus: beer.availability_status,
          priceNumeric: normalizedPrice.priceNumeric,
        }),
      });

      return {
        name: normalized.label,
        servingSize: "pint",
        priceNumeric: normalized.price_numeric,
        priceText: normalized.price_text,
        availabilityStatus: normalized.availability_status,
        availableOnTap: normalized.available_on_tap,
        availablePackageOnly: normalized.available_package_only,
        unavailableReason: normalized.unavailable_reason,
        confidence: normalizeConfidence(beer.confidence, parsed.overall_confidence ?? 0.7) ?? 0.7,
        needsReview: normalized.needs_review,
        notes: beer.notes,
      } satisfies AdminIngestionBeerRecord;
    });
    const beers = this.standardizeIngestionBeerRecords(
      rawBeers,
      "menu_photo_ocr_preview",
      new Date().toISOString(),
      false,
    );

    return {
      venueNameGuess: parsed.venue_name_guess,
      capturedNotes: parsed.captured_notes,
      overallConfidence: normalizeConfidence(
        parsed.overall_confidence,
        beers.length > 0
          ? beers.reduce((sum, beer) => sum + beer.confidence, 0) / beers.length
          : null,
      ),
      beers,
    };
  }

  async createVenue(input: AdminVenueInput): Promise<VenueRow> {
    const supabase = this.getSupabase();
    if (input.googlePlaceId) {
      const { data: existing, error: existingError } = await supabase
        .from("venues")
        .select("id, name, address, suburb, state, postcode, phone, website, latitude, longitude")
        .eq("google_place_id", input.googlePlaceId)
        .maybeSingle();

      if (existingError) {
        logger.warn("Failed to check existing venue before Google place insert", {
          error: redactSecrets(existingError.message),
        });
      } else if (existing) {
        return existing as VenueRow;
      }
    }

    const payload = {
      google_place_id: input.googlePlaceId,
      name: input.name.trim(),
      address: input.address.trim(),
      suburb: input.suburb,
      state: input.state ?? "VIC",
      postcode: input.postcode,
      phone: input.phone,
      website: input.website,
      latitude: input.latitude,
      longitude: input.longitude,
      source: input.googlePlaceId ? "google_places_admin" : "manual_admin",
    };

    const { data, error } = await supabase
      .from("venues")
      .insert(payload)
      .select("id, name, address, suburb, state, postcode, phone, website, latitude, longitude")
      .single();

    if (error || !data) {
      throw new ExternalServiceError("Failed to create venue", {
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
        code: error?.code,
      });
    }

    logger.info("Created manual venue", {
      venueId: data.id,
      venueName: data.name,
    });

    return data as VenueRow;
  }

  async saveManualCapture(input: AdminManualCaptureInput): Promise<{
    venue: VenueRow;
    savedAt: string;
    beerCount: number;
  }> {
    return this.persistManualCapture(input);
  }

  async ocrMenuPhoto(input: AdminMenuPhotoOcrInput): Promise<{
    venueNameGuess: string | null;
    capturedNotes: string | null;
    overallConfidence: number | null;
    beers: Array<AdminBeerInput & { confidence: number }>;
  }> {
    const extracted = await this.extractMenuPhoto(input);

    return {
      venueNameGuess: extracted.venueNameGuess,
      capturedNotes: extracted.capturedNotes,
      overallConfidence: extracted.overallConfidence,
      beers: extracted.beers.map((beer) => ({
        ...toAdminBeerInput(beer),
        confidence: beer.confidence,
      })),
    };
  }

  async queueSourceIngestion(input: AdminSourceIngestionQueueInput): Promise<AdminIngestionQueueRecord> {
    const repository = this.getIngestionQueue();
    const venue = await this.getVenueById(input.venueId);
    const imageDataUrl =
      input.imageDataUrl ??
      (input.sourceUrl ? await this.fetchImageDataUrlFromSourceUrl(input.sourceUrl) : null);

    if (!imageDataUrl) {
      throw new AppError("Provide an image upload or a direct image URL to queue OCR.", 400);
    }

    const extracted = await this.extractMenuPhoto({
      venueNameHint: venue.name,
      imageDataUrl,
    });
    const extractedBeers = this.standardizeIngestionBeerRecords(
      extracted.beers,
      "source_ingestion_crawler",
      new Date().toISOString(),
    );

    const queueItem = repository.create({
      venueId: venue.id,
      venueName: venue.name,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      imageDataUrl,
      note: input.note,
      status: "pending_review",
      venueNameGuess: extracted.venueNameGuess,
      capturedNotes: extracted.capturedNotes,
      overallConfidence: extracted.overallConfidence,
      extractedBeers,
      errorMessage: null,
    });

    logger.info("Queued source ingestion item", {
      ingestionId: queueItem.id,
      venueId: venue.id,
      venueName: venue.name,
      beerCount: queueItem.extractedBeers.length,
    });

    return queueItem;
  }

  listQueuedIngestions(status?: AdminIngestionStatus, limit = 50, offset = 0): AdminIngestionQueueRecord[] {
    return this.getIngestionQueue().list(status, limit, offset);
  }

  countQueuedIngestions(status?: AdminIngestionStatus): number {
    return this.getIngestionQueue().count(status);
  }

  async publishQueuedIngestion(
    ingestionId: string,
    input: AdminPublishQueuedIngestionInput,
  ): Promise<{
    queueItem: AdminIngestionQueueRecord;
    venue: VenueRow;
    savedAt: string;
    beerCount: number;
    mapPriceRecordCount: number;
    inventoryBeerCount: number;
    captureSaved: boolean;
    captureWarning: string | null;
  }> {
    const repository = this.getIngestionQueue();
    const queueItem = repository.getById(ingestionId);

    if (!queueItem) {
      throw new AppError("Source ingestion item was not found.", 404);
    }

    if (queueItem.status !== "pending_review") {
      throw new AppError("This source ingestion item is no longer pending review.", 409);
    }

    const reviewedBeers = this.standardizeAdminBeerInputs(
      input.beers,
      "source_ingestion_review",
      new Date().toISOString(),
    );
    const expectedPriceRecordCount = this.countPublishableMapPriceRows(reviewedBeers);
    if (expectedPriceRecordCount > 0 && !this.priceRecordDatabase) {
      throw new AppError("Live map price database is unavailable, so this source cannot be published yet.", 503);
    }
    const noteParts = [
      queueItem.note,
      queueItem.capturedNotes,
      queueItem.sourceUrl ? `Source: ${queueItem.sourceUrl}` : null,
      input.note,
    ].filter(Boolean);
    const savedAt = new Date().toISOString();
    const captureResult = await this.persistSourceIngestionCaptureSnapshot({
      venueId: queueItem.venueId,
      note: noteParts.length > 0 ? noteParts.join("\n") : null,
      beers: reviewedBeers,
      savedAt,
    });
    const crawlerFeedback = buildCrawlerFeedback({
      outcome: "published",
      extractedBeers: queueItem.extractedBeers,
      reviewBeers: reviewedBeers,
      note: input.note,
      generatedAt: savedAt,
    });
    let priceRecordCount = 0;
    let inventoryBeerCount = 0;

    if (this.priceRecordDatabase) {
      const publishLocalState = this.priceRecordDatabase.transaction(() => {
        const published = this.publishIngestionPriceRecords({
          ingestionId,
          venue: captureResult.venue,
          savedAt,
          beers: reviewedBeers,
        });

        if (published !== expectedPriceRecordCount) {
          throw new AppError(
            `Source review publish wrote ${published} of ${expectedPriceRecordCount} expected live map price row${expectedPriceRecordCount === 1 ? "" : "s"}.`,
            500,
          );
        }

        const syncedInventory = this.syncVenueBeerInventory({
          venue: captureResult.venue,
          savedAt,
          beers: reviewedBeers,
          source: "source_ingestion",
        });

        repository.markPublished(
          ingestionId,
          reviewedBeers.map((beer) => ({
            ...beer,
            confidence: 1,
            notes: null,
          })),
          input.note,
          crawlerFeedback,
          savedAt,
        );

        return { published, syncedInventory };
      });

      const localState = publishLocalState();
      priceRecordCount = localState.published;
      inventoryBeerCount = localState.syncedInventory;
    } else {
      repository.markPublished(
        ingestionId,
        reviewedBeers.map((beer) => ({
          ...beer,
          confidence: 1,
          notes: null,
        })),
        input.note,
        crawlerFeedback,
        savedAt,
      );
    }

    return {
      queueItem: repository.getById(ingestionId)!,
      venue: captureResult.venue,
      savedAt,
      beerCount: reviewedBeers.length,
      mapPriceRecordCount: priceRecordCount,
      inventoryBeerCount,
      captureSaved: captureResult.captureSaved,
      captureWarning: captureResult.captureWarning,
    };
  }

  rejectQueuedIngestion(ingestionId: string, input: AdminRejectQueuedIngestionInput): { queueItem: AdminIngestionQueueRecord } {
    const repository = this.getIngestionQueue();
    const queueItem = repository.getById(ingestionId);

    if (!queueItem) {
      throw new AppError("Source ingestion item was not found.", 404);
    }

    if (queueItem.status !== "pending_review") {
      throw new AppError("This source ingestion item is no longer pending review.", 409);
    }

    const rejectedAt = new Date().toISOString();
    const crawlerFeedback = buildCrawlerFeedback({
      outcome: "rejected",
      extractedBeers: queueItem.extractedBeers,
      note: input.note,
      generatedAt: rejectedAt,
    });

    repository.markRejected(ingestionId, input.note, crawlerFeedback, rejectedAt);
    return {
      queueItem: repository.getById(ingestionId)!,
    };
  }

  rejectQueuedIngestions(input: AdminBulkRejectQueuedIngestionsInput): {
    queueItems: AdminIngestionQueueRecord[];
    rejectedCount: number;
  } {
    const queueItems = input.ids.map((id) => this.rejectQueuedIngestion(id, { note: input.note }).queueItem);

    return {
      queueItems,
      rejectedCount: queueItems.length,
    };
  }
}
