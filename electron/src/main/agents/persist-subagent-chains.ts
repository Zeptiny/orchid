/**
 * Persist in-memory subagent records onto their owning sessions.
 *
 * Extracted so tools (wait) and wire-subagents can share the logic without a
 * circular import through tools ↔ wire-subagents.
 *
 * Records persist as one `subagent_chains` row per record; checkpoints upsert
 * only records whose `persistRevision` exceeds their last-persisted revision
 * (R7). The last-persisted bookkeeping updates only after the storage write
 * succeeds, so a rejected write keeps its records dirty for the next attempt.
 */
import type { Session } from '../../shared/types/session';
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import { getSessionManager } from '../ipc/session';
import type { SubagentManager, SubagentRecord } from './manager';
import { runtimeToDomain } from './manager';

export interface PersistenceTimerApi {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Flavor of a persistence flush, reported to the write callback. */
export interface SubagentPersistenceFlushInfo {
  /**
   * True only for explicit recovery flushes. Ordinary checkpoints and
   * terminal waves are observable through the delta stream, so only recovery
   * flushes warrant a `SESSION_SUBAGENTS_CHANGED` broadcast (R8).
   */
  readonly recovery: boolean;
}

export interface SubagentPersistenceSchedulerOptions {
  /** Retries after the initial failed checkpoint before the breaker opens. */
  maxRetries?: number;
}

const CHECKPOINT_DELAY_MS = 2000;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_MAX_DELAY_MS = 2000;
const DEFAULT_MAX_RETRIES = 3;

/** One bounded checkpoint scheduler per session, including re-entrant writes. */
export function createSubagentPersistenceScheduler(
  write: (sessionId: string, info: SubagentPersistenceFlushInfo) => void,
  timers: PersistenceTimerApi = { setTimeout, clearTimeout },
  options: SubagentPersistenceSchedulerOptions = {},
) {
  const requestedMaxRetries = options.maxRetries;
  const maxRetries = typeof requestedMaxRetries === 'number' &&
      Number.isInteger(requestedMaxRetries) && requestedMaxRetries >= 0
    ? requestedMaxRetries
    : DEFAULT_MAX_RETRIES;
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  /** Terminal completion wave timers; one early flush batches a wave (R8). */
  const waves = new Map<string, ReturnType<typeof setTimeout>>();
  const dirty = new Set<string>();
  const writing = new Set<string>();
  const failures = new Map<string, number>();
  const degraded = new Set<string>();
  /** Sessions whose next successful flush must report `recovery: true`. */
  const recoveryPending = new Set<string>();

  const clearScheduled = (sessionId: string): void => {
    for (const pending of [scheduled, waves]) {
      const timer = pending.get(sessionId);
      if (timer) timers.clearTimeout(timer);
      pending.delete(sessionId);
    }
  };

  const flush = (sessionId: string): void => {
    clearScheduled(sessionId);
    // A persistent failure is kept dirty for a later recovery trigger, but it
    // must not keep scheduling work by itself once its retry budget is spent.
    if (degraded.has(sessionId)) return;
    if (writing.has(sessionId)) {
      dirty.add(sessionId);
      return;
    }
    writing.add(sessionId);
    dirty.delete(sessionId);
    const recovery = recoveryPending.has(sessionId);
    try {
      write(sessionId, { recovery });
      failures.delete(sessionId);
      recoveryPending.delete(sessionId);
    } catch (error) {
      dirty.add(sessionId);
      const attempt = (failures.get(sessionId) ?? 0) + 1;
      failures.set(sessionId, attempt);
      if (attempt > maxRetries) {
        degraded.add(sessionId);
        console.warn(
          `Subagent persistence degraded for session ${sessionId}; automatic retries paused:`,
          error,
        );
      } else {
        console.debug('Subagent persistence retry scheduled:', error);
      }
    } finally {
      writing.delete(sessionId);
      if (dirty.has(sessionId) && !degraded.has(sessionId)) {
        const attempt = failures.get(sessionId) ?? 0;
        const delay = attempt > 0
          ? Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
          : 0;
        scheduleCheckpoint(sessionId, delay);
      }
    }
  };

  function scheduleCheckpoint(sessionId: string, delay: number): void {
    if (scheduled.has(sessionId) || waves.has(sessionId) || degraded.has(sessionId)) return;
    scheduled.set(sessionId, timers.setTimeout(() => flush(sessionId), delay));
  }

  function scheduleWave(sessionId: string, delayMs: number): void {
    if (waves.has(sessionId) || degraded.has(sessionId)) return;
    dirty.add(sessionId);
    if (writing.has(sessionId)) return;
    waves.set(sessionId, timers.setTimeout(() => flush(sessionId), delayMs));
  }

  const reopen = (sessionId: string, immediate: boolean): void => {
    degraded.delete(sessionId);
    failures.delete(sessionId);
    dirty.add(sessionId);
    if (writing.has(sessionId)) return;
    if (immediate) flush(sessionId);
    else scheduleCheckpoint(sessionId, CHECKPOINT_DELAY_MS);
  };

  const clear = (sessionId: string): void => {
    clearScheduled(sessionId);
    dirty.delete(sessionId);
    writing.delete(sessionId);
    failures.delete(sessionId);
    degraded.delete(sessionId);
    recoveryPending.delete(sessionId);
  };

  return {
    markDirty(sessionId: string): void {
      // New durable state can reopen a *tripped* breaker, but must not reset
      // an active retry window: a continuously streaming subagent would then
      // prevent a persistent failure from ever reaching its retry budget.
      if (degraded.has(sessionId)) {
        reopen(sessionId, false);
        return;
      }
      dirty.add(sessionId);
      if (!writing.has(sessionId)) scheduleCheckpoint(sessionId, CHECKPOINT_DELAY_MS);
    },
    /**
     * Batch near-simultaneous terminal completions into one early flush
     * instead of one immediate write per terminal event (R8).
     */
    scheduleWave(sessionId: string, delayMs: number): void {
      scheduleWave(sessionId, delayMs);
    },
    flush,
    /** Explicit user retry or a storage-recovery notification. */
    recover(sessionId: string): void {
      recoveryPending.add(sessionId);
      reopen(sessionId, true);
    },
    /**
     * Recover every degraded session plus any caller-supplied sessions (the
     * persistence tracker's keys), so a rebuilt database re-receives every
     * record the bookkeeping considered persisted.
     */
    recoverAll(extraSessionIds?: Iterable<string>): void {
      for (const sessionId of new Set([...degraded, ...extraSessionIds ?? []])) {
        recoveryPending.add(sessionId);
        reopen(sessionId, true);
      }
    },
    flushAll(): void {
      for (const sessionId of new Set([...dirty, ...scheduled.keys(), ...waves.keys()])) {
        flush(sessionId);
      }
    },
    /** Remove all state for a deleted session so no late timer can recreate it. */
    clear,
    /** Stop timers and release every per-session retry/degraded entry. */
    dispose(): void {
      for (const sessionId of new Set([
        ...scheduled.keys(), ...waves.keys(), ...dirty, ...writing,
        ...failures.keys(), ...degraded, ...recoveryPending,
      ])) {
        clear(sessionId);
      }
    },
    isDegraded(sessionId: string): boolean {
      return degraded.has(sessionId);
    },
    hasPending(sessionId: string): boolean {
      return dirty.has(sessionId) || scheduled.has(sessionId) ||
        waves.has(sessionId) || writing.has(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Dirty-record checkpoint (R7, R9)
// ---------------------------------------------------------------------------

/** Last persisted `persistRevision` per session, per subagent id. */
const lastPersistedRevision = new Map<string, Map<string, number>>();

/** Drop persistence bookkeeping for a deleted session. */
export function clearSubagentPersistenceTracking(sessionId: string): void {
  lastPersistedRevision.delete(sessionId);
}

/** Sessions with persistence bookkeeping; recovery must re-check all of them. */
export function trackedSubagentPersistenceSessions(): string[] {
  return [...lastPersistedRevision.keys()];
}

export interface PersistSubagentChainsOptions {
  /** Recovery flush: treat every record as dirty (missing-row contract). */
  recovery?: boolean;
}

/**
 * Group runtime records by `sessionId` and upsert only the records dirtied
 * since their last persisted `persistRevision` onto each owning session.
 *
 * A debounced flush after session switch must not write prior-session chains
 * into `getActive()`. Records without a sessionId fall back to the active
 * session (tests / edge cases).
 */
export function persistSubagentChains(
  manager: SubagentManager,
  onlySessionId?: string,
  options: PersistSubagentChainsOptions = {},
): void {
  const recovery = options.recovery === true;
  const sessionManager = getSessionManager();
  const bySession = new Map<string, SubagentRecord[]>();
  let activeId: string | null | undefined;

  for (const record of manager.allRecords()) {
    let sessionId = record.sessionId;
    if (!sessionId) {
      if (activeId === undefined) activeId = sessionManager.getActive()?.id ?? null;
      sessionId = activeId;
    }
    if (!sessionId) continue;
    if (onlySessionId && sessionId !== onlySessionId) continue;
    const list = bySession.get(sessionId) ?? [];
    list.push(record);
    bySession.set(sessionId, list);
  }

  for (const [sessionId, records] of bySession) {
    const tracker = lastPersistedRevision.get(sessionId);
    const dirtyRecords: SubagentRecord[] = [];
    for (const record of records) {
      // `queued` is a runtime-only state: records parked in the queue — or
      // cancelled before admission — never get a durable row. Durable
      // eligibility begins at admission (`startedAt`).
      if (record.queuedAt !== null && record.startedAt === null) continue;
      if (!recovery && record.persistRevision <= (tracker?.get(record.id) ?? -1)) continue;
      dirtyRecords.push(record);
    }
    if (dirtyRecords.length === 0) continue;

    const domainRecords: DomainSubagentRecord[] =
      dirtyRecords.map((record) => runtimeToDomain(record));
    const started = performance.now();
    let result: { session: Session | null; bytes: number };
    try {
      result = sessionManager.syncSubagentRecords(sessionId, domainRecords);
    } catch (err) {
      console.debug(
        `Failed to persist subagent chains for session ${sessionId} (non-fatal):`,
        err,
      );
      throw err;
    }
    if (!result.session) continue;
    const next = tracker ?? new Map<string, number>();
    for (const record of dirtyRecords) next.set(record.id, record.persistRevision);
    lastPersistedRevision.set(sessionId, next);
    const durationMs = (performance.now() - started).toFixed(1);
    console.debug(
      `[subagents] checkpoint session=${sessionId} records=${dirtyRecords.length} ` +
        `bytes=${result.bytes} durationMs=${durationMs}${recovery ? ' (recovery)' : ''}`,
    );
  }
}
