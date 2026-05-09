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
    expect(logic.getMarkerColor(unknownBeer)).toBe("#64748b");
    expect(logic.getMarkerLabel(unknownBeer)).toBe("?");
  });
});
