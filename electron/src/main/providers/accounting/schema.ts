import type { SqliteDatabase } from '../../utils/sqlite';

/** SQLite schema version for append-only provider attempt records. */
export const ACCOUNTING_SCHEMA_VERSION = 6;

export const ACCOUNTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_attempts (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chain_id TEXT,
  turn_id TEXT,
  sdk_call_id TEXT,
  provider_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'interrupted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  first_token_at TEXT,
  usage_json TEXT,
  provider_evidence_json TEXT NOT NULL DEFAULT '{}',
  cost_state TEXT NOT NULL CHECK (cost_state IN ('reported', 'calculated', 'unknown')),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('provider-reported', 'token-formula', 'energy-formula', 'unknown')),
  cost_rung TEXT CHECK (cost_rung IS NULL OR cost_rung IN ('provider-api', 'user', 'catalog')),
  currency TEXT,
  cost_amount TEXT,
  error TEXT,
  agent_scope TEXT,
  agent_name TEXT,
  agent_tier TEXT,
  agent_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_attempts_session ON provider_attempts(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_chain ON provider_attempts(chain_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_turn ON provider_attempts(turn_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_outcome ON provider_attempts(outcome, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_model ON provider_attempts(model_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_provider ON provider_attempts(provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_started ON provider_attempts(started_at);

CREATE TABLE IF NOT EXISTS tool_attempts (
  tool_attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chain_id TEXT,
  turn_id TEXT,
  provider_attempt_id TEXT REFERENCES provider_attempts(attempt_id) ON DELETE SET NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_source TEXT NOT NULL CHECK (tool_source IN ('builtin', 'mcp')),
  mcp_server_name TEXT,
  tool_family TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'complete', 'partial', 'empty', 'error', 'cancelled')),
  result_size_bytes INTEGER,
  offloaded INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  agent_scope TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_attempts_session ON tool_attempts(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_attempts_chain ON tool_attempts(chain_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_attempts_name ON tool_attempts(tool_name, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_attempts_outcome ON tool_attempts(outcome, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_attempts_provider_attempt ON tool_attempts(provider_attempt_id);
CREATE INDEX IF NOT EXISTS idx_tool_attempts_started ON tool_attempts(started_at);

CREATE TABLE IF NOT EXISTS context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chain_id TEXT,
  turn_id TEXT,
  provider_attempt_id TEXT REFERENCES provider_attempts(attempt_id) ON DELETE SET NULL,
  agent_scope TEXT,
  captured_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  system_tokens INTEGER NOT NULL DEFAULT 0,
  tools_tokens INTEGER NOT NULL DEFAULT 0,
  tool_use_tokens INTEGER NOT NULL DEFAULT 0,
  user_tokens INTEGER NOT NULL DEFAULT 0,
  assistant_tokens INTEGER NOT NULL DEFAULT 0,
  summary_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON context_snapshots(session_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_chain ON context_snapshots(chain_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_turn ON context_snapshots(turn_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_provider_attempt ON context_snapshots(provider_attempt_id);

CREATE TABLE IF NOT EXISTS subagent_attribution (
  attribution_id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  parent_chain_id TEXT,
  agent_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_tier TEXT NOT NULL,
  model_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted'))
);

CREATE INDEX IF NOT EXISTS idx_subagent_attribution_session ON subagent_attribution(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_subagent_attribution_chain ON subagent_attribution(chain_id);
CREATE INDEX IF NOT EXISTS idx_subagent_attribution_agent_name ON subagent_attribution(agent_name);
CREATE INDEX IF NOT EXISTS idx_subagent_attribution_status ON subagent_attribution(status);

-- Session-name tombstones: written best-effort when a session is deleted so
-- analytics keeps the last-known name. Retention note: rows are never pruned,
-- and the name (often auto-generated from chat content) deliberately outlives
-- the session — a future "clear analytics" flow must DELETE from here too.
CREATE TABLE IF NOT EXISTS session_names (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
`;

/**
 * Idempotent column migrations for databases created before the current
 * schema version. Every store that opens accounting.db runs this so the
 * columns exist regardless of which store connects first.
 */
export function applyAccountingSchemaMigrations(db: SqliteDatabase): void {
  const tables = new Set(
    (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as Array<{ name: string }>)
      .map((row) => row.name),
  );

  if (tables.has('provider_attempts')) {
    const attemptColumns = db.prepare('PRAGMA table_info(provider_attempts)').all() as Array<{ name: string }>;
    const existingAttempts = new Set(attemptColumns.map((c) => c.name));
    for (const col of ['agent_scope', 'agent_name', 'agent_tier', 'agent_type', 'cost_rung', 'first_token_at']) {
      if (!existingAttempts.has(col)) {
        db.prepare(`ALTER TABLE provider_attempts ADD COLUMN ${col} TEXT`).run();
      }
    }
  }

  if (tables.has('context_snapshots')) {
    const snapshotColumns = db.prepare('PRAGMA table_info(context_snapshots)').all() as Array<{ name: string }>;
    const existingSnapshots = new Set(snapshotColumns.map((c) => c.name));
    if (!existingSnapshots.has('agent_scope')) {
      db.prepare('ALTER TABLE context_snapshots ADD COLUMN agent_scope TEXT').run();
    }
    if (!existingSnapshots.has('summary_tokens')) {
      db.prepare('ALTER TABLE context_snapshots ADD COLUMN summary_tokens INTEGER NOT NULL DEFAULT 0').run();
    }
    // Created here (not in the schema SQL) so it never references the column
    // before the ALTER above exists on legacy databases.
    // The top-N context queries GROUP BY session_id/agent_scope and ORDER BY
    // MAX(used_tokens); these covering indexes keep those scans index-only
    // (no rowid lookups for used_tokens). The narrow (agent_scope, captured_at)
    // index is replaced by the wider agent_scope_tokens variant so the date-
    // filtered paths stay covering too.
    db.prepare('DROP INDEX IF EXISTS idx_context_snapshots_agent_scope').run();
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_scope_session_tokens
      ON context_snapshots(agent_scope, session_id, used_tokens)
    `).run();
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_agent_scope_tokens
      ON context_snapshots(agent_scope, captured_at, session_id, used_tokens)
    `).run();
  }
}
