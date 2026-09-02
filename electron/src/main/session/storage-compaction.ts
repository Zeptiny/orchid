/**
 * Compaction persistence — the targeted single-transaction writes that turn a
 * compaction settle into durable rows (`chains` for the main session,
 * `subagent_chains` for a subagent run), plus the dirty-record upsert.
 */
import type { SqliteDatabase } from '../utils/sqlite';
import type { Chain } from '../../shared/types/chain';
import type { Message } from '../../shared/types/message';
import type { SubagentRecord } from '../../shared/types/subagent';
import { subagentRecordFromStorageDict } from '../../shared/serialization/chain-subagent';
import {
  isValidSessionId,
  resolveOptions,
  withCorruptionRecovery,
  type StorageOptions,
} from './storage-db';
import {
  chainMetadataFromRow,
  serializeSubagentRecord,
  serializeSubagentSummary,
  tryDeserializeMessages,
  type ChainRow,
} from './storage-parse';
import {
  bumpSessionRecency,
  INSERT_CHAIN_SQL,
  insertChainRow,
  updateChainRow,
} from './storage-chains';

/** Input for the targeted, single-transaction compaction write. */
export interface CompactionPersistencePayload {
  /** Recency timestamp written onto the session row with the compaction. */
  readonly updatedAt: string;
  /**
   * Message ids to flag with `excludeFromModel` in their owning durable
   * chains. Every id must resolve against durable chain rows; an unknown id
   * aborts the whole write so a compaction can never persist a partial flag
   * set. Partial in-memory chain views are never consulted — each affected
   * chain's FULL durable `messages_json` is the write source.
   */
  readonly flaggedMessageIds: readonly string[];
  /**
   * Message ids whose `excludeFromModel` flag the settle CLEARED (scoped
   * exempt users, selective covered-kept resets). Cleared in the SAME
   * transaction as the flag writes so the durable rows can never keep a
   * stale true flag that resurrects on reload. A cleared id with no durable
   * owner is IDEMPOTENT (skipped): the settle computes the clear set over the
   * live history, which can lead the debounced checkpoint flush — there is no
   * durable row to resurrect a stale flag from. Unlike `flaggedMessageIds`,
   * a missing cleared id never aborts the write.
   */
  readonly clearedMessageIds?: readonly string[];
  /**
   * Summary-head chain row to insert verbatim (R20: the summary is its own
   * COMPLETED chain); null for reclaim-only compaction.
   */
  readonly summaryChain: Chain | null;
  /**
   * Durable message id the summary must precede in replay order — the first
   * preserved-window message after the cut. The summary chain's messages are
   * inserted INLINE into the owning chain at that position. Null (with a
   * summary) appends the summary after the last durable chain.
   */
  readonly insertBeforeMessageId: string | null;
}

/** Durable layout outcome of a successful compaction write. */
export interface CompactionPersistenceResult {
  /** Final durable chain ids in replay (ordinal) order after the write. */
  readonly chainIds: readonly string[];
  /** Durable chain ids whose rows received `excludeFromModel` flags. */
  readonly flaggedChainIds: readonly string[];
  /**
   * Inserted summary-head chain id — set only when the summary became its own
   * durable row (append path). Null for reclaim-only compaction AND for
   * INLINE insertion (the summary lives inside the owning chain row; no row
   * carries the summary chain's id).
   */
  readonly summaryChainId: string | null;
}

interface DurableChainEntry {
  readonly row: ChainRow;
  messages: Message[];
}

interface SummaryAnchor {
  readonly entry: DurableChainEntry;
  readonly index: number;
}

function assertSessionRowPersisted(
  db: SqliteDatabase,
  sessionId: string,
  operation: string,
): void {
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
    throw new Error(`${operation}: session ${sessionId} not found in durable rows`);
  }
}

/**
 * Apply one message's `excludeFromModel` flags. A set wins if an id were
 * somehow both flagged and cleared (the settle guarantees the two sets are
 * disjoint).
 */
