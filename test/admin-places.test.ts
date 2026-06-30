import { afterEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
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
      ocrReason: "missing_openai_api_key",
      googlePlacesEnabled: true,
      googlePlacesReason: null,
      queueEnabled: false,
    });
  });

  it("uses strict venue type filters and drops non-venue Google results", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { includedType?: string };
      const places = body.includedType === "bar"
        ? [
            {
              id: "bar-place",
              displayName: { text: "German Beer Hall" },
              formattedAddress: "2 Example St, Melbourne VIC 3000, Australia",
              addressComponents: [
                { longText: "Melbourne", shortText: "Melbourne", types: ["locality", "political"] },
              ],
              location: { latitude: -37.81, longitude: 144.96 },
              businessStatus: "OPERATIONAL",
              primaryType: "bar",
              types: ["bar", "point_of_interest"],
            },
            {
              id: "shirt-shop",
              displayName: { text: "German Tee Shirt Shop" },
              formattedAddress: "3 Retail St, Melbourne VIC 3000, Australia",
              businessStatus: "OPERATIONAL",
              primaryType: "clothing_store",
              types: ["clothing_store", "store", "point_of_interest"],
            },
          ]
        : [];

      return new Response(JSON.stringify({ places }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      undefined,
      "test-google-places-key",
    );

    const result = await service.searchGoogleVenuePlaces("German bar");
    const requestBodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));

    expect(requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ includedType: "bar", strictTypeFiltering: true }),
        expect.objectContaining({ includedType: "pub", strictTypeFiltering: true }),
        expect.objectContaining({ includedType: "restaurant", strictTypeFiltering: true }),
      ]),
    );
    expect(result.places).toHaveLength(1);
    expect(result.places[0]).toEqual(expect.objectContaining({
      googlePlaceId: "bar-place",
      name: "German Beer Hall",
      primaryType: "bar",
    }));
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

  it("returns a clear admin-safe error when the menu OCR provider fails", async () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    (service as unknown as {
      openai: { responses: { create: ReturnType<typeof vi.fn> } };
    }).openai = {
      responses: {
        create: vi.fn(async () => {
          const error = new Error("model_not_found sk-test-secret");
          Object.assign(error, { status: 404, code: "model_not_found", type: "invalid_request_error" });
          throw error;
        }),
      },
    };

    await expect(service.ocrMenuPhoto({
      venueNameHint: "Test Venue",
      imageDataUrl: "data:image/jpeg;base64,AAAA",
    })).rejects.toMatchObject({
      statusCode: 502,
      message: "Menu OCR provider failed. Try a clearer or smaller photo, or enter the beer rows manually.",
    });
  });

  it("uses the live beer catalogue when prompting menu OCR", async () => {
    const database = new BetterSqlite3(":memory:");

    try {
      initializeDatabaseSchema(database);
      new BeerCatalogRepository(database).resolveBeerName({
        name: "Very Local Hazy Pint",
        source: "test_dynamic_catalog",
        now: "2026-06-30T00:00:00.000Z",
      });

      const service = new AdminService(
        undefined,
        undefined,
        undefined,
        "venue_menu_captures",
        "test-openai-key",
        undefined,
        database,
      );
      let prompt = "";
      const create = vi.fn(async (request: {
        input: Array<{ content: Array<{ type: string; text?: string }> }>;
      }) => {
        prompt = request.input[0]?.content.find((part) => part.type === "input_text")?.text ?? "";
        return {
          output_text: JSON.stringify({
            venue_name_guess: null,
            captured_notes: null,
            overall_confidence: 0.9,
            beers: [{
              name: "Very Local Hazy Pint",
              price_numeric: 15,
              price_text: "$15",
              availability_status: "on_tap",
              available_on_tap: true,
              available_package_only: false,
              unavailable_reason: null,
              notes: null,
              confidence: 0.92,
            }],
          }),
        };
      });
      (service as unknown as {
        openai: { responses: { create: typeof create } };
      }).openai = {
        responses: { create },
      };

      const result = await service.ocrMenuPhoto({
        venueNameHint: "Test Venue",
        imageDataUrl: "data:image/jpeg;base64,AAAA",
      });

      expect(prompt).toContain("Very Local Hazy Pint");
      expect(result.beers[0]).toEqual(expect.objectContaining({
        name: "Very Local Hazy Pint",
        needsReview: true,
      }));
    } finally {
      database.close();
    }
  });
});
