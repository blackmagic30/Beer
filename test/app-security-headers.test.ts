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

  it("blocks inline script attributes in CSP", () => {
    const source = appSource();

    expect(source).toContain(`"script-src-attr": ["'none'"]`);
  });

  it("publishes security contact discovery without exposing secrets", () => {
    const source = appSource();
    const securityTxt = fs.readFileSync(path.resolve(process.cwd(), "viewer/security.txt"), "utf8");

    expect(source).toContain('["/.well-known/security.txt", "/security.txt"]');
    expect(securityTxt).toContain("Contact: mailto:admin@pintpath.au");
    expect(securityTxt).toContain("Contact: https://pintpath.au/feedback.html");
    expect(securityTxt).toContain("Policy: https://pintpath.au/security.html");
    expect(securityTxt).not.toMatch(/service_role|sk_live_|whsec_|AIza/i);
  });

  it("keeps server-rendered venue pages connected to primary and support navigation", () => {
    const source = appSource();

    expect(source).toContain('<nav class="siteNav" aria-label="Primary">');
    expect(source).toContain('<a href="/venue-portal.html">For venues</a>');
    expect(source).not.toContain('<a href="/pricing.html">Pricing</a>');
    expect(source).toContain('<a href="/account.html">Account</a>');
    expect(source).toContain('<footer class="siteFooter" role="contentinfo" aria-label="Legal, privacy, and help">');
    expect(source).not.toContain('<footer class="siteFooter" aria-label="Legal, privacy, and help">');
    expect(source).toContain('<a href="/privacy.html">Privacy</a>');
    expect(source).toContain('<a href="/status.html">Service status</a>');
  });
});
