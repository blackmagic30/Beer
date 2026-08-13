import type BetterSqlite3 from "better-sqlite3";

import { BEER_CATALOG, type BeerCatalogItem } from "../constants/beer-catalog.js";
import {
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../constants/beers.js";
import type { SqlDatabase } from "./sql-database.js";

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
  abv: number | string | null;
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

const MAX_BEER_CATALOG_RESULTS = 10_000;

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

function normalizeCatalogAbv(value: number | string | null): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rowToResolved(row: BeerCatalogRow, created: boolean): ResolvedBeerCatalogItem {
  return {
    key: row.key,
    name: row.name,
    brewery: row.brewery,
    style: row.style,
    abv: normalizeCatalogAbv(row.abv),
    status: row.status,
    source: row.source,
    created,
    matchedExisting: !created,
  };
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("@", "@@").replaceAll("%", "@%").replaceAll("_", "@_");
}

export class BeerCatalogRepository {
  constructor(private readonly db: SqlDatabase) {}

  async resolveBeerName(input: {
    name: string;
    source: string;
    now: string;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): Promise<ResolvedBeerCatalogItem> {
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

    const resolve = this.db.transaction(async () => {
      await this.lockCatalogKey(tracked?.key ?? aliasKey);
      const existing = await this.findByAliasKey(aliasKey) ?? (tracked ? await this.findByKey(tracked.key) : null);
      if (existing) {
        if (
          input.createIfMissing !== false &&
          existing.status === "pending_review" &&
          (input.brewery != null || input.abv != null)
        ) {
          await this.db
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
          return rowToResolved(await this.findByKey(existing.key) ?? existing, false);
        }
        return rowToResolved(existing, false);
      }

      const fuzzyMatch = input.matchMode === "ocr" ? await this.findActiveFuzzyMatch(cleaned) : null;
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
          status: "pending_review" as const,
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
          status: tracked ? "active" as const : "pending_review" as const,
          source: tracked ? "system_catalog" : input.source,
          created: false,
          matchedExisting: Boolean(tracked),
        };
      }

      const row: BeerCatalogRow = {
        key: await this.uniqueKey(tracked?.key ?? fallbackBeerKey(cleaned)),
        name: tracked?.name ?? cleaned,
        brewery: tracked?.brewery ?? cleanOptionalCatalogText(input.brewery),
        style: tracked?.style ?? null,
        abv: tracked?.abv ?? cleanOptionalCatalogAbv(input.abv),
        status: tracked ? "active" : "pending_review",
        source: tracked ? "system_catalog" : input.source,
      };

      await this.db
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

      await this.upsertAlias({
        beerKey: row.key,
        alias: cleaned,
        source: input.source,
        now: input.now,
      });

      if (tracked) {
        for (const alias of [tracked.key, tracked.name, ...tracked.aliases]) {
          await this.upsertAlias({
            beerKey: row.key,
            alias,
            source: "system_catalog",
            now: input.now,
          });
        }
      }

      return rowToResolved(row, !tracked);
    });

    return resolve();
  }

  private async lockCatalogKey(key: string): Promise<void> {
    if (this.db.dialect !== "postgres") return;
    await this.db
      .prepare("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))")
      .run(`pintpath:beer-catalog:${key}`);
  }

  private async findByAliasKey(aliasKey: string): Promise<BeerCatalogRow | null> {
    const row = await this.db
      .prepare(
        `SELECT item.key, item.name, item.brewery, item.style, item.abv, item.status, item.source
           FROM beer_catalog_aliases alias
           JOIN beer_catalog_items item ON item.key = alias.beer_key
          WHERE alias.alias_key = ?
          LIMIT 1`,
      )
      .get<BeerCatalogRow>(aliasKey);
    return row ?? null;
  }

  private async findByKey(key: string): Promise<BeerCatalogRow | null> {
    const row = await this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source
           FROM beer_catalog_items
          WHERE key = ?
          LIMIT 1`,
      )
      .get<BeerCatalogRow>(key);
    return row ?? null;
  }

  private async findActiveFuzzyMatch(value: string): Promise<BeerCatalogRow | null> {
    const inputKey = compactBeerSearchKey(value);
    if (inputKey.length < 7) {
      return null;
    }

    const rows = await this.db
      .prepare(
        `SELECT item.key, item.name, item.brewery, item.style, item.abv, item.status, item.source,
                alias.alias
           FROM beer_catalog_items item
           JOIN beer_catalog_aliases alias ON alias.beer_key = item.key
          WHERE item.status = 'active'`,
      )
      .all<BeerCatalogFuzzyRow>();
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

  async isActiveBeer(key: string | null | undefined): Promise<boolean> {
    if (!key) return false;
    return (await this.findByKey(key))?.status === "active";
  }

  private async findAdminByKey(key: string): Promise<BeerCatalogAdminRow | null> {
    const row = await this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
           FROM beer_catalog_items
          WHERE key = ?
          LIMIT 1`,
      )
      .get<BeerCatalogAdminRow>(key);
    return row ?? null;
  }

  private async aliasesForKeys(keys: string[]): Promise<Map<string, string[]>> {
    if (!keys.length) {
      return new Map();
    }

    const aliasesByBeerKey = new Map<string, string[]>();
    const aliasRows = await this.db
      .prepare(
        `SELECT beer_key, alias
           FROM beer_catalog_aliases
          WHERE beer_key IN (${keys.map(() => "?").join(", ")})
          ORDER BY lower(alias) ASC, alias ASC`,
      )
      .all<BeerCatalogAliasRow>(...keys);

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
      abv: normalizeCatalogAbv(row.abv),
      status: row.status,
      source: row.source,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      aliases: Array.from(aliases),
    };
  }

  private async uniqueKey(baseKey: string): Promise<string> {
    let candidate = fallbackBeerKey(baseKey);
    let suffix = 2;
    while (await this.findByKey(candidate)) {
      candidate = `${fallbackBeerKey(baseKey)}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async upsertAlias(input: {
    beerKey: string;
    alias: string;
    source: string;
    now: string;
  }): Promise<void> {
    const alias = cleanBeerDisplayName(input.alias);
    const aliasKey = normalizeBeerSearchKey(alias);
    if (!aliasKey) {
      return;
    }

    await this.db
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

  async listForAdmin(
    status: BeerCatalogStatus | "all" = "pending_review",
    limit = 100,
    offset = 0,
    query = "",
  ): Promise<BeerCatalogAdminItem[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const queryPattern = `%${escapeLikePattern(normalizedQuery)}%`;
    const rows = await this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
           FROM beer_catalog_items
          WHERE (? = 'all' OR status = ?)
            AND (? = '' OR lower(name) LIKE ? ESCAPE '@' OR lower(COALESCE(brewery, '')) LIKE ? ESCAPE '@'
              OR EXISTS (SELECT 1 FROM beer_catalog_aliases alias WHERE alias.beer_key = beer_catalog_items.key AND lower(alias.alias) LIKE ? ESCAPE '@'))
          ORDER BY CASE status WHEN 'pending_review' THEN 0 ELSE 1 END, updated_at DESC, lower(name) ASC, name ASC
          LIMIT ? OFFSET ?`,
      )
      .all<BeerCatalogAdminRow>(
        status,
        status,
        normalizedQuery,
        queryPattern,
        queryPattern,
        queryPattern,
        Math.min(MAX_BEER_CATALOG_RESULTS, Math.max(0, limit)),
        Math.max(0, offset),
      );
    const aliasesByBeerKey = await this.aliasesForKeys(rows.map((row) => row.key));
    return rows.map((row) => this.toAdminItem(row, aliasesByBeerKey));
  }

  async countForAdmin(status: BeerCatalogStatus | "all" = "all", query = ""): Promise<number> {
    const normalizedQuery = query.trim().toLowerCase();
    const queryPattern = `%${escapeLikePattern(normalizedQuery)}%`;
    const row = await this.db
      .prepare(`SELECT count(*) AS count FROM beer_catalog_items
        WHERE (? = 'all' OR status = ?)
          AND (? = '' OR lower(name) LIKE ? ESCAPE '@' OR lower(COALESCE(brewery, '')) LIKE ? ESCAPE '@'
            OR EXISTS (SELECT 1 FROM beer_catalog_aliases alias WHERE alias.beer_key = beer_catalog_items.key AND lower(alias.alias) LIKE ? ESCAPE '@'))`)
      .get<{ count: number | string }>(status, status, normalizedQuery, queryPattern, queryPattern, queryPattern);
    return Number(row?.count ?? 0);
  }

  async approvePendingBeer(input: {
    key: string;
    reviewNote?: string | null;
    now: string;
  }): Promise<BeerCatalogAdminItem | null> {
    const approve = this.db.transaction(async () => {
      await this.lockCatalogKey(input.key);
      const row = await this.findAdminByKey(input.key);
      if (!row || row.status !== "pending_review") {
        return null;
      }

      const updated = await this.db
        .prepare(
          `UPDATE beer_catalog_items
              SET status = 'active',
                  review_note = ?,
                  updated_at = ?
            WHERE key = ?
              AND status = 'pending_review'`,
        )
        .run(input.reviewNote ?? row.review_note, input.now, input.key);
      if (updated.changes !== 1) return null;
      await this.upsertAlias({
        beerKey: input.key,
        alias: row.name,
        source: "admin_catalog_review",
        now: input.now,
      });
      await this.db
        .prepare("UPDATE submission_items SET requires_catalog_approval = FALSE WHERE normalized_beer_id = ?")
        .run(input.key);
      return this.getAdminItem(input.key);
    });

    return approve();
  }

  async mergePendingBeer(input: {
    sourceKey: string;
    targetKey: string;
    reviewNote?: string | null;
    now: string;
  }): Promise<{ source: BeerCatalogAdminItem; target: BeerCatalogAdminItem } | null> {
    if (input.sourceKey === input.targetKey) {
      return null;
    }

    const merge = this.db.transaction(async () => {
      for (const key of [input.sourceKey, input.targetKey].sort()) {
        await this.lockCatalogKey(key);
      }
      const sourceRow = await this.findAdminByKey(input.sourceKey);
      const targetRow = await this.findAdminByKey(input.targetKey);
      if (!sourceRow || sourceRow.status !== "pending_review" || !targetRow || targetRow.status !== "active") {
        return null;
      }

      const aliasesByBeerKey = await this.aliasesForKeys([sourceRow.key, targetRow.key]);
      const sourceBeforeMerge = this.toAdminItem(sourceRow, aliasesByBeerKey);
      for (const alias of [sourceRow.key, sourceRow.name, ...(aliasesByBeerKey.get(sourceRow.key) ?? [])]) {
        await this.upsertAlias({
          beerKey: targetRow.key,
          alias,
          source: "admin_catalog_merge",
          now: input.now,
        });
      }

      for (const table of ["submission_items", "venue_price_records", "venue_beers"]) {
        await this.db
          .prepare(`UPDATE ${table} SET beer_name = ?, normalized_beer_id = ? WHERE normalized_beer_id = ?`)
          .run(targetRow.name, targetRow.key, sourceRow.key);
      }
      await this.db
        .prepare("UPDATE submission_items SET requires_catalog_approval = FALSE WHERE normalized_beer_id = ?")
        .run(targetRow.key);
      await this.db
        .prepare(
          `UPDATE beer_catalog_items
              SET review_note = ?,
                  updated_at = ?
            WHERE key = ?`,
        )
        .run(input.reviewNote ?? `Merged ${sourceRow.name} into ${targetRow.name}.`, input.now, targetRow.key);
      const deleted = await this.db
        .prepare("DELETE FROM beer_catalog_items WHERE key = ? AND status = 'pending_review'")
        .run(sourceRow.key);
      if (deleted.changes !== 1) return null;

      const target = await this.getAdminItem(targetRow.key);
      return target ? { source: sourceBeforeMerge, target } : null;
    });

    return merge();
  }

  async rejectPendingBeer(input: {
    key: string;
    reviewNote?: string | null;
    now: string;
  }): Promise<BeerCatalogAdminItem | null> {
    const reject = this.db.transaction(async () => {
      await this.lockCatalogKey(input.key);
      const row = await this.findAdminByKey(input.key);
      if (!row || row.status !== "pending_review") {
        return null;
      }

      const aliasesByBeerKey = await this.aliasesForKeys([row.key]);
      const rejectedItem = {
        ...this.toAdminItem(row, aliasesByBeerKey),
        reviewNote: input.reviewNote ?? row.review_note,
        updatedAt: input.now,
      };

      await this.db
        .prepare(
          `DELETE FROM submission_items
            WHERE normalized_beer_id = ?
              AND requires_catalog_approval = TRUE`,
        )
        .run(row.key);
      await this.db.prepare("DELETE FROM venue_price_records WHERE normalized_beer_id = ?").run(row.key);
      await this.db.prepare("DELETE FROM venue_beers WHERE normalized_beer_id = ?").run(row.key);
      await this.db.prepare("DELETE FROM beer_catalog_aliases WHERE beer_key = ?").run(row.key);
      const deleted = await this.db
        .prepare("DELETE FROM beer_catalog_items WHERE key = ? AND status = 'pending_review'")
        .run(row.key);
      return deleted.changes === 1 ? rejectedItem : null;
    });

    return reject();
  }

  async getAdminItem(key: string): Promise<BeerCatalogAdminItem | null> {
    const row = await this.findAdminByKey(key);
    if (!row) {
      return null;
    }
    return this.toAdminItem(row, await this.aliasesForKeys([row.key]));
  }

  async listForViewer(limit = -1): Promise<BeerCatalogItem[]> {
    const boundedLimit = limit < 0
      ? MAX_BEER_CATALOG_RESULTS
      : Math.min(MAX_BEER_CATALOG_RESULTS, Math.max(0, limit));
    const rows = await this.db
      .prepare(
        `SELECT key, name, brewery, style, abv, status, source
           FROM beer_catalog_items
          WHERE status = 'active'
          ORDER BY lower(name) ASC, name ASC
          LIMIT ?`,
      )
      .all<BeerCatalogRow>(boundedLimit);

    if (!rows.length) {
      return limit < 0 ? [...BEER_CATALOG] : BEER_CATALOG.slice(0, boundedLimit);
    }

    const aliasesByBeerKey = await this.aliasesForKeys(rows.map((row) => row.key));

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
      const abv = normalizeCatalogAbv(row.abv);
      if (abv != null) {
        item.abv = abv;
      }
      return item;
    });
  }
}

