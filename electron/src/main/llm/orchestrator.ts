/**
 * LLM stream orchestrator — the core agentic loop.
 *
 * Uses AI SDK's `streamText` with `tools` and `maxSteps` for multi-step tool calling.
 *
 * Design:
 * - Uses AI SDK's `streamText` with `maxSteps` for multi-step agentic loop
 * - Custom tool execution via `tool.execute` with timeout and output offloading
 * - Yields `StreamEvent` for each chunk type (thinking, content, tool_call,
 *   tool_result, usage, error)
 * - Filters tool registry by agent's `allowed_tools`
 * - Includes MCP tools from MCPManager
 * - Composes middleware (retry, throttle; optional attempt accounting)
 * - Token usage updates after every completed model step
 *
 * AI SDK stream event flow (fullStream):
 * - `start-step` → new step begins
 * - `reasoning` → model is thinking (yields as "thinking")
 * - `text-delta` → model is producing text (yields as "content")
 * - `tool-input-available` / `tool-call` → model wants to call a tool
 * - `tool-output-available` / `tool-result` → tool finished
 * - `finish-step` → step completed (tool executed, or text finished)
 * - `finish` → entire stream completed
 * - `error` → error occurred
 *
 * Tool events: prefer fullStream parts as the single source of truth. onStepFinish
 * still captures toolCalls/toolResults into pending arrays for the textStream
 * fallback path (when fullStream is unavailable). Drain of pending is deduped
 * by toolCallId so the same call/result is never yielded twice.
 */
import { createHash } from 'node:crypto';
import type { AssistantContent, ModelMessage, Tool } from 'ai';
import { getErrorMessage, type LanguageModelV4 } from '@ai-sdk/provider';
import { jsonSchema } from '@ai-sdk/provider-utils';
import type { Message, Usage } from '../../shared/types/message';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import type { Config } from '../config/schema';
import type { ToolRegistry } from '../tools/registry';
import { ToolRegistry as ToolRegistryClass } from '../tools/registry';
import type { MCPManager } from '../mcp/manager';
import type { ProjectRuntime } from '../project/runtime';
import { toApiMessages } from './history';
import {
  executeToolCall,
  type ToolDispatchOptions,
} from './tool-dispatch';
import { EagerToolExecutor } from './eager-tool-executor';
import {
  finalizeToolExecutionResult,
  genericAgentProjector,
  parseToolExecutionResult,
} from '../tools/result';
import { buildSystemPrompt, type SystemPromptContext } from './system-prompt';
import { createMiddlewareStack } from './middleware/index';
import type { ProviderAttemptAccountingContext } from '../providers/accounting/middleware';
import type { ReasoningProviderOptions } from '../providers/drivers/types';
import { createContextSnapshotBuilder } from './context-snapshot';
import { importESM } from '../utils/esm-import';
import { buildSkillTool } from '../tools/skill/skill';
import { getSkillsRegistry } from '../tools';
import {
  createCanonicalToolResult,
  type ToolExecutionResult,
} from '../../shared/types/tool-result';

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_TOOL_NAME_HASH_LENGTH = 16;

/**
 * Convert an internal MCP tool identity into the conservative function-name
 * grammar shared by OpenAI-compatible and other providers. The hash preserves
 * uniqueness when different names sanitize to the same prefix.
 */
function toProviderMcpToolName(internalName: string): string {
  const safePrefix = internalName
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'mcp_tool';
  const hash = createHash('sha256')
    .update(internalName)
    .digest('hex')
    .slice(0, PROVIDER_TOOL_NAME_HASH_LENGTH);
  const prefixLength = PROVIDER_TOOL_NAME_MAX_LENGTH - hash.length - 1;

  return `${safePrefix.slice(0, prefixLength)}_${hash}`;
}

function toInternalToolName(
  toolName: string,
  mcpManager: MCPManager | null,
): string {
  if (!mcpManager || toolName.startsWith('mcp::')) return toolName;
  const match = mcpManager.getTools().find(
    ({ definition }) => toProviderMcpToolName(definition.name) === toolName,
  );
  return match?.definition.name ?? toolName;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Events yielded by the orchestrator's async generator. */
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'tool_call_delta'; toolCallId: string; argsDelta: string }
  | {
      type: 'tool_result';
      toolCallId: string;
      content: string;
      /** Raw canonical execution retained by Orchid; U3 transports it durably. */
      execution: ToolExecutionResult;
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; title: string; detail: string }
  | { type: 'step_finish'; stepIndex: number; finishReason: string }
  | { type: 'finish'; finishReason: string };

/** Parameters for the stream orchestrator. */
export interface StreamChatParams {
  /** Persisted message history. */
  messages: Message[];
  /** The agent configuration. */
  agent: Agent;
  /** System prompt instructions (from agent). */
  systemPrompt: string;
  /** Runtime context for dynamic system prompt. */
  context: SystemPromptContext;
  /** Application config. */
  config: Config;
  /** Tool registry (built-in tools). */
  registry: ToolRegistry;
  /** MCP manager (may be null if MCP is not configured). */
  mcpManager: MCPManager | null;
  /** Session ID for tool output offloading. */
  sessionId?: string;
  /** Originating renderer window frozen for approval delivery. */
  windowId?: string;
  /** Immutable project config/definitions captured when this turn began. */
  projectRuntime?: ProjectRuntime;
  /**
   * Agent scope within the session (`main` or subagent id).
   * Propagated into tool dispatch for todos / background isolation.
   */
  agentScopeId?: string;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /**
   * Optional early-stop predicate evaluated at each step boundary. When it
   * returns true the multi-step loop stops after the current step (a clean
   * termination, not an abort). Used to end a chain early so a queued
   * "next-request" message can start a fresh chain.
   */
  shouldStopEarly?: () => boolean;
  /** The AI SDK model instance to use for streaming. */
  modelInstance: LanguageModelV4;
  /** Frozen durable-attempt context for every provider invocation. */
  accounting?: ProviderAttemptAccountingContext;
  /** Provider-native reasoning options forwarded to streamText. */
  providerOptions?: ReasoningProviderOptions;
}

