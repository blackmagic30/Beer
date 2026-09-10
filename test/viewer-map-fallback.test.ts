import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = fs.readFileSync(path.resolve("viewer/index.html"), "utf8");
const section = (start: string, end: string) => {
  const index = html.indexOf(start);
  return index < 0 ? "" : html.slice(index, html.indexOf(end, index));
};
const fallback = section("    async function renderVenueListFallback(", "    function formatAddress(");
const authFailure = section("    window.gm_authFailure =", "    async function loadGoogleMapsScript(");
const starter = section("    function startVenueListFallback(", "    async function renderVenueListFallback(");
const initStart = html.indexOf("    async function init() {");
const initPrefix = html.slice(initStart, html.indexOf("        analyticsVenueRows = allVenueRows;", initStart));
const initCatch = html.slice(html.lastIndexOf("      } catch (error) {"), html.indexOf('    window.addEventListener("DOMContentLoaded"'));
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const rows = [{ id: "mapped" }, { id: "without-coordinates" }];
  const messages: string[] = [];
  const load = vi.fn(async (_includeUnmappable?: boolean) => ({ allVenueRows: rows, venueRows: rows }));
  const clearMapListeners = vi.fn();
  const maps = vi.fn(function () { return {}; });
  const title = { textContent: "On this part of the map" };
  const rail = vi.fn((records: unknown[]) => { title.textContent = "Venue list mode"; return records; });
  const bind = vi.fn();
  const control = new EventTarget();
  const click = vi.fn();
  const noop = () => {};
  const window = { google: { maps: { Map: maps, LatLngBounds: class {}, marker: { AdvancedMarkerElement: class {} }, event: { clearInstanceListeners: clearMapListeners } } }, gm_authFailure: noop };
  const context = vm.createContext({
    window, google: window.google, console: { info: noop }, AbortController, Promise, Error,
    testControl: control, testClick: click,
    googleMapsAuthFailed: false, venueListFallbackPromise: null, stopActiveMap: noop,
    googleMapInstance: {}, focusVenueMarker: noop,
    searchThisAreaButtonEl: { hidden: false }, mobileOverlayQuery: { matches: true }, overlayPanelState: {},
    syncOverlayPanels: noop, venueRailTitleEl: title, venueRailCountEl: {}, venueRailSubtitleEl: {}, venueRailBodyEl: {},
    loadBusinessVenueRows: load, renderMapFailure: (message: string) => messages.push(message), fail: noop,
    analyticsVenueRows: [], beerOptionRows: [], applySharedSearchParams: noop, buildBeerSuggestionList: noop,
    renderTrackedBeerChips: noop, getViewState: () => ({}), rowMatchesView: () => true,
    createListModeVenueRecord: (row: unknown) => row, syncStatusPills: noop, renderLegend: noop,
    renderVenueRail: rail, initialSharedVenueId: "", initialSharedVenueOpened: false,
    bindVenueListFallbackControls: bind, trackBusinessEvent: noop, getAnalyticsContext: noop,
    syncAuthenticatedNavLinks: noop, loadGoogleMapsScript: async () => {}, refreshBusinessAccess: async () => {},
    readStoredVenues: () => [], RECENTLY_VIEWED_STORAGE_KEY: "", MAX_RECENT_VENUES: 0,
    NIGHT_PLAN_STORAGE_KEY: "", MAX_NIGHT_PLAN_STOPS: 0, loadSavedVenueState: async () => {},
    renderRecentlyViewedPanel: noop, renderNightPlanPanel: noop, document: { getElementById: () => ({}) },
    MAP_DEFAULT_ZOOM: 12, EFFECTIVE_GOOGLE_MAPS_MAP_ID: "fixture", GOOGLE_MAPS_KEY: "fixture",
    installCommandScrollZoomAssist: noop, loadMarkerClustererScript: async () => {},
  });
  // Execute the actual initialization through its asynchronous provider/data
  // boundaries; marker rendering is outside this transition fixture.
  const controlProbe = 'if (typeof bindMapControl === "function") bindMapControl(testControl, "click", testClick);';
  vm.runInContext(`${starter}\n${fallback}\n${authFailure}\n${initPrefix}\n${controlProbe}\n${initCatch}`, context);
  return { context, window, rows, load, rail, bind, title, messages, maps, clearMapListeners, control, click };
}

