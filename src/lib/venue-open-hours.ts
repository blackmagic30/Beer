import fs from "node:fs";
import path from "node:path";

const GOOGLE_PLACE_DETAILS_API_URL = "https://places.googleapis.com/v1";
const VENUE_HOURS_CACHE_PATH = path.resolve(process.cwd(), "./data/google-place-hours-cache.json");
const VENUE_HOURS_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 21;
const PLACE_DETAILS_FIELD_MASK = "id,regularOpeningHours.weekdayDescriptions";
const PLACE_DETAILS_CONCURRENCY = 8;

const WEEKDAY_INDEX_BY_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

interface CachedVenueHoursEntry {
  googlePlaceId: string;
  weekdayDescriptions: string[] | null;
  fetchedAt: string;
}

type VenueHoursCache = Record<string, CachedVenueHoursEntry>;

interface LocalDateParts {
  weekdayIndex: number;
  minutes: number;
}

interface ParsedTimeRange {
  startMinutes: number;
  endMinutes: number;
  overnight: boolean;
}

function loadVenueHoursCache(): VenueHoursCache {
  if (!fs.existsSync(VENUE_HOURS_CACHE_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(VENUE_HOURS_CACHE_PATH, "utf8")) as VenueHoursCache;
  } catch {
    return {};
  }
}

