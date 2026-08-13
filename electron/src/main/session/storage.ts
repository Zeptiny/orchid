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
import {
  contextSnapshotSchema,
  MessageRole,
  MessageType,
  type Message,
  type Usage,
} from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import {
  SubagentStatus,
  summarizeSubagentRecord,
  type SubagentRecord,
  type SubagentSummary,
} from '../../shared/types/subagent';
import { ipcSubagentSummarySchema } from '../../shared/types/ipc-schemas';
import type { TodoStoreData } from '../../shared/types/todo';
import { PERMISSION_MODE_VALUES, type PermissionMode } from '../../shared/types/permission';
import {
  messageToStorageDict,
  messageFromStorageDict,
} from '../../shared/types/message';
import {
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from '../../shared/serialization/chain-subagent';
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
import { sumMessageUsages } from '../../shared/usage';

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
  /** Initial renderer history budget; primarily overridden by focused tests. */
  sessionViewMessageBudget?: number;
  /** Initial renderer serialized-message byte budget. */
  sessionViewByteBudget?: number;
}

export const DEFAULT_SESSION_VIEW_MESSAGE_BUDGET = 240;
export const DEFAULT_SESSION_VIEW_BYTE_BUDGET = 2 * 1024 * 1024;
export const DEFAULT_HISTORY_PAGE_MESSAGE_BUDGET = 100;
export const DEFAULT_HISTORY_PAGE_BYTE_BUDGET = 512 * 1024;

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

function resolveOptions(opts?: StorageOptions) {
  return {
    dbPath: opts?.dbPath ?? SESSION_DB_PATH,
    toolOutputCacheDir: opts?.toolOutputCacheDir ?? TOOL_OUTPUT_CACHE_DIR,
    webFetchCacheDir: opts?.webFetchCacheDir ?? WEB_FETCH_CACHE_DIR,
    sessionViewMessageBudget:
      opts?.sessionViewMessageBudget ?? DEFAULT_SESSION_VIEW_MESSAGE_BUDGET,
    sessionViewByteBudget:
      opts?.sessionViewByteBudget ?? DEFAULT_SESSION_VIEW_BYTE_BUDGET,
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
const storageRecoveryListeners = new Set<() => void>();

/**
 * Subscribe to a successful SQLite connection recovery.
 *
 * Consumers with previously failed best-effort writes can use this as a safe
 * signal to retry once; the storage layer itself still owns recovery.
 */
export function onSessionStorageRecovered(listener: () => void): () => void {
  storageRecoveryListeners.add(listener);
  return () => storageRecoveryListeners.delete(listener);
}

function notifySessionStorageRecovered(): void {
  for (const listener of storageRecoveryListeners) {
    try {
      listener();
    } catch (error) {
      console.warn('Session storage recovery observer failed:', error);
    }
  }
}

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
const activeRecoveryPaths = new Set<string>();

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
    const result = op(getDb(dbPath));
    if (!activeRecoveryPaths.has(dbPath)) {
      activeRecoveryPaths.add(dbPath);
      try {
        notifySessionStorageRecovered();
      } finally {
        activeRecoveryPaths.delete(dbPath);
      }
    }
    return result;
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
  todo_store_json: string;
  reasoning_effort_override: string | null;
  tier_override: string | null;
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
  messages_json: string | null;
  message_count?: number;
  message_bytes?: number;
  summary_json: string | null;
  recent_messages_json: string | null;
  start_time: string | null;
  end_time: string | null;
  error_detail: string | null;
  error_title: string | null;
}

interface ChainViewSummary {
  readonly messageCount: number;
  readonly messageBytes: number;
  readonly usage: Usage | null;
  readonly preview: string | null;
  /** Lets first paint skip an oversized newest message without parsing the chain blob. */
  readonly newestMessageBytes: number | null;
  /** Absolute index represented by the first persisted recent message. */
  readonly recentStartIndex: number;
  /** Serialized sizes for the bounded recent-message window only. */
  readonly recentMessageSizes: readonly number[] | null;
}

/** One bounded durable history page returned without changing active selection. */
export interface SessionHistoryPage {
  readonly sessionId: string;
  readonly chainId: string;
  readonly messages: Message[];
  readonly startIndex: number;
  readonly totalMessages: number;
  readonly complete: boolean;
}

interface SubagentChainRow {
  subagent_id: string;
  record_json: string;
  summary_json: string | null;
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

function tryDeserializeMessages(
  json: string,
  reconcile = true,
): Message[] | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return null;
    const messages = raw.map((message) => messageFromStorageDict(message));
    return reconcile ? reconcileOrphanToolResults(messages) : messages;
  } catch {
    return null;
  }
}

