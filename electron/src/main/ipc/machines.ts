/**
 * Machines IPC — registry CRUD plus connection/status and per-window active
 * machine (issue #112, plan units U6/U8).
 *
 * Registry mutations broadcast `machines:changed` with the fresh ordered list;
 * connection-manager transitions broadcast `machines:status_changed` with every
 * machine's status entry. Expected failure modes (unpinned host keys, refused
 * switches, scan failures) are typed results, not thrown errors, so the
 * renderer can prompt instead of parsing message strings.
 *
 * Connection wiring: `machines:connect` gates on a pinned known-hosts file
 * (TOFU), asks the connection manager to connect, then registers a HostClient
 * for the machine's live transport in `host/routing.ts`. Auto-reconnects ride
 * the manager's status subscription, which re-attaches the client whenever a
 * machine reaches `connected`.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  MachineActionError,
  MachineConnectResult,
  MachineDisconnectResult,
  MachineErrorView,
  MachineRecord,
  MachineResyncResult,
  MachineScanHostKeyResult,
  MachineSetActiveResult,
  MachineStatusEntry,
  MachineStatusResult,
  MachineConfirmHostKeyResult,
  RemoteMachineRecord,
} from '../../shared/types/ipc';
import { getMachineRegistry } from '../machines/registry';
import {
  getMachineConnectionManager,
  MachineConnectionError,
  type MachineConnectionManager,
  type MachineConnectionStatus,
} from '../machines/connection-manager';
import {
  getMachineHostKeyFlow,
  MachineHostKeyFlowError,
} from '../machines/host-key-flow';
import { HostKeyScanError } from '../machines/host-key';
import {
  attachRemoteMachineClient,
  detachAllRemoteMachineClients,
  detachRemoteMachineClient,
} from '../machines/remote-clients';
import { resyncRemoteMachine } from '../machines/resync';
import {
  activeMachineFor,
  getHostClient,
  LOCAL_MACHINE_ID,
  registeredMachines,
  resetWindowsForMachine,
  setActiveMachine,
} from '../host/routing';
import {
  machinesCreateSchema,
  machinesDeleteSchema,
  machinesMachineIdSchema,
  machinesUpdateSchema,
} from './payload-schemas';

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    } catch (error) {
      // One destroyed/racing window must not starve the remaining windows.
      console.warn(`Failed to broadcast '${channel}' to a window:`, error);
    }
  }
}

function broadcastMachinesChanged(machines: MachineRecord[]): void {
  broadcastToAllWindows(IPC_CHANNELS.MACHINES_CHANGED, { machines });
}

/** Serialize a connect/scan failure into the renderer-safe error view. */
function toErrorView(
  error: unknown,
  fallbackKind = 'unknown',
): MachineErrorView {
  if (error instanceof MachineConnectionError) {
    return { kind: error.kind, message: error.message, hint: error.hint };
  }
  if (error instanceof HostKeyScanError) {
    const detail = error.stderrExcerpt.trim();
    return {
      kind: 'host-key-scan-failed',
      message: error.message,
      hint: detail !== '' ? `ssh-keyscan: ${detail}` : 'Check the host, port, and network reachability.',
    };
  }
  if (error instanceof MachineHostKeyFlowError) {
    return { kind: error.kind, message: error.message, hint: 'Scan the host keys and review them before confirming.' };
  }
  return {
    kind: fallbackKind,
    message: error instanceof Error ? error.message : String(error),
    hint: '',
  };
}

function actionError(
  error: unknown,
  extra: Partial<MachineActionError> = {},
): MachineActionError {
  return { ...toErrorView(error), ...extra };
}

function statusEntryFor(
  machine: MachineRecord,
  manager: MachineConnectionManager,
): MachineStatusEntry {
  if (machine.kind === 'local') {
    return { machineId: machine.id, state: 'connected', error: null, reconnectAttempts: 0 };
  }
  const status = manager.getStatus(machine.id);
  return {
    machineId: machine.id,
    state: status.state,
    error: status.error ? toErrorView(status.error) : null,
    reconnectAttempts: status.reconnectAttempts,
  };
}

