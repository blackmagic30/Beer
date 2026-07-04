const HARD_TIME_LIMITED_SOURCE_PATTERN =
  /\b(?:happy\s*hours?|weekly\s+specials?|daily\s+specials?|drink\s+specials?|beer\s+specials?|specials?|offers?|deals?|promotions?|promo)\b/i;
const EVENT_SOURCE_PATTERN = /\b(?:events?|what\s+s\s+on|whats\s+on)\b/i;
const REGULAR_MENU_SOURCE_PATTERN =
  /\b(?:menus?|food\s+(?:and\s+)?drinks?|eat\s+(?:and\s+)?drink|drinks?\s+menus?|beer\s+menus?|bar\s+menus?|tap\s+lists?)\b/i;

function safeDecodeSourceIdentity(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function menuSourceIdentity(sourceUrl: string, linkText = ""): string {
  let sourceIdentity = sourceUrl;
  try {
    const url = new URL(sourceUrl);
    sourceIdentity = `${url.pathname} ${url.search} ${url.hash}`;
  } catch {
    // Use the raw value below.
  }

  return safeDecodeSourceIdentity(`${sourceIdentity} ${linkText}`)
    .replace(/['’]/g, "")
    .replace(/[-_+/|#?=&.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTimeLimitedMenuSource(sourceUrl: string, linkText = ""): boolean {
  const identity = menuSourceIdentity(sourceUrl, linkText);
  if (HARD_TIME_LIMITED_SOURCE_PATTERN.test(identity)) {
    return true;
  }
  return EVENT_SOURCE_PATTERN.test(identity) && !REGULAR_MENU_SOURCE_PATTERN.test(identity);
}
