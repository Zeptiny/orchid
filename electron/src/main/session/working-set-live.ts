/**
 * Working-set mutations — catalog filtering, persistence, and the open/focus
 * helpers shared by the turn pipeline and the session IPC handlers.
 *
 * Electron-free on purpose: the renderer broadcast is injected via
 * {@link setWorkingSetBroadcast} so plain-Node hosts keep the no-op default,
 * while `ipc/session-working-set.ts` owns handler registration.
 */
import type { WorkingSetSnapshot } from '../../shared/types/ipc';
import { sessionWorkingSet } from './working-set';
import { getSessionManager } from './singleton';

/** Injected renderer broadcast (the Electron shell installs the window fan-out). */
export type WorkingSetBroadcast = (
  snapshot: WorkingSetSnapshot,
  sourceOwnerId: string,
) => void;

const noopBroadcast: WorkingSetBroadcast = () => {};

let broadcastOpenSet: WorkingSetBroadcast = noopBroadcast;

/**
 * Install the working-set broadcast (the Electron shell installs the window
 * fan-out). Passing null restores the no-op default.
 */
export function setWorkingSetBroadcast(broadcast: WorkingSetBroadcast | null): void {
  broadcastOpenSet = broadcast ?? noopBroadcast;
}

function sameOpenIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type SessionCatalog =
  | { status: 'ok'; ids: Set<string> }
  | { status: 'io_error'; error: string };

/** Distinguish true empty catalog from session store I/O failure. */
export function tryListSessionCatalog(): SessionCatalog {
  try {
    const manager = getSessionManager();
    return {
      status: 'ok',
      ids: new Set(manager.listSaved().map((s) => s.id)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'io_error', error: message };
  }
}

/**
 * Filter missing sessions when catalog is readable.
 * Returns the requesting owner's snapshot. Does not persist/broadcast.
 */
export function filterIfCatalogOk(ownerId: string): {
  snapshot: WorkingSetSnapshot;
  membershipChanged: boolean;
} {
  const catalog = tryListSessionCatalog();
  if (catalog.status === 'io_error') {
    console.error('[working-set] skip filterExisting; session list I/O failed', catalog.error);
    return {
      snapshot: sessionWorkingSet.getSnapshot(ownerId),
      membershipChanged: false,
    };
  }
  const before = sessionWorkingSet.getSnapshot(ownerId).openSessionIds;
  const snapshot = sessionWorkingSet.filterExisting(catalog.ids, ownerId);
  return {
    snapshot,
    membershipChanged: !sameOpenIds(before, snapshot.openSessionIds),
  };
}

/** Run one working-set mutation, persist it, and broadcast the result. */
export function mutateAndPersist(
  ownerId: string,
  run: () => WorkingSetSnapshot,
): WorkingSetSnapshot {
  const snapshot = run();
  try {
    sessionWorkingSet.saveToDisk();
  } catch (err) {
    console.error('[working-set] failed to persist ui-state.json', err);
  }
  broadcastOpenSet(snapshot, ownerId);
  return snapshot;
}

export function bootstrapWorkingSet(): WorkingSetSnapshot {
  sessionWorkingSet.loadFromDisk();
  return mutateAndPersist('__primary__', () => filterIfCatalogOk('__primary__').snapshot);
}

/** Called from session:load activate path so open-set stays in sync. */
export function workingSetOpenOrFocus(
  id: string,
  ownerId?: string,
): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.openOrFocus(id, owner));
}

/** Called from session:delete so ghost tabs disappear. */
export function workingSetRemove(id: string, ownerId?: string): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.remove(id, owner));
}

/** Draft mode: clear focused id without removing open session tabs. */
export function workingSetClearFocus(ownerId?: string): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.setFocus(null, owner));
}

export function getWorkingSetSnapshot(ownerId?: string): WorkingSetSnapshot {
  return sessionWorkingSet.getSnapshot(ownerId ?? '__primary__');
}
