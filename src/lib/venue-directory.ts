export interface GoogleAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

export interface GooglePlaceCandidate {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: GoogleAddressComponent[];
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
}

export interface ReviewVenueRow {
  venueId: string;
  googlePlaceId: string | null;
  venueName: string;
  suburb: string | null;
  address: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
  alreadyCalled: boolean;
  latestCallAt: string | null;
  callEligible: boolean;
  issues: string[];
}

export function dedupeReviewVenueRowsByPhone(rows: ReviewVenueRow[]): ReviewVenueRow[] {
  const seenPhones = new Set<string>();
  const deduped: ReviewVenueRow[] = [];

  for (const row of rows) {
    if (!row.normalizedPhone) {
      deduped.push(row);
      continue;
    }

    if (seenPhones.has(row.normalizedPhone)) {
      continue;
    }

    seenPhones.add(row.normalizedPhone);
    deduped.push(row);
  }

  return deduped;
}

const AREA_FILTER_ALIASES: Record<string, string[]> = {
  cbd: ["melbourne"],
  "melbourne cbd": ["melbourne"],
  "saint kilda": ["st kilda"],
  "saint kilda east": ["st kilda east"],
  beghntligh: ["bentleigh"],
};

const STRICT_BAR_PUB_TYPES = new Set(["bar", "pub", "brewery"]);
const EXCLUDED_NAME_PATTERNS = [
  /\bairport lounge\b/i,
  /\bairport services\b/i,
  /\bqantas\b/i,
  /\bvirgin australia\b/i,
  /\bsilverkris\b/i,
  /\bcenturion lounge\b/i,
  /\bair new zealand lounge\b/i,
  /\bpty ltd\b/i,
  /\bcinema\b/i,
  /\bmovie\b/i,
  /\bgolf square\b/i,
  /\bdriving range\b/i,
  /\bgolf club\b/i,
  /\bcricket club\b/i,
  /\bbowls club\b/i,
  /\bhhm club\b/i,
  /\bpickle club\b/i,
  /\bsports club\b/i,
  /\bsoccer club\b/i,
  /\bshisha\b/i,
  /\bfunction venue\b/i,
  /\bmobile bar\b/i,
  /\bfurniture\b/i,
  /\bbeauty\b/i,
  /^\.$/,
];
const RESTAURANT_LED_NAME_PATTERNS = [
  /\brestaurant\b/i,
  /\bcafe\b/i,
  /\bbistro\b/i,
  /\bdining\b/i,
  /\beatery\b/i,
  /\bdiner\b/i,
  /\bgrill\b/i,
  /\bbbq\b/i,
  /\bcantina\b/i,
  /\bcuisine\b/i,
  /\bpizzeria\b/i,
  /\bpizza\b/i,
  /\bramen\b/i,
  /\bcurry\b/i,
  /\bthai\b/i,
  /\bindian\b/i,
  /\bnepalese\b/i,
  /\bmexican\b/i,
  /\bitalian\b/i,
  /\btea bar\b/i,
  /\bcellar door\b/i,
  /\bcatering\b/i,
  /\bbar hire\b/i,
  /\boff[\s-]?licen[cs]e\b/i,
  /\bbottles?hop\b/i,
  /\bliquor\b/i,
  /\bespresso\b/i,
  /\bkitchen\b/i,
];
const STRONG_BAR_PUB_BREWERY_NAME_PATTERNS = [
  /\bpub\b/i,
  /\bhotel\b/i,
  /\btavern\b/i,
  /\balehouse\b/i,
  /\bsaloon\b/i,
  /\bbrew(ery|ing|pub)?\b/i,
  /\btaproom\b/i,
  /\bbeer garden\b/i,
  /\brooftop\b/i,
  /\bwine bar\b/i,
  /\bwine room\b/i,
];

export function normalizeVenueKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
}

export function buildAreaFilterTerms(value: string | null | undefined): string[] {
  const rawTerms = String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const terms = new Set<string>();

  for (const rawTerm of rawTerms) {
    terms.add(rawTerm);

    const aliasTerms = AREA_FILTER_ALIASES[rawTerm] ?? [];
    for (const aliasTerm of aliasTerms) {
      terms.add(aliasTerm);
    }

    if (rawTerm.startsWith("saint ")) {
      terms.add(rawTerm.replace(/^saint\s+/, "st "));
    }
  }

  return Array.from(terms);
}

export function matchesAreaFilter(input: {
  suburb: string | null;
  address: string | null;
}, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  const haystack = `${input.suburb ?? ""} ${input.address ?? ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export function isStrictBarOrPubPlace(place: GooglePlaceCandidate): boolean {
  const primaryType = place.primaryType?.trim().toLowerCase();

  if (primaryType) {
    return STRICT_BAR_PUB_TYPES.has(primaryType);
  }

  const types = (place.types ?? []).map((type) => type.trim().toLowerCase());
  return types.some((type) => STRICT_BAR_PUB_TYPES.has(type));
}

export function isExcludedVenueName(name: string): boolean {
  return EXCLUDED_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function isRestaurantLedVenueName(name: string): boolean {
  return RESTAURANT_LED_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function hasStrongBarOrPubNameSignal(name: string): boolean {
  return STRONG_BAR_PUB_BREWERY_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function shouldImportBarOrPubPlace(place: GooglePlaceCandidate): boolean {
  const name = place.displayName?.text?.trim() ?? "";
  const address = place.formattedAddress?.trim() ?? "";

  if ((place.businessStatus ?? "OPERATIONAL") === "CLOSED_PERMANENTLY") {
    return false;
  }

  if (!name || !address) {
    return false;
  }

  if (!isStrictBarOrPubPlace(place)) {
    return false;
  }

  if (isExcludedVenueName(name)) {
    return false;
  }

  if (isRestaurantLedVenueName(name) && !hasStrongBarOrPubNameSignal(name)) {
    return false;
  }

  return true;
}

export function buildReviewVenueRow(input: {
  id: string;
  googlePlaceId: string | null;
  name: string;
  suburb: string | null;
  address: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
  alreadyCalled: boolean;
  latestCallAt: string | null;
}): ReviewVenueRow {
  const issues: string[] = [];

  if (!input.normalizedPhone) {
    issues.push("missing_e164_phone");
  }

  if (input.latitude == null || input.longitude == null) {
    issues.push("missing_coordinates");
  }

  if (input.alreadyCalled) {
    issues.push("already_called");
  }

  if (isExcludedVenueName(input.name)) {
    issues.push("suspicious_venue_name");
  }

  return {
    venueId: input.id,
    googlePlaceId: input.googlePlaceId,
    venueName: input.name,
    suburb: input.suburb,
    address: input.address,
    phone: input.phone,
    normalizedPhone: input.normalizedPhone,
    latitude: input.latitude,
    longitude: input.longitude,
    source: input.source,
    alreadyCalled: input.alreadyCalled,
    latestCallAt: input.latestCallAt,
    callEligible: issues.length === 0,
    issues,
  };
}
