/**
 * LLM stream orchestrator — the core agentic loop.
 *
 * Replicates Python `stream_response` (client.py:1018-1175) using AI SDK's
 * `streamText` with `tools` and `maxSteps` for multi-step tool calling.
 *
 * Design:
 * - Uses AI SDK's `streamText` with `maxSteps` for multi-step agentic loop
 * - Custom tool execution via `tool.execute` with timeout and output offloading
 * - Yields `StreamEvent` for each chunk type (thinking, content, tool_call,
 *   tool_result, usage, error)
 * - Filters tool registry by agent's `allowed_tools`
 * - Includes MCP tools from MCPManager
 * - Composes middleware from U8 (retry, throttle, provider-quirks)
 * - Token usage tracking across all steps
 *
 * AI SDK stream event flow (fullStream):
 * - `step-start` → new step begins
 * - `reasoning` → model is thinking (yields as "thinking")
 * - `text-delta` → model is producing text (yields as "content")
 * - `tool-input-available` / `tool-call` → model wants to call a tool
 * - `tool-output-available` / `tool-result` → tool finished
 * - `step-finish` → step completed (tool executed, or text finished)
 * - `finish` → entire stream completed
 * - `error` → error occurred
 *
 * Tool events: prefer fullStream parts as the single source of truth. onStepFinish
 * still captures toolCalls/toolResults into pending arrays for the textStream
 * fallback path (when fullStream is unavailable). Drain of pending is deduped
 * by toolCallId so the same call/result is never yielded twice.
 */
import type { AssistantContent, ModelMessage, Tool } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Message, Usage } from '../../shared/types/message';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import type { ToolCall } from '../../shared/types/tool';
import type { Config } from '../config/schema';
import type { ToolRegistry } from '../tools/registry';
import { ToolRegistry as ToolRegistryClass } from '../tools/registry';
import type { MCPManager } from '../mcp/manager';
import { toApiMessages } from './history';
import {
  executeToolCall,
  runWithToolTimeout,
  ToolTimeoutError,
  type ToolDispatchOptions,
} from './tool-dispatch';
import { parseToolExecuteOutput } from '../tools/result';
import { buildSystemPrompt, type SystemPromptContext } from './system-prompt';
import { createMiddlewareStack } from './middleware/index';
import { buildContextSnapshot } from './context-snapshot';
import { importESM } from '../utils/esm-import';
import { buildSkillTool } from '../tools/skill/skill';
import { getSkillsRegistry } from '../tools';

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
  | { type: 'tool_result'; toolCallId: string; content: string; isError: boolean }
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
  /**
   * Agent scope within the session (`main` or subagent id).
   * Propagated into tool dispatch for todos / background isolation.
   */
  agentScopeId?: string;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** The AI SDK model instance to use for streaming. */
  modelInstance: LanguageModelV4;
}