function deserializeMessages(json: string): Message[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const messages: Message[] = [];
  for (const storedMessage of raw) {
    try {
      messages.push(messageFromStorageDict(storedMessage));
    } catch (error) {
      console.error('[session] skipping malformed message while loading history', error);
    }
  }
  return reconcileOrphanToolResults(messages);
}

function chainPreview(messages: readonly Message[]): string | null {
  const user = messages.find(
    (message) => message.role === MessageRole.USER && message.type === MessageType.TEXT,
  );
  if (!user?.content) return null;
  const text = user.content.trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

interface SerializedChainMessages {
  readonly messagesJson: string;
  readonly summaryJson: string;
  readonly recentMessagesJson: string;
  readonly messageOffsets: readonly MessageByteOffset[];
}

interface MessageByteOffset {
  readonly messageIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function serializeChainMessages(messages: readonly Message[]): SerializedChainMessages {
  const storedMessages = messages.map(messageToStorageDict);
  const serializedMessages = storedMessages.map((message) => JSON.stringify(message));
  const messageOffsets: MessageByteOffset[] = [];
  let byteOffset = 1; // Skip the opening '[' byte.
  for (let index = 0; index < serializedMessages.length; index += 1) {
    const byteLength = Buffer.byteLength(serializedMessages[index]!, 'utf8');
    messageOffsets.push({ messageIndex: index, byteOffset, byteLength });
    byteOffset += byteLength + 1; // Each non-final fragment is followed by ','.
  }
  const messagesJson = `[${serializedMessages.join(',')}]`;
  const recentMessageSizes: number[] = [];
  let recentBytes = 0;
  let recentStartIndex = storedMessages.length;

  for (let index = storedMessages.length - 1; index >= 0; index -= 1) {
    if (recentMessageSizes.length >= DEFAULT_SESSION_VIEW_MESSAGE_BUDGET) break;
    const messageBytes = messageOffsets[index]!.byteLength;
    if (recentBytes + messageBytes > DEFAULT_SESSION_VIEW_BYTE_BUDGET) break;
    recentMessageSizes.unshift(messageBytes);
    recentBytes += messageBytes;
    recentStartIndex = index;
  }

  const newestStoredMessage = storedMessages.at(-1);
  const summary: ChainViewSummary = {
    messageCount: messages.length,
    messageBytes: Buffer.byteLength(messagesJson, 'utf8'),
    usage: sumMessageUsages(messages),
    preview: chainPreview(messages),
    newestMessageBytes: recentMessageSizes.at(-1)
      ?? (newestStoredMessage
        ? Buffer.byteLength(JSON.stringify(newestStoredMessage), 'utf8')
        : null),
    recentStartIndex,
    recentMessageSizes,
  };
  return {
    messagesJson,
    summaryJson: JSON.stringify(summary),
    recentMessagesJson: `[${serializedMessages.slice(recentStartIndex).join(',')}]`,
    messageOffsets,
  };
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Build exact UTF-8 byte ranges for top-level members of a stored JSON array. */
function messageOffsetsFromJson(messagesJson: string): MessageByteOffset[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const bytes = Buffer.from(messagesJson, 'utf8');
  let cursor = 0;
  while (cursor < bytes.length && isJsonWhitespace(bytes[cursor]!)) cursor += 1;
  if (bytes[cursor] !== 0x5b) return null; // '['
  cursor += 1;

  const offsets: MessageByteOffset[] = [];
  while (cursor < bytes.length) {
    while (cursor < bytes.length && isJsonWhitespace(bytes[cursor]!)) cursor += 1;
    if (bytes[cursor] === 0x5d) { // ']'
      cursor += 1;
      while (cursor < bytes.length && isJsonWhitespace(bytes[cursor]!)) cursor += 1;
      return cursor === bytes.length && offsets.length === parsed.length ? offsets : null;
    }

    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let completed = false;
    for (; cursor < bytes.length; cursor += 1) {
      const byte = bytes[cursor]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true; // '\\'
        else if (byte === 0x22) inString = false; // '"'
        continue;
      }
      if (byte === 0x22) {
        inString = true;
      } else if (byte === 0x7b || byte === 0x5b) { // '{' or '['
        depth += 1;
      } else if (byte === 0x7d) { // '}'
        if (depth === 0) return null;
        depth -= 1;
      } else if (byte === 0x5d) { // ']'
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        let end = cursor;
        while (end > start && isJsonWhitespace(bytes[end - 1]!)) end -= 1;
        if (end === start) return null;
        offsets.push({
          messageIndex: offsets.length,
          byteOffset: start,
          byteLength: end - start,
        });
        completed = true;
        break;
      } else if (byte === 0x2c && depth === 0) { // ','
        let end = cursor;
        while (end > start && isJsonWhitespace(bytes[end - 1]!)) end -= 1;
        if (end === start) return null;
        offsets.push({
          messageIndex: offsets.length,
          byteOffset: start,
          byteLength: end - start,
        });
        cursor += 1;
        completed = true;
        break;
      }
    }
    if (!completed) return null;
  }
  return null;
}

function replaceChainMessageOffsets(
  db: SqliteDatabase,
  chainId: string,
  offsets: readonly MessageByteOffset[],
): void {
  db.prepare('DELETE FROM chain_message_offsets WHERE chain_id = ?').run(chainId);
  if (offsets.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO chain_message_offsets (
      chain_id, message_index, byte_offset, byte_length
    ) VALUES (?, ?, ?, ?)
  `);
  for (const offset of offsets) {
    insert.run(
      chainId,
      offset.messageIndex,
      offset.byteOffset,
      offset.byteLength,
    );
  }
}

function ensureChainMessageOffsets(
  db: SqliteDatabase,
  chainId: string,
  messagesJson: string,
  force = false,
): boolean {
  if (!force) {
    const exists = db.prepare(
      'SELECT 1 FROM chain_message_offsets WHERE chain_id = ? LIMIT 1',
    ).get(chainId);
    if (exists) return true;
  }
  const offsets = messageOffsetsFromJson(messagesJson);
  if (!offsets) return false;
  db.transaction(() => replaceChainMessageOffsets(db, chainId, offsets))();
  return true;
}

function parseUsage(value: unknown): Usage | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) return null;
  }
  const context = contextSnapshotSchema.safeParse(raw.context);
  return {
    prompt_tokens: raw.prompt_tokens as number,
    completion_tokens: raw.completion_tokens as number,
    total_tokens: raw.total_tokens as number,
    cached_tokens: raw.cached_tokens as number,
    ...(typeof raw.reasoning_tokens === 'number'
      && Number.isFinite(raw.reasoning_tokens)
      && raw.reasoning_tokens >= 0
      ? { reasoning_tokens: raw.reasoning_tokens }
      : {}),
    ...(context.success ? { context: context.data } : {}),
  };
}

function parseChainViewSummary(json: string | null): ChainViewSummary | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.messageCount !== 'number'
      || !Number.isInteger(raw.messageCount)
      || raw.messageCount < 0
      || typeof raw.messageBytes !== 'number'
      || !Number.isInteger(raw.messageBytes)
      || raw.messageBytes < 0
      || (raw.preview !== null && typeof raw.preview !== 'string')
    ) {
      return null;
    }
    const newestMessageBytes = typeof raw.newestMessageBytes === 'number'
      && Number.isInteger(raw.newestMessageBytes)
      && raw.newestMessageBytes >= 0
      ? raw.newestMessageBytes
      : null;
    const recentStartIndex = typeof raw.recentStartIndex === 'number'
      && Number.isInteger(raw.recentStartIndex)
      && raw.recentStartIndex >= 0
      && raw.recentStartIndex <= raw.messageCount
      ? raw.recentStartIndex
      : raw.messageCount;
    const recentMessageSizes = Array.isArray(raw.recentMessageSizes)
      && raw.recentMessageSizes.length === raw.messageCount - recentStartIndex
      && raw.recentMessageSizes.every((size) => (
        typeof size === 'number' && Number.isInteger(size) && size >= 0
      ))
      ? raw.recentMessageSizes as number[]
      : null;
    return {
      messageCount: raw.messageCount,
      messageBytes: raw.messageBytes,
      usage: parseUsage(raw.usage),
      preview: raw.preview as string | null,
      newestMessageBytes,
      recentStartIndex,
      recentMessageSizes,
    };
  } catch {
    return null;
  }
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

function chainFromRow(
  row: ChainRow,
  view?: {
    messages: Message[];
    startIndex: number;
    summary: ChainViewSummary;
  },
): Chain {
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
    messages: view?.messages ?? deserializeMessages(row.messages_json ?? '[]'),
    status: parseChainStatus(row.status),
    selection: deserializeSelection(row.selection_json),
    modelLabel: row.model_label,
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    subagentRecord,
    startTime: row.start_time,
    endTime: row.end_time,
    errorDetail: row.error_detail ?? null,
    errorTitle: row.error_title ?? null,
    ...(view
      ? {
          messagesLoaded: view.startIndex === 0,
          messageStartIndex: view.startIndex,
          messageCount: view.summary.messageCount,
          usageSummary: view.summary.usage,
          preview: view.summary.preview,
        }
      : {}),
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

function serializeTierOverride(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function deserializeTierOverride(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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

function sessionFromRow(row: SessionRow, chains: Chain[], subagentChains: SubagentRecord[]): Session {
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
    subagentChains,
    todoStore: deserializeTodoStore(row.todo_store_json),
    reasoningEffortOverride: deserializeReasoningEffortOverride(row.reasoning_effort_override),
    tierOverride: deserializeTierOverride(row.tier_override),
    permissionMode: deserializePermissionMode(row.permission_mode),
  };
}

const INSERT_CHAIN_SQL = `
  INSERT INTO chains (id, session_id, ordinal, status, selection_json, model_label, agent_name, agent_type, agent_tier, subagent_record_json, messages_json, start_time, end_time, error_detail, error_title, summary_json, recent_messages_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_SUBAGENT_CHAIN_SQL = `
  INSERT INTO subagent_chains (session_id, subagent_id, record_json, summary_json)
  VALUES (?, ?, ?, ?)
`;

function serializeSubagentRecord(record: SubagentRecord): string {
  return JSON.stringify(subagentRecordToStorageDict(record));
}

function serializeSubagentSummary(record: SubagentRecord): string {
  return JSON.stringify(summarizeSubagentRecord(record));
}

function restoreSubagentSummary(value: unknown): SubagentSummary | null {
  const parsed = ipcSubagentSummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const summary = parsed.data;
  if (
    summary.status !== SubagentStatus.QUEUED
    && summary.status !== SubagentStatus.PENDING
    && summary.status !== SubagentStatus.RUNNING
  ) {
    return summary;
  }
  return {
    ...summary,
    status: SubagentStatus.INTERRUPTED,
    end_time: summary.end_time ?? new Date().toISOString(),
  };
}

function deserializeSubagentSummary(json: string): SubagentSummary | null {
  try {
    return restoreSubagentSummary(JSON.parse(json));
  } catch {
    return null;
  }
}

function insertChainRow(
  db: SqliteDatabase,
  insertChain: import('better-sqlite3').Statement,
  chain: Chain,
  ordinal: number,
): void {
  const serialized = serializeChainMessages(chain.messages);
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
    serialized.messagesJson,
    chain.startTime,
    chain.endTime,
    chain.errorDetail,
    chain.errorTitle,
    serialized.summaryJson,
    serialized.recentMessagesJson,
  );
  replaceChainMessageOffsets(db, chain.id, serialized.messageOffsets);
}

function updateChainRow(db: SqliteDatabase, chain: Chain): number {
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
      serialized.messagesJson,
      chain.startTime,
      chain.endTime,
      chain.errorDetail,
      chain.errorTitle,
      serialized.summaryJson,
      serialized.recentMessagesJson,
      chain.id,
      chain.sessionId,
    ).changes;
  if (changes > 0) {
    replaceChainMessageOffsets(db, chain.id, serialized.messageOffsets);
  }
  return changes;
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
  if (Object.hasOwn(update, 'todoStore')) {
    add('todo_store_json', serializeTodoStore(update.todoStore ?? { tasks: [] }));
  }
  if (Object.hasOwn(update, 'reasoningEffortOverride')) {
    add(
      'reasoning_effort_override',
      serializeReasoningEffortOverride(update.reasoningEffortOverride ?? null),
    );
  }
  if (Object.hasOwn(update, 'tierOverride')) {
    add('tier_override', serializeTierOverride(update.tierOverride ?? null));
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
      insertChainRow(db, insertChain, chain, ordinalRow.ordinal);
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

      const ordinal = db.prepare(
        'SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM chains WHERE session_id = ?',
      ).pluck().get(chain.sessionId) as number;
      insertChainRow(db, insertChain, chain, ordinal);
      return true;
    });
    return txn();
  });
}

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

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

