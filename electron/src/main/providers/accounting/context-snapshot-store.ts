import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type ContextSnapshotRecord,
} from '../../../shared/types/accounting';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL, applyAccountingSchemaMigrations } from './schema';

export const CONTEXT_SNAPSHOT_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

export interface ContextSnapshotStoreOptions {
  readonly dbPath?: string;
  readonly now?: () => Date;
}

export interface InsertContextSnapshotInput {
  readonly snapshotId?: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerAttemptId: string | null;
  /** Subagent scope id; null/omitted for the main agent. */
  readonly agentScope?: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usedTokens: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly toolUseTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly summaryTokens?: number;
}

type ContextSnapshotRow = {
  snapshot_id: string;
  session_id: string;
  chain_id: string | null;
  turn_id: string | null;
  provider_attempt_id: string | null;
  agent_scope: string | null;
  captured_at: string;
  input_tokens: number;
  output_tokens: number;
  used_tokens: number;
  system_tokens: number;
  tools_tokens: number;
  tool_use_tokens: number;
  user_tokens: number;
  assistant_tokens: number;
  summary_tokens: number;
};

function rowToRecord(row: ContextSnapshotRow): ContextSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    turnId: row.turn_id,
    providerAttemptId: row.provider_attempt_id,
    agentScope: row.agent_scope,
    capturedAt: row.captured_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    usedTokens: row.used_tokens,
    systemTokens: row.system_tokens,
    toolsTokens: row.tools_tokens,
    toolUseTokens: row.tool_use_tokens,
    userTokens: row.user_tokens,
    assistantTokens: row.assistant_tokens,
    summaryTokens: row.summary_tokens ?? 0,
  };
}

/**
 * Insert-only context snapshot store. Records context window state per LLM
 * step. Shares the accounting.db file.
 */
export class ContextSnapshotStore {
  private readonly dbPath: string;
  private readonly now: () => Date;
  private db: SqliteDatabase | null = null;

  constructor(options: ContextSnapshotStoreOptions = {}) {
    this.dbPath = options.dbPath ?? CONTEXT_SNAPSHOT_DB_PATH;
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  insert(input: InsertContextSnapshotInput): string {
    const db = this.connection();
    const snapshotId = input.snapshotId || randomUUID();
    db.prepare(`
      INSERT INTO context_snapshots (
        snapshot_id, session_id, chain_id, turn_id, provider_attempt_id,
        agent_scope, captured_at, input_tokens, output_tokens, used_tokens,
        system_tokens, tools_tokens, tool_use_tokens, user_tokens, assistant_tokens, summary_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      input.sessionId,
      input.chainId,
      input.turnId,
      input.providerAttemptId,
      input.agentScope ?? null,
      this.now().toISOString(),
      input.inputTokens,
      input.outputTokens,
      input.usedTokens,
      input.systemTokens,
      input.toolsTokens,
      input.toolUseTokens,
      input.userTokens,
      input.assistantTokens,
      input.summaryTokens ?? 0,
    );
    return snapshotId;
  }

  listBySession(sessionId: string, limit = 1000): readonly ContextSnapshotRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM context_snapshots WHERE session_id = ? ORDER BY captured_at ASC LIMIT ?',
    ).all(sessionId, limit) as ContextSnapshotRow[];
    return rows.map(rowToRecord);
  }

  listAll(limit = 1000, startDate?: string, endDate?: string): readonly ContextSnapshotRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (startDate) { conditions.push('captured_at >= ?'); params.push(startDate); }
    if (endDate) { conditions.push('captured_at <= ?'); params.push(endDate); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.connection().prepare(
      `SELECT * FROM context_snapshots ${where} ORDER BY captured_at ASC LIMIT ?`,
    ).all(...params, limit) as ContextSnapshotRow[];
    return rows.map(rowToRecord);
  }

  private connection(): SqliteDatabase {
    if (this.db) return this.db;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const db = openSqliteDb(this.dbPath, { schema: ACCOUNTING_SCHEMA_SQL, recovery: 'preserve' });
    try { fs.chmodSync(this.dbPath, 0o600); } catch { /* best effort */ }
    db.pragma('foreign_keys = ON');
    applyAccountingSchemaMigrations(db);
    this.db = db;
    return db;
  }
}

let runtimeStore: ContextSnapshotStore | null = null;
let runtimeInitializationError: Error | null = null;

export function initializeContextSnapshotStore(options: ContextSnapshotStoreOptions = {}): ContextSnapshotStore {
  try {
    const store = new ContextSnapshotStore(options);
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

export function getContextSnapshotStore(): ContextSnapshotStore {
  if (runtimeStore) return runtimeStore;
  throw runtimeInitializationError ?? new Error('Context snapshot store has not been initialized');
}

export function resetContextSnapshotStore(): void {
  runtimeStore?.close();
  runtimeStore = null;
  runtimeInitializationError = null;
}
