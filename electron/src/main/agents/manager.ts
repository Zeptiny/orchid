/**
 * SubagentManager — runtime manager for subagent lifecycle.
 *
 * Provides:
 * - spawn(name, task, agent, options): SubagentRecord (starts run when runner set)
 * - wait(subagentIds): Promise of terminal records
 * - cancelOne / cancelAll / cancelRunning
 * - getStates / allRecords / getRecord
 *
 * Ported from Python `src/orchid/agents/manager.py` (SubagentManager).
 *
 * When a stream runner is configured (production), spawn fire-and-forgets an
 * isolated LLM stream, accumulates messages + token usage on the subagent
 * chain, and notifies listeners so the session can persist `subagent_chains`.
 * Tests leave the runner unset and drive completion via markCompleted/markFailed.
 */

import { randomUUID } from 'node:crypto';
import type { Agent } from '../../shared/types/agent';
import type { Chain } from '../../shared/types/chain';
import { ChainStatus } from '../../shared/types/chain';
import type { ModelSelection } from '../../shared/types/provider';
import type { Message, Usage } from '../../shared/types/message';
import { MessageType } from '../../shared/types/message';
import type { StreamEvent } from '../llm/orchestrator';
import type { ProjectRuntime } from '../project/runtime';
import { addUsage, hasUsage } from '../../shared/usage';
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import {
  SubagentStatus,
  type SubagentLiveChange,
  type SubagentLiveProjection,
  type SubagentToolSnapshot,
} from '../../shared/types/subagent';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../llm/message-factories';

// ── Enums ───────────────────────────────────────────────────────────────────

export const SubagentState = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const;

export type SubagentState = (typeof SubagentState)[keyof typeof SubagentState];

/** Terminal states — subagents in these states cannot be cancelled. */
const TERMINAL_STATES = new Set<SubagentState>([
  SubagentState.COMPLETED,
  SubagentState.FAILED,
  SubagentState.INTERRUPTED,
]);

// ── Stream runner ───────────────────────────────────────────────────────────

/** Production stream driver (wired from subagent-runner.ts). */
export type SubagentStreamRunner = (params: {
  task: string;
  agent: Agent;
  selection: ModelSelection | null;
  abortSignal: AbortSignal;
  sessionId?: string;
  /** Frozen parent-turn workspace cwd (do not re-resolve live session). */
  cwd?: string;
  /** This subagent's scope id (record.id) for todos / bg / prompt isolation. */
  agentScopeId: string;
  /** Durable child-chain and turn identifiers for provider attempt attribution. */
  chainId?: string;
  turnId?: string;
  /** Immutable parent project snapshot for config, tools, and definitions. */
  projectRuntime?: ProjectRuntime;
}) => AsyncGenerator<StreamEvent>;

export type SubagentChangeListener = (records: readonly SubagentRecord[]) => void;
export type SubagentLiveChangeListener = (change: SubagentLiveChange) => void;

/** Default max time `wait_for_subagent` will block (5 minutes). */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/**
 * Thrown by `SubagentManager.wait` when the wait budget elapses while any
 * target is still non-terminal. Subagents are not cancelled.
 */
export class SubagentWaitTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly statusSnapshot: string[];

  constructor(timeoutMs: number, statusSnapshot: string[]) {
    const seconds = Math.round(timeoutMs / 1000);
    super(
      `Wait timed out after ${seconds}s with no completion. ` +
        `Subagents are still running (${statusSnapshot.join('; ')}). ` +
        `Only the wait tool stopped waiting; they were not cancelled or interrupted. ` +
        `Call wait_for_subagent again or interrupt_subagents to stop them.`,
    );
    this.name = 'SubagentWaitTimeoutError';
    this.timeoutMs = timeoutMs;
    this.statusSnapshot = statusSnapshot;
  }
}

// ── SubagentRecord ──────────────────────────────────────────────────────────

