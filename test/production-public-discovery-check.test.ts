import { describe, expect, it, vi } from "vitest";

import {
  isCanonicalHappyHourMissionReason,
  runProductionPublicDiscoveryCheck,
} from "../scripts/production-public-discovery-check.mjs";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function missionPage(
  missions: Array<Record<string, unknown>>,
  pagination: { total: number; limit: number; offset: number; hasMore: boolean },
) {
  return jsonResponse({ data: { missions, pagination } });
}

describe("production public discovery contract", () => {
  it("uses the launch detector shared by the Free-only mission contract", () => {
    expect(isCanonicalHappyHourMissionReason("Missing happy-hour details")).toBe(true);
    expect(isCanonicalHappyHourMissionReason("Update HAPPY_HOUR prices")).toBe(true);
    expect(isCanonicalHappyHourMissionReason("HH details need checking")).toBe(true);
    expect(isCanonicalHappyHourMissionReason("Missing Guinness price")).toBe(false);
    expect(isCanonicalHappyHourMissionReason("Whhatever beer price")).toBe(false);
  });

  it("exhausts the global feed and explicitly checks each launch suburb", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/venues")) {
        return jsonResponse({ data: { venues: [{ id: "venue-1" }] } });
      }
      const offset = Number(url.searchParams.get("offset"));
      const suburb = url.searchParams.get("suburb");
      if (suburb === "Brighton") {
        return missionPage(
          [{ id: "brighton-1", venueId: "venue-brighton", reason: "Missing Guinness price" }],
          { total: 1, limit: 2, offset, hasMore: false },
        );
      }
      return offset === 0
        ? missionPage([
            { id: "mission-1", venueId: "venue-1", reason: "Missing Guinness price" },
            { id: "mission-2", venueId: "venue-2", reason: "Stale drink menu" },
          ], { total: 3, limit: 2, offset: 0, hasMore: true })
        : missionPage([
            { id: "mission-3", venueId: "venue-3", reason: "Missing Carlton Draught price" },
          ], { total: 3, limit: 2, offset: 2, hasMore: false });
    });

    await expect(runProductionPublicDiscoveryCheck({
      baseUrl: "https://pintpath.test",
      launchSuburbs: ["Brighton"],
      attempts: 1,
      retryDelayMs: 0,
      requestTimeoutMs: 100,
      pageSize: 2,
      fetchImplementation,
      sleep: async () => undefined,
    })).resolves.toEqual({
      launchSuburbs: ["Brighton"],
      missionCounts: { all: 3, Brighton: 1 },
      venueSampleCount: 1,
    });

    const missionUrls = fetchImplementation.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/missions"));
    expect(missionUrls.map((url) => [
      url.searchParams.get("suburb"),
      url.searchParams.get("offset"),
    ])).toEqual([
      [null, "0"],
      [null, "2"],
      ["Brighton", "0"],
    ]);
  });

  it("fails when a deferred HH mission appears beyond the first page", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/venues")) {
        return jsonResponse({ data: { venues: [{ id: "venue-1" }] } });
      }
      const offset = Number(url.searchParams.get("offset"));
      return offset === 0
        ? missionPage([
            { id: "mission-1", venueId: "venue-1", reason: "Missing Guinness price" },
          ], { total: 2, limit: 1, offset: 0, hasMore: true })
        : missionPage([
            { id: "mission-2", venueId: "venue-2", reason: "HH details need checking" },
          ], { total: 2, limit: 1, offset: 1, hasMore: false });
    });

    await expect(runProductionPublicDiscoveryCheck({
      baseUrl: "https://pintpath.test",
      launchSuburbs: ["Brighton"],
      attempts: 1,
      retryDelayMs: 0,
      requestTimeoutMs: 100,
      pageSize: 1,
      fetchImplementation,
      sleep: async () => undefined,
    })).rejects.toThrow("deferred happy-hour/HH mission");
  });

  it("fails closed on pagination that claims more rows without progress", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/venues")
        ? jsonResponse({ data: { venues: [{ id: "venue-1" }] } })
        : missionPage([], { total: 1, limit: 1, offset: 0, hasMore: true });
    });

    await expect(runProductionPublicDiscoveryCheck({
      baseUrl: "https://pintpath.test",
      launchSuburbs: ["Brighton"],
      attempts: 1,
      retryDelayMs: 0,
      requestTimeoutMs: 100,
      pageSize: 1,
      fetchImplementation,
      sleep: async () => undefined,
    })).rejects.toThrow("did not make bounded progress");
  });
});
