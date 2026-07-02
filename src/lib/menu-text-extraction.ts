import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName } from "../constants/beers.js";

export type MenuTextAvailabilityStatus = "on_tap" | "package_only" | "unavailable" | "unknown";

export interface ExtractedMenuBeerRow {
  name: string;
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: MenuTextAvailabilityStatus;
  notes: string | null;
  confidence: number | null;
}

interface SectionMarker {
  index: number;
  label: string;
  availabilityStatus: MenuTextAvailabilityStatus;
}

const MENU_ROW_PATTERN =
  /([A-Z][A-Za-z0-9'&.,\- ]{2,100}?(?:\(\s*\d+(?:\.\d+)?%\s*\))?)\s*(?:\.{3,}|_{3,}|-{3,})\s*((?:\$?\d{1,2}(?:\.\d{1,2})?\s*(?:\/\s*)?){1,4})(?:\s*\(([^)]{1,30})\))?/g;

const SECTION_PATTERNS: Array<{ label: string; availabilityStatus: MenuTextAvailabilityStatus; pattern: RegExp }> = [
  { label: "ON TAP", availabilityStatus: "on_tap", pattern: /\b(?:ON\s+TAP|TAP\s+BEERS?|BEERS?\s+ON\s+TAP|DRAUGHT|DRAFT)\b/gi },
  { label: "CANS OR BOTTLES", availabilityStatus: "package_only", pattern: /\b(?:BOTTLES?\s*(?:&|AND)\s*(?:CANS?|TINS?)|CANS?\s*(?:&|AND)\s*BOTTLES?|TINS?\s*(?:&|AND)\s*BOTTLES?|PACKAGED\s+(?:BEER|DRINKS?)|TINNIES?)\b/gi },
];

const HEADING_PREFIX_PATTERN =
  /^(?:(?:drink|drinks|beer|beers|on\s+tap|tap\s+beers?|beers?\s+on\s+tap|pots?|pints?|jugs?|bottles?\s*(?:&|and)\s*(?:cans?|tins?)|cans?\s*(?:&|and)\s*bottles?|tins?\s*(?:&|and)\s*bottles?|tinnies?|packaged|sparkling\s*&\s*rose|white|red|glass|bottle|can|tin)\b[\s/:,-]*)+/i;

const BEERISH_NAME_PATTERN =
  /\b(beer|lager|ale|ipa|xpa|stout|porter|pilsner|draught|draft|bitter|cider|sour|ginger\s+beer|whisky|dry|lemon|hard\s+rated|rtd|guinness|asahi|balter|carlton|northern|goat|bulmers|lions?|corona|peroni|heineken|sapporo|kilkenny|obrien'?s|heaps\s+normal|pabst)\b/i;

const TAP_SECTION_LINE_PATTERN = /^(?:on\s+tap|tap\s+beers?|beers?\s+on\s+tap|draught|draft)$/i;
const PACKAGE_SECTION_LINE_PATTERN =
  /^(?:tins?\s*(?:&|and)\s*bottles?|bottles?\s*(?:&|and)\s*(?:cans?|tins?)|cans?\s*(?:&|and)\s*bottles?|cans?|bottles?|tinnies?|packaged(?:\s+(?:beer|drinks?))?)$/i;
const NON_BEER_SECTION_LINE_PATTERN =
  /^(?:red(?:\s+wine)?|white(?:\s+wine)?|sparkling(?:\s*&\s*|\s+and\s+)ros[eé]|ros[eé]|cocktails?|spirits?|food|snacks?|kitchen|desserts?)$/i;
const SIMPLE_MENU_PRICE_PATTERN =
  /(?:\$?\d{1,2}(?:\.\d{1,2})?(?:\s*\/\s*\$?\d{1,2}(?:\.\d{1,2})?){0,3}|\/\s*\$?\d{1,2}(?:\.\d{1,2})?)(?![\d.]|\s*%)/g;

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRACKED_ALIASES = VIEWER_TRACKED_BEERS.flatMap((beer) =>
  [beer.name, ...beer.aliases].map((alias) => ({
    canonical: beer.name,
    normalizedAlias: normalizeLooseText(alias),
  })),
)
  .filter((item) => item.normalizedAlias.length >= 3)
  .sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length);

function findTrackedBeerInRowName(value: string): string | null {
  const normalized = normalizeLooseText(value);
  if (!normalized) {
    return null;
  }

  const exact = canonicalizeTrackedBeerName(value);
  if (normalizeLooseText(exact) !== normalized || VIEWER_TRACKED_BEERS.some((beer) => normalizeLooseText(beer.name) === normalized)) {
    return exact;
  }

  const compact = normalized.replace(/\s+/g, "");
  for (const item of TRACKED_ALIASES) {
    const aliasTokens = item.normalizedAlias.split(/\s+/).filter(Boolean);
    const aliasPattern = new RegExp(`(?:^|\\s)${escapeRegExp(item.normalizedAlias)}(?:\\s|$)`);
    if (aliasPattern.test(normalized)) {
      if (aliasTokens.length > 1 || normalized === item.normalizedAlias) {
        return item.canonical;
      }
    }

    const compactAlias = item.normalizedAlias.replace(/\s+/g, "");
    if (compactAlias.length >= 10 && compact.includes(compactAlias)) {
      return item.canonical;
    }
  }

  return null;
}

function normalizeMenuText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[•·]/g, "\n")
    .replace(/[–—]/g, "-")
    .replace(/\s+\|\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMenuLines(value: string): string[] {
  const normalized = value
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[•·]/g, "\n")
    .replace(/[–—]/g, "-")
    .replace(/\s+\|\s+/g, "\n");

  return normalized
    .split(/\n|(?<=\d)\s{2,}(?=[A-Z])|(?<=[.!?])\s+(?=[A-Z])/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function detectSections(text: string): SectionMarker[] {
  const sections: SectionMarker[] = [];
  for (const sectionPattern of SECTION_PATTERNS) {
    sectionPattern.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sectionPattern.pattern.exec(text))) {
      sections.push({
        index: match.index,
        label: sectionPattern.label,
        availabilityStatus: sectionPattern.availabilityStatus,
      });
    }
  }
  return sections.sort((a, b) => a.index - b.index);
}

function sectionForIndex(sections: SectionMarker[], index: number): SectionMarker | null {
  let current: SectionMarker | null = null;
  for (const section of sections) {
    if (section.index > index) {
      break;
    }
    current = section;
  }
  return current;
}

function sectionForMenuLine(line: string): SectionMarker | "reset" | null {
  const cleaned = line
    .replace(/[^\w\s&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return null;
  }
  if (TAP_SECTION_LINE_PATTERN.test(cleaned)) {
    return { index: 0, label: "ON TAP", availabilityStatus: "on_tap" };
  }
  if (PACKAGE_SECTION_LINE_PATTERN.test(cleaned)) {
    return { index: 0, label: "CANS OR BOTTLES", availabilityStatus: "package_only" };
  }
  if (NON_BEER_SECTION_LINE_PATTERN.test(cleaned)) {
    return "reset";
  }
  return null;
}

function cleanMenuRowName(value: string): string {
  let cleaned = value
    .replace(HEADING_PREFIX_PATTERN, "")
    .replace(/\(\s*\d+(?:\.\d+)?%\s*\)/g, "")
    .replace(/\b(?:pots?|pints?|jugs?)\s*(?:\/|\b)/gi, " ")
    .replace(/\b(?:glass|bottle)\s*(?:\/|\b)/gi, " ")
    .replace(/^[\s:;,.\/-]+|[\s:;,.\/-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const trailingHeading = cleaned.match(
    /\b(?:ON\s+TAP|BOTTLES?\s*(?:&|AND)\s*(?:CANS?|TINS?)|CANS?\s*(?:&|AND)\s*BOTTLES?|TINS?\s*(?:&|AND)\s*BOTTLES?)\s+(.+)$/i,
  );
  if (trailingHeading?.[1]) {
    cleaned = trailingHeading[1].trim();
  }

  return cleaned;
}

function formatCurrencyPrice(value: number): string {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function parsePriceNumbers(value: string): number[] {
  return Array.from(value.matchAll(/\d{1,3}(?:\.\d{1,2})?/g))
    .map((match) => Number(match[0]))
    .filter((price) => Number.isFinite(price) && price > 0 && price <= 80);
}

function inferAvailabilityStatus(input: {
  sourceRow: string;
  section: SectionMarker | null;
  priceCount: number;
  hasPotsPintsJugsHint: boolean;
}): MenuTextAvailabilityStatus {
  if (input.section?.availabilityStatus === "on_tap") {
    return "on_tap";
  }
  if (input.hasPotsPintsJugsHint || input.priceCount >= 3) {
    return "on_tap";
  }
  if (input.section?.availabilityStatus === "package_only") {
    return "package_only";
  }
  if (/\b(tap|draught|draft|pint|schooner|pot|jug|500\s?ml|425\s?ml|400\s?ml|285\s?ml)\b/i.test(input.sourceRow)) {
    return "on_tap";
  }
  if (/\b(can|cans|bottle|bottles|tin|tins|tinnie|tinnies|bucket|pack|takeaway)\b/i.test(input.sourceRow)) {
    return "package_only";
  }
  return "unknown";
}

function selectDisplayPrice(input: {
  prices: number[];
  availabilityStatus: MenuTextAvailabilityStatus;
  hasPotsPintsJugsHint: boolean;
}): number | null {
  if (input.prices.length === 0) {
    return null;
  }
  if (input.availabilityStatus === "on_tap" || input.hasPotsPintsJugsHint) {
    if (input.prices.length >= 3) {
      return input.prices[1] ?? null;
    }
    return input.prices[input.prices.length - 1] ?? null;
  }
  return input.prices[0] ?? null;
}

function sourceRowPreview(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= 180 ? cleaned : `${cleaned.slice(0, 177)}...`;
}

function hasPotsPintsJugsHint(text: string, index: number, priceCount: number): boolean {
  if (priceCount >= 3) {
    return true;
  }
  const nearby = text.slice(Math.max(0, index - 260), Math.min(text.length, index + 80));
  return /\bPots?\s*\/\s*Pints?\s*\/\s*Jugs?\b/i.test(nearby);
}

function simpleMenuPriceMatch(line: string): { index: number; priceText: string; prices: number[] } | null {
  SIMPLE_MENU_PRICE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SIMPLE_MENU_PRICE_PATTERN.exec(line))) {
    const rawPriceText = match[0] ?? "";
    const prices = parsePriceNumbers(rawPriceText);
    if (prices.length === 0) {
      continue;
    }

    const before = line.slice(0, match.index).trim();
    if (!before || before.length > 90 || !/[A-Za-z]/.test(before)) {
      continue;
    }

    const context = line.slice(Math.max(0, match.index - 20), Math.min(line.length, match.index + rawPriceText.length + 20));
    if (/%/.test(rawPriceText) || /\b(?:19|20)\d{2}\b/.test(context)) {
      continue;
    }

    return {
      index: match.index,
      priceText: rawPriceText,
      prices,
    };
  }

  return null;
}

function rowKey(row: Pick<ExtractedMenuBeerRow, "name" | "priceNumeric" | "availabilityStatus">): string {
  return `${normalizeLooseText(row.name)}|${row.priceNumeric ?? ""}|${row.availabilityStatus}`;
}

export function extractStructuredBeerRowsFromText(text: string): ExtractedMenuBeerRow[] {
  const normalizedText = normalizeMenuText(text);
  if (!normalizedText) {
    return [];
  }

  const sections = detectSections(normalizedText);
  const rows: ExtractedMenuBeerRow[] = [];
  const seen = new Set<string>();
  MENU_ROW_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENU_ROW_PATTERN.exec(normalizedText))) {
    const rawName = match[1] ?? "";
    const priceText = match[2] ?? "";
    const servingText = match[3] ?? "";
    const cleanedName = cleanMenuRowName(rawName);
    if (!cleanedName || cleanedName.length < 3 || cleanedName.length > 80) {
      continue;
    }

    const trackedName = findTrackedBeerInRowName(cleanedName);
    if (!trackedName && !BEERISH_NAME_PATTERN.test(cleanedName)) {
      continue;
    }

    const prices = parsePriceNumbers(priceText);
    const hint = hasPotsPintsJugsHint(normalizedText, match.index, prices.length);
    const section = sectionForIndex(sections, match.index);
    const sourceRow = sourceRowPreview(match[0] ?? "");
    const availabilityStatus = inferAvailabilityStatus({
      sourceRow: `${sourceRow} ${servingText}`,
      section,
      priceCount: prices.length,
      hasPotsPintsJugsHint: hint,
    });
    const selectedPrice = selectDisplayPrice({
      prices,
      availabilityStatus,
      hasPotsPintsJugsHint: hint,
    });
    if (selectedPrice == null) {
      continue;
    }

    const row: ExtractedMenuBeerRow = {
      name: trackedName ?? canonicalizeTrackedBeerName(cleanedName),
      priceNumeric: selectedPrice,
      priceText: formatCurrencyPrice(selectedPrice),
      availabilityStatus,
      notes: [
        section ? `Section: ${section.label}` : null,
        hint && prices.length >= 3 ? "Selected pint price from pots/pints/jugs." : null,
        servingText ? `Serving hint: ${servingText}` : null,
        `Source row: ${sourceRow}`,
      ]
        .filter(Boolean)
        .join(" | "),
      confidence: trackedName ? 0.88 : 0.68,
    };
    const key = rowKey(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  let currentSection: SectionMarker | null = null;
  for (const line of normalizeMenuLines(text)) {
    const lineSection = sectionForMenuLine(line);
    if (lineSection === "reset") {
      currentSection = null;
      continue;
    }
    if (lineSection) {
      currentSection = lineSection;
      continue;
    }

    const priceMatch = simpleMenuPriceMatch(line);
    if (!priceMatch) {
      continue;
    }

    const rawName = line.slice(0, priceMatch.index);
    const cleanedName = cleanMenuRowName(rawName);
    if (!cleanedName || cleanedName.length < 3 || cleanedName.length > 80) {
      continue;
    }

    const trackedName = findTrackedBeerInRowName(cleanedName);
    if (!trackedName && !BEERISH_NAME_PATTERN.test(cleanedName)) {
      continue;
    }

    const availabilityStatus = inferAvailabilityStatus({
      sourceRow: line,
      section: currentSection,
      priceCount: priceMatch.prices.length,
      hasPotsPintsJugsHint: false,
    });
    const selectedPrice = selectDisplayPrice({
      prices: priceMatch.prices,
      availabilityStatus,
      hasPotsPintsJugsHint: false,
    });
    if (selectedPrice == null) {
      continue;
    }

    const row: ExtractedMenuBeerRow = {
      name: trackedName ?? canonicalizeTrackedBeerName(cleanedName),
      priceNumeric: selectedPrice,
      priceText: formatCurrencyPrice(selectedPrice),
      availabilityStatus,
      notes: [
        currentSection ? `Section: ${currentSection.label}` : null,
        priceMatch.prices.length > 1 && availabilityStatus === "on_tap" ? "Selected largest tap pour price from slash-separated row." : null,
        `Source row: ${sourceRowPreview(line)}`,
      ]
        .filter(Boolean)
        .join(" | "),
      confidence: trackedName ? 0.82 : 0.6,
    };
    const key = rowKey(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  return rows;
}
