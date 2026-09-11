-- Metadata-only fixture of reviewed legacy physical schema, including historical index order.
-- No production rows, credentials or provider identities.

CREATE TABLE account_deletion_completion_outbox (
  request_id TEXT PRIMARY KEY REFERENCES account_deletion_requests(id) ON DELETE CASCADE,
  template_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_fingerprint TEXT CHECK (payload_fingerprint IS NULL OR length(payload_fingerprint) = 64),
  secret_purge_checkpoint_pending INTEGER NOT NULL DEFAULT 0
    CHECK (secret_purge_checkpoint_pending IN (0, 1)),
  secret_purge_generation INTEGER NOT NULL DEFAULT 0
    CHECK (secret_purge_generation >= 0),
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'pending', 'sending', 'accepted', 'delivered', 'failed', 'manual_review', 'purged', 'cancelled', 'suppressed_restore')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT UNIQUE,
  provider_last_event TEXT,
  provider_event_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  accepted_at TEXT,
  delivered_at TEXT,
  terminal_at TEXT,
  retention_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE account_deletion_notice_recipient_secrets (
  request_id TEXT PRIMARY KEY REFERENCES account_deletion_completion_outbox(request_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  created_at TEXT NOT NULL,
  purge_after TEXT NOT NULL
);

CREATE TABLE account_deletion_notification_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES account_deletion_completion_outbox(request_id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64)
);

CREATE TABLE account_deletion_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_review',
  user_message TEXT,
  requested_at TEXT NOT NULL,
  execute_after TEXT NOT NULL,
  reviewed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  completed_at TEXT,
  result_summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, processing_started_at TEXT, identity_deleted_at TEXT, stripe_customer_deleted_at TEXT, stripe_customer_id_snapshot TEXT, deletion_tombstone_recorded_at TEXT, last_error TEXT, attempt_count INTEGER NOT NULL DEFAULT 0);

