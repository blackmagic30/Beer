import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  baseUrl: "https://pintpath.au",
  launchSuburbs: "Brighton",
  attempts: 3,
  retryDelayMs: 5_000,
  requestTimeoutMs: 30_000,
  pageSize: 50,
  maximumRowsPerScope: 5_000,
  maximumResponseBytes: 1_048_576,
});

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizedBaseUrl(value) {
  const url = new URL(value || DEFAULTS.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new Error("PINTPATH_DATA_BASE_URL must be an HTTP(S) origin without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizedLaunchSuburbs(value) {
  const source = typeof value === "string" ? value : DEFAULTS.launchSuburbs;
  const suburbs = [...new Set(source.split(",").map((item) => item.trim()).filter(Boolean))];
  if (
    suburbs.length < 1
    || suburbs.length > 10
    || suburbs.some((suburb) => (
      suburb.length > 100 || !/^[A-Za-z0-9 .&'-]+$/.test(suburb)
    ))
  ) {
    throw new Error("PINTPATH_DISCOVERY_LAUNCH_SUBURBS must contain 1-10 bounded comma-separated suburbs.");
  }
  return suburbs;
}

export function isCanonicalHappyHourMissionReason(value) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/[-_]+/g, " ");
  return normalized.includes("happy") || /\bhh\b/.test(normalized);
}

function isDemoMission(mission) {
  return String(mission?.venueId || "").startsWith("demo:")
    || String(mission?.id || "").includes("demo:");
}

async function requestJson({
  url,
  attempts,
  retryDelayMs,
  requestTimeoutMs,
  maximumResponseBytes,
  fetchImplementation,
  sleep,
}) {
  let lastFailure = "request_failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImplementation(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PintPath-Production-Discovery/1.0",
        },
        redirect: "error",
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        lastFailure = `http_${response.status}`;
      } else if (Buffer.byteLength(body, "utf8") > maximumResponseBytes) {
        lastFailure = "response_too_large";
      } else {
        try {
          return JSON.parse(body);
        } catch {
          lastFailure = "response_not_json";
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "request_failed";
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(`Public discovery request failed after ${attempts} attempts (${lastFailure}).`);
}

function exactMissionPage(payload, expectedOffset, expectedLimit, maximumRowsPerScope) {
  const missions = payload?.data?.missions;
  const pagination = payload?.data?.pagination;
  if (
    !Array.isArray(missions)
    || !pagination
    || typeof pagination !== "object"
    || !Number.isSafeInteger(pagination.total)
    || pagination.total < 0
    || pagination.total > maximumRowsPerScope
    || !Number.isSafeInteger(pagination.limit)
    || pagination.limit !== expectedLimit
    || !Number.isSafeInteger(pagination.offset)
    || pagination.offset !== expectedOffset
    || typeof pagination.hasMore !== "boolean"
    || missions.length > pagination.limit
    || pagination.total < pagination.offset + missions.length
    || missions.some((mission) => (
      !mission
      || typeof mission !== "object"
      || Array.isArray(mission)
      || typeof mission.id !== "string"
      || typeof mission.venueId !== "string"
      || typeof mission.reason !== "string"
      || mission.id.length < 1
      || mission.id.length > 500
      || mission.venueId.length < 1
      || mission.venueId.length > 500
      || mission.reason.length < 1
      || mission.reason.length > 2_000
      || /[\r\n\0]/.test(mission.id)
      || /[\r\n\0]/.test(mission.venueId)
      || /[\r\n\0]/.test(mission.reason)
    ))
  ) {
    throw new Error("Public mission response has an invalid bounded pagination contract.");
  }
  return { missions, pagination };
}

async function checkMissionScope(scope, options) {
  let offset = 0;
  let observed = 0;
  for (let page = 0; page <= options.maximumRowsPerScope; page += 1) {
    const url = new URL("/api/business/missions", options.baseUrl);
    url.searchParams.set("limit", String(options.pageSize));
    url.searchParams.set("offset", String(offset));
    if (scope !== null) url.searchParams.set("suburb", scope);
    const payload = await requestJson({ ...options, url });
    const { missions, pagination } = exactMissionPage(
      payload,
      offset,
      options.pageSize,
      options.maximumRowsPerScope,
    );
    const demoCount = missions.filter(isDemoMission).length;
    const happyHourCount = missions.filter((mission) => (
      isCanonicalHappyHourMissionReason(mission?.reason)
    )).length;
    const label = scope === null ? "all public missions" : `launch suburb ${scope}`;
    if (demoCount > 0) throw new Error(`${label} returned ${demoCount} demo mission(s).`);
    if (happyHourCount > 0) {
      throw new Error(`${label} returned ${happyHourCount} deferred happy-hour/HH mission(s).`);
    }

    observed += missions.length;
    const nextOffset = offset + missions.length;
    if (pagination.hasMore !== (nextOffset < pagination.total)) {
      throw new Error(`${label} returned inconsistent mission pagination.`);
    }
    if (!pagination.hasMore) return observed;
    if (missions.length < 1 || nextOffset <= offset || nextOffset > options.maximumRowsPerScope) {
      throw new Error(`${label} mission pagination did not make bounded progress.`);
    }
    offset = nextOffset;
  }
  throw new Error("Public mission pagination exceeded its bounded page budget.");
}

export async function runProductionPublicDiscoveryCheck(options = {}) {
  const baseUrl = normalizedBaseUrl(
    options.baseUrl ?? process.env.PINTPATH_DATA_BASE_URL ?? DEFAULTS.baseUrl,
  );
  const launchSuburbs = Array.isArray(options.launchSuburbs)
    ? normalizedLaunchSuburbs(options.launchSuburbs.join(","))
    : normalizedLaunchSuburbs(
        options.launchSuburbs
          ?? process.env.PINTPATH_DISCOVERY_LAUNCH_SUBURBS
          ?? DEFAULTS.launchSuburbs,
      );
  const runtime = {
    baseUrl,
    attempts: boundedInteger(options.attempts, DEFAULTS.attempts, 1, 10, "attempts"),
    retryDelayMs: boundedInteger(options.retryDelayMs, DEFAULTS.retryDelayMs, 0, 60_000, "retryDelayMs"),
    requestTimeoutMs: boundedInteger(
      options.requestTimeoutMs,
      DEFAULTS.requestTimeoutMs,
      100,
      120_000,
      "requestTimeoutMs",
    ),
    pageSize: boundedInteger(options.pageSize, DEFAULTS.pageSize, 1, 100, "pageSize"),
    maximumRowsPerScope: boundedInteger(
      options.maximumRowsPerScope,
      DEFAULTS.maximumRowsPerScope,
      1,
      10_000,
      "maximumRowsPerScope",
    ),
    maximumResponseBytes: boundedInteger(
      options.maximumResponseBytes,
      DEFAULTS.maximumResponseBytes,
      1_024,
      4_194_304,
      "maximumResponseBytes",
    ),
    fetchImplementation: options.fetchImplementation ?? globalThis.fetch,
    sleep: options.sleep ?? ((delayMs) => new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    })),
  };
  if (typeof runtime.fetchImplementation !== "function") {
    throw new Error("A Fetch implementation is required.");
  }

  const venueUrl = new URL("/api/business/venues", baseUrl);
  venueUrl.searchParams.set("limit", "3");
  const venuePayload = await requestJson({ ...runtime, url: venueUrl });
  const venues = venuePayload?.data?.venues;
  if (!Array.isArray(venues) || venues.length < 1) {
    throw new Error("No public venues returned.");
  }

  const scopes = [null, ...launchSuburbs];
  const missionCounts = {};
  for (const scope of scopes) {
    missionCounts[scope ?? "all"] = await checkMissionScope(scope, runtime);
  }
  return { launchSuburbs, missionCounts, venueSampleCount: venues.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runProductionPublicDiscoveryCheck()
    .then((summary) => console.log(JSON.stringify({ ok: true, ...summary })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
