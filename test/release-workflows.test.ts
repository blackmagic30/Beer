import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), ".github/workflows", name), "utf8");
}

function evidenceValidator(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/validate-release-evidence.ts"), "utf8");
}

describe("release workflow contracts", () => {
  it("keeps the automatic workflow informational about external launch evidence", () => {
    const source = workflow("pintpath-release-readiness.yml");

    expect(source).toContain("name: Pint Path Automated Readiness");
    expect(source).toContain("npm run test:e2e:pintpath");
    expect(source).toContain("npm run release:evidence | tee release-evidence-summary.json");
    expect(source).not.toContain("release:evidence:strict");
    expect(evidenceValidator()).toContain("ok: launchReady");
    expect(evidenceValidator()).toContain("launchReady,");
  });

  it("requires authenticated production role checks and strict evidence in the manual release gate", () => {
    const source = workflow("pintpath-release-gate.yml");

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: production");
    expect(source).toContain("PINTPATH_SMOKE_USER_TOKEN: ${{ secrets.PINTPATH_SMOKE_USER_TOKEN }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_TOKEN: ${{ secrets.PINTPATH_SMOKE_VENUE_TOKEN }}");
    expect(source).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");
    expect(source).toContain("npm run smoke:production:auth");
    expect(source).toContain("npm run release:evidence:strict");
  });
});