function applyMessageFlags(
  message: Message,
  setIds: ReadonlySet<string> | undefined,
  clearIds: ReadonlySet<string> | undefined,
): Message {
  if (setIds?.has(message.id) && !message.excludeFromModel) {
    return { ...message, excludeFromModel: true };
  }
  if (clearIds?.has(message.id) && message.excludeFromModel) {
    return { ...message, excludeFromModel: false };
  }
  return message;
}

function collectIdsByChain(
  messageIds: Iterable<string>,
  chainIdsByMessageId: ReadonlyMap<string, string[]>,
): Map<string, Set<string>> {
  const idsByChain = new Map<string, Set<string>>();
  for (const messageId of messageIds) {
    for (const chainId of chainIdsByMessageId.get(messageId) ?? []) {
      const ids = idsByChain.get(chainId);
      if (ids) ids.add(messageId);
      else idsByChain.set(chainId, new Set([messageId]));
    }
  }
  return idsByChain;
}

/**
 * Durable chain content is the only trusted write source. Partial in-memory
 * chains (loadSessionView budgets) are never read here.
 */
function loadDurableChainEntries(
  db: SqliteDatabase,
  sessionId: string,
): DurableChainEntry[] {
  const rows = db.prepare(
    'SELECT * FROM chains WHERE session_id = ? ORDER BY ordinal',
  ).all(sessionId) as ChainRow[];
  return rows.map((row) => {
    const messages = tryDeserializeMessages(row.messages_json ?? '[]', false);
    if (!messages) {
      throw new Error(
        `applyCompactionPersistence: chain ${row.id} has unreadable messages (session ${sessionId})`,
      );
    }
    return { row, messages };
  });
}

function indexChainIdsByMessage(
  entries: readonly DurableChainEntry[],
): Map<string, string[]> {
  const chainIdsByMessageId = new Map<string, string[]>();
  for (const entry of entries) {
    for (const message of entry.messages) {
      const existing = chainIdsByMessageId.get(message.id);
      if (existing) existing.push(entry.row.id);
      else chainIdsByMessageId.set(message.id, [entry.row.id]);
    }
  }
  return chainIdsByMessageId;
}

/**
 * Resolve every flagged id against durable chains before writing, so a partial
 * flag set can never persist.
 */
function resolveFlaggedIdsByChain(
  flaggedMessageIds: readonly string[],
  chainIdsByMessageId: ReadonlyMap<string, string[]>,
  sessionId: string,
): Map<string, Set<string>> {
  const flaggedIds = new Set(flaggedMessageIds);
  for (const messageId of flaggedIds) {
    const owners = chainIdsByMessageId.get(messageId);
    if (!owners || owners.length === 0) {
      throw new Error(
        `applyCompactionPersistence: flagged message ${messageId} not found in durable chains (session ${sessionId})`,
      );
    }
  }
  return collectIdsByChain(flaggedIds, chainIdsByMessageId);
}

/**
 * Cleared ids resolve against the same owner index, but a cleared id with no
 * durable owner is IDEMPOTENT — there is no durable row that could resurrect a
 * stale true flag, so it is skipped rather than aborting the write. The settle
 * computes the clear set over the LIVE history, which can lead the debounced
 * checkpoint flush (the subagent scope reconciles the same lag via its live
 * messages tail append); failing the whole transaction over a benign clear
 * would lose the compaction's flags and summary head.
 */
function resolveClearedIdsByChain(
  clearedMessageIds: readonly string[] | undefined,
  chainIdsByMessageId: ReadonlyMap<string, string[]>,
): Map<string, Set<string>> {
  return collectIdsByChain(new Set(clearedMessageIds ?? []), chainIdsByMessageId);
}

function resolveSummaryAnchor(
  entries: readonly DurableChainEntry[],
  insertBeforeMessageId: string,
  sessionId: string,
): SummaryAnchor {
  for (const entry of entries) {
    const index = entry.messages.findIndex((message) => message.id === insertBeforeMessageId);
    if (index >= 0) return { entry, index };
  }
  throw new Error(
    `applyCompactionPersistence: summary anchor message ${insertBeforeMessageId} not found (session ${sessionId})`,
  );
}

