/**
 * Session history reads — bounded renderer views, durable history pages, and
 * subagent record/summary loading over the `chains` and `subagent_chains`
 * tables.
 */
import type { SqliteDatabase } from '../utils/sqlite';
import type { Session } from '../../shared/types/session';
import type { Chain } from '../../shared/types/chain';
import { ChainStatus, parseChainStatus } from '../../shared/types/chain';
import {
  messageFromStorageDict,
  type Message,
} from '../../shared/types/message';
import {
  summarizeSubagentRecord,
  type SubagentRecord,
  type SubagentSummary,
} from '../../shared/types/subagent';
import { subagentRecordFromStorageDict } from '../../shared/serialization/chain-subagent';
import {
  DEFAULT_HISTORY_PAGE_BYTE_BUDGET,
  DEFAULT_HISTORY_PAGE_MESSAGE_BUDGET,
  isValidSessionId,
  resolveOptions,
  withCorruptionRecovery,
  type StorageOptions,
} from './storage-db';
import {
  chainFromRow,
  deserializeMessages,
  deserializeSubagentSummary,
  emptyChainSummary,
  ensureChainMessageOffsets,
  parseChainViewSummary,
  serializeChainMessages,
  sessionFromRow,
  tryDeserializeMessages,
  type ChainRow,
  type ChainViewSummary,
  type SessionRow,
} from './storage-parse';
import {
  deleteSupersededChains,
  resolveChainViewSummary,
  selectChainRows,
} from './storage-chains';

/** One bounded durable history page returned without changing active selection. */
export interface SessionHistoryPage {
  readonly sessionId: string;
  readonly chainId: string;
  readonly messages: Message[];
  readonly startIndex: number;
  readonly totalMessages: number;
  readonly complete: boolean;
}

interface LoadedHistoryPage extends SessionHistoryPage {
  readonly loadedBytes: number;
}

interface HistoryPageQuery {
  readonly sessionId: string;
  readonly chainId: string;
  readonly beforeIndex?: number;
  readonly maxMessages: number;
  readonly maxBytes: number;
  readonly allowOneOversizedMessage: boolean;
  readonly summary?: ChainViewSummary;
}

interface HistoryPageIdentity {
  readonly sessionId: string;
  readonly chainId: string;
}

interface HistoryPageWindow {
  readonly messages: Message[];
  readonly startIndex: number;
  readonly loadedBytes: number;
}

function buildHistoryPage(
  identity: HistoryPageIdentity,
  totalMessages: number,
  window: HistoryPageWindow,
): LoadedHistoryPage {
  return {
    sessionId: identity.sessionId,
    chainId: identity.chainId,
    messages: window.messages,
    startIndex: window.startIndex,
    totalMessages,
    complete: window.startIndex === 0,
    loadedBytes: window.loadedBytes,
  };
}

interface RecentMessageWindow {
  readonly startOffset: number;
  readonly loadedBytes: number;
}

function recentMessageWindow(
  sizes: readonly number[],
  endOffset: number,
  maxMessages: number,
  maxBytes: number,
  allowOneOversizedMessage: boolean,
): RecentMessageWindow {
  let startOffset = endOffset;
  let loadedBytes = 0;
  while (startOffset > 0 && endOffset - startOffset < maxMessages) {
    const nextBytes = sizes[startOffset - 1]!;
    if (
      loadedBytes + nextBytes > maxBytes
      && !(allowOneOversizedMessage && startOffset === endOffset)
    ) {
      break;
    }
    startOffset -= 1;
    loadedBytes += nextBytes;
  }
  return { startOffset, loadedBytes };
}

function storedRecentMessages(
  recentMessagesJson: string | null,
  expectedCount: number,
): unknown[] | null {
  if (!recentMessagesJson) return null;
  let storedMessages: unknown;
  try {
    storedMessages = JSON.parse(recentMessagesJson);
  } catch {
    return null;
  }
  return Array.isArray(storedMessages) && storedMessages.length === expectedCount
    ? storedMessages
    : null;
}