interface ProviderStepUsage {
  inputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokens?: number;
  totalTokens?: number;
}

function buildStepUsage(
  usage: ProviderStepUsage,
  messages: readonly ModelMessage[],
  buildContextSnapshot: ReturnType<typeof createContextSnapshotBuilder>,
): Usage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: usage.totalTokens ?? inputTokens + outputTokens,
    cached_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    context: buildContextSnapshot({
      messages,
      inputTokens,
      outputTokens,
    }),
  };
}

/** Pending tool call captured from onStepFinish (textStream fallback / safety net). */
export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  args: string;
};

/** Pending tool result captured from onStepFinish (textStream fallback / safety net). */
export type PendingToolResult = {
  toolCallId: string;
  content: string;
  execution: ToolExecutionResult;
};

/**
 * Drain pending tool events from onStepFinish, skipping any toolCallId already
 * emitted from fullStream. Prevents double-yield when both sources report the
 * same tool call/result (P1-20).
 *
 * Mutates `pending*` (shift) and `seen*` (add). Exported for unit tests.
 */
export function* drainPendingToolEvents(
  pendingToolCalls: PendingToolCall[],
  pendingToolResults: PendingToolResult[],
  seenToolCallIds: Set<string>,
  seenToolResultIds: Set<string>,
): Generator<Extract<StreamEvent, { type: 'tool_call' | 'tool_result' }>> {
  while (pendingToolCalls.length > 0) {
    const tc = pendingToolCalls.shift()!;
    if (seenToolCallIds.has(tc.toolCallId)) continue;
    seenToolCallIds.add(tc.toolCallId);
    yield { type: 'tool_call', ...tc };
  }
  while (pendingToolResults.length > 0) {
    const tr = pendingToolResults.shift()!;
    if (seenToolResultIds.has(tr.toolCallId)) continue;
    seenToolResultIds.add(tr.toolCallId);
    yield { type: 'tool_result', ...tr };
  }
}

/** Build one exact-projection generic terminal execution at an SDK boundary. */
function genericSdkExecution(
  toolName: string,
  content: string,
  options: {
    status?: 'complete' | 'empty' | 'error' | 'cancelled';
    errorCode?: string;
    originKind?: 'built-in' | 'dynamic' | 'mcp';
  } = {},
): ToolExecutionResult {
  const status = options.status ?? (content.length === 0 ? 'empty' : 'complete');
  const data = {
    value: content,
    origin: {
      kind: options.originKind ?? 'built-in',
      name: toolName || 'unknown',
    },
  } as const;
  const canonical = status === 'error'
    ? createCanonicalToolResult('generic', {
        status,
        data,
        error: {
          code: options.errorCode ?? 'sdk_tool_error',
          message: content,
        },
      })
    : createCanonicalToolResult('generic', { status, data });

  return finalizeToolExecutionResult({
    canonical,
    toolName,
    expectedFamily: 'generic',
    projector: genericAgentProjector,
  }) as ToolExecutionResult;
}

/**
 * Validate the raw AI SDK execution wrapper. Provider stream parts must carry
 * the canonical execution wrapper; malformed values become explicit generic
 * errors rather than being interpreted as a legacy content result.
 */
function executionFromSdkOutput(
  raw: unknown,
  toolName: string = 'unknown',
): ToolExecutionResult {
  try {
    const execution = parseToolExecutionResult(raw);
    return execution;
  } catch {
    if (
      raw != null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      ('canonical' in raw || 'agentProjection' in raw)
    ) {
      return genericSdkExecution(
        toolName,
        `Tool '${toolName}' returned an invalid execution result.`,
        { status: 'error', errorCode: 'invalid_tool_result' },
      );
    }
  }

  return genericSdkExecution(
    toolName,
    `Tool '${toolName}' returned an invalid execution result.`,
    { status: 'error', errorCode: 'invalid_tool_result' },
  );
}

function sdkPreExecutionError(
  part: Record<string, unknown>,
  mcpManager: MCPManager | null = null,
): ToolExecutionResult {
  const content = typeof part.errorText === 'string'
    ? part.errorText
    : getErrorMessage(part.error ?? 'Tool failed');
  const providerToolName = typeof part.toolName === 'string' ? part.toolName : 'unknown';
  const toolName = toInternalToolName(providerToolName, mcpManager);
  return genericSdkExecution(toolName, content, {
    status: 'error',
    errorCode: 'sdk_tool_error',
  });
}

function streamResultFields(execution: ToolExecutionResult): Pick<
  PendingToolResult,
  'content' | 'execution'
