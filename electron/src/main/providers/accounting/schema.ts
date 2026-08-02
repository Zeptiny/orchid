/** SQLite schema version for append-only provider attempt records. */
export const ACCOUNTING_SCHEMA_VERSION = 2;

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
  usage_json TEXT,
  provider_evidence_json TEXT NOT NULL DEFAULT '{}',
  cost_state TEXT NOT NULL CHECK (cost_state IN ('reported', 'calculated', 'unknown')),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('provider-reported', 'token-formula', 'energy-formula', 'unknown')),
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
  captured_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  system_tokens INTEGER NOT NULL DEFAULT 0,
  tools_tokens INTEGER NOT NULL DEFAULT 0,
  tool_use_tokens INTEGER NOT NULL DEFAULT 0,
  user_tokens INTEGER NOT NULL DEFAULT 0,
  assistant_tokens INTEGER NOT NULL DEFAULT 0
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
`;
