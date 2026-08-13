import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SUPPRESSION_PATTERN = /^\s*\/\/ codeql\[(js\/[a-z0-9-]+)\]\s*$/;
const SAME_LINE_SUPPRESSION_PATTERN = /\/\/ lgtm\[(js\/[a-z0-9-]+)\]\s*$/;
const EXPECTED_ALERT_LINE = new Map<string, RegExp>([
  ["js/file-system-race", /(?:const handle|handle) = await fs\.promises\.open\(/],
  ["js/insufficient-password-hash", /crypto\.createHash\("sha256"\)/],
  [
    "js/missing-rate-limiting",
    /(?:app|router)\.(?:get|post|delete|put|patch)\(|^}, async \(_req, res, next\) => \{$/,
  ],
  ["js/user-controlled-bypass", /if \(!rawBody \|\| !signature\)/],
]);

function sourceFiles(directory = "src"): string[] {
  return fs.readdirSync(path.resolve(process.cwd(), directory), { withFileTypes: true })
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(filename);
      return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [filename] : [];
    })
    .sort();
}

describe("CodeQL source suppressions", () => {
  it("keeps every reviewed suppression on the blank line immediately before its alert", () => {
    const counts = new Map<string, number>();
    const sameLineCounts = new Map<string, number>();

    for (const filename of sourceFiles()) {
      const lines = fs.readFileSync(path.resolve(process.cwd(), filename), "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const sameLineMatch = lines[index]!.match(SAME_LINE_SUPPRESSION_PATTERN);
        if (sameLineMatch) {
          const queryId = sameLineMatch[1]!;
          sameLineCounts.set(queryId, (sameLineCounts.get(queryId) ?? 0) + 1);
          expect(
            lines[index]!.slice(0, sameLineMatch.index).trim(),
            `${filename}:${index + 1}`,
          ).toMatch(EXPECTED_ALERT_LINE.get(queryId) ?? /$a/);
        }

        const match = lines[index]!.match(SUPPRESSION_PATTERN);
        if (!match) continue;

        const queryId = match[1]!;
        const justification = lines[index - 1]?.trim() ?? "";
        const alertLine = lines[index + 1]?.trim() ?? "";
        counts.set(queryId, (counts.get(queryId) ?? 0) + 1);

        expect(justification, `${filename}:${index + 1}`).not.toBe("");
        expect(justification, `${filename}:${index + 1}`).not.toMatch(/^\/\/ codeql\[/);
        expect(alertLine, `${filename}:${index + 1}`).not.toBe("");
        expect(alertLine, `${filename}:${index + 1}`).not.toMatch(/^\/\//);
        expect(alertLine, `${filename}:${index + 1}`).toMatch(
          EXPECTED_ALERT_LINE.get(queryId) ?? /$a/,
        );
      }
    }

    expect(Object.fromEntries([...counts].sort())).toEqual({
      "js/file-system-race": 14,
      "js/insufficient-password-hash": 2,
      "js/missing-rate-limiting": 10,
      "js/user-controlled-bypass": 1,
    });
    // The hosted 010694c analysis reported 26 alerts at these 25 exact source
    // locations (the Stripe guard produced two findings on the same line).
    expect(Object.fromEntries([...sameLineCounts].sort())).toEqual({
      "js/file-system-race": 14,
      "js/insufficient-password-hash": 2,
      "js/missing-rate-limiting": 8,
      "js/user-controlled-bypass": 1,
    });
  });
});
