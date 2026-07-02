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
    isLatLngInBounds: (
      value: { lat?: number; lng?: number; latitude?: number; longitude?: number },
      bounds: { south: number; north: number; west: number; east: number },
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

  it("labels packaged crawler rows as cans or bottles instead of raw package-only copy", () => {
    const source = {
      availability_status: "package_only",
      unavailable_reason: "cans_or_bottles",
      price_numeric: 8,
    };
    const label = logic.getAvailabilityLabel(source);

    expect(label).toBe("Cans or bottles");
    expect(logic.getMarkerState({ priceNumeric: null, availabilityLabel: label })).toBe("package_only");
    expect(logic.getMarkerLabel({ priceNumeric: null, availabilityLabel: label })).toBe("C/B");
    expect(logic.getAvailabilityLabel({ availability_status: "package_only" })).toBe("Cans or bottles");
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

  it("rejects invalid or world-default coordinates before they can stretch map bounds", () => {
    const australiaBounds = { south: -44.5, north: -9, west: 112, east: 154.5 };

    expect(logic.isLatLngInBounds({ lat: -37.916, lng: 144.997 }, australiaBounds)).toBe(true);
    expect(logic.isLatLngInBounds({ latitude: 0, longitude: 0 }, australiaBounds)).toBe(false);
    expect(logic.isLatLngInBounds({ latitude: -37.916, longitude: 0 }, australiaBounds)).toBe(false);
    expect(logic.isLatLngInBounds({ latitude: 99, longitude: 144.997 }, australiaBounds)).toBe(false);
  });
});

describe("viewer map UI wiring", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
  const venuePortalHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-portal.html"), "utf8");

  it("renders advanced markers with visible map panels and list-mode fallback", () => {
    expect(html).toContain("renderer: clusterRenderer");
    expect(html).toContain("getClusterVisual(count)");
    expect(html).toContain("const viewState = getViewState();");
    expect(html).toContain("AdvancedMarkerElement");
    expect(html).toContain('marker.addEventListener("gmp-click", handleMarkerClick)');
    expect(html).toContain("createAdvancedMapMarker");
    expect(html).toContain("advancedMapPin");
    expect(html).toContain("advancedMapPin--priced");
    expect(html).toContain("advancedMapPin--pro");
    expect(html).toContain("const isProVenueMarker");
    expect(html).toContain('? "PRO"');
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
    expect(html).toContain("PINT_PATH_CLEAN_MAP_TYPE_ID");
    expect(html).toContain("PINT_PATH_BASE_MAP_STYLES");
    expect(html).toContain('featureType: "poi", elementType: "all"');
    expect(html).toContain('featureType: "transit", elementType: "labels.icon"');
    expect(html).toContain('featureType: "transit", elementType: "labels.text"');
    expect(html).toContain("new google.maps.StyledMapType(PINT_PATH_BASE_MAP_STYLES");
    expect(html).toContain("map.mapTypes.set(PINT_PATH_CLEAN_MAP_TYPE_ID, cleanMapType)");
    expect(html).toContain("map.setMapTypeId(PINT_PATH_CLEAN_MAP_TYPE_ID)");
    expect(html).toContain("mapOptions.styles = PINT_PATH_BASE_MAP_STYLES");
    expect(html).toContain("installCleanGoogleMapType(map)");
    expect(html).toContain('gestureHandling: "cooperative"');
    expect(html).toContain("zoomControl: false");
    expect(html).toContain("clickableIcons: false");
    expect(html).toContain("installCommandScrollZoomAssist(map, mapElement)");
    expect(html).toContain('mapElement.addEventListener("wheel"');
    expect(html).toContain("if (!event.metaKey && !event.ctrlKey)");
    expect(html).toContain("PINT_PATH_VENUE_COORDINATE_BOUNDS");
    expect(html).toContain("getMappableVenueLatLng");
    expect(html).not.toContain('id="mapZoomControls"');
    expect(html).toContain("const MAP_OVERLAYS_ENABLED = true");
    expect(html).toContain("renderVenueListFallback");
    expect(html).toContain("loadBusinessVenueRows");
    expect(html).toContain("function getBeerSearchCandidates");
    expect(html).toContain("function beerMatchesSearchQuery");
    expect(html).toContain("record.normalizedBeerId || record.beerName || record.id");
    expect(html).toContain("normalized_beer_id: record.normalizedBeerId || null");
    expect(venuePortalHtml).toContain("function findClosestTrackedBeer");
    expect(venuePortalHtml).toContain("data-use-portal-beer-suggestion");
    expect(venuePortalHtml).toContain("New beer will be saved for admin review and reused next time.");
    expect(html).toContain("Loading venue list");
    expect(html).toContain("Map tiles are unavailable, so Pint Path is loading the venue list instead.");
    expect(html).toContain("Venue list unavailable");
    expect(html).toContain('markerType: "list_fallback"');
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
    expect(html).toContain("function isBeerPriceHiddenForViewer");
    expect(html).toContain("function canReportBeerPrice");
    expect(html).toContain("const reportButtonMarkup = canReportBeerPrice(beer, markerId)");
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
    expect(html).toContain("MAP_OVERLAYS_ENABLED = true");
    expect(html).toContain('id="recentlyViewedPanel"');
    expect(html).toContain('id="recentlyViewedTitle"');
    expect(html).toContain('id="recentlyViewedList"');
    expect(html).toContain('id="clearRecentlyViewed"');
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

  it("lets venue managers refresh beer prices in a fast checklist flow", () => {
    expect(venuePortalHtml).toContain('id="priceRefreshPanel"');
    expect(venuePortalHtml).toContain('id="confirmAllPricesButton"');
    expect(venuePortalHtml).toContain("All prices are the same");
    expect(venuePortalHtml).toContain('id="priceRefreshSearch"');
    expect(venuePortalHtml).toContain('id="submitPriceRefreshButton"');
    expect(venuePortalHtml).toContain("function renderPriceRefreshPanel");
    expect(venuePortalHtml).toContain("function sortedBeerRows");
    expect(venuePortalHtml).toContain("function collectPriceRefreshUpdates");
    expect(venuePortalHtml).toContain("function submitPriceRefreshUpdates");
    expect(venuePortalHtml).toContain('data-jump-tab="${escapeHtml(nextAction.tab)}"');
    expect(venuePortalHtml).toContain('tab: "price-refresh"');
  });

  it("moves venue discount redemption into a focused code workspace", () => {
    expect(venuePortalHtml).toContain('data-tab="redemption"');
    expect(venuePortalHtml).toContain('data-panel="redemption"');
    expect(venuePortalHtml).toContain("Redeem a user code");
    expect(venuePortalHtml).toContain("Manual now · POS ready");
    expect(venuePortalHtml).toContain('id="discountSpecialChoices"');
    expect(venuePortalHtml).toContain('id="selectedDiscountSpecial"');
    expect(venuePortalHtml).toContain('name="specialId" type="hidden"');
    expect(venuePortalHtml).toContain("function renderDiscountSpecialChoices");
    expect(venuePortalHtml).toContain("function syncSelectedDiscountSpecial");
    expect(venuePortalHtml).toContain("function renderRedemptionItemOptions");
    expect(venuePortalHtml).toContain("function syncRedemptionItemSelection");
    expect(venuePortalHtml).toContain('<select name="itemName" required>');
    expect(venuePortalHtml).toContain('optgroup label="Pint Path specials"');
    expect(venuePortalHtml).toContain('optgroup label="Beers / stock"');
    expect(venuePortalHtml).toContain('data-savings-dollars="0">$0');
    expect(venuePortalHtml).toContain('name="estimatedSavingsDollars" type="hidden" value="0"');
    expect(venuePortalHtml).toContain("added automatically");
    expect(venuePortalHtml).not.toContain("Fixed-price special selected. Enter actual savings if you want it tracked.");
    expect(venuePortalHtml).not.toContain("Issue Pint Points");
    expect(venuePortalHtml).not.toContain("Fast drink labels");
    expect(venuePortalHtml).toContain("data-discount-special-id");
    expect(venuePortalHtml).toContain('data-jump-tab="redemption"');
    expect(venuePortalHtml).toContain('specialId: field(discountRedemptionFormElement, "specialId").value || null');
  });

  it("gives venue managers support and structured opening-hour controls", () => {
    expect(venuePortalHtml).toContain('data-tab="support"');
    expect(venuePortalHtml).toContain('data-panel="support"');
    expect(venuePortalHtml).toContain('id="venueSupportForm"');
    expect(venuePortalHtml).toContain('MelbBeerBusiness.apiFetch("/api/business/feedback"');
    expect(venuePortalHtml).toContain('id="openingHoursEditor"');
    expect(venuePortalHtml).toContain('data-opening-day="${escapeHtml(dayKey)}"');
    expect(venuePortalHtml).toContain('type="time" data-opening-start');
    expect(venuePortalHtml).toContain('type="time" data-opening-end');
    expect(venuePortalHtml).toContain("function collectOpeningHours");
    expect(venuePortalHtml).toContain('openingHours: collectOpeningHours()');
    expect(venuePortalHtml).not.toContain('name="openingHoursNote"');
  });

  it("requires an ending time when venues add Pint Path specials", () => {
    expect(venuePortalHtml).toContain("Ending time");
    expect(venuePortalHtml).toContain("Choose start time");
    expect(venuePortalHtml).toContain("Choose ending time");
    expect(venuePortalHtml).toContain("specialScheduleDays");
    expect(venuePortalHtml).toContain("specialScheduleTime");
    expect(venuePortalHtml).toContain("for (let hour = 0; hour <= 23; hour += 1)");
    expect(venuePortalHtml).toContain("Choose both a start time and ending time for the Pint Path special.");
    expect(venuePortalHtml).toContain("startTime: specialStartTime");
    expect(venuePortalHtml).toContain("endTime: specialEndTime");
    expect(venuePortalHtml).toContain("specialTimeRangeCopy(item)");
  });

  it("surfaces the premium tiered venue command centre preview", () => {
    expect(venuePortalHtml).toContain('id="premiumVenueDashboard"');
    expect(venuePortalHtml).toContain('id="dashboardSetupProgress"');
    expect(venuePortalHtml).toContain('id="venueDailyActions"');
    expect(venuePortalHtml).toContain('id="venuePulseGrid"');
    expect(venuePortalHtml).toContain('id="weeklyActionCard"');
    expect(venuePortalHtml).toContain('id="businessToolkit"');
    expect(venuePortalHtml).toContain('id="qualityScore"');
    expect(venuePortalHtml).toContain('id="priceRecords"');
    expect(venuePortalHtml).toContain("function renderDashboardSetupProgress");
    expect(venuePortalHtml).toContain("function renderVenueDailyActions");
    expect(venuePortalHtml).toContain("function renderPremiumVenueDashboard");
    expect(venuePortalHtml).toContain("function focusVenueField");
    expect(venuePortalHtml).toContain("renderVenuePulseGrid(data)");
    expect(venuePortalHtml).toContain("renderBusinessToolkit(data)");
    expect(venuePortalHtml).toContain("window.confirm(`Remove this ${label}?");
    expect(venuePortalHtml).toContain('data-focus-venue-field="beerName"');
    expect(venuePortalHtml).toContain("formatAppValueHeadline");
    expect(venuePortalHtml).toContain("No app redemptions logged yet");
    expect(venuePortalHtml).toContain("No redemptions yet");
    expect(venuePortalHtml).toContain("Record codes in staff mode");
    expect(venuePortalHtml).toContain("Invite staff");
    expect(venuePortalHtml).toContain("visibleActions.length < 4");
    expect(venuePortalHtml).toContain("VENUE_DASHBOARD_FEATURES");
    expect(venuePortalHtml).not.toContain("premiumPlanSwitcher");
    expect(venuePortalHtml).not.toContain("Avg spend");
    expect(venuePortalHtml).toContain("data-dashboard-section");
    expect(venuePortalHtml).toContain("premiumDashboardSubnav");
    expect(venuePortalHtml).toContain("App Value Overview");
    expect(venuePortalHtml).toContain("Demand Signals");
    expect(venuePortalHtml).toContain("Growth recommendations");
    expect(venuePortalHtml).toContain("function buildGrowthRecommendations");
    expect(venuePortalHtml).toContain("Lost opportunity risk");
    expect(venuePortalHtml).toContain("Price freshness");
    expect(venuePortalHtml).toContain("Specials strategy");
    expect(venuePortalHtml).toContain("premiumLockedCard");
    expect(venuePortalHtml).not.toContain("Demand score");
  });

  it("renders the simplified public header, primary controls, and shared advanced filters", () => {
    expect(html).toContain('class="mapNavCard" aria-label="Primary"');
    expect(html).toContain('class="mapBrand" href="/"');
    expect(html).toContain('class="mapHeroCard" aria-label="Map overview"');
    expect(html.indexOf('class="mapHeroCard"')).toBeLessThan(html.indexOf('class="mapNavCard"'));
    expect(html).toContain('<strong>Pint Path</strong>');
    expect(html).toContain('<div class="topbar__eyebrow">Melbourne beer map <span class="fieldTestBadge">Beta</span></div>');
    expect(html).toContain("<h1>Pint Path</h1>");
    expect(html).not.toContain("Verified local price index");
    expect(html).toContain('id="topbarBusinessLinks"');
    expect(html.indexOf('href="/submit.html">Submit')).toBeLessThan(
      html.indexOf('href="/missions.html">Missions'),
    );
    expect(html).toContain('href="/feedback.html" id="topbarFeedbackLink">Contact us');
    expect(html).not.toContain("data-venue-hidden");
    expect(html).toContain('id="accessPill"');
    const responsibleNote = html.match(/<div class="responsibleNote">([\s\S]*?)<\/div>/)?.[1] || "";
    expect(responsibleNote).toContain("Prices may change. Check with the venue before ordering. Drink responsibly.");
    expect(responsibleNote).not.toContain("<a ");
    expect(html).toContain('class="controlDeck"');
    expect(html).toContain("Find a venue fast");
    expect(html).toContain('placeholder="Area or venue"');
    expect(html).toContain('<select id="beerSearch" class="controlInput beerSelect">');
    expect(html).toContain('<option value="">Beer</option>');
    expect(html).toContain("function isBeerDropdownLabel(label)");
    expect(html).toContain("BEER_DROPDOWN_EXCLUDED_KEYS");
    expect(html).toContain("isBeerDropdownLabel(displayLabel)");
    expect(html).toContain("included_you_ll_find");
    expect(html).toContain("ipa");
    expect(html).toContain("/[/?=*$%]/.test(normalizedValue)");
    expect(html).toContain("words.length > 7");
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
    expect(html).toContain(".mapBrand {\n        display: inline-flex;");
    expect(html).toContain(".mapBrandText {\n        display: none;");
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
    expect(venuePortalHtml).not.toContain('id="tierGuide"');
    expect(venuePortalHtml).not.toContain("Current plan");
    expect(venuePortalHtml).toContain('data-tab="pending-reviews"');
    expect(venuePortalHtml).toContain('return value === "pro" || value === "plus" ? "Pro" : "Free";');
    expect(venuePortalHtml).toContain("Free venue accounts can add beer data and happy-hour data only.");
    expect(venuePortalHtml).toContain("data-specials-only");
  });
});
