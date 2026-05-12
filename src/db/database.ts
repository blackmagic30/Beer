import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { env } from "../config/env.js";

function resolveSchemaPath(): string | URL {
  const bundledSchemaPath = new URL("./schema.sql", import.meta.url);

  if (fs.existsSync(bundledSchemaPath)) {
    return bundledSchemaPath;
  }

  return path.resolve(process.cwd(), "src/db/schema.sql");
}

const beerPriceResultsColumns = [
  { name: "venue_id", definition: "TEXT" },
  { name: "availability_status", definition: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "available_on_tap", definition: "INTEGER" },
  { name: "available_package_only", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "unavailable_reason", definition: "TEXT" },
  { name: "happy_hour", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "happy_hour_days", definition: "TEXT" },
  { name: "happy_hour_start", definition: "TEXT" },
  { name: "happy_hour_end", definition: "TEXT" },
  { name: "happy_hour_price", definition: "REAL" },
  { name: "happy_hour_confidence", definition: "REAL NOT NULL DEFAULT 0" },
  { name: "happy_hour_specials", definition: "TEXT" },
] as const;

const callRunsColumns = [
  { name: "conversation_id", definition: "TEXT UNIQUE" },
  { name: "venue_id", definition: "TEXT" },
  { name: "requested_beer", definition: "TEXT" },
  { name: "script_variant", definition: "TEXT" },
  { name: "is_test", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const barProfilesColumns = [
  { name: "stripe_customer_id", definition: "TEXT" },
  { name: "stripe_subscription_id", definition: "TEXT" },
  { name: "subscription_status", definition: "TEXT" },
  { name: "tier_manual_override", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const barAnalyticsEventsColumns = [
  { name: "suburb", definition: "TEXT" },
] as const;

const authSessionsColumns = [
  { name: "revoked_at", definition: "TEXT" },
  { name: "last_used_at", definition: "TEXT" },
  { name: "last_ip_hash", definition: "TEXT" },
  { name: "user_agent_hash", definition: "TEXT" },
] as const;

function ensureColumns(
  database: BetterSqlite3.Database,
  tableName: string,
  columns: ReadonlyArray<{ name: string; definition: string }>,
): void {
  const existingColumns = new Set(
    (
      database
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as Array<{ name: string }>
    ).map((column) => column.name),
  );

  for (const column of columns) {
    if (existingColumns.has(column.name)) {
      continue;
    }

    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.definition}`);
  }
}

function ensureIndexes(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_call_runs_venue_id
      ON call_runs (venue_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_beer_price_results_venue_id
      ON beer_price_results (venue_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_bar_profiles_stripe_subscription
      ON bar_profiles (stripe_subscription_id);

    CREATE INDEX IF NOT EXISTS idx_bar_analytics_events_suburb
      ON bar_analytics_events (suburb, event_type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
      ON auth_sessions (user_id, revoked_at, expires_at DESC);
  `);
}

function normalizeLegacyBarTiers(database: BetterSqlite3.Database): void {
  database.exec(`
    UPDATE bar_profiles
       SET membership_tier = 'basic'
     WHERE membership_tier = 'free';

    UPDATE bar_profiles
       SET membership_tier = 'plus'
     WHERE membership_tier = 'pro'
       AND highlighted_name = 0
       AND promoted = 0;

    UPDATE bar_profiles
       SET membership_tier = 'pro'
     WHERE membership_tier = 'super_premium';
  `);
}

export function createDatabase(): BetterSqlite3.Database {
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });

  const database = new BetterSqlite3(env.DATABASE_PATH);
  const schema = fs.readFileSync(resolveSchemaPath(), "utf8");

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(schema);
  ensureColumns(database, "call_runs", callRunsColumns);
  ensureColumns(database, "beer_price_results", beerPriceResultsColumns);
  ensureColumns(database, "bar_profiles", barProfilesColumns);
  ensureColumns(database, "bar_analytics_events", barAnalyticsEventsColumns);
  ensureColumns(database, "auth_sessions", authSessionsColumns);
  normalizeLegacyBarTiers(database);
  ensureIndexes(database);

  return database;
}
