import { useEffect } from 'react';
import type { WorkingSetSnapshot } from '../../shared/types/ipc';
import type { SessionDeletionNotice } from './useSession';

interface SessionDeletionReconciliationActions {
  applySnapshot: (snapshot: WorkingSetSnapshot) => WorkingSetSnapshot;
  clearQueue: () => void;
  clearMessages: () => void;
  focusAfterWorkingSet: (snapshot: WorkingSetSnapshot) => Promise<void>;
  onError?: (error: unknown) => void;
}

let handledSequence = 0;

/** Test-only: reset module-level dedup tracking. */
export function __resetDeletionReconciliation(): void {
  handledSequence = 0;
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
  useEffect(() => {
    if (!notice || notice.sequence <= handledSequence) return;
    handledSequence = notice.sequence;
    const snapshot = actions.applySnapshot(notice.workingSet);
    if (!notice.wasActive) return;
    actions.clearQueue();
    actions.clearMessages();
    void actions.focusAfterWorkingSet(snapshot).catch((error) => {
      actions.onError?.(error);
    });
  }, [notice, actions]);
}
