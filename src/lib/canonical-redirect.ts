import { isCanonicalProductionRuntime } from "./deployment-environment.js";

const PINT_PATH_PRODUCTION_CANONICAL_HOST = "pintpath.au";
const PINT_PATH_LEGACY_HOSTS = new Set([
  "www.pintpath.au",
  "pintpath.com.au",
  "www.pintpath.com.au",
]);
const PINT_PATH_RUNTIME_PROBE_PATHS = new Set([
  "/health",
  "/ready",
  "/startup",
]);

export type CanonicalHostRequestResolution =
  | { readonly action: "pass" }
  | { readonly action: "redirect"; readonly location: string }
  | { readonly action: "reject" };

export function shouldEnforceCanonicalProductionHost(input: {
  nodeEnv: string;
  railwayEnvironmentName?: string | undefined;
  restoreRehearsalMode: boolean;
  postgresRecoveryRehearsalMode: boolean;
  accountDeletionRehearsalEnabled: boolean;
}): boolean {
  return isCanonicalProductionRuntime({
    nodeEnv: input.nodeEnv,
    railwayEnvironmentName: input.railwayEnvironmentName,
  })
    && !input.restoreRehearsalMode
    && !input.postgresRecoveryRehearsalMode
    && !input.accountDeletionRehearsalEnabled;
}

function normalizeHostname(value: string): string | null {
  if (!value || value !== value.trim() || value.length > 253) return null;
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) return null;
  if (normalized.includes("..")) return null;
  return normalized;
}

export function shouldRedirectToCanonicalHost(
  canonicalHostname: string,
  requestHostname: string,
): boolean {
  const canonicalHost = normalizeHostname(canonicalHostname);
  const requestHost = normalizeHostname(requestHostname);
  return canonicalHost === PINT_PATH_PRODUCTION_CANONICAL_HOST
    && requestHost !== null
    && PINT_PATH_LEGACY_HOSTS.has(requestHost);
}

export function buildCanonicalHostRedirectUrl(
  canonicalOrigin: string,
  requestTarget: string,
): string {
  const origin = new URL(canonicalOrigin).origin;
  const target = requestTarget || "/";
  const queryIndex = target.indexOf("?");
  const rawPath = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
  const rawQuery = queryIndex >= 0 ? target.slice(queryIndex) : "";
  const localPath = rawPath
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  return `${origin}/${localPath}${rawQuery}`;
}

export function resolveCanonicalHostRequest(input: {
  enabled: boolean;
  canonicalOrigin: string;
  requestHostname: string;
  requestMethod: string;
  requestPath: string;
  requestTarget: string;
}): CanonicalHostRequestResolution {
  if (!input.enabled) return { action: "pass" };

  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(input.canonicalOrigin);
  } catch {
    return { action: "reject" };
  }

  const canonicalHost = normalizeHostname(canonicalUrl.hostname);
  const requestHost = normalizeHostname(input.requestHostname);
  if (
    canonicalUrl.protocol !== "https:"
    || canonicalUrl.origin !== input.canonicalOrigin
    || canonicalHost !== PINT_PATH_PRODUCTION_CANONICAL_HOST
  ) {
    return { action: "reject" };
  }

  if (requestHost === canonicalHost) return { action: "pass" };
  if (
    requestHost !== null
    && shouldRedirectToCanonicalHost(canonicalHost, requestHost)
  ) {
    return {
      action: "redirect",
      location: buildCanonicalHostRedirectUrl(
        canonicalUrl.origin,
        input.requestTarget,
      ),
    };
  }

  const method = input.requestMethod.toUpperCase();
  if (
    (method === "GET" || method === "HEAD")
    && PINT_PATH_RUNTIME_PROBE_PATHS.has(input.requestPath)
  ) {
    return { action: "pass" };
  }

  return { action: "reject" };
}
