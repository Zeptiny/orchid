/**
 * Event-driven bridge between normalized provider tool-input notifications and
 * Orchid's eager tool executor.
 *
 * This deliberately does not understand AI SDK part shapes. The orchestrator
 * normalizes those parts, while this class owns the stateful concerns that
 * otherwise make the stream loop hard to reason about: incremental JSON input,
 * eager launch/completion queues, SDK reconciliation, and call/result dedup.
 */
import type { ToolExecutionResult } from '../../../shared/types/tool-result';
import { EagerToolExecutor } from '../eager-tool-executor';

export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  args: string;
};

export type PendingToolResult = {
  toolCallId: string;
  content: string;
  execution: ToolExecutionResult;
};

export type EagerToolBridgeEvent =
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: string }
  | { type: 'tool_result'; toolCallId: string; content: string; execution: ToolExecutionResult };

export interface EagerToolBridgeOptions {
  eager: EagerToolExecutor;
  /** The current attempt signal, frozen when the bridge is constructed. */
  abortSignal: AbortSignal;
  /** Keep the stream watchdog paused while an eagerly-started tool runs. */
  pauseIdleForTool: () => void;
  /** Balance one prior pause once the corresponding tool run settles. */
  resumeIdleAfterTool: () => void;
  /** Tell retry handling that a user-visible tool event was delivered. */
  markDeliveredOutput: () => void;
}

type PendingToolInput = { toolName: string; text: string };

/**
 * Coordinates eager executions for exactly one provider stream attempt.
 *
 * `EagerToolExecutor` remains the exactly-once primitive. This bridge only
 * decides when an input is complete and turns settled eager promises into
 * ordered renderer events.
 */
export class EagerToolBridge {
  private readonly pendingInputs = new Map<string, PendingToolInput>();
  private activeInputId: string | null = null;
  private readonly eagerStarts: PendingToolCall[] = [];
  private readonly eagerCompletions: PendingToolResult[] = [];
  private readonly pendingToolCalls: PendingToolCall[] = [];
  private readonly pendingToolResults: PendingToolResult[] = [];
  private readonly seenToolCallIds = new Set<string>();
  private readonly seenToolResultIds = new Set<string>();
  private readonly pausedToolCallIds = new Set<string>();
  private readonly resumedToolCallIds = new Set<string>();
  private readonly eagerPromises = new Set<Promise<ToolExecutionResult>>();

  constructor(private readonly options: EagerToolBridgeOptions) {}

  /** Start receiving one normalized streamed tool input. */
  inputStarted(toolCallId: string, toolName: string): void {
    if (this.activeInputId && this.activeInputId !== toolCallId) {
      this.finalizeInput(this.activeInputId);
    }
    this.pendingInputs.set(toolCallId, { toolName, text: '' });
    this.activeInputId = toolCallId;
  }

  /** Append a normalized JSON text fragment for one streamed tool input. */
  inputDelta(toolCallId: string, argsDelta: string): void {
    const pending = this.pendingInputs.get(toolCallId);
    if (pending) pending.text += argsDelta;
  }

  /** Finalize one tool when its provider sends an explicit input end. */
  inputEnded(toolCallId: string): void {
    this.finalizeInput(toolCallId);
  }

  /** Provider began another content kind, so finish the active input as a backstop. */
  flushActiveInput(): void {
    if (this.activeInputId) this.finalizeInput(this.activeInputId);
  }

  /**
   * Reconcile a normalized SDK call event. It is returned rather than queued so
   * callers can preserve the provider's exact event ordering.
   */
  sdkToolCall(input: {
    toolCallId: string;
    toolName: string;
    args: string;
    rawInput: unknown;
    providerExecuted: boolean;
    invalid: boolean;
  }): EagerToolBridgeEvent | undefined {
    if (this.seenToolCallIds.has(input.toolCallId)) return undefined;
    this.seenToolCallIds.add(input.toolCallId);
    this.pauseIdleForTool(input.toolCallId);
    this.options.markDeliveredOutput();
    if (!input.providerExecuted && !input.invalid) {
      this.options.eager.start(
        input.toolCallId,
        input.toolName,
        input.rawInput,
        this.options.abortSignal,
      );
    }
    return {
      type: 'tool_call',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    };
  }

  /** Reconcile a normalized successful SDK result event. */
  sdkToolResult(
    toolCallId: string,
    execution: ToolExecutionResult,
  ): EagerToolBridgeEvent | undefined {
    this.resumeIdleAfterTool(toolCallId);
    this.options.eager.forget(toolCallId);
    return this.toResultEvent(toolCallId, execution);
  }

  /** Reconcile a normalized SDK error result event. */
  sdkToolError(
    toolCallId: string,
    execution: ToolExecutionResult,
  ): EagerToolBridgeEvent | undefined {
    return this.sdkToolResult(toolCallId, execution);
  }

