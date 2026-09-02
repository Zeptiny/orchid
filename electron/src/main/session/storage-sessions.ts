/**
 * Session row persistence — full saves, targeted column updates, listing, and
 * deletion (plus the best-effort cache cleanup that follows a delete).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../../shared/types/session';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { ModelSelection } from '../../shared/types/provider';
import type { PermissionMode } from '../../shared/types/permission';
import type { TodoStoreData } from '../../shared/types/todo';
import {
  isValidSessionId,
  resolveOptions,
  withCorruptionRecovery,
  type StorageOptions,
} from './storage-db';
import {
  serializePermissionMode,
  serializeReasoningEffortOverride,
  serializeSelection,
  serializeSubagentRecord,
  serializeSubagentSummary,
  serializeTierOverride,
  serializeTodoStore,
} from './storage-parse';
import { insertChainRow, INSERT_CHAIN_SQL } from './storage-chains';

/** Session columns that can be updated without touching persisted chains. */
export interface SessionFieldsUpdate {
  name?: string;
  selection?: ModelSelection | null;
  modelLabel?: string | null;
  cwd?: string | null;
  activeChainId?: string | null;
  todoStore?: TodoStoreData;
  reasoningEffortOverride?: string | number | null;
  tierOverride?: string | null;
  permissionMode?: PermissionMode | null;
  updatedAt: string;
}

const INSERT_SUBAGENT_CHAIN_SQL = `
  INSERT INTO subagent_chains (session_id, subagent_id, record_json, summary_json)
  VALUES (?, ?, ?, ?)
`;

/** Persist a session and all chains atomically (UPSERT session + replace chains). */
export function saveSession(session: Session, opts?: StorageOptions): void {
  if (!isValidSessionId(session.id)) {
    throw new Error(`Refusing to save session with unsafe ID: ${session.id}`);
  }
  const { dbPath } = resolveOptions(opts);
  withCorruptionRecovery(dbPath, (db) => {
    const upsertSession = db.prepare(`
      INSERT INTO sessions (id, name, selection_json, model_label, cwd, active_chain_id, todo_store_json, reasoning_effort_override, tier_override, permission_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        selection_json = excluded.selection_json,
        model_label = excluded.model_label,
        cwd = excluded.cwd,
        active_chain_id = excluded.active_chain_id,
        todo_store_json = excluded.todo_store_json,
        reasoning_effort_override = excluded.reasoning_effort_override,
        tier_override = excluded.tier_override,
        permission_mode = excluded.permission_mode,
        updated_at = excluded.updated_at
    `);

    const deleteChains = db.prepare('DELETE FROM chains WHERE session_id = ?');
    const insertChain = db.prepare(INSERT_CHAIN_SQL);
    const deleteSubagentChains = db.prepare('DELETE FROM subagent_chains WHERE session_id = ?');
    const insertSubagentChain = db.prepare(INSERT_SUBAGENT_CHAIN_SQL);

    const txn = db.transaction(() => {
      upsertSession.run(
        session.id,
        session.name,
        serializeSelection(session.selection),
        session.modelLabel,
        session.cwd,
        session.activeChainId,
        serializeTodoStore(session.todoStore),
        serializeReasoningEffortOverride(session.reasoningEffortOverride),
        serializeTierOverride(session.tierOverride),
        serializePermissionMode(session.permissionMode),
        session.createdAt,
        session.updatedAt,
      );

      deleteChains.run(session.id);

      for (let i = 0; i < session.chains.length; i++) {
        const chain = session.chains[i]!;
        insertChainRow(db, insertChain, chain, i);
      }

      deleteSubagentChains.run(session.id);
      for (const record of session.subagentChains) {
        insertSubagentChain.run(
          session.id,
          record.id,
          serializeSubagentRecord(record),
          serializeSubagentSummary(record),
        );
      }
    });

    txn();
  });
}

interface ColumnAssignment {
  readonly column: string;
  readonly value: unknown;
}

function addIdentityAssignments(
  assignments: ColumnAssignment[],
  update: SessionFieldsUpdate,
): void {
  if (Object.hasOwn(update, 'name') && update.name !== undefined) {
    assignments.push({ column: 'name', value: update.name });
  }
  if (Object.hasOwn(update, 'selection')) {
    assignments.push({
      column: 'selection_json',
      value: serializeSelection(update.selection ?? null),
    });
  }
  if (Object.hasOwn(update, 'modelLabel')) {
    assignments.push({ column: 'model_label', value: update.modelLabel ?? null });
  }
}

