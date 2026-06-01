import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function loadMapLogic() {
  const script = fs.readFileSync(path.resolve(process.cwd(), "viewer/map-logic.js"), "utf8");
  const context = {
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return (context.window as { MelbBeerMapLogic: unknown }).MelbBeerMapLogic;
}

describe("viewer map price logic", () => {
  const logic = loadMapLogic() as {
    normalizeBeerPriceNumeric: (source: Record<string, unknown>) => number | null;
    getAvailabilityLabel: (source: Record<string, unknown>) => string;
    getBeerPriceText: (source: Record<string, unknown>, label: string, price: number | null) => string;
    hasNumericPrice: (beer: Record<string, unknown>) => boolean;
    getLowestKnownPrice: (beers: Array<Record<string, unknown>>) => number | null;
    isUnderPriceThreshold: (beers: Array<Record<string, unknown>>, threshold: number) => boolean;
    getMarkerColor: (beer: Record<string, unknown>) => string;
    getMarkerLabel: (beer: Record<string, unknown>) => string;
    getPriceTier: (beer: Record<string, unknown>) => string;
    getMarkerState: (beer: Record<string, unknown> | null, options?: Record<string, unknown>) => string;
    getMarkerVisual: (beer: Record<string, unknown> | null, options?: Record<string, unknown>) => {
      state: string;
      fillColor: string;
      strokeColor: string;
      labelText: string;
      scale: number;
      selected?: boolean;
    };
    getClusterVisual: (count: number) => {
      fillColor: string;
      strokeColor: string;
      labelColor: string;
      scale: number;
    };
    getDistanceKm: (
      origin: { lat?: number; lng?: number; latitude?: number; longitude?: number },
      destination: { lat?: number; lng?: number; latitude?: number; longitude?: number },
    ) => number | null;
    formatDistance: (distanceKm: number | null) => string;
    isWithinRadiusKm: (
      origin: { lat?: number; lng?: number; latitude?: number; longitude?: number },
      destination: { lat?: number; lng?: number; latitude?: number; longitude?: number },
      radiusKm: number,
    ) => boolean;
  };

  it("does not convert unknown, zero, unavailable, or off-tap prices into cheap numeric prices", () => {
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: null })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: 0 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "unknown", price_numeric: 8 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "unavailable", price_numeric: 8 })).toBeNull();
    expect(logic.normalizeBeerPriceNumeric({ availability_status: "on_tap", price_numeric: 9 })).toBe(9);
  });

  it("renders unknown selected-beer prices as unknown rather than $0 or cheap", () => {
    const source = { availability_status: "on_tap", price_text: "$0", price_numeric: null };
    const label = logic.getAvailabilityLabel(source);
    const price = logic.normalizeBeerPriceNumeric(source);

    expect(label).toBe("On tap");
    expect(price).toBeNull();
    expect(logic.getBeerPriceText(source, label, price)).toBe("Price unknown");
  });

  it("excludes unknown prices from cheapest and under-threshold calculations", () => {
    const beers = [
      { label: "Guinness", priceNumeric: null, availabilityLabel: "On tap" },
      { label: "Carlton Draught", priceNumeric: 11, availabilityLabel: "On tap" },
      { label: "Stone & Wood", priceNumeric: undefined, availabilityLabel: "Unknown" },
    ];

    expect(logic.getLowestKnownPrice(beers)).toBe(11);
    expect(logic.isUnderPriceThreshold(beers, 10)).toBe(false);
    expect(logic.isUnderPriceThreshold(beers, 12)).toBe(true);
    expect(logic.getLowestKnownPrice([{ priceNumeric: null }, { priceNumeric: 0 }])).toBeNull();
  });

  it("keeps unknown price markers neutral instead of green", () => {
    const unknownBeer = { priceNumeric: null, availabilityLabel: "On tap" };

    expect(logic.hasNumericPrice(unknownBeer)).toBe(false);
    expect(logic.getPriceTier(unknownBeer)).toBe("unknown");
    expect(logic.getMarkerColor(unknownBeer)).not.toBe("#15803d");
    expect(logic.getMarkerColor(unknownBeer)).toBe("#475569");
    expect(logic.getMarkerLabel(unknownBeer)).toBe("?");
  });

  it("maps price and data states to distinct marker visuals", () => {
    const cheap = { priceNumeric: 10, availabilityLabel: "On tap" };
    const mid = { priceNumeric: 14, availabilityLabel: "On tap" };
    const expensive = { priceNumeric: 19, availabilityLabel: "On tap" };
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };

    expect(logic.getMarkerState(cheap)).toBe("cheap");
    expect(logic.getMarkerVisual(cheap).fillColor).toBe("#15803d");
    expect(logic.getMarkerState(mid)).toBe("mid");
    expect(logic.getMarkerVisual(mid).fillColor).toBe("#d97706");
    expect(logic.getMarkerState(expensive)).toBe("expensive");
    expect(logic.getMarkerVisual(expensive).fillColor).toBe("#b91c1c");
    expect(logic.getMarkerState(unknown)).toBe("unknown");
    expect(logic.getMarkerVisual(unknown).fillColor).toBe("#475569");
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).state).toBe("mapped");
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).fillColor).toBe("#0f766e");
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).labelText).toBe("✓");
    expect(logic.getMarkerVisual(null, { needsData: true }).state).toBe("needs_data");
    expect(logic.getMarkerVisual(null, { needsData: true }).fillColor).toBe("#64748b");
    expect(logic.getMarkerVisual(null, { needsData: true }).labelText).toBe("?");
  });

  it("gives selected markers a stronger gold ring without changing unknown into cheap", () => {
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };
    const base = logic.getMarkerVisual(unknown);
    const selected = logic.getMarkerVisual(unknown, { selected: true });

    expect(selected.selected).toBe(true);
    expect(selected.fillColor).toBe(base.fillColor);
    expect(selected.fillColor).not.toBe("#15803d");
    expect(selected.strokeColor).toBe("#f5c76b");
    expect(selected.scale).toBeGreaterThan(base.scale);
  });

  it("keeps locked prices distinct from unknown and cheap marker states", () => {
    const redacted = { priceNumeric: null, availabilityLabel: "On tap" };
    const locked = logic.getMarkerVisual(redacted, { locked: true });

    expect(locked.state).toBe("locked");
    expect(locked.fillColor).toBe("#7c3aed");
    expect(locked.labelText).toBe("$");
    expect(locked.fillColor).not.toBe("#15803d");
    expect(locked.fillColor).not.toBe("#475569");
  });

  it("keeps unavailable beer distinct from expensive verified pricing", () => {
    const unavailable = { priceNumeric: null, availabilityLabel: "Unavailable" };

    expect(logic.getMarkerState(unavailable)).toBe("unavailable");
    expect(logic.getMarkerVisual(unavailable).labelText).toBe("NO");
    expect(logic.getMarkerVisual(unavailable).strokeColor).toBe("#fecaca");
  });

  it("styles clusters with deliberate count tiers", () => {
    expect(logic.getClusterVisual(5).fillColor).toBe("#334155");
    expect(logic.getClusterVisual(12).fillColor).toBe("#1d4ed8");
    expect(logic.getClusterVisual(40).fillColor).toBe("#b45309");
    expect(logic.getClusterVisual(120).fillColor).toBe("#9f1239");
  });

  it("calculates and formats approximate venue distance", () => {
    const flindersStreet = { lat: -37.8183, lng: 144.9671 };
    const richmond = { latitude: -37.823, longitude: 144.998 };
    const distanceKm = logic.getDistanceKm(flindersStreet, richmond);

    expect(distanceKm).toBeGreaterThan(2);
    expect(distanceKm).toBeLessThan(3.5);
    expect(logic.formatDistance(0.35)).toBe("350 m");
    expect(logic.formatDistance(1.24)).toBe("1.2 km");
    expect(logic.formatDistance(null)).toBe("Distance unavailable");
    expect(logic.isWithinRadiusKm(flindersStreet, richmond, 5)).toBe(true);
    expect(logic.isWithinRadiusKm(flindersStreet, richmond, 1)).toBe(false);
  });
});

