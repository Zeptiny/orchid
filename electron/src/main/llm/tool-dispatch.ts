/**
 * Tool dispatch — execute tool calls with timeout and output offloading.
 *
 * Replicates Python `_execute_tool` (client.py:417-475) and
 * `_maybe_offload_tool_output` (client.py:251-307).
 *
 * Features:
 * - 60s timeout (configurable via `command_timeout` config)
 * - Certain tools exempt from timeout (e.g., AST tools, `read_output`)
 * - `wait_for_subagent` uses a longer dedicated outer timeout (300s)
 * - Output offloading: outputs >20KB written to cache files, replaced with
 *   pointer message
 * - Certain tools exempt from offloading (read, grep, glob, etc.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from '../../shared/types/message';
import type { ToolCall } from '../../shared/types/tool';
import type { ToolRegistry } from '../tools/registry';
import {
  TOOL_OUTPUT_INLINE_THRESHOLD,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './middleware/provider-quirks';
import { makeToolResultMessage } from './message-factories';
import { normalizeToolHandlerResult } from '../tools/result';
import type { ToolExecutionContext } from '../tools/types';
import type { ProjectRuntime } from '../project/runtime';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../agents/manager';

// ---------------------------------------------------------------------------
// Constants — match Python client.py:44, 48-56
// ---------------------------------------------------------------------------

/** Default tool execution timeout in seconds. */
const DEFAULT_TOOL_TIMEOUT_S = 60;

/**
 * Outer dispatch timeout for `wait_for_subagent` (seconds).
 * Slightly longer than the wait tool's internal DEFAULT_WAIT_TIMEOUT_MS so
 * the structured "still running" tool result wins; this is a backstop.
 */
const WAIT_TOOL_OUTER_TIMEOUT_S = Math.ceil(DEFAULT_WAIT_TIMEOUT_MS / 1000) + 5;

/**
 * Tools exempt from timeout.
 * Matches Python `_TOOLS_WITHOUT_TIMEOUT` (client.py:48-56) except
 * `wait_for_subagent`, which must observe an outer timeout (M-P0-011).
 */
const TOOLS_WITHOUT_TIMEOUT = new Set([
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
  /**
   * Outer timeout for `wait_for_subagent` only (seconds).
   * Defaults to DEFAULT_WAIT_TIMEOUT_MS / 1000 (300). Independent of
   * `timeoutSeconds` / command_timeout so waits are not cut short by 30–60s.
   */
  waitTimeoutSeconds?: number;
  /** Session ID for output offloading cache. */
  sessionId?: string;
  /**
   * Absolute workspace cwd frozen for this turn.
   * Required for correct relative-path tool behavior; missing cwd is an error.
   */
  cwd?: string;
  /** Agent scope (`main` or subagent id) for todos / bg command isolation. */
  agentScopeId?: string;
  /** Immutable project definitions captured when this turn began. */
  projectRuntime?: ProjectRuntime;
  /** Parent-turn abort signal (unblocks wait without cancelling children). */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a single tool call and return a TOOL_RESULT message.
 *
 * @param toolCall - The tool call to execute
 * @param registry - The tool registry to look up the handler
 * @param options - Optional timeout, session ID, and frozen turn cwd
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
      name,
      `Could not parse arguments for tool '${name}': invalid JSON.`,
      true,
    );
  }

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return makeToolResultMessage(
      toolCall.id,
      name,
      `Arguments for tool '${name}' must be a JSON object, got ${typeof args}.`,
      true,
    );
  }

  // Look up tool
  const registered = registry.get(name);
  if (!registered) {
    const available = registry.listAll().map((t) => t.definition.name);
    return makeToolResultMessage(
      toolCall.id,
      name,
      `Tool '${name}' does not exist. Available tools: ${available.join(', ')}`,
      true,
    );
  }

  // Validate arguments against the tool's Zod schema (agent path)
  const validation = registry.validate(name, args);
  if (!validation.ok) {
    return makeToolResultMessage(toolCall.id, name, validation.error, true);
  }

  if (!options.cwd || options.cwd.trim() === '') {
    return makeToolResultMessage(
      toolCall.id,
      name,
      `Tool '${name}' cannot run: no workspace cwd in tool execution context.`,
      true,
    );
  }

  // Timeout AbortController — aborted by runWithToolTimeout so foreground
  // process tools can kill the live ChildProcess handle (not only reject).
  const timeoutAbort = new AbortController();
  const parentAbort = options.abortSignal;
  const combinedAbort =
    parentAbort !== undefined
      ? AbortSignal.any([parentAbort, timeoutAbort.signal])
      : timeoutAbort.signal;

  const toolCtx: ToolExecutionContext = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    projectRuntime: options.projectRuntime,
    agentScopeId: options.agentScopeId,
    abortSignal: combinedAbort,
  };

  // wait_for_subagent uses a dedicated outer budget (default 300s), not
  // command_timeout, so the tool can return its structured timeout message
  // (subagents stay running) before the dispatch race fires.
  const effectiveTimeoutSeconds =
    name === 'wait_for_subagent'
      ? (options.waitTimeoutSeconds ?? WAIT_TOOL_OUTER_TIMEOUT_S)
      : timeoutSeconds;

  // Execute with optional timeout (shared policy with MCP wrappers)
  // Prefer Zod-parsed data so defaults/coercions reach the handler.
  const handlerArgs = validation.data;
  let result: unknown;
  try {
    result = await runWithToolTimeout(
      () => registered.handler(handlerArgs, toolCtx),
      name,
      {
        timeoutSeconds: effectiveTimeoutSeconds,
        noTimeout: Boolean(registered.definition.noTimeout),
        abortController: timeoutAbort,
      },
    );
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return makeToolResultMessage(toolCall.id, name, err.message, true);
    }
    console.error(`Tool '${name}' raised an exception:`, err);
    return makeToolResultMessage(
      toolCall.id,
      name,
      `Tool '${name}' failed with an internal error.`,
      true,
    );
  }

  const { content, isError } = normalizeToolHandlerResult(result);

  // Maybe offload large output (preserves isError)
  const trimmed = maybeOffloadToolOutput(name, content, toolCall.id, options.sessionId);

  return makeToolResultMessage(toolCall.id, name, trimmed, isError);
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
 *
 * When `abortController` is provided, it is aborted on timeout so tools that
 * hold live ChildProcess handles can kill them (not only reject the Promise).
 */
export function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  message: string,
  abortController?: AbortController,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    abortController?.abort();
    return Promise.reject(new ToolTimeoutError(message));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const promise = work();

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController?.abort();
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
  options: {
    timeoutSeconds?: number;
    noTimeout?: boolean;
    abortController?: AbortController;
  } = {},
): Promise<T> {
  if (options.noTimeout || TOOLS_WITHOUT_TIMEOUT.has(toolName)) {
    return work();
  }
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S;
  return withTimeout(
    work,
    timeoutSeconds * 1000,
    `Tool '${toolName}' timed out after ${timeoutSeconds}s.`,
    options.abortController,
  );
}

/** Test-only root override so unit tests never write a real home directory. */
let toolOutputCacheRootOverride: string | null = null;

/** @internal Test-only cache-root override. */
export function _setToolOutputCacheRootForTests(root: string | null): void {
  toolOutputCacheRootOverride = root;
}

/** Get the tool-output cache directory for a session. */
function getToolOutputCacheDir(sessionId: string): string {
  return path.join(
    toolOutputCacheRootOverride ?? os.homedir(),
    '.orchid',
    'cache',
    'tool-output',
    sessionId,
  );
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