function mapStoredMessages(
  storedMessages: readonly unknown[],
  startOffset: number,
  endOffset: number,
): Message[] | null {
  try {
    return storedMessages
      .slice(startOffset, endOffset)
      .map((message) => messageFromStorageDict(message));
  } catch {
    return null;
  }
}

function loadRecentHistoryPage(
  summary: ChainViewSummary,
  recentMessagesJson: string | null,
  query: HistoryPageQuery & { beforeIndex: number },
): LoadedHistoryPage | null {
  const { beforeIndex, maxMessages, maxBytes, allowOneOversizedMessage } = query;
  const sizes = summary.recentMessageSizes;
  if (!sizes || beforeIndex <= summary.recentStartIndex) return null;

  const storedMessages = storedRecentMessages(recentMessagesJson, sizes.length);
  if (!storedMessages) return null;

  const endOffset = Math.min(
    sizes.length,
    beforeIndex - summary.recentStartIndex,
  );
  const window = recentMessageWindow(
    sizes,
    endOffset,
    maxMessages,
    maxBytes,
    allowOneOversizedMessage,
  );
  const messages = mapStoredMessages(storedMessages, window.startOffset, endOffset);
  if (!messages) return null;

  return buildHistoryPage(query, summary.messageCount, {
    messages,
    startIndex: summary.recentStartIndex + window.startOffset,
    loadedBytes: window.loadedBytes,
  });
}

function legacyChainMessageCount(
  db: SqliteDatabase,
  sessionId: string,
  chainId: string,
): number {
  const messageCount = db.prepare(`
    SELECT CASE WHEN json_valid(messages_json)
      THEN json_array_length(messages_json) ELSE 0 END AS message_count
    FROM chains WHERE session_id = ? AND id = ?
  `).pluck().get(sessionId, chainId) as number ?? 0;
  return Math.max(0, messageCount);
}

interface HistorySummaryState {
  readonly summary: ChainViewSummary;
  readonly rebuildMessageOffsets: boolean;
  readonly recentMessagesJson: string | null | undefined;
}

function loadHistorySummaryState(
  db: SqliteDatabase,
  sessionId: string,
  chainId: string,
  provided: ChainViewSummary | undefined,
): HistorySummaryState | null {
  if (provided) {
    return { summary: provided, rebuildMessageOffsets: false, recentMessagesJson: undefined };
  }
  const metadata = db.prepare(`
    SELECT summary_json, recent_messages_json,
           length(CAST(messages_json AS BLOB)) AS message_bytes
    FROM chains WHERE session_id = ? AND id = ?
  `).get(sessionId, chainId) as {
    summary_json: string | null;
    recent_messages_json: string | null;
    message_bytes: number;
  } | undefined;
  if (!metadata) return null;
  const summary = parseChainViewSummary(metadata.summary_json);
  if (summary) {
    return {
      summary,
      rebuildMessageOffsets: false,
      recentMessagesJson: metadata.recent_messages_json,
    };
  }
  return {
    summary: emptyChainSummary(
      legacyChainMessageCount(db, sessionId, chainId),
      metadata.message_bytes ?? 0,
    ),
    rebuildMessageOffsets: true,
    recentMessagesJson: metadata.recent_messages_json,
  };
}

function resolveRecentMessagesJson(
  db: SqliteDatabase,
  sessionId: string,
  chainId: string,
  summary: ChainViewSummary,
  known: string | null | undefined,
): string | null | undefined {
  if (known !== undefined || !summary.recentMessageSizes) return known;
  return db.prepare(
    'SELECT recent_messages_json FROM chains WHERE session_id = ? AND id = ?',
  ).pluck().get(sessionId, chainId) as string | null | undefined;
}