export interface SubagentRecord {
  /** Unique subagent identifier. */
  readonly id: string;
  /** The agent configuration used. */
  readonly agent: Agent;
  /** Current state. */
  state: SubagentState;
  /** Display label. */
  readonly label: string;
  /** Task description. */
  readonly task: string;
  /** Result text (populated on completion). */
  result: string | null;
  /** Error message (populated on failure). */
  error: string | null;
  /** Start time (epoch ms). */
  readonly startTime: number;
  /** End time (epoch ms, null if still running). */
  endTime: number | null;
  /** The chain associated with this subagent (for persistence). */
  chain: Chain | null;
  /** Aggregate token usage across the subagent's stream (also on messages). */
  usage: Usage | null;
  /** Frozen connection-scoped model selection (null = provider-required). */
  readonly selection: ModelSelection | null;
  /** Parent chain index (for attribution). */
  readonly parentChainIndex: number | null;
  /**
   * Owning session id for chain persistence.
   * Required so onChange sync writes to the correct session after a switch
   * (global manager + getActive() would otherwise attach chains to the new session).
   */
  readonly sessionId: string | null;
  readonly projectRuntime?: ProjectRuntime;
  /** Abort controller for the in-flight run. */
  abortController: AbortController | null;
  /** Pending completion promise resolvers. */
  _resolveWait: Array<(record: SubagentRecord) => void> | null;
  /** In-flight run promise (for debugging / optional await). */
  _runPromise: Promise<void> | null;
  /** Runtime-only live projection; durable history remains in `chain`. */
  live: SubagentLiveProjection;
  _liveCommittedSegmentCount: number;
  _liveTerminalEmitted: boolean;
}

// ── SubagentResult ──────────────────────────────────────────────────────────

export interface SubagentResult {
  id: string;
  state: SubagentState;
  result: string | null;
  error: string | null;
  elapsed: number | null;
}

// ── SubagentManager ─────────────────────────────────────────────────────────

/**
 * SubagentManager — manages the lifecycle of subagent runs.
 *
 * Spawn subagents, wait for their completion, cancel them, and query
 * their states. Mirrors Python's SubagentManager API.
 */
export class SubagentManager {
  private _subagents: Map<string, SubagentRecord> = new Map();
  private _runner: SubagentStreamRunner | null = null;
  private _onChange: SubagentChangeListener | null = null;
  private _onLiveChange: SubagentLiveChangeListener | null = null;

  /**
   * Configure the stream runner. When set, spawn() starts a background run.
   * Leave unset in unit tests that call markCompleted manually.
   */
  setRunner(runner: SubagentStreamRunner | null): void {
    this._runner = runner;
  }

  /** Register a listener invoked after any state/message change. */
  setOnChange(listener: SubagentChangeListener | null): void {
    this._onChange = listener;
  }

  /** Subscribe to ordered, low-latency changes for active subagent runs. */
  setOnLiveChange(listener: SubagentLiveChangeListener | null): void {
    this._onLiveChange = listener;
  }

  /**
   * Spawn a new subagent.
   *
   * Returns the record immediately. If a runner is configured, starts the
   * isolated LLM stream in the background (matching Python asyncio.create_task).
   */
  spawn(
    name: string,
    task: string,
    agent: Agent,
    options: {
      selection?: ModelSelection | null;
      parentChainIndex?: number;
      sessionId?: string;
      /** Frozen parent-turn workspace cwd for tools/prompt. */
      cwd?: string;
      /** Immutable parent project snapshot. */
      projectRuntime?: ProjectRuntime;
    } = {},
  ): SubagentRecord {
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const userMessage = makeUserMessage(task);
    const selection = options.selection ?? null;
    const chain = makeEmptyChain(options.sessionId ?? '', selection, agent);

    const record: SubagentRecord = {
      id,
      agent,
      state: SubagentState.PENDING,
      label: name,
      task,
      result: null,
      error: null,
      startTime: Date.now(),
      endTime: null,
      chain: {
        ...chain,
        messages: [userMessage],
      },
      usage: null,
      selection,
      parentChainIndex: options.parentChainIndex ?? null,
      sessionId: options.sessionId ?? null,
      projectRuntime: options.projectRuntime,
      abortController: null,
      _resolveWait: [],
      _runPromise: null,
      live: makeLiveProjection(id, options.sessionId ?? null, 'pending'),
      _liveCommittedSegmentCount: 0,
      _liveTerminalEmitted: false,
    };

    this._subagents.set(id, record);
    this._notify();

    if (this._runner) {
      record._runPromise = this._startRun(record, options.cwd);
    }

    return record;
  }

