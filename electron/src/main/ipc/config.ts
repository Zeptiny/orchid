/**
 * Config IPC handlers — config:get, config:save, config:get_home,
 * config:read_project, config:save_project, config:list_personalities.
 *
 * The read/merge/write core lives in `config/persist.ts` (electron-free,
 * shared with the headless host); this module owns handler registration and
 * the project-target authorization the IPC boundary performs.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getConfig } from '../config/loader';
import {
  loadHomeConfig,
  readProjectConfig,
  saveHomeConfigUpdates,
  saveProjectConfigUpdates,
} from '../config/persist';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import {
  configSaveSchema,
  configSaveProjectSchema,
  configReadProjectSchema,
} from './payload-schemas';
import { resolveAuthorizedProjectDir } from './project-target';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerConfigIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_HOME, async () => {
    return loadHomeConfig();
  });

  // config:list_personalities — home personalities only (~/.orchid/personalities).
  // Project personalities are applied at chat time via ProjectRuntime, not this list.
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES, async () => {
    // Reload so newly-added files appear without restarting the app.
    loadPersonalities();
    return listPersonalityNames();
  });

  // config:save — merge general preference updates into the home config.
  // Validation of the payload happens here (pure, outside the save lock); the
  // serialized read → merge → write cycle lives in config/persist.ts.
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, payload: unknown) => {
    const parsed = configSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid config:save payload: ${parsed.error.message}`);
    }
    return saveHomeConfigUpdates(parsed.data.updates);
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_READ_PROJECT, async (event, projectDir: unknown) => {
    const parsed = configReadProjectSchema.safeParse(projectDir);
    if (!parsed.success) {
      throw new Error('config:read_project requires a non-empty projectDir string');
    }
    const verifiedProjectDir = resolveAuthorizedProjectDir(event.sender.id, parsed.data);
    return readProjectConfig(verifiedProjectDir);
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE_PROJECT, async (event, payload: unknown) => {
    const parsed = configSaveProjectSchema.parse(payload);
    const { projectDir, updates } = parsed;

    const verifiedProjectDir = resolveAuthorizedProjectDir(event.sender.id, projectDir);
    return saveProjectConfigUpdates(verifiedProjectDir, updates);
  });
}

/**
 * Unregister config IPC handlers (for cleanup/testing).
 */
export function unregisterConfigIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET_HOME);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_READ_PROJECT);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE_PROJECT);
}