> {
  return {
    content: execution.agentProjection.content,
    execution,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Main LLM stream orchestrator — async generator that yields StreamEvents.
 *
 * Builds system prompt + history + dynamic prompt, filters tools by agent's
 * allowed_tools, includes MCP tools, calls `streamText` with composed
 * middleware, and processes chunks into StreamEvents.
 *
 * Uses AI SDK's `maxSteps` for multi-step agentic loop.
 * Custom tool execution via `tool.execute` handles timeout and output offloading.
 *
 * @param params - Stream chat parameters
 * @yields StreamEvent for each chunk, tool call, result, usage, etc.
 */
export async function* streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
  const {
    messages,
    agent,
    systemPrompt,
    context,
    config,
    registry,
    mcpManager,
    sessionId,
    windowId,
    projectRuntime,
    agentScopeId,
    abortSignal,
    shouldStopEarly,
    modelInstance,
    accounting,
    providerOptions,
  } = params;

  // Dynamic import — `ai` is ESM-only but Electron main compiles to CJS
  const { streamText, wrapLanguageModel, isStepCount } = await importESM<typeof import('ai')>('ai');

  // ── Build system prompt ──
  const fullSystemPrompt = buildSystemPrompt(systemPrompt, context);

  // ── Convert history to API messages ──
  const historyMessages = toApiMessages(messages);

  // ── Build CoreMessage array ──
  const coreMessages: ModelMessage[] = [];

  for (const msg of historyMessages) {
    if (msg.role === 'system') {
      // System messages are handled by the `system` param in streamText
      continue;
    }
    if (msg.role === 'assistant') {
      // Handle content that may be a string or an array with reasoning parts
      const contentArray = Array.isArray(msg.content)
        ? msg.content.map((part) => {
            if (part.type === 'reasoning') {
              return { type: 'reasoning' as const, text: part.text };
            }
            return { type: 'text' as const, text: part.text };
          })
        : msg.content
          ? [{ type: 'text' as const, text: msg.content }]
          : [];

      const content: AssistantContent = msg.tool_calls
        ? [
            ...contentArray,
            ...msg.tool_calls.flatMap((tc) => {
              let input: unknown;
              try {
                input = JSON.parse(tc.function.arguments);
              } catch {
                return [];
              }
              return [
                {
                  type: 'tool-call' as const,
                  toolCallId: tc.id,
                  toolName: tc.function.name,
                  input,
                },
              ];
            }),
          ]
        : contentArray.length === 1 && contentArray[0].type === 'text'
          ? contentArray[0].text
          : contentArray.length > 0
            ? contentArray
            : '';
      coreMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Extract text content for tool results
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
          : '';
      // For tool results, we need the tool name from the original tool call.
      // Since we don't store it on the message, use 'unknown' — AI SDK
      // matches by toolCallId, not toolName.
      coreMessages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: msg.tool_call_id!,
            toolName: 'unknown',
            output: { type: 'text', value: textContent },
          },
        ],
      });
    } else if (msg.role === 'user') {
      // Extract text content for user messages
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
          : '';
      coreMessages.push({
        role: 'user',
        content: textContent,
      });
    }
  }

  // ── Filter and build tools ──
  // Freeze session cwd from prompt context so tools match the turn's workspace.
  // Rebuild skill tool with this agent's allowed_skills (per-stream filter).
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const triggeringMessage = typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content
    : '';

  // Eager execution: tools start as soon as their input is streamed, before the
  // model finishes the step. The executor lives across idle-retry attempts;
  // toolCallIds are unique, so stale in-flight entries never collide.
  const eagerExecutor = new EagerToolExecutor();
  const tools = buildToolMap(agent.allowed_tools, registry, mcpManager, {
    sessionId,
    windowId,
    timeoutSeconds: config.command_timeout,
    cwd: context.cwd,
    agentScopeId,
    projectRuntime,
    abortSignal,
    triggeringMessage,
  }, {
    skills: projectRuntime
      ? new Map(projectRuntime.skills)
      : getSkillsRegistry(),
    allowedSkills: agent.allowed_skills,
  }, eagerExecutor);
  const buildUsageContext = createContextSnapshotBuilder(fullSystemPrompt, tools);

  // ── Compose middleware ──
  const middleware = createMiddlewareStack({
    retry: { maxRetries: config.llm_stream_retries },
    ...(accounting ? { accounting } : {}),
  });

  // Wrap model with middleware
  const wrappedModel = wrapLanguageModel({
    model: modelInstance,
    middleware,
  });

  // ── Determine max steps (config) ──
  const maxSteps = config.max_tool_steps ?? 100;

  // ── Idle timeout ──
  // Only idles while waiting on LLM tokens — not during tool execution.
  // Pause the watchdog on tool-input-available; re-arm when the model streams again.
  // Retry the whole stream attempt if idle fires before any content/tool was delivered.
  // Min 1ms so a zero/negative config cannot arm a no-op timer.
  const idleTimeoutMs = Math.max(1, config.llm_stream_idle_timeout * 1000);
  const maxIdleAttempts = Math.max(1, (config.llm_stream_retries ?? 0) + 1);

  for (let idleAttempt = 0; idleAttempt < maxIdleAttempts; idleAttempt++) {
    const idleController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;
    let deliveredAny = false;
    let toolsInFlight = 0;

    const clearIdleTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    /** Arm/reset idle only when waiting on the model (not while tools run). */
    const armIdleTimer = (): void => {
      clearIdleTimer();
      if (toolsInFlight > 0) return;
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        idleController.abort();
      }, idleTimeoutMs);
    };
    const pauseIdleForTool = (): void => {
      toolsInFlight += 1;
      clearIdleTimer();
    };
    const resumeIdleAfterTool = (): void => {
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      if (toolsInFlight === 0) {
        armIdleTimer();
      }
    };

    armIdleTimer();
    const { signal: combinedAbort, dispose: disposeAbortMerge } = combineAbortSignals(
      abortSignal,
      idleController.signal,
    );

    // Pending tool events (textStream fallback / safety net)
    const pendingToolCalls: PendingToolCall[] = [];
    const pendingToolResults: PendingToolResult[] = [];
    const seenToolCallIds = new Set<string>();
    const seenToolResultIds = new Set<string>();
    // Eager execution. The AI SDK emits each tool's input parts
    // (tool-input-start/delta/end, then the validated tool-input-available)
    // incrementally as the model streams, but defers actually RUNNING the tool
    // until model-call-end (Promise.all). To overlap execution with the
    // generation of subsequent tool calls, we reconstruct "input complete"
    // ourselves: accumulate tool-input-delta text per tool and launch it when
    // tool-input-end fires (or when the next tool / text begins, as a backstop).
    // The tool-input-available case below also eager-starts via the same
    // idempotent getOrStart, so whichever signal arrives first wins and the
    // SDK's deferred execute becomes a no-op await for already-started tools.
    const pendingToolInputs = new Map<string, { toolName: string; text: string }>();
    let activeToolInputId: string | null = null;
    // Early UI events for eagerly-started tools, drained into the stream so the
    // renderer sees `running` / `completed` transitions as they actually happen
    // rather than in the SDK's batched step-end burst.
    const eagerStarts: Array<{ toolCallId: string; toolName: string; args: string }> = [];
    const eagerCompletions: Array<{ toolCallId: string; execution: ToolExecutionResult }> = [];
    const finalizeToolInput = (toolCallId: string): void => {
      const pending = pendingToolInputs.get(toolCallId);
      if (!pending) return;
      pendingToolInputs.delete(toolCallId);
      if (activeToolInputId === toolCallId) activeToolInputId = null;
      let input: unknown;
      try {
        input = JSON.parse(pending.text);
      } catch {
        // Incomplete/invalid JSON — the SDK's `tool-call` path will handle it.
        return;
      }
      // Pass the per-attempt combined (user + idle) abort signal so an idle
      // timeout or turn death aborts the eagerly-running tool, matching the
      // SDK `execute` path (which derives its per-call signal from the same
      // combined signal).
      const promise = eagerExecutor.getOrStart(
        toolCallId,
        pending.toolName,
        input,
        combinedAbort,
      );
      if (!promise) return; // no launcher / invalid input — the SDK path handles it
      // The eager tool is now running: pause the idle watchdog for its duration
      // so a quiet model tail can't spuriously abort a legitimately-running tool
      // (the SDK only pauses idle at model-call-end, which the delta path beats).
      // The matching resume fires when the run settles, independent of the
      // seenToolResultIds UI dedup below.
      pauseIdleForTool();
      eagerStarts.push({
        toolCallId,
        toolName: pending.toolName,
        args: stringifyToolInput(input),
      });
      promise
        .then((execution) => {
          eagerCompletions.push({ toolCallId, execution });
        })
        .catch(() => {
          // executeToolCall resolves to terminal executions rather than rejecting.
        })
        .finally(() => resumeIdleAfterTool());
    };
    /** Finalize the currently-streaming tool when an input boundary is reached. */
    const flushActiveToolInput = (): void => {
      if (activeToolInputId) finalizeToolInput(activeToolInputId);
    };
    const drainEagerStarts = function* (): Generator<StreamEvent> {
      while (eagerStarts.length > 0) {
        const start = eagerStarts.shift()!;
        if (seenToolCallIds.has(start.toolCallId)) continue;
        seenToolCallIds.add(start.toolCallId);
        deliveredAny = true;
        yield {
          type: 'tool_call',
          toolCallId: start.toolCallId,
          toolName: start.toolName,
          args: start.args,
        };
      }
    };
    const drainEagerCompletions = function* (): Generator<StreamEvent> {
      while (eagerCompletions.length > 0) {
        const completion = eagerCompletions.shift()!;
        if (seenToolResultIds.has(completion.toolCallId)) continue;
        seenToolResultIds.add(completion.toolCallId);
        deliveredAny = true;
        yield {
          type: 'tool_result',
          toolCallId: completion.toolCallId,
          ...streamResultFields(completion.execution),
        };
      }
    };
    const pendingUsageEvents: Usage[] = [];
    let currentStepMessages: readonly ModelMessage[] = coreMessages;
    let stepIndex = 0;
    let usedFullStream = false;
    let pendingStepEventsSignaled = false;
    let resolvePendingStepEvents: (() => void) | null = null;

    const notifyPendingStepEvents = (): void => {
      if (pendingStepEventsSignaled) return;
      pendingStepEventsSignaled = true;
      resolvePendingStepEvents?.();
      resolvePendingStepEvents = null;
    };
    const waitForPendingStepEvents = (): Promise<void> => {
      if (pendingStepEventsSignaled) {
        pendingStepEventsSignaled = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        resolvePendingStepEvents = () => {
          pendingStepEventsSignaled = false;
          resolve();
        };
      });
    };

    // Stop at the step-count limit OR when an early stop is requested (e.g. a
    // queued "next-request" message). Without a predicate the step-count
    // condition is passed through unchanged so the default path behaves exactly
    // as before; a supplied predicate never stops early unless it returns true.
    const stepLimit = isStepCount(maxSteps);
    const stopWhen = shouldStopEarly
      ? (ctx: Parameters<typeof stepLimit>[0]) =>
          stepLimit(ctx) || shouldStopEarly()
      : stepLimit;

    const result = streamText({
      model: wrappedModel,
      system: fullSystemPrompt,
      messages: coreMessages,
      include: { requestMessages: true },
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen,
      abortSignal: combinedAbort,
      // Retry ownership belongs to Orchid's accounting-aware middleware.
      maxRetries: 0,
      providerOptions,
      onStepFinish: async ({ usage, request, toolCalls, toolResults, content }) => {
        if (usage && !usedFullStream) {
          pendingUsageEvents.push(buildStepUsage(
            usage,
            request?.messages ?? coreMessages,
            buildUsageContext,
          ));
        }
        if (toolCalls) {
          for (const tc of toolCalls as Array<{ toolCallId: string; toolName: string; input?: unknown }>) {
            pendingToolCalls.push({
              toolCallId: tc.toolCallId,
              toolName: toInternalToolName(tc.toolName, mcpManager),
              args: stringifyToolInput(tc.input),
            });
          }
        }
        if (toolResults) {
          for (const tr of toolResults as Array<{
            toolCallId: string;
            output?: unknown;
            result?: unknown;
            error?: unknown;
          }>) {
            const raw = tr.output ?? tr.result ?? tr.error ?? '';
            const execution = tr.error != null && tr.output == null && tr.result == null
              ? genericSdkExecution('unknown', getErrorMessage(tr.error), {
                  status: 'error',
                  errorCode: 'sdk_tool_error',
                })
              : executionFromSdkOutput(
                  raw,
                  'unknown',
                );
            pendingToolResults.push({
              toolCallId: tr.toolCallId,
              ...streamResultFields(execution),
            });
          }
        }
        if (content) {
          for (const rawPart of content as Array<Record<string, unknown>>) {
            const type = String(rawPart.type ?? '');
            if (type !== 'tool-error' && type !== 'tool-input-error') continue;
            const toolCallId = streamToolCallId(rawPart);
            if (!toolCallId) continue;
            const execution = sdkPreExecutionError(rawPart, mcpManager);
            pendingToolResults.push({
              toolCallId,
              ...streamResultFields(execution),
            });
          }
        }
        if (
          !usedFullStream &&
          (pendingUsageEvents.length > 0 ||
            pendingToolCalls.length > 0 ||
            pendingToolResults.length > 0)
        ) {
          notifyPendingStepEvents();
        }
      },
    });

    try {
      try {
        for await (const chunk of result.fullStream) {
          if (!usedFullStream) {
            usedFullStream = true;
            pendingUsageEvents.length = 0;
          }
          const part = chunk as Record<string, unknown>;
          const partType = String(part.type ?? '');

          switch (partType) {
            case 'start-step': {
              const request = part.request as { messages?: readonly ModelMessage[] } | undefined;
              currentStepMessages = request?.messages ?? coreMessages;
              break;
            }

            case 'finish-step': {
              // Backstop: finalize any tool still pending at step end.
              flushActiveToolInput();
              yield {
                type: 'usage',
                usage: buildStepUsage(
                  (part.usage ?? {}) as ProviderStepUsage,
                  currentStepMessages,
                  buildUsageContext,
                ),
              };
              yield {
                type: 'step_finish',
                stepIndex,
                finishReason:
                  typeof part.finishReason === 'string'
                    ? part.finishReason
                    : 'unknown',
              };
              stepIndex += 1;
              break;
            }

            case 'text-delta': {
              armIdleTimer();
              // Model resumed text after tool inputs → finalize any pending tool.
              flushActiveToolInput();
              const text =
                typeof part.text === 'string'
                  ? part.text
                  : typeof part.textDelta === 'string'
                    ? part.textDelta
                    : '';
              if (text) {
                deliveredAny = true;
                yield { type: 'content', text };
              }
              break;
            }

            case 'tool-input-start': {
              armIdleTimer();
              const toolCallId = streamToolCallId(part);
              const toolName = toInternalToolName(
                typeof part.toolName === 'string' ? part.toolName : 'unknown',
                mcpManager,
              );
              // The model moved to a new tool → the previously streaming tool's
              // input is complete (backstop for providers without tool-input-end).
              if (activeToolInputId && activeToolInputId !== toolCallId) {
                finalizeToolInput(activeToolInputId);
              }
              // Surface the finalized tool's `running` state BEFORE announcing the
              // new generating tool, so the single streamingToolCall slot settles
              // on the tool that is actually still generating.
              yield* drainEagerStarts();
              if (toolCallId) {
                pendingToolInputs.set(toolCallId, { toolName, text: '' });
                activeToolInputId = toolCallId;
                deliveredAny = true;
                yield { type: 'tool_call_start', toolCallId, toolName };
              }
              break;
            }

            case 'tool-input-delta': {
              armIdleTimer();
              const toolCallId = streamToolCallId(part);
              const argsDelta =
                typeof part.inputTextDelta === 'string'
                  ? part.inputTextDelta
                  : typeof part.delta === 'string'
                    ? part.delta
                    : '';
              if (toolCallId && argsDelta) {
                const pending = pendingToolInputs.get(toolCallId);
                if (pending) pending.text += argsDelta;
                deliveredAny = true;
                yield { type: 'tool_call_delta', toolCallId, argsDelta };
              }
              break;
            }

            case 'tool-input-end': {
              // This tool's input finished streaming — launch it now, before the
              // SDK emits the batched `tool-call` at step end.
              const toolCallId = streamToolCallId(part);
              if (toolCallId) finalizeToolInput(toolCallId);
              break;
            }

            // Args complete → tool is about to execute — pause idle
            case 'tool-input-available':
            case 'tool-call': {
              pauseIdleForTool();
              const toolCallId = streamToolCallId(part);
              const toolName = toInternalToolName(
                typeof part.toolName === 'string' ? part.toolName : 'unknown',
                mcpManager,
              );
              const args = stringifyToolInput(part.input ?? part.args);
              if (toolCallId && !seenToolCallIds.has(toolCallId)) {
                seenToolCallIds.add(toolCallId);
                deliveredAny = true;
                // Start executing now, while the model keeps generating other
                // tool calls. Skip provider-executed tools (the provider owns
                // them) and SDK-invalid calls (the SDK will emit tool-input-error;
                // running them eagerly would commit a handler the model is told
                // failed).
                if (part.providerExecuted !== true && part.invalid !== true) {
                  eagerExecutor.start(
                    toolCallId,
                    toolName,
                    part.input ?? part.args,
                    combinedAbort,
                  );
                }
                yield { type: 'tool_call', toolCallId, toolName, args };
              }
              break;
            }

            case 'tool-output-available':
            case 'tool-result': {
              resumeIdleAfterTool();
              const toolCallId = streamToolCallId(part);
              // The SDK has the result, so the execute shim has run and will not
              // run again for this id — release the in-flight memo (bounds the
              // map to genuinely in-flight tools).
              if (toolCallId) eagerExecutor.forget(toolCallId);
              const raw = part.output ?? part.result ?? '';
              const toolName = toInternalToolName(
                typeof part.toolName === 'string' ? part.toolName : 'unknown',
                mcpManager,
              );
              const execution = executionFromSdkOutput(raw, toolName);
              if (toolCallId && !seenToolResultIds.has(toolCallId)) {
                seenToolResultIds.add(toolCallId);
                deliveredAny = true;
                yield {
                  type: 'tool_result',
                  toolCallId,
                  ...streamResultFields(execution),
                };
              }
              break;
            }

            case 'tool-output-error':
            case 'tool-error': {
              resumeIdleAfterTool();
              const toolCallId = streamToolCallId(part);
              if (toolCallId) eagerExecutor.forget(toolCallId);
              const execution = sdkPreExecutionError(part, mcpManager);
              if (toolCallId && !seenToolResultIds.has(toolCallId)) {
                seenToolResultIds.add(toolCallId);
                deliveredAny = true;
                yield {
                  type: 'tool_result',
                  toolCallId,
                  ...streamResultFields(execution),
                };
              }
              break;
            }

            case 'tool-input-error': {
              // Args never became valid — no execute, keep/reset idle
              armIdleTimer();
              const toolCallId = streamToolCallId(part);
              // Release any eager memo (the delta path may have started this tool
              // before the SDK's validation verdict); the SDK owns the error path.
              if (toolCallId) eagerExecutor.forget(toolCallId);
              const execution = sdkPreExecutionError(part, mcpManager);
              if (toolCallId) {
                const toolName = toInternalToolName(
                  typeof part.toolName === 'string' ? part.toolName : 'unknown',
                  mcpManager,
                );
                if (!seenToolCallIds.has(toolCallId)) {
                  seenToolCallIds.add(toolCallId);
                  deliveredAny = true;
                  yield {
                    type: 'tool_call',
                    toolCallId,
                    toolName,
                    args: stringifyToolInput(part.input),
                  };
                }
                if (!seenToolResultIds.has(toolCallId)) {
                  seenToolResultIds.add(toolCallId);
                  yield {
                    type: 'tool_result',
                    toolCallId,
                    ...streamResultFields(execution),
                  };
                }
              }
              break;
            }

            case 'reasoning-delta':
            case 'reasoning': {
              armIdleTimer();
              flushActiveToolInput();
              const text =
                typeof part.text === 'string'
                  ? part.text
                  : typeof part.delta === 'string'
                    ? part.delta
                    : '';
              if (text) {
                deliveredAny = true;
                yield { type: 'thinking', text };
              }
              break;
            }

            case 'error': {
              const err = part.error ?? part.errorText ?? chunk;
              const { title, detail } = classifyStreamError(err);
              yield { type: 'error', title, detail };
              break;
            }

            default:
              break;
          }

          // Surface eagerly-started tools and their early completions to the UI
          // stream as soon as they happen (deduped against the SDK's batched
          // `tool-call` / `tool-output-available` via the seen-id sets).
          yield* drainEagerStarts();
          yield* drainEagerCompletions();
          yield* drainPendingToolEvents(
            pendingToolCalls,
            pendingToolResults,
            seenToolCallIds,
            seenToolResultIds,
          );
        }
      } catch (fullStreamErr) {
        // Idle/user abort is not "fullStream unsupported" — rethrow so the
        // outer catch can emit Stream idle timeout / cancel (not textStream fallback).
        if (idleTimedOut || abortSignal?.aborted || combinedAbort.aborted) {
          throw fullStreamErr;
        }
        if (!usedFullStream) {
          console.warn('[orchestrator] fullStream failed, falling back to textStream:', fullStreamErr);
          const textIterator = result.textStream[Symbol.asyncIterator]();
          let nextText = textIterator.next().then((value) => ({
            kind: 'text' as const,
            value,
          }));
          let nextStepEvents = waitForPendingStepEvents().then(() => ({
            kind: 'step-events' as const,
          }));

          while (true) {
            const next = await Promise.race([nextText, nextStepEvents]);
            if (next.kind === 'step-events') {
              yield* drainPendingToolEvents(
                pendingToolCalls,
                pendingToolResults,
                seenToolCallIds,
                seenToolResultIds,
              );
              while (pendingUsageEvents.length > 0) {
                yield { type: 'usage', usage: pendingUsageEvents.shift()! };
              }
              nextStepEvents = waitForPendingStepEvents().then(() => ({
                kind: 'step-events' as const,
              }));
              continue;
            }

            if (next.value.done) break;
            armIdleTimer();
            if (next.value.value) {
              deliveredAny = true;
              yield { type: 'content', text: next.value.value };
            }
            nextText = textIterator.next().then((value) => ({
              kind: 'text' as const,
              value,
            }));
          }
        } else {
          throw fullStreamErr;
        }
      }

      const finishReason = await result.finishReason;

      // Flush any eager tool starts/completions that settled during the final
      // await (e.g. the last tool in a step) before emitting `finish`.
      yield* drainEagerStarts();
      yield* drainEagerCompletions();
      yield* drainPendingToolEvents(
        pendingToolCalls,
        pendingToolResults,
        seenToolCallIds,
        seenToolResultIds,
      );
      if (!usedFullStream) {
        while (pendingUsageEvents.length > 0) {
          yield { type: 'usage', usage: pendingUsageEvents.shift()! };
        }
      }

      yield { type: 'finish', finishReason: finishReason ?? 'stop' };

      if (finishReason === 'length') {
        console.warn('[orchestrator] Stream terminated due to max token limit');
      } else if (finishReason === 'content-filter') {
        console.warn('[orchestrator] Stream terminated by content filter');
      }
      return; // success
    } catch (err) {
      const canRetryIdle =
        idleTimedOut &&
        !abortSignal?.aborted &&
        !deliveredAny &&
        idleAttempt + 1 < maxIdleAttempts;

      if (canRetryIdle) {
        console.warn(
          `[orchestrator] Stream idle timed out before output; retrying (${idleAttempt + 1}/${maxIdleAttempts - 1})`,
        );
        continue;
      }

      if (idleTimedOut && !abortSignal?.aborted) {
        yield {
          type: 'error',
          title: 'Stream idle timeout',
          detail: `No LLM data received for ${config.llm_stream_idle_timeout}s`,
        };
        return;
      }

      if (abortSignal?.aborted) {
        return;
      }

      const { title, detail } = classifyStreamError(err);
      yield { type: 'error', title, detail };
      return;
    } finally {
      clearIdleTimer();
      disposeAbortMerge();
    }
  }
}

