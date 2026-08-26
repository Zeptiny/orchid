/**
 * Runtime-only persistence and terminal-retention state for subagents.
 *
 * This deliberately stores operational persistence facts beside the manager,
 * rather than decorating the serializable `SubagentRecord` with bookkeeping
 * flags. The manager remains responsible for mutating/disposing the actual
 * records when an effect is returned from this collaborator.
 */
import type {
  SubagentCompactionPayload,
  SubagentCompactionResult,
} from '../session/storage';

/** Callback that performs the durable subagent-chain compaction write (R36). */
export interface SubagentCompactionSink {
  (
    sessionId: string,
    subagentId: string,
    payload: SubagentCompactionPayload,
  ): SubagentCompactionResult | null;
}

export interface SubagentPersistenceCandidate {
  readonly id: string;
  readonly sessionId: string;
  /** Opaque, monotonic runtime generation for this record incarnation. */
  readonly timeline: SubagentPersistenceTimeline;
  /** Exact dirty revision captured before the storage write starts. */
  readonly revision: number;
  /** The captured record was terminal and may be summarized on confirmation. */
  readonly terminal: boolean;
}

/**
 * A candidate is valid only for the exact timeline object it captured. The
 * monotonic serial makes generations diagnosable; the symbol makes a matching
 * token impossible to fabricate from ordinary runtime data.
 */
export interface SubagentPersistenceTimeline {
  readonly generation: number;
  readonly nonce: symbol;
}

export interface SubagentPersistenceConfirmation {
  /** The manager should drop heavy runtime fields for this confirmed record. */
  readonly evict: boolean;
  /** Oldest terminal summaries the manager should remove entirely. */
  readonly removeIds: readonly string[];
}

interface PersistenceState {
  sessionId: string | null;
  timeline: SubagentPersistenceTimeline;
  dirtyRevision: number;
  confirmedRevision: number;
  summary: boolean;
  /** Last revision at which compaction was applied (separate from summary eviction). */
  lastCompactionRevision: number | null;
}

/**
 * Owns one manager's checkpoint generations, summary state, and retention
 * FIFOs. It never retains a record object, avoiding a second mutable domain
 * representation.
 */
export class SubagentPersistence {
  private readonly records = new Map<string, PersistenceState>();
  private readonly summariesBySession = new Map<string, string[]>();
  private readonly trackedSessionsSet = new Set<string>();
  private timelineGeneration = 0;
  private readonly compactionSink: SubagentCompactionSink | null;

  constructor(
    private readonly getTerminalRetention: () => number,
    compactionSink: SubagentCompactionSink | null = null,
  ) {
    this.compactionSink = compactionSink;
  }

  /**
   * Every record starts durable: a spawn parked in the admission queue must
   * still own a durable row, or an app close while queued leaves no record to
   * hydrate after restart (issue #121 path a) while the frozen transcript
   * still claims status "queued".
   */
  register(id: string, sessionId: string | null): void {
    this.records.set(id, {
      sessionId,
      timeline: this.nextTimeline(),
      dirtyRevision: 0,
      confirmedRevision: -1,
      summary: false,
      lastCompactionRevision: null,
    });
  }

  /** Advance the current durable generation after a record mutation. */
  markDirty(id: string): number | null {
    const state = this.records.get(id);
    // A purged session may still have an asynchronously unwinding runner with
    // a detached record reference. Its late transcript cannot be persisted.
    if (!state) return null;
    state.dirtyRevision += 1;
    return state.dirtyRevision;
  }

  /**
   * Record a compaction mutation separately from the summary eviction flag.
   * Compaction is a normal dirty revision (so checkpoint will persist it), but
   * we track the compaction revision independently so crash recovery can
   * distinguish a compacted chain from a summarized/evicted one (U9).
   */
  markCompaction(id: string, revision?: number | null): number | null {
    const state = this.records.get(id);
    if (!state) return null;
    const rev = typeof revision === 'number' ? revision : this.markDirty(id);
    if (rev !== null) {
      state.lastCompactionRevision = rev;
    }
    return rev;
  }

  /**
   * Apply a subagent-chain compaction as one atomic durable write (R36).
   *
   * Calls the injected compaction sink (which performs the targeted
   * `subagent_chains` transaction against the session DB) and then marks the
   * compaction revision so crash recovery distinguishes a compacted chain
   * from a summarized/evicted one. Returns null when no sink is configured
   * (unit tests without DB access), the record is unknown, or the sink
   * reports an environment-unavailable session manager — no durable write
   * happened in any of those cases, so callers should still update the
   * in-memory record and the compaction revision is marked to keep the
   * bookkeeping consistent (the checkpoint path will persist the record on
   * the next flush). When the sink THROWS (a genuine write failure — the
   * storage layer's integrity errors abort the transaction), the error
   * propagates and markCompaction is skipped by construction: a failed write
   * must never be labeled a compaction checkpoint.
   */
  applySubagentCompaction(
    id: string,
    sessionId: string,
    payload: SubagentCompactionPayload,
  ): SubagentCompactionResult | null {
    const state = this.records.get(id);
    if (!state) return null;
    let result: SubagentCompactionResult | null = null;
    if (this.compactionSink) {
      // Deliberately unguarded: a throw skips the markCompaction below (the
      // caller treats the compaction as failed).
      result = this.compactionSink(sessionId, id, payload);
    }
    this.markCompaction(id);
    return result;
  }

