/**
 * U12: Selective manifest builder and op schema
 *
 * Requirements R8,R9. Dependencies U3 (cut-point).
 *
 * Produce ID→kind→preview manifest and op list.
 * Assign stable ids (message ids, ToolCall.id) and emit compact manifest
 * (id + kind + one-line preview, not content) to keep agent input small.
 * Define op grammar: keep(id), keep_range(id, startLine, endLine), summarize([ids], text).
 */

import type { Message } from '../../../../shared/types/message';
import { MessageType, MessageRole } from '../../../../shared/types/message';
import type { ToolCall } from '../../../../shared/types/tool';

// ── Manifest types ──────────────────────────────────────────────────────────

export const PREVIEW_MAX_LENGTH = 120;

export interface CompactableRange {
  readonly start: number;
  readonly end: number;
}

export type ManifestKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'error';

export interface ManifestEntry {
  readonly id: string;
  readonly kind: ManifestKind;
  readonly preview: string;
  /** Position in manifest order (0..n-1) */
  readonly index: number;
  /** Original index in full messages array */
  readonly originalIndex: number;
  readonly role: MessageRole;
  readonly type: MessageType;
  /** For tool calls: the call ids inside this message */
  readonly toolCallIds?: readonly string[];
}

export interface Manifest {
  readonly entries: readonly ManifestEntry[];
  readonly byId: ReadonlyMap<string, ManifestEntry>;
  readonly compactableRange: CompactableRange;
}

// ── Selective op grammar ────────────────────────────────────────────────────

export interface KeepOp {
  readonly type: 'keep';
  readonly id: string;
}

export interface KeepRangeOp {
  readonly type: 'keep_range';
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SummarizeOp {
  readonly type: 'summarize';
  readonly ids: readonly string[];
  readonly text: string;
}

export type SelectiveOp = KeepOp | KeepRangeOp | SummarizeOp;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toManifestKind(msg: Message): ManifestKind {
  if (msg.type === MessageType.THINKING) return 'thinking';
  if (msg.type === MessageType.ERROR) return 'error';
  if (msg.role === MessageRole.USER) return 'user';
  if (msg.role === MessageRole.TOOL) return 'tool_result';
  if (msg.type === MessageType.TOOL_CALL) return 'tool_call';
  if (msg.role === MessageRole.ASSISTANT) return 'assistant';
  if (msg.role === MessageRole.SYSTEM) return 'system';
  return 'assistant';
}

function previewFromMessage(msg: Message): string {
  let raw = '';
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const calls = (msg.tool_calls as readonly ToolCall[])
      .map((tc) => `${tc.function.name}(${truncateArgs(tc.function.arguments)}) [id=${tc.id}]`)
      .join(', ');
    raw = msg.content ? `${msg.content} | ${calls}` : calls;
  } else if (msg.type === MessageType.THINKING) {
    raw = msg.thinking ?? msg.content ?? '';
  } else if (msg.role === MessageRole.TOOL) {
    // tool result: include tool name + content preview
    raw = msg.name ? `${msg.name}: ${msg.content}` : msg.content;
  } else {
    raw = msg.content ?? '';
  }
  return boundedPreview(raw, PREVIEW_MAX_LENGTH);
}

function truncateArgs(args: string): string {
  const collapsed = args.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 60) return collapsed;
  return collapsed.slice(0, 57) + '...';
}

export function boundedPreview(text: string, maxLen: number = PREVIEW_MAX_LENGTH): string {
  if (!text) return '';
  const oneLine = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}

// ── Manifest builder ────────────────────────────────────────────────────────

