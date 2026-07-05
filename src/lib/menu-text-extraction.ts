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

type PourPriceLabel = "pot" | "schooner" | "pint" | "jug";

const MENU_ROW_PATTERN =
  /([A-Z][A-Za-z0-9'&.,\- ]{2,100}?(?:\(\s*\d+(?:\.\d+)?%\s*\))?)\s*(?:\.{3,}|_{3,}|-{3,})\s*((?:\$?\d{1,2}(?:\.\d{1,2})?\s*(?:\/\s*)?){1,4})(?:\s*\(([^)]{1,30})\))?/g;

const SECTION_PATTERNS: Array<{ label: string; availabilityStatus: MenuTextAvailabilityStatus; pattern: RegExp }> = [
  { label: "ON TAP", availabilityStatus: "on_tap", pattern: /\b(?:ON\s+TAP|TAP|TAP\s+BEERS?|BEERS?\s+ON\s+TAP|DRAUGHT|DRAFT)\b/gi },
  { label: "CANS OR BOTTLES", availabilityStatus: "package_only", pattern: /\b(?:BOTTLES?\s*(?:&|AND|OR)\s*(?:CANS?|TINS?)|CANS?\s*(?:&|AND|OR)\s*BOTTLES?|TINS?\s*(?:&|AND|OR)\s*BOTTLES?|TINS?|PACKAGED\s+(?:BEER|DRINKS?)|TINNIES?)\b/gi },
];

const HEADING_PREFIX_PATTERN =
  /^(?:(?:drink|drinks|beer|beers|on\s+tap|tap\s+beers?|beers?\s+on\s+tap|pots?|pints?|jugs?|bottles?\s*(?:&|and)\s*(?:cans?|tins?)|cans?\s*(?:&|and)\s*bottles?|tins?\s*(?:&|and)\s*bottles?|tinnies?|packaged|sparkling\s*&\s*rose|white(?!\s+(?:bay|rabbit)\b)|red|glass|bottle|can|tin)\b[\s/:,-]*)+/i;

const BEERISH_NAME_PATTERN =
  /\b(beer|lager|ale|ipa|xpa|stout|porter|pilsner|draught|draft|bitter|cider|sour|ginger\s+beer|hard\s+rated|rtd|guinness|asahi|balter|carlton|great\s+northern|mountain\s+goat|bulmers|lions?|corona|peroni|heineken|sapporo|kilkenny|kirin|furphy|napoleone|little\s+creatures|obrien'?s|heaps\s+normal|pabst)\b/i;
const NON_BEER_DRINK_NAME_PATTERN =
  /\b(?:wine|cocktails?|spritz|margarita|negroni|amaretto|mini\s+beer|baby\s+guinness|gin|vodka|rum|tequila|mezcal|vermouth|amaro|aperitif|liqueur|whisk(?:e)?y|bourbon|scotch|rye|brandy|cognac|sambuca|ouzo|pisco|campari|aperol|tanqueray|poor\s+tom'?s|archie\s+rose|aviation|four\s+pillars|mgc|hellyer'?s|noilly\s+prat|marionette|bulleit|bitter\s+orange|dry\s+cassis|single\s+shot)\b/i;
const FOOD_OR_EVENT_NOISE_PATTERN =
  /\b(?:beer[-\s]?battered|sour\s+cream|sweet\s+chilli|red\s+wine\s+vinegar|red\s+wine\s+jus|white\s+wine\s+jus|wedges?|chips?|fries|salad|fish|prawns?|oysters?|calamari|seafood|steak|t[-\s]?bone|rib[-\s]?eye|porterhouse|sirloin|scotch\s+fillet|eye\s+fillet|tenderloin|wagyu|angus|beef|chicken|pork|lamb|brisket|ribs?|cutlets?|roast|charcuterie|platter|grazing|cheese|tart|msa\s*\d?\s*grade|\d+\s*day\s+aged|dry[-\s]?aged|grass[-\s]?fed|grain[-\s]?fed|burger|burgers?|parmas?|parma|parmigiana|schnitzel|sandwich|toastie|share\s+plates?|pub\s+meal|dessert|festival|tickets?|tix|birthday|olympics?|carols|wrestling|run|km|food\s+and\s+beverage\s+stalls?|bottomless|course\s+meal|vegetarian|vegan|fine\s+sugar|fresh\s+ginger|honey\s+with\s+ginger)\b/i;
const ARTICLE_OR_JSON_NOISE_PATTERN =
  /\b(?:description|urlslug|structured_data|utm_|blogs?\/|\/news\/|\/articles?\/|cdn\/shop|width=|join\s+us|hosting|celebrate|soak\s+up|grab\s+a\s+free|served\s+with|glass\s+of\s+house\s+wine|house\s+wine|soft\s+drink|official\s+beer\s+(?:and\s+cider\s+)?partner|bookings?|reservations?|guests?|time\s+slots?|security|confiscated|litres?\s+of\s+beer|beer\s+mugs?|million\s+litres?|guided\s+tour|terminal\s+\d|first\s+working\s+brewery|fourth\s+in\s+the\s+world)\b/i;
const MARKETING_COPY_NOISE_PATTERN =
  /\b(?:we\s+believe|we\s+pride\s+ourselves|our\s+(?:range|beer|beers|tap|taps)|your\s+fave|should\s+be\s+for\s+everyone|something\s+for\s+everyone|wide\s+range|suit\s+all\s+tastes|laid[-\s]?back|easy\s+drinkers?|more\s+adventurous|welcoming\s+community\s+hub|become\s+the\s+welcoming|take\s+online\s+reservations)\b/i;

const TAP_SECTION_LINE_PATTERN = /^(?:on\s+tap|tap|tap\s+beers?|beers?\s+on\s+tap|draught|draft)$/i;
const TAP_SECTION_PREFIX_PATTERN = /^(?:on\s+tap|tap|tap\s+beers?|beers?\s+on\s+tap|draught|draft)\b/i;
const PACKAGE_SECTION_LINE_PATTERN =
  /^(?:tins?\s*(?:&|and|or)\s*bottles?|bottles?\s*(?:&|and|or)\s*(?:cans?|tins?)|cans?\s*(?:&|and|or)\s*bottles?|cans?|bottles?|tins?|tinnies?|packaged(?:\s+(?:beer|drinks?))?)$/i;
const PACKAGE_SECTION_PREFIX_PATTERN =
  /^(?:tins?\s*(?:&|and|or)\s*bottles?|bottles?\s*(?:&|and|or)\s*(?:cans?|tins?)|cans?\s*(?:&|and|or)\s*bottles?|tins?|tinnies?|packaged(?:\s+(?:beer|drinks?))?)\b/i;
const NON_BEER_SECTION_LINE_PATTERN =
  /^(?:red(?:\s+wine)?|white(?:\s+wine)?|sparkling(?:\s*&\s*|\s+and\s+)ros[eé]|ros[eé]|cocktails?|spirits?|food|snacks?|kitchen|desserts?)$/i;
const PRICE_TOKEN_PATTERN_SOURCE = String.raw`(?:A\$|AUD\s*|\$)?\s*\d{1,2}(?:\.\d{1,2})?`;
const SIMPLE_MENU_PRICE_PATTERN =
  new RegExp(`(?:${PRICE_TOKEN_PATTERN_SOURCE}(?:\\s*\\/\\s*${PRICE_TOKEN_PATTERN_SOURCE}){0,3}|\\/\\s*${PRICE_TOKEN_PATTERN_SOURCE})(?![\\d.]|\\s*%)`, "g");
const ABV_PATTERN = /\b(?:ABV\s*)?(<\s*)?\d{1,2}(?:\.\d+)?\s*%/i;
const DETAIL_LINE_PATTERN =
  /\b(?:brewing|brewery|brewers?|beer|co|company|stone\s*&\s*wood|mountain\s+culture|bonehead|guinness|asahi|pabst|heaps\s+normal|two\s+bays|bad\s+shepherd|venom|brick\s+lane|hargraves?|hargreaves?)\b/i;

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

const COLLAPSED_ROW_START_STOPWORDS = new Set([
  "ale",
  "beer",
  "bitter",
  "cider",
  "draft",
  "draught",
  "ginger beer",
  "ipa",
  "jug",
  "jugs",
  "lager",
  "pale ale",
  "pint",
  "pints",
  "pilsner",
  "pot",
  "pots",
  "schooner",
  "schooners",
  "stout",
  "xpa",
]);
const COLLAPSED_ROW_START_TERMS = Array.from(
  new Set(
    VIEWER_TRACKED_BEERS.flatMap((beer) => [beer.name, beer.brewery, ...beer.aliases])
      .map((term) => term?.replace(/\s+/g, " ").trim())
      .filter((term): term is string => Boolean(term))
      .filter((term) => term.length >= 4 && !COLLAPSED_ROW_START_STOPWORDS.has(term.toLowerCase())),
  ),
).sort((left, right) => right.length - left.length);
const COLLAPSED_ROW_START_SOURCE = COLLAPSED_ROW_START_TERMS.map(escapeRegExp).join("|");
const COLLAPSED_ROW_AFTER_TAP_PRICE_PATTERN = new RegExp(
  `(\\b(?:PINT|PINTS|SCHOONER|SCHOONERS|POT|POTS|JUG|JUGS)\\b\\s+[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+){0,1})\\s+(?=${COLLAPSED_ROW_START_SOURCE}\\b)`,
  "g",
);
const COLLAPSED_ROW_AFTER_PACKAGE_PRICE_PATTERN = new RegExp(
  `(\\$\\d{1,2}(?:\\.\\d{1,2})?\\s+[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+){0,1})\\s+(?=${COLLAPSED_ROW_START_SOURCE}\\b)`,
  "g",
);
const COLLAPSED_PACKAGE_HEADING_PATTERN = new RegExp(
  `\\s+\\b(CAN|CANS|BOTTLE|BOTTLES|TIN|TINS|TINNIES|PACKAGED)\\s+(?=[A-Z0-9][A-Za-z0-9'&., -]{2,90}\\s+(?:\\d{1,2}(?:\\.\\d+)?%\\s+)?\\$?\\d)`,
  "gi",
);

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
  return splitCollapsedMenuRowsForExtraction(value)
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

export function splitCollapsedMenuRowsForExtraction(value: string): string {
  return value
    .replace(
      /\b(ON\s+TAP|TAP\s+BEERS?|BEERS?\s+ON\s+TAP|CANS?\s+OR\s+BOTTLES?|BOTTLES?\s*(?:&|AND|OR)\s*(?:CANS?|TINS?)|CANS?\s*(?:&|AND|OR)\s*BOTTLES?|TINS?\s*(?:&|AND|OR)\s*BOTTLES?|TINNIES?|PACKAGED)\s+(?=[A-Z0-9])/gi,
      "$1\n",
    )
    .replace(COLLAPSED_PACKAGE_HEADING_PATTERN, "\n$1\n")
    .replace(COLLAPSED_ROW_AFTER_TAP_PRICE_PATTERN, "$1\n")
    .replace(COLLAPSED_ROW_AFTER_PACKAGE_PRICE_PATTERN, "$1\n");
}

function normalizeMenuLines(value: string): string[] {
  const normalized = splitCollapsedMenuRowsForExtraction(value)
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
  if (TAP_SECTION_LINE_PATTERN.test(cleaned) || TAP_SECTION_PREFIX_PATTERN.test(cleaned)) {
    return { index: 0, label: "ON TAP", availabilityStatus: "on_tap" };
  }
  if (PACKAGE_SECTION_LINE_PATTERN.test(cleaned) || PACKAGE_SECTION_PREFIX_PATTERN.test(cleaned)) {
    return { index: 0, label: "CANS OR BOTTLES", availabilityStatus: "package_only" };
  }
  if (NON_BEER_SECTION_LINE_PATTERN.test(cleaned)) {
    return "reset";
  }
  return null;
}

function isBeerDetailLine(line: string): boolean {
  if (!line || simpleMenuPriceMatch(line)) {
    return false;
  }
  return ABV_PATTERN.test(line) || (DETAIL_LINE_PATTERN.test(line) && /\s+-\s+/.test(line));
}

function detailLineAfter(lines: string[], index: number): string | null {
  for (let offset = 1; offset <= 2; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate) {
      return null;
    }
    if (sectionForMenuLine(candidate)) {
      return null;
    }
    if (simpleMenuPriceMatch(candidate)) {
      return null;
    }
    if (isBeerDetailLine(candidate)) {
      return sourceRowPreview(candidate);
    }
    if (!/^(?:ask\s+staff|rotating|specials?|lager|ipa|dark\s+beer|sour\s+beer|ginger\s+beer|seltzers?|ciders?)\b/i.test(candidate)) {
      return null;
    }
  }
  return null;
}

function abvNoteFromText(value: string | null): string | null {
  const match = value?.match(ABV_PATTERN);
  if (!match?.[0]) {
    return null;
  }
  return `ABV: ${match[0].replace(/^ABV\s*/i, "").replace(/\s+/g, "")}`;
}

function cleanMenuRowName(value: string): string {
  let cleaned = value
    .replace(HEADING_PREFIX_PATTERN, "")
    .replace(/\(\s*\d+(?:\.\d+)?%\s*\)/g, "")
    .replace(/\b(?:ABV\s*)?(?:<\s*)?\d{1,2}(?:\.\d+)?\s*%.*$/i, "")
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

function isLikelyNonBeerDrinkName(name: string, sourceRow: string): boolean {
  const text = `${name} ${sourceRow}`;
  if (!NON_BEER_DRINK_NAME_PATTERN.test(text)) {
    return false;
  }

  return !/\b(?:beer|lager|ale|ipa|xpa|stout|porter|pilsner|cider|ginger\s+beer|hard\s+rated|rtd)\b/i.test(name);
}

function isReadableMenuRowText(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 3) {
    return false;
  }

  const strangeChars = compact.match(/[^\x20-\x7e\u00a0-\u024f]/g)?.length ?? 0;
  if (strangeChars >= 3 && strangeChars / compact.length > 0.08) {
    return false;
  }

  const letters = compact.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 3;
}

function isLikelyMenuNoiseName(name: string, sourceRow: string): boolean {
  const text = `${name} ${sourceRow}`;
  if (!isReadableMenuRowText(text)) {
    return true;
  }
  if (
    FOOD_OR_EVENT_NOISE_PATTERN.test(text) ||
    ARTICLE_OR_JSON_NOISE_PATTERN.test(text) ||
    MARKETING_COPY_NOISE_PATTERN.test(text)
  ) {
    return true;
  }
  if (!/\$/.test(text) && /\b\d{1,3}\s*taps?\b/i.test(text)) {
    return true;
  }
  if (!/\$/.test(text) && name.split(/\s+/).length >= 8 && /[,.;:]|\b(?:we|our|your|everyone|range|tastes?|drinkers?|adventurous|welcoming)\b/i.test(name)) {
    return true;
  }
  if (/^(?:https?:)?\/\//i.test(name) || /^\//.test(name) || /\b(?:cdn\/shop|\.com\/|\.com\.au\/|width=|[?&]v=)/i.test(name)) {
    return true;
  }
  if (/^\(/.test(name) || /\b\d{3,4}\s*ml\b/i.test(name) || (/\b\d{2,4}\s*ml\b/i.test(text) && /\b\d{1,4}\s*g\b/i.test(text))) {
    return true;
  }
  if (/^\s*(?:cocktails?|red\s+wine|white\s+wine|sparkling\s+wine|ros[eé]|spirits?)\b/i.test(name)) {
    return true;
  }
  if (/^\s*(?:mini\s+beer|baby\s+guinness|amaretto\s+sour)\s*$/i.test(name)) {
    return true;
  }
  if (/^\s*(?:apple\s+cider|hazy\s+apple\s+cider|lemon)\s*$/i.test(name)) {
    return true;
  }
  return false;
}

function formatCurrencyPrice(value: number): string {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function parsePriceNumbers(value: string): number[] {
  return Array.from(value.matchAll(/\d{1,3}(?:\.\d{1,2})?/g))
    .map((match) => Number(match[0]))
    .filter((price) => Number.isFinite(price) && price > 0 && price <= 80);
}

function isEmbeddedInMeasurementToken(line: string, start: number, end: number): boolean {
  const before = line.slice(Math.max(0, start - 1), start);
  const after = line.slice(end, Math.min(line.length, end + 6));
  if (/\d/.test(before)) {
    return true;
  }
  return /^\s*(?:ml|l\b|oz|cl|g\b|kg\b|%|days?\b|years?\b|yrs?\b|packs?\b|grade\b|tap(?:s|\s+bar|\s+beers?)?\b)/i.test(after);
}

function decodeMenuHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&middot;/g, " ")
    .replace(/&bull;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripMenuHtml(value: string): string {
  return decodeMenuHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstClassText(html: string, className: string): string | null {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i");
  const value = stripMenuHtml(html.match(pattern)?.[1] ?? "");
  return value || null;
}

function extractClassTexts(html: string, className: string): string[] {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const value = stripMenuHtml(match[1] ?? "");
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function extractOnTapCardPricePairs(html: string): Array<{ size: string; price: number; priceText: string }> {
  const pairs: Array<{ size: string; price: number; priceText: string }> = [];
  const pattern =
    /class=["'][^"']*sp-on-tap-price-size[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>\s*<[^>]+class=["'][^"']*sp-on-tap-style[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const size = stripMenuHtml(match[1] ?? "").replace(/[:\s]+$/g, "");
    const rawPriceText = stripMenuHtml(match[2] ?? "");
    const price = parsePriceNumbers(rawPriceText)[0];
    if (!size || price == null) {
      continue;
    }
    pairs.push({ size, price, priceText: formatCurrencyPrice(price) });
  }
  return pairs;
}

function hasNameOverlapBeyondBrewery(beerName: string, candidateName: string, brewery: string): boolean {
  const sourceTokens = new Set(normalizeLooseText(beerName).split(/\s+/).filter((token) => token.length >= 3));
  const breweryTokens = new Set(normalizeLooseText(brewery).split(/\s+/).filter(Boolean));
  return normalizeLooseText(candidateName)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && token !== "and" && !breweryTokens.has(token))
    .some((token) => sourceTokens.has(token));
}

export function extractOnTapCardRowsFromHtml(html: string): ExtractedMenuBeerRow[] {
  if (!/\bsp_on-tap_name\b/i.test(html) || !/\bsp-on-tap-prices-flex\b/i.test(html)) {
    return [];
  }

  const rows: ExtractedMenuBeerRow[] = [];
  const seen = new Set<string>();
  const nameTagPattern = /<[^>]+class=["'][^"']*\bsp_on-tap_name\b[^"']*["'][^>]*>/gi;
  const starts: number[] = [];
  let nameTagMatch: RegExpExecArray | null;
  while ((nameTagMatch = nameTagPattern.exec(html))) {
    starts.push(nameTagMatch.index);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start == null) {
      continue;
    }
    const end = starts[index + 1] ?? html.length;
    const itemHtml = html.slice(start, end);
    const rawName = extractFirstClassText(itemHtml, "sp_on-tap_name");
    const cleanedName = cleanMenuRowName(rawName ?? "");
    if (!cleanedName || cleanedName.length < 3 || cleanedName.length > 90) {
      continue;
    }

    const pricePairs = extractOnTapCardPricePairs(itemHtml);
    const pintPair = pricePairs.find((pair) => /\bpint\b/i.test(pair.size));
    if (!pintPair) {
      continue;
    }

    const pricesIndex = itemHtml.search(/class=["'][^"']*sp-on-tap-prices-flex\b/i);
    const detailHtml = pricesIndex >= 0 ? itemHtml.slice(0, pricesIndex) : itemHtml;
    const brewery = extractFirstClassText(itemHtml, "sp_on-tap_brewery");
    const abvValue = extractClassTexts(detailHtml, "sp-on-tap-abv").find((value) => /\d/.test(value))?.replace(/\s*%\s*$/, "") ?? null;
    const style = extractClassTexts(detailHtml, "sp-on-tap-style")
      .find((value) => !/^\$?\d/.test(value) && !/^(?:pot|schooner|pint)$/i.test(value)) ?? null;
    const trackedNameFromSource = findTrackedBeerInRowName(cleanedName);
    const trackedNameFromBreweryContext = brewery ? findTrackedBeerInRowName(`${brewery} ${cleanedName}`) : null;
    const trackedName =
      trackedNameFromSource ??
      (trackedNameFromBreweryContext && brewery && hasNameOverlapBeyondBrewery(cleanedName, trackedNameFromBreweryContext, brewery)
        ? trackedNameFromBreweryContext
        : null);
    const name = trackedName ?? canonicalizeTrackedBeerName(cleanedName);
    if (isLikelyNonBeerDrinkName(name, `${cleanedName} ${brewery ?? ""} ${style ?? ""}`)) {
      continue;
    }

    const sourceRow = sourceRowPreview(
      [
        cleanedName,
        brewery,
        abvValue ? `${abvValue}%` : null,
        style,
        ...pricePairs.map((pair) => `${pair.size} ${pair.priceText}`),
      ]
        .filter(Boolean)
        .join(" "),
    );
    const row: ExtractedMenuBeerRow = {
      name,
      priceNumeric: pintPair.price,
      priceText: pintPair.priceText,
      availabilityStatus: "on_tap",
      notes: [
        "Section: ON TAP",
        "Selected pint price from structured on-tap card.",
        `Source row: ${sourceRow}`,
        brewery ? `Brewery: ${brewery}` : null,
        style ? `Style: ${style}` : null,
        abvValue ? `ABV: ${abvValue}%` : null,
      ]
        .filter(Boolean)
        .join(" | "),
      confidence: trackedName ? 0.92 : 0.86,
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

function inferAvailabilityStatus(input: {
  sourceRow: string;
  section: SectionMarker | null;
  priceCount: number;
  tapPriceOrder: PourPriceLabel[] | null;
}): MenuTextAvailabilityStatus {
  if (input.section?.availabilityStatus === "on_tap") {
    return "on_tap";
  }
  if (input.section?.availabilityStatus === "package_only" && input.priceCount < 3) {
    return "package_only";
  }
  if (input.tapPriceOrder || input.priceCount >= 3) {
    return "on_tap";
  }
  if (/\b(tap|draught|draft|pint|schooner|pot|jug|500\s?ml|425\s?ml|400\s?ml|285\s?ml)\b/i.test(input.sourceRow)) {
    return "on_tap";
  }
  if (input.priceCount >= 2 && /\d\s*\/\s*\d/.test(input.sourceRow) && !/\b(wine|cocktail|spritz|margarita|negroni)\b/i.test(input.sourceRow)) {
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
  tapPriceOrder: PourPriceLabel[] | null;
}): number | null {
  if (input.prices.length === 0) {
    return null;
  }

  const shouldUseTapPriceOrder = input.availabilityStatus === "on_tap" || (
    Boolean(input.tapPriceOrder) && input.availabilityStatus !== "package_only"
  );
  const explicitPintIndex = input.tapPriceOrder?.indexOf("pint") ?? -1;
  if (shouldUseTapPriceOrder && explicitPintIndex >= 0 && explicitPintIndex < input.prices.length) {
    return input.prices[explicitPintIndex] ?? null;
  }

  if (shouldUseTapPriceOrder) {
    if (input.prices.length >= 3) {
      const lastPrice = input.prices[input.prices.length - 1];
      const previousPrice = input.prices[input.prices.length - 2];
      if (lastPrice != null && previousPrice != null && lastPrice >= previousPrice * 1.45) {
        return previousPrice;
      }
      return lastPrice ?? null;
    }
    return input.prices[input.prices.length - 1] ?? null;
  }
  return input.prices[0] ?? null;
}

function sourceRowPreview(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= 180 ? cleaned : `${cleaned.slice(0, 177)}...`;
}

function normalizePourPriceLabel(value: string): PourPriceLabel {
  return value.toLowerCase().replace(/s$/, "") as PourPriceLabel;
}

function tapPriceOrderFromText(value: string): PourPriceLabel[] | null {
  const matches = Array.from(value.matchAll(/\b(pots?|schooners?|pints?|jugs?)\b/gi))
    .map((match) => normalizePourPriceLabel(match[1] ?? ""))
    .filter((label): label is PourPriceLabel => ["pot", "schooner", "pint", "jug"].includes(label));

  for (let index = 0; index <= matches.length - 3; index += 1) {
    const candidate = matches.slice(index, index + 3);
    const uniqueLabels = new Set(candidate);
    if (uniqueLabels.size === 3 && uniqueLabels.has("pint")) {
      return candidate;
    }
  }

  return null;
}

function tapPriceOrderHint(text: string, index: number): PourPriceLabel[] | null {
  const nearby = text.slice(Math.max(0, index - 320), Math.min(text.length, index + 120));
  return tapPriceOrderFromText(nearby);
}

function tapPriceOrderForMenuLine(lines: string[], index: number): PourPriceLabel[] | null {
  const start = Math.max(0, index - 8);
  const end = Math.min(lines.length, index + 2);
  return tapPriceOrderFromText(lines.slice(start, end).join(" "));
}

function tapPriceSelectionNote(input: {
  tapPriceOrder: PourPriceLabel[] | null;
  prices: number[];
  selectedPrice: number;
  preferredLabel: PourPriceLabel | null;
}): string | null {
  if (input.preferredLabel === "pint") {
    return "Selected pint price from labelled pour row.";
  }
  const explicitPintIndex = input.tapPriceOrder?.indexOf("pint") ?? -1;
  if (explicitPintIndex >= 0 && explicitPintIndex < input.prices.length) {
    return "Selected pint price from menu pour order.";
  }
  if (input.prices.length >= 3) {
    const lastPrice = input.prices[input.prices.length - 1];
    return input.selectedPrice === lastPrice
      ? "Selected largest tap pour price as pint."
      : "Selected middle tap pour price because the largest pour appears to be a jug.";
  }
  return null;
}

function preferredPourPrice(matches: Array<{ label: PourPriceLabel; price: number }>): { label: PourPriceLabel; price: number } | null {
  return (
    matches.find((match) => match.label === "pint") ??
    matches.find((match) => match.label === "schooner") ??
    matches.find((match) => match.label === "jug") ??
    matches.find((match) => match.label === "pot") ??
    null
  );
}

function parseLabeledPourPrices(
  line: string,
  startIndex: number,
): { priceText: string; prices: number[]; preferredPrice: number | null; preferredLabel: PourPriceLabel | null } | null {
  const priceArea = line.slice(startIndex);
  const matches: Array<{ index: number; label: PourPriceLabel; price: number; text: string }> = [];
  const seen = new Set<string>();
  const patterns: Array<{
    pattern: RegExp;
    priceGroup: number;
    labelGroup: number;
  }> = [
    {
      pattern: /(?:A\$|AUD\s*|\$)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(pot|pots|schooner|schooners|pint|pints|jug|jugs)\b/gi,
      priceGroup: 1,
      labelGroup: 2,
    },
    {
      pattern: /\b(pot|pots|schooner|schooners|pint|pints|jug|jugs)\b\s*[:=-]?\s*(?:A\$|AUD\s*|\$)?\s*(\d{1,2}(?:\.\d{1,2})?)/gi,
      priceGroup: 2,
      labelGroup: 1,
    },
  ];

  for (const { pattern, priceGroup, labelGroup } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(priceArea))) {
      const numericRaw = match[priceGroup];
      const labelRaw = match[labelGroup];
      if (!numericRaw || !labelRaw) {
        continue;
      }
      const price = Number(numericRaw);
      if (!Number.isFinite(price) || price <= 0 || price > 80) {
        continue;
      }
      const label = normalizePourPriceLabel(labelRaw);
      const absoluteIndex = startIndex + match.index;
      const key = `${absoluteIndex}:${label}:${price}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push({
        index: absoluteIndex,
        label,
        price,
        text: match[0].trim(),
      });
    }
  }

  const ordered = matches.sort((left, right) => left.index - right.index);
  if (ordered.length === 0) {
    return null;
  }
  const preferred = preferredPourPrice(ordered);

  return {
    priceText: ordered.map((match) => match.text).join(" / "),
    prices: ordered.map((match) => match.price),
    preferredPrice: preferred?.price ?? null,
    preferredLabel: preferred?.label ?? null,
  };
}

function simpleMenuPriceMatch(
  line: string,
): { index: number; priceText: string; prices: number[]; preferredPrice: number | null; preferredLabel: PourPriceLabel | null } | null {
  SIMPLE_MENU_PRICE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SIMPLE_MENU_PRICE_PATTERN.exec(line))) {
    const rawPriceText = match[0] ?? "";
    if (isEmbeddedInMeasurementToken(line, match.index, match.index + rawPriceText.length)) {
      continue;
    }
    const prices = parsePriceNumbers(rawPriceText);
    if (prices.length === 0) {
      continue;
    }

    const before = line.slice(0, match.index).trim();
    if (!before || before.length > 90 || !/[A-Za-z]/.test(before)) {
      continue;
    }

    const context = line.slice(Math.max(0, match.index - 20), Math.min(line.length, match.index + rawPriceText.length + 20));
    const after = line.slice(match.index + rawPriceText.length, Math.min(line.length, match.index + rawPriceText.length + 16));
    if (/%/.test(rawPriceText) || /\b(?:19|20)\d{2}\b/.test(context)) {
      continue;
    }
    if (/^\s*(?:packs?|days?|years?|yrs?|grade)\b/i.test(after) || /\b(?:day\s+aged|dry[-\s]?aged|msa\s*\d?\s*grade)\b/i.test(context)) {
      continue;
    }

    const labeledPourPrices = parseLabeledPourPrices(line, Math.max(0, match.index - 24));
    if (labeledPourPrices) {
      return {
        index: match.index,
        priceText: labeledPourPrices.priceText,
        prices: labeledPourPrices.prices,
        preferredPrice: labeledPourPrices.preferredPrice,
        preferredLabel: labeledPourPrices.preferredLabel,
      };
    }

    return {
      index: match.index,
      priceText: rawPriceText,
      prices,
      preferredPrice: null,
      preferredLabel: null,
    };
  }

  return null;
}

function priceOnlyLine(
  line: string,
): { prices: number[]; priceText: string; preferredPrice: number | null; preferredLabel: PourPriceLabel | null } | null {
  const cleaned = line.trim();
  const labeledPourPrices = parseLabeledPourPrices(cleaned, 0);
  if (
    labeledPourPrices &&
    /^(?:\s|,|\/|\.|-|A\$|AUD|\$|\d|pot|pots|schooner|schooners|pint|pints|jug|jugs)+$/i.test(cleaned)
  ) {
    return labeledPourPrices;
  }

  if (!cleaned || !/^(?:[$\d\s./-]|—)+$/.test(cleaned) || /%/.test(cleaned)) {
    return null;
  }

  const prices = parsePriceNumbers(cleaned);
  if (prices.length === 0) {
    return null;
  }

  return {
    prices,
    priceText: cleaned,
    preferredPrice: null,
    preferredLabel: null,
  };
}

function isLikelyStandaloneBeerNameLine(line: string, section: SectionMarker | null): boolean {
  const cleanedName = cleanMenuRowName(line);
  if (!cleanedName || cleanedName.length < 3 || cleanedName.length > 80) {
    return false;
  }
  if (sectionForMenuLine(line) || simpleMenuPriceMatch(line) || priceOnlyLine(line)) {
    return false;
  }

  if (isLikelyMenuNoiseName(cleanedName, line) || isLikelyNonBeerDrinkName(cleanedName, line)) {
    return false;
  }
  const trackedName = findTrackedBeerInRowName(cleanedName);
  if (trackedName) {
    return true;
  }

  return Boolean(section) && BEERISH_NAME_PATTERN.test(cleanedName);
}

function collectFollowingMenuPrices(lines: string[], startIndex: number): {
  prices: number[];
  priceText: string;
  preferredPrice: number | null;
  preferredLabel: PourPriceLabel | null;
  detailLine: string | null;
  lastIndex: number;
} | null {
  const prices: number[] = [];
  const priceTexts: string[] = [];
  let preferredPrice: number | null = null;
  let preferredLabel: PourPriceLabel | null = null;
  let detailLine: string | null = null;
  let lastIndex = startIndex;
  let skippedDetail = false;

  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = lines[startIndex + offset];
    if (!candidate || sectionForMenuLine(candidate)) {
      break;
    }

    const priceOnly = priceOnlyLine(candidate);
    if (priceOnly) {
      prices.push(...priceOnly.prices);
      priceTexts.push(priceOnly.priceText);
      preferredPrice ??= priceOnly.preferredPrice;
      preferredLabel ??= priceOnly.preferredLabel;
      lastIndex = startIndex + offset;
      if (prices.length >= 3) {
        break;
      }
      continue;
    }

    if (prices.length > 0) {
      break;
    }

    const trimmed = candidate.trim();
    const looksLikeDetail =
      isBeerDetailLine(trimmed) ||
      (!skippedDetail && trimmed.length <= 42 && /^[A-Za-z][A-Za-z\s,.'-]+$/.test(trimmed) && !isLikelyStandaloneBeerNameLine(trimmed, null));
    if (!looksLikeDetail) {
      break;
    }

    detailLine = sourceRowPreview(trimmed);
    skippedDetail = true;
    lastIndex = startIndex + offset;
  }

  if (prices.length === 0) {
    return null;
  }

  return {
    prices,
    priceText: priceTexts.join(" / "),
    preferredPrice,
    preferredLabel,
    detailLine,
    lastIndex,
  };
}

function inferAvailabilityStatusForLookahead(input: {
  section: SectionMarker | null;
  priceCount: number;
  sourceRow: string;
}): MenuTextAvailabilityStatus {
  if (input.priceCount >= 2) {
    return "on_tap";
  }
  if (input.section?.availabilityStatus === "package_only") {
    return "package_only";
  }
  if (/\b(can|cans|bottle|bottles|tin|tins|tinnie|tinnies|bucket|pack|takeaway)\b/i.test(input.sourceRow)) {
    return "package_only";
  }
  if (/\b(tap|draught|draft|pint|schooner|pot|jug)\b/i.test(input.sourceRow)) {
    return "on_tap";
  }
  return "unknown";
}

function rowKey(row: Pick<ExtractedMenuBeerRow, "name" | "priceNumeric" | "availabilityStatus">): string {
  return `${normalizeLooseText(row.name)}|${row.priceNumeric ?? ""}|${row.availabilityStatus}`;
}

function normalizeAvailabilityFromSectionNote(row: ExtractedMenuBeerRow): ExtractedMenuBeerRow {
  if (row.availabilityStatus !== "unknown" || !row.notes) {
    return row;
  }
  if (/\bSection:\s*ON TAP\b/i.test(row.notes)) {
    return { ...row, availabilityStatus: "on_tap" };
  }
  if (/\bSection:\s*CANS OR BOTTLES\b/i.test(row.notes)) {
    return { ...row, availabilityStatus: "package_only" };
  }
  return row;
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

    if (isLikelyMenuNoiseName(cleanedName, match[0] ?? "")) {
      continue;
    }
    const trackedName = findTrackedBeerInRowName(cleanedName);
    if (!trackedName && isLikelyNonBeerDrinkName(cleanedName, match[0] ?? "")) {
      continue;
    }
    if (!trackedName && !BEERISH_NAME_PATTERN.test(cleanedName)) {
      continue;
    }

    const prices = parsePriceNumbers(priceText);
    const tapPriceOrder = tapPriceOrderHint(normalizedText, match.index);
    const section = sectionForIndex(sections, match.index);
    const sourceRow = sourceRowPreview(match[0] ?? "");
    const inferredAvailabilityStatus = inferAvailabilityStatus({
      sourceRow: `${sourceRow} ${servingText}`,
      section,
      priceCount: prices.length,
      tapPriceOrder,
    });
    const availabilityStatus =
      inferredAvailabilityStatus === "unknown" && section?.availabilityStatus
        ? section.availabilityStatus
        : inferredAvailabilityStatus;
    const selectedPrice = selectDisplayPrice({
      prices,
      availabilityStatus,
      tapPriceOrder,
    });
    if (selectedPrice == null) {
      continue;
    }
    if (priceText.replace(/\s/g, "").startsWith("$") === false && prices.length === 1 && selectedPrice > 40) {
      continue;
    }

    const row: ExtractedMenuBeerRow = {
      name: trackedName ?? canonicalizeTrackedBeerName(cleanedName),
      priceNumeric: selectedPrice,
      priceText: formatCurrencyPrice(selectedPrice),
      availabilityStatus,
      notes: [
        section ? `Section: ${section.label}` : null,
        tapPriceSelectionNote({ tapPriceOrder, prices, selectedPrice, preferredLabel: null }),
        servingText ? `Serving hint: ${servingText}` : null,
        `Source row: ${sourceRow}`,
        abvNoteFromText(`${rawName} ${sourceRow}`),
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
  const menuLines = normalizeMenuLines(text);
  for (let lineIndex = 0; lineIndex < menuLines.length; lineIndex += 1) {
    const line = menuLines[lineIndex]!;
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

    if (isLikelyMenuNoiseName(cleanedName, line)) {
      continue;
    }
    const trackedName = findTrackedBeerInRowName(cleanedName);
    if (!trackedName && isLikelyNonBeerDrinkName(cleanedName, line)) {
      continue;
    }
    if (!trackedName && !BEERISH_NAME_PATTERN.test(cleanedName)) {
      continue;
    }

    const tapPriceOrder = tapPriceOrderForMenuLine(menuLines, lineIndex);
    const inferredAvailabilityStatus = inferAvailabilityStatus({
      sourceRow: line,
      section: currentSection,
      priceCount: priceMatch.prices.length,
      tapPriceOrder,
    });
    const availabilityStatus =
      inferredAvailabilityStatus === "unknown" && currentSection?.availabilityStatus
        ? currentSection.availabilityStatus
        : inferredAvailabilityStatus;
    const selectedPrice = priceMatch.preferredPrice ?? selectDisplayPrice({
      prices: priceMatch.prices,
      availabilityStatus,
      tapPriceOrder,
    });
    if (selectedPrice == null) {
      continue;
    }
    if (!priceMatch.priceText.trim().startsWith("$") && priceMatch.prices.length === 1 && selectedPrice > 40) {
      continue;
    }

    const detailLine = detailLineAfter(menuLines, lineIndex);
    const row: ExtractedMenuBeerRow = {
      name: trackedName ?? canonicalizeTrackedBeerName(cleanedName),
      priceNumeric: selectedPrice,
      priceText: formatCurrencyPrice(selectedPrice),
      availabilityStatus,
      notes: [
        currentSection ? `Section: ${currentSection.label}` : null,
        tapPriceSelectionNote({
          tapPriceOrder,
          prices: priceMatch.prices,
          selectedPrice,
          preferredLabel: priceMatch.preferredLabel,
        }),
        `Source row: ${sourceRowPreview(line)}`,
        detailLine ? `Beer details: ${detailLine}` : null,
        abvNoteFromText(`${line} ${detailLine ?? ""}`),
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

  currentSection = null;
  for (let lineIndex = 0; lineIndex < menuLines.length; lineIndex += 1) {
    const line = menuLines[lineIndex]!;
    const lineSection = sectionForMenuLine(line);
    if (lineSection === "reset") {
      currentSection = null;
      continue;
    }
    if (lineSection) {
      currentSection = lineSection;
      continue;
    }
    if (!isLikelyStandaloneBeerNameLine(line, currentSection)) {
      continue;
    }

    const priceBlock = collectFollowingMenuPrices(menuLines, lineIndex);
    if (!priceBlock) {
      continue;
    }

    const cleanedName = cleanMenuRowName(line);
    if (isLikelyMenuNoiseName(cleanedName, line)) {
      continue;
    }
    const trackedName = findTrackedBeerInRowName(cleanedName);
    if (!trackedName && isLikelyNonBeerDrinkName(cleanedName, line)) {
      continue;
    }

    const availabilityStatus = inferAvailabilityStatusForLookahead({
      section: currentSection,
      priceCount: priceBlock.prices.length,
      sourceRow: `${line} ${priceBlock.priceText}`,
    });
    const tapPriceOrder = tapPriceOrderForMenuLine(menuLines, lineIndex);
    const selectedPrice = priceBlock.preferredPrice ?? selectDisplayPrice({
      prices: priceBlock.prices,
      availabilityStatus,
      tapPriceOrder,
    });
    if (selectedPrice == null) {
      continue;
    }
    if (!priceBlock.priceText.trim().startsWith("$") && priceBlock.prices.length === 1 && selectedPrice > 40) {
      continue;
    }

    const row: ExtractedMenuBeerRow = {
      name: trackedName ?? canonicalizeTrackedBeerName(cleanedName),
      priceNumeric: selectedPrice,
      priceText: formatCurrencyPrice(selectedPrice),
      availabilityStatus,
      notes: [
        currentSection ? `Section: ${currentSection.label}` : null,
        tapPriceSelectionNote({
          tapPriceOrder,
          prices: priceBlock.prices,
          selectedPrice,
          preferredLabel: priceBlock.preferredLabel,
        }),
        `Source row: ${sourceRowPreview(`${line} ${priceBlock.priceText}`)}`,
        priceBlock.detailLine ? `Beer details: ${priceBlock.detailLine}` : null,
        abvNoteFromText(`${line} ${priceBlock.detailLine ?? ""}`),
      ]
        .filter(Boolean)
        .join(" | "),
      confidence: trackedName ? 0.84 : 0.72,
    };
    const key = rowKey(row);
    if (seen.has(key)) {
      lineIndex = Math.max(lineIndex, priceBlock.lastIndex);
      continue;
    }
    seen.add(key);
    rows.push(row);
    lineIndex = Math.max(lineIndex, priceBlock.lastIndex);
  }

  return rows.map(normalizeAvailabilityFromSectionNote);
}
