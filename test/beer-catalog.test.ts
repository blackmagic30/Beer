import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  VIEWER_TRACKED_BEERS,
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../src/constants/beers.js";

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
    expect(normalizeBeerSearchKey("--Carlton Draught--")).toBe("carlton_draught");
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
    expect(canonicalizeTrackedBeerName("Great Northern Supercrisp")).toBe("Great Northern Super Crisp");
    expect(canonicalizeTrackedBeerName("reschs")).toBe("Resch's Draught");
    expect(canonicalizeTrackedBeerName("Mountain Goat Lager")).toBe("Mountain Goat Lager");
    expect(canonicalizeTrackedBeerName("Stomping Ground Gipps St Pale")).toBe("Stomping Ground Gipps St Pale Ale");

    const beer = findTrackedBeerByName("balter xpa");
    expect(beer).toEqual(expect.objectContaining({
      name: "Balter XPA",
      brewery: "Balter",
      style: "XPA",
    }));
  });

  it("does not use brewery-only aliases for unrelated beers or ciders", () => {
    expect(findTrackedBeerByName("Mountain Goat")).toBeNull();
    expect(canonicalizeTrackedBeerName("Mountain Goat Tasty Pale Ale")).toBe("Mountain Goat Tasty Pale Ale");
    expect(canonicalizeTrackedBeerName("Mountain Goat Hazy Apple Cider")).toBe("Mountain Goat Hazy Apple Cider");
    expect(findTrackedBeerByName("Stomping Ground")).toBeNull();
    expect(canonicalizeTrackedBeerName("Stomping Ground Big Sky Hazy Pale Ale")).toBe(
      "Stomping Ground Big Sky Hazy Pale Ale",
    );
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

  it("rejects crawler menu-copy fragments as beer names", () => {
    expect(isLikelyBeerName("Hop Nation Jedi Juice")).toBe(true);
    expect(isLikelyBeerName("Very Local Hazy Pint")).toBe(true);
    expect(isLikelyBeerName("INCLUDED YOU'LL FIND *")).toBe(false);
    expect(isLikelyBeerName("INCLUDED YOU'LL FIND * $ COCKTAILS *")).toBe(false);
    expect(isLikelyBeerName("Includes")).toBe(false);
    expect(isLikelyBeerName("IPA")).toBe(false);
    expect(isLikelyBeerName("Happy Hour -8pm -")).toBe(false);
    expect(isLikelyBeerName("Heaps Normal % Lager Mornington Peninsula Free % XPA")).toBe(false);
    expect(isLikelyBeerName("Poor Tom's Sydney Dry")).toBe(false);
    expect(isLikelyBeerName("78 Degrees Whisky")).toBe(false);
    expect(isLikelyBeerName("Premium Northern Victorian T bone")).toBe(false);
    expect(isLikelyBeerName("Venom Cherry Sour")).toBe(true);
  });

  it("seeds the system beer registry and resolves static aliases", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      expect(await repository.resolveBeerName({
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
      expect(await repository.resolveBeerName({
        name: "Guinness Stout",
        source: "manual_test",
        now: "2026-06-30T00:00:00.000Z",
        createIfMissing: false,
      })).toEqual(expect.objectContaining({
        key: "guinness_stout",
        status: "pending_review",
        matchedExisting: false,
      }));
      expect(await repository.resolveBeerName({
        name: "Guinness Stout",
        source: "photo_ocr_test",
        now: "2026-06-30T00:00:00.000Z",
        createIfMissing: false,
        matchMode: "ocr",
      })).toEqual(expect.objectContaining({
        key: "guinness",
        name: "Guinness",
        status: "active",
        matchedExisting: true,
      }));
    } finally {
      database.close();
    }
  });

  it("keeps active catalogue entries beyond row 500 available to viewer and OCR callers", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const insert = database.prepare(
        `INSERT INTO beer_catalog_items (
          key, name, brewery, style, abv, status, source, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, 'active', 'reachability_test', ?, ?)`,
      );
      database.transaction(() => {
        for (let index = 0; index < 510; index += 1) {
          const suffix = String(index).padStart(3, "0");
          insert.run(`reachability_beer_${suffix}`, `ZZZ Reachability Beer ${suffix}`, "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z");
        }
      })();
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      expect(await repository.listForViewer()).toContainEqual(expect.objectContaining({
        key: "reachability_beer_509",
        name: "ZZZ Reachability Beer 509",
      }));
      expect(await repository.listForViewer(500)).not.toContainEqual(expect.objectContaining({ key: "reachability_beer_509" }));
    } finally {
      database.close();
    }
  });

  it("adds unknown crawler beers as pending system beer candidates", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      const created = await repository.resolveBeerName({
        name: "Very Local Hazy Pint",
        source: "menu_crawler_import",
        now: "2026-06-30T00:00:00.000Z",
      });
      const matched = await repository.resolveBeerName({
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
      expect(await repository.listForViewer()).not.toContainEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
      }));
      expect(await repository.listForAdmin("pending_review", 20)).toContainEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
        name: "Very Local Hazy Pint",
        aliases: expect.arrayContaining(["Very Local Hazy Pint"]),
      }));
      expect(await repository.listForAdmin("pending_review", 20, 0, "%")).toEqual([]);
      expect(await repository.countForAdmin("pending_review", "_")).toBe(0);
    } finally {
      database.close();
    }
  });

  it("serializes concurrent resolution through the shared SQLite adapter", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      const resolved = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.resolveBeerName({
        name: index % 2 === 0 ? "Parallel Test Lager" : "parallel test lager",
        source: "concurrency_test",
        now: "2026-08-08T00:00:00.000Z",
      })));

      expect(resolved.map((beer) => beer.key)).toEqual(Array(8).fill("parallel_test_lager"));
      expect(resolved.filter((beer) => beer.created)).toHaveLength(1);
      expect(database.prepare("SELECT count(*) AS count FROM beer_catalog_items WHERE key = ?")
        .get("parallel_test_lager")).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("lets admins reject pending catalogue names without deleting active beers", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      await repository.resolveBeerName({
        name: "Very Local Hazy Pint",
        source: "menu_crawler_import",
        now: "2026-06-30T00:00:00.000Z",
      });

      const rejected = await repository.rejectPendingBeer({
        key: "very_local_hazy_pint",
        reviewNote: "OCR website copy noise.",
        now: "2026-06-30T00:15:00.000Z",
      });

      expect(rejected).toEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
        name: "Very Local Hazy Pint",
        reviewNote: "OCR website copy noise.",
      }));
      expect(await repository.listForAdmin("pending_review", 20)).not.toContainEqual(expect.objectContaining({
        key: "very_local_hazy_pint",
      }));
      expect(database.prepare("SELECT count(*) AS count FROM beer_catalog_aliases WHERE beer_key = ?").get("very_local_hazy_pint")).toEqual({
        count: 0,
      });
      expect(await repository.rejectPendingBeer({
        key: "carlton_draft",
        reviewNote: "Should not remove active beers.",
        now: "2026-06-30T00:20:00.000Z",
      })).toBeNull();
      expect(await repository.listForViewer()).toContainEqual(expect.objectContaining({
        key: "carlton_draft",
        name: "Carlton Draught",
      }));
    } finally {
      database.close();
    }
  });

  it("does not create pending catalogue entries for obvious OCR noise", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      const rejected = await repository.resolveBeerName({
        name: "INCLUDED YOU'LL FIND *",
        source: "menu_crawler_import",
        now: "2026-06-30T00:00:00.000Z",
      });

      expect(rejected).toEqual(expect.objectContaining({
        key: "included_you_ll_find",
        name: "INCLUDED YOU'LL FIND *",
        status: "pending_review",
        created: false,
        matchedExisting: false,
      }));
      expect(await repository.listForAdmin("pending_review", 20)).not.toContainEqual(expect.objectContaining({
        name: "INCLUDED YOU'LL FIND *",
      }));
    } finally {
      database.close();
    }
  });

  it("cleans old pending crawler noise from the beer catalogue on startup", async () => {
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      database
        .prepare(
          `INSERT INTO beer_catalog_items (
            key, name, brewery, style, abv, status, source, created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, 'pending_review', 'menu_crawler_import', ?, ?)`,
        )
        .run("included_you_ll_find", "INCLUDED YOU'LL FIND *", "2026-06-30T00:00:00.000Z", "2026-06-30T00:00:00.000Z");
      database
        .prepare(
          `INSERT INTO beer_catalog_aliases (
            alias_key, beer_key, alias, source, created_at
          ) VALUES (?, ?, ?, 'menu_crawler_import', ?)`,
        )
        .run("included_you_ll_find", "included_you_ll_find", "INCLUDED YOU'LL FIND *", "2026-06-30T00:00:00.000Z");

      initializeDatabaseSchema(database);
      const repository = new BeerCatalogRepository(asAsyncSqliteDatabase(database));

      expect(await repository.listForAdmin("pending_review", 20)).not.toContainEqual(expect.objectContaining({
        key: "included_you_ll_find",
      }));
    } finally {
      database.close();
    }
  });
});