  /**
   * Mark a subagent as running (called when the actor starts).
   */
  markRunning(subagentId: string): void {
    const record = this._subagents.get(subagentId);
    if (record && record.state === SubagentState.PENDING) {
      record.state = SubagentState.RUNNING;
      this._updateLive(record, { state: SubagentState.RUNNING });
      this._notify();
    }
  }

  /**
   * Mark a subagent as completed with a result.
   * Resolves any pending `wait()` promises.
   */
  markCompleted(subagentId: string, result: string): void {
    const record = this._subagents.get(subagentId);
    if (!record || TERMINAL_STATES.has(record.state)) return;

    record.state = SubagentState.COMPLETED;
    record.result = result;
    record.endTime = Date.now();
    this._finalizeChain(record, ChainStatus.COMPLETED);
    this._finishLive(record, SubagentState.COMPLETED);
    this._resolveWaiters(record);
    this._notify();
  }

  /**
   * Mark a subagent as failed with an error.
   * Resolves any pending `wait()` promises.
   */
  markFailed(subagentId: string, error: string): void {
    const record = this._subagents.get(subagentId);
    if (!record || TERMINAL_STATES.has(record.state)) return;

    record.state = SubagentState.FAILED;
    record.error = error;
    record.endTime = Date.now();
    this._finalizeChain(record, ChainStatus.FAILED);
    this._finishLive(record, SubagentState.FAILED);
    this._resolveWaiters(record);
    this._notify();
  }

  /**
   * Wait for all specified subagents to reach a terminal state.
   *
   * Optional `timeoutMs` races the wait without cancelling subagents.
   * Optional `signal` unblocks the wait when the parent turn is aborted
   * (children keep running unless separately cancelled).
   *
   * @throws {SubagentWaitTimeoutError} when `timeoutMs` elapses with any
   *   non-terminal target still running
   * @throws {DOMException} (`AbortError`) when `signal` aborts first
   */
  async wait(
    subagentIds: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Map<string, SubagentRecord>> {
    const { timeoutMs, signal } = options;

    if (signal?.aborted) {
      throw new DOMException('Wait aborted', 'AbortError');
    }

    const pending: Promise<void>[] = [];
    const waiterCleanups: Array<() => void> = [];

    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (!record) continue;

      if (TERMINAL_STATES.has(record.state)) continue;

      const promise = new Promise<void>((resolve) => {
        if (!record._resolveWait) {
          record._resolveWait = [];
        }
        const entry = () => resolve();
        record._resolveWait.push(entry);
        waiterCleanups.push(() => {
          if (!record._resolveWait) return;
          const idx = record._resolveWait.indexOf(entry);
          if (idx >= 0) record._resolveWait.splice(idx, 1);
          if (record._resolveWait.length === 0) {
            record._resolveWait = null;
          }
        });
      });
      pending.push(promise);
    }

    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
          };

          void Promise.all(pending).then(
            () => settle(() => resolve()),
            (err: unknown) => settle(() => reject(err)),
          );

          if (timeoutMs !== undefined && timeoutMs >= 0) {
            timer = setTimeout(() => {
              settle(() => {
                reject(
                  new SubagentWaitTimeoutError(
                    timeoutMs,
                    this._statusSnapshot(subagentIds),
                  ),
                );
              });
            }, timeoutMs);
            if (typeof timer === 'object' && timer && 'unref' in timer) {
              (timer as NodeJS.Timeout).unref();
            }
          }

