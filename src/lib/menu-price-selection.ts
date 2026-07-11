export interface SelectedPintPrice {
  priceNumeric: number;
  priceText: string;
}

type PourLabel = "pot" | "schooner" | "pint" | "jug";

function normalizePourLabel(value: string): PourLabel {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("schooner")) {
    return "schooner";
  }
  if (normalized.startsWith("pint")) {
    return "pint";
  }
  if (normalized.startsWith("jug")) {
    return "jug";
  }
  return "pot";
}

function formatCurrencyPrice(value: number): string {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function selectSlashSeparatedAustralianPintPrice(text: string): SelectedPintPrice | null {
  if (!text.includes("/")) {
    return null;
  }

  const priceToken = "(?:A\\$|AUD\\s*|\\$)?\\s*\\d{1,2}(?:\\.\\d{1,2})?";
  const sequencePattern = new RegExp(
    `(?<![\\d.])(${priceToken}(?:\\s*\\/\\s*${priceToken}){1,2})(?![\\d.])`,
    "gi",
  );
  const sequence = sequencePattern.exec(text);
  if (!sequence?.[1]) {
    const leadingSlash = text.match(/^\s*\/\s*(?:A\$|AUD\s*|\$)?\s*(\d{1,2}(?:\.\d{1,2})?)(?![\d.])/i);
    const value = leadingSlash?.[1] ? Number(leadingSlash[1]) : null;
    return value != null && Number.isFinite(value) && value > 0 && value <= 80
      ? { priceNumeric: value, priceText: formatCurrencyPrice(value) }
      : null;
  }

  const prices = Array.from(sequence[1].matchAll(/(?:A\$|AUD\s*|\$)?\s*(\d{1,2}(?:\.\d{1,2})?)/gi))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 80);
  if (prices.length < 2) return null;

  const labelsBeforeSequence = Array.from(text.slice(0, sequence.index).matchAll(/\b(pot|pots|schooner|schooners|pint|pints|jug|jugs)\b/gi))
    .map((match) => normalizePourLabel(match[1] ?? "pot"))
    .slice(-prices.length);
  const labeledPintIndex = labelsBeforeSequence.length === prices.length
    ? labelsBeforeSequence.indexOf("pint")
    : -1;
  const selected = labeledPintIndex >= 0
    ? prices[labeledPintIndex]
    : prices.length >= 3
      ? prices[2]
      : prices[1];

  return selected == null
    ? null
    : {
        priceNumeric: selected,
        priceText: formatCurrencyPrice(selected),
      };
}

export function selectLabeledPintPrice(priceText: string | null | undefined): SelectedPintPrice | null {
  const text = priceText?.trim();
  if (!text) {
    return null;
  }

  const matches: Array<{
    index: number;
    label: PourLabel;
    price: number;
    priceStart: number;
    priceEnd: number;
    patternIndex: number;
  }> = [];
  const patterns: Array<{ pattern: RegExp; priceGroup: number; labelGroup: number }> = [
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

  const seen = new Set<string>();
  for (const [patternIndex, { pattern, priceGroup, labelGroup }] of patterns.entries()) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const numericRaw = match[priceGroup];
      const labelRaw = match[labelGroup];
      if (!numericRaw || !labelRaw) {
        continue;
      }
      const price = Number(numericRaw);
      if (!Number.isFinite(price) || price <= 0 || price > 80) {
        continue;
      }
      const label = normalizePourLabel(labelRaw);
      const priceStart = match.index + match[0].indexOf(numericRaw);
      const priceEnd = priceStart + numericRaw.length;
      const key = `${match.index}:${label}:${price}:${patternIndex}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push({ index: match.index, label, price, priceStart, priceEnd, patternIndex });
    }
  }

  const earliestMatch = matches.sort((left, right) => left.index - right.index)[0];
  const directionalMatches = earliestMatch
    ? matches.filter((match) => match.patternIndex === earliestMatch.patternIndex)
    : [];

  const filteredMatches = directionalMatches.filter((match) => {
    if (match.patternIndex !== 0) {
      return true;
    }
    return !directionalMatches.some(
      (other) =>
        other.patternIndex === 1 &&
        other.label !== match.label &&
        other.priceStart === match.priceStart &&
        other.priceEnd === match.priceEnd,
    );
  });

  const pint = filteredMatches
    .sort((left, right) => left.index - right.index)
    .find((match) => match.label === "pint");
  if (!pint) {
    return selectSlashSeparatedAustralianPintPrice(text);
  }

  return {
    priceNumeric: pint.price,
    priceText: formatCurrencyPrice(pint.price),
  };
}
