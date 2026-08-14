import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("environment example contract", () => {
  it("documents every application environment variable exactly once", () => {
    const envSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/config/env.ts"),
      "utf8",
    );
    const schemaStart = envSource.indexOf("const envSchema = z.object({");
    const schemaEnd = envSource.indexOf("\n});", schemaStart);
    expect(schemaStart).toBeGreaterThan(-1);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    const schemaKeys = [...envSource.slice(schemaStart, schemaEnd).matchAll(
      /^  ([A-Z][A-Z0-9_]+):/gm,
    )].map((match) => match[1]);

    const example = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");
    const exampleKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1]);
    expect(new Set(exampleKeys).size).toBe(exampleKeys.length);
    expect(schemaKeys.length).toBeGreaterThan(100);
    expect(schemaKeys.filter((key) => !exampleKeys.includes(key))).toEqual([]);
    expect(example).toContain("TARGET_BEER=guinness");
    expect(example).toContain("DATABASE_MAINTENANCE_URL=");
  });
});
