import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import dotenv from "dotenv";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { scoreOcrBenchmark, type OcrBenchmarkManifest } from "../src/lib/menu-ocr-benchmark.js";
import { AdminService } from "../src/modules/admin/admin.service.js";

dotenv.config();

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function fileDataUrl(filename: string): { kind: "image" | "document"; dataUrl: string } {
  const extension = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".pdf": "application/pdf",
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error(`Unsupported OCR benchmark source type: ${extension || filename}`);
  return {
    kind: extension === ".pdf" ? "document" : "image",
    dataUrl: `data:${mimeType};base64,${fs.readFileSync(filename).toString("base64")}`,
  };
}

const manifestPath = path.resolve(argumentValue("--manifest") ?? "test/fixtures/ocr-benchmark-scorer.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as OcrBenchmarkManifest;
const live = process.argv.includes("--live");

if (live) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for a live OCR benchmark.");
  if (manifest.mode !== "labelled_corpus") {
    throw new Error("Live OCR benchmarks require a manifest with mode labelled_corpus.");
  }

  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  const service = new AdminService(
    undefined,
    undefined,
    undefined,
    "venue_menu_captures",
    process.env.OPENAI_API_KEY,
    undefined,
    database,
  );
  const manifestDirectory = path.dirname(manifestPath);
  for (const benchmarkCase of manifest.cases) {
    if (!benchmarkCase.sources?.length) throw new Error(`${benchmarkCase.id} has no source files.`);
    const sources = benchmarkCase.sources.map((source) => fileDataUrl(path.resolve(manifestDirectory, source)));
    const result = await service.ocrMenuPhotos({
      venueNameHint: benchmarkCase.venueName,
      imageDataUrls: sources.filter((source) => source.kind === "image").map((source) => source.dataUrl),
      documentDataUrls: sources.filter((source) => source.kind === "document").map((source) => source.dataUrl),
    });
    benchmarkCase.observed = result.beers.map((beer) => ({
      name: beer.name,
      brewery: beer.brewery,
      abv: beer.abv,
      priceNumeric: beer.priceNumeric,
      availabilityStatus: beer.availabilityStatus,
    }));
  }
}

const outputPath = argumentValue("--write-results");
if (outputPath) fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);

const report = scoreOcrBenchmark(manifest);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
