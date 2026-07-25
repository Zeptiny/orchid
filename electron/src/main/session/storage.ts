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
import { ChainStatus, parseChainStatus, reconcileOrphanToolResults } from '../../shared/types/chain';
import type { Message } from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import type { SubagentRecord } from '../../shared/types/subagent';
import type { TodoStoreData } from '../../shared/types/todo';
import { PERMISSION_MODE_VALUES, type PermissionMode } from '../../shared/types/permission';
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
import { type SqliteDatabase, isSqliteCorruptionError } from '../utils/sqlite';
import { SESSION_DB_PATH, SessionDb } from './db';

export type { SessionSummary } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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

/** Session columns that can be updated without touching persisted chains. */
export interface SessionFieldsUpdate {
  name?: string;
  selection?: ModelSelection | null;
  modelLabel?: string | null;
  cwd?: string | null;
  activeChainId?: string | null;
  subagentChains?: readonly SubagentRecord[];
  todoStore?: TodoStoreData;
  reasoningEffortOverride?: string | number | null;
  permissionMode?: PermissionMode | null;
  updatedAt: string;
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

/** Defense-in-depth: true only for canonical UUID session IDs. */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

const dbCache = new Map<string, SessionDb>();

function getDb(dbPath: string): SqliteDatabase {
  let cached = dbCache.get(dbPath);
  if (!cached) {
    cached = new SessionDb(dbPath);
    dbCache.set(dbPath, cached);
  }
  return cached.connection;
}

/**
 * Run a database operation; on a corruption-class error, reset the cached
 * connection and retry once. Reopening triggers the shared utility's
 * open-time recovery (move-aside + rebuild), so mid-life corruption heals
 * instead of permanently poisoning the cached handle.
 */
function withCorruptionRecovery<T>(dbPath: string, op: (db: SqliteDatabase) => T): T {
  try {
    return op(getDb(dbPath));
  } catch (err) {
    if (!isSqliteCorruptionError(err)) throw err;
    console.error(`[session] corruption detected during operation at ${dbPath}; resetting connection`, err);
    const cached = dbCache.get(dbPath);
    if (cached) {
      cached.dispose();
      dbCache.delete(dbPath);
    }
    return op(getDb(dbPath));
  }
}

/** Close all cached session database connections (invoked on app shutdown). */
export function closeSessionDb(): void {
  for (const db of dbCache.values()) {
    db.dispose();
  }
  dbCache.clear();
}

/** @internal Test-only: clear cached connections. */
export function _clearDbCache(): void {
  closeSessionDb();
}

// ---------------------------------------------------------------------------
// ensureSessionDb — compat shim
// ---------------------------------------------------------------------------

/** Ensure the DB parent directory exists and the connection is open; returns the directory. */
export function ensureSessionDb(opts?: StorageOptions): string {
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
  reasoning_effort_override: string | null;
  permission_mode: string | null;
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
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function serializeMessages(messages: readonly Message[]): string {
  return JSON.stringify(messages.map(messageToStorageDict));
}

function deserializeMessages(json: string): Message[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return reconcileOrphanToolResults(raw.map((m) => messageFromStorageDict(m)));
}

function serializeSubagentChains(records: readonly SubagentRecord[]): string {
  return JSON.stringify(records.map(subagentRecordToStorageDict));
}

function deserializeSubagentChains(json: string): SubagentRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const result: SubagentRecord[] = [];
  for (const item of raw) {
    try {
      result.push(subagentRecordFromStorageDict(item));
    } catch (err) {
      console.error('[session] skipping corrupt subagent record on load', err);
    }
  }
  return result;
}

function serializeTodoStore(data: TodoStoreData): string {
  return JSON.stringify(todoStoreToStorageDict(data));
}

function deserializeTodoStore(json: string): TodoStoreData {
  try {
    return todoStoreFromStorageDict(JSON.parse(json));
  } catch (err) {
    console.error('[session] failed to parse todo store on load; using empty store', err);
    return { tasks: [] };
  }
}

function chainFromRow(row: ChainRow): Chain {
  let subagentRecord: SubagentRecord | null = null;
  if (row.subagent_record_json) {
    try {
      subagentRecord = subagentRecordFromStorageDict(JSON.parse(row.subagent_record_json));
    } catch (err) {
      console.error(`[session] failed to parse subagent record for chain ${row.id}`, err);
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    messages: deserializeMessages(row.messages_json),
    status: parseChainStatus(row.status),
    selection: deserializeSelection(row.selection_json),
    modelLabel: row.model_label,
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    subagentRecord,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

function serializeReasoningEffortOverride(value: string | number | null): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function deserializeReasoningEffortOverride(json: string | null): string | number | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function serializePermissionMode(mode: PermissionMode | null): string | null {
  return mode ?? null;
}

function deserializePermissionMode(value: string | null): PermissionMode | null {
  if (value == null) return null;
  return (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
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
    reasoningEffortOverride: deserializeReasoningEffortOverride(row.reasoning_effort_override),
    permissionMode: deserializePermissionMode(row.permission_mode),
  };
}

const INSERT_CHAIN_SQL = `
  INSERT INTO chains (id, session_id, ordinal, status, selection_json, model_label, agent_name, agent_type, agent_tier, subagent_record_json, messages_json, start_time, end_time)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertChainRow(
  insertChain: import('better-sqlite3').Statement,
  chain: Chain,
  ordinal: number,
): void {
  insertChain.run(
    chain.id,
    chain.sessionId,
    ordinal,
    chain.status,
    serializeSelection(chain.selection),
    chain.modelLabel,
    chain.agentName,
    chain.agentType,
    chain.agentTier,
    chain.subagentRecord
      ? JSON.stringify(subagentRecordToStorageDict(chain.subagentRecord))
      : null,
    serializeMessages(chain.messages),
    chain.startTime,
    chain.endTime,
  );
}

function updateChainRow(db: SqliteDatabase, chain: Chain): number {
  return db
    .prepare(
      `UPDATE chains
       SET status = ?, selection_json = ?, model_label = ?,
           agent_name = ?, agent_type = ?, agent_tier = ?,
           subagent_record_json = ?, messages_json = ?,
           start_time = ?, end_time = ?
       WHERE id = ? AND session_id = ?`,
    )
    .run(
      chain.status,
      serializeSelection(chain.selection),
      chain.modelLabel,
      chain.agentName,
      chain.agentType,
      chain.agentTier,
      chain.subagentRecord
        ? JSON.stringify(subagentRecordToStorageDict(chain.subagentRecord))
        : null,
      serializeMessages(chain.messages),
      chain.startTime,
      chain.endTime,
      chain.id,
      chain.sessionId,
    ).changes;
}

// ---------------------------------------------------------------------------
// saveSession
// ---------------------------------------------------------------------------

/** Persist a session and all chains atomically (UPSERT session + replace chains). */
export function saveSession(session: Session, opts?: StorageOptions): void {
  if (!isValidSessionId(session.id)) {
    throw new Error(`Refusing to save session with unsafe ID: ${session.id}`);
  }
  const { dbPath } = resolveOptions(opts);
  withCorruptionRecovery(dbPath, (db) => {
    const upsertSession = db.prepare(`
      INSERT INTO sessions (id, name, selection_json, model_label, cwd, active_chain_id, subagent_chains_json, todo_store_json, reasoning_effort_override, permission_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        selection_json = excluded.selection_json,
        model_label = excluded.model_label,
        cwd = excluded.cwd,
        active_chain_id = excluded.active_chain_id,
        subagent_chains_json = excluded.subagent_chains_json,
        todo_store_json = excluded.todo_store_json,
        reasoning_effort_override = excluded.reasoning_effort_override,
        permission_mode = excluded.permission_mode,
        updated_at = excluded.updated_at
    `);

    const deleteChains = db.prepare('DELETE FROM chains WHERE session_id = ?');
    const insertChain = db.prepare(INSERT_CHAIN_SQL);

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
        serializeReasoningEffortOverride(session.reasoningEffortOverride),
        serializePermissionMode(session.permissionMode),
        session.createdAt,
        session.updatedAt,
      );

      deleteChains.run(session.id);

      for (let i = 0; i < session.chains.length; i++) {
        const chain = session.chains[i]!;
        insertChainRow(insertChain, chain, i);
      }
    });

    txn();
  });
}

// ---------------------------------------------------------------------------
// Incremental writes
// ---------------------------------------------------------------------------

/**
 * Update only the supplied session columns and recency. Historical chain rows
 * are never read, deleted, or rewritten. Returns false if the session is
 * missing so callers can use full replacement as a recovery path.
 */
export function updateSessionFields(
  sessionId: string,
  update: SessionFieldsUpdate,
  opts?: StorageOptions,
): boolean {
  if (!isValidSessionId(sessionId)) return false;

  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    columns.push(`${column} = ?`);
    values.push(value);
  };

  if (Object.hasOwn(update, 'name') && update.name !== undefined) {
    add('name', update.name);
  }
  if (Object.hasOwn(update, 'selection')) {
    add('selection_json', serializeSelection(update.selection ?? null));
  }
  if (Object.hasOwn(update, 'modelLabel')) add('model_label', update.modelLabel ?? null);
  if (Object.hasOwn(update, 'cwd')) add('cwd', update.cwd ?? null);
  if (Object.hasOwn(update, 'activeChainId')) {
    add('active_chain_id', update.activeChainId ?? null);
  }
  if (Object.hasOwn(update, 'subagentChains')) {
    add('subagent_chains_json', serializeSubagentChains(update.subagentChains ?? []));
  }
  if (Object.hasOwn(update, 'todoStore')) {
    add('todo_store_json', serializeTodoStore(update.todoStore ?? { tasks: [] }));
  }
  if (Object.hasOwn(update, 'reasoningEffortOverride')) {
    add(
      'reasoning_effort_override',
      serializeReasoningEffortOverride(update.reasoningEffortOverride ?? null),
    );
  }
  if (Object.hasOwn(update, 'permissionMode')) {
    add('permission_mode', serializePermissionMode(update.permissionMode ?? null));
  }
  add('updated_at', update.updatedAt);

  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const result = db
      .prepare(`UPDATE sessions SET ${columns.join(', ')} WHERE id = ?`)
      .run(...values, sessionId);
    return result.changes > 0;
  });
}

/**
 * Atomically interrupt any stale ACTIVE chain, append the new ACTIVE chain,
 * and point the session at it. Returns false if the owning session is missing.
 */
export function appendActiveChain(
  chain: Chain,
  interruptedChainIds: readonly string[],
  updatedAt: string,
  todoStore: TodoStoreData,
  opts?: StorageOptions,
): boolean {
  if (!isValidSessionId(chain.sessionId)) return false;
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const insertChain = db.prepare(INSERT_CHAIN_SQL);
    const txn = db.transaction(() => {
      const sessionResult = db
        .prepare(
          `UPDATE sessions
           SET active_chain_id = ?, todo_store_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          chain.id,
          serializeTodoStore(todoStore),
          updatedAt,
          chain.sessionId,
        );
      if (sessionResult.changes === 0) return false;

      const interruptChain = db.prepare(
        `UPDATE chains
         SET status = ?, end_time = COALESCE(end_time, ?)
         WHERE id = ? AND session_id = ? AND status = ?`,
      );
      for (const chainId of interruptedChainIds) {
        interruptChain.run(
          ChainStatus.INTERRUPTED,
          updatedAt,
          chainId,
          chain.sessionId,
          ChainStatus.ACTIVE,
        );
      }

      const ordinalRow = db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM chains WHERE session_id = ?',
        )
        .get(chain.sessionId) as { ordinal: number };
      insertChainRow(insertChain, chain, ordinalRow.ordinal);
      return true;
    });
    return txn();
  });
}

