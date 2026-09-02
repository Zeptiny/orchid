/**
 * useMachineResync — drives the renderer side of reconnect resync (U10, R6).
 *
 * Watches the ACTIVE machine's connection state and fires once on a
 * lost/offline/connecting → connected transition (same machine only — a
 * machine switch is handled by the switch path). The callback performs the
 * machine-scoped refresh (same surface as an active-machine switch) plus a
 * forced re-open of the active session, then asks main to re-broadcast the
 * pending-state catch-up. Returns the reconnect timestamp so callers can
 * distinguish a turn resumed across the gap (started before the reconnect)
 * from one started locally afterwards.
 */
import { useEffect, useRef, useState } from 'react';
import type { MachineStatusEntry } from '../../shared/types/ipc';

export interface UseMachineResyncParams {
  /** The window's active machine id. */
  readonly machineId: string;
  /**
   * Connection state of that machine as this window sees it. Pass
   * `'connected'` for the local machine — it can never reconnect.
   */
  readonly state: MachineStatusEntry['state'];
  /** Invoked once on the reconnect transition. */
  readonly onReconnect: () => void;
}

export interface UseMachineResyncReturn {
  /** Epoch ms of the last reconnect transition; null before the first one. */
  readonly reconnectedAt: number | null;
}

/**
 * Whether a state pair constitutes a reconnect: the previous state was never
 * connected and the new one is. Exported for tests.
 */
export function isMachineReconnectTransition(
  previous: MachineStatusEntry['state'],
  next: MachineStatusEntry['state'],
): boolean {
  return previous !== 'connected' && next === 'connected';
}

export function useMachineResync({
  machineId,
  state,
  onReconnect,
}: UseMachineResyncParams): UseMachineResyncReturn {
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const lastRef = useRef<{ machineId: string; state: MachineStatusEntry['state'] } | null>(null);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    const previous = lastRef.current;
    lastRef.current = { machineId, state };
    // First observation, or a different machine became active: the switch
    // path owns that refresh; never treat it as a reconnect.
    if (previous === null || previous.machineId !== machineId) {
      return;
    }
    if (!isMachineReconnectTransition(previous.state, state)) {
      return;
    }
    const at = Date.now();
    setReconnectedAt(at);
    onReconnectRef.current();
  }, [machineId, state]);

  // Reset the reconnect marker when the active machine changes so a stale
  // timestamp can never light up the new machine's live-turn indicator.
  useEffect(() => {
    setReconnectedAt(null);
  }, [machineId]);

  return { reconnectedAt };
}
