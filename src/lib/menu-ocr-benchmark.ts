import { normalizeBeerSearchKey } from "../constants/beers.js";

export interface OcrBenchmarkBeer {
  name: string;
  aliases?: string[];
  brewery?: string | null;
  abv?: number | null;
  priceNumeric?: number | null;
  availabilityStatus?: "on_tap" | "package_only" | "unavailable" | "unknown";
}

export interface OcrBenchmarkObservedBeer {
  name: string;
  brewery?: string | null;
  abv?: number | null;
  priceNumeric?: number | null;
  availabilityStatus?: "on_tap" | "package_only" | "unavailable" | "unknown";
}

export interface OcrBenchmarkCase {
  id: string;
  venueName: string;
  sources?: string[];
  expected: OcrBenchmarkBeer[];
  forbiddenNames?: string[];
  observed?: OcrBenchmarkObservedBeer[];
  observedModel?: string;
  durationMs?: number;
}

export interface OcrBenchmarkThresholds {
  overall: number;
  rowRecall: number;
  rowPrecision: number;
  canonicalNames: number;
  prices: number;
  availability: number;
  nonBeerRejection: number;
}

export interface OcrBenchmarkManifest {
  version: number;
  mode: "scorer_fixture" | "labelled_corpus";
  thresholds: OcrBenchmarkThresholds;
  cases: OcrBenchmarkCase[];
}

interface MetricCount {
  correct: number;
  total: number;
}

export interface OcrBenchmarkScores {
  overall: number;
  rowRecall: number;
  rowPrecision: number;
  canonicalNames: number;
  prices: number;
  availability: number;
  abv: number;
  brewery: number;
  nonBeerRejection: number;
}

export interface OcrBenchmarkReport {
  passed: boolean;
  mode: OcrBenchmarkManifest["mode"];
  caseCount: number;
  scores: OcrBenchmarkScores;
  thresholds: OcrBenchmarkThresholds;
  failures: string[];
  cases: Array<{
    id: string;
    venueName: string;
    expectedRows: number;
    observedRows: number;
    missingNames: string[];
    unexpectedNames: string[];
    forbiddenNamesFound: string[];
  }>;
}

const metric = (count: MetricCount): number => count.total === 0 ? 1 : count.correct / count.total;

function normalizedNames(beer: OcrBenchmarkBeer): Set<string> {
  return new Set([beer.name, ...(beer.aliases ?? [])].map(normalizeBeerSearchKey).filter(Boolean));
}

function nearlyEqual(left: number | null | undefined, right: number | null | undefined, tolerance: number): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) <= tolerance;
}

