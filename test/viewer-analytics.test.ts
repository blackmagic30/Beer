import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function indexHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
}

function businessJs() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
}

describe("public map analytics capture", () => {
  it("captures search, filter, and venue-click intent through the privacy-safe event pipeline", () => {
    const html = indexHtml();

    expect(html).toContain("function getAnalyticsContext");
    expect(html).toContain("function trackSearchAnalytics");
    expect(html).toContain("function trackVenueAnalytics");
    expect(html).toContain('"map_pin_click"');
    expect(html).toContain('"beer_list_viewed"');
    expect(html).toContain("approximateSuburb");
    expect(html).toContain("distanceBucket");
    expect(html).toContain("localTimeBucket");
    expect(html).toContain("beerId: matchedBeer ? getBeerAnalyticsKey(matchedBeer) : null");
  });

  it("strips exact location-like keys before analytics leave the browser", () => {
    const js = businessJs();

    expect(js).toContain("safeMetadata");
    expect(js).toContain("latitude|longitude");
    expect(js).toContain("precise.?location");
    expect(js).toContain("eventType");
  });
});
