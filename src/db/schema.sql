PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_ingestion_queue (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  image_data_url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
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
  source TEXT NOT NULL DEFAULT 'venue_portal',
  reward_code_id TEXT,
  recorded_by_user_id TEXT,
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_code_id) REFERENCES free_pint_reward_codes(id) ON DELETE SET NULL,
  FOREIGN KEY (recorded_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_user
  ON pint_point_drink_records (user_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_venue
  ON pint_point_drink_records (venue_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_pint_point_drink_records_suburb
  ON pint_point_drink_records (suburb, recorded_at DESC);

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
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_source_evidence_owner
  ON source_evidence_objects (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  client_submission_id TEXT,
  user_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  submission_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_photo_url TEXT,
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
  FOREIGN KEY (reviewed_by) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_status_created
  ON submissions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_user_created
  ON submissions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_user_venue_month
  ON submissions (user_id, venue_id, observed_at);

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
  optional_analytics_enabled INTEGER NOT NULL DEFAULT 1,
  venue_report_inclusion_enabled INTEGER NOT NULL DEFAULT 1,
  product_research_enabled INTEGER NOT NULL DEFAULT 1,
  email_updates_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_privacy_settings_updated
  ON account_privacy_settings (updated_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  feedback_type TEXT NOT NULL,
  message TEXT NOT NULL,
  venue_id TEXT,
  venue_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  triage_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  beer_name TEXT,
  suburb TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_requests_type_status
  ON venue_requests (request_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_requests_venue
  ON venue_requests (venue_id, venue_name, created_at DESC);

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  status TEXT NOT NULL DEFAULT 'active',
  approved_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_user
  ON venue_manager_assignments (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_manager_assignments_venue
  ON venue_manager_assignments (venue_id, status, created_at DESC);

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
  tier_manual_override INTEGER NOT NULL DEFAULT 0,
  accepts_pint_path_codes INTEGER NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_beers_venue
  ON venue_beers (venue_id, on_tap, in_stock, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_beers_name
  ON venue_beers (beer_name, style);

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
  starts_at TEXT,
  ends_at TEXT,
  start_time TEXT,
  end_time TEXT,
  schedule_note TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_specials_venue
  ON venue_specials (venue_id, active, starts_at, ends_at);

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
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  processed_at TEXT NOT NULL
);
