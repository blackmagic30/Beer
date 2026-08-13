import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type {
  AdminIngestionBeerRecord,
  AdminIngestionQueueRecord,
} from "../src/db/models.js";
import {
  REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
  REVIEWED_PRICE_SELECTION_POLICY,
  REVIEWED_PRICE_SELECTION_POLICY_CANONICAL_JSON,
  REVIEWED_PRICE_SELECTION_POLICY_SHA256,
  isLikelyBaselineMenuSource,
  selectPublishableMapBaseRows,
  type ReviewedPriceSelectionOptions,
} from "../src/lib/reviewed-price-selection-policy.js";
import {
  assertPublishMapBaseSupabaseBoundary,
  isLikelyBaselineMenuSource as publisherIsLikelyBaselineMenuSource,
  selectPublishableMapBaseRows as publisherSelectPublishableMapBaseRows,
} from "../scripts/publish-source-ingestion-map-base.js";

function beerRow(
  overrides: Partial<AdminIngestionBeerRecord> = {},
): AdminIngestionBeerRecord {
  return {
    availabilityStatus: "on_tap",
    availableOnTap: true,
    availablePackageOnly: false,
    confidence: 0.9,
    name: "Carlton Draught",
    needsReview: true,
    notes: null,
    priceNumeric: 13.5,
    priceText: "$13.50 pint",
    servingSize: "pint",
    unavailableReason: null,
    ...overrides,
  };
}

function queueItem(overrides: Partial<AdminIngestionQueueRecord> = {}): AdminIngestionQueueRecord {
  return {
    id: "queue-1",
    venueId: "11111111-1111-4111-8111-111111111111",
    venueName: "Test Venue",
    sourceType: "source_reference",
    sourceUrl: "https://example.com/drinks-menu.pdf",
    imageDataUrl: null,
    note: "Crawler import for admin review only.",
    status: "pending_review",
    venueNameGuess: "Test Venue",
    capturedNotes: "Source: https://example.com/drinks-menu.pdf",
    overallConfidence: 0.88,
    extractedBeers: [beerRow()],
    reviewBeers: null,
    crawlerFeedback: null,
    errorMessage: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    publishedAt: null,
    rejectedAt: null,
    ...overrides,
  };
}

function expectSelectionParity(
  item: AdminIngestionQueueRecord,
  expected: ReturnType<typeof selectPublishableMapBaseRows>,
  options: ReviewedPriceSelectionOptions = { ...REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS },
): void {
  expect(selectPublishableMapBaseRows(item, options)).toEqual(expected);
  expect(publisherSelectPublishableMapBaseRows(item, options)).toEqual(expected);
}

