/**
 * Machine scope for ChatView: re-scoping this window when the active machine
 * changes, reconnect resync, and the banner that reports a dropped remote.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMachineResync } from '../../hooks/useMachineResync';
import type { UseMachinesReturn } from '../../hooks/useMachines';
import type { UseProvidersReturn } from '../../hooks/useProviders';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { ChatStatus } from '../../hooks/useChat';
import type { MachineStatusEntry } from '../../../shared/types/ipc';

export interface UseChatViewMachineScopeOptions {
  readonly session: UseSessionReturn;
  readonly providers: UseProvidersReturn;
  readonly machines: UseMachinesReturn;
  /** The native folder picker is a local-machine capability. */
  readonly canPickProjectDir: boolean;
  readonly chatStatus: ChatStatus;
  readonly streamStartTime: number | null;
  readonly enterDraftMode: (opts?: { clearComposer?: boolean }) => Promise<void>;
  readonly selectSession: (id: string, options?: { force?: boolean }) => Promise<void>;
}

export interface UseChatViewMachineScopeReturn {
  /** Status of the active remote machine, or null while on the local machine. */
  readonly activeMachineStatus: MachineStatusEntry | null;
  readonly remoteDisconnected: boolean;
  /** A turn that started before the reconnect survived the gap (U10). */
  readonly resumedLiveTurnStartedAt: number | null;
  readonly reconnectingMachine: boolean;
  readonly handleMachineReconnect: () => Promise<void>;
}

/** A remote that dropped mid-work is retried by the connection manager. */
function reportsDroppedConnection(status: MachineStatusEntry | null): boolean {
  return status?.state === 'lost' || status?.state === 'offline';
}

/**
 * Machine switches re-scope this window; reconnects restore the SAME complete
 * view a fresh open produces, then ask main to re-broadcast what only it can
 * push (pending approvals/questions, fleet and subagent reload signals).
 */
export function useChatViewMachineScope({
  session,
  providers,
  machines,
  canPickProjectDir,
  chatStatus,
  streamStartTime,
  enterDraftMode,
  selectSession,
}: UseChatViewMachineScopeOptions): UseChatViewMachineScopeReturn {
  const [reconnectingMachine, setReconnectingMachine] = useState(false);

  // The machine-scoped refresh shared by machine switches and reconnect
  // resync: re-read the host's session list, workspace, and provider surface.
  const refreshMachineScope = useCallback(() => {
    void session.refresh();
    void session.getWorkspace();
    void providers.refresh();
  }, [session.refresh, session.getWorkspace, providers.refresh]);

  // The initial mount value is recorded without side effects (tab restore must win).
  const machineScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const active = machines.activeMachineId;
    if (machineScopeRef.current === null) {
      machineScopeRef.current = active;
      return;
    }
    if (machineScopeRef.current === active) return;
    machineScopeRef.current = active;
    refreshMachineScope();
    void enterDraftMode({ clearComposer: true });
  }, [
    machines.activeMachineId,
    refreshMachineScope,
    enterDraftMode,
  ]);

  const activeMachineConnectionState: MachineStatusEntry['state'] = canPickProjectDir
    ? 'connected'
    : machines.statusOf(machines.activeMachineId).state;
  const activeSessionIdForResync = session.activeSession?.id ?? null;
  const activeSessionIdForResyncRef = useRef(activeSessionIdForResync);
  activeSessionIdForResyncRef.current = activeSessionIdForResync;
  const { reconnectedAt } = useMachineResync({
    machineId: machines.activeMachineId,
    state: activeMachineConnectionState,
    onReconnect: useCallback(() => {
      refreshMachineScope();
      const activeId = activeSessionIdForResyncRef.current;
      if (activeId) {
        void selectSession(activeId, { force: true }).then(() => {
          // The re-open has landed host-side (the session is active for the
          // machine client again), so the session-scoped catch-up resolves
          // against it.
          void window.orchid?.machines?.resync?.();
        });
      } else {
        void window.orchid?.machines?.resync?.();
      }
    }, [refreshMachineScope, selectSession]),
  });

  // A remote machine that dropped (or was never reconnected) shows an inline
  // banner above the stream; the manager keeps retrying while `lost`.
  const activeMachineStatus = canPickProjectDir
    ? null
    : machines.statusOf(machines.activeMachineId);
  const remoteDisconnected = activeMachineStatus != null && reportsDroppedConnection(activeMachineStatus);
  // Live-turn indicator (U10): the resync re-open seeds the projection with the
  // host snapshot's own start time, so a turn older than the reconnect anchors
  // on it. Locally started turns already have the footer's Running state.
  const turnPredatesReconnect = reconnectedAt != null
    && streamStartTime != null
    && streamStartTime <= reconnectedAt;
  const resumedLiveTurnStartedAt = !canPickProjectDir
    && chatStatus === 'streaming'
    && turnPredatesReconnect
    ? streamStartTime
    : null;

  const handleMachineReconnect = useCallback(async () => {
    if (canPickProjectDir) return;
    setReconnectingMachine(true);
    try {
      await machines.connect(machines.activeMachineId);
    } finally {
      setReconnectingMachine(false);
    }
  }, [canPickProjectDir, machines]);

  return {
    activeMachineStatus,
    remoteDisconnected,
    resumedLiveTurnStartedAt,
    reconnectingMachine,
    handleMachineReconnect,
  };
}
