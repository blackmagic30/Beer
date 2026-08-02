import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  baseUrl: "https://pintpath.au",
  healthAttempts: 3,
  healthRetryDelayMs: 5_000,
  readinessAttempts: 6,
  readinessRetryDelayMs: 15_000,
  requestTimeoutMs: 30_000,
});

const SAFE_DEPENDENCY_FIELDS = [
  "status",
  "required",
  "ready",
  "liveProbe",
  "error",
  "foreignKeyViolations",
  "lastSuccessfulAt",
  "ageHours",
  "scheduled",
  "enabled",
];

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
    throw new Error("PINTPATH_HEALTH_BASE_URL must be an HTTP(S) origin without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function dependencyDiagnostics(payload) {
  const dependencies = payload?.data?.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return undefined;

  return Object.fromEntries(Object.entries(dependencies).flatMap(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const summary = Object.fromEntries(SAFE_DEPENDENCY_FIELDS.flatMap((field) => (
      Object.prototype.hasOwnProperty.call(value, field) ? [[field, value[field]]] : []
    )));
    return Object.keys(summary).length > 0 ? [[name, summary]] : [];
  }));
}

function attemptDiagnostic(pathname, expectedStatus, attempt, result) {
  const dependencies = dependencyDiagnostics(result.payload);
  return {
    timestamp: new Date().toISOString(),
    check: pathname,
    attempt,
    passed: result.httpStatus === 200 && result.payload?.ok === true && result.payload?.data?.status === expectedStatus,
    httpStatus: result.httpStatus,
    serviceStatus: result.payload?.data?.status ?? null,
    commitSha: result.payload?.data?.deployment?.commitSha ?? null,
    ...(result.error ? { error: result.error } : {}),
    ...(result.payload === null && result.bodyLength !== undefined
      ? { response: { format: "non_json", bodyLength: result.bodyLength } }
      : {}),
    ...(dependencies ? { dependencies } : {}),
  };
}

async function requestJson(url, timeoutMs, fetchImplementation) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "PintPath-Production-Health/1.0",
      },
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // The body itself is deliberately not logged: an unexpected proxy page
      // could contain details that do not belong in public CI output.
    }
    return { httpStatus: response.status, payload, bodyLength: Buffer.byteLength(body) };
  } catch (error) {
    return {
      httpStatus: null,
      payload: null,
      error: error instanceof Error ? error.name : "RequestError",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkEndpoint({
  baseUrl,
  pathname,
  expectedStatus,
  attempts,
  retryDelayMs,
  requestTimeoutMs,
  fetchImplementation,
  sleep,
  log,
}) {
  let lastDiagnostic;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(`${baseUrl}${pathname}`, requestTimeoutMs, fetchImplementation);
    lastDiagnostic = attemptDiagnostic(pathname, expectedStatus, attempt, result);
    log(JSON.stringify(lastDiagnostic));
    if (lastDiagnostic.passed) return lastDiagnostic;
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  throw new Error(
    `${pathname} did not return HTTP 200 with status=${expectedStatus} after ${attempts} attempts. `
    + `Last diagnostic: ${JSON.stringify(lastDiagnostic)}`,
  );
}

export async function runProductionHealthCheck(options = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? process.env.PINTPATH_HEALTH_BASE_URL ?? DEFAULTS.baseUrl);
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs ?? process.env.PINTPATH_HEALTH_REQUEST_TIMEOUT_MS,
    DEFAULTS.requestTimeoutMs,
    100,
    120_000,
    "PINTPATH_HEALTH_REQUEST_TIMEOUT_MS",
  );
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const log = options.log ?? console.log;

  const health = await checkEndpoint({
    baseUrl,
    pathname: "/health",
    expectedStatus: "ok",
    attempts: boundedInteger(
      options.healthAttempts ?? process.env.PINTPATH_HEALTH_ATTEMPTS,
      DEFAULTS.healthAttempts,
      1,
      10,
      "PINTPATH_HEALTH_ATTEMPTS",
    ),
    retryDelayMs: boundedInteger(
      options.healthRetryDelayMs ?? process.env.PINTPATH_HEALTH_RETRY_DELAY_MS,
      DEFAULTS.healthRetryDelayMs,
      0,
      60_000,
      "PINTPATH_HEALTH_RETRY_DELAY_MS",
    ),
    requestTimeoutMs,
    fetchImplementation,
    sleep,
    log,
  });

  const readiness = await checkEndpoint({
    baseUrl,
    pathname: "/ready",
    expectedStatus: "ready",
    attempts: boundedInteger(
      options.readinessAttempts ?? process.env.PINTPATH_READINESS_ATTEMPTS,
      DEFAULTS.readinessAttempts,
      1,
      10,
      "PINTPATH_READINESS_ATTEMPTS",
    ),
    retryDelayMs: boundedInteger(
      options.readinessRetryDelayMs ?? process.env.PINTPATH_READINESS_RETRY_DELAY_MS,
      DEFAULTS.readinessRetryDelayMs,
      0,
      60_000,
      "PINTPATH_READINESS_RETRY_DELAY_MS",
    ),
    requestTimeoutMs,
    fetchImplementation,
    sleep,
    log,
  });

  return { health, readiness };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runProductionHealthCheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
