/**
 * Session storage — SQLite-backed persistence for sessions.
 *
 * Database: ~/.orchid/sessions.db (single file, WAL mode)
 * Cache directories: ~/.orchid/cache/tool-output/<session_id>/
 *                    ~/.orchid/cache/web-fetch/<session_id>/
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../shared/types/session';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { Chain } from '../../shared/types/chain';
import { ChainStatus } from '../../shared/types/chain';
import type { Message } from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import type { SubagentRecord } from '../../shared/types/subagent';
import type { TodoStoreData } from '../../shared/types/todo';
import {
  messageToStorageDict,
  messageFromStorageDict,
} from '../../shared/types/message';
import {
  subagentRecordToStorageDict,
  subagentRecordFromStorageDict,
} from '../../shared/types/subagent';
import {
  todoStoreToStorageDict,
  todoStoreFromStorageDict,
} from '../../shared/types/todo';
import {
  copyModelSelection,
  modelSelectionSchema,
} from '../../shared/types/provider';
import { openSqliteDb, type SqliteDatabase } from '../utils/sqlite';
import { SESSION_SCHEMA_SQL } from './schema';

export type { SessionSummary } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const SESSION_DB_PATH = path.join(os.homedir(), '.orchid', 'sessions.db');
export const CACHE_DIR = path.join(os.homedir(), '.orchid', 'cache');
export const TOOL_OUTPUT_CACHE_DIR = path.join(CACHE_DIR, 'tool-output');
export const WEB_FETCH_CACHE_DIR = path.join(CACHE_DIR, 'web-fetch');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StorageOptions {
  /** Override path to the sessions database. Defaults to `~/.orchid/sessions.db`. */
  dbPath?: string;
  /** Override path to tool-output cache directory. */
  toolOutputCacheDir?: string;
  /** Override path to web-fetch cache directory. */
  webFetchCacheDir?: string;
}

