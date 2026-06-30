import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readFile(filePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("website performance loading", () => {
  it("keeps the landing page startup path non-blocking where safe", () => {
    const html = readFile("viewer/index.html");

    expect(html).toContain('<link rel="preconnect" href="https://maps.googleapis.com"');
    expect(html).toContain('<link rel="preconnect" href="https://maps.gstatic.com" crossorigin');
    expect(html).toContain('<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin');
    expect(html).toContain('<script src="./business.js" defer></script>');
    expect(html).not.toContain('<script src="https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer/dist/index.min.js"></script>');
    expect(html).toContain("function loadMarkerClustererScript()");
    expect(html).toContain("const markerClustererReady = loadMarkerClustererScript().catch");
    expect(html).toContain("const [allVenues, priceRecordResponse] = await Promise.all([");
    expect(html).toContain('window.addEventListener("DOMContentLoaded", () => {');
  });

  it("avoids avoidable signed-out dashboard and auth-page work", () => {
    const venuePortalHtml = readFile("viewer/venue-portal.html");

    expect(venuePortalHtml).toContain("if (MelbBeerBusiness.hasAuthenticatedSessionHint())");
    [
      "viewer/account.html",
      "viewer/reset-password.html",
      "viewer/resend-confirmation.html",
      "viewer/auth/callback.html",
      "viewer/stats.html",
    ].forEach((filePath) => {
      expect(readFile(filePath), filePath).toContain('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer');
    });
  });

  it("serves static website assets with production cache headers", () => {
    const appSource = readFile("src/app.ts");

    expect(appSource).toContain("function getStaticAssetCacheControl");
    expect(appSource).toContain("stale-while-revalidate=3600");
    expect(appSource).toContain("stale-while-revalidate=604800");
    expect(appSource).toContain("setHeaders: setStaticAssetHeaders");
  });
});
