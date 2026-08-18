/**
 * Message types for the Orchid domain.
 *
 * Ported from src/orchid/domain/message.py.
 * Messages are the atomic unit of conversation history.
 *
 * Differences from Python:
 * - Timestamps are ISO strings (not monotonic floats) — TS app's own format v1.
 * - tool_calls uses typed ToolCall[] (not raw dicts).
 * - toApiFormat() produces OpenAI-shaped messages for LLM API calls.
 */

import { z } from 'zod';
import type { JSONValue } from 'ai';
import type { ToolCall } from './tool';
import { toolCallToStorageDict, toolCallFromStorageDict } from './tool';
import {
  canonicalToolResultSchema,
  type CanonicalToolResult,
} from './tool-result';

// ── Thinking replay payload ─────────────────────────────────────────────────

export const ThinkingArtifactKind = {
  SIGNED: 'signed',
  REDACTED: 'redacted',
  ENCRYPTED: 'encrypted',
  OPAQUE: 'opaque',
  TEXT: 'text',
} as const;

export type ThinkingArtifactKind =
  (typeof ThinkingArtifactKind)[keyof typeof ThinkingArtifactKind];

const thinkingArtifactKinds = new Set<string>(Object.values(ThinkingArtifactKind));

// Replay artifacts persist provider blobs and replay them into later
// requests; every boundary caps these fields so a hostile/corrupt payload
// cannot grow the chain DB or inflate request bodies without limit.
export const THINKING_BLOB_MAX_LENGTH = 64 * 1024;
export const THINKING_DISPLAY_TEXT_MAX_LENGTH = 64 * 1024;
export const THINKING_ITEM_ID_MAX_LENGTH = 256;

/** Bound one provider blob (signature, redacted data, encrypted content). */
export function capThinkingBlob(value: string): string {
  return value.length > THINKING_BLOB_MAX_LENGTH
    ? value.slice(0, THINKING_BLOB_MAX_LENGTH)
    : value;
}

/** Bound accumulated reasoning text persisted as displayText. */
export function capThinkingDisplayText(value: string): string {
  return value.length > THINKING_DISPLAY_TEXT_MAX_LENGTH
    ? value.slice(0, THINKING_DISPLAY_TEXT_MAX_LENGTH)
    : value;
}

/**
 * Provider-specific replay artifact captured from one thinking segment (R16).
 * `blob` carries the provider value (Anthropic signature, redacted data,
 * Responses encrypted content); `displayText` is present only when the
 * provider exposes readable thinking or summaries.
 */
export interface ThinkingReplayPayload {
  readonly providerId: string;
  readonly modelId: string;
  readonly kind: ThinkingArtifactKind;
  readonly blob: string | null;
  readonly displayText: string | null;
  /** Responses reasoning item id when the provider identifies items. */
  readonly itemId?: string;
  /** Reported reasoning tokens, for opaque render metadata (R17). */
  readonly reasoningTokenCount?: number;
}

/** Tolerant parse: unknown shapes degrade to no payload, extra keys pass through; oversized blobs/display text truncate and oversized item ids drop. */
export function thinkingReplayPayloadFromUnknown(
  value: unknown,
): ThinkingReplayPayload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.providerId !== 'string' || raw.providerId.length === 0 ||
    typeof raw.modelId !== 'string' || raw.modelId.length === 0 ||
    typeof raw.kind !== 'string' || !thinkingArtifactKinds.has(raw.kind)
  ) {
    return undefined;
  }
  return {
    providerId: raw.providerId,
    modelId: raw.modelId,
    kind: raw.kind as ThinkingArtifactKind,
    blob: typeof raw.blob === 'string' ? capThinkingBlob(raw.blob) : null,
    displayText: typeof raw.displayText === 'string' ? capThinkingDisplayText(raw.displayText) : null,
    ...(typeof raw.itemId === 'string'
      && raw.itemId.length > 0
      && raw.itemId.length <= THINKING_ITEM_ID_MAX_LENGTH
      ? { itemId: raw.itemId }
      : {}),
    ...(typeof raw.reasoningTokenCount === 'number' && raw.reasoningTokenCount >= 0
      ? { reasoningTokenCount: raw.reasoningTokenCount }
      : {}),
  };
}

// ── Enums as const objects ──────────────────────────────────────────────────

export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
} as const;

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const MessageType = {
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  ERROR: 'error',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// ── Usage ───────────────────────────────────────────────────────────────────

export interface Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cached_tokens: number;
  readonly reasoning_tokens?: number;
  /** Latest-step projected context after including the current output. */
  readonly context?: ContextSnapshot;
}

