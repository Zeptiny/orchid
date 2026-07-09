/**
 * Tool dispatch — execute tool calls with timeout and output offloading.
 *
 * Replicates Python `_execute_tool` (client.py:417-475) and
 * `_maybe_offload_tool_output` (client.py:251-307).
 *
 * Features:
 * - 60s timeout (configurable via `command_timeout` config)
 * - Certain tools exempt from timeout (e.g., `wait_for_subagent`, AST tools)
 * - Output offloading: outputs >20KB written to cache files, replaced with
 *   pointer message
 * - Certain tools exempt from offloading (read, grep, glob, etc.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { ToolCall } from '../../shared/types/tool';
import type { ToolRegistry } from '../tools/registry';
import {
  TOOL_OUTPUT_INLINE_THRESHOLD,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './middleware/provider-quirks';

// ---------------------------------------------------------------------------
// Constants — match Python client.py:44, 48-56
// ---------------------------------------------------------------------------

/** Default tool execution timeout in seconds. */
const DEFAULT_TOOL_TIMEOUT_S = 60;

/**
 * Tools exempt from timeout.
 * Matches Python `_TOOLS_WITHOUT_TIMEOUT` (client.py:48-56).
 */
const TOOLS_WITHOUT_TIMEOUT = new Set([
  'wait_for_subagent',
  'get_file_skeleton',
  'get_function',
  'find_symbol_references',
  'replace_symbol',
  'rename_symbol',
  'read_output',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDispatchOptions {
  /** Tool timeout in seconds. Defaults to 60. */
  timeoutSeconds?: number;
  /** Session ID for output offloading cache. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a single tool call and return a TOOL_RESULT message.
 *
 * @param toolCall - The tool call to execute
 * @param registry - The tool registry to look up the handler
 * @param options - Optional timeout and session ID
 * @returns A TOOL_RESULT message with the tool's output
 */
export async function executeToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  options: ToolDispatchOptions = {},
): Promise<Message> {
  const name = toolCall.function.name;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S;

  // Parse arguments
  let args: unknown;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return makeToolResultMessage(
      toolCall.id,
      `Error: Could not parse arguments for tool '${name}': invalid JSON.`,
      true,
    );
  }

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return makeToolResultMessage(
      toolCall.id,
      `Error: Arguments for tool '${name}' must be a JSON object, got ${typeof args}.`,
      true,
    );
  }

  // Look up tool
  const registered = registry.get(name);
  if (!registered) {
    const available = registry.listAll().map((t) => t.definition.name);
    return makeToolResultMessage(
      toolCall.id,
      `Error: tool '${name}' does not exist. Available tools: ${available.join(', ')}`,
      true,
    );
  }

  // Execute with optional timeout (shared policy with MCP wrappers)
  let result: unknown;
  try {
    result = await runWithToolTimeout(
      () => registered.handler(args),
      name,
      {
        timeoutSeconds,
        noTimeout: Boolean(registered.definition.noTimeout),
      },
    );
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      // Prefix Error: so UI / stream classifiers mark the tool as failed.
      return makeToolResultMessage(toolCall.id, `Error: ${err.message}`, true);
    }
    console.error(`Tool '${name}' raised an exception:`, err);
    return makeToolResultMessage(
      toolCall.id,
      `Error: Tool '${name}' failed with an internal error.`,
      true,
    );
  }

  // Coerce result to string
  const content = typeof result === 'string' ? result : JSON.stringify(result);

  // Maybe offload large output
  const trimmed = maybeOffloadToolOutput(name, content, toolCall.id, options.sessionId);

  return makeToolResultMessage(toolCall.id, trimmed, false);
}

// ---------------------------------------------------------------------------
// Output offloading
// ---------------------------------------------------------------------------

/**
 * Bound tool output size before it enters `api_messages`.
 *
 * Outputs at or below `TOOL_OUTPUT_INLINE_THRESHOLD` and tools that
 * already self-limit (`TOOLS_WITHOUT_OUTPUT_OFFLOAD`) pass through
 * unchanged. Larger outputs are written to a per-session cache file
 * and replaced with a compact pointer so the provider context window
 * is not blown out. When no session is active, the content is
 * hard-truncated instead.
 *
 * Matches Python `_maybe_offload_tool_output` (client.py:251-307).
 */
