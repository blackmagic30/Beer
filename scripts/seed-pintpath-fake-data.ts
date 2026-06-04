import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { initializeDatabaseSchema } from "../src/db/database.js";

const TEST_PREFIX = "pintpath-release";
const DEFAULT_DATABASE_PATH = "data/pintpath-release-test.sqlite";
const SIMULATION_MONTH = process.env.PINTPATH_FAKE_MONTH ?? "2026-05";
const USER_COUNT = Number(process.env.PINTPATH_FAKE_USER_COUNT ?? 420);
const BAR_COUNT = Number(process.env.PINTPATH_FAKE_BAR_COUNT ?? 48);
const OWNER_COUNT = Number(process.env.PINTPATH_FAKE_OWNER_COUNT ?? 12);
const ANALYTICS_PRIVACY_FLOOR = Number(process.env.ANALYTICS_MIN_BUCKET_SIZE ?? 5);

type Tier = "basic" | "plus" | "pro";

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
}

function monthRange(month: string): { start: Date; end: Date; startIso: string; endIso: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("PINTPATH_FAKE_MONTH must use YYYY-MM, for example 2026-05.");
  }

  const [yearPart, monthPart] = month.split("-");
  const year = Number(yearPart);
  const monthNumber = Number(monthPart);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error("PINTPATH_FAKE_MONTH must use a valid YYYY-MM month.");
  }

  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0, 0));
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
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

const random = mulberry32(0x70696e74);

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
  date.setUTCHours(hour, sequence % 60, Math.floor(random() * 60), 0);
  return date.toISOString();
}