// ---------------------------------------------------------------------------
// Tool building
// ---------------------------------------------------------------------------

export interface BuildToolMapSkillOptions {
  /** Full skill registry (for per-agent skill tool rebuild). */
  skills?: Map<string, Skill>;
  /** Agent's allowed_skills globs; when set, skill tool is filtered. */
  allowedSkills?: readonly string[];
}

/** Everything needed to wire one tool (registry, skill, or MCP) for eager execution. */
interface EagerToolWiring {
  eager?: EagerToolExecutor;
  /** Internal tool name (MCP names are pre-normalized); keys the launcher/validator. */
  internalName: string;
  /** Registry that owns this tool's handler. */
  registry: ToolRegistry;
  dispatchOptions: ToolDispatchOptions;
  /** Structural Zod-like input schema, used to gate eager execution on valid input. */
  inputSchema: { safeParse(input: unknown): { success: boolean } };
}

/**
 * Register a tool's eager launcher and input validator (no-op without `eager`).
 * The launcher routes through the unchanged `executeToolCall`, overriding only the
 * abort signal with the per-attempt signal supplied at start time.
 */
function registerEagerTool(wiring: EagerToolWiring): void {
  const { eager, internalName, registry, dispatchOptions, inputSchema } = wiring;
  if (!eager) return;
  eager.registerLauncher(internalName, (toolCallId, input, abortSignal) =>
    executeToolCall(
      { id: toolCallId, name: internalName, args: input },
      registry,
      abortSignal ? { ...dispatchOptions, abortSignal } : dispatchOptions,
    ),
  );
  eager.registerValidator(internalName, (input) => inputSchema.safeParse(input).success);
}

