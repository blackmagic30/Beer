import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeTrackedBeerName } from "../src/constants/beers.js";
import { crawlerQueueDuplicateKey, crawlerQueueRowKey, crawlerQueueRowOverlapRatio } from "../src/lib/menu-source-dedupe.js";
import { isTimeLimitedMenuSource } from "../src/lib/menu-source-filter.js";
import { selectLabeledPintPrice } from "../src/lib/menu-price-selection.js";
import { extractOnTapCardRowsFromHtml, extractStructuredBeerRowsFromText } from "../src/lib/menu-text-extraction.js";

describe("menu crawler extraction", () => {
  it("rejects happy-hour and specials pages as regular crawler price sources", () => {
    const rejectedSources = [
      "https://anglers-tavern.com.au/events/happy-hour/",
      "https://mollyrosebrewing.com/blogs/weekly-specials/25-marga-lager",
      "https://example.com/happy-hour",
      "https://example.com/specials",
      "https://example.com/whats-on",
      "https://example.com/offers/weeknight-pints",
    ];
    const allowedSources = [
      "https://example.com/menu",
      "https://example.com/drinks-menu",
      "https://example.com/bar-menu",
      "https://example.com/tap-list",
      "https://example.com/eat-drink",
      "https://example.com/events/beer-menu",
    ];

    rejectedSources.forEach((sourceUrl) => {
      expect(isTimeLimitedMenuSource(sourceUrl, "happy hour menu link")).toBe(true);
    });
    allowedSources.forEach((sourceUrl) => {
      expect(isTimeLimitedMenuSource(sourceUrl, "drink menu link")).toBe(false);
    });
  });

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

  it("uses pint prices when tap menus say pot, schooner and pint are available", () => {
    const strayNeighbourText = [
      "TAP BEER",
      "POT, SCHOONER AND PINT AVAILABLE",
      "STRAY LAGER BY TALLBOY & MOOSE 4.2% ABV $ 6 / $ 9 / $ 12",
      "HAWKERS STOUT 5.4% ABV $ 8 / $ 11 / $ 14",
      "STRAY PALE ALE BY TALLBOY & MOOSE 4.8% ABV $ 7 / $ 10 / $ 13",
      "HAWKERS IPA 6.2% ABV $10 / $15 / $17",
      "HAWKERS MIDWAY PALE ALE 3.5% $6 / $9 / $12",
      "WHITE BAY JAPANESE LAGER 4.3% $7 / $10 / $13",
      "TINS",
      "BETTER CIDER 4.2% ABV $11",
      "STOMPING GROUND PALE ALE $10",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(strayNeighbourText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("STRAY LAGER BY TALLBOY & MOOSE")).toEqual(expect.objectContaining({
      priceNumeric: 12,
      priceText: "$12",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("HAWKERS STOUT")).toEqual(expect.objectContaining({
      priceNumeric: 14,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("STRAY PALE ALE BY TALLBOY & MOOSE")).toEqual(expect.objectContaining({
      priceNumeric: 13,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("HAWKERS IPA")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("HAWKERS MIDWAY PALE ALE")).toEqual(expect.objectContaining({
      priceNumeric: 12,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("WHITE BAY JAPANESE LAGER")).toEqual(expect.objectContaining({
      priceNumeric: 13,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("BETTER CIDER")).toEqual(expect.objectContaining({
      priceNumeric: 11,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("STRAY LAGER BY TALLBOY & MOOSE")?.notes).toContain("Selected pint price from menu pour order.");
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

  it("does not turn package millilitre sizes into Botanical Hotel prices", () => {
    const botanicalText = [
      "ON TAP",
      "Mountain Goat Tasty Pale Ale 4.4%",
      "Richmond",
      "$9 POT, $18 PINT",
      "Stomping Ground Big Sky Hazy Pale Ale 4.3%",
      "Collingwood",
      "$8.5 POT, $17 PINT",
      "Fixation IPA 6.4%",
      "Hobart",
      "$9 POT, $18 PINT",
      "Guinness Stout 4.2%",
      "$9 POT, $18 PINT",
      "Hard Rated Lemon 4.5%",
      "$8.5 POT, $17 PINT",
      "CANS OR BOTTLES",
      "Stomping Ground Big Sky Hazy Pale Ale 335ml 4.3%",
      "Guinness Stout 440ml 4.2%",
      "Peroni 330ml 5.1%",
      "Asahi Super Dry 330ml 5%",
      "Carlton Zero 330ml 0%",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(botanicalText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Mountain Goat Tasty Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Stomping Ground Big Sky Hazy Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      priceText: "$17",
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Fixation IPA")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Guinness Stout")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Hard Rated Lemon")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      availabilityStatus: "on_tap",
    }));
    expect(rows.some((row) => [30, 35, 40].includes(row.priceNumeric ?? 0))).toBe(false);
    expect(rows.some((row) => /330ml|335ml|440ml/i.test(row.notes ?? ""))).toBe(false);
    expect(byName.has("Guinness Stout 4")).toBe(false);
    expect(byName.has("Peroni 3")).toBe(false);
    expect(byName.has("Carlton Zero 3")).toBe(false);
    expect(byName.has("Mountain Goat Lager")).toBe(false);
    expect(byName.has("Stomping Ground Gipps St Pale Ale")).toBe(false);
  });

  it("splits collapsed Botanical Hotel website rows before extracting prices", () => {
    const collapsedBotanicalText = [
      "ON TAP Carlton Draught 4.6% $8.5 POT, $17 PINT Abbotsford",
      "Asahi Super Dry 5% $9.5 POT, $19 PINT Abbotsford",
      "Stone & Wood Pacific Ale 4.5% $8.5 POT, $17 PINT Byron Bay",
      "Balter XPA 5% $9.5 POT, $18.5 PINT Currumbin",
      "Mountain Goat Tasty Pale Ale 4.4% $9 POT, $18 PINT Richmond",
      "Stomping Ground Big Sky Hazy Pale Ale 4.3% $8.5 POT, $17 PINT Collingwood",
      "Fixation IPA 6.4% $9 POT, $18 PINT Hobart",
      "Guinness Stout 4.2% $9 POT, $18 PINT",
      "Mountain Goat Hazy Apple Cider 5% $9.5 POT, $18.5 PINT Richmond",
      "Hard Rated Lemon 4.5% $8.5 POT, $17 PINT Australia",
      "Can 2 Brothers Kung Foo Rice Lager 4.6% $15 Moorabbin",
      "Peroni Red 4.7% $13 Italy",
    ].join(" ");

    const rows = extractStructuredBeerRowsFromText(collapsedBotanicalText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Mountain Goat Tasty Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Stomping Ground Big Sky Hazy Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Mountain Goat Hazy Apple Cider")).toEqual(expect.objectContaining({
      priceNumeric: 18.5,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("2 Brothers Kung Foo Rice Lager")).toEqual(expect.objectContaining({
      priceNumeric: 15,
      availabilityStatus: "package_only",
    }));
    expect(byName.get("Peroni Red")).toEqual(expect.objectContaining({
      priceNumeric: 13,
      availabilityStatus: "package_only",
    }));
    expect(byName.has("Tasty Pale Ale")).toBe(false);
    expect(byName.has("Big Sky Hazy Pale Ale")).toBe(false);
    expect(byName.has("Mountain Goat Lager")).toBe(false);
    expect(byName.has("Stomping Ground Gipps St Pale Ale")).toBe(false);
  });

  it("treats plain Tap headings as on-tap sections for website name-price-location rows", () => {
    const botanicalWebsiteText = [
      "Beer & Cider",
      "Tap",
      "Mountain Goat Tasty Pale Ale 4.4%",
      "$9 POT, $18 PINT",
      "Richmond",
      "Stomping Ground Big Sky Hazy Pale Ale 4.3%",
      "$8.5 POT, $17 PINT",
      "Collingwood",
      "Hazy Apple Cider 5%",
      "$9.5 POT, $18.5 PINT",
      "Richmond",
      "Lemon 4.5%",
      "$8.5 POT, $17 PINT",
      "Australia",
      "Can",
      "2 Brothers Kung Foo Rice Lager 4.6%",
      "$15",
      "Moorabbin",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(botanicalWebsiteText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("Mountain Goat Tasty Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 18,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("Stomping Ground Big Sky Hazy Pale Ale")).toEqual(expect.objectContaining({
      priceNumeric: 17,
      availabilityStatus: "on_tap",
    }));
    expect(byName.get("2 Brothers Kung Foo Rice Lager")).toEqual(expect.objectContaining({
      priceNumeric: 15,
      availabilityStatus: "package_only",
    }));
    expect(byName.has("Hazy Apple Cider")).toBe(false);
    expect(byName.has("Lemon")).toBe(false);
  });

  it("does not turn steak or food rows into crawler beer rows", () => {
    const blazedMenuText = [
      "Premium Northern Victorian T bone 30 day aged, MSA 6 grade",
      "Rib eye 300g grass fed 42",
      "Goat cheese tart 18",
      "Chicken schnitzel 26",
      "Carlton Draught Pint $11 / Schooner $9 / Pot $7",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(blazedMenuText);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.has("Premium Northern Victorian T bone")).toBe(false);
    expect(byName.has("Rib eye")).toBe(false);
    expect(byName.has("Goat cheese tart")).toBe(false);
    expect(byName.has("Chicken schnitzel")).toBe(false);
    expect(rows.some((row) => /t[-\s]?bone|rib[-\s]?eye|goat cheese|schnitzel|msa\s*\d?\s*grade|day aged/i.test(row.name))).toBe(false);
    expect(byName.get("Carlton Draught")).toEqual(expect.objectContaining({
      priceNumeric: 11,
      priceText: "$11",
      availabilityStatus: "on_tap",
    }));
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

  it("drops food, cocktail, event, and unreadable PDF noise from low-confidence sources", () => {
    const noisyText = [
      "Wedges, sour cream, sweet chilli (V, VGA) $14",
      "Stone & Wood Beer Battered Fish (1 piece) chips, salad, lemon, tartare $24",
      "COCKTAIL 20 - 80",
      "Baby Guinness 14.5",
      "Mini Beer 14.5",
      "Join us for Beer and Carols at the Wesley Anne on Saturday 14th December between 2.30pm and 4.30pm.",
      "Tallboy & Moose are hosting the ultimate Beer Olympics to celebrate their 7th birthday.",
      "A mixed case of all our current beers on offer: 6 Pack Lead Head Lager 6 Pack XPA 43 4 Pack Bayside IPA 4 Pack True Course Session Ale",
      "Our Beers XPA 43",
      "We pride ourselves on having something for everyone, with a range of wine available, plus 14 different draught beers to choose from and all your favourite spirits.",
      "$25 Marga & Lager Every Wednesday",
      "/blogs/weekly-specials/25-marga-lager#article",
      "https://mollyrosebrewing.com/blogs/weekly-specials/25-marga-lager",
      "https://cbco.beer/cdn/shop/files/CBCo_For-Australian-Tastes.jpg?v=1740976211&width=500",
      "https://cbco.beer/cdn/shop/articles/07-24_Future-Golf-Partnership-v3.jpg?v=1721193323&width=1920",
      "(400ml Tiger beer, 200g Fine sugar & 30g Fresh ginger) OR Honey with ginger $30",
      "We believe beer should be for everyone, so the 30 taps will pour a wide range of beer styles to suit all tastes, from laid-back easy drinkers to the more adventurous.",
      "With its beer garden sheltered by a retractable roof, cubby house and giant 30 tap bar, it's fast become the welcoming community hub.",
      "BOOKINGS At our Collingwood Beer Hall we take online reservations for groups of 2-20 guests.",
      "Menu Good food and good beer goes hand in hand with our huge range of 25+ tap beers, great wines and a cider.",
      "How many litres of beer were consumed? 6.5 million litres",
      "Enjoy your fave dish with a pot of beer or house wine for $25, every Monday-Friday from 12pm-3pm.",
      "Grab a beer, dig into a classic pub meal and dive into our 7 mouthwatering burgers, 9 irresistible parmas, and share plates.",
      "Hargreaves Hill As Advertised - Hazy IPA 440ml $40",
      "355ml 4.3% 15 Collingwood",
      "Stomping Ground Brewery and Beer Hall inside the airport's Terminal 3 is the first working brewery inside an airport in Australia.",
      "\u001ed0\u0019\u0082\u00f9\u00a1\u00b8\u00f5\u0080\u00a9$\u0017\u00beD0 \"Y`ALE\u00ecAHI\"I\"}\u00c1\u0095p\u00c4D\u00cc\u0098\u00c6\u0011\u00031b\u001aCz\u0093XL1\u0088&\u00bd0",
      "Vergina, Lager Makethonia, Greece.........................11",
    ].join("\n");

    const rows = extractStructuredBeerRowsFromText(noisyText);
    const names = rows.map((row) => row.name);

    expect(names).toContain("Vergina, Lager Makethonia, Greece");
    expect(names).not.toContain("Wedges, sour cream, sweet chilli (V, VGA)");
    expect(names).not.toContain("Stone & Wood Pacific Ale");
    expect(names).not.toContain("COCKTAIL");
    expect(names).not.toContain("Baby Guinness");
    expect(names).not.toContain("Mini Beer");
    expect(names).not.toContain("Pack Lead Head Lager");
    expect(names).not.toContain("XPA");
    expect(names).not.toContain("Our Beers XPA");
    expect(names).not.toContain("Draught");
    expect(names).not.toContain("Lager");
    expect(names.some((name) => /https?:|\/blogs|cdn\/shop|Tiger beer|Fine sugar|Fresh ginger|Beer Olympics|Beer and Carols|tap bar|BOOKINGS|litres|house wine|pub meal|mouthwatering|440ml|355ml|Terminal 3|ALE\u00ecAHI/i.test(name))).toBe(false);
    expect(names.some((name) => /we believe|for everyone|wide range|all tastes|drinkers|adventurous/i.test(name))).toBe(false);
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

  it("keeps OCR prompts from treating package sizes or ABV as prices", () => {
    const promptSources = [
      readFileSync(resolve(process.cwd(), "src/modules/admin/admin.service.ts"), "utf8"),
      readFileSync(resolve(process.cwd(), "scripts/discover-menu-sources.ts"), "utf8"),
    ];

    for (const source of promptSources) {
      expect(source).toContain("Never use package volume, serving size, ABV");
      expect(source).toContain("omit the row instead of inventing a price from the size");
      expect(source).toContain("choose the PINT price");
      expect(source).toContain("Read the whole image first");
      expect(source).toContain("Do not include gin, vodka, whisky");
      expect(source).toContain('detail: "high"');
      expect(source).toContain("second-pass quality check");
      expect(source).toContain("Proposed first-pass extraction JSON");
      expect(source).toContain("temperature: 0");
      expect(source).toContain("CANS OR BOTTLES");
    }
  });

  it("normalizes OCR-labelled pour prices to the pint value before queueing", () => {
    expect(selectLabeledPintPrice("$9.5 POT $15 PINT")).toEqual({
      priceNumeric: 15,
      priceText: "$15",
    });
    expect(selectLabeledPintPrice("Pot $8.5 Schooner $12 Pint $17 Jug $35")).toEqual({
      priceNumeric: 17,
      priceText: "$17",
    });
    expect(selectLabeledPintPrice("$6 / $9 / $12")).toEqual({
      priceNumeric: 12,
      priceText: "$12",
    });
    expect(selectLabeledPintPrice("9/16.5")).toEqual({
      priceNumeric: 16.5,
      priceText: "$16.50",
    });
    expect(selectLabeledPintPrice("/16")).toEqual({
      priceNumeric: 16,
      priceText: "$16",
    });
    expect(selectLabeledPintPrice("$11 bottle")).toBeNull();
  });
});