/**
 * In-place flag writes: full durable messages, only flags change — sets and
 * clears land in the SAME transaction, so an in-memory-only clear can never
 * leave a stale true flag on the durable row.
 */
function applyChainFlagWrites(
  db: SqliteDatabase,
  entries: DurableChainEntry[],
  flagsByChain: ReadonlyMap<string, Set<string>>,
  clearsByChain: ReadonlyMap<string, Set<string>>,
): void {
  const touchedChainIds = new Set([...flagsByChain.keys(), ...clearsByChain.keys()]);
  for (const chainId of touchedChainIds) {
    const setIds = flagsByChain.get(chainId);
    const clearIds = clearsByChain.get(chainId);
    const entry = entries.find((candidate) => candidate.row.id === chainId)!;
    entry.messages = entry.messages.map((message) => applyMessageFlags(message, setIds, clearIds));
    updateChainRow(db, { ...chainMetadataFromRow(entry.row), messages: entry.messages });
  }
}

/**
 * Summary-head insertion (R20): when the anchor names a durable message, the
 * summary chain's messages are inserted INLINE into the owning chain at the
 * anchor index — the same shape the subagent scope persists. One turn stays
 * one chain row: no split duplicates for the finalize retire, no extra rows
 * consuming the bounded renderer view budget (which starves the turn's user
 * message in its oldest row), and no chain-count explosion past the renderer's
 * collapse threshold. Untouched chains keep their rows and ordinals exactly as
 * they are. Returns the inserted row's id for the append path only.
 */
function persistSummaryHead(
  db: SqliteDatabase,
  sessionId: string,
  summaryChain: Chain,
  anchor: SummaryAnchor | null,
): string | null {
  const summary: Chain = { ...summaryChain, sessionId };
  if (anchor) {
    anchor.entry.messages = [
      ...anchor.entry.messages.slice(0, anchor.index),
      ...summary.messages,
      ...anchor.entry.messages.slice(anchor.index),
    ];
    updateChainRow(db, {
      ...chainMetadataFromRow(anchor.entry.row),
      messages: anchor.entry.messages,
    });
    return null;
  }
  // Append after the last durable chain (no anchor chain to inline into).
  // This is the ONLY branch that creates a durable row carrying the summary
  // chain's id — the inline branch leaves it null (no row with summary.id
  // exists to reference).
  const insertChain = db.prepare(INSERT_CHAIN_SQL);
  const ordinal = db
    .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 FROM chains WHERE session_id = ?')
    .pluck()
    .get(sessionId) as number;
  insertChainRow(db, insertChain, summary, ordinal);
  return summary.id;
}

/**
 * Persist a compaction as one targeted SQLite transaction.
 *
 * Effects, all-or-nothing:
 * - For every chain owning a flagged message id: re-read that chain's FULL
 *   durable `messages_json`, set `excludeFromModel` on the matching ids, and
 *   update the row in place. Only those flags change.
 * - Insert the summary head INLINE into the owning anchor chain (same shape
 *   as the subagent scope): flags + one message, no row restructuring.
 * - Never deletes or rewrites any chain not touched by the compaction and
 *   never touches `subagent_chains` (a wholesale saveSession from a bounded
 *   view would permanently truncate pre-window history and wipe durable
 *   subagent rows — both P0 data-loss hazards).
 *
 * Throws (rolling the transaction back) when the session is unknown, a
 * flagged id has no durable owner, a chain blob is unreadable, or the summary
 * anchor message cannot be found. Callers must never fall back to a full save
 * from an in-memory view when this fails.
 */
