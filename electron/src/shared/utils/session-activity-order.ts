/**
 * Session activity ordering — the one comparator shared by the main-process
 * `SessionActivityStore.list()` and the renderer's
 * `orderedSessionActivities()` so IPC snapshots and live broadcasts can never
 * disagree on row order.
 */
import type {
  SessionActivity,
  SessionExecutionState,
} from '../types/ipc-boundary';

/** Lower number sorts first. */
export const SESSION_ACTIVITY_STATE_PRIORITY: Record<SessionExecutionState, number> = {
  needs_attention: 0,
  working: 1,
  waiting: 2,
  idle: 3,
};

/**
 * Order two session activities by urgency:
 *
 * 1. State priority (`SESSION_ACTIVITY_STATE_PRIORITY`): needs_attention,
 *    then working, waiting, idle.
 * 2. Working/waiting pairs tie-break by `startedAt` ascending with unknown
 *    starts last. Detail updates bump `updatedAt` on every streamed event, so
 *    ordering by turn start gives active rows a stable queue position while
 *    the turn runs: longest-running work keeps the bucket top and newly
 *    started work enters below instead of displacing rows mid-turn.
 * 3. Other same-state pairs tie-break unread-first.
 * 4. Final tie-break: most recent `updatedAt`.
 */
export function compareSessionActivity(
  a: SessionActivity,
  b: SessionActivity,
): number {
  const statePriority =
    SESSION_ACTIVITY_STATE_PRIORITY[a.state] -
    SESSION_ACTIVITY_STATE_PRIORITY[b.state];
  if (statePriority !== 0) return statePriority;
  if (a.state === 'working' || a.state === 'waiting') {
    // Unknown turn starts sort last, not oldest, within the bucket.
    const aStart = a.startedAt ?? Number.POSITIVE_INFINITY;
    const bStart = b.startedAt ?? Number.POSITIVE_INFINITY;
    if (aStart !== bStart) return aStart - bStart;
  } else if (a.unread !== b.unread) {
    return a.unread ? -1 : 1;
  }
  return b.updatedAt - a.updatedAt;
}
