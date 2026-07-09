import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { env } from "../config/env.js";
import { BeerCatalogRepository, syncStaticBeerCatalog } from "./beer-catalog.repository.js";
import { isLikelyBeerName } from "../constants/beers.js";

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
  { name: "accepts_pint_path_codes", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const venueAnalyticsEventsColumns = [
  { name: "suburb", definition: "TEXT" },
] as const;

const venueSpecialsColumns = [
  { name: "start_time", definition: "TEXT" },
  { name: "end_time", definition: "TEXT" },
] as const;

const venueHappyHoursColumns = [
  { name: "happy_hour_beers_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
] as const;

const authSessionsColumns = [
  { name: "revoked_at", definition: "TEXT" },
  { name: "last_used_at", definition: "TEXT" },
  { name: "last_ip_hash", definition: "TEXT" },
  { name: "user_agent_hash", definition: "TEXT" },
] as const;

const accountsColumns = [
  { name: "public_account_id", definition: "TEXT" },
  { name: "display_name", definition: "TEXT" },
  { name: "display_name_key", definition: "TEXT" },
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

const profilesColumns = [
  { name: "public_account_id", definition: "TEXT" },
  { name: "display_name_key", definition: "TEXT" },
] as const;

const submissionColumns = [
  { name: "client_submission_id", definition: "TEXT" },
  { name: "upload_latitude", definition: "REAL" },
  { name: "upload_longitude", definition: "REAL" },
  { name: "upload_accuracy_meters", definition: "REAL" },
  { name: "upload_location_captured_at", definition: "TEXT" },
  { name: "distance_to_venue_meters", definition: "REAL" },
  { name: "points_eligible_by_location", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "points_eligibility_reason", definition: "TEXT" },
  { name: "pending_venue_json", definition: "TEXT" },
] as const;

const feedbackColumns = [
  { name: "priority", definition: "TEXT NOT NULL DEFAULT 'normal'" },
  { name: "triage_reason", definition: "TEXT" },
] as const;

const venuePartnerOutreachColumns = [
  { name: "tier_fit", definition: "TEXT" },
  { name: "next_action", definition: "TEXT" },
  { name: "last_contacted_at", definition: "TEXT" },
] as const;

const adminIngestionQueueColumns = [
  { name: "crawler_feedback_json", definition: "TEXT" },
] as const;

const venueBeersColumns = [
  { name: "normalized_beer_id", definition: "TEXT" },
] as const;

const PUBLIC_ACCOUNT_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_account
      ON accounts (public_account_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_display_name_key
      ON accounts (display_name_key)
      WHERE display_name_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_profiles_public_account
      ON profiles (public_account_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_display_name_key
      ON profiles (display_name_key)
      WHERE display_name_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_accounts_email_verified
      ON accounts (email_verified_at, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_venue_beers_normalized
      ON venue_beers (normalized_beer_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_account_discount_passes_user
      ON account_discount_passes (user_id, status, expires_at DESC);

    CREATE INDEX IF NOT EXISTS idx_account_discount_passes_session
      ON account_discount_passes (session_token_hash, status, expires_at DESC);

    CREATE INDEX IF NOT EXISTS idx_discount_redemptions_user
      ON discount_redemptions (user_id, redeemed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_discount_redemptions_venue
      ON discount_redemptions (venue_id, redeemed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_discount_redemptions_suburb
      ON discount_redemptions (suburb, redeemed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_user
      ON pint_point_drink_records (user_id, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_venue
      ON pint_point_drink_records (venue_id, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_suburb
      ON pint_point_drink_records (suburb, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_user
      ON free_pint_reward_codes (user_id, status, expires_at DESC);

    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_code
      ON free_pint_reward_codes (code_hash);

    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_venue
      ON free_pint_reward_codes (redeemed_venue_id, status, used_at DESC);

    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_user
      ON free_pint_reward_redemptions (user_id, redeemed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_venue
      ON free_pint_reward_redemptions (venue_id, redeemed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_user
      ON pint_point_ledger (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_venue
      ON pint_point_ledger (venue_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_review
      ON venue_pending_changes (status, reviewed_at DESC, submitted_at DESC);

    CREATE INDEX IF NOT EXISTS idx_source_evidence_owner
      ON source_evidence_objects (owner_user_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_user_client_submission
      ON submissions (user_id, client_submission_id)
      WHERE client_submission_id IS NOT NULL;

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

function generatePublicAccountId(database: BetterSqlite3.Database): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let randomPart = "";
    for (let index = 0; index < 8; index += 1) {
      randomPart += PUBLIC_ACCOUNT_ID_ALPHABET[crypto.randomInt(PUBLIC_ACCOUNT_ID_ALPHABET.length)]!;
    }
    const candidate = `PP-${randomPart}`;
    const exists = database
      .prepare("SELECT 1 FROM accounts WHERE public_account_id = ? LIMIT 1")
      .get(candidate);
    if (!exists) {
      return candidate;
    }
  }

  throw new Error("Unable to generate unique public account ID");
}

function backfillPublicAccountIds(database: BetterSqlite3.Database): void {
  const rows = database
    .prepare("SELECT id FROM accounts WHERE public_account_id IS NULL OR trim(public_account_id) = ''")
    .all() as Array<{ id: string }>;

  const updateAccount = database.prepare("UPDATE accounts SET public_account_id = ? WHERE id = ?");
  const updateProfile = database.prepare("UPDATE profiles SET public_account_id = ? WHERE id = ?");

  const backfill = database.transaction(() => {
    for (const row of rows) {
      const publicAccountId = generatePublicAccountId(database);
      updateAccount.run(publicAccountId, row.id);
      updateProfile.run(publicAccountId, row.id);
    }
  });

  backfill();
}

function normalizeDisplayNameKey(value: string | null): string | null {
  const key = (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return key || null;
}

function backfillDisplayNameKeys(database: BetterSqlite3.Database): void {
  const rows = database
    .prepare("SELECT id, display_name FROM accounts ORDER BY updated_at DESC, created_at DESC, id")
    .all() as Array<{ id: string; display_name: string | null }>;
  const usedKeys = new Set<string>();
  const nextKeys = new Map<string, string | null>();

  for (const row of rows) {
    const key = normalizeDisplayNameKey(row.display_name);
    if (!key || usedKeys.has(key)) {
      nextKeys.set(row.id, null);
      continue;
    }

    usedKeys.add(key);
    nextKeys.set(row.id, key);
  }

  const updateAccount = database.prepare("UPDATE accounts SET display_name_key = ? WHERE id = ?");
  const updateProfile = database.prepare("UPDATE profiles SET display_name_key = ? WHERE id = ?");
  const syncProfiles = database.prepare(`
    UPDATE profiles
       SET display_name_key = (
         SELECT accounts.display_name_key
           FROM accounts
          WHERE accounts.id = profiles.id
       )
     WHERE EXISTS (
       SELECT 1
         FROM accounts
        WHERE accounts.id = profiles.id
     )
  `);

  const backfill = database.transaction(() => {
    for (const [id, key] of nextKeys) {
      updateAccount.run(key, id);
      updateProfile.run(key, id);
    }
    syncProfiles.run();
  });

  backfill();
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
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size, price, currency,
        on_tap, in_stock, notes, created_at, updated_at
      )
      SELECT
        id, bar_id, beer_name, NULL, brewery, style, abv, serve_size, price, currency,
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
       SET membership_tier = 'pro'
     WHERE membership_tier IN ('plus', 'super_premium');
  `);
}

function shouldCatalogBeerName(value: string | null | undefined, isHappyHour = false): boolean {
  return !isHappyHour && isLikelyBeerName(value);
}

function backfillBeerNames(database: BetterSqlite3.Database): void {
  const repository = new BeerCatalogRepository(database);
  const now = new Date().toISOString();
  const backfillTable = (input: {
    source: string;
    selectSql: string;
    updateSql: string;
  }) => {
    const rows = database.prepare(input.selectSql).all() as Array<{
      id: string;
      beer_name: string;
      is_happy_hour_price?: number | null;
    }>;
    const update = database.prepare(input.updateSql);

    const backfill = database.transaction(() => {
      for (const row of rows) {
        if (!shouldCatalogBeerName(row.beer_name, Boolean(row.is_happy_hour_price))) {
          continue;
        }

        const resolved = repository.resolveBeerName({
          name: row.beer_name,
          source: input.source,
          now,
        });
        update.run(resolved.name, resolved.key, row.id);
      }
    });

    backfill();
  };

  backfillTable({
    source: "legacy_submission_backfill",
    selectSql: "SELECT id, beer_name, is_happy_hour_price FROM submission_items WHERE trim(beer_name) != ''",
    updateSql: "UPDATE submission_items SET beer_name = ?, normalized_beer_id = ? WHERE id = ?",
  });
  backfillTable({
    source: "legacy_price_record_backfill",
    selectSql: "SELECT id, beer_name, is_happy_hour_price FROM venue_price_records WHERE trim(beer_name) != ''",
    updateSql: "UPDATE venue_price_records SET beer_name = ?, normalized_beer_id = ?, updated_at = updated_at WHERE id = ?",
  });
  backfillTable({
    source: "legacy_venue_inventory_backfill",
    selectSql: "SELECT id, beer_name, 0 AS is_happy_hour_price FROM venue_beers WHERE trim(beer_name) != ''",
    updateSql: "UPDATE venue_beers SET beer_name = ?, normalized_beer_id = ?, updated_at = updated_at WHERE id = ?",
  });
}

function deletePendingNonBeerCatalogItems(database: BetterSqlite3.Database): void {
  const rows = database
    .prepare("SELECT key, name FROM beer_catalog_items WHERE status = 'pending_review'")
    .all() as Array<{ key: string; name: string }>;
  const invalidKeys = rows
    .filter((row) => !isLikelyBeerName(row.name))
    .map((row) => row.key);

  if (!invalidKeys.length) {
    return;
  }

  const deleteAliases = database.prepare("DELETE FROM beer_catalog_aliases WHERE beer_key = ?");
  const deleteItem = database.prepare("DELETE FROM beer_catalog_items WHERE key = ? AND status = 'pending_review'");
  const cleanup = database.transaction(() => {
    invalidKeys.forEach((key) => {
      deleteAliases.run(key);
      deleteItem.run(key);
    });
  });

  cleanup();
}

function redactCompletedAdminIngestionImages(database: BetterSqlite3.Database): void {
  database
    .prepare(
      `UPDATE admin_ingestion_queue
       SET image_data_url = NULL
       WHERE status IN ('published', 'rejected', 'failed')
         AND image_data_url IS NOT NULL`,
    )
    .run();
}

export function initializeDatabaseSchema(database: BetterSqlite3.Database): void {
  const schema = fs.readFileSync(resolveSchemaPath(), "utf8");

  database.exec(schema);
  migrateLegacyVenuePartnerTables(database);
  ensureColumns(database, "venue_profiles", venueProfilesColumns);
  ensureColumns(database, "venue_analytics_events", venueAnalyticsEventsColumns);
  ensureColumns(database, "venue_happy_hours", venueHappyHoursColumns);
  ensureColumns(database, "venue_specials", venueSpecialsColumns);
  ensureColumns(database, "accounts", accountsColumns);
  ensureColumns(database, "profiles", profilesColumns);
  ensureColumns(database, "auth_sessions", authSessionsColumns);
  ensureColumns(database, "submissions", submissionColumns);
  ensureColumns(database, "feedback", feedbackColumns);
  ensureColumns(database, "venue_partner_outreach", venuePartnerOutreachColumns);
  ensureColumns(database, "admin_ingestion_queue", adminIngestionQueueColumns);
  redactCompletedAdminIngestionImages(database);
  ensureColumns(database, "venue_beers", venueBeersColumns);
  syncStaticBeerCatalog(database);
  deletePendingNonBeerCatalogItems(database);
  backfillBeerNames(database);
  normalizeVenueTiers(database);
  backfillPublicAccountIds(database);
  backfillDisplayNameKeys(database);
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
