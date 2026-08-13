import { useEffect, useRef } from 'react';
import type { WorkingSetSnapshot } from '../../shared/types/ipc';
import type { SessionDeletionNotice } from './useSession';

interface SessionDeletionReconciliationActions {
  applySnapshot: (snapshot: WorkingSetSnapshot) => WorkingSetSnapshot;
  clearQueue: () => void;
  clearMessages: () => void;
  focusAfterWorkingSet: (snapshot: WorkingSetSnapshot) => Promise<void>;
  onError?: (error: unknown) => void;
}

/**
 * Reconcile one deduplicated session deletion with tabs and center-pane focus.
 * The notice sequence prevents the event and invoke response from navigating
 * independently when both carry the same deletion.
 */
export function useSessionDeletionReconciliation(
  notice: SessionDeletionNotice | null,
  actions: SessionDeletionReconciliationActions,
): void {
  const handledSequence = useRef(0);

  useEffect(() => {
    if (!notice || notice.sequence <= handledSequence.current) return;
    handledSequence.current = notice.sequence;
    const snapshot = actions.applySnapshot(notice.workingSet);
    if (!notice.wasActive) return;
    actions.clearQueue();
    actions.clearMessages();
    void actions.focusAfterWorkingSet(snapshot).catch((error) => {
      actions.onError?.(error);
    });
  }, [notice, actions]);
}