/**
 * Atomically persist a terminal chain snapshot and clear the session's active
 * chain pointer. Returns false if the chain row is missing.
 */
export function finishChain(
  chain: Chain,
  updatedAt: string,
  todoStore: TodoStoreData,
  opts?: StorageOptions,
): boolean {
  if (!isValidSessionId(chain.sessionId)) return false;
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction(() => {
      if (updateChainRow(db, chain) === 0) return false;
      db.prepare(
        `UPDATE sessions
         SET active_chain_id = NULL, todo_store_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        serializeTodoStore(todoStore),
        updatedAt,
        chain.sessionId,
      );
      return true;
    });
    return txn();
  });
}

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

/**
 * Load a session by ID (null if absent/invalid).
 *
 * A process restart makes every persisted active chain terminal. Recovery is
 * durable: affected chains, their shared recovery timestamp, and a matching
 * session active-chain pointer are updated in one transaction before the
 * session is materialized.
 */
export function loadSession(sessionId: string, opts?: StorageOptions): Session | null {
  if (!isValidSessionId(sessionId)) {
    return null;
  }
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const load = db.transaction(() => {
      let row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
      if (!row) return null;

      let chainRows = db
        .prepare('SELECT * FROM chains WHERE session_id = ? ORDER BY ordinal')
        .all(sessionId) as ChainRow[];
      const activeChainIds = chainRows
        .filter((chain) => parseChainStatus(chain.status) === ChainStatus.ACTIVE)
        .map((chain) => chain.id);

      if (activeChainIds.length > 0) {
        const recoveredAt = new Date().toISOString();
        const activePlaceholders = activeChainIds.map(() => '?').join(', ');

        db.prepare(
          `UPDATE chains
           SET status = ?, end_time = COALESCE(end_time, ?)
           WHERE session_id = ? AND id IN (${activePlaceholders})`,
        ).run(
          ChainStatus.INTERRUPTED,
          recoveredAt,
          sessionId,
          ...activeChainIds,
        );
        db.prepare(
          `UPDATE sessions
           SET active_chain_id = CASE
                 WHEN active_chain_id IN (${activePlaceholders}) THEN NULL
                 ELSE active_chain_id
               END,
               updated_at = ?
           WHERE id = ?`,
        ).run(
          ...activeChainIds,
          recoveredAt,
          sessionId,
        );

        row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow;
        chainRows = db
          .prepare('SELECT * FROM chains WHERE session_id = ? ORDER BY ordinal')
          .all(sessionId) as ChainRow[];
      }

      const chains: Chain[] = [];
      for (const cr of chainRows) {
        try {
          chains.push(chainFromRow(cr));
        } catch (err) {
          console.error(`[session] skipping corrupt chain ${cr.id} on load (session ${sessionId})`, err);
        }
      }

      return sessionFromRow(row, chains);
    });
    return load();
  });
}

// ---------------------------------------------------------------------------
// listSavedSessions
// ---------------------------------------------------------------------------

/** List session summaries via a single indexed query, newest first. */
export function listSavedSessions(opts?: StorageOptions): SessionSummary[] {
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
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
  });
}

// ---------------------------------------------------------------------------
// updateChain — targeted turn-local write
// ---------------------------------------------------------------------------

/**
 * Replace one chain snapshot and bump the owning session's recency without
 * rewriting sibling chains or session-level JSON columns. Returns false when
 * the chain row is missing so callers can fall back to a full save.
 */
export function updateChain(
  chain: Chain,
  updatedAt: string,
  opts?: StorageOptions,
): boolean {
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction(() => {
      if (updateChainRow(db, chain) === 0) return false;
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, chain.sessionId);
      return true;
    });
    return txn();
  });
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

/** Delete a session (chains cascade) plus its file caches; true if it existed. */
export function deleteSession(sessionId: string, opts?: StorageOptions): boolean {
  if (!isValidSessionId(sessionId)) {
    return false;
  }
  const { dbPath, toolOutputCacheDir, webFetchCacheDir } = resolveOptions(opts);
  const deleted = withCorruptionRecovery(dbPath, (db) => {
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes > 0;
  });
  if (!deleted) {
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