export function maybeOffloadToolOutput(
  toolName: string,
  content: string,
  toolCallId: string,
  sessionId?: string,
): string {
  if (
    content.length <= TOOL_OUTPUT_INLINE_THRESHOLD ||
    TOOLS_WITHOUT_OUTPUT_OFFLOAD.has(toolName)
  ) {
    return content;
  }

  if (!sessionId) {
    // No session — hard-truncate
    const truncated = content.slice(0, TOOL_OUTPUT_INLINE_THRESHOLD);
    return (
      `<${toolName}_result length=${content.length}>\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
      `and was truncated because no active session is available for cache ` +
      `storage. Use the tool again with narrower scope (offset/limit) to ` +
      `inspect the full result.</warning>\n${truncated}\n</${toolName}_result>`
    );
  }

  const cacheDir = getToolOutputCacheDir(sessionId);
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(cacheDir, 0o700);
    } catch {
      // ignore chmod errors
    }

    const slug = toolOutputSlug(toolName, toolCallId);
    const filePath = path.join(cacheDir, slug);
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore chmod errors
    }

    const escapedPath = escapeHtmlAttr(filePath);
    return (
      `<${toolName}_result length=${content.length} file="${escapedPath}">\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters and ` +
      `was written to ${escapedPath}. Use read (with offset/limit) or grep to inspect ` +
      `it.</warning>\n</${toolName}_result>`
    );
  } catch (err) {
    // Cache write failed — truncate inline
    console.warn(`Failed to offload tool output for ${toolName}:`, err);
    const truncated = content.slice(0, TOOL_OUTPUT_INLINE_THRESHOLD);
    return (
      `<${toolName}_result length=${content.length}>\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
      `and cache write failed (${err instanceof Error ? err.message : err}). Truncated below; re-run the tool with ` +
      `narrower scope to inspect the full result.</warning>\n` +
      `${truncated}\n</${toolName}_result>`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Custom timeout error — exported so orchestrator/MCP can reuse detection. */
export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Race a work function against a timeout.
 * Rejects with `ToolTimeoutError` if the timeout fires first.
 * Clears the timer on settle and swallows late rejections from the work
 * promise so a timed-out tool does not surface as an unhandled rejection.
 */
export function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.reject(new ToolTimeoutError(message));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const promise = work();

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ToolTimeoutError(message));
    }, ms);
    // Unref so the timer doesn't keep the process alive in tests/CLI
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  });

  return Promise.race([
    promise.then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        return value;
      },
      (err: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        throw err;
      },
    ),
    timeoutPromise,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    // If we already timed out, ignore a late failure/success from work().
    if (timedOut) {
      promise.then(
        () => undefined,
        () => undefined,
      );
    }
  });
}

/**
 * Run an async tool body under the shared tool timeout policy.
 * Used by registry dispatch and MCP tool wrappers.
 */
export async function runWithToolTimeout<T>(
  work: () => Promise<T>,
  toolName: string,
  options: { timeoutSeconds?: number; noTimeout?: boolean } = {},
): Promise<T> {
  if (options.noTimeout || TOOLS_WITHOUT_TIMEOUT.has(toolName)) {
    return work();
  }
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S;
  return withTimeout(
    work,
    timeoutSeconds * 1000,
    `Tool '${toolName}' timed out after ${timeoutSeconds}s.`,
  );
}

/** Create a TOOL_RESULT message. */
function makeToolResultMessage(
  toolCallId: string,
  content: string,
  _isError: boolean,
): Message {
  return {
    id: crypto.randomUUID(),
    role: MessageRole.TOOL,
    content,
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: toolCallId,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
  };
}

/** Get the tool-output cache directory for a session. */
function getToolOutputCacheDir(sessionId: string): string {
  return path.join(os.homedir(), '.orchid', 'cache', 'tool-output', sessionId);
}

/** Generate a slug for the tool output cache file. */
function toolOutputSlug(toolName: string, toolCallId: string): string {
  // Use first 8 chars of tool_call_id for uniqueness
  const shortId = toolCallId.slice(0, 8);
  return `${toolName}-${shortId}.txt`;
}

/** Escape a string for use as an HTML attribute value. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
