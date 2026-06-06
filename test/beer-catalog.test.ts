import { describe, expect, it } from "vitest";

import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName, findTrackedBeerByName } from "../src/constants/beers.js";

describe("Pint Path beer catalogue", () => {
  it("provides a broad dropdown catalogue for venue-owner beer entry", () => {
    expect(VIEWER_TRACKED_BEERS.length).toBeGreaterThanOrEqual(80);
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Balter XPA");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Coopers Pale Ale");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Asahi Super Dry");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Carlton Draught");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).toContain("Resch's Draught");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).not.toContain("Carlton Draft");
    expect(VIEWER_TRACKED_BEERS.map((beer) => beer.name)).not.toContain("Reschs Draught");
  });

  it("canonicalises common aliases so venue rows do not fork misspelled beer names", () => {
    expect(canonicalizeTrackedBeerName("Carlton Draft")).toBe("Carlton Draught");
    expect(canonicalizeTrackedBeerName("Carlton Draught")).toBe("Carlton Draught");
    expect(findTrackedBeerByName("Carlton Draft")).toEqual(expect.objectContaining({
      key: "carlton_draft",
      name: "Carlton Draught",
    }));
    expect(canonicalizeTrackedBeerName("stone and wood")).toBe("Stone & Wood Pacific Ale");
    expect(canonicalizeTrackedBeerName("reschs")).toBe("Resch's Draught");

    const beer = findTrackedBeerByName("balter xpa");
    expect(beer).toEqual(expect.objectContaining({
      name: "Balter XPA",
      brewery: "Balter",
      style: "XPA",
    }));
  });

  it("does not publish duplicate visible names in the tracked catalogue", () => {
    const names = VIEWER_TRACKED_BEERS.map((beer) => beer.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});
