import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  CallRunRecord,
  ParseStatus,
  PersistedBeerPriceResultInput,
  PersistedHappyHourInput,
} from "../db/models.js";
import { formatBeerAvailabilityLabel } from "./beer-availability.js";
import { ExternalServiceError } from "./errors.js";
import { logger } from "./logger.js";

const DEFAULT_RESULTS_TABLE = "call_results";

export interface SyncSupabaseCallResultInput {
  run: CallRunRecord;
  callSid: string;
  conversationId: string | null;
  resultTimestamp: string;
  savedAt: string;
  rawTranscript: string;
  parseConfidence: number;
  parseStatus: ParseStatus;
  needsReview: boolean;
  items: PersistedBeerPriceResultInput[];
  happyHour: PersistedHappyHourInput;
}

interface SupabaseCallResultRow {
  venue_id: string | null;
  venue_name: string;
  suburb: string;
  saved_at: string;
  raw: Record<string, unknown>;
  cleaned: Record<string, unknown>;
}

function toBeerKey(beerName: string): string {
  return beerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildSupabaseCallResultRow(
  input: SyncSupabaseCallResultInput,
): SupabaseCallResultRow {
  const beerEntries = Object.fromEntries(
    input.items.map((item) => {
      const key = toBeerKey(item.beerName);
      return [
        key,
        {
          label: item.beerName,
          price: item.priceNumeric,
          price_text: item.priceText,
          availability_status: item.availabilityStatus,
          available_on_tap: item.availableOnTap,
          available_package_only: item.availablePackageOnly,
          unavailable_reason: item.unavailableReason,
          availability: {
            status: item.availabilityStatus,
            on_tap: item.availableOnTap,
            package_only: item.availablePackageOnly,
            reason: item.unavailableReason,
            label: formatBeerAvailabilityLabel(item),
          },
          confidence: item.confidence,
          needs_review: item.needsReview,
        },
      ];
    }),
  );

  const happyHourNeedsReview = input.happyHour.happyHour
    ? input.happyHour.happyHourConfidence < 0.72 ||
      input.happyHour.happyHourPrice == null ||
      !input.happyHour.happyHourStart ||
      !input.happyHour.happyHourEnd
    : false;

  return {
    venue_id: input.run.venueId,
    venue_name: input.run.venueName,
    suburb: input.run.suburb,
    saved_at: input.savedAt,
    raw: {
      call_run_id: input.run.id,
      call_sid: input.callSid,
      conversation_id: input.conversationId,
      venue_id: input.run.venueId,
      venue_name: input.run.venueName,
      phone_number: input.run.phoneNumber,
      suburb: input.run.suburb,
      is_test: input.run.isTest,
      started_at: input.run.startedAt,
      ended_at: input.run.endedAt,
      duration_seconds: input.run.durationSeconds,
      timestamp: input.resultTimestamp,
      parse_confidence: input.parseConfidence,
      parse_status: input.parseStatus,
      needs_review: input.needsReview,
      raw_transcript: input.rawTranscript,
      beer_results: input.items,
      menu_capture: {
        source: "phone_agent",
        completeness: "single_beer_probe",
        known_items_count: input.items.length,
        crowdsource_full_menu_planned: true,
      },
      happy_hour: input.happyHour,
    },
    cleaned: {
      ...beerEntries,
      beers: beerEntries,
      menu_capture: {
        source: "phone_agent",
        completeness: "single_beer_probe",
        known_items_count: input.items.length,
        crowdsource_full_menu_planned: true,
      },
      menu_items: input.items.map((item) => ({
        label: item.beerName,
        category: "beer",
        price: item.priceNumeric,
        price_text: item.priceText,
        availability_status: item.availabilityStatus,
        available_on_tap: item.availableOnTap,
        available_package_only: item.availablePackageOnly,
        unavailable_reason: item.unavailableReason,
        availability_label: formatBeerAvailabilityLabel(item),
        confidence: item.confidence,
        needs_review: item.needsReview,
      })),
      happy_hour: {
        exists: input.happyHour.happyHour,
        days: input.happyHour.happyHourDays,
        start: input.happyHour.happyHourStart,
        end: input.happyHour.happyHourEnd,
        price: input.happyHour.happyHourPrice,
        confidence: input.happyHour.happyHourConfidence,
        needs_review: happyHourNeedsReview,
        days_times: [input.happyHour.happyHourDays, input.happyHour.happyHourStart, input.happyHour.happyHourEnd]
          .filter(Boolean)
          .join(" "),
      },
      parse_confidence: input.parseConfidence,
      parse_status: input.parseStatus,
      needs_review: input.needsReview,
    },
  };
}

export class SupabaseResultsSyncService {
  private readonly client?: SupabaseClient;

  constructor(
    supabaseUrl?: string,
    supabaseServiceRoleKey?: string,
    private readonly resultsTable = DEFAULT_RESULTS_TABLE,
  ) {
    if (supabaseUrl && supabaseServiceRoleKey) {
      this.client = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async saveCallResult(input: SyncSupabaseCallResultInput): Promise<void> {
    if (!this.client) {
      return;
    }

    const row = buildSupabaseCallResultRow(input);
    const { error } = await this.client.from(this.resultsTable).insert(row);

    if (error) {
      throw new ExternalServiceError("Supabase call_results insert failed", {
        table: this.resultsTable,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    logger.info("Synced call result to Supabase", {
      table: this.resultsTable,
      callSid: input.callSid,
      venueId: input.run.venueId,
      venueName: input.run.venueName,
    });
  }
}