function ensureHistoryOffsetsIndexed(
  db: SqliteDatabase,
  sessionId: string,
  chainId: string,
  rebuildMessageOffsets: boolean,
): boolean {
  const hasOffsets = !rebuildMessageOffsets && Boolean(db.prepare(
    'SELECT 1 FROM chain_message_offsets WHERE chain_id = ? LIMIT 1',
  ).get(chainId));
  if (hasOffsets) return true;

  const source = db.prepare(
    'SELECT messages_json FROM chains WHERE session_id = ? AND id = ?',
  ).get(sessionId, chainId) as { messages_json: string } | undefined;
  if (source && ensureChainMessageOffsets(db, chainId, source.messages_json, true)) {
    return true;
  }
  console.error(`[session] could not index canonical history for chain ${chainId}`);
  return false;
}

interface HistoryOffsetRow {
  readonly message_index: number;
  readonly message_json: string;
  readonly message_bytes: number;
}

function selectHistoryOffsetRows(
  db: SqliteDatabase,
  query: HistoryPageQuery,
  before: number,
): HistoryOffsetRow[] {
  const { sessionId, chainId, maxMessages, maxBytes, allowOneOversizedMessage } = query;
  return db.prepare(`
    WITH candidates AS (
      SELECT message_index, byte_offset, byte_length
      FROM chain_message_offsets
      WHERE chain_id = ? AND message_index < ?
      ORDER BY message_index DESC
      LIMIT ?
    ), ranked AS (
      SELECT message_index, byte_offset, byte_length,
             ROW_NUMBER() OVER (ORDER BY message_index DESC) AS message_rank,
             SUM(byte_length) OVER (ORDER BY message_index DESC) AS cumulative_bytes
      FROM candidates
    )
    SELECT r.message_index,
           CAST(substr(
             CAST(c.messages_json AS BLOB),
             r.byte_offset + 1,
             r.byte_length
           ) AS TEXT) AS message_json,
           r.byte_length AS message_bytes
    FROM ranked r
    JOIN chains c ON c.id = ? AND c.session_id = ?
    WHERE cumulative_bytes <= ? OR (? = 1 AND message_rank = 1)
    ORDER BY r.message_index
  `).all(
    chainId,
    before,
    Math.max(1, Math.floor(maxMessages)),
    chainId,
    sessionId,
    Math.max(1, Math.floor(maxBytes)),
    allowOneOversizedMessage ? 1 : 0,
  ) as HistoryOffsetRow[];
}

function mapHistoryRows(
  rows: readonly HistoryOffsetRow[],
  chainId: string,
  before: number,
): HistoryPageWindow {
  const messages: Message[] = [];
  let loadedBytes = 0;
  let startIndex = before;
  for (const row of rows) {
    // Cursor progress follows durable row positions even when one row cannot
    // be decoded; otherwise the renderer can request the same corrupt page forever.
    startIndex = Math.min(startIndex, row.message_index);
    try {
      messages.push(messageFromStorageDict(JSON.parse(row.message_json)));
      loadedBytes += row.message_bytes;
    } catch (err) {
      console.error(
        `[session] skipping corrupt message ${row.message_index} in chain ${chainId}`,
        err,
      );
    }
  }
  return { messages, startIndex, loadedBytes };
}

