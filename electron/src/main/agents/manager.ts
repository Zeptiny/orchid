/**
 * SubagentManager — runtime manager for subagent lifecycle.
 *
 * Provides:
 * - spawn(name, task, agent, options): SubagentRecord (starts run when runner set)
 * - wait(subagentIds): Promise of terminal records
 * - cancelOne / cancelAll / cancelRunning
 * - getStates / allRecords / getRecord
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
import type { StreamEvent } from '../llm/orchestrator';
import type { ProjectRuntime } from '../project/runtime';
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import {
  SubagentDeltaEventType,
  SubagentStatus,
  type SubagentDeltaEvent,
  type SubagentLiveProjection,
  type SubagentTerminalState,
} from '../../shared/types/subagent';
import { makeUserMessage } from '../llm/message-factories';
import { getConfig } from '../config/loader';
import { subagentsConfigSchema } from '../config/schema';
import { AdmissionController, type AdmissionCounters, type SubagentAdmissionLimits } from './admission';
import { SubagentRunRegistry, type SubagentRun } from './subagent-run';
import {
  SubagentLifecycle,
  type SubagentQuestion,
  type SubagentQuestionResult,
  type SubagentWaiterReason,
} from './subagent-lifecycle';
import {
  SubagentRunAssembler,
  type SubagentRunFinalization,
  type SubagentRunProjectionEffect,
} from './subagent-run-assembler';
import {
  SubagentLiveProjectionStore,
  materializeProjectionTail,
  type SubagentProjectionCheckpoint,
} from './subagent-live-projection';
import {
  SubagentPersistence,
  type SubagentPersistenceCandidate,
} from './subagent-persistence';
import {
  SubagentWaitTimeoutError,
  SubagentQueueFullError,
  SubagentNotTerminalError,
  SubagentClosedError,
  SubagentEvictedError,
  SubagentSummaryClosedError,
  SubagentStillSettlingError,
} from './errors';

export type { SubagentAdmissionLimits } from './admission';
export {
  SubagentWaitTimeoutError,
  SubagentQueueFullError,
  SubagentNotTerminalError,
  SubagentClosedError,
  SubagentEvictedError,
  SubagentSummaryClosedError,
  SubagentStillSettlingError,
} from './errors';

export { isTerminalSubagentState, SubagentState } from './types';
import { isTerminalSubagentState, SubagentState } from './types';

/** Result of answering (or declining) a subagent's pending question. */
export type { SubagentQuestionResult } from './subagent-lifecycle';

/**
 * Terminal domain statuses map 1:1 onto runtime states for hydration. Stored
 * `subagentChains` only ever carry terminal statuses (the restore migration
 * maps queued/pending/running → interrupted); a non-terminal lookup yields
 * `undefined` and the spec is skipped defensively.
 */
const HYDRATABLE_STATUS_TO_STATE: Partial<Record<SubagentStatus, SubagentState>> = {
  [SubagentStatus.COMPLETED]: SubagentState.COMPLETED,
  [SubagentStatus.FAILED]: SubagentState.FAILED,
  [SubagentStatus.INTERRUPTED]: SubagentState.INTERRUPTED,
};

/**
 * Lazily parsed `subagents.*` schema defaults, cached in a module-level
 * singleton. Every "config not loaded" fallback in this module reads these so
 * the values cannot silently drift from the schema (they ARE the schema
 * defaults, not hand-duplicated literals).
 */
let subagentConfigDefaults: ReturnType<typeof subagentsConfigSchema.parse> | null = null;

function getSubagentConfigDefaults(): ReturnType<typeof subagentsConfigSchema.parse> {
  subagentConfigDefaults ??= subagentsConfigSchema.parse({});
  return subagentConfigDefaults;
}

// ── Stream runner ───────────────────────────────────────────────────────────

/** Production stream driver (wired from subagent-runner.ts). */
export type SubagentStreamRunner = (params: {
  task: string;
  /** Full chain to replay for a resumed run; absent = spawn path. */
  history?: Message[];
  agent: Agent;
  selection: ModelSelection | null;
  abortSignal: AbortSignal;
  sessionId?: string;
  /** Originating renderer window frozen by the parent turn. */
  windowId?: string;
  /** Frozen parent-turn workspace cwd (do not re-resolve live session). */
  cwd?: string;
  /** This subagent's scope id (record.id) for todos / bg / prompt isolation. */
  agentScopeId: string;
  /** Durable child-chain and turn identifiers for provider attempt attribution. */
  chainId?: string;
  turnId?: string;
  /** Immutable parent project snapshot for config, tools, and definitions. */
  projectRuntime?: ProjectRuntime;
  /** Reports the resolved reasoning effort once the provider execution is known. */
  onReasoningEffort?: (effort: string | number | undefined) => void;
}) => AsyncGenerator<StreamEvent>;

export type SubagentChangeListener = (records: readonly SubagentRecord[]) => void;

/**
 * Resolve the default `wait_for_subagent` budget in milliseconds.
 *
 * Source: `subagent_wait_timeout` (seconds) from the live process-wide config
 * (`getConfig()`), multiplied by 1000. Falls back to 300_000 ms (300s) when the
 * config is not loaded. Turn-scoped callers should prefer the frozen project
 * runtime config via `getToolConfig(ctx)` so a mid-turn settings change cannot
 * alter an in-flight wait.
 */
export function getDefaultWaitTimeoutMs(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../config/loader') as typeof import('../config/loader');
    return getConfig().subagent_wait_timeout * 1000;
  } catch {
    return 300_000;
  }
}

/**
 * Resolve admission limits from the live process-wide config (`getConfig()`),
 * read at spawn/admission time so a runtime settings change takes effect
 * immediately. Falls back to the schema defaults when config is not loaded.
 */
