/**
 * Presents AI SDK fullStream and textStream fallback as one Orchid event
 * stream.  It owns the fallback's onStepFinish hand-off, leaving the
 * orchestrator to construct an attempt and decide whether an idle timeout may
 * be retried.
 */
import type { ModelMessage } from 'ai';
import type { Usage } from '../../../shared/types/message';
import type { MCPManager } from '../../mcp/manager';
import type { StreamAttemptController } from './attempt-controller';
import { EagerToolBridge, streamResultFields } from './eager-tool-bridge';
import {
  createToolNameResolver,
  executionFromSdkOutput,
  sdkPreExecutionError,
  SdkEventAdapter,
  streamToolCallId,
  stringifyToolInput,
  type ProviderStepUsage,
  type ToolNameResolver,
} from './sdk-event-adapter';
import type { StreamEvent } from './events';

export interface StreamResultLike {
  fullStream: AsyncIterable<unknown>;
  textStream: AsyncIterable<string>;
  finishReason: PromiseLike<string | undefined>;
}

export interface StepFinishLike {
  usage?: ProviderStepUsage;
  request?: { messages?: readonly ModelMessage[] };
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolResults?: Array<{
    toolCallId: string;
    output?: unknown;
    result?: unknown;
    error?: unknown;
  }>;
  content?: readonly unknown[];
}

export interface NormalizedStreamOptions {
  coreMessages: readonly ModelMessage[];
  mcpManager: MCPManager | null;
  attempt: StreamAttemptController;
  eagerBridge: EagerToolBridge;
  buildUsage: (
    usage: ProviderStepUsage,
    messages: readonly ModelMessage[],
  ) => Usage;
}

type NextText =
  | { kind: 'text'; value: IteratorResult<string> }
  | { kind: 'step-events' };

/**
 * Stateful normalized stream for one provider attempt.
 *
 * `fullStream` remains authoritative whenever it yields a part.  A failure
 * before the first part switches to `textStream`; usage and tool events
 * accumulated by onStepFinish are emitted before the next text delta.
 */
export class NormalizedStream {
  private readonly pendingUsageEvents: Usage[] = [];
  private readonly sdkEvents: SdkEventAdapter;
  private readonly resolveToolName: ToolNameResolver;
  private usedFullStream = false;
  private pendingStepEventsSignaled = false;
  private resolvePendingStepEvents: (() => void) | null = null;

  constructor(private readonly options: NormalizedStreamOptions) {
    this.resolveToolName = createToolNameResolver(options.mcpManager);
    this.sdkEvents = new SdkEventAdapter({
      coreMessages: options.coreMessages,
      resolveToolName: this.resolveToolName,
      attempt: options.attempt,
      eagerBridge: options.eagerBridge,
      buildUsage: options.buildUsage,
    });
  }

  /** AI SDK callback that supplies data only needed by the textStream fallback. */
  readonly onStepFinish = async (step: StepFinishLike): Promise<void> => {
    if (step.usage && !this.usedFullStream) {
      this.pendingUsageEvents.push(this.options.buildUsage(
        step.usage,
        step.request?.messages ?? this.options.coreMessages,
      ));
    }
    this.queueFallbackToolCalls(step.toolCalls);
    this.queueFallbackToolResults(step.toolResults, step.toolCalls);
    this.queueFallbackToolErrors(step.content);
    if (!this.usedFullStream && this.hasPendingStepEvents()) {
      this.notifyPendingStepEvents();
    }
  };

  /** Yield the one normalized Orchid contract from fullStream or its fallback. */
  async *events(result: StreamResultLike): AsyncGenerator<StreamEvent> {
    try {
      yield* this.fullStreamEvents(result.fullStream);
    } catch (error) {
      if (this.mustRethrowFullStreamError()) throw error;
      console.warn('[orchestrator] fullStream failed, falling back to textStream:', error);
      yield* this.textStreamEvents(result.textStream);
    }

    let finishReason: string | undefined;
    try {
      finishReason = await result.finishReason;
    } catch {
      finishReason = undefined;
    }
    await this.options.eagerBridge.flush();
    yield* this.options.eagerBridge.drainEvents();
    if (!this.usedFullStream) yield* this.drainPendingUsageEvents();

    yield { type: 'finish', finishReason: finishReason ?? 'stop' };
    warnOnFinishReason(finishReason);
  }

