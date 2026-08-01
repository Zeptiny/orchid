/**
 * Runtime-only persistence and terminal-retention state for subagents.
 *
 * This deliberately stores operational persistence facts beside the manager,
 * rather than decorating the serializable `SubagentRecord` with bookkeeping
 * flags. The manager remains responsible for mutating/disposing the actual
 * records when an effect is returned from this collaborator.
 */

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
  /** A spawn parked in admission has no durable row; resumed queues do. */
  durableEligible: boolean;
  summary: boolean;
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

  constructor(private readonly getTerminalRetention: () => number) {}

  register(id: string, sessionId: string | null, options: { admitted: boolean }): void {
    this.records.set(id, {
      sessionId,
      timeline: this.nextTimeline(),
      dirtyRevision: 0,
      confirmedRevision: -1,
      durableEligible: options.admitted,
      summary: false,
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

  /** Admission makes a fresh spawn durable and ends resume-queue state. */
  markAdmitted(id: string): void {
    this.require(id).durableEligible = true;
  }

  /** A follow-up always owns an already durable record, even while queued. */
  beginFollowUp(id: string): void {
    const state = this.require(id);
    state.durableEligible = true;
    state.summary = false;
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
      durableEligible: true,
      summary: false,
    });
  }

  isSummary(id: string): boolean {
    return this.records.get(id)?.summary === true;
  }

  needsHydration(id: string): boolean {
    return !this.records.has(id) || this.isSummary(id);
  }

  /** Whether the record owns a durable row (including a queued follow-up). */
  hasDurableEligibility(id: string): boolean {
    return this.records.get(id)?.durableEligible === true;
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
    if (!state || state.summary || !state.durableEligible) return null;
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

  /**
   * Spawn-queued cancellation has no durable row, but retains the historic
   * bounded summary behavior. Unlike `confirmCheckpoint`, this is intentionally
   * not persist-first because a fresh queued record is never serializable.
   */
  summarizeUndurable(id: string): SubagentPersistenceConfirmation {
    const state = this.records.get(id);
    if (!state || state.summary) return { evict: false, removeIds: [] };
    state.summary = true;
    return {
      evict: true,
      removeIds: this.trackSummary(state.sessionId ?? '', id),
    };
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
