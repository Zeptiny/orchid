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
import type { ModelMessage, Tool } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { jsonSchema } from '@ai-sdk/provider-utils';
import type { Message, Usage } from '../../shared/types/message';
import type { Agent } from '../../shared/types/agent';
import type { Skill } from '../../shared/types/skill';
import type { Config } from '../config/schema';
import type { ToolRegistry } from '../tools/registry';
import { ToolRegistry as ToolRegistryClass } from '../tools/registry';
import type { MCPManager } from '../mcp/manager';
import type { ProjectRuntime } from '../project/runtime';
import { toApiMessages, type ThinkingReplayContext } from './history';
import { toModelMessages } from './model-messages';
import {
  executeToolCall,
  type ToolDispatchOptions,
} from './tool-dispatch';
import { EagerToolExecutor } from './eager-tool-executor';
import { StreamAttemptController } from './stream/attempt-controller';
import {
  EagerToolBridge,
} from './stream/eager-tool-bridge';
import { NormalizedStream } from './stream/normalized-stream';
import { classifyStreamError, toProviderMcpToolName } from './stream/sdk-event-adapter';
import type { ProviderStepUsage } from './stream/sdk-event-adapter';
import type { StreamEvent } from './stream/events';
import { buildSystemPrompt, type SystemPromptContext } from './system-prompt';
import { createMiddlewareStack } from './middleware/index';
import type { ProviderAttemptAccountingContext } from '../providers/accounting/middleware';
import type { ReasoningProviderOptions } from '../providers/drivers/types';
import { applyCacheBreakpoints } from '../providers/facets/cache';
import type { CacheFacet } from '../../shared/types/provider-facets';
import { createContextSnapshotBuilder } from './context-snapshot';
import { importESM } from '../utils/esm-import';
import { buildSkillTool } from '../tools/skill/skill';
import { getSkillsRegistry } from '../tools';
import type { ToolExecutionResult } from '../../shared/types/tool-result';
import { getContextSnapshotStore } from '../providers/accounting/context-snapshot-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Events yielded by the orchestrator's async generator. */
export type { StreamEvent } from './stream/events';

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
  /** Current model's thinking policy + identity for artifact replay (R16). */
  thinkingReplay?: ThinkingReplayContext;
  /**
   * Driver-owned prompt-cache placement. Absent facet = no markers (R12);
   * explicit facets place breakpoints on the stable prefix and conversation
   * tail (R10), with the TTL selection as the only user knob (R11).
   */
  cachePlacement?: {
    readonly facet: CacheFacet;
    readonly ttl?: string;
    readonly sessionKey?: string;
  };
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
    reasoning_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    context: buildContextSnapshot({
      messages,
      inputTokens,
      outputTokens,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    }),
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
    thinkingReplay,
    cachePlacement,
  } = params;

  // Dynamic import — `ai` is ESM-only but Electron main compiles to CJS
  const { streamText, wrapLanguageModel, isStepCount } = await importESM<typeof import('ai')>('ai');

  // ── Build system prompt ──
  const fullSystemPrompt = buildSystemPrompt(systemPrompt, context);

  // ── Convert history to API messages ──
  const historyMessages = toApiMessages(messages, thinkingReplay);

  // System messages are handled by the `system` param in streamText.
  const coreMessages = toModelMessages(historyMessages, {
    responsesReplay: thinkingReplay?.protocol === 'openai-responses',
  });

  // ── Filter and build tools ──
  // Freeze session cwd from prompt context so tools match the turn's workspace.
  // Rebuild skill tool with this agent's allowed_skills (per-stream filter).
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const triggeringMessage = typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content
    : '';

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
    // Eager memoization is attempt-scoped so an idle retry cannot reuse a stale
    // execution from the provider call it replaces.
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
      chainId: accounting?.chainId ?? null,
      turnId: accounting?.turnId ?? null,
    }, {
      skills: projectRuntime
        ? new Map(projectRuntime.skills)
        : getSkillsRegistry(),
      allowedSkills: agent.allowed_skills,
    }, eagerExecutor);
    const buildUsageContext = createContextSnapshotBuilder(fullSystemPrompt, tools);
    const attempt = new StreamAttemptController({
      userAbortSignal: abortSignal,
      idleTimeoutMs,
    });
    attempt.armIdleTimer();

    const eagerBridge = new EagerToolBridge({
      eager: eagerExecutor,
      abortSignal: attempt.signal,
      pauseIdleForTool: () => attempt.pauseIdleForTool(),
      resumeIdleAfterTool: () => attempt.resumeIdleAfterTool(),
      markDeliveredOutput: () => attempt.markDeliveredOutput(),
    });
    const normalizedStream = new NormalizedStream({
      coreMessages,
      mcpManager,
      attempt,
      eagerBridge,
      artifactIdentity: thinkingReplay?.selection,
      buildUsage: (usage, stepMessages) => {
        const stepUsage = buildStepUsage(
          usage,
          stepMessages,
          buildUsageContext,
        );
        // Context snapshots are session-scoped: without a session id there is
        // nowhere to attribute the row (the Analytics Sessions tab groups by
        // session_id), so sessionless streams insert nothing.
        if (stepUsage.context && sessionId) {
          try {
            getContextSnapshotStore().insert({
              sessionId,
              chainId: accounting?.chainId ?? null,
              turnId: accounting?.turnId ?? null,
              providerAttemptId: accounting?.attemptIdHolder?.value ?? null,
              agentScope: agentScopeId ?? null,
              inputTokens: stepUsage.context.input_tokens,
              outputTokens: stepUsage.context.output_tokens,
              usedTokens: stepUsage.context.used_tokens,
              systemTokens: stepUsage.context.system_tokens,
              toolsTokens: stepUsage.context.tools_tokens,
              toolUseTokens: stepUsage.context.tool_use_tokens,
              userTokens: stepUsage.context.user_tokens,
              assistantTokens: stepUsage.context.assistant_tokens,
            });
          } catch (error) {
            console.warn('[orchestrator] Context snapshot insert failed', { error });
          }
        }
        return stepUsage;
      },
    });

    // Stop at the step-count limit OR when an early stop is requested (e.g. a
    // queued "next-request" message). Without a predicate the step-count
    // condition is passed through unchanged so the default path behaves exactly
    // as before; a supplied predicate never stops early unless it returns true.
    const stepLimit = isStepCount(maxSteps);
    const stopWhen = shouldStopEarly
      ? (ctx: Parameters<typeof stepLimit>[0]) =>
          stepLimit(ctx) || shouldStopEarly()
      : stepLimit;

    const placed = applyCacheBreakpoints({
      system: fullSystemPrompt,
      messages: coreMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      sessionKey: cachePlacement?.sessionKey,
      ttl: cachePlacement?.ttl,
      cacheFacet: cachePlacement?.facet,
      providerNamespace: accounting?.snapshot.providerId ?? '',
    });

    const result = streamText({
      model: wrappedModel,
      system: placed.system,
      messages: placed.messages,
      include: { requestMessages: true },
      tools: placed.tools as Record<string, Tool> | undefined,
      stopWhen,
      abortSignal: attempt.signal,
      // Retry ownership belongs to Orchid's accounting-aware middleware.
      maxRetries: 0,
      providerOptions,
      onStepFinish: normalizedStream.onStepFinish,
    });

    try {
      yield* normalizedStream.events(result);
      return; // success
    } catch (err) {
      const canRetryIdle = attempt.canRetryIdle(idleAttempt, maxIdleAttempts);

      if (canRetryIdle) {
        console.warn(
          `[orchestrator] Stream idle timed out before output; retrying (${idleAttempt + 1}/${maxIdleAttempts - 1})`,
        );
        continue;
      }

      if (attempt.didIdleTimeout && !attempt.didUserAbort) {
        yield {
          type: 'error',
          title: 'Stream idle timeout',
          detail: `No LLM data received for ${config.llm_stream_idle_timeout}s`,
        };
        return;
      }

      if (attempt.didUserAbort) {
        return;
      }

      const { title, detail } = classifyStreamError(err);
      yield { type: 'error', title, detail };
      return;
    } finally {
      attempt.abort();
      eagerBridge.dispose();
      attempt.dispose();
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
