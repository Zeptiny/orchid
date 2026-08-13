/** SQLite schema for session storage. */
import type { SqliteDatabase } from '../utils/sqlite';

/** Current session schema version. */
export const SESSION_SCHEMA_VERSION = 3;

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
  todo_store_json TEXT NOT NULL DEFAULT '{}',
  reasoning_effort_override TEXT,
  tier_override TEXT,
  permission_mode TEXT,
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
  end_time TEXT,
  error_detail TEXT,
  error_title TEXT
);

CREATE TABLE IF NOT EXISTS subagent_chains (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subagent_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (session_id, subagent_id)
);

CREATE INDEX IF NOT EXISTS idx_chains_session ON chains(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;

/**
 * Idempotent column migrations for databases created before the current
 * schema version.
 */
export function applySessionSchemaMigrations(db: SqliteDatabase): void {
  const tables = new Set(
    (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as Array<{ name: string }>)
      .map((row) => row.name),
  );

  if (tables.has('sessions')) {
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const existing = new Set(sessionColumns.map((c) => c.name));
    for (const col of ['tier_override']) {
      if (!existing.has(col)) {
        db.prepare(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`).run();
      }
    }
  }

  if (tables.has('chains')) {
    const chainColumns = db.prepare('PRAGMA table_info(chains)').all() as Array<{ name: string }>;
    const existing = new Set(chainColumns.map((c) => c.name));
    for (const col of ['error_detail', 'error_title']) {
      if (!existing.has(col)) {
        db.prepare(`ALTER TABLE chains ADD COLUMN ${col} TEXT`).run();
      }
    }
  }
}
