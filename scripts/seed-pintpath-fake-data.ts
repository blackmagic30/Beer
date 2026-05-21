import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { initializeDatabaseSchema } from "../src/db/database.js";

const TEST_PREFIX = "pintpath-release";
const DEFAULT_DATABASE_PATH = "data/pintpath-release-test.sqlite";

function assertSafeTarget(): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
  if (process.env.NODE_ENV === "production" || /https:\/\/pintpath\.au/i.test(publicBaseUrl)) {
    throw new Error("Refusing to seed synthetic release data against production. Use local, test, preview, or staging only.");
  }

  const databasePath = process.env.PINTPATH_TEST_DATABASE_PATH ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return databasePath;
}

const databasePath = assertSafeTarget();
const database = new BetterSqlite3(databasePath);
database.pragma("foreign_keys = ON");
initializeDatabaseSchema(database);

const now = new Date().toISOString();
const accounts = [
  { id: `${TEST_PREFIX}:free-user`, email: "free-user@pintpath.test", role: "user", subscription: "free" },
  { id: `${TEST_PREFIX}:paid-user`, email: "paid-user@pintpath.test", role: "user", subscription: "premium_monthly" },
  { id: `${TEST_PREFIX}:manager-basic`, email: "manager-basic@pintpath.test", role: "venue_manager", subscription: "free" },
  { id: `${TEST_PREFIX}:manager-plus`, email: "manager-plus@pintpath.test", role: "venue_manager", subscription: "free" },
  { id: `${TEST_PREFIX}:admin`, email: "admin@pintpath.test", role: "admin", subscription: "admin" },
] as const;

const venues = [
  { id: `${TEST_PREFIX}:venue-basic`, name: "Synthetic Basic Arms", suburb: "Fitzroy", tier: "basic" },
  { id: `${TEST_PREFIX}:venue-plus`, name: "Synthetic Plus Hotel", suburb: "Richmond", tier: "plus" },
  { id: `${TEST_PREFIX}:venue-pro`, name: "Synthetic Pro Taproom", suburb: "Carlton", tier: "pro" },
] as const;

database.transaction(() => {
  const insertAccount = database.prepare(`
    INSERT OR IGNORE INTO accounts (
      id, email, password_hash, role, age_confirmed_at, subscription_status,
      email_verified_at, created_at, updated_at
    ) VALUES (?, ?, 'synthetic-test-hash', ?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = database.prepare(`
    INSERT OR IGNORE INTO profiles (
      id, email, role, account_status, age_verification_status, is_over_18_verified, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', 'not_started', 0, ?, ?)
  `);
  for (const account of accounts) {
    insertAccount.run(account.id, account.email, account.role, now, account.subscription, now, now, now);
    insertProfile.run(account.id, account.email, account.role, now, now);
  }

  const insertVenue = database.prepare(`
    INSERT OR REPLACE INTO venue_profiles (
      venue_id, name, address, suburb, area, description, opening_hours_json, venue_tags_json,
      membership_tier, highlighted_name, premium_badge, promoted, featured_special_eligible,
      active, created_at, updated_at
    ) VALUES (?, ?, '1 Synthetic St', ?, ?, 'Synthetic release-readiness venue.',
      '{}', '["pub","happy hour"]', ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const venue of venues) {
    const isPro = venue.tier === "pro";
    insertVenue.run(
      venue.id,
      venue.name,
      venue.suburb,
      venue.suburb,
      venue.tier,
      isPro ? 1 : 0,
      isPro ? "Pro" : null,
      isPro ? 1 : 0,
      isPro ? 1 : 0,
      now,
      now,
    );
  }

  database.prepare(`
    INSERT OR IGNORE INTO venue_manager_assignments (
      id, user_id, venue_id, venue_name, suburb, status, approved_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    `${TEST_PREFIX}:assignment-plus`,
    `${TEST_PREFIX}:manager-plus`,
    `${TEST_PREFIX}:venue-plus`,
    "Synthetic Plus Hotel",
    "Richmond",
    `${TEST_PREFIX}:admin`,
    now,
    now,
  );

  const insertBeer = database.prepare(`
    INSERT OR REPLACE INTO venue_beers (
      id, venue_id, beer_name, brewery, style, abv, serve_size, price, currency,
      on_tap, in_stock, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pint', ?, 'AUD', 1, 1, 'Synthetic release test row.', ?, ?)
  `);
  insertBeer.run(`${TEST_PREFIX}:beer-guinness`, `${TEST_PREFIX}:venue-plus`, "Guinness", "Guinness", "Stout", 4.2, 13, now, now);
  insertBeer.run(`${TEST_PREFIX}:beer-carlton`, `${TEST_PREFIX}:venue-pro`, "Carlton Draft", "Carlton & United Breweries", "Lager", 4.6, 11, now, now);

  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO events (
      id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb, metadata_json, created_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, '{"synthetic":true}', ?)
  `);
  for (let index = 0; index < 12; index += 1) {
    insertEvent.run(`${TEST_PREFIX}:event:${index}`, `${TEST_PREFIX}:anon:${index}`, "beer_search_performed", null, "guinness", "Richmond", now);
  }
})();

database.close();

console.log(`Seeded synthetic Pint Path release data into ${databasePath}.`);