/**
 * SQLite schema/bootstrap work is intentionally synchronous because
 * createDatabase() must finish migrations before the application adapter is
 * created. Runtime code must use BeerCatalogRepository instead.
 */
function resolveBeerNameForSqliteBootstrapUnsafe(
  database: BetterSqlite3.Database,
  input: { name: string; source: string; now: string },
): ResolvedBeerCatalogItem {
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

  const findByKey = (key: string) => database
    .prepare("SELECT key, name, brewery, style, abv, status, source FROM beer_catalog_items WHERE key = ? LIMIT 1")
    .get(key) as BeerCatalogRow | undefined;
  const existing = database
    .prepare(
      `SELECT item.key, item.name, item.brewery, item.style, item.abv, item.status, item.source
         FROM beer_catalog_aliases alias
         JOIN beer_catalog_items item ON item.key = alias.beer_key
        WHERE alias.alias_key = ?
        LIMIT 1`,
    )
    .get(aliasKey) as BeerCatalogRow | undefined ?? (tracked ? findByKey(tracked.key) : undefined);
  if (existing) return rowToResolved(existing, false);

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

  const baseKey = tracked?.key ?? fallbackBeerKey(cleaned);
  let key = baseKey;
  let suffix = 2;
  while (findByKey(key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }
  const row: BeerCatalogRow = {
    key,
    name: tracked?.name ?? cleaned,
    brewery: tracked?.brewery ?? null,
    style: tracked?.style ?? null,
    abv: tracked?.abv ?? null,
    status: tracked ? "active" : "pending_review",
    source: tracked ? "system_catalog" : input.source,
  };
  database.prepare(
    `INSERT INTO beer_catalog_items (
      key, name, brewery, style, abv, status, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.key, row.name, row.brewery, row.style, row.abv, row.status, row.source, input.now, input.now);

  const upsertAlias = database.prepare(
    `INSERT INTO beer_catalog_aliases (alias_key, beer_key, alias, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(alias_key) DO UPDATE SET
       beer_key = excluded.beer_key,
       alias = excluded.alias,
       source = excluded.source`,
  );
  for (const alias of [cleaned, ...(tracked ? [tracked.key, tracked.name, ...tracked.aliases] : [])]) {
    const displayAlias = cleanBeerDisplayName(alias);
    const normalizedAlias = normalizeBeerSearchKey(displayAlias);
    if (normalizedAlias) {
      upsertAlias.run(normalizedAlias, row.key, displayAlias, tracked ? "system_catalog" : input.source, input.now);
    }
  }
  return rowToResolved(row, !tracked);
}

export function resolveBeerNameForSqliteBootstrap(
  database: BetterSqlite3.Database,
  input: { name: string; source: string; now: string },
): ResolvedBeerCatalogItem {
  return database.transaction(() => resolveBeerNameForSqliteBootstrapUnsafe(database, input))();
}

export function syncStaticBeerCatalog(database: BetterSqlite3.Database, now = new Date().toISOString()): void {
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
  const upsertAlias = database.prepare(
    `INSERT INTO beer_catalog_aliases (
      alias_key, beer_key, alias, source, created_at
    ) VALUES (?, ?, ?, 'system_catalog', ?)
    ON CONFLICT(alias_key) DO UPDATE SET
      beer_key = excluded.beer_key,
      alias = excluded.alias,
      source = excluded.source`,
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
        const displayAlias = cleanBeerDisplayName(alias);
        const aliasKey = normalizeBeerSearchKey(displayAlias);
        if (aliasKey) {
          upsertAlias.run(aliasKey, beer.key, displayAlias, now);
        }
      }
    }
  });

  sync();
}
