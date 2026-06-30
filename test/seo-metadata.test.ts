import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readViewerFile(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer", file), "utf8");
}

describe("SEO metadata", () => {
  it("keeps public website pages discoverable with descriptions, canonicals, and social previews", () => {
    [
      "index.html",
      "pricing.html",
      "venue-portal.html",
      "trust.html",
      "submit.html",
      "feedback.html",
      "privacy.html",
      "terms.html",
      "missions.html",
      "security.html",
      "community.html",
      "status.html",
    ].forEach((file) => {
      const html = readViewerFile(file);
      expect(html, file).toMatch(/<title>[^<]*Pint Path[^<]*<\/title>/);
      expect(html, file).toContain('<meta name="description"');
      expect(html, file).toContain('rel="canonical"');
      expect(html, file).toContain('property="og:title"');
      expect(html, file).toContain('property="og:description"');
      expect(html, file).toContain('name="twitter:card"');
      expect(html, file).toContain('name="twitter:description"');
    });
  });

  it("exposes crawl files for public pages and keeps private utilities out of the index", () => {
    const robots = readViewerFile("robots.txt");
    const sitemap = readViewerFile("sitemap.xml");

    expect(robots).toContain("Sitemap: https://pintpath.au/sitemap.xml");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Disallow: /admin.html");
    expect(sitemap).toContain("<loc>https://pintpath.au/</loc>");
    expect(sitemap).toContain("<loc>https://pintpath.au/pricing.html</loc>");
    expect(sitemap).toContain("<loc>https://pintpath.au/venue-portal</loc>");

    [
      "account.html",
      "admin.html",
      "stats.html",
      "reset-password.html",
      "resend-confirmation.html",
      "auth/callback.html",
    ].forEach((file) => {
      expect(readViewerFile(file), file).toContain('name="robots" content="noindex');
    });
  });
});
