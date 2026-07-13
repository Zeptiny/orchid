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
import { SubagentStatus } from '../../shared/types/subagent';
import {
  makeAssistantMessage,
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
    const chain = makeEmptyChain(id, selection, agent);

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
    this._resolveWaiters(record);
    this._notify();
  }

  /**
   * Wait for all specified subagents to reach a terminal state.
   */
  async wait(subagentIds: string[]): Promise<Map<string, SubagentRecord>> {
    const pending: Promise<void>[] = [];

    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (!record) continue;

      if (TERMINAL_STATES.has(record.state)) continue;

      const promise = new Promise<void>((resolve) => {
        if (!record._resolveWait) {
          record._resolveWait = [];
        }
        record._resolveWait.push(() => resolve());
      });
      pending.push(promise);
    }

    if (pending.length > 0) {
      await Promise.all(pending);
    }

    const results = new Map<string, SubagentRecord>();
    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (record) {
        results.set(id, record);
      }
    }
    return results;
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
    this._finalizeChain(record, ChainStatus.INTERRUPTED);
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
    return records.map(runtimeToDomain);
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
            break;
          }
          case 'usage': {
            accumulatedUsage = hasUsage(accumulatedUsage)
              ? addUsage(accumulatedUsage, event.usage)
              : { ...event.usage };
            record.usage = accumulatedUsage;
            break;
          }
          case 'tool_call':
          case 'tool_call_start': {
            // Flush any assistant text that arrived before this tool
            if (responseText.trim()) {
              messages.push(makeAssistantMessage(responseText, null));
              responseText = '';
            }
            const toolCallId =
              'toolCallId' in event ? event.toolCallId : randomUUID();
            const toolName =
              'toolName' in event && event.toolName ? event.toolName : 'unknown';
            const args =
              event.type === 'tool_call' && 'args' in event ? event.args : '{}';
            toolNames.set(toolCallId, toolName);
            // Only record tool_call once we have args (tool_call event)
            if (event.type === 'tool_call') {
              messages.push(makeToolCallMessage(toolCallId, toolName, args));
              this._setChainMessages(record, messages);
              this._notify();
            }
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
              messages.push(
                makeToolCallMessage(event.toolCallId, toolName, '{}'),
              );
            }
            messages.push(
              makeToolResultMessage(
                event.toolCallId,
                toolName,
                event.content,
                event.isError,
              ),
            );
            this._setChainMessages(record, messages);
            this._notify();
            break;
          }
          case 'error': {
            throw new Error(event.detail || event.title || 'Subagent stream error');
          }
          case 'finish':
          case 'thinking':
          case 'step_finish':
          case 'tool_call_delta':
          default:
            break;
        }
      }

      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        // cancelOne already finalized; just ensure partial text is kept
        if (responseText.trim() && !TERMINAL_STATES.has(record.state)) {
          messages.push(makeAssistantMessage(responseText, accumulatedUsage));
          this._setChainMessages(record, messages);
        }
        return;
      }

      // Final assistant text with usage on the last bubble
      if (responseText.trim() || accumulatedUsage) {
        messages.push(
          makeAssistantMessage(
            responseText,
            accumulatedUsage && hasUsage(accumulatedUsage)
              ? accumulatedUsage
              : null,
          ),
        );
      }

      record.result = resultText || record.result;
      record.usage = accumulatedUsage;
      this._setChainMessages(record, messages);
      this.markCompleted(record.id, record.result ?? '');
    } catch (err) {
      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        return;
      }
      // Keep partial content
      if (responseText.trim()) {
        messages.push(makeAssistantMessage(responseText, accumulatedUsage));
        this._setChainMessages(record, messages);
      }
      const message = err instanceof Error ? err.message : String(err);
      record.usage = accumulatedUsage;
      this.markFailed(record.id, message);
    } finally {
      record.abortController = null;
    }
  }

  private _setChainMessages(record: SubagentRecord, messages: Message[]): void {
    if (!record.chain) {
      record.chain = makeEmptyChain(record.id, record.selection, record.agent);
    }
    record.chain = {
      ...record.chain,
      messages: [...messages],
      status: ChainStatus.ACTIVE,
    };
  }

  private _finalizeChain(record: SubagentRecord, status: ChainStatus): void {
    if (!record.chain) {
      record.chain = makeEmptyChain(record.id, record.selection, record.agent);
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

  private _notify(): void {
    try {
      this._onChange?.(this.allRecords());
    } catch (err) {
      console.debug('Subagent onChange listener failed (non-fatal):', err);
    }
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────

/** Map runtime record → domain SubagentRecord for session JSON. */
export function runtimeToDomain(record: SubagentRecord): DomainSubagentRecord {
  const statusMap: Record<SubagentState, DomainSubagentRecord['status']> = {
    [SubagentState.PENDING]: SubagentStatus.PENDING,
    [SubagentState.RUNNING]: SubagentStatus.RUNNING,
    [SubagentState.COMPLETED]: SubagentStatus.COMPLETED,
    [SubagentState.FAILED]: SubagentStatus.FAILED,
    [SubagentState.INTERRUPTED]: SubagentStatus.INTERRUPTED,
  };

  const chain =
    record.chain ??
    makeEmptyChain(record.id, record.selection, record.agent);

  return {
    id: record.id,
    agent_name: record.agent.name || record.label,
    agent_type: record.agent.type || 'subagent',
    agent_tier: record.agent.tier || 'bloom',
    task: record.task,
    status: statusMap[record.state],
    chain_id: chain.id,
    start_time: new Date(record.startTime).toISOString(),
    end_time: record.endTime ? new Date(record.endTime).toISOString() : null,
    result: record.result,
    error: record.error,
    parentChainIndex: record.parentChainIndex,
    chain,
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
