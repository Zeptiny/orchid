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
import { addStepUsage } from '../../shared/usage';
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import {
  SubagentDeltaEventType,
  SubagentStatus,
  type SubagentDeltaEvent,
  type SubagentDeltaEventBase,
  type SubagentLiveProjection,
  type SubagentLiveSegment,
  type SubagentTerminalState,
  type SubagentToolSnapshot,
} from '../../shared/types/subagent';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
  makeUserMessage,
} from '../llm/message-factories';
import { getConfig } from '../config/loader';
import { subagentsConfigSchema } from '../config/schema';

// ── Enums ───────────────────────────────────────────────────────────────────

export const SubagentState = {
  /** Parked in the admission queue awaiting a run slot; never persisted. */
  QUEUED: 'queued',
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const;

export type SubagentState = (typeof SubagentState)[keyof typeof SubagentState];

/** Result of answering (or declining) a subagent's pending question. */
export type SubagentQuestionResult =
  | { type: 'answered'; answers: Array<{ selected: string[]; text: string | null; skipped: boolean }> }
  | { type: 'declined' };

/** Terminal states — subagents in these states cannot be cancelled. */
const TERMINAL_STATES = new Set<SubagentState>([
  SubagentState.COMPLETED,
  SubagentState.FAILED,
  SubagentState.INTERRUPTED,
]);

/** Terminal-state check shared by persistence, tools, and IPC wiring. */
export function isTerminalSubagentState(state: SubagentState): boolean {
  return TERMINAL_STATES.has(state);
}

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
type SubagentWaiterReason = 'state-change' | 'flush';

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

/** Admission limits resolved from `subagents.*` config. */
export interface SubagentAdmissionLimits {
  readonly maxActiveGlobal: number;
  readonly maxActivePerSession: number;
  readonly maxQueued: number;
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

/**
 * Thrown by `SubagentManager.spawn` when the admission queue is full: every
 * active slot is taken (PENDING/RUNNING) and `max_queued` records already
 * wait. No record is created. The delegate tool converts this into a
 * structured tool error naming the limit.
 */
export class SubagentQueueFullError extends Error {
  readonly maxQueued: number;
  readonly maxActiveGlobal: number;
  readonly maxActivePerSession: number;

  constructor(limits: SubagentAdmissionLimits) {
    super(
      `Subagent queue is full (subagents.max_queued=${limits.maxQueued}): all active slots are taken ` +
        `(subagents.max_active_global=${limits.maxActiveGlobal}, ` +
        `subagents.max_active_per_session=${limits.maxActivePerSession}). ` +
        `Wait for running subagents to finish or interrupt them before delegating more.`,
    );
    this.name = 'SubagentQueueFullError';
    this.maxQueued = limits.maxQueued;
    this.maxActiveGlobal = limits.maxActiveGlobal;
    this.maxActivePerSession = limits.maxActivePerSession;
  }
}

/**
 * Thrown by `SubagentManager.followUp` when the target record is not in a
 * terminal state. Only completed/failed/interrupted subagents can be resumed;
 * the follow-up tool maps this to wait/interrupt guidance.
 */
export class SubagentNotTerminalError extends Error {
  readonly state: SubagentState;

  constructor(subagentId: string, state: SubagentState) {
    super(
      `Subagent '${subagentId}' is ${state}, not terminal. ` +
        `Only completed, failed, or interrupted subagents can be followed up. ` +
        `Call wait_for_subagent or interrupt_subagents first.`,
    );
    this.name = 'SubagentNotTerminalError';
    this.state = state;
  }
}

/**
 * Thrown by `SubagentManager.followUp` when the target record is closed.
 * Closed subagents are hidden from the prompt and cannot be resumed; the
 * follow-up tool maps this to a named "closed" error.
 */
export class SubagentClosedError extends Error {
  constructor(subagentId: string) {
    super(`Subagent '${subagentId}' is closed and cannot be followed up.`);
    this.name = 'SubagentClosedError';
  }
}

/**
 * Thrown by `SubagentManager.followUp` when the target record is an evicted
 * lean summary. Defensive only: the follow-up tool hydrates evicted records
 * first, so this should never fire in production — a summary holds no chain to
 * replay, so resuming it directly would stream an empty history.
 */
export class SubagentEvictedError extends Error {
  constructor(subagentId: string) {
    super(
      `Subagent '${subagentId}' is an evicted summary; hydrate it before following up.`,
    );
    this.name = 'SubagentEvictedError';
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
  /** Runtime-only owner window used for approval delivery. */
  readonly windowId: string | null;
  /** Frozen parent-turn workspace cwd; reused when a queued run is admitted. */
  readonly cwd: string | null;
  projectRuntime?: ProjectRuntime;
  /** Abort controller for the in-flight run. */
  abortController: AbortController | null;
  /** Pending completion promise resolvers. */
  _resolveWait: Array<(reason: SubagentWaiterReason) => void> | null;
  /** In-flight run promise (for debugging / optional await). */
  _runPromise: Promise<void> | null;
  /**
   * Hidden from the dynamic system prompt while the durable record, chain,
   * and terminal state stay intact (close_subagents tool). Only meaningful on
   * terminal records; persisted with the durable row.
   */
  closed: boolean;
  /** Runtime-only live projection; durable history remains in `chain`. */
  live: SubagentLiveProjection;
  _liveCommittedSegmentCount: number;
  _liveTerminalEmitted: boolean;
  /**
   * Runtime-only: the record was evicted to a lean terminal summary after its
   * durable row was confirmed persisted. Persistence flushes and snapshot
   * merges must skip flagged records — their confirmed durable row stays
   * authoritative, and re-serializing the summary would clobber it with an
   * empty chain. Cannot leak into storage/domain output: `runtimeToDomain`
   * and the storage dicts build fresh explicit-field objects.
   */
  _evicted: boolean;
  /**
   * Runtime-only single-use marker: the record was re-queued by a follow-up
   * resume rather than a fresh spawn. Persistence keeps a durable row for
   * resume-queued records (the reopened chain + follow-up message survive a
   * crash while queued); spawn-queued and cancelled-before-admission records
   * still get no row. Cleared on admission. Cannot leak into storage/domain
   * output: `runtimeToDomain` builds fresh explicit-field objects.
   */
  _resumeQueued: boolean;
  /** Durable-mutation counter; the persistence scheduler upserts dirty records (U6). */
  persistRevision: number;
  /** Per-record run counter for per-run turnId attribution. */
  runCount: number;
  /** Epoch ms of the last emitted `usage` delta (0 = none yet); throttles usage deltas. */
  _lastUsageDeltaAt: number;
  /** Pending question routed to the main agent (null when no question is outstanding). */
  pendingQuestion: {
    toolCallId: string;
    questions: Array<{
      type: 'single' | 'multi';
      title: string;
      description?: string;
      options: Array<{ label: string; description?: string }>;
    }>;
    resolve: (result: SubagentQuestionResult) => void;
  } | null;
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

// ── Mutable live state ──────────────────────────────────────────────────────

/** Mutable view of a tool snapshot for in-place run-loop accumulation. */
type MutableToolSnapshot = { -readonly [K in keyof SubagentToolSnapshot]: SubagentToolSnapshot[K] };

/**
 * Mutable view of the live projection. The manager mutates the stored
 * projection in place during a run so accumulation is structurally cheap;
 * snapshot accessors deep-copy on read via `cloneLiveProjection`.
 */
type MutableLiveProjection = {
  -readonly [K in keyof SubagentLiveProjection]: K extends 'segments'
    ? SubagentLiveSegment[]
    : K extends 'toolCalls'
      ? MutableToolSnapshot[]
      : SubagentLiveProjection[K];
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Variant-specific fields of a delta event, without the shared identity base. */
type SubagentDeltaPayload = DistributiveOmit<SubagentDeltaEvent, keyof SubagentDeltaEventBase>;

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
  private _onDelta: ((event: SubagentDeltaEvent) => void) | null = null;
  /** Per-session monotonic revision counter ordering events and snapshots. */
  private _sessionRevisions: Map<string, number> = new Map();
  /** FIFO admission queue of QUEUED record ids awaiting a run slot. */
  private _queue: string[] = [];
  /** Session key ('' = unscoped) admitted last; round-robin fairness cursor. */
  private _lastAdmittedSession: string | null = null;
  /**
   * Per-session FIFO of evicted terminal summary ids, capped at
   * `subagents.terminal_retention`. Oldest entries are removed from
   * `_subagents` entirely once the cap is exceeded; their durable row
   * remains the record of truth.
   */
  private _terminalSummaries: Map<string, string[]> = new Map();

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

  /** Subscribe to typed incremental live deltas for active subagent runs. */
  setOnDelta(listener: ((event: SubagentDeltaEvent) => void) | null): void {
    this._onDelta = listener;
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
    const admitted = this._canAdmit(sessionId, limits);
    if (!admitted && this._queue.length >= limits.maxQueued) {
      throw new SubagentQueueFullError(limits);
    }

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
      windowId: options.windowId ?? null,
      cwd: options.cwd ?? null,
      projectRuntime: options.projectRuntime,
      abortController: null,
      _resolveWait: [],
      _runPromise: null,
      closed: false,
      live: makeLiveProjection(id, sessionId, admitted ? 'pending' : 'queued'),
      _liveCommittedSegmentCount: 0,
      _liveTerminalEmitted: false,
      _evicted: false,
      _resumeQueued: false,
      persistRevision: 0,
      runCount: 1,
      _lastUsageDeltaAt: 0,
      pendingQuestion: null,
    };

    this._subagents.set(id, record);
    if (!admitted) this._queue.push(id);
    else this._lastAdmittedSession = sessionId ?? '';
    this._notify();
    this._emitDelta(record, {
      type: SubagentDeltaEventType.SPAWNED,
      record: runtimeToDomain(record, { includeLiveTail: false }),
      usage: record.usage,
    });

    if (admitted && this._runner) {
      record._runPromise = this._startRun(record, options.cwd);
    }

    return record;
  }

  /**
   * 1-based FIFO position of a queued record, or null when not queued.
   * Surfaced by the delegate tool so the main agent sees backpressure.
   */
  getQueuePosition(subagentId: string): number | null {
    const index = this._queue.indexOf(subagentId);
    return index >= 0 ? index + 1 : null;
  }

  /**
   * Resume a terminal, non-closed subagent with new user input (R5, R7, R8).
   *
   * Appends the input as a user message, reopens the chain, resets the per-run
   * fields (fresh live projection / runId, `runCount += 1`), and runs the
   * resumed record through the same admission control as `spawn`: admitted
   * resumes start immediately (PENDING → runner); over-capacity resumes park in
   * the bounded FIFO queue as QUEUED and start when a terminal transition frees
   * a slot. Throws `SubagentQueueFullError` — leaving the terminal record
   * completely unmutated — when the queue is full.
   *
   * Guards: the record must exist, must not be an `_evicted` summary (the
   * follow-up tool hydrates those first; a summary has no chain to replay),
   * must be terminal, and must not be closed.
   */
  followUp(subagentId: string, input: string): SubagentRecord {
    const record = this._subagents.get(subagentId);
    if (!record) throw new Error(`Subagent '${subagentId}' not found`);
    if (record._evicted) throw new SubagentEvictedError(subagentId);
    if (!TERMINAL_STATES.has(record.state)) {
      throw new SubagentNotTerminalError(subagentId, record.state);
    }
    if (record.closed) throw new SubagentClosedError(subagentId);

    const limits = getAdmissionLimits();
    const admitted = this._canAdmit(record.sessionId, limits);
    // Unlike spawn (which creates the record AFTER the capacity check), followUp
    // mutates an existing durable record. Validate queue capacity FIRST so a
    // rejected resume leaves the terminal record completely unmutated.
    if (!admitted && this._queue.length >= limits.maxQueued) {
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

    // Per-run reset: clear the prior run's outcome and timing, bump the run
    // counter, and build a fresh live projection (new runId) so the renderer
    // treats the resume as a new run.
    record.result = null;
    record.error = null;
    record.endTime = null;
    record.startedAt = null;
    record.startTime = now;
    record.live = makeLiveProjection(
      record.id,
      record.sessionId,
      admitted ? SubagentStatus.PENDING : SubagentStatus.QUEUED,
    );
    record._liveCommittedSegmentCount = 0;
    record._liveTerminalEmitted = false;
    record._lastUsageDeltaAt = 0;
    record.pendingQuestion = null;
    record.abortController = null;
    record.runCount += 1;
    // Reopened chain + follow-up message must persist via the next checkpoint
    // (spawn sets a fresh row; followUp reopens a terminal durable row).
    this._markRecordDirty(record);

    if (admitted) {
      record.state = SubagentState.PENDING;
      record.queuedAt = null;
      this._lastAdmittedSession = record.sessionId ?? '';
      this._notify();
      this._emitDelta(record, {
        type: SubagentDeltaEventType.SPAWNED,
        record: runtimeToDomain(record, { includeLiveTail: false }),
        usage: record.usage,
      });
      if (this._runner) {
        record._runPromise = this._startRun(record, record.cwd ?? undefined);
      }
    } else {
      record.state = SubagentState.QUEUED;
      record.queuedAt = now;
      record._resumeQueued = true;
      this._queue.push(record.id);
      this._notify();
      this._emitDelta(record, {
        type: SubagentDeltaEventType.SPAWNED,
        record: runtimeToDomain(record, { includeLiveTail: false }),
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
    if (record && record.state === SubagentState.PENDING) {
      record.state = SubagentState.RUNNING;
      record.startedAt ??= Date.now();
      this._updateLive(record, { state: SubagentState.RUNNING });
      this._markRecordDirty(record);
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

    this._removeFromQueue(subagentId);
    record.state = SubagentState.COMPLETED;
    record.result = result;
    record.endTime = Date.now();
    this._finalizeChain(record, ChainStatus.COMPLETED);
    this._markRecordDirty(record);
    this._finishLive(record, SubagentState.COMPLETED);
    this._resolveWaiters(record);
    this._notify();
    this._admitFromQueue();
  }

  /**
   * Mark a subagent as failed with an error.
   * Resolves any pending `wait()` promises.
   */
  markFailed(subagentId: string, error: string): void {
    const record = this._subagents.get(subagentId);
    if (!record || TERMINAL_STATES.has(record.state)) return;

    this._removeFromQueue(subagentId);
    record.state = SubagentState.FAILED;
    record.error = error;
    record.endTime = Date.now();
    this._finalizeChain(record, ChainStatus.FAILED);
    this._markRecordDirty(record);
    this._finishLive(record, SubagentState.FAILED);
    this._resolveWaiters(record);
    this._notify();
    this._admitFromQueue();
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
    record.closed = true;
    this._markRecordDirty(record);
    this._notify();
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
      records.some((record) => record.pendingQuestion !== null) ||
      records.every((record) => TERMINAL_STATES.has(record.state));

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
            if (TERMINAL_STATES.has(record.state)) continue;
            if (!record._resolveWait) {
              record._resolveWait = [];
            }
            const entry = (reason: SubagentWaiterReason) => {
              if (reason === 'flush') {
                settle(resolve);
                return;
              }
              checkPredicate();
            };
            record._resolveWait.push(entry);
            waiterCleanups.push(() => {
              if (!record._resolveWait) return;
              const idx = record._resolveWait.indexOf(entry);
              if (idx >= 0) record._resolveWait.splice(idx, 1);
              if (record._resolveWait.length === 0) {
                record._resolveWait = null;
              }
            });
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
    if (!record || TERMINAL_STATES.has(record.state)) {
      return false;
    }

    // A queued record is cancelled in place: removed from the queue, marked
    // INTERRUPTED, terminal delta emitted — no run slot was ever consumed, so
    // no admission follows.
    const wasQueued = record.state === SubagentState.QUEUED;
    this._removeFromQueue(subagentId);
    record.state = SubagentState.INTERRUPTED;
    record.error = record.error ?? 'Interrupted by user';
    record.endTime = record.endTime ?? Date.now();
    record.abortController?.abort();
    if (record.pendingQuestion) {
      record.pendingQuestion.resolve({ type: 'declined' });
      record.pendingQuestion = null;
    }
    this._markRecordDirty(record);
    // The runner owns the async interruption boundary. It must materialize its
    // partial live tail before the terminal projection is emitted; otherwise
    // the terminal event can make the renderer flush an incomplete record.
    if (!record._runPromise) {
      this._finalizeChain(record, ChainStatus.INTERRUPTED);
      this._finishLive(record, SubagentState.INTERRUPTED);
    }
    this._resolveWaiters(record);
    if (wasQueued) {
      // A record cancelled while QUEUED was never admitted, so it never gets a
      // durable row (persistence eligibility begins at admission) — but it must
      // not linger as a full record either. Evict it to a lean terminal summary
      // under the same retention FIFO as persisted records; the terminal delta
      // above already carried the full record to the renderer. Eviction runs
      // after _resolveWaiters because _evictToSummary drops _resolveWait.
      this._evictToSummary(record);
      this._trackSummary(record.sessionId ?? '', record.id, getTerminalRetention());
    }
    this._notify();
    if (!wasQueued) this._admitFromQueue();
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
      if (this._resolveWaiters(record, 'flush')) {
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

  /**
   * Store a pending question on the subagent record and unblock waiters.
   *
   * The record stays RUNNING — `_resolveWaiters` lets `wait_for_subagent`
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
    if (record.pendingQuestion) {
      return Promise.resolve({ type: 'declined' });
    }

    return new Promise((resolve) => {
      record.pendingQuestion = { toolCallId, questions, resolve };
      this._resolveWaiters(record);
    });
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
    const record = this._subagents.get(subagentId);
    if (!record?.pendingQuestion || record.pendingQuestion.toolCallId !== toolCallId) {
      return false;
    }
    record.pendingQuestion.resolve(result);
    record.pendingQuestion = null;
    return true;
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
      if (record.sessionId === sessionId && record.pendingQuestion) {
        results.push({
          subagentId: id,
          name: record.label,
          type: record.agent.type,
          toolCallId: record.pendingQuestion.toolCallId,
          questions: record.pendingQuestion.questions,
        });
      }
    }
    return results;
  }

  /** Snapshot a single live projection; deep-copied so callers never alias run state. */
  getLiveProjection(subagentId: string): SubagentLiveProjection | undefined {
    const record = this._subagents.get(subagentId);
    return record ? cloneLiveProjection(record.live) : undefined;
  }

  /** Snapshot live projections for a session; each is deep-copied at call time. */
  getLiveProjections(sessionId?: string | null): SubagentLiveProjection[] {
    return this.allRecords()
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .map((record) => cloneLiveProjection(record.live));
  }

  /** Current per-session revision; 0 for sessions with no recorded activity. */
  getSessionRevision(sessionId: string): number {
    return this._sessionRevisions.get(sessionId) ?? 0;
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

  /**
   * Confirm that terminal records were durably persisted. Only after this
   * confirmation does the manager evict heavy runtime data (persist-first
   * ordering guarantee). Non-terminal ids are ignored.
   */
  confirmRecordsPersisted(sessionId: string, subagentIds: string[]): void {
    const retention = getTerminalRetention();
    for (const id of subagentIds) {
      const record = this._subagents.get(id);
      if (!record || record.sessionId !== sessionId) continue;
      if (!TERMINAL_STATES.has(record.state)) continue;
      // Already a summary (e.g. a queued cancel, or double confirmation):
      // re-evicting would be an idempotent no-op, so skip it explicitly.
      if (record._evicted) continue;
      this._evictToSummary(record);
      this._trackSummary(sessionId, id, retention);
    }
  }

  /**
   * Purge every manager record owned by a session: cancel active/queued
   * records first (emitting terminal deltas so renderers settle), then remove
   * all records including summaries.
   */
  purgeSession(sessionId: string): void {
    for (const [id, record] of this._subagents) {
      if (record.sessionId !== sessionId) continue;
      if (!TERMINAL_STATES.has(record.state)) this.cancelOne(id);
    }
    for (const [id, record] of this._subagents) {
      if (record.sessionId === sessionId) this._subagents.delete(id);
    }
    this._queue = this._queue.filter(
      (id) => this._subagents.get(id)?.sessionId !== sessionId,
    );
    this._terminalSummaries.delete(sessionId);
    this._sessionRevisions.delete(sessionId);
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
    return records.map((record) => runtimeToDomain(record));
  }

  /**
   * Materialize durable records back into the runtime map on demand (R9).
   *
   * Targets records whose full form lives only in `session.subagentChains`:
   * evicted lean summaries (`_evicted`, chain emptied) and everything persisted
   * before the current app launch. A live full record always wins (no-op); an
   * `_evicted` summary shell is REPLACED, because its chain is empty and the
   * stored domain record is the only replay source.
   *
   * Hydration is deliberately silent: no deltas, no `_notify`, no dirty mark —
   * the mutating tool that follows owns notification and persistence. Each
   * rebuilt record restarts at `persistRevision: 0`, so the caller must also
   * drop the id's `lastPersistedRevision` entry (see
   * `forgetSubagentPersistedRevision`); otherwise the revision-gated checkpoint
   * would skip the re-materialized record forever (R12).
   */
  hydrate(specs: HydrateSpec[]): void {
    for (const spec of specs) {
      const existing = this._subagents.get(spec.id);
      // A live full record wins; only absent ids and chain-less evicted
      // summaries are (re)materialized from durable storage.
      if (existing && !existing._evicted) continue;

      // Defensive: stored rows only ever carry terminal statuses (the restore
      // migration maps queued/pending/running → interrupted). Skip anything else.
      const state = HYDRATABLE_STATUS_TO_STATE[spec.domain.status];
      if (!state) continue;

      const { domain } = spec;
      const startTime = Date.parse(domain.start_time);
      const endTime = domain.end_time ? Date.parse(domain.end_time) : null;

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
        windowId: spec.windowId,
        cwd: spec.cwd,
        projectRuntime: spec.projectRuntime,
        abortController: null,
        _resolveWait: [],
        _runPromise: null,
        closed: domain.closed,
        live: makeLiveProjection(spec.id, spec.sessionId, domain.status),
        _liveCommittedSegmentCount: 0,
        _liveTerminalEmitted: true,
        _evicted: false,
        _resumeQueued: false,
        persistRevision: 0,
        runCount: 1,
        _lastUsageDeltaAt: 0,
        pendingQuestion: null,
      };
      if (domain.reasoning_effort !== undefined) {
        record.reasoningEffort = domain.reasoning_effort;
      }

      this._subagents.set(spec.id, record);
      // A re-materialized full record sharing an id with a FIFO-tracked summary
      // would be deleted from the map when the retention FIFO rolls. Untrack it
      // so subsequent retention rolls leave it alone (R12).
      if (existing?._evicted) {
        this._untrackSummary(spec.sessionId ?? '', spec.id);
      }
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

  private _canAdmit(sessionId: string | null, limits: SubagentAdmissionLimits): boolean {
    return (
      this._activeCount() < limits.maxActiveGlobal &&
      this._sessionActiveCount(sessionId) < limits.maxActivePerSession
    );
  }

  private _removeFromQueue(subagentId: string): void {
    const index = this._queue.indexOf(subagentId);
    if (index >= 0) this._queue.splice(index, 1);
  }

  /**
   * Admit queued records after a terminal transition frees capacity. FIFO
   * within a session, round-robin across sessions: when the global limit is
   * the binding constraint, sessions with queued work take turns; a session
   * blocked by its per-session limit is skipped until its own slot frees.
   */
  private _admitFromQueue(): void {
    const limits = getAdmissionLimits();
    for (;;) {
      if (this._queue.length === 0) return;
      if (this._activeCount() >= limits.maxActiveGlobal) return;
      const sessionKey = this._nextAdmissibleSessionKey(limits);
      if (sessionKey === null) return;
      const index = this._queue.findIndex(
        (id) => (this._subagents.get(id)?.sessionId ?? '') === sessionKey,
      );
      if (index < 0) return;
      const [id] = this._queue.splice(index, 1);
      const record = this._subagents.get(id);
      if (!record || record.state !== SubagentState.QUEUED) continue;
      this._admit(record);
    }
  }

  /**
   * Session key ('' = unscoped) of the next queued session with per-session
   * capacity, rotating past the last admitted session; null when no queued
   * session can admit.
   */
  private _nextAdmissibleSessionKey(limits: SubagentAdmissionLimits): string | null {
    const sessionKeys: string[] = [];
    for (const id of this._queue) {
      const key = this._subagents.get(id)?.sessionId ?? '';
      if (!sessionKeys.includes(key)) sessionKeys.push(key);
    }
    if (sessionKeys.length === 0) return null;
    const cursor = this._lastAdmittedSession === null
      ? -1
      : sessionKeys.indexOf(this._lastAdmittedSession);
    for (let offset = 0; offset < sessionKeys.length; offset += 1) {
      const key = sessionKeys[(cursor + 1 + offset) % sessionKeys.length];
      if (this._sessionActiveCount(key === '' ? null : key) < limits.maxActivePerSession) {
        return key;
      }
    }
    return null;
  }

  /** Move a queued record into a run slot: PENDING, then start the runner. */
  private _admit(record: SubagentRecord): void {
    record.state = SubagentState.PENDING;
    // Single-use resume marker: cleared once the record leaves the queue so a
    // later terminal transition does not keep its durable row alive as queued.
    record._resumeQueued = false;
    this._lastAdmittedSession = record.sessionId ?? '';
    // Durable row eligibility begins at admission; queued records stay out of
    // storage (persistRevision stays 0 until here).
    this._markRecordDirty(record);
    this._updateLive(record, { state: SubagentState.PENDING });
    this._notify();
    if (this._runner) {
      record._runPromise = this._startRun(record, record.cwd ?? undefined);
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
   * prompt-context) don't break; chain messages, live state, projectRuntime,
   * and abort artifacts are dropped. The `_evicted` flag marks the summary so
   * persistence flushes and snapshot merges never let it overwrite the
   * confirmed durable row.
   */
  private _evictToSummary(record: SubagentRecord): void {
    record._runPromise = null;
    record._evicted = true;
    record.abortController = null;
    record._resolveWait = null;
    record.pendingQuestion = null;
    record.projectRuntime = undefined;
    if (record.chain) {
      record.chain = { ...record.chain, messages: [] };
    }
    record.live = {
      ...record.live,
      segments: [],
      toolCalls: [],
    };
    record._liveCommittedSegmentCount = 0;
  }

  /** Track an evicted summary in the per-session FIFO; remove oldest over cap. */
  private _trackSummary(sessionId: string, id: string, retention: number): void {
    let fifo = this._terminalSummaries.get(sessionId);
    if (!fifo) {
      fifo = [];
      this._terminalSummaries.set(sessionId, fifo);
    }
    if (fifo.includes(id)) return;
    fifo.push(id);
    while (fifo.length > retention) {
      const evicted = fifo.shift()!;
      this._subagents.delete(evicted);
    }
  }

  /** Remove an id from the per-session terminal-summary FIFO (no-op if absent). */
  private _untrackSummary(sessionId: string, id: string): void {
    const fifo = this._terminalSummaries.get(sessionId);
    if (!fifo) return;
    const index = fifo.indexOf(id);
    if (index >= 0) fifo.splice(index, 1);
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
    // Per-step text tracking so the returned result is the subagent's last
    // message rather than the concatenation of every step's narration.
    // `stepText` accumulates the current step; `lastStepResult` remembers the
    // most recent step that produced text (so a trailing tool-only step does
    // not blank out the answer).
    let stepText = '';
    let lastStepResult = '';
    let accumulatedUsage: Usage | null = null;
    // Track open tool calls for result pairing in the chain
    const toolNames = new Map<string, string>();

    try {
      const stream = runner({
        task: record.task,
        // Replay the full chain on a resume; a mutable snapshot keeps the
        // runner's history independent of the run-loop message accumulator.
        history: [...(record.chain?.messages ?? [])],
        agent: record.agent,
        selection: record.selection,
        abortSignal: abort.signal,
        sessionId: record.sessionId ?? undefined,
        windowId: record.windowId ?? undefined,
        cwd,
        agentScopeId: record.id,
        chainId: record.chain?.id,
        // Per-run turn id keeps provider accounting attribution unique across
        // resumes (spawn path runCount=1 reproduces a stable unique id).
        turnId: `${record.id}#${record.runCount}`,
        projectRuntime: record.projectRuntime,
        onReasoningEffort: (effort) => {
          record.reasoningEffort = effort;
        },
      });

      for await (const event of stream) {
        if (abort.signal.aborted || record.state === SubagentState.INTERRUPTED) {
          break;
        }

        switch (event.type) {
          case 'content': {
            responseText += event.text;
            resultText += event.text;
            stepText += event.text;
            this._appendLiveText(record, 'text', event.text);
            break;
          }
          case 'usage': {
            accumulatedUsage = addStepUsage(accumulatedUsage, event.usage);
            record.usage = accumulatedUsage;
            this._updateLive(record, { usage: accumulatedUsage });
            if (accumulatedUsage) {
              const now = Date.now();
              if (record._lastUsageDeltaAt === 0 || now - record._lastUsageDeltaAt >= getUsageDeltaIntervalMs()) {
                record._lastUsageDeltaAt = now;
                this._emitDelta(record, { type: SubagentDeltaEventType.USAGE, usage: accumulatedUsage });
              }
            }
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
              if (toolSegment) {
                const startedAt = record.live.toolCalls.find(
                  (tool) => tool.toolCallId === toolCallId,
                )?.startedAt ?? new Date().toISOString();
                this._emitDelta(record, {
                  type: SubagentDeltaEventType.TOOL_START,
                  segmentId: toolSegment.id,
                  toolCallId,
                  toolName,
                  status: 'running',
                  args,
                  startedAt,
                });
              }
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
            this._emitDelta(record, {
              type: SubagentDeltaEventType.TOOL_ARGS_DELTA,
              toolCallId: event.toolCallId,
              append: event.argsDelta,
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
            const finishedAt = new Date().toISOString();
            this._updateLiveTool(record, event.toolCallId, {
              status: event.execution.canonical.status,
              content: event.content,
              toolResult: event.execution.canonical,
              finishedAt,
            });
            this._markLiveCommitted(record);
            this._setChainMessages(record, messages);
            this._notify();
            this._emitDelta(record, {
              type: SubagentDeltaEventType.TOOL_RESULT,
              toolCallId: event.toolCallId,
              status: event.execution.canonical.status,
              content: event.content,
              toolResult: event.execution.canonical,
              finishedAt,
            });
            break;
          }
          case 'error': {
            throw new Error(event.detail || event.title || 'Subagent stream error');
          }
          case 'step_finish': {
            if (stepText.trim()) lastStepResult = stepText;
            stepText = '';
            break;
          }
          case 'finish':
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

      // Prefer the last step's text (the subagent's final message). Fall back
      // to the full accumulation when no step boundary was observed (e.g. the
      // textStream fallback path, which does not emit step_finish).
      const finalStepText = stepText.trim() ? stepText : lastStepResult;
      record.result = finalStepText || resultText || record.result;
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
      record._runPromise = null;
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

  private _resolveWaiters(
    record: SubagentRecord,
    reason: SubagentWaiterReason = 'state-change',
  ): boolean {
    const waiters = record._resolveWait;
    if (reason === 'flush' && waiters?.length === 0) return false;
    if (waiters) {
      for (const resolve of waiters) {
        resolve(reason);
      }
      record._resolveWait = null;
      return waiters.length > 0;
    }
    return false;
  }

  private _appendLiveText(record: SubagentRecord, kind: 'text' | 'thinking', content: string): void {
    const live = this._live(record);
    const last = live.segments.at(-1);
    let segmentId: string;
    if (last && last.kind === kind) {
      last.content += content;
      segmentId = last.id;
    } else {
      segmentId = randomUUID();
      live.segments.push({ kind, id: segmentId, content });
    }
    this._updateLive(record, {});
    this._emitDelta(record, kind === 'text'
      ? { type: SubagentDeltaEventType.TEXT_DELTA, segmentId, append: content }
      : { type: SubagentDeltaEventType.THINKING_DELTA, segmentId, append: content });
  }

  private _ensureLiveTool(record: SubagentRecord, toolCallId: string, toolName: string): void {
    const live = this._live(record);
    if (live.toolCalls.some((tool) => tool.toolCallId === toolCallId)) return;
    const startedAt = new Date().toISOString();
    live.toolCalls.push({
      toolCallId, toolName, status: 'generating', partialArgs: '', args: '',
      content: null, toolResult: null, startedAt, finishedAt: null,
    });
    const segmentId = randomUUID();
    live.segments.push({ kind: 'tool', id: segmentId, toolCallId });
    this._updateLive(record, {});
    this._emitDelta(record, {
      type: SubagentDeltaEventType.TOOL_START, segmentId, toolCallId, toolName,
      status: 'generating', args: '', startedAt,
    });
  }

  private _updateLiveTool(record: SubagentRecord, toolCallId: string, patch: Partial<SubagentToolSnapshot>): void {
    const tool = this._live(record).toolCalls.find((entry) => entry.toolCallId === toolCallId);
    if (!tool) return;
    Object.assign(tool, patch);
    this._updateLive(record, {});
  }

  private _markLiveCommitted(record: SubagentRecord): void {
    record._liveCommittedSegmentCount = record.live.segments.length;
  }

  /** Mutable view of a record's live projection for in-place run-loop accumulation. */
  private _live(record: SubagentRecord): MutableLiveProjection {
    return record.live as MutableLiveProjection;
  }

  private _updateLive(
    record: SubagentRecord,
    patch: Partial<Omit<SubagentLiveProjection, 'sequence' | 'subagentId' | 'runId'>>,
  ): void {
    const live = this._live(record);
    if (patch.sessionId !== undefined) live.sessionId = patch.sessionId;
    if (patch.state !== undefined) live.state = patch.state;
    if (patch.usage !== undefined) live.usage = patch.usage;
    if (patch.result !== undefined) live.result = patch.result;
    if (patch.error !== undefined) live.error = patch.error;
    if (patch.segments !== undefined) {
      live.segments.length = 0;
      live.segments.push(...patch.segments);
    }
    if (patch.toolCalls !== undefined) {
      live.toolCalls.length = 0;
      live.toolCalls.push(...patch.toolCalls);
    }
    live.sequence += 1;
    this._bumpSessionRevision(record);
  }

  private _finishLive(record: SubagentRecord, state: SubagentTerminalState): void {
    if (record._liveTerminalEmitted) return;
    record._liveTerminalEmitted = true;
    this._updateLive(record, {
      state, result: record.result, error: record.error, usage: record.usage,
      segments: [], toolCalls: [],
    });
    record._liveCommittedSegmentCount = 0;
    this._emitDelta(record, {
      type: SubagentDeltaEventType.TERMINAL,
      record: runtimeToDomain(record, { includeLiveTail: true }),
      state,
      usage: record.usage,
    });
  }

  /** Emit a typed live delta stamped with the current run sequence and session revision. */
  private _emitDelta(record: SubagentRecord, delta: SubagentDeltaPayload): void {
    const listener = this._onDelta;
    if (!listener) return;
    const sessionId = record.sessionId ?? '';
    const event = {
      sessionId,
      subagentId: record.id,
      runId: record.live.runId,
      sequence: record.live.sequence,
      sessionRevision: this.getSessionRevision(sessionId),
      ...delta,
    } as SubagentDeltaEvent;
    try {
      listener(event);
    } catch (err) {
      console.debug('Subagent delta listener failed (non-fatal):', err);
    }
  }

  /** Advance the per-session revision counter used to order events and snapshots. */
  private _bumpSessionRevision(record: SubagentRecord): void {
    if (!record.sessionId) return;
    this._sessionRevisions.set(
      record.sessionId,
      (this._sessionRevisions.get(record.sessionId) ?? 0) + 1,
    );
  }

  /** Mark a durable record mutation: bump the persist revision and the session revision. */
  private _markRecordDirty(record: SubagentRecord): void {
    record.persistRevision += 1;
    this._bumpSessionRevision(record);
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
    ...(record.reasoningEffort !== undefined
      ? { reasoning_effort: record.reasoningEffort }
      : {}),
    closed: record.closed,
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

/** Deep-copy a live projection so snapshot reads never alias mutable run state. */
function cloneLiveProjection(projection: SubagentLiveProjection): SubagentLiveProjection {
  return {
    ...projection,
    segments: projection.segments.map((segment) => ({ ...segment })),
    toolCalls: projection.toolCalls.map((tool) => ({ ...tool })),
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
