import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const validator = path.resolve(root, "scripts/validate-release-evidence.ts");
const source = JSON.parse(fs.readFileSync(path.resolve(root, "docs/release-evidence.json"), "utf8")) as {
  version: number;
  items: Array<Record<string, unknown>>;
};
const temporaryDirectories: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function allPassed(): typeof source {
  const value = clone(source);
  value.items = value.items.map((item) => ({
    ...item,
    status: "pass",
    evidence: `PP-${String(item.id)}`,
    verifiedAt: "2026-07-14T10:00:00.000Z",
    verifiedBy: "Release Owner, verifier",
  }));
  return value;
}

function validate(value: unknown, strict = false): { status: number | null; output: Record<string, unknown>; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-release-evidence-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "evidence.json");
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`);
  const result = spawnSync(
    process.execPath,
    ["--import=tsx", validator, ...(strict ? ["--strict"] : [])],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_EVIDENCE_PATH: filename },
    },
  );
  return {
    status: result.status,
    output: JSON.parse(result.stdout) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release evidence validator", () => {
  it("keeps valid pending evidence informational in normal mode and blocking in strict mode", () => {
    const normal = validate(source);
    const strict = validate(source, true);

    expect(normal.status).toBe(0);
    expect(normal.output).toMatchObject({ valid: true, launchReady: false, strict: false });
    expect(strict.status).toBe(1);
    expect(strict.output).toMatchObject({ valid: true, launchReady: false, strict: true });
  });

  it("accepts a complete evidence file only when every required item has supported proof", () => {
    const result = validate(allPassed(), true);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.output).toMatchObject({ valid: true, launchReady: true, strict: true });
  });

  it("keeps failed and not-applicable required gates launch-blocking", () => {
    for (const status of ["fail", "not_applicable"]) {
      const value = allPassed();
      value.items[0] = { ...value.items[0], status };
      const result = validate(value, true);
      expect(result.status, status).toBe(1);
      expect(result.output).toMatchObject({ valid: true, launchReady: false });
    }
  });

  it("rejects malformed schemas, gate drift, unsupported proof, and impossible timestamps in both modes", () => {
    const missing = clone(source);
    missing.items = missing.items.slice(1);
    const duplicate = clone(source);
    duplicate.items.push(clone(duplicate.items[0]!));
    const unexpected = clone(source);
    unexpected.items.push({
      id: "unreviewed_gate",
      label: "Unexpected launch gate",
      required: false,
      status: "pending",
      evidence: null,
      verifiedAt: null,
      verifiedBy: null,
    });
    const notRequired = clone(source);
    notRequired.items[0] = { ...notRequired.items[0], required: false };
    const unsupported = allPassed();
    unsupported.items[0] = { ...unsupported.items[0], evidence: " " };
    const impossibleDate = allPassed();
    impossibleDate.items[0] = { ...impossibleDate.items[0], verifiedAt: "2026-02-30T10:00:00.000Z" };
    const invalidFixtures: unknown[] = [
      missing,
      duplicate,
      unexpected,
      notRequired,
      unsupported,
      impossibleDate,
      { version: "not-a-version", items: source.items },
      { version: 1, items: null },
      { version: 1, items: [null] },
      [],
    ];

    for (const fixture of invalidFixtures) {
      for (const strict of [false, true]) {
        const result = validate(fixture, strict);
        expect(result.status, JSON.stringify({ fixture, strict })).toBe(1);
        expect(result.output).toMatchObject({ valid: false, launchReady: false, strict });
      }
    }
  });
});
