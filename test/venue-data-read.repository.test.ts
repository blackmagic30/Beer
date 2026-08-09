import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  VenueDataReadRepository,
  VenueDataReadRepositoryError,
  venueDataReadRepositoryLimits,
} from "../src/db/venue-data-read.repository.js";
import { asAsyncSqliteDatabase, type SqlDatabase } from "../src/db/sql-database.js";

const BASE_TIME = "2026-08-09T00:00:00.000Z";
const MINUTE_1 = "2026-08-09T00:01:00.000Z";
const MINUTE_2 = "2026-08-09T00:02:00.000Z";

interface PriceFixture {
  id: string;
  venueId?: string;
  venueName?: string;
  suburb?: string | null;
  beerName?: string;
  normalizedBeerId?: string | null;
  lastVerifiedAt?: string;
}

describe("venue data read repository", () => {
  let sqlite: BetterSqlite3.Database | null = null;
  let database: SqlDatabase | null = null;

  afterEach(async () => {
    if (database) await database.close().catch(() => undefined);
    else if (sqlite?.open) sqlite.close();
    database = null;
    sqlite = null;
  });

  function createRepository(): VenueDataReadRepository {
    sqlite = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(sqlite);
    database = asAsyncSqliteDatabase(sqlite);
    return new VenueDataReadRepository(database);
  }

  function insertProfile(input: {
    venueId: string;
    name: string;
    suburb?: string | null;
    active?: boolean;
  }): void {
    sqlite!.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, suburb, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.venueId,
      input.name,
      input.suburb ?? null,
      input.active === false ? 0 : 1,
      BASE_TIME,
      BASE_TIME,
    );
  }

  function insertLocation(input: {
    venueId: string;
    venueName: string;
    suburb?: string | null;
  }): void {
    sqlite!.prepare(
      `INSERT INTO venue_location_cache (
         venue_id, venue_name, suburb, latitude, longitude, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, ?)`,
    ).run(input.venueId, input.venueName, input.suburb ?? null, BASE_TIME);
  }

  function insertPrice(input: PriceFixture): void {
    sqlite!.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, source_type, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pint', 'community_verified', ?, ?, ?)`,
    ).run(
      input.id,
      input.venueId ?? "venue-a",
      input.venueName ?? "Alpha Hotel",
      input.suburb ?? "Fitzroy",
      input.beerName ?? "Carlton Draught",
      input.normalizedBeerId === undefined ? "carlton_draft" : input.normalizedBeerId,
      input.lastVerifiedAt ?? BASE_TIME,
      BASE_TIME,
      input.lastVerifiedAt ?? BASE_TIME,
    );
  }

  it("short-circuits empty lookups without touching AsyncSQLite", async () => {
    const repository = createRepository();

    await expect(repository.findLikelyVenueDuplicate({ name: "   " })).resolves.toBeNull();
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: " venue-a ",
      beerName: "  ",
      normalizedBeerId: " ",
    })).resolves.toBe(false);
    expect(database!.metrics().completedQueries).toBe(0);
  });

  it("preserves suburb-first and lexical source precedence with a deterministic single result", async () => {
    const repository = createRepository();
    insertProfile({ venueId: "venue-profile", name: "The Test Hotel", suburb: "Fitzroy" });
    insertLocation({ venueId: "venue-location", venueName: "The Test Hotel", suburb: "Richmond" });
    insertPrice({
      id: "price-record",
      venueId: "venue-price",
      venueName: "The Test Hotel",
      suburb: "Richmond",
    });
    insertProfile({ venueId: "inactive", name: "Closed Hotel", active: false });

    await expect(repository.findLikelyVenueDuplicate({
      name: "  THE TEST HOTEL ",
      suburb: " fitzroy ",
    })).resolves.toEqual({
      venueId: "venue-profile",
      venueName: "The Test Hotel",
      suburb: "Fitzroy",
      source: "venue_profile",
    });
    await expect(repository.findLikelyVenueDuplicate({
      name: "the test hotel",
      suburb: "RICHMOND",
    })).resolves.toEqual({
      venueId: "venue-location",
      venueName: "The Test Hotel",
      suburb: "Richmond",
      source: "location_cache",
    });
    await expect(repository.findLikelyVenueDuplicate({
      name: "the test hotel",
    })).resolves.toEqual(expect.objectContaining({
      venueId: "venue-location",
      source: "location_cache",
    }));
    await expect(repository.findLikelyVenueDuplicate({ name: "Closed Hotel" })).resolves.toBeNull();
  });

  it("loads the newest canonical timestamp and matches normalized IDs before the name fallback", async () => {
    const repository = createRepository();
    insertPrice({ id: "old", lastVerifiedAt: MINUTE_1 });
    insertPrice({
      id: "new",
      beerName: "Stone & Wood Pacific Ale",
      normalizedBeerId: "stone_and_wood_pacific_ale",
      lastVerifiedAt: MINUTE_2,
    });

    await expect(repository.getLatestVenueDataTimestamp(" venue-a ")).resolves.toBe(MINUTE_2);
    await expect(repository.getLatestVenueDataTimestamp("missing")).resolves.toBeNull();
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: "venue-a",
      beerName: "Not the stored name",
      normalizedBeerId: " stone_and_wood_pacific_ale ",
    })).resolves.toBe(true);
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: "venue-a",
      beerName: "  STONE & WOOD PACIFIC ALE ",
      normalizedBeerId: "unknown-key",
    })).resolves.toBe(true);
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: "venue-a",
      beerName: "Guinness",
      normalizedBeerId: null,
    })).resolves.toBe(false);
  });

  it("rejects oversized or control-bearing inputs with a stable secret-free error", async () => {
    const repository = createRepository();
    const expected = {
      name: "VenueDataReadRepositoryError",
      code: "invalid_input",
      message: "The venue-data lookup input is invalid.",
    };

    await expect(repository.getLatestVenueDataTimestamp(
      "v".repeat(venueDataReadRepositoryLimits.maxVenueIdLength + 1),
    )).rejects.toMatchObject(expected);
    await expect(repository.findLikelyVenueDuplicate({
      name: "Unsafe\nHotel",
    })).rejects.toMatchObject(expected);
    await expect(repository.venueHasPublishedBeerRecord({
      venueId: "venue-a",
      beerName: "beer",
      normalizedBeerId: "b".repeat(
        venueDataReadRepositoryLimits.maxNormalizedBeerIdLength + 1,
      ),
    })).rejects.toMatchObject(expected);
  });

  it("fails closed on malformed persisted identifiers and timestamps", async () => {
    const repository = createRepository();
    insertLocation({ venueId: "", venueName: "Malformed Hotel" });
    insertPrice({ id: "malformed-time", venueId: "bad-time", lastVerifiedAt: "not-a-time" });

    await expect(repository.findLikelyVenueDuplicate({
      name: "Malformed Hotel",
    })).rejects.toMatchObject({
      name: "VenueDataReadRepositoryError",
      code: "malformed_record",
      message: "Stored venue data is malformed.",
    });
    await expect(repository.getLatestVenueDataTimestamp("bad-time")).rejects.toBeInstanceOf(
      VenueDataReadRepositoryError,
    );
    await expect(repository.getLatestVenueDataTimestamp("bad-time")).rejects.toMatchObject({
      code: "malformed_record",
    });
  });

  it("maps database failures without exposing driver details", async () => {
    const repository = createRepository();
    await database!.close();

    await expect(repository.getLatestVenueDataTimestamp("venue-a")).rejects.toMatchObject({
      name: "VenueDataReadRepositoryError",
      code: "persistence_failure",
      message: "Venue data could not be loaded.",
    });
    database = null;
  });
});
