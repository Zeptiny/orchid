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
import {
  getConfig,
  ConfigManager,
  atomicWriteJson,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
} from '../config/loader';
import { mergeConfigUpdates } from '../config/merge';
import { configSchema } from '../config/schema';
import { resolveModelMetadata } from '../llm/model-metadata';
import { discoverModelsAsync } from '../llm/providers';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import {
  encryptAndStore,
  providerKeychainKey,
  redactConfig,
} from '../config/keychain';
import {
  applyWorkspaceProjectLayers,
  resetLastAppliedProjectDir,
} from '../project/layers';

// ── Zod validation schemas ───────────────────────────────────────────────────

/**
 * Known top-level config keys — extracted from configSchema so the IPC
 * boundary rejects typos like `{ providres: ... }` that would silently no-op.
 */
const KNOWN_CONFIG_KEYS = new Set(Object.keys(configSchema.shape));

/**
 * Accept partial config updates, including `null` tombstones for deleting
 * nested map entries (e.g. `providers.openai: null`).
 *
 * Top-level keys are validated against known config schema keys so typos
 * are rejected at the boundary rather than silently ignored.
 *
 * Structure is validated after deep-merge via `configSchema.parse`.
 */
const configSaveSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
}).superRefine((data, ctx) => {
  for (const key of Object.keys(data.updates)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown config key: "${key}". Known keys: ${[...KNOWN_CONFIG_KEYS].sort().join(', ')}`,
        path: ['updates', key],
      });
    }
  }
});

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

  // config:list_personalities — names from ~/.orchid/personalities/*.md
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES, async () => {
    // Reload so newly-added files appear without restarting the app
    loadPersonalities();
    return listPersonalityNames();
  });

  // config:save — merge updates into the home config and persist.
  // API keys in providers are stored in the keychain and removed from the
  // config file before persistence.
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
      // (providers, rag, tier_models, mcp_servers) preserve sibling fields/aliases
      // instead of replacing the entire nested map (P1-18 / P1-19).
      const current = getConfig();
      const merged = mergeConfigUpdates(
        current as unknown as Record<string, unknown>,
        updates,
      );

      // Validate the merged result
      const validated = configSchema.parse(merged);

      // Extract API keys from providers and store in keychain
      const providers = validated.providers as Record<string, unknown>;
      const providersWithoutKeys = await storeProviderKeys(providers);

      // Persist config with keys stripped
      const configToSave = { ...validated, providers: providersWithoutKeys };
      atomicWriteJson(HOME_CONFIG_PATH, configToSave);

      // Capture sticky before reset — validated config is about to leave the cache.
      // Without re-applying project layers, lastAppliedProjectDir can stay on a
      // stale project while the in-memory config is home-only / wrong overlays.
      const sticky = configToSave.default_project_dir;

      // Reset the cached config so next load picks up changes
      ConfigManager.reset();
      resetLastAppliedProjectDir();

      if (sticky != null && sticky !== '') {
        // Re-merge project .orchid.json + agents/skills for the sticky workspace.
        applyWorkspaceProjectLayers(sticky);
      } else {
        // Home-only load — never fall back to process.cwd() as project root (R2).
        ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
      }

      return { status: 'saved' as const };
    });
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
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES);
}
