import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function loadMapLogic() {
  const script = fs.readFileSync(path.resolve(process.cwd(), "viewer/map-logic.js"), "utf8");
  const context = {
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return (context.window as { MelbBeerMapLogic: unknown }).MelbBeerMapLogic;
}

describe("viewer map price logic", () => {
  const logic = loadMapLogic() as {
    normalizeBeerPriceNumeric: (source: Record<string, unknown>) => number | null;
    getAvailabilityLabel: (source: Record<string, unknown>) => string;
    getBeerPriceText: (source: Record<string, unknown>, label: string, price: number | null) => string;
    hasNumericPrice: (beer: Record<string, unknown>) => boolean;
    getLowestKnownPrice: (beers: Array<Record<string, unknown>>) => number | null;
    isUnderPriceThreshold: (beers: Array<Record<string, unknown>>, threshold: number) => boolean;
    getMarkerColor: (beer: Record<string, unknown>) => string;
    getMarkerLabel: (beer: Record<string, unknown>) => string;
    getPriceTier: (beer: Record<string, unknown>) => string;
    getMarkerState: (beer: Record<string, unknown> | null, options?: Record<string, unknown>) => string;
    getMarkerVisual: (beer: Record<string, unknown> | null, options?: Record<string, unknown>) => {
      state: string;
      fillColor: string;
      strokeColor: string;
      labelText: string;
      scale: number;
      selected?: boolean;
    };
    getClusterVisual: (count: number) => {
      fillColor: string;
      strokeColor: string;
      labelColor: string;
      scale: number;
    };
  };

  it("does not convert unknown, zero, unavailable, or off-tap prices into cheap numeric prices", () => {
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: null })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: 0 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "unknown", price_numeric: 8 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "unavailable", price_numeric: 8 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: 9 })).toBe(9);
  });

  it("renders unknown selected-beer prices as unknown rather than $0 or cheap", () => {
    const source = { availability_status: "on_tap", price_text: "$0", price_numeric: null };
    const label = logic.getAvailabilityLabel(source);
    const price = logic.normalizeBeerPriceNumeric(source);

    expect(label).toBe("On tap");
    expect(price).toBeNull();
    expect(logic.getBeerPriceText(source, label, price)).toBe("Price unknown");
  });

  it("excludes unknown prices from cheapest and under-threshold calculations", () => {
    const beers = [
      { label: "Guinness", priceNumeric: null, availabilityLabel: "On tap" },
      { label: "Carlton Draught", priceNumeric: 11, availabilityLabel: "On tap" },
      { label: "Stone & Wood", priceNumeric: undefined, availabilityLabel: "Unknown" },
    ];

    expect(logic.getLowestKnownPrice(beers)).toBe(11);
    expect(logic.isUnderPriceThreshold(beers, 10)).toBe(false);
    expect(logic.isUnderPriceThreshold(beers, 12)).toBe(true);
    expect(logic.getLowestKnownPrice([{ priceNumeric: null }, { priceNumeric: 0 }])).toBeNull();
  });

  it("keeps unknown price markers neutral instead of green", () => {
    const unknownBeer = { priceNumeric: null, availabilityLabel: "On tap" };

    expect(logic.hasNumericPrice(unknownBeer)).toBe(false);
    expect(logic.getPriceTier(unknownBeer)).toBe("unknown");
    expect(logic.getMarkerColor(unknownBeer)).not.toBe("#15803d");
    expect(logic.getMarkerColor(unknownBeer)).toBe("#475569");
    expect(logic.getMarkerLabel(unknownBeer)).toBe("?");
  });

  it("maps price and data states to distinct marker visuals", () => {
    const cheap = { priceNumeric: 10, availabilityLabel: "On tap" };
    const mid = { priceNumeric: 14, availabilityLabel: "On tap" };
    const expensive = { priceNumeric: 19, availabilityLabel: "On tap" };
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };

    expect(logic.getMarkerState(cheap)).toBe("cheap");
    expect(logic.getMarkerVisual(cheap).fillColor).toBe("#15803d");
    expect(logic.getMarkerState(mid)).toBe("mid");
    expect(logic.getMarkerVisual(mid).fillColor).toBe("#d97706");
    expect(logic.getMarkerState(expensive)).toBe("expensive");
    expect(logic.getMarkerVisual(expensive).fillColor).toBe("#b91c1c");
    expect(logic.getMarkerState(unknown)).toBe("unknown");
    expect(logic.getMarkerVisual(unknown).fillColor).toBe("#475569");
    expect(logic.getMarkerVisual(null, { needsData: true }).state).toBe("needs_data");
    expect(logic.getMarkerVisual(null, { needsData: true }).fillColor).toBe("#2563eb");
  });

  it("gives selected markers a stronger gold ring without changing unknown into cheap", () => {
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };
    const base = logic.getMarkerVisual(unknown);
    const selected = logic.getMarkerVisual(unknown, { selected: true });

    expect(selected.selected).toBe(true);
    expect(selected.fillColor).toBe(base.fillColor);
    expect(selected.fillColor).not.toBe("#15803d");
    expect(selected.strokeColor).toBe("#f5c76b");
    expect(selected.scale).toBeGreaterThan(base.scale);
  });

  it("keeps locked prices distinct from unknown and cheap marker states", () => {
    const redacted = { priceNumeric: null, availabilityLabel: "On tap" };
    const locked = logic.getMarkerVisual(redacted, { locked: true });

    expect(locked.state).toBe("locked");
    expect(locked.fillColor).toBe("#7c3aed");
    expect(locked.labelText).toBe("$");
    expect(locked.fillColor).not.toBe("#15803d");
    expect(locked.fillColor).not.toBe("#475569");
  });

  it("keeps unavailable beer distinct from expensive verified pricing", () => {
    const unavailable = { priceNumeric: null, availabilityLabel: "Unavailable" };

    expect(logic.getMarkerState(unavailable)).toBe("unavailable");
    expect(logic.getMarkerVisual(unavailable).labelText).toBe("NO");
    expect(logic.getMarkerVisual(unavailable).strokeColor).toBe("#fecaca");
  });

  it("styles clusters with deliberate count tiers", () => {
    expect(logic.getClusterVisual(5).fillColor).toBe("#334155");
    expect(logic.getClusterVisual(12).fillColor).toBe("#1d4ed8");
    expect(logic.getClusterVisual(40).fillColor).toBe("#b45309");
    expect(logic.getClusterVisual(120).fillColor).toBe("#9f1239");
  });
});

describe("viewer map UI wiring", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");

  it("renders the polished marker legend and cluster renderer", () => {
    expect(html).toContain("legend__swatch--selected");
    expect(html).toContain("Unknown prices are shown separately");
    expect(html).toContain("renderer: clusterRenderer");
    expect(html).toContain("getClusterVisual(count)");
  });

  it("has distinct venue card row states for known, unknown, unavailable, package, and locked prices", () => {
    expect(html).toContain("beerPopup__beerRow--known");
    expect(html).toContain("beerPopup__beerRow--unknown");
    expect(html).toContain("beerPopup__beerRow--unavailable");
    expect(html).toContain("beerPopup__beerRow--package");
    expect(html).toContain("beerPopup__beerRow--locked");
    expect(html).not.toContain(">$0<");
  });
});
