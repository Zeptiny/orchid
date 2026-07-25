/**
 * Tool dispatch — execute tool calls with timeout and output offloading.
 *
 * Replicates Python `_execute_tool` (client.py:417-475) and
 * `_maybe_offload_tool_output` (client.py:251-307).
 *
 * Features:
 * - 30s timeout (configurable via `command_timeout` config; overridden by per-call `timeout` arg on execute_command)
 * - Certain tools exempt from timeout (e.g., AST tools, `read_output`)
 * - `wait_for_subagent` uses a longer dedicated outer timeout (300s)
 * - Output offloading: outputs >20KB written to cache files, replaced with
 *   pointer message
 * - Certain tools exempt from offloading (read, grep, glob, etc.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolRegistry } from '../tools/registry';
import {
  getToolOutputInlineThreshold,
  TOOLS_WITHOUT_OUTPUT_OFFLOAD,
} from './middleware/provider-quirks';
import {
  escapeXmlAttribute,
  escapeXmlText,
  finalizeToolExecutionResult,
  genericAgentProjector,
  renderRetrieval,
} from '../tools/result';
import type { ToolExecutionContext } from '../tools/types';
import { toWorkerContext } from '../tools/types';
import { getToolWorkerPool } from './tool-pool';
import type { ProjectRuntime } from '../project/runtime';
import { getDefaultWaitTimeoutMs } from '../agents/manager';
import {
  createCanonicalToolResult,
  type JsonValue,
  type ToolResultRetrieval,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../shared/types/tool-result';
import { materializeCanonicalResultRetrieval } from '../tools/result-retrieval';
import { withTimeout as sharedWithTimeout } from '../utils/async';
import { checkPermission } from '../permissions/gate';
import { recordToolCall } from '../permissions/history';
import { genericTerminalExecution } from './terminal-result';
import { defaults } from '../config/schema';
import type { Config } from '../../shared/types/ipc-boundary';

// Re-exported so existing consumers keep importing these from tool-dispatch.
export { genericTerminalExecution };
export {
  clearToolCallHistoryForAgentScope,
  clearToolCallHistoryForSession,
  getRecentToolCallHistory,
} from '../permissions/history';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default tool execution timeout in seconds. Only used when the caller does
 * not pass `timeoutSeconds` (orchestrator always passes `command_timeout`).
 */
const DEFAULT_TOOL_TIMEOUT_S = 30;

