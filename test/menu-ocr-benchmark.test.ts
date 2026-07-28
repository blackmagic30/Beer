import fs from "node:fs";

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
        expected: [{
          name: "Guinness",
          brewery: "Guinness",
          priceNumeric: 14,
          availabilityStatus: "on_tap",
          abv: 4.2,
        }],
        forbiddenNames: ["Scotch Fillet"],
        observed: [{
          name: "Guinness",
          brewery: "Guinness",
          priceNumeric: 14,
          availabilityStatus: "on_tap",
          abv: 4.2,
        }],
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

  it("counts every explicitly labelled field as wrong when its expected row is missing", () => {
    const manifest: OcrBenchmarkManifest = {
      version: 1,
      mode: "labelled_corpus",
      thresholds,
      cases: [{
        id: "missing-labelled-row",
        venueName: "Test Hotel",
        expected: [{
          name: "Guinness",
          brewery: "Guinness",
          abv: 4.2,
          priceNumeric: 14,
          availabilityStatus: "on_tap",
        }],
        observed: [],
      }],
    };

    const report = scoreOcrBenchmark(manifest);
    expect(report.passed).toBe(false);
    expect(report.scores).toEqual(expect.objectContaining({
      rowRecall: 0,
      canonicalNames: 0,
      prices: 0,
      availability: 0,
      abv: 0,
      brewery: 0,
    }));
  });

  it("fails an empty benchmark corpus even when zero-denominator metrics are perfect", () => {
    const report = scoreOcrBenchmark({
      version: 1,
      mode: "labelled_corpus",
      thresholds,
      cases: [],
    });

    expect(report.passed).toBe(false);
    expect(report.caseCount).toBe(0);
    expect(report.failures).toContain("OCR benchmark corpus must contain at least one case");
  });

  it("fails a corpus that has cases but no required price, availability, or rejection labels", () => {
    const report = scoreOcrBenchmark({
      version: 1,
      mode: "labelled_corpus",
      thresholds,
      cases: [{
        id: "labels-missing",
        venueName: "Test Hotel",
        expected: [{ name: "Guinness" }],
        observed: [{ name: "Guinness" }],
      }],
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      "OCR benchmark corpus has no price labels",
      "OCR benchmark corpus has no availability labels",
      "OCR benchmark corpus has no ABV labels",
      "OCR benchmark corpus has no brewery labels",
      "OCR benchmark corpus has no forbidden non-beer candidates",
    ]));
  });

  it("loads AdminService only after dotenv has initialized live benchmark configuration", () => {
    const source = fs.readFileSync(
      new URL("../scripts/benchmark-menu-ocr.ts", import.meta.url),
      "utf8",
    );
    const dotenvIndex = source.indexOf("dotenv.config({ quiet: true })");
    const adminServiceImportIndex = source.indexOf(
      'await import("../src/modules/admin/admin.service.js")',
    );

    expect(dotenvIndex).toBeGreaterThanOrEqual(0);
    expect(adminServiceImportIndex).toBeGreaterThan(dotenvIndex);
    expect(source).not.toContain(
      'import { AdminService } from "../src/modules/admin/admin.service.js"',
    );
  });
});
