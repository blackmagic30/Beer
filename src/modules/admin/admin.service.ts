import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AdminIngestionQueueRepository } from "../../db/admin-ingestion-queue.repository.js";
import type {
  AdminIngestionBeerRecord,
  AdminIngestionQueueRecord,
  AdminIngestionStatus,
} from "../../db/models.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

import type {
  AdminBeerInput,
  AdminManualCaptureInput,
  AdminMenuPhotoOcrInput,
  AdminPublishQueuedIngestionInput,
  AdminRejectQueuedIngestionInput,
  AdminSourceIngestionQueueInput,
  AdminVenueInput,
} from "./admin.schemas.js";
import {
  buildManualBeerEntry,
  buildManualCallResultRow,
  type AdminVenueSnapshot,
  type ExistingCallResultSnapshot,
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

interface MenuPhotoOcrModelItem {
  name: string;
  price_numeric: number | null;
  price_text: string | null;
  availability_status: "on_tap" | "package_only" | "unavailable" | "unknown";
  available_on_tap: boolean | null;
  available_package_only: boolean;
  unavailable_reason: "cans_only" | "bottles_only" | "no_pints" | "not_on_tap" | "not_stocked" | "unknown" | null;
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
            ["cans_only", "bottles_only", "no_pints", "not_on_tap", "not_stocked", "unknown"].includes(beer.unavailable_reason)
              ? (beer.unavailable_reason as MenuPhotoOcrModelItem["unavailable_reason"])
              : null,
          notes: typeof beer.notes === "string" ? beer.notes.trim() : null,
          confidence: normalizeConfidence(beer.confidence, null),
        }))
        .filter((beer) => beer.name.length > 0)
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

export class AdminService {
  private readonly supabase?: SupabaseClient;
  private readonly openai?: OpenAI;

  constructor(
    private readonly ingestionQueueRepository: AdminIngestionQueueRepository | undefined,
    supabaseUrl?: string,
    supabaseServiceRoleKey?: string,
    private readonly resultsTable = "call_results",
    private readonly adminSharedSecret?: string,
    openaiApiKey?: string,
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
  }

  getStatus() {
    return {
      enabled: Boolean(this.supabase && this.adminSharedSecret),
      ocrEnabled: Boolean(this.supabase && this.adminSharedSecret && this.openai),
      queueEnabled: Boolean(this.supabase && this.adminSharedSecret && this.ingestionQueueRepository),
    };
  }

  assertAuthorized(secret: string | undefined): void {
    if (!this.supabase || !this.adminSharedSecret) {
      throw new AppError("Admin tools are not configured on this deployment.", 503);
    }

    if (!secret || secret !== this.adminSharedSecret) {
      throw new AppError("Invalid admin secret.", 401);
    }
  }