function getAdmissionLimits(): SubagentAdmissionLimits {
  try {
    const { max_active_global, max_active_per_session, max_queued } = getConfig().subagents;
    return {
      maxActiveGlobal: max_active_global,
      maxActivePerSession: max_active_per_session,
      maxQueued: max_queued,
    };
  } catch {
    const defaults = getSubagentConfigDefaults();
    return {
      maxActiveGlobal: defaults.max_active_global,
      maxActivePerSession: defaults.max_active_per_session,
      maxQueued: defaults.max_queued,
    };
  }
}

/**
 * Resolve the per-subagent `usage` delta throttle interval in milliseconds.
 *
 * Source: `subagents.usage_event_interval_ms` from the live process-wide
 * config (`getConfig()`), read at emission time so a runtime settings change
 * takes effect immediately rather than snapshotting at spawn. Falls back to
 * the schema default when the config is not loaded.
 *
 * Uses the top-level `getConfig` import (like `subagent-runner`) rather than a
 * lazy `require`: a `require` of the TS loader cannot be resolved under Vitest
 * (verified empirically), which would pin this to the fallback in every test.
 */
function getUsageDeltaIntervalMs(): number {
  try {
    return getConfig().subagents.usage_event_interval_ms;
  } catch {
    return getSubagentConfigDefaults().usage_event_interval_ms;
  }
}

/**
 * Resolve the bounded terminal summary retention count per session.
 * Source: `subagents.terminal_retention`; falls back to the schema default
 * when the config is not loaded.
 */
