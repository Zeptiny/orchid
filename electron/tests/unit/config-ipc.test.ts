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
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

// Config state that getConfig reads — mutable between saves
let configState: Record<string, unknown>;

vi.mock('../../src/main/config/loader', () => ({
  HOME_CONFIG_PATH: '/tmp/orchid-test-config.json',
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
  },
  atomicWriteJson: vi.fn((_path: string, data: unknown) => {
    mocks.writtenConfigs.push(JSON.parse(JSON.stringify(data)));
  }),
}));

vi.mock('../../src/main/config/keychain', () => ({
  encryptAndStore: vi.fn(async () => {}),
  providerKeychainKey: (alias: string) => `provider:${alias}:api_key`,
  redactConfig: (cfg: Record<string, unknown>) => cfg,
}));

vi.mock('../../src/main/llm/model-metadata', () => ({
  resolveModelMetadata: vi.fn(),
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

/** Simulate a config:save IPC call with the given updates. */
function callSave(updates: Record<string, unknown>) {
  const handler = getSaveHandler();
  return handler(null, { updates });
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