          if (signal) {
            onAbort = () => {
              settle(() => reject(new DOMException('Wait aborted', 'AbortError')));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      } catch (err) {
        // Timed out or aborted: detach this wait's resolvers only.
        // Subagents keep their current state (still RUNNING, etc.).
        for (const cleanup of waiterCleanups) cleanup();
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    }

    return this._collectRecords(subagentIds);
  }

  private _collectRecords(subagentIds: string[]): Map<string, SubagentRecord> {
    const results = new Map<string, SubagentRecord>();
    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (record) {
        results.set(id, record);
      }
    }
    return results;
  }

  /** Per-id status lines for wait timeout / abort diagnostics. */
  private _statusSnapshot(subagentIds: string[]): string[] {
    const lines: string[] = [];
    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (!record) {
        lines.push(`${id}: not_found`);
        continue;
      }
      const elapsed = record.endTime
        ? record.endTime - record.startTime
        : Date.now() - record.startTime;
      lines.push(
        `${id}: ${record.state} name="${record.label}" elapsed_ms=${elapsed}`,
      );
    }
    return lines;
  }

  /**
   * Cancel a single subagent by ID.
   */
  cancelOne(subagentId: string): boolean {
    const record = this._subagents.get(subagentId);
    if (!record || TERMINAL_STATES.has(record.state)) {
      return false;
    }

    record.state = SubagentState.INTERRUPTED;
    record.error = record.error ?? 'Interrupted by user';
    record.endTime = record.endTime ?? Date.now();
    record.abortController?.abort();
    // The runner owns the async interruption boundary. It must materialize its
    // partial live tail before the terminal projection is emitted; otherwise
    // the terminal event can make the renderer flush an incomplete record.
    if (!record._runPromise) {
      this._finalizeChain(record, ChainStatus.INTERRUPTED);
      this._finishLive(record, SubagentState.INTERRUPTED);
    }
    this._resolveWaiters(record);
    this._notify();
    return true;
  }

  cancelAll(): string[] {
    const cancelled: string[] = [];
    for (const [id] of this._subagents) {
      if (this.cancelOne(id)) {
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  /**
   * Cancel non-terminal subagents.
   *
   * @param sessionId - When provided, only cancel subagents owned by that
   *   session. When omitted, cancel all running (Esc interrupt / session switch).
   */
  cancelRunning(sessionId?: string | null): string[] {
    const cancelled: string[] = [];
    for (const [id, record] of this._subagents) {
      if (sessionId !== undefined && sessionId !== null && record.sessionId !== sessionId) {
        continue;
      }
      if (!TERMINAL_STATES.has(record.state)) {
        if (this.cancelOne(id)) {
          cancelled.push(id);
        }
      }
    }
    return cancelled;
  }

  flushStateCallbacks(): string[] {
    const flushed: string[] = [];

    for (const record of this._subagents.values()) {
      if (record._resolveWait && record._resolveWait.length > 0) {
        for (const resolve of record._resolveWait) {
          resolve(record);
        }
        record._resolveWait = null;
        flushed.push(record.id);
      }
    }

    return flushed;
  }

  getStates(sessionId?: string | null): Array<{
    id: string;
    name: string;
    type: string;
    task: string;
    state: SubagentState;
    elapsed: number | null;
  }> {
    const states: Array<{
      id: string;
      name: string;
      type: string;
      task: string;
      state: SubagentState;
      elapsed: number | null;
    }> = [];

    for (const record of this._subagents.values()) {
      if (sessionId !== undefined && record.sessionId !== sessionId) {
        continue;
      }
      states.push({
        id: record.id,
        name: record.agent.name,
        type: record.agent.type,
        task: record.task,
        state: record.state,
        elapsed: record.endTime
          ? record.endTime - record.startTime
          : record.startTime
            ? Date.now() - record.startTime
            : null,
      });
    }

    return states;
  }

  getRecord(subagentId: string): SubagentRecord | undefined {
    return this._subagents.get(subagentId);
  }

  getLiveProjection(subagentId: string): SubagentLiveProjection | undefined {
    return this._subagents.get(subagentId)?.live;
  }

  getLiveProjections(sessionId?: string | null): SubagentLiveProjection[] {
    return this.allRecords()
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .map((record) => record.live);
  }

  allRecords(): SubagentRecord[] {
    return Array.from(this._subagents.values());
  }

  /**
   * Convert runtime records to domain SubagentRecords for session storage.
   *
   * @param sessionId - When provided, only include records owned by that session.
   */
  toDomainRecords(sessionId?: string | null): DomainSubagentRecord[] {
    const records =
      sessionId === undefined
        ? this.allRecords()
        : this.allRecords().filter((r) => r.sessionId === sessionId);
    return records.map((record) => runtimeToDomain(record));
  }

  // ── Private: run loop ─────────────────────────────────────────────────────

  private async _startRun(
    record: SubagentRecord,
    cwd?: string,
  ): Promise<void> {
    const runner = this._runner;
    if (!runner) return;

    if (TERMINAL_STATES.has(record.state)) return;

    const abort = new AbortController();
    record.abortController = abort;
    this.markRunning(record.id);

    const messages: Message[] = [...(record.chain?.messages ?? [])];
    let responseText = '';
    let resultText = '';
    let accumulatedUsage: Usage | null = null;
    // Track open tool calls for result pairing in the chain
    const toolNames = new Map<string, string>();

    try {
      const stream = runner({
        task: record.task,
        agent: record.agent,
        selection: record.selection,
        abortSignal: abort.signal,
        sessionId: record.sessionId ?? undefined,
        cwd,
        agentScopeId: record.id,
        chainId: record.chain?.id,
        turnId: record.id,
        projectRuntime: record.projectRuntime,
      });

      for await (const event of stream) {
        if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
          break;
        }

        switch (event.type) {
          case 'content': {
            responseText += event.text;
            resultText += event.text;
            this._appendLiveText(record, 'text', event.text);
            break;
          }
          case 'usage': {
            accumulatedUsage = hasUsage(accumulatedUsage)
              ? addUsage(accumulatedUsage, event.usage)
              : { ...event.usage };
            record.usage = accumulatedUsage;
            this._updateLive(record, { usage: accumulatedUsage });
            break;
          }
          case 'thinking': {
            this._appendLiveText(record, 'thinking', event.text);
            break;
          }
          case 'tool_call':
          case 'tool_call_start': {
            const toolCallId =
              'toolCallId' in event ? event.toolCallId : randomUUID();
            const toolName =
              'toolName' in event && event.toolName ? event.toolName : 'unknown';
            const args =
              event.type === 'tool_call' && 'args' in event ? event.args : '{}';
            toolNames.set(toolCallId, toolName);
            this._ensureLiveTool(record, toolCallId, toolName);
            // Only record tool_call once we have args (tool_call event)
            if (event.type === 'tool_call') {
              const toolSegment = record.live.segments.find(
                (segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId,
              );
              const toolIndex = toolSegment
                ? record.live.segments.indexOf(toolSegment)
                : record.live.segments.length;
              this._commitLiveSegments(record, messages, toolIndex);
              this._updateLiveTool(record, toolCallId, {
                status: 'running',
                args,
                partialArgs: args,
              });
              messages.push(makeToolCallMessage(toolCallId, toolName, args, toolSegment?.id));
              this._markLiveCommitted(record);
              this._setChainMessages(record, messages);
              this._notify();
            }
            break;
          }
          case 'tool_call_delta': {
            const current = record.live.toolCalls.find(
              (tool) => tool.toolCallId === event.toolCallId,
            );
            this._ensureLiveTool(record, event.toolCallId, current?.toolName ?? 'unknown');
            this._updateLiveTool(record, event.toolCallId, {
              partialArgs: `${current?.partialArgs ?? ''}${event.argsDelta}`,
            });
            break;
          }
          case 'tool_result': {
            const toolName = toolNames.get(event.toolCallId) ?? 'unknown';
            // Ensure a tool_call exists (start-only path)
            if (!messages.some(
              (m) =>
                m.type === MessageType.TOOL_CALL &&
                m.tool_call_id === event.toolCallId,
            )) {
              const toolSegment = record.live.segments.find(
                (segment) => segment.kind === 'tool' && segment.toolCallId === event.toolCallId,
              );
              messages.push(
                makeToolCallMessage(event.toolCallId, toolName, '{}', toolSegment?.id),
              );
            }
            messages.push(
              makeToolResultMessage(
                event.toolCallId,
                toolName,
                event.content,
                event.execution.canonical,
                `${event.toolCallId}:result`,
              ),
            );
            this._updateLiveTool(record, event.toolCallId, {
              status: event.execution.canonical.status,
              content: event.content,
              toolResult: event.execution.canonical,
              finishedAt: new Date().toISOString(),
            });
            this._markLiveCommitted(record);
            this._setChainMessages(record, messages);
            this._notify();
            break;
          }
          case 'error': {
            throw new Error(event.detail || event.title || 'Subagent stream error');
          }
          case 'finish':
          case 'step_finish':
          default:
            break;
        }
      }

      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        this._flushPartialOnInterrupt(
          record,
          messages,
          responseText,
          resultText,
          accumulatedUsage,
        );
        return;
      }

      // Commit the remaining live prefix in exactly the order emitted. Segment
      // IDs become message IDs so a durable handoff cannot duplicate bubbles.
      this._commitLiveSegments(record, messages, record.live.segments.length, accumulatedUsage);

      record.result = resultText || record.result;
      record.usage = accumulatedUsage;
      this._setChainMessages(record, messages);
      this._markLiveCommitted(record);
      this.markCompleted(record.id, record.result ?? '');
    } catch (err) {
      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        this._flushPartialOnInterrupt(
          record,
          messages,
          responseText,
          resultText,
          accumulatedUsage,
        );
        return;
      }
      // Keep partial content in the same chronological, ID-stable form as a
      // normal completion. The live projection may already contain both text
      // and thinking, so do not append the accumulator a second time.
      this._commitLiveSegments(record, messages, record.live.segments.length, accumulatedUsage);
      this._setChainMessages(record, messages);
      const message = err instanceof Error ? err.message : String(err);
      record.usage = accumulatedUsage;
      this.markFailed(record.id, message);
    } finally {
      if (record.state === SubagentState.INTERRUPTED) {
        this._finishLive(record, SubagentState.INTERRUPTED);
      }
      record.abortController = null;
    }
  }

  private _flushPartialOnInterrupt(
    record: SubagentRecord,
    messages: Message[],
    responseText: string,
    resultText: string,
    accumulatedUsage: Usage | null,
  ): void {
    this._commitLiveSegments(record, messages, record.live.segments.length, accumulatedUsage);
    if (resultText) {
      record.result = resultText;
    }
    if (accumulatedUsage) {
      record.usage = accumulatedUsage;
    }
    this._setChainMessages(record, messages);
    this._markLiveCommitted(record);
    if (record.state === SubagentState.INTERRUPTED) this._finalizeChain(record, ChainStatus.INTERRUPTED);
    this._notify();
  }

  /** Commit only the live segment prefix before `endIndex`, preserving order. */
  private _commitLiveSegments(
    record: SubagentRecord,
    messages: Message[],
    endIndex: number,
    usage: Usage | null = null,
  ): void {
    const segments = record.live.segments;
    const lastTextIndex = segments
      .slice(record._liveCommittedSegmentCount, endIndex)
      .map((segment, index) => ({ segment, index: record._liveCommittedSegmentCount + index }))
      .filter(({ segment }) => segment.kind === 'text')
      .at(-1)?.index;
    for (let index = record._liveCommittedSegmentCount; index < endIndex; index += 1) {
      const segment = segments[index];
      if (segment.kind === 'text' && segment.content.trim()) {
        messages.push(makeAssistantMessage(
          segment.content,
          usage && index === lastTextIndex ? usage : null,
          segment.id,
        ));
      } else if (segment.kind === 'thinking' && segment.content.trim()) {
        messages.push(makeThinkingMessage(segment.content, segment.id));
      }
    }
    record._liveCommittedSegmentCount = Math.max(record._liveCommittedSegmentCount, endIndex);
  }

  private _setChainMessages(record: SubagentRecord, messages: Message[]): void {
    if (!record.chain) {
      record.chain = makeEmptyChain(
        record.sessionId ?? '',
        record.selection,
        record.agent,
      );
    }
    const prev = record.chain.status;
    const keepTerminal =
      prev === ChainStatus.INTERRUPTED ||
      prev === ChainStatus.FAILED ||
      prev === ChainStatus.COMPLETED;
    record.chain = {
      ...record.chain,
      messages: [...messages],
      status: keepTerminal ? prev : ChainStatus.ACTIVE,
    };
  }

  private _finalizeChain(record: SubagentRecord, status: ChainStatus): void {
    if (!record.chain) {
      record.chain = makeEmptyChain(
        record.sessionId ?? '',
        record.selection,
        record.agent,
      );
    }
    const terminal =
      status === ChainStatus.INTERRUPTED
        ? ChainStatus.INTERRUPTED
        : status === ChainStatus.FAILED
          ? ChainStatus.FAILED
          : ChainStatus.COMPLETED;
    record.chain = {
      ...record.chain,
      status: terminal,
      endTime: new Date().toISOString(),
    };
  }

  private _resolveWaiters(record: SubagentRecord): void {
    if (record._resolveWait) {
      for (const resolve of record._resolveWait) {
        resolve(record);
      }
      record._resolveWait = null;
    }
  }

  private _appendLiveText(record: SubagentRecord, kind: 'text' | 'thinking', content: string): void {
    const segments = [...record.live.segments];
    const last = segments.at(-1);
    if (last?.kind === kind) segments[segments.length - 1] = { ...last, content: last.content + content };
    else segments.push({ kind, id: randomUUID(), content });
    this._updateLive(record, { segments });
  }

  private _ensureLiveTool(record: SubagentRecord, toolCallId: string, toolName: string): void {
    if (record.live.toolCalls.some((tool) => tool.toolCallId === toolCallId)) return;
    const tool: SubagentToolSnapshot = {
      toolCallId, toolName, status: 'generating', partialArgs: '', args: '',
      content: null, toolResult: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    this._updateLive(record, {
      toolCalls: [...record.live.toolCalls, tool],
      segments: [...record.live.segments, { kind: 'tool', id: randomUUID(), toolCallId }],
    });
  }

  private _updateLiveTool(record: SubagentRecord, toolCallId: string, patch: Partial<SubagentToolSnapshot>): void {
    this._updateLive(record, {
      toolCalls: record.live.toolCalls.map((tool) => tool.toolCallId === toolCallId ? { ...tool, ...patch } : tool),
    });
  }

  private _markLiveCommitted(record: SubagentRecord): void {
    record._liveCommittedSegmentCount = record.live.segments.length;
  }

  private _updateLive(
    record: SubagentRecord,
    patch: Partial<Omit<SubagentLiveProjection, 'sequence' | 'subagentId' | 'runId'>>,
  ): void {
    const next: SubagentLiveProjection = {
      ...record.live, ...patch, sequence: record.live.sequence + 1,
      segments: patch.segments ? [...patch.segments] : [...record.live.segments],
      toolCalls: patch.toolCalls ? [...patch.toolCalls] : [...record.live.toolCalls],
    };
    record.live = next;
    const change: SubagentLiveChange = {
      sessionId: next.sessionId, subagentId: next.subagentId, runId: next.runId,
      sequence: next.sequence, projection: next,
    };
    try { this._onLiveChange?.(change); } catch (err) {
      console.debug('Subagent live listener failed (non-fatal):', err);
    }
  }

  private _finishLive(record: SubagentRecord, state: SubagentState): void {
    if (record._liveTerminalEmitted) return;
    record._liveTerminalEmitted = true;
    this._updateLive(record, {
      state, result: record.result, error: record.error, usage: record.usage,
      segments: [], toolCalls: [],
    });
    record._liveCommittedSegmentCount = 0;
  }

  private _notify(): void {
    try {
      this._onChange?.(this.allRecords());
    } catch (err) {
      console.debug('Subagent onChange listener failed (non-fatal):', err);
    }
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────

export interface RuntimeToDomainOptions {
  /** Include the uncommitted live tail in the returned durable chain. */
  includeLiveTail?: boolean;
}

/** Map runtime record → domain SubagentRecord for session JSON. */
export function runtimeToDomain(
  record: SubagentRecord,
  options: RuntimeToDomainOptions = {},
): DomainSubagentRecord {
  const statusMap: Record<SubagentState, DomainSubagentRecord['status']> = {
    [SubagentState.PENDING]: SubagentStatus.PENDING,
    [SubagentState.RUNNING]: SubagentStatus.RUNNING,
    [SubagentState.COMPLETED]: SubagentStatus.COMPLETED,
    [SubagentState.FAILED]: SubagentStatus.FAILED,
    [SubagentState.INTERRUPTED]: SubagentStatus.INTERRUPTED,
  };

  const chain =
    record.chain ??
    makeEmptyChain(record.sessionId ?? '', record.selection, record.agent);
  const checkpointChain = options.includeLiveTail === false
    ? chain
    : materializeLiveTail(record, chain);

  return {
    id: record.id,
    // `label` is the descriptive name supplied to delegate_to_subagent;
    // `agent.name` is only the registry role (for example, "explorer").
    agent_name: record.label || record.agent.name,
    agent_type: record.agent.name || record.agent.type || 'subagent',
    agent_tier: record.agent.tier || 'bloom',
    task: record.task,
    status: statusMap[record.state],
    chain_id: checkpointChain.id,
    start_time: new Date(record.startTime).toISOString(),
    end_time: record.endTime ? new Date(record.endTime).toISOString() : null,
    result: record.result,
    error: record.error,
    parentChainIndex: record.parentChainIndex,
    chain: checkpointChain,
  };
}

/** Materialize only the uncommitted live tail for persistence checkpoints. */
function materializeLiveTail(record: SubagentRecord, chain: Chain): Chain {
  const tail = record.live.segments.slice(record._liveCommittedSegmentCount);
  if (tail.length === 0) return chain;
  const messages = [...chain.messages];
  const lastTextIndex = tail.findLastIndex((segment) => segment.kind === 'text');
  for (const [index, segment] of tail.entries()) {
    if (segment.kind === 'thinking' && segment.content) {
      messages.push(makeThinkingMessage(segment.content, segment.id));
    } else if (segment.kind === 'text' && segment.content) {
      messages.push(makeAssistantMessage(segment.content, index === lastTextIndex ? record.usage : null, segment.id));
    }
  }
  return { ...chain, messages };
}

function makeLiveProjection(
  subagentId: string,
  sessionId: string | null,
  state: SubagentStatus,
): SubagentLiveProjection {
  return {
    sessionId, subagentId, runId: randomUUID(), sequence: 0, state,
    segments: [], toolCalls: [], usage: null, result: null, error: null,
  };
}

// ── Chain factory ───────────────────────────────────────────────────────────

function makeEmptyChain(
  sessionKey: string,
  selection: ModelSelection | null,
  agent: Agent,
): Chain {
  return {
    id: randomUUID(),
    sessionId: sessionKey,
    messages: [],
    status: ChainStatus.ACTIVE,
    selection,
    modelLabel: selection?.modelId ?? null,
    agentName: agent.name,
    agentType: agent.type,
    agentTier: agent.tier,
    subagentRecord: null,
    startTime: new Date().toISOString(),
    endTime: null,
  };
}
