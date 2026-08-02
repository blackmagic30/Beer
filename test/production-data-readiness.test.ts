import { describe, expect, it, vi } from "vitest";

import {
  type DataReadinessConfig,
  type ReadinessFetch,
  resolveDataReadinessConfig,
  runProductionDataReadiness,
} from "../scripts/production-data-readiness.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");

function config(overrides: Partial<DataReadinessConfig> = {}): DataReadinessConfig {
  return {
    baseUrl: "https://pintpath.example",
    strict: true,
    marketedSuburbs: [],
    minimumMarketedVenueCoveragePercent: 70,
    minimumCurrentPricesPerVenue: 3,
    maximumCoreFreshnessHours: 48,
    maximumVenueStatusAgeHours: 168,
    maximumTrustedRowAgeDays: 30,
    minimumHappyHourCoveragePercent: 25,
    noHappyHourLaunchScope: false,
    noHappyHourScopeReferenceProvided: false,
    ...overrides,
  };
}

function venue(
  index: number,
  options: { includeBusinessStatus?: boolean; suburb?: string } = {},
) {
  const suburb = options.suburb ?? "Melbourne";
  return {
    id: `venue-${index}`,
    name: `Venue ${index}`,
    address: `${index} Example Street, ${suburb} VIC 3000`,
    suburb,
    state: "VIC",
    postcode: "3000",
    latitude: -37.81,
    longitude: 144.96,
    lastCheckedAt: "2026-07-28T00:00:00.000Z",
    ...(options.includeBusinessStatus === false ? {} : { businessStatus: "OPERATIONAL" }),
  };
}

function price(
  venueIndex: number,
  priceIndex: number,
  options: { evidenceMetadata?: boolean; verifiedAt?: string } = {},
) {
  return {
    id: `price-${venueIndex}-${priceIndex}`,
    venueId: `venue-${venueIndex}`,
    displayKind: "beer",
    isHappyHourPrice: false,
    confidence: "photo_verified",
    sourceType: "community_submission",
    sourceSubmissionId: `submission-${venueIndex}-${priceIndex}`,
    lastVerifiedAt: options.verifiedAt ?? "2026-07-28T00:00:00.000Z",
    ...(options.evidenceMetadata === false ? {} : { hasSourceEvidence: true }),
  };
}

function happyHour(venueIndex: number) {
  return {
    id: `happy-hour-${venueIndex}`,
    venueId: `venue-${venueIndex}`,
    displayKind: "happy_hour",
    isHappyHourPrice: true,
    confidence: "venue_confirmed",
    sourceType: "venue_manager_portal",
    sourceSubmissionId: null,
    lastVerifiedAt: "2026-07-27T12:00:00.000Z",
  };
}