describe("Google Maps authentication failure transition", () => {
  it("moves a settled map into one full-directory fallback even when auth failure repeats", async () => {
    const f = fixture();
    await vm.runInContext("init()", f.context);
    f.control.dispatchEvent(new Event("click"));
    f.load.mockClear();
    f.window.gm_authFailure();
    f.window.gm_authFailure();
    await flush();
    expect(f.load).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.context.googleMapInstance).toBeNull();
    expect(f.clearMapListeners).toHaveBeenCalledTimes(1);
    f.control.dispatchEvent(new Event("click"));
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(f.title.textContent).toBe("Venue list mode");
    expect(f.rail).toHaveBeenCalledWith(f.rows, {});
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.messages.join(" ")).not.toMatch(/localhost|API key|billing|project|SQL/i);
  });

  it("does not recreate a map when authentication fails during the marker-library await", async () => {
    const f = fixture();
    const marker = deferred<{ AdvancedMarkerElement: unknown }>();
    Object.assign(f.window.google.maps, { marker: undefined, importLibrary: () => marker.promise });
    const initializing = vm.runInContext("init()", f.context);
    await flush();
    f.window.gm_authFailure();
    await flush();
    marker.resolve({ AdvancedMarkerElement: class {} });
    await initializing;
    await flush();
    expect(f.maps).not.toHaveBeenCalled();
    expect(f.context.googleMapInstance).toBeNull();
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.title.textContent).toBe("Venue list mode");
  });

  it("keeps fallback authoritative when the original map data finishes loading afterward", async () => {
    const f = fixture();
    const original = deferred<{ allVenueRows: unknown[]; venueRows: unknown[] }>();
    f.context.loadBusinessVenueRows = (includeUnmappable: boolean) => includeUnmappable
      ? f.load(true)
      : original.promise;
    const initializing = vm.runInContext("init()", f.context);
    await flush();
    expect(f.maps).toHaveBeenCalledTimes(1);
    f.window.gm_authFailure();
    await flush();
    original.resolve({ allVenueRows: [], venueRows: [] });
    await initializing;
    expect(f.context.googleMapInstance).toBeNull();
    expect(f.load).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.rail).toHaveBeenLastCalledWith(f.rows, {});
    expect(f.bind).toHaveBeenCalledTimes(1);
  });

  it("retires map callbacks before awaiting the fallback directory", async () => {
    const f = fixture();
    const directory = deferred<{ allVenueRows: unknown[]; venueRows: unknown[] }>();
    const staleMapCallback = vi.fn();
    Object.assign(f.window, {
      __melbBeerMapRefreshVisibleRail: staleMapCallback,
      __melbBeerMapAfterLocationChange: staleMapCallback,
      __openStoredVenue: staleMapCallback,
    });
    f.load.mockImplementationOnce(() => directory.promise);
    f.window.gm_authFailure();
    await flush();
    vm.runInContext(`
      window.__melbBeerMapRefreshVisibleRail();
      window.__melbBeerMapAfterLocationChange("pending_location");
      window.__openStoredVenue("mapped");
    `, f.context);
    expect(staleMapCallback).not.toHaveBeenCalled();
    expect(f.rail).not.toHaveBeenCalled();
    expect(f.title.textContent).toBe("Loading venue list");
    directory.resolve({ allVenueRows: f.rows, venueRows: f.rows });
    await flush();
    vm.runInContext("window.__melbBeerMapRefreshVisibleRail()", f.context);
    expect(f.rail).toHaveBeenCalledTimes(2);
    expect(f.rail).toHaveBeenLastCalledWith(f.rows, {});
  });

  it("shows recovery copy if the fallback directory also fails without leaking its error", async () => {
    const f = fixture();
    const staleMapCallback = vi.fn();
    Object.assign(f.window, {
      __melbBeerMapRefreshVisibleRail: staleMapCallback,
      __melbBeerMapAfterLocationChange: staleMapCallback,
      __openStoredVenue: staleMapCallback,
    });
    f.load.mockRejectedValue(new Error("SQL relation private_internal is missing"));
    f.window.gm_authFailure();
    await flush();
    expect(f.context.googleMapInstance).toBeNull();
    expect(f.title.textContent).toBe("Venue list unavailable");
    expect(f.messages.join(" ")).toContain("Refresh to try again");
    expect(f.messages.join(" ")).not.toMatch(/SQL|private_internal/);
    vm.runInContext(`
      window.__melbBeerMapRefreshVisibleRail();
      window.__melbBeerMapAfterLocationChange("pending_location");
      window.__openStoredVenue("mapped");
    `, f.context);
    expect(staleMapCallback).not.toHaveBeenCalled();
  });

  it("does not expose an internal initialization error while preserving the usable list", async () => {
    const f = fixture();
    f.context.refreshBusinessAccess = async () => { throw new Error("SQL connection failed at private-provider.example"); };
    await vm.runInContext("init()", f.context);
    expect(f.messages.join(" ")).not.toMatch(/SQL|private-provider/);
    expect(f.title.textContent).toBe("Venue list mode");
  });
});
