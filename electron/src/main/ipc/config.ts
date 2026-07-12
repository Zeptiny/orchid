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
import { IPC_CHANNELS, type ProviderRename } from '../../shared/types/ipc';
import {
  getConfig,
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
import { discoverModelsAsync } from '../llm/providers';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import {
  deleteKey,
  encryptAndStore,
  providerKeychainKey,
  redactApiKey,
  redactConfig,
  retrieveAndDecrypt,
} from '../config/keychain';
import { getRuntimeConfig } from '../config/runtime';
import {
  getLastAppliedProjectDir,
} from '../project/layers';
import { clearProjectRuntimeRegistry } from '../project/runtime';

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
const providerAliasSchema = z.string().regex(/^[a-z0-9-]+$/);

const configSaveSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
  providerRenames: z.array(z.object({
    from: providerAliasSchema,
    to: providerAliasSchema,
  })).optional(),
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

/** Extract API keys into the keychain and remove them from persisted config. */
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

    if (typeof apiKey === 'string') {
      if (apiKey) {
        const keychainKey = providerKeychainKey(alias);
        const stored = await retrieveAndDecrypt(keychainKey);
        if (stored === null || redactApiKey(stored) !== apiKey) {
          await encryptAndStore(keychainKey, apiKey);
        }
      }
      // Literal and redacted keys never belong in the config file.
      delete entryCopy['api_key'];
    }

    result[alias] = entryCopy;
  }

  return result;
}

function getProviderMap(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validateProviderRenames(
  currentProviders: Record<string, unknown>,
  providerUpdates: Record<string, unknown>,
  finalProviders: Record<string, unknown>,
  renames: ProviderRename[],
): void {
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  for (const { from, to } of renames) {
    if (seenSources.has(from) || seenTargets.has(to)) {
      throw new Error('Provider rename aliases must be unique');
    }
    seenSources.add(from);
    seenTargets.add(to);
    if (from === to) {
      throw new Error(`Invalid provider rename: source and target are both '${from}'`);
    }
    if (!(from in currentProviders) || currentProviders[to] !== undefined) {
      throw new Error(`Invalid provider rename: '${from}' cannot be renamed to '${to}'`);
    }
    if (providerUpdates[from] !== null || providerUpdates[to] == null) {
      throw new Error(`Invalid provider rename payload for '${from}' → '${to}'`);
    }
    if (from in finalProviders || !(to in finalProviders)) {
      throw new Error(`Provider rename did not produce '${to}'`);
    }
  }
}

async function copyProviderKeysForRenames(
  renames: ProviderRename[],
): Promise<void> {
  for (const { from, to } of renames) {
    const stored = await retrieveAndDecrypt(providerKeychainKey(from));
    if (stored) {
      await encryptAndStore(providerKeychainKey(to), stored);
    } else {
      await deleteKey(providerKeychainKey(to));
    }
  }
}

async function clearStaleKeysForAddedProviders(
  previousProviders: Record<string, unknown>,
  nextProviders: Record<string, unknown>,
  renames: ProviderRename[],
): Promise<void> {
  const renameTargets = new Set(renames.map(({ to }) => to));
  for (const [alias, value] of Object.entries(nextProviders)) {
    if (alias in previousProviders || renameTargets.has(alias)) continue;
    const entry = getProviderMap(value);
    if (typeof entry.api_key !== 'string' || !entry.api_key) {
      await deleteKey(providerKeychainKey(alias));
    }
  }
}

async function deleteRemovedProviderKeys(
  previousProviders: Record<string, unknown>,
  nextProviders: Record<string, unknown>,
): Promise<void> {
  for (const alias of Object.keys(previousProviders)) {
    if (!(alias in nextProviders)) {
      await deleteKey(providerKeychainKey(alias));
    }
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerConfigIPC(): void {
  // config:get — return the current merged config with API keys redacted
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    const config = await getRuntimeConfig();
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
    const config = await getRuntimeConfig();
    return discoverModelsAsync(alias, config, force === true);
  });

  // config:list_personalities — names from home (+ project overlay when layers applied)
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES, async () => {
    // Reload so newly-added files appear without restarting the app.
    // Prefer last applied project dir (set by workspace bind / session load).
    const projectDir = getLastAppliedProjectDir() ?? undefined;
    loadPersonalities(projectDir ? { projectDir } : undefined);
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

    const { updates, providerRenames = [] } = parsed.data;

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

      const currentProviders = getProviderMap(current.providers);
      const providerUpdates = getProviderMap(updates.providers);
      const finalProviders = validated.providers as Record<string, unknown>;
      validateProviderRenames(
        currentProviders,
        providerUpdates,
        finalProviders,
        providerRenames,
      );

      // Copy first and delete old aliases only after the config write succeeds.
      await copyProviderKeysForRenames(providerRenames);
      await clearStaleKeysForAddedProviders(
        currentProviders,
        finalProviders,
        providerRenames,
      );

      // Extract API keys from providers and store in keychain
      const providersWithoutKeys = await storeProviderKeys(finalProviders);

      // Persist config with keys stripped
      const configToSave = { ...validated, providers: providersWithoutKeys };
      atomicWriteJson(HOME_CONFIG_PATH, configToSave);

      // Reset the cached config so next load picks up changes
      ConfigManager.reset();
      // Every project runtime inherits home configuration. Clear the immutable
      // snapshots so only already-running turns retain the previous config.
      clearProjectRuntimeRegistry();
      // Drop model-metadata cache so picker limits reflect new overrides.
      clearModelMetadataCache();

      // Keep the process-wide compatibility cache home-only. Project overlays
      // are independently resolved for the session/turn that needs them.
      ConfigManager.load({ projectDir: HOME_CONFIG_DIR });

      await deleteRemovedProviderKeys(currentProviders, providersWithoutKeys);

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