function getTerminalRetention(): number {
  try {
    return getConfig().subagents.terminal_retention;
  } catch {
    return getSubagentConfigDefaults().terminal_retention;
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
  /** Spawn time (epoch ms); reset to the resumed run's start on a follow-up. */
  startTime: number;
  /** When the record entered the admission queue (epoch ms; null = admitted at spawn). */
  queuedAt: number | null;
  /** When execution started after admission (epoch ms; null = not started). */
  startedAt: number | null;
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
  /** Resolved reasoning effort reported by the stream runner (undefined = none). */
  reasoningEffort?: string | number;
  /**
   * Owning session id for chain persistence.
   * Required so onChange sync writes to the correct session after a switch
   * (global manager + getActive() would otherwise attach chains to the new session).
   */
  readonly sessionId: string | null;
  /**
   * Hidden from the dynamic system prompt while the durable record, chain,
   * and terminal state stay intact (close_subagents tool). Only meaningful on
   * terminal records; persisted with the durable row.
   */
  closed: boolean;
}

// ── SubagentResult ──────────────────────────────────────────────────────────

export interface SubagentResult {
  id: string;
  state: SubagentState;
  result: string | null;
  error: string | null;
  elapsed: number | null;
}

// ── HydrateSpec ─────────────────────────────────────────────────────────────

/**
 * One durable record to materialize back into the runtime manager.
 *
 * `domain` is the stored record from `session.subagentChains` — the
 * authoritative complete copy for evicted summaries and pre-launch records.
 * `agent` is re-resolved from the project runtime registry by the stored
 * `agent_type` (registry name); a missing definition is a tool-side error, so
 * it never reaches `SubagentManager.hydrate`.
 */
export interface HydrateSpec {
  readonly id: string;
  readonly agent: Agent;
  readonly domain: DomainSubagentRecord;
  readonly sessionId: string | null;
  readonly windowId: string | null;
  readonly cwd: string | null;
  readonly projectRuntime?: ProjectRuntime;
}

/** A runtime record paired with the exact revision captured for a checkpoint. */
export interface SubagentCheckpointCandidate {
  readonly record: SubagentRecord;
  readonly checkpoint: SubagentPersistenceCandidate;
}

// ── SubagentManager ─────────────────────────────────────────────────────────

/**
 * SubagentManager — manages the lifecycle of subagent runs.
 *
 * Spawn subagents, wait for their completion, cancel them, and query
 * their states.
 */
export class SubagentManager {
  private _subagents: Map<string, SubagentRecord> = new Map();
  private _runner: SubagentStreamRunner | null = null;
  private _onChange: SubagentChangeListener | null = null;
  private _changeListeners = new Set<SubagentChangeListener>();
  private _liveProjection = new SubagentLiveProjectionStore({ getUsageDeltaIntervalMs });
  private _admission = new AdmissionController();
  private _runs = new SubagentRunRegistry();
  private _lifecycle = new SubagentLifecycle();
  private _persistence = new SubagentPersistence(getTerminalRetention);

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

  /** Subscribe without replacing the production persistence callback. */
  addOnChangeListener(listener: SubagentChangeListener): () => void {
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  /** Subscribe to typed incremental live deltas for active subagent runs. */
  setOnDelta(listener: ((event: SubagentDeltaEvent) => void) | null): void {
    this._liveProjection.setOnDelta(listener);
  }

  /**
   * Spawn a new subagent.
   *
   * Always returns a record. Under the configured active limits the run
   * starts immediately (PENDING → runner); over capacity the record parks in
   * the bounded FIFO admission queue as QUEUED and starts when a terminal
   * transition frees a slot. Throws `SubagentQueueFullError` (creating no
   * record) when the queue is full.
   */
  spawn(
    name: string,
    task: string,
    agent: Agent,
    options: {
      selection?: ModelSelection | null;
      parentChainIndex?: number;
      sessionId?: string;
      /** Originating renderer window frozen by the parent turn. */
      windowId?: string;
      /** Frozen parent-turn workspace cwd for tools/prompt. */
      cwd?: string;
      /** Immutable parent project snapshot. */
      projectRuntime?: ProjectRuntime;
    } = {},
  ): SubagentRecord {
    const id = `subagent-${randomUUID()}`;
    const sessionId = options.sessionId ?? null;
    const limits = getAdmissionLimits();
    const admitted = this._admission.canAdmit(sessionId, limits, this._admissionCounters());
    if (!admitted && this._admission.queueLength >= limits.maxQueued) {
      throw new SubagentQueueFullError(limits);
    }
    const run = this._runs.register(id, 1, {
      windowId: options.windowId ?? null,
      cwd: options.cwd ?? null,
      projectRuntime: options.projectRuntime,
    });

    const userMessage = makeUserMessage(task);
    const selection = options.selection ?? null;
    const chain = makeEmptyChain(options.sessionId ?? '', selection, agent);
    const now = Date.now();

    const record: SubagentRecord = {
      id,
      agent,
      state: admitted ? SubagentState.PENDING : SubagentState.QUEUED,
      label: name,
      task,
      result: null,
      error: null,
      startTime: now,
      queuedAt: admitted ? null : now,
      startedAt: null,
      endTime: null,
      chain: {
        ...chain,
        messages: [userMessage],
      },
      usage: null,
      selection,
      parentChainIndex: options.parentChainIndex ?? null,
      sessionId,
      closed: false,
    };

    this._subagents.set(id, record);
    this._persistence.register(id, sessionId, { admitted });
    this._liveProjection.start({
      subagentId: id,
      sessionId,
      state: admitted ? SubagentStatus.PENDING : SubagentStatus.QUEUED,
      runId: run.runId,
    });
    if (!admitted) this._admission.enqueue(id);
    else this._admission.markAdmitted(sessionId);
    this._notify();
    this._emitDelta(record, {
      type: SubagentDeltaEventType.SPAWNED,
      record: this.toDomainRecord(record, { includeLiveTail: false }),
      usage: record.usage,
    });

    if (admitted && this._runner) {
      this._startRecordRun(record);
    }

    return record;
  }

  /**
   * 1-based FIFO position of a queued record, or null when not queued.
   * Surfaced by the delegate tool so the main agent sees backpressure.
   */
  getQueuePosition(subagentId: string): number | null {
    return this._admission.getQueuePosition(subagentId);
  }

  /**
   * Resume a terminal, non-closed subagent with new user input (R5, R7, R8).
   *
   * Appends the input as a user message, reopens the chain, resets the per-run
   * fields (fresh live projection / runId and generation), and runs the
   * resumed record through the same admission control as `spawn`: admitted
   * resumes start immediately (PENDING → runner); over-capacity resumes park in
   * the bounded FIFO queue as QUEUED and start when a terminal transition frees
   * a slot. Throws `SubagentQueueFullError` — leaving the terminal record
   * completely unmutated — when the queue is full.
   *
   * Guards: the record must exist, must not be a terminal summary (the
   * follow-up tool hydrates those first; a summary has no chain to replay),
   * must be terminal, and must not be closed.
   */
  followUp(subagentId: string, input: string): SubagentRecord {
    const record = this._subagents.get(subagentId);
    if (!record) throw new Error(`Subagent '${subagentId}' not found`);
    if (this.isSummary(subagentId)) throw new SubagentEvictedError(subagentId);
    if (!isTerminalSubagentState(record.state)) {
      throw new SubagentNotTerminalError(subagentId, record.state);
    }
    if (record.closed) throw new SubagentClosedError(subagentId);
    // A cancelled RUNNING record is already terminal while its run loop still
    // owns the interruption boundary (a settling run). Resuming now would
    // hand the record to a second run while the zombie loop's partial flush
    // and finally block still write to it.
    if (this._runs.isSettling(record.id)) {
      throw new SubagentStillSettlingError(subagentId);
    }

    const limits = getAdmissionLimits();
    const admitted = this._admission.canAdmit(record.sessionId, limits, this._admissionCounters());
    if (!admitted && this._admission.queueLength >= limits.maxQueued) {
      throw new SubagentQueueFullError(limits);
    }

    const now = Date.now();
    // Append the follow-up user message and REOPEN the chain. The reopen is
    // built directly (same object-spread style as `_finalizeChain`) BEFORE any
    // `_setChainMessages` call: that helper's `keepTerminal` logic preserves a
    // terminal chain status, so the chain must already be ACTIVE by the time
    // the run loop writes its first message.
    const userMessage = makeUserMessage(input);
    record.chain = record.chain
      ? {
          ...record.chain,
          messages: [...record.chain.messages, userMessage],
          status: ChainStatus.ACTIVE,
          endTime: null,
        }
      : {
          ...makeEmptyChain(record.sessionId ?? '', record.selection, record.agent),
          messages: [userMessage],
        };

    // Per-run lifecycle reset and fresh projection make the resume a new run.
    const transition = this._lifecycle.transition(record, { type: 'follow-up', admitted, now });
    if (!transition) throw new SubagentNotTerminalError(subagentId, record.state);
    const run = this._runs.beginNext(record.id);
    this._liveProjection.start({
      subagentId: record.id,
      sessionId: record.sessionId,
      state: admitted ? SubagentStatus.PENDING : SubagentStatus.QUEUED,
      runId: run.runId,
    });
    if (transition.clearQuestion) this._lifecycle.cancelQuestion(record.id);
    // Reopened chain + follow-up message must persist via the next checkpoint
    // (spawn sets a fresh row; followUp reopens a terminal durable row).
    this._persistence.beginFollowUp(record.id);
    // Persistence owns its dirty revision; the projection clock separately
    // orders this durable lifecycle mutation against snapshots and deltas.
    if (transition.persist) this._bumpSessionRevision(record);

    if (admitted) {
      this._admission.markAdmitted(record.sessionId);
      this._notify();
      this._emitDelta(record, {
        type: SubagentDeltaEventType.SPAWNED,
        record: this.toDomainRecord(record, { includeLiveTail: false }),
        usage: record.usage,
      });
      if (this._runner) {
        this._startRecordRun(record);
      }
    } else {
      this._admission.enqueue(record.id);
      this._notify();
      this._emitDelta(record, {
        type: SubagentDeltaEventType.SPAWNED,
        record: this.toDomainRecord(record, { includeLiveTail: false }),
        usage: record.usage,
      });
    }

    return record;
  }

  /**
   * Mark a subagent as running (called when the actor starts).
   */
  markRunning(subagentId: string): void {
    const record = this._subagents.get(subagentId);
    const transition = record
      ? this._lifecycle.transition(record, { type: 'running', now: Date.now() })
      : null;
    if (record && transition) {
      this._updateLive(record, { state: SubagentState.RUNNING });
      if (transition.persist) this._markRecordDirty(record);
      this._emitDelta(record, {
        type: SubagentDeltaEventType.STATUS_CHANGED,
        status: SubagentStatus.RUNNING,
      });
      if (transition.notify) this._notify();
    }
  }

  /**
   * Mark a subagent as completed with a result.
   * Resolves any pending `wait()` promises.
   */
  markCompleted(subagentId: string, result: string): void {
    const record = this._subagents.get(subagentId);
    if (!record) return;
    const transition = this._lifecycle.transition(record, { type: 'complete', result, now: Date.now() });
    if (!transition) return;

    if (transition.removeFromAdmissionQueue) this._admission.removeFromQueue(subagentId);
    this._finalizeChain(record, ChainStatus.COMPLETED);
    if (transition.persist) this._markRecordDirty(record);
    if (transition.finishProjection) this._finishLive(record, SubagentState.COMPLETED);
    if (transition.resolveWaiters) this._lifecycle.resolveWaiters(record.id);
    if (transition.notify) this._notify();
    if (transition.admitNext) this._admitFromQueue();
  }

  /**
   * Mark a subagent as failed with an error.
   * Resolves any pending `wait()` promises.
   */
  markFailed(subagentId: string, error: string): void {
    const record = this._subagents.get(subagentId);
    if (!record) return;
    const transition = this._lifecycle.transition(record, { type: 'fail', error, now: Date.now() });
    if (!transition) return;

    if (transition.removeFromAdmissionQueue) this._admission.removeFromQueue(subagentId);
    this._finalizeChain(record, ChainStatus.FAILED);
    if (transition.persist) this._markRecordDirty(record);
    if (transition.finishProjection) this._finishLive(record, SubagentState.FAILED);
    if (transition.resolveWaiters) this._lifecycle.resolveWaiters(record.id);
    if (transition.notify) this._notify();
    if (transition.admitNext) this._admitFromQueue();
  }

  /**
   * Mark a terminal subagent closed — hidden from the dynamic system prompt
   * while the durable record, chain, and terminal state stay intact (R2). The
   * flag persists with the durable row (R4) so it survives restarts. Idempotent:
   * re-closing an already-closed record is a no-op. The close_subagents tool
   * owns the terminal-state and session-ownership guards; this only mutates.
   */
  close(subagentId: string): void {
    const record = this._subagents.get(subagentId);
    if (!record || record.closed) return;
    // A flag set on a terminal summary never persists — refuse loudly; the
    // tool hydrates these first.
    if (this.isSummary(subagentId)) throw new SubagentSummaryClosedError(subagentId);
    const transition = this._lifecycle.transition(record, { type: 'close' });
    if (!transition) return;
    if (transition.persist) this._markRecordDirty(record);
    if (transition.notify) this._notify();
  }

  /**
   * Wait until all specified subagents are terminal or any target asks a
   * question that requires the main agent's response.
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

    const records = subagentIds
      .map((id) => this._subagents.get(id))
      .filter((record): record is SubagentRecord => record !== undefined);
    const shouldReturn = () =>
      records.some((record) => this._lifecycle.hasPendingQuestion(record.id)) ||
      records.every((record) => isTerminalSubagentState(record.state));

    if (!shouldReturn()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const waiterCleanups: Array<() => void> = [];

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
          };

          const checkPredicate = () => {
            if (shouldReturn()) {
              settle(resolve);
            }
          };

          for (const record of records) {
            if (isTerminalSubagentState(record.state)) continue;
            const entry = (reason: SubagentWaiterReason) => {
              if (reason === 'flush') {
                settle(resolve);
                return;
              }
              checkPredicate();
            };
            waiterCleanups.push(this._lifecycle.addWaiter(record.id, entry));
          }

          checkPredicate();

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
      } finally {
        // Detach only this wait's callbacks. Other concurrent waits remain.
        for (const cleanup of waiterCleanups) cleanup();
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
    if (!record) {
      return false;
    }
    const wasQueued = record.state === SubagentState.QUEUED;
    const transition = this._lifecycle.transition(record, {
      type: 'interrupt',
      error: 'Interrupted by user',
      now: Date.now(),
    });
    if (!transition) return false;

    // A queued record is cancelled in place: removed from the queue, marked
    // INTERRUPTED, terminal delta emitted — no run slot was ever consumed, so
    // no admission follows.
    if (transition.removeFromAdmissionQueue) this._admission.removeFromQueue(subagentId);
    this._runs.abortCurrent(record.id);
    if (transition.clearQuestion) this._lifecycle.cancelQuestion(record.id);
    if (transition.persist) this._markRecordDirty(record);
    // The runner owns the async interruption boundary. It must materialize its
    // partial live tail before the terminal projection is emitted; otherwise
    // the terminal event can make the renderer flush an incomplete record.
    if (!this._runs.isSettling(record.id)) {
      this._finalizeChain(record, ChainStatus.INTERRUPTED);
      this._finishLive(record, SubagentState.INTERRUPTED);
    }
    if (transition.resolveWaiters) this._lifecycle.resolveWaiters(record.id);
    if (wasQueued && !this._persistence.hasDurableEligibility(record.id)) {
      // A record cancelled while QUEUED was never admitted, so it never gets a
      // durable row (persistence eligibility begins at admission) — but it must
      // not linger as a full record either. Evict it to a lean terminal summary
      // under the same retention FIFO as persisted records; the terminal delta
      // above already carried the full record to the renderer. Eviction runs
      // after resolving waiters because eviction clears runtime lifecycle state.
      this._applySummaryConfirmation(record, this._persistence.summarizeUndurable(record.id));
    }
    // A resume-queued record owns a durable row (persist-subagent-chains
    // eligibility carve-out), so evicting it here would strand the row with a
    // stale pre-interrupt status and drop the follow-up message — every later
    // checkpoint skips summaries. Leave it as a full dirty INTERRUPTED
    // record: the terminal wave persists it, then confirmRecordsPersisted
    // evicts it through the normal row-confirmed path.
    if (transition.notify) this._notify();
    if (!wasQueued && transition.admitNext) this._admitFromQueue();
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
      if (!isTerminalSubagentState(record.state)) {
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
      if (this._lifecycle.resolveWaiters(record.id, 'flush')) {
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
      if (record.closed) {
        continue;
      }
      states.push({
        id: record.id,
        name: record.agent.name,
        type: record.agent.type,
        task: record.task,
        state: record.state,
        elapsed: this._elapsedMs(record),
      });
    }

    return states;
  }

  getRecord(subagentId: string): SubagentRecord | undefined {
    return this._subagents.get(subagentId);
  }

  /** In-flight run promise, if this record's current generation is settling. */
  getRunPromise(subagentId: string): Promise<void> | null {
    return this._runs.getPromise(subagentId);
  }

  /** Current generation used for per-run turn attribution and stale-run guards. */
  getRunGeneration(subagentId: string): number | undefined {
    return this._runs.getGeneration(subagentId);
  }

  /** Whether the current generation still owns asynchronous teardown. */
  isRunSettling(subagentId: string): boolean {
    return this._runs.isSettling(subagentId);
  }

  /**
   * Store a runtime-only pending question and unblock waiters.
   *
   * The record stays RUNNING — lifecycle waiters let `wait_for_subagent`
   * return early so the main agent can see and answer the question.
   */
  markQuestionPending(
    subagentId: string,
    toolCallId: string,
    questions: Array<{
      type: 'single' | 'multi';
      title: string;
      description?: string;
      options: Array<{ label: string; description?: string }>;
    }>,
  ): Promise<SubagentQuestionResult> {
    const record = this._subagents.get(subagentId);
    if (!record) throw new Error(`Subagent '${subagentId}' not found`);
    if (this._lifecycle.hasPendingQuestion(subagentId)) return Promise.resolve({ type: 'declined' });
    const promise = this._lifecycle.askQuestion(subagentId, { toolCallId, questions });
    this._lifecycle.resolveWaiters(subagentId);
    return promise;
  }

  /**
   * Resolve a subagent's pending question with the given result.
   *
   * Returns false if the subagent has no pending question or the supplied
   * tool-call identity does not match the currently pending question.
   */
  answerSubagentQuestion(
    subagentId: string,
    toolCallId: string,
    result: SubagentQuestionResult,
  ): boolean {
    return this._lifecycle.answerQuestion(subagentId, toolCallId, result);
  }

  /** Runtime-only pending question for a record, if any. */
  getPendingQuestion(subagentId: string): SubagentQuestion | undefined {
    return this._lifecycle.getPendingQuestion(subagentId);
  }

  /**
   * Return all records for a session that have a pending question.
   *
   * Used by the dynamic system prompt builder to surface outstanding
   * questions to the main agent.
   */
  getPendingQuestions(sessionId: string): Array<{
    subagentId: string;
    name: string;
    type: string;
    toolCallId: string;
    questions: unknown[];
  }> {
    const results: Array<{
      subagentId: string;
      name: string;
      type: string;
      toolCallId: string;
      questions: unknown[];
    }> = [];
    for (const [id, record] of this._subagents) {
      const pendingQuestion = this._lifecycle.getPendingQuestion(id);
      if (record.sessionId === sessionId && pendingQuestion) {
        results.push({
          subagentId: id,
          name: record.label,
          type: record.agent.type,
          toolCallId: pendingQuestion.toolCallId,
          questions: pendingQuestion.questions,
        });
      }
    }
    return results;
  }

  /** Snapshot a single live projection; deep-copied so callers never alias run state. */
  getLiveProjection(subagentId: string): SubagentLiveProjection | undefined {
    return this._subagents.has(subagentId) ? this._liveProjection.get(subagentId) : undefined;
  }

  /** Snapshot live projections for a session; each is deep-copied at call time. */
  getLiveProjections(sessionId?: string | null): SubagentLiveProjection[] {
    return this._liveProjection.getAll(sessionId)
      .filter((projection) => this._subagents.has(projection.subagentId));
  }

  /** Current per-session revision; 0 for sessions with no recorded activity. */
  getSessionRevision(sessionId: string): number {
    return this._liveProjection.getSessionRevision(sessionId);
  }

  /**
   * All runtime records, including lean terminal summaries.
   *
   * Invariant: evicted terminal records remain in this array as bounded
   * summaries (heavy fields emptied) until their per-session FIFO cap is
   * exceeded, at which point they are removed entirely. Consumers that need
   * full history beyond the cap read from durable storage.
   */
  allRecords(): SubagentRecord[] {
    return Array.from(this._subagents.values());
  }

  /** Whether an in-memory record is a lean, durable-backed terminal summary. */
  isSummary(subagentId: string): boolean {
    return this._persistence.isSummary(subagentId);
  }

  /** Whether a stored row must be materialized before tools can mutate it. */
  needsHydration(subagentId: string): boolean {
    return this._persistence.needsHydration(subagentId);
  }

  /** Sessions with confirmed persistence state that recovery must revisit. */
  trackedPersistenceSessions(): string[] {
    return this._persistence.trackedSessions();
  }

  /** Capture dirty durable rows with their exact revisions for one storage write. */
  checkpointCandidates(
    sessionId: string,
    options: { recovery?: boolean; includeUnscoped?: boolean } = {},
  ): SubagentCheckpointCandidate[] {
    const candidates: SubagentCheckpointCandidate[] = [];
    for (const record of this._subagents.values()) {
      if (record.sessionId !== sessionId && !(options.includeUnscoped && record.sessionId === null)) {
        continue;
      }
      const checkpoint = this._persistence.checkpointCandidate(
        record.id,
        sessionId,
        isTerminalSubagentState(record.state),
        options.recovery === true,
      );
      if (checkpoint) candidates.push({ record, checkpoint });
    }
    return candidates;
  }

  /** Apply exact-revision persistence confirmations and declared retention effects. */
  confirmCheckpointCandidates(candidates: readonly SubagentCheckpointCandidate[]): void {
    for (const candidate of candidates) {
      const record = this._subagents.get(candidate.record.id);
      const effect = this._persistence.confirmCheckpoint(candidate.checkpoint);
      if (effect.evict && record === candidate.record) this._evictToSummary(record);
      for (const id of effect.removeIds) this._removeRuntimeState(id);
    }
  }

  /** Compatibility facade for non-writer callers; writers use captured candidates. */
  confirmRecordsPersisted(sessionId: string, subagentIds: string[]): void {
    const wanted = new Set(subagentIds);
    this.confirmCheckpointCandidates(
      this.checkpointCandidates(sessionId).filter((candidate) => wanted.has(candidate.record.id)),
    );
  }

  /**
   * Purge every manager record owned by a session: cancel active/queued
   * records first (emitting terminal deltas so renderers settle), then remove
   * all records including summaries.
   */
  purgeSession(sessionId: string): void {
    for (const [id, record] of this._subagents) {
      if (record.sessionId !== sessionId) continue;
      if (!isTerminalSubagentState(record.state)) this.cancelOne(id);
    }
    for (const [id, record] of this._subagents) {
      if (record.sessionId === sessionId) {
        this._subagents.delete(id);
        this._lifecycle.clear(id);
        // Let an already-started run unwind through its guarded terminal
        // projection. Its finally block drops the detached registry entry.
        if (!this._runs.isSettling(id)) {
          this._runs.remove(id);
          this._liveProjection.remove(id);
        }
      }
    }
    this._admission.filterQueue(
      (id) => this._subagents.get(id)?.sessionId !== sessionId,
    );
    this._admission.filterQueue((id) => this._subagents.has(id));
    this._persistence.clearSession(sessionId);
    this._liveProjection.clearSessionRevision(sessionId);
    this._notify();
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
    return records
      .filter((record) => !this.isSummary(record.id))
      .map((record) => this.toDomainRecord(record));
  }

  /** Convert a runtime record using an explicit checkpoint from the live store. */
  toDomainRecord(
    record: SubagentRecord,
    options: Omit<RuntimeToDomainOptions, 'projectionCheckpoint'> = {},
  ): DomainSubagentRecord {
    const includeLiveTail = options.includeLiveTail ?? true;
    const projectionCheckpoint = !includeLiveTail
      ? undefined
      : this._liveProjection.getCheckpoint(record.id);
    return runtimeToDomain(record, { ...options, includeLiveTail, projectionCheckpoint });
  }

  /**
   * Materialize durable records back into the runtime map on demand (R9).
   *
   * Targets records whose full form lives only in `session.subagentChains`:
   * terminal summaries (chain emptied) and everything persisted
   * before the current app launch. A live full record always wins (no-op); an
   * terminal summary shell is REPLACED, because its chain is empty and the
   * stored domain record is the only replay source.
   *
   * Hydration is deliberately silent: no deltas, no `_notify`, no dirty mark —
   * the mutating tool that follows owns notification and persistence. Each
   * rebuilt record starts a new persistence revision timeline, so the next
   * post-hydrate mutation cannot be hidden by an earlier confirmation (R12).
   */
  hydrate(specs: HydrateSpec[]): void {
    for (const spec of specs) {
      const existing = this._subagents.get(spec.id);
      // A live full record wins; only absent ids and chain-less terminal
      // summaries are (re)materialized from durable storage.
      if (existing && !this.isSummary(spec.id)) continue;

      // Defensive: stored rows only ever carry terminal statuses (the restore
      // migration maps queued/pending/running → interrupted). Skip anything else.
      const state = HYDRATABLE_STATUS_TO_STATE[spec.domain.status];
      if (!state) continue;

      const { domain } = spec;
      // Guard against NaN from an unparseable stored timestamp (the `|| 0`
      // fallback mirrors session storage hydration) so hydration stays total
      // and runtimeToDomain never receives an invalid Date.
      const startTime = Date.parse(domain.start_time) || 0;
      const endTime = domain.end_time ? (Date.parse(domain.end_time) || 0) : null;
      const run = this._runs.reset(spec.id, 1, {
        windowId: spec.windowId,
        cwd: spec.cwd,
        projectRuntime: spec.projectRuntime,
      });

      const record: SubagentRecord = {
        id: spec.id,
        agent: spec.agent,
        state,
        label: domain.agent_name,
        task: domain.task,
        result: domain.result,
        error: domain.error,
        startTime,
        queuedAt: null,
        // Durable eligibility is keyed on `startedAt`; a restored terminal
        // record was admitted, so it replays from its original start time.
        startedAt: startTime,
        endTime,
        chain: domain.chain,
        // Usage lives on the chain messages; hydration does not reconstruct the
        // aggregate (summaries keep it, storage does not carry it).
        usage: null,
        selection: domain.chain.selection,
        parentChainIndex: domain.parentChainIndex,
        sessionId: spec.sessionId,
        closed: domain.closed,
      };
      if (domain.reasoning_effort !== undefined) {
        record.reasoningEffort = domain.reasoning_effort;
      }

      this._subagents.set(spec.id, record);
      this._persistence.rehydrate(spec.id, spec.sessionId);
      this._liveProjection.start({
        subagentId: spec.id,
        sessionId: spec.sessionId,
        state: domain.status,
        runId: run.runId,
        terminalEmitted: true,
      });
    }
  }

  // ── Private: admission control ────────────────────────────────────────────

  /** "Active" = PENDING + RUNNING; QUEUED consumes no run slot. */
  private _isActive(record: SubagentRecord): boolean {
    return record.state === SubagentState.PENDING || record.state === SubagentState.RUNNING;
  }

  private _activeCount(): number {
    let count = 0;
    for (const record of this._subagents.values()) {
      if (this._isActive(record)) count += 1;
    }
    return count;
  }

  private _sessionActiveCount(sessionId: string | null): number {
    let count = 0;
    for (const record of this._subagents.values()) {
      if (record.sessionId === sessionId && this._isActive(record)) count += 1;
    }
    return count;
  }

  private _admissionCounters(): AdmissionCounters {
    return {
      activeCountGlobal: () => this._activeCount(),
      sessionActiveCount: (sid) => this._sessionActiveCount(sid),
      recordSessionKey: (id) => this._subagents.get(id)?.sessionId ?? '',
      isRecordQueued: (id) => this._subagents.get(id)?.state === SubagentState.QUEUED,
    };
  }

  private _admitFromQueue(): void {
    const limits = getAdmissionLimits();
    const counters = this._admissionCounters();
    for (;;) {
      const id = this._admission.nextAdmissible(limits, counters);
      if (id === null) return;
      const record = this._subagents.get(id);
      if (!record) continue;
      this._admit(record);
    }
  }

  private _admit(record: SubagentRecord): void {
    const transition = this._lifecycle.transition(record, { type: 'admit' });
    if (!transition) return;
    this._persistence.markAdmitted(record.id);
    this._admission.markAdmitted(record.sessionId);
    if (transition.persist) this._markRecordDirty(record);
    this._updateLive(record, { state: SubagentState.PENDING });
    this._emitDelta(record, {
      type: SubagentDeltaEventType.STATUS_CHANGED,
      status: SubagentStatus.PENDING,
    });
    if (transition.notify) this._notify();
    if (this._runner) {
      this._startRecordRun(record);
    }
  }

  /**
   * Elapsed with queue wait excluded from execution: queued records report
   * their wait so far; records admitted from the queue report execution time
   * from `startedAt`; everything else keeps spawn-based elapsed. Queue wait
   * and execution remain separable via `queuedAt`/`startedAt` on the record.
   */
  private _elapsedMs(record: SubagentRecord, now: number = Date.now()): number | null {
    if (record.state === SubagentState.QUEUED) {
      return now - (record.queuedAt ?? record.startTime);
    }
    if (record.queuedAt !== null && record.startedAt !== null) {
      return Math.max(0, (record.endTime ?? now) - record.startedAt);
    }
    return record.startTime ? (record.endTime ?? now) - record.startTime : null;
  }

  // ── Private: terminal eviction ────────────────────────────────────────────

  /**
   * Replace heavy runtime fields with a bounded summary. The record keeps its
   * SubagentRecord shape so downstream type contracts (getStates, wait,
   * prompt-context) don't break; chain messages and live state are dropped.
   * Persistence owns the corresponding
   * summary status so writers and snapshots retain the durable row as truth.
   */
  private _evictToSummary(record: SubagentRecord): void {
    this._lifecycle.clear(record.id);
    // `_startRun` snapshots this seed before it starts consuming the stream;
    // clearing it here releases heavyweight affinity without changing a
    // settling generation's identity, abort signal, or promise.
    this._runs.releaseSeed(record.id);
    if (record.chain) {
      record.chain = { ...record.chain, messages: [] };
    }
    this._liveProjection.clearLiveTail(record.id);
  }

  /** Apply one summary declaration and any FIFO removals chosen by persistence. */
  private _applySummaryConfirmation(
    record: SubagentRecord,
    effect: { evict: boolean; removeIds: readonly string[] },
  ): void {
    if (effect.evict) this._evictToSummary(record);
    for (const id of effect.removeIds) this._removeRuntimeState(id);
  }

  private _removeRuntimeState(subagentId: string): void {
    this._subagents.delete(subagentId);
    this._runs.remove(subagentId);
    this._lifecycle.clear(subagentId);
    this._liveProjection.remove(subagentId);
  }

  // ── Private: run loop ─────────────────────────────────────────────────────

  private _startRecordRun(record: SubagentRecord): void {
    const run = this._runs.start(record.id);
    const promise = this._startRun(record, run);
    this._runs.attachPromise(run, promise);
  }

  private async _startRun(
    record: SubagentRecord,
    run: SubagentRun,
  ): Promise<void> {
    const runner = this._runner;
    if (!runner) {
      this._runs.settle(run);
      return;
    }

    if (!this._runs.isCurrent(run) || isTerminalSubagentState(record.state)) {
      this._runs.settle(run);
      return;
    }

    const abort = run.abortController;
    if (!abort) return;
    const seed = this._runs.getSeed(record.id);
    this.markRunning(record.id);

    const assembler = new SubagentRunAssembler(record.chain?.messages ?? []);

    try {
      const stream = runner({
        task: record.task,
        // Replay the full chain on a resume; a mutable snapshot keeps the
        // runner's history independent of the assembler's message accumulator.
        history: [...(record.chain?.messages ?? [])],
        agent: record.agent,
        selection: record.selection,
        abortSignal: abort.signal,
        sessionId: record.sessionId ?? undefined,
        windowId: seed?.windowId ?? undefined,
        cwd: seed?.cwd ?? undefined,
        agentScopeId: record.id,
        chainId: record.chain?.id,
        // Per-run turn id keeps provider accounting attribution unique across
        // resumes (spawn path generation=1 reproduces a stable unique id).
        turnId: `${record.id}#${run.generation}`,
        projectRuntime: seed?.projectRuntime,
        onReasoningEffort: (effort) => {
          if (!this._runs.isCurrent(run)) return;
          record.reasoningEffort = effort;
        },
      });

      for await (const event of stream) {
        if (!this._runs.isCurrent(run)) return;
        if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
          break;
        }
        if (!this._applyAssemblerEffects(record, run, assembler.accept(event))) return;
      }

      if (!this._runs.isCurrent(run)) return;
      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        this._applyAssemblerFinalization(record, run, assembler.interrupt());
        return;
      }
      this._applyAssemblerFinalization(record, run, assembler.complete());
    } catch (err) {
      if (!this._runs.isCurrent(run)) return;
      if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
        this._applyAssemblerFinalization(record, run, assembler.interrupt());
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this._applyAssemblerFinalization(record, run, assembler.fail(message));
    } finally {
      if (this._runs.isCurrent(run)) {
        if (record.state === SubagentState.INTERRUPTED) {
          this._finishLive(record, SubagentState.INTERRUPTED);
        }
        this._runs.settle(run);
        if (this._subagents.get(record.id) !== record) {
          this._runs.remove(record.id);
          this._liveProjection.remove(record.id);
        }
      }
    }
  }

  /** Apply the assembler's small live-projection effects behind the run guard. */
  private _applyAssemblerEffects(
    record: SubagentRecord,
    run: SubagentRun,
    effects: readonly SubagentRunProjectionEffect[],
  ): boolean {
    for (const assemblerEffect of effects) {
      if (!this._runs.isCurrent(run)) return false;
      for (const effect of this._liveProjection.applyAssemblerEffects(record.id, [assemblerEffect])) {
        if (!this._runs.isCurrent(run)) return false;
        if (effect.usage !== undefined) record.usage = effect.usage;
        if (effect.transcript) this._applyAssemblerTranscript(record, effect.transcript.messages);
        if (effect.notify) this._notify();
        effect.publish?.();
      }
    }
    return this._runs.isCurrent(run);
  }

  /** Apply a terminal transcript assembled independently of the runtime record. */
  private _applyAssemblerFinalization(
    record: SubagentRecord,
    run: SubagentRun,
    finalization: SubagentRunFinalization,
  ): boolean {
    if (!this._runs.isCurrent(run)) return false;
    if (finalization.result !== null) record.result = finalization.result;
    record.usage = finalization.usage;
    this._applyAssemblerTranscript(
      record,
      finalization.messages,
    );

    switch (finalization.state) {
      case 'completed':
        this.markCompleted(record.id, record.result ?? '');
        break;
      case 'failed':
        this.markFailed(record.id, finalization.error ?? 'Subagent stream error');
        break;
      case 'interrupted':
        if (record.state === SubagentState.INTERRUPTED) {
          this._finalizeChain(record, ChainStatus.INTERRUPTED);
          this._notify();
        }
        break;
    }
    return this._runs.isCurrent(run);
  }

  /** The projection store owns the cursor; the manager persists only the transcript. */
  private _applyAssemblerTranscript(
    record: SubagentRecord,
    messages: readonly Message[],
  ): void {
    this._setChainMessages(record, [...messages]);
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
    this._markRecordDirty(record);
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

  private _updateLive(
    record: SubagentRecord,
    patch: Partial<Omit<SubagentLiveProjection, 'sequence' | 'subagentId' | 'runId'>>,
  ): void {
    this._liveProjection.update(record.id, patch);
  }

  private _finishLive(record: SubagentRecord, state: SubagentTerminalState): void {
    this._liveProjection.finish(record.id, {
      state,
      result: record.result,
      error: record.error,
      usage: record.usage,
      terminalRecord: () => this.toDomainRecord(record, { includeLiveTail: true }),
    });
  }

  /** Delegates wire construction and publication to the live-projection store. */
  private _emitDelta(record: SubagentRecord, delta: Parameters<SubagentLiveProjectionStore['emit']>[1]): void {
    this._liveProjection.emit(record.id, delta);
  }

  /** Advance the per-session revision counter used to order events and snapshots. */
  private _bumpSessionRevision(record: SubagentRecord): void {
    this._liveProjection.bumpSessionRevision(record.sessionId);
  }

  /** Mark a durable record mutation and advance its manager-owned revision. */
  private _markRecordDirty(record: SubagentRecord): void {
    this._persistence.markDirty(record.id);
    this._bumpSessionRevision(record);
  }

  private _notify(): void {
    try {
      const records = this.allRecords();
      this._onChange?.(records);
      for (const listener of this._changeListeners) {
        listener(records);
      }
    } catch (err) {
      console.debug('Subagent onChange listener failed (non-fatal):', err);
    }
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────

export interface RuntimeToDomainOptions {
  /** Include the uncommitted live tail from the explicit projection checkpoint. */
  includeLiveTail?: boolean;
  /** Runtime-only checkpoint supplied by `SubagentLiveProjectionStore`. */
  projectionCheckpoint?: SubagentProjectionCheckpoint;
}

/** Map runtime record → domain SubagentRecord for session JSON. */
export function runtimeToDomain(
  record: SubagentRecord,
  options: RuntimeToDomainOptions = {},
): DomainSubagentRecord {
  const statusMap: Record<SubagentState, DomainSubagentRecord['status']> = {
    [SubagentState.QUEUED]: SubagentStatus.QUEUED,
    [SubagentState.PENDING]: SubagentStatus.PENDING,
    [SubagentState.RUNNING]: SubagentStatus.RUNNING,
    [SubagentState.COMPLETED]: SubagentStatus.COMPLETED,
    [SubagentState.FAILED]: SubagentStatus.FAILED,
    [SubagentState.INTERRUPTED]: SubagentStatus.INTERRUPTED,
  };

  const chain =
    record.chain ??
    makeEmptyChain(record.sessionId ?? '', record.selection, record.agent);
  const checkpointChain = options.includeLiveTail === true && options.projectionCheckpoint
    ? materializeProjectionTail(options.projectionCheckpoint, chain)
    : chain;

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
    ...(record.reasoningEffort !== undefined
      ? { reasoning_effort: record.reasoningEffort }
      : {}),
    closed: record.closed,
    chain: checkpointChain,
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