describe("viewer map UI wiring", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
  const venuePortalHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-portal.html"), "utf8");

  it("renders the polished marker legend and cluster renderer", () => {
    expect(html).toContain("legend__swatch--selected");
    expect(html).toContain("Unknown prices are shown separately");
    expect(html).toContain("renderer: clusterRenderer");
    expect(html).toContain("getClusterVisual(count)");
    expect(html).toContain("const currentViewState = getViewState();");
    expect(html).toContain("Teal markers have data");
    expect(html).toContain("Muted grey markers are mapped venues");
    expect(html).not.toContain("Blue markers have no captured beer prices yet.");
    expect(html).not.toContain("buildCurrentViewState");
  });

  it("has distinct venue card row states for known, unknown, unavailable, package, and locked prices", () => {
    expect(html).toContain("beerPopup__beerRow--known");
    expect(html).toContain("beerPopup__beerRow--unknown");
    expect(html).toContain("beerPopup__beerRow--unavailable");
    expect(html).toContain("beerPopup__beerRow--package");
    expect(html).toContain("beerPopup__beerRow--locked");
    expect(html).toContain("beerPopup__summaryGrid");
    expect(html).toContain("Venue-supplied listing");
    expect(html).toContain("Update this venue");
    expect(html).toContain('id="venueDetailOverlay"');
    expect(html).toContain("openVenueDetailOverlay");
    expect(html).toContain("Close this panel to return to the map.");
    expect(html).toContain('liveHappyHourDetails?.sourceType === "venue_manager_portal"');
    expect(html).toContain("const canShowHappyHourDetails");
    expect(html).not.toContain(">$0<");
  });

  it("renders the simplified public header, primary controls, and contributor-only advanced filters", () => {
    expect(html).toContain('id="topbarBusinessLinks"');
    expect(html).toContain('id="accessPill"');
    expect(html).toContain('class="controlDeck"');
    expect(html).toContain("Find a venue fast");
    expect(html).toContain('placeholder="Search beer, venue or suburb"');
    expect(html).toContain('id="advancedFiltersToggle"');
    expect(html).toContain('aria-controls="advancedFiltersPanel" hidden');
    expect(html).toContain('id="advancedFiltersPanel" class="advancedFiltersPanel" hidden');
    expect(html).toContain('id="activeFilterSummary"');
    expect(html).toContain('data-area-chip="Fitzroy"');
    expect(html).toContain('data-filter-chip="best_options"');
    expect(html).toContain('data-filter-chip="pint_path_specials"');
    expect(html).toContain('aria-label="Specials filters"');
    expect(html).toContain('<span class="filterGroup__label">Specials</span>');
    expect(html).toContain('data-premium-filter="true"');
    expect(html).toContain("syncAdvancedFiltersAvailability");
    expect(html).toContain("advancedFiltersToggleEl.hidden = !canUseAdvancedFilters");
    expect(html).toContain('class="belowMapInsights"');
    expect(html).toContain('id="accessSummary"');
    expect(html).toContain("Drink responsibly");
  });

  it("renders location-aware controls and only auto-requests after a saved opt-in", () => {
    expect(html).toContain('id="useLocationButton"');
    expect(html).not.toContain('data-filter-chip="happy_hour_near_me"');
    expect(html).toContain('data-filter-chip="happy_hour_active_now"');
    expect(html).toContain('data-filter-chip="pint_path_specials"');
    expect(html).toContain('data-filter-chip="recently_verified_near_me"');
    expect(html).toContain('data-filter-chip="nearest"');
    expect(html).toContain('id="nearMeRadiusSelect"');
    expect(html).toContain('LOCATION_PREFERENCE_STORAGE_KEY = "pintPathLocationPreference"');
    expect(html).toContain('requestUserLocation("saved_location_preference")');
    expect(html).toContain('disableUserLocation("use_location_button_off")');
    expect(html).toContain("navigator.geolocation.getCurrentPosition");
    expect(html).not.toContain("watchPosition");
  });

  it("limits public beer shortcut chips to the free preview beers", () => {
    expect(html).toContain('label: "Guinness", query: "Guinness"');
    expect(html).toContain('label: "Carlton Draft", query: "Carlton Draft"');
    expect(html).toContain('label: "Stone & Wood", query: "Stone & Wood"');
    expect(html).toContain("FREE_PREVIEW_BEER_CHIPS");
    expect(html).toContain("FREE_PREVIEW_BEER_KEYS");
    expect(html).not.toContain("Search for more beers");
  });

  it("renders a Pint Path specials filter and locked special-detail copy", () => {
    expect(html).toContain("Pint Path specials");
    expect(html).toContain("hasPintPathSpecial(row)");
    expect(html).toContain("Pint Path special available. Unlock full access to view price, discount, and conditions.");
  });

  it("keeps the public map top area compact and touch-friendly on phones", () => {
    expect(html).toContain("@media (max-width: 640px)");
    expect(html).toContain("min-height: 100dvh");
    expect(html).toContain("-webkit-overflow-scrolling: touch");
    expect(html).toContain("-webkit-line-clamp: 2");
    expect(html).toContain("font-size: 16px");
    expect(html).toContain(".specialsFilterRow,\n      .popularBeerRow");
    expect(html).toContain(".advancedFiltersGrid {\n        grid-template-columns: 1fr;");
    expect(html).toContain("min-height: 62dvh");
  });

  it("keeps admin navigation out of the static public header", () => {
    expect(html).not.toMatch(/<a[^>]*href="\/admin\.html"[^>]*>Admin<\/a>/);
    expect(html).not.toMatch(/<a[^>]*href="\/for-bars"[^>]*>/);
    expect(html).not.toContain("Admin secret");
    expect(html).not.toContain("debugToggle");
  });

  it("keeps venue manager self-claiming hidden behind invite-only copy", () => {
    expect(venuePortalHtml).toContain("Venue portal access is assigned by Pint Path admin");
    expect(venuePortalHtml).not.toContain('id="claimForm"');
    expect(venuePortalHtml).not.toContain("Create your Basic bar account");
    expect(venuePortalHtml).not.toContain("Claim your bar");
  });
});
