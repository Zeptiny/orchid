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
import type { ToolRegistry } from '../tools/registry';
import {
  TOOL_OUTPUT_INLINE_THRESHOLD,
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
import type { ProjectRuntime } from '../project/runtime';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../agents/manager';
import {
  createCanonicalToolResult,
  toolExecutionResultSchema,
  type JsonValue,
  type ToolResultRetrieval,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../shared/types/tool-result';
import { materializeCanonicalResultRetrieval } from '../tools/result-retrieval';
import { withTimeout as sharedWithTimeout } from '../utils/async';
import { resolvePermission, passesRiskClassFloor, FILE_TOOLS } from '../permissions/resolver';
import { approvalStore } from '../permissions/approval-store';
import { createDefaultEngine, DetectionEngine } from '../permissions/detection';
import { sessionPermissionOverrides } from '../ipc/permission';
import { evaluateToolCall, type EvaluatorContext } from '../permissions/evaluator';
import { getProviderRuntime } from '../providers';
import { createMiddlewareStack } from './middleware';
import { getTierModelSelection } from '../config/loader';
import { importESM } from '../utils/esm-import';
import { AgentType } from '../../shared/types/agent';
import type { PermissionMode, RiskClass, ToolScope } from '../../shared/types/permission';
import type { Config } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default tool execution timeout in seconds. */
const DEFAULT_TOOL_TIMEOUT_S = 60;

/**
 * Outer dispatch timeout for `wait_for_subagent` (seconds).
 * Slightly longer than the wait tool's internal DEFAULT_WAIT_TIMEOUT_MS so
 * the structured "still running" tool result wins; this is a backstop.
 */
const WAIT_TOOL_OUTER_TIMEOUT_S = Math.ceil(DEFAULT_WAIT_TIMEOUT_MS / 1000) + 5;

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
  /** The user message that triggered the current turn (for decide-for-me evaluator). */
  triggeringMessage?: string;
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

let detectionEngine: DetectionEngine | null = null;

const TOOL_CALL_HISTORY_SIZE = 50;
const toolCallHistory: Array<{ name: string; argsSummary: string }> = [];

function recordToolCall(name: string, args: unknown): void {
  const summary = JSON.stringify(args) ?? '';
  toolCallHistory.push({ name, argsSummary: summary.slice(0, 200) });
  if (toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    toolCallHistory.shift();
  }
}

const FALLBACK_CONFIG: Config = {
  default_model: null,
  tier_models: {},
  tier_reasoning_effort: {},
  ignored_dirs: [],
  command_timeout: 60,
  read_line_limit: 2000,
  grep_max_results: 100,
  directory_tree_depth: 3,
  theme: 'system',
  personality: 'default',
  rag: {
    chunk_size: 1000,
    chunk_overlap: 200,
    top_k: 5,
    max_file_size: 100_000,
    embedding_model: 'all-MiniLM-L6-v2',
    embedding_threads: 2,
    embedding_batch_size: 16,
    embedding_api_model: null,
  },
  ast_max_file_size: 100_000,
  mcp_startup_timeout: 30_000,
  mcp_per_server_timeout: 10_000,
  mcp_servers: {},
  providers: {},
  llm_stream_idle_timeout: 120_000,
  llm_stream_retries: 3,
  background_command_idle_timeout: 300_000,
  max_tool_steps: 100,
  permission_history_size: 10,
  permissions: {},
  default_project_dir: null,
  always_expand_tool_groups: false,
  has_completed_onboarding: true,
};

async function requestApproval(
  toolCallId: string,
  sessionId: string | undefined,
  toolName: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  scope: ToolScope | undefined,
  abortSignal?: AbortSignal,
): Promise<ToolExecutionResult | null> {
  const result = await approvalStore.create(
    toolCallId,
    sessionId ?? '',
    toolName,
    riskClass,
    args,
    cwd,
    scope,
    abortSignal,
  );
  if (result.decision === 'approved') return null;
  const reason = result.reason ? ` (${result.reason})` : '';
  return genericTerminalExecution(
    toolCallId,
    toolName,
    'error',
    `Permission denied for tool '${toolName}'${reason}.`,
    'permission_denied',
  );
}

async function runEvaluator(
  name: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
  projectRuntime: ProjectRuntime | undefined,
  triggeringMessage: string,
): Promise<'approved' | 'denied'> {
  if (!projectRuntime) return 'denied';
  const evaluatorAgent = projectRuntime.agents.get('permission-evaluator');
  if (!evaluatorAgent || evaluatorAgent.type !== AgentType.INTERNAL) return 'denied';

  const selection = getTierModelSelection(config, evaluatorAgent.tier);
  if (!selection) return 'denied';

  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    const { generateText, wrapLanguageModel } = await importESM<typeof import('ai')>('ai');
    const model = wrapLanguageModel({
      model: execution.modelInstance,
      middleware: createMiddlewareStack({
        retry: { maxRetries: config.llm_stream_retries },
      }),
    });

    const context: EvaluatorContext = {
      toolName: name,
      riskClass,
      args,
      cwd,
      triggeringMessage,
      recentToolCalls: [...toolCallHistory],
    };

    const result = await evaluateToolCall(
      context,
      config,
      async ({ systemPrompt, userMessage }) => {
        const response = await generateText({
          model,
          instructions: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          abortSignal: AbortSignal.timeout(30_000),
          maxRetries: 0,
        });
        return response.text;
      },
      evaluatorAgent.system_prompt,
    );
    return result.decision;
  } catch {
    return 'denied';
  }
}

async function checkPermission(
  toolCallId: string,
  name: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  sessionId: string | undefined,
  config: Config,
  projectRuntime: ProjectRuntime | undefined,
  triggeringMessage: string,
  abortSignal?: AbortSignal,
): Promise<ToolExecutionResult | null> {
  if (name === 'ask_question') return null;
  if (!sessionId) return null;
  if (!riskClass) return null;

  const sessionOverride: PermissionMode | null = sessionId
    ? (sessionPermissionOverrides.get(sessionId) ?? null)
    : null;

  const resolution = resolvePermission(name, riskClass, args, cwd, config, sessionOverride);
  const { mode, scope } = resolution;

  if (mode === 'allow') return null;

  if (mode === 'ask') {
    return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal);
  }

  if (mode === 'decide-for-me') {
    if (!passesRiskClassFloor(name, riskClass, args, cwd, config)) return null;
    const decision = await runEvaluator(name, riskClass, args, cwd, config, projectRuntime, triggeringMessage);
    if (decision === 'approved') return null;
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Permission denied for tool '${name}' by evaluator.`,
      'permission_denied',
    );
  }

  if (!passesRiskClassFloor(name, riskClass, args, cwd, config)) return null;

  if (name === 'execute_command' || name === 'send_input') {
    const command = typeof args['command'] === 'string'
      ? args['command']
      : typeof args['text'] === 'string'
        ? args['text']
        : '';
    if (!detectionEngine) detectionEngine = createDefaultEngine();
    const detection = detectionEngine.evaluate(command);
    if (!detection.flagged) return null;
    return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal);
  }

  if (name.startsWith('mcp::')) {
    return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal);
  }

  if (FILE_TOOLS.has(name)) {
    if (scope === 'inside') return null;
    return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal);
  }

  return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal);
}

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

  recordToolCall(name, args);

  const permissionConfig = options.projectRuntime?.config ?? FALLBACK_CONFIG;
  const permissionDenial = await checkPermission(
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
  );
  if (permissionDenial) return permissionDenial;

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

  // Execute with optional timeout (shared policy with MCP wrappers).
  // Timeout exemption is definition.noTimeout only (no parallel name set).
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
    projector: genericAgentProjector,
  });
  return toolExecutionResultSchema.parse(execution) as ToolExecutionResult;
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
      `<tool_result name="${escapeXmlAttribute(toolName)}" status="partial" length="${content.length}">\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
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
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters and ` +
      `was written to ${escapeXmlText(filePath)}. Use read (with offset/limit) or grep to inspect ` +
      `it.</warning>\n` +
      `<retrieve tool="read" path="${escapedPath}" />\n` +
      `</tool_result>`
    ), cachePath: filePath };
  } catch (err) {
    // Cache write failed — truncate inline
    console.warn(`Failed to offload tool output for ${toolName}:`, err);
    const truncated = content.slice(0, TOOL_OUTPUT_INLINE_THRESHOLD);
    return { content: (
      `<tool_result name="${escapeXmlAttribute(toolName)}" status="partial" length="${content.length}">\n` +
      `<warning>Output exceeded ${TOOL_OUTPUT_INLINE_THRESHOLD} characters ` +
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