export interface ContextSnapshot {
  /** Provider-reported aggregate counts; category counts below are estimates. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly used_tokens: number;
  readonly system_tokens: number;
  readonly tools_tokens: number;
  readonly tool_use_tokens: number;
  readonly user_tokens: number;
  readonly assistant_tokens: number;
  /** Compaction summary category (R19). Zero when no summary head is in the replay. */
  readonly summary_tokens?: number;
  /** Provider-reported reasoning tokens included in `assistant_tokens`. */
  readonly reasoning_tokens?: number;
}

export const contextSnapshotSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  used_tokens: z.number().nonnegative(),
  system_tokens: z.number().nonnegative(),
  tools_tokens: z.number().nonnegative(),
  tool_use_tokens: z.number().nonnegative(),
  user_tokens: z.number().nonnegative(),
  assistant_tokens: z.number().nonnegative(),
  summary_tokens: z.number().nonnegative().optional(),
  reasoning_tokens: z.number().nonnegative().optional(),
});

// ── Compaction marker (R23) ─────────────────────────────────────────────────

export const COMPACTION_MODES = ['simple', 'selective'] as const;

export type CompactionMode = (typeof COMPACTION_MODES)[number];

/**
 * Marker attached to the summary head message produced by compaction.
 * Records the covered range and mode so later compactions and the renderer
 * can distinguish it from real content. Persists via MessageStorageDict
 * under the `compacted` key (same snake_case would be `compacted`).
 */
export interface CompactedMarker {
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly mode: CompactionMode;
  /** Number of original messages summarized, if known. */
  readonly summarizedCount?: number;
}

function isCompactionMode(value: unknown): value is CompactionMode {
  return (COMPACTION_MODES as readonly string[]).includes(value as string);
}

/** Tolerant parse: unknown shapes degrade to undefined; extra keys ignored. */
export function compactedMarkerFromUnknown(value: unknown): CompactedMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.rangeStart !== 'string' || raw.rangeStart.length === 0 ||
    typeof raw.rangeEnd !== 'string' || raw.rangeEnd.length === 0 ||
    !isCompactionMode(raw.mode)
  ) {
    return undefined;
  }
  const marker: CompactedMarker = {
    rangeStart: raw.rangeStart,
    rangeEnd: raw.rangeEnd,
    mode: raw.mode,
  };
  if (
    typeof raw.summarizedCount === 'number' &&
    Number.isFinite(raw.summarizedCount) &&
    raw.summarizedCount >= 0
  ) {
    return { ...marker, summarizedCount: Math.floor(raw.summarizedCount) };
  }
  return marker;
}

// ── Message ─────────────────────────────────────────────────────────────────

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly type: MessageType;
  readonly tool_calls: readonly ToolCall[] | null;
  readonly tool_call_id: string | null;
  readonly name: string | null;
  readonly thinking: string | null;
  /** Replay artifact for THINKING messages; absent for plain-text reasoning. */
  readonly thinking_payload?: ThinkingReplayPayload;
  readonly timestamp: string;
  readonly usage: Usage | null;
  readonly hidden: boolean;
  /** Persisted display message that must not be replayed to the model. */
  readonly excludeFromModel?: boolean;
  /** Compaction summary head marker (R23); absent for real content. */
  readonly compacted?: CompactedMarker;
  /** Canonical terminal facts for TOOL_RESULT messages; null for other messages. */
  readonly tool_result: CanonicalToolResult | null;
}

// ── Storage dict ────────────────────────────────────────────────────────────

export interface MessageStorageDict {
  role: string;
  content: string;
  type?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  thinking?: string;
  thinking_payload?: ThinkingReplayPayload;
  timestamp?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
    context?: ContextSnapshot;
  };
  hidden?: boolean;
  /** Keep the message visible in history while excluding it from model context. */
  exclude_from_model?: boolean;
  /** Compaction marker; same key as the domain field (no snake_case transform). */
  compacted?: CompactedMarker;
  /** Explicit tool failure; only meaningful for tool_result messages. */
  is_error?: boolean;
  /** Canonical terminal facts for TOOL_RESULT records. */
  tool_result?: unknown;
  // Forward-compat: extra keys tolerated on restore
  [key: string]: unknown;
}

// ── API format (OpenAI-shaped) ──────────────────────────────────────────────

/**
 * Provider-specific options attached to one replayed content part. Values are
 * produced only by trusted main-process code (thinking replay artifacts), so
 * the shape stays an open record rather than a zod-validated boundary type.
 */
export type ApiContentPartOptions = Record<string, Record<string, JSONValue>>;

export interface ApiMessage {
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text: string;
        providerOptions?: ApiContentPartOptions;
      }>
    | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ── Serialization ───────────────────────────────────────────────────────────