  private async *fullStreamEvents(fullStream: AsyncIterable<unknown>): AsyncGenerator<StreamEvent> {
    for await (const chunk of fullStream) {
      if (!this.usedFullStream) {
        this.usedFullStream = true;
        this.pendingUsageEvents.length = 0;
      }
      yield* this.sdkEvents.adapt(chunk as Record<string, unknown>);
      yield* this.options.eagerBridge.drainEvents();
    }
  }

  private async *textStreamEvents(textStream: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
    const iterator = textStream[Symbol.asyncIterator]();
    let nextText = this.nextText(iterator);
    let nextStepEvents = this.waitForPendingStepEvents();

    while (true) {
      const next = await Promise.race([nextText, nextStepEvents]);
      if (next.kind === 'step-events') {
        yield* this.options.eagerBridge.drainEvents();
        yield* this.drainPendingUsageEvents();
        nextStepEvents = this.waitForPendingStepEvents();
        continue;
      }
      if (next.value.done) return;
      this.options.attempt.armIdleTimer();
      if (next.value.value) {
        this.options.attempt.markDeliveredOutput();
        yield { type: 'content', text: next.value.value };
      }
      nextText = this.nextText(iterator);
    }
  }

  private queueFallbackToolCalls(calls: StepFinishLike['toolCalls']): void {
    for (const call of calls ?? []) {
      this.options.eagerBridge.queuePendingToolCall({
        toolCallId: call.toolCallId,
        toolName: this.resolveToolName(call.toolName),
        args: stringifyToolInput(call.input),
      });
    }
  }

  private queueFallbackToolResults(
    results: StepFinishLike['toolResults'],
    calls: StepFinishLike['toolCalls'],
  ): void {
    for (const result of results ?? []) {
      const toolName = this.resolveToolName(
        calls?.find((call) => call.toolCallId === result.toolCallId)?.toolName ?? 'unknown',
      );
      const raw = result.output ?? result.result ?? result.error ?? '';
      const execution = result.error != null && result.output == null && result.result == null
        ? sdkPreExecutionError({ error: result.error, toolName })
        : executionFromSdkOutput(raw, toolName);
      this.options.eagerBridge.queuePendingToolResult({
        toolCallId: result.toolCallId,
        ...streamResultFields(execution),
      });
    }
  }

  private queueFallbackToolErrors(content: StepFinishLike['content']): void {
    for (const rawPart of content ?? []) {
      if (!isRecord(rawPart)) continue;
      const part = rawPart;
      const type = String(part.type ?? '');
      if (type !== 'tool-error' && type !== 'tool-input-error') continue;
      const toolCallId = streamToolCallId(part);
      if (!toolCallId) continue;
      const execution = sdkPreExecutionError(part, this.resolveToolName);
      this.options.eagerBridge.queuePendingToolResult({
        toolCallId,
        ...streamResultFields(execution),
      });
    }
  }

  private hasPendingStepEvents(): boolean {
    return this.pendingUsageEvents.length > 0 || this.options.eagerBridge.hasPendingFallbackEvents;
  }

  private notifyPendingStepEvents(): void {
    if (this.pendingStepEventsSignaled) return;
    this.pendingStepEventsSignaled = true;
    this.resolvePendingStepEvents?.();
    this.resolvePendingStepEvents = null;
  }

  private waitForPendingStepEvents(): Promise<NextText> {
    if (this.pendingStepEventsSignaled) {
      this.pendingStepEventsSignaled = false;
      return Promise.resolve({ kind: 'step-events' });
    }
    return new Promise((resolve) => {
      this.resolvePendingStepEvents = () => {
        this.pendingStepEventsSignaled = false;
        resolve({ kind: 'step-events' });
      };
    });
  }

  private nextText(iterator: AsyncIterator<string>): Promise<NextText> {
    return iterator.next().then((value) => ({ kind: 'text', value }));
  }

  private *drainPendingUsageEvents(): Generator<StreamEvent> {
    while (this.pendingUsageEvents.length > 0) {
      yield { type: 'usage', usage: this.pendingUsageEvents.shift()! };
    }
  }

  private mustRethrowFullStreamError(): boolean {
    return this.options.attempt.didIdleTimeout ||
      this.options.attempt.didUserAbort ||
      this.options.attempt.signal.aborted ||
      this.usedFullStream;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function warnOnFinishReason(finishReason: string | undefined): void {
  if (finishReason === 'length') {
    console.warn('[orchestrator] Stream terminated due to max token limit');
  } else if (finishReason === 'content-filter') {
    console.warn('[orchestrator] Stream terminated by content filter');
  }
}