function loadHistoryPageFromDb(
  db: SqliteDatabase,
  query: HistoryPageQuery,
): LoadedHistoryPage | null {
  const { sessionId, chainId, beforeIndex, maxMessages, maxBytes } = query;
  const state = loadHistorySummaryState(db, sessionId, chainId, query.summary);
  if (!state) return null;

  const summary = state.summary;
  const totalMessages = summary.messageCount;
  const before = Math.min(
    totalMessages,
    Math.max(0, beforeIndex ?? totalMessages),
  );
  if (before === 0 || maxMessages <= 0 || maxBytes <= 0) {
    return buildHistoryPage(query, totalMessages, {
      messages: [],
      startIndex: before,
      loadedBytes: 0,
    });
  }

  const recentMessagesJson = resolveRecentMessagesJson(
    db,
    sessionId,
    chainId,
    summary,
    state.recentMessagesJson,
  );
  const recentPage = loadRecentHistoryPage(
    summary,
    recentMessagesJson ?? null,
    {
      ...query,
      beforeIndex: before,
      maxMessages: Math.max(1, Math.floor(maxMessages)),
      maxBytes: Math.max(1, Math.floor(maxBytes)),
    },
  );
  if (recentPage) return recentPage;

  if (!ensureHistoryOffsetsIndexed(db, sessionId, chainId, state.rebuildMessageOffsets)) {
    return buildHistoryPage(query, totalMessages, {
      messages: [],
      startIndex: 0,
      loadedBytes: 0,
    });
  }

  const window = mapHistoryRows(selectHistoryOffsetRows(db, query, before), chainId, before);
  return buildHistoryPage(query, totalMessages, window);
}

interface SessionLoadState {
  readonly row: SessionRow;
  readonly chainRows: ChainRow[];
}

interface SessionViewBudget {
  messages: number;
  bytes: number;
}

function selectSessionRow(db: SqliteDatabase, sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
}

function readSessionLoadState(
  db: SqliteDatabase,
  sessionId: string,
  loadFullSession: boolean,
): SessionLoadState | null {
  const row = selectSessionRow(db, sessionId);
  if (!row) return null;
  return { row, chainRows: selectChainRows(db, sessionId, loadFullSession) };
}

/**
 * A process restart makes every persisted active chain terminal: mark them
 * INTERRUPTED, drop the session pointer at them, and re-read both rows.
 */
function recoverActiveChainRows(
  db: SqliteDatabase,
  sessionId: string,
  loadFullSession: boolean,
  state: SessionLoadState,
): SessionLoadState {
  const activeChainIds = state.chainRows
    .filter((chain) => parseChainStatus(chain.status) === ChainStatus.ACTIVE)
    .map((chain) => chain.id);
  if (activeChainIds.length === 0) return state;

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

  return {
    row: selectSessionRow(db, sessionId) as SessionRow,
    chainRows: selectChainRows(db, sessionId, loadFullSession),
  };
}

/**
 * Heal superseded chain rows (duplicate split rows from mid-turn
 * compactions whose turn never finalized — crash or restart — plus
 * sessions already carrying the damage). Recovery above already made
 * every chain terminal, so the active-pointer exclusion only protects
 * a pointer that survived it. A LIVE compaction split (fresh-id
 * prefix + summary + continuing suffix) is never a subset relation
 * and always survives the heal.
 */
function healSupersededChainRows(
  db: SqliteDatabase,
  sessionId: string,
  loadFullSession: boolean,
  state: SessionLoadState,
): SessionLoadState {
  const healed = deleteSupersededChains(db, sessionId, null, state.row.active_chain_id ?? null);
  if (healed.length === 0) return state;
  return { row: state.row, chainRows: selectChainRows(db, sessionId, loadFullSession) };
}

function loadFullChains(chainRows: readonly ChainRow[], sessionId: string): Chain[] {
  const chains: Chain[] = [];
  for (const cr of chainRows) {
    try {
      chains.push(chainFromRow(cr));
    } catch (err) {
      console.error(`[session] skipping corrupt chain ${cr.id} on load (session ${sessionId})`, err);
    }
  }
  return chains;
}

function loadChainViewPage(
  db: SqliteDatabase,
  sessionId: string,
  chainId: string,
  summary: ChainViewSummary,
  budget: SessionViewBudget,
): LoadedHistoryPage | null {
  if (budget.messages <= 0 || budget.bytes <= 0 || summary.messageCount <= 0) return null;
  const newestMessageBytes = summary.newestMessageBytes;
  if (newestMessageBytes != null && newestMessageBytes > budget.bytes) return null;
  return loadHistoryPageFromDb(db, {
    sessionId,
    chainId,
    beforeIndex: summary.messageCount,
    maxMessages: budget.messages,
    maxBytes: budget.bytes,
    allowOneOversizedMessage: false,
    summary,
  });
}