function getWaitToolOuterTimeoutS(): number {
  return Math.ceil(getDefaultWaitTimeoutMs() / 1000) + 5;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tool invocation for dispatch. Prefer pre-parsed `args` objects from the
 * AI SDK / IPC layer; a JSON string is still accepted for wire-form callers.
 */
export interface ToolDispatchRequest {
  id: string;
  name: string;
  /** Pre-parsed args object, or a JSON string to parse once. */
  args: unknown;
}

export interface ToolDispatchOptions {
  /** Tool timeout in seconds. Defaults to DEFAULT_TOOL_TIMEOUT_S (30). */
  timeoutSeconds?: number;
  /**
   * Outer timeout for `wait_for_subagent` only (seconds).
   * Defaults to subagent_wait_timeout + 5s. Independent of
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
  /** Originating renderer window frozen for approval delivery. */
  windowId?: string;
  /** Immutable project definitions captured when this turn began. */
  projectRuntime?: ProjectRuntime;
  /** Parent-turn abort signal (unblocks wait without cancelling children). */
  abortSignal?: AbortSignal;
  /** The user message that triggered the current turn (for decide-for-me evaluator). */
  triggeringMessage?: string;
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

const FALLBACK_CONFIG: Config = defaults();

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a single tool call and return canonical facts plus the exact agent
 * projection that the provider will receive.
 *
 * @param request - Tool id, name, and pre-parsed (or JSON-string) args
 * @param registry - The tool registry to look up the handler
 * @param options - Optional timeout, session ID, and frozen turn cwd
 * @returns A validated raw execution result for AI SDK streaming
 */
export async function executeToolCall(
  request: ToolDispatchRequest,
  registry: ToolRegistry,
  options: ToolDispatchOptions = {},
): Promise<ToolExecutionResult> {
  const name = request.name;
  const toolCallId = request.id;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_S;

  if (options.abortSignal?.aborted) {
    return genericTerminalExecution(
      toolCallId,
      name,
      'cancelled',
      `Tool '${name}' was cancelled.`,
      'parent_cancelled',
    );
  }

  // Accept pre-parsed objects from AI SDK / IPC; parse JSON strings once.
  let args: unknown = request.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        `Could not parse arguments for tool '${name}': invalid JSON.`,
        'invalid_arguments_json',
      );
    }
  }

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return genericTerminalExecution(
      toolCallId,
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
      toolCallId,
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
      toolCallId,
      name,
      'error',
      validation.error,
      'invalid_arguments',
    );
  }

  if (!options.cwd || options.cwd.trim() === '') {
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Tool '${name}' cannot run: no workspace cwd in tool execution context.`,
      'missing_workspace',
    );
  }

  const permissionConfig = options.projectRuntime?.config ?? FALLBACK_CONFIG;
  let permissionDenial: ToolExecutionResult | null;
  try {
    permissionDenial = await checkPermission(
      toolCallId,
      name,
      registered.definition.riskClass,
      args as Record<string, unknown>,
      options.cwd,
      options.sessionId,
      permissionConfig,
      options.projectRuntime,
      options.triggeringMessage ?? '',
      options.abortSignal,
      options.agentScopeId,
      options.windowId,
    );
  } catch (error) {
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Permission gate error for tool '${name}': ${error instanceof Error ? error.message : 'unknown error'}.`,
      'permission_gate_error',
    );
  }
  if (options.abortSignal?.aborted) {
    return genericTerminalExecution(
      toolCallId,
      name,
      'cancelled',
      `Tool '${name}' was cancelled.`,
      'parent_cancelled',
    );
  }
  if (permissionDenial) return permissionDenial;
  recordToolCall(options.sessionId, options.agentScopeId, name, args);

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
    windowId: options.windowId,
    abortSignal: combinedAbort,
  };

  // wait_for_subagent uses a dedicated outer budget (default 300s), not
  // command_timeout, so the tool can return its structured timeout message
  // (subagents stay running) before the dispatch race fires.
  //
  // execute_command: honor a per-call `timeout` so the inner process timeout
  // can return its structured message before the outer dispatch race fires.
  // Add a small buffer for spawn/teardown overhead.
  const effectiveTimeoutSeconds = (() => {
    if (name === 'wait_for_subagent') {
      return options.waitTimeoutSeconds ?? getWaitToolOuterTimeoutS();
    }
    if (name === 'execute_command') {
      const callTimeout = (validation.data as { timeout?: unknown } | null)?.timeout;
      if (typeof callTimeout === 'number' && callTimeout > 0) {
        return Math.max(timeoutSeconds, callTimeout + 5);
      }
    }
    return timeoutSeconds;
  })();

  // Execute with optional timeout (shared policy with MCP wrappers).
  // Timeout exemption is definition.noTimeout only (no parallel name set).
  // Prefer Zod-parsed data so defaults/coercions reach the handler.
  const handlerArgs = validation.data;
  let result: unknown;
  try {
    const offloadPool = registered.definition.offload ? getToolWorkerPool() : null;
    const execute = offloadPool
      ? () => {
          const workerCtx = toWorkerContext(toolCtx);
          return offloadPool.run(
            { toolName: name, args: handlerArgs, context: workerCtx },
            timeoutAbort?.signal,
          );
        }
      : () => registered.handler(handlerArgs, toolCtx);
    result = await runWithToolTimeout(execute, name, {
      timeoutSeconds: effectiveTimeoutSeconds,
      noTimeout: Boolean(registered.definition.noTimeout),
      abortController: timeoutAbort,
    });
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        err.message,
        'timeout',
      );
    }
    if (parentAbort?.aborted) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'cancelled',
        `Tool '${name}' was cancelled.`,
        'parent_cancelled',
      );
    }
    console.error('[tool-dispatch] Tool handler failed', {
      toolCallId,
      toolName: name,
      exceptionClass: err instanceof Error ? err.constructor.name : 'Unknown',
    });
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Tool '${name}' failed with an internal error.`,
      'handler_exception',
    );
  }

  if (parentAbort?.aborted) {
    return genericTerminalExecution(
      toolCallId,
      name,
      'cancelled',
      `Tool '${name}' was cancelled.`,
      'parent_cancelled',
    );
  }

  let execution: ToolExecutionResult;
  try {
    execution = finalizeHandlerResult(result, request, registry);
    execution = ensureProjectionRecovery(execution, request, options);
    execution = maybeOffloadAgentProjection(execution, request, options);
    const executionSchema = registry.getToolExecutionResultSchema(name);
    if (!executionSchema) {
      throw new TypeError(`No execution schema registered for tool '${name}'`);
    }
    return executionSchema.parse(execution) as ToolExecutionResult;
  } catch (error) {
    console.warn('[tool-dispatch] Tool result finalization failed', {
      toolCallId,
      toolName: name,
      family: registered.definition.resultFamily ?? 'generic',
      stage: 'schema',
      exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    return genericTerminalExecution(
      toolCallId,
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

function finalizeHandlerResult(
  result: unknown,
  request: ToolDispatchRequest,
  registry: ToolRegistry,
): ToolExecutionResult {
  const registered = registry.get(request.name);
  if (!registered) {
    throw new TypeError(`Tool '${request.name}' is no longer registered`);
  }

  if (!isToolHandlerOutcome(result)) {
    throw new TypeError(`Tool '${request.name}' returned a non-canonical result`);
  }

  const canonical = createCanonicalToolResult(registered.definition.resultFamily, result);
  return finalizeToolExecutionResult({
    canonical,
    toolName: request.name,
    toolCallId: request.id,
    outputDataSchema: registered.definition.outputDataSchema,
    expectedFamily: registered.definition.resultFamily,
    projector: registry.resolveAgentProjector(request.name).projector,
  });
}

function ensureProjectionRecovery(
  execution: ToolExecutionResult,
  request: ToolDispatchRequest,
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
      toolCallId: request.id,
      canonical: execution.canonical,
    });
    return {
      canonical: execution.canonical,
      agentProjection: {
        content: appendXmlRetrieval(
          execution.agentProjection.content,
          retrieval,
          request.name,
        ),
        completeness: 'partial',
        retrieval,
      },
    };
  } catch (error) {
    console.warn('[tool-dispatch] Recovery cache materialization failed', {
      toolCallId: request.id,
      toolName: request.name,
      family: execution.canonical.family,
      stage: 'projection',
      exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    return {
      canonical: execution.canonical,
      agentProjection: genericAgentProjector(execution.canonical, request.name),
    };
  }
}

function appendXmlRetrieval(
  content: string,
  retrieval: ToolResultRetrieval,
  toolName: string,
): string {
  const retrievalXml = renderRetrieval(retrieval);
  const closingTag = '</tool_result>';
  const closingIndex = content.lastIndexOf(closingTag);
  const startsWithEnvelope = content.startsWith('<tool_result');
  const hasClosingTag = closingIndex >= 0;
  if (startsWithEnvelope && hasClosingTag) {
    return content.slice(0, closingIndex).trimEnd() + '\n' +
      retrievalXml + '\n' + content.slice(closingIndex);
  }
  console.warn('[tool-dispatch] Projection content is not a well-formed tool_result envelope; wrapping in fallback envelope', {
    toolName,
    startsWithEnvelope,
    hasClosingTag,
  });
  return '<tool_result name="' + escapeXmlAttribute(toolName) + '" status="partial">\n' +
    '<payload>' + escapeXmlText(content) + '</payload>\n' +
    retrievalXml + '\n</tool_result>';
}

function maybeOffloadAgentProjection(
  execution: ToolExecutionResult,
  request: ToolDispatchRequest,
  options: ToolDispatchOptions,
): ToolExecutionResult {
  if (!options.sessionId) return execution;
  const offload = maybeOffloadToolOutputDetailed(
    request.name,
    execution.agentProjection.content,
    request.id,
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
 * Outputs at or below `tool_output_inline_threshold` and tools that
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
  const inlineThreshold = getToolOutputInlineThreshold();
  if (
    content.length <= inlineThreshold ||
    TOOLS_WITHOUT_OUTPUT_OFFLOAD.has(toolName)
  ) {
    return { content };
  }

  if (!sessionId) {
    // No session — hard-truncate
    const truncated = content.slice(0, inlineThreshold);
    return { content: (
      `<tool_result name="${escapeXmlAttribute(toolName)}" status="partial" length="${content.length}">\n` +
      `<warning>Output exceeded ${inlineThreshold} characters ` +
      `and was truncated because no active session is available for cache ` +
      `storage. Use the tool again with narrower scope (offset/limit) to ` +
      `inspect the full result.</warning>\n` +
      `<payload>${escapeXmlText(truncated)}</payload>\n` +
      `</tool_result>`
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

    const escapedPath = escapeXmlAttribute(filePath);
    return { content: (
      `<tool_result name="${escapeXmlAttribute(toolName)}" status="partial" length="${content.length}" file="${escapedPath}">\n` +
      `<warning>Output exceeded ${inlineThreshold} characters and ` +
      `was written to ${escapeXmlText(filePath)}. Use read (with offset/limit) or grep to inspect ` +
      `it.</warning>\n` +
      `<retrieve tool="read" path="${escapedPath}" />\n` +
      `</tool_result>`
    ), cachePath: filePath };
  } catch (err) {
    // Cache write failed — truncate inline
    console.warn(`Failed to offload tool output for ${toolName}:`, err);
    const truncated = content.slice(0, inlineThreshold);
    return { content: (
      `<tool_result name="${escapeXmlAttribute(toolName)}" status="partial" length="${content.length}">\n` +
      `<warning>Output exceeded ${inlineThreshold} characters ` +
      `and cache write failed (${escapeXmlText(err instanceof Error ? err.message : String(err))}). Truncated below; re-run the tool with ` +
      `narrower scope to inspect the full result.</warning>\n` +
      `<payload>${escapeXmlText(truncated)}</payload>\n` +
      `</tool_result>`
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
  return sharedWithTimeout(work, ms, message, {
    abortController,
    createError: (m) => new ToolTimeoutError(m),
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
    /** When true, skip the outer timeout (from ToolDefinition.noTimeout). */
    noTimeout?: boolean;
    abortController?: AbortController;
  } = {},
): Promise<T> {
  if (options.noTimeout) {
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
