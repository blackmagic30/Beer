import { afterEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { externalProviderCostBudgetInternals } from "../src/lib/external-provider-cost-budget.js";
import { AdminService } from "../src/modules/admin/admin.service.js";

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]).toString("base64")}`;
const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from(
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF",
  "ascii",
).toString("base64")}`;

describe("admin Google Places venue lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
        redirect: "error",
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
      imageDataUrl: JPEG_DATA_URL,
    })).rejects.toMatchObject({
      statusCode: 502,
      message: "Menu OCR provider failed. Try a clearer or smaller photo, or enter the beer rows manually.",
    });
  });

  it("uses the live beer catalogue when prompting menu OCR", async () => {
    const database = new BetterSqlite3(":memory:");

    try {
      initializeDatabaseSchema(database);
      const sqlDatabase = asAsyncSqliteDatabase(database);
      const beerCatalog = new BeerCatalogRepository(sqlDatabase);
      await beerCatalog.resolveBeerName({
        name: "Very Local Hazy Pint",
        source: "test_dynamic_catalog",
        now: "2026-06-30T00:00:00.000Z",
      });
      await beerCatalog.approvePendingBeer({
        key: "very_local_hazy_pint",
        now: "2026-06-30T00:01:00.000Z",
      });

      const service = new AdminService(
        undefined,
        undefined,
        undefined,
        "venue_menu_captures",
        "test-openai-key",
        undefined,
        sqlDatabase,
      );
      const prompts: string[] = [];
      const create = vi.fn(async (request: {
        model: string;
        input: Array<{ content: Array<{ type: string; text?: string; detail?: string }> }>;
      }) => {
        prompts.push(request.input[0]?.content.find((part) => part.type === "input_text")?.text ?? "");
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

      const result = await service.ocrMenuPhotos({
        venueNameHint: "Test Venue",
        imageDataUrls: [JPEG_DATA_URL],
        documentDataUrls: [PDF_DATA_URL],
      });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: "gpt-5.6-sol",
        store: false,
        max_output_tokens: 8_192,
        reasoning: { effort: "low" },
        text: expect.objectContaining({
          format: expect.objectContaining({ type: "json_schema", strict: true }),
        }),
        input: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "input_image", detail: "high" }),
              expect.objectContaining({ type: "input_file", detail: "high" }),
            ]),
          }),
        ]),
      }), expect.objectContaining({
        timeout: expect.any(Number),
      }));
      expect(create).toHaveBeenCalledTimes(2);
      expect(prompts[0]).toContain("Very Local Hazy Pint");
      expect(prompts[0]).toContain("285ml, 425ml, and 570ml");
      expect(prompts[0]).toContain("pint-equivalent price");
      expect(prompts[0]).toContain("untrusted menu content");
      expect(prompts[1]).toContain("second-pass quality check");
      expect(prompts[1]).toContain("Proposed first-pass extraction JSON");
      expect(result.beers[0]).toEqual(expect.objectContaining({
        name: "Very Local Hazy Pint",
        needsReview: false,
      }));
    } finally {
      database.close();
    }
  });

  it("reviews with the model that completed the first pass instead of retrying a failed primary", async () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    const attemptedModels: string[] = [];
    const create = vi.fn(async (request: { model: string }) => {
      attemptedModels.push(request.model);
      if (request.model === "gpt-5.6-sol") {
        throw new Error("Primary unavailable");
      }
      return {
        output_text: JSON.stringify({
          venue_name_guess: "Test Venue",
          captured_notes: null,
          overall_confidence: 0.9,
          beers: [{
            name: "Carlton Draught",
            product_category: "beer",
            brewery: "Carlton & United Breweries",
            abv: 4.6,
            price_numeric: 14,
            price_text: "$14",
            availability_status: "on_tap",
            available_on_tap: true,
            available_package_only: false,
            unavailable_reason: null,
            notes: null,
            source_text: "Carlton Draught pint $14",
            confidence: 0.9,
          }],
          rejected_candidates: [],
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
      imageDataUrl: JPEG_DATA_URL,
    });

    expect(result.model).toBe("gpt-4.1");
    expect(attemptedModels).toEqual(["gpt-5.6-sol", "gpt-4.1", "gpt-4.1"]);
  });

  it("rejects an unreviewed environment-selected OCR model before provider access", async () => {
    vi.stubEnv("OPENAI_MENU_OCR_MODEL", "unreviewed-expensive-model");
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    const create = vi.fn();
    (service as unknown as {
      openai: { responses: { create: typeof create } };
    }).openai = {
      responses: { create },
    };

    await expect(service.ocrMenuPhoto({
      venueNameHint: "Test Venue",
      imageDataUrl: JPEG_DATA_URL,
    })).rejects.toMatchObject({
      statusCode: 503,
      message: "OPENAI_MENU_OCR_MODEL must select a reviewed menu OCR model.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("reserves the permanent-staging rolling budget before cost-bound OCR", async () => {
    vi.stubEnv("OPENAI_MENU_OCR_COST_BOUND_MODE", "true");
    vi.stubEnv("OPENAI_MENU_OCR_MODEL", "gpt-4.1-mini-2025-04-14");
    vi.stubEnv("OPENAI_MENU_OCR_FALLBACK_MODEL", "gpt-4.1-mini-2025-04-14");
    vi.stubEnv("OPENAI_MENU_OCR_REVIEW_PASS", "false");
    const database = new BetterSqlite3(":memory:");

    try {
      initializeDatabaseSchema(database);
      const sqlDatabase = asAsyncSqliteDatabase(database);
      const service = new AdminService(
        undefined,
        undefined,
        undefined,
        "venue_menu_captures",
        "test-openai-key",
        undefined,
        sqlDatabase,
      );
      const create = vi.fn(async () => ({
        output_text: JSON.stringify({
          venue_name_guess: "Test Venue",
          captured_notes: null,
          overall_confidence: 0.9,
          beers: [],
          rejected_candidates: [],
        }),
      }));
      (service as unknown as {
        openai: { responses: { create: typeof create } };
      }).openai = { responses: { create } };

      await service.ocrMenuPhoto({
        venueNameHint: "Test Venue",
        imageDataUrl: JPEG_DATA_URL,
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: "gpt-4.1-mini-2025-04-14",
        max_output_tokens: 8_192,
      }), expect.any(Object));
      const state = await new SystemStateRepository(sqlDatabase).get<{
        reservationTimestamps: string[];
      }>("external-provider-budget:permanent-staging:openai-menu-ocr:rolling-31-day");
      expect(state?.value).toEqual(expect.objectContaining({
        reservationTimestamps: [expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)],
      }));
    } finally {
      database.close();
    }
  });

  it("fails before provider access when cost-bound persistence or PDF bounds are absent", async () => {
    vi.stubEnv("OPENAI_MENU_OCR_COST_BOUND_MODE", "true");
    vi.stubEnv("OPENAI_MENU_OCR_MODEL", "gpt-4.1-mini-2025-04-14");
    vi.stubEnv("OPENAI_MENU_OCR_FALLBACK_MODEL", "gpt-4.1-mini-2025-04-14");
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    const create = vi.fn();
    (service as unknown as {
      openai: { responses: { create: typeof create } };
    }).openai = { responses: { create } };

    await expect(service.ocrMenuPhoto({
      venueNameHint: "Test Venue",
      imageDataUrl: JPEG_DATA_URL,
    })).rejects.toMatchObject({
      statusCode: 503,
      message: "The menu OCR cost reservation could not be proved.",
    });
    await expect(service.ocrMenuPhotos({
      venueNameHint: "Test Venue",
      imageDataUrls: [],
      documentDataUrls: [PDF_DATA_URL],
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "PDF menu OCR is unavailable while the permanent-staging cost bound is active.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("denies an exhausted rolling budget before provider access", async () => {
    vi.stubEnv("OPENAI_MENU_OCR_COST_BOUND_MODE", "true");
    vi.stubEnv("OPENAI_MENU_OCR_MODEL", "gpt-4.1-mini-2025-04-14");
    vi.stubEnv("OPENAI_MENU_OCR_FALLBACK_MODEL", "gpt-4.1-mini-2025-04-14");
    const database = new BetterSqlite3(":memory:");
    try {
      initializeDatabaseSchema(database);
      const sqlDatabase = asAsyncSqliteDatabase(database);
      const repository = new SystemStateRepository(sqlDatabase);
      for (let index = 0; index < 20; index += 1) {
        await externalProviderCostBudgetInternals.reserveOpenAiMenuOcrRollingBudgetAt(
          repository,
          new Date().toISOString(),
        );
      }
      const service = new AdminService(
        undefined,
        undefined,
        undefined,
        "venue_menu_captures",
        "test-openai-key",
        undefined,
        sqlDatabase,
      );
      const create = vi.fn();
      (service as unknown as {
        openai: { responses: { create: typeof create } };
      }).openai = { responses: { create } };

      await expect(service.ocrMenuPhoto({
        venueNameHint: "Test Venue",
        imageDataUrl: JPEG_DATA_URL,
      })).rejects.toMatchObject({
        statusCode: 503,
        message: "The rolling menu OCR cost budget is exhausted.",
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("does not send non-retryable provider authentication failures to a fallback model", async () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Invalid API key"), { status: 401 });
    });
    (service as unknown as {
      openai: { responses: { create: typeof create } };
    }).openai = {
      responses: { create },
    };

    await expect(service.ocrMenuPhoto({
      venueNameHint: "Test Venue",
      imageDataUrl: JPEG_DATA_URL,
    })).rejects.toMatchObject({ statusCode: 502 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects food rows and does not turn package volume into a beer price", async () => {
    const service = new AdminService(
      undefined,
      undefined,
      undefined,
      "venue_menu_captures",
      "test-openai-key",
      undefined,
    );
    const create = vi.fn(async () => ({
      output_text: JSON.stringify({
        venue_name_guess: "Test Venue",
        captured_notes: null,
        overall_confidence: 0.9,
        beers: [
          {
            name: "Guinness Stout 440ml 4.2%",
            product_category: "beer",
            brewery: "Guinness",
            abv: 4.2,
            price_numeric: 40,
            price_text: "$40",
            availability_status: "package_only",
            available_on_tap: false,
            available_package_only: true,
            unavailable_reason: "cans_or_bottles",
            notes: null,
            source_text: "Guinness Stout 440ml 4.2%",
            confidence: 0.92,
          },
          {
            name: "Premium Northern Victorian T bone",
            product_category: "food",
            brewery: null,
            abv: null,
            price_numeric: 30,
            price_text: "$30",
            availability_status: "unknown",
            available_on_tap: null,
            available_package_only: false,
            unavailable_reason: null,
            notes: null,
            source_text: "Premium Northern Victorian T bone 30 day aged, MSA 6 grade $30",
            confidence: 0.95,
          },
          {
            name: "Carlton Draught",
            product_category: "beer",
            brewery: "Carlton & United Breweries",
            abv: 4.6,
            price_numeric: 29,
            price_text: "$29",
            availability_status: "on_tap",
            available_on_tap: true,
            available_package_only: false,
            unavailable_reason: null,
            notes: null,
            source_text: "Pots / Pints / Jugs Carlton Draught 7.5 / 14.5 / 29",
            confidence: 0.9,
          },
          {
            name: "Stone & Wood Pacific Ale",
            product_category: "beer",
            brewery: "Stone & Wood",
            abv: 4.4,
            price_numeric: 7.5,
            price_text: "$7.50",
            availability_status: "on_tap",
            available_on_tap: true,
            available_package_only: false,
            unavailable_reason: null,
            notes: null,
            source_text: "Stone & Wood Pacific Ale 7.5 / 10 / 15",
            confidence: 0.9,
          },
          {
            name: "Heineken 6 pack",
            product_category: "beer",
            brewery: "Heineken",
            abv: 5,
            price_numeric: 24,
            price_text: "$24",
            availability_status: "package_only",
            available_on_tap: false,
            available_package_only: true,
            unavailable_reason: "cans_or_bottles",
            notes: null,
            source_text: "Heineken 6 pack / $24",
            confidence: 0.9,
          },
          {
            name: "Asahi Super Dry 6 pack",
            product_category: "beer",
            brewery: "Asahi",
            abv: 5,
            price_numeric: 26,
            price_text: "$26",
            availability_status: "on_tap",
            available_on_tap: true,
            available_package_only: false,
            unavailable_reason: null,
            notes: null,
            source_text: "Asahi Super Dry 6 pack / $26",
            confidence: 0.9,
          },
        ],
        rejected_candidates: [],
      }),
    }));
    (service as unknown as {
      openai: { responses: { create: typeof create } };
    }).openai = {
      responses: { create },
    };

    const result = await service.ocrMenuPhoto({
      venueNameHint: "Test Venue",
      imageDataUrl: JPEG_DATA_URL,
    });

    expect(result.beers).toHaveLength(5);
    expect(result.beers).toContainEqual(expect.objectContaining({
      name: "Guinness Stout",
      brewery: "Guinness",
      abv: 4.2,
      priceNumeric: null,
      availabilityStatus: "package_only",
    }));
    expect(result.beers).toContainEqual(expect.objectContaining({
      name: "Carlton Draught",
      priceNumeric: 14.5,
      priceText: "$14.50 pint",
      availabilityStatus: "on_tap",
    }));
    expect(result.beers).toContainEqual(expect.objectContaining({
      name: "Stone & Wood Pacific Ale",
      priceNumeric: 7.5,
      availabilityStatus: "on_tap",
      needsReview: true,
    }));
    expect(result.beers).toContainEqual(expect.objectContaining({
      name: "Heineken 6 pack",
      priceNumeric: null,
      availabilityStatus: "package_only",
    }));
    expect(result.beers).toContainEqual(expect.objectContaining({
      name: "Asahi Super Dry 6 pack",
      priceNumeric: null,
      availabilityStatus: "on_tap",
      needsReview: true,
    }));
    expect(result.rejectedCandidateCount).toBe(1);
  });
});
