import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function appSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");
}

describe("application security headers", () => {
  it("allows the configured Supabase Auth origin in CSP connect-src", () => {
    const source = appSource();

    expect(source).toContain("const cspConnectSources");
    expect(source).toContain("new URL(env.SUPABASE_URL).origin");
    expect(source).toContain('"connect-src": cspConnectSources');
  });
});
