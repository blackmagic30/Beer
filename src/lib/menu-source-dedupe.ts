export interface CrawlerQueueSourceIdentity {
  venueName: string | null | undefined;
  sourceUrl: string | null | undefined;
  canonicalSourceUrl?: string | null | undefined;
}

export interface CrawlerQueueDedupeRow {
  name: string;
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: string;
}

export function normalizeCrawlerQueueText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSqlComparableText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeCrawlerQueueSourceUrl(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.port = "";
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_|fbclid$|gclid$|gbraid$|wbraid$|mc_cid$|mc_eid$|igshid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }
    return url.toString();
  } catch {
    return raw.toLowerCase().replace(/#.*$/g, "").replace(/\/+$/g, "");
  }
}

export function crawlerQueueDuplicateKey(input: CrawlerQueueSourceIdentity): string {
  return [
    normalizeCrawlerQueueText(input.venueName),
    normalizeCrawlerQueueSourceUrl(input.canonicalSourceUrl || input.sourceUrl),
  ].join("|");
}

export function crawlerQueueSourceUrlCandidates(input: CrawlerQueueSourceIdentity): string[] {
  const candidates = [
    input.canonicalSourceUrl || input.sourceUrl || "",
    input.sourceUrl || "",
    normalizeCrawlerQueueSourceUrl(input.canonicalSourceUrl || input.sourceUrl),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(candidates));
}

function normalizeCrawlerQueuePrice(row: CrawlerQueueDedupeRow): string {
  if (Number.isFinite(row.priceNumeric ?? Number.NaN)) {
    return Number(row.priceNumeric).toFixed(2);
  }
  return normalizeCrawlerQueueText(row.priceText);
}

export function crawlerQueueRowKey(row: CrawlerQueueDedupeRow): string {
  return [
    normalizeCrawlerQueueText(row.name),
    normalizeCrawlerQueuePrice(row),
    normalizeCrawlerQueueText(row.availabilityStatus),
  ].join("|");
}

export function crawlerQueueRowOverlapRatio(
  existingRowKeys: ReadonlySet<string>,
  candidateRows: CrawlerQueueDedupeRow[],
): number {
  const candidateKeys = new Set(candidateRows.map(crawlerQueueRowKey).filter(Boolean));
  if (candidateKeys.size === 0) {
    return 0;
  }

  let overlapping = 0;
  for (const key of candidateKeys) {
    if (existingRowKeys.has(key)) {
      overlapping += 1;
    }
  }

  return overlapping / candidateKeys.size;
}
