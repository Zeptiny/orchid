/** SQLite schema for session storage. */

/** Current session schema version. */
export const SESSION_SCHEMA_VERSION = 1;

/** Idempotent DDL for the session database. */
export const SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selection_json TEXT,
  model_label TEXT,
  cwd TEXT,
  active_chain_id TEXT,
  subagent_chains_json TEXT NOT NULL DEFAULT '[]',
  todo_store_json TEXT NOT NULL DEFAULT '{}',
  reasoning_effort_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  selection_json TEXT,
  model_label TEXT,
  agent_name TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT '',
  agent_tier TEXT NOT NULL DEFAULT '',
  subagent_record_json TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  start_time TEXT,
  end_time TEXT
);

CREATE INDEX IF NOT EXISTS idx_chains_session ON chains(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;
