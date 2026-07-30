/**
 * Tool types for the Orchid domain.
 *
 * - ToolCall: assistant message's tool_calls entries
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

// ── Storage dict shapes ─────────────────────────────────────────────────────

export interface ToolCallStorageDict {
  id: string;
  type: string;
  function: { name: string; arguments: string };
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
