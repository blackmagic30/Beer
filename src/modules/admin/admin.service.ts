import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

import type {
  AdminBeerInput,
  AdminManualCaptureInput,
  AdminMenuPhotoOcrInput,
  AdminVenueInput,
} from "./admin.schemas.js";
import {
  buildManualCallResultRow,
  buildManualBeerEntry,
  type AdminVenueSnapshot,
  type ExistingCallResultSnapshot,
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

interface CallResultsRow {
  raw: Record<string, unknown> | null;
  cleaned: Record<string, unknown> | null;
}

interface MenuPhotoOcrModelItem {
  name: string;
  price_numeric: number | null;
  price_text: string | null;
  availability_status: "on_tap" | "package_only" | "unavailable" | "unknown";
  available_on_tap: boolean | null;
  available_package_only: boolean;
  unavailable_reason: "cans_only" | "bottles_only" | "not_on_tap" | "not_stocked" | "unknown" | null;
  notes: string | null;
}

interface MenuPhotoOcrModelResponse {
  venue_name_guess: string | null;
  captured_notes: string | null;
  beers: MenuPhotoOcrModelItem[];
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

function normalizeOcrResponse(value: unknown): MenuPhotoOcrModelResponse {
  if (!isRecord(value)) {
    throw new AppError("Menu OCR returned an invalid payload", 502);
  }

  const beers = Array.isArray(value.beers)
    ? value.beers.filter(isRecord).map((beer) => ({
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
          ["cans_only", "bottles_only", "not_on_tap", "not_stocked", "unknown"].includes(beer.unavailable_reason)
            ? (beer.unavailable_reason as MenuPhotoOcrModelItem["unavailable_reason"])
            : null,
        notes: typeof beer.notes === "string" ? beer.notes.trim() : null,
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
    beers,
  };
}

export class AdminService {
  private readonly supabase?: SupabaseClient;
  private readonly openai?: OpenAI;

  constructor(
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

  async ocrMenuPhoto(input: AdminMenuPhotoOcrInput): Promise<{
    venueNameGuess: string | null;
    capturedNotes: string | null;
    beers: AdminBeerInput[];
  }> {
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
      '  "beers": [',
      "    {",
      '      "name": string,',
      '      "price_numeric": number | null,',
      '      "price_text": string | null,',
      '      "availability_status": "on_tap" | "package_only" | "unavailable" | "unknown",',
      '      "available_on_tap": boolean | null,',
      '      "available_package_only": boolean,',
      '      "unavailable_reason": "cans_only" | "bottles_only" | "not_on_tap" | "not_stocked" | "unknown" | null,',
      '      "notes": string | null',
      "    }",
      "  ]",
      "}",
      "Only include beer products that appear readable and useful for a pub beer map.",
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
        priceNumeric: beer.price_numeric,
        priceText: beer.price_text,
        availabilityStatus: beer.availability_status,
        availableOnTap: beer.available_on_tap,
        availablePackageOnly: beer.available_package_only,
        unavailableReason: beer.unavailable_reason,
        needsReview: false,
      });

      return {
        name: normalized.label,
        priceNumeric: normalized.price_numeric,
        priceText: normalized.price_text,
        availabilityStatus: normalized.availability_status,
        availableOnTap: normalized.available_on_tap,
        availablePackageOnly: normalized.available_package_only,
        unavailableReason: normalized.unavailable_reason,
        needsReview: false,
      } satisfies AdminBeerInput;
    });

    return {
      venueNameGuess: parsed.venue_name_guess,
      capturedNotes: parsed.captured_notes,
      beers,
    };
  }
}
