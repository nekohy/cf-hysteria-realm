CREATE TABLE IF NOT EXISTS realm_sessions (
  realm_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  addresses TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS realm_sessions_expires_at_idx
  ON realm_sessions (expires_at);

CREATE TABLE IF NOT EXISTS connect_attempts (
  realm_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  response_addresses TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS connect_attempts_realm_nonce_expires_at_idx
  ON connect_attempts (realm_id, nonce, expires_at);

CREATE INDEX IF NOT EXISTS connect_attempts_realm_expires_at_idx
  ON connect_attempts (realm_id, expires_at);

CREATE INDEX IF NOT EXISTS connect_attempts_session_idx
  ON connect_attempts (realm_id, session_id);

CREATE INDEX IF NOT EXISTS connect_attempts_expires_at_idx
  ON connect_attempts (expires_at);

CREATE TABLE IF NOT EXISTS realm_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  realm_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS realm_events_session_sequence_idx
  ON realm_events (realm_id, session_id, sequence);

CREATE TABLE IF NOT EXISTS event_streams (
  session_id TEXT PRIMARY KEY,
  realm_id TEXT NOT NULL,
  stream_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_streams_realm_session_idx
  ON event_streams (realm_id, session_id);
