import type { SessionActivity } from '../../shared/types/ipc-boundary';
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

/** Visible activities ordered by urgency and turn-start stability. */
export function orderedSessionActivities(
  current: SessionActivityMap,
): SessionActivity[] {
  const priority: Record<SessionActivity['state'], number> = {
    needs_attention: 0,
    working: 1,
    waiting: 2,
    idle: 3,
  };
  // Unknown turn starts sort last, not oldest, within the working/waiting bucket.
  const startedAtSortValue = (activity: SessionActivity): number =>
    activity.startedAt ?? Number.POSITIVE_INFINITY;
  return [...current.values()]
    .filter((activity) => sessionActivityPresentation(activity).visible)
    .sort((a, b) => {
      const statePriority = priority[a.state] - priority[b.state];
      if (statePriority !== 0) return statePriority;
      if (a.state === 'working' || a.state === 'waiting') {
        // Mirror SessionActivityStore.list(): active rows order by turn start
        // so streamed detail bumps never reshuffle them between snapshot and
        // broadcast. Oldest start first; equal or unknown starts fall through
        // to recency.
        const aStart = startedAtSortValue(a);
        const bStart = startedAtSortValue(b);
        if (aStart !== bStart) return aStart - bStart;
      } else if (a.unread !== b.unread) {
        return a.unread ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt;
    });
}
