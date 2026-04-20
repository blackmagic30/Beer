import type BetterSqlite3 from "better-sqlite3";

import type {
  BeerPriceResultRecord,
  PersistedBeerPriceResultInput,
  PersistedHappyHourInput,
  ResultFilters,
} from "./models.js";

interface ReplaceCallResultsInput {
  venueId: string | null;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  timestamp: string;
  rawTranscript: string;
  callSid: string;
  conversationId: string | null;
  items: PersistedBeerPriceResultInput[];
  happyHour: PersistedHappyHourInput;
}

interface RawBeerPriceResultRecord
  extends Omit<BeerPriceResultRecord, "needsReview" | "happyHour" | "availableOnTap" | "availablePackageOnly"> {
  happyHour: number;
  needsReview: number;
  availableOnTap: number | null;
  availablePackageOnly: number;
}

export class BeerPriceResultsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  replaceForCall(input: ReplaceCallResultsInput): number {
    const deleteStatement = this.db.prepare("DELETE FROM beer_price_results WHERE call_sid = ?");
    const insertStatement = this.db.prepare(
      `INSERT INTO beer_price_results (
        venue_id,
        venue_name,
        phone_number,
        suburb,
        beer_name,
        price_text,
        price_numeric,
        availability_status,
        available_on_tap,
        available_package_only,
        unavailable_reason,
        timestamp,
        raw_transcript,
        confidence,
        happy_hour,
        happy_hour_days,
        happy_hour_start,
        happy_hour_end,
        happy_hour_price,
        happy_hour_confidence,
        call_sid,
        conversation_id,
        needs_review
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transaction = this.db.transaction(() => {
      deleteStatement.run(input.callSid);

      for (const item of input.items) {
        insertStatement.run(
          input.venueId,
          input.venueName,
          input.phoneNumber,
          input.suburb,
          item.beerName,
          item.priceText,
          item.priceNumeric,
          item.availabilityStatus,
          item.availableOnTap === null ? null : item.availableOnTap ? 1 : 0,
          item.availablePackageOnly ? 1 : 0,
          item.unavailableReason,
          input.timestamp,
          input.rawTranscript,
          item.confidence,
          input.happyHour.happyHour ? 1 : 0,
          input.happyHour.happyHourDays,
          input.happyHour.happyHourStart,
          input.happyHour.happyHourEnd,
          input.happyHour.happyHourPrice,
          input.happyHour.happyHourConfidence,
          input.callSid,
          input.conversationId,
          item.needsReview ? 1 : 0,
        );
      }
    });

    transaction();

    return input.items.length;
  }

  list(filters: ResultFilters): BeerPriceResultRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.callSid) {
      clauses.push("call_sid = ?");
      params.push(filters.callSid);
    }

    if (filters.venueName) {
      clauses.push("venue_name LIKE ?");
      params.push(`%${filters.venueName}%`);
    }

    if (filters.suburb) {
      clauses.push("suburb LIKE ?");
      params.push(`%${filters.suburb}%`);
    }

    if (filters.needsReview !== undefined) {
      clauses.push("needs_review = ?");
      params.push(filters.needsReview ? 1 : 0);
    }

    params.push(filters.limit);

    const query = `
      SELECT
        id,
        venue_id AS venueId,
        venue_name AS venueName,
        phone_number AS phoneNumber,
        suburb,
        beer_name AS beerName,
        price_text AS priceText,
        price_numeric AS priceNumeric,
        availability_status AS availabilityStatus,
        available_on_tap AS availableOnTap,
        available_package_only AS availablePackageOnly,
        unavailable_reason AS unavailableReason,
        timestamp,
        raw_transcript AS rawTranscript,
        confidence,
        happy_hour AS happyHour,
        happy_hour_days AS happyHourDays,
        happy_hour_start AS happyHourStart,
        happy_hour_end AS happyHourEnd,
        happy_hour_price AS happyHourPrice,
        happy_hour_confidence AS happyHourConfidence,
        call_sid AS callSid,
        conversation_id AS conversationId,
        needs_review AS needsReview,
        created_at AS createdAt
      FROM beer_price_results
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY timestamp DESC, beer_name ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(...params) as RawBeerPriceResultRecord[];

    return rows.map((row) => ({
      ...row,
      availableOnTap: row.availableOnTap === null ? null : Boolean(row.availableOnTap),
      availablePackageOnly: Boolean(row.availablePackageOnly),
      happyHour: Boolean(row.happyHour),
      needsReview: Boolean(row.needsReview),
    }));
  }

  listByCallSids(callSids: string[]): BeerPriceResultRecord[] {
    if (callSids.length === 0) {
      return [];
    }

    const placeholders = callSids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT
          id,
          venue_id AS venueId,
          venue_name AS venueName,
          phone_number AS phoneNumber,
          suburb,
          beer_name AS beerName,
          price_text AS priceText,
          price_numeric AS priceNumeric,
          availability_status AS availabilityStatus,
          available_on_tap AS availableOnTap,
          available_package_only AS availablePackageOnly,
          unavailable_reason AS unavailableReason,
          timestamp,
          raw_transcript AS rawTranscript,
          confidence,
          happy_hour AS happyHour,
          happy_hour_days AS happyHourDays,
          happy_hour_start AS happyHourStart,
          happy_hour_end AS happyHourEnd,
          happy_hour_price AS happyHourPrice,
          happy_hour_confidence AS happyHourConfidence,
          call_sid AS callSid,
          conversation_id AS conversationId,
          needs_review AS needsReview,
          created_at AS createdAt
         FROM beer_price_results
         WHERE call_sid IN (${placeholders})
         ORDER BY timestamp DESC, beer_name ASC`,
      )
      .all(...callSids) as RawBeerPriceResultRecord[];

    return rows.map((row) => ({
      ...row,
      availableOnTap: row.availableOnTap === null ? null : Boolean(row.availableOnTap),
      availablePackageOnly: Boolean(row.availablePackageOnly),
      happyHour: Boolean(row.happyHour),
      needsReview: Boolean(row.needsReview),
    }));
  }
}
