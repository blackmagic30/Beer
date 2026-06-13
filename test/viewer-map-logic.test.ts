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
      priceRingColor: string | null;
      labelText: string;
      scale: number;
      selected?: boolean;
    };
    getPriceRingColor: (beer: Record<string, unknown>) => string | null;
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
      { label: "Stone & Wood Pacific Ale", priceNumeric: undefined, availabilityLabel: "Unknown" },
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
    expect(logic.getMarkerColor(unknownBeer)).not.toBe("#22d3ee");
    expect(logic.getMarkerColor(unknownBeer)).toBe("#64748b");
    expect(logic.getMarkerLabel(unknownBeer)).toBe("?");
  });

  it("maps price and data states to distinct marker visuals", () => {
    const cheap = { priceNumeric: 10, availabilityLabel: "On tap" };
    const mid = { priceNumeric: 14, availabilityLabel: "On tap" };
    const expensive = { priceNumeric: 19, availabilityLabel: "On tap" };
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };

    expect(logic.getMarkerState(cheap)).toBe("cheap");
    expect(logic.getMarkerVisual(cheap).fillColor).toBe("#22d3ee");
    expect(logic.getMarkerVisual(cheap).priceRingColor).toBe("#16a34a");
    expect(logic.getMarkerState(mid)).toBe("mid");
    expect(logic.getMarkerVisual(mid).fillColor).toBe("#a3e635");
    expect(logic.getMarkerVisual(mid).priceRingColor).toBe("#facc15");
    expect(logic.getMarkerState(expensive)).toBe("expensive");
    expect(logic.getMarkerVisual(expensive).fillColor).toBe("#d946ef");
    expect(logic.getMarkerVisual(expensive).priceRingColor).toBe("#7f1d1d");
    expect(logic.getMarkerState(unknown)).toBe("unknown");
    expect(logic.getMarkerVisual(unknown).fillColor).toBe("#64748b");
    expect(logic.getMarkerVisual(unknown).priceRingColor).toBeNull();
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).state).toBe("mapped");
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).fillColor).toBe("#2563eb");
    expect(logic.getMarkerVisual(null, { mappedOnly: true }).labelText).toBe("✓");
    expect(logic.getMarkerVisual(null, { needsData: true }).state).toBe("needs_data");
    expect(logic.getMarkerVisual(null, { needsData: true }).fillColor).toBe("#475569");
    expect(logic.getMarkerVisual(null, { needsData: true }).labelText).toBe("?");
  });

  it("gives selected markers a stronger gold ring without changing unknown into cheap", () => {
    const unknown = { priceNumeric: null, availabilityLabel: "On tap" };
    const base = logic.getMarkerVisual(unknown);
    const selected = logic.getMarkerVisual(unknown, { selected: true });

    expect(selected.selected).toBe(true);
    expect(selected.fillColor).toBe(base.fillColor);
    expect(selected.fillColor).not.toBe("#22d3ee");
    expect(selected.strokeColor).toBe("#f5c542");
    expect(selected.priceRingColor).toBe(base.priceRingColor);
    expect(selected.scale).toBeGreaterThan(base.scale);
  });

  it("uses a green to dark-red price ring scale only for visible numeric prices", () => {
    expect(logic.getPriceRingColor({ priceNumeric: 10 })).toBe("#16a34a");
    expect(logic.getPriceRingColor({ priceNumeric: 14 })).toBe("#facc15");
    expect(logic.getPriceRingColor({ priceNumeric: 16 })).toBe("#ea580c");
    expect(logic.getPriceRingColor({ priceNumeric: 20 })).toBe("#7f1d1d");
    expect(logic.getPriceRingColor({ priceNumeric: null })).toBeNull();
    expect(logic.getMarkerVisual({ priceNumeric: null, availabilityLabel: "On tap" }, { locked: true }).priceRingColor).toBeNull();
  });

  it("keeps locked prices distinct from unknown and cheap marker states", () => {
    const redacted = { priceNumeric: null, availabilityLabel: "On tap" };
    const locked = logic.getMarkerVisual(redacted, { locked: true });

    expect(locked.state).toBe("locked");
    expect(locked.fillColor).toBe("#8b5cf6");
    expect(locked.labelText).toBe("$");
    expect(locked.fillColor).not.toBe("#22d3ee");
    expect(locked.fillColor).not.toBe("#64748b");
  });

  it("keeps unavailable beer distinct from expensive verified pricing", () => {
    const unavailable = { priceNumeric: null, availabilityLabel: "Unavailable" };

    expect(logic.getMarkerState(unavailable)).toBe("unavailable");
    expect(logic.getMarkerVisual(unavailable).labelText).toBe("NO");
    expect(logic.getMarkerVisual(unavailable).strokeColor).toBe("#fecaca");
  });

  it("styles clusters with deliberate count tiers", () => {
    expect(logic.getClusterVisual(5).fillColor).toBe("#172554");
    expect(logic.getClusterVisual(12).fillColor).toBe("#2563eb");
    expect(logic.getClusterVisual(40).fillColor).toBe("#22d3ee");
    expect(logic.getClusterVisual(120).fillColor).toBe("#f5c542");
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

  it("renders advanced markers without visible map legend/list overlays", () => {
    expect(html).toContain("renderer: clusterRenderer");
    expect(html).toContain("getClusterVisual(count)");
    expect(html).toContain("const viewState = getViewState();");
    expect(html).toContain("AdvancedMarkerElement");
    expect(html).toContain("createAdvancedMapMarker");
    expect(html).toContain("advancedMapPin");
    expect(html).toContain("advancedMapPin--priced");
    expect(html).toContain("--pin-price-ring");
    expect(html).toContain("getVisibleBeerPriceTier");
    expect(html).toContain("venueRail__card--price-");
    expect(html).toContain("green, yellow, orange, and dark-red price rings");
    expect(html).toContain("__pintPathMapMarkerDebug");
    expect(html).toContain('libraries: "marker"');
    expect(html).not.toContain('libraries: "marker,places"');
    expect(html).toContain('loading: "async"');
    expect(html).toContain("EFFECTIVE_GOOGLE_MAPS_MAP_ID");
    expect(html).toContain("useConfiguredGoogleMapsMapId");
    expect(html).toContain('gestureHandling: "cooperative"');
    expect(html).toContain("zoomControl: false");
    expect(html).toContain("installCommandScrollZoomAssist(map, mapElement)");
    expect(html).toContain('mapElement.addEventListener("wheel"');
    expect(html).toContain("if (!event.metaKey && !event.ctrlKey)");
    expect(html).not.toContain('id="mapZoomControls"');
    expect(html).toContain("const MAP_OVERLAYS_ENABLED = false");
    expect(html).toContain('id="mapOverlayTabs" aria-label="Map panels" hidden');
    expect(html).not.toContain("new google.maps.Marker");
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
    expect(html).toContain("I’m here · submit price");
    expect(html).toContain("More updates");
    expect(html).toContain('id="venueDetailOverlay"');
    expect(html).toContain("openVenueDetailOverlay");
    expect(html).toContain("Close this panel to return to the map.");
    expect(html).toContain('liveHappyHourDetails?.sourceType === "venue_manager_portal"');
    expect(html).toContain("const canShowHappyHourDetails");
    expect(html).not.toContain(">$0<");
  });

  it("renders launch-ready retention, sharing, and map refresh affordances", () => {
    expect(html).toContain('id="shareSearchButton"');
    expect(html).toContain('id="searchThisAreaButton"');
    expect(html).toContain('id="mapOverlayTabs" aria-label="Map panels" hidden');
    expect(html).toContain("MAP_OVERLAYS_ENABLED = false");
    expect(html).not.toContain('id="recentlyViewedPanel"');
    expect(html).not.toContain('id="recentlyViewedTitle"');
    expect(html).toContain('id="nightPlanPanel"');
    expect(html).toContain('LOCAL_SAVED_VENUES_STORAGE_KEY = "pintPathLocalSavedVenues"');
    expect(html).toContain('RECENTLY_VIEWED_STORAGE_KEY = "pintPathRecentlyViewedVenues"');
    expect(html).toContain('NIGHT_PLAN_STORAGE_KEY = "pintPathNightPlanVenues"');
    expect(html).toContain('NIGHT_PLAN_ACCOUNT_ITEM_ID = "current-night-plan"');
    expect(html).toContain('itemType: "night_plan"');
    expect(html).toContain("getNightPlanSavedItemPayload");
    expect(html).toContain("persistAccountNightPlan");
    expect(html).toContain('data-venue-action="save"');
    expect(html).toContain('data-venue-action="share"');
    expect(html).toContain('data-venue-action="plan"');
    expect(html).toContain('data-venue-action="directions"');
    expect(html).toContain("Manage this venue");
    expect(html).toContain("applySharedSearchParams");
    expect(html).toContain("window.__openStoredVenue");
    expect(html).toContain('new URL(`/venues/${encodeURIComponent(snapshot.id)}`, window.location.origin)');
    expect(html).toContain("search_this_area");
    expect(html).toContain("venue_shared");
    expect(html).toContain("search_shared");
  });

  it("renders the simplified public header, primary controls, and shared advanced filters", () => {
    expect(html).toContain('class="mapNavCard" aria-label="Primary"');
    expect(html).toContain('class="mapBrand" href="/"');
    expect(html).toContain('class="mapHeroCard" aria-label="Map overview"');
    expect(html.indexOf('class="mapHeroCard"')).toBeLessThan(html.indexOf('class="mapNavCard"'));
    expect(html).toContain('<strong>Melbourne beer map</strong>');
    expect(html).toContain('<div class="topbar__eyebrow">Melbourne beer map <span class="fieldTestBadge">Beta</span></div>');
    expect(html).toContain("<h1>Pint Path</h1>");
    expect(html).not.toContain("Verified local price index");
    expect(html).toContain('id="topbarBusinessLinks"');
    expect(html).toContain('id="accessPill"');
    expect(html).toContain('<a href="/feedback.html">Feedback</a> · <a href="/privacy.html">Privacy</a>');
    expect(html).toContain('class="controlDeck"');
    expect(html).toContain("Find a venue fast");
    expect(html).toContain('placeholder="Suburb or venue"');
    expect(html).toContain('<select id="beerSearch" class="controlInput beerSelect">');
    expect(html).toContain('<option value="">Beer</option>');
    expect(html).toContain('id="advancedFiltersToggle"');
    expect(html).toContain('aria-controls="advancedFiltersPanel" hidden>Advanced filters</button>');
    expect(html).toContain('id="advancedFiltersPanel" class="advancedFiltersPanel" hidden');
    expect(html).toContain('aria-label="Beer availability filters"');
    expect(html).not.toContain('id="businessBanner"');
    expect(html).not.toContain('id="businessBannerCopy"');
    expect(html).toContain('id="activeFilterSummary"');
    expect(html).not.toContain("Choose area");
    expect(html).not.toContain('data-area-chip="Fitzroy"');
    expect(html).not.toContain('<span class="advancedFilterSection__title">View</span>');
    expect(html).not.toContain('<span class="advancedFilterSection__title">Now</span>');
    expect(html).not.toContain('data-filter-chip="best_options"');
    expect(html).toContain('data-filter-chip="pint_path_specials"');
    expect(html).toContain('aria-label="Specials filters"');
    expect(html).toContain('<span class="filterGroup__label">Specials</span>');
    expect(html).toContain('data-premium-filter="true"');
    expect(html).toContain("syncAdvancedFiltersAvailability");
    expect(html).toContain("function canUseAdvancedFilters()");
    expect(html).toContain("const canUseAdvancedFiltersValue = canUseAdvancedFilters();");
    expect(html).toContain("advancedFiltersToggleEl.hidden = !canUseAdvancedFiltersValue");
    expect(html).toContain("advancedFiltersPanelEl.hidden = true");
    expect(html).toContain("onTapOnlyEl.disabled = !canUseAdvancedFilters()");
    expect(html).toContain("const canApplyAdvancedFilters = canUseAdvancedFilters();");
    expect(html).toContain('onTapOnlyEl.checked = canApplyAdvancedFilters &&');
    expect(html).toContain('showToast("Advanced filters are for signed-in Premium or contributor accounts.")');
    expect(html).toContain('class="belowMapInsights"');
    expect(html).not.toContain('id="accessSummary"');
    expect(html).not.toContain('id="statusBar"');
    expect(html).not.toContain('id="retentionHighlights"');
    expect(html).not.toContain("Unlock perks");
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
    expect(html).toContain('type="range"');
    expect(html).toContain('id="nearMeRadiusValue"');
    expect(html).toContain('"radius_slider"');
    expect(html).toContain("function shouldConstrainToSelectedRadius()");
    expect(html).toContain("if (shouldConstrainToSelectedRadius() && !isWithinSelectedRadius(row))");
    expect(html).toContain("const showRadius = shouldConstrainToSelectedRadius();");
    expect(html).toContain("syncUserLocationOverlay(shouldConstrainToSelectedRadius())");
    expect(html).toContain('LOCATION_PREFERENCE_STORAGE_KEY = "pintPathLocationPreference"');
    expect(html).toContain('requestUserLocation("saved_location_preference")');
    expect(html).toContain('disableUserLocation("use_location_button_off")');
    expect(html).toContain("navigator.geolocation.getCurrentPosition");
    expect(html).not.toContain("watchPosition");
  });

  it("limits public beer shortcut chips to the free preview beers", () => {
    expect(html).toContain('label: "Guinness", query: "Guinness"');
    expect(html).toContain('label: "Carlton Draught", query: "Carlton Draught"');
    expect(html).toContain('label: "Stone & Wood Pacific Ale", query: "Stone & Wood Pacific Ale"');
    expect(html).toContain("FREE_PREVIEW_BEER_CHIPS");
    expect(html).toContain("FREE_PREVIEW_BEER_KEYS");
    expect(html).toContain('optgroup label="Unlock full beer search"');
    expect(html).toContain('Locked - ');
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
    expect(html).toContain(".mapBrand {\n        display: none;");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr) minmax(118px, 0.82fr);");
    expect(html).toContain("flex-wrap: nowrap;");
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
    expect(venuePortalHtml).not.toContain('<select name="membershipTier">');
    expect(venuePortalHtml).not.toContain("near public transport");
    expect(venuePortalHtml).toContain('id="tierGuide"');
    expect(venuePortalHtml).toContain('return value === "pro" ? "Pro" : value === "plus" ? "Plus" : "Free";');
    expect(venuePortalHtml).toContain("Free venue accounts can add beer data and happy-hour data only.");
    expect(venuePortalHtml).toContain("data-specials-only");
  });
});