  private getSupabase(): SupabaseClient {
    if (!this.supabase) {
      throw new AppError("Supabase admin client is not configured.", 503);
    }

    return this.supabase;
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

  private async getLatestCallResult(venueId: string): Promise<ExistingCallResultSnapshot | null> {
    const supabase = this.getSupabase();
    const { data, error } = await supabase
      .from(this.resultsTable)
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
    return row ? (row as ExistingCallResultSnapshot) : null;
  }

  private async persistManualCapture(input: AdminManualCaptureInput): Promise<{
    venue: VenueRow;
    savedAt: string;
    beerCount: number;
  }> {
    const supabase = this.getSupabase();
    const venue = await this.getVenueById(input.venueId);
    const latest = await this.getLatestCallResult(input.venueId);
    const savedAt = new Date().toISOString();

    const row = buildManualCallResultRow({
      venue,
      latestResult: latest,
      beers: input.beers,
      source: input.source,
      note: input.note,
      savedAt,
    });

    const { error } = await supabase.from(this.resultsTable).insert(row);

    if (error) {
      throw new ExternalServiceError("Failed to save manual venue capture", {
        venueId: input.venueId,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    logger.info("Saved manual beer capture", {
      venueId: venue.id,
      venueName: venue.name,
      source: input.source,
      beerCount: input.beers.length,
    });

    return {
      venue,
      savedAt,
      beerCount: input.beers.length,
    };
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
        "User-Agent": "melb-beer-bot-source-ingestion/1.0",
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

  private async extractMenuPhoto(
    input: AdminMenuPhotoOcrInput | { venueNameHint: string | null; imageDataUrl: string },
  ): Promise<NormalizedOcrExtraction> {
    if (!this.openai) {
      throw new AppError("Menu OCR is not configured. Set OPENAI_API_KEY on the server.", 503);
    }

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
      '      "unavailable_reason": "cans_only" | "bottles_only" | "no_pints" | "not_on_tap" | "not_stocked" | "unknown" | null,',
      '      "notes": string | null,',
      '      "confidence": number | null',
      "    }",
      "  ]",
      "}",
      "Only include beer products that appear readable and useful for a pub beer map.",
      "Use confidence values from 0 to 1 based on how readable and reliable each beer item looks.",
      "If a beer has a visible price, put the numeric value in price_numeric and preserve the menu wording in price_text.",
      "If tap or package format is not clear, use availability_status 'unknown'.",
      input.venueNameHint ? `Venue hint: ${input.venueNameHint}` : "Venue hint: none",
    ].join("\n");

    const response = await this.openai.responses.create({
      model: "gpt-4.1-mini",
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
              detail: "auto",
            },
          ],
        },
      ],
    });

    if (!response.output_text || response.output_text.trim().length === 0) {
      throw new ExternalServiceError("Menu OCR returned an empty response");
    }

    const parsed = normalizeOcrResponse(parseJsonResponse(response.output_text));
    const beers = parsed.beers.map((beer) => {
      const normalized = buildManualBeerEntry({
        name: beer.name,
        servingSize: "pint",
        priceNumeric: beer.price_numeric,
        priceText: beer.price_text,
        availabilityStatus: beer.availability_status,
        availableOnTap: beer.available_on_tap,
        availablePackageOnly: beer.available_package_only,
        unavailableReason: beer.unavailable_reason,
        needsReview: needsReviewFromConfidence({
          confidence: beer.confidence,
          availabilityStatus: beer.availability_status,
          priceNumeric: beer.price_numeric,
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
    const payload = {
      google_place_id: null,
      name: input.name.trim(),
      address: input.address.trim(),
      suburb: input.suburb,
      state: input.state ?? "VIC",
      postcode: input.postcode,
      phone: input.phone,
      website: input.website,
      latitude: input.latitude,
      longitude: input.longitude,
      source: "manual_admin",
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
      extractedBeers: extracted.beers,
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

  listQueuedIngestions(status?: AdminIngestionStatus, limit = 50): AdminIngestionQueueRecord[] {
    return this.getIngestionQueue().list(status, limit);
  }

  async publishQueuedIngestion(
    ingestionId: string,
    input: AdminPublishQueuedIngestionInput,
  ): Promise<{
    queueItem: AdminIngestionQueueRecord;
    venue: VenueRow;
    savedAt: string;
    beerCount: number;
  }> {
    const repository = this.getIngestionQueue();
    const queueItem = repository.getById(ingestionId);

    if (!queueItem) {
      throw new AppError("Source ingestion item was not found.", 404);
    }

    if (queueItem.status !== "pending_review") {
      throw new AppError("This source ingestion item is no longer pending review.", 409);
    }

    const noteParts = [
      queueItem.note,
      queueItem.capturedNotes,
      queueItem.sourceUrl ? `Source: ${queueItem.sourceUrl}` : null,
      input.note,
    ].filter(Boolean);
    const result = await this.persistManualCapture({
      venueId: queueItem.venueId,
      source: "source_ingestion",
      note: noteParts.length > 0 ? noteParts.join("\n") : null,
      beers: input.beers,
    });

    repository.markPublished(
      ingestionId,
      input.beers.map((beer) => ({
        ...beer,
        confidence: 1,
        notes: null,
      })),
      result.savedAt,
    );

    return {
      queueItem: repository.getById(ingestionId)!,
      venue: result.venue,
      savedAt: result.savedAt,
      beerCount: result.beerCount,
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

    repository.markRejected(ingestionId, input.note, new Date().toISOString());
    return {
      queueItem: repository.getById(ingestionId)!,
    };
  }
}