/**
 * Build the SDK-facing `execute` shim: await the eager run if one was started
 * (or start it if the shim wins the race), otherwise fall back to a direct
 * dispatch. Exactly one execution happens either way.
 */
function makeEagerExecute(
  wiring: EagerToolWiring,
): (
  args: unknown,
  executionOptions: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<ToolExecutionResult> {
  const { eager, internalName, registry, dispatchOptions } = wiring;
  return async (args, executionOptions) => {
    const opts = withSdkAbortSignal(dispatchOptions, executionOptions.abortSignal);
    const inflight = eager?.getOrStart(
      executionOptions.toolCallId,
      internalName,
      args,
      opts.abortSignal,
    );
    if (inflight) return inflight;
    return executeToolCall(
      { id: executionOptions.toolCallId, name: internalName, args },
      registry,
      opts,
    );
  };
}

/** Build the `toModelOutput` mapper from an execution result schema. */
function makeToModelOutput(outputSchema: {
  parse: (output: unknown) => unknown;
}): ({ output }: { output: unknown }) => { type: string; value: string } {
  return ({ output }: { output: unknown }) => {
    const execution = outputSchema.parse(output) as ToolExecutionResult;
    return {
      type: execution.canonical.status === 'error' ? 'error-text' : 'text',
      value: execution.agentProjection.content,
    };
  };
}

/**
 * Build a tool map for AI SDK from the registry, filtered by agent's allowed tools.
 *
 * Each tool gets a custom `execute` function that uses our dispatch logic
 * (timeout + output offloading).
 *
 * When `skillOptions.skills` is provided and `skill` is in the map, the skill
 * tool is rebuilt with `allowedSkills` so restricted agents cannot load skills
 * outside their allowlist.
 *
 * When `eager` is provided, each tool registers a launcher (bound to its own
 * registry and the frozen `dispatchOptions`) and its `execute` becomes a shim
 * that awaits the pre-started in-flight promise. This lets a tool begin
 * executing as soon as its input is streamed, before the model finishes the
 * step. Without `eager`, `execute` runs `executeToolCall` directly as before.
 */
export function buildToolMap(
  allowedTools: readonly string[],
  registry: ToolRegistry,
  mcpManager: MCPManager | null,
  dispatchOptions: ToolDispatchOptions,
  skillOptions?: BuildToolMapSkillOptions,
  eager?: EagerToolExecutor,
): Record<string, Tool> {
  // Use a loose record internally to avoid TS2589 (excessively deep
  // instantiation) from Tool's conditional generic types, then assert to
  // Record<string, Tool> at the return site. The shape is validated by
  // `streamText` at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolMap: Record<string, any> = {};

  // Get filtered tools from registry
  const filtered = registry.filter([...allowedTools]);

  for (const { definition } of filtered) {
    const outputSchema = registry.getToolExecutionResultSchema(definition.name);
    if (!outputSchema) {
      throw new TypeError(`No execution schema registered for tool '${definition.name}'`);
    }
    const wiring: EagerToolWiring = {
      eager,
      internalName: definition.name,
      registry,
      dispatchOptions,
      inputSchema: definition.inputSchema,
    };
    registerEagerTool(wiring);
    toolMap[definition.name] = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema,
      execute: makeEagerExecute(wiring),
      toModelOutput: makeToModelOutput(outputSchema),
    };
  }

  // Per-agent skill filter: rebuild definition into a one-shot registry so
  // executeToolCall still applies cwd checks, timeout, and output offload.
  if (toolMap.skill && skillOptions?.skills) {
    const allowed =
      skillOptions.allowedSkills !== undefined
        ? [...skillOptions.allowedSkills]
        : undefined;
    const { definition, handler } = buildSkillTool(skillOptions.skills, allowed);
    const skillRegistry = new ToolRegistryClass();
    skillRegistry.register(definition, handler);
    const outputSchema = skillRegistry.getToolExecutionResultSchema(definition.name);
    if (!outputSchema) {
      throw new TypeError(`No execution schema registered for tool '${definition.name}'`);
    }
    const skillWiring: EagerToolWiring = {
      eager,
      internalName: definition.name,
      registry: skillRegistry,
      dispatchOptions,
      inputSchema: definition.inputSchema,
    };
    registerEagerTool(skillWiring);
    toolMap.skill = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema,
      execute: makeEagerExecute(skillWiring),
      toModelOutput: makeToModelOutput(outputSchema),
    };
  }

  // Add MCP tools if available
  if (mcpManager) {
    const mcpTools = mcpManager.getTools();
    for (const { definition, handler } of mcpTools) {
      const isAllowed = allowedTools.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(definition.name);
        }
        return definition.name === pattern;
      });

      if (!isAllowed) continue;

      const internalName = definition.name;
      const providerName = toProviderMcpToolName(internalName);
      if (providerName in toolMap) {
        throw new Error(
          `Provider tool name collision for MCP tool "${internalName}": "${providerName}"`,
        );
      }
      const dynamicRegistry = new ToolRegistryClass();
      dynamicRegistry.register(definition, handler);
      const outputSchema = dynamicRegistry.getToolExecutionResultSchema(internalName);
      if (!outputSchema) {
        throw new TypeError(`No execution schema registered for MCP tool '${internalName}'`);
      }

      const mcpWiring: EagerToolWiring = {
        eager,
        internalName,
        registry: dynamicRegistry,
        dispatchOptions,
        inputSchema: definition.inputSchema,
      };
      registerEagerTool(mcpWiring);
      const mcpExecute = makeEagerExecute(mcpWiring);
      toolMap[providerName] = {
        description: definition.description,
        inputSchema: definition.rawInputJsonSchema
          ? jsonSchema(definition.rawInputJsonSchema as Parameters<typeof jsonSchema>[0])
          : definition.inputSchema,
        outputSchema,
        execute: (
          args: unknown,
          executionOptions: { toolCallId: string; abortSignal?: AbortSignal } = {
            toolCallId: crypto.randomUUID(),
          },
        ) => mcpExecute(args, executionOptions),
        toModelOutput: makeToModelOutput(outputSchema),
      };
    }
  }

  return toolMap as Record<string, Tool>;
}

