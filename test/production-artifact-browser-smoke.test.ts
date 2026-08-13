import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function repositoryFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("rendered production artifact smoke contract", () => {
  it("pins the browser runtime and exposes a repository-local command", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(repositoryFile("package-lock.json")) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };

    expect(packageJson.scripts?.["smoke:artifact:browser"]).toBe(
      "node scripts/smoke-production-artifact-browser.mjs",
    );
    expect(packageJson.devDependencies?.["playwright-core"]).toBe("1.62.1");
    expect(packageLock.packages?.["node_modules/playwright-core"]).toMatchObject({
      version: "1.62.1",
      integrity: "sha512-wPYSwEBJY9GHraISXqyqtx0na0LpO3XEX7jNDhntbex7tzUS7kLnZsOlFruFJB4Hi/rhDMjXGqHewDZ68nYZVw==",
    });
  });

  it("keeps the rendered suite fail-closed and provider-free", () => {
    const source = repositoryFile("scripts/smoke-production-artifact-browser.mjs");

    expect(source).toContain('const EXPECTED_NODE_VERSION = "v22.23.2"');
    expect(source).toContain('COMMERCIAL_LAUNCH_ENABLED: "false"');
    expect(source).toContain('CONSUMER_PAID_ENROLLMENT_ENABLED: "false"');
    expect(source).toContain('GOOGLE_MAPS_API_KEY: ""');
    expect(source).toContain('OUTBOUND_CALLS_ENABLED: "false"');
    expect(source).toContain('page.on("console"');
    expect(source).toContain('page.on("pageerror"');
    expect(source).toContain('page.on("requestfailed"');
    expect(source).toContain("document.documentElement.scrollWidth");
    expect(source).toContain('fetch("/api/business/venue-portal"');
    expect(source).toContain('path: "/venue-portal?checkout=success&billing=returned&tab=specials"');
    expect(source).toContain('await route.abort("blockedbyclient")');
  });

  it("runs the rendered smoke after the artifact build in ordinary CI", () => {
    const workflow = repositoryFile(".github/workflows/ci.yml");
    const install = "npx --no-install playwright-core install --with-deps --only-shell chromium";
    const build = "run: npm run check";
    const smoke = "run: npm run smoke:artifact:browser";

    expect(workflow).toContain(install);
    expect(workflow).toContain(build);
    expect(workflow).toContain(smoke);
    expect(workflow.indexOf(install)).toBeLessThan(workflow.indexOf(build));
    expect(workflow.indexOf(build)).toBeLessThan(workflow.indexOf(smoke));
  });
});
