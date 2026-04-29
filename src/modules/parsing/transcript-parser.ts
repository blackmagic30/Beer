import { TARGET_BEERS, type BeerName, type TrackedBeerDefinition } from "../../constants/beers.js";
import type {
  BeerAvailabilityStatus,
  BeerUnavailableReason,
  ParseStatus,
} from "../../db/models.js";
import { inferBeerAvailability } from "../../lib/beer-availability.js";

export interface TranscriptTurnLike {
  role: string | undefined;
  message: string | undefined;
  originalMessage: string | undefined;
}

export interface ParsedBeerPrice {
  beerName: BeerName;
  priceText: string | null;
  priceNumeric: number | null;
  confidence: number;
  needsReview: boolean;
  evidence: string | null;
  isUnavailable: boolean;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
}

export interface ParsedHappyHour {
  happyHour: boolean;
  happyHourDays: string | null;
  happyHourStart: string | null;
  happyHourEnd: string | null;
  happyHourPrice: number | null;
  happyHourSpecials: string | null;
  confidence: number;
  needsReview: boolean;
  evidence: string | null;
}

export interface ParseOutcomeSummary {
  parseConfidence: number;
  parseStatus: ParseStatus;
  needsReview: boolean;
}

interface ParseBeerOptions {
  assumeBeerContext?: boolean;
  targetBeers?: readonly TrackedBeerDefinition[];
}

interface PriceMention {
  index: number;
  value: number;
  text: string;
  hasCurrencySignal: boolean;
}

interface Candidate {
  beerName: BeerName;
  priceText: string | null;
  priceNumeric: number | null;
  confidence: number;
  evidence: string;
  isUnavailable: boolean;
}

interface HappyHourDayMatch {
  value: string;
  index: number;
}

interface HappyHourTimeRange {
  start: string;
  end: string;
  index: number;
  raw: string;
}

interface ParseHappyHourOptions {
  assumeHappyHourContext?: boolean;
}

interface ExtractTimeRangeOptions {
  preferPm?: boolean;
}

