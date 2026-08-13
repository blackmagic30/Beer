/**
 * Passive, side-effect-free V4 TABLE DATA selection contract.
 *
 * This leaf intentionally contains only frozen literal data. Importing it does
 * not load migration-source, filesystem, database, or tool-execution modules.
 */
export interface PostgresLogicalBackupV4TableDataDescriptor {
  readonly description: "TABLE DATA";
  readonly schemaName: "pintpath_app" | "pintpath_ops";
  readonly tableName: string;
}

const tableData = (
  schemaName: PostgresLogicalBackupV4TableDataDescriptor["schemaName"],
  tableName: string,
): PostgresLogicalBackupV4TableDataDescriptor => Object.freeze({
  description: "TABLE DATA",
  schemaName,
  tableName,
});

export const POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS = Object.freeze([
  tableData("pintpath_app", "account_deletion_completion_outbox"),
  tableData("pintpath_app", "account_deletion_notice_recipient_secrets"),
  tableData("pintpath_app", "account_deletion_notification_events"),
  tableData("pintpath_app", "account_deletion_requests"),
  tableData("pintpath_app", "account_discount_passes"),
  tableData("pintpath_app", "account_preferences"),
  tableData("pintpath_app", "account_privacy_settings"),
  tableData("pintpath_app", "account_reward_vouchers"),
  tableData("pintpath_app", "accounts"),
  tableData("pintpath_app", "admin_ingestion_queue"),
  tableData("pintpath_app", "age_verifications"),
  tableData("pintpath_app", "auth_sessions"),
  tableData("pintpath_app", "beer_catalog_aliases"),
  tableData("pintpath_app", "beer_catalog_items"),
  tableData("pintpath_app", "billing_checkout_reservations"),
  tableData("pintpath_app", "contribution_ledger"),
  tableData("pintpath_app", "discount_redemptions"),
  tableData("pintpath_app", "events"),
  tableData("pintpath_app", "feedback"),
  tableData("pintpath_app", "free_pint_reward_codes"),
  tableData("pintpath_app", "free_pint_reward_redemptions"),
  tableData("pintpath_app", "leaderboard_prize_awards"),
  tableData("pintpath_app", "leaderboard_prize_campaigns"),
  tableData("pintpath_app", "migration_quarantined_records"),
  tableData("pintpath_app", "mission_progress"),
  tableData("pintpath_app", "missions"),
  tableData("pintpath_app", "pint_point_drink_records"),
  tableData("pintpath_app", "pint_point_ledger"),
  tableData("pintpath_app", "profiles"),
  tableData("pintpath_app", "revoked_provider_sessions"),
  tableData("pintpath_app", "saved_items"),
  tableData("pintpath_app", "schema_metadata"),
  tableData("pintpath_app", "security_audit_log"),
  tableData("pintpath_app", "source_evidence_objects"),
  tableData("pintpath_app", "stripe_webhook_events"),
  tableData("pintpath_app", "submission_items"),
  tableData("pintpath_app", "submission_source_evidence"),
  tableData("pintpath_app", "submissions"),
  tableData("pintpath_app", "system_state"),
  tableData("pintpath_app", "user_activity_events"),
  tableData("pintpath_app", "venue_analytics_events"),
  tableData("pintpath_app", "venue_beers"),
  tableData("pintpath_app", "venue_claim_requests"),
  tableData("pintpath_app", "venue_happy_hours"),
  tableData("pintpath_app", "venue_identity_aliases"),
  tableData("pintpath_app", "venue_interest_requests"),
  tableData("pintpath_app", "venue_location_cache"),
  tableData("pintpath_app", "venue_manager_assignments"),
  tableData("pintpath_app", "venue_monthly_reports"),
  tableData("pintpath_app", "venue_partner_outreach"),
  tableData("pintpath_app", "venue_pending_changes"),
  tableData("pintpath_app", "venue_price_records"),
  tableData("pintpath_app", "venue_profiles"),
  tableData("pintpath_app", "venue_requests"),
  tableData("pintpath_app", "venue_specials"),
  tableData("pintpath_app", "verifications"),
  tableData("pintpath_app", "wrong_price_reports"),
  tableData("pintpath_ops", "migration_chunks"),
  tableData("pintpath_ops", "migration_runs"),
] satisfies readonly PostgresLogicalBackupV4TableDataDescriptor[]);

export const POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256 =
  "505d42cd7ffbe6809aea3e3ed02b33968bf625bde882cdbc0f1a3c69cc94f6d8" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256 =
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256;