function resolveViewChainSummary(
  sessionId: string,
  row: ChainRow,
  backfillSummary: import('better-sqlite3').Statement,
  selectLegacyMessages: import('better-sqlite3').Statement,
): ChainViewSummary {
  const persistedSummary = parseChainViewSummary(row.summary_json);
  if (persistedSummary) return persistedSummary;
  const summary = resolveChainViewSummary(row);
  const legacy = selectLegacyMessages.get(sessionId, row.id) as {
    messages_json: string;
  } | undefined;
  const legacyMessages = legacy ? tryDeserializeMessages(legacy.messages_json, false) : null;
  if (!legacyMessages) return summary;
  const serialized = serializeChainMessages(legacyMessages);
  const serializedSummary = parseChainViewSummary(serialized.summaryJson);
  if (!serializedSummary) return summary;
  backfillSummary.run(
    serialized.summaryJson,
    serialized.recentMessagesJson,
    sessionId,
    row.id,
  );
  return serializedSummary;
}

function loadPagedChains(
  db: SqliteDatabase,
  sessionId: string,
  chainRows: readonly ChainRow[],
  budget: SessionViewBudget,
): Chain[] {
  const backfillSummary = db.prepare(
    `UPDATE chains
     SET summary_json = ?, recent_messages_json = ?
     WHERE session_id = ? AND id = ?`,
  );
  const selectLegacyMessages = db.prepare(
    'SELECT messages_json FROM chains WHERE session_id = ? AND id = ?',
  );
  const pagedChains = new Array<Chain | undefined>(chainRows.length);
  for (let index = chainRows.length - 1; index >= 0; index -= 1) {
    const cr = chainRows[index]!;
    const summary = resolveViewChainSummary(
      sessionId,
      cr,
      backfillSummary,
      selectLegacyMessages,
    );
    const page = loadChainViewPage(db, sessionId, cr.id, summary, budget);
    const messages = page?.messages ?? [];
    const startIndex = page?.startIndex ?? summary.messageCount;
    budget.messages = Math.max(0, budget.messages - messages.length);
    budget.bytes = Math.max(0, budget.bytes - (page?.loadedBytes ?? 0));
    try {
      pagedChains[index] = chainFromRow(cr, { messages, startIndex, summary });
    } catch (err) {
      console.error(`[session] skipping corrupt chain ${cr.id} on view load (session ${sessionId})`, err);
    }
  }
  return pagedChains.filter((chain): chain is Chain => chain != null);
}

function loadFullSubagentRecords(db: SqliteDatabase, sessionId: string): SubagentRecord[] {
  const subagentRows = db
    .prepare(
      'SELECT subagent_id, record_json, summary_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
    )
    .all(sessionId) as Array<{ subagent_id: string; record_json: string }>;
  const records: SubagentRecord[] = [];
  for (const sr of subagentRows) {
    try {
      records.push(subagentRecordFromStorageDict(JSON.parse(sr.record_json)));
    } catch (err) {
      console.error(
        `[session] skipping corrupt subagent record ${sr.subagent_id} on load (session ${sessionId})`,
        err,
      );
    }
  }
  return records;
}

