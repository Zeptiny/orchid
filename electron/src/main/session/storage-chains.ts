/**
 * Chain row persistence — the `chains` table write primitives (insert, update,
 * select, superseded-row retirement) and the chain-scoped durable operations
 * built on top of them.
 */
import type { SqliteDatabase } from '../utils/sqlite';
import type { Chain } from '../../shared/types/chain';
import { ChainStatus } from '../../shared/types/chain';
import type { TodoStoreData } from '../../shared/types/todo';
import {
  isValidSessionId,
  resolveOptions,
  withCorruptionRecovery,
  type StorageOptions,
} from './storage-db';
import {
  emptyChainSummary,
  parseChainViewSummary,
  replaceChainMessageOffsets,
  serializeChainMessages,
  serializeSelection,
  serializeSubagentRecord,
  serializeTodoStore,
  type ChainRow,
  type ChainViewSummary,
  type SerializedChainMessages,
} from './storage-parse';

export const INSERT_CHAIN_SQL = `
  INSERT INTO chains (id, session_id, ordinal, status, selection_json, model_label, agent_name, agent_type, agent_tier, subagent_record_json, messages_json, start_time, end_time, error_detail, error_title, summary_json, recent_messages_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** The `chains` columns a chain write supplies, in placeholder order. */
type ChainColumnValues = readonly [
  status: string,
  selectionJson: string | null,
  modelLabel: string | null,
  agentName: string,
  agentType: string,
  agentTier: string,
  subagentRecordJson: string | null,
  messagesJson: string,
  startTime: string | null,
  endTime: string | null,
  errorDetail: string | null,
  errorTitle: string | null,
  summaryJson: string,
  recentMessagesJson: string,
];

function chainColumnValues(
  chain: Chain,
  serialized: SerializedChainMessages,
): ChainColumnValues {
  return [
    chain.status,
    serializeSelection(chain.selection),
    chain.modelLabel,
    chain.agentName,
    chain.agentType,
    chain.agentTier,
    chain.subagentRecord ? serializeSubagentRecord(chain.subagentRecord) : null,
    serialized.messagesJson,
    chain.startTime,
    chain.endTime,
    chain.errorDetail,
    chain.errorTitle,
    serialized.summaryJson,
    serialized.recentMessagesJson,
  ];
}

export function insertChainRow(
  db: SqliteDatabase,
  insertChain: import('better-sqlite3').Statement,
  chain: Chain,
  ordinal: number,
): void {
  const serialized = serializeChainMessages(chain.messages);
  insertChain.run(chain.id, chain.sessionId, ordinal, ...chainColumnValues(chain, serialized));
  replaceChainMessageOffsets(db, chain.id, serialized.messageOffsets);
}

export function updateChainRow(db: SqliteDatabase, chain: Chain): number {
  const serialized = serializeChainMessages(chain.messages);
  const changes = db
    .prepare(
      `UPDATE chains
       SET status = ?, selection_json = ?, model_label = ?,
           agent_name = ?, agent_type = ?, agent_tier = ?,
           subagent_record_json = ?, messages_json = ?,
           start_time = ?, end_time = ?,
           error_detail = ?, error_title = ?, summary_json = ?, recent_messages_json = ?
       WHERE id = ? AND session_id = ?`,
    )
    .run(...chainColumnValues(chain, serialized), chain.id, chain.sessionId).changes;
  if (changes > 0) {
    replaceChainMessageOffsets(db, chain.id, serialized.messageOffsets);
  }
  return changes;
}

/** Bump one session row's recency — the shared tail of every targeted write. */
export function bumpSessionRecency(
  db: SqliteDatabase,
  sessionId: string,
  updatedAt: string,
): void {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, sessionId);
}

const CHAIN_VIEW_COLUMNS = `
  id, session_id, ordinal, status, selection_json, model_label,
  agent_name, agent_type, agent_tier, subagent_record_json,
  NULL AS messages_json, NULL AS recent_messages_json,
  start_time, end_time, error_detail, error_title,
  summary_json,
  COALESCE(
    CASE WHEN json_valid(summary_json) THEN
      CASE
        WHEN json_type(summary_json, '$.messageCount') = 'integer'
          AND json_extract(summary_json, '$.messageCount') >= 0
          THEN json_extract(summary_json, '$.messageCount')
      END
    END,
    CASE WHEN json_valid(messages_json) THEN json_array_length(messages_json) ELSE 0 END
  ) AS message_count,
  COALESCE(
    CASE WHEN json_valid(summary_json) THEN
      CASE
        WHEN json_type(summary_json, '$.messageBytes') = 'integer'
          AND json_extract(summary_json, '$.messageBytes') >= 0
          THEN json_extract(summary_json, '$.messageBytes')
      END
    END,
    length(CAST(messages_json AS BLOB))
  ) AS message_bytes