interface LatestContextUsage {
  messages: readonly ModelMessage[];
  inputTokens: number | undefined;
  outputTokens: number | undefined;
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
  isError: boolean;
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
    agentScopeId,
    abortSignal,
    modelInstance,
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
            ...msg.tool_calls.map((tc) => ({
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
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
  // Rebuild skill tool with this agent's allowed_skills (Python per-stream filter).
  const tools = buildToolMap(agent.allowed_tools, registry, mcpManager, {
    sessionId,
    timeoutSeconds: config.command_timeout,
    cwd: context.cwd,
    agentScopeId,
  }, {
    skills: getSkillsRegistry(),
    allowedSkills: agent.allowed_skills,
  });

  // ── Compose middleware ──
  const middleware = createMiddlewareStack({
    retry: { maxRetries: config.llm_stream_retries },
  });

  // Wrap model with middleware
  const wrappedModel = wrapLanguageModel({
    model: modelInstance,
    middleware,
  });

  // ── Determine max steps (config; Python loop is unbounded) ──
  const maxSteps = config.max_tool_steps ?? 100;

  // ── Idle timeout ──
  // Python only idles while waiting on LLM tokens — not during tool execution.
  // Pause the watchdog on tool-input-available; re-arm when the model streams again.
  // Retry the whole stream attempt if idle fires before any content/tool was delivered.
  // Min 1ms so a zero/negative config cannot arm a no-op timer.
  const idleTimeoutMs = Math.max(1, config.llm_stream_idle_timeout * 1000);
  const maxIdleAttempts = Math.max(1, (config.llm_stream_retries ?? 0) + 1);

  // ── Track usage across steps (shared across idle retries) ──
  let totalUsage: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
  };
  let latestContextUsage: LatestContextUsage | null = null;

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

    const result = streamText({
      model: wrappedModel,
      system: fullSystemPrompt,
      messages: coreMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: isStepCount(maxSteps),
      abortSignal: combinedAbort,
      onStepFinish: async ({ usage, request, toolCalls, toolResults }) => {
        if (usage) {
          const cachedTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
          totalUsage = {
            prompt_tokens: totalUsage.prompt_tokens + (usage.inputTokens ?? 0),
            completion_tokens: totalUsage.completion_tokens + (usage.outputTokens ?? 0),
            total_tokens: totalUsage.total_tokens + (usage.totalTokens ?? 0),
            cached_tokens: totalUsage.cached_tokens + cachedTokens,
          };
          latestContextUsage = {
            messages: request?.messages ?? coreMessages,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          };
        }
        if (toolCalls) {
          for (const tc of toolCalls as Array<{ toolCallId: string; toolName: string; input?: unknown }>) {
            pendingToolCalls.push({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: stringifyToolInput(tc.input),
            });
          }
        }
        if (toolResults) {
          for (const tr of toolResults as Array<{
            toolCallId: string;
            output?: unknown;
            result?: unknown;
            isError?: boolean;
            error?: unknown;
          }>) {
            const raw = tr.output ?? tr.result ?? '';
            const parsed = parseToolExecuteOutput(raw);
            const isError =
              Boolean(tr.isError) || tr.error != null || parsed.isError;
            pendingToolResults.push({
              toolCallId: tr.toolCallId,
              content: parsed.content,
              isError,
            });
          }
        }
      },
    });

    try {
      let usedFullStream = false;
      try {
        for await (const chunk of result.fullStream) {
          usedFullStream = true;
          const part = chunk as Record<string, unknown>;
          const partType = String(part.type ?? '');

          switch (partType) {
            case 'text-delta': {
              armIdleTimer();
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
              const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown';
              if (toolCallId) {
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
                deliveredAny = true;
                yield { type: 'tool_call_delta', toolCallId, argsDelta };
              }
              break;
            }

            // Args complete → tool is about to execute — pause idle (Python parity)
            case 'tool-input-available':
            case 'tool-call': {
              pauseIdleForTool();
              const toolCallId = streamToolCallId(part);
              const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown';
              const args = stringifyToolInput(part.input ?? part.args);
              if (toolCallId && !seenToolCallIds.has(toolCallId)) {
                seenToolCallIds.add(toolCallId);
                deliveredAny = true;
                yield { type: 'tool_call', toolCallId, toolName, args };
              }
              break;
            }

            case 'tool-output-available':
            case 'tool-result': {
              resumeIdleAfterTool();
              const toolCallId = streamToolCallId(part);
              const raw = part.output ?? part.result ?? '';
              const parsed = parseToolExecuteOutput(raw);
              if (toolCallId && !seenToolResultIds.has(toolCallId)) {
                seenToolResultIds.add(toolCallId);
                deliveredAny = true;
                yield {
                  type: 'tool_result',
                  toolCallId,
                  content: parsed.content,
                  isError: parsed.isError,
                };
              }
              break;
            }

            case 'tool-output-error':
            case 'tool-error': {
              resumeIdleAfterTool();
              const toolCallId = streamToolCallId(part);
              const content =
                typeof part.errorText === 'string'
                  ? part.errorText
                  : typeof part.error === 'string'
                    ? part.error
                    : stringifyToolInput(part.errorText ?? part.error ?? 'Tool failed');
              if (toolCallId && !seenToolResultIds.has(toolCallId)) {
                seenToolResultIds.add(toolCallId);
                deliveredAny = true;
                yield { type: 'tool_result', toolCallId, content, isError: true };
              }
              break;
            }

            case 'tool-input-error': {
              // Args never became valid — no execute, keep/reset idle
              armIdleTimer();
              const toolCallId = streamToolCallId(part);
              const content =
                typeof part.errorText === 'string'
                  ? part.errorText
                  : 'Invalid tool input';
              if (toolCallId) {
                const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown';
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
                  yield { type: 'tool_result', toolCallId, content, isError: true };
                }
              }
              break;
            }

            case 'reasoning-delta':
            case 'reasoning': {
              armIdleTimer();
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
          for await (const textDelta of result.textStream) {
            armIdleTimer();
            if (textDelta) {
              deliveredAny = true;
              yield { type: 'content', text: textDelta };
            }
            yield* drainPendingToolEvents(
              pendingToolCalls,
              pendingToolResults,
              seenToolCallIds,
              seenToolResultIds,
            );
          }
        } else {
          throw fullStreamErr;
        }
      }

      yield* drainPendingToolEvents(
        pendingToolCalls,
        pendingToolResults,
        seenToolCallIds,
        seenToolResultIds,
      );

      const finishReason = await result.finishReason;
      const contextUsage = latestContextUsage as LatestContextUsage | null;
      const usageContext = contextUsage
        ? buildContextSnapshot({
            systemPrompt: fullSystemPrompt,
            tools,
            messages: contextUsage.messages,
            inputTokens: contextUsage.inputTokens,
            outputTokens: contextUsage.outputTokens,
          })
        : undefined;
      yield {
        type: 'usage',
        usage: usageContext ? { ...totalUsage, context: usageContext } : totalUsage,
      };
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
          `[orchestrator] Stream idle before any content (attempt ${idleAttempt + 1}/${maxIdleAttempts}); retrying`,
        );
        continue;
      }
      if (idleTimedOut && !abortSignal?.aborted) {
        yield {
          type: 'error',
          title: 'Stream idle timeout',
          detail:
            `LLM stream was idle for more than ${config.llm_stream_idle_timeout}s with no deltas.`,
        };
      } else {
        const { title, detail } = classifyStreamError(err);
        yield { type: 'error', title, detail };
      }
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

/**
 * Build a tool map for AI SDK from the registry, filtered by agent's allowed tools.
 *
 * Each tool gets a custom `execute` function that uses our dispatch logic
 * (timeout + output offloading).
 *
 * When `skillOptions.skills` is provided and `skill` is in the map, the skill
 * tool is rebuilt with `allowedSkills` so restricted agents cannot load skills
 * outside their allowlist (Python `build_skill_tool(allowed_skills)` parity).
 */
export function buildToolMap(
  allowedTools: readonly string[],
  registry: ToolRegistry,
  mcpManager: MCPManager | null,
  dispatchOptions: ToolDispatchOptions,
  skillOptions?: BuildToolMapSkillOptions,
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
    toolMap[definition.name] = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (args: unknown) => {
        const toolCall: ToolCall = {
          id: crypto.randomUUID(),
          type: 'function',
          function: {
            name: definition.name,
            arguments: JSON.stringify(args),
          },
        };

        const result = await executeToolCall(toolCall, registry, dispatchOptions);
        // Structured payload so orchestrator can read isError without content sniffing.
        return { content: result.content, isError: result.is_error };
      },
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
    toolMap.skill = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (args: unknown) => {
        const toolCall: ToolCall = {
          id: crypto.randomUUID(),
          type: 'function',
          function: {
            name: definition.name,
            arguments: JSON.stringify(args),
          },
        };
        const result = await executeToolCall(toolCall, skillRegistry, dispatchOptions);
        return { content: result.content, isError: result.is_error };
      },
    };
  }

  // Add MCP tools if available
  if (mcpManager) {
    const mcpTools = mcpManager.getTools();
    for (const { definition } of mcpTools) {
      const isAllowed = allowedTools.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(definition.name);
        }
        return definition.name === pattern;
      });

      if (!isAllowed) continue;

      toolMap[definition.name] = {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (args: unknown) => {
          try {
            const result = await runWithToolTimeout(
              () => mcpManager.callTool(definition.name, args),
              definition.name,
              { timeoutSeconds: dispatchOptions.timeoutSeconds },
            );
            // MCP legacy: plain "Error:" string indicates failure
            if (typeof result === 'string' && result.startsWith('Error:')) {
              return { content: result, isError: true };
            }
            // Structured result → delegate to parseToolExecuteOutput
            if (typeof result === 'object' && result !== null) {
              return parseToolExecuteOutput(result);
            }
            return { content: String(result), isError: false };
          } catch (err) {
            if (err instanceof ToolTimeoutError) {
              return { content: err.message, isError: true };
            }
            const message = err instanceof Error ? err.message : String(err);
            return { content: message, isError: true };
          }
        },
      };
    }
  }

  return toolMap as Record<string, Tool>;
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