function resolveOptions(opts?: StorageOptions) {
  return {
    dbPath: opts?.dbPath ?? SESSION_DB_PATH,
    toolOutputCacheDir: opts?.toolOutputCacheDir ?? TOOL_OUTPUT_CACHE_DIR,
    webFetchCacheDir: opts?.webFetchCacheDir ?? WEB_FETCH_CACHE_DIR,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

const dbCache = new Map<string, SqliteDatabase>();

function getDb(dbPath: string): SqliteDatabase {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const db = openSqliteDb(dbPath, {
    schema: SESSION_SCHEMA_SQL,
    corruptionCheck: 'SELECT 1 FROM sessions LIMIT 1',
  });
  dbCache.set(dbPath, db);
  return db;
}

/** @internal Test-only: clear cached connections. */
export function _clearDbCache(): void {
  for (const db of dbCache.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  dbCache.clear();
}

// ---------------------------------------------------------------------------
// ensureSessionsDir — compat shim
// ---------------------------------------------------------------------------

export function ensureSessionsDir(opts?: StorageOptions): string {
  const { dbPath } = resolveOptions(opts);
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  getDb(dbPath);
  return dir;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  name: string;
  selection_json: string | null;
  model_label: string | null;
  cwd: string | null;
  active_chain_id: string | null;
  subagent_chains_json: string;
  todo_store_json: string;
  created_at: string;
  updated_at: string;
}

interface ChainRow {
  id: string;
  session_id: string;
  ordinal: number;
  status: string;
  selection_json: string | null;
  model_label: string | null;
  agent_name: string;
  agent_type: string;
  agent_tier: string;
  subagent_record_json: string | null;
  messages_json: string;
  start_time: string | null;
  end_time: string | null;
}

function serializeSelection(selection: ModelSelection | null): string | null {
  if (!selection) return null;
  return JSON.stringify(copyModelSelection(selection));
}

function deserializeSelection(json: string | null): ModelSelection | null {
  if (!json) return null;
  const parsed = modelSelectionSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

function serializeMessages(messages: readonly Message[]): string {
  return JSON.stringify(messages.map(messageToStorageDict));
}

function deserializeMessages(json: string): Message[] {
  const raw = JSON.parse(json) as unknown[];
  return raw.map((m) => messageFromStorageDict(m));
}

function serializeSubagentChains(records: readonly SubagentRecord[]): string {
  return JSON.stringify(records.map(subagentRecordToStorageDict));
}

function deserializeSubagentChains(json: string): SubagentRecord[] {
  const raw = JSON.parse(json) as unknown[];
  const result: SubagentRecord[] = [];
  for (const item of raw) {
    try {
      result.push(subagentRecordFromStorageDict(item));
    } catch {
      // per-record error isolation
    }
  }
  return result;
}

function serializeTodoStore(data: TodoStoreData): string {
  return JSON.stringify(todoStoreToStorageDict(data));
}

function deserializeTodoStore(json: string): TodoStoreData {
  return todoStoreFromStorageDict(JSON.parse(json));
}

function chainFromRow(row: ChainRow): Chain {
  let status = row.status as ChainStatus;
  let endTime = row.end_time;
  if (status === ChainStatus.ACTIVE) {
    status = ChainStatus.INTERRUPTED;
    if (!endTime) endTime = new Date().toISOString();
  }

  let subagentRecord: SubagentRecord | null = null;
  if (row.subagent_record_json) {
    try {
      subagentRecord = subagentRecordFromStorageDict(JSON.parse(row.subagent_record_json));
    } catch {
      // ignore
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    messages: deserializeMessages(row.messages_json),
    status,
    selection: deserializeSelection(row.selection_json),
    modelLabel: row.model_label,
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    subagentRecord,
    startTime: row.start_time,
    endTime,
  };
}

function sessionFromRow(row: SessionRow, chains: Chain[]): Session {
  return {
    id: row.id,
    name: row.name,
    selection: deserializeSelection(row.selection_json),
    modelLabel: row.model_label,
    cwd: row.cwd,
    chains,
    activeChainId: row.active_chain_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subagentChains: deserializeSubagentChains(row.subagent_chains_json),
    todoStore: deserializeTodoStore(row.todo_store_json),
  };
}

// ---------------------------------------------------------------------------
// saveSession
// ---------------------------------------------------------------------------

export function saveSession(session: Session, opts?: StorageOptions): void {
  if (!isValidSessionId(session.id)) {
    throw new Error(`Refusing to save session with unsafe ID: ${session.id}`);
  }
  const { dbPath } = resolveOptions(opts);
  const db = getDb(dbPath);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, name, selection_json, model_label, cwd, active_chain_id, subagent_chains_json, todo_store_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      selection_json = excluded.selection_json,
      model_label = excluded.model_label,
      cwd = excluded.cwd,
      active_chain_id = excluded.active_chain_id,
      subagent_chains_json = excluded.subagent_chains_json,
      todo_store_json = excluded.todo_store_json,
      updated_at = excluded.updated_at
  `);

  const deleteChains = db.prepare('DELETE FROM chains WHERE session_id = ?');

  const insertChain = db.prepare(`
    INSERT INTO chains (id, session_id, ordinal, status, selection_json, model_label, agent_name, agent_type, agent_tier, subagent_record_json, messages_json, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    upsertSession.run(
      session.id,
      session.name,
      serializeSelection(session.selection),
      session.modelLabel,
      session.cwd,
      session.activeChainId,
      serializeSubagentChains(session.subagentChains),
      serializeTodoStore(session.todoStore),
      session.createdAt,
      session.updatedAt,
    );

    deleteChains.run(session.id);

    for (let i = 0; i < session.chains.length; i++) {
      const chain = session.chains[i]!;
      insertChain.run(
        chain.id,
        session.id,
        i,
        chain.status,
        serializeSelection(chain.selection),
        chain.modelLabel,
        chain.agentName,
        chain.agentType,
        chain.agentTier,
        chain.subagentRecord ? JSON.stringify(subagentRecordToStorageDict(chain.subagentRecord)) : null,
        serializeMessages(chain.messages),
        chain.startTime,
        chain.endTime,
      );
    }
  });

  txn();
}

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

export function loadSession(sessionId: string, opts?: StorageOptions): Session | null {
  if (!isValidSessionId(sessionId)) {
    return null;
  }
  const { dbPath } = resolveOptions(opts);
  const db = getDb(dbPath);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!row) return null;

  const chainRows = db
    .prepare('SELECT * FROM chains WHERE session_id = ? ORDER BY ordinal')
    .all(sessionId) as ChainRow[];

  const chains: Chain[] = [];
  for (const cr of chainRows) {
    try {
      chains.push(chainFromRow(cr));
    } catch {
      // per-chain error isolation
    }
  }

  return sessionFromRow(row, chains);
}

// ---------------------------------------------------------------------------
// listSavedSessions
// ---------------------------------------------------------------------------

export function listSavedSessions(opts?: StorageOptions): SessionSummary[] {
  const { dbPath } = resolveOptions(opts);
  const db = getDb(dbPath);

  const rows = db.prepare(`
    SELECT s.id, s.name, s.model_label, s.cwd, s.updated_at,
           COUNT(c.id) as chain_count
    FROM sessions s
    LEFT JOIN chains c ON c.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `).all() as Array<{
    id: string;
    name: string;
    model_label: string | null;
    cwd: string | null;
    updated_at: string;
    chain_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    modelLabel: r.model_label,
    cwd: r.cwd,
    chainCount: r.chain_count,
    updatedAt: Date.parse(r.updated_at) || 0,
  }));
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

export function deleteSession(sessionId: string, opts?: StorageOptions): boolean {
  if (!isValidSessionId(sessionId)) {
    return false;
  }
  const { dbPath, toolOutputCacheDir, webFetchCacheDir } = resolveOptions(opts);
  const db = getDb(dbPath);

  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  if (result.changes === 0) {
    return false;
  }

  const toolOutputDir = path.join(toolOutputCacheDir, sessionId);
  try {
    if (fs.existsSync(toolOutputDir)) {
      fs.rmSync(toolOutputDir, { recursive: true, force: true });
    }
  } catch {
    // non-fatal
  }

  const webFetchDir = path.join(webFetchCacheDir, sessionId);
  try {
    if (fs.existsSync(webFetchDir)) {
      fs.rmSync(webFetchDir, { recursive: true, force: true });
    }
  } catch {
    // non-fatal
  }

  return true;
}
