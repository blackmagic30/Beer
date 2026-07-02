import { describe, expect, it } from "vitest";

import { canonicalizeTrackedBeerName } from "../src/constants/beers.js";
import { crawlerQueueDuplicateKey, crawlerQueueRowKey, crawlerQueueRowOverlapRatio } from "../src/lib/menu-source-dedupe.js";
import { extractStructuredBeerRowsFromText } from "../src/lib/menu-text-extraction.js";

describe("menu crawler extraction", () => {
  it("keeps dotted PDF menu rows paired with their own beer and pint price", () => {
    const royalDerbyText = [
      "DRINK",
      "ON TAP",
      "Pots / Pints / Jugs",
      "Carlton Draught (4.6%) ........................ 7.50 / 14.50 / 29 Melbourne Bitter (5%) ................. 8 / 15.50 / 31",
      "Lions Lager (4.2%) ............................ 7.5 / 15 / 30 Balter XPA (5%) ......................... 8.25 / 16.50 / 33",
      "Great Northern Supercrisp (3.5%) ............... 7 / 14 / 28 Balter Eazy Hazy (4%) .................... 8.5 / 17 / 34",
      "Mt Goat Pale Ale (4.4%) ........................ 8.25 / 16.50 / 33 Asahi (5%) ............................ 15 (400ml)",
      "Brookvale Whisky & Dry (4%) ..................... 9 / 18 / 36 Hard Rated Lemon (4.5%) .................. 9 / 18 / 36",
      "BOTTLES & CANS",
      "Victoria Bitter (4.9%) ......................... 8",
      "O’Briens GF Lager (3%) ......................... 9.5",
      "Heaps Normal Quiet XPA (0%) .................... 9",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(royalDerbyText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Carlton Draught")).toEqual(expect.objectContaining({
      priceNumeric: 14.5,
      priceText: "$14.50",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Melbourne Bitter")).toEqual(expect.objectContaining({
      priceNumeric: 15.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Balter XPA")).toEqual(expect.objectContaining({
      priceNumeric: 16.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Great Northern Super Crisp")).toEqual(expect.objectContaining({
      priceNumeric: 14,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Asahi Super Dry")).toEqual(expect.objectContaining({
      priceNumeric: 15,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Brookvale Union Whisky & Dry")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Hard Rated Lemon")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Victoria Bitter")).toEqual(expect.objectContaining({
      priceNumeric: 8,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("O'Brien's GF Lager")).toEqual(expect.objectContaining({
      priceNumeric: 9.5,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Heaps Normal Quiet XPA")).toEqual(expect.objectContaining({
      priceNumeric: 9,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Carlton Draught")?.notes).toContain("Section: ON TAP");
  });

  it("canonicalises Royal Derby style Great Northern spelling", () => {
    expect(canonicalizeTrackedBeerName("Great Northern Supercrisp")).toBe("Great Northern Super Crisp");
  });

  it("treats three-price pots/pints/jugs rows as on tap even when PDF columns leak headings", () => {
    const rows = extractStructuredBeerRowsFromText(
      "BOTTLES & CANS WHITE SPARKLING & ROSE Carlton Draught (4.6%) .............. 7.50 / 14.50 / 29 ON TAP Carlton Draught (4.6%) .............. 7.50 / 14.50 / 29",
    );
    const carltonRows = rows.filter((row) => row.name === "Carlton Draught");

    expect(carltonRows).toHaveLength(1);
    expect(carltonRows[0]).toEqual(expect.objectContaining({
      priceNumeric: 14.5,
      availabilityStatus: "on_tap",
    }));
  });

  it("uses venue name and source URL to catch duplicate queue candidates across venue ids", () => {
    const first = crawlerQueueDuplicateKey({
      venueName: "Royal Derby Hotel",
      sourceUrl: "https://royalderbyhotel.com.au/wp-content/uploads/2026/01/Royal-Derby-Hotel-Drink-Menu.pdf",
    });
    const second = crawlerQueueDuplicateKey({
      venueName: " royal derby hotel ",
      sourceUrl: "http://www.royalderbyhotel.com.au/wp-content/uploads/2026/01/Royal-Derby-Hotel-Drink-Menu.pdf#page=1",
    });

    expect(second).toBe(first);
  });

  it("detects mostly repeated venue rows so combined menus do not duplicate review work", () => {
    const drinkMenuRows = [
      { name: "Carlton Draught", priceNumeric: 14.5, priceText: "$14.50", availabilityStatus: "on_tap" },
      { name: "Balter XPA", priceNumeric: 16.5, priceText: "$16.50", availabilityStatus: "on_tap" },
      { name: "Great Northern Super Crisp", priceNumeric: 14, priceText: "$14", availabilityStatus: "on_tap" },
      { name: "Victoria Bitter", priceNumeric: 8, priceText: "$8", availabilityStatus: "package_only" },
    ];
    const combinedMenuRows = [
      { name: "Carlton Draught", priceNumeric: 14.5, priceText: "$14.50", availabilityStatus: "on_tap" },
      { name: "Balter XPA", priceNumeric: 16.5, priceText: "$16.50", availabilityStatus: "on_tap" },
      { name: "Great Northern Super Crisp", priceNumeric: 14, priceText: "$14", availabilityStatus: "on_tap" },
    ];
    const existing = new Set(drinkMenuRows.map(crawlerQueueRowKey));

    expect(crawlerQueueRowOverlapRatio(existing, combinedMenuRows)).toBe(1);
    expect(crawlerQueueRowOverlapRatio(existing, [
      ...combinedMenuRows,
      { name: "New Local Lager", priceNumeric: 12, priceText: "$12", availabilityStatus: "on_tap" },
    ])).toBe(0.75);
  });
});
