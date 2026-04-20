export interface CallingWindowConfig {
  timezone: string;
  start: string;
  end: string;
  allowedDays: string;
}

export interface CallingWindowStatus {
  allowed: boolean;
  reason: string | null;
  localDay: string;
  localTime: string;
  label: string;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

function normaliseWeekday(value: string): WeekdayKey | null {
  const normalised = value.trim().toLowerCase().slice(0, 3);

  if (WEEKDAY_KEYS.includes(normalised as WeekdayKey)) {
    return normalised as WeekdayKey;
  }

  return null;
}

function parseAllowedDays(value: string): Set<WeekdayKey> {
  const parts = value
    .split(/[,\s]+/)
    .map((part) => normaliseWeekday(part))
    .filter((part): part is WeekdayKey => part !== null);

  return new Set(parts.length > 0 ? parts : WEEKDAY_KEYS);
}

function parseClockMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);

  if (!match) {
    throw new Error(`Invalid clock time: ${value}`);
  }

  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);
  return hours * 60 + minutes;
}

function formatLocalParts(date: Date, timezone: string): { localDay: WeekdayKey; localTime: string; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const weekdayValue = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hourValue = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minuteValue = parts.find((part) => part.type === "minute")?.value ?? "00";
  const localDay = normaliseWeekday(weekdayValue) ?? "mon";
  const localTime = `${hourValue}:${minuteValue}`;

  return {
    localDay,
    localTime,
    minutes: parseClockMinutes(localTime),
  };
}

function isWithinWindow(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function formatCallingWindowLabel(config: CallingWindowConfig): string {
  return `${config.start}-${config.end} ${config.timezone} (${config.allowedDays})`;
}

export function getCallingWindowStatus(
  now: Date,
  config: CallingWindowConfig,
): CallingWindowStatus {
  const allowedDays = parseAllowedDays(config.allowedDays);
  const { localDay, localTime, minutes } = formatLocalParts(now, config.timezone);
  const startMinutes = parseClockMinutes(config.start);
  const endMinutes = parseClockMinutes(config.end);
  const label = formatCallingWindowLabel(config);

  if (!allowedDays.has(localDay)) {
    return {
      allowed: false,
      reason: `Outside allowed call days: ${localDay}`,
      localDay,
      localTime,
      label,
    };
  }

  if (!isWithinWindow(minutes, startMinutes, endMinutes)) {
    return {
      allowed: false,
      reason: `Outside allowed call hours at ${localTime} ${config.timezone}`,
      localDay,
      localTime,
      label,
    };
  }

  return {
    allowed: true,
    reason: null,
    localDay,
    localTime,
    label,
  };
}
