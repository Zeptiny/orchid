/**
 * Session storage parsing — pure row/JSON (de)serialization helpers shared by
 * the chain, session, history, and compaction storage modules.
 */
import type { Session } from '../../shared/types/session';
import type { Chain } from '../../shared/types/chain';
import { parseChainStatus, reconcileOrphanToolResults } from '../../shared/types/chain';
import type { SqliteDatabase } from '../utils/sqlite';
import {
  contextSnapshotSchema,
  MessageRole,
  MessageType,
  type Message,
  type Usage,
  messageToStorageDict,
  messageFromStorageDict,
} from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import {
  copyModelSelection,
  modelSelectionSchema,
} from '../../shared/types/provider';
import {
  SubagentStatus,
  summarizeSubagentRecord,
  type SubagentRecord,
  type SubagentSummary,
} from '../../shared/types/subagent';
import { ipcSubagentSummarySchema } from '../../shared/types/ipc-schemas';
import type { TodoStoreData } from '../../shared/types/todo';
import {
  todoStoreToStorageDict,
  todoStoreFromStorageDict,
} from '../../shared/types/todo';
import { PERMISSION_MODE_VALUES, type PermissionMode } from '../../shared/types/permission';
import {
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from '../../shared/serialization/chain-subagent';
import { sumMessageUsages } from '../../shared/usage';
import {
  DEFAULT_SESSION_VIEW_BYTE_BUDGET,
  DEFAULT_SESSION_VIEW_MESSAGE_BUDGET,
} from './storage-db';

export interface SessionRow {
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

export interface ChainRow {
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

export interface ChainViewSummary {
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

export interface SubagentChainRow {
  subagent_id: string;
  record_json: string;
  summary_json: string | null;
}

export function serializeSelection(selection: ModelSelection | null): string | null {
  if (!selection) return null;
  return JSON.stringify(copyModelSelection(selection));
}

export function deserializeSelection(json: string | null): ModelSelection | null {
  if (!json) return null;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function tryDeserializeMessages(
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

export function deserializeMessages(json: string): Message[] {
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

export function chainPreview(messages: readonly Message[]): string | null {
  const user = messages.find(
    (message) => message.role === MessageRole.USER && message.type === MessageType.TEXT,
  );
  if (!user?.content) return null;
  const text = user.content.trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export interface SerializedChainMessages {
  readonly messagesJson: string;
  readonly summaryJson: string;
  readonly recentMessagesJson: string;
  readonly messageOffsets: readonly MessageByteOffset[];
}

export interface MessageByteOffset {
  readonly messageIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function recentMessageWindow(serializedMessages: readonly string[]): {
  readonly recentStartIndex: number;
  readonly recentMessageSizes: number[];
} {
  const recentMessageSizes: number[] = [];
  let recentBytes = 0;
  let recentStartIndex = serializedMessages.length;

  for (let index = serializedMessages.length - 1; index >= 0; index -= 1) {
    if (recentMessageSizes.length >= DEFAULT_SESSION_VIEW_MESSAGE_BUDGET) break;
    const messageBytes = Buffer.byteLength(serializedMessages[index]!, 'utf8');
    if (recentBytes + messageBytes > DEFAULT_SESSION_VIEW_BYTE_BUDGET) break;
    recentMessageSizes.unshift(messageBytes);
    recentBytes += messageBytes;
    recentStartIndex = index;
  }
  return { recentStartIndex, recentMessageSizes };
}

export function serializeChainMessages(messages: readonly Message[]): SerializedChainMessages {
  const serializedMessages = messages.map(messageToStorageDict).map((message) => JSON.stringify(message));
  const messageOffsets: MessageByteOffset[] = [];
  let byteOffset = 1; // Skip the opening '[' byte.
  for (let index = 0; index < serializedMessages.length; index += 1) {
    const byteLength = Buffer.byteLength(serializedMessages[index]!, 'utf8');
    messageOffsets.push({ messageIndex: index, byteOffset, byteLength });
    byteOffset += byteLength + 1; // Each non-final fragment is followed by ','.
  }
  const messagesJson = `[${serializedMessages.join(',')}]`;
  const { recentStartIndex, recentMessageSizes } = recentMessageWindow(serializedMessages);

  const newestStoredMessage = serializedMessages.at(-1);
  const summary: ChainViewSummary = {
    messageCount: messages.length,
    messageBytes: Buffer.byteLength(messagesJson, 'utf8'),
    usage: sumMessageUsages(messages),
    preview: chainPreview(messages),
    newestMessageBytes: recentMessageSizes.at(-1)
      ?? (newestStoredMessage
        ? Buffer.byteLength(newestStoredMessage, 'utf8')
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

const JSON_ARRAY_OPEN = 0x5b; // '['
const JSON_ARRAY_CLOSE = 0x5d; // ']'
const JSON_OBJECT_OPEN = 0x7b; // '{'
const JSON_OBJECT_CLOSE = 0x7d; // '}'
const JSON_QUOTE = 0x22; // '"'
const JSON_COMMA = 0x2c; // ','
const JSON_ESCAPE = 0x5c; // '\\'

/** Bracket-depth delta per byte; zero for every byte that is not a bracket. */
const JSON_DEPTH_DELTA = new Int8Array(256);
JSON_DEPTH_DELTA[JSON_OBJECT_OPEN] = 1;
JSON_DEPTH_DELTA[JSON_ARRAY_OPEN] = 1;
JSON_DEPTH_DELTA[JSON_OBJECT_CLOSE] = -1;
JSON_DEPTH_DELTA[JSON_ARRAY_CLOSE] = -1;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipJsonWhitespace(bytes: Buffer, cursor: number): number {
  let index = cursor;
  while (index < bytes.length && isJsonWhitespace(bytes[index]!)) index += 1;
  return index;
}

/** Advance past the JSON string opened by the quote at `cursor`. */
function skipJsonString(bytes: Buffer, cursor: number): number {
  let escaped = false;
  for (let index = cursor + 1; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (escaped) {
      escaped = false;
    } else if (byte === JSON_ESCAPE) {
      escaped = true;
    } else if (byte === JSON_QUOTE) {
      return index + 1;
    }
  }
  return bytes.length;
}

interface JsonMemberTerminator {
  readonly index: number;
  readonly byte: number;
}

/**
 * Find the byte that ends the array member opened at `start`: a comma at depth
 * zero, a closing brace at depth zero (malformed), or the array's own closing
 * bracket. Null when no member terminator is reachable.
 */
function findJsonMemberTerminator(
  bytes: Buffer,
  start: number,
): JsonMemberTerminator | null {
  let depth = 0;
  let cursor = start;
  while (cursor < bytes.length) {
    const byte = bytes[cursor]!;
    if (byte === JSON_QUOTE) {
      cursor = skipJsonString(bytes, cursor);
      continue;
    }
    const delta = JSON_DEPTH_DELTA[byte]!;
    if (delta < 0 && depth === 0) return { index: cursor, byte };
    depth += delta;
    if (byte === JSON_COMMA && depth === 0) return { index: cursor, byte };
    cursor += 1;
  }
  return null;
}

interface JsonMemberScan {
  readonly range: Omit<MessageByteOffset, 'messageIndex'>;
  readonly next: number;
  readonly closedArray: boolean;
}

function scanJsonArrayMember(bytes: Buffer, start: number): JsonMemberScan | null {
  const terminator = findJsonMemberTerminator(bytes, start);
  if (!terminator || terminator.byte === JSON_OBJECT_CLOSE) return null;
  let end = terminator.index;
  while (end > start && isJsonWhitespace(bytes[end - 1]!)) end -= 1;
  if (end === start) return null;
  return {
    range: { byteOffset: start, byteLength: end - start },
    next: terminator.index + 1,
    closedArray: terminator.byte === JSON_ARRAY_CLOSE,
  };
}

function finishJsonArrayOffsets(
  bytes: Buffer,
  cursor: number,
  offsets: MessageByteOffset[],
  memberCount: number,
): MessageByteOffset[] | null {
  return skipJsonWhitespace(bytes, cursor) === bytes.length && offsets.length === memberCount
    ? offsets
    : null;
}

function jsonTopLevelArrayLength(messagesJson: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed.length : null;
}

/** Build exact UTF-8 byte ranges for top-level members of a stored JSON array. */
export function messageOffsetsFromJson(messagesJson: string): MessageByteOffset[] | null {
  const memberCount = jsonTopLevelArrayLength(messagesJson);
  if (memberCount === null) return null;

  const bytes = Buffer.from(messagesJson, 'utf8');
  let cursor = skipJsonWhitespace(bytes, 0);
  if (bytes[cursor] !== JSON_ARRAY_OPEN) return null;
  cursor += 1;

  const offsets: MessageByteOffset[] = [];
  while (cursor < bytes.length) {
    cursor = skipJsonWhitespace(bytes, cursor);
    if (bytes[cursor] === JSON_ARRAY_CLOSE) {
      return finishJsonArrayOffsets(bytes, cursor + 1, offsets, memberCount);
    }
    const member = scanJsonArrayMember(bytes, cursor);
    if (!member) return null;
    offsets.push({ ...member.range, messageIndex: offsets.length });
    if (member.closedArray) {
      return finishJsonArrayOffsets(bytes, member.next, offsets, memberCount);
    }
    cursor = member.next;
  }
  return null;
}

export function replaceChainMessageOffsets(
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

export function ensureChainMessageOffsets(
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

const REQUIRED_USAGE_COUNTS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cached_tokens',
] as const;

function isUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasRequiredUsageCounts(raw: Record<string, unknown>): boolean {
  return REQUIRED_USAGE_COUNTS.every((key) => isUsageCount(raw[key]));
}

export function parseUsage(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasRequiredUsageCounts(raw)) return null;
  const context = contextSnapshotSchema.safeParse(raw.context);
  return {
    prompt_tokens: raw.prompt_tokens as number,
    completion_tokens: raw.completion_tokens as number,
    total_tokens: raw.total_tokens as number,
    cached_tokens: raw.cached_tokens as number,
    ...(isUsageCount(raw.reasoning_tokens) ? { reasoning_tokens: raw.reasoning_tokens } : {}),
    ...(context.success ? { context: context.data } : {}),
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

interface ChainSummaryCore {
  readonly messageCount: number;
  readonly messageBytes: number;
  readonly preview: string | null;
}

function parseChainSummaryCore(raw: Record<string, unknown>): ChainSummaryCore | null {
  const messageCount = nonNegativeInteger(raw.messageCount);
  const messageBytes = nonNegativeInteger(raw.messageBytes);
  if (messageCount === null || messageBytes === null) return null;
  if (raw.preview !== null && typeof raw.preview !== 'string') return null;
  return { messageCount, messageBytes, preview: raw.preview as string | null };
}

function parseRecentStartIndex(value: unknown, messageCount: number): number {
  const recentStartIndex = nonNegativeInteger(value);
  return recentStartIndex !== null && recentStartIndex <= messageCount
    ? recentStartIndex
    : messageCount;
}

function parseRecentMessageSizes(value: unknown, expectedLength: number): number[] | null {
  if (!Array.isArray(value) || value.length !== expectedLength) return null;
  return value.every((size) => nonNegativeInteger(size) !== null)
    ? value as number[]
    : null;
}

export function parseChainViewSummary(json: string | null): ChainViewSummary | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  const core = parseChainSummaryCore(raw);
  if (!core) return null;
  const recentStartIndex = parseRecentStartIndex(raw.recentStartIndex, core.messageCount);
  return {
    messageCount: core.messageCount,
    messageBytes: core.messageBytes,
    usage: parseUsage(raw.usage),
    preview: core.preview,
    newestMessageBytes: nonNegativeInteger(raw.newestMessageBytes),
    recentStartIndex,
    recentMessageSizes: parseRecentMessageSizes(
      raw.recentMessageSizes,
      core.messageCount - recentStartIndex,
    ),
  };
}

export function emptyChainSummary(
  messageCount: number,
  messageBytes: number,
): ChainViewSummary {
  return {
    messageCount,
    messageBytes,
    usage: null,
    preview: null,
    newestMessageBytes: null,
    recentStartIndex: messageCount,
    recentMessageSizes: null,
  };
}

export function serializeTodoStore(data: TodoStoreData): string {
  return JSON.stringify(todoStoreToStorageDict(data));
}

export function deserializeTodoStore(json: string): TodoStoreData {
  try {
    return todoStoreFromStorageDict(JSON.parse(json));
  } catch (err) {
    console.error('[session] failed to parse todo store on load; using empty store', err);
    return { tasks: [] };
  }
}

/** Chain row metadata without messages — for updates that supply messages separately. */
export function chainMetadataFromRow(row: ChainRow): Omit<Chain, 'messages'> {
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
  };
}

export function chainFromRow(
  row: ChainRow,
  view?: {
    messages: Message[];
    startIndex: number;
    summary: ChainViewSummary;
  },
): Chain {
  return {
    ...chainMetadataFromRow(row),
    messages: view?.messages ?? deserializeMessages(row.messages_json ?? '[]'),
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

export function serializeReasoningEffortOverride(value: string | number | null): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function deserializeReasoningEffortOverride(json: string | null): string | number | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function serializeTierOverride(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function deserializeTierOverride(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function serializePermissionMode(mode: PermissionMode | null): string | null {
  return mode ?? null;
}

export function deserializePermissionMode(value: string | null): PermissionMode | null {
  if (value == null) return null;
  return (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

export function sessionFromRow(row: SessionRow, chains: Chain[], subagentChains: SubagentRecord[]): Session {
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

export function serializeSubagentRecord(record: SubagentRecord): string {
  return JSON.stringify(subagentRecordToStorageDict(record));
}

export function serializeSubagentSummary(record: SubagentRecord): string {
  return JSON.stringify(summarizeSubagentRecord(record));
}

export function restoreSubagentSummary(value: unknown): SubagentSummary | null {
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

export function deserializeSubagentSummary(json: string): SubagentSummary | null {
  try {
    return restoreSubagentSummary(JSON.parse(json));
  } catch {
    return null;
  }
}
