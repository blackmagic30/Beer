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

const STRICT_BAR_PUB_TYPES = new Set(["bar", "pub"]);
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

export function normalizeVenueKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
}

export function isStrictBarOrPubPlace(place: GooglePlaceCandidate): boolean {
  const primaryType = place.primaryType?.trim().toLowerCase();

  if (primaryType && STRICT_BAR_PUB_TYPES.has(primaryType)) {
    return true;
  }

  const types = (place.types ?? []).map((type) => type.trim().toLowerCase());
  return types.some((type) => STRICT_BAR_PUB_TYPES.has(type));
}

export function isExcludedVenueName(name: string): boolean {
  return EXCLUDED_NAME_PATTERNS.some((pattern) => pattern.test(name));
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

  return true;
}

export function buildReviewVenueRow(input: {
  id: string;
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
