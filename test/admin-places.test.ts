import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminService } from "../src/modules/admin/admin.service.js";

describe("admin Google Places venue lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports Google venue add as ready when a server key is configured", () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      "test-google-places-key",
    );

    expect(service.getStatus()).toEqual({
      enabled: false,
      ocrEnabled: false,
      googlePlacesEnabled: true,
      queueEnabled: false,
    });
  });

  it("normalizes selected Google place details for the admin venue form", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "ChIJ123",
      displayName: { text: "The Test Hotel" },
      formattedAddress: "1 Example St, Melbourne VIC 3000, Australia",
      addressComponents: [
        { longText: "Melbourne", shortText: "Melbourne", types: ["locality", "political"] },
        { longText: "Victoria", shortText: "VIC", types: ["administrative_area_level_1", "political"] },
        { longText: "3000", shortText: "3000", types: ["postal_code"] },
      ],
      location: { latitude: -37.8136, longitude: 144.9631 },
      internationalPhoneNumber: "+61 3 9999 8888",
      websiteUri: "https://example.test",
      businessStatus: "OPERATIONAL",
      primaryType: "pub",
      types: ["pub", "bar", "point_of_interest"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      "test-google-places-key",
    );

    const result = await service.getGoogleVenuePlace("ChIJ123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places/ChIJ123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Goog-Api-Key": "test-google-places-key",
          "X-Goog-FieldMask": expect.stringContaining("internationalPhoneNumber"),
        }),
      }),
    );
    expect(result).toEqual({
      configured: true,
      place: expect.objectContaining({
        googlePlaceId: "ChIJ123",
        name: "The Test Hotel",
        address: "1 Example St, Melbourne VIC 3000",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        phone: "+61 3 9999 8888",
        website: "https://example.test",
        latitude: -37.8136,
        longitude: 144.9631,
        recommended: true,
        alreadyExists: false,
      }),
    });
  });
});
