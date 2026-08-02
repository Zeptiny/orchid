/**
 * Normalizes AI SDK provider stream parts into Orchid stream events.
 *
 * Provider field aliases live here rather than in the orchestrator. The
 * adapter keeps only per-step message/index state; execution, idle timing, and
 * call/result de-duplication remain owned by the existing controller/bridge.
 */
import { createHash } from 'node:crypto';
import { getErrorMessage } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import type { Usage } from '../../../shared/types/message';
import type { ToolExecutionResult } from '../../../shared/types/tool-result';
import type { MCPManager } from '../../mcp/manager';
import {
  finalizeToolExecutionResult,
  genericAgentProjector,
  parseToolExecutionResult,
} from '../../tools/result';
import { createCanonicalToolResult } from '../../../shared/types/tool-result';
import type { EagerToolBridge } from './eager-tool-bridge';
import type { StreamAttemptController } from './attempt-controller';
import type { StreamEvent } from './events';

export interface ProviderStepUsage {
  inputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
  totalTokens?: number;
}

type AttemptActions = Pick<
  StreamAttemptController,
  'armIdleTimer' | 'markDeliveredOutput'
>;
type BridgeActions = Pick<
  EagerToolBridge,
  | 'flushActiveInput'
  | 'inputStarted'
  | 'inputDelta'
  | 'inputEnded'
  | 'sdkToolCall'
  | 'sdkToolResult'
  | 'sdkToolError'
  | 'sdkInputError'
  | 'drainEagerStarts'
  | 'drainEvents'
>;

export interface SdkEventAdapterOptions {
  coreMessages: readonly ModelMessage[];
  resolveToolName: ToolNameResolver;
  attempt: AttemptActions;
  eagerBridge: BridgeActions;
  buildUsage: (
    usage: ProviderStepUsage,
    messages: readonly ModelMessage[],
  ) => Usage;
}

/**
 * Stateful adapter for one AI SDK fullStream attempt.
 *
 * Call `adapt` once per raw provider part, then let the caller drain the
 * bridge after it to preserve the historical event ordering.
 */
export class SdkEventAdapter {
  private currentStepMessages: readonly ModelMessage[];
  private stepIndex = 0;

  constructor(private readonly options: SdkEventAdapterOptions) {
    this.currentStepMessages = options.coreMessages;
  }

  *adapt(part: Record<string, unknown>): Generator<StreamEvent> {
    switch (String(part.type ?? '')) {
      case 'start-step': {
        const request = part.request as { messages?: readonly ModelMessage[] } | undefined;
        this.currentStepMessages = request?.messages ?? this.options.coreMessages;
        break;
      }

      case 'finish-step':
        this.options.eagerBridge.flushActiveInput();
        yield {
          type: 'usage',
          usage: this.options.buildUsage(
            (part.usage ?? {}) as ProviderStepUsage,
            this.currentStepMessages,
          ),
        };
        yield {
          type: 'step_finish',
          stepIndex: this.stepIndex,
          finishReason: typeof part.finishReason === 'string' ? part.finishReason : 'unknown',
        };
        this.stepIndex += 1;
        break;

      case 'text-delta': {
        this.options.attempt.armIdleTimer();
        this.options.eagerBridge.flushActiveInput();
        const text = stringField(part.text) ?? stringField(part.textDelta) ?? '';
        if (text) {
          this.options.attempt.markDeliveredOutput();
          yield { type: 'content', text };
        }
        break;
      }

      case 'tool-input-start': {
        this.options.attempt.armIdleTimer();
        const toolCallId = streamToolCallId(part);
        const toolName = this.options.resolveToolName(stringField(part.toolName) ?? 'unknown');
        if (toolCallId) this.options.eagerBridge.inputStarted(toolCallId, toolName);
        // Only a prior finalized eager start may precede this new generating
        // state. Fallback calls/results must remain after it so the renderer
        // cannot observe a completed tool before its streamed start.
        yield* this.options.eagerBridge.drainEagerStarts();
        if (toolCallId) {
          this.options.attempt.markDeliveredOutput();
          yield { type: 'tool_call_start', toolCallId, toolName };
        }
        break;
      }

      case 'tool-input-delta': {
        this.options.attempt.armIdleTimer();
        const toolCallId = streamToolCallId(part);
        const argsDelta = stringField(part.inputTextDelta) ?? stringField(part.delta) ?? '';
        if (toolCallId && argsDelta) {
          this.options.eagerBridge.inputDelta(toolCallId, argsDelta);
          this.options.attempt.markDeliveredOutput();
          yield { type: 'tool_call_delta', toolCallId, argsDelta };
        }
        break;
      }

      case 'tool-input-end': {
        const toolCallId = streamToolCallId(part);
        if (toolCallId) this.options.eagerBridge.inputEnded(toolCallId);
        break;
      }

      case 'tool-input-available':
      case 'tool-call': {
        const toolCallId = streamToolCallId(part);
        const toolName = this.options.resolveToolName(stringField(part.toolName) ?? 'unknown');
        const rawInput = part.input ?? part.args;
        if (toolCallId) {
          const event = this.options.eagerBridge.sdkToolCall({
            toolCallId,
            toolName,
            args: stringifyToolInput(rawInput),
            rawInput,
            providerExecuted: part.providerExecuted === true,
            invalid: part.invalid === true,
          });
          if (event) yield event;
        }
        break;
      }

      case 'tool-output-available':
      case 'tool-result': {
        const toolCallId = streamToolCallId(part);
        const toolName = this.options.resolveToolName(stringField(part.toolName) ?? 'unknown');
        const execution = executionFromSdkOutput(part.output ?? part.result ?? '', toolName);
        if (toolCallId) {
          const event = this.options.eagerBridge.sdkToolResult(toolCallId, execution);
          if (event) yield event;
        }
        break;
      }

      case 'tool-output-error':
      case 'tool-error': {
        const toolCallId = streamToolCallId(part);
        const execution = sdkPreExecutionError(part, this.options.resolveToolName);
        if (toolCallId) {
          const event = this.options.eagerBridge.sdkToolError(toolCallId, execution);
          if (event) yield event;
        }
        break;
      }

      case 'tool-input-error': {
        this.options.attempt.armIdleTimer();
        const toolCallId = streamToolCallId(part);
        if (toolCallId) {
          const toolName = this.options.resolveToolName(stringField(part.toolName) ?? 'unknown');
          yield* this.options.eagerBridge.sdkInputError({
            toolCallId,
            toolName,
            args: stringifyToolInput(part.input),
            execution: sdkPreExecutionError(part, this.options.resolveToolName),
          });
        }
        break;
      }

      case 'reasoning-delta':
      case 'reasoning': {
        this.options.attempt.armIdleTimer();
        this.options.eagerBridge.flushActiveInput();
        const text = stringField(part.text) ?? stringField(part.delta) ?? '';
        if (text) {
          this.options.attempt.markDeliveredOutput();
          yield { type: 'thinking', text };
        }
        break;
      }

      case 'error': {
        const { title, detail } = classifyStreamError(part.error ?? part.errorText ?? part);
        yield { type: 'error', title, detail };
        break;
      }

      default:
        break;
    }
  }
}