function loadSessionInternal(
  sessionId: string,
  loadFullSession: boolean,
  opts?: StorageOptions,
  recoverActiveChains = true,
): Session | null {
  if (!isValidSessionId(sessionId)) {
    return null;
  }
  const {
    dbPath,
    sessionViewMessageBudget,
    sessionViewByteBudget,
  } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const load = db.transaction(() => {
      const stored = readSessionLoadState(db, sessionId, loadFullSession);
      if (!stored) return null;
      const recovered = recoverActiveChains
        ? recoverActiveChainRows(db, sessionId, loadFullSession, stored)
        : stored;
      const healed = healSupersededChainRows(db, sessionId, loadFullSession, recovered);
      const chains = loadFullSession
        ? loadFullChains(healed.chainRows, sessionId)
        : loadPagedChains(db, sessionId, healed.chainRows, {
            messages: Math.max(0, sessionViewMessageBudget),
            bytes: Math.max(0, sessionViewByteBudget),
          });
      const subagentChains = loadFullSession ? loadFullSubagentRecords(db, sessionId) : [];
      return sessionFromRow(healed.row, chains, subagentChains);
    });
    return load();
  });
}

/** Load the complete durable session, including full subagent transcripts. */
export function loadSession(sessionId: string, opts?: StorageOptions): Session | null {
  return loadSessionInternal(sessionId, true, opts);
}

/** Load complete durable state without applying process-restart recovery. */
export function loadSessionForReplacement(
  sessionId: string,
  opts?: StorageOptions,
): Session | null {
  return loadSessionInternal(sessionId, true, opts, false);
}

/** Load the navigation payload without selecting or parsing subagent record_json. */
export function loadSessionView(sessionId: string, opts?: StorageOptions): Session | null {
  return loadSessionInternal(sessionId, false, opts);
}

/**
 * Bounded renderer view WITHOUT process-restart recovery.
 *
 * Live-cache refresh after a compaction durable write: a mid-turn ACTIVE
 * continuing row must keep its status and the session's active-chain pointer
 * (recovery would flip it to INTERRUPTED and strand the live turn's
 * checkpoint writes).
 */
export function loadSessionViewUnrecovered(sessionId: string, opts?: StorageOptions): Session | null {
  return loadSessionInternal(sessionId, false, opts, false);
}

/** Load the next older bounded page for one chain in a renderer session view. */
export function loadSessionHistoryPage(
  sessionId: string,
  chainId: string,
  beforeIndex?: number,
  opts?: StorageOptions,
): SessionHistoryPage | null {
  if (!isValidSessionId(sessionId)) return null;
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const page = loadHistoryPageFromDb(db, {
      sessionId,
      chainId,
      beforeIndex,
      maxMessages: DEFAULT_HISTORY_PAGE_MESSAGE_BUDGET,
      maxBytes: DEFAULT_HISTORY_PAGE_BYTE_BUDGET,
      allowOneOversizedMessage: true,
    });
    if (!page) return null;
    const { loadedBytes: _loadedBytes, ...result } = page;
    return result;
  });
}

/** Full main-conversation history for model context, independent from renderer paging. */
export function loadSessionMessages(
  sessionId: string,
  opts?: StorageOptions,
): Message[] {
  if (!isValidSessionId(sessionId)) return [];
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const rows = db.prepare(
      'SELECT messages_json FROM chains WHERE session_id = ? ORDER BY ordinal',
    ).all(sessionId) as Array<{ messages_json: string }>;
    return rows.flatMap((row) => deserializeMessages(row.messages_json));
  });
}

/**
 * Load bounded persisted summaries. Legacy rows are derived once from the full
 * record and backfilled so subsequent navigation/snapshot reads stay bounded.
 */