const PRICE_REGEX = /\$?\s*(\d{1,2}(?:\.\d{1,2})?)(?:\s*(?:dollars?|bucks?))?/gi;
const NUMBER_WORD_UNITS = [
  "zero",
  "oh",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;
const NUMBER_WORD_TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;
const NUMBER_WORD_TOKEN_PATTERN = [...NUMBER_WORD_UNITS, ...NUMBER_WORD_TENS].join("|");
const NUMBER_WORD_PHRASE_PATTERN = `(?:${NUMBER_WORD_TOKEN_PATTERN})(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?`;
const WORD_PRICE_REGEX = new RegExp(
  `\\b(${NUMBER_WORD_PHRASE_PATTERN})(?:\\s+(?:dollars?|bucks?))(?:\\s+and\\s+(${NUMBER_WORD_PHRASE_PATTERN})\\s+cents?)?\\b`,
  "gi",
);
const UNCERTAINTY_REGEX = /\b(not sure|don't know|dont know|unsure|maybe|around|about|probably|i think)\b/i;
const DO_NOT_DISFLUENT_HAVE_PATTERN = "do not(?:,?\\s*(?:uh|um|ah|er),?)?\\s+have";
const DO_NOT_DISFLUENT_SELL_PATTERN = "do not(?:,?\\s*(?:uh|um|ah|er),?)?\\s+sell";
const DO_NOT_DISFLUENT_DO_PATTERN = "do not(?:,?\\s*(?:uh|um|ah|er),?)?\\s+do";
const SMALL_TAP_POUR_PATTERN = "(?:schooners?|pots?|midd(?:y|ies)|halves?)";
const NO_PINTS_PATTERN =
  `(?:don't do(?: [^.!?\\n]{0,24})?pints?|dont do(?: [^.!?\\n]{0,24})?pints?|${DO_NOT_DISFLUENT_DO_PATTERN}(?: [^.!?\\n]{0,24})?pints?|no pints?(?: of)?|${SMALL_TAP_POUR_PATTERN} only|only (?:do|have|serve)(?: [^.!?\\n]{0,18})?${SMALL_TAP_POUR_PATTERN}|just (?:do|have|serve)(?: [^.!?\\n]{0,18})?${SMALL_TAP_POUR_PATTERN}|only in ${SMALL_TAP_POUR_PATTERN})`;
const UNAVAILABLE_REGEX =
  new RegExp(
    `\\b(unavailable|don't have|dont have|${DO_NOT_DISFLUENT_HAVE_PATTERN}|don't sell|dont sell|${DO_NOT_DISFLUENT_SELL_PATTERN}|don't do|dont do|${DO_NOT_DISFLUENT_DO_PATTERN}|not available|out of stock|no idea|${NO_PINTS_PATTERN})\\b`,
    "i",
  );
const STRONG_UNAVAILABLE_REGEX =
  new RegExp(
    `\\b(don't have(?: it)? on tap|dont have(?: it)? on tap|${DO_NOT_DISFLUENT_HAVE_PATTERN}(?: it)? on tap|don't sell|dont sell|${DO_NOT_DISFLUENT_SELL_PATTERN}|not on tap|only got (?:cans?|bottles?)|only have (?:cans?|bottles?)|(?:just |only )?do(?: it)? (?:on|in) the (?:cans?|bottles?)|(?:only )?do(?: like)? (?:the )?(?:big )?(?:cans?|bottles?)|${NO_PINTS_PATTERN})\\b`,
    "i",
  );
const RECORDING_UNAVAILABLE_REGEX =
  /\b(this number is not available|record your message|at the tone|leave (?:your )?message|voicemail|mailbox|press any key)\b/i;
const AUTOMATED_RECORDING_REGEX =
  /\b(emergency broadcast|this is a test of the emergency broadcast system|local radio or television station|broadcast important information)\b/i;
const CLARIFICATION_PROMPT_REGEX =
  /\b(sorry|pardon|come again|repeat that|say that again|what was that|could you repeat)\b/i;
const NON_SUBSTANTIVE_AGENT_TURN_REGEX = /^[.?!…\s]+$/;
const CLOSING_AGENT_TURN_REGEX = /\b(thanks|thank you|thanks anyway|goodbye|bye|no worries)\b/i;
const CORRECTION_SIGNAL_REGEX =
  /\b(wrong price|double-?check|have a check|let me check|let me just check|actually|pardon|sorry|i mean)\b/i;
const NON_BEER_SERVICE_PRICE_REGEX =
  /\b(?:for|per)\s+an?\s+hour\b|\bby (?:the )?hour\b|\bhourly\b|\b(?:golf )?bay\b|\bdriving range\b|\blane hire\b/i;
const GREETING_PRICE_PREFIX_REGEX =
  /\b(?:thanks?|thank you)\s+for\s+calling\s*$|\byou(?:'ve| have)\s+reached\s*$|\bwelcome\s+to\s*$|\bthis\s+is\s*$/i;
const DAY_OR_SPECIAL_CONTEXT_REGEX =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays?|weekends?|public holidays?|sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|specials?|happy hour)\b/i;
const REGULAR_PRICE_CONTEXT_REGEX = /\b(normally|usually|regular(?:ly)?(?:'s|s)?|standard|full price)\b/i;
const HAPPY_HOUR_KEYWORD_REGEX = /\b(happy hour|deal|deals|special|specials|promo|promotion|discount)\b/i;
const HAPPY_HOUR_NEGATIVE_REGEX =
  /\b(no happy hour|no deals?|no specials?|not at the moment|nothing at the moment|nothing right now|not currently)\b|\b(?:don't|dont)\s+have\b(?:[^.!?\n]{0,30})\b(?:happy hour|deals?|specials?)\b|\b(?:nah|nope|none)\b(?:[^.!?\n]{0,25})\b(?:happy hour|deals?|specials?)\b/i;
const HAPPY_HOUR_SPECIALS_KEYWORD_REGEX =
  /\b(specials?|deals?|discount|discounted|off|two for one|2 for 1|half price|pints?|schooners?|pots?|midd(?:y|ies)|cocktails?|spritz(?:es)?|beer|wine|wings?|pizza|parma|burgers?|oysters?|tacos?|snacks?|jugs?)\b/i;
const DAY_RANGE_REGEX =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(?:-|to)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const DAY_ONLY_REGEX = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+only\b/i;
const SINGLE_DAY_REGEX = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TIME_RANGE_REGEX =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|til|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;

function clamp(value: number, min = 0, max = 0.99): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(2))));
}

function normaliseTranscript(transcriptText: string): string {
  return transcriptText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function splitIntoSegments(transcriptText: string): string[] {
  const normalised = normaliseTranscript(transcriptText);

  if (!normalised) {
    return [];
  }

  return normalised
    .split(/(?:\n+|[!?]+|\.(?!\d))/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function findAllIndexes(text: string, search: string): number[] {
  const indexes: number[] = [];
  let index = text.indexOf(search);

  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(search, index + search.length);
  }

  return indexes;
}

function parseNumberWordPhrase(phrase: string | undefined): number | null {
  if (!phrase) {
    return null;
  }

  const normalized = phrase.toLowerCase().replace(/-/g, " ").trim();

  if (!normalized) {
    return null;
  }

  const directValues: Record<string, number> = {
    zero: 0,
    oh: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  if (normalized in directValues) {
    return directValues[normalized]!;
  }

  const parts = normalized.split(/\s+/).filter(Boolean);

  if (parts.length !== 2) {
    return null;
  }

  const tens = directValues[parts[0]!] ?? null;
  const units = directValues[parts[1]!] ?? null;

  if (tens === null || units === null || tens < 20 || units > 9) {
    return null;
  }

  return tens + units;
}

function extractPriceMentions(segment: string): PriceMention[] {
  const mentions: PriceMention[] = [];

  for (const match of segment.matchAll(PRICE_REGEX)) {
    const rawValue = match[1];
    const fullMatch = match[0];
    const startIndex = match.index;

    if (!rawValue || !fullMatch || startIndex === undefined) {
      continue;
    }

    const numericOffset = fullMatch.search(/\d/);

    if (numericOffset === -1) {
      continue;
    }

    const numericStartIndex = startIndex + numericOffset;
    const numericEndIndex = numericStartIndex + rawValue.length;
    const previousCharacter = segment[numericStartIndex - 1] ?? "";
    const nextCharacter = segment[numericEndIndex] ?? "";
    const currencyCharacter = segment[startIndex] ?? "";
    const beforeWindow = segment.slice(Math.max(0, numericStartIndex - 40), numericStartIndex);
    const afterWindow = segment.slice(numericEndIndex, Math.min(segment.length, numericEndIndex + 40));

    if (
      previousCharacter === ":" ||
      nextCharacter === ":" ||
      /[£€¥]/.test(previousCharacter) ||
      /[£€¥]/.test(currencyCharacter) ||
      /[A-Za-z0-9]/.test(previousCharacter) ||
      /[A-Za-z0-9]/.test(nextCharacter)
    ) {
      continue;
    }

    if (
      !/\$|dollar|buck/i.test(fullMatch) &&
      GREETING_PRICE_PREFIX_REGEX.test(beforeWindow) &&
      /^\s*[A-Za-z]/.test(afterWindow)
    ) {
      continue;
    }

    if (
      !/\$|dollar|buck/i.test(fullMatch) &&
      (
        /^\s*(?:-|to|til|until)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(afterWindow) ||
        /\b\d{1,2}(?::\d{2})?\s*(?:-|to|til|until)\s*$/.test(beforeWindow)
      )
    ) {
      continue;
    }

    mentions.push({
      index: startIndex,
      value: Number.parseFloat(rawValue),
      text: fullMatch.trim(),
      hasCurrencySignal: /\$|dollar|buck/i.test(fullMatch),
    });
  }

  for (const match of segment.matchAll(WORD_PRICE_REGEX)) {
    const wholeMatch = match[0];
    const dollarsRaw = match[1];
    const centsRaw = match[2];
    const startIndex = match.index;

    if (!wholeMatch || !dollarsRaw || startIndex === undefined) {
      continue;
    }

    const dollars = parseNumberWordPhrase(dollarsRaw);
    const cents = parseNumberWordPhrase(centsRaw);

    if (dollars === null) {
      continue;
    }

    const value = cents === null ? dollars : Number.parseFloat(`${dollars}.${String(cents).padStart(2, "0")}`);

    if (
      mentions.some(
        (mention) =>
          mention.index === startIndex &&
          mention.value === value,
      )
    ) {
      continue;
    }

    mentions.push({
      index: startIndex,
      value,
      text: wholeMatch.trim(),
      hasCurrencySignal: true,
    });
  }

  mentions.sort((left, right) => left.index - right.index);

  return mentions;
}

function buildBeerCandidate(segment: string, beerName: BeerName, aliases: readonly string[]): Candidate | null {
  const lowerSegment = segment.toLowerCase();
  const aliasMatches = aliases
    .flatMap((alias) =>
      findAllIndexes(lowerSegment, alias.toLowerCase()).map((index) => ({ alias, index })),
    )
    .sort((left, right) => left.index - right.index);

  if (aliasMatches.length === 0) {
    return null;
  }

  const priceMentions = extractPriceMentions(segment);

  if (priceMentions.length === 0) {
    const isUnavailable = UNAVAILABLE_REGEX.test(segment);
    const confidence = isUnavailable ? 0.84 : 0.24;

    return {
      beerName,
      priceText: isUnavailable ? segment : null,
      priceNumeric: null,
      confidence,
      evidence: segment,
      isUnavailable,
    };
  }

  let bestCandidate: Candidate | null = null;

  for (const [aliasIndex, aliasMatch] of aliasMatches.entries()) {
    const nextAliasIndex = aliasMatches[aliasIndex + 1]?.index;
    const mentionsAfterAlias = priceMentions.filter((priceMention) => priceMention.index >= aliasMatch.index);
    const mentionsWithinAliasWindow =
      nextAliasIndex === undefined
        ? mentionsAfterAlias
        : mentionsAfterAlias.filter((priceMention) => priceMention.index < nextAliasIndex);
    const candidateMentions =
      mentionsWithinAliasWindow.length > 0
        ? mentionsWithinAliasWindow
        : mentionsAfterAlias.length > 0
          ? mentionsAfterAlias
          : priceMentions;

    for (const priceMention of candidateMentions) {
      const relativeDistance = priceMention.index - aliasMatch.index;
      const absoluteDistance = Math.abs(relativeDistance);
      let confidence = aliasMatch.alias.toLowerCase() === beerName.toLowerCase() ? 0.62 : 0.54;

      if (relativeDistance >= 0 && relativeDistance <= 20) {
        confidence += 0.24;
      } else if (relativeDistance >= 0 && relativeDistance <= 45) {
        confidence += 0.16;
      } else if (absoluteDistance <= 12) {
        confidence += 0.06;
      } else {
        confidence -= 0.04;
      }

      if (priceMention.hasCurrencySignal) {
        confidence += 0.08;
      }

      if (priceMentions.length === 1) {
        confidence += 0.05;
      } else {
        confidence -= 0.06;
      }

      if (UNCERTAINTY_REGEX.test(segment)) {
        confidence -= 0.18;
      }

      if (UNAVAILABLE_REGEX.test(segment)) {
        confidence -= 0.22;
      }

      const candidate: Candidate = {
        beerName,
        priceText: priceMention.text,
        priceNumeric: priceMention.value,
        confidence: clamp(confidence),
        evidence: segment,
        isUnavailable: false,
      };

      if (!bestCandidate || candidate.confidence > bestCandidate.confidence) {
        bestCandidate = candidate;
      }
    }
  }

  return bestCandidate;
}

function buildMissingBeerResult(beerName: BeerName): ParsedBeerPrice {
  return {
    beerName,
    priceText: null,
    priceNumeric: null,
    confidence: 0.05,
    needsReview: true,
    evidence: null,
    isUnavailable: false,
    availabilityStatus: "unknown",
    availableOnTap: null,
    availablePackageOnly: false,
    unavailableReason: null,
  };
}

function scoreAssumedContextPrice(evidence: string, priceMentions: PriceMention[], target: PriceMention): number {
  const mentionIndex = priceMentions.indexOf(target);
  const windowStart = Math.max(0, target.index - 18);
  const windowEnd = Math.min(evidence.length, target.index + target.text.length + 18);
  const contextWindow = evidence.slice(windowStart, windowEnd);
  const previousMention = mentionIndex > 0 ? priceMentions[mentionIndex - 1] : null;
  const nextMention = mentionIndex + 1 < priceMentions.length ? priceMentions[mentionIndex + 1] : null;
  const leadIn = evidence.slice(previousMention ? previousMention.index + previousMention.text.length : Math.max(0, target.index - 60), target.index);
  const trailOut = evidence.slice(target.index + target.text.length, nextMention ? nextMention.index : evidence.length);
  let score = 0.56;

  if (target.hasCurrencySignal) {
    score += 0.08;
  }

  if (REGULAR_PRICE_CONTEXT_REGEX.test(contextWindow)) {
    score += 0.24;
  }

  if (DAY_OR_SPECIAL_CONTEXT_REGEX.test(contextWindow)) {
    score -= 0.18;
  }

  if (HAPPY_HOUR_KEYWORD_REGEX.test(contextWindow) || /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:to|until|-)\s+\d{1,2}/i.test(contextWindow)) {
    score -= 0.24;
  }

  if (mentionIndex > 0 && CORRECTION_SIGNAL_REGEX.test(leadIn)) {
    score += 0.26;
  }

  if (nextMention && CORRECTION_SIGNAL_REGEX.test(trailOut)) {
    score -= 0.22;
  }

  if (mentionIndex > 0 && /\./.test(target.text) && priceMentions.slice(0, mentionIndex).every((mention) => !/\./.test(mention.text))) {
    score += 0.08;
  }

  if (mentionIndex === 0) {
    score += 0.08;
  }

  if (priceMentions.length === 2 && mentionIndex === 0 && /,\s*\d{1,2}(?:\.\d{1,2})?\s*(?:on|for)\s+/i.test(evidence)) {
    score += 0.1;
  }

  return score;
}

function pickPrimaryAssumedContextPrice(evidence: string, priceMentions: PriceMention[]): PriceMention | null {
  if (priceMentions.length === 0) {
    return null;
  }

  return [...priceMentions].sort((left, right) => {
    const scoreDifference =
      scoreAssumedContextPrice(evidence, priceMentions, right) - scoreAssumedContextPrice(evidence, priceMentions, left);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    const precisionDifference =
      (/\./.test(right.text) ? 1 : 0) - (/\./.test(left.text) ? 1 : 0);

    if (precisionDifference !== 0) {
      return precisionDifference;
    }

    return right.index - left.index;
  })[0] ?? null;
}

function titleCaseDay(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
}

function inferMissingMeridian(startHour: number, endHour: number, endMeridian?: string): string | undefined {
  if (!endMeridian) {
    return undefined;
  }

  if (startHour <= 12 && endHour <= 12 && startHour <= endHour) {
    return endMeridian;
  }

  return undefined;
}

function normaliseTimePart(hourRaw: string, minuteRaw?: string, meridianRaw?: string): string | null {
  const hour = Number.parseInt(hourRaw, 10);
  const minute = minuteRaw ? Number.parseInt(minuteRaw, 10) : 0;

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute < 0 || minute > 59) {
    return null;
  }

  const meridian = meridianRaw?.toLowerCase();
  let hour24 = hour;

  if (meridian === "am") {
    hour24 = hour % 12;
  } else if (meridian === "pm") {
    hour24 = hour % 12;
    hour24 += 12;
  }

  if (hour24 < 0 || hour24 > 23) {
    return null;
  }

  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extractDayMatch(text: string): HappyHourDayMatch | null {
  const normalised = text.toLowerCase();

  const dailyMatch = normalised.match(/\b(daily|every day|7 days|seven days)\b/i);

  if (dailyMatch?.index !== undefined) {
    return {
      value: "daily",
      index: dailyMatch.index,
    };
  }

  const weekdaysMatch = normalised.match(/\bweekdays\b/i);

  if (weekdaysMatch?.index !== undefined) {
    return {
      value: "weekdays",
      index: weekdaysMatch.index,
    };
  }

  const weekendsMatch = normalised.match(/\bweekends\b/i);

  if (weekendsMatch?.index !== undefined) {
    return {
      value: "weekends",
      index: weekendsMatch.index,
    };
  }

  const dayRangeMatch = text.match(DAY_RANGE_REGEX);

  if (dayRangeMatch && dayRangeMatch.index !== undefined) {
    return {
      value: `${titleCaseDay(dayRangeMatch[1]!)}-${titleCaseDay(dayRangeMatch[2]!)}`,
      index: dayRangeMatch.index,
    };
  }

  const dayOnlyMatch = text.match(DAY_ONLY_REGEX);

  if (dayOnlyMatch && dayOnlyMatch.index !== undefined) {
    return {
      value: `${titleCaseDay(dayOnlyMatch[1]!)} only`,
      index: dayOnlyMatch.index,
    };
  }

  const singleDayMatch = text.match(SINGLE_DAY_REGEX);

  if (singleDayMatch && singleDayMatch.index !== undefined) {
    return {
      value: titleCaseDay(singleDayMatch[1]!),
      index: singleDayMatch.index,
    };
  }

  return null;
}

function extractTimeRange(text: string, options: ExtractTimeRangeOptions = {}): HappyHourTimeRange | null {
  let bestMatch: HappyHourTimeRange | null = null;

  for (const match of text.matchAll(TIME_RANGE_REGEX)) {
    const raw = match[0];
    const startHourRaw = match[1];
    const startMinuteRaw = match[2];
    const startMeridianRaw = match[3];
    const endHourRaw = match[4];
    const endMinuteRaw = match[5];
    const endMeridianRaw = match[6];

    if (!raw || !startHourRaw || !endHourRaw || match.index === undefined) {
      continue;
    }

    const startHour = Number.parseInt(startHourRaw, 10);
    const endHour = Number.parseInt(endHourRaw, 10);
    const inferPmRange =
      options.preferPm === true &&
      !startMeridianRaw &&
      !endMeridianRaw &&
      startHour >= 3 &&
      startHour <= 11 &&
      endHour >= 3 &&
      endHour <= 11;
    const inferredStartMeridian =
      startMeridianRaw ??
      (inferPmRange ? "pm" : inferMissingMeridian(
        startHour,
        endHour,
        endMeridianRaw ?? undefined,
      ));
    const inferredEndMeridian = endMeridianRaw ?? startMeridianRaw ?? (inferPmRange ? "pm" : undefined);
    const start = normaliseTimePart(startHourRaw, startMinuteRaw ?? undefined, inferredStartMeridian);
    const end = normaliseTimePart(endHourRaw, endMinuteRaw ?? undefined, inferredEndMeridian);

    if (!start || !end) {
      continue;
    }

    const timeRange: HappyHourTimeRange = {
      start,
      end,
      index: match.index,
      raw: raw.trim(),
    };

    if (!bestMatch) {
      bestMatch = timeRange;
      continue;
    }

    const currentHasMeridian = Boolean(
      startMeridianRaw ||
      endMeridianRaw ||
      Number.parseInt(startHourRaw, 10) > 12 ||
      Number.parseInt(endHourRaw, 10) > 12,
    );
    const bestHasMeridian = /am|pm|:/.test(bestMatch.raw);

    if (currentHasMeridian && !bestHasMeridian) {
      bestMatch = timeRange;
    }
  }

  return bestMatch;
}

function findHappyHourKeywordIndex(text: string): number | null {
  const keywordMatch = text.match(HAPPY_HOUR_KEYWORD_REGEX);
  return keywordMatch?.index ?? null;
}

function extractHappyHourPrice(
  text: string,
  primaryAnchor: number,
  timeRange: HappyHourTimeRange | null,
): PriceMention | null {
  const allMentions = extractPriceMentions(text).filter((mention) => {
    if (!timeRange) {
      return true;
    }

    const timeRangeStart = timeRange.index;
    const timeRangeEnd = timeRange.index + timeRange.raw.length;
    return !(mention.index >= timeRangeStart && mention.index < timeRangeEnd);
  });

  if (allMentions.length === 0) {
    return null;
  }

  const candidateMentions = allMentions.filter((mention) => mention.index >= primaryAnchor);
  const mentions = candidateMentions.length > 0 ? candidateMentions : allMentions;

  let bestMention: PriceMention | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const mention of mentions) {
    let score = 0.25;
    const distanceToAnchor = Math.abs(mention.index - primaryAnchor);

    if (distanceToAnchor <= 12) {
      score += 0.26;
    } else if (distanceToAnchor <= 28) {
      score += 0.18;
    } else if (distanceToAnchor <= 60) {
      score += 0.08;
    }

    if (mention.hasCurrencySignal) {
      score += 0.08;
    }

    if (timeRange && mention.index >= timeRange.index) {
      score += 0.14;
    }

    if (mention.index < primaryAnchor) {
      score -= 0.18;
    }

    if (mentions.length > 1 && mention === mentions[mentions.length - 1]) {
      score += 0.04;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMention = mention;
    }
  }

  return bestMention;
}

function containsHappyHourContext(segment: string): boolean {
  return (
    HAPPY_HOUR_KEYWORD_REGEX.test(segment) ||
    extractDayMatch(segment) !== null ||
    extractTimeRange(segment) !== null
  );
}

function buildHappyHourCandidateText(transcriptText: string, assumeHappyHourContext: boolean): string {
  const normalised = normaliseTranscript(transcriptText);

  if (!normalised) {
    return "";
  }

  if (assumeHappyHourContext) {
    return normalised;
  }

  const segments = splitIntoSegments(normalised);
  const selectedIndexes = new Set<number>();

  segments.forEach((segment, index) => {
    if (!containsHappyHourContext(segment)) {
      return;
    }

    selectedIndexes.add(index);

    if (index > 0) {
      selectedIndexes.add(index - 1);
    }

    if (index + 1 < segments.length) {
      selectedIndexes.add(index + 1);
    }
  });

  if (selectedIndexes.size === 0) {
    if (HAPPY_HOUR_NEGATIVE_REGEX.test(normalised) || HAPPY_HOUR_KEYWORD_REGEX.test(normalised)) {
      return normalised;
    }

    return "";
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => segments[index])
    .join(". ");
}

function extractHappyHourSpecials(
  candidateText: string,
  dayMatch: HappyHourDayMatch | null,
  timeRange: HappyHourTimeRange | null,
): string | null {
  if (!candidateText.trim()) {
    return null;
  }

  const explicitMatch = candidateText.match(
    /\b(?:specials?|deals?)\s*(?:are|is|include|includes|during(?: that| it)?)?\s+(.+)$/i,
  );
  let specialsSource = explicitMatch?.[1] ?? candidateText;

  if (dayMatch?.value) {
    specialsSource = specialsSource.replace(new RegExp(dayMatch.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }

  if (timeRange?.raw) {
    specialsSource = specialsSource.replace(new RegExp(timeRange.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }

  specialsSource = specialsSource
    .replace(/\bhappy hour\b/gi, " ")
    .replace(/\b(?:we do|we've got|we have|there's|there is|it is|it's|available|from|then|during that|during it)\b/gi, " ")
    .replace(/\band\b/gi, " ")
    .replace(/^with\b/i, " ")
    .replace(/^the\b/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "");

  if (!specialsSource) {
    return null;
  }

  if (!HAPPY_HOUR_SPECIALS_KEYWORD_REGEX.test(specialsSource) && extractPriceMentions(specialsSource).length === 0) {
    return null;
  }

  return specialsSource;
}

function buildNoHappyHourResult(confidence: number, evidence: string | null): ParsedHappyHour {
  return {
    happyHour: false,
    happyHourDays: null,
    happyHourStart: null,
    happyHourEnd: null,
    happyHourPrice: null,
    happyHourSpecials: null,
    confidence,
    needsReview: false,
    evidence,
  };
}

function getTurnText(turn: TranscriptTurnLike): string {
  return turn.message?.trim() || turn.originalMessage?.trim() || "";
}

function containsTargetBeerReference(text: string, beers: readonly TrackedBeerDefinition[] = TARGET_BEERS): boolean {
  const lowerText = text.toLowerCase();

  return beers.some((beer) =>
    [beer.name, ...beer.aliases].some((alias) => lowerText.includes(alias.toLowerCase())),
  );
}

function isBeerQuestionTurn(turn: TranscriptTurnLike, beers: readonly TrackedBeerDefinition[] = TARGET_BEERS): boolean {
  const message = getTurnText(turn);

  if (!message || turn.role?.toLowerCase() !== "agent") {
    return false;
  }

  return containsTargetBeerReference(message, beers) && /\b(price|pint)\b/i.test(message);
}

function isClarificationTurn(turn: TranscriptTurnLike): boolean {
  const message = getTurnText(turn);

  if (!message || turn.role?.toLowerCase() !== "agent") {
    return false;
  }

  return CLARIFICATION_PROMPT_REGEX.test(message);
}

function isNonSubstantiveAgentTurn(turn: TranscriptTurnLike): boolean {
  const message = getTurnText(turn);

  if (!message || turn.role?.toLowerCase() !== "agent") {
    return false;
  }

  return NON_SUBSTANTIVE_AGENT_TURN_REGEX.test(message);
}

function isClosingAgentTurn(turn: TranscriptTurnLike): boolean {
  const message = getTurnText(turn);

  if (!message || turn.role?.toLowerCase() !== "agent") {
    return false;
  }

  return CLOSING_AGENT_TURN_REGEX.test(message);
}

function scoreBeerContextSequence(sequence: string, beers: readonly TrackedBeerDefinition[] = TARGET_BEERS): number {
  const evidence = normaliseTranscript(sequence);

  if (!evidence) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (AUTOMATED_RECORDING_REGEX.test(evidence) || RECORDING_UNAVAILABLE_REGEX.test(evidence)) {
    score -= 1.2;
  }

  if (NON_BEER_SERVICE_PRICE_REGEX.test(evidence)) {
    score -= 1.1;
  }

  if (STRONG_UNAVAILABLE_REGEX.test(evidence)) {
    score += 0.9;
  } else if (UNAVAILABLE_REGEX.test(evidence)) {
    score += 0.55;
  }

  const priceMentions = extractPriceMentions(evidence);

  if (priceMentions.length > 0) {
    score += 0.45;

    if (priceMentions.some((mention) => mention.hasCurrencySignal)) {
      score += 0.12;
    }
  }

  if (containsTargetBeerReference(evidence, beers)) {
    score += 0.08;
  }

  if (/^(?:uh[,.\s]*)?no[.!]?$/.test(evidence.trim().toLowerCase())) {
    score -= 0.2;
  }

  score += Math.min(evidence.length / 500, 0.18);

  return score;
}

function buildAssumedContextCandidate(transcriptText: string, beerName: BeerName): Candidate | null {
  const evidence = normaliseTranscript(transcriptText);

  if (!evidence) {
    return null;
  }

  if (AUTOMATED_RECORDING_REGEX.test(evidence) || RECORDING_UNAVAILABLE_REGEX.test(evidence)) {
    return null;
  }

  if (NON_BEER_SERVICE_PRICE_REGEX.test(evidence)) {
    return null;
  }

  if (
    (STRONG_UNAVAILABLE_REGEX.test(evidence) || UNAVAILABLE_REGEX.test(evidence)) &&
    !RECORDING_UNAVAILABLE_REGEX.test(evidence)
  ) {
    let confidence = STRONG_UNAVAILABLE_REGEX.test(evidence) ? 0.88 : 0.82;

    if (UNCERTAINTY_REGEX.test(evidence) && !STRONG_UNAVAILABLE_REGEX.test(evidence)) {
      confidence -= 0.16;
    }

    return {
      beerName,
      priceText: evidence,
      priceNumeric: null,
      confidence: clamp(confidence),
      evidence,
      isUnavailable: true,
    };
  }

  const priceMentions = extractPriceMentions(evidence);

  if (priceMentions.length === 0) {
    return null;
  }

  const priceMention = pickPrimaryAssumedContextPrice(evidence, priceMentions);

  if (!priceMention) {
    return null;
  }

  let confidence = 0.72;

  if (priceMention.hasCurrencySignal) {
    confidence += 0.08;
  }

  if (priceMentions.length > 1) {
    confidence -= 0.02;

    const daySpecificFollowUpPattern = /,\s*\d{1,2}(?:\.\d{1,2})?\s*(?:on|for)\s+(?:sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|weekends?|weekdays?|public holidays?)/i;

    if (priceMentions.length === 2 && priceMention === priceMentions[0] && daySpecificFollowUpPattern.test(evidence)) {
      confidence += 0.12;
    } else {
      const windowStart = Math.max(0, priceMention.index - 18);
      const windowEnd = Math.min(evidence.length, priceMention.index + priceMention.text.length + 26);
      const contextWindow = evidence.slice(windowStart, windowEnd);

      if (REGULAR_PRICE_CONTEXT_REGEX.test(contextWindow) || !DAY_OR_SPECIAL_CONTEXT_REGEX.test(contextWindow)) {
        confidence += 0.06;
      } else {
        confidence -= 0.08;
      }
    }
  }

  if (UNCERTAINTY_REGEX.test(evidence)) {
    confidence -= 0.18;
  }

  const shouldPreserveFullEvidence =
    priceMentions.length > 1 ||
    UNCERTAINTY_REGEX.test(evidence) ||
    DAY_OR_SPECIAL_CONTEXT_REGEX.test(evidence);

  return {
    beerName,
    priceText: shouldPreserveFullEvidence ? evidence : priceMention.text,
    priceNumeric: priceMention.value,
    confidence: clamp(confidence),
    evidence,
    isUnavailable: false,
  };
}

export function extractBeerContextText(
  turns: TranscriptTurnLike[],
  beers: readonly TrackedBeerDefinition[] = TARGET_BEERS,
): string {
  const sequences: string[] = [];
  let collected: string[] = [];
  let capturing = false;

  for (const turn of turns) {
    const message = getTurnText(turn);

    if (!message) {
      continue;
    }

    if (isBeerQuestionTurn(turn, beers)) {
      if (collected.length > 0) {
        sequences.push(collected.join(". ").trim());
        collected = [];
      }

      capturing = true;
      continue;
    }

    if (!capturing) {
      continue;
    }

    if (turn.role?.toLowerCase() === "user") {
      collected.push(message);
      continue;
    }

    if (
      collected.length > 0 &&
      (isClarificationTurn(turn) || isNonSubstantiveAgentTurn(turn) || isClosingAgentTurn(turn))
    ) {
      continue;
    }

    if (collected.length > 0 && turn.role?.toLowerCase() === "agent") {
      sequences.push(collected.join(". ").trim());
      collected = [];
      capturing = false;
    }
  }

  if (collected.length > 0) {
    sequences.push(collected.join(". ").trim());
  }

  return (
    [...sequences]
      .sort((left, right) => scoreBeerContextSequence(right, beers) - scoreBeerContextSequence(left, beers))[0] ??
    ""
  );
}

export function extractHappyHourContextText(turns: TranscriptTurnLike[]): string {
  const sequences: string[] = [];
  let collected: string[] = [];
  let capturing = false;

  for (const turn of turns) {
    const message = getTurnText(turn);

    if (!message) {
      continue;
    }

    if (turn.role?.toLowerCase() === "agent" && /happy hour|specials?|days? and times?/i.test(message)) {
      if (collected.length > 0) {
        sequences.push(collected.join(". ").trim());
        collected = [];
      }

      capturing = true;
      continue;
    }

    if (!capturing) {
      continue;
    }

    if (turn.role?.toLowerCase() === "user") {
      collected.push(message);
      continue;
    }

    if (
      collected.length > 0 &&
      (isClarificationTurn(turn) || isNonSubstantiveAgentTurn(turn) || isClosingAgentTurn(turn))
    ) {
      continue;
    }

    if (collected.length > 0 && turn.role?.toLowerCase() === "agent") {
      sequences.push(collected.join(". ").trim());
      collected = [];
      capturing = false;
    }
  }

  if (collected.length > 0) {
    sequences.push(collected.join(". ").trim());
  }

  return sequences.join(". ").trim();
}

export function parseBeerPrices(
  transcriptText: string,
  options: ParseBeerOptions = {},
): ParsedBeerPrice[] {
  const segments = splitIntoSegments(transcriptText);
  const targetBeers = options.targetBeers ?? TARGET_BEERS;

  return targetBeers.map((beer) => {
    const segmentCandidate =
      segments
      .map((segment) => buildBeerCandidate(segment, beer.name, beer.aliases))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort((left, right) => right.confidence - left.confidence)[0] ?? null;
    const assumedContextCandidate = options.assumeBeerContext
      ? buildAssumedContextCandidate(transcriptText, beer.name)
      : null;
    const bestCandidate =
      [segmentCandidate, assumedContextCandidate]
        .filter((candidate): candidate is Candidate => candidate !== null)
        .sort((left, right) => right.confidence - left.confidence)[0] ?? null;

    if (!bestCandidate) {
      return buildMissingBeerResult(beer.name);
    }

    const needsReview =
      (!bestCandidate.isUnavailable && bestCandidate.priceNumeric === null) || bestCandidate.confidence < 0.72;
    const availability = inferBeerAvailability({
      evidence: bestCandidate.evidence,
      priceNumeric: bestCandidate.priceNumeric,
      isUnavailable: bestCandidate.isUnavailable,
    });

    return {
      beerName: bestCandidate.beerName,
      priceText: bestCandidate.priceText,
      priceNumeric: bestCandidate.priceNumeric,
      confidence: bestCandidate.confidence,
      needsReview,
      evidence: bestCandidate.evidence,
      isUnavailable: bestCandidate.isUnavailable,
      availabilityStatus: availability.availabilityStatus,
      availableOnTap: availability.availableOnTap,
      availablePackageOnly: availability.availablePackageOnly,
      unavailableReason: availability.unavailableReason,
    };
  });
}

export function parseHappyHourInfo(
  transcriptText: string,
  options: ParseHappyHourOptions = {},
): ParsedHappyHour {
  const normalised = normaliseTranscript(transcriptText);

  if (!normalised) {
    return buildNoHappyHourResult(0.08, null);
  }

  const candidateText = buildHappyHourCandidateText(normalised, options.assumeHappyHourContext ?? false);

  if (!candidateText) {
    return buildNoHappyHourResult(0.12, null);
  }

  const isNegative = HAPPY_HOUR_NEGATIVE_REGEX.test(candidateText);
  const dayMatch = extractDayMatch(candidateText);
  const timeRange = extractTimeRange(candidateText, {
    preferPm: true,
  });
  const keywordIndex = findHappyHourKeywordIndex(candidateText);
  const primaryAnchor =
    keywordIndex ??
    dayMatch?.index ??
    timeRange?.index ??
    (options.assumeHappyHourContext ? 0 : null) ??
    0;
  const happyHourPrice = extractHappyHourPrice(candidateText, primaryAnchor, timeRange);
  const happyHourSpecials = extractHappyHourSpecials(candidateText, dayMatch, timeRange);
  const hasPositiveSignals =
    Boolean(options.assumeHappyHourContext) ||
    HAPPY_HOUR_KEYWORD_REGEX.test(candidateText) ||
    dayMatch !== null ||
    timeRange !== null ||
    happyHourPrice !== null ||
    happyHourSpecials !== null;

  if (isNegative && !dayMatch && !timeRange && !happyHourPrice) {
    return buildNoHappyHourResult(0.93, candidateText);
  }

  if (!hasPositiveSignals) {
    return buildNoHappyHourResult(0.18, null);
  }

  let confidence = 0.26;

  if (options.assumeHappyHourContext) {
    confidence += 0.18;
  }

  if (HAPPY_HOUR_KEYWORD_REGEX.test(candidateText)) {
    confidence += 0.14;
  }

  if (dayMatch) {
    confidence += 0.12;
  }

  if (timeRange) {
    confidence += 0.18;
  }

  if (happyHourPrice) {
    confidence += 0.18;
  }

  if (happyHourSpecials) {
    confidence += 0.12;
  }

  if (UNCERTAINTY_REGEX.test(candidateText)) {
    confidence -= 0.16;
  }

  if (isNegative) {
    confidence -= 0.22;
  }

  confidence = clamp(confidence);

  return {
    happyHour: true,
    happyHourDays: dayMatch?.value ?? null,
    happyHourStart: timeRange?.start ?? null,
    happyHourEnd: timeRange?.end ?? null,
    happyHourPrice: happyHourPrice?.value ?? null,
    happyHourSpecials,
    confidence,
    needsReview: confidence < 0.72 || timeRange === null || happyHourSpecials === null,
    evidence: candidateText,
  };
}

export function summariseParseOutcome(
  beerPrices: ParsedBeerPrice[],
  happyHour: ParsedHappyHour | null,
  confidenceThreshold: number,
): ParseOutcomeSummary {
  const confidenceValues = happyHour
    ? [...beerPrices.map((item) => item.confidence), happyHour.confidence]
    : beerPrices.map((item) => item.confidence);
  const parseConfidence = clamp(
    confidenceValues.reduce((sum, value) => sum + value, 0) / Math.max(confidenceValues.length, 1),
    0,
    1,
  );
  const missingBeerCount = beerPrices.filter((item) => item.priceNumeric === null && !item.isUnavailable).length;
  const unavailableBeerCount = beerPrices.filter((item) => item.isUnavailable).length;
  const hasNoUsefulData =
    missingBeerCount + unavailableBeerCount === beerPrices.length &&
    unavailableBeerCount === 0 &&
    (!happyHour ||
      (!happyHour.evidence &&
        happyHour.happyHourPrice === null &&
        !happyHour.happyHour));
  const happyHourPartial =
    happyHour
      ? (happyHour.happyHour &&
          (happyHour.happyHourStart === null ||
            happyHour.happyHourEnd === null)) ||
        (!happyHour.happyHour && happyHour.confidence < confidenceThreshold)
      : false;

  if (hasNoUsefulData) {
    return {
      parseConfidence,
      parseStatus: "failed",
      needsReview: true,
    };
  }

  if (missingBeerCount > 0 || happyHourPartial) {
    return {
      parseConfidence,
      parseStatus: "partial",
      needsReview: true,
    };
  }

  if (
    parseConfidence < confidenceThreshold ||
    beerPrices.some((item) => item.needsReview) ||
    happyHour?.needsReview
  ) {
    return {
      parseConfidence,
      parseStatus: "needs_review",
      needsReview: true,
    };
  }

  return {
    parseConfidence,
    parseStatus: "parsed",
    needsReview: false,
  };
}