function selectChainRows(
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

function resolveChainViewSummary(row: ChainRow): ChainViewSummary {
  return parseChainViewSummary(row.summary_json) ?? {
    messageCount: row.message_count ?? 0,
    messageBytes: row.message_bytes ?? 0,
    usage: null,
    preview: null,
    newestMessageBytes: null,
    recentStartIndex: row.message_count ?? 0,
    recentMessageSizes: null,
  };
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

function loadRecentHistoryPage(
  summary: ChainViewSummary,
  recentMessagesJson: string | null,
  query: HistoryPageQuery & { beforeIndex: number },
): LoadedHistoryPage | null {
  const {
    sessionId,
    chainId,
    beforeIndex,
    maxMessages,
    maxBytes,
    allowOneOversizedMessage,
  } = query;
  const sizes = summary.recentMessageSizes;
  if (!sizes || !recentMessagesJson || beforeIndex <= summary.recentStartIndex) return null;

  let storedMessages: unknown;
  try {
    storedMessages = JSON.parse(recentMessagesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(storedMessages) || storedMessages.length !== sizes.length) return null;

  const endOffset = Math.min(
    sizes.length,
    beforeIndex - summary.recentStartIndex,
  );
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

  let messages: Message[];
  try {
    messages = storedMessages
      .slice(startOffset, endOffset)
      .map((message) => messageFromStorageDict(message));
  } catch {
    return null;
  }

  const startIndex = summary.recentStartIndex + startOffset;
  return {
    sessionId,
    chainId,
    messages,
    startIndex,
    totalMessages: summary.messageCount,
    complete: startIndex === 0,
    loadedBytes,
  };
}

function loadHistoryPageFromDb(
  db: SqliteDatabase,
  query: HistoryPageQuery,
): LoadedHistoryPage | null {
  const {
    sessionId,
    chainId,
    beforeIndex,
    maxMessages,
    maxBytes,
    allowOneOversizedMessage,
  } = query;
  let summary = query.summary;
  let rebuildMessageOffsets = false;
  let recentMessagesJson: string | null | undefined;
  if (!summary) {
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
    summary = parseChainViewSummary(metadata.summary_json) ?? undefined;
    if (!summary) {
      rebuildMessageOffsets = true;
      const legacyMessageCount = Math.max(0, db.prepare(`
        SELECT CASE WHEN json_valid(messages_json)
          THEN json_array_length(messages_json) ELSE 0 END AS message_count
        FROM chains WHERE session_id = ? AND id = ?
      `).pluck().get(sessionId, chainId) as number ?? 0);
      summary = {
        messageCount: legacyMessageCount,
        messageBytes: metadata.message_bytes ?? 0,
        usage: null,
        preview: null,
        newestMessageBytes: null,
        recentStartIndex: legacyMessageCount,
        recentMessageSizes: null,
      };
    }
    recentMessagesJson = metadata.recent_messages_json;
  }

  const totalMessages = summary.messageCount;
  const before = Math.min(
    totalMessages,
    Math.max(0, beforeIndex ?? totalMessages),
  );
  if (before === 0 || maxMessages <= 0 || maxBytes <= 0) {
    return {
      sessionId,
      chainId,
      messages: [],
      startIndex: before,
      totalMessages,
      complete: before === 0,
      loadedBytes: 0,
    };
  }

  if (recentMessagesJson === undefined && summary.recentMessageSizes) {
    recentMessagesJson = db.prepare(
      'SELECT recent_messages_json FROM chains WHERE session_id = ? AND id = ?',
    ).pluck().get(sessionId, chainId) as string | null | undefined;
  }
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

  const hasOffsets = !rebuildMessageOffsets && Boolean(db.prepare(
    'SELECT 1 FROM chain_message_offsets WHERE chain_id = ? LIMIT 1',
  ).get(chainId));
  if (!hasOffsets) {
    const source = db.prepare(
      'SELECT messages_json FROM chains WHERE session_id = ? AND id = ?',
    ).get(sessionId, chainId) as { messages_json: string } | undefined;
    if (!source || !ensureChainMessageOffsets(
      db,
      chainId,
      source.messages_json,
      true,
    )) {
      console.error(`[session] could not index canonical history for chain ${chainId}`);
      return {
        sessionId,
        chainId,
        messages: [],
        startIndex: 0,
        totalMessages,
        complete: true,
        loadedBytes: 0,
      };
    }
  }

  const rows = db.prepare(`
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
  ) as Array<{ message_index: number; message_json: string; message_bytes: number }>;

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

  return {
    sessionId,
    chainId,
    messages,
    startIndex,
    totalMessages,
    complete: startIndex === 0,
    loadedBytes,
  };
}

/**
 * Load a session by ID (null if absent/invalid).
 *
 * A process restart makes every persisted active chain terminal. Recovery is
 * durable: affected chains, their shared recovery timestamp, and a matching
 * session active-chain pointer are updated in one transaction before the
 * session is materialized.
 */
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
      let row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
      if (!row) return null;

      let chainRows = selectChainRows(db, sessionId, loadFullSession);
      const activeChainIds = chainRows
        .filter((chain) => parseChainStatus(chain.status) === ChainStatus.ACTIVE)
        .map((chain) => chain.id);

      if (recoverActiveChains && activeChainIds.length > 0) {
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
        chainRows = selectChainRows(db, sessionId, loadFullSession);
      }

      const chains: Chain[] = [];
      if (loadFullSession) {
        for (const cr of chainRows) {
          try {
            chains.push(chainFromRow(cr));
          } catch (err) {
            console.error(`[session] skipping corrupt chain ${cr.id} on load (session ${sessionId})`, err);
          }
        }
      } else {
        let remainingMessages = Math.max(0, sessionViewMessageBudget);
        let remainingBytes = Math.max(0, sessionViewByteBudget);
        const backfillSummary = db.prepare(
          `UPDATE chains
           SET summary_json = ?, recent_messages_json = ?
           WHERE session_id = ? AND id = ?`,
        );
        const selectLegacyMessages = db.prepare(
          'SELECT messages_json FROM chains WHERE session_id = ? AND id = ?',
        );
        const pagedChains = new Array<Chain>(chainRows.length);
        for (let index = chainRows.length - 1; index >= 0; index -= 1) {
          const cr = chainRows[index]!;
          const persistedSummary = parseChainViewSummary(cr.summary_json);
          let summary = persistedSummary ?? resolveChainViewSummary(cr);
          if (!persistedSummary) {
            const row = selectLegacyMessages.get(sessionId, cr.id) as {
              messages_json: string;
            } | undefined;
            const legacyMessages = row
              ? tryDeserializeMessages(row.messages_json, false)
              : null;
            if (legacyMessages) {
              const serialized = serializeChainMessages(legacyMessages);
              const serializedSummary = parseChainViewSummary(serialized.summaryJson);
              if (serializedSummary) {
                summary = serializedSummary;
                backfillSummary.run(
                  serialized.summaryJson,
                  serialized.recentMessagesJson,
                  sessionId,
                  cr.id,
                );
              }
            }
          }
          let page: LoadedHistoryPage | null = null;
          if (remainingMessages > 0 && remainingBytes > 0 && summary.messageCount > 0) {
            const newestMessageBytes = summary.newestMessageBytes;
            if (newestMessageBytes == null || newestMessageBytes <= remainingBytes) {
              page = loadHistoryPageFromDb(db, {
                sessionId,
                chainId: cr.id,
                beforeIndex: summary.messageCount,
                maxMessages: remainingMessages,
                maxBytes: remainingBytes,
                allowOneOversizedMessage: false,
                summary,
              });
            }
          }
          const messages = page?.messages ?? [];
          const startIndex = page?.startIndex ?? summary.messageCount;
          remainingMessages = Math.max(0, remainingMessages - messages.length);
          remainingBytes = Math.max(0, remainingBytes - (page?.loadedBytes ?? 0));
          try {
            pagedChains[index] = chainFromRow(cr, { messages, startIndex, summary });
          } catch (err) {
            console.error(`[session] skipping corrupt chain ${cr.id} on view load (session ${sessionId})`, err);
          }
        }
        chains.push(...pagedChains.filter((chain): chain is Chain => chain != null));
      }

      const subagentChains: SubagentRecord[] = [];
      if (loadFullSession) {
        const subagentRows = db
          .prepare(
            'SELECT subagent_id, record_json, summary_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
          )
          .all(sessionId) as SubagentChainRow[];
        for (const sr of subagentRows) {
          try {
            subagentChains.push(subagentRecordFromStorageDict(JSON.parse(sr.record_json)));
          } catch (err) {
            console.error(
              `[session] skipping corrupt subagent record ${sr.subagent_id} on load (session ${sessionId})`,
              err,
            );
          }
        }
      }

      return sessionFromRow(row, chains, subagentChains);
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
    const rows: Array<{ subagent_id: string; record_json: string }> = [];
    if (uniqueIds == null) {
      rows.push(...db.prepare(
        'SELECT subagent_id, record_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
      ).all(sessionId) as Array<{ subagent_id: string; record_json: string }>);
    } else {
      for (let offset = 0; offset < uniqueIds.length; offset += 900) {
        const chunk = uniqueIds.slice(offset, offset + 900);
        const placeholders = chunk.map(() => '?').join(', ');
        rows.push(...db.prepare(
          `SELECT subagent_id, record_json FROM subagent_chains
           WHERE session_id = ? AND subagent_id IN (${placeholders}) ORDER BY rowid`,
        ).all(sessionId, ...chunk) as Array<{ subagent_id: string; record_json: string }>);
      }
    }

    const records: SubagentRecord[] = [];
    for (const row of rows) {
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
// upsertSubagentRecords — targeted dirty-record write
// ---------------------------------------------------------------------------

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
      return { bytes };
    });
    return txn();
  });
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

/** Delete a session (chains and subagent rows cascade) plus its file caches; true if it existed. */
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
