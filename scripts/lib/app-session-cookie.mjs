const APP_SESSION_COOKIE_NAME = "pint_path_session";
const GENERIC_APP_SESSION_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE_APP_SESSION_CREDENTIAL =
  /^credential-v1\.(?:session_management|account_export|account_deletion|billing_portal|venue_billing_portal|logout_all)\.[1-9][0-9]{0,10}\.[A-Za-z0-9_-]{43}$/;
const COOKIE_EXPIRES =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

function invalidCookie() {
  throw new Error("Pint Path session exchange did not return one exact host-only app session cookie");
}

/**
 * Return each Set-Cookie field without treating its Expires comma as a header
 * delimiter. Node 22 exposes getSetCookie(); the single-field fallback remains
 * fail-closed because extractExactAppSessionCookie validates every character.
 *
 * @param {{ get(name: string): string | null, getSetCookie?: () => string[] }} headers
 * @returns {string[]}
 */
export function readSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value === null ? [] : [value];
}

/**
 * Validate and reduce an app-session Set-Cookie response to the only header a
 * non-browser client may replay. The token is returned solely for callers that
 * must hash it to verify server-side revocation; callers must never log it.
 *
 * @param {readonly string[]} setCookieHeaders
 * @param {string | URL} responseUrl
 * @param {{ allowPurposeCredential?: boolean }} [options]
 * @returns {{ token: string, cookieHeader: string }}
 */
export function extractExactAppSessionCookie(
  setCookieHeaders,
  responseUrl,
  options = {},
) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length !== 1) {
    return invalidCookie();
  }
  const serialized = setCookieHeaders[0];
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    serialized.length > 2_048 ||
    /[\r\n\0]/.test(serialized)
  ) {
    return invalidCookie();
  }

  let target;
  try {
    target = new URL(responseUrl);
  } catch {
    return invalidCookie();
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return invalidCookie();
  }

  const parts = serialized.split(";");
  if (parts.length < 4 || parts.some((part) => part.trim().length === 0)) {
    return invalidCookie();
  }
  const nameValue = parts.shift().trim();
  const separator = nameValue.indexOf("=");
  if (
    separator < 1 ||
    nameValue.indexOf("=", separator + 1) !== -1 ||
    nameValue.slice(0, separator) !== APP_SESSION_COOKIE_NAME
  ) {
    return invalidCookie();
  }
  const token = nameValue.slice(separator + 1);
  const credentialIsExact = GENERIC_APP_SESSION_CREDENTIAL.test(token) ||
    (options.allowPurposeCredential === true &&
      PURPOSE_APP_SESSION_CREDENTIAL.test(token));
  if (!credentialIsExact) return invalidCookie();

  const attributes = new Map();
  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    const attributeSeparator = attribute.indexOf("=");
    const rawName = attributeSeparator === -1
      ? attribute
      : attribute.slice(0, attributeSeparator);
    const name = rawName.toLowerCase();
    const value = attributeSeparator === -1
      ? null
      : attribute.slice(attributeSeparator + 1);
    if (
      !["expires", "httponly", "path", "samesite", "secure"].includes(name) ||
      attributes.has(name)
    ) {
      return invalidCookie();
    }
    attributes.set(name, value);
  }

  if (
    attributes.get("httponly") !== null ||
    attributes.get("path") !== "/" ||
    attributes.get("samesite")?.toLowerCase() !== "lax" ||
    (target.protocol === "https:" && attributes.get("secure") !== null)
  ) {
    return invalidCookie();
  }
  if (attributes.has("secure") && attributes.get("secure") !== null) {
    return invalidCookie();
  }
  if (attributes.has("expires")) {
    const expires = attributes.get("expires");
    if (
      typeof expires !== "string" ||
      !COOKIE_EXPIRES.test(expires) ||
      !Number.isFinite(Date.parse(expires))
    ) {
      return invalidCookie();
    }
  }

  return { token, cookieHeader: `${APP_SESSION_COOKIE_NAME}=${token}` };
}