CREATE TABLE account_discount_passes (
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

CREATE TABLE account_preferences (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  preferred_suburbs_json TEXT NOT NULL DEFAULT '[]',
  preferred_beers_json TEXT NOT NULL DEFAULT '[]',
  preferred_use_cases_json TEXT NOT NULL DEFAULT '[]',
  onboarding_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE account_privacy_settings (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  optional_analytics_enabled INTEGER NOT NULL DEFAULT 1,
  venue_report_inclusion_enabled INTEGER NOT NULL DEFAULT 1,
  product_research_enabled INTEGER NOT NULL DEFAULT 1,
  email_updates_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, consent_version TEXT NOT NULL DEFAULT '2026-07-11', consented_at TEXT);

CREATE TABLE account_reward_vouchers (
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

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  age_confirmed_at TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  premium_until TEXT,
  trust_score INTEGER NOT NULL DEFAULT 50,
  contribution_points_current_month INTEGER NOT NULL DEFAULT 0,
  approved_submission_count INTEGER NOT NULL DEFAULT 0,
  rejected_submission_count INTEGER NOT NULL DEFAULT 0,
  fraud_strike_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, display_name TEXT, avatar_url TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', supabase_user_id TEXT, email_verified_at TEXT, mfa_level TEXT NOT NULL DEFAULT 'aal1', mfa_verified_at TEXT, age_verification_status TEXT NOT NULL DEFAULT 'not_started', is_over_18_verified INTEGER NOT NULL DEFAULT 0, terms_accepted_at TEXT, privacy_accepted_at TEXT, terms_version TEXT, privacy_version TEXT, public_account_id TEXT, display_name_key TEXT, stripe_event_created_at TEXT, provider_tokens_valid_after TEXT, stripe_paid_subscription_status TEXT);

CREATE TABLE admin_ingestion_queue (
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
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  rejected_at TEXT
, crawler_feedback_json TEXT, image_retention_expires_at TEXT, image_redacted_at TEXT, image_redaction_reason TEXT, review_claim_token TEXT, review_claimed_at TEXT);

CREATE TABLE age_verifications (
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

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT, last_ip_hash TEXT, user_agent_hash TEXT, provider_session_id_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id)
);

CREATE TABLE beer_catalog_aliases (
  alias_key TEXT PRIMARY KEY,
  beer_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system_catalog',
  created_at TEXT NOT NULL,
  FOREIGN KEY (beer_key) REFERENCES beer_catalog_items(key) ON DELETE CASCADE
);

CREATE TABLE beer_catalog_items (
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

CREATE TABLE beer_price_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT,
  venue_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  suburb TEXT NOT NULL,
  beer_name TEXT NOT NULL,
  price_text TEXT,
  price_numeric REAL,
  availability_status TEXT NOT NULL DEFAULT 'unknown',
  available_on_tap INTEGER,
  available_package_only INTEGER NOT NULL DEFAULT 0,
  unavailable_reason TEXT,
  timestamp TEXT NOT NULL,
  raw_transcript TEXT NOT NULL,
  confidence REAL NOT NULL,
  happy_hour INTEGER NOT NULL DEFAULT 0,
  happy_hour_days TEXT,
  happy_hour_start TEXT,
  happy_hour_end TEXT,
  happy_hour_price REAL,
  happy_hour_confidence REAL NOT NULL DEFAULT 0,
  call_sid TEXT NOT NULL,
  conversation_id TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, happy_hour_specials TEXT,
  UNIQUE(call_sid, beer_name)
);

CREATE TABLE billing_checkout_reservations (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('consumer', 'venue')),
  subject_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  reservation_token TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  checkout_url TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE call_runs (
  id TEXT PRIMARY KEY,
  call_sid TEXT UNIQUE,
  conversation_id TEXT UNIQUE,
  venue_id TEXT,
  venue_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  suburb TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  call_status TEXT NOT NULL DEFAULT 'queued',
  raw_transcript TEXT,
  parse_confidence REAL,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, requested_beer TEXT, script_variant TEXT);

CREATE TABLE call_sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT UNIQUE,
  call_sid TEXT UNIQUE,
  venue_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  suburb TEXT NOT NULL,
  call_status TEXT NOT NULL DEFAULT 'queued',
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  transcript_received_at TEXT,
  raw_transcript TEXT,
  notes TEXT
);

CREATE TABLE contribution_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  submission_id TEXT,
  venue_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE TABLE discount_redemptions (
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
  created_at TEXT NOT NULL, idempotency_key TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (discount_pass_id) REFERENCES account_discount_passes(id) ON DELETE SET NULL,
  FOREIGN KEY (redeemed_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE events (
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

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  feedback_type TEXT NOT NULL,
  message TEXT NOT NULL,
  venue_id TEXT,
  venue_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, priority TEXT NOT NULL DEFAULT 'normal', triage_reason TEXT, contact_email TEXT, assigned_to TEXT, resolution_note TEXT, resolved_at TEXT, resolved_by TEXT);

CREATE TABLE free_pint_reward_codes (
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

CREATE TABLE free_pint_reward_redemptions (
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

CREATE TABLE leaderboard_prize_awards (
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

CREATE TABLE leaderboard_prize_campaigns (
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

CREATE TABLE migration_quarantined_records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  original_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);

CREATE TABLE mission_progress (
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

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  points INTEGER NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sponsor_flag INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pint_point_drink_records (
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
  created_at TEXT NOT NULL, points_awarded INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT, status TEXT NOT NULL DEFAULT 'active', voided_at TEXT, voided_by_user_id TEXT, void_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_code_id) REFERENCES free_pint_reward_codes(id) ON DELETE SET NULL,
  FOREIGN KEY (recorded_by_user_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE pint_point_ledger (
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

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  username TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  account_status TEXT NOT NULL DEFAULT 'active',
  age_verification_status TEXT NOT NULL DEFAULT 'not_started',
  is_over_18_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, public_account_id TEXT, display_name_key TEXT,
  FOREIGN KEY (id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE revoked_provider_sessions (
  user_id TEXT NOT NULL,
  provider_session_id_hash TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_session_id_hash),
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE saved_items (
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

CREATE TABLE security_audit_log (
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

CREATE TABLE source_evidence_objects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'sqlite_private',
  object_path TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  byte_size INTEGER,
  data_base64 TEXT,
  external_url TEXT,
  created_at TEXT NOT NULL, retention_expires_at TEXT, deleted_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES accounts(id)
);

CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
, status TEXT NOT NULL DEFAULT 'applied', event_created_at TEXT, payload_json TEXT, attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT, received_at TEXT, applied_at TEXT, processing_token TEXT);

CREATE TABLE submission_items (
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
  created_at TEXT NOT NULL, capture_source TEXT NOT NULL DEFAULT 'manual', source_text TEXT, requires_catalog_approval INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE TABLE submission_source_evidence (
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, evidence_id),
  UNIQUE (submission_id, sort_order),
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES source_evidence_objects(id) ON DELETE CASCADE
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  submission_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_photo_url TEXT,
  notes TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  fraud_flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, upload_latitude REAL, upload_longitude REAL, upload_accuracy_meters REAL, upload_location_captured_at TEXT, distance_to_venue_meters REAL, points_eligible_by_location INTEGER NOT NULL DEFAULT 0, points_eligibility_reason TEXT, pending_venue_json TEXT, client_submission_id TEXT, ocr_status TEXT NOT NULL DEFAULT 'not_requested', ocr_summary_json TEXT, mission_id TEXT,
  FOREIGN KEY (user_id) REFERENCES accounts(id),
  FOREIGN KEY (reviewed_by) REFERENCES accounts(id)
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  revision TEXT NOT NULL CHECK (length(revision) > 0)
);

CREATE TABLE user_activity_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE venue_analytics_events (
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

CREATE TABLE venue_beers (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  beer_name TEXT NOT NULL,
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
, normalized_beer_id TEXT, price_verified_at TEXT, stock_verified_at TEXT, source_ingestion_id TEXT);

CREATE TABLE venue_claim_requests (
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
, review_note TEXT, reviewed_by TEXT, reviewed_at TEXT);

CREATE TABLE venue_happy_hours (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  days_of_week_json TEXT NOT NULL DEFAULT '[]',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, happy_hour_beers_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE venue_identity_aliases (
  alias_venue_id TEXT PRIMARY KEY,
  canonical_venue_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'automatic_exact_match',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE venue_interest_requests (
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
, assigned_to TEXT, resolution_note TEXT, resolved_at TEXT, resolved_by TEXT);

CREATE TABLE venue_location_cache (
  venue_id TEXT PRIMARY KEY,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  latitude REAL,
  longitude REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE venue_manager_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  approved_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, access_level TEXT NOT NULL DEFAULT 'manager', expires_at TEXT,
  UNIQUE (user_id, venue_id)
);

CREATE TABLE venue_monthly_reports (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (venue_id, month)
);

CREATE TABLE venue_partner_outreach (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  suburb TEXT,
  status TEXT NOT NULL DEFAULT 'lead',
  contact_name TEXT,
  notes TEXT,
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, tier_fit TEXT, next_action TEXT, last_contacted_at TEXT,
  UNIQUE (venue_id)
);

CREATE TABLE venue_pending_changes (
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

CREATE TABLE venue_price_records (
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
  updated_at TEXT NOT NULL, source_ingestion_id TEXT, source_evidence_reference TEXT, source_evidence_verified_at TEXT,
  FOREIGN KEY (source_submission_id) REFERENCES submissions(id)
);

CREATE TABLE venue_profiles (
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
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, accepts_pint_path_codes INTEGER NOT NULL DEFAULT 0, stripe_event_created_at TEXT, pos_webhook_token_version INTEGER NOT NULL DEFAULT 1, stripe_paid_membership_tier TEXT, pos_previous_token_version INTEGER, pos_previous_token_valid_until TEXT, pos_last_success_at TEXT, pos_last_terminal_id TEXT, subscription_current_period_end TEXT, intro_trial_ever_claimed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE venue_requests (
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
, assigned_to TEXT, resolution_note TEXT, resolved_at TEXT, resolved_by TEXT, google_place_id TEXT, source_submission_id TEXT);

CREATE TABLE venue_specials (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue_profiles(venue_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL,
  discount TEXT,
  starts_at TEXT,
  ends_at TEXT,
  schedule_note TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, start_time TEXT, end_time TEXT, savings_amount_cents INTEGER, recurrence_frequency TEXT NOT NULL DEFAULT 'none', days_of_week_json TEXT NOT NULL DEFAULT '[]', timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne');

CREATE TABLE verifications (
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

CREATE TABLE wrong_price_reports (
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
, assigned_to TEXT, resolution_note TEXT, resolved_at TEXT, resolved_by TEXT);

CREATE INDEX idx_account_deletion_completion_outbox_due
  ON account_deletion_completion_outbox (status, next_attempt_at, lease_expires_at);

CREATE INDEX idx_account_deletion_completion_outbox_retention
  ON account_deletion_completion_outbox (retention_expires_at)
  WHERE status IN ('held', 'pending', 'sending', 'accepted', 'manual_review');

CREATE INDEX idx_account_deletion_notice_recipient_secrets_purge
  ON account_deletion_notice_recipient_secrets (purge_after);

CREATE INDEX idx_account_deletion_notification_events_request
  ON account_deletion_notification_events (request_id, event_created_at DESC);

CREATE INDEX idx_account_deletion_notification_events_retention
  ON account_deletion_notification_events (received_at, event_id COLLATE BINARY);

CREATE INDEX idx_account_deletion_requests_status
  ON account_deletion_requests (status, execute_after, requested_at DESC);

CREATE UNIQUE INDEX idx_account_deletion_requests_open_user
  ON account_deletion_requests (user_id)
  WHERE status IN ('pending_review', 'approved');

CREATE INDEX idx_account_deletion_requests_reviewed_by
  ON account_deletion_requests (reviewed_by);

CREATE UNIQUE INDEX idx_account_deletion_requests_unfinished_user
  ON account_deletion_requests (user_id)
  WHERE status IN ('pending_review', 'approved', 'processing', 'failed');

CREATE INDEX idx_account_discount_passes_user
  ON account_discount_passes (user_id, status, expires_at DESC);

CREATE INDEX idx_account_discount_passes_session
  ON account_discount_passes (session_token_hash, status, expires_at DESC);

CREATE INDEX idx_account_privacy_settings_updated
  ON account_privacy_settings (updated_at DESC);

CREATE INDEX idx_account_reward_vouchers_user
  ON account_reward_vouchers (user_id, status, issued_at DESC);

CREATE INDEX idx_accounts_email
  ON accounts (email);

CREATE INDEX idx_accounts_stripe_customer
  ON accounts (stripe_customer_id);

CREATE INDEX idx_accounts_supabase_user
      ON accounts (supabase_user_id);

CREATE INDEX idx_accounts_email_verified
      ON accounts (email_verified_at, updated_at DESC);

CREATE UNIQUE INDEX idx_accounts_public_account
      ON accounts (public_account_id);

CREATE UNIQUE INDEX idx_accounts_display_name_key
      ON accounts (display_name_key)
      WHERE display_name_key IS NOT NULL;

CREATE INDEX idx_admin_ingestion_queue_status_created
  ON admin_ingestion_queue (status, created_at DESC);

CREATE INDEX idx_admin_ingestion_queue_venue_status
  ON admin_ingestion_queue (venue_id, status, created_at DESC);

CREATE INDEX idx_admin_ingestion_queue_image_retention
  ON admin_ingestion_queue (status, image_retention_expires_at, created_at)
  WHERE image_data_url IS NOT NULL;

CREATE INDEX idx_age_verifications_user
  ON age_verifications (user_id, created_at DESC);

CREATE INDEX idx_age_verifications_status
  ON age_verifications (status, updated_at DESC);

CREATE INDEX idx_auth_sessions_user
  ON auth_sessions (user_id, expires_at DESC);

CREATE INDEX idx_auth_sessions_active
      ON auth_sessions (user_id, revoked_at, expires_at DESC);

CREATE INDEX idx_auth_sessions_provider_session
  ON auth_sessions (user_id, provider_session_id_hash);

CREATE INDEX idx_auth_sessions_retention_revoked
  ON auth_sessions (revoked_at, token_hash COLLATE BINARY)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX idx_auth_sessions_retention_expired
  ON auth_sessions (expires_at, token_hash COLLATE BINARY);

CREATE INDEX idx_beer_catalog_aliases_beer
  ON beer_catalog_aliases (beer_key);

CREATE INDEX idx_beer_catalog_items_status
  ON beer_catalog_items (status, updated_at DESC);

CREATE INDEX idx_beer_catalog_items_name
  ON beer_catalog_items (name COLLATE NOCASE);

CREATE INDEX idx_beer_price_results_timestamp
  ON beer_price_results (timestamp DESC);

CREATE INDEX idx_beer_price_results_needs_review
  ON beer_price_results (needs_review, timestamp DESC);

CREATE INDEX idx_beer_price_results_venue_id
      ON beer_price_results (venue_id, timestamp DESC);

CREATE UNIQUE INDEX idx_billing_checkout_reservation_token
  ON billing_checkout_reservations (reservation_token);

CREATE INDEX idx_call_runs_call_status
  ON call_runs (call_status, updated_at DESC);

CREATE INDEX idx_call_runs_phone_started
  ON call_runs (phone_number, started_at DESC);

CREATE INDEX idx_call_runs_parse_status
  ON call_runs (parse_status, updated_at DESC);

CREATE INDEX idx_call_runs_venue_id
      ON call_runs (venue_id, created_at DESC);

CREATE INDEX idx_call_sessions_call_status
  ON call_sessions (call_status, updated_at DESC);

CREATE UNIQUE INDEX idx_contribution_ledger_user_venue_month
  ON contribution_ledger (user_id, venue_id, month_key);

CREATE INDEX idx_contribution_ledger_submission
  ON contribution_ledger (submission_id);

CREATE INDEX idx_contribution_ledger_created_points
  ON contribution_ledger (created_at, points);

CREATE INDEX idx_discount_redemptions_user
  ON discount_redemptions (user_id, redeemed_at DESC);

CREATE INDEX idx_discount_redemptions_venue
  ON discount_redemptions (venue_id, redeemed_at DESC);

CREATE INDEX idx_discount_redemptions_suburb
  ON discount_redemptions (suburb, redeemed_at DESC);

CREATE UNIQUE INDEX idx_discount_redemptions_idempotency
  ON discount_redemptions (venue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_discount_redemptions_redeemed_by
  ON discount_redemptions (redeemed_by_user_id);

CREATE INDEX idx_discount_redemptions_pass
  ON discount_redemptions (discount_pass_id);

CREATE UNIQUE INDEX idx_discount_redemptions_pass_once
  ON discount_redemptions (discount_pass_id)
  WHERE discount_pass_id IS NOT NULL;

CREATE INDEX idx_events_type_created
  ON events (event_type, created_at DESC);

CREATE INDEX idx_events_venue_created
  ON events (venue_id, created_at DESC);

CREATE INDEX idx_events_suburb_type_created
  ON events (suburb, event_type, created_at DESC);

CREATE INDEX idx_events_beer_created
  ON events (beer_id, created_at DESC);

CREATE INDEX idx_events_user
  ON events (user_id);

CREATE INDEX idx_feedback_status_created
  ON feedback (status, created_at DESC);

CREATE INDEX idx_feedback_priority_created
      ON feedback (priority, created_at DESC);

CREATE INDEX idx_feedback_user
  ON feedback (user_id);

CREATE INDEX idx_feedback_workflow
      ON feedback (status, assigned_to, updated_at DESC);

CREATE INDEX idx_feedback_assigned_to
  ON feedback (assigned_to);

CREATE INDEX idx_feedback_resolved_by
  ON feedback (resolved_by);

CREATE INDEX idx_free_pint_reward_codes_user
  ON free_pint_reward_codes (user_id, status, expires_at DESC);

CREATE INDEX idx_free_pint_reward_codes_code
  ON free_pint_reward_codes (code_hash);

CREATE INDEX idx_free_pint_reward_codes_venue
  ON free_pint_reward_codes (redeemed_venue_id, status, used_at DESC);

CREATE INDEX idx_free_pint_reward_codes_redeemed_by
  ON free_pint_reward_codes (redeemed_by_user_id);

CREATE INDEX idx_free_pint_reward_redemptions_user
  ON free_pint_reward_redemptions (user_id, redeemed_at DESC);

CREATE INDEX idx_free_pint_reward_redemptions_venue
  ON free_pint_reward_redemptions (venue_id, redeemed_at DESC);

CREATE INDEX idx_free_pint_reward_redemptions_redeemed_by
  ON free_pint_reward_redemptions (redeemed_by_user_id);

CREATE INDEX idx_free_pint_reward_redemptions_reward
  ON free_pint_reward_redemptions (reward_code_id);

CREATE INDEX idx_leaderboard_prize_awards_user
  ON leaderboard_prize_awards (user_id, month_key DESC);

CREATE INDEX idx_leaderboard_prize_awards_voucher
  ON leaderboard_prize_awards (voucher_id);

CREATE INDEX idx_migration_quarantine_entity
  ON migration_quarantined_records (entity_type, original_id, quarantined_at DESC);

CREATE INDEX idx_migration_quarantined_records_retention
  ON migration_quarantined_records (quarantined_at, id COLLATE BINARY)
  WHERE payload_json <> '{"redactedAfterRetention":true}';

CREATE INDEX idx_mission_progress_user_status
  ON mission_progress (user_id, status, updated_at DESC);

CREATE INDEX idx_mission_progress_submission
  ON mission_progress (submission_id);

CREATE INDEX idx_mission_progress_acceptance_expiry
  ON mission_progress (status, accepted_at);

CREATE UNIQUE INDEX idx_mission_progress_open_reservation
  ON mission_progress (mission_id)
  WHERE status IN ('accepted', 'submitted');

CREATE INDEX idx_mission_progress_user_updated_cursor
  ON mission_progress (user_id, updated_at DESC, id ASC);

CREATE INDEX idx_missions_active_priority
  ON missions (active, priority, updated_at DESC);

CREATE INDEX idx_missions_updated_cursor
  ON missions (updated_at DESC, id ASC);

CREATE INDEX idx_missions_active_updated_cursor
  ON missions (active, updated_at DESC, id ASC);

CREATE INDEX idx_missions_admin_active_score
  ON missions ((points * multiplier) DESC, updated_at DESC, id ASC, venue_name)
  WHERE active;

CREATE INDEX idx_missions_venue_updated_id
  ON missions (venue_id, updated_at DESC, id ASC, venue_name);

CREATE INDEX idx_pint_point_drink_records_user
  ON pint_point_drink_records (user_id, recorded_at DESC);

CREATE INDEX idx_pint_point_drink_records_venue
  ON pint_point_drink_records (venue_id, recorded_at DESC);

CREATE INDEX idx_pint_point_drink_records_suburb
  ON pint_point_drink_records (suburb, recorded_at DESC);

CREATE UNIQUE INDEX idx_pint_point_drink_records_idempotency
  ON pint_point_drink_records (venue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_pint_point_drink_records_recorded_by
  ON pint_point_drink_records (recorded_by_user_id);

CREATE INDEX idx_pint_point_drink_records_reward
  ON pint_point_drink_records (reward_code_id);

CREATE INDEX idx_pint_point_drink_records_venue_status
      ON pint_point_drink_records (venue_id, status, recorded_at DESC);

CREATE UNIQUE INDEX idx_pint_point_drink_records_member_pass_once
  ON pint_point_drink_records (idempotency_key)
  WHERE idempotency_key LIKE 'member-pass:%';

CREATE INDEX idx_pint_point_drink_records_voided_by
  ON pint_point_drink_records (voided_by_user_id);

CREATE INDEX idx_pint_point_ledger_user
  ON pint_point_ledger (user_id, created_at DESC);

CREATE INDEX idx_pint_point_ledger_venue
  ON pint_point_ledger (venue_id, created_at DESC);

CREATE INDEX idx_pint_point_ledger_reward
  ON pint_point_ledger (reward_code_id);

CREATE INDEX idx_pint_point_ledger_drink
  ON pint_point_ledger (drink_record_id);

CREATE INDEX idx_profiles_status
  ON profiles (account_status, updated_at DESC);

CREATE INDEX idx_profiles_public_account
      ON profiles (public_account_id);

CREATE UNIQUE INDEX idx_profiles_display_name_key
      ON profiles (display_name_key)
      WHERE display_name_key IS NOT NULL;

CREATE INDEX idx_revoked_provider_sessions_user
  ON revoked_provider_sessions (user_id, revoked_at DESC);

CREATE INDEX idx_revoked_provider_sessions_retention
  ON revoked_provider_sessions (
    revoked_at,
    user_id COLLATE BINARY,
    provider_session_id_hash COLLATE BINARY
  )
  WHERE reason IN ('password_reset_completed', 'all_app_sessions_revoked');

CREATE INDEX idx_saved_items_user_type
  ON saved_items (user_id, item_type, created_at DESC);

CREATE INDEX idx_security_audit_log_created
  ON security_audit_log (created_at DESC);

CREATE INDEX idx_security_audit_log_action
  ON security_audit_log (action, created_at DESC);

CREATE INDEX idx_source_evidence_owner
  ON source_evidence_objects (owner_user_id, created_at DESC);

CREATE INDEX idx_source_evidence_retention
  ON source_evidence_objects (deleted_at, retention_expires_at);

CREATE INDEX idx_stripe_webhook_events_status
  ON stripe_webhook_events (status, received_at);

CREATE INDEX idx_submission_items_submission
  ON submission_items (submission_id);

CREATE INDEX idx_submission_source_evidence_submission
  ON submission_source_evidence (submission_id, sort_order);

CREATE INDEX idx_submission_source_evidence_evidence
  ON submission_source_evidence (evidence_id);

CREATE INDEX idx_submissions_status_created
  ON submissions (status, created_at DESC);

CREATE INDEX idx_submissions_user_created
  ON submissions (user_id, created_at DESC);

CREATE INDEX idx_submissions_user_venue_month
  ON submissions (user_id, venue_id, observed_at);

CREATE UNIQUE INDEX idx_submissions_user_client_submission
      ON submissions (user_id, client_submission_id)
      WHERE client_submission_id IS NOT NULL;

CREATE INDEX idx_submissions_reviewed_by
  ON submissions (reviewed_by);

CREATE INDEX idx_submissions_mission
  ON submissions (mission_id, status, created_at DESC);

CREATE INDEX idx_submissions_venue_created_id
  ON submissions (venue_id, created_at DESC, id COLLATE BINARY);

CREATE INDEX idx_submissions_reviewed_location_retention
  ON submissions (reviewed_at, id COLLATE BINARY)
  WHERE reviewed_at IS NOT NULL
    AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
    AND (
      upload_latitude IS NOT NULL
      OR upload_longitude IS NOT NULL
      OR upload_accuracy_meters IS NOT NULL
      OR upload_location_captured_at IS NOT NULL
    );

CREATE INDEX idx_user_activity_user_created
  ON user_activity_events (user_id, created_at DESC);

CREATE INDEX idx_user_activity_type
  ON user_activity_events (event_type, created_at DESC);

CREATE INDEX idx_venue_analytics_events_venue
  ON venue_analytics_events (venue_id, event_type, created_at DESC);

CREATE INDEX idx_venue_analytics_events_area
  ON venue_analytics_events (area, event_type, created_at DESC);

CREATE INDEX idx_venue_analytics_events_suburb
      ON venue_analytics_events (suburb, event_type, created_at DESC);

CREATE INDEX idx_venue_beers_venue
  ON venue_beers (venue_id, on_tap, in_stock, updated_at DESC);

CREATE INDEX idx_venue_beers_name
  ON venue_beers (beer_name, style);

CREATE INDEX idx_venue_beers_normalized
      ON venue_beers (normalized_beer_id, updated_at DESC);

CREATE INDEX idx_venue_beers_source_ingestion
  ON venue_beers (source_ingestion_id)
  WHERE source_ingestion_id IS NOT NULL;

CREATE INDEX idx_venue_claim_requests_user
  ON venue_claim_requests (user_id, status, created_at DESC);

CREATE INDEX idx_venue_claim_requests_status
  ON venue_claim_requests (status, created_at DESC);

CREATE INDEX idx_venue_claim_requests_venue
  ON venue_claim_requests (venue_id, venue_name, suburb);

CREATE INDEX idx_venue_claim_requests_reviewed_by
  ON venue_claim_requests (reviewed_by);

CREATE INDEX idx_venue_happy_hours_venue
  ON venue_happy_hours (venue_id, active, updated_at DESC);

CREATE INDEX idx_venue_identity_aliases_canonical
  ON venue_identity_aliases (canonical_venue_id, updated_at DESC);

CREATE INDEX idx_venue_identity_aliases_identity
  ON venue_identity_aliases (identity_key, updated_at DESC);

CREATE INDEX idx_venue_interest_status_created
  ON venue_interest_requests (status, created_at DESC);

CREATE INDEX idx_venue_interest_venue
  ON venue_interest_requests (venue_id, venue_name, created_at DESC);

CREATE INDEX idx_venue_interest_requests_user
  ON venue_interest_requests (user_id);

CREATE INDEX idx_venue_interest_requests_workflow
      ON venue_interest_requests (status, assigned_to, updated_at DESC);

CREATE INDEX idx_venue_interest_requests_assigned_to
  ON venue_interest_requests (assigned_to);

CREATE INDEX idx_venue_interest_requests_resolved_by
  ON venue_interest_requests (resolved_by);

CREATE INDEX idx_venue_interest_created_id
  ON venue_interest_requests (created_at DESC, id ASC);

CREATE INDEX idx_venue_location_cache_suburb
  ON venue_location_cache (suburb, updated_at DESC);

CREATE INDEX idx_venue_location_cache_duplicate_name
  ON venue_location_cache (
    lower(trim(venue_name)),
    lower(trim(COALESCE(suburb, ''))),
    venue_id COLLATE BINARY
  );

CREATE INDEX idx_venue_manager_assignments_user
  ON venue_manager_assignments (user_id, status, created_at DESC);

CREATE INDEX idx_venue_manager_assignments_venue
  ON venue_manager_assignments (venue_id, status, created_at DESC);

CREATE INDEX idx_venue_manager_assignments_approved_by
  ON venue_manager_assignments (approved_by);

CREATE INDEX idx_venue_manager_assignments_access
      ON venue_manager_assignments (venue_id, access_level, status, updated_at DESC);

CREATE INDEX idx_venue_manager_assignments_expiry
  ON venue_manager_assignments (status, access_level, expires_at);

CREATE INDEX idx_venue_monthly_reports_venue
  ON venue_monthly_reports (venue_id, month DESC);

CREATE INDEX idx_venue_partner_outreach_status
  ON venue_partner_outreach (status, updated_at DESC);

CREATE INDEX idx_venue_partner_outreach_updated_by
  ON venue_partner_outreach (updated_by);

CREATE INDEX idx_venue_partner_outreach_updated_id
  ON venue_partner_outreach (updated_at DESC, venue_id ASC);

CREATE INDEX idx_venue_pending_changes_venue_status
  ON venue_pending_changes (venue_id, status, submitted_at DESC);

CREATE INDEX idx_venue_pending_changes_submitter_status
  ON venue_pending_changes (submitted_by, status, submitted_at DESC);

CREATE INDEX idx_venue_pending_changes_status
  ON venue_pending_changes (status, submitted_at DESC);

CREATE INDEX idx_venue_pending_changes_review
      ON venue_pending_changes (status, reviewed_at DESC, submitted_at DESC);

CREATE INDEX idx_venue_pending_changes_reviewed_by
  ON venue_pending_changes (reviewed_by);

CREATE INDEX idx_venue_price_records_venue
  ON venue_price_records (venue_id, last_verified_at DESC);

CREATE INDEX idx_venue_price_records_beer
  ON venue_price_records (normalized_beer_id, last_verified_at DESC);

CREATE INDEX idx_venue_price_records_source_submission
  ON venue_price_records (source_submission_id);

CREATE INDEX idx_venue_price_records_feed
  ON venue_price_records (last_verified_at DESC, id DESC);

CREATE INDEX idx_venue_price_records_duplicate_name
  ON venue_price_records (
    lower(trim(venue_name)),
    lower(trim(COALESCE(suburb, ''))),
    venue_id COLLATE BINARY,
    id COLLATE BINARY
  );

CREATE INDEX idx_venue_price_records_venue_normalized_beer
  ON venue_price_records (venue_id, normalized_beer_id)
  WHERE normalized_beer_id IS NOT NULL;

CREATE INDEX idx_venue_price_records_venue_beer_name
  ON venue_price_records (venue_id, lower(trim(beer_name)));

CREATE INDEX idx_venue_price_records_source_ingestion
  ON venue_price_records (source_ingestion_id)
  WHERE source_ingestion_id IS NOT NULL;

CREATE INDEX idx_venue_price_records_source_evidence_reference
  ON venue_price_records (source_evidence_reference)
  WHERE source_evidence_reference IS NOT NULL;

CREATE INDEX idx_venue_profiles_membership
  ON venue_profiles (membership_tier, active, updated_at DESC);

CREATE INDEX idx_venue_profiles_area
  ON venue_profiles (area, suburb, active);

CREATE INDEX idx_venue_profiles_stripe_subscription
      ON venue_profiles (stripe_subscription_id);

CREATE INDEX idx_venue_profiles_duplicate_name
  ON venue_profiles (
    lower(trim(name)),
    lower(trim(COALESCE(suburb, ''))),
    venue_id COLLATE BINARY
  )
  WHERE active = 1;

CREATE INDEX idx_venue_requests_type_status
  ON venue_requests (request_type, status, created_at DESC);

CREATE INDEX idx_venue_requests_venue
  ON venue_requests (venue_id, venue_name, created_at DESC);

CREATE INDEX idx_venue_requests_mission
  ON venue_requests (mission_id);

CREATE INDEX idx_venue_requests_user
  ON venue_requests (user_id);

CREATE INDEX idx_venue_requests_workflow
      ON venue_requests (status, assigned_to, updated_at DESC);

CREATE INDEX idx_venue_requests_google_place
  ON venue_requests (google_place_id, request_type, status, created_at DESC);

CREATE UNIQUE INDEX idx_venue_requests_user_google_open
  ON venue_requests (user_id, google_place_id)
  WHERE user_id IS NOT NULL
    AND google_place_id IS NOT NULL
    AND request_type = 'missing_venue'
    AND status IN ('open', 'in_progress', 'mission_created');

CREATE UNIQUE INDEX idx_venue_requests_anon_google_open
  ON venue_requests (anonymous_session_id, google_place_id)
  WHERE user_id IS NULL
    AND anonymous_session_id IS NOT NULL
    AND google_place_id IS NOT NULL
    AND request_type = 'missing_venue'
    AND status IN ('open', 'in_progress', 'mission_created');

CREATE INDEX idx_venue_requests_assigned_to
  ON venue_requests (assigned_to);

CREATE INDEX idx_venue_requests_resolved_by
  ON venue_requests (resolved_by);

CREATE INDEX idx_venue_requests_created_id
  ON venue_requests (created_at DESC, id ASC);

CREATE INDEX idx_venue_requests_source_submission
  ON venue_requests (source_submission_id);

CREATE INDEX idx_venue_specials_venue
  ON venue_specials (venue_id, active, starts_at, ends_at);

CREATE INDEX idx_verifications_user
  ON verifications (verifier_user_id, created_at DESC);

CREATE INDEX idx_verifications_target
  ON verifications (target_entity_type, target_entity_id, created_at DESC);

CREATE INDEX idx_verifications_upload
  ON verifications (upload_id);

CREATE INDEX idx_wrong_price_reports_record
  ON wrong_price_reports (price_record_id, status, created_at DESC);

CREATE INDEX idx_wrong_price_reports_user
  ON wrong_price_reports (user_id);

CREATE INDEX idx_wrong_price_reports_workflow
      ON wrong_price_reports (status, assigned_to, updated_at DESC);

CREATE INDEX idx_wrong_price_reports_assigned_to
  ON wrong_price_reports (assigned_to);

CREATE INDEX idx_wrong_price_reports_resolved_by
  ON wrong_price_reports (resolved_by);

CREATE INDEX idx_wrong_price_reports_venue_created_id
  ON wrong_price_reports (venue_id, created_at DESC, id COLLATE BINARY);

CREATE TRIGGER clear_added_account_references_before_delete
    BEFORE DELETE ON accounts
    BEGIN
      UPDATE pint_point_drink_records SET voided_by_user_id = NULL WHERE voided_by_user_id = OLD.id;
      UPDATE venue_claim_requests SET reviewed_by = NULL WHERE reviewed_by = OLD.id;
    END;

CREATE TRIGGER validate_pint_point_status_insert
    BEFORE INSERT ON pint_point_drink_records
    WHEN NEW.status NOT IN ('active', 'void')
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point record status');
    END;

CREATE TRIGGER validate_pint_point_status_update
    BEFORE UPDATE OF status ON pint_point_drink_records
    WHEN NEW.status NOT IN ('active', 'void')
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point record status');
    END;

CREATE TRIGGER validate_pint_point_voided_by_insert
    BEFORE INSERT ON pint_point_drink_records
    WHEN NEW.voided_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.voided_by_user_id)
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point voiding account');
    END;

CREATE TRIGGER validate_pint_point_voided_by_update
    BEFORE UPDATE OF voided_by_user_id ON pint_point_drink_records
    WHEN NEW.voided_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.voided_by_user_id)
    BEGIN
      SELECT RAISE(ABORT, 'invalid pint point voiding account');
    END;

CREATE TRIGGER validate_venue_claim_insert
    BEFORE INSERT ON venue_claim_requests
    WHEN NEW.status NOT IN ('pending', 'approved', 'rejected')
      OR (NEW.reviewed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.reviewed_by))
      OR (NEW.status = 'pending' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
      OR (NEW.status IN ('approved', 'rejected') AND julianday(NEW.reviewed_at) IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue claim review state');
    END;

CREATE TRIGGER validate_venue_claim_update
    BEFORE UPDATE OF status, reviewed_by, reviewed_at ON venue_claim_requests
    WHEN NEW.status NOT IN ('pending', 'approved', 'rejected')
      OR (NEW.reviewed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.reviewed_by))
      OR (NEW.status = 'pending' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
      OR (NEW.status IN ('approved', 'rejected') AND julianday(NEW.reviewed_at) IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue claim review state');
    END;

CREATE TRIGGER validate_venue_assignment_insert
    BEFORE INSERT ON venue_manager_assignments
    WHEN NEW.access_level NOT IN ('manager', 'counter_staff')
      OR NEW.status NOT IN ('active', 'pending', 'revoked')
      OR (NEW.status = 'pending' AND (NEW.access_level != 'counter_staff' OR julianday(NEW.expires_at) IS NULL))
      OR (NEW.status != 'pending' AND NEW.expires_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue assignment state');
    END;

CREATE TRIGGER validate_venue_assignment_update
    BEFORE UPDATE OF access_level, status, expires_at ON venue_manager_assignments
    WHEN NEW.access_level NOT IN ('manager', 'counter_staff')
      OR NEW.status NOT IN ('active', 'pending', 'revoked')
      OR (NEW.status = 'pending' AND (NEW.access_level != 'counter_staff' OR julianday(NEW.expires_at) IS NULL))
      OR (NEW.status != 'pending' AND NEW.expires_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'invalid venue assignment state');
    END;

PRAGMA user_version = 16;
