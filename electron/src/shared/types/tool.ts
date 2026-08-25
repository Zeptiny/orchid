/**
 * Tool types for the Orchid domain.
 *
 * - ToolCall: assistant message's tool_calls entries
 * - RENDERER_ALLOWED_TOOLS: the direct-invoke allow-list shared by the
 *   Electron tool IPC and the host protocol's tool.execute binding
 */

import { z } from 'zod';

// ── Renderer direct-invoke allow-list ───────────────────────────────────────

/**
 * Tools that the renderer may invoke directly via tool:execute (IPC channel
 * and host protocol method alike). Only read-only, non-destructive tools are
 * permitted.
 */
export const RENDERER_ALLOWED_TOOLS = new Set([
  'read',
  'read_directory',
  'glob',
  'grep',
  'todo_list',
  'rag_search',
]);

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
