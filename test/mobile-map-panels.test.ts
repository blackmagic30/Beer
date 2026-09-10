import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.resolve("viewer/index.html"), "utf8");
const start = html.indexOf("    function readOverlayState() {");
const end = html.indexOf('    document.addEventListener("click", async (event) => {', start);
const controller = html.slice(start, end);

function element(hidden = false, panel = "") {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const events = new Map<string, () => void>();
  return {
    hidden, inert: false, dataset: { overlayPanel: panel },
    classList: {
      add(name: string) { classes.add(name); },
      toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    getAttribute(name: string) { return attributes.get(name); },
    addEventListener(name: string, callback: () => void) { events.set(name, callback); },
    click() { events.get("click")?.(); },
  };
}

function loadPanels(mobile: boolean, enabled = true) {
  const initialTabs = html.match(/<div id="mapOverlayTabs"[^>]*>/)?.[0] ?? "";
  const tabs = element(/\bhidden\b/.test(initialTabs));
  const rail = element();
  const legend = element();
  const listButton = element(false, "list");
  const legendButton = element(false, "legend");
  const closeList = element();
  const closeLegend = element();
  const storage = new Map<string, string>();
  const context = vm.createContext({
    MAP_OVERLAYS_ENABLED: enabled, MAP_OVERLAY_STORAGE_KEY: "test-map-panels",
    mobileOverlayQuery: { matches: mobile }, mapOverlayTabsEl: tabs,
    venueRailEl: rail, mapLegendEl: legend, overlayTabEls: [listButton, legendButton],
    closeVenueRailEl: closeList, closeMapLegendEl: closeLegend,
    window: { localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } },
  });
  // Execute the real initial active-map controller, without invoking the map
  // failure path that automatically opens the list and used to hide this bug.
  vm.runInContext(`${controller}\nsyncOverlayPanels();`, context);
  return { tabs, rail, legend, listButton, legendButton, closeList };
}

describe("mobile active-map panel access", () => {
  it("exposes the intended list control and allows opening, closing and reopening on a phone", () => {
    const ui = loadPanels(true);
    expect(ui.rail.getAttribute("aria-hidden")).toBe("true");
    expect(ui.rail.inert).toBe(true);
    expect(ui.tabs.hidden).toBe(false);
    ui.listButton.click();
    expect(ui.rail.getAttribute("aria-hidden")).toBe("false");
    expect(ui.rail.inert).toBe(false);
    expect(ui.listButton.getAttribute("aria-pressed")).toBe("true");
    ui.closeList.click();
    expect(ui.rail.getAttribute("aria-hidden")).toBe("true");
    expect(ui.tabs.hidden).toBe(false);
    ui.listButton.click();
    expect(ui.rail.inert).toBe(false);
    ui.legendButton.click();
    expect(ui.rail.inert).toBe(true);
    expect(ui.legend.inert).toBe(false);
  });

  it("preserves the initial desktop list and intentionally disabled controls", () => {
    const desktop = loadPanels(false);
    expect(desktop.tabs.hidden).toBe(false);
    expect(desktop.rail.inert).toBe(false);
    const disabled = loadPanels(true, false);
    expect(disabled.tabs.hidden).toBe(true);
    expect(disabled.rail.inert).toBe(true);
    expect(disabled.legend.inert).toBe(true);
  });
});
