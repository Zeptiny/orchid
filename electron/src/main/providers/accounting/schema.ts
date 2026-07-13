/** SQLite schema version for append-only provider attempt records. */
export const ACCOUNTING_SCHEMA_VERSION = 1;

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
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_attempts_session ON provider_attempts(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_chain ON provider_attempts(chain_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_turn ON provider_attempts(turn_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_outcome ON provider_attempts(outcome, started_at);
`;