describe("source ingestion map-base publisher selection", () => {
  it("rejects unreviewed Supabase transports before publication setup", () => {
    const serviceRoleKey = `sb_secret_${"s".repeat(32)}`;
    expect(assertPublishMapBaseSupabaseBoundary({
      SUPABASE_URL: "https://auth.pintpath.au",
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    })).toEqual({
      supabaseUrl: "https://auth.pintpath.au",
      serviceRoleKey,
    });
    expect(assertPublishMapBaseSupabaseBoundary({}, false)).toBeNull();
    expect(assertPublishMapBaseSupabaseBoundary({
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
    }, false)).toBeNull();
    expect(() => assertPublishMapBaseSupabaseBoundary({
      SUPABASE_URL: "https://auth.pintpath.au",
    }, false)).toThrow(/no configured value is emitted/);

    for (const environment of [
      {
        SUPABASE_URL: "https://attacker.invalid",
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      },
      {
        SUPABASE_URL: " https://auth.pintpath.au",
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      },
      {
        SUPABASE_URL: "https://auth.pintpath.au",
        SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${"p".repeat(32)}`,
      },
      {
        SUPABASE_URL: "https://auth.pintpath.au",
        SUPABASE_SERVICE_ROLE_KEY: `${serviceRoleKey}\n`,
      },
    ]) {
      expect(() => assertPublishMapBaseSupabaseBoundary(environment))
        .toThrow(/no configured value is emitted|no key value is emitted/);
    }
  });

  it("runs a local dry-run with no Supabase configuration or client", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-map-base-dry-run-"));
    const databasePath = path.join(root, "pint-path.sqlite");
    const database = new Database(databasePath);
    try {
      database.exec(fs.readFileSync(path.resolve("src/db/schema.sql"), "utf8"));
    } finally {
      database.close();
    }
    try {
      const result = spawnSync(process.execPath, [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("scripts/publish-source-ingestion-map-base.ts"),
        "--dry-run",
        `--database=${databasePath}`,
        "--skip-source-check",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "development",
          SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "dry-run",
        publishedCount: 0,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports one immutable canonical policy with a pinned deterministic SHA-256", () => {
    expect(publisherIsLikelyBaselineMenuSource).toBe(isLikelyBaselineMenuSource);
    expect(publisherSelectPublishableMapBaseRows).toBe(selectPublishableMapBaseRows);
    expect(Object.isFrozen(REVIEWED_PRICE_SELECTION_POLICY)).toBe(true);
    expect(Object.isFrozen(REVIEWED_PRICE_SELECTION_POLICY.defaultOptions)).toBe(true);
    expect(Object.isFrozen(REVIEWED_PRICE_SELECTION_POLICY.patterns)).toBe(true);
    expect(Object.isFrozen(REVIEWED_PRICE_SELECTION_POLICY.patterns.noisyBeerName)).toBe(true);
    expect(JSON.parse(REVIEWED_PRICE_SELECTION_POLICY_CANONICAL_JSON)).toEqual(
      REVIEWED_PRICE_SELECTION_POLICY,
    );
    expect(
      createHash("sha256")
        .update(REVIEWED_PRICE_SELECTION_POLICY_CANONICAL_JSON, "utf8")
        .digest("hex"),
    ).toBe(REVIEWED_PRICE_SELECTION_POLICY_SHA256);
    expect(REVIEWED_PRICE_SELECTION_POLICY_SHA256).toBe(
      "eb45b42b2c3a75c4b76a14ddcf5dc0053658cec5de5c69025a4319da67a0fa3a",
    );
  });

  it("preserves adversarial source-classification parity for every legacy exclusion family", () => {
    const specialSignals = [
      "happy-hour",
      "whats-on",
      "events",
      "specials",
      "mates-rates",
      "parma",
      "roast",
      "beer-of-the-month",
      "drinks-of-the-month",
      "good-beer-week",
      "big-bash",
      "promo",
      "promotion",
      "deal",
      "offer",
      "blog",
      "post",
      "news",
      "weekly-specials",
    ];
    for (const signal of specialSignals) {
      const item = queueItem({ capturedNotes: `Crawler source: ${signal}` });
      expect(isLikelyBaselineMenuSource(item)).toBe(false);
      expectSelectionParity(item, { beers: [], reasons: ["not_baseline_menu_source"] });
    }

    for (const extension of ["avif", "gif", "jpg", "jpeg", "png", "webp"]) {
      const item = queueItem({
        sourceUrl: `https://example.com/assets/drinks-menu.${extension}?download=1`,
      });
      expect(isLikelyBaselineMenuSource(item)).toBe(false);
      expectSelectionParity(item, { beers: [], reasons: ["not_baseline_menu_source"] });
    }

    for (const sourceUrl of [
      "ftp://example.com/drinks-menu.pdf",
      "not a URL",
      "https://example.com/cocktail-menu.pdf",
      "https://example.com/cocktails/menu.pdf",
    ]) {
      const item = queueItem({ sourceUrl });
      expect(isLikelyBaselineMenuSource(item)).toBe(false);
      expectSelectionParity(item, { beers: [], reasons: ["not_baseline_menu_source"] });
    }

    const homepageOptions = {
      ...REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
      allowHomepage: true,
    };
    for (const signal of [
      "drink price text",
      "html text rows",
      "menu page",
      "drinks menu",
      "beverage menu",
      "beer menu",
    ]) {
      const item = queueItem({
        capturedNotes: signal,
        sourceUrl: "https://example.com/",
      });
      expect(isLikelyBaselineMenuSource(item, homepageOptions)).toBe(true);
      expectSelectionParity(item, {
        beers: [
          {
            availabilityStatus: "on_tap",
            availableOnTap: true,
            availablePackageOnly: false,
            name: "Carlton Draught",
            needsReview: false,
            priceNumeric: 13.5,
            priceText: "$13.50 pint",
            servingSize: "pint",
            unavailableReason: null,
          },
        ],
        reasons: [],
      }, homepageOptions);
    }

    const specialAllowedOptions = {
      ...REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
      allowSpecialSources: true,
    };
    const allowedSpecial = queueItem({ capturedNotes: "happy-hour" });
    expect(isLikelyBaselineMenuSource(allowedSpecial, specialAllowedOptions)).toBe(true);
    expectSelectionParity(
      allowedSpecial,
      selectPublishableMapBaseRows(queueItem()),
      specialAllowedOptions,
    );

    // Preserve the legacy normalization order exactly: hyphens and underscores
    // become spaces before the wine-list alternatives are evaluated.
    for (const sourceUrl of [
      "https://example.com/wine-list-menu.pdf",
      "https://example.com/wine_list_menu.pdf",
    ]) {
      const item = queueItem({ sourceUrl });
      expect(isLikelyBaselineMenuSource(item)).toBe(true);
      expectSelectionParity(item, selectPublishableMapBaseRows(queueItem()));
    }

    const malformedEncoding = queueItem({
      sourceUrl: "https://example.com/drinks-menu-%E0%A4%A.pdf",
    });
    expect(() => isLikelyBaselineMenuSource(malformedEncoding)).toThrow(URIError);
    expect(() => publisherIsLikelyBaselineMenuSource(malformedEncoding)).toThrow(URIError);
    expect(() => selectPublishableMapBaseRows(malformedEncoding)).toThrow(URIError);
    expect(() => publisherSelectPublishableMapBaseRows(malformedEncoding)).toThrow(URIError);
  });

  it("preserves adversarial row-exclusion parity for every legacy name and context family", () => {
    const noisyNames = [
      "cocktail",
      "wine",
      "spritz",
      "margarita",
      "negroni",
      "espresso",
      "martini",
      "parma",
      "burger",
      "pizza",
      "steak",
      "wings",
      "coffee",
      "tea",
      "soft drink",
      "soda",
      "mocktail",
      "flight",
      "tasting paddle",
      "cider",
      "ginger beer",
      "hard rated",
      "seltzer",
      "rtd",
      "whisky",
      "whiskey",
      "bourbon",
      "vodka",
      "rum",
      "gin",
      "tequila",
      "mezcal",
    ];
    for (const noisyName of noisyNames) {
      expectSelectionParity(
        queueItem({ extractedBeers: [beerRow({ name: `House ${noisyName}` })] }),
        { beers: [], reasons: ["no_usable_on_tap_pint_rows"] },
      );
    }

    const excludedContexts = [
      "schooner",
      "pot",
      "middy",
      "jug",
      "can",
      "bottle",
      "stubby",
      "stubbies",
      "pie & pint",
      "pint & pie",
      "parma & pot",
      "pot & parma",
      "happy-hour",
      "special",
      "deal",
      "offer",
      "promo",
      "cocktail",
      "gin",
      "rum",
      "vodka",
      "tequila",
      "mezcal",
      "whisky",
      "whiskey",
      "bourbon",
      "vermouth",
      "liqueur",
      "agave",
      "yuzu",
      "grapefruit",
      "mint",
      "served on ice",
      "tasty pale ale",
      "captain sensible",
    ];
    for (const context of excludedContexts) {
      expectSelectionParity(
        queueItem({ extractedBeers: [beerRow({ notes: `Listed as ${context}` })] }),
        { beers: [], reasons: ["no_usable_on_tap_pint_rows"] },
      );
    }
  });

  it("preserves canonical output, boundary, duplicate, and reason-order parity", () => {
    const canonical = queueItem({
      extractedBeers: [beerRow({
        availableOnTap: null,
        name: "  Carlton   Draught  ",
        unavailableReason: "unknown",
      })],
      overallConfidence: REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS.minOverallConfidence,
    });
    expectSelectionParity(canonical, {
      beers: [{
        availabilityStatus: "on_tap",
        availableOnTap: true,
        availablePackageOnly: false,
        name: "  Carlton   Draught  ",
        needsReview: false,
        priceNumeric: 13.5,
        priceText: "$13.50 pint",
        servingSize: "pint",
        unavailableReason: null,
      }],
      reasons: [],
    });

    expectSelectionParity(queueItem({
      extractedBeers: [beerRow({
        confidence: REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS.minRowConfidence,
        priceNumeric: REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS.minPrice,
      }), beerRow({
        name: "Guinness Draught",
        priceNumeric: REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS.maxPrice,
      })],
    }), {
      beers: [
        expect.objectContaining({ name: "Carlton Draught", priceNumeric: 8 }),
        expect.objectContaining({ name: "Guinness Draught", priceNumeric: 25 }),
      ],
      reasons: [],
    } as ReturnType<typeof selectPublishableMapBaseRows>);

    expectSelectionParity(queueItem({
      extractedBeers: [
        beerRow({ name: " Carlton   Draught ", priceNumeric: 13.501 }),
        beerRow({ name: "carlton draught", priceNumeric: 13.504 }),
      ],
    }), {
      beers: [expect.objectContaining({
        name: " Carlton   Draught ",
        priceNumeric: 13.501,
      })],
      reasons: [],
    } as ReturnType<typeof selectPublishableMapBaseRows>);

    expectSelectionParity(queueItem({
      extractedBeers: [
        beerRow({ priceNumeric: 13.504 }),
        beerRow({ name: "carlton draught", priceNumeric: 13.506 }),
        beerRow({ name: "Guinness Draught", priceNumeric: 14 }),
      ],
    }), {
      beers: [expect.objectContaining({ name: "Guinness Draught", priceNumeric: 14 })],
      reasons: [],
    } as ReturnType<typeof selectPublishableMapBaseRows>);

    expectSelectionParity(queueItem({
      extractedBeers: [beerRow({ priceNumeric: 7.99 })],
      overallConfidence: 0.71,
      sourceType: "menu_photo_upload",
      sourceUrl: "not a URL",
    }), {
      beers: [],
      reasons: [
        "source_type_not_reference",
        "not_baseline_menu_source",
        "low_overall_confidence",
        "no_usable_on_tap_pint_rows",
      ],
    });
  });

  it("accepts regular menu sources with clear on-tap pint prices", () => {
    const selected = selectPublishableMapBaseRows(queueItem());

    expect(selected.reasons).toEqual([]);
    expect(selected.beers).toEqual([
      expect.objectContaining({
        name: "Carlton Draught",
        priceNumeric: 13.5,
        availabilityStatus: "on_tap",
        availableOnTap: true,
        needsReview: false,
      }),
    ]);
  });

  it("rejects happy-hour and event sources unless explicitly allowed", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/drinks-menu",
      capturedNotes: "Discovery: homepage_link; happy hour page",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
    expect(isLikelyBaselineMenuSource(item, { allowHomepage: false, allowSpecialSources: true })).toBe(true);
  });

  it("does not accept generic images only because captured notes mention menu candidates", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/wp-content/uploads/logo.png",
      capturedNotes: "Menu source candidate. Text extraction is best-effort; review source before using any prices.",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
  });

  it("does not auto-publish direct raster menu image assets", () => {
    const item = queueItem({
      sourceUrl: "https://example.com/wp-content/uploads/2026/07/drinks-menu-1024x1024.png",
      capturedNotes: "Menu source candidate. Text extraction is best-effort; review source before using any prices.",
    });

    expect(isLikelyBaselineMenuSource(item)).toBe(false);
    expect(selectPublishableMapBaseRows(item).reasons).toContain("not_baseline_menu_source");
  });

  it("drops ambiguous duplicate prices for the same beer", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 11,
          priceText: "$11",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 14,
          priceText: "$14",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.beers).toEqual([]);
    expect(selected.reasons).toContain("ambiguous_duplicate_prices");
  });

  it("drops non-beer tap drinks while preserving valid beer rows", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Carlton Draught",
          servingSize: "pint",
          priceNumeric: 14,
          priceText: "$14 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Bulmers Original Cider",
          servingSize: "pint",
          priceNumeric: 15,
          priceText: "$15 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Brookvale Union Whisky & Dry",
          servingSize: "pint",
          priceNumeric: 18,
          priceText: "$18 pint",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.reasons).toEqual([]);
    expect(selected.beers).toEqual([
      expect.objectContaining({
        name: "Carlton Draught",
        priceNumeric: 14,
      }),
    ]);
  });

  it("rejects package-only, low-confidence, and special-price-looking rows", () => {
    const selected = selectPublishableMapBaseRows(queueItem({
      extractedBeers: [
        {
          name: "Guinness",
          servingSize: "pint",
          priceNumeric: 7,
          priceText: "$7",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Stone & Wood Pacific Ale",
          servingSize: "pint",
          priceNumeric: 16,
          priceText: "$16",
          availabilityStatus: "package_only",
          availableOnTap: false,
          availablePackageOnly: true,
          unavailableReason: "cans_or_bottles",
          confidence: 0.9,
          needsReview: true,
          notes: null,
        },
        {
          name: "Balter XPA",
          servingSize: "pint",
          priceNumeric: 15,
          priceText: "$15",
          availabilityStatus: "on_tap",
          availableOnTap: true,
          availablePackageOnly: false,
          unavailableReason: null,
          confidence: 0.7,
          needsReview: true,
          notes: null,
        },
      ],
    }));

    expect(selected.beers).toEqual([]);
    expect(selected.reasons).toContain("no_usable_on_tap_pint_rows");
  });
});
