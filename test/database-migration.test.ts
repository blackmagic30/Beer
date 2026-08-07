import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository } from "../src/db/business.repository.js";
import {
  createDatabase,
  CURRENT_DATABASE_SCHEMA_VERSION,
  initializeDatabaseSchema,
  openReadOnlyDatabase,
} from "../src/db/database.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("database schema migration safety", () => {
  it("backs up schema 13 and adds the encrypted account-deletion completion outbox in schema 15", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v13-notice-migration-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const legacy = createDatabase(databasePath);
    try {
      const repository = new BusinessRepository(legacy);
      const account = repository.createAccount({
        id: "schema-13-deletion-user",
        email: "schema-13-deletion@example.com",
        passwordHash: "test-password-hash",
        role: "user",
        subscriptionStatus: "free",
        now: "2026-08-03T01:00:00.000Z",
      });
      repository.createAccountDeletionRequest({
        id: "schema-13-deletion-request",
        userId: account.id,
        userMessage: "preserve this request",
        requestedAt: "2026-08-03T01:01:00.000Z",
        executeAfter: "2026-08-10T01:01:00.000Z",
      });
      legacy.exec(`
        DROP TABLE account_deletion_notification_events;
        DROP TABLE account_deletion_notice_recipient_secrets;
        DROP TABLE account_deletion_completion_outbox;
        PRAGMA user_version = 13;
      `);
    } finally {
      legacy.close();
    }

    const migrated = createDatabase(databasePath);
    try {
      expect(migrated.pragma("user_version", { simple: true })).toBe(15);
      expect(migrated.pragma("secure_delete", { simple: true })).toBe(1);
      for (const table of [
        "account_deletion_completion_outbox",
        "account_deletion_notice_recipient_secrets",
        "account_deletion_notification_events",
      ]) {
        expect(migrated.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeTruthy();
      }
      expect(migrated.prepare(
        "SELECT id, user_message FROM account_deletion_requests WHERE id = ?",
      ).get("schema-13-deletion-request")).toEqual({
        id: "schema-13-deletion-request",
        user_message: "preserve this request",
      });
      const indexNames = (migrated.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_deletion_completion_outbox'",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      expect(indexNames).toEqual(expect.arrayContaining([
        "idx_account_deletion_completion_outbox_due",
        "idx_account_deletion_completion_outbox_retention",
      ]));
    } finally {
      migrated.close();
    }

    const backupDirectory = path.join(root, "migration-backups");
    const backupName = fs.readdirSync(backupDirectory)
      .find((name) => name.startsWith("schema-13-to-15-"));
    expect(backupName).toBeTruthy();
    const backup = new BetterSqlite3(path.join(backupDirectory, backupName!));
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(13);
      expect(backup.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_deletion_completion_outbox'",
      ).get()).toBeUndefined();
    } finally {
      backup.close();
    }
  });

  it("backs up and upgrades an early schema-14 outbox before adding delivery safeguards", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v14-outbox-upgrade-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const backupCiphertextMarker = Buffer.from("MIGRATION_BACKUP_CIPHERTEXT_MARKER_20260803", "utf8");
    const early = createDatabase(databasePath);
    try {
      const repository = new BusinessRepository(early);
      const account = repository.createAccount({
        id: "early-v14-notice-user",
        email: "early-v14-notice@example.com",
        passwordHash: "test-password-hash",
        role: "user",
        subscriptionStatus: "free",
        now: "2026-08-03T01:00:00.000Z",
      });
      repository.createAccountDeletionRequest({
        id: "early-v14-notice-request",
        userId: account.id,
        userMessage: null,
        requestedAt: "2026-08-03T01:01:00.000Z",
        executeAfter: "2026-08-10T01:01:00.000Z",
      });
      early.prepare(
        `INSERT INTO account_deletion_completion_outbox (
           request_id, template_version, idempotency_key, status, created_at, updated_at
         ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
      ).run(
        "early-v14-notice-request",
        "pintpath-account-deletion/early-v14-notice-request",
        "2026-08-03T01:01:00.000Z",
        "2026-08-03T01:01:00.000Z",
      );
      early.prepare(
        `INSERT INTO account_deletion_notice_recipient_secrets (
           request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
         ) VALUES (?, 'early-key', ?, ?, ?, ?, ?)`,
      ).run(
        "early-v14-notice-request",
        Buffer.alloc(12, 1),
        backupCiphertextMarker,
        Buffer.alloc(16, 2),
        "2026-08-03T01:01:00.000Z",
        "2026-10-02T01:01:00.000Z",
      );
      early.exec("ALTER TABLE account_deletion_completion_outbox DROP COLUMN payload_fingerprint");
      early.exec("ALTER TABLE account_deletion_completion_outbox DROP COLUMN secret_purge_checkpoint_pending");
      early.exec("ALTER TABLE account_deletion_completion_outbox DROP COLUMN secret_purge_generation");
      expect((early.pragma("table_info(account_deletion_completion_outbox)") as Array<{ name: string }>)
        .some((column) => column.name === "payload_fingerprint")).toBe(false);
      expect((early.pragma("table_info(account_deletion_completion_outbox)") as Array<{ name: string }>)
        .some((column) => column.name === "secret_purge_checkpoint_pending")).toBe(false);
      expect((early.pragma("table_info(account_deletion_completion_outbox)") as Array<{ name: string }>)
        .some((column) => column.name === "secret_purge_generation")).toBe(false);
      early.pragma("user_version = 14");
    } finally {
      early.close();
    }

    const repaired = createDatabase(databasePath);
    try {
      const columns = repaired.pragma("table_info(account_deletion_completion_outbox)") as Array<{
        name: string;
        type: string;
      }>;
      expect(columns.find((candidate) => candidate.name === "payload_fingerprint"))
        .toEqual(expect.objectContaining({ name: "payload_fingerprint", type: "TEXT" }));
      expect(columns.find((candidate) => candidate.name === "secret_purge_checkpoint_pending"))
        .toEqual(expect.objectContaining({ name: "secret_purge_checkpoint_pending", type: "INTEGER" }));
      expect(columns.find((candidate) => candidate.name === "secret_purge_generation"))
        .toEqual(expect.objectContaining({ name: "secret_purge_generation", type: "INTEGER" }));
      expect(repaired.pragma("user_version", { simple: true })).toBe(15);
    } finally {
      repaired.close();
    }

    const backupDirectory = path.join(root, "migration-backups");
    const backupName = fs.readdirSync(backupDirectory)
      .find((name) => name.startsWith("schema-14-to-15-"));
    expect(backupName).toBeTruthy();
    const backup = new BetterSqlite3(path.join(backupDirectory, backupName!));
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(14);
      const backupColumns = backup.pragma("table_info(account_deletion_completion_outbox)") as Array<{ name: string }>;
      expect(backupColumns.some((column) => column.name === "payload_fingerprint")).toBe(false);
      expect(backupColumns.some((column) => column.name === "secret_purge_checkpoint_pending")).toBe(false);
      expect(backupColumns.some((column) => column.name === "secret_purge_generation")).toBe(false);
      expect(backup.prepare(
        "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets",
      ).get()).toEqual({ count: 0 });
      expect(backup.prepare(
        "SELECT status FROM account_deletion_completion_outbox WHERE request_id = ?",
      ).get("early-v14-notice-request")).toEqual({ status: "purged" });
    } finally {
      backup.close();
    }
    expect(fs.readFileSync(path.join(backupDirectory, backupName!)).includes(backupCiphertextMarker)).toBe(false);
  });

  it("preserves the policy version an account actually consented to when the database reopens", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-consent-provenance-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const database = createDatabase(databasePath);
    const recordedAt = "2026-07-12T01:00:00.000Z";
    try {
      const repository = new BusinessRepository(database);
      const account = repository.createAccount({
        id: "consent-provenance-user",
        email: "consent-provenance@example.com",
        passwordHash: "test-password-hash",
        role: "user",
        subscriptionStatus: "free",
        now: recordedAt,
      });
      repository.upsertAccountPrivacySettings({
        userId: account.id,
        optionalAnalyticsEnabled: false,
        venueReportInclusionEnabled: false,
        productResearchEnabled: false,
        emailUpdatesEnabled: false,
        consentVersion: "2026-07-12",
        now: recordedAt,
      });
    } finally {
      database.close();
    }

    const reopened = createDatabase(databasePath);
    try {
      expect(reopened.prepare(
        "SELECT consent_version, consented_at, updated_at FROM account_privacy_settings WHERE user_id = ?",
      ).get("consent-provenance-user")).toEqual({
        consent_version: "2026-07-12",
        consented_at: recordedAt,
        updated_at: recordedAt,
      });
    } finally {
      reopened.close();
    }
  });

  it("opens an attested restore database read-only without changing its bytes across app reads or reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-read-only-restore-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    createDatabase(databasePath).close();
    const normalized = new BetterSqlite3(databasePath, { fileMustExist: true });
    try {
      expect(normalized.pragma("journal_mode = DELETE", { simple: true })).toBe("delete");
    } finally {
      normalized.close();
    }

    const originalBytes = fs.readFileSync(databasePath);
    const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");
    const originalEntries = fs.readdirSync(root).sort();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = openReadOnlyDatabase(databasePath);
      try {
        expect(restored.pragma("query_only", { simple: true })).toBe(1);
        expect(restored.pragma("user_version", { simple: true })).toBe(CURRENT_DATABASE_SCHEMA_VERSION);

        const repository = new BusinessRepository(restored);
        expect(repository.listPublicVenueDirectoryPage({ limit: 20, offset: 0 })).toEqual({
          venues: [],
          total: 0,
        });
        expect(repository.listCurrentPriceRecordPage({ limit: 20 })).toEqual([]);
        expect(() => restored.prepare("DELETE FROM venue_profiles").run()).toThrow();
      } finally {
        restored.close();
      }
    }

    const finalBytes = fs.readFileSync(databasePath);
    expect(finalBytes.byteLength).toBe(originalBytes.byteLength);
    expect(crypto.createHash("sha256").update(finalBytes).digest("hex")).toBe(originalHash);
    expect(finalBytes.equals(originalBytes)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual(originalEntries);
  });

  it("rejects a restore database at any other schema version without migrating or creating files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-read-only-schema-"));
    roots.push(root);
    const databasePath = path.join(root, "pint-path.sqlite");
    const legacy = new BetterSqlite3(databasePath);
    legacy.exec(`
      CREATE TABLE preserved (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO preserved VALUES ('before', 'unchanged');
      PRAGMA user_version = ${CURRENT_DATABASE_SCHEMA_VERSION - 1};
    `);
    legacy.close();
    const originalBytes = fs.readFileSync(databasePath);

    expect(() => openReadOnlyDatabase(databasePath)).toThrow(
      `does not exactly match the supported version (${CURRENT_DATABASE_SCHEMA_VERSION})`,
    );
    expect(fs.readFileSync(databasePath).equals(originalBytes)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual(["pint-path.sqlite"]);
  });

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
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(15);
      expect(migrated.pragma("user_version", { simple: true })).toBe(15);
      expect((migrated.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("provider_session_id_hash");
      expect((migrated.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("provider_tokens_valid_after");
      expect((migrated.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("stripe_paid_subscription_status");
      expect((migrated.prepare("PRAGMA table_info(venue_profiles)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("stripe_paid_membership_tier");
      expect((migrated.prepare("PRAGMA table_info(venue_profiles)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("subscription_current_period_end");
      expect((migrated.prepare("PRAGMA table_info(venue_profiles)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toContain("intro_trial_ever_claimed");
      expect(migrated.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_checkout_reservations'",
      ).get()).toBeTruthy();
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
      const backupNames = fs.readdirSync(backupDirectory)
        .filter((name) => name.startsWith(`schema-6-to-${CURRENT_DATABASE_SCHEMA_VERSION}-`));
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
    expect(fs.readdirSync(path.join(root, "migration-backups"))
      .some((name) => name.startsWith(`schema-6-to-${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
      .toBe(true);
  });
});
