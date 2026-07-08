/**
 * Config IPC handlers — config:get, config:save.
 *
 * Wraps ConfigManager from U3 with zod-validated payloads.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getConfig, ConfigManager, atomicWriteJson, HOME_CONFIG_PATH } from '../config/loader';
import { configSchema } from '../config/schema';

// ── Zod validation schemas ───────────────────────────────────────────────────

const configSaveSchema = z.object({
  updates: configSchema.deepPartial(),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerConfigIPC(): void {
  // config:get — return the current merged config
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return getConfig();
  });

  // config:save — merge updates into the home config and persist
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, payload: unknown) => {
    // Validate input with zod
    const parsed = configSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid config:save payload: ${parsed.error.message}`);
    }

    const { updates } = parsed.data;

    // Load current config, merge updates, save
    const current = getConfig();
    const merged = { ...current, ...updates };

    // Validate the merged result
    const validated = configSchema.parse(merged);

    // Persist to disk
    atomicWriteJson(HOME_CONFIG_PATH, validated);

    // Reset the cached config so next load picks up changes
    ConfigManager.reset();

    return { status: 'saved' };
  });
}

/**
 * Unregister config IPC handlers (for cleanup/testing).
 */
export function unregisterConfigIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE);
}