export function buildManifest(
  messages: readonly Message[],
  compactableRange: CompactableRange,
): Manifest {
  const n = messages.length;
  const start = Math.max(0, Math.min(compactableRange.start, n));
  const end = Math.max(start, Math.min(compactableRange.end, n));
  const entries: ManifestEntry[] = [];
  const byId = new Map<string, ManifestEntry>();
  let idx = 0;
  for (let i = start; i < end; i += 1) {
    const msg = messages[i]!;
    const kind = toManifestKind(msg);
    const preview = previewFromMessage(msg);
    const entry: ManifestEntry = {
      id: msg.id,
      kind,
      preview,
      index: idx,
      originalIndex: i,
      role: msg.role as MessageRole,
      type: msg.type as MessageType,
      ...(msg.tool_calls && msg.tool_calls.length > 0
        ? { toolCallIds: (msg.tool_calls as readonly ToolCall[]).map((tc) => tc.id) }
        : {}),
    };
    entries.push(entry);
    byId.set(entry.id, entry);
    idx += 1;
  }
  return {
    entries,
    byId,
    compactableRange: { start, end },
  };
}

// ── Tool-call mapping helpers ───────────────────────────────────────────────

/**
 * Build a map from ToolCall.id → manifest entry id (the assistant message that owns it).
 * Also returns a map from tool_call_id (result's tool_call_id) → call message id for convenience.
 */
export function buildToolCallIdToEntryMap(
  messages: readonly Message[],
  manifest: Manifest,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.toolCallIds) {
      for (const tcId of entry.toolCallIds) {
        map.set(tcId, entry.id);
      }
    }
  }
  // Also consider messages outside manifest? For completeness include all messages mapping
  // but manifest entries are primary.
  return map;
}

export function buildToolCallIdToCallMessageMap(
  messages: readonly Message[],
): ReadonlyMap<string, { callMessageId: string; toolCall: ToolCall }> {
  const map = new Map<string, { callMessageId: string; toolCall: ToolCall }>();
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls as readonly ToolCall[]) {
        if (tc.id) map.set(tc.id, { callMessageId: msg.id, toolCall: tc });
      }
    }
  }
  return map;
}

export function buildToolResultIdToMessageMap(
  messages: readonly Message[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === MessageRole.TOOL && msg.tool_call_id) {
      // Keep first occurrence; duplicate results are handled elsewhere
      if (!map.has(msg.tool_call_id)) map.set(msg.tool_call_id, msg.id);
    }
  }
  return map;
}

// ── Op serialization helpers ────────────────────────────────────────────────

export function selectiveOpsToJson(ops: readonly SelectiveOp[]): string {
  return JSON.stringify(ops.map((op) => opToJson(op)), null, 2);
}

function opToJson(op: SelectiveOp): unknown {
  if (op.type === 'keep') return { type: 'keep', id: op.id };
  if (op.type === 'keep_range')
    return { type: 'keep_range', id: op.id, startLine: op.startLine, endLine: op.endLine };
  return { type: 'summarize', ids: [...op.ids], text: op.text };
}

export function parseSelectiveOps(json: string): SelectiveOp[] {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('ops JSON must be array');
  return parsed.map((raw) => parseOneOp(raw));
}

function parseOneOp(raw: unknown): SelectiveOp {
  if (typeof raw !== 'object' || raw === null) throw new Error('op must be object');
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (type === 'keep') {
    if (typeof r.id !== 'string' || !r.id) throw new Error('keep requires id');
    return { type: 'keep', id: r.id };
  }
  if (type === 'keep_range') {
    if (typeof r.id !== 'string' || !r.id) throw new Error('keep_range requires id');
    if (typeof r.startLine !== 'number' || typeof r.endLine !== 'number')
      throw new Error('keep_range requires startLine/endLine');
    return { type: 'keep_range', id: r.id, startLine: Math.floor(r.startLine), endLine: Math.floor(r.endLine) };
  }
  if (type === 'summarize') {
    if (!Array.isArray(r.ids)) throw new Error('summarize requires ids array');
    if (typeof r.text !== 'string') throw new Error('summarize requires text');
    const ids = (r.ids as unknown[]).map((v) => {
      if (typeof v !== 'string' || !v) throw new Error('summarize id must be non-empty string');
      return v;
    });
    return { type: 'summarize', ids, text: r.text };
  }
  throw new Error(`unknown op type ${String(type)}`);
}

// Re-export for convenience in tests
export { toManifestKind, previewFromMessage };