export function applyCompactionPersistence(
  sessionId: string,
  payload: CompactionPersistencePayload,
  opts?: StorageOptions,
): CompactionPersistenceResult {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`applyCompactionPersistence: refusing unsafe session id ${sessionId}`);
  }
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction((): CompactionPersistenceResult => {
      assertSessionRowPersisted(db, sessionId, 'applyCompactionPersistence');
      const entries = loadDurableChainEntries(db, sessionId);
      const chainIdsByMessageId = indexChainIdsByMessage(entries);
      const flagsByChain = resolveFlaggedIdsByChain(
        payload.flaggedMessageIds,
        chainIdsByMessageId,
        sessionId,
      );
      const clearsByChain = resolveClearedIdsByChain(payload.clearedMessageIds, chainIdsByMessageId);
      const anchor = payload.summaryChain && payload.insertBeforeMessageId != null
        ? resolveSummaryAnchor(entries, payload.insertBeforeMessageId, sessionId)
        : null;

      const chainIds = entries.map((entry) => entry.row.id);
      applyChainFlagWrites(db, entries, flagsByChain, clearsByChain);
      const summaryChainId = payload.summaryChain
        ? persistSummaryHead(db, sessionId, payload.summaryChain, anchor)
        : null;
      if (summaryChainId) chainIds.push(summaryChainId);
      bumpSessionRecency(db, sessionId, payload.updatedAt);

      return {
        chainIds,
        flaggedChainIds: [...flagsByChain.keys()],
        summaryChainId,
      };
    });
    return txn();
  });
}

/** Outcome of a successful targeted subagent-record upsert. */
export interface SubagentUpsertResult {
  /** Total serialized `record_json` UTF-8 bytes written (checkpoint diagnostics, R9). */
  readonly bytes: number;
}

/**
 * Upsert one row per supplied subagent record and bump the owning session's
 * recency in one transaction, without touching sibling rows or session-level
 * JSON columns. Returns false when the session row is missing so callers can
 * fall back to a full save.
 */
export function upsertSubagentRecords(
  sessionId: string,
  records: readonly SubagentRecord[],
  updatedAt: string,
  opts?: StorageOptions,
): SubagentUpsertResult | false {
  if (!isValidSessionId(sessionId)) return false;
  if (records.length === 0) return { bytes: 0 };
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction(() => {
      const sessionResult = db
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(updatedAt, sessionId);
      if (sessionResult.changes === 0) return false;
      return { bytes: writeSubagentRecords(db, sessionId, records) };
    });
    return txn();
  });
}

function writeSubagentRecords(
  db: SqliteDatabase,
  sessionId: string,
  records: readonly SubagentRecord[],
): number {
  const upsert = db.prepare(`
    INSERT INTO subagent_chains (session_id, subagent_id, record_json, summary_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, subagent_id) DO UPDATE SET
      record_json = excluded.record_json,
      summary_json = excluded.summary_json
  `);
  let bytes = 0;
  for (const record of records) {
    const json = serializeSubagentRecord(record);
    // UTF-8 bytes, not UTF-16 code units (json.length) — the R9 checkpoint
    // diagnostic is a byte count and must not undercount multibyte content.
    bytes += Buffer.byteLength(json, 'utf8');
    upsert.run(sessionId, record.id, json, serializeSubagentSummary(record));
  }
  return bytes;
}

/** Input for the targeted, single-transaction subagent-chain compaction write. */
export interface SubagentCompactionPayload {
  /** Recency timestamp written onto the owning session row with the compaction. */
  readonly updatedAt: string;
  /**
   * Message ids to flag with `excludeFromModel` inside the subagent's durable
   * chain. Every id must resolve against the durable chain messages; an
   * unknown id aborts the whole write so a compaction can never persist a
   * partial flag set. The durable `record_json` (not an in-memory snapshot)
   * is the write source.
   */
  readonly flaggedMessageIds: readonly string[];
  /**
   * Message ids whose `excludeFromModel` flag the settle CLEARED (scoped
   * exempt users, selective covered-kept resets). Cleared in the SAME
   * transaction as the flag writes, mirroring `applyCompactionPersistence`:
   * a cleared id with no durable owner is IDEMPOTENT (skipped) — the settle
   * computes the clear set over the LIVE history, which can lead the
   * debounced checkpoint flush, and there is no durable row that could
   * resurrect a stale true flag.
   */
  readonly clearedMessageIds?: readonly string[];
  /**
   * Summary-head message carrying the `compacted` marker to insert into the
   * chain's messages at the cut position (R20: the summary is its own message
   * in the chain). Null for reclaim-only compaction.
   */
  readonly summaryMessage: Message | null;
  /**
   * Durable message id the summary must precede in replay order — the first
   * preserved-window message after the cut. Null (with a summary) appends the
   * summary after the last durable message.
   */
  readonly insertBeforeMessageId: string | null;
  /**
   * Authoritative live transcript for the run, supplied by the caller because
   * the flagged ids and the summary anchor are computed over it while the
   * durable `record_json` can lag the debounced checkpoint flush. Messages the
   * durable row lacks (the un-flushed live tail) are appended inside the
   * transaction BEFORE flag/anchor resolution, so a lagging row cannot make
   * the write throw spuriously. Flagged ids and the summary anchor unknown to
   * BOTH views still abort the write — the integrity throws stay intact for
   * genuinely corrupt payloads.
   */
  readonly liveMessages?: readonly Message[];
}

