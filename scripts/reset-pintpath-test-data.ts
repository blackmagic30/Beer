import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { initializeDatabaseSchema } from "../src/db/database.js";

const TEST_PREFIX = "pintpath-release";
const DEFAULT_DATABASE_PATH = "data/pintpath-release-test.sqlite";

function assertSafeTarget(): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
  if (process.env.NODE_ENV === "production" || /https:\/\/pintpath\.au/i.test(publicBaseUrl)) {
    throw new Error("Refusing to reset synthetic release data against production. Use local, test, preview, or staging only.");
  }

  const databasePath = process.env.PINTPATH_TEST_DATABASE_PATH ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return databasePath;
}

const databasePath = assertSafeTarget();
const database = new BetterSqlite3(databasePath);
database.pragma("foreign_keys = ON");
initializeDatabaseSchema(database);

database.transaction(() => {
  const prefixLike = `${TEST_PREFIX}:%`;
  const testEmailLike = "%@pintpath.test";

  database.prepare("DELETE FROM events WHERE id LIKE ? OR anonymous_session_id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_analytics_events WHERE id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM saved_items WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM feedback WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM wrong_price_reports WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_requests WHERE id LIKE ? OR user_id LIKE ? OR anonymous_session_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_interest_requests WHERE id LIKE ? OR user_id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_pending_changes WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_specials WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_happy_hours WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_beers WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_manager_assignments WHERE id LIKE ? OR venue_id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_monthly_reports WHERE id LIKE ? OR venue_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM venue_profiles WHERE venue_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM verifications WHERE id LIKE ? OR verifier_user_id LIKE ? OR upload_id LIKE ?").run(prefixLike, prefixLike, prefixLike);
  database.prepare("DELETE FROM submission_items WHERE submission_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM submissions WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM contribution_ledger WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM user_activity_events WHERE id LIKE ? OR user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM source_evidence_objects WHERE id LIKE ? OR owner_user_id LIKE ?").run(prefixLike, prefixLike);
  database.prepare("DELETE FROM auth_sessions WHERE user_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM account_privacy_settings WHERE user_id LIKE ?").run(prefixLike);
  database.prepare("DELETE FROM profiles WHERE id LIKE ? OR email LIKE ?").run(prefixLike, testEmailLike);
  database.prepare("DELETE FROM accounts WHERE id LIKE ? OR email LIKE ?").run(prefixLike, testEmailLike);
})();

database.close();

console.log(`Removed synthetic Pint Path release data from ${databasePath}.`);