async function statusResult(
  manager: MachineConnectionManager,
): Promise<MachineStatusResult> {
  const machines = await getMachineRegistry().list();
  return { machines: machines.map((machine) => statusEntryFor(machine, manager)) };
}

async function findMachine(machineId: string): Promise<MachineRecord | null> {
  const machines = await getMachineRegistry().list();
  return machines.find((machine) => machine.id === machineId) ?? null;
}

function requireRemote(
  machine: MachineRecord,
): { machine: RemoteMachineRecord } | { error: MachineActionError } {
  if (machine.kind !== 'ssh') {
    return {
      error: {
        kind: 'not-remote',
        message: `Machine '${machine.id}' is the local machine and connects in-process, not over SSH.`,
        hint: '',
      },
    };
  }
  return { machine };
}

// ── IPC registration ─────────────────────────────────────────────────────────

/** Manager status subscription installed by registerMachinesIPC. */
let unsubscribeManagerStatus: (() => void) | null = null;

export function registerMachinesIPC(): void {
  const registry = getMachineRegistry();
  const manager = getMachineConnectionManager();
  const hostKeyFlow = getMachineHostKeyFlow();

  const broadcastStatusChanged = (): void => {
    void statusResult(manager).then((result) => {
      broadcastToAllWindows(IPC_CHANNELS.MACHINES_STATUS_CHANGED, result);
    }).catch((error: unknown) => {
      console.warn('Failed to broadcast machines:status_changed:', error);
    });
  };

  // Manager transitions drive both the status broadcast and (on connected) the
  // host-client attachment, so manual connects and auto-reconnects are wired
  // through one seam. Every (re)attach immediately resyncs the machine's
  // pending state to its windows (U10): the fresh connection id a remote host
  // assigned means owner-scoped snapshots alone cannot restore pending
  // approvals/questions.
  unsubscribeManagerStatus = manager.subscribe('*', (status: MachineConnectionStatus) => {
    if (status.state === 'connected') {
      const transport = manager.getTransport(status.machineId);
      if (transport) {
        void findMachine(status.machineId).then((machine) => {
          if (!machine || machine.kind !== 'ssh') return;
          // The machine may have disconnected or been deleted while the record
          // was resolving — never resurrect a torn-down client.
          if (manager.getStatus(status.machineId).state !== 'connected') return;
          if (manager.getTransport(status.machineId) !== transport) return;
          const client = attachRemoteMachineClient(machine, transport);
          void resyncRemoteMachine(machine.id, client).catch(() => {
            // Non-fatal: windows still re-fetch through their refresh path.
          });
        }).catch(() => {
          // The status broadcast below still reports the transition.
        });
      }
    }
    broadcastStatusChanged();
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_LIST, async () => {
    return { machines: await registry.list() };
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_CREATE, async (_event, payload: unknown) => {
    const parsed = machinesCreateSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:create payload: ${parsed.error.message}`);
    }
    const machine = await registry.create(parsed.data);
    broadcastMachinesChanged(await registry.list());
    return machine;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_UPDATE, async (_event, payload: unknown) => {
    const parsed = machinesUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:update payload: ${parsed.error.message}`);
    }
    const { id, patch } = parsed.data;
    const machine = await registry.update(id, patch);
    broadcastMachinesChanged(await registry.list());
    return machine;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_DELETE, async (_event, payload: unknown) => {
    const parsed = machinesDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:delete payload: ${parsed.error.message}`);
    }
    const result = await registry.remove(parsed.data.id);
    if (result.status === 'deleted') {
      // The machine cannot be driven anymore: drop its connection + client and
      // reset every window still pointing at it back to the local machine.
      detachRemoteMachineClient(parsed.data.id);
      manager.disconnect(parsed.data.id);
      hostKeyFlow.forget(parsed.data.id);
      resetWindowsForMachine(parsed.data.id);
      broadcastMachinesChanged(await registry.list());
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_GET_STATUS, async () => {
    return statusResult(manager);
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_GET_ACTIVE, async (event) => {
    return { machineId: activeMachineFor(String(event.sender.id)) };
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_SET_ACTIVE, async (event, payload: unknown) => {
    const parsed = machinesMachineIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:set_active payload: ${parsed.error.message}`);
    }
    const { machineId } = parsed.data;
    const windowId = String(event.sender.id);
    if (machineId !== LOCAL_MACHINE_ID) {
      const machine = await findMachine(machineId);
      if (!machine) {
        return {
          status: 'error',
          error: {
            kind: 'machine-not-found',
            message: `Unknown machine '${machineId}'.`,
            hint: '',
          },
        } satisfies MachineSetActiveResult;
      }
      const state = manager.getStatus(machineId).state;
      if (state !== 'connected') {
        return {
          status: 'error',
          error: {
            kind: 'not-connected',
            message: `Machine '${machine.label}' is ${state}; connect it before switching.`,
            hint: 'Use Connect on the machine to establish the session first.',
          },
        } satisfies MachineSetActiveResult;
      }
    }
    setActiveMachine(windowId, machineId);
    return { status: 'ok', machineId } satisfies MachineSetActiveResult;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_CONNECT, async (_event, payload: unknown) => {
    const parsed = machinesMachineIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:connect payload: ${parsed.error.message}`);
    }
    const machine = await findMachine(parsed.data.machineId);
    if (!machine) {
      return {
        status: 'error',
        error: {
          kind: 'machine-not-found',
          message: `Unknown machine '${parsed.data.machineId}'.`,
          hint: '',
        },
      } satisfies MachineConnectResult;
    }
    const remote = requireRemote(machine);
    if ('error' in remote) return { status: 'error', error: remote.error } satisfies MachineConnectResult;

    if (!hostKeyFlow.pinned(remote.machine.id)) {
      // TOFU gate: scan now so the UI can show fingerprints and confirm-host-key
      // pins exactly this scan before the user retries the connect.
      try {
        const fingerprints = await hostKeyFlow.scan(remote.machine);
        if (fingerprints.length === 0) throw new HostKeyScanError(
          'no-keys',
          `ssh-keyscan returned no usable host keys for ${remote.machine.host}:${remote.machine.port}.`,
        );
        return {
          status: 'error',
          error: {
            kind: 'host-key-not-pinned',
            message: `No pinned host keys for '${remote.machine.label}' (${remote.machine.host}).`,
            hint: 'Review the scanned fingerprints and confirm them to pin before connecting.',
            fingerprints,
          },
        } satisfies MachineConnectResult;
      } catch (error) {
        return { status: 'error', error: actionError(error) } satisfies MachineConnectResult;
      }
    }

    try {
      await manager.connect(remote.machine);
    } catch (error) {
      return { status: 'error', error: actionError(error) } satisfies MachineConnectResult;
    }
    const transport = manager.getTransport(remote.machine.id);
    if (!transport) {
      return {
        status: 'error',
        error: {
          kind: 'transport-closed',
          message: `The connection to '${remote.machine.label}' closed before the client could attach.`,
          hint: 'Retry the connect.',
        },
      } satisfies MachineConnectResult;
    }
    const client = attachRemoteMachineClient(remote.machine, transport);
    void resyncRemoteMachine(remote.machine.id, client).catch(() => {
      // Non-fatal: windows still re-fetch through their refresh path.
    });
    return {
      status: 'ok',
      machine: statusEntryFor(remote.machine, manager),
    } satisfies MachineConnectResult;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_RESYNC, async (event) => {
    const machineId = activeMachineFor(String(event.sender.id));
    if (machineId === LOCAL_MACHINE_ID || !registeredMachines().includes(machineId)) {
      // The local machine rehydrates through its own paths; nothing to push.
      return { status: 'ok', machineId, resynced: false } satisfies MachineResyncResult;
    }
    const machine = await findMachine(machineId);
    if (!machine || machine.kind !== 'ssh') {
      return { status: 'ok', machineId, resynced: false } satisfies MachineResyncResult;
    }
    try {
      await resyncRemoteMachine(machineId, getHostClient(machineId));
      return { status: 'ok', machineId, resynced: true } satisfies MachineResyncResult;
    } catch (error) {
      return {
        status: 'error',
        machineId,
        error: actionError(error),
      } satisfies MachineResyncResult;
    }
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_DISCONNECT, async (_event, payload: unknown) => {
    const parsed = machinesMachineIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:disconnect payload: ${parsed.error.message}`);
    }
    const { machineId } = parsed.data;
    if (machineId === LOCAL_MACHINE_ID) {
      return {
        status: 'error',
        error: {
          kind: 'not-remote',
          message: 'The local machine connects in-process and cannot be disconnected.',
          hint: '',
        },
      } satisfies MachineDisconnectResult;
    }
    detachRemoteMachineClient(machineId);
    manager.disconnect(machineId);
    return { status: 'ok' } satisfies MachineDisconnectResult;
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY, async (_event, payload: unknown) => {
    const parsed = machinesMachineIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:scan_host_key payload: ${parsed.error.message}`);
    }
    const machine = await findMachine(parsed.data.machineId);
    if (!machine) {
      return {
        status: 'error',
        error: {
          kind: 'machine-not-found',
          message: `Unknown machine '${parsed.data.machineId}'.`,
          hint: '',
        },
      } satisfies MachineScanHostKeyResult;
    }
    const remote = requireRemote(machine);
    if ('error' in remote) return { status: 'error', error: remote.error } satisfies MachineScanHostKeyResult;
    try {
      const fingerprints = await hostKeyFlow.scan(remote.machine);
      if (fingerprints.length === 0) {
        return {
          status: 'error',
          error: {
            kind: 'host-key-scan-failed',
            message: `ssh-keyscan returned no usable host keys for ${remote.machine.host}:${remote.machine.port}.`,
            hint: 'The host may be reachable but speak no supported key algorithms.',
          },
        } satisfies MachineScanHostKeyResult;
      }
      return { status: 'scanned', fingerprints } satisfies MachineScanHostKeyResult;
    } catch (error) {
      return { status: 'error', error: actionError(error) } satisfies MachineScanHostKeyResult;
    }
  });

  ipcMain.handle(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY, async (_event, payload: unknown) => {
    const parsed = machinesMachineIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid machines:confirm_host_key payload: ${parsed.error.message}`);
    }
    const machine = await findMachine(parsed.data.machineId);
    if (!machine) {
      return {
        status: 'error',
        error: {
          kind: 'machine-not-found',
          message: `Unknown machine '${parsed.data.machineId}'.`,
          hint: '',
        },
      } satisfies MachineConfirmHostKeyResult;
    }
    const remote = requireRemote(machine);
    if ('error' in remote) return { status: 'error', error: remote.error } satisfies MachineConfirmHostKeyResult;
    try {
      return {
        status: 'pinned',
        fingerprints: hostKeyFlow.confirm(remote.machine.id),
      } satisfies MachineConfirmHostKeyResult;
    } catch (error) {
      return { status: 'error', error: actionError(error) } satisfies MachineConfirmHostKeyResult;
    }
  });

}

function unregisterMachinesIPCHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_GET_STATUS);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_GET_ACTIVE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_SET_ACTIVE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_CONNECT);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_DISCONNECT);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_RESYNC);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY);
}

/**
 * Unregister machines IPC handlers (for cleanup/testing): drop the handlers,
 * the manager subscription, and every attached remote client.
 */
export function unregisterMachinesIPC(): void {
  unsubscribeManagerStatus?.();
  unsubscribeManagerStatus = null;
  unregisterMachinesIPCHandlers();
  detachAllRemoteMachineClients();
}
