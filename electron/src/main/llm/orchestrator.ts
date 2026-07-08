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
 * AI SDK stream event flow:
 * - `step-start` → new step begins
 * - `reasoning` → model is thinking (yields as "thinking")
 * - `text-delta` → model is producing text (yields as "content")
 * - `tool-call` → model wants to call a tool (AI SDK executes via our custom execute fn)
 * - `step-finish` → step completed (tool executed, or text finished)
 * - `finish` → entire stream completed
 * - `error` → error occurred
 *
 * Note: AI SDK does NOT yield `tool-result` in the stream. When a tool is called,
 * AI SDK executes it (via our `tool.execute` function) and the result is fed back
 * to the model internally. We track tool results via the `onStepFinish` callback
 * and by monitoring what our `tool.execute` functions return.
 */
import type { ModelMessage, Tool } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Message, Usage } from '../../shared/types/message';
import type { Agent } from '../../shared/types/agent';
import type { ToolCall } from '../../shared/types/tool';
import type { Config } from '../config/schema';
import type { ToolRegistry } from '../tools/registry';
import type { MCPManager } from '../mcp/manager';
import { toApiMessages } from './history';
import { executeToolCall, type ToolDispatchOptions } from './tool-dispatch';
import { buildSystemPrompt, type SystemPromptContext } from './system-prompt';
import { createMiddlewareStack } from './middleware/index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Events yielded by the orchestrator's async generator. */
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string }
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
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** The AI SDK model instance to use for streaming. */
  modelInstance: LanguageModelV4;
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
    abortSignal,
    modelInstance,
  } = params;

  // Dynamic import — `ai` is ESM-only but Electron main compiles to CJS
  const { streamText, wrapLanguageModel, isStepCount } = await import('ai');

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
      const content = msg.tool_calls
        ? [
            ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
            ...msg.tool_calls.map((tc) => ({
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          ]
        : msg.content || '';
      coreMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
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
            output: { type: 'text', value: msg.content ?? '' },
          },
        ],
      });
    } else if (msg.role === 'user') {
      coreMessages.push({
        role: 'user',
        content: msg.content || '',
      });
    }
  }

  // ── Filter and build tools ──
  const tools = buildToolMap(agent.allowed_tools, registry, mcpManager, {
    sessionId,
    timeoutSeconds: config.command_timeout,
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

  // ── Determine max steps ──
  const maxSteps = 10;

  // ── Track usage across steps ──
  let totalUsage: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
  };

  // ── Track tool calls and results for yielding ──
  const pendingToolCalls: Array<{ toolCallId: string; toolName: string }> = [];
  const pendingToolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];

  // ── Call streamText ──
  const result = streamText({
    model: wrappedModel,
    system: fullSystemPrompt,
    messages: coreMessages,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    stopWhen: isStepCount(maxSteps),
    abortSignal,
    onStepFinish: async ({ usage, toolCalls, toolResults }) => {
      if (usage) {
        totalUsage = {
          prompt_tokens: totalUsage.prompt_tokens + (usage.inputTokens ?? 0),
          completion_tokens: totalUsage.completion_tokens + (usage.outputTokens ?? 0),
          total_tokens: totalUsage.total_tokens + (usage.totalTokens ?? 0),
          cached_tokens: totalUsage.cached_tokens,
        };
      }
      // Capture tool calls for yielding to the UI
      if (toolCalls) {
        for (const tc of toolCalls as Array<{ toolCallId: string; toolName: string }>) {
          pendingToolCalls.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          });
        }
      }
      // Capture tool results for yielding to the UI
      if (toolResults) {
        for (const tr of toolResults as Array<{ toolCallId: string; output: unknown }>) {
          pendingToolResults.push({
            toolCallId: tr.toolCallId,
            content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output),
            isError: false,
          });
        }
      }
    },
  });

  // ── Process the text stream ──
  try {
    // Use textStream to avoid AI SDK's chunk type issues with fullStream.
    // Tool calls and results are captured via onStepFinish callback.
    for await (const textDelta of result.textStream) {
      if (textDelta) {
        yield { type: 'content', text: textDelta };
      }

      // Yield any pending tool calls
      while (pendingToolCalls.length > 0) {
        const tc = pendingToolCalls.shift()!;
        yield { type: 'tool_call', ...tc };
      }

      // Yield any pending tool results
      while (pendingToolResults.length > 0) {
        const tr = pendingToolResults.shift()!;
        yield { type: 'tool_result', ...tr };
      }
    }

    // Yield any remaining pending tool calls/results after stream ends
    while (pendingToolCalls.length > 0) {
      const tc = pendingToolCalls.shift()!;
      yield { type: 'tool_call', ...tc };
    }
    while (pendingToolResults.length > 0) {
      const tr = pendingToolResults.shift()!;
      yield { type: 'tool_result', ...tr };
    }

    // Get the finish reason from the result
    const finishReason = await result.finishReason;
    yield { type: 'finish', finishReason: finishReason ?? 'stop' };
  } catch (err) {
    const { title, detail } = classifyStreamError(err);
    yield { type: 'error', title, detail };
  }

  // ── Yield final usage ──
  yield { type: 'usage', usage: totalUsage };
}

// ---------------------------------------------------------------------------
// Tool building
// ---------------------------------------------------------------------------

/**
 * Build a tool map for AI SDK from the registry, filtered by agent's allowed tools.
 *
 * Each tool gets a custom `execute` function that uses our dispatch logic
 * (timeout + output offloading).
 */
export function buildToolMap(
  allowedTools: readonly string[],
  registry: ToolRegistry,
  mcpManager: MCPManager | null,
  dispatchOptions: ToolDispatchOptions,
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
    const inputSchema = definition.inputSchema;

    toolMap[definition.name] = {
      description: definition.description,
      inputSchema,
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
        return result.content;
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
          const result = await mcpManager.callTool(definition.name, args);
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
      };
    }
  }

  return toolMap as Record<string, Tool>;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyStreamError(err: unknown): { title: string; detail: string } {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return { title: 'Request Timed Out', detail: 'The API did not respond in time. Try again later.' };
    }
    if (msg.includes('rate limit') || msg.includes('429')) {
      return { title: 'Rate Limit Exceeded', detail: 'Too many requests. Please wait and try again.' };
    }
    if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
      return { title: 'Authentication Failed', detail: 'Invalid or missing API key. Check your configuration.' };
    }
    return { title: 'Stream Error', detail: err.message };
  }
  return { title: 'Unexpected Error', detail: String(err) };
}
