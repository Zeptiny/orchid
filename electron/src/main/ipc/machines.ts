/**
 * Machines IPC — machines:list, machines:create, machines:update, machines:delete.
 *
 * Registry CRUD only: connection semantics (SSH transport, host keys) arrive
 * with the connection manager. Every mutation broadcasts machines:changed with
 * the fresh ordered list so windows can re-render without a round-trip.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { MachineRecord } from '../../shared/types/machine';
import { getMachineRegistry } from '../machines/registry';
import { machinesCreateSchema, machinesDeleteSchema, machinesUpdateSchema } from './payload-schemas';

function broadcastMachinesChanged(machines: MachineRecord[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IPC_CHANNELS.MACHINES_CHANGED, { machines });
    } catch (error) {
      // One destroyed/racing window must not starve the remaining windows.
      console.warn('Failed to broadcast machines:changed to a window:', error);
    }
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMachinesIPC(): void {
  const registry = getMachineRegistry();

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
      broadcastMachinesChanged(await registry.list());
    }
    return result;
  });
}

/**
 * Unregister machines IPC handlers (for cleanup/testing).
 */
export function unregisterMachinesIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.MACHINES_DELETE);
}
