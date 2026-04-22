import { describe, expect, it } from "vitest";

import {
  buildReviewVenueRow,
  hasStrongBarOrPubNameSignal,
  isStrictBarOrPubPlace,
  isRestaurantLedVenueName,
  shouldImportBarOrPubPlace,
} from "../src/lib/venue-directory.js";

describe("isStrictBarOrPubPlace", () => {
  it("accepts Google places tagged as a pub", () => {
    expect(
      isStrictBarOrPubPlace({
        primaryType: "pub",
        types: ["pub", "point_of_interest"],
      }),
    ).toBe(true);
  });

  it("rejects non-bar hospitality venues", () => {
    expect(
      isStrictBarOrPubPlace({
        primaryType: "restaurant",
        types: ["restaurant", "food"],
      }),
    ).toBe(false);
  });

  it("rejects restaurant-primary places even when bar appears in secondary types", () => {
    expect(
      isStrictBarOrPubPlace({
        primaryType: "restaurant",
        types: ["restaurant", "bar", "food"],
      }),
    ).toBe(false);
  });

  it("accepts Google places tagged as a brewery", () => {
    expect(
      isStrictBarOrPubPlace({
        primaryType: "brewery",
        types: ["brewery", "food", "point_of_interest"],
      }),
    ).toBe(true);
  });
});

describe("name heuristics", () => {
  it("spots restaurant-led venue names", () => {
    expect(isRestaurantLedVenueName("Venue Sixty-Nine Restaurant & Bar")).toBe(true);
  });

  it("keeps strong pub and brewery signals", () => {
    expect(hasStrongBarOrPubNameSignal("The Standard Hotel")).toBe(true);
    expect(hasStrongBarOrPubNameSignal("Mountain Goat Brewery")).toBe(true);
  });
});

describe("shouldImportBarOrPubPlace", () => {
  it("keeps clean pub results", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "The Duke of Wellington" },
        formattedAddress: "146 Flinders St, Melbourne VIC 3000, Australia",
        primaryType: "pub",
        types: ["pub", "point_of_interest"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(true);
  });

  it("filters noisy non-pub results even if they look hospitality-adjacent", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Qantas International Business Lounge Melbourne" },
        formattedAddress: "Tullamarine VIC 3045, Australia",
        primaryType: "bar",
        types: ["bar", "airport_lounge"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(false);
  });

  it("filters suspicious business-style names that slipped through place typing", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Red Rock Airport Services Pty Ltd" },
        formattedAddress: "2 Service Rd, Melbourne Airport VIC 3045, Australia",
        primaryType: "bar",
        types: ["bar", "point_of_interest"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(false);
  });

  it("filters pickle-club and shisha venue names from import", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Royal Pickle Club Carrum Downs" },
        formattedAddress: "Test Address",
        primaryType: "bar",
        types: ["bar", "point_of_interest"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(false);

    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Sahara Lounge And Shisha Cafe" },
        formattedAddress: "Test Address",
        primaryType: "bar",
        types: ["bar", "point_of_interest"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(false);
  });

  it("filters restaurant-led bar names that are not true bar/pub/brewery venues", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Venue Sixty-Nine Restaurant & Bar" },
        formattedAddress: "Test Address",
        primaryType: "bar",
        types: ["bar", "restaurant", "food"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(false);
  });

  it("keeps brewery venues even when the name is not a pub or hotel", () => {
    expect(
      shouldImportBarOrPubPlace({
        displayName: { text: "Mountain Goat Brewery" },
        formattedAddress: "Test Address",
        primaryType: "brewery",
        types: ["brewery", "food", "point_of_interest"],
        businessStatus: "OPERATIONAL",
      }),
    ).toBe(true);
  });
});

describe("buildReviewVenueRow", () => {
  it("marks rows with normalized phone and coordinates as call-eligible", () => {
    const row = buildReviewVenueRow({
      id: "venue-1",
      name: "The Local",
      suburb: "Richmond",
      address: "1 Swan St, Richmond VIC 3121, Australia",
      phone: "(03) 9999 8888",
      normalizedPhone: "+61399998888",
      latitude: -37.82,
      longitude: 144.99,
      source: "google_places_bar_pub",
      alreadyCalled: false,
      latestCallAt: null,
    });

    expect(row.callEligible).toBe(true);
    expect(row.issues).toEqual([]);
  });

  it("marks already-called or incomplete rows for review", () => {
    const row = buildReviewVenueRow({
      id: "venue-2",
      name: "Another Venue",
      suburb: "Melbourne",
      address: "2 Example St, Melbourne VIC 3000, Australia",
      phone: null,
      normalizedPhone: null,
      latitude: null,
      longitude: null,
      source: "google_places_bar_pub",
      alreadyCalled: true,
      latestCallAt: "2026-04-13T10:00:00.000Z",
    });

    expect(row.callEligible).toBe(false);
    expect(row.issues).toEqual([
      "missing_e164_phone",
      "missing_coordinates",
      "already_called",
    ]);
  });

  it("marks suspicious venue names as not call-eligible", () => {
    const row = buildReviewVenueRow({
      id: "venue-3",
      name: "Golf Square Sunshine",
      suburb: "Sunshine North",
      address: "8 Annastasia Way, Sunshine North VIC 3020",
      phone: "(03) 9689 1888",
      normalizedPhone: "+61396891888",
      latitude: -37.77,
      longitude: 144.82,
      source: "google_places_bar_pub",
      alreadyCalled: false,
      latestCallAt: null,
    });

    expect(row.callEligible).toBe(false);
    expect(row.issues).toContain("suspicious_venue_name");
  });

  it("marks pickle-club names as suspicious for calling", () => {
    const row = buildReviewVenueRow({
      id: "venue-4",
      name: "Royal Pickle Club Carrum Downs",
      suburb: "Carrum Downs",
      address: "Test",
      phone: "(03) 8845 8344",
      normalizedPhone: "+61388458344",
      latitude: -38,
      longitude: 145,
      source: "google_places_bar_pub",
      alreadyCalled: false,
      latestCallAt: null,
    });

    expect(row.callEligible).toBe(false);
    expect(row.issues).toContain("suspicious_venue_name");
  });
});
