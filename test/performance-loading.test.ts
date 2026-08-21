import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readFile(filePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("website performance loading", () => {
  it("keeps landing-page startup bounded, paginated, and complete", () => {
    const html = readFile("viewer/index.html");
    const routes = readFile("src/modules/business/business.routes.ts");
    const service = readFile("src/modules/business/business.service.ts");

    expect(html).toContain('<link rel="preconnect" href="https://maps.googleapis.com"');
    expect(html).toContain('<link rel="preconnect" href="https://maps.gstatic.com" crossorigin');
    expect(html).toContain('<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin');
    expect(html).toContain('<script src="./business.js" defer></script>');
    expect(html).not.toContain('@googlemaps/markerclusterer/dist/index.min.js');
    expect(html).toContain('@googlemaps/markerclusterer@2.6.2/dist/index.min.js');
    expect(html).toContain('script.integrity = "sha384-EVwzhfwoZgEjEQ2ffmvGXq5cOevVMtRZTog22siWEV3jCmD0BahdPQHx8y/VIhbi"');
    expect(html).toContain("function loadMarkerClustererScript()");
    expect(html).toContain("const markerClustererReady = loadMarkerClustererScript().catch");
    expect(html).toContain("const [allVenues, priceRecordResponse] = await Promise.all([");
    expect(html).toContain("fetchBusinessViewerVenues(),");
    expect(html).toContain("fetchBusinessPriceRecords().catch");
    expect(html).toContain("const nextCursor = response.nextCursor || null;");
    expect(html).toContain("if (!nextCursor) break;");
    expect(html).toContain("seenCursors.has(nextCursor)");
    expect(routes).toContain("public, max-age=30, stale-while-revalidate=120");
    expect(routes).toContain('router.get("/venues", venueDirectoryReadLimiter');
    expect(routes).toContain('res.setHeader("Cache-Control", "private, no-store")');
    expect(routes).toContain('res.vary("Origin")');
    expect(routes).toContain('res.vary("Authorization")');
    expect(routes).toContain('res.vary("Cookie")');
    expect(routes).toContain("Math.min(query.limit, PUBLIC_VENUE_DIRECTORY_PAGE_LIMIT)");
    expect(routes).toContain("if (credentialsSupplied && !account)");
    expect(service).not.toContain("private publicVenueCache:");
    expect(service).toContain("listPublicVenueDirectoryPage");
    expect(service).toContain("listBarProfilePublicMetadata");
    expect(service).toContain('{ count: "exact" }');
    expect(service).toContain("request.range(remoteOffset, remoteOffset + remoteFetchLimit - 1)");
    expect(service).toContain("if (allLocalVenues.length === 0)");
    expect(service).toContain("const MAX_REMOTE_VENUE_SCAN_ROWS = 5000");
    expect(service).toContain("request.range(scanOffset, scanOffset + scanLimit - 1)");
    expect(service).not.toContain('request.not("id", "in"');
    expect(service).not.toContain("const prefixSize = normalizedOffset + normalizedLimit");
    expect(html).toContain('window.addEventListener("DOMContentLoaded", () => {');
  });

  it("probes cookie-backed venue sessions without depending on readable browser tokens", () => {
    const venuePortalHtml = readFile("viewer/venue-portal.html");

    expect(venuePortalHtml).toContain('await loadPortal(urlParams.get("venueId"))');
    expect(venuePortalHtml).not.toContain("if (MelbBeerBusiness.hasAuthenticatedSessionHint())");
    [
      "viewer/account.html",
      "viewer/reset-password.html",
      "viewer/resend-confirmation.html",
      "viewer/auth/callback.html",
      "viewer/stats.html",
    ].forEach((filePath) => {
      const source = readFile(filePath);
      expect(source, filePath).toContain('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.min.js"');
      expect(source, filePath).toContain('integrity="sha384-l8ah+VgaWtk1mvOe9VC+OirC6qHFF4yH7l7mKRidV9MSti3E9F463bMp6ZVN4kuC"');
      expect(source, filePath).toContain('crossorigin="anonymous"');
      expect(source, filePath).not.toMatch(/@supabase\/supabase-js@(?:2|latest)(?:["/])/);
    });
  });

  it("pins every jsDelivr executable to an exact version and integrity hash", () => {
    const htmlFiles = fs.readdirSync(path.resolve(process.cwd(), "viewer"), { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".html"));
    const combined = htmlFiles
      .map((entry) => readFile(path.join("viewer", entry)))
      .join("\n");

    expect(combined).not.toMatch(/cdn\.jsdelivr\.net\/npm\/[^"']+@(?:latest|\d+)(?:["/])/);
    expect(combined).not.toContain("@googlemaps/markerclusterer/dist/index.min.js");
    expect(combined).toContain("@googlemaps/markerclusterer@2.6.2/dist/index.min.js");
  });

  it("serves static website assets with production cache headers", () => {
    const appSource = readFile("src/app.ts");

    expect(appSource).toContain("function getStaticAssetCacheControl");
    expect(appSource).toContain("stale-while-revalidate=3600");
    expect(appSource).toContain("stale-while-revalidate=604800");
    expect(appSource).toContain("public, max-age=0, must-revalidate");
    expect(appSource).toContain("setHeaders: setStaticAssetHeaders");
    expect(appSource).toContain('import compression from "compression"');
    expect(appSource).toContain('!req.path.startsWith("/api/")');
  });
});
