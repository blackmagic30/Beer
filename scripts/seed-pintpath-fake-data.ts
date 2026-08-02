import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";

import { BusinessRepository } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { findTrackedBeerByName, normalizeBeerSearchKey } from "../src/constants/beers.js";
import { getZonedMonthRangeIso } from "../src/lib/time.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

assertOperatorMutationAllowed("Synthetic Pint Path data seed");

const TEST_PREFIX = "pintpath-release";
const DEFAULT_DATABASE_PATH = "data/pintpath-release-test.sqlite";
const SIMULATION_MONTH = process.env.PINTPATH_FAKE_MONTH ?? "2026-05";
const USER_COUNT = Number(process.env.PINTPATH_FAKE_USER_COUNT ?? 420);
const BAR_COUNT = Number(process.env.PINTPATH_FAKE_BAR_COUNT ?? 48);
const OWNER_COUNT = Number(process.env.PINTPATH_FAKE_OWNER_COUNT ?? 12);
const ANALYTICS_PRIVACY_FLOOR = Number(process.env.ANALYTICS_MIN_BUCKET_SIZE ?? 5);
const RANDOM_SEED = Number(process.env.PINTPATH_FAKE_SEED ?? 0x70696e74);
const DEMO_OWNER_ID = `${TEST_PREFIX}:owner:001`;
const DEMO_OWNER_EMAIL = "owner-001@pintpath.test";
const DEMO_OWNER_PASSWORD = process.env.PINTPATH_FAKE_OWNER_PASSWORD ?? `${crypto.randomBytes(18).toString("base64url")}!aA1`;

type Tier = "basic" | "pro";

interface FakeVenue {
  id: string;
  name: string;
  suburb: string;
  area: string;
  category: string;
  tier: Tier;
  ownerId: string | null;
  active: boolean;
}

interface FakeUser {
  id: string;
  email: string;
  role: "user" | "venue_manager" | "admin";
  subscription: "free" | "premium_monthly" | "premium_yearly" | "admin";
  displayName: string;
  createdAt: string;
  venueReportOptIn: boolean;
}

function monthRange(month: string): { start: Date; end: Date; startIso: string; endIso: string; dayCount: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("PINTPATH_FAKE_MONTH must use YYYY-MM, for example 2026-05.");
  }

  const [yearPart, monthPart] = month.split("-");
  const year = Number(yearPart);
  const monthNumber = Number(monthPart);
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error("PINTPATH_FAKE_MONTH must use a valid YYYY-MM month from 2020 to 2100.");
  }

  const zonedRange = getZonedMonthRangeIso(month, "Australia/Melbourne");
  const start = new Date(zonedRange.startIso);
  const end = new Date(zonedRange.endIso);
  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dayCount: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(),
  };
}

