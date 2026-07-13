import { describe, expect, it } from "vitest";

import { scoreOcrBenchmark, type OcrBenchmarkManifest } from "../src/lib/menu-ocr-benchmark.js";

const thresholds = {
  overall: 0.9,
  rowRecall: 0.9,
  rowPrecision: 0.9,
  canonicalNames: 0.9,
  prices: 0.9,
  availability: 0.9,
  nonBeerRejection: 1,
};

describe("menu OCR benchmark scoring", () => {
  it("passes exact labelled extraction results", () => {
    const manifest: OcrBenchmarkManifest = {
      version: 1,
      mode: "labelled_corpus",
      thresholds,
      cases: [{
        id: "exact",
        venueName: "Test Hotel",
        expected: [{ name: "Guinness", priceNumeric: 14, availabilityStatus: "on_tap", abv: 4.2 }],
        forbiddenNames: ["Scotch Fillet"],
        observed: [{ name: "Guinness", priceNumeric: 14, availabilityStatus: "on_tap", abv: 4.2 }],
      }],
    };

    const report = scoreOcrBenchmark(manifest);
    expect(report.passed).toBe(true);
    expect(report.scores.overall).toBe(1);
  });

  it("fails pot prices, missing rows, and food false positives", () => {
    const manifest: OcrBenchmarkManifest = {
      version: 1,
      mode: "labelled_corpus",
      thresholds,
      cases: [{
        id: "regression",
        venueName: "Test Hotel",
        expected: [
          { name: "Guinness", priceNumeric: 14, availabilityStatus: "on_tap" },
          { name: "Carlton Draught", priceNumeric: 13, availabilityStatus: "on_tap" },
        ],
        forbiddenNames: ["Premium T-bone"],
        observed: [
          { name: "Guinness", priceNumeric: 8, availabilityStatus: "unknown" },
          { name: "Premium T-bone", priceNumeric: 30, availabilityStatus: "unknown" },
        ],
      }],
    };

    const report = scoreOcrBenchmark(manifest);
    expect(report.passed).toBe(false);
    expect(report.cases[0]).toEqual(expect.objectContaining({
      missingNames: ["Carlton Draught"],
      unexpectedNames: ["Premium T-bone"],
      forbiddenNamesFound: ["Premium T-bone"],
    }));
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("prices"),
      expect.stringContaining("availability"),
      expect.stringContaining("nonBeerRejection"),
    ]));
  });
});
