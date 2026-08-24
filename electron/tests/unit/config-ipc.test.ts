/**
 * Config IPC handler tests — config:save serialization and U1 provider boundary.
 *
 * General preferences still use serialized read → merge → write cycles, but
 * provider aliases, credentials, and rename flows no longer belong to config.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { defaults } from '../../src/main/config/schema';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const state = {
    workspaceCwd: null as string | null,
    sessionCwds: [] as string[],
  };

  return {
    handlers,
    state,
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
    canonicalizeProjectDirectory: vi.fn((dir: string) => dir),
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
  PROJECT_CONFIG_NAME: '.orchid.json',
  // U5: the embedded local host (behind the config handlers) composes this.
  ensureHomeConfig: vi.fn(),
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

vi.mock('../../src/main/project/runtime', () => ({
  clearProjectRuntimeRegistry: mocks.clearProjectRuntimeRegistry,
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  invalidateAllProjectMCPManagers: mocks.invalidateAllProjectMCPManagers,
}));

vi.mock('../../src/main/personality/registry', () => ({
  listPersonalityNames: vi.fn(() => []),
  loadPersonalities: vi.fn(),
}));

vi.mock('../../src/main/project/path', () => ({
  canonicalizeProjectDirectory: mocks.canonicalizeProjectDirectory,
}));

vi.mock('../../src/main/session/singleton', () => ({
  resolveWindowWorkspace: vi.fn(() => (
    mocks.state.workspaceCwd == null
      ? { cwd: null, source: 'unbound', status: 'unbound' }
      : { cwd: mocks.state.workspaceCwd, source: 'session', status: 'valid' }
  )),
  getSessionManager: () => ({
    listSaved: () => mocks.state.sessionCwds.map((cwd) => ({ cwd })),
  }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

let configIpc: typeof import('../../src/main/ipc/config');
let loader: typeof import('../../src/main/config/loader');
let writeLock: typeof import('../../src/main/config/write-lock');
let projectDir: string;

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.writtenConfigs.length = 0;
  mocks.getConfigCalls = 0;
  mocks.clearProjectRuntimeRegistry.mockClear();
  mocks.invalidateAllProjectMCPManagers.mockClear();
  mocks.canonicalizeProjectDirectory.mockClear();

  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-config-ipc-'));
  mocks.state.workspaceCwd = projectDir;
  mocks.state.sessionCwds = [];

  // Fresh default config state for each test
  configState = defaults() as unknown as Record<string, unknown>;

  configIpc = await import('../../src/main/ipc/config');
  loader = await import('../../src/main/config/loader');
  writeLock = await import('../../src/main/config/write-lock');
  writeLock._resetConfigSaveChainForTests();
  configIpc.registerConfigIPC();
});

afterEach(() => {
  configIpc.unregisterConfigIPC();
  mocks.state.workspaceCwd = null;
  mocks.state.sessionCwds = [];
  fs.rmSync(projectDir, { recursive: true, force: true });
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
function callSave(updates: Record<string, unknown>) {
  const handler = getSaveHandler();
  return handler(fakeEvent, { updates });
}

function callRawSave(payload: unknown) {
  return getSaveHandler()(fakeEvent, payload);
}

const fakeEvent = { sender: { id: 1 } };

function getReadProjectHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.CONFIG_READ_PROJECT);
  if (!handler) throw new Error('config:read_project handler not registered');
  return handler;
}

function getSaveProjectHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PROJECT);
  if (!handler) throw new Error('config:save_project handler not registered');
  return handler;
}

function callReadProject(dir: unknown) {
  return getReadProjectHandler()(fakeEvent, dir);
}

function callSaveProject(updates: Record<string, unknown>, dir: string = projectDir) {
  return getSaveProjectHandler()(fakeEvent, { projectDir: dir, updates });
}

function writeProjectConfig(value: unknown): void {
  fs.writeFileSync(path.join(projectDir, '.orchid.json'), JSON.stringify(value), 'utf-8');
}

function lastProjectWrite(): { path: string; data: Record<string, unknown>; options: unknown } {
  const calls = vi.mocked(loader.atomicWriteJson).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('atomicWriteJson was not called');
  return {
    path: last[0] as string,
    data: mocks.writtenConfigs[mocks.writtenConfigs.length - 1] as Record<string, unknown>,
    options: last[2],
  };
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
  it('rejects the retired providerRenames payload before it writes', async () => {
    await expect(callRawSave({
      updates: { theme: 'should-not-write' },
      providerRenames: [{ from: 'legacy', to: 'work' }],
    })).rejects.toThrow(/providerRenames/i);

    expect(mocks.writtenConfigs).toHaveLength(0);
    expect(mocks.getConfigCalls).toBe(0);
  });

});

describe('config:read_project', () => {
  it('returns empty overrides when the project config file is missing', async () => {
    await expect(callReadProject(projectDir)).resolves.toEqual({
      projectDir,
      overrides: {},
    });
  });

  it('returns parsed overrides from a valid project config object', async () => {
    writeProjectConfig({ theme: 'project-dark', command_timeout: 45 });

    await expect(callReadProject(projectDir)).resolves.toEqual({
      projectDir,
      overrides: { theme: 'project-dark', command_timeout: 45 },
    });
  });

  it('returns empty overrides when the file contains malformed JSON', async () => {
    fs.writeFileSync(path.join(projectDir, '.orchid.json'), '{ not valid json', 'utf-8');

    await expect(callReadProject(projectDir)).resolves.toEqual({
      projectDir,
      overrides: {},
    });
  });

  it('returns empty overrides when the file contains a non-object JSON value', async () => {
    for (const raw of ['[1, 2, 3]', '"a string"', '42']) {
      fs.writeFileSync(path.join(projectDir, '.orchid.json'), raw, 'utf-8');

      await expect(callReadProject(projectDir)).resolves.toEqual({
        projectDir,
        overrides: {},
      });
    }
  });

  it('rejects a non-string projectDir', async () => {
    await expect(callReadProject(123)).rejects.toThrow(/non-empty projectDir/);
    await expect(callReadProject('')).rejects.toThrow(/non-empty projectDir/);
    await expect(callReadProject(null)).rejects.toThrow(/non-empty projectDir/);
  });

  it('returns overrides for a session project even when a different workspace is selected', async () => {
    mocks.state.workspaceCwd = '/some/other/workspace';
    mocks.state.sessionCwds = [projectDir];
    writeProjectConfig({ theme: 'project-dark' });

    await expect(callReadProject(projectDir)).resolves.toEqual({
      projectDir,
      overrides: { theme: 'project-dark' },
    });
  });

  it('rejects when the target is neither the selected workspace nor a session project', async () => {
    mocks.state.workspaceCwd = '/some/other/workspace';

    await expect(callReadProject(projectDir)).rejects.toThrow(
      /selected workspace or any project with sessions/i,
    );
  });

  it('rejects when no workspace is bound and the project has no sessions', async () => {
    mocks.state.workspaceCwd = null;

    await expect(callReadProject(projectDir)).rejects.toThrow(
      /selected workspace or any project with sessions/i,
    );
  });
});

describe('config:save_project', () => {
  const SELECTION = { connectionId: '123e4567-e89b-12d3-a456-426614174000', modelId: 'model-x' };

  it('merges updates and writes to the project config path', async () => {
    await callSaveProject({ personality: 'project-persona', command_timeout: 42 });

    const write = lastProjectWrite();
    expect(write.path).toBe(path.join(projectDir, '.orchid.json'));
    expect(write.data['personality']).toBe('project-persona');
    expect(write.data['command_timeout']).toBe(42);
    expect(write.options).toEqual({ hardenDirectory: false });
  });

  it('deletes a key with a null tombstone from an existing config', async () => {
    writeProjectConfig({ personality: 'kept', command_timeout: 99 });

    await callSaveProject({ command_timeout: null });

    const write = lastProjectWrite();
    expect(write.data['personality']).toBe('kept');
    expect(write.data).not.toHaveProperty('command_timeout');
  });

  it('persists per-project MCP servers and default model', async () => {
    await callSaveProject({
      mcp_servers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } },
      default_model: SELECTION,
    });

    const write = lastProjectWrite();
    expect(write.data['mcp_servers']).toEqual({
      docs: { command: 'npx', args: ['-y', 'docs-mcp'] },
    });
    expect(write.data['default_model']).toEqual(SELECTION);
  });

  it('deletes an MCP alias with a null tombstone from the project config', async () => {
    writeProjectConfig({
      mcp_servers: { keep: { command: 'keep' }, drop: { command: 'drop' } },
    });

    await callSaveProject({ mcp_servers: { drop: null } });

    const write = lastProjectWrite();
    expect(write.data['mcp_servers']).toEqual({ keep: { command: 'keep' } });
  });

  it('clears a default_model override with null instead of storing an explicit null', async () => {
    writeProjectConfig({ default_model: SELECTION });

    await callSaveProject({ default_model: null });

    const write = lastProjectWrite();
    expect(write.data).not.toHaveProperty('default_model');
  });

  it('replaces tier maps exactly so removed overrides are deleted', async () => {
    writeProjectConfig({
      tier_models: {
        seed: { ...SELECTION, modelId: 'seed-model' },
        crown: { ...SELECTION, modelId: 'crown-model' },
      },
      tier_reasoning_effort: { seed: 'low', crown: 'high' },
    });

    await callSaveProject({
      tier_models: { crown: { ...SELECTION, modelId: 'crown-model' } },
      tier_reasoning_effort: { crown: 'high' },
    });

    const write = lastProjectWrite();
    expect(write.data['tier_models']).toEqual({
      crown: { ...SELECTION, modelId: 'crown-model' },
    });
    expect(write.data['tier_reasoning_effort']).toEqual({ crown: 'high' });
  });

  it('persists agents_md overrides', async () => {
    await callSaveProject({ agents_md: { enforce_on_write: 'block' } });

    const write = lastProjectWrite();
    expect(write.data['agents_md']).toEqual({ enforce_on_write: 'block' });
  });

  it('rejects keys outside the project config allowlist without writing', async () => {
    await expect(callSaveProject({
      permissions: { Bash: 'approve' },
      theme: 'light',
    })).rejects.toThrow(/Not configurable per project/);
    await expect(callSaveProject({
      permissions: { Bash: 'approve' },
    })).rejects.toThrow(/permissions/);

    expect(mocks.writtenConfigs).toHaveLength(0);
  });

  it('rejects a mixed payload (allowed + disallowed) without a partial write', async () => {
    await expect(callSaveProject({
      command_timeout: 45,
      subagents: { max_active_global: 2 },
    })).rejects.toThrow(/Not configurable per project: subagents/);

    expect(mocks.writtenConfigs).toHaveLength(0);
  });

  it('rejects null tier maps instead of silently ignoring them', async () => {
    await expect(callSaveProject({ tier_models: null })).rejects.toThrow(
      /tier_models must be an object map/,
    );
    await expect(callSaveProject({ tier_reasoning_effort: null })).rejects.toThrow(
      /tier_reasoning_effort must be an object map/,
    );
    expect(mocks.writtenConfigs).toHaveLength(0);
  });

  it('drops prototype-pollution aliases from tier maps', async () => {
    const poisoned = JSON.parse(
      `{"tier_models":{"__proto__":{"connectionId":"x"},"seed":${JSON.stringify(SELECTION)}},"tier_reasoning_effort":{"constructor":"low"}}`,
    ) as Record<string, unknown>;

    await callSaveProject(poisoned);

    const write = lastProjectWrite();
    expect(write.data['tier_models']).toEqual({ seed: SELECTION });
    expect(write.data['tier_reasoning_effort']).toEqual({});
  });

  it('preserves project permissions written through the permission-scope channel', async () => {
    writeProjectConfig({
      permissions: { grep: 'ask' },
      command_timeout: 60,
    });

    await callSaveProject({ command_timeout: 45 });

    const write = lastProjectWrite();
    expect(write.data['permissions']).toEqual({ grep: 'ask' });
    expect(write.data['command_timeout']).toBe(45);
  });

  it('unblocks unrelated saves when the project file was already invalid', async () => {
    writeProjectConfig({ default_model: 'not-a-selection' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await callSaveProject({ command_timeout: 45 });
      const write = lastProjectWrite();
      expect(write.data['command_timeout']).toBe(45);
      // The pre-existing invalid value is preserved, not silently dropped.
      expect(write.data['default_model']).toBe('not-a-selection');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    // But a save that itself introduces an invalid value (on a clean file)
    // still rejects.
    writeProjectConfig({ command_timeout: 45 });
    await expect(callSaveProject({ personality: 42 })).rejects.toThrow(/Invalid project config/);
  });

  it('rejects a newly invalid update when the project file already has an invalid key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // New violation at a path the file did not already fail.
      writeProjectConfig({ default_model: 'not-a-selection' });
      await expect(callSaveProject({ personality: 42 })).rejects.toThrow(
        /Invalid project config/,
      );

      // Changed value at the already-invalid path.
      writeProjectConfig({ command_timeout: 0 });
      await expect(callSaveProject({ command_timeout: -5 })).rejects.toThrow(
        /Invalid project config/,
      );
    } finally {
      warn.mockRestore();
    }

    expect(mocks.writtenConfigs).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects schema-violating values without writing', async () => {
    await expect(callSaveProject({ command_timeout: -5 })).rejects.toThrow(
      /Invalid project config/,
    );

    expect(mocks.writtenConfigs).toHaveLength(0);
  });

  it('invalidates caches and reloads the home config after saving', async () => {
    vi.mocked(loader.ConfigManager.reset).mockClear();
    vi.mocked(loader.ConfigManager.load).mockClear();

    await callSaveProject({ command_timeout: 45 });

    expect(loader.ConfigManager.reset).toHaveBeenCalledTimes(1);
    expect(mocks.clearProjectRuntimeRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateAllProjectMCPManagers).toHaveBeenCalledTimes(1);
    expect(loader.ConfigManager.load).toHaveBeenCalledWith({
      projectDir: '/tmp/orchid-test-home',
    });
  });

  it('saves to a session project that is not the selected workspace', async () => {
    mocks.state.workspaceCwd = '/some/other/workspace';
    mocks.state.sessionCwds = [projectDir];

    await callSaveProject({ command_timeout: 45 });
    const write = lastProjectWrite();
    expect(write.path).toBe(path.join(projectDir, '.orchid.json'));
    expect(write.data['command_timeout']).toBe(45);
  });

  it('rejects a projectDir that is neither the selected workspace nor a session project', async () => {
    mocks.state.workspaceCwd = '/some/other/workspace';

    await expect(callSaveProject({ command_timeout: 45 })).rejects.toThrow(
      /selected workspace or any project with sessions/i,
    );
    expect(mocks.writtenConfigs).toHaveLength(0);
  });
});
