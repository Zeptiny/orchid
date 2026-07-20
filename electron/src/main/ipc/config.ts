/**
 * Config IPC handlers — config:get, config:save.
 *
 * Wraps ConfigManager with zod-validated payloads.
 * Provider connections live in their own store and IPC surface; this boundary
 * fails closed for legacy provider aliases and secrets in the config document.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  getConfig,
  getConfigDiagnostics,
  ConfigManager,
  atomicWriteJson,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
} from '../config/loader';
import { mergeConfigUpdates } from '../config/merge';
import { configSchema } from '../config/schema';
import {
  clearModelMetadataCache,
  resolveModelMetadata,
} from '../llm/model-metadata';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import { invalidateAllProjectMCPManagers } from '../mcp/project-registry';
import { configSaveSchema } from './payload-schemas';

// ── Config save lock ────────────────────────────────────────────────────────

/**
 * Promise chain that serializes config:save operations.
 *
 * Without this, concurrent IPC calls each read the same `getConfig()` snapshot,
 * merge different updates, and the last writer overwrites earlier providers/
 * settings — a classic read-modify-write race (P1-3).
 *
 * The chain ensures each save reads → merges → writes atomically before the
 * next save begins. Errors from prior operations do not block subsequent ones.
 */
let configSaveChain: Promise<void> = Promise.resolve();

/**
 * Run `fn` exclusively after any prior config save completes.
 * Errors from previous operations do not block subsequent ones.
 *
 * Exported so sticky `default_project_dir` patches share the same lock and
 * cannot race with config:save read-modify-write cycles.
 */
export function withConfigSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = configSaveChain;
  const run = previous.catch(() => undefined).then(fn);
  // Update the chain — swallow both success and error so the chain never blocks
  configSaveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Reset the config-save chain. For test isolation only.
 * @internal
 */
export function _resetConfigSaveChainForTests(): void {
  configSaveChain = Promise.resolve();
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerConfigIPC(): void {
  // config:get — provider connection metadata and credentials never travel in
  // this general configuration response.
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return { ...getConfig(), providers: {} };
  });

  // Expose only non-secret compatibility notices. This lets the renderer
  // explain why a legacy provider/default was reset instead of silently
  // presenting a disconnected workspace.
  ipcMain.handle(IPC_CHANNELS.CONFIG_DIAGNOSTICS, async () => {
    return getConfigDiagnostics({ projectDir: HOME_CONFIG_DIR });
  });

  // config:model_metadata — resolve metadata for a given model ID
  ipcMain.handle(IPC_CHANNELS.CONFIG_MODEL_METADATA, async (_event, modelId: unknown) => {
    if (typeof modelId !== 'string' || !modelId) {
      throw new Error('config:model_metadata requires a non-empty modelId string');
    }
    return resolveModelMetadata(modelId);
  });

  // config:list_personalities — home personalities only (~/.orchid/personalities).
  // Project personalities are applied at chat time via ProjectRuntime, not this list.
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES, async () => {
    // Reload so newly-added files appear without restarting the app.
    loadPersonalities();
    return listPersonalityNames();
  });

  // config:save — merge general preference updates into the home config.
  //
  // The entire read → merge → write cycle is serialized via withConfigSaveLock
  // so concurrent saves cannot read a stale snapshot and overwrite each other
  // (P1-3).  Zod validation happens outside the lock since it is pure and cheap.
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, payload: unknown) => {
    // Validate input with zod (pure, no shared state — safe outside the lock)
    const parsed = configSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid config:save payload: ${parsed.error.message}`);
    }

    const { updates } = parsed.data;

    // Serialize the read → merge → write cycle so concurrent saves don't race.
    // getConfig() is called *inside* the lock to avoid reading a stale snapshot
    // before the lock and then writing after another save has already persisted.
    return withConfigSaveLock(async () => {
      // Load current config and deep-merge updates so partial nested objects
      // (rag, tier_models, mcp_servers) preserve sibling fields/aliases
      // instead of replacing the entire nested map (P1-18 / P1-19).
      const current = getConfig();
      const merged = mergeConfigUpdates(
        current as unknown as Record<string, unknown>,
        updates,
      );

      // Validate the merged result
      const validated = configSchema.parse(merged);

      atomicWriteJson(HOME_CONFIG_PATH, validated);

      // Reset the cached config so next load picks up changes
      ConfigManager.reset();
      // Every project runtime inherits home configuration. Clear the immutable
      // snapshots so only already-running turns retain the previous config.
      clearProjectRuntimeRegistry();
      invalidateAllProjectMCPManagers();
      // Drop model-metadata cache so picker limits reflect new overrides.
      clearModelMetadataCache();

      // Keep the process-wide compatibility cache home-only. Project overlays
      // are independently resolved for the session/turn that needs them.
      ConfigManager.load({ projectDir: HOME_CONFIG_DIR });

      return { status: 'saved' as const };
    });
  });
}

/**
 * Unregister config IPC handlers (for cleanup/testing).
 */
export function unregisterConfigIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_DIAGNOSTICS);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_MODEL_METADATA);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES);
}
