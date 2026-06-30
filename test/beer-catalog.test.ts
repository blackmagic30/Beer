import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName, findTrackedBeerByName, normalizeBeerSearchKey } from "../src/constants/beers.js";

describe("Pint Path beer catalogue", () => {
  it("provides a broad dropdown catalogue for venue-owner beer entry", () => {
    expect(VIEWER_TRACKED_BEERS.length).toBeGreaterThanOrEqual(80);
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Balter XPA");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Coopers Pale Ale");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Asahi Super Dry");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Carlton Draught");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Resch's Draught");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).not.toContain("Carlton Draft");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).not.toContain("Reschs Draught");
  });

  it("canonicalises common aliases so venue rows do not fork misspelled beer names", () => {
    expect(canonicalizeTrackedBeerName("Carlton Draft")).toBe("Carlton Draught");
    expect(canonicalizeTrackedBeerName("Carlton Draught")).toBe("Carlton Draught");
    expect(findTrackedBeerByName("Carlton Draft")).toEqual(expect.objectContaining({
      key: "carlton_draft",
      name: "Carlton Draught",
    }));
    expect(canonicalizeTrackedBeerName("stone and wood")).toBe("Stone & Wood Pacific Ale");
    expect(canonicalizeTrackedBeerName("Stone & Wood")).toBe("Stone & Wood Pacific Ale");
    expect(findTrackedBeerByName("stone_and_wood")).toEqual(expect.objectContaining({
      key: "stone_and_wood_pacific_ale",
      name: "Stone & Wood Pacific Ale",
    }));
    expect(canonicalizeTrackedBeerName("Great Northern")).toBe("Great Northern Original");
    expect(canonicalizeTrackedBeerName("reschs")).toBe("Resch's Draught");

    const beer = findTrackedBeerByName("balter xpa");
    expect(beer).toEqual(expect.objectContaining({
      name: "Balter XPA",
      brewery: "Balter",
      style: "XPA",
    }));
  });

  it("does not publish duplicate visible names in the tracked catalogue", () => {
    const names = VIEWER_TRACKED_BEERS.map((beer) => beer.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not map the same normalized candidate to multiple tracked beers", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];

    for (const beer of VIEWER_TRACKED_BEERS) {
      for (const candidate of [beer.key, beer.name, ...beer.aliases]) {
        const normalized = normalizeBeerSearchKey(candidate);
        if (!normalized) {
          continue;
        }

        const existing = seen.get(normalized);
        if (existing && existing !== beer.key) {
          collisions.push(`${normalized}: ${existing} vs ${beer.key}`);
        }
        seen.set(normalized, beer.key);
      }
    }

    expect(collisions).toEqual([]);
  });

  it("seeds the system beer registry and resolves static aliases", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(database);

      expect(repository.resolveBeerName({
        name: "Carlton Draft",
        source: "test",
        now: "2026-06-30T00:00:00.000Z",
      })).toEqual(expect.objectContaining({
        key: "carlton_draft",
        name: "Carlton Draught",
        status: "active",
        created: false,
        matchedExisting: true,
      }));
    } finally {
      database.close();
    }
  });

  it("adds unknown crawler beers as pending system beer candidates", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(database);

      const created = repository.resolveBeerName({
        name: "Very Local Hazy Pint",
        source: "menu_crawler_import",
        now: "2026-06-30T00:00:00.000Z",
      });
      const matched = repository.resolveBeerName({
        name: "very local hazy pint",
        source: "source_ingestion_review",
        now: "2026-06-30T00:10:00.000Z",
      });

      expect(created).toEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
        name: "Very Local Hazy Pint",
        status: "pending_review",
        created: true,
      }));
      expect(matched).toEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
        name: "Very Local Hazy Pint",
        status: "pending_review",
        created: false,
        matchedExisting: true,
      }));
    } finally {
      database.close();
    }
  });
});
