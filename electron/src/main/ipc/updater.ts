/**
 * Updater IPC handlers — updater:check, updater:install, updater:status.
 *
 * Wraps the auto-updater module for renderer communication.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  checkForUpdates,
  quitAndInstall,
  getUpdaterState,
  downloadUpdate,
} from '../updater';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerUpdaterIPC(): void {
  // updater:check — manually check for updates
  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async () => {
    await checkForUpdates();
    return getUpdaterState();
  });

  // updater:install — quit and install the downloaded update
  ipcMain.handle(IPC_CHANNELS.UPDATER_INSTALL, async () => {
    quitAndInstall();
    return { status: 'installing' };
  });

  // updater:status — get current update status
  ipcMain.handle(IPC_CHANNELS.UPDATER_STATUS, async () => {
    return getUpdaterState();
  });

  // updater:download — manually download the update (for unsigned builds)
  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
    await downloadUpdate();
    return getUpdaterState();
  });
}

/**
 * Unregister updater IPC handlers (for cleanup/testing).
 */
export function unregisterUpdaterIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_CHECK);
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_INSTALL);
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_STATUS);
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_DOWNLOAD);
}
