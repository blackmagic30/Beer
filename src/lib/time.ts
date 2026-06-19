export function nowIso(): string {
  return new Date().toISOString();
}

export function unixSecondsToIso(unixSeconds?: number): string {
  if (!unixSeconds) {
    return nowIso();
  }

  return new Date(unixSeconds * 1000).toISOString();
}

export const DEFAULT_REPORT_TIMEZONE = "Australia/Melbourne";

function getZonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const parts = getZonedParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedLocalTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour?: number | undefined;
  minute?: number | undefined;
  second?: number | undefined;
  timezone: string;
}): Date {
  const targetUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour ?? 0,
    input.minute ?? 0,
    input.second ?? 0,
    0,
  );
  let guess = targetUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimezoneOffsetMs(new Date(guess), input.timezone);
    guess = targetUtc - offset;
  }

  return new Date(guess);
}

export function getZonedMonthKey(date = new Date(), timezone = DEFAULT_REPORT_TIMEZONE): string {
  const parts = getZonedParts(date, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
}

export function getPreviousZonedMonthKey(date = new Date(), timezone = DEFAULT_REPORT_TIMEZONE): string {
  const parts = getZonedParts(date, timezone);
  const previousMonthDate = parts.month === 1
    ? { year: parts.year - 1, month: 12 }
    : { year: parts.year, month: parts.month - 1 };
  return `${String(previousMonthDate.year).padStart(4, "0")}-${String(previousMonthDate.month).padStart(2, "0")}`;
}

export function getZonedMonthRangeIso(month: string, timezone = DEFAULT_REPORT_TIMEZONE): {
  month: string;
  timezone: string;
  startIso: string;
  endIso: string;
} {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("Month must use YYYY-MM format.");
  }

  const [yearPart, monthPart] = month.split("-");
  const year = Number(yearPart);
  const monthNumber = Number(monthPart);

  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error("Month must use a valid YYYY-MM value.");
  }

  const nextMonth = monthNumber === 12
    ? { year: year + 1, month: 1 }
    : { year, month: monthNumber + 1 };

  return {
    month,
    timezone,
    startIso: zonedLocalTimeToUtc({ year, month: monthNumber, day: 1, timezone }).toISOString(),
    endIso: zonedLocalTimeToUtc({ year: nextMonth.year, month: nextMonth.month, day: 1, timezone }).toISOString(),
  };
}

export function getZonedDayRangeIso(date = new Date(), timezone = DEFAULT_REPORT_TIMEZONE): {
  timezone: string;
  startIso: string;
  endIso: string;
} {
  const parts = getZonedParts(date, timezone);

  return {
    timezone,
    startIso: zonedLocalTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, timezone }).toISOString(),
    endIso: zonedLocalTimeToUtc({ year: parts.year, month: parts.month, day: parts.day + 1, timezone }).toISOString(),
  };
}

export function getZonedWeekRangeIso(date = new Date(), timezone = DEFAULT_REPORT_TIMEZONE): {
  timezone: string;
  startIso: string;
  endIso: string;
} {
  const parts = getZonedParts(date, timezone);
  const localWeekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const daysSinceMonday = (localWeekday + 6) % 7;
  const startDay = parts.day - daysSinceMonday;

  return {
    timezone,
    startIso: zonedLocalTimeToUtc({ year: parts.year, month: parts.month, day: startDay, timezone }).toISOString(),
    endIso: zonedLocalTimeToUtc({ year: parts.year, month: parts.month, day: startDay + 7, timezone }).toISOString(),
  };
}
