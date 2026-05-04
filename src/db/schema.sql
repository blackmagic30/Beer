PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS call_sessions (
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

CREATE INDEX IF NOT EXISTS idx_call_sessions_call_status
  ON call_sessions (call_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS call_runs (
  id TEXT PRIMARY KEY,
  call_sid TEXT UNIQUE,
  conversation_id TEXT UNIQUE,
  venue_id TEXT,
  requested_beer TEXT,
  script_variant TEXT,
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
);

CREATE INDEX IF NOT EXISTS idx_call_runs_call_status
  ON call_runs (call_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_runs_phone_started
  ON call_runs (phone_number, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_runs_parse_status
  ON call_runs (parse_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS beer_price_results (
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
  happy_hour_specials TEXT,
  call_sid TEXT NOT NULL,
  conversation_id TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(call_sid, beer_name)
);

CREATE INDEX IF NOT EXISTS idx_beer_price_results_timestamp
  ON beer_price_results (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_beer_price_results_needs_review
  ON beer_price_results (needs_review, timestamp DESC);

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

CREATE TABLE IF NOT EXISTS accounts (
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
);

CREATE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts (email);

CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer
  ON accounts (stripe_customer_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS submissions (
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
  points INTEGER NOT NULL,
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
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES accounts(id),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contribution_ledger_user_venue_month
  ON contribution_ledger (user_id, venue_id, month_key);

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

CREATE TABLE IF NOT EXISTS feedback (
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

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
