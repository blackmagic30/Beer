import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import {
  createDatabase,
  CURRENT_DATABASE_SCHEMA_VERSION,
  initializeDatabaseSchema,
} from "../src/db/database.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("database schema migration safety", () => {
  it("backs up v6 before migrating provider-session containment and reconciles legacy uniqueness conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v6-migration-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const legacy = new BetterSqlite3(databasePath);
    initializeDatabaseSchema(legacy);
    const repository = new BusinessRepository(legacy);
    const now = "2026-07-14T01:00:00.000Z";
    const account = repository.createAccount({
      id: "migration-user",
      email: "migration-user@example.com",
      passwordHash: "test-password-hash",
      role: "user",
      subscriptionStatus: "free",
      now,
    });
    repository.createSession({
      tokenHash: "migration-session-hash",
      userId: account.id,
      createdAt: now,
      expiresAt: "2027-07-14T01:00:00.000Z",
    });

    legacy.exec(`
      DROP INDEX IF EXISTS idx_account_deletion_requests_open_user;
      DROP INDEX IF EXISTS idx_account_deletion_requests_unfinished_user;
      DROP INDEX IF EXISTS idx_discount_redemptions_idempotency;
      DROP INDEX IF EXISTS idx_discount_redemptions_pass_once;
      DROP INDEX IF EXISTS idx_pint_point_drink_records_idempotency;
      DROP INDEX IF EXISTS idx_pint_point_drink_records_member_pass_once;
      DROP INDEX IF EXISTS idx_auth_sessions_provider_session;
      DROP TABLE IF EXISTS revoked_provider_sessions;
      ALTER TABLE auth_sessions DROP COLUMN provider_session_id_hash;
      ALTER TABLE accounts DROP COLUMN provider_tokens_valid_after;
      ALTER TABLE accounts DROP COLUMN stripe_paid_subscription_status;
      ALTER TABLE venue_profiles DROP COLUMN stripe_paid_membership_tier;

      INSERT INTO account_discount_passes (
        id, user_id, session_token_hash, code_hash, status, created_at, expires_at
      ) VALUES (
        'migration-pass', 'migration-user', 'migration-session-hash', 'migration-code-hash',
        'used', '2026-07-14T01:00:00.000Z', '2026-07-14T02:00:00.000Z'
      );

      INSERT INTO account_deletion_requests (
        id, user_id, status, requested_at, execute_after, created_at, updated_at
      ) VALUES
        ('deletion-processing', 'migration-user', 'processing', '2026-07-13T00:00:00.000Z', '2026-07-20T00:00:00.000Z', '2026-07-13T00:00:00.000Z', '2026-07-14T00:00:00.000Z'),
        ('deletion-failed', 'migration-user', 'failed', '2026-07-14T00:00:00.000Z', '2026-07-21T00:00:00.000Z', '2026-07-14T00:00:00.000Z', '2026-07-14T00:30:00.000Z');

      INSERT INTO discount_redemptions (
        id, user_id, public_account_id, venue_id, venue_name, item_name, quantity,
        estimated_savings_cents, discount_pass_id, idempotency_key, redeemed_at, metadata_json, created_at
      ) VALUES
        ('redemption-original', 'migration-user', '${account.publicAccountId}', 'migration-venue', 'Migration Venue', 'Pint', 1, 200, 'migration-pass', 'duplicate-redemption', '2026-07-14T01:01:00.000Z', '{}', '2026-07-14T01:01:00.000Z'),
        ('redemption-duplicate', 'migration-user', '${account.publicAccountId}', 'migration-venue', 'Migration Venue', 'Pint', 1, 200, 'migration-pass', 'duplicate-redemption', '2026-07-14T01:02:00.000Z', '{}', '2026-07-14T01:02:00.000Z');

      INSERT INTO pint_point_drink_records (
        id, user_id, venue_id, venue_name, item_name, quantity, is_alcoholic, points_awarded,
        source, idempotency_key, status, recorded_at, metadata_json, created_at
      ) VALUES
        ('drink-original', 'migration-user', 'migration-venue', 'Migration Venue', 'Pint', 1, 1, 1, 'venue_portal', 'member-pass:duplicate', 'active', '2026-07-14T01:03:00.000Z', '{}', '2026-07-14T01:03:00.000Z'),
        ('drink-duplicate', 'migration-user', 'migration-venue', 'Migration Venue', 'Pint', 1, 1, 1, 'venue_portal', 'member-pass:duplicate', 'active', '2026-07-14T01:04:00.000Z', '{}', '2026-07-14T01:04:00.000Z');

      INSERT INTO pint_point_ledger (
        id, user_id, venue_id, drink_record_id, type, points_delta, points_reserved_delta,
        description, created_at, metadata_json
      ) VALUES
        ('ledger-original', 'migration-user', 'migration-venue', 'drink-original', 'drink_scan', 1, 0, 'Original point', '2026-07-14T01:03:00.000Z', '{}'),
        ('ledger-duplicate', 'migration-user', 'migration-venue', 'drink-duplicate', 'drink_scan', 1, 0, 'Duplicate point', '2026-07-14T01:04:00.000Z', '{}');

      PRAGMA user_version = 6;
    `);
    legacy.close();

    const migrated = createDatabase(databasePath);
    try {
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(11);
      expect(migrated.pragma("user_version", { simple: true })).toBe(11);
      expect((migrated.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("provider_session_id_hash");
      expect((migrated.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("provider_tokens_valid_after");
      expect((migrated.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("stripe_paid_subscription_status");
      expect((migrated.prepare("PRAGMA table_info(venue_profiles)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("stripe_paid_membership_tier");
      expect(migrated.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revoked_provider_sessions'",
      ).get()).toBeTruthy();

      const deletionRows = migrated.prepare(
        "SELECT id, status, result_summary_json FROM account_deletion_requests ORDER BY id",
      ).all() as Array<{ id: string; status: string; result_summary_json: string | null }>;
      expect(deletionRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "deletion-processing", status: "processing" }),
        expect.objectContaining({ id: "deletion-failed", status: "cancelled" }),
      ]));
      expect(deletionRows.find((row) => row.id === "deletion-failed")?.result_summary_json)
        .toContain("migrationReconciledDuplicate");

      expect(migrated.prepare(
        "SELECT count(*) AS count, sum(estimated_savings_cents) AS savings FROM discount_redemptions",
      ).get()).toEqual({ count: 1, savings: 200 });
      const quarantinedRedemption = migrated.prepare(
        "SELECT original_id, reason, payload_json FROM migration_quarantined_records WHERE entity_type = 'discount_redemption'",
      ).get() as { original_id: string; reason: string; payload_json: string };
      expect(quarantinedRedemption).toEqual(expect.objectContaining({
        original_id: "redemption-duplicate",
        reason: "duplicate_discount_pass",
      }));
      expect(quarantinedRedemption.payload_json).toContain("duplicate-redemption");

      const duplicateDrink = migrated.prepare(
        "SELECT status, idempotency_key, void_reason, metadata_json FROM pint_point_drink_records WHERE id = 'drink-duplicate'",
      ).get() as { status: string; idempotency_key: string | null; void_reason: string; metadata_json: string };
      expect(duplicateDrink).toEqual(expect.objectContaining({ status: "void", idempotency_key: null }));
      expect(duplicateDrink.void_reason).toContain("Migration quarantined");
      expect(migrated.prepare(
        "SELECT sum(points_delta) AS points FROM pint_point_ledger WHERE user_id = 'migration-user'",
      ).get()).toEqual({ points: 1 });

      const backupDirectory = path.join(root, "migration-backups");
      const backupNames = fs.readdirSync(backupDirectory).filter((name) => name.startsWith("schema-6-to-11-"));
      expect(backupNames).toHaveLength(1);
      const backup = new BetterSqlite3(path.join(backupDirectory, backupNames[0]!));
      try {
        expect(backup.pragma("user_version", { simple: true })).toBe(6);
        expect((backup.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>)
          .map((column) => column.name)).not.toContain("provider_session_id_hash");
        expect(backup.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revoked_provider_sessions'",
        ).get()).toBeUndefined();
        expect(backup.prepare("SELECT count(*) AS count FROM discount_redemptions").get()).toEqual({ count: 2 });
      } finally {
        backup.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("rolls back a failed migration, preserves v6, and releases the database handle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v6-rollback-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const legacy = new BetterSqlite3(databasePath);
    legacy.exec(`
      CREATE TABLE migration_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO migration_probe VALUES ('before', 'preserved');
      CREATE VIEW auth_sessions AS SELECT id AS token_hash FROM migration_probe;
      PRAGMA user_version = 6;
    `);
    legacy.close();

    expect(() => createDatabase(databasePath)).toThrow();

    const reopened = new BetterSqlite3(databasePath);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(6);
      expect(reopened.prepare("SELECT * FROM migration_probe").get()).toEqual({ id: "before", value: "preserved" });
      expect(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get())
        .toBeUndefined();
    } finally {
      reopened.close();
    }
    expect(fs.readdirSync(path.join(root, "migration-backups")).some((name) => name.startsWith("schema-6-to-11-")))
      .toBe(true);
  });
});
