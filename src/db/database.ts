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

const venueProfilesColumns = [
  { name: "stripe_customer_id", definition: "TEXT" },
  { name: "stripe_subscription_id", definition: "TEXT" },
  { name: "subscription_status", definition: "TEXT" },
  { name: "tier_manual_override", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const venueAnalyticsEventsColumns = [
  { name: "suburb", definition: "TEXT" },
] as const;

const authSessionsColumns = [
  { name: "revoked_at", definition: "TEXT" },
  { name: "last_used_at", definition: "TEXT" },
  { name: "last_ip_hash", definition: "TEXT" },
  { name: "user_agent_hash", definition: "TEXT" },
] as const;

const accountsColumns = [
  { name: "display_name", definition: "TEXT" },
  { name: "avatar_url", definition: "TEXT" },
  { name: "auth_provider", definition: "TEXT NOT NULL DEFAULT 'local'" },
  { name: "supabase_user_id", definition: "TEXT" },
  { name: "email_verified_at", definition: "TEXT" },
  { name: "mfa_level", definition: "TEXT NOT NULL DEFAULT 'aal1'" },
  { name: "mfa_verified_at", definition: "TEXT" },
  { name: "terms_accepted_at", definition: "TEXT" },
  { name: "privacy_accepted_at", definition: "TEXT" },
  { name: "terms_version", definition: "TEXT" },
  { name: "privacy_version", definition: "TEXT" },
  { name: "age_verification_status", definition: "TEXT NOT NULL DEFAULT 'not_started'" },
  { name: "is_over_18_verified", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const submissionColumns = [
  { name: "upload_latitude", definition: "REAL" },
  { name: "upload_longitude", definition: "REAL" },
  { name: "upload_accuracy_meters", definition: "REAL" },
  { name: "upload_location_captured_at", definition: "TEXT" },
  { name: "distance_to_venue_meters", definition: "REAL" },
  { name: "points_eligible_by_location", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "points_eligibility_reason", definition: "TEXT" },
] as const;

const feedbackColumns = [
  { name: "priority", definition: "TEXT NOT NULL DEFAULT 'normal'" },
  { name: "triage_reason", definition: "TEXT" },
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
    CREATE INDEX IF NOT EXISTS idx_venue_profiles_stripe_subscription
      ON venue_profiles (stripe_subscription_id);

    CREATE INDEX IF NOT EXISTS idx_venue_analytics_events_suburb
      ON venue_analytics_events (suburb, event_type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
      ON auth_sessions (user_id, revoked_at, expires_at DESC);

    CREATE INDEX IF NOT EXISTS idx_accounts_supabase_user
      ON accounts (supabase_user_id);

    CREATE INDEX IF NOT EXISTS idx_accounts_email_verified
      ON accounts (email_verified_at, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_review
      ON venue_pending_changes (status, reviewed_at DESC, submitted_at DESC);

    CREATE INDEX IF NOT EXISTS idx_source_evidence_owner
      ON source_evidence_objects (owner_user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_venue_location_cache_suburb
      ON venue_location_cache (suburb, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_events_suburb_type_created
      ON events (suburb, event_type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_events_beer_created
      ON events (beer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_feedback_priority_created
      ON feedback (priority, created_at DESC);
  `);
}

function tableExists(database: BetterSqlite3.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { exists_flag: number } | undefined;
  return Boolean(row);
}

function migrateLegacyVenuePartnerTables(database: BetterSqlite3.Database): void {
  if (tableExists(database, "bar_profiles")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_profiles (
        venue_id, name, address, suburb, area, phone, website, instagram, description,
        opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
        promoted, featured_special_eligible, stripe_customer_id, stripe_subscription_id,
        subscription_status, tier_manual_override, active, created_at, updated_at
      )
      SELECT
        bar_id, name, address, suburb, area, phone, website, instagram, description,
        opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
        promoted, featured_special_eligible, stripe_customer_id, stripe_subscription_id,
        subscription_status, tier_manual_override, active, created_at, updated_at
      FROM bar_profiles;
    `);
  }

  if (tableExists(database, "bar_beers")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_beers (
        id, venue_id, beer_name, brewery, style, abv, serve_size, price, currency,
        on_tap, in_stock, notes, created_at, updated_at
      )
      SELECT
        id, bar_id, beer_name, brewery, style, abv, serve_size, price, currency,
        on_tap, in_stock, notes, created_at, updated_at
      FROM bar_beers;
    `);
  }

  if (tableExists(database, "bar_happy_hours")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_happy_hours (
        id, venue_id, title, days_of_week_json, start_time, end_time, description,
        active, created_at, updated_at
      )
      SELECT
        id, bar_id, title, days_of_week_json, start_time, end_time, description,
        active, created_at, updated_at
      FROM bar_happy_hours;
    `);
  }

  if (tableExists(database, "bar_specials")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_specials (
        id, venue_id, title, description, price, discount, starts_at, ends_at,
        schedule_note, exclusive, active, created_at, updated_at
      )
      SELECT
        id, bar_id, title, description, price, discount, starts_at, ends_at,
        schedule_note, exclusive, active, created_at, updated_at
      FROM bar_specials;
    `);
  }

  if (tableExists(database, "bar_pending_changes")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_pending_changes (
        id, venue_id, change_type, action, target_id, payload_json, status,
        submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason,
        created_at, updated_at
      )
      SELECT
        id, bar_id, change_type, action, target_id, payload_json, status,
        submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason,
        created_at, updated_at
      FROM bar_pending_changes;
    `);
  }

  if (tableExists(database, "bar_analytics_events")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_analytics_events (
        id, venue_id, area, suburb, event_type, query_text, beer_name, beer_style, created_at
      )
      SELECT id, bar_id, area, suburb, event_type, query_text, beer_name, beer_style, created_at
      FROM bar_analytics_events;
    `);
  }

  if (tableExists(database, "bar_claim_requests")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_claim_requests (
        id, user_id, venue_id, venue_name, address, suburb, requester_name,
        requester_role, contact_email, contact_phone, message, status, created_at, updated_at
      )
      SELECT
        id, user_id, bar_id, bar_name, address, suburb, requester_name,
        requester_role, contact_email, contact_phone, message, status, created_at, updated_at
      FROM bar_claim_requests;
    `);
  }

  if (tableExists(database, "monthly_bar_reports")) {
    database.exec(`
      INSERT OR IGNORE INTO venue_monthly_reports (id, venue_id, month, data_json, created_at)
      SELECT id, bar_id, month, data_json, created_at
      FROM monthly_bar_reports;
    `);
  }

  database.exec(`
    DROP TABLE IF EXISTS monthly_bar_reports;
    DROP TABLE IF EXISTS bar_analytics_events;
    DROP TABLE IF EXISTS bar_claim_requests;
    DROP TABLE IF EXISTS bar_pending_changes;
    DROP TABLE IF EXISTS bar_specials;
    DROP TABLE IF EXISTS bar_happy_hours;
    DROP TABLE IF EXISTS bar_beers;
    DROP TABLE IF EXISTS bar_profiles;
  `);
}

function normalizeVenueTiers(database: BetterSqlite3.Database): void {
  database.exec(`
    UPDATE venue_profiles
       SET membership_tier = 'basic'
     WHERE membership_tier = 'free';

    UPDATE venue_profiles
       SET membership_tier = 'plus'
     WHERE membership_tier = 'pro'
       AND highlighted_name = 0
       AND promoted = 0;

    UPDATE venue_profiles
       SET membership_tier = 'pro'
     WHERE membership_tier = 'super_premium';
  `);
}

export function initializeDatabaseSchema(database: BetterSqlite3.Database): void {
  const schema = fs.readFileSync(resolveSchemaPath(), "utf8");

  database.exec(schema);
  migrateLegacyVenuePartnerTables(database);
  ensureColumns(database, "venue_profiles", venueProfilesColumns);
  ensureColumns(database, "venue_analytics_events", venueAnalyticsEventsColumns);
  ensureColumns(database, "accounts", accountsColumns);
  ensureColumns(database, "auth_sessions", authSessionsColumns);
  ensureColumns(database, "submissions", submissionColumns);
  ensureColumns(database, "feedback", feedbackColumns);
  normalizeVenueTiers(database);
  ensureIndexes(database);
}

export function createDatabase(): BetterSqlite3.Database {
  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });

  const database = new BetterSqlite3(env.DATABASE_PATH);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  initializeDatabaseSchema(database);

  return database;
}
