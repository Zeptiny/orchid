/**
 * usePermissionApproval — permission approval queue state for the composer.
 *
 * Subscribes to the permission approval IPC events, hydrates pending requests
 * for the selected session, and exposes an answer action over a deduplicated
 * FIFO. While `active` is non-null the composer is replaced by the approval
 * panel (see InputArea); the chat stream above stays mounted and scrollable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PermissionApprovalAnswerMessage,
  PermissionApprovalRequestedEvent,
} from '../../shared/types/ipc';
import {
  enqueueApproval,
  reconcileApprovals,
  removeApproval,
} from '../components/PermissionApprovalPanel';

export interface UsePermissionApprovalReturn {
  /** Active approval request; null when nothing is pending. */
  active: PermissionApprovalRequestedEvent | null;
  /** Decision currently mid-round-trip, if any. */
  submittingDecision: 'approved' | 'denied' | null;
  /** Answer the active request (optionally with a denial reason). */
  answer: (decision: 'approved' | 'denied', reason?: string) => void;
}

export function usePermissionApproval(
  sessionId: string | null,
): UsePermissionApprovalReturn {
  const [queue, setQueue] = useState<PermissionApprovalRequestedEvent[]>([]);
  const [submittingDecision, setSubmittingDecision] = useState<'approved' | 'denied' | null>(null);
  const busyRef = useRef<string | null>(null);
  const hydrationRef = useRef<{
    buffered: PermissionApprovalRequestedEvent[];
    settledToolCallIds: Set<string>;
  } | null>(null);
  const hydrationGenerationRef = useRef(0);

  const active = sessionId && queue[0]?.sessionId === sessionId ? queue[0] : null;

  // A snapshot makes pending approvals replayable after remounts and session
  // switches. Live events received while it is in flight are buffered, then
  // reconciled against the authoritative snapshot.
  useEffect(() => {
    const bridge = window.orchid?.permission;
    const generation = ++hydrationGenerationRef.current;
    busyRef.current = null;
    setQueue([]);
    setSubmittingDecision(null);

    if (!bridge || !sessionId) {
      hydrationRef.current = null;
      return;
    }

    const hydration = {
      buffered: [] as PermissionApprovalRequestedEvent[],
      settledToolCallIds: new Set<string>(),
    };
    hydrationRef.current = hydration;
    let cancelled = false;

    const unsubscribeRequested = bridge.onApprovalRequested((event) => {
      if (event.sessionId !== sessionId || !event.toolCallId) return;
      if (hydrationRef.current === hydration) {
        if (!hydration.buffered.some((item) => item.toolCallId === event.toolCallId)) {
          hydration.buffered.push(event);
        }
        return;
      }
      setQueue((previous) => enqueueApproval(previous, event));
    });

    const unsubscribeSettled = bridge.onApprovalSettled((event) => {
      if (event.sessionId !== sessionId || !event.toolCallId) return;
      if (busyRef.current === event.toolCallId) busyRef.current = null;
      if (hydrationRef.current === hydration) {
        hydration.settledToolCallIds.add(event.toolCallId);
        hydration.buffered = hydration.buffered.filter(
          (item) => item.toolCallId !== event.toolCallId,
        );
      }
      setQueue((previous) => removeApproval(previous, event.toolCallId));
    });

    const applySnapshot = (snapshot: PermissionApprovalRequestedEvent[]) => {
      if (cancelled || hydrationGenerationRef.current !== generation) return;
      if (hydrationRef.current !== hydration) return;
      hydrationRef.current = null;
      setQueue(
        reconcileApprovals(
          snapshot,
          hydration.buffered,
          hydration.settledToolCallIds,
          sessionId,
        ),
      );
    };

    void bridge.snapshot().then(
      (snapshot) => applySnapshot(snapshot.approvals),
      () => applySnapshot([]),
    );

    return () => {
      cancelled = true;
      if (hydrationRef.current === hydration) hydrationRef.current = null;
      unsubscribeRequested();
      unsubscribeSettled();
    };
  }, [sessionId]);

  const answer = useCallback(
    (decision: 'approved' | 'denied', reason?: string) => {
      const bridge = window.orchid?.permission;
      if (!bridge || !active || busyRef.current) return;
      const toolCallId = active.toolCallId;
      busyRef.current = toolCallId;
      setSubmittingDecision(decision);
      const payload: PermissionApprovalAnswerMessage = reason
        ? { toolCallId, decision, reason }
        : { toolCallId, decision };
      const finish = () => {
        if (busyRef.current === toolCallId) busyRef.current = null;
        setSubmittingDecision(null);
      };
      void bridge.answer(payload).then(
        (result) => {
          finish();
          if (result.ok) setQueue((previous) => removeApproval(previous, toolCallId));
        },
        finish,
      );
    },
    [active],
  );

  return useMemo(
    () => ({ active, submittingDecision, answer }),
    [active, submittingDecision, answer],
  );
}
