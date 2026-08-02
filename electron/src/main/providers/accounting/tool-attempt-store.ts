import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type ToolAttemptRecord,
  type ToolAttemptOutcome,
  type ToolSource,
} from '../../../shared/types/accounting';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { redactLogString } from '../../logging';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL } from './schema';

export const TOOL_ATTEMPT_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

export interface ToolAttemptStoreOptions {
  readonly dbPath?: string;
  readonly now?: () => Date;
}

export interface InsertPendingToolAttemptInput {
  readonly toolAttemptId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerAttemptId: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolSource: ToolSource;
  readonly mcpServerName: string | null;
  readonly toolFamily: string;
  readonly timeoutSeconds: number | null;
  readonly agentScope: string | null;
}

export interface FinalizeToolAttemptInput {
  readonly outcome: Exclude<ToolAttemptOutcome, 'pending'>;
  readonly resultSizeBytes: number | null;
  readonly offloaded: boolean;
  readonly timedOut: boolean;
  readonly error?: string;
}

type ToolAttemptRow = {
  tool_attempt_id: string;
  session_id: string;
  chain_id: string | null;
  turn_id: string | null;
  provider_attempt_id: string | null;
  tool_call_id: string;
  tool_name: string;
  tool_source: ToolSource;
  mcp_server_name: string | null;
  tool_family: string;
  started_at: string;
  completed_at: string | null;
  outcome: ToolAttemptOutcome;
  result_size_bytes: number | null;
  offloaded: number;
  timeout_seconds: number | null;
  timed_out: number;
  agent_scope: string | null;
  error: string | null;
};

function toolRowToRecord(row: ToolAttemptRow): ToolAttemptRecord {
  return {
    toolAttemptId: row.tool_attempt_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    turnId: row.turn_id,
    providerAttemptId: row.provider_attempt_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolSource: row.tool_source,
    mcpServerName: row.mcp_server_name,
    toolFamily: row.tool_family,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome,
    resultSizeBytes: row.result_size_bytes,
    offloaded: row.offloaded === 1,
    timeoutSeconds: row.timeout_seconds,
    timedOut: row.timed_out === 1,
    agentScope: row.agent_scope,
    error: row.error,
  };
}

/**
 * Append-only tool attempt ledger. A pending row is inserted synchronously
 * before tool handler execution and finalized idempotently after completion.
 * Shares the accounting.db file with ProviderAccountingStore.
 */
export class ToolAttemptStore {
  private readonly dbPath: string;
  private readonly now: () => Date;
  private db: SqliteDatabase | null = null;

  constructor(options: ToolAttemptStoreOptions = {}) {
    this.dbPath = options.dbPath ?? TOOL_ATTEMPT_DB_PATH;
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  insertPending(input: InsertPendingToolAttemptInput): string {
    const db = this.connection();
    const toolAttemptId = input.toolAttemptId || randomUUID();
    db.prepare(`
      INSERT INTO tool_attempts (
        tool_attempt_id, session_id, chain_id, turn_id, provider_attempt_id,
        tool_call_id, tool_name, tool_source, mcp_server_name, tool_family,
        started_at, completed_at, outcome, result_size_bytes, offloaded,
        timeout_seconds, timed_out, agent_scope, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, 0, ?, 0, ?, NULL)
    `).run(
      toolAttemptId,
      input.sessionId,
      input.chainId,
      input.turnId,
      input.providerAttemptId,
      input.toolCallId,
      input.toolName,
      input.toolSource,
      input.mcpServerName,
      input.toolFamily,
      this.now().toISOString(),
      input.timeoutSeconds,
      input.agentScope,
    );
    return toolAttemptId;
  }

  finalize(toolAttemptId: string, input: FinalizeToolAttemptInput): boolean {
    const db = this.connection();
    const result = db.prepare(`
      UPDATE tool_attempts
      SET outcome = ?, completed_at = ?, result_size_bytes = ?, offloaded = ?,
          timed_out = ?, error = ?
      WHERE tool_attempt_id = ? AND outcome = 'pending'
    `).run(
      input.outcome,
      this.now().toISOString(),
      input.resultSizeBytes,
      input.offloaded ? 1 : 0,
      input.timedOut ? 1 : 0,
      input.error ? redactLogString(input.error) : null,
      toolAttemptId,
    );
    return result.changes === 1;
  }

  recoverPending(): number {
    const result = this.connection().prepare(`
      UPDATE tool_attempts
      SET outcome = 'cancelled', completed_at = ?, error = 'Application exited before tool attempt completed'
      WHERE outcome = 'pending'
    `).run(this.now().toISOString());
    return result.changes;
  }

  listBySession(sessionId: string, limit = 1000): readonly ToolAttemptRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM tool_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(sessionId, limit) as ToolAttemptRow[];
    return rows.map(toolRowToRecord);
  }

  listByToolName(toolName: string, limit = 1000): readonly ToolAttemptRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM tool_attempts WHERE tool_name = ? ORDER BY started_at DESC LIMIT ?',
    ).all(toolName, limit) as ToolAttemptRow[];
    return rows.map(toolRowToRecord);
  }

  listAll(limit = 1000): readonly ToolAttemptRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM tool_attempts ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as ToolAttemptRow[];
    return rows.map(toolRowToRecord);
  }

  private connection(): SqliteDatabase {
    if (this.db) return this.db;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const db = openSqliteDb(this.dbPath, { schema: ACCOUNTING_SCHEMA_SQL, recovery: 'preserve' });
    try { fs.chmodSync(this.dbPath, 0o600); } catch { /* best effort */ }
    db.pragma('foreign_keys = ON');
    this.db = db;
    return db;
  }
}

let runtimeStore: ToolAttemptStore | null = null;
let runtimeInitializationError: Error | null = null;

export function initializeToolAttemptStore(options: ToolAttemptStoreOptions = {}): ToolAttemptStore {
  try {
    const store = new ToolAttemptStore(options);
    store.recoverPending();
    runtimeStore?.close();
    runtimeStore = store;
    runtimeInitializationError = null;
    return store;
  } catch (error) {
    runtimeStore?.close();
    runtimeStore = null;
    runtimeInitializationError = error instanceof Error ? error : new Error(String(error));
    throw runtimeInitializationError;
  }
}

export function getToolAttemptStore(): ToolAttemptStore {
  if (runtimeStore) return runtimeStore;
  throw runtimeInitializationError ?? new Error('Tool attempt store has not been initialized');
}

export function resetToolAttemptStore(): void {
  runtimeStore?.close();
  runtimeStore = null;
  runtimeInitializationError = null;
}
