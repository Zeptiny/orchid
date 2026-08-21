/**
 * useTrustSendReplay — orchestration for trust-gated sends (issue #148).
 *
 * A send rejected by the `untrusted_project` gate is stashed here and has
 * exactly one owner until the trust flow resolves it:
 * - dialog opens  → grant replays it into the session that owns the view
 *                   (double-grant and superseded-session guarded); a replay
 *                   that is gated again returns to the composer
 *                 → decline restores it to the composer (same superseded guard)
 * - openFor resolves without a dialog (`already-trusted` / `lookup-failed`)
 *   → the stash is dropped and the text restored immediately: the gate state
 *   is uncertain, so the message must never sit parked invisibly for a later,
 *   unrelated grant to replay.
 *
 * The stash also suppresses queue auto-fire restores of its own message
 * (`restoreQueueBatch`): resurrecting the queue copy would auto-fire it again
 * after the stash replays — a double send.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { UntrustedProjectSendFailure } from './useChat';
import type { QueuedMessage } from './useMessageQueue';
import type { TrustPromptOpenCallbacks } from './useTrustPrompt';

export interface UseTrustSendReplayParams {
  /** Trust-prompt surface: open the dialog for a gated directory. */
  openFor: (cwd: string, callbacks?: TrustPromptOpenCallbacks) => void;
  /** Trust-prompt surface: close the dialog without granting. */
  decline: () => void;
  /** Queue restore to wrap (useMessageQueue.restoreBatch). */
  restoreBatch: (batch: readonly QueuedMessage[], owner?: string | null) => void;
  /** Gated project directory (workspace cwd, falling back to the session's). */
  cwd: string | null;
  /** Session owning the composer; guards stale replays/restores. */
  activeSessionId: string | null;
}

export interface DraftRestore {
  text: string;
  consumed: () => void;
}

export interface UseTrustSendReplayReturn {
  /** chat-level callback: stash the failed send and open the trust dialog. */
  onUntrustedProject: (failure: UntrustedProjectSendFailure) => void;
  /** Trust granted: replay the stash into the session that owns the view. */
  onGranted: () => void;
  /** Trust declined: restore the stash to the composer and close the dialog. */
  onDecline: () => void;
  /** One-shot composer restore; InputArea reports consumption. */
  draftRestore: DraftRestore | null;
  /** Late-bound send bridge; the mount point assigns its handleSend into it. */
  sendRef: RefObject<((message: string) => Promise<boolean>) | null>;
  /**
   * Queue-restore wrapper: a batch whose joined text is the stashed message
   * is not resurrected — the stash now owns that message (grant replays it,
   * decline restores it), so a restored queue copy would double-send.
   */
  restoreQueueBatch: (batch: readonly QueuedMessage[], owner?: string | null) => void;
}

/** Same join as useMessageQueue.selectBatch — how a consumed batch is sent. */
const BATCH_JOIN = '\n\n';

function batchIsStashedMessage(batch: readonly QueuedMessage[], stashed: string): boolean {
  return batch.length > 0 && batch.map((m) => m.text).join(BATCH_JOIN) === stashed;
}

/**
 * Stash/replay/restore controller for trust-gated sends. Mount points wire
 * their `useTrustPrompt` surface in, hand `onUntrustedProject` to `useChat`,
 * route grant/decline through the returned handlers, and pass `draftRestore`
 * to the composer.
 */
export function useTrustSendReplay({
  openFor,
  decline,
  restoreBatch,
  cwd,
  activeSessionId,
}: UseTrustSendReplayParams): UseTrustSendReplayReturn {
  const pendingTrustSendRef = useRef<UntrustedProjectSendFailure | null>(null);
  /** Late-bound handleSend for the grant replay; assigned by the mount point. */
  const sendRef = useRef<((message: string) => Promise<boolean>) | null>(null);
  /** One-shot composer draft restore (decline / unresolved openFor). */
  const [restoreDraft, setRestoreDraft] = useState<{ text: string } | null>(null);

  // Refs so the stable callbacks below always see the latest render's values.
  const openForRef = useRef(openFor);
  openForRef.current = openFor;
  const declineRef = useRef(decline);
  declineRef.current = decline;
  const restoreBatchRef = useRef(restoreBatch);
  restoreBatchRef.current = restoreBatch;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const restoreToComposer = useCallback((failure: UntrustedProjectSendFailure) => {
    pendingTrustSendRef.current = null;
    setRestoreDraft({ text: failure.message });
  }, []);

  const onUntrustedProject = useCallback((failure: UntrustedProjectSendFailure) => {
    const gated = cwdRef.current?.trim() ?? '';
    if (!gated) {
      // No resolvable project directory — the dialog can never open, so the
      // message goes straight back to the composer instead of being lost.
      restoreToComposer(failure);
      return;
    }
    // Stash first: the stash owns the message until the trust flow resolves it.
    pendingTrustSendRef.current = failure;
    openForRef.current(gated, {
      onOutcome: (outcome) => {
        if (outcome === 'opened') return;
        // No dialog will resolve this stash. The gate state is uncertain
        // (already-trusted and still gated, or the lookup failed) — restore
        // the message instead of leaving it parked for a later, unrelated
        // grant to replay. A newer stash may have replaced this one already.
        const pending = pendingTrustSendRef.current;
        if (pending === failure) restoreToComposer(pending);
      },
    });
  }, [restoreToComposer]);

  const onGranted = useCallback(() => {
    // Clear first so a replay that fails again re-stashes fresh instead of
    // double-firing the stash (this is also the double-grant guard).
    const pending = pendingTrustSendRef.current;
    if (!pending) return;
    pendingTrustSendRef.current = null;
    // Superseded: another session owns the view now (the dialog is modal, so
    // this only happens through programmatic session switches). Drop the
    // stash silently rather than firing the message into an unrelated
    // session — the sidebar selected another session deliberately.
    if ((pending.options.sessionId ?? null) !== (activeSessionIdRef.current ?? null)) {
      return;
    }
    void sendRef.current?.(pending.message)?.then((sent) => {
      // Replay was gated (provider/workspace changed mid-dialog): put the
      // message back in the composer instead of dropping it.
      if (!sent) setRestoreDraft({ text: pending.message });
    });
  }, []);

  const onDecline = useCallback(() => {
    const pending = pendingTrustSendRef.current;
    pendingTrustSendRef.current = null;
    // Mirror the grant path's superseded guard: restoring into a different
    // session's composer would leak the message across sessions.
    if (pending && (pending.options.sessionId ?? null) === (activeSessionIdRef.current ?? null)) {
      setRestoreDraft({ text: pending.message });
    }
    declineRef.current();
  }, []);

  const restoreQueueBatch = useCallback((batch: readonly QueuedMessage[], owner?: string | null) => {
    if (batchIsStashedMessage(batch, pendingTrustSendRef.current?.message ?? '')) return;
    restoreBatchRef.current(batch, owner);
  }, []);

  const handleRestoreDraftConsumed = useCallback(() => setRestoreDraft(null), []);
  const draftRestore = useMemo(
    () => (restoreDraft ? { text: restoreDraft.text, consumed: handleRestoreDraftConsumed } : null),
    [restoreDraft, handleRestoreDraftConsumed],
  );

  return {
    onUntrustedProject,
    onGranted,
    onDecline,
    draftRestore,
    sendRef,
    restoreQueueBatch,
  };
}