function saveVenueHoursCache(cache: VenueHoursCache): void {
  fs.mkdirSync(path.dirname(VENUE_HOURS_CACHE_PATH), { recursive: true });
  fs.writeFileSync(VENUE_HOURS_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

function isFreshCacheEntry(entry: CachedVenueHoursEntry | undefined): boolean {
  if (!entry) {
    return false;
  }

  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < VENUE_HOURS_CACHE_TTL_MS;
}

function normalizeTimeToken(token: string): string {
  return token
    .replace(/[\u2009\u202f]/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseClockToken(token: string): number | null {
  const normalized = normalizeTimeToken(token);
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i);

  if (!match) {
    return null;
  }

  let hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = match[3]?.toLowerCase();

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59 || !meridiem) {
    return null;
  }

  if (hour === 12) {
    hour = 0;
  }

  if (meridiem === "p") {
    hour += 12;
  }

  return hour * 60 + minute;
}

function parseTimeRanges(description: string): ParsedTimeRange[] | null {
  const afterColon = description.split(":").slice(1).join(":").trim();

  if (!afterColon) {
    return null;
  }

  if (/open 24 hours/i.test(afterColon)) {
    return [
      {
        startMinutes: 0,
        endMinutes: 24 * 60,
        overnight: false,
      },
    ];
  }

  if (/closed/i.test(afterColon)) {
    return [];
  }

  const rawRanges = afterColon
    .split(",")
    .map((part) => normalizeTimeToken(part))
    .filter(Boolean);

  const parsedRanges: ParsedTimeRange[] = [];

  for (const rawRange of rawRanges) {
    const parts = rawRange.split("-").map((part) => part.trim());

    if (parts.length !== 2) {
      return null;
    }

    const startMinutes = parseClockToken(parts[0] ?? "");
    const endMinutes = parseClockToken(parts[1] ?? "");

    if (startMinutes == null || endMinutes == null) {
      return null;
    }

    parsedRanges.push({
      startMinutes,
      endMinutes,
      overnight: endMinutes <= startMinutes,
    });
  }

  return parsedRanges;
}

function getLocalDateParts(date: Date, timezone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });

  const parts = formatter.formatToParts(date);
  const weekdayName = (parts.find((part) => part.type === "weekday")?.value ?? "").toLowerCase();
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);

  return {
    weekdayIndex: WEEKDAY_INDEX_BY_NAME[weekdayName] ?? 0,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

function getDescriptionForWeekdayIndex(weekdayDescriptions: string[], weekdayIndex: number): string | null {
  return (
    weekdayDescriptions.find((description) => {
      const dayName = description.split(":")[0]?.trim().toLowerCase();
      return dayName ? WEEKDAY_INDEX_BY_NAME[dayName] === weekdayIndex : false;
    }) ?? null
  );
}

export function isVenueLikelyOpenAt(
  weekdayDescriptions: string[] | null | undefined,
  date: Date,
  timezone: string,
): boolean | null {
  if (!weekdayDescriptions || weekdayDescriptions.length === 0) {
    return null;
  }

  const { weekdayIndex, minutes } = getLocalDateParts(date, timezone);
  const previousWeekdayIndex = (weekdayIndex + 6) % 7;
  const todayDescription = getDescriptionForWeekdayIndex(weekdayDescriptions, weekdayIndex);
  const previousDescription = getDescriptionForWeekdayIndex(weekdayDescriptions, previousWeekdayIndex);
  const todayRanges = todayDescription ? parseTimeRanges(todayDescription) : null;
  const previousRanges = previousDescription ? parseTimeRanges(previousDescription) : null;

  if (todayDescription && todayRanges == null) {
    return null;
  }

  if (previousDescription && previousRanges == null) {
    return null;
  }

  for (const range of todayRanges ?? []) {
    if (!range.overnight && minutes >= range.startMinutes && minutes < range.endMinutes) {
      return true;
    }

    if (range.overnight && minutes >= range.startMinutes) {
      return true;
    }
  }

  for (const range of previousRanges ?? []) {
    if (range.overnight && minutes < range.endMinutes) {
      return true;
    }
  }

  if ((todayRanges?.length ?? 0) === 0) {
    return false;
  }

  return false;
}

export async function getVenueLikelyOpenMap(
  googlePlaceIds: string[],
  options: {
    apiKey?: string | null;
    timezone: string;
    now?: Date;
  },
): Promise<Map<string, boolean | null>> {
  const uniquePlaceIds = Array.from(new Set(googlePlaceIds.filter(Boolean)));
  const results = new Map<string, boolean | null>();

  if (!options.apiKey || uniquePlaceIds.length === 0) {
    return results;
  }

  const cache = loadVenueHoursCache();
  const freshEntries = new Map<string, CachedVenueHoursEntry>();
  const stalePlaceIds: string[] = [];

  for (const googlePlaceId of uniquePlaceIds) {
    const entry = cache[googlePlaceId];

    if (isFreshCacheEntry(entry)) {
      freshEntries.set(googlePlaceId, entry!);
    } else {
      stalePlaceIds.push(googlePlaceId);
    }
  }

  for (let index = 0; index < stalePlaceIds.length; index += PLACE_DETAILS_CONCURRENCY) {
    const batch = stalePlaceIds.slice(index, index + PLACE_DETAILS_CONCURRENCY);

    await Promise.all(
      batch.map(async (googlePlaceId) => {
        try {
          const response = await fetch(
            `${GOOGLE_PLACE_DETAILS_API_URL}/places/${encodeURIComponent(googlePlaceId)}`,
            {
              headers: {
                "X-Goog-Api-Key": options.apiKey!,
                "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
              },
            },
          );

          if (!response.ok) {
            return;
          }

          const payload = (await response.json().catch(() => null)) as
            | {
                regularOpeningHours?: {
                  weekdayDescriptions?: string[];
                };
              }
            | null;
          const entry: CachedVenueHoursEntry = {
            googlePlaceId,
            weekdayDescriptions: payload?.regularOpeningHours?.weekdayDescriptions ?? null,
            fetchedAt: new Date().toISOString(),
          };
          cache[googlePlaceId] = entry;
          freshEntries.set(googlePlaceId, entry);
        } catch {
          // Ignore transient Google fetch errors; unknown hours should not block a venue.
        }
      }),
    );
  }

  if (stalePlaceIds.length > 0) {
    saveVenueHoursCache(cache);
  }

  const now = options.now ?? new Date();

  for (const googlePlaceId of uniquePlaceIds) {
    const entry = freshEntries.get(googlePlaceId);
    results.set(
      googlePlaceId,
      isVenueLikelyOpenAt(entry?.weekdayDescriptions, now, options.timezone),
    );
  }

  return results;
}
