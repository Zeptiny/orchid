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
import type { ToolCall } from '../../shared/types/tool';
import type { ToolRegistry } from '../tools/registry';
import {
  TOOL_OUTPUT_INLINE_THRESHOLD,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './middleware/provider-quirks';
import {
  finalizeToolExecutionResult,
  genericAgentProjector,
} from '../tools/result';
import type { ToolExecutionContext } from '../tools/types';
import type { ProjectRuntime } from '../project/runtime';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../agents/manager';
import {
  createCanonicalToolResult,
  toolExecutionResultSchema,
  type AgentProjection,
  type JsonValue,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../shared/types/tool-result';
import { materializeCanonicalResultRetrieval } from '../tools/result-retrieval';

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
 * Execute a single tool call and return canonical facts plus the exact agent
 * projection that the provider will receive.
 *
 * @param toolCall - The tool call to execute
 * @param registry - The tool registry to look up the handler
 * @param options - Optional timeout, session ID, and frozen turn cwd
 * @returns A validated raw execution result for AI SDK streaming
 */
export async function executeToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  options: ToolDispatchOptions = {},
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S;

  if (options.abortSignal?.aborted) {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'cancelled',
      `Tool '${name}' was cancelled.`,
      'parent_cancelled',
    );
  }

  // Parse arguments
  let args: unknown;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Could not parse arguments for tool '${name}': invalid JSON.`,
      'invalid_arguments_json',
    );
  }

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Arguments for tool '${name}' must be a JSON object, got ${typeof args}.`,
      'invalid_arguments_type',
    );
  }

  // Look up tool
  const registered = registry.get(name);
  if (!registered) {
    const available = registry.listAll().map((t) => t.definition.name);
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Tool '${name}' does not exist. Available tools: ${available.join(', ')}`,
      'unknown_tool',
    );
  }

  // Validate arguments against the tool's Zod schema (agent path)
  const validation = registry.validate(name, args);
  if (!validation.ok) {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      validation.error,
      'invalid_arguments',
    );
  }

  if (!options.cwd || options.cwd.trim() === '') {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Tool '${name}' cannot run: no workspace cwd in tool execution context.`,
      'missing_workspace',
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
      return genericTerminalExecution(
        toolCall.id,
        name,
        'error',
        err.message,
        'timeout',
      );
    }
    if (parentAbort?.aborted) {
      return genericTerminalExecution(
        toolCall.id,
        name,
        'cancelled',
        `Tool '${name}' was cancelled.`,
        'parent_cancelled',
      );
    }
    console.error('[tool-dispatch] Tool handler failed', {
      toolCallId: toolCall.id,
      toolName: name,
      exceptionClass: err instanceof Error ? err.constructor.name : 'Unknown',
    });
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Tool '${name}' failed with an internal error.`,
      'handler_exception',
    );
  }

  if (parentAbort?.aborted) {
    return genericTerminalExecution(
      toolCall.id,
      name,
      'cancelled',
      `Tool '${name}' was cancelled.`,
      'parent_cancelled',
    );
  }

  let execution: ToolExecutionResult;
  try {
    execution = finalizeHandlerResult(result, toolCall, registry);
    execution = ensureProjectionRecovery(execution, toolCall, options);
    execution = maybeOffloadAgentProjection(execution, toolCall, options);
    const executionSchema = registry.getToolExecutionResultSchema(name);
    if (!executionSchema) {
      throw new TypeError(`No execution schema registered for tool '${name}'`);
    }
    return executionSchema.parse(execution) as ToolExecutionResult;
  } catch (error) {
    console.warn('[tool-dispatch] Tool result finalization failed', {
      toolCallId: toolCall.id,
      toolName: name,
      family: registered.definition.resultFamily ?? 'generic',
      stage: 'schema',
      exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    return genericTerminalExecution(
      toolCall.id,
      name,
      'error',
      `Tool '${name}' returned an invalid result.`,
      'invalid_tool_result',
    );
  }
}

function isToolHandlerOutcome(value: unknown): value is ToolHandlerOutcome<JsonValue> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    ['complete', 'partial', 'empty', 'error', 'cancelled'].includes(
      String(candidate.status),
    ) && Object.hasOwn(candidate, 'data')
  );
}

function exactProjection(content: string): AgentProjection {
  return { content, completeness: 'complete' };
}

export function genericTerminalExecution(
  toolCallId: string,
  toolName: string,
  status: 'error' | 'cancelled',
  message: string,
  code: string,
): ToolExecutionResult {
  const canonical = status === 'error'
    ? createCanonicalToolResult('generic', {
        status,
        data: {
          value: message,
          origin: { kind: 'built-in', name: toolName },
        },
        error: { code, message },
      })
    : createCanonicalToolResult('generic', {
        status,
        data: {
          value: message,
          origin: { kind: 'built-in', name: toolName },
        },
      });
  const execution = finalizeToolExecutionResult({
    canonical,
    toolName,
    toolCallId,
    expectedFamily: 'generic',
    projector: () => exactProjection(message),
  });
  return toolExecutionResultSchema.parse(execution) as ToolExecutionResult;
}

function finalizeHandlerResult(
  result: unknown,
  toolCall: ToolCall,
  registry: ToolRegistry,
): ToolExecutionResult {
  const registered = registry.get(toolCall.function.name);
  if (!registered) {
    throw new TypeError(`Tool '${toolCall.function.name}' is no longer registered`);
  }

  if (!isToolHandlerOutcome(result)) {
    throw new TypeError(`Tool '${toolCall.function.name}' returned a non-canonical result`);
  }

  const canonical = createCanonicalToolResult(registered.definition.resultFamily, result);
  return finalizeToolExecutionResult({
    canonical,
    toolName: toolCall.function.name,
    toolCallId: toolCall.id,
    outputDataSchema: registered.definition.outputDataSchema,
    expectedFamily: registered.definition.resultFamily,
    projector: registry.resolveAgentProjector(toolCall.function.name).projector,
  });
}

function ensureProjectionRecovery(
  execution: ToolExecutionResult,
  toolCall: ToolCall,
  options: ToolDispatchOptions,
): ToolExecutionResult {
  if (execution.agentProjection.completeness !== 'partial') {
    return execution;
  }

  if (!options.sessionId) {
    return execution;
  }

  if (
    execution.canonical.status === 'partial' &&
    execution.agentProjection.retrieval.kind !== 'cache'
  ) {
    return execution;
  }

  try {
    const retrieval = materializeCanonicalResultRetrieval({
      sessionId: options.sessionId,
      toolCallId: toolCall.id,
      canonical: execution.canonical,
    });
    return {
      canonical: execution.canonical,
      agentProjection: {
        content: [
          execution.agentProjection.content,
          '',
          `Complete result: ${retrieval.path}`,
          ...retrieval.instructions,
        ].join('\n'),
        completeness: 'partial',
        retrieval,
      },
    };
  } catch (error) {
    console.warn('[tool-dispatch] Recovery cache materialization failed', {
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      family: execution.canonical.family,
      stage: 'projection',
      exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    return {
      canonical: execution.canonical,
      agentProjection: genericAgentProjector(execution.canonical),
    };
  }
}

function maybeOffloadAgentProjection(
  execution: ToolExecutionResult,
  toolCall: ToolCall,
  options: ToolDispatchOptions,
): ToolExecutionResult {
  if (!options.sessionId) return execution;
  const offload = maybeOffloadToolOutputDetailed(
    toolCall.function.name,
    execution.agentProjection.content,
    toolCall.id,
    options.sessionId,
  );
  if (!offload.cachePath) return execution;

  return {
    canonical: execution.canonical,
    agentProjection: {
      content: offload.content,
      completeness: 'partial',
      retrieval: {
        kind: 'cache',
        path: offload.cachePath,
        instructions: [
          `Use read with file_path=${JSON.stringify(offload.cachePath)} to inspect the complete agent projection.`,
          `Use grep against ${JSON.stringify(offload.cachePath)} to search the complete agent projection.`,
        ],
      },
    },
  };
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
  return maybeOffloadToolOutputDetailed(
    toolName,
    content,
    toolCallId,
    sessionId,
  ).content;
}

interface ToolOutputOffloadResult {
  content: string;
  cachePath?: string;
}

function maybeOffloadToolOutputDetailed(
  toolName: string,
  content: string,
  toolCallId: string,
  sessionId?: string,
): ToolOutputOffloadResult {
  if (
    content.length <= TOOL_OUTPUT_INLINE_THRESHOLD ||
    TOOLS_WITHOUT_OUTPUT_OFFLOAD.has(toolName)
  ) {
    return { content };
  }

  if (!sessionId) {
    // No session — hard-truncate
    const truncated = content.slice(0, TOOL_OUTPUT_INLINE_THRESHOLD);
    return { content: (
      `<${toolName}_result length=${content.length}>\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
      `and was truncated because no active session is available for cache ` +
      `storage. Use the tool again with narrower scope (offset/limit) to ` +
      `inspect the full result.</warning>\n${truncated}\n</${toolName}_result>`
    ) };
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
    if (fs.readFileSync(filePath, 'utf-8') !== content) {
      throw new Error('Tool output cache verification failed');
    }

    const escapedPath = escapeHtmlAttr(filePath);
    return { content: (
      `<${toolName}_result length=${content.length} file="${escapedPath}">\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters and ` +
      `was written to ${escapedPath}. Use read (with offset/limit) or grep to inspect ` +
      `it.</warning>\n</${toolName}_result>`
    ), cachePath: filePath };
  } catch (err) {
    // Cache write failed — truncate inline
    console.warn(`Failed to offload tool output for ${toolName}:`, err);
    const truncated = content.slice(0, TOOL_OUTPUT_INLINE_THRESHOLD);
    return { content: (
      `<${toolName}_result length=${content.length}>\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
      `and cache write failed (${err instanceof Error ? err.message : err}). Truncated below; re-run the tool with ` +
      `narrower scope to inspect the full result.</warning>\n` +
      `${truncated}\n</${toolName}_result>`
    ) };
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
