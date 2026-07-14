import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { env } from "../config/env.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../config/legal.js";
import { BeerCatalogRepository, syncStaticBeerCatalog } from "./beer-catalog.repository.js";
import { isLikelyBeerName } from "../constants/beers.js";

export const CURRENT_DATABASE_SCHEMA_VERSION = 11;
const MIGRATION_BACKUP_RETENTION = 3;
export const MIGRATION_BACKUP_MAX_AGE_DAYS = 30;

function splitSchemaIndexes(schema: string): { baseSchema: string; indexSchema: string } {
  const indexPattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b[\s\S]*?;\s*/gi;
  const indexes = schema.match(indexPattern) ?? [];
  return {
    baseSchema: schema.replace(indexPattern, ""),
    indexSchema: indexes.join("\n"),
  };
}

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
  { name: "stripe_paid_membership_tier", definition: "TEXT" },
  { name: "tier_manual_override", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "accepts_pint_path_codes", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "stripe_event_created_at", definition: "TEXT" },
  { name: "pos_webhook_token_version", definition: "INTEGER NOT NULL DEFAULT 1" },
  { name: "pos_previous_token_version", definition: "INTEGER" },
  { name: "pos_previous_token_valid_until", definition: "TEXT" },
  { name: "pos_last_success_at", definition: "TEXT" },
  { name: "pos_last_terminal_id", definition: "TEXT" },
] as const;

const venueAnalyticsEventsColumns = [
  { name: "suburb", definition: "TEXT" },
] as const;

