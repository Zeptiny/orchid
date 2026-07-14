/**
 * Config IPC handler tests — config:save serialization and U1 provider boundary.
 *
 * General preferences still use serialized read → merge → write cycles, but
 * provider aliases, credentials, and rename flows no longer belong to config.
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
    // Track writes so concurrent ordinary preference updates can be asserted.
    writtenConfigs: [] as unknown[],
    // Track getConfig call order for race detection
    getConfigCalls: 0,
    clearProjectRuntimeRegistry: vi.fn(),
    invalidateAllProjectMCPManagers: vi.fn(),
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
  getConfigDiagnostics: vi.fn(() => []),
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
      diagnostics: vi.fn(() => []),
  },
  atomicWriteJson: vi.fn((_path: string, data: unknown) => {
    mocks.writtenConfigs.push(JSON.parse(JSON.stringify(data)));
  }),
}));

vi.mock('../../src/main/project/runtime', () => ({
  clearProjectRuntimeRegistry: mocks.clearProjectRuntimeRegistry,
}));

vi.mock('../../src/main/llm/model-metadata', () => ({
  resolveModelMetadata: vi.fn(),
  clearModelMetadataCache: vi.fn(),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  invalidateAllProjectMCPManagers: mocks.invalidateAllProjectMCPManagers,
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
  mocks.clearProjectRuntimeRegistry.mockClear();
  mocks.invalidateAllProjectMCPManagers.mockClear();

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

function getDiagnosticsHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.CONFIG_DIAGNOSTICS);
  if (!handler) throw new Error('config:diagnostics handler not registered');
  return handler;
}

/** Simulate a config:save IPC call with the given updates. */
function callSave(updates: Record<string, unknown>) {
  const handler = getSaveHandler();
  return handler(null, { updates });
}

function callRawSave(payload: unknown) {
  return getSaveHandler()(null, payload);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('config:save concurrency lock (P1-3)', () => {
  it('serializes concurrent ordinary preference saves without losing either update', async () => {
    // Without the lock both calls can read the same snapshot, and the final
    // write would discard one of these otherwise independent preferences.
    const save1 = callSave({ theme: 'night-orchid' });
    const save2 = callSave({ always_expand_tool_groups: true });

    await Promise.all([save1, save2]);

    // Both saves should succeed
    expect(await save1).toEqual({ status: 'saved' });
    expect(await save2).toEqual({ status: 'saved' });

    // The final written config must contain both ordinary updates.
    const finalWrite = mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>;
    expect(finalWrite['theme']).toBe('night-orchid');
    expect(finalWrite['always_expand_tool_groups']).toBe(true);
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

  it('a failed write inside the lock does not block the next save', async () => {
    const loader = await import('../../src/main/config/loader');
    vi.mocked(loader.atomicWriteJson).mockImplementationOnce(() => {
      throw new Error('simulated disk failure');
    });

    await expect(callSave({ theme: 'failed-theme' })).rejects.toThrow('simulated disk failure');
    await expect(callSave({ theme: 'test-theme' })).resolves.toEqual({ status: 'saved' });

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

  it('reloads the compatibility cache from home configuration only', async () => {
    const loader = await import('../../src/main/config/loader');
    vi.mocked(loader.ConfigManager.load).mockClear();

    configState.default_project_dir = null;

    await callSave({ theme: 'home-only' });

    expect(loader.ConfigManager.load).toHaveBeenCalledWith({
      projectDir: '/tmp/orchid-test-home',
    });
  });
});

describe('provider configuration boundary (U1)', () => {
  it('rejects a nonempty legacy providers update before it writes', async () => {
    await expect(callSave({
      providers: {
        legacy: { base_url: 'https://legacy.example.invalid/v1', models: {} },
      },
    })).rejects.toThrow(/legacy provider aliases are no longer accepted/i);

    expect(mocks.writtenConfigs).toHaveLength(0);
    expect(mocks.getConfigCalls).toBe(0);
  });

  it('rejects the retired providerRenames payload before it writes', async () => {
    await expect(callRawSave({
      updates: { theme: 'should-not-write' },
      providerRenames: [{ from: 'legacy', to: 'work' }],
    })).rejects.toThrow(/providerRenames/i);

    expect(mocks.writtenConfigs).toHaveLength(0);
    expect(mocks.getConfigCalls).toBe(0);
  });

  it('returns no providers or API-key-shaped provider state from config:get', async () => {
    configState.providers = {
      legacy: {
        base_url: 'https://legacy.example.invalid/v1',
        api_key: 'test-only-not-a-secret',
      },
    };

    const result = await getConfigHandler()(null) as Record<string, unknown>;

    expect(result['providers']).toEqual({});
    expect(result).not.toHaveProperty('api_key');
    expect(JSON.stringify(result)).not.toContain('test-only-not-a-secret');
  });

  it('exposes only a non-secret legacy reset diagnostic to the renderer', async () => {
    const loader = await import('../../src/main/config/loader');
    vi.mocked(loader.getConfigDiagnostics).mockReturnValueOnce([
      {
        code: 'legacy-provider-config-reset',
        message: 'Legacy provider configuration was ignored.',
      },
    ]);

    await expect(getDiagnosticsHandler()(null)).resolves.toEqual([
      {
        code: 'legacy-provider-config-reset',
        message: 'Legacy provider configuration was ignored.',
      },
    ]);
    expect(loader.getConfigDiagnostics).toHaveBeenCalledWith({
      projectDir: '/tmp/orchid-test-home',
    });
  });
});
