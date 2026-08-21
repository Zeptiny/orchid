import type { SessionActivity } from '../../shared/types/ipc-boundary';
import { compareSessionActivity } from '../../shared/utils/session-activity-order';
import { sessionActivityPresentation } from './session-activity-presentation';

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;
export type SessionActivityBaseline = ReadonlyMap<string, number>;

function terminalTombstone(activity: SessionActivity): SessionActivity {
  return Object.freeze({
    ...activity,
    state: 'idle',
    phase: null,
    detail: null,
    unread: false,
    backgroundProcessCount: 0,
    canCancel: false,
  });
}

/** Merge one ordered activity event while retaining invisible terminal tombstones. */
export function mergeSessionActivity(
  current: SessionActivityMap,
  incoming: SessionActivity,
): SessionActivityMap {
  const existing = current.get(incoming.sessionId);
  if (existing && existing.updatedAt >= incoming.updatedAt) {
    return current;
  }
  const next = new Map(current);
  next.set(incoming.sessionId, incoming);
  return next;
}

/** Capture the entries an authoritative refresh is allowed to remove. */
export function captureSessionActivityBaseline(
  current: SessionActivityMap,
): SessionActivityBaseline {
  return new Map(
    [...current].map(([sessionId, activity]) => [sessionId, activity.updatedAt]),
  );
}

/**
 * Reconcile a snapshot without pruning broadcasts that arrived after the
 * request began. Missing unchanged entries become ordered tombstones.
 */
export function reconcileSessionActivitySnapshot(
  current: SessionActivityMap,
  incoming: readonly SessionActivity[],
  baseline: SessionActivityBaseline,
): SessionActivityMap {
  let next = current;
  const incomingIds = new Set<string>();
  for (const activity of incoming) {
    incomingIds.add(activity.sessionId);
    next = mergeSessionActivity(next, activity);
  }

  for (const [sessionId, baselineUpdatedAt] of baseline) {
    if (incomingIds.has(sessionId)) continue;
    const latest = next.get(sessionId);
    if (!latest || latest.updatedAt !== baselineUpdatedAt) continue;
    const updated = new Map(next);
    updated.set(sessionId, terminalTombstone(latest));
    next = updated;
  }
  return next;
}

/**
 * Visible activities in the one shared ordering (`compareSessionActivity`),
 * also used by `SessionActivityStore.list()`: state urgency first, then
 * turn-start stability for active rows, unread-first, and recency.
 */
export function orderedSessionActivities(
  current: SessionActivityMap,
): SessionActivity[] {
  return [...current.values()]
    .filter((activity) => sessionActivityPresentation(activity).visible)
    .sort(compareSessionActivity);
}