  /** Last compaction revision for a record, if any (separate from summary). */
  getLastCompactionRevision(id: string): number | null {
    return this.records.get(id)?.lastCompactionRevision ?? null;
  }

  /** Whether a record has a compaction checkpoint pending. */
  hasPendingCompaction(id: string): boolean {
    const state = this.records.get(id);
    if (!state || state.lastCompactionRevision === null) return false;
    return state.lastCompactionRevision > state.confirmedRevision;
  }

  /** A follow-up always owns an already durable record, even while queued. */
  beginFollowUp(id: string): void {
    const state = this.require(id);
    state.summary = false;
    // The follow-up keeps the prior compaction revision: the resumed chain already carries compacted flags, so checkpoint must not treat compaction as new work.
    this.untrackSummary(state.sessionId, id);
    this.markDirty(id);
  }

  /** Full materialization has a new revision timeline and leaves the FIFO. */
  rehydrate(id: string, sessionId: string | null): void {
    const previous = this.records.get(id);
    this.untrackSummary(previous?.sessionId ?? sessionId, id);
    this.records.set(id, {
      sessionId,
      timeline: this.nextTimeline(),
      dirtyRevision: 0,
      confirmedRevision: -1,
      summary: false,
      lastCompactionRevision: null,
    });
  }

  isSummary(id: string): boolean {
    return this.records.get(id)?.summary === true;
  }

  needsHydration(id: string): boolean {
    return !this.records.has(id) || this.isSummary(id);
  }

  /**
   * Return a captured checkpoint only when this runtime record can safely
   * write a durable row. A `null` session is intentionally left to the
   * manager's active-session fallback before it calls this method.
   */
  checkpointCandidate(
    id: string,
    sessionId: string,
    terminal: boolean,
    recovery = false,
  ): SubagentPersistenceCandidate | null {
    const state = this.records.get(id);
    if (!state || state.summary) return null;
    if (state.sessionId && state.sessionId !== sessionId) return null;
    if (!recovery && state.dirtyRevision <= state.confirmedRevision) return null;
    return {
      id,
      sessionId,
      timeline: state.timeline,
      revision: state.dirtyRevision,
      terminal,
    };
  }

  /**
   * Confirm precisely the candidate revision that storage accepted. A later
   * mutation remains dirty and cannot be evicted by this stale confirmation.
   */
  confirmCheckpoint(candidate: SubagentPersistenceCandidate): SubagentPersistenceConfirmation {
    const state = this.records.get(candidate.id);
    if (
      !state || state.timeline !== candidate.timeline ||
      (state.sessionId && state.sessionId !== candidate.sessionId) || state.summary
    ) {
      return { evict: false, removeIds: [] };
    }

    state.sessionId ??= candidate.sessionId;

    state.confirmedRevision = Math.max(state.confirmedRevision, candidate.revision);
    this.trackedSessionsSet.add(candidate.sessionId);
    if (!candidate.terminal || candidate.revision !== state.dirtyRevision) {
      return { evict: false, removeIds: [] };
    }

    state.summary = true;
    const removeIds = this.trackSummary(candidate.sessionId, candidate.id);
    return { evict: true, removeIds };
  }

  clearSession(sessionId: string): void {
    for (const [id, state] of this.records) {
      if (state.sessionId === sessionId) this.records.delete(id);
    }
    this.summariesBySession.delete(sessionId);
    this.trackedSessionsSet.delete(sessionId);
  }

  remove(id: string): void {
    const state = this.records.get(id);
    if (!state) return;
    this.untrackSummary(state.sessionId, id);
    this.records.delete(id);
  }

  trackedSessions(): string[] {
    return [...this.trackedSessionsSet];
  }

  private trackSummary(sessionId: string, id: string): string[] {
    let fifo = this.summariesBySession.get(sessionId);
    if (!fifo) {
      fifo = [];
      this.summariesBySession.set(sessionId, fifo);
    }
    if (!fifo.includes(id)) fifo.push(id);

    const removeIds: string[] = [];
    while (fifo.length > this.getTerminalRetention()) {
      const oldest = fifo.shift()!;
      this.records.delete(oldest);
      removeIds.push(oldest);
    }
    return removeIds;
  }

  private untrackSummary(sessionId: string | null, id: string): void {
    const fifo = this.summariesBySession.get(sessionId ?? '');
    if (!fifo) return;
    const index = fifo.indexOf(id);
    if (index >= 0) fifo.splice(index, 1);
    if (fifo.length === 0) this.summariesBySession.delete(sessionId ?? '');
  }

  private require(id: string): PersistenceState {
    const state = this.records.get(id);
    if (!state) throw new Error(`Subagent persistence state missing for '${id}'`);
    return state;
  }

  private nextTimeline(): SubagentPersistenceTimeline {
    return Object.freeze({
      generation: ++this.timelineGeneration,
      nonce: Symbol('subagent-persistence-timeline'),
    });
  }
}
