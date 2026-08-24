/**
 * useMachines — machine list, connection status, and the window's active
 * machine (issue #112, plan unit U8).
 *
 * Shared module store (pattern: useProviders/useSession) so the chat shell,
 * the switcher/wizard, and the Machines settings tab reuse one snapshot.
 * Expected action failures are typed `MachineActionError` values (never thrown
 * message strings), so the wizard can prompt TOFU confirmation or surface the
 * connect hint verbatim.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { MACHINE_ID_LOCAL } from '../../shared/types/machine';
import type { MachineRecord } from '../../shared/types/machine';
import type {
  MachineActionError,
  MachineActiveResult,
  MachineConfirmHostKeyResult,
  MachineConnectResult,
  MachineCreateMessage,
  MachineDeleteResult,
  MachineDisconnectResult,
  MachineScanHostKeyResult,
  MachineSetActiveResult,
  MachineStatusEntry,
  MachineUpdateMessage,
  MachinesChangedEvent,
  MachinesStatusChangedEvent,
  RemoteMachineRecord,
} from '../../shared/types/ipc';

export type MachinesLoadStatus = 'loading' | 'ready' | 'error';

export interface MachinesState {
  readonly status: MachinesLoadStatus;
  readonly machines: readonly MachineRecord[];
  readonly statuses: ReadonlyMap<string, MachineStatusEntry>;
  readonly activeMachineId: string;
  /** Registry/list load failure. */
  readonly error: string | null;
  /** Last failed action (connect/switch/scan/confirm); null when healthy. */
  readonly actionError: MachineActionError | null;
}

export interface UseMachinesReturn {
  readonly state: MachinesState;
  readonly machines: readonly MachineRecord[];
  readonly statuses: ReadonlyMap<string, MachineStatusEntry>;
  /** Status entry with a safe default (local: connected; unknown: offline). */
  readonly statusOf: (machineId: string) => MachineStatusEntry;
  readonly activeMachineId: string;
  readonly activeMachine: MachineRecord | null;
  readonly activeMachineLabel: string;
  readonly isActiveMachineLocal: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly actionError: MachineActionError | null;
  readonly refresh: () => Promise<void>;
  readonly refreshActive: () => Promise<void>;
  readonly clearActionError: () => void;
  readonly switchTo: (machineId: string) => Promise<MachineSetActiveResult>;
  readonly connect: (machineId: string) => Promise<MachineConnectResult>;
  readonly disconnect: (machineId: string) => Promise<MachineDisconnectResult>;
  readonly createMachine: (message: MachineCreateMessage) => Promise<RemoteMachineRecord>;
  readonly updateMachine: (message: MachineUpdateMessage) => Promise<RemoteMachineRecord>;
  readonly deleteMachine: (machineId: string) => Promise<MachineDeleteResult>;
  readonly scanHostKey: (machineId: string) => Promise<MachineScanHostKeyResult>;
  readonly confirmHostKey: (machineId: string) => Promise<MachineConfirmHostKeyResult>;
}

const LOCAL_CONNECTED: MachineStatusEntry = {
  machineId: MACHINE_ID_LOCAL,
  state: 'connected',
  error: null,
  reconnectAttempts: 0,
};

const OFFLINE_DEFAULT = (machineId: string): MachineStatusEntry => ({
  machineId,
  state: 'offline',
  error: null,
  reconnectAttempts: 0,
});

const INITIAL_STATE: MachinesState = {
  status: 'loading',
  machines: [],
  statuses: new Map([[MACHINE_ID_LOCAL, LOCAL_CONNECTED]]),
  activeMachineId: MACHINE_ID_LOCAL,
  error: null,
  actionError: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownActionError(error: unknown): MachineActionError {
  return {
    kind: 'unknown',
    message: errorMessage(error),
    hint: '',
  };
}

// ── Shared store (one snapshot for all useMachines() callers) ────────────────

type Listener = () => void;

let sharedState = INITIAL_STATE;
/** Stable snapshot for useSyncExternalStore (Object.is between emits). */
let cachedSnapshot = sharedState;
let bootstrapped = false;
let subscriptionsInstalled = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<MachinesState>): void {
  const merged = { ...sharedState, ...next };
  if (
    merged.status === sharedState.status
    && merged.machines === sharedState.machines
    && merged.statuses === sharedState.statuses
    && merged.activeMachineId === sharedState.activeMachineId
    && merged.error === sharedState.error
    && merged.actionError === sharedState.actionError
  ) {
    return;
  }
  sharedState = merged;
  cachedSnapshot = merged;
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MachinesState {
  return cachedSnapshot;
}

async function refreshShared(): Promise<void> {
  if (!window.orchid?.machines?.list || !window.orchid?.machines?.getStatus) {
    setState({
      status: sharedState.machines.length > 0 ? 'ready' : 'error',
      error: 'The machines API is not available in this build.',
    });
    return;
  }
  try {
    const [list, status] = await Promise.all([
      window.orchid.machines.list(),
      window.orchid.machines.getStatus(),
    ]);
    setState({
      status: 'ready',
      machines: list.machines,
      statuses: new Map(status.machines.map((entry) => [entry.machineId, entry])),
      error: null,
    });
  } catch (error) {
    setState({
      status: sharedState.machines.length > 0 ? 'ready' : 'error',
      error: errorMessage(error),
    });
  }
}

async function refreshActiveShared(): Promise<void> {
  if (!window.orchid?.machines?.getActive) return;
  try {
    const result: MachineActiveResult = await window.orchid.machines.getActive();
    setState({ activeMachineId: result.machineId });
  } catch {
    // Keep the current value; the next successful getActive re-syncs.
  }
}

/** Record a typed action failure (result-level or thrown) on the store. */
function recordActionError(error: MachineActionError): void {
  setState({ actionError: error });
}

function installSubscriptions(): void {
  if (subscriptionsInstalled) return;
  subscriptionsInstalled = true;
  window.orchid?.machines?.onChanged?.((event: MachinesChangedEvent) => {
    setState({ machines: event.machines });
    // Registry changes can remove the active machine (delete resets windows to
    // local in main); re-read the authoritative per-window value.
    void refreshActiveShared();
    void refreshShared();
  });
  window.orchid?.machines?.onStatusChanged?.((event: MachinesStatusChangedEvent) => {
    setState({ statuses: new Map(event.machines.map((entry) => [entry.machineId, entry])) });
  });
}

function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  installSubscriptions();
  void refreshShared();
  void refreshActiveShared();
}

