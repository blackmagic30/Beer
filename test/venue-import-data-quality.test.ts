import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  assertVenueDiscoveryComplete,
  assertSupabaseProjectTarget,
  assertVenueStatusRefreshComplete,
  mapPlaceToVenue,
  type VenueMappingResult,
} from "../scripts/import-melbourne-venues.js";
import type { GooglePlaceCandidate } from "../src/lib/venue-directory.js";

const CHECKED_AT = "2026-07-28T10:30:00.000Z";

function googleVenue(overrides: Partial<GooglePlaceCandidate> = {}): GooglePlaceCandidate {
  return {
    id: "google-place-1",
    displayName: { text: "The Test Hotel" },
    formattedAddress: "1 Example St, Melbourne VIC 3000, Australia",
    addressComponents: [
      { longText: "Melbourne", shortText: "Melbourne", types: ["locality"] },
      { longText: "Victoria", shortText: "VIC", types: ["administrative_area_level_1"] },
      { longText: "3000", shortText: "3000", types: ["postal_code"] },
    ],
    location: { latitude: -37.8136, longitude: 144.9631 },
    internationalPhoneNumber: "+61 3 9000 1000",
    websiteUri: "https://test-hotel.example.com/",
    businessStatus: "OPERATIONAL",
    primaryType: "pub",
    types: ["pub", "point_of_interest"],
    ...overrides,
  };
}

function expectVenue(result: VenueMappingResult) {
  expect(result.outcome).toBe("venue");
  if (result.outcome !== "venue") {
    throw new Error(`Expected venue mapping, received ${result.outcome}.`);
  }
  return result.venue;
}

describe("Melbourne venue importer data quality", () => {
  it("keeps scheduled status refreshes separate from partial discovery modes", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/import-melbourne-venues.ts"),
      "utf8",
    );

    expect(source).toContain('hasFlag("status-only")');
    expect(source).toContain(
      "--status-only cannot be combined with discovery, backfill, or --max-cells options.",
    );
    expect(source).toContain('"existing-place-status-refresh"');
    expect(source).toContain('"directory-discovery-and-status-refresh"');
  });

  it("refuses a partial refresh before directory writes begin", () => {
    expect(() => assertVenueDiscoveryComplete([], [])).not.toThrow();
    expect(() => assertVenueDiscoveryComplete(["-37.8,144.9"], []))
      .toThrow(/refusing to write a partial directory refresh/i);
    expect(() => assertVenueDiscoveryComplete([], ["bars in Carlton Melbourne"]))
      .toThrow(/failed text-search queries: 1/i);
    expect(() => assertVenueStatusRefreshComplete([])).not.toThrow();
    expect(() => assertVenueStatusRefreshComplete(["hashed-place-id"]))
      .toThrow(/failed google place detail checks: 1/i);
  });

  it("requires the Supabase project reference to match the exact target", () => {
    expect(assertSupabaseProjectTarget(
      "https://jxpubqlmqnnqwadmjgyk.supabase.co",
      "jxpubqlmqnnqwadmjgyk",
    )).toBe("jxpubqlmqnnqwadmjgyk");
    expect(() => assertSupabaseProjectTarget(
      "https://gjjffexmflwtnewtkkiy.supabase.co",
      "jxpubqlmqnnqwadmjgyk",
    )).toThrow(/project target mismatch/i);
    expect(() => assertSupabaseProjectTarget(
      "https://jxpubqlmqnnqwadmjgyk.supabase.co",
      undefined,
    )).toThrow(/un pinned|unpinned/i);
  });

  it("persists contact, operational status, and check provenance", () => {
    expect(expectVenue(mapPlaceToVenue(googleVenue(), CHECKED_AT))).toEqual(expect.objectContaining({
      google_place_id: "google-place-1",
      postcode: "3000",
      phone: "+61 3 9000 1000",
      website: "https://test-hotel.example.com/",
      business_status: "OPERATIONAL",
      last_checked_at: CHECKED_AT,
      directory_eligible: true,
    }));
  });

  it.each(["CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"] as const)(
    "preserves %s rows so the public directory can filter without deleting evidence",
    (businessStatus) => {
      expect(expectVenue(mapPlaceToVenue(googleVenue({ businessStatus }), CHECKED_AT)))
        .toEqual(expect.objectContaining({ business_status: businessStatus }));
    },
  );

  it("quarantines malformed structured postcodes without creating a write payload", () => {
    const result = mapPlaceToVenue(googleVenue({
      addressComponents: [
        { longText: "Melbourne", shortText: "Melbourne", types: ["locality"] },
        { longText: "3OOO", shortText: "3OOO", types: ["postal_code"] },
      ],
    }), CHECKED_AT);

    expect(result).toEqual({
      outcome: "quarantined",
      reason: "invalid_postcode",
      googlePlaceId: "google-place-1",
      venueName: "The Test Hotel",
    });
    expect(result).not.toHaveProperty("venue");
  });

  it("quarantines missing or unsupported business status instead of assuming a venue is active", () => {
    expect(mapPlaceToVenue(googleVenue({ businessStatus: undefined }), CHECKED_AT))
      .toEqual(expect.objectContaining({
        outcome: "quarantined",
        reason: "missing_or_invalid_business_status",
      }));
    expect(mapPlaceToVenue(googleVenue({ businessStatus: "BUSINESS_STATUS_UNSPECIFIED" }), CHECKED_AT))
      .toEqual(expect.objectContaining({
        outcome: "quarantined",
        reason: "missing_or_invalid_business_status",
      }));
  });

  it("uses a valid four-digit address fallback when Google omits the postcode component", () => {
    const venue = expectVenue(mapPlaceToVenue(googleVenue({ addressComponents: [] }), CHECKED_AT));
    expect(venue.postcode).toBe("3000");
  });
});
