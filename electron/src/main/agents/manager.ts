/**
 * SubagentManager — runtime manager for subagent lifecycle.
 *
 * Provides a promise-based API over XState subagent actors:
 * - spawn(name, task, type, tier): SubagentRecord
 * - wait(subagentIds): Promise<SubagentResult[]>
 * - cancelOne(subagentId)
 * - cancelAll()
 * - cancelRunning()
 * - getStates(): SubagentState[]
 * - allRecords(): SubagentRecord[]
 *
 * Ported from Python `src/orchid/agents/manager.py` (SubagentManager).
 *
 * Key differences from Python:
 * - Uses XState actors instead of asyncio tasks
 * - Uses Map instead of dict for subagent tracking
 * - Completion/failure tracked via actor snapshots and subscriptions
 * - No ContextVar equivalent — session-scoped via instance state
 */

import type { ActorRefFrom, AnyActorRef } from 'xstate';
import type { Agent } from '../../shared/types/agent';
import type { Chain } from '../../shared/types/chain';

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
  /** Model override (null = use default). */
  readonly model: string | null;
  /** Parent chain index (for attribution). */
  readonly parentChainIndex: number | null;
  /** Reference to the XState actor. */
  actorRef: AnyActorRef | null;
  /** Pending completion promise resolvers. */
  _resolveWait: Array<(record: SubagentRecord) => void> | null;
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
 * SubagentManager — manages the lifecycle of subagent actors.
 *
 * Spawn subagents, wait for their completion, cancel them, and query
 * their states. Mirrors Python's SubagentManager API.
 */
export class SubagentManager {
  private _subagents: Map<string, SubagentRecord> = new Map();

  /**
   * Spawn a new subagent.
   *
   * @param name - Display label for the subagent
   * @param task - Task description (the prompt given to the subagent)
   * @param agent - Agent configuration
   * @param options - Optional overrides (model, parentChainIndex)
   * @returns The SubagentRecord immediately (before completion)
   */
  spawn(
    name: string,
    task: string,
    agent: Agent,
    options: {
      model?: string;
      parentChainIndex?: number;
    } = {},
  ): SubagentRecord {
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      chain: null,
      model: options.model ?? null,
      parentChainIndex: options.parentChainIndex ?? null,
      actorRef: null,
      _resolveWait: [],
    };

    this._subagents.set(id, record);
    return record;
  }

  /**
   * Mark a subagent as running (called when the actor starts).
   */
  markRunning(subagentId: string): void {
    const record = this._subagents.get(subagentId);
    if (record && record.state === SubagentState.PENDING) {
      record.state = SubagentState.RUNNING;
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

    // Resolve pending waiters
    if (record._resolveWait) {
      for (const resolve of record._resolveWait) {
        resolve(record);
      }
      record._resolveWait = null;
    }
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

    // Resolve pending waiters
    if (record._resolveWait) {
      for (const resolve of record._resolveWait) {
        resolve(record);
      }
      record._resolveWait = null;
    }
  }

  /**
   * Wait for all specified subagents to reach a terminal state.
   *
   * @param subagentIds - List of subagent IDs to wait for
   * @returns Promise resolving to a map of subagent ID → SubagentRecord
   */
  async wait(subagentIds: string[]): Promise<Map<string, SubagentRecord>> {
    const pending: Promise<void>[] = [];

    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (!record) continue;

      // Already terminal
      if (TERMINAL_STATES.has(record.state)) continue;

      // Create a promise that resolves when the subagent completes
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

    // Collect results
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
   *
   * @param subagentId - The subagent to cancel
   * @returns true if the subagent was cancelled, false if not found or already terminal
   */
  cancelOne(subagentId: string): boolean {
    const record = this._subagents.get(subagentId);
    if (!record || TERMINAL_STATES.has(record.state)) {
      return false;
    }

    record.state = SubagentState.INTERRUPTED;
    record.error = record.error ?? 'Interrupted by user';
    record.endTime = record.endTime ?? Date.now();

    // Stop the actor if we have a reference
    if (record.actorRef && 'stop' in record.actorRef) {
      (record.actorRef as { stop: () => void }).stop();
    }

    // Resolve pending waiters
    if (record._resolveWait) {
      for (const resolve of record._resolveWait) {
        resolve(record);
      }
      record._resolveWait = null;
    }

    return true;
  }

  /**
   * Cancel all subagents (running, pending, or otherwise non-terminal).
   *
   * @returns List of cancelled subagent IDs
   */
  cancelAll(): string[] {
    const cancelled: string[] = [];
    for (const [id, record] of this._subagents) {
      if (this.cancelOne(id)) {
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  /**
   * Cancel only running (non-terminal) subagents.
   *
   * @returns List of cancelled subagent IDs
   */
  cancelRunning(): string[] {
    const cancelled: string[] = [];
    for (const [id, record] of this._subagents) {
      if (!TERMINAL_STATES.has(record.state)) {
        if (this.cancelOne(id)) {
          cancelled.push(id);
        }
      }
    }
    return cancelled;
  }

  /**
   * Get state info for all tracked subagents.
   *
   * @returns Array of state snapshots
   */
  getStates(): Array<{
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

  /**
   * Get a single subagent record by ID.
   *
   * @param subagentId - The subagent ID to look up
   * @returns The SubagentRecord, or undefined if not found
   */
  getRecord(subagentId: string): SubagentRecord | undefined {
    return this._subagents.get(subagentId);
  }

  /**
   * Get all subagent records.
   *
   * @returns Array of all SubagentRecords
   */
  allRecords(): SubagentRecord[] {
    return Array.from(this._subagents.values());
  }
}