function assertSafeTarget(): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
  if (process.env.NODE_ENV === "production" || /https:\/\/pintpath\.au/i.test(publicBaseUrl)) {
    throw new Error("Refusing to seed synthetic release data against production. Use local, test, preview, or staging only.");
  }

  const databasePath = process.env.PINTPATH_TEST_DATABASE_PATH ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  const resolvedPath = path.resolve(databasePath);
  const defaultResolvedPath = path.resolve(DEFAULT_DATABASE_PATH);
  const explicitAllow = process.env.ALLOW_FAKE_SEED === "true" || process.env.NODE_ENV === "test";

  if (!explicitAllow && resolvedPath !== defaultResolvedPath && !resolvedPath.includes("pintpath-release-test")) {
    throw new Error("Refusing to seed a custom database path without ALLOW_FAKE_SEED=true.");
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

function mulberry32(seed: number) {
  let current = seed;
  return () => {
    current += 0x6d2b79f5;
    let value = current;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

if (!Number.isInteger(RANDOM_SEED)) {
  throw new Error("PINTPATH_FAKE_SEED must be an integer so the synthetic run can be reproduced.");
}

const random = mulberry32(RANDOM_SEED);

function pick<T>(values: T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function weightedPick<T>(values: Array<{ value: T; weight: number }>): T {
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;
  for (const item of values) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.value;
    }
  }
  return values.at(-1)!.value;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dayTimestamp(monthStart: Date, dayIndex: number, sequence: number, eveningBias = true): string {
  const date = addDays(monthStart, dayIndex);
  const isWeekend = [5, 6].includes(date.getUTCDay());
  const hour = eveningBias
    ? weightedPick([
        { value: 17, weight: 1 },
        { value: 18, weight: 2 },
        { value: 19, weight: 3 },
        { value: 20, weight: isWeekend ? 5 : 3 },
        { value: 21, weight: isWeekend ? 6 : 2 },
        { value: 22, weight: isWeekend ? 5 : 1 },
        { value: 23, weight: isWeekend ? 3 : 1 },
      ])
    : Math.floor(random() * 16) + 8;
  date.setTime(date.getTime() + (
    hour * 60 * 60 * 1000 +
    (sequence % 60) * 60 * 1000 +
    Math.floor(random() * 60) * 1000
  ));
  return date.toISOString();
}

function cleanupSyntheticRows(database: BetterSqlite3.Database): void {
  const prefixLike = `${TEST_PREFIX}:%`;
  const testEmailLike = "%@pintpath.test";

  database.prepare("DELETE FROM events WHERE id LIKE ? OR anonymous_session_id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM discount_redemptions WHERE id LIKE ? OR user_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_analytics_events WHERE id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM saved_items WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM feedback WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM wrong_price_reports WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_requests WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_interest_requests WHERE id LIKE ? OR user_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_pending_changes WHERE id LIKE ? OR venue_id LIKE ? OR submitted_by LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_specials WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_happy_hours WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_beers WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_manager_assignments WHERE id LIKE ? OR venue_id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_monthly_reports WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_profiles WHERE venue_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM verifications WHERE id LIKE ? OR verifier_user_id LIKE ? OR upload_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM submission_items WHERE id LIKE ? OR submission_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM submissions WHERE id LIKE ? OR user_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM contribution_ledger WHERE id LIKE ? OR user_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM user_activity_events WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM source_evidence_objects WHERE id LIKE ? OR owner_user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM auth_sessions WHERE user_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM account_privacy_settings WHERE user_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM profiles WHERE id LIKE ? OR email LIKE ?").run(prefixLike, testEmailLike);
  database.prepare("DELETE FROM accounts WHERE id LIKE ? OR email LIKE ?").run(prefixLike, testEmailLike);
}

const suburbs = [
  "Melbourne CBD",
  "Fitzroy",
  "Richmond",
  "Carlton",
  "Collingwood",
  "Southbank",
  "St Kilda",
  "Brunswick",
  "Prahran",
  "Northcote",
  "Footscray",
  "South Yarra",
];
const categories = ["Pub", "Cocktail bar", "Rooftop bar", "Wine bar", "Sports bar", "Live music venue", "Club", "Dive bar", "Brewery", "Lounge"];
const vibes = ["happy hour", "craft beer", "date night", "late night", "sports", "rooftop", "live music", "after work", "quiet pint", "group friendly"];
const beers = [
  { name: "Guinness", brewery: "Guinness", style: "Stout", price: 13 },
  { name: "Carlton Draught", brewery: "Carlton & United Breweries", style: "Lager", price: 11 },
  { name: "Stone & Wood Pacific Ale", brewery: "Stone & Wood", style: "Pacific Ale", price: 12 },
  { name: "Balter XPA", brewery: "Balter", style: "XPA", price: 13 },
  { name: "Mountain Goat Lager", brewery: "Mountain Goat", style: "Lager", price: 12 },
  { name: "Young Henrys Newtowner", brewery: "Young Henrys", style: "Ale", price: 12 },
];
const searchTerms = ["guinness", "lager", "stout", "xpa", "happy hour", "rooftop", "live music", "cheap pint", "craft beer"];
const beerSearchTerms = ["guinness", "carlton draught", "stone & wood", "lager", "stout", "xpa", "pilsner", "pacific ale"];

function buildUsers(range: ReturnType<typeof monthRange>): FakeUser[] {
  const users: FakeUser[] = [];
  for (let index = 0; index < USER_COUNT; index += 1) {
    const createdDay = Math.floor(random() * range.dayCount);
    const paidRoll = random();
    users.push({
      id: `${TEST_PREFIX}:user:${String(index + 1).padStart(4, "0")}`,
      email: `user-${String(index + 1).padStart(4, "0")}@pintpath.test`,
      role: "user",
      subscription: paidRoll > 0.94 ? "premium_yearly" : paidRoll > 0.86 ? "premium_monthly" : "free",
      displayName: `Fake User ${index + 1}`,
      createdAt: dayTimestamp(range.start, createdDay, index, false),
      venueReportOptIn: index % 17 !== 0,
    });
  }

  for (let index = 0; index < OWNER_COUNT; index += 1) {
    users.push({
      id: `${TEST_PREFIX}:owner:${String(index + 1).padStart(3, "0")}`,
      email: `owner-${String(index + 1).padStart(3, "0")}@pintpath.test`,
      role: "venue_manager",
      subscription: "free",
      displayName: `Fake Venue Owner ${index + 1}`,
      createdAt: dayTimestamp(range.start, Math.floor(random() * 12), index, false),
      venueReportOptIn: true,
    });
  }

  users.push({
    id: `${TEST_PREFIX}:admin`,
    email: "admin@pintpath.test",
    role: "admin",
    subscription: "admin",
    displayName: "Fake Admin",
    createdAt: range.startIso,
    venueReportOptIn: true,
  });

  return users;
}

function buildVenues(): FakeVenue[] {
  const venueWords = ["Arms", "Hotel", "Taproom", "Cellar", "Social", "House", "Roof", "Club", "Lounge", "Yard"];
  const venues: FakeVenue[] = [];
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const tier: Tier = index % 4 === 0 || index % 7 === 0 || index % 10 === 0 || index % 13 === 0 ? "pro" : "basic";
    const suburb = suburbs[index % suburbs.length]!;
    const category = categories[index % categories.length]!;
    const claimed = index < Math.floor(BAR_COUNT * 0.75);
    venues.push({
      id: `${TEST_PREFIX}:venue:${String(index + 1).padStart(3, "0")}`,
      name: `Synthetic ${suburb} ${venueWords[index % venueWords.length]}`,
      suburb,
      area: suburb,
      category,
      tier,
      ownerId: claimed ? `${TEST_PREFIX}:owner:${String((index % OWNER_COUNT) + 1).padStart(3, "0")}` : null,
      active: index < BAR_COUNT - 3,
    });
  }
  return venues;
}

function insertAccounts(database: BetterSqlite3.Database, users: FakeUser[], now: string): void {
  const demoOwnerSalt = crypto.randomBytes(16).toString("hex");
  const demoOwnerPasswordHash = `scrypt:${demoOwnerSalt}:${crypto.scryptSync(DEMO_OWNER_PASSWORD, demoOwnerSalt, 64).toString("hex")}`;
  const insertAccount = database.prepare(`
    INSERT INTO accounts (
      id, public_account_id, email, password_hash, display_name, auth_provider, email_verified_at,
      role, age_confirmed_at, terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
      subscription_status, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, '2026-05-24', '2026-05-24', ?, 'active', ?, ?)
  `);
  const insertProfile = database.prepare(`
    INSERT INTO profiles (
      id, public_account_id, email, display_name, role, account_status, age_verification_status,
      is_over_18_verified, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'not_started', 0, ?, ?)
  `);
  const insertPrivacy = database.prepare(`
    INSERT INTO account_privacy_settings (
      user_id, optional_analytics_enabled, venue_report_inclusion_enabled, product_research_enabled,
      email_updates_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 0, ?, ?)
  `);

  users.forEach((user, index) => {
    const publicId = `PP-FAKE${String(index + 1).padStart(5, "0")}`;
    insertAccount.run(
      user.id,
      publicId,
      user.email,
      user.id === DEMO_OWNER_ID ? demoOwnerPasswordHash : "synthetic-test-hash",
      user.displayName,
      now,
      user.role,
      now,
      now,
      now,
      user.subscription,
      user.createdAt,
      now,
    );
    insertProfile.run(user.id, publicId, user.email, user.displayName, user.role, user.createdAt, now);
    insertPrivacy.run(user.id, user.venueReportOptIn ? 1 : 0, user.venueReportOptIn ? 1 : 0, now, now);
  });
}

function insertVenues(database: BetterSqlite3.Database, venues: FakeVenue[], now: string): void {
  const insertVenue = database.prepare(`
    INSERT INTO venue_profiles (
      venue_id, name, address, suburb, area, phone, website, instagram, description,
      opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
      promoted, featured_special_eligible, subscription_status, tier_manual_override, active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO venue_manager_assignments (
      id, user_id, venue_id, venue_name, suburb, status, approved_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const insertBeer = database.prepare(`
    INSERT INTO venue_beers (
      id, venue_id, beer_name, brewery, style, abv, serve_size, price, currency,
      on_tap, in_stock, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pint', ?, 'AUD', 1, 1, 'Synthetic release-readiness stock row.', ?, ?)
  `);
  const insertHappyHour = database.prepare(`
    INSERT INTO venue_happy_hours (
      id, venue_id, title, days_of_week_json, start_time, end_time, description, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertSpecial = database.prepare(`
    INSERT INTO venue_specials (
      id, venue_id, title, description, price, discount, starts_at, ends_at,
      schedule_note, exclusive, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?)
  `);

  venues.forEach((venue, index) => {
    const tags = [venue.category.toLowerCase(), pick(vibes), pick(vibes)].filter((value, tagIndex, list) => list.indexOf(value) === tagIndex);
    const openingHours = {
      mon: { open: "16:00", close: "23:00" },
      tue: { open: "16:00", close: "23:00" },
      wed: { open: "16:00", close: "23:30" },
      thu: { open: "16:00", close: "00:30" },
      fri: { open: "15:00", close: "02:00" },
      sat: { open: "14:00", close: "02:00" },
      sun: { open: "14:00", close: "22:00" },
    };
    insertVenue.run(
      venue.id,
      venue.name,
      `${index + 10} Synthetic St`,
      venue.suburb,
      venue.area,
      `+61 3 9000 ${String(index).padStart(4, "0")}`,
      `https://${venue.id.replaceAll(":", "-")}.pintpath.test`,
      null,
      `${venue.category} test listing for launch rehearsal only.`,
      JSON.stringify(openingHours),
      JSON.stringify(tags),
      venue.tier,
      venue.tier === "pro" ? 1 : 0,
      venue.tier === "pro" ? "Pro" : null,
      venue.tier === "pro" ? 1 : 0,
      venue.tier === "pro" ? 1 : 0,
      venue.tier === "basic" ? null : "active_test",
      venue.active ? 1 : 0,
      now,
      now,
    );

    if (venue.ownerId) {
      insertAssignment.run(`${TEST_PREFIX}:assignment:${venue.id}`, venue.ownerId, venue.id, venue.name, venue.suburb, `${TEST_PREFIX}:admin`, now, now);
    }

    const beerOffset = index % beers.length;
    for (let beerIndex = 0; beerIndex < 3; beerIndex += 1) {
      const beer = beers[(beerOffset + beerIndex) % beers.length]!;
      insertBeer.run(
        `${TEST_PREFIX}:beer:${String(index + 1).padStart(3, "0")}:${beerIndex}`,
        venue.id,
        beer.name,
        beer.brewery,
        beer.style,
        4 + random() * 2,
        beer.price + (venue.tier === "pro" ? 1 : 0) + (random() > 0.8 ? 1 : 0),
        now,
        now,
      );
    }

    insertHappyHour.run(
      `${TEST_PREFIX}:happy:${String(index + 1).padStart(3, "0")}`,
      venue.id,
      "Synthetic golden hour",
      JSON.stringify(["thu", "fri", "sat"]),
      "17:00",
      "19:00",
      "$10 selected pints and rotating venue-confirmed specials.",
      now,
      now,
    );

    if (venue.tier !== "basic") {
      insertSpecial.run(
        `${TEST_PREFIX}:special:${String(index + 1).padStart(3, "0")}`,
        venue.id,
        "Pro featured pint path special",
        "Synthetic Pro special for report and portal testing.",
        9,
        "Featured",
        "Visible only because this fake venue is Pro.",
        1,
        now,
        now,
      );
    }
  });
}

function insertActivity(database: BetterSqlite3.Database, users: FakeUser[], venues: FakeVenue[], range: ReturnType<typeof monthRange>): number {
  const normalUsers = users.filter((user) => user.role === "user");
  const reportUsers = normalUsers.filter((user) => user.venueReportOptIn);
  const anonymousSessions = Array.from(
    { length: Math.max(80, Math.round(USER_COUNT * 0.4)) },
    (_, index) => `${TEST_PREFIX}:anon-session:${String(index + 1).padStart(4, "0")}`,
  );
  const activeVenues = venues.filter((venue) => venue.active);
  const venueWeights = activeVenues.map((venue, index) => ({
    value: venue,
    weight: (venue.tier === "pro" ? 2.4 : 1) * (index < 8 ? 1.8 : 1),
  }));
  const insertEvent = database.prepare(`
    INSERT INTO events (
      id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVenueAnalytics = database.prepare(`
    INSERT INTO venue_analytics_events (
      id, venue_id, area, suburb, event_type, query_text, beer_name, beer_style, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSaved = database.prepare(`
    INSERT OR IGNORE INTO saved_items (
      id, user_id, item_type, item_id, label, suburb, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWrongPrice = database.prepare(`
    INSERT INTO wrong_price_reports (
      id, user_id, anonymous_session_id, venue_id, venue_name, price_record_id, beer_name,
      reason, notes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'open', ?, ?)
  `);
  const insertRequest = database.prepare(`
    INSERT INTO venue_requests (
      id, user_id, anonymous_session_id, request_type, venue_id, venue_name, beer_name,
      suburb, notes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `);
  const insertFeedback = database.prepare(`
    INSERT INTO feedback (
      id, user_id, anonymous_session_id, feedback_type, message, venue_id, venue_name,
      status, priority, triage_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `);
  const insertInterest = database.prepare(`
    INSERT INTO venue_interest_requests (
      id, user_id, venue_id, venue_name, manager_name, email, phone, role, notes,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'Owner', ?, 'open', ?, ?)
  `);
  const insertDiscountRedemption = database.prepare(`
    INSERT INTO discount_redemptions (
      id, user_id, public_account_id, venue_id, venue_name, suburb, special_id, item_name,
      quantity, estimated_savings_cents, discount_pass_id, redeemed_by_user_id,
      idempotency_key, redeemed_at, metadata_json, created_at
    ) VALUES (?, ?, (SELECT public_account_id FROM accounts WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);

  let eventCount = 0;
  const eventTypes = [
    "map_viewed",
    "search_performed",
    "beer_search_performed",
    "suburb_search_performed",
    "venue_card_viewed",
    "map_pin_click",
    "venue_detail_opened",
    "beer_list_viewed",
    "free_preview_viewed",
    "happy_hour_active_now_used",
    "special_viewed",
    "deal_viewed",
    "directions_clicked",
    "venue_lookup",
    "saved_venue_added",
    "saved_night_plan_added",
    "venue_shared",
    "share_link_copied",
  ];

  for (let dayIndex = 0; dayIndex < range.dayCount; dayIndex += 1) {
    const date = addDays(range.start, dayIndex);
    if (date >= range.end) {
      break;
    }
    const isWeekend = [5, 6].includes(date.getUTCDay());
    const eventsToday = isWeekend ? 390 : 190;
    for (let sequence = 0; sequence < eventsToday; sequence += 1) {
      const venue = weightedPick(venueWeights);
      const user = random() > 0.28 ? pick(reportUsers) : null;
      const isSearch = random() < 0.28;
      const eventType = isSearch
        ? weightedPick([
            { value: "beer_search_performed", weight: 4 },
            { value: "search_performed", weight: 3 },
            { value: "suburb_search_performed", weight: 1 },
          ])
        : weightedPick(eventTypes.map((value) => ({
            value,
            weight:
              value === "venue_detail_opened" ? 4 :
              value === "map_pin_click" ? 4 :
              value === "venue_card_viewed" ? 3 :
              value === "free_preview_viewed" ? 2 :
              value.startsWith("saved") ? 0.5 :
              value.includes("shared") || value.includes("share") ? 0.35 :
              1,
          })));
      const searchTerm = eventType === "beer_search_performed" ? pick(beerSearchTerms) : pick(searchTerms);
      const beerId = eventType === "beer_search_performed"
        ? findTrackedBeerByName(searchTerm)?.key ?? normalizeBeerSearchKey(searchTerm)
        : random() > 0.72 ? findTrackedBeerByName(pick(beers).name)?.key ?? null : null;
      const eventVenue = isSearch && random() > 0.22 ? null : venue;
      const createdAt = dayTimestamp(range.start, dayIndex, sequence);
      const anonymousSessionId = user ? null : pick(anonymousSessions);

      insertEvent.run(
        `${TEST_PREFIX}:event:${dayIndex}:${sequence}`,
        user?.id ?? null,
        anonymousSessionId,
        eventType,
        eventVenue?.id ?? null,
        beerId,
        eventVenue?.suburb ?? venue.suburb,
        JSON.stringify({
          synthetic: true,
          query: isSearch ? searchTerm : undefined,
          source: isWeekend ? "weekend-night-simulation" : "weekday-evening-simulation",
          privacyScope: eventVenue ? "venue_insight" : "optional_analytics",
        }),
        createdAt,
      );
      eventCount += 1;

      if (eventType === "beer_search_performed" || random() > 0.965) {
        const beerStyle = pick(["lager", "stout", "xpa", "ale", "pilsner"]);
        insertVenueAnalytics.run(
          `${TEST_PREFIX}:venue-analytics:${dayIndex}:${sequence}`,
          null,
          venue.area,
          venue.suburb,
          random() > 0.35 ? "beer_style_search" : "beer_search",
          searchTerm,
          eventType === "beer_search_performed" ? searchTerm : null,
          beerStyle,
          createdAt,
        );
        insertEvent.run(
          `${TEST_PREFIX}:style-event:${dayIndex}:${sequence}`,
          user?.id ?? null,
          anonymousSessionId,
          "style_search",
          null,
          null,
          venue.suburb,
          JSON.stringify({
            synthetic: true,
            query: beerStyle,
            beerStyle,
            searchKind: "style",
            source: "synthetic-style-search",
            privacyScope: "optional_analytics",
          }),
          createdAt,
        );
        eventCount += 1;
      }

      if (user && (eventType === "saved_venue_added" || eventType === "saved_night_plan_added")) {
        insertSaved.run(
          `${TEST_PREFIX}:saved:${user.id}:${eventVenue?.id ?? venue.id}:${eventType}`,
          user.id,
          eventType === "saved_night_plan_added" ? "night_plan" : "venue",
          eventType === "saved_night_plan_added" ? `${TEST_PREFIX}:night-plan:${user.id}:${dayIndex}` : (eventVenue?.id ?? venue.id),
          eventType === "saved_night_plan_added" ? `Synthetic night plan ${dayIndex + 1}` : (eventVenue?.name ?? venue.name),
          eventVenue?.suburb ?? venue.suburb,
          JSON.stringify({ synthetic: true, tier: venue.tier }),
          createdAt,
        );
      }
    }
  }

  for (const [venueIndex, venue] of activeVenues.filter((item) => item.tier === "pro" && item.ownerId).entries()) {
    const redemptionCount = 8 + Math.floor(random() * 12);
    for (let index = 0; index < redemptionCount; index += 1) {
      const user = pick(reportUsers);
      const quantity = random() > 0.82 ? 2 : 1;
      const createdAt = dayTimestamp(range.start, (venueIndex * 3 + index * 2) % range.dayCount, index);
      insertDiscountRedemption.run(
        `${TEST_PREFIX}:discount:${venue.id}:${index}`,
        user.id,
        user.id,
        venue.id,
        venue.name,
        venue.suburb,
        `${TEST_PREFIX}:special:${String(venues.indexOf(venue) + 1).padStart(3, "0")}`,
        index % 3 === 0 ? "$10 selected pint" : index % 3 === 1 ? "Pint Path happy hour" : "Featured venue special",
        quantity,
        quantity * (200 + (index % 3) * 100),
        venue.ownerId,
        `synthetic:${venue.id}:${index}`,
        createdAt,
        JSON.stringify({ synthetic: true, source: "release-readiness-seed" }),
        createdAt,
      );
      eventCount += 1;
    }
  }

  for (let index = 0; index < 65; index += 1) {
    const venue = weightedPick(venueWeights);
    const user = random() > 0.25 ? pick(normalUsers) : null;
    const createdAt = dayTimestamp(range.start, Math.floor(random() * range.dayCount), index);
    insertWrongPrice.run(
      `${TEST_PREFIX}:wrong-price:${index}`,
      user?.id ?? null,
      user ? null : `${TEST_PREFIX}:anon-wrong:${index}`,
      venue.id,
      venue.name,
      pick(beers).name,
      pick(["price_changed", "beer_not_available", "happy_hour_changed", "wrong_serving_size", "other"]),
      "Synthetic wrong-price report for local launch rehearsal.",
      createdAt,
      createdAt,
    );
  }

  for (let index = 0; index < 110; index += 1) {
    const venue = random() > 0.18 ? weightedPick(venueWeights) : null;
    const user = random() > 0.2 ? pick(normalUsers) : null;
    const createdAt = dayTimestamp(range.start, Math.floor(random() * range.dayCount), index, false);
    insertRequest.run(
      `${TEST_PREFIX}:request:${index}`,
      user?.id ?? null,
      user ? null : `${TEST_PREFIX}:anon-request:${index}`,
      venue ? pick(["verify_venue", "verify_beer_at_venue", "missing_beer"]) : "missing_venue",
      venue?.id ?? null,
      venue?.name ?? `Synthetic Missing Venue ${index}`,
      pick(beers).name,
      venue?.suburb ?? pick(suburbs),
      "Synthetic venue/request signal.",
      createdAt,
      createdAt,
    );
  }

  for (let index = 0; index < 42; index += 1) {
    const venue = random() > 0.45 ? weightedPick(venueWeights) : null;
    const user = random() > 0.3 ? pick(normalUsers) : null;
    const feedbackType = pick(["bug", "wrong_data", "feature_idea", "general_feedback", "privacy_request"] as const);
    const createdAt = dayTimestamp(range.start, Math.floor(random() * range.dayCount), index, false);
    insertFeedback.run(
      `${TEST_PREFIX}:feedback:${index}`,
      user?.id ?? null,
      user ? null : `${TEST_PREFIX}:anon-feedback:${index}`,
      feedbackType,
      "Synthetic support/feedback item for launch rehearsal.",
      venue?.id ?? null,
      venue?.name ?? null,
      feedbackType === "privacy_request" ? "high" : "normal",
      feedbackType === "privacy_request" ? "privacy_request" : null,
      createdAt,
      createdAt,
    );
  }

  for (const venue of venues.filter((item) => !item.ownerId).slice(0, 8)) {
    const createdAt = dayTimestamp(range.start, Math.floor(random() * range.dayCount), Number(venue.id.at(-1) ?? "0"), false);
    insertInterest.run(
      `${TEST_PREFIX}:interest:${venue.id}`,
      null,
      venue.id,
      venue.name,
      `Fake Manager ${venue.name}`,
      `${venue.id.replaceAll(":", "-")}@pintpath.test`,
      "Synthetic unclaimed venue interest request.",
      createdAt,
      createdAt,
    );
  }

  return eventCount;
}

function generateMonthlyReports(database: BetterSqlite3.Database): number {
  const repository = new BusinessRepository(database);
  const service = new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    COMMERCIAL_LAUNCH_ENABLED: true,
    CONSUMER_PAID_ENROLLMENT_ENABLED: true,
    FIELD_TEST_MODE: false,
    PINT_POINTS_REWARDS_ENABLED: true,
    ALCOHOL_GAMIFICATION_ENABLED: true,
    SESSION_TTL_DAYS: 60,
    ADMIN_SESSION_TTL_DAYS: 7,
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
    ADMIN_MFA_MAX_AGE_MINUTES: 720,
    REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
    ANALYTICS_MIN_BUCKET_SIZE: Math.max(1, ANALYTICS_PRIVACY_FLOOR),
    REPORT_TIMEZONE: "Australia/Melbourne",
    REPORT_EMAIL_MODE: "disabled",
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    SOURCE_EVIDENCE_STORAGE_DIR: path.resolve("data/pintpath-release-source-evidence"),
    SOURCE_EVIDENCE_SIGNING_SECRET: "synthetic-release-readiness-only",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    SOURCE_EVIDENCE_RETENTION_DAYS: 30,
    POS_WEBHOOK_SIGNING_SECRET: "synthetic-release-readiness-pos-only",
    NODE_ENV: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    VENUE_PRO_TRIAL_DAYS: 60,
    VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: false,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
  });

  return service.generateScheduledVenueMonthlyReports({
    month: SIMULATION_MONTH,
    venueId: null,
    dryRun: false,
  }).generatedCount;
}

const range = monthRange(SIMULATION_MONTH);
const databasePath = assertSafeTarget();
const database = new BetterSqlite3(databasePath);
database.pragma("foreign_keys = ON");
initializeDatabaseSchema(database);

const now = new Date().toISOString();
const users = buildUsers(range);
const venues = buildVenues();

let generatedEvents = 0;
let generatedReports = 0;

database.transaction(() => {
  cleanupSyntheticRows(database);
  insertAccounts(database, users, now);
  insertVenues(database, venues, now);
  generatedEvents = insertActivity(database, users, venues, range);
})();

generatedReports = generateMonthlyReports(database);

database.close();

const normalUserCount = users.filter((user) => user.role === "user").length;
const ownerCount = users.filter((user) => user.role === "venue_manager").length;
const claimedBars = venues.filter((venue) => venue.ownerId).length;
const proBars = venues.filter((venue) => venue.tier === "pro").length;
const demoOwnerVenue = venues.find((venue) => venue.ownerId === DEMO_OWNER_ID && venue.tier === "pro" && venue.active) ?? null;

console.log(JSON.stringify({
  ok: true,
  databasePath,
  simulationMonth: SIMULATION_MONTH,
  dateRange: { start: range.startIso, endExclusive: range.endIso },
  fakeUsers: normalUserCount,
  venueReportOptInUsers: users.filter((user) => user.role === "user" && user.venueReportOptIn).length,
  fakeBarOwners: ownerCount,
  fakeBars: venues.length,
  claimedBars,
  unclaimedBars: venues.length - claimedBars,
  proBars,
  fakeInteractions: generatedEvents,
  generatedReports,
  randomSeed: RANDOM_SEED,
  demoVenueOwner: demoOwnerVenue ? {
    email: DEMO_OWNER_EMAIL,
    password: DEMO_OWNER_PASSWORD,
    venueId: demoOwnerVenue.id,
    portalUrl: `/venue-portal.html?venueId=${encodeURIComponent(demoOwnerVenue.id)}&month=${SIMULATION_MONTH}`,
  } : null,
  safety: "synthetic local/test data only; production targets refused",
}, null, 2));
