import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type SubagentAttributionRecord,
  type SubagentAttributionStatus,
} from '../../../shared/types/accounting';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL } from './schema';

export const SUBAGENT_ATTRIBUTION_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

export interface SubagentAttributionStoreOptions {
  readonly dbPath?: string;
  readonly now?: () => Date;
}

export interface InsertSubagentAttributionInput {
  readonly attributionId?: string;
  readonly subagentId: string;
  readonly sessionId: string;
  readonly chainId: string;
  readonly parentChainId: string | null;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly modelId: string;
  readonly connectionId: string;
}

export interface FinalizeSubagentAttributionInput {
  readonly status: Exclude<SubagentAttributionStatus, 'running'>;
  readonly error?: string;
}

type SubagentAttributionRow = {
  attribution_id: string;
  subagent_id: string;
  session_id: string;
  chain_id: string;
  parent_chain_id: string | null;
  agent_name: string;
  agent_type: string;
  agent_tier: string;
  model_id: string;
  connection_id: string;
  started_at: string;
  completed_at: string | null;
  status: SubagentAttributionStatus;
};

function rowToRecord(row: SubagentAttributionRow): SubagentAttributionRecord {
  return {
    attributionId: row.attribution_id,
    subagentId: row.subagent_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    parentChainId: row.parent_chain_id,
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    modelId: row.model_id,
    connectionId: row.connection_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
  };
}

/**
 * Subagent attribution store. Records subagent identity and lifecycle.
 * Shares the accounting.db file.
 */
export class SubagentAttributionStore {
  private readonly dbPath: string;
  private readonly now: () => Date;
  private db: SqliteDatabase | null = null;

  constructor(options: SubagentAttributionStoreOptions = {}) {
    this.dbPath = options.dbPath ?? SUBAGENT_ATTRIBUTION_DB_PATH;
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  insert(input: InsertSubagentAttributionInput): string {
    const db = this.connection();
    const attributionId = input.attributionId || randomUUID();
    db.prepare(`
      INSERT INTO subagent_attribution (
        attribution_id, subagent_id, session_id, chain_id, parent_chain_id,
        agent_name, agent_type, agent_tier, model_id, connection_id,
        started_at, completed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'running')
    `).run(
      attributionId,
      input.subagentId,
      input.sessionId,
      input.chainId,
      input.parentChainId,
      input.agentName,
      input.agentType,
      input.agentTier,
      input.modelId,
      input.connectionId,
      this.now().toISOString(),
    );
    return attributionId;
  }

  finalize(subagentId: string, input: FinalizeSubagentAttributionInput): boolean {
    const db = this.connection();
    const result = db.prepare(`
      UPDATE subagent_attribution
      SET status = ?, completed_at = ?
      WHERE subagent_id = ? AND status = 'running'
    `).run(
      input.status,
      this.now().toISOString(),
      subagentId,
    );
    return result.changes === 1;
  }

  recoverPending(): number {
    const result = this.connection().prepare(`
      UPDATE subagent_attribution
      SET status = 'interrupted', completed_at = ?
      WHERE status = 'running'
    `).run(this.now().toISOString());
    return result.changes;
  }

  listBySession(sessionId: string): readonly SubagentAttributionRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM subagent_attribution WHERE session_id = ? ORDER BY started_at ASC',
    ).all(sessionId) as SubagentAttributionRow[];
    return rows.map(rowToRecord);
  }

  listAll(limit = 1000): readonly SubagentAttributionRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM subagent_attribution ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as SubagentAttributionRow[];
    return rows.map(rowToRecord);
  }

  getByAgentName(agentName: string, limit = 1000): readonly SubagentAttributionRecord[] {
    const rows = this.connection().prepare(
      'SELECT * FROM subagent_attribution WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?',
    ).all(agentName, limit) as SubagentAttributionRow[];
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
    this.db = db;
    return db;
  }
}

let runtimeStore: SubagentAttributionStore | null = null;
let runtimeInitializationError: Error | null = null;

export function initializeSubagentAttributionStore(options: SubagentAttributionStoreOptions = {}): SubagentAttributionStore {
  try {
    const store = new SubagentAttributionStore(options);
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

export function getSubagentAttributionStore(): SubagentAttributionStore {
  if (runtimeStore) return runtimeStore;
  throw runtimeInitializationError ?? new Error('Subagent attribution store has not been initialized');
}

export function resetSubagentAttributionStore(): void {
  runtimeStore?.close();
  runtimeStore = null;
  runtimeInitializationError = null;
}
