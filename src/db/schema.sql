PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_ingestion_queue (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  image_data_url TEXT,
  image_retention_expires_at TEXT,
  image_redacted_at TEXT,
  image_redaction_reason TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  review_claim_token TEXT,
  review_claimed_at TEXT,
  venue_name_guess TEXT,
  captured_notes TEXT,
  overall_confidence REAL,
  extracted_beers_json TEXT NOT NULL DEFAULT '[]',
  review_beers_json TEXT,
  crawler_feedback_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  rejected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_ingestion_queue_status_created
  ON admin_ingestion_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_ingestion_queue_venue_status
  ON admin_ingestion_queue (venue_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_ingestion_queue_image_retention
  ON admin_ingestion_queue (status, image_retention_expires_at, created_at)
  WHERE image_data_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS beer_catalog_items (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brewery TEXT,
  style TEXT,
  abv REAL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'system_catalog',
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_beer_catalog_items_status
  ON beer_catalog_items (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_beer_catalog_items_name
  ON beer_catalog_items (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS beer_catalog_aliases (
  alias_key TEXT PRIMARY KEY,
  beer_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system_catalog',
  created_at TEXT NOT NULL,
  FOREIGN KEY (beer_key) REFERENCES beer_catalog_items(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_beer_catalog_aliases_beer
  ON beer_catalog_aliases (beer_key);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  public_account_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  display_name_key TEXT,
  avatar_url TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  supabase_user_id TEXT UNIQUE,
  email_verified_at TEXT,
  mfa_level TEXT NOT NULL DEFAULT 'aal1',
  mfa_verified_at TEXT,
  provider_tokens_valid_after TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  age_confirmed_at TEXT,
  terms_accepted_at TEXT,
  privacy_accepted_at TEXT,
  terms_version TEXT,
  privacy_version TEXT,
  age_verification_status TEXT NOT NULL DEFAULT 'not_started',
  is_over_18_verified INTEGER NOT NULL DEFAULT 0,
  subscription_status TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_paid_subscription_status TEXT,
  stripe_event_created_at TEXT,
  premium_until TEXT,
  trust_score INTEGER NOT NULL DEFAULT 50,
  contribution_points_current_month REAL NOT NULL DEFAULT 0,
  approved_submission_count INTEGER NOT NULL DEFAULT 0,
  rejected_submission_count INTEGER NOT NULL DEFAULT 0,
  fraud_strike_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts (email);

CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer
  ON accounts (stripe_customer_id);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  public_account_id TEXT UNIQUE,
  email TEXT,
  display_name TEXT,
  display_name_key TEXT,
  username TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  account_status TEXT NOT NULL DEFAULT 'active',
  age_verification_status TEXT NOT NULL DEFAULT 'not_started',
  is_over_18_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profiles_status
  ON profiles (account_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_session_id_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_ip_hash TEXT,
  user_agent_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_provider_session
  ON auth_sessions (user_id, provider_session_id_hash);

CREATE TABLE IF NOT EXISTS revoked_provider_sessions (
  user_id TEXT NOT NULL,
  provider_session_id_hash TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_session_id_hash),
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revoked_provider_sessions_user
  ON revoked_provider_sessions (user_id, revoked_at DESC);

CREATE TABLE IF NOT EXISTS migration_quarantined_records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  original_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migration_quarantine_entity
  ON migration_quarantined_records (entity_type, original_id, quarantined_at DESC);

CREATE TABLE IF NOT EXISTS account_discount_passes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (session_token_hash) REFERENCES auth_sessions(token_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_discount_passes_user
  ON account_discount_passes (user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_discount_passes_session
  ON account_discount_passes (session_token_hash, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_account_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  special_id TEXT,
  item_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  estimated_savings_cents INTEGER NOT NULL DEFAULT 0,
  discount_pass_id TEXT,
  redeemed_by_user_id TEXT,
  idempotency_key TEXT,
  redeemed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (discount_pass_id) REFERENCES account_discount_passes(id) ON DELETE SET NULL,
  FOREIGN KEY (redeemed_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

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

CREATE TABLE IF NOT EXISTS pint_point_drink_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  item_name TEXT,
  beverage_category TEXT NOT NULL DEFAULT 'alcoholic',
  quantity INTEGER NOT NULL DEFAULT 1,
  is_alcoholic INTEGER NOT NULL DEFAULT 1,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'venue_portal',
  reward_code_id TEXT,
  recorded_by_user_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  voided_at TEXT,
  voided_by_user_id TEXT,
  void_reason TEXT,
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_code_id) REFERENCES free_pint_reward_codes(id) ON DELETE SET NULL,
  FOREIGN KEY (recorded_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (voided_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_user
  ON pint_point_drink_records (user_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_venue
  ON pint_point_drink_records (venue_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_suburb
  ON pint_point_drink_records (suburb, recorded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pint_point_drink_records_idempotency
  ON pint_point_drink_records (venue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pint_point_drink_records_member_pass_once
  ON pint_point_drink_records (idempotency_key)
  WHERE idempotency_key LIKE 'member-pass:%';

CREATE TABLE IF NOT EXISTS free_pint_reward_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_account_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  eligible_venue_scope TEXT NOT NULL DEFAULT 'affiliated',
  status TEXT NOT NULL DEFAULT 'active',
  points_reserved INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT,
  rejected_at TEXT,
  rejected_reason TEXT,
  redeemed_by_user_id TEXT,
  redeemed_venue_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (redeemed_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_user
  ON free_pint_reward_codes (user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_code
  ON free_pint_reward_codes (code_hash);

CREATE INDEX IF NOT EXISTS idx_free_pint_reward_codes_venue
  ON free_pint_reward_codes (redeemed_venue_id, status, used_at DESC);

CREATE TABLE IF NOT EXISTS free_pint_reward_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_account_id TEXT NOT NULL,
  reward_code_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  redeemed_by_user_id TEXT,
  redeemed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_code_id) REFERENCES free_pint_reward_codes(id) ON DELETE CASCADE,
  FOREIGN KEY (redeemed_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_user
  ON free_pint_reward_redemptions (user_id, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS idx_free_pint_reward_redemptions_venue
  ON free_pint_reward_redemptions (venue_id, redeemed_at DESC);

CREATE TABLE IF NOT EXISTS pint_point_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  venue_id TEXT,
  drink_record_id TEXT,
  reward_code_id TEXT,
  type TEXT NOT NULL,
  points_delta INTEGER NOT NULL DEFAULT 0,
  points_reserved_delta INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (drink_record_id) REFERENCES pint_point_drink_records(id) ON DELETE SET NULL,
  FOREIGN KEY (reward_code_id) REFERENCES free_pint_reward_codes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_user
  ON pint_point_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pint_point_ledger_venue
  ON pint_point_ledger (venue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_reward_vouchers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_account_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AUD',
  venue_scope TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  redeemed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_reward_vouchers_user
  ON account_reward_vouchers (user_id, status, issued_at DESC);

CREATE TABLE IF NOT EXISTS leaderboard_prize_campaigns (
  month_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  first_place_cents INTEGER NOT NULL DEFAULT 10000,
  second_place_cents INTEGER NOT NULL DEFAULT 5000,
  third_place_cents INTEGER NOT NULL DEFAULT 2500,
  affiliate_bar TEXT,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  finalized_at TEXT,
  finalized_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_prize_awards (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  public_account_id TEXT NOT NULL,
  display_name TEXT,
  points REAL NOT NULL DEFAULT 0,
  approved_submissions INTEGER NOT NULL DEFAULT 0,
  voucher_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (month_key, rank),
  UNIQUE (month_key, user_id),
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (voucher_id) REFERENCES account_reward_vouchers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_prize_awards_user
  ON leaderboard_prize_awards (user_id, month_key DESC);

CREATE TABLE IF NOT EXISTS security_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_audit_log_created
  ON security_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_audit_log_action
  ON security_audit_log (action, created_at DESC);

CREATE TABLE IF NOT EXISTS source_evidence_objects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'sqlite_private',
  object_path TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  byte_size INTEGER,
  data_base64 TEXT,
  external_url TEXT,
  retention_expires_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_source_evidence_owner
  ON source_evidence_objects (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_evidence_retention
  ON source_evidence_objects (deleted_at, retention_expires_at);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  client_submission_id TEXT,
  mission_id TEXT,
  user_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  submission_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_photo_url TEXT,
  ocr_status TEXT NOT NULL DEFAULT 'not_requested',
  ocr_summary_json TEXT,
  notes TEXT,
  points_awarded REAL NOT NULL DEFAULT 0,
  upload_latitude REAL,
  upload_longitude REAL,
  upload_accuracy_meters REAL,
  upload_location_captured_at TEXT,
  distance_to_venue_meters REAL,
  points_eligible_by_location INTEGER NOT NULL DEFAULT 0,
  points_eligibility_reason TEXT,
  pending_venue_json TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  fraud_flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id),
  FOREIGN KEY (reviewed_by) REFERENCES accounts(id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status_created
  ON submissions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_user_created
  ON submissions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_user_venue_month
  ON submissions (user_id, venue_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_submissions_mission
  ON submissions (mission_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_source_evidence (
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, evidence_id),
  UNIQUE (submission_id, sort_order),
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES source_evidence_objects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_submission_source_evidence_submission
  ON submission_source_evidence (submission_id, sort_order);

CREATE TABLE IF NOT EXISTS submission_items (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  beer_name TEXT NOT NULL,
  normalized_beer_id TEXT,
  serving_size TEXT NOT NULL,
  price REAL,
  is_happy_hour_price INTEGER NOT NULL DEFAULT 0,
  happy_hour_details TEXT,
  is_on_tap TEXT NOT NULL DEFAULT 'unknown',
  confidence REAL NOT NULL DEFAULT 0.5,
  capture_source TEXT NOT NULL DEFAULT 'manual',
  source_text TEXT,
  requires_catalog_approval INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE INDEX IF NOT EXISTS idx_submission_items_submission
  ON submission_items (submission_id);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  verifier_user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  target_entity_type TEXT NOT NULL DEFAULT 'submission',
  target_entity_id TEXT NOT NULL,
  result TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (verifier_user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id) REFERENCES submissions(id) ON DELETE CASCADE,
  UNIQUE (verifier_user_id, upload_id)
);

CREATE INDEX IF NOT EXISTS idx_verifications_user
  ON verifications (verifier_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_verifications_target
  ON verifications (target_entity_type, target_entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_activity_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_activity_user_created
  ON user_activity_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_type
  ON user_activity_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS age_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  age_threshold INTEGER NOT NULL DEFAULT 18,
  is_over_18 INTEGER NOT NULL DEFAULT 0,
  provider_name TEXT,
  provider_reference_id TEXT,
  checked_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_age_verifications_user
  ON age_verifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_age_verifications_status
  ON age_verifications (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS venue_price_records (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  beer_name TEXT NOT NULL,
  normalized_beer_id TEXT,
  serving_size TEXT NOT NULL,
  price REAL,
  is_happy_hour_price INTEGER NOT NULL DEFAULT 0,
  happy_hour_details TEXT,
  is_on_tap TEXT NOT NULL DEFAULT 'unknown',
  confidence TEXT NOT NULL DEFAULT 'user_reported_pending',
  source_type TEXT NOT NULL,
  source_submission_id TEXT,
  last_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_submission_id) REFERENCES submissions(id)
);

CREATE INDEX IF NOT EXISTS idx_venue_price_records_venue
  ON venue_price_records (venue_id, last_verified_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_price_records_feed
  ON venue_price_records (last_verified_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_venue_price_records_beer
  ON venue_price_records (normalized_beer_id, last_verified_at DESC);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  points REAL NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sponsor_flag INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_missions_active_priority
  ON missions (active, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS mission_progress (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  submission_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  accepted_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL,
  UNIQUE (mission_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mission_progress_user_status
  ON mission_progress (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mission_progress_submission
  ON mission_progress (submission_id);

CREATE INDEX IF NOT EXISTS idx_mission_progress_acceptance_expiry
  ON mission_progress (status, accepted_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_progress_open_reservation
  ON mission_progress (mission_id)
  WHERE status IN ('accepted', 'submitted');

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contribution_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  submission_id TEXT,
  venue_id TEXT NOT NULL,
  points REAL NOT NULL,
  reason TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contribution_ledger_user_venue_month
  ON contribution_ledger (user_id, venue_id, month_key);

CREATE TABLE IF NOT EXISTS venue_location_cache (
  venue_id TEXT PRIMARY KEY,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  latitude REAL,
  longitude REAL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_location_cache_suburb
  ON venue_location_cache (suburb, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  anonymous_session_id TEXT,
  event_type TEXT NOT NULL,
  venue_id TEXT,
  beer_id TEXT,
  suburb TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_events_type_created
  ON events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_venue_created
  ON events (venue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_suburb_type_created
  ON events (suburb, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_beer_created
  ON events (beer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_preferences (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  preferred_suburbs_json TEXT NOT NULL DEFAULT '[]',
  preferred_beers_json TEXT NOT NULL DEFAULT '[]',
  preferred_use_cases_json TEXT NOT NULL DEFAULT '[]',
  onboarding_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  label TEXT NOT NULL,
  suburb TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_items_user_type
  ON saved_items (user_id, item_type, created_at DESC);

CREATE TABLE IF NOT EXISTS account_privacy_settings (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  optional_analytics_enabled INTEGER NOT NULL DEFAULT 0,
  venue_report_inclusion_enabled INTEGER NOT NULL DEFAULT 0,
  product_research_enabled INTEGER NOT NULL DEFAULT 0,
  email_updates_enabled INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT NOT NULL DEFAULT '2026-07-20',
  consented_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_privacy_settings_updated
  ON account_privacy_settings (updated_at DESC);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_review',
  user_message TEXT,
  requested_at TEXT NOT NULL,
  execute_after TEXT NOT NULL,
  reviewed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  completed_at TEXT,
  processing_started_at TEXT,
  identity_deleted_at TEXT,
  stripe_customer_deleted_at TEXT,
  stripe_customer_id_snapshot TEXT,
  deletion_tombstone_recorded_at TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_status
  ON account_deletion_requests (status, execute_after, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_requests_open_user
  ON account_deletion_requests (user_id)
  WHERE status IN ('pending_review', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_requests_unfinished_user
  ON account_deletion_requests (user_id)
  WHERE status IN ('pending_review', 'approved', 'processing', 'failed');

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  feedback_type TEXT NOT NULL,
  message TEXT NOT NULL,
  venue_id TEXT,
  venue_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  triage_reason TEXT,
  assigned_to TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_to) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created
  ON feedback (status, created_at DESC);

CREATE TABLE IF NOT EXISTS wrong_price_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  price_record_id TEXT REFERENCES venue_price_records(id) ON DELETE SET NULL,
  beer_name TEXT,
  reason TEXT NOT NULL,
  notes TEXT,
  source_photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_to) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_record
  ON wrong_price_reports (price_record_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS venue_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  request_type TEXT NOT NULL,
  venue_id TEXT,
  venue_name TEXT,
  google_place_id TEXT,
  beer_name TEXT,
  suburb TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  source_submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  assigned_to TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_to) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_requests_type_status
  ON venue_requests (request_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_requests_venue
  ON venue_requests (venue_id, venue_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_requests_google_place
  ON venue_requests (google_place_id, request_type, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_requests_user_google_open
  ON venue_requests (user_id, google_place_id)
  WHERE user_id IS NOT NULL
    AND google_place_id IS NOT NULL
    AND request_type = 'missing_venue'
    AND status IN ('open', 'in_progress', 'mission_created');

CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_requests_anon_google_open
  ON venue_requests (anonymous_session_id, google_place_id)
  WHERE user_id IS NULL
    AND anonymous_session_id IS NOT NULL
    AND google_place_id IS NOT NULL
    AND request_type = 'missing_venue'
    AND status IN ('open', 'in_progress', 'mission_created');

CREATE TABLE IF NOT EXISTS venue_interest_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  venue_id TEXT,
  venue_name TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_to) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_interest_status_created
  ON venue_interest_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_interest_venue
  ON venue_interest_requests (venue_id, venue_name, created_at DESC);

CREATE TABLE IF NOT EXISTS venue_manager_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  access_level TEXT NOT NULL DEFAULT 'manager' CHECK (access_level IN ('manager', 'counter_staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
  approved_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND access_level = 'counter_staff' AND julianday(expires_at) IS NOT NULL)
    OR (status != 'pending' AND expires_at IS NULL)
  ),
  UNIQUE (user_id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_user
  ON venue_manager_assignments (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_venue
  ON venue_manager_assignments (venue_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_expiry
  ON venue_manager_assignments (status, access_level, expires_at);

CREATE TABLE IF NOT EXISTS venue_profiles (
  venue_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  suburb TEXT,
  area TEXT,
  phone TEXT,
  website TEXT,
  instagram TEXT,
  description TEXT,
  opening_hours_json TEXT NOT NULL DEFAULT '{}',
  venue_tags_json TEXT NOT NULL DEFAULT '[]',
  membership_tier TEXT NOT NULL DEFAULT 'basic',
  highlighted_name INTEGER NOT NULL DEFAULT 0,
  premium_badge TEXT,
  promoted INTEGER NOT NULL DEFAULT 0,
  featured_special_eligible INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  stripe_paid_membership_tier TEXT,
  tier_manual_override INTEGER NOT NULL DEFAULT 0,
  accepts_pint_path_codes INTEGER NOT NULL DEFAULT 0,
  stripe_event_created_at TEXT,
  pos_webhook_token_version INTEGER NOT NULL DEFAULT 1,
  pos_previous_token_version INTEGER,
  pos_previous_token_valid_until TEXT,
  pos_last_success_at TEXT,
  pos_last_terminal_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_profiles_membership
  ON venue_profiles (membership_tier, active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_profiles_area
  ON venue_profiles (area, suburb, active);

CREATE TABLE IF NOT EXISTS venue_beers (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  beer_name TEXT NOT NULL,
  normalized_beer_id TEXT,
  brewery TEXT,
  style TEXT,
  abv REAL,
  serve_size TEXT,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'AUD',
  on_tap INTEGER NOT NULL DEFAULT 0,
  in_stock INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  price_verified_at TEXT,
  stock_verified_at TEXT,
  source_ingestion_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_beers_venue
  ON venue_beers (venue_id, on_tap, in_stock, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_beers_name
  ON venue_beers (beer_name, style);

CREATE INDEX IF NOT EXISTS idx_venue_beers_source_ingestion
  ON venue_beers (source_ingestion_id)
  WHERE source_ingestion_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS venue_happy_hours (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  days_of_week_json TEXT NOT NULL DEFAULT '[]',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  description TEXT NOT NULL,
  happy_hour_beers_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_happy_hours_venue
  ON venue_happy_hours (venue_id, active, updated_at DESC);

CREATE TABLE IF NOT EXISTS venue_specials (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL,
  discount TEXT,
  savings_amount_cents INTEGER,
  starts_at TEXT,
  ends_at TEXT,
  start_time TEXT,
  end_time TEXT,
  recurrence_frequency TEXT NOT NULL DEFAULT 'none',
  days_of_week_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  schedule_note TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_specials_venue
  ON venue_specials (venue_id, active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS venue_identity_aliases (
  alias_venue_id TEXT PRIMARY KEY,
  canonical_venue_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'automatic_exact_match',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_identity_aliases_canonical
  ON venue_identity_aliases (canonical_venue_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_identity_aliases_identity
  ON venue_identity_aliases (identity_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS venue_pending_changes (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_venue_status
  ON venue_pending_changes (venue_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_submitter_status
  ON venue_pending_changes (submitted_by, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_status
  ON venue_pending_changes (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS venue_analytics_events (
  id TEXT PRIMARY KEY,
  venue_id TEXT,
  area TEXT,
  suburb TEXT,
  event_type TEXT NOT NULL,
  query_text TEXT,
  beer_name TEXT,
  beer_style TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_analytics_events_venue
  ON venue_analytics_events (venue_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_analytics_events_area
  ON venue_analytics_events (area, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS venue_claim_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  venue_id TEXT,
  venue_name TEXT NOT NULL,
  address TEXT,
  suburb TEXT,
  requester_name TEXT NOT NULL,
  requester_role TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status IN ('approved', 'rejected') AND julianday(reviewed_at) IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_venue_claim_requests_user
  ON venue_claim_requests (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_claim_requests_status
  ON venue_claim_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_claim_requests_venue
  ON venue_claim_requests (venue_id, venue_name, suburb);

CREATE TABLE IF NOT EXISTS venue_monthly_reports (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (venue_id, month)
);

CREATE INDEX IF NOT EXISTS idx_venue_monthly_reports_venue
  ON venue_monthly_reports (venue_id, month DESC);

CREATE TABLE IF NOT EXISTS venue_partner_outreach (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'lead',
  tier_fit TEXT,
  next_action TEXT,
  last_contacted_at TEXT,
  contact_name TEXT,
  notes TEXT,
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_partner_outreach_status
  ON venue_partner_outreach (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  event_created_at TEXT,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  processed_at TEXT NOT NULL,
  processing_token TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON stripe_webhook_events (status, received_at);

-- Every foreign-key child column needs a leading index so deletes, cascades, and joins
-- do not degrade into full table scans as production data grows.
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
CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_user
  ON wrong_price_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_assigned_to
  ON wrong_price_reports (assigned_to);
CREATE INDEX IF NOT EXISTS idx_wrong_price_reports_resolved_by
  ON wrong_price_reports (resolved_by);
CREATE INDEX IF NOT EXISTS idx_venue_requests_mission
  ON venue_requests (mission_id);
CREATE INDEX IF NOT EXISTS idx_venue_requests_user
  ON venue_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_venue_requests_assigned_to
  ON venue_requests (assigned_to);
CREATE INDEX IF NOT EXISTS idx_venue_requests_resolved_by
  ON venue_requests (resolved_by);
CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_user
  ON venue_interest_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_assigned_to
  ON venue_interest_requests (assigned_to);
CREATE INDEX IF NOT EXISTS idx_venue_interest_requests_resolved_by
  ON venue_interest_requests (resolved_by);
CREATE INDEX IF NOT EXISTS idx_venue_claim_requests_reviewed_by
  ON venue_claim_requests (reviewed_by);
CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_approved_by
  ON venue_manager_assignments (approved_by);
CREATE INDEX IF NOT EXISTS idx_venue_pending_changes_reviewed_by
  ON venue_pending_changes (reviewed_by);
CREATE INDEX IF NOT EXISTS idx_venue_partner_outreach_updated_by
  ON venue_partner_outreach (updated_by);
