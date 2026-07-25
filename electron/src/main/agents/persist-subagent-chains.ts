/**
 * Persist in-memory subagent records onto their owning sessions.
 *
 * Extracted so tools (wait) and wire-subagents can share the logic without a
 * circular import through tools ↔ wire-subagents.
 */
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import { getSessionManager } from '../ipc/session';
import type { SubagentManager } from './manager';
import { runtimeToDomain } from './manager';

export interface PersistenceTimerApi {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One bounded checkpoint scheduler per session, including re-entrant writes. */
export function createSubagentPersistenceScheduler(
  write: (sessionId: string) => void,
  timers: PersistenceTimerApi = { setTimeout, clearTimeout },
) {
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  const dirty = new Set<string>();
  const writing = new Set<string>();
  const failures = new Map<string, number>();

  const flush = (sessionId: string): void => {
    const timer = scheduled.get(sessionId);
    if (timer) timers.clearTimeout(timer);
    scheduled.delete(sessionId);
    if (writing.has(sessionId)) {
      dirty.add(sessionId);
      return;
    }
    writing.add(sessionId);
    dirty.delete(sessionId);
    try {
      write(sessionId);
      failures.delete(sessionId);
    } catch (error) {
      dirty.add(sessionId);
      const attempt = (failures.get(sessionId) ?? 0) + 1;
      failures.set(sessionId, attempt);
      console.debug('Subagent persistence retry scheduled:', error);
    } finally {
      writing.delete(sessionId);
      if (dirty.has(sessionId)) {
        const attempt = failures.get(sessionId) ?? 0;
        const delay = attempt > 0 ? Math.min(2000, 100 * 2 ** (attempt - 1)) : 0;
        schedule(sessionId, delay);
      }
    }
  };

  function schedule(sessionId: string, delay: number): void {
    if (scheduled.has(sessionId)) return;
    scheduled.set(sessionId, timers.setTimeout(() => flush(sessionId), delay));
  }

  return {
    markDirty(sessionId: string): void {
      dirty.add(sessionId);
      if (!writing.has(sessionId)) schedule(sessionId, 2000);
    },
    flush,
    flushAll(): void {
      for (const sessionId of new Set([...dirty, ...scheduled.keys()])) flush(sessionId);
    },
    hasPending(sessionId: string): boolean {
      return dirty.has(sessionId) || scheduled.has(sessionId) || writing.has(sessionId);
    },
  };
}

/**
 * Group runtime records by `sessionId` and call `syncSubagentChains` per owner.
 *
 * A debounced flush after session switch must not write prior-session chains
 * into `getActive()`. Records without a sessionId fall back to the active
 * session (tests / edge cases).
 */
export function persistSubagentChains(manager: SubagentManager, onlySessionId?: string): void {
  const bySession = new Map<string, DomainSubagentRecord[]>();
  const unscoped: DomainSubagentRecord[] = [];

  for (const record of manager.allRecords()) {
    if (onlySessionId && record.sessionId !== onlySessionId) continue;
    const domain = runtimeToDomain(record);
    if (record.sessionId) {
      const list = bySession.get(record.sessionId) ?? [];
      list.push(domain);
      bySession.set(record.sessionId, list);
    } else {
      unscoped.push(domain);
    }
  }

  const sessionManager = getSessionManager();

  for (const [sessionId, records] of bySession) {
    try {
      const existing = sessionManager.getSession(sessionId)?.subagentChains ?? [];
      const merged = new Map(existing.map((record) => [record.id, record]));
      for (const record of records) merged.set(record.id, record);
      sessionManager.syncSubagentChains([...merged.values()], sessionId);
    } catch (err) {
      console.debug(
        `Failed to persist subagent chains for session ${sessionId} (non-fatal):`,
        err,
      );
      throw err;
    }
  }

  if (unscoped.length > 0) {
    try {
      const active = sessionManager.getActive();
      const existing = active?.subagentChains ?? [];
      const merged = new Map(existing.map((record) => [record.id, record]));
      for (const record of unscoped) merged.set(record.id, record);
      sessionManager.syncSubagentChains([...merged.values()]);
    } catch (err) {
      console.debug('Failed to persist unscoped subagent chains (non-fatal):', err);
      throw err;
    }
  }
}