const venueSpecialsColumns = [
  { name: "start_time", definition: "TEXT" },
  { name: "end_time", definition: "TEXT" },
  { name: "savings_amount_cents", definition: "INTEGER" },
  { name: "recurrence_frequency", definition: "TEXT NOT NULL DEFAULT 'none'" },
  { name: "days_of_week_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "timezone", definition: "TEXT NOT NULL DEFAULT 'Australia/Melbourne'" },
] as const;

const venueHappyHoursColumns = [
  { name: "happy_hour_beers_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
] as const;

const authSessionsColumns = [
  { name: "provider_session_id_hash", definition: "TEXT" },
  { name: "revoked_at", definition: "TEXT" },
  { name: "last_used_at", definition: "TEXT" },
  { name: "last_ip_hash", definition: "TEXT" },
  { name: "user_agent_hash", definition: "TEXT" },
] as const;

const discountRedemptionColumns = [
  { name: "idempotency_key", definition: "TEXT" },
] as const;

const pintPointDrinkRecordColumns = [
  { name: "points_awarded", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "idempotency_key", definition: "TEXT" },
  { name: "status", definition: "TEXT NOT NULL DEFAULT 'active'" },
  { name: "voided_at", definition: "TEXT" },
  { name: "voided_by_user_id", definition: "TEXT" },
  { name: "void_reason", definition: "TEXT" },
] as const;

const venueManagerAssignmentColumns = [
  { name: "access_level", definition: "TEXT NOT NULL DEFAULT 'manager'" },
  { name: "expires_at", definition: "TEXT" },
] as const;

const venueClaimRequestColumns = [
  { name: "review_note", definition: "TEXT" },
  { name: "reviewed_by", definition: "TEXT" },
  { name: "reviewed_at", definition: "TEXT" },
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
  { name: "provider_tokens_valid_after", definition: "TEXT" },
  { name: "stripe_paid_subscription_status", definition: "TEXT" },
  { name: "terms_accepted_at", definition: "TEXT" },
  { name: "privacy_accepted_at", definition: "TEXT" },
  { name: "terms_version", definition: "TEXT" },
  { name: "privacy_version", definition: "TEXT" },
  { name: "age_verification_status", definition: "TEXT NOT NULL DEFAULT 'not_started'" },
  { name: "is_over_18_verified", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "stripe_event_created_at", definition: "TEXT" },
] as const;

const stripeWebhookEventColumns = [
  { name: "status", definition: "TEXT NOT NULL DEFAULT 'applied'" },
  { name: "event_created_at", definition: "TEXT" },
  { name: "payload_json", definition: "TEXT" },
  { name: "attempts", definition: "INTEGER NOT NULL DEFAULT 1" },
  { name: "last_error", definition: "TEXT" },
  { name: "received_at", definition: "TEXT" },
  { name: "applied_at", definition: "TEXT" },
  { name: "processing_token", definition: "TEXT" },
] as const;

const profilesColumns = [
  { name: "public_account_id", definition: "TEXT" },
  { name: "display_name_key", definition: "TEXT" },
] as const;

const submissionColumns = [
  { name: "client_submission_id", definition: "TEXT" },
  { name: "mission_id", definition: "TEXT" },
  { name: "ocr_status", definition: "TEXT NOT NULL DEFAULT 'not_requested'" },
  { name: "ocr_summary_json", definition: "TEXT" },
  { name: "upload_latitude", definition: "REAL" },
  { name: "upload_longitude", definition: "REAL" },
  { name: "upload_accuracy_meters", definition: "REAL" },
  { name: "upload_location_captured_at", definition: "TEXT" },
  { name: "distance_to_venue_meters", definition: "REAL" },
  { name: "points_eligible_by_location", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "points_eligibility_reason", definition: "TEXT" },
  { name: "pending_venue_json", definition: "TEXT" },
] as const;

const submissionItemColumns = [
  { name: "capture_source", definition: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: "source_text", definition: "TEXT" },
  { name: "requires_catalog_approval", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const feedbackColumns = [
  { name: "priority", definition: "TEXT NOT NULL DEFAULT 'normal'" },
  { name: "triage_reason", definition: "TEXT" },
  { name: "contact_email", definition: "TEXT" },
  { name: "assigned_to", definition: "TEXT" },
  { name: "resolution_note", definition: "TEXT" },
  { name: "resolved_at", definition: "TEXT" },
  { name: "resolved_by", definition: "TEXT" },
] as const;

const trustWorkflowColumns = [
  { name: "assigned_to", definition: "TEXT" },
  { name: "resolution_note", definition: "TEXT" },
  { name: "resolved_at", definition: "TEXT" },
  { name: "resolved_by", definition: "TEXT" },
] as const;

const venueRequestColumns = [
  { name: "google_place_id", definition: "TEXT" },
  { name: "source_submission_id", definition: "TEXT" },
] as const;

const accountPrivacySettingsColumns = [
  { name: "consent_version", definition: "TEXT NOT NULL DEFAULT '2026-07-12'" },
  { name: "consented_at", definition: "TEXT" },
] as const;

const sourceEvidenceColumns = [
  { name: "retention_expires_at", definition: "TEXT" },
  { name: "deleted_at", definition: "TEXT" },
] as const;

const accountDeletionRequestColumns = [
  { name: "processing_started_at", definition: "TEXT" },
  { name: "identity_deleted_at", definition: "TEXT" },
  { name: "stripe_customer_deleted_at", definition: "TEXT" },
  { name: "stripe_customer_id_snapshot", definition: "TEXT" },
  { name: "deletion_tombstone_recorded_at", definition: "TEXT" },
  { name: "last_error", definition: "TEXT" },
  { name: "attempt_count", definition: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const venuePartnerOutreachColumns = [
  { name: "tier_fit", definition: "TEXT" },
  { name: "next_action", definition: "TEXT" },
  { name: "last_contacted_at", definition: "TEXT" },
] as const;

const adminIngestionQueueColumns = [
  { name: "crawler_feedback_json", definition: "TEXT" },
  { name: "image_retention_expires_at", definition: "TEXT" },
  { name: "image_redacted_at", definition: "TEXT" },
  { name: "image_redaction_reason", definition: "TEXT" },
  { name: "review_claim_token", definition: "TEXT" },
  { name: "review_claimed_at", definition: "TEXT" },
] as const;

const venueBeersColumns = [
  { name: "normalized_beer_id", definition: "TEXT" },
  { name: "price_verified_at", definition: "TEXT" },
  { name: "stock_verified_at", definition: "TEXT" },
  { name: "source_ingestion_id", definition: "TEXT" },
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

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_provider_session
      ON auth_sessions (user_id, provider_session_id_hash);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_requests_unfinished_user
      ON account_deletion_requests (user_id)
      WHERE status IN ('pending_review', 'approved', 'processing', 'failed');

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_redemptions_idempotency
      ON discount_redemptions (venue_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_redemptions_pass_once
      ON discount_redemptions (discount_pass_id)
      WHERE discount_pass_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_user
      ON pint_point_drink_records (user_id, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_venue
      ON pint_point_drink_records (venue_id, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_venue_status
      ON pint_point_drink_records (venue_id, status, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_suburb
      ON pint_point_drink_records (suburb, recorded_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pint_point_drink_records_idempotency
      ON pint_point_drink_records (venue_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pint_point_drink_records_member_pass_once
      ON pint_point_drink_records (idempotency_key)
      WHERE idempotency_key LIKE 'member-pass:%';

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

    CREATE INDEX IF NOT EXISTS idx_source_evidence_retention
      ON source_evidence_objects (deleted_at, retention_expires_at);

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

    CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
      ON stripe_webhook_events (status, received_at);

    CREATE INDEX IF NOT EXISTS idx_discount_redemptions_redeemed_by
      ON discount_redemptions (redeemed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_discount_redemptions_pass
      ON discount_redemptions (discount_pass_id);
    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_recorded_by
      ON pint_point_drink_records (recorded_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_voided_by
      ON pint_point_drink_records (voided_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_reward
      ON pint_point_drink_records (reward_code_id);
    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_redeemed_by
      ON free_pint_reward_codes (redeemed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_redeemed_by
      ON free_pint_reward_redemptions (redeemed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_reward
      ON free_pint_reward_redemptions (reward_code_id);
    CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_reward
      ON pint_point_ledger (reward_code_id);
    CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_drink
      ON pint_point_ledger (drink_record_id);
    CREATE INDEX IF NOT EXISTS idx_leaderboard_prize_awards_voucher
      ON leaderboard_prize_awards (voucher_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_reviewed_by
      ON submissions (reviewed_by);
    CREATE INDEX IF NOT EXISTS idx_submissions_mission
      ON submissions (mission_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_progress_user_status
      ON mission_progress (user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_progress_submission
      ON mission_progress (submission_id);

    CREATE INDEX IF NOT EXISTS idx_mission_progress_acceptance_expiry
      ON mission_progress (status, accepted_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_progress_open_reservation
      ON mission_progress (mission_id)
      WHERE status IN ('accepted', 'submitted');
    CREATE INDEX IF NOT EXISTS idx_submission_source_evidence_evidence
      ON submission_source_evidence (evidence_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_upload
      ON verifications (upload_id);
    CREATE INDEX IF NOT EXISTS idx_venue_price_records_source_submission
      ON venue_price_records (source_submission_id);
    CREATE INDEX IF NOT EXISTS idx_contribution_ledger_submission
      ON contribution_ledger (submission_id);
    CREATE INDEX IF NOT EXISTS idx_events_user
      ON events (user_id);
    CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_reviewed_by
      ON account_deletion_requests (reviewed_by);
    CREATE INDEX IF NOT EXISTS idx_feedback_user
      ON feedback (user_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_assigned_to
      ON feedback (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_feedback_resolved_by
      ON feedback (resolved_by);
    CREATE INDEX IF NOT EXISTS idx_feedback_workflow
      ON feedback (status, assigned_to, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_user
      ON wrong_price_reports (user_id);
    CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_assigned_to
      ON wrong_price_reports (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_resolved_by
      ON wrong_price_reports (resolved_by);
    CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_workflow
      ON wrong_price_reports (status, assigned_to, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_venue_requests_mission
      ON venue_requests (mission_id);
    CREATE INDEX IF NOT EXISTS idx_venue_requests_user
      ON venue_requests (user_id);
    CREATE INDEX IF NOT EXISTS idx_venue_requests_assigned_to
      ON venue_requests (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_venue_requests_resolved_by
      ON venue_requests (resolved_by);
    CREATE INDEX IF NOT EXISTS idx_venue_requests_workflow
      ON venue_requests (status, assigned_to, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_user
      ON venue_interest_requests (user_id);
    CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_assigned_to
      ON venue_interest_requests (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_resolved_by
      ON venue_interest_requests (resolved_by);
    CREATE INDEX IF NOT EXISTS idx_venue_claim_requests_reviewed_by
      ON venue_claim_requests (reviewed_by);
    CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_workflow
      ON venue_interest_requests (status, assigned_to, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_venue_identity_aliases_canonical
      ON venue_identity_aliases (canonical_venue_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_approved_by
      ON venue_manager_assignments (approved_by);
    CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_access
      ON venue_manager_assignments (venue_id, access_level, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_expiry
      ON venue_manager_assignments (status, access_level, expires_at);
    CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_reviewed_by
      ON venue_pending_changes (reviewed_by);
    CREATE INDEX IF NOT EXISTS idx_venue_partner_outreach_updated_by
      ON venue_partner_outreach (updated_by);
  `);
}

function normalizeMissionReservations(database: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `WITH ranked_reservations AS (
         SELECT
           id,
           row_number() OVER (
             PARTITION BY mission_id
             ORDER BY
               CASE status WHEN 'submitted' THEN 0 ELSE 1 END,
               CASE WHEN status = 'submitted' THEN julianday(submitted_at) END ASC,
               CASE WHEN status = 'accepted' THEN julianday(accepted_at) END DESC,
               id ASC
           ) AS reservation_rank
         FROM mission_progress
         WHERE status IN ('accepted', 'submitted')
       )
       UPDATE mission_progress
       SET status = 'cancelled', completed_at = NULL, updated_at = ?
       WHERE id IN (
         SELECT id FROM ranked_reservations WHERE reservation_rank > 1
       )`,
    )
    .run(now);
}

function reconcileCounterOnlyAccountRoles(database: BetterSqlite3.Database): void {
  database.prepare(
    `UPDATE accounts
        SET role = 'user', updated_at = datetime('now')
      WHERE role = 'venue_manager' AND subscription_status <> 'admin'
        AND EXISTS (
          SELECT 1 FROM venue_manager_assignments assignment
          WHERE assignment.user_id = accounts.id AND assignment.access_level = 'counter_staff'
        )
        AND NOT EXISTS (
          SELECT 1 FROM venue_manager_assignments assignment
          WHERE assignment.user_id = accounts.id
            AND assignment.access_level = 'manager' AND assignment.status = 'active'
        )`,
  ).run();
}

function parseMigrationMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function appendMigrationReconciliation(
  metadataJson: unknown,
  reconciliation: Record<string, unknown>,
): string {
  const metadata = parseMigrationMetadata(metadataJson);
  const existing = Array.isArray(metadata.migrationReconciliations)
    ? metadata.migrationReconciliations
    : [];
  return JSON.stringify({
    ...metadata,
    migrationReconciliations: [...existing, reconciliation],
  });
}

function reconcileLegacyUniqueConstraints(database: BetterSqlite3.Database): void {
  const reconciledAt = new Date().toISOString();
  const reconcile = database.transaction(() => {
    const unfinishedDeletionRows = database.prepare(
      `SELECT id, user_id, status, requested_at, updated_at, result_summary_json
       FROM account_deletion_requests
       WHERE status IN ('pending_review', 'approved', 'processing', 'failed')
       ORDER BY user_id ASC,
         CASE status WHEN 'processing' THEN 0 WHEN 'failed' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END ASC,
         updated_at DESC, requested_at DESC, id ASC`,
    ).all() as Array<{
      id: string;
      user_id: string;
      status: string;
      requested_at: string;
      updated_at: string;
      result_summary_json: string | null;
    }>;
    const canonicalDeletionByUser = new Map<string, string>();
    const cancelDeletion = database.prepare(
      `UPDATE account_deletion_requests
       SET status = 'cancelled', completed_at = COALESCE(completed_at, ?),
           result_summary_json = ?, updated_at = ?
       WHERE id = ?`,
    );
    for (const row of unfinishedDeletionRows) {
      const canonicalId = canonicalDeletionByUser.get(row.user_id);
      if (!canonicalId) {
        canonicalDeletionByUser.set(row.user_id, row.id);
        continue;
      }
      cancelDeletion.run(
        reconciledAt,
        JSON.stringify({
          migrationReconciledDuplicate: true,
          schemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
          priorStatus: row.status,
          canonicalRequestId: canonicalId,
          priorResultSummary: parseMigrationMetadata(row.result_summary_json),
        }),
        reconciledAt,
        row.id,
      );
    }

    const reconcileDiscountDuplicates = (partition: "pass" | "idempotency") => {
      const partitionSql = partition === "pass"
        ? "discount_pass_id"
        : "venue_id, idempotency_key";
      const whereSql = partition === "pass"
        ? "discount_pass_id IS NOT NULL"
        : "idempotency_key IS NOT NULL";
      const rows = database.prepare(
        `WITH ranked AS (
           SELECT id,
             row_number() OVER (
               PARTITION BY ${partitionSql}
               ORDER BY redeemed_at ASC, created_at ASC, id ASC
             ) AS duplicate_rank
           FROM discount_redemptions
           WHERE ${whereSql}
         )
         SELECT id FROM ranked WHERE duplicate_rank > 1`,
      ).all() as Array<{ id: string }>;
      const getRecord = database.prepare("SELECT * FROM discount_redemptions WHERE id = ?");
      const quarantine = database.prepare(
        `INSERT INTO migration_quarantined_records (
          id, entity_type, original_id, reason, payload_json, quarantined_at
        ) VALUES (?, 'discount_redemption', ?, ?, ?, ?)`,
      );
      const remove = database.prepare("DELETE FROM discount_redemptions WHERE id = ?");
      for (const row of rows) {
        const record = getRecord.get(row.id) as Record<string, unknown> | undefined;
        if (!record) continue;
        const reason = partition === "pass" ? "duplicate_discount_pass" : "duplicate_idempotency_key";
        quarantine.run(
          crypto.randomUUID(),
          row.id,
          reason,
          JSON.stringify({ schemaVersion: CURRENT_DATABASE_SCHEMA_VERSION, record }),
          reconciledAt,
        );
        remove.run(row.id);
      }
    };
    reconcileDiscountDuplicates("pass");
    reconcileDiscountDuplicates("idempotency");

    const reconcilePintPointDuplicates = (globalMemberPass: boolean) => {
      const partitionSql = globalMemberPass ? "idempotency_key" : "venue_id, idempotency_key";
      const whereSql = globalMemberPass
        ? "idempotency_key LIKE 'member-pass:%'"
        : "idempotency_key IS NOT NULL";
      const rows = database.prepare(
        `WITH ranked AS (
           SELECT id, user_id, venue_id, points_awarded, status, metadata_json, idempotency_key,
             row_number() OVER (
               PARTITION BY ${partitionSql}
               ORDER BY recorded_at ASC, created_at ASC, id ASC
             ) AS duplicate_rank
           FROM pint_point_drink_records
           WHERE ${whereSql}
         )
         SELECT * FROM ranked WHERE duplicate_rank > 1`,
      ).all() as Array<{
        id: string;
        user_id: string;
        venue_id: string;
        points_awarded: number;
        status: string;
        metadata_json: string | null;
        idempotency_key: string;
      }>;
      const quarantine = database.prepare(
        `UPDATE pint_point_drink_records
         SET idempotency_key = NULL, status = 'void', voided_at = COALESCE(voided_at, ?),
             void_reason = COALESCE(void_reason, ?), metadata_json = ?
         WHERE id = ?`,
      );
      const hasReversal = database.prepare(
        "SELECT 1 FROM pint_point_ledger WHERE drink_record_id = ? AND type = 'drink_void' LIMIT 1",
      );
      const insertReversal = database.prepare(
        `INSERT INTO pint_point_ledger (
          id, user_id, venue_id, drink_record_id, reward_code_id, type,
          points_delta, points_reserved_delta, description, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, NULL, 'drink_void', ?, 0, ?, ?, ?)`,
      );
      for (const row of rows) {
        const wasActive = row.status !== "void";
        quarantine.run(
          reconciledAt,
          "Migration quarantined a duplicate purchase record.",
          appendMigrationReconciliation(row.metadata_json, {
            type: globalMemberPass ? "duplicate_member_pass" : "duplicate_idempotency_key",
            originalIdempotencyKey: row.idempotency_key,
            schemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
            reconciledAt,
          }),
          row.id,
        );
        if (wasActive && Number(row.points_awarded) > 0 && !hasReversal.get(row.id)) {
          insertReversal.run(
            crypto.randomUUID(),
            row.user_id,
            row.venue_id,
            row.id,
            -Number(row.points_awarded),
            `Migration reversal: ${Number(row.points_awarded)} duplicate Pint Point${Number(row.points_awarded) === 1 ? "" : "s"}.`,
            reconciledAt,
            JSON.stringify({ migrationReconciliation: true, schemaVersion: CURRENT_DATABASE_SCHEMA_VERSION }),
          );
        }
      }
    };
    reconcilePintPointDuplicates(false);
    reconcilePintPointDuplicates(true);
  });
  reconcile();
}

function ensurePostMigrationIntegrity(database: BetterSqlite3.Database): void {
  database.exec(`
    UPDATE pint_point_drink_records
    SET status = 'active'
    WHERE status NOT IN ('active', 'void');
    UPDATE pint_point_drink_records
    SET voided_by_user_id = NULL
    WHERE voided_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.id = pint_point_drink_records.voided_by_user_id);

    UPDATE venue_manager_assignments
    SET access_level = 'manager'
    WHERE access_level NOT IN ('manager', 'counter_staff');
    UPDATE venue_manager_assignments
    SET status = 'revoked'
    WHERE status NOT IN ('active', 'pending', 'revoked');
    UPDATE venue_manager_assignments
    SET status = 'revoked', expires_at = NULL
    WHERE status = 'pending' AND access_level != 'counter_staff';
    UPDATE venue_manager_assignments
    SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+72 hours')
    WHERE status = 'pending' AND access_level = 'counter_staff'
      AND (expires_at IS NULL OR julianday(expires_at) IS NULL);
    UPDATE venue_manager_assignments
    SET expires_at = NULL
    WHERE status != 'pending' AND expires_at IS NOT NULL;

    UPDATE venue_claim_requests
    SET status = 'pending'
    WHERE status NOT IN ('pending', 'approved', 'rejected');
    UPDATE venue_claim_requests
    SET reviewed_by = NULL
    WHERE reviewed_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.id = venue_claim_requests.reviewed_by);
    UPDATE venue_claim_requests
    SET reviewed_by = NULL, reviewed_at = NULL
    WHERE status = 'pending';
    UPDATE venue_claim_requests
    SET reviewed_at = COALESCE(
      strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    WHERE status IN ('approved', 'rejected') AND julianday(reviewed_at) IS NULL;

    DROP TRIGGER IF EXISTS validate_venue_assignment_insert;
    DROP TRIGGER IF EXISTS validate_venue_assignment_update;
    DROP TRIGGER IF EXISTS validate_venue_claim_insert;
    DROP TRIGGER IF EXISTS validate_venue_claim_update;

    CREATE TRIGGER IF NOT EXISTS validate_pint_point_status_insert
    BEFORE INSERT ON pint_point_drink_records
    WHEN NEW.status NOT IN ('active', 'void')
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point record status');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_pint_point_status_update
    BEFORE UPDATE OF status ON pint_point_drink_records
    WHEN NEW.status NOT IN ('active', 'void')
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point record status');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_pint_point_voided_by_insert
    BEFORE INSERT ON pint_point_drink_records
    WHEN NEW.voided_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.voided_by_user_id)
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point voiding account');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_pint_point_voided_by_update
    BEFORE UPDATE OF voided_by_user_id ON pint_point_drink_records
    WHEN NEW.voided_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.voided_by_user_id)
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point voiding account');
    END;

    CREATE TRIGGER IF NOT EXISTS validate_venue_assignment_insert
    BEFORE INSERT ON venue_manager_assignments
    WHEN NEW.access_level NOT IN ('manager', 'counter_staff')
      OR NEW.status NOT IN ('active', 'pending', 'revoked')
      OR (NEW.status = 'pending' AND (NEW.access_level != 'counter_staff' OR julianday(NEW.expires_at) IS NULL))
      OR (NEW.status != 'pending' AND NEW.expires_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue assignment state');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_venue_assignment_update
    BEFORE UPDATE OF access_level, status, expires_at ON venue_manager_assignments
    WHEN NEW.access_level NOT IN ('manager', 'counter_staff')
      OR NEW.status NOT IN ('active', 'pending', 'revoked')
      OR (NEW.status = 'pending' AND (NEW.access_level != 'counter_staff' OR julianday(NEW.expires_at) IS NULL))
      OR (NEW.status != 'pending' AND NEW.expires_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue assignment state');
    END;

    CREATE TRIGGER IF NOT EXISTS validate_venue_claim_insert
    BEFORE INSERT ON venue_claim_requests
    WHEN NEW.status NOT IN ('pending', 'approved', 'rejected')
      OR (NEW.reviewed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.reviewed_by))
      OR (NEW.status = 'pending' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
      OR (NEW.status IN ('approved', 'rejected') AND julianday(NEW.reviewed_at) IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue claim review state');
    END;
    CREATE TRIGGER IF NOT EXISTS validate_venue_claim_update
    BEFORE UPDATE OF status, reviewed_by, reviewed_at ON venue_claim_requests
    WHEN NEW.status NOT IN ('pending', 'approved', 'rejected')
      OR (NEW.reviewed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.reviewed_by))
      OR (NEW.status = 'pending' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
      OR (NEW.status IN ('approved', 'rejected') AND julianday(NEW.reviewed_at) IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue claim review state');
    END;

    CREATE TRIGGER IF NOT EXISTS clear_added_account_references_before_delete
    BEFORE DELETE ON accounts
    BEGIN
      UPDATE pint_point_drink_records SET voided_by_user_id = NULL WHERE voided_by_user_id = OLD.id;
      UPDATE venue_claim_requests SET reviewed_by = NULL WHERE reviewed_by = OLD.id;
    END;
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

function backfillStripeEntitlementTargets(database: BetterSqlite3.Database): void {
  database.exec(`
    UPDATE accounts
       SET stripe_paid_subscription_status = subscription_status
     WHERE stripe_paid_subscription_status IS NULL
       AND subscription_status IN ('premium_monthly', 'premium_yearly');

    UPDATE venue_profiles
       SET stripe_paid_membership_tier = 'pro'
     WHERE stripe_paid_membership_tier IS NULL
       AND membership_tier = 'pro';

    UPDATE venue_profiles
       SET stripe_paid_membership_tier = 'pro'
     WHERE stripe_paid_membership_tier IN ('plus', 'super_premium');
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
  const { baseSchema, indexSchema } = splitSchemaIndexes(schema);
  const transactionalBaseSchema = baseSchema
    .replace(/PRAGMA\s+journal_mode\s*=\s*WAL\s*;/gi, "")
    .replace(/PRAGMA\s+foreign_keys\s*=\s*ON\s*;/gi, "");
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const migrate = database.transaction(() => {
    // Existing databases can be missing columns referenced by newer indexes.
    // Create tables first, upgrade columns second, reconcile legacy rows, then build every index.
    database.exec(transactionalBaseSchema);
    migrateLegacyVenuePartnerTables(database);
    ensureColumns(database, "venue_profiles", venueProfilesColumns);
    ensureColumns(database, "venue_analytics_events", venueAnalyticsEventsColumns);
    ensureColumns(database, "venue_happy_hours", venueHappyHoursColumns);
    ensureColumns(database, "venue_specials", venueSpecialsColumns);
    ensureColumns(database, "accounts", accountsColumns);
    ensureColumns(database, "stripe_webhook_events", stripeWebhookEventColumns);
    ensureColumns(database, "profiles", profilesColumns);
    ensureColumns(database, "auth_sessions", authSessionsColumns);
    ensureColumns(database, "discount_redemptions", discountRedemptionColumns);
    ensureColumns(database, "pint_point_drink_records", pintPointDrinkRecordColumns);
    ensureColumns(database, "venue_manager_assignments", venueManagerAssignmentColumns);
    ensureColumns(database, "venue_claim_requests", venueClaimRequestColumns);
    ensureColumns(database, "submissions", submissionColumns);
    ensureColumns(database, "submission_items", submissionItemColumns);
    ensureColumns(database, "feedback", feedbackColumns);
    ensureColumns(database, "wrong_price_reports", trustWorkflowColumns);
    ensureColumns(database, "venue_requests", trustWorkflowColumns);
    ensureColumns(database, "venue_requests", venueRequestColumns);
    ensureColumns(database, "venue_interest_requests", trustWorkflowColumns);
    ensureColumns(database, "account_privacy_settings", accountPrivacySettingsColumns);
    database.prepare(
      "UPDATE account_privacy_settings SET consent_version = ? WHERE consent_version <> ?",
    ).run(CURRENT_LEGAL_POLICY_VERSION, CURRENT_LEGAL_POLICY_VERSION);
    ensureColumns(database, "source_evidence_objects", sourceEvidenceColumns);
    ensureColumns(database, "account_deletion_requests", accountDeletionRequestColumns);
    ensureColumns(database, "venue_partner_outreach", venuePartnerOutreachColumns);
    ensureColumns(database, "admin_ingestion_queue", adminIngestionQueueColumns);
    redactCompletedAdminIngestionImages(database);
    ensureColumns(database, "venue_beers", venueBeersColumns);
    normalizeMissionReservations(database);
    reconcileCounterOnlyAccountRoles(database);
    reconcileLegacyUniqueConstraints(database);
    ensurePostMigrationIntegrity(database);
    database.exec(indexSchema);
    syncStaticBeerCatalog(database);
    deletePendingNonBeerCatalogItems(database);
    backfillBeerNames(database);
    normalizeVenueTiers(database);
    backfillStripeEntitlementTargets(database);
    backfillPublicAccountIds(database);
    backfillDisplayNameKeys(database);
    ensureIndexes(database);
    database.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
  });
  migrate();
}

function currentDatabaseSchemaVersion(database: BetterSqlite3.Database): number {
  return Number(database.pragma("user_version", { simple: true }) ?? 0);
}

function hasApplicationTables(database: BetterSqlite3.Database): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
      .get(),
  );
}

function createPreMigrationBackup(database: BetterSqlite3.Database, databasePath: string, fromVersion: number): string | null {
  if (databasePath === ":memory:" || !hasApplicationTables(database)) {
    return null;
  }

  const backupDirectory = path.join(path.dirname(databasePath), "migration-backups");
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `schema-${fromVersion}-to-${CURRENT_DATABASE_SCHEMA_VERSION}-${timestamp}.sqlite`,
  );

  database.prepare("VACUUM INTO ?").run(backupPath);
  fs.chmodSync(backupPath, 0o600);

  purgeExpiredMigrationBackups(databasePath);

  const backups = fs
    .readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^schema-\d+-to-\d+-.*\.sqlite$/.test(entry.name))
    .map((entry) => ({
      path: path.join(backupDirectory, entry.name),
      modifiedAt: fs.statSync(path.join(backupDirectory, entry.name)).mtimeMs,
    }))
    .sort((first, second) => second.modifiedAt - first.modifiedAt);

  for (const staleBackup of backups.slice(MIGRATION_BACKUP_RETENTION)) {
    fs.rmSync(staleBackup.path, { force: true });
  }

  return backupPath;
}

export function purgeExpiredMigrationBackups(databasePath: string, now = new Date()): number {
  if (databasePath === ":memory:") return 0;
  const backupDirectory = path.join(path.dirname(databasePath), "migration-backups");
  if (!fs.existsSync(backupDirectory)) return 0;
  const cutoff = now.getTime() - MIGRATION_BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const entry of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^schema-\d+-to-\d+-.*\.sqlite$/.test(entry.name)) continue;
    const backupPath = path.join(backupDirectory, entry.name);
    if (fs.statSync(backupPath).mtimeMs > cutoff) continue;
    fs.rmSync(backupPath, { force: true });
    deleted += 1;
  }
  return deleted;
}

export function createDatabase(databasePath = env.DATABASE_PATH): BetterSqlite3.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  purgeExpiredMigrationBackups(databasePath);

  const database = new BetterSqlite3(databasePath);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const schemaVersion = currentDatabaseSchemaVersion(database);
  if (schemaVersion > CURRENT_DATABASE_SCHEMA_VERSION) {
    database.close();
    throw new Error(
      `Database schema version ${schemaVersion} is newer than this app supports (${CURRENT_DATABASE_SCHEMA_VERSION}).`,
    );
  }
  if (schemaVersion < CURRENT_DATABASE_SCHEMA_VERSION) {
    const backupPath = createPreMigrationBackup(database, databasePath, schemaVersion);
    if (backupPath) {
      console.info("Created pre-migration database backup", {
        fromVersion: schemaVersion,
        toVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        backupPath,
      });
    }
  }
  try {
    initializeDatabaseSchema(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}
