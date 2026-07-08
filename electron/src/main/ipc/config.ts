/**
 * Config IPC handlers — config:get, config:save.
 *
 * Wraps ConfigManager from U3 with zod-validated payloads.
 * Integrates keychain (U25) for API key storage:
 * - `config:get` returns redacted API keys (last 4 chars).
 * - `config:save` accepts full keys, stores them in the keychain,
 *   and persists the config with keys stripped.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getConfig, ConfigManager, atomicWriteJson, HOME_CONFIG_PATH } from '../config/loader';
import { configSchema } from '../config/schema';
import { resolveModelMetadata } from '../llm/model-metadata';
import { discoverModelsAsync } from '../llm/providers';
import {
  encryptAndStore,
  providerKeychainKey,
  redactConfig,
} from '../config/keychain';

// ── Zod validation schemas ───────────────────────────────────────────────────

const configSaveSchema = z.object({
  updates: configSchema.deepPartial(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract API keys from providers and store them in the keychain.
 * Returns a new providers dict with `api_key` fields removed.
 */
async function storeProviderKeys(
  providers: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const [alias, entry] of Object.entries(providers)) {
    if (typeof entry !== 'object' || entry === null) {
      result[alias] = entry;
      continue;
    }

    const entryCopy = { ...(entry as Record<string, unknown>) };
    const apiKey = entryCopy['api_key'];

    if (typeof apiKey === 'string' && apiKey) {
      // Store in keychain
      await encryptAndStore(providerKeychainKey(alias), apiKey);
      // Remove from config (we'll resolve from keychain at runtime)
      delete entryCopy['api_key'];
    }

    result[alias] = entryCopy;
  }

  return result;
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerConfigIPC(): void {
  // config:get — return the current merged config with API keys redacted
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    const config = getConfig();
    return redactConfig(config as unknown as Record<string, unknown>);
  });

  // config:model_metadata — resolve metadata for a given model ID
  ipcMain.handle(IPC_CHANNELS.CONFIG_MODEL_METADATA, async (_event, modelId: unknown) => {
    if (typeof modelId !== 'string' || !modelId) {
      throw new Error('config:model_metadata requires a non-empty modelId string');
    }
    const config = getConfig();
    return resolveModelMetadata(modelId, config);
  });

  // config:discover_models — discover models from a provider's GET /models endpoint
  ipcMain.handle(IPC_CHANNELS.CONFIG_DISCOVER_MODELS, async (_event, alias: unknown, force?: unknown) => {
    if (typeof alias !== 'string' || !alias) {
      throw new Error('config:discover_models requires a non-empty alias string');
    }
    const config = getConfig();
    return discoverModelsAsync(alias, config, force === true);
  });

  // config:save — merge updates into the home config and persist.
  // API keys in providers are stored in the keychain and removed from the
  // config file before persistence.
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, payload: unknown) => {
    // Validate input with zod
    const parsed = configSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid config:save payload: ${parsed.error.message}`);
    }

    const { updates } = parsed.data;

    // Load current config, merge updates
    const current = getConfig();
    const merged = { ...current, ...updates };

    // Validate the merged result
    const validated = configSchema.parse(merged);

    // Extract API keys from providers and store in keychain
    const providers = validated.providers as Record<string, unknown>;
    const providersWithoutKeys = await storeProviderKeys(providers);

    // Persist config with keys stripped
    const configToSave = { ...validated, providers: providersWithoutKeys };
    atomicWriteJson(HOME_CONFIG_PATH, configToSave);

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
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_MODEL_METADATA);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_DISCOVER_MODELS);
}