  /** Reconcile an invalid SDK input without ever launching a new tool. */
  sdkInputError(input: {
    toolCallId: string;
    toolName: string;
    args: string;
    execution: ToolExecutionResult;
  }): EagerToolBridgeEvent[] {
    this.options.eager.forget(input.toolCallId);
    const events: EagerToolBridgeEvent[] = [];
    if (!this.seenToolCallIds.has(input.toolCallId)) {
      this.seenToolCallIds.add(input.toolCallId);
      this.options.markDeliveredOutput();
      events.push({
        type: 'tool_call',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
      });
    }
    const result = this.toResultEvent(input.toolCallId, input.execution);
    if (result) events.push(result);
    return events;
  }

  /** Add onStepFinish fallback data; `drainEvents` deduplicates it with SDK parts. */
  queuePendingToolCall(call: PendingToolCall): void {
    this.pendingToolCalls.push(call);
  }

  /** Add onStepFinish fallback data; `drainEvents` deduplicates it with SDK parts. */
  queuePendingToolResult(result: PendingToolResult): void {
    this.pendingToolResults.push(result);
  }

  get hasPendingFallbackEvents(): boolean {
    return this.pendingToolCalls.length > 0 || this.pendingToolResults.length > 0;
  }

  /** Drain eager and step-fallback renderer events in their established order. */
  *drainEvents(): Generator<EagerToolBridgeEvent> {
    yield* this.drainEagerStarts();
    while (this.eagerCompletions.length > 0) {
      const completion = this.eagerCompletions.shift()!;
      const result = this.toResultEvent(completion.toolCallId, completion.execution);
      if (result) yield result;
    }
    while (this.pendingToolCalls.length > 0) {
      const call = this.pendingToolCalls.shift()!;
      if (this.seenToolCallIds.has(call.toolCallId)) continue;
      this.seenToolCallIds.add(call.toolCallId);
      yield { type: 'tool_call', ...call };
    }
    while (this.pendingToolResults.length > 0) {
      const result = this.pendingToolResults.shift()!;
      const event = this.toResultEvent(result.toolCallId, result.execution, false);
      if (event) yield event;
    }
  }

  /** Drain only finalized eager starts, preserving an incoming start part's lifecycle. */
  *drainEagerStarts(): Generator<EagerToolBridgeEvent> {
    while (this.eagerStarts.length > 0) {
      const start = this.eagerStarts.shift()!;
      if (this.seenToolCallIds.has(start.toolCallId)) continue;
      this.seenToolCallIds.add(start.toolCallId);
      this.options.markDeliveredOutput();
      yield { type: 'tool_call', ...start };
    }
  }

  /** Finish an unterminated input before the attempt ends. */
  dispose(): void {
    this.flushActiveInput();
  }

  /**
   * Finish pending input and wait for already-launched eager executions to
   * enqueue their final renderer events. The SDK normally waits for the same
   * executions at step end; this is the terminal backstop for sparse streams.
   */
  async flush(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.eagerPromises]);
  }

  private finalizeInput(toolCallId: string): void {
    const pending = this.pendingInputs.get(toolCallId);
    if (!pending) return;
    this.pendingInputs.delete(toolCallId);
    if (this.activeInputId === toolCallId) this.activeInputId = null;
    let input: unknown;
    try {
      input = JSON.parse(pending.text);
    } catch {
      // The SDK's validation / tool-input-error path owns malformed JSON.
      return;
    }
    const promise = this.options.eager.getOrStart(
      toolCallId,
      pending.toolName,
      input,
      this.options.abortSignal,
    );
    if (!promise) return;
    this.eagerPromises.add(promise);
    this.pauseIdleForTool(toolCallId);
    this.eagerStarts.push({
      toolCallId,
      toolName: pending.toolName,
      args: JSON.stringify(input),
    });
    promise
      .then((execution) => {
        this.eagerCompletions.push({ toolCallId, ...streamResultFields(execution) });
      })
      .catch(() => {
        // executeToolCall normally resolves terminal executions; SDK owns rejects.
      })
      .finally(() => {
        this.eagerPromises.delete(promise);
        this.resumeIdleAfterTool(toolCallId);
      });
  }

  private pauseIdleForTool(toolCallId: string): void {
    if (this.pausedToolCallIds.has(toolCallId)) return;
    this.pausedToolCallIds.add(toolCallId);
    this.options.pauseIdleForTool();
  }

  private resumeIdleAfterTool(toolCallId: string): void {
    if (
      !this.pausedToolCallIds.has(toolCallId) ||
      this.resumedToolCallIds.has(toolCallId)
    ) return;
    this.resumedToolCallIds.add(toolCallId);
    this.options.resumeIdleAfterTool();
  }

  private toResultEvent(
    toolCallId: string,
    execution: ToolExecutionResult,
    markDelivered = true,
  ): EagerToolBridgeEvent | undefined {
    if (this.seenToolResultIds.has(toolCallId)) return undefined;
    this.seenToolResultIds.add(toolCallId);
    if (markDelivered) this.options.markDeliveredOutput();
    return { type: 'tool_result', toolCallId, ...streamResultFields(execution) };
  }
}

export function streamResultFields(
  execution: ToolExecutionResult,
): Omit<PendingToolResult, 'toolCallId'> {
  return { content: execution.agentProjection.content, execution };
}