/** Durable outcome of a successful subagent-chain compaction write. */
export interface SubagentCompactionResult {
  /** Total serialized `record_json` UTF-8 bytes written (diagnostics). */
  readonly bytes: number;
  /** Whether a summary head message was inserted. */
  readonly summaryInserted: boolean;
  /** Number of messages that received `excludeFromModel` flips. */
  readonly flaggedCount: number;
}

function loadDurableSubagentRecord(
  db: SqliteDatabase,
  sessionId: string,
  subagentId: string,
): SubagentRecord {
  const row = db
    .prepare(
      'SELECT record_json FROM subagent_chains WHERE session_id = ? AND subagent_id = ?',
    )
    .get(sessionId, subagentId) as { record_json: string } | undefined;
  if (!row) {
    throw new Error(
      `applySubagentCompactionPersistence: subagent ${subagentId} not found in durable rows (session ${sessionId})`,
    );
  }
  try {
    return subagentRecordFromStorageDict(JSON.parse(row.record_json));
  } catch {
    throw new Error(
      `applySubagentCompactionPersistence: subagent ${subagentId} has unreadable record (session ${sessionId})`,
    );
  }
}

/**
 * Checkpoint-lag reconciliation: append the live tail the durable row has not
 * received yet (the flagged ids / anchor were computed over the LIVE
 * transcript). Append-only — durable messages are never reordered or dropped
 * by this pass.
 */
function withLiveMessageTail(
  messages: readonly Message[],
  liveMessages: readonly Message[] | undefined,
): Message[] {
  if (!liveMessages || liveMessages.length === 0) return [...messages];
  const durableIds = new Set(messages.map((m) => m.id));
  const missingLive = liveMessages.filter((m) => !durableIds.has(m.id));
  if (missingLive.length === 0) return [...messages];
  return [...messages, ...missingLive];
}

function assertSubagentMessageIdsDurable(
  messageIds: ReadonlySet<string>,
  durableIds: ReadonlySet<string>,
  label: 'flagged',
  sessionId: string,
  subagentId: string,
): void {
  for (const id of messageIds) {
    if (!durableIds.has(id)) {
      throw new Error(
        `applySubagentCompactionPersistence: ${label} message ${id} not found in durable chain (subagent ${subagentId}, session ${sessionId})`,
      );
    }
  }
}

function resolveSubagentAnchorIndex(
  messages: readonly Message[],
  payload: SubagentCompactionPayload,
  sessionId: string,
  subagentId: string,
): number {
  if (!payload.summaryMessage || payload.insertBeforeMessageId == null) return -1;
  const anchorIndex = messages.findIndex((m) => m.id === payload.insertBeforeMessageId);
  if (anchorIndex < 0) {
    throw new Error(
      `applySubagentCompactionPersistence: summary anchor message ${payload.insertBeforeMessageId} not found (subagent ${subagentId}, session ${sessionId})`,
    );
  }
  return anchorIndex;
}

/** Summary-head insertion at the cut position (R20); negative anchor appends. */
function insertSubagentSummaryMessage(
  messages: Message[],
  summary: Message,
  anchorIndex: number,
): Message[] {
  if (anchorIndex < 0) return [...messages, summary];
  return [
    ...messages.slice(0, anchorIndex),
    summary,
    ...messages.slice(anchorIndex),
  ];
}