export function messageToApiFormat(msg: Message): ApiMessage {
  // OpenAI convention: assistant messages carrying only tool_calls should
  // use content: null rather than empty string.
  const content =
    msg.role === MessageRole.ASSISTANT && msg.tool_calls
      ? msg.content || null
      : msg.content;

  const api: ApiMessage = { role: msg.role, content };

  if (msg.tool_call_id) {
    api.tool_call_id = msg.tool_call_id;
  }
  if (msg.tool_calls) {
    api.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  return api;
}

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function messageToStorageDict(msg: Message): MessageStorageDict {
  const d: MessageStorageDict = {
    role: msg.role,
    content: msg.content,
    type: msg.type,
  };
  // Persist ids so reloads keep stable React keys across session switches.
  if (msg.id) {
    d.id = msg.id;
  }
  if (msg.tool_calls) {
    d.tool_calls = msg.tool_calls.map(toolCallToStorageDict);
  }
  if (msg.tool_call_id) {
    d.tool_call_id = msg.tool_call_id;
  }
  if (msg.name) {
    d.name = msg.name;
  }
  if (msg.thinking) {
    d.thinking = msg.thinking;
  }
  if (msg.thinking_payload) {
    d.thinking_payload = msg.thinking_payload;
  }
  if (msg.timestamp) {
    d.timestamp = msg.timestamp;
  }
  if (msg.usage) {
    d.usage = {
      prompt_tokens: msg.usage.prompt_tokens,
      completion_tokens: msg.usage.completion_tokens,
      total_tokens: msg.usage.total_tokens,
      cached_tokens: msg.usage.cached_tokens,
      ...(msg.usage.reasoning_tokens ? { reasoning_tokens: msg.usage.reasoning_tokens } : {}),
      ...(msg.usage.context ? { context: msg.usage.context } : {}),
    };
  }
  if (msg.hidden) {
    d.hidden = true;
  }
  if (msg.excludeFromModel) {
    d.exclude_from_model = true;
  }
  if (msg.compacted) {
    d.compacted = msg.compacted;
  }
  if (msg.tool_result?.status === 'error') {
    d.is_error = true;
  }
  if (msg.tool_result) {
    d.tool_result = msg.tool_result;
  }
  return d;
}

export function messageFromStorageDict(data: unknown): Message {
  const raw = data as Record<string, unknown>;

  // Parse role with fallback
  let role: MessageRole = MessageRole.SYSTEM;
  const rawRole = raw.role;
  if (
    typeof rawRole === 'string' &&
    (rawRole === 'user' || rawRole === 'assistant' ||
      rawRole === 'system' || rawRole === 'tool')
  ) {
    role = rawRole;
  }

  // Parse type with fallback
  let type: MessageType = MessageType.TEXT;
  const rawType = raw.type;
  if (
    typeof rawType === 'string' &&
    (rawType === 'text' || rawType === 'thinking' ||
      rawType === 'tool_call' || rawType === 'tool_result' ||
      rawType === 'error')
  ) {
    type = rawType;
  }

  // Parse usage with forward-compat (extra keys tolerated, missing keys defaulted)
  let usage: Usage | null = null;
  if (raw.usage != null && typeof raw.usage === 'object') {
    const u = raw.usage as Record<string, unknown>;
    const parsedContext = contextSnapshotSchema.safeParse(u.context);
    usage = {
      prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
      completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
      cached_tokens: typeof u.cached_tokens === 'number' ? u.cached_tokens : 0,
      ...(typeof u.reasoning_tokens === 'number' ? { reasoning_tokens: u.reasoning_tokens } : {}),
      context: parsedContext.success ? parsedContext.data : undefined,
    };
  }

  // Parse tool_calls
  let toolCalls: ToolCall[] | null = null;
  if (Array.isArray(raw.tool_calls)) {
    toolCalls = raw.tool_calls.map((tc) => toolCallFromStorageDict(tc));
  }

  // Empty/missing ids cause React key collisions when switching sessions
  // (every loaded message becomes ""), so always assign a real id.
  const id =
    typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newMessageId();
  const parsedToolResult = canonicalToolResultSchema.safeParse(raw.tool_result);
  const toolResult = parsedToolResult.success
    ? parsedToolResult.data as CanonicalToolResult
    : null;
  const thinkingPayload = thinkingReplayPayloadFromUnknown(raw.thinking_payload);
  const compacted = compactedMarkerFromUnknown(raw.compacted);

  return {
    id,
    role,
    content: typeof raw.content === 'string' ? raw.content : '',
    type,
    tool_calls: toolCalls,
    tool_call_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    thinking: typeof raw.thinking === 'string' ? raw.thinking : null,
    ...(thinkingPayload ? { thinking_payload: thinkingPayload } : {}),
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    usage,
    hidden: raw.hidden === true,
    excludeFromModel: raw.exclude_from_model === true,
    ...(compacted ? { compacted } : {}),
    tool_result: toolResult,
  };
}
