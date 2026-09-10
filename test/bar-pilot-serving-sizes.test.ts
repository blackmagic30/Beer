import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync("viewer/index.html", "utf8");
const source = html.slice(html.indexOf("    function getBusinessBeerKey(record)"), html.indexOf("    function isPackagedBusinessServing"));
const context = vm.createContext({ toSearchKey: (value: unknown) => String(value).trim().toLowerCase() });
vm.runInContext(source, context);
function key(record: unknown): string {
  context.record = record;
  return vm.runInContext("getBusinessBeerKey(record)", context) as string;
}

describe("public pilot serving sizes", () => {
  it("preserves the existing pint key, including unspecified legacy pint records", () => {
    expect(key({ normalizedBeerId: "guinness", servingSize: "pint" })).toBe("guinness");
    expect(key({ normalizedBeerId: "guinness" })).toBe("guinness");
  });
  it("keeps pint, pot and schooner prices as independent rows instead of overwriting one beer", () => {
    const prices = [
      { normalizedBeerId: "guinness", servingSize: "pint", price: 14.5 },
      { normalizedBeerId: "guinness", servingSize: "pot", price: 8.5 },
      { normalizedBeerId: "guinness", servingSize: "schooner", price: 11 },
    ];
    const rows = Object.fromEntries(prices.map((record) => [key(record), record]));
    expect(Object.keys(rows)).toHaveLength(3);
    expect(Object.values(rows).map((record) => record.price)).toEqual([14.5, 8.5, 11]);
    expect(key({ normalizedBeerId: "guinness", servingSize: "pot", price: 9 })).toBe(key(prices[1]));
  });
});