function persistSubagentRecordWrite(
  db: SqliteDatabase,
  sessionId: string,
  subagentId: string,
  record: SubagentRecord,
): number {
  const json = serializeSubagentRecord(record);
  const bytes = Buffer.byteLength(json, 'utf8');
  db.prepare(
    `UPDATE subagent_chains SET record_json = ?, summary_json = ?
     WHERE session_id = ? AND subagent_id = ?`,
  ).run(
    json,
    serializeSubagentSummary(record),
    sessionId,
    subagentId,
  );
  return bytes;
}

/**
 * Persist a subagent-chain compaction as one targeted SQLite transaction.
 *
 * Mirrors `applyCompactionPersistence` over the `subagent_chains` table
 * instead of the `chains` table: a subagent's chain lives embedded inside the
 * `record_json` column, not as separate chain rows. Effects, all-or-nothing:
 *
 * - Re-reads the durable `record_json` for the given subagent, deserializes
 *   the chain, sets `excludeFromModel` on every flagged message id, and inserts
 *   the summary-head message at the cut position. The chain keeps its original
 *   id — the summary is a message within the chain, not a separate row (no
 *   chain-split id handling is needed because the subagent's chain is a single
 *   row inside the record, not a multi-row layout with ordinals).
 * - Re-serializes the record and updates the `record_json` (and `summary_json`)
 *   column in place. Sibling subagent rows and every `chains` row are never
 *   touched.
 *
 * Throws (rolling the transaction back) when the session or subagent row is
 * unknown, a flagged id has no durable owner, or the record blob is
 * unreadable. Callers must never fall back to a full save from an in-memory
 * view when this fails.
 */
export function applySubagentCompactionPersistence(
  sessionId: string,
  subagentId: string,
  payload: SubagentCompactionPayload,
  opts?: StorageOptions,
): SubagentCompactionResult {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `applySubagentCompactionPersistence: refusing unsafe session id ${sessionId}`,
    );
  }
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const txn = db.transaction((): SubagentCompactionResult => {
      assertSessionRowPersisted(db, sessionId, 'applySubagentCompactionPersistence');
      const record = loadDurableSubagentRecord(db, sessionId, subagentId);
      const messages = withLiveMessageTail(record.chain.messages, payload.liveMessages);

      const durableMessageIds = new Set(messages.map((m) => m.id));
      const flaggedSet = new Set(payload.flaggedMessageIds);
      assertSubagentMessageIdsDurable(flaggedSet, durableMessageIds, 'flagged', sessionId, subagentId);
      // Idempotent clears (mirroring resolveClearedIdsByChain): a cleared id
      // with no durable owner is skipped — there is no durable message that
      // could resurrect a stale true flag, so a benign clear must never abort
      // the write and lose the flags and summary head.
      const clearedSet = new Set(
        (payload.clearedMessageIds ?? []).filter((id) => durableMessageIds.has(id)),
      );
      const anchorIndex = resolveSubagentAnchorIndex(messages, payload, sessionId, subagentId);

      // In-place flag writes: only flags change, originals preserved (R3).
      // Sets and clears land in the SAME message pass so a cleared flag can
      // never leave a stale true flag on the durable record.
      let updatedMessages = messages.map((m) => applyMessageFlags(m, flaggedSet, clearedSet));
      let summaryInserted = false;
      if (payload.summaryMessage) {
        updatedMessages = insertSubagentSummaryMessage(
          updatedMessages,
          payload.summaryMessage,
          anchorIndex,
        );
        summaryInserted = true;
      }

      const bytes = persistSubagentRecordWrite(db, sessionId, subagentId, {
        ...record,
        chain: { ...record.chain, messages: updatedMessages },
      });
      bumpSessionRecency(db, sessionId, payload.updatedAt);

      return {
        bytes,
        summaryInserted,
        flaggedCount: flaggedSet.size,
      };
    });
    return txn();
  });
}
