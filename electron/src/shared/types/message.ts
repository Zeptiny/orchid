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
import type { ToolCall } from './tool';
import { toolCallToStorageDict, toolCallFromStorageDict } from './tool';
import {
  canonicalToolResultSchema,
  type CanonicalToolResult,
} from './tool-result';

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
});

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
  readonly timestamp: string;
  readonly usage: Usage | null;
  readonly hidden: boolean;
  /** Canonical terminal facts for TOOL_RESULT messages; null on legacy records. */
  readonly tool_result: CanonicalToolResult | null;
  /**
   * Explicit tool failure flag (TOOL_RESULT). Set by the backend when the tool
   * execution failed; frontend must render from this field only — never infer
   * failure from content text.
   */
  readonly is_error: boolean;
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
  timestamp?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    context?: ContextSnapshot;
  };
  hidden?: boolean;
  /** Explicit tool failure; only meaningful for tool_result messages. */
  is_error?: boolean;
  /** Canonical terminal facts; absent historical records restore as null. */
  tool_result?: unknown;
  // Forward-compat: extra keys tolerated on restore
  [key: string]: unknown;
}

// ── API format (OpenAI-shaped) ──────────────────────────────────────────────

export interface ApiMessage {
  role: string;
  content: string | Array<{ type: string; text: string }> | null;
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
  if (msg.timestamp) {
    d.timestamp = msg.timestamp;
  }
  if (msg.usage) {
    d.usage = {
      prompt_tokens: msg.usage.prompt_tokens,
      completion_tokens: msg.usage.completion_tokens,
      total_tokens: msg.usage.total_tokens,
      cached_tokens: msg.usage.cached_tokens,
      ...(msg.usage.context ? { context: msg.usage.context } : {}),
    };
  }
  if (msg.hidden) {
    d.hidden = true;
  }
  if (msg.tool_result) {
    d.tool_result = msg.tool_result;
  } else if (msg.is_error) {
    // Preserve unsupported legacy records without treating this flag as a
    // second authority for messages that carry canonical terminal facts.
    d.is_error = true;
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

  return {
    id,
    role,
    content: typeof raw.content === 'string' ? raw.content : '',
    type,
    tool_calls: toolCalls,
    tool_call_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    thinking: typeof raw.thinking === 'string' ? raw.thinking : null,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    usage,
    hidden: raw.hidden === true,
    tool_result: toolResult,
    is_error: toolResult ? toolResult.status === 'error' : raw.is_error === true,
  };
}