/** Test-only access to the shared cache (not for product code). */
export const __machinesCacheTest = {
  reset(): void {
    sharedState = INITIAL_STATE;
    cachedSnapshot = sharedState;
    bootstrapped = false;
    subscriptionsInstalled = false;
    listeners.clear();
  },
  getState: (): MachinesState => sharedState,
  getSnapshot,
  subscribe,
  refresh: refreshShared,
  refreshActive: refreshActiveShared,
};

function machinesApi(): NonNullable<typeof window.orchid>['machines'] {
  const api = window.orchid?.machines;
  if (!api) {
    throw new Error('The machines API is not available in this build.');
  }
  return api;
}

/**
 * Machines connection state for the chat header switcher, the add-machine
 * wizard, and the Machines settings tab.
 */
export function useMachines(): UseMachinesReturn {
  ensureBootstrapped();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(async (): Promise<void> => {
    await refreshShared();
  }, []);

  const refreshActive = useCallback(async (): Promise<void> => {
    await refreshActiveShared();
  }, []);

  const clearActionError = useCallback(() => {
    setState({ actionError: null });
  }, []);

  const switchTo = useCallback(async (machineId: string): Promise<MachineSetActiveResult> => {
    try {
      const result = await machinesApi().setActive({ machineId });
      if (result.status === 'ok') {
        setState({ activeMachineId: result.machineId, actionError: null });
      } else {
        recordActionError(result.error);
      }
      return result;
    } catch (error) {
      const actionError = unknownActionError(error);
      recordActionError(actionError);
      return { status: 'error', error: actionError };
    }
  }, []);

  const connect = useCallback(async (machineId: string): Promise<MachineConnectResult> => {
    try {
      const result = await machinesApi().connect({ machineId });
      if (result.status === 'error') recordActionError(result.error);
      else setState({ actionError: null });
      return result;
    } catch (error) {
      const actionError = unknownActionError(error);
      recordActionError(actionError);
      return { status: 'error', error: actionError };
    }
  }, []);

  const disconnect = useCallback(async (machineId: string): Promise<MachineDisconnectResult> => {
    try {
      const result = await machinesApi().disconnect({ machineId });
      if (result.status === 'error') recordActionError(result.error);
      else setState({ actionError: null });
      return result;
    } catch (error) {
      const actionError = unknownActionError(error);
      recordActionError(actionError);
      return { status: 'error', error: actionError };
    }
  }, []);

  const createMachine = useCallback(async (
    message: MachineCreateMessage,
  ): Promise<RemoteMachineRecord> => {
    return machinesApi().create(message);
  }, []);

  const updateMachine = useCallback(async (
    message: MachineUpdateMessage,
  ): Promise<RemoteMachineRecord> => {
    return machinesApi().update(message);
  }, []);

  const deleteMachine = useCallback(async (machineId: string): Promise<MachineDeleteResult> => {
    return machinesApi().delete({ id: machineId });
  }, []);

  const scanHostKey = useCallback(async (machineId: string): Promise<MachineScanHostKeyResult> => {
    try {
      return await machinesApi().scanHostKey({ machineId });
    } catch (error) {
      const actionError = unknownActionError(error);
      recordActionError(actionError);
      return { status: 'error', error: actionError };
    }
  }, []);

  const confirmHostKey = useCallback(async (
    machineId: string,
  ): Promise<MachineConfirmHostKeyResult> => {
    try {
      return await machinesApi().confirmHostKey({ machineId });
    } catch (error) {
      const actionError = unknownActionError(error);
      recordActionError(actionError);
      return { status: 'error', error: actionError };
    }
  }, []);

  const statusOf = useCallback((machineId: string): MachineStatusEntry => {
    if (machineId === MACHINE_ID_LOCAL) {
      return state.statuses.get(machineId) ?? LOCAL_CONNECTED;
    }
    return state.statuses.get(machineId) ?? OFFLINE_DEFAULT(machineId);
  }, [state.statuses]);

  const activeMachine = state.machines.find((machine) => machine.id === state.activeMachineId) ?? null;
  const isActiveMachineLocal = state.activeMachineId === MACHINE_ID_LOCAL;

  return {
    state,
    machines: state.machines,
    statuses: state.statuses,
    statusOf,
    activeMachineId: state.activeMachineId,
    activeMachine,
    activeMachineLabel: activeMachine?.label ?? 'This machine',
    isActiveMachineLocal,
    isLoading: state.status === 'loading',
    error: state.error,
    actionError: state.actionError,
    refresh,
    refreshActive,
    clearActionError,
    switchTo,
    connect,
    disconnect,
    createMachine,
    updateMachine,
    deleteMachine,
    scanHostKey,
    confirmHostKey,
  };
}