`;

const CHAIN_VIEW_SELECT = `
  SELECT ${CHAIN_VIEW_COLUMNS}
  FROM chains WHERE session_id = ? ORDER BY ordinal
`;

export function selectChainRows(
  db: SqliteDatabase,
  sessionId: string,
  includeMessages: boolean,
): ChainRow[] {
  return db
    .prepare(includeMessages
      ? 'SELECT * FROM chains WHERE session_id = ? ORDER BY ordinal'
      : CHAIN_VIEW_SELECT)
    .all(sessionId) as ChainRow[];
}

export function resolveChainViewSummary(row: ChainRow): ChainViewSummary {
  return parseChainViewSummary(row.summary_json)
    ?? emptyChainSummary(row.message_count ?? 0, row.message_bytes ?? 0);
}

interface ChainMessageRow {
  readonly id: string;
  readonly messages_json: string | null;
}

function chainMessageIds(messagesJson: string | null): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(messagesJson ?? '[]');
    if (!Array.isArray(parsed)) return null;
    const ids = new Set<string>();
    for (const message of parsed) {
      const id = (message as { id?: unknown } | null | undefined)?.id;
      if (typeof id === 'string') ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

function indexedChainMessageIds(
  rows: readonly ChainMessageRow[],
): Map<string, Set<string>> {
  const idSets = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = chainMessageIds(row.messages_json);
    if (ids) idSets.set(row.id, ids);
  }
  return idSets;
}

function isSupersededByIds(
  candidateIds: ReadonlySet<string>,
  ownerIds: ReadonlySet<string> | undefined,
): boolean {
  if (!ownerIds || ownerIds.size < candidateIds.size) return false;
  for (const id of candidateIds) {
    if (!ownerIds.has(id)) return false;
  }
  return true;
}

function hasSupersedingOwner(
  idSets: ReadonlyMap<string, Set<string>>,
  rows: readonly ChainMessageRow[],
  candidateIndex: number,
  candidateIds: ReadonlySet<string>,
): boolean {
  for (let ownerIndex = 0; ownerIndex < candidateIndex; ownerIndex += 1) {
    if (isSupersededByIds(candidateIds, idSets.get(rows[ownerIndex]!.id))) return true;
  }
  return false;
}

function selectSupersededChainIds(
  rows: readonly ChainMessageRow[],
  finalizedChainId: string | null,
  activeChainId?: string | null,
): string[] {
  const idSets = indexedChainMessageIds(rows);
  const superseded: string[] = [];
  for (let candidateIndex = 0; candidateIndex < rows.length; candidateIndex += 1) {
    const candidate = rows[candidateIndex]!;
    if (candidate.id === finalizedChainId || candidate.id === activeChainId) continue;
    const candidateIds = idSets.get(candidate.id);
    if (!candidateIds || candidateIds.size === 0) continue;
    if (hasSupersedingOwner(idSets, rows, candidateIndex, candidateIds)) {
      superseded.push(candidate.id);
    }
  }
  return superseded;
}

function deleteChainRows(
  db: SqliteDatabase,
  sessionId: string,
  chainIds: readonly string[],
): void {
  const deleteOffsets = db.prepare('DELETE FROM chain_message_offsets WHERE chain_id = ?');
  const deleteChain = db.prepare('DELETE FROM chains WHERE id = ? AND session_id = ?');
  for (const id of chainIds) {
    deleteOffsets.run(id);
    deleteChain.run(id, sessionId);
  }
}

/**
 * Delete superseded chain rows — rows whose message-id set is fully contained
 * in another chain of the same session (the split-prefix orphans a mid-turn
 * compaction's durable split creates once the owning turn finalizes into its
 * continuing row). The chain being finalized now is always kept; the session's
 * active-chain pointer is honored when supplied.
 *
 * Safety properties:
 * - Empty or unreadable rows are never deleted (an empty id set is not a match).
 * - Fresh-id chains (turns start with a new user message, summary heads carry a
 *   new summary id) can never be subsets, so legitimate chains are immune.
 * - Containment is judged on the FULL id set (visible + hidden) of BOTH rows:
 *   duplicated hidden extras (usage carriers mirrored into stale split rows)
 *   do not protect a row the owner fully subsumes, but a row carrying hidden
 *   content the owner LACKS is preserved — retiring it would silently drop
 *   that usage evidence (nothing else holds it).
 * - Deleting the LATER duplicate matches replay semantics: history assembly
 *   dedupes by id keeping first occurrence, so the deleted rows were already
 *   invisible to the model.
 */
export function deleteSupersededChains(
  db: SqliteDatabase,
  sessionId: string,
  finalizedChainId: string | null,
  activeChainId?: string | null,
): string[] {
  const rows = db.prepare(
    'SELECT id, messages_json FROM chains WHERE session_id = ? ORDER BY ordinal',
  ).all(sessionId) as ChainMessageRow[];
  if (rows.length < 2) return [];

  const superseded = selectSupersededChainIds(rows, finalizedChainId, activeChainId);
  deleteChainRows(db, sessionId, superseded);
  if (superseded.length > 0) {
    console.debug(
      `[session] retired ${superseded.length} superseded chain row(s) (session ${sessionId})`,
    );
  }
  return superseded;
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

      const ordinal = db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM chains WHERE session_id = ?',
        )
        .get(chain.sessionId) as { ordinal: number };
      insertChainRow(db, insertChain, chain, ordinal.ordinal);
      return true;
    });
    return txn();
  });
}

/**
 * Atomically persist a terminal chain snapshot and clear the session's active
 * chain pointer. Returns false if the chain row is missing.
 *
 * Finalize is the convergence point for the at-rest invariant "one turn = one
 * chain row": the finished chain (the continuing suffix row a mid-turn
 * compaction kept the original id on) now holds the full turn, so any split
 * prefix row and absorbed summary row the compaction left behind (their
 * content subsumed by this write) is retired in the same transaction instead
 * of lingering as an orphan.
 */
export function finishChain(
  chain: Chain,
  updatedAt: string,
  todoStore: TodoStoreData,
  opts?: StorageOptions,
): { ok: boolean; retiredChainIds: readonly string[] } {
  if (!isValidSessionId(chain.sessionId)) return { ok: false, retiredChainIds: [] };
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction(() => {
      if (updateChainRow(db, chain) === 0) {
        return { ok: false, retiredChainIds: [] as string[] };
      }
      const retiredChainIds = deleteSupersededChains(db, chain.sessionId, chain.id);
      db.prepare(
        `UPDATE sessions
         SET active_chain_id = NULL, todo_store_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        serializeTodoStore(todoStore),
        updatedAt,
        chain.sessionId,
      );
      return { ok: true, retiredChainIds };
    });
    return txn();
  });
}

/**
 * Recreate one missing chain row and update its owning session pointer without
 * replacing any sibling chains or subagent rows.
 */
export function restoreMissingChain(
  chain: Chain,
  updatedAt: string,
  todoStore: TodoStoreData,
  opts?: StorageOptions,
): boolean {
  if (!isValidSessionId(chain.sessionId)) return false;
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const insertChain = db.prepare(INSERT_CHAIN_SQL);
    const txn = db.transaction(() => {
      const sessionResult = db.prepare(
        `UPDATE sessions
         SET active_chain_id = ?, todo_store_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        chain.status === ChainStatus.ACTIVE ? chain.id : null,
        serializeTodoStore(todoStore),
        updatedAt,
        chain.sessionId,
      );
      if (sessionResult.changes === 0) return false;

      const ordinal = db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM chains WHERE session_id = ?',
        )
        .pluck()
        .get(chain.sessionId) as number;
      insertChainRow(db, insertChain, chain, ordinal);
      return true;
    });
    return txn();
  });
}

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
      bumpSessionRecency(db, chain.sessionId, updatedAt);
      return true;
    });
    return txn();
  });
}
