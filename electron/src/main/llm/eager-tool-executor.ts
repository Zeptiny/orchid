/**
 * Eager tool execution coordinator.
 *
 * The AI SDK defers every tool call's `execute` until the model finishes the
 * whole step (`model-call-end`), then runs them via `Promise.all` — even though
 * each tool's input is streamed incrementally. This coordinator lets a tool
 * start executing as soon as its own input is available, overlapping execution
 * with the generation of subsequent tool calls in the same step.
 *
 * Two trigger paths feed the same idempotent memoization:
 * - Delta reconstruction (primary): the stream loop accumulates
 *   `tool-input-delta` text and calls `start()` once the input is complete
 *   (`tool-input-end`, or the next tool / text / step boundary as a backstop).
 * - `tool-input-available`: the stream loop also calls `start()` on the SDK's
 *   validated input part. Whichever signal arrives first wins.
 *
 * Mechanism (pre-execution memoization):
 * - `buildToolMap` registers a launcher per internal tool name, bound to the
 *   correct registry and frozen dispatch options.
 * - `start()` is a fire-and-forget wrapper over `getOrStart()`, which invokes
 *   the launcher and stores the in-flight promise keyed by `toolCallId`.
 * - The tool's SDK `execute` shim calls `getOrStart()` when the SDK reaches
 *   `model-call-end`: it awaits the already-running promise if an earlier
 *   trigger won the race, or starts the execution itself if it runs first.
 *   Either way exactly one execution happens. With no launcher registered it
 *   returns `undefined` and the shim falls back to a normal `executeToolCall`.
 *
 * The coordinator owns no execution logic — `executeToolCall` is unchanged.
 */
import type { ToolExecutionResult } from '../../shared/types/tool-result';

/** Starts a tool execution; returns the in-flight result promise. */
export type EagerToolLauncher = (
  toolCallId: string,
  input: unknown,
) => Promise<ToolExecutionResult>;

export class EagerToolExecutor {
  /** Launchers keyed by internal tool name (MCP names are pre-normalized). */
  private readonly launchers = new Map<string, EagerToolLauncher>();
  /** In-flight executions keyed by toolCallId. */
  private readonly inflight = new Map<string, Promise<ToolExecutionResult>>();

  /** Register the launcher for one internal tool name (last registration wins). */
  registerLauncher(internalToolName: string, launcher: EagerToolLauncher): void {
    this.launchers.set(internalToolName, launcher);
  }

  /**
   * Begin executing a tool call from the stream loop (fire-and-forget). Delegates
   * to `getOrStart`, so a later `execute` shim call awaits the same run.
   */
  start(toolCallId: string, internalToolName: string, input: unknown): void {
    this.getOrStart(toolCallId, internalToolName, input);
  }

  /**
   * Return the single memoized execution promise for a tool call, creating it via
   * the launcher on first call. Both the stream loop (`start`) and the tool's
   * `execute` shim call this, so whichever runs first owns the execution and the
   * other awaits it — guaranteeing exactly one run regardless of their ordering.
   *
   * Returns `undefined` when no launcher is registered (unknown or
   * provider-executed tool), signalling the caller to fall back to a direct
   * `executeToolCall`. Synchronous launcher failures are captured as a rejected
   * promise so they surface through the SDK's normal error path.
   */
  getOrStart(
    toolCallId: string,
    internalToolName: string,
    input: unknown,
  ): Promise<ToolExecutionResult> | undefined {
    const existing = this.inflight.get(toolCallId);
    if (existing) return existing;
    const launcher = this.launchers.get(internalToolName);
    if (!launcher) return undefined;
    let promise: Promise<ToolExecutionResult>;
    try {
      promise = launcher(toolCallId, input);
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.inflight.set(toolCallId, promise);
    return promise;
  }
}