function cleanupSyntheticRows(database: BetterSqlite3.Database): void {
  const prefixLike = `${TEST_PREFIX}:%`;
  const testEmailLike = "%@pintpath.test";

  database.prepare("DELETE FROM events WHERE id LIKE ? OR anonymous_session_id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
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
  { name: "Carlton Draft", brewery: "Carlton & United Breweries", style: "Lager", price: 11 },
  { name: "Stone & Wood Pacific Ale", brewery: "Stone & Wood", style: "Pacific Ale", price: 12 },
  { name: "Balter XPA", brewery: "Balter", style: "XPA", price: 13 },
  { name: "Mountain Goat Steam Ale", brewery: "Mountain Goat", style: "Ale", price: 12 },
  { name: "Young Henrys Newtowner", brewery: "Young Henrys", style: "Ale", price: 12 },
];
const searchTerms = ["guinness", "lager", "stout", "xpa", "happy hour", "rooftop", "live music", "cheap pint", "craft beer"];

function buildUsers(range: ReturnType<typeof monthRange>): FakeUser[] {
  const users: FakeUser[] = [];
  for (let index = 0; index < USER_COUNT; index += 1) {
    const createdDay = Math.floor(random() * 30);
    const paidRoll = random();
    users.push({
      id: `${TEST_PREFIX}:user:${String(index + 1).padStart(4, "0")}`,
      email: `user-${String(index + 1).padStart(4, "0")}@pintpath.test`,
      role: "user",
      subscription: paidRoll > 0.94 ? "premium_yearly" : paidRoll > 0.86 ? "premium_monthly" : "free",
      displayName: `Fake User ${index + 1}`,
      createdAt: dayTimestamp(range.start, createdDay, index, false),
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
    });
  }

  users.push({
    id: `${TEST_PREFIX}:admin`,
    email: "admin@pintpath.test",
    role: "admin",
    subscription: "admin",
    displayName: "Fake Admin",
    createdAt: range.startIso,
  });

  return users;
}

function buildVenues(): FakeVenue[] {
  const venueWords = ["Arms", "Hotel", "Taproom", "Cellar", "Social", "House", "Roof", "Club", "Lounge", "Yard"];
  const venues: FakeVenue[] = [];
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const tier: Tier = index % 10 === 0 || index % 13 === 0 ? "pro" : index % 4 === 0 || index % 7 === 0 ? "plus" : "basic";
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
  const insertAccount = database.prepare(`
    INSERT INTO accounts (
      id, public_account_id, email, password_hash, display_name, auth_provider, email_verified_at,
      role, age_confirmed_at, terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
      subscription_status, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'synthetic-test-hash', ?, 'local', ?, ?, ?, ?, ?, '2026-05-24', '2026-05-24', ?, 'active', ?, ?)
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
    const optsOut = user.role === "user" && index % 17 === 0;
    insertPrivacy.run(user.id, optsOut ? 0 : 1, optsOut ? 0 : 1, now, now);
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
      venue.tier === "pro" ? "Pro" : venue.tier === "plus" ? "Plus" : null,
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
        venue.tier === "pro" ? "Pro featured pint path special" : "Plus happy-hour feature",
        "Synthetic Plus/Pro special for report and portal testing.",
        venue.tier === "pro" ? 9 : 10,
        venue.tier === "pro" ? "Featured" : "Plus",
        "Visible only because this fake venue is Plus/Pro.",
        venue.tier === "pro" ? 1 : 0,
        now,
        now,
      );
    }
  });
}

function insertActivity(database: BetterSqlite3.Database, users: FakeUser[], venues: FakeVenue[], range: ReturnType<typeof monthRange>): number {
  const normalUsers = users.filter((user) => user.role === "user");
  const activeVenues = venues.filter((venue) => venue.active);
  const venueWeights = activeVenues.map((venue, index) => ({
    value: venue,
    weight: (venue.tier === "pro" ? 2.4 : venue.tier === "plus" ? 1.55 : 1) * (index < 8 ? 1.8 : 1),
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
    "price_view_revealed",
    "happy_hour_active_now_used",
    "venue_lookup",
    "saved_venue_added",
    "saved_night_plan_added",
    "venue_shared",
    "share_link_copied",
  ];

  for (let dayIndex = 0; dayIndex < 30; dayIndex += 1) {
    const date = addDays(range.start, dayIndex);
    if (date >= range.end) {
      break;
    }
    const isWeekend = [5, 6].includes(date.getUTCDay());
    const eventsToday = isWeekend ? 390 : 190;
    for (let sequence = 0; sequence < eventsToday; sequence += 1) {
      const venue = weightedPick(venueWeights);
      const user = random() > 0.28 ? pick(normalUsers) : null;
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
              value === "price_view_revealed" ? 2 :
              value.startsWith("saved") ? 0.5 :
              value.includes("shared") || value.includes("share") ? 0.35 :
              1,
          })));
      const searchTerm = pick(searchTerms);
      const beerId = eventType === "beer_search_performed" ? searchTerm : random() > 0.72 ? pick(beers).name.toLowerCase() : null;
      const eventVenue = isSearch && random() > 0.22 ? null : venue;
      const createdAt = dayTimestamp(range.start, dayIndex, sequence);
      const anonymousSessionId = user ? null : `${TEST_PREFIX}:anon:${dayIndex}:${sequence}`;

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
        insertVenueAnalytics.run(
          `${TEST_PREFIX}:venue-analytics:${dayIndex}:${sequence}`,
          null,
          venue.area,
          venue.suburb,
          random() > 0.35 ? "beer_style_search" : "beer_search",
          searchTerm,
          eventType === "beer_search_performed" ? searchTerm : null,
          pick(["lager", "stout", "xpa", "ale", "pilsner"]),
          createdAt,
        );
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

  for (let index = 0; index < 65; index += 1) {
    const venue = weightedPick(venueWeights);
    const user = random() > 0.25 ? pick(normalUsers) : null;
    const createdAt = dayTimestamp(range.start, Math.floor(random() * 30), index);
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
    const createdAt = dayTimestamp(range.start, Math.floor(random() * 30), index, false);
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
    const createdAt = dayTimestamp(range.start, Math.floor(random() * 30), index, false);
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
    const createdAt = dayTimestamp(range.start, Math.floor(random() * 30), Number(venue.id.at(-1) ?? "0"), false);
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

function generateMonthlyReports(database: BetterSqlite3.Database, venues: FakeVenue[], range: ReturnType<typeof monthRange>, now: string): number {
  const insertReport = database.prepare(`
    INSERT INTO venue_monthly_reports (id, venue_id, month, data_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(venue_id, month) DO UPDATE SET data_json = excluded.data_json
  `);
  const countEvents = (venueId: string, eventTypes: string[]) => {
    const placeholders = eventTypes.map(() => "?").join(", ");
    const row = database.prepare(`
      SELECT count(*) AS count
      FROM events
      WHERE venue_id = ?
        AND event_type IN (${placeholders})
        AND created_at >= ?
        AND created_at < ?
    `).get(venueId, ...eventTypes, range.startIso, range.endIso) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  };
  const topSearches = (suburb: string) =>
    database.prepare(`
      SELECT COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'search') AS key, count(*) AS count
      FROM events
      WHERE event_type IN ('beer_search_performed', 'search_performed', 'suburb_search_performed')
        AND lower(COALESCE(suburb, '')) = lower(?)
        AND created_at >= ?
        AND created_at < ?
      GROUP BY COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'search')
      HAVING count(*) >= ?
      ORDER BY count DESC
      LIMIT 6
    `).all(suburb, range.startIso, range.endIso, ANALYTICS_PRIVACY_FLOOR) as Array<{ key: string; count: number }>;

  let reports = 0;
  for (const venue of venues.filter((item) => item.tier !== "basic")) {
    const summary = {
      generated: true,
      synthetic: true,
      month: SIMULATION_MONTH,
      venueTier: venue.tier,
      totalBarLookups: countEvents(venue.id, ["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"]),
      totalProfileViews: countEvents(venue.id, ["venue_detail_opened", "venue_profile_viewed", "venue_portal_viewed"]),
      totalBeerListViews: countEvents(venue.id, ["beer_list_viewed", "price_view_revealed", "venue_detail_opened"]),
      totalSpecialsDealsViews: countEvents(venue.id, ["deal_viewed", "special_viewed", "happy_hour_active_now_used", "happy_hour_near_me_used"]),
      mapMarkerClicks: countEvents(venue.id, ["map_pin_click"]),
      savesAndNightPlanAdds: countEvents(venue.id, ["saved_venue_added", "saved_night_plan_added"]),
      shares: countEvents(venue.id, ["venue_shared", "share_link_copied"]),
      mostSearchedBeersInArea: topSearches(venue.suburb),
      suggestedActions: [
        "Keep beer rows and happy-hour times fresh before Thursday evening.",
        venue.tier === "pro" ? "Use Pro visibility on Friday/Saturday peaks." : "Upgrade to Pro if you want a stronger listing treatment.",
      ],
      privacy: {
        aggregateOnly: true,
        suppressedBelowCount: ANALYTICS_PRIVACY_FLOOR,
        excludesUserEmails: true,
        excludesSessionIds: true,
        excludesExactLocation: true,
      },
    };
    insertReport.run(
      `${TEST_PREFIX}:monthly-report:${venue.id}:${SIMULATION_MONTH}`,
      venue.id,
      SIMULATION_MONTH,
      JSON.stringify({ summary }),
      now,
    );
    reports += 1;
  }

  return reports;
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
  generatedReports = generateMonthlyReports(database, venues, range, now);
})();

database.close();

const normalUserCount = users.filter((user) => user.role === "user").length;
const ownerCount = users.filter((user) => user.role === "venue_manager").length;
const claimedBars = venues.filter((venue) => venue.ownerId).length;
const plusBars = venues.filter((venue) => venue.tier === "plus").length;
const proBars = venues.filter((venue) => venue.tier === "pro").length;

console.log(JSON.stringify({
  ok: true,
  databasePath,
  simulationMonth: SIMULATION_MONTH,
  dateRange: { start: range.startIso, endExclusive: range.endIso },
  fakeUsers: normalUserCount,
  fakeBarOwners: ownerCount,
  fakeBars: venues.length,
  claimedBars,
  unclaimedBars: venues.length - claimedBars,
  plusBars,
  proBars,
  fakeInteractions: generatedEvents,
  generatedReports,
  safety: "synthetic local/test data only; production targets refused",
}, null, 2));