function mockedPublicFetch(input: {
  venues: unknown[];
  pricePages: unknown[][];
}): { fetchImpl: ReadinessFetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(request));
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    if (url.pathname === "/api/business/venues") {
      expect(url.searchParams.get("limit")).toBe("250");
      expect(url.searchParams.get("offset")).toBe("0");
      return new Response(JSON.stringify({
        ok: true,
        data: {
          venues: input.venues,
          pagination: {
            total: input.venues.length,
            limit: 250,
            offset: 0,
            hasMore: false,
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/business/price-records") {
      expect(url.searchParams.get("limit")).toBe("500");
      const pageIndex = url.searchParams.get("cursor") === "next-page" ? 1 : 0;
      const records = input.pricePages[pageIndex] ?? [];
      const nextCursor = pageIndex === 0 && input.pricePages.length > 1 ? "next-page" : null;
      return new Response(JSON.stringify({
        ok: true,
        data: { records, nextCursor },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: mock as unknown as ReadinessFetch, mock };
}

describe("production data readiness", () => {
  it("paginates public APIs read-only and passes complete strict evidence", async () => {
    const venues = [venue(1), venue(2), venue(3), venue(4)];
    const prices = [
      ...[1, 2, 3].flatMap((venueIndex) => [1, 2, 3].map((priceIndex) => price(venueIndex, priceIndex))),
      happyHour(1),
    ];
    const { fetchImpl, mock } = mockedPublicFetch({
      venues,
      pricePages: [prices.slice(0, 5), prices.slice(5)],
    });

    const report = await runProductionDataReadiness({
      config: config(),
      fetchImpl,
      now: NOW,
    });

    expect(mock).toHaveBeenCalledTimes(3);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      failed: 0,
      unknown: 0,
      strictBlockingIssues: 0,
      strictReleaseReady: true,
      processExitCode: 0,
    });
    expect(report.metrics.marketedVenuePriceCoverage).toEqual({
      coveredVenueCount: 3,
      coveragePercent: 75,
    });
    expect(report.metrics.happyHours.coveragePercent).toBe(25);
    expect(report.metrics.trustedEvidence.evidencePresenceCoveragePercent).toBe(100);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Venue 1");
    expect(serialized).not.toContain("price-1-1");
    expect(serialized).not.toContain("submission-1-1");
  });

  it("marks public evidence-presence and closed-venue proof unknown when the APIs omit those fields", async () => {
    const venues = [venue(1, { includeBusinessStatus: false })];
    const prices = [1, 2, 3].map((priceIndex) => price(1, priceIndex, { evidenceMetadata: false }));
    const { fetchImpl } = mockedPublicFetch({ venues, pricePages: [[...prices, happyHour(1)]] });

    const report = await runProductionDataReadiness({
      config: config({ minimumHappyHourCoveragePercent: 25 }),
      fetchImpl,
      now: NOW,
    });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "closed_active_venues_absent", status: "unknown" }),
      expect.objectContaining({ id: "trusted_non_manager_evidence_presence", status: "unknown" }),
    ]));
    expect(report.summary.unknown).toBe(2);
    expect(report.summary.strictReleaseReady).toBe(false);
    expect(report.summary.processExitCode).toBe(1);
  });

  it("fails when a published operational venue has a stale status check", async () => {
    const staleVenue = {
      ...venue(1),
      lastCheckedAt: "2026-07-20T00:00:00.000Z",
    };
    const prices = [1, 2, 3].map((priceIndex) => price(1, priceIndex));
    const { fetchImpl } = mockedPublicFetch({
      venues: [staleVenue],
      pricePages: [[...prices, happyHour(1)]],
    });

    const report = await runProductionDataReadiness({
      config: config(),
      fetchImpl,
      now: NOW,
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "venue_business_status_freshness",
      status: "fail",
    }));
    expect(report.metrics.venues.staleStatusCount).toBe(1);
    expect(report.summary.strictReleaseReady).toBe(false);
  });

  it("fails when a strong suburb hides a weak suburb behind passing aggregate coverage", async () => {
    const venues = [
      venue(1, { suburb: "Carlton" }),
      venue(2, { suburb: " carlton " }),
      venue(3, { suburb: "Fitzroy" }),
      venue(4, { suburb: "FITZROY" }),
    ];
    const prices = [
      ...[1, 2, 3].flatMap((venueIndex) =>
        [1, 2, 3].map((priceIndex) => price(venueIndex, priceIndex))),
      happyHour(1),
    ];
    const { fetchImpl } = mockedPublicFetch({ venues, pricePages: [prices] });

    const report = await runProductionDataReadiness({
      config: config(),
      fetchImpl,
      now: NOW,
    });

    expect(report.metrics.marketedVenuePriceCoverage).toEqual({
      coveredVenueCount: 3,
      coveragePercent: 75,
    });
    expect(report.metrics.marketedSuburbPriceCoverage).toEqual({
      evaluatedSuburbCount: 2,
      passingSuburbCount: 1,
      failingSuburbCount: 1,
      minimumCoveragePercent: 50,
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "marketed_venue_price_coverage", status: "pass" }),
      expect.objectContaining({ id: "every_marketed_suburb_price_coverage", status: "fail" }),
    ]));
    expect(report.summary.strictReleaseReady).toBe(false);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("carlton");
    expect(JSON.stringify(report).toLowerCase()).not.toContain("fitzroy");
  });

  it("restricts the denominator to a normalized configured pilot scope", async () => {
    const venues = [
      venue(1, { suburb: "Carlton" }),
      venue(2, { suburb: " carlton " }),
      venue(3, { suburb: "Fitzroy" }),
      venue(4, { suburb: "FITZROY" }),
    ];
    const prices = [
      ...[1, 2].flatMap((venueIndex) =>
        [1, 2, 3].map((priceIndex) => price(venueIndex, priceIndex))),
      happyHour(1),
    ];
    const { fetchImpl } = mockedPublicFetch({ venues, pricePages: [prices] });

    const report = await runProductionDataReadiness({
      config: config({ marketedSuburbs: [" CARLTON ", "carlton"] }),
      fetchImpl,
      now: NOW,
    });

    expect(report.metrics.marketedSuburbScope).toMatchObject({
      configured: true,
      configuredSuburbCount: 1,
      directorySuburbCount: 2,
      matchedSuburbCount: 1,
      missingConfiguredSuburbCount: 0,
      marketedSuburbCount: 1,
    });
    expect(report.metrics.venues).toMatchObject({
      publicDirectoryVenueCount: 4,
      marketedVenueCount: 2,
    });
    expect(report.metrics.marketedSuburbPriceCoverage).toEqual({
      evaluatedSuburbCount: 1,
      passingSuburbCount: 1,
      failingSuburbCount: 0,
      minimumCoveragePercent: 100,
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "marketed_suburb_scope_resolved", status: "pass" }),
      expect.objectContaining({ id: "every_marketed_suburb_price_coverage", status: "pass" }),
    ]));
    expect(report.summary.strictReleaseReady).toBe(true);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("carlton");
  });

  it("fails a complete strict gate when a configured pilot suburb is missing", async () => {
    const venues = [venue(1)];
    const prices = [
      ...[1, 2, 3].map((priceIndex) => price(1, priceIndex)),
      happyHour(1),
    ];
    const { fetchImpl } = mockedPublicFetch({ venues, pricePages: [prices] });

    const report = await runProductionDataReadiness({
      config: config({ marketedSuburbs: [" Fitzroy ", "FITZROY", "fitzroy"] }),
      fetchImpl,
      now: NOW,
    });

    expect(report.metrics.marketedSuburbScope).toMatchObject({
      configured: true,
      configuredSuburbCount: 1,
      directorySuburbCount: 1,
      matchedSuburbCount: 0,
      missingConfiguredSuburbCount: 1,
      marketedSuburbCount: 0,
    });
    expect(report.metrics.marketedSuburbScope.scopeHashSha256).toBeNull();
    expect(report.metrics.marketedSuburbScope.missingConfiguredScopeHashSha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "marketed_suburb_scope_resolved", status: "fail" }),
      expect.objectContaining({ id: "every_marketed_suburb_price_coverage", status: "unknown" }),
    ]));
    expect(report.summary.strictReleaseReady).toBe(false);
    expect(report.summary.processExitCode).toBe(1);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("fitzroy");
  });

  it("requires a documented reference before the no-happy-hour launch escape can pass", async () => {
    const venues = [venue(1)];
    const prices = [1, 2, 3].map((priceIndex) => price(1, priceIndex));
    const first = mockedPublicFetch({ venues, pricePages: [prices] });
    const undocumented = await runProductionDataReadiness({
      config: config({
        noHappyHourLaunchScope: true,
        noHappyHourScopeReferenceProvided: false,
      }),
      fetchImpl: first.fetchImpl,
      now: NOW,
    });
    expect(undocumented.checks).toContainEqual(expect.objectContaining({
      id: "happy_hour_coverage_or_documented_scope",
      status: "fail",
    }));

    const second = mockedPublicFetch({ venues, pricePages: [prices] });
    const documented = await runProductionDataReadiness({
      config: config({
        noHappyHourLaunchScope: true,
        noHappyHourScopeReferenceProvided: true,
      }),
      fetchImpl: second.fetchImpl,
      now: NOW,
    });
    expect(documented.checks).toContainEqual(expect.objectContaining({
      id: "happy_hour_coverage_or_documented_scope",
      status: "pass",
    }));
    expect(documented.summary.strictReleaseReady).toBe(true);
  });

  it("uses safe defaults and validates owner-configurable thresholds", () => {
    expect(resolveDataReadinessConfig({
      PINTPATH_DATA_BASE_URL: "https://pintpath.example",
    }, [])).toMatchObject({
      strict: false,
      marketedSuburbs: [],
      minimumMarketedVenueCoveragePercent: 70,
      minimumCurrentPricesPerVenue: 3,
      maximumCoreFreshnessHours: 48,
      maximumVenueStatusAgeHours: 168,
      maximumTrustedRowAgeDays: 30,
      minimumHappyHourCoveragePercent: 25,
      noHappyHourLaunchScope: false,
      noHappyHourScopeReferenceProvided: false,
    });

    expect(resolveDataReadinessConfig({
      PINTPATH_DATA_BASE_URL: "http://localhost:3000",
      PINTPATH_DATA_STRICT: "true",
      PINTPATH_DATA_MARKETED_SUBURBS: " Fitzroy,fitzroy,RICHMOND, richmond ",
      PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT: "80",
      PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE: "true",
      PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE: "docs/no-happy-hour-launch.md",
    }, [])).toMatchObject({
      baseUrl: "http://localhost:3000",
      strict: true,
      marketedSuburbs: ["fitzroy", "richmond"],
      minimumMarketedVenueCoveragePercent: 80,
      noHappyHourLaunchScope: true,
      noHappyHourScopeReferenceProvided: true,
    });

    expect(() => resolveDataReadinessConfig({
      PINTPATH_DATA_BASE_URL: "https://pintpath.example",
      PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE: "0",
    }, [])).toThrow("PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE");
  });
});
