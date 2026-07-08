/**
 * Tool types for the Orchid domain.
 *
 * Mirrors the OpenAI function-calling shape used by the Python TUI:
 * - ToolCall: assistant message's tool_calls entries
 * - ToolResult: tool-role message payload
 */

import { z } from 'zod';

// ── ToolCall ────────────────────────────────────────────────────────────────

export interface ToolCallFunction {
  readonly name: string;
  readonly arguments: string;
}

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: ToolCallFunction;
}

export const toolCallFunctionSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: toolCallFunctionSchema,
});

// ── ToolResult ──────────────────────────────────────────────────────────────

export interface ToolResult {
  readonly tool_call_id: string;
  readonly content: string;
  readonly is_error: boolean;
}

export const toolResultSchema = z.object({
  tool_call_id: z.string(),
  content: z.string(),
  is_error: z.boolean().default(false),
});

// ── Storage dict shapes ─────────────────────────────────────────────────────

export interface ToolCallStorageDict {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ToolResultStorageDict {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

// ── Serialization helpers ───────────────────────────────────────────────────

export function toolCallToStorageDict(tc: ToolCall): ToolCallStorageDict {
  return {
    id: tc.id,
    type: tc.type,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  };
}

export function toolCallFromStorageDict(data: unknown): ToolCall {
  const parsed = toolCallSchema.parse(data);
  return {
    id: parsed.id,
    type: 'function',
    function: { name: parsed.function.name, arguments: parsed.function.arguments },
  };
}

export function toolResultToStorageDict(tr: ToolResult): ToolResultStorageDict {
  return {
    tool_call_id: tr.tool_call_id,
    content: tr.content,
    is_error: tr.is_error,
  };
}

export function toolResultFromStorageDict(data: unknown): ToolResult {
  const parsed = toolResultSchema.parse(data);
  return {
    tool_call_id: parsed.tool_call_id,
    content: parsed.content,
    is_error: parsed.is_error,
  };
}