export type ToolNameResolver = (providerToolName: string) => string;

/** Snapshot provider-safe MCP aliases once for this frozen stream attempt. */
export function createToolNameResolver(mcpManager: MCPManager | null): ToolNameResolver {
  if (!mcpManager) return (toolName) => toolName;

  const internalNamesByAlias = new Map<string, string>();
  for (const { definition } of mcpManager.getTools()) {
    const alias = toProviderMcpToolName(definition.name);
    if (!internalNamesByAlias.has(alias)) {
      internalNamesByAlias.set(alias, definition.name);
    }
  }
  return (toolName) => toolName.startsWith('mcp::')
    ? toolName
    : internalNamesByAlias.get(toolName) ?? toolName;
}

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_TOOL_NAME_HASH_LENGTH = 16;

/** Kept alongside alias reversal so provider naming is one coherent concern. */
export function toProviderMcpToolName(internalName: string): string {
  const safePrefix = internalName
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'mcp_tool';
  const hash = createHash('sha256').update(internalName).digest('hex').slice(0, PROVIDER_TOOL_NAME_HASH_LENGTH);
  return `${safePrefix.slice(0, PROVIDER_TOOL_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

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
  const data = { value: content, origin: { kind: options.originKind ?? 'built-in', name: toolName || 'unknown' } } as const;
  const canonical = status === 'error'
    ? createCanonicalToolResult('generic', { status, data, error: { code: options.errorCode ?? 'sdk_tool_error', message: content } })
    : createCanonicalToolResult('generic', { status, data });
  return finalizeToolExecutionResult({ canonical, toolName, expectedFamily: 'generic', projector: genericAgentProjector }) as ToolExecutionResult;
}

export function executionFromSdkOutput(raw: unknown, toolName = 'unknown'): ToolExecutionResult {
  try {
    return parseToolExecutionResult(raw);
  } catch {
    return genericSdkExecution(toolName, `Tool '${toolName}' returned an invalid execution result.`, {
      status: 'error', errorCode: 'invalid_tool_result',
    });
  }
}

export function sdkPreExecutionError(
  part: Record<string, unknown>,
  resolveToolName: ToolNameResolver = (toolName) => toolName,
): ToolExecutionResult {
  const content = stringField(part.errorText) ?? getErrorMessage(part.error ?? 'Tool failed');
  const toolName = resolveToolName(stringField(part.toolName) ?? 'unknown');
  return genericSdkExecution(toolName, content, { status: 'error', errorCode: 'sdk_tool_error' });
}

export function classifyStreamError(err: unknown): { title: string; detail: string } {
  const detail = extractErrorMessage(err);
  const lower = detail.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return { title: 'Request Timed Out', detail };
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('usage limit')) return { title: 'Rate Limit Exceeded', detail };
  if (lower.includes('auth') || lower.includes('401') || lower.includes('403')) return { title: 'Authentication Failed', detail };
  return err instanceof Error ? { title: 'Stream Error', detail } : { title: 'Unexpected Error', detail };
}

export function stringifyToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input); } catch { return String(input); }
}

export function streamToolCallId(part: Record<string, unknown>): string {
  return stringField(part.toolCallId) ?? stringField(part.id) ?? '';
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const MAX_ERROR_MESSAGE_DEPTH = 8;

function extractErrorMessage(err: unknown, depth = 0): string {
  if (depth >= MAX_ERROR_MESSAGE_DEPTH) return safeString(err);
  if (err && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return extractErrorMessage(errors[errors.length - 1], depth + 1);
    }
  }
  return err instanceof Error ? err.message : safeString(err);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Unknown error';
  }
}
