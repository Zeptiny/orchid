import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionActivity } from '../../shared/types/ipc-boundary';

export type SessionActivityState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; error: string };

export interface UseSessionActivityReturn {
  activities: readonly SessionActivity[];
  state: SessionActivityState;
  refresh: () => Promise<void>;
  markSeen: (sessionId: string) => Promise<void>;
}

function mergeActivity(
  current: ReadonlyMap<string, SessionActivity>,
  incoming: SessionActivity,
): Map<string, SessionActivity> {
  const existing = current.get(incoming.sessionId);
  if (existing && existing.updatedAt > incoming.updatedAt) {
    return new Map(current);
  }
  const next = new Map(current);
  next.set(incoming.sessionId, incoming);
  return next;
}

function orderedActivities(map: ReadonlyMap<string, SessionActivity>): SessionActivity[] {
  const priority: Record<SessionActivity['state'], number> = {
    needs_attention: 0,
    working: 1,
    waiting: 2,
    idle: 3,
  };
  return [...map.values()].sort((a, b) => {
    const statePriority = priority[a.state] - priority[b.state];
    if (statePriority !== 0) return statePriority;
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Process-wide session activity. Push updates are merged by timestamp so a
 * slow initial snapshot can never overwrite a newer broadcast.
 */
export function useSessionActivity(): UseSessionActivityReturn {
  const [activityBySession, setActivityBySession] = useState<
    ReadonlyMap<string, SessionActivity>
  >(() => new Map());
  const [state, setState] = useState<SessionActivityState>({ status: 'loading' });

  const apply = useCallback((activity: SessionActivity) => {
    setActivityBySession((current) => mergeActivity(current, activity));
  }, []);

  const refresh = useCallback(async () => {
    if (!window.orchid?.session?.listActivity) {
      setState({ status: 'ready' });
      return;
    }
    try {
      const activities = await window.orchid.session.listActivity();
      setActivityBySession((current) => {
        let next: ReadonlyMap<string, SessionActivity> = current;
        for (const activity of activities) {
          next = mergeActivity(next, activity);
        }
        return next;
      });
      setState({ status: 'ready' });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.orchid?.session?.onActivityChanged?.((event) => {
      apply(event.activity);
    });
    void refresh();
    return unsubscribe;
  }, [apply, refresh]);

  const markSeen = useCallback(async (sessionId: string) => {
    if (!window.orchid?.session?.markSeen) return;
    try {
      const activity = await window.orchid.session.markSeen({ id: sessionId });
      if (activity) apply(activity);
    } catch {
      // A seen marker is cosmetic; the next broadcast or refresh will retry.
    }
  }, [apply]);

  const activities = useMemo(
    () => orderedActivities(activityBySession),
    [activityBySession],
  );

  return { activities, state, refresh, markSeen };
}
