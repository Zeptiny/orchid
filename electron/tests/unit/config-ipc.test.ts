/**
 * Config IPC handler tests — focusing on the config:save concurrency lock (P1-3).
 *
 * Verifies that concurrent config:save calls are serialized so that
 * read → merge → write cycles don't race and lose provider updates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { defaults } from '../../src/main/config/schema';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    // Track writes so we can assert both updates survived
    writtenConfigs: [] as unknown[],
    // Track getConfig call order for race detection
    getConfigCalls: 0,
    encryptAndStore: vi.fn(async () => {}),
    retrieveAndDecrypt: vi.fn(async () => null as string | null),
    deleteKey: vi.fn(async () => {}),
    injectKeychainKeys: vi.fn(async (cfg: Record<string, unknown>) => cfg),
    redactConfig: vi.fn((cfg: Record<string, unknown>) => cfg),
    redactApiKey: vi.fn((key: string) => key.length <= 8 ? '****' : `${key.slice(0, 3)}...${key.slice(-4)}`),
    clearProjectRuntimeRegistry: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

// Config state that getConfig reads — mutable between saves
let configState: Record<string, unknown>;

vi.mock('../../src/main/config/loader', () => ({
  HOME_CONFIG_PATH: '/tmp/orchid-test-config.json',
  HOME_CONFIG_DIR: '/tmp/orchid-test-home',
  getConfig: vi.fn(() => {
    mocks.getConfigCalls++;
    return configState;
  }),
  ConfigManager: {
    reset: vi.fn(() => {
      // Simulate cache invalidation: next getConfig() should read from
      // "disk" — the last written config. In production, ConfigManager.reset()
      // clears the singleton so loadConfig() re-reads from disk.
      if (mocks.writtenConfigs.length > 0) {
        configState = JSON.parse(
          JSON.stringify(mocks.writtenConfigs[mocks.writtenConfigs.length - 1]),
        );
      }
    }),
    load: vi.fn(() => {
      if (mocks.writtenConfigs.length > 0) {
        configState = JSON.parse(
          JSON.stringify(mocks.writtenConfigs[mocks.writtenConfigs.length - 1]),
        );
      }
      return configState;
    }),
  },
  atomicWriteJson: vi.fn((_path: string, data: unknown) => {
    mocks.writtenConfigs.push(JSON.parse(JSON.stringify(data)));
  }),
}));

vi.mock('../../src/main/project/layers', () => ({
  applyWorkspaceProjectLayers: vi.fn(() => ({
    applied: true,
    projectDir: '/mock',
    config: {},
    agents: null,
    skills: null,
  })),
  resetLastAppliedProjectDir: vi.fn(),
  getLastAppliedProjectDir: vi.fn(() => null),
}));

vi.mock('../../src/main/project/runtime', () => ({
  clearProjectRuntimeRegistry: mocks.clearProjectRuntimeRegistry,
}));

vi.mock('../../src/main/config/keychain', () => ({
  encryptAndStore: mocks.encryptAndStore,
  retrieveAndDecrypt: mocks.retrieveAndDecrypt,
  deleteKey: mocks.deleteKey,
  injectKeychainKeys: mocks.injectKeychainKeys,
  providerKeychainKey: (alias: string) => `provider:${alias}:api_key`,
  redactApiKey: mocks.redactApiKey,
  redactConfig: mocks.redactConfig,
}));

vi.mock('../../src/main/llm/model-metadata', () => ({
  resolveModelMetadata: vi.fn(),
  clearModelMetadataCache: vi.fn(),
}));

vi.mock('../../src/main/llm/providers', () => ({
  discoverModelsAsync: vi.fn(),
}));

vi.mock('../../src/main/personality/registry', () => ({
  listPersonalityNames: vi.fn(() => []),
  loadPersonalities: vi.fn(),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

let configIpc: typeof import('../../src/main/ipc/config');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.writtenConfigs.length = 0;
  mocks.getConfigCalls = 0;
  mocks.encryptAndStore.mockClear();
  mocks.retrieveAndDecrypt.mockReset().mockResolvedValue(null);
  mocks.deleteKey.mockClear();
  mocks.injectKeychainKeys.mockReset().mockImplementation(async (cfg) => cfg);
  mocks.redactConfig.mockReset().mockImplementation((cfg) => cfg);
  mocks.clearProjectRuntimeRegistry.mockClear();

  // Fresh default config state for each test
  configState = defaults() as unknown as Record<string, unknown>;

  configIpc = await import('../../src/main/ipc/config');
  configIpc._resetConfigSaveChainForTests();
  configIpc.registerConfigIPC();
});

afterEach(() => {
  configIpc.unregisterConfigIPC();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function getSaveHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE);
  if (!handler) throw new Error('config:save handler not registered');
  return handler;
}

function getConfigHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.CONFIG_GET);
  if (!handler) throw new Error('config:get handler not registered');
  return handler;
}

/** Simulate a config:save IPC call with the given updates. */
function callSave(
  updates: Record<string, unknown>,
  providerRenames?: Array<{ from: string; to: string }>,
) {
  const handler = getSaveHandler();
  return handler(null, { updates, providerRenames });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('config:save concurrency lock (P1-3)', () => {
  it('serializes two concurrent saves — second save sees first save result', async () => {
    // Save 1: add provider "alpha"
    // Save 2: add provider "beta"
    // Without the lock, both read the same snapshot and the second write
    // overwrites the first's provider.  With the lock, "alpha" persists.
    const save1 = callSave({
      providers: {
        alpha: { base_url: 'https://alpha.example.com', models: {} },
      },
    });
    const save2 = callSave({
      providers: {
        beta: { base_url: 'https://beta.example.com', models: {} },
      },
    });

    await Promise.all([save1, save2]);

    // Both saves should succeed
    expect(await save1).toEqual({ status: 'saved' });
    expect(await save2).toEqual({ status: 'saved' });

    // The final written config must contain BOTH providers.
    // This is the critical assertion — without the lock, only "beta" would survive.
    const finalWrite = mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>;
    const providers = finalWrite['providers'] as Record<string, unknown>;
    expect(providers).toHaveProperty('alpha');
    expect(providers).toHaveProperty('beta');
    expect(providers).toHaveProperty('default');
  });

  it('serializes saves so second save merges on top of first', async () => {
    // Save 1: change theme to "dark"
    // Save 2: change theme to "solarized"
    // Expected: final theme is "solarized" (second save wins), but both ran.
    const save1 = callSave({ theme: 'dark' });
    const save2 = callSave({ theme: 'solarized' });

    await Promise.all([save1, save2]);

    const finalWrite = mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>;
    expect(finalWrite['theme']).toBe('solarized');
  });

  it('second save sees updated providers from first save', async () => {
    // Save 1: add provider "openai" with api_key
    // Save 2: update the default provider base_url
    // Both changes must survive.
    const save1 = callSave({
      providers: {
        openai: {
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test123456789',
          models: {},
        },
      },
    });
    const save2 = callSave({
      providers: {
        default: { base_url: 'https://custom-opencode.example.com' },
      },
    });

    await Promise.all([save1, save2]);

    const finalWrite = mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>;
    const providers = finalWrite['providers'] as Record<string, unknown>;

    // openai from save1 survived
    expect(providers).toHaveProperty('openai');
    // default base_url from save2 updated
    const defaultProv = providers['default'] as Record<string, unknown>;
    expect(defaultProv['base_url']).toBe('https://custom-opencode.example.com');
  });

  it('error in one save does not block subsequent saves', async () => {
    // Save 1: invalid payload (will throw before lock)
    // Save 2: valid payload
    const handler = getSaveHandler();

    const badSave = handler(null, { invalid: true }).catch((e: Error) => e);
    const goodSave = callSave({ theme: 'test-theme' });

    const [badResult, goodResult] = await Promise.all([badSave, goodSave]);

    expect(badResult).toBeInstanceOf(Error);
    expect(goodResult).toEqual({ status: 'saved' });

    const finalWrite = mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>;
    expect(finalWrite['theme']).toBe('test-theme');
  });

  it('getConfig is called inside the lock (reads fresh state)', async () => {
    // Verify that getConfig() is invoked once per save (inside the lock),
    // not once at the start (outside the lock where it would read stale state).
    mocks.getConfigCalls = 0;

    await callSave({ theme: 'first' });
    expect(mocks.getConfigCalls).toBe(1);

    await callSave({ theme: 'second' });
    expect(mocks.getConfigCalls).toBe(2);
  });
});

describe('config:save workspace layer reset', () => {
  it('clears inherited project runtime snapshots after the home config changes', async () => {
    await callSave({ theme: 'runtime-cache-test' });

    expect(mocks.clearProjectRuntimeRegistry).toHaveBeenCalledTimes(1);
  });

  it('does not re-apply one project globally when sticky is set', async () => {
    const layers = await import('../../src/main/project/layers');
    vi.mocked(layers.applyWorkspaceProjectLayers).mockClear();

    configState.default_project_dir = '/tmp/orchid-sticky-project';

    await callSave({ theme: 'layer-test' });

    expect(layers.applyWorkspaceProjectLayers).not.toHaveBeenCalled();
  });

  it('reloads the compatibility cache from home configuration only', async () => {
    const layers = await import('../../src/main/project/layers');
    const loader = await import('../../src/main/config/loader');
    vi.mocked(layers.applyWorkspaceProjectLayers).mockClear();
    vi.mocked(loader.ConfigManager.load).mockClear();

    configState.default_project_dir = null;

    await callSave({ theme: 'home-only' });

    expect(layers.applyWorkspaceProjectLayers).not.toHaveBeenCalled();
    expect(loader.ConfigManager.load).toHaveBeenCalledWith({
      projectDir: '/tmp/orchid-test-home',
    });
  });
});

describe('provider API key lifecycle', () => {
  it('hydrates keychain keys before redacting config:get results', async () => {
    const hydrated = {
      ...configState,
      providers: {
        default: {
          ...(configState.providers as Record<string, Record<string, unknown>>).default,
          api_key: 'sk-runtime-secret',
        },
      },
    };
    const redacted = {
      ...hydrated,
      providers: {
        default: {
          ...(hydrated.providers as Record<string, Record<string, unknown>>).default,
          api_key: 'sk-...cret',
        },
      },
    };
    mocks.injectKeychainKeys.mockResolvedValue(hydrated);
    mocks.redactConfig.mockReturnValue(redacted);

    const result = await getConfigHandler()(null);

    expect(mocks.injectKeychainKeys).toHaveBeenCalledWith(configState);
    expect(mocks.redactConfig).toHaveBeenCalledWith(hydrated);
    expect(result).toEqual(redacted);
  });

  it('moves an existing key when a provider is explicitly renamed', async () => {
    configState.providers = {
      legacy: { base_url: 'https://legacy.example.com', models: {} },
    };
    mocks.retrieveAndDecrypt.mockResolvedValue('sk-existing-secret');

    await callSave(
      {
        providers: {
          legacy: null,
          current: { base_url: 'https://current.example.com', models: {} },
        },
      },
      [{ from: 'legacy', to: 'current' }],
    );

    expect(mocks.retrieveAndDecrypt).toHaveBeenCalledWith(
      'provider:legacy:api_key',
    );
    expect(mocks.encryptAndStore).toHaveBeenCalledWith(
      'provider:current:api_key',
      'sk-existing-secret',
    );
    expect(mocks.deleteKey).toHaveBeenCalledWith('provider:legacy:api_key');
  });

  it('deletes keychain entries for removed providers', async () => {
    configState.providers = {
      removeMe: { base_url: 'https://remove.example.com', models: {} },
    };

    await callSave({ providers: { removeMe: null } });

    expect(mocks.deleteKey).toHaveBeenCalledWith('provider:removeMe:api_key');
  });

  it('clears stale keys when adding a provider without a new key', async () => {
    configState.providers = {};

    await callSave({
      providers: {
        reused: { base_url: 'https://reused.example.com', models: {} },
      },
    });

    expect(mocks.deleteKey).toHaveBeenCalledWith('provider:reused:api_key');
  });

  it('clears a stale target key when a renamed provider has no source key', async () => {
    configState.providers = {
      legacy: { base_url: 'https://legacy.example.com', models: {} },
    };
    mocks.retrieveAndDecrypt.mockResolvedValue(null);

    await callSave(
      {
        providers: {
          legacy: null,
          current: { base_url: 'https://current.example.com', models: {} },
        },
      },
      [{ from: 'legacy', to: 'current' }],
    );

    expect(mocks.deleteKey).toHaveBeenCalledWith('provider:current:api_key');
  });

  it('never stores a redacted key returned by config:get', async () => {
    configState.providers = {
      existing: { base_url: 'https://existing.example.com', models: {} },
    };
    mocks.retrieveAndDecrypt.mockResolvedValue('sk-runtime-secret');

    await callSave({
      providers: {
        existing: {
          base_url: 'https://existing.example.com',
          api_key: 'sk-...cret',
          models: {},
        },
      },
    });

    expect(mocks.encryptAndStore).not.toHaveBeenCalledWith(
      'provider:existing:api_key',
      'sk-...cret',
    );
    const finalWrite = mocks.writtenConfigs.at(-1) as Record<string, unknown>;
    const providers = finalWrite.providers as Record<string, Record<string, unknown>>;
    expect(providers.existing.api_key).toBeUndefined();
  });
});
