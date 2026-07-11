import type BetterSqlite3 from "better-sqlite3";

import { BEER_CATALOG, type BeerCatalogItem } from "../constants/beer-catalog.js";
import {
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../constants/beers.js";

export type BeerCatalogStatus = "active" | "pending_review";

export interface ResolvedBeerCatalogItem {
  key: string;
  name: string;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  status: BeerCatalogStatus;
  source: string;
  created: boolean;
  matchedExisting: boolean;
}

export interface BeerCatalogAdminItem {
  key: string;
  name: string;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  status: BeerCatalogStatus;
  source: string;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  aliases: string[];
}

interface BeerCatalogRow {
  key: string;
  name: string;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  status: BeerCatalogStatus;
  source: string;
}

interface BeerCatalogAdminRow extends BeerCatalogRow {
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

interface BeerCatalogAliasRow {
  beer_key: string;
  alias: string;
}

interface BeerCatalogFuzzyRow extends BeerCatalogRow {
  alias: string;
}

function cleanBeerDisplayName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

function fallbackBeerKey(value: string): string {
  return normalizeBeerSearchKey(value) || "unknown_beer";
}

function cleanOptionalCatalogText(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return cleaned ? cleaned.slice(0, 160) : null;
}

function cleanOptionalCatalogAbv(value: number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 30 ? numeric : null;
}

function compactBeerSearchKey(value: string): string {
  return normalizeBeerSearchKey(value).replaceAll("_", "");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

function rowToResolved(row: BeerCatalogRow, created: boolean): ResolvedBeerCatalogItem {
  return {
    key: row.key,
    name: row.name,
    brewery: row.brewery,
    style: row.style,
    abv: row.abv,
    status: row.status,
    source: row.source,
    created,
    matchedExisting: !created,
  };
}

export class BeerCatalogRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  resolveBeerName(input: {
    name: string;
    source: string;
    now: string;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): ResolvedBeerCatalogItem {
    const cleaned = cleanBeerDisplayName(canonicalizeTrackedBeerName(input.name));
    const tracked = findTrackedBeerByName(cleaned);
    const aliasKey = normalizeBeerSearchKey(cleaned);

    if (!aliasKey) {
      return {
        key: "unknown_beer",
        name: "Unknown beer",
        brewery: null,
        style: null,
        abv: null,
        status: "pending_review",
        source: input.source,
        created: false,
        matchedExisting: false,
      };
    }

    const existing = this.findByAliasKey(aliasKey) ?? (tracked ? this.findByKey(tracked.key) : null);
    if (existing) {
      if (existing.status === "pending_review" && (input.brewery != null || input.abv != null)) {
        this.db
          .prepare(
            `UPDATE beer_catalog_items
                SET brewery = COALESCE(brewery, ?),
                    abv = COALESCE(abv, ?),
                    updated_at = ?
              WHERE key = ?
                AND status = 'pending_review'`,
          )
          .run(
            cleanOptionalCatalogText(input.brewery),
            cleanOptionalCatalogAbv(input.abv),
            input.now,
            existing.key,
          );
        return rowToResolved(this.findByKey(existing.key) ?? existing, false);
      }
      return rowToResolved(existing, false);
    }

    const fuzzyMatch = input.matchMode === "ocr" ? this.findActiveFuzzyMatch(cleaned) : null;
    if (fuzzyMatch) {
      return rowToResolved(fuzzyMatch, false);
    }

    if (!tracked && !isLikelyBeerName(cleaned)) {
      return {
        key: fallbackBeerKey(cleaned),
        name: cleaned,
        brewery: null,
        style: null,
        abv: null,
        status: "pending_review",
        source: input.source,
        created: false,
        matchedExisting: false,
      };
    }

    if (input.createIfMissing === false) {
      return {
        key: tracked?.key ?? fallbackBeerKey(cleaned),
        name: tracked?.name ?? cleaned,
        brewery: tracked?.brewery ?? null,
        style: tracked?.style ?? null,
        abv: tracked?.abv ?? null,
        status: tracked ? "active" : "pending_review",
        source: tracked ? "system_catalog" : input.source,
        created: false,
        matchedExisting: Boolean(tracked),
      };
    }

    const row = {
      key: this.uniqueKey(tracked?.key ?? fallbackBeerKey(cleaned)),
      name: tracked?.name ?? cleaned,
      brewery: tracked?.brewery ?? cleanOptionalCatalogText(input.brewery),
      style: tracked?.style ?? null,
      abv: tracked?.abv ?? cleanOptionalCatalogAbv(input.abv),
      status: (tracked ? "active" : "pending_review") as BeerCatalogStatus,
      source: tracked ? "system_catalog" : input.source,
    };

    this.db
      .prepare(
        `INSERT INTO beer_catalog_items (
          key, name, brewery, style, abv, status, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.key,
        row.name,
        row.brewery,
        row.style,
        row.abv,
        row.status,
        row.source,
        input.now,
        input.now,
      );

    this.upsertAlias({
      beerKey: row.key,
      alias: cleaned,
      source: input.source,
      now: input.now,
    });

    if (tracked) {
      for (const alias of [tracked.key, tracked.name, ...tracked.aliases]) {
        this.upsertAlias({
          beerKey: row.key,
          alias,
          source: "system_catalog",
          now: input.now,
        });
      }
    }

    return rowToResolved(row, !tracked);
  }

  private findByAliasKey(aliasKey: string): BeerCatalogRow | null {
    const row = this.db
      .prepare(
        `SELECT item.key, item.name, item.brewery, item.style, item.abv, item.status, item.source
           FROM beer_catalog_aliases alias
           JOIN beer_catalog_items item ON item.key = alias.beer_key
          WHERE alias.alias_key = ?
          LIMIT 1`,
      )
      .get(aliasKey) as BeerCatalogRow | undefined;
    return row ?? null;
  }

  private findByKey(key: string): BeerCatalogRow | null {
    const row = this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source
           FROM beer_catalog_items
          WHERE key = ?
          LIMIT 1`,
      )
      .get(key) as BeerCatalogRow | undefined;
    return row ?? null;
  }

  private findActiveFuzzyMatch(value: string): BeerCatalogRow | null {
    const inputKey = compactBeerSearchKey(value);
    if (inputKey.length < 7) {
      return null;
    }

    const rows = this.db
      .prepare(
        `SELECT item.key, item.name, item.brewery, item.style, item.abv, item.status, item.source,
                alias.alias
           FROM beer_catalog_items item
           JOIN beer_catalog_aliases alias ON alias.beer_key = item.key
          WHERE item.status = 'active'`,
      )
      .all() as BeerCatalogFuzzyRow[];
    const scoreByKey = new Map<string, { score: number; row: BeerCatalogRow }>();

    for (const row of rows) {
      const candidateKey = compactBeerSearchKey(row.alias);
      if (candidateKey.length < 7) continue;
      const styleKey = row.style ? compactBeerSearchKey(row.style) : "";
      const candidateVariants = Array.from(new Set([
        candidateKey,
        styleKey && !candidateKey.endsWith(styleKey) ? `${candidateKey}${styleKey}` : candidateKey,
      ]));
      for (const candidateVariant of candidateVariants) {
        const maxLength = Math.max(inputKey.length, candidateVariant.length);
        const distance = levenshteinDistance(inputKey, candidateVariant);
        const allowedDistance = maxLength >= 18 ? 2 : 1;
        if (distance > allowedDistance) continue;
        const score = 1 - distance / maxLength;
        if (score < 0.91) continue;

        const current = scoreByKey.get(row.key);
        if (!current || score > current.score) {
          scoreByKey.set(row.key, { score, row });
        }
      }
    }

    const matches = Array.from(scoreByKey.values()).sort((left, right) => right.score - left.score);
    const best = matches[0];
    if (!best || (matches[1] && best.score - matches[1].score < 0.03)) {
      return null;
    }
    return best.row;
  }

  isActiveBeer(key: string | null | undefined): boolean {
    if (!key) return false;
    return this.findByKey(key)?.status === "active";
  }

  private findAdminByKey(key: string): BeerCatalogAdminRow | null {
    const row = this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
           FROM beer_catalog_items
          WHERE key = ?
          LIMIT 1`,
      )
      .get(key) as BeerCatalogAdminRow | undefined;
    return row ?? null;
  }

  private aliasesForKeys(keys: string[]): Map<string, string[]> {
    if (!keys.length) {
      return new Map();
    }

    const aliasesByBeerKey = new Map<string, string[]>();
    const aliasRows = this.db
      .prepare(
        `SELECT beer_key, alias
           FROM beer_catalog_aliases
          WHERE beer_key IN (${keys.map(() => "?").join(", ")})
          ORDER BY alias COLLATE NOCASE ASC`,
      )
      .all(...keys) as BeerCatalogAliasRow[];

    aliasRows.forEach((row) => {
      const aliases = aliasesByBeerKey.get(row.beer_key) ?? [];
      aliases.push(row.alias);
      aliasesByBeerKey.set(row.beer_key, aliases);
    });

    return aliasesByBeerKey;
  }

  private toAdminItem(row: BeerCatalogAdminRow, aliasesByBeerKey: Map<string, string[]>): BeerCatalogAdminItem {
    const aliases = new Set([row.key, row.name, ...(aliasesByBeerKey.get(row.key) ?? [])].filter(Boolean));
    return {
      key: row.key,
      name: row.name,
      brewery: row.brewery,
      style: row.style,
      abv: row.abv,
      status: row.status,
      source: row.source,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      aliases: Array.from(aliases),
    };
  }

  private uniqueKey(baseKey: string): string {
    let candidate = fallbackBeerKey(baseKey);
    let suffix = 2;
    while (this.findByKey(candidate)) {
      candidate = `${fallbackBeerKey(baseKey)}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  upsertAlias(input: {
    beerKey: string;
    alias: string;
    source: string;
    now: string;
  }): void {
    const alias = cleanBeerDisplayName(input.alias);
    const aliasKey = normalizeBeerSearchKey(alias);
    if (!aliasKey) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO beer_catalog_aliases (
          alias_key, beer_key, alias, source, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(alias_key) DO UPDATE SET
          beer_key = excluded.beer_key,
          alias = excluded.alias,
          source = excluded.source`,
      )
      .run(aliasKey, input.beerKey, alias, input.source, input.now);
  }

  listForAdmin(status: BeerCatalogStatus | "all" = "pending_review", limit = 100): BeerCatalogAdminItem[] {
    const rows = this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
           FROM beer_catalog_items
          WHERE (? = 'all' OR status = ?)
          ORDER BY CASE status WHEN 'pending_review' THEN 0 ELSE 1 END, updated_at DESC, name COLLATE NOCASE ASC
          LIMIT ?`,
      )
      .all(status, status, limit) as BeerCatalogAdminRow[];
    const aliasesByBeerKey = this.aliasesForKeys(rows.map((row) => row.key));
    return rows.map((row) => this.toAdminItem(row, aliasesByBeerKey));
  }

  approvePendingBeer(input: {
    key: string;
    reviewNote?: string | null;
    now: string;
  }): BeerCatalogAdminItem | null {
    const row = this.findAdminByKey(input.key);
    if (!row || row.status !== "pending_review") {
      return null;
    }

    const approve = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE beer_catalog_items
              SET status = 'active',
                  review_note = ?,
                  updated_at = ?
            WHERE key = ?
              AND status = 'pending_review'`,
        )
        .run(input.reviewNote ?? row.review_note, input.now, input.key);
      this.upsertAlias({
        beerKey: input.key,
        alias: row.name,
        source: "admin_catalog_review",
        now: input.now,
      });
      this.db
        .prepare("UPDATE submission_items SET requires_catalog_approval = 0 WHERE normalized_beer_id = ?")
        .run(input.key);
    });

    approve();
    return this.getAdminItem(input.key);
  }

  mergePendingBeer(input: {
    sourceKey: string;
    targetKey: string;
    reviewNote?: string | null;
    now: string;
  }): { source: BeerCatalogAdminItem; target: BeerCatalogAdminItem } | null {
    if (input.sourceKey === input.targetKey) {
      return null;
    }

    const sourceRow = this.findAdminByKey(input.sourceKey);
    const targetRow = this.findAdminByKey(input.targetKey);
    if (!sourceRow || sourceRow.status !== "pending_review" || !targetRow || targetRow.status !== "active") {
      return null;
    }

    const aliasesByBeerKey = this.aliasesForKeys([sourceRow.key, targetRow.key]);
    const sourceBeforeMerge = this.toAdminItem(sourceRow, aliasesByBeerKey);

    const merge = this.db.transaction(() => {
      for (const alias of [sourceRow.key, sourceRow.name, ...(aliasesByBeerKey.get(sourceRow.key) ?? [])]) {
        this.upsertAlias({
          beerKey: targetRow.key,
          alias,
          source: "admin_catalog_merge",
          now: input.now,
        });
      }

      const tables = [
        "submission_items",
        "venue_price_records",
        "venue_beers",
      ];
      for (const table of tables) {
        this.db
          .prepare(`UPDATE ${table} SET beer_name = ?, normalized_beer_id = ? WHERE normalized_beer_id = ?`)
          .run(targetRow.name, targetRow.key, sourceRow.key);
      }
      this.db
        .prepare("UPDATE submission_items SET requires_catalog_approval = 0 WHERE normalized_beer_id = ?")
        .run(targetRow.key);

      this.db
        .prepare(
          `UPDATE beer_catalog_items
              SET review_note = ?,
                  updated_at = ?
            WHERE key = ?`,
        )
        .run(input.reviewNote ?? `Merged ${sourceRow.name} into ${targetRow.name}.`, input.now, targetRow.key);
      this.db.prepare("DELETE FROM beer_catalog_items WHERE key = ?").run(sourceRow.key);
    });

    merge();
    const target = this.getAdminItem(targetRow.key);
    return target ? { source: sourceBeforeMerge, target } : null;
  }

  rejectPendingBeer(input: {
    key: string;
    reviewNote?: string | null;
    now: string;
  }): BeerCatalogAdminItem | null {
    const row = this.findAdminByKey(input.key);
    if (!row || row.status !== "pending_review") {
      return null;
    }

    const aliasesByBeerKey = this.aliasesForKeys([row.key]);
    const rejectedItem = {
      ...this.toAdminItem(row, aliasesByBeerKey),
      reviewNote: input.reviewNote ?? row.review_note,
      updatedAt: input.now,
    };

    const reject = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM submission_items
            WHERE normalized_beer_id = ?
              AND capture_source = 'photo_ocr'
              AND requires_catalog_approval = 1`,
        )
        .run(row.key);
      this.db.prepare("DELETE FROM beer_catalog_aliases WHERE beer_key = ?").run(row.key);
      this.db.prepare("DELETE FROM beer_catalog_items WHERE key = ? AND status = 'pending_review'").run(row.key);
    });

    reject();
    return rejectedItem;
  }

  getAdminItem(key: string): BeerCatalogAdminItem | null {
    const row = this.findAdminByKey(key);
    if (!row) {
      return null;
    }
    return this.toAdminItem(row, this.aliasesForKeys([row.key]));
  }

  listForViewer(limit = 500): BeerCatalogItem[] {
    const rows = this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source
           FROM beer_catalog_items
          WHERE status = 'active'
          ORDER BY name COLLATE NOCASE ASC
          LIMIT ?`,
      )
      .all(limit) as BeerCatalogRow[];

    if (!rows.length) {
      return BEER_CATALOG.slice(0, limit);
    }

    const aliasesByBeerKey = this.aliasesForKeys(rows.map((row) => row.key));

    return rows.map((row) => {
      const aliasSet = new Set([row.key, row.name, ...(aliasesByBeerKey.get(row.key) ?? [])]);
      const item: BeerCatalogItem = {
        key: row.key,
        name: row.name,
        aliases: Array.from(aliasSet).filter(Boolean),
      };
      if (row.brewery) {
        item.brewery = row.brewery;
      }
      if (row.style) {
        item.style = row.style;
      }
      if (row.abv != null) {
        item.abv = row.abv;
      }
      return item;
    });
  }
}

export function syncStaticBeerCatalog(database: BetterSqlite3.Database, now = new Date().toISOString()): void {
  const repository = new BeerCatalogRepository(database);
  const insertItem = database.prepare(
    `INSERT INTO beer_catalog_items (
      key, name, brewery, style, abv, status, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'system_catalog', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      brewery = excluded.brewery,
      style = excluded.style,
      abv = excluded.abv,
      status = 'active',
      source = 'system_catalog',
      updated_at = excluded.updated_at`,
  );

  const sync = database.transaction(() => {
    for (const beer of BEER_CATALOG) {
      insertItem.run(
        beer.key,
        beer.name,
        beer.brewery ?? null,
        beer.style ?? null,
        beer.abv ?? null,
        now,
        now,
      );

      for (const alias of [beer.key, beer.name, ...beer.aliases]) {
        repository.upsertAlias({
          beerKey: beer.key,
          alias,
          source: "system_catalog",
          now,
        });
      }
    }
  });

  sync();
}