function addWorkspaceAssignments(
  assignments: ColumnAssignment[],
  update: SessionFieldsUpdate,
): void {
  if (Object.hasOwn(update, 'cwd')) {
    assignments.push({ column: 'cwd', value: update.cwd ?? null });
  }
  if (Object.hasOwn(update, 'activeChainId')) {
    assignments.push({ column: 'active_chain_id', value: update.activeChainId ?? null });
  }
  if (Object.hasOwn(update, 'todoStore')) {
    assignments.push({
      column: 'todo_store_json',
      value: serializeTodoStore(update.todoStore ?? { tasks: [] }),
    });
  }
}

function addPreferenceAssignments(
  assignments: ColumnAssignment[],
  update: SessionFieldsUpdate,
): void {
  if (Object.hasOwn(update, 'reasoningEffortOverride')) {
    assignments.push({
      column: 'reasoning_effort_override',
      value: serializeReasoningEffortOverride(update.reasoningEffortOverride ?? null),
    });
  }
  if (Object.hasOwn(update, 'tierOverride')) {
    assignments.push({
      column: 'tier_override',
      value: serializeTierOverride(update.tierOverride ?? null),
    });
  }
  if (Object.hasOwn(update, 'permissionMode')) {
    assignments.push({
      column: 'permission_mode',
      value: serializePermissionMode(update.permissionMode ?? null),
    });
  }
  assignments.push({ column: 'updated_at', value: update.updatedAt });
}

function sessionColumnAssignments(update: SessionFieldsUpdate): ColumnAssignment[] {
  const assignments: ColumnAssignment[] = [];
  addIdentityAssignments(assignments, update);
  addWorkspaceAssignments(assignments, update);
  addPreferenceAssignments(assignments, update);
  return assignments;
}

function applySessionColumnAssignments(
  assignments: readonly ColumnAssignment[],
): string {
  const columns = assignments.map((assignment) => `${assignment.column} = ?`).join(', ');
  return `UPDATE sessions SET ${columns} WHERE id = ?`;
}

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
  const assignments = sessionColumnAssignments(update);
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const result = db
      .prepare(applySessionColumnAssignments(assignments))
      .run(...assignments.map((assignment) => assignment.value), sessionId);
    return result.changes > 0;
  });
}

/** List session summaries via a single indexed query, newest first. */
export function listSavedSessions(opts?: StorageOptions): SessionSummary[] {
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const rows = db.prepare(`
      SELECT s.id, s.name, s.model_label, s.cwd, s.updated_at,
             (
               SELECT COUNT(*)
               FROM chains c
               WHERE c.session_id = s.id
             ) as chain_count
      FROM sessions s
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

/**
 * Look up session names for a set of session IDs.
 * Returns a map of sessionId → name for all found sessions.
 */
export function getSessionNames(sessionIds: readonly string[], opts?: StorageOptions): Map<string, string> {
  if (sessionIds.length === 0) return new Map();
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, name FROM sessions WHERE id IN (${placeholders})`,
    ).all(...sessionIds) as Array<{ id: string; name: string }>;
    return new Map(rows.map((r) => [r.id, r.name]));
  });
}

async function removeSessionCacheDirectory(cacheDir: string, sessionId: string): Promise<void> {
  const target = path.join(cacheDir, sessionId);
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to remove deleted session cache '${target}':`, error);
  }
}

/** Best-effort cache cleanup scheduled after the durable session row is gone. */
export async function deleteSessionCaches(
  sessionId: string,
  opts?: StorageOptions,
): Promise<void> {
  if (!isValidSessionId(sessionId)) return;
  const { toolOutputCacheDir, webFetchCacheDir } = resolveOptions(opts);
  await Promise.all([
    removeSessionCacheDirectory(toolOutputCacheDir, sessionId),
    removeSessionCacheDirectory(webFetchCacheDir, sessionId),
  ]);
}

/** Delete a session durably; file-cache cleanup continues asynchronously. */
export function deleteSession(sessionId: string, opts?: StorageOptions): boolean {
  if (!isValidSessionId(sessionId)) {
    return false;
  }
  const { dbPath } = resolveOptions(opts);
  const deleted = withCorruptionRecovery(dbPath, (db) => {
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes > 0;
  });
  if (!deleted) {
    return false;
  }
  void deleteSessionCaches(sessionId, opts);
  return true;
}
