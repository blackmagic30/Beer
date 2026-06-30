import type BetterSqlite3 from "better-sqlite3";

import { BEER_CATALOG, type BeerCatalogItem } from "../constants/beer-catalog.js";
import { canonicalizeTrackedBeerName, findTrackedBeerByName, normalizeBeerSearchKey } from "../constants/beers.js";

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

interface BeerCatalogRow {
  key: string;
  name: string;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  status: BeerCatalogStatus;
  source: string;
}

interface BeerCatalogAliasRow {
  beer_key: string;
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
      return rowToResolved(existing, false);
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
      brewery: tracked?.brewery ?? null,
      style: tracked?.style ?? null,
      abv: tracked?.abv ?? null,
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

  listForViewer(limit = 500): BeerCatalogItem[] {
    const rows = this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source
           FROM beer_catalog_items
          WHERE status IN ('active', 'pending_review')
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC
          LIMIT ?`,
      )
      .all(limit) as BeerCatalogRow[];

    if (!rows.length) {
      return BEER_CATALOG.slice(0, limit);
    }

    const aliasesByBeerKey = new Map<string, string[]>();
    const aliasRows = this.db
      .prepare(
        `SELECT beer_key, alias
           FROM beer_catalog_aliases
          WHERE beer_key IN (${rows.map(() => "?").join(", ")})
          ORDER BY alias COLLATE NOCASE ASC`,
      )
      .all(...rows.map((row) => row.key)) as BeerCatalogAliasRow[];

    aliasRows.forEach((row) => {
      const aliases = aliasesByBeerKey.get(row.beer_key) ?? [];
      aliases.push(row.alias);
      aliasesByBeerKey.set(row.beer_key, aliases);
    });

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
