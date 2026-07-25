import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionActivity } from '../../shared/types/ipc-boundary';
import {
  captureSessionActivityBaseline,
  mergeSessionActivity,
  orderedSessionActivities,
  reconcileSessionActivitySnapshot,
  type SessionActivityMap,
} from '../utils/session-activity-state';

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

/**
 * Process-wide session activity. Push updates are merged by timestamp so a
 * slow initial snapshot can never overwrite a newer broadcast.
 */
export function useSessionActivity(): UseSessionActivityReturn {
  const [activityBySession, setActivityBySession] = useState<
    ReadonlyMap<string, SessionActivity>
  >(() => new Map());
  const activityBySessionRef = useRef<SessionActivityMap>(activityBySession);
  const [state, setState] = useState<SessionActivityState>({ status: 'loading' });

  const updateActivities = useCallback(
    (update: (current: SessionActivityMap) => SessionActivityMap) => {
      setActivityBySession((current) => {
        const next = update(current);
        activityBySessionRef.current = next;
        return next;
      });
    },
    [],
  );

  const apply = useCallback((activity: SessionActivity) => {
    updateActivities((current) => mergeSessionActivity(current, activity));
  }, [updateActivities]);

  const refresh = useCallback(async () => {
    if (!window.orchid?.session?.listActivity) {
      setState({ status: 'ready' });
      return;
    }
    const baseline = captureSessionActivityBaseline(activityBySessionRef.current);
    try {
      const activities = await window.orchid.session.listActivity();
      updateActivities((current) =>
        reconcileSessionActivitySnapshot(current, activities, baseline));
      setState({ status: 'ready' });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [updateActivities]);

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
    () => orderedSessionActivities(activityBySession),
    [activityBySession],
  );

  return { activities, state, refresh, markSeen };
}