export function scoreOcrBenchmark(manifest: OcrBenchmarkManifest): OcrBenchmarkReport {
  const rowRecall: MetricCount = { correct: 0, total: 0 };
  const rowPrecision: MetricCount = { correct: 0, total: 0 };
  const canonicalNames: MetricCount = { correct: 0, total: 0 };
  const prices: MetricCount = { correct: 0, total: 0 };
  const availability: MetricCount = { correct: 0, total: 0 };
  const abv: MetricCount = { correct: 0, total: 0 };
  const brewery: MetricCount = { correct: 0, total: 0 };
  const nonBeerRejection: MetricCount = { correct: 0, total: 0 };
  const caseReports: OcrBenchmarkReport["cases"] = [];

  for (const benchmarkCase of manifest.cases) {
    const observed = benchmarkCase.observed ?? [];
    const usedObserved = new Set<number>();
    const missingNames: string[] = [];

    for (const expected of benchmarkCase.expected) {
      rowRecall.total += 1;
      canonicalNames.total += 1;
      if (expected.priceNumeric !== undefined) prices.total += 1;
      if (expected.availabilityStatus !== undefined) availability.total += 1;
      if (expected.abv !== undefined) abv.total += 1;
      if (expected.brewery !== undefined) brewery.total += 1;

      const acceptedNames = normalizedNames(expected);
      const observedIndex = observed.findIndex((candidate, index) =>
        !usedObserved.has(index) && acceptedNames.has(normalizeBeerSearchKey(candidate.name)),
      );
      if (observedIndex < 0) {
        missingNames.push(expected.name);
        continue;
      }

      usedObserved.add(observedIndex);
      rowRecall.correct += 1;
      const candidate = observed[observedIndex]!;

      if (normalizeBeerSearchKey(candidate.name) === normalizeBeerSearchKey(expected.name)) canonicalNames.correct += 1;

      if (expected.priceNumeric !== undefined) {
        if (nearlyEqual(candidate.priceNumeric, expected.priceNumeric, 0.01)) prices.correct += 1;
      }
      if (expected.availabilityStatus !== undefined) {
        if (candidate.availabilityStatus === expected.availabilityStatus) availability.correct += 1;
      }
      if (expected.abv !== undefined) {
        if (nearlyEqual(candidate.abv, expected.abv, 0.05)) abv.correct += 1;
      }
      if (expected.brewery !== undefined) {
        if (normalizeBeerSearchKey(candidate.brewery) === normalizeBeerSearchKey(expected.brewery)) brewery.correct += 1;
      }
    }

    rowPrecision.total += observed.length;
    rowPrecision.correct += usedObserved.size;
    const unexpectedNames = observed
      .filter((_candidate, index) => !usedObserved.has(index))
      .map((candidate) => candidate.name);
    const observedNameKeys = new Set(observed.map((beer) => normalizeBeerSearchKey(beer.name)));
    const forbiddenNamesFound = (benchmarkCase.forbiddenNames ?? [])
      .filter((name) => observedNameKeys.has(normalizeBeerSearchKey(name)));
    nonBeerRejection.total += benchmarkCase.forbiddenNames?.length ?? 0;
    nonBeerRejection.correct += (benchmarkCase.forbiddenNames?.length ?? 0) - forbiddenNamesFound.length;

    caseReports.push({
      id: benchmarkCase.id,
      venueName: benchmarkCase.venueName,
      expectedRows: benchmarkCase.expected.length,
      observedRows: observed.length,
      missingNames,
      unexpectedNames,
      forbiddenNamesFound,
    });
  }

  const scores: OcrBenchmarkScores = {
    rowRecall: metric(rowRecall),
    rowPrecision: metric(rowPrecision),
    canonicalNames: metric(canonicalNames),
    prices: metric(prices),
    availability: metric(availability),
    abv: metric(abv),
    brewery: metric(brewery),
    nonBeerRejection: metric(nonBeerRejection),
    overall: 0,
  };
  scores.overall =
    scores.rowRecall * 0.3 +
    scores.rowPrecision * 0.15 +
    scores.canonicalNames * 0.1 +
    scores.prices * 0.2 +
    scores.availability * 0.1 +
    scores.abv * 0.05 +
    scores.brewery * 0.02 +
    scores.nonBeerRejection * 0.08;

  const failures = (Object.entries(manifest.thresholds) as Array<[keyof OcrBenchmarkThresholds, number]>)
    .filter(([key, threshold]) => scores[key] < threshold)
    .map(([key, threshold]) => `${key} ${(scores[key] * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%`);
  if (manifest.cases.length === 0) {
    failures.unshift("OCR benchmark corpus must contain at least one case");
  }
  const requiredCoverage: Array<[string, MetricCount]> = [
    ["expected beer rows", rowRecall],
    ["price labels", prices],
    ["availability labels", availability],
    ["ABV labels", abv],
    ["brewery labels", brewery],
    ["forbidden non-beer candidates", nonBeerRejection],
  ];
  for (const [label, count] of requiredCoverage) {
    if (count.total === 0) {
      failures.push(`OCR benchmark corpus has no ${label}`);
    }
  }

  return {
    passed: failures.length === 0,
    mode: manifest.mode,
    caseCount: manifest.cases.length,
    scores,
    thresholds: manifest.thresholds,
    failures,
    cases: caseReports,
  };
}
