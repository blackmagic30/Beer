const PINT_PATH_PRODUCTION_CANONICAL_HOST = "pintpath.au";
const PINT_PATH_LEGACY_HOSTS = new Set([
  "pintpath.com.au",
  "www.pintpath.com.au",
]);

export function shouldRedirectToCanonicalHost(
  canonicalHostname: string,
  requestHostname: string,
): boolean {
  const canonicalHost = canonicalHostname.trim().toLowerCase();
  const requestHost = requestHostname.trim().toLowerCase();
  if (!canonicalHost || !requestHost || requestHost === canonicalHost) return false;
  if (requestHost === `www.${canonicalHost}`) return true;
  return canonicalHost === PINT_PATH_PRODUCTION_CANONICAL_HOST
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
