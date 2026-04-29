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
