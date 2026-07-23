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