function withSdkAbortSignal(
  dispatchOptions: ToolDispatchOptions,
  sdkAbortSignal?: AbortSignal,
): ToolDispatchOptions {
  if (!sdkAbortSignal) return dispatchOptions;
  if (!dispatchOptions.abortSignal) {
    return { ...dispatchOptions, abortSignal: sdkAbortSignal };
  }
  return {
    ...dispatchOptions,
    abortSignal: AbortSignal.any([dispatchOptions.abortSignal, sdkAbortSignal]),
  };
}

/**
 * Merge optional user AbortSignal with the idle-timeout controller.
 * Aborts when either fires. Call `dispose` in finally to drop listeners.
 */
export function combineAbortSignals(
  userSignal: AbortSignal | undefined,
  idleSignal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!userSignal) {
    return { signal: idleSignal, dispose: () => {} };
  }
  // Node 20+ / modern Electron — no manual listeners to clean up
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([userSignal, idleSignal]),
      dispose: () => {},
    };
  }
  const controller = new AbortController();
  const onAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (userSignal.aborted || idleSignal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  userSignal.addEventListener('abort', onAbort);
  idleSignal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      userSignal.removeEventListener('abort', onAbort);
      idleSignal.removeEventListener('abort', onAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Extract the deepest error message from an error chain.
 * AI SDK wraps errors in RetryError → APICallError; this unwraps to the
 * provider's actual message (e.g. "5-hour usage limit reached…").
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return extractErrorMessage(errors[errors.length - 1]);
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function classifyStreamError(err: unknown): { title: string; detail: string } {
  const detail = extractErrorMessage(err);
  const lower = detail.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { title: 'Request Timed Out', detail };
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('usage limit')) {
    return { title: 'Rate Limit Exceeded', detail };
  }
  if (lower.includes('auth') || lower.includes('401') || lower.includes('403')) {
    return { title: 'Authentication Failed', detail };
  }
  if (err instanceof Error) {
    return { title: 'Stream Error', detail };
  }
  return { title: 'Unexpected Error', detail };
}

function stringifyToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** Extract toolCallId from AI SDK 7 stream parts (and legacy `id` aliases). */
function streamToolCallId(part: Record<string, unknown>): string {
  if (typeof part.toolCallId === 'string' && part.toolCallId) return part.toolCallId;
  if (typeof part.id === 'string' && part.id) return part.id;
  return '';
}
