import { describe, expect, it } from "vitest";

import { canonicalizeTrackedBeerName } from "../src/constants/beers.js";
import { crawlerQueueDuplicateKey, crawlerQueueRowKey, crawlerQueueRowOverlapRatio } from "../src/lib/menu-source-dedupe.js";
import { extractOnTapCardRowsFromHtml, extractStructuredBeerRowsFromText } from "../src/lib/menu-text-extraction.js";

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
    expect(byName.get("Carlton Draught")?.notes).toContain("ABV: 4.6%");
  });

  it("canonicalises Royal Derby style Great Northern spelling", () => {
    expect(canonicalizeTrackedBeerName("Great Northern Supercrisp")).toBe("Great Northern Super Crisp");
  });

  it("uses Australian tins and later ON TAP headings for simple PDF rows", () => {
    const savingGraceText = [
      "TINS & BOTTLES",
      "LAGER",
      "Asahi Super Dry Mid-Strength 13",
      "Asahi - Japan - 3.5%",
      "Asahi Super Dry 14",
      "Asahi - Japan - 5%",
      "Pabst Blue Ribbon 15",
      "Pabst Brewing Co - Irwindale, USA - 4.7%",
      "Heaps Normal XPA 10",
      "Heaps Normal - Marrickville, NSW <0.5%",
      "ON TAP Rotating Specials Tap",
      "Ask staff for details.",
      "Pacific Ale 9/16.5",
      "Stone & Wood - Byron Bay, NSW 4.4%",
      "Status Quo Hazy Pale 9/16.5",
      "Mountain Culture - Katoomba, NSW 5.2%",
      "Cult IPA 10/17.5",
      "Mountain Culture - Katoomba, NSW 6.2%",
      "Flemington Lager 7.5/14",
      "Bonehead - Kensington, VIC 4.7%",
      "Guinness /16",
      "Guinness - Ireland 4.2%",
      "RED WINE",
      "Punt Road Shiraz 14/56",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(savingGraceText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Asahi Super Dry Mid-Strength")).toEqual(expect.objectContaining({
      priceNumeric: 13,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Pabst Blue Ribbon")).toEqual(expect.objectContaining({
      priceNumeric: 15,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Heaps Normal XPA")).toEqual(expect.objectContaining({
      priceNumeric: 10,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Stone & Wood Pacific Ale")).toEqual(expect.objectContaining({
      priceNumeric: 16.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Stone & Wood Pacific Ale")?.notes).toContain("Beer details: Stone & Wood - Byron Bay, NSW 4.4%");
    expect(byName.get("Stone & Wood Pacific Ale")?.notes).toContain("ABV: 4.4%");
    expect(byName.get("Mountain Culture Status Quo Hazy Pale")).toEqual(expect.objectContaining({
      priceNumeric: 16.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Mountain Culture Cult IPA")).toEqual(expect.objectContaining({
      priceNumeric: 17.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Mountain Culture Cult IPA")?.notes).toContain("Beer details: Mountain Culture - Katoomba, NSW 6.2%");
    expect(byName.get("Bonehead Flemington Lager")).toEqual(expect.objectContaining({
      priceNumeric: 14,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Guinness")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      availabilityStatus: "on_tap",
    }));
    expect(byName.has("Punt Road Shiraz")).toBe(false);
    expect(canonicalizeTrackedBeerName("conehead flemington lager")).toBe("Bonehead Flemington Lager");
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

  it("reads Rooftop Bar style HTML table text without drifting into spirits", () => {
    const rooftopText = [
      "Beer",
      "Cocktails",
      "Wine",
      "Spirits",
      "Happy",
      "Hour",
      "Guinness Pint $10",
      "Beer",
      "On Tap",
      "Pot",
      "Pint",
      "Jug",
      "Hahn Superdry 3.5% NSW",
      "$7",
      "$14",
      "$40",
      "Napoleone Apple Cider 4.7% Coldstream",
      "$8",
      "$16",
      "$46",
      "Furphy Refreshing Ale 4.4% Geelong",
      "$8",
      "$16",
      "$46",
      "Stone & Wood Pacific Ale 4.4% NSW",
      "$8",
      "$16",
      "$46",
      "Little Creatures Pale Ale 5.2% Geelong",
      "$8",
      "$16",
      "$46",
      "Guinness Stout 4.2% Ireland",
      "$9",
      "$18",
      "Heineken 5.0% Netherlands",
      "$9",
      "$18",
      "$52",
      "Kirin Ichiban 5.0% Japan",
      "$9",
      "$18",
      "$52",
      "Kirin Hyoketsu 4.0% Japan",
      "$9",
      "$18",
      "$52",
      "Spirits",
      "Gin",
      "Tanqueray $12",
      "Poor Tom's Sydney Dry $14",
      "Archie Rose Signature Dry $14",
      "Four Pillars Rare Dry $14",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(rooftopText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Hahn Super Dry")).toEqual(expect.objectContaining({
      priceNumeric: 14,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Napoleone Apple Cider")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Furphy Refreshing Ale")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Stone & Wood Pacific Ale")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Little Creatures Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Guinness Stout")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Heineken")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Kirin Ichiban")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Kirin Hyoketsu")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.has("Poor Tom's Sydney Dry")).toBe(false);
    expect(byName.has("Archie Rose Signature Dry")).toBe(false);
    expect(byName.has("Four Pillars Rare Dry")).toBe(false);
  });

  it("uses pint prices rather than ABV from structured on-tap website cards", () => {
    const steamPacketHtml = `
      <div class="collection-item w-dyn-item">
        <div class="w-layout-grid sp-grid-whats-on">
          <div class="sp_on-tap_name">Steam Packet Draught</div>
          <div class="sp_on-tap_brewery">Hop Nation</div>
          <div class="w-layout-vflex sp_on-tap_details-flex">
            <div><div class="sp-on-tap-abv">4.2</div><div class="sp-on-tap-abv">%</div></div>
            <div class="sp-on-tap-style">Draught</div>
          </div>
          <div class="w-layout-vflex sp-on-tap-prices-flex">
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pot </div><div class="sp-on-tap-style">$5</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Schooner </div><div class="sp-on-tap-style">$8</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pint </div><div class="sp-on-tap-style">$10</div></div>
          </div>
        </div>
      </div>
      <div class="collection-item w-dyn-item">
        <div class="w-layout-grid sp-grid-whats-on">
          <div class="sp_on-tap_name">Birra Moretti</div>
          <div class="sp_on-tap_brewery">Moretti</div>
          <div class="w-layout-vflex sp_on-tap_details-flex">
            <div><div class="sp-on-tap-abv">4.6</div><div class="sp-on-tap-abv">%</div></div>
            <div class="sp-on-tap-style">Lager</div>
          </div>
          <div class="w-layout-vflex sp-on-tap-prices-flex">
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pot </div><div class="sp-on-tap-style">$8.50</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Schooner </div><div class="sp-on-tap-style">$14.00</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pint </div><div class="sp-on-tap-style">$17.00</div></div>
          </div>
        </div>
      </div>
      <div class="collection-item w-dyn-item">
        <div class="w-layout-grid sp-grid-whats-on">
          <div class="sp_on-tap_name">Balter XPA</div>
          <div class="sp_on-tap_brewery">Balter</div>
          <div class="w-layout-vflex sp_on-tap_details-flex">
            <div><div class="sp-on-tap-abv">5</div><div class="sp-on-tap-abv">%</div></div>
            <div class="sp-on-tap-style">XPA</div>
          </div>
          <div class="w-layout-vflex sp-on-tap-prices-flex">
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pot </div><div class="sp-on-tap-style">$8.00</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Schooner </div><div class="sp-on-tap-style">$13.00</div></div>
            <div class="sp-on-tap-price-item"><div class="sp-on-tap-price-size">Pint </div><div class="sp-on-tap-style">$16.00</div></div>
          </div>
        </div>
      </div>
    `;

    const rows = extractOnTapCardRowsFromHtml(steamPacketHtml);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Steam Packet Draught")).toEqual(expect.objectContaining({
      priceNumeric: 10,
      priceText: "$10",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Steam Packet Draught")?.notes).toContain("ABV: 4.2%");
    expect(byName.get("Birra Moretti")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      priceText: "$17",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Birra Moretti")?.notes).toContain("ABV: 4.6%");
    expect(byName.get("Balter XPA")).toEqual(expect.objectContaining({
      priceNumeric: 16,
      priceText: "$16",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Balter XPA")?.notes).toContain("ABV: 5%");
    expect(rows.some((row) => row.priceNumeric === 4.2 || row.priceNumeric === 4.6 || row.priceNumeric === 5)).toBe(false);
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
