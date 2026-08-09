import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";

const NOW = "2026-08-08T00:00:00.000Z";

describe("public venue directory repository", () => {
  let database: BetterSqlite3.Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  function createRepository(): PublicVenueDirectoryRepository {
    database = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(database);
    return new PublicVenueDirectoryRepository(asAsyncSqliteDatabase(database));
  }

  function insertProfile(input: {
    id: string;
    name: string;
    suburb?: string;
    address?: string;
    active?: boolean;
    tags?: string[];
    openingHours?: Record<string, unknown>;
  }): void {
    database!.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, address, suburb, opening_hours_json, venue_tags_json,
         active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.address ?? null,
      input.suburb ?? null,
      JSON.stringify(input.openingHours ?? {}),
      JSON.stringify(input.tags ?? []),
      input.active === false ? 0 : 1,
      NOW,
      NOW,
    );
  }

  it("preserves profile precedence, filters, stable ordering, JSON, totals, and pagination", async () => {
    const repository = createRepository();
    insertProfile({
      id: "venue-zulu",
      name: "zulu Hotel",
      suburb: "Fitzroy",
      address: "100 Percent Lane",
      tags: ["user submitted", "rooftop"],
      openingHours: { friday: { open: true } },
    });
    insertProfile({ id: "venue-alpha-upper", name: "Alpha Hotel", suburb: "Richmond" });
    insertProfile({ id: "venue-alpha-lower", name: "alpha hotel", suburb: "Carlton" });
    insertProfile({ id: "venue-inactive", name: "Hidden Hotel", active: false });
    database!.prepare(
      `INSERT INTO venue_location_cache (
         venue_id, venue_name, suburb, latitude, longitude, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("venue-zulu", "zulu Hotel", "Fitzroy", -37.8, 144.9, NOW);
    const insertMission = database!.prepare(
      `INSERT INTO missions (
         id, venue_id, venue_name, suburb, reason, priority, points,
         active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'test', 'normal', 5, ?, ?, ?)`,
    );
    insertMission.run("mission-duplicate", "venue-zulu", "Mission Name Must Lose", "Melbourne", 1, NOW, NOW);
    insertMission.run("mission-only", "venue-mission", "Bravo Mission", "Brunswick", 1, NOW, NOW);
    insertMission.run("mission-inactive", "venue-hidden-mission", "Hidden Mission", "Brunswick", 0, NOW, NOW);

    const page = await repository.listPublicVenueDirectoryPage({ limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.venues.map((venue) => venue.id)).toEqual(["venue-alpha-lower", "venue-mission"]);

    const zulu = (await repository.listPublicVenueDirectoryPage({
      query: "100 Percent",
      limit: 20,
      offset: 0,
    })).venues[0];
    expect(zulu).toEqual(expect.objectContaining({
      id: "venue-zulu",
      name: "zulu Hotel",
      latitude: -37.8,
      longitude: 144.9,
      openingHours: { friday: { open: true } },
      venueTags: ["user submitted", "rooftop"],
      isUserSubmittedVenue: true,
    }));
    expect((await repository.listPublicVenueDirectoryPage({
      query: "%",
      limit: 20,
      offset: 0,
    })).venues).toEqual([]);
    expect((await repository.listPublicVenueDirectoryPage({
      query: "_",
      limit: 20,
      offset: 0,
    })).venues).toEqual([]);
  });

  it("batch-resolves canonical aliases and excludes quarantined or unavailable beer rows", async () => {
    const repository = createRepository();
    insertProfile({ id: "canonical-venue", name: "Canonical Hotel" });
    insertProfile({ id: "alias-venue", name: "Historical Hotel", active: false });
    database!.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run("alias-venue", "canonical-venue", "canonical hotel|fitzroy", NOW, NOW);
    const insertPrice = database!.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, beer_name, normalized_beer_id, serving_size,
         source_type, source_ingestion_id, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, 'Canonical Hotel', ?, ?, 'pint', ?, ?, ?, ?, ?)`,
    );
    insertPrice.run(
      "price-carlton",
      "alias-venue",
      "Carlton Draught",
      "carlton_draft",
      "community_verified",
      null,
      NOW,
      NOW,
      NOW,
    );
    insertPrice.run(
      "price-quarantined",
      "canonical-venue",
      "Victoria Bitter",
      "victoria_bitter",
      "source_ingestion_quarantined",
      "ingestion-quarantined",
      NOW,
      NOW,
      NOW,
    );
    const insertBeer = database!.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, in_stock,
         source_ingestion_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertBeer.run("beer-guinness", "canonical-venue", "Guinness", "guinness", 1, null, NOW, NOW);
    insertBeer.run("beer-duplicate", "canonical-venue", "Carlton Draught", "carlton_draft", 1, null, NOW, NOW);
    insertBeer.run("beer-out", "canonical-venue", "Hahn Super Dry", "hahn_super_dry", 0, null, NOW, NOW);
    insertBeer.run(
      "beer-quarantined-ingestion",
      "canonical-venue",
      "Stone & Wood Pacific Ale",
      "stone_and_wood_pacific_ale",
      1,
      "ingestion-quarantined",
      NOW,
      NOW,
    );

    const keys = await repository.listPublicVenueBeerKeys([
      " canonical-venue ",
      "alias-venue",
      "canonical-venue",
      "missing-venue",
      "",
    ]);
    expect([...keys.keys()]).toEqual(["canonical-venue", "alias-venue", "missing-venue"]);
    expect(keys.get("canonical-venue")).toEqual(["carlton_draft", "guinness"]);
    expect(keys.get("alias-venue")).toEqual(["carlton_draft", "guinness"]);
    expect(keys.get("missing-venue")).toEqual([]);
  });

  it("caps the dynamic VALUES batch at one thousand placeholder-bound venue IDs", async () => {
    const repository = createRepository();
    const requested = Array.from({ length: 1_005 }, (_, index) => `venue-${index}`);
    const result = await repository.listPublicVenueBeerKeys(requested);

    expect(result.size).toBe(1_000);
    expect(result.has("venue-999")).toBe(true);
    expect(result.has("venue-1000")).toBe(false);
  });
});