export function loadSubagentSummaries(
  sessionId: string,
  opts?: StorageOptions,
): SubagentSummary[] {
  if (!isValidSessionId(sessionId)) return [];
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const rows = db.prepare(
      'SELECT rowid, subagent_id, summary_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
    ).all(sessionId) as Array<{
      rowid: number;
      subagent_id: string;
      summary_json: string | null;
    }>;
    if (rows.length === 0) return [];

    const loadRecord = db.prepare(
      'SELECT record_json FROM subagent_chains WHERE session_id = ? AND subagent_id = ?',
    );
    const backfill = db.prepare(
      'UPDATE subagent_chains SET summary_json = ? WHERE session_id = ? AND subagent_id = ?',
    );
    const summaries: SubagentSummary[] = [];

    for (const row of rows) {
      let summary = row.summary_json
        ? deserializeSubagentSummary(row.summary_json)
        : null;
      if (!summary) {
        const recordJson = (
          loadRecord.get(sessionId, row.subagent_id) as { record_json: string } | undefined
        )?.record_json;
        if (!recordJson) continue;
        try {
          const record = subagentRecordFromStorageDict(JSON.parse(recordJson));
          summary = summarizeSubagentRecord(record);
          backfill.run(JSON.stringify(summary), sessionId, row.subagent_id);
        } catch (err) {
          console.error(
            `[session] skipping corrupt subagent record ${row.subagent_id} while loading summaries (session ${sessionId})`,
            err,
          );
          continue;
        }
      }
      summaries.push(summary);
    }
    return summaries;
  });
}

/** Load exactly one full persisted subagent transcript for detail/lifecycle use. */
export function loadSubagentRecord(
  sessionId: string,
  subagentId: string,
  opts?: StorageOptions,
): SubagentRecord | null {
  if (!isValidSessionId(sessionId)) return null;
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const row = db.prepare(
      'SELECT record_json FROM subagent_chains WHERE session_id = ? AND subagent_id = ?',
    ).get(sessionId, subagentId) as { record_json: string } | undefined;
    if (!row) return null;
    try {
      return subagentRecordFromStorageDict(JSON.parse(row.record_json));
    } catch (err) {
      console.error(
        `[session] failed to load subagent record ${subagentId} (session ${sessionId})`,
        err,
      );
      return null;
    }
  });
}

/** List durable subagent identities without selecting transcript or summary JSON. */
export function listSubagentRecordIds(
  sessionId: string,
  opts?: StorageOptions,
): string[] {
  if (!isValidSessionId(sessionId)) return [];
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => (
    db.prepare(
      'SELECT subagent_id FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
    ).all(sessionId) as Array<{ subagent_id: string }>
  ).map((row) => row.subagent_id));
}

function selectSubagentRecordRows(
  db: SqliteDatabase,
  sessionId: string,
  uniqueIds: readonly string[] | null,
): Array<{ subagent_id: string; record_json: string }> {
  if (uniqueIds == null) {
    return db.prepare(
      'SELECT subagent_id, record_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
    ).all(sessionId) as Array<{ subagent_id: string; record_json: string }>;
  }
  const rows: Array<{ subagent_id: string; record_json: string }> = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 900) {
    const chunk = uniqueIds.slice(offset, offset + 900);
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(...db.prepare(
      `SELECT subagent_id, record_json FROM subagent_chains
       WHERE session_id = ? AND subagent_id IN (${placeholders}) ORDER BY rowid`,
    ).all(sessionId, ...chunk) as Array<{ subagent_id: string; record_json: string }>);
  }
  return rows;
}

/** Load selected full records; omit ids to restore the entire session runtime. */
export function loadSubagentRecords(
  sessionId: string,
  subagentIds?: readonly string[],
  opts?: StorageOptions,
): SubagentRecord[] {
  if (!isValidSessionId(sessionId)) return [];
  const uniqueIds = subagentIds ? [...new Set(subagentIds)] : null;
  if (uniqueIds?.length === 0) return [];
  const { dbPath } = resolveOptions(opts);
  return withCorruptionRecovery(dbPath, (db) => {
    const records: SubagentRecord[] = [];
    for (const row of selectSubagentRecordRows(db, sessionId, uniqueIds)) {
      try {
        records.push(subagentRecordFromStorageDict(JSON.parse(row.record_json)));
      } catch (err) {
        console.error(
          `[session] skipping corrupt subagent record ${row.subagent_id} during runtime load (session ${sessionId})`,
          err,
        );
      }
    }
    return records;
  });
}
