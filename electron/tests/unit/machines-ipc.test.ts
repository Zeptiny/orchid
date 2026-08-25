/**
 * Machine registry + machines IPC tests (issue #112, unit U6).
 *
 * Covers the pure ordering/parsing helpers, the home-config-backed registry
 * (local machine implicit and immutable, remotes persisted), and the
 * machines:list/create/update/delete handlers including the machines:changed
 * broadcast.
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
  type FakeWindow = {
    isDestroyed: () => boolean;
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  };
  return {
    handlers,
    windows: [] as FakeWindow[],
    homeConfigPath: '',
    configState: {} as Record<string, unknown>,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => mocks.windows),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => 'test_libsecret'),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
      decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: mocks.BrowserWindow,
  safeStorage: mocks.safeStorage,
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: vi.fn(() => mocks.configState),
    get HOME_CONFIG_PATH() {
      return mocks.homeConfigPath;
    },
    get HOME_CONFIG_DIR() {
      return path.dirname(mocks.homeConfigPath);
    },
  };
});

// ── Imports under test ──────────────────────────────────────────────────────

import { registerMachinesIPC, unregisterMachinesIPC } from '../../src/main/ipc/machines';
import {
  MachineRegistry,
  _resetMachineRegistryForTests,
  applyMachinePatch,
  buildLocalMachine,
  localMachineLabel,
  orderMachines,
  parseRemoteMachineRecords,
  sortRemoteMachines,
} from '../../src/main/machines/registry';
import { _resetConfigSaveChainForTests } from '../../src/main/config/write-lock';
import { knownHostsPath } from '../../src/main/machines/host-key';
import {
  _clearMachinePasswordWriteChains,
  _resetMachineSecretsStoreForTests,
} from '../../src/main/machines/machine-secrets';
import {
  _resetMachineHostKeyFlowForTests,
  getMachineHostKeyFlow,
} from '../../src/main/machines/host-key-flow';
import {
  machinesCreateSchema,
  machinesDeleteSchema,
  machinesUpdateSchema,
} from '../../src/main/ipc/payload-schemas';
import { configSchema } from '../../src/main/config/schema';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const T0 = '2026-08-23T00:00:00.000Z';
const T1 = '2026-08-23T01:00:00.000Z';

/** Real throwaway ed25519 key line (twin of machines-host-key.test.ts). */
const ED25519_LINE =
  'build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPHhT8R1+f81M2hvSEhe/iCDDHV3m79vicl5uXQ0IZRM test-ed25519';

function remoteMachine(
  id: string,
  label: string,
  overrides: Partial<RemoteMachineRecord> = {},
): RemoteMachineRecord {
  return {
    id,
    label,
    kind: 'ssh',
    host: `${id}.example.com`,
    port: 22,
    user: '',
    agentCommand: 'orchid-agent',
    authMethod: 'key',
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

let homeDir: string;

function writeHomeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(mocks.homeConfigPath), { recursive: true });
  fs.writeFileSync(mocks.homeConfigPath, JSON.stringify(value, null, 2), 'utf-8');
}

function readHomeConfigRaw(): string {
  return fs.readFileSync(mocks.homeConfigPath, 'utf-8');
}

function readHomeConfig(): Record<string, unknown> {
  return JSON.parse(readHomeConfigRaw()) as Record<string, unknown>;
}

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`${channel} handler not registered`);
  return registered;
}

function addWindow(): mocks.windows[number] {
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
  mocks.windows.push(win);
  return win;
}

function broadcastCount(): number {
  return mocks.windows.reduce((total, win) => total + win.webContents.send.mock.calls.length, 0);
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.windows.length = 0;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-ipc-'));
  mocks.homeConfigPath = path.join(homeDir, 'config.json');
  mocks.configState = defaults() as unknown as Record<string, unknown>;
  mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true);
  _resetConfigSaveChainForTests();
  _resetMachineRegistryForTests();
  _resetMachineHostKeyFlowForTests();
  _resetMachineSecretsStoreForTests();
  _clearMachinePasswordWriteChains();
});

afterEach(() => {
  unregisterMachinesIPC();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('machine registry pure helpers', () => {
  it('sorts remotes by label with the id as a stable tie-break', () => {
    const sorted = sortRemoteMachines([
      remoteMachine('zeta', 'Workstation'),
      remoteMachine('beta-2', 'Build server'),
      remoteMachine('beta-1', 'Build server'),
    ]);
    expect(sorted.map((machine) => machine.id)).toEqual(['beta-1', 'beta-2', 'zeta']);
  });

  it('derives a platform-appropriate local machine label', () => {
    expect(localMachineLabel('studio', 'darwin')).toBe('This Mac (studio)');
    expect(localMachineLabel('worktop', 'linux')).toBe('This PC (worktop)');
    expect(localMachineLabel('   ', 'win32')).toBe('This PC');
  });

  it('builds the implicit local machine record', () => {
    expect(buildLocalMachine('studio', 'darwin')).toEqual({
      id: 'local',
      label: 'This Mac (studio)',
      kind: 'local',
    });
  });

  it('always places the local machine first', () => {
    const machines = orderMachines(buildLocalMachine('studio', 'linux'), [
      remoteMachine('a', 'Alpha'),
      remoteMachine('b', 'Beta'),
    ]);
    expect(machines.map((machine) => [machine.id, machine.kind])).toEqual([
      ['local', 'local'],
      ['a', 'ssh'],
      ['b', 'ssh'],
    ]);
  });

  it('parses a missing or empty machines section as no remotes', () => {
    expect(parseRemoteMachineRecords(undefined)).toEqual([]);
    expect(parseRemoteMachineRecords(null)).toEqual([]);
    expect(parseRemoteMachineRecords([])).toEqual([]);
  });

  it('rejects a non-array machines section and invalid entries', () => {
    expect(() => parseRemoteMachineRecords({})).toThrow(/must be an array/);
    expect(() => parseRemoteMachineRecords([remoteMachine('a', 'Alpha'), { id: 'b' }])).toThrow(
      /machine entry 1 is invalid/,
    );
  });

  it('applies a partial patch and bumps only updated_at', () => {
    const patched = applyMachinePatch(
      remoteMachine('a', 'Alpha'),
      { port: 2222, label: 'Alpha prime' },
      T1,
    );
    expect(patched).toEqual({
      ...remoteMachine('a', 'Alpha prime', { port: 2222 }),
      updated_at: T1,
    });
  });
});

// ── Registry store ──────────────────────────────────────────────────────────

function makeRegistry(overrides: { now?: () => string; idFactory?: () => string } = {}) {
  return new MachineRegistry({
    homeConfigPath: mocks.homeConfigPath,
    hostname: () => 'studio',
    platform: () => 'linux' as NodeJS.Platform,
    now: overrides.now ?? (() => T0),
    idFactory: overrides.idFactory ?? (() => 'generated-id'),
  });
}

describe('MachineRegistry', () => {
  it('lists only the local machine when the home config has no machines section', async () => {
    writeHomeConfig({ theme: 'default' });
    const registry = makeRegistry();
    await expect(registry.list()).resolves.toEqual([
      { id: 'local', label: 'This PC (studio)', kind: 'local' },
    ]);
  });

  it('lists persisted remotes after the local machine, sorted by label', async () => {
    writeHomeConfig({
      machines: [
        remoteMachine('zeta', 'Workstation'),
        remoteMachine('beta', 'Build server'),
      ],
    });
    const registry = makeRegistry();
    await expect(registry.list()).resolves.toEqual([
      { id: 'local', label: 'This PC (studio)', kind: 'local' },
      remoteMachine('beta', 'Build server'),
      remoteMachine('zeta', 'Workstation'),
    ]);
  });

  it('persists a created machine into the machines section while preserving sibling keys', async () => {
    writeHomeConfig({ theme: 'light', permissions: { grep: 'ask' } });
    const registry = makeRegistry({ idFactory: () => 'build-1' });

    const created = await registry.create({ label: 'Build server', host: 'build.example.com' });

    expect(created).toEqual(remoteMachine('build-1', 'Build server', { host: 'build.example.com' }));
    const home = readHomeConfig();
    expect(home['theme']).toBe('light');
    expect(home['permissions']).toEqual({ grep: 'ask' });
    expect(home['machines']).toEqual([
      remoteMachine('build-1', 'Build server', { host: 'build.example.com' }),
    ]);
  });

  it('keeps the cached config in sync so a later config:save cannot revert the registry', async () => {
    writeHomeConfig({});
    const registry = makeRegistry({ idFactory: () => 'build-1' });

    await registry.create({ label: 'Build server', host: 'build.example.com' });

    expect(mocks.configState['machines']).toHaveLength(1);
  });

  it('rejects invalid create input without writing', async () => {
    writeHomeConfig({});
    const registry = makeRegistry();

    await expect(registry.create({ label: 'x', host: 'h', port: 0 })).rejects.toThrow();
    await expect(registry.create({ label: 'x', host: 'h', port: 65536 })).rejects.toThrow();
    await expect(registry.create({ label: 'x', host: 'h', port: 22.5 })).rejects.toThrow();
    await expect(registry.create({ label: 'x', host: '   ' })).rejects.toThrow();
    await expect(registry.create({ label: '', host: 'h' })).rejects.toThrow();
    await expect(registry.create({ label: 'x', host: 'h', agentCommand: '' })).rejects.toThrow();
    await expect(
      registry.create({ label: 'x', host: 'h', id: 'local' }),
    ).rejects.toThrow(/reserved/);
    await expect(
      registry.create({ label: 'x', host: 'h', extra: true } as never),
    ).rejects.toThrow();

    expect(readHomeConfig()).toEqual({});
  });

  it('rejects agentCommand shell metacharacters without writing', async () => {
    writeHomeConfig({});
    const registry = makeRegistry();

    const injected = [
      'orchid-agent; rm -rf /',
      'orchid-agent && echo pwned',
      'orchid-agent | sh',
      'orchid-agent & background',
      'orchid-agent $(whoami)',
      'orchid-agent `whoami`',
      'echo "orchid-agent"',
      "echo 'orchid-agent'",
      'orchid-agent\\; ls',
      'orchid-agent > /etc/passwd',
      'orchid-agent < secret',
      'orchid-agent *',
    ];
    for (const agentCommand of injected) {
      await expect(
        registry.create({ label: 'x', host: 'h', agentCommand }),
        `agentCommand '${agentCommand}' must be rejected`,
      ).rejects.toThrow(/agentCommand/);
    }

    expect(readHomeConfig()).toEqual({});
  });

  it('rejects ssh option injection through host and user without writing', async () => {
    writeHomeConfig({});
    const registry = makeRegistry();

    // OpenSSH parses a leading-dash destination token as an option
    // (-oProxyCommand executes locally before host-key checking); a second
    // '@' re-splits the user/host boundary.
    for (const injected of [
      { host: '-oProxyCommand=evil' },
      { host: '-oProxyCommand=evil', user: 'deploy' },
      { host: 'h', user: '-oX=Y' },
      { host: 'h', user: 'a@b' },
      { host: 'h', user: 'a b' },
      { host: 'h', user: 'a#b' },
    ]) {
      await expect(
        registry.create({ label: 'x', host: 'h', ...injected }),
        `create ${JSON.stringify(injected)} must be rejected`,
      ).rejects.toThrow();
    }

    expect(readHomeConfig()).toEqual({});

    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });
    await expect(registry.update('build-1', { host: '-oProxyCommand=evil' })).rejects.toThrow();
    await expect(registry.update('build-1', { user: 'a@b' })).rejects.toThrow();

    // Legit destinations keep working.
    await expect(
      registry.create({ label: 'ok', host: '2001:db8::1', user: 'deploy-user' }),
    ).resolves.toBeTruthy();
  });

  it('rejects a duplicate machine id', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });
    const registry = makeRegistry({ idFactory: () => 'build-1' });

    await expect(registry.create({ label: 'Other', host: 'h' })).rejects.toThrow(
      /Duplicate machine id 'build-1'/,
    );
  });

  it('patches fields and bumps updated_at while keeping created_at', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });
    const registry = makeRegistry({ now: () => T1 });

    const updated = await registry.update('build-1', { port: 2222, user: 'deploy' });

    expect(updated).toEqual(
      remoteMachine('build-1', 'Build server', { port: 2222, user: 'deploy', updated_at: T1 }),
    );
    expect(readHomeConfig()['machines']).toEqual([
      remoteMachine('build-1', 'Build server', { port: 2222, user: 'deploy', updated_at: T1 }),
    ]);
  });

  it('rejects updates for the local machine and unknown ids', async () => {
    writeHomeConfig({});
    const registry = makeRegistry();

    await expect(registry.update('local', { label: 'renamed' })).rejects.toThrow(
      /local machine cannot be modified/,
    );
    await expect(registry.update('ghost', { label: 'renamed' })).rejects.toThrow(
      /Unknown machine 'ghost'/,
    );
  });

  it('deletes a machine and reports not_found for unknown ids', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });
    const registry = makeRegistry();

    await expect(registry.remove('build-1')).resolves.toEqual({
      status: 'deleted',
      machine: remoteMachine('build-1', 'Build server'),
    });
    expect(readHomeConfig()['machines']).toEqual([]);

    await expect(registry.remove('build-1')).resolves.toEqual({ status: 'not_found' });
  });

  it('rejects deleting the local machine', async () => {
    writeHomeConfig({});
    const registry = makeRegistry();

    await expect(registry.remove('local')).rejects.toThrow(/local machine cannot be deleted/);
  });

  it('rejects mutations when the home config is unreadable, leaving the file intact', async () => {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(mocks.homeConfigPath, '{ not json', 'utf-8');
    const registry = makeRegistry();

    await expect(registry.listRemotes()).rejects.toThrow(/not readable JSON/);
    await expect(registry.create({ label: 'x', host: 'h' })).rejects.toThrow(/not readable JSON/);
    expect(readHomeConfigRaw()).toBe('{ not json');
  });
});

// ── Home config schema section ──────────────────────────────────────────────

describe('home config machines section', () => {
  it('defaults to an empty array', () => {
    expect(defaults().machines).toEqual([]);
  });

  it('accepts machine records and rejects invalid ones', () => {
    expect(configSchema.safeParse({ machines: [remoteMachine('a', 'Alpha')] }).success).toBe(true);
    expect(
      configSchema.safeParse({ machines: [remoteMachine('a', 'Alpha', { port: 0 })] }).success,
    ).toBe(false);
    expect(configSchema.safeParse({ machines: 'nope' }).success).toBe(false);
  });
});

// ── IPC handlers ────────────────────────────────────────────────────────────

describe('machines IPC', () => {
  beforeEach(() => {
    addWindow();
    addWindow();
    registerMachinesIPC();
  });

  it('lists the local machine first and persisted remotes after it', async () => {
    writeHomeConfig({
      machines: [
        remoteMachine('zeta', 'Workstation'),
        remoteMachine('beta', 'Build server'),
      ],
    });

    const result = (await handler(IPC_CHANNELS.MACHINES_LIST)()) as {
      machines: Array<{ id: string; kind: string; label: string }>;
    };

    expect(result.machines.map((machine) => machine.id)).toEqual(['local', 'beta', 'zeta']);
    expect(result.machines[0]).toMatchObject({ kind: 'local' });
    expect(result.machines[0]?.label.length ?? 0).toBeGreaterThan(0);
    expect(broadcastCount()).toBe(0);
  });

  it('creates a machine through IPC and persists it to the home config', async () => {
    writeHomeConfig({ theme: 'light' });

    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
      port: 2222,
      user: 'deploy',
    })) as RemoteMachineRecord;

    expect(created).toMatchObject({
      label: 'Build server',
      kind: 'ssh',
      host: 'build.example.com',
      port: 2222,
      user: 'deploy',
      agentCommand: 'orchid-agent',
    authMethod: 'key',
    });
    expect(created.created_at).toEqual(created.updated_at);
    const home = readHomeConfig();
    expect(home['theme']).toBe('light');
    expect((home['machines'] as RemoteMachineRecord[]).map((machine) => machine.id)).toEqual([
      created.id,
    ]);
  });

  it('applies defaults for port, user, and agentCommand on create', async () => {
    writeHomeConfig({});

    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Bare',
      host: 'bare.example.com',
    })) as RemoteMachineRecord;

    expect(created).toMatchObject({ port: 22, user: '', agentCommand: 'orchid-agent' });
  });

  it('accepts plain agentCommand tokens with flags, paths, and tilde', async () => {
    writeHomeConfig({});

    for (const agentCommand of [
      'orchid-agent --verbose',
      '/usr/local/bin/orchid-agent --port=2222',
      '~/bin/orchid-agent serve --socket ~/.orchid/daemon.sock',
      'node ./agent.js --host 127.0.0.1',
    ]) {
      const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
        label: 'x',
        host: 'h',
        agentCommand,
      })) as RemoteMachineRecord;
      expect(created.agentCommand).toBe(agentCommand);
    }
  });

  it('rejects malformed create payloads without writing', async () => {
    writeHomeConfig({});

    await expect(
      handler(IPC_CHANNELS.MACHINES_CREATE)(null, { label: 'x', host: 'h', port: 0 }),
    ).rejects.toThrow(/Invalid machines:create payload/);
    await expect(
      handler(IPC_CHANNELS.MACHINES_CREATE)(null, { label: 'x', host: '' }),
    ).rejects.toThrow(/Invalid machines:create payload/);
    await expect(
      handler(IPC_CHANNELS.MACHINES_CREATE)(null, 'not-an-object'),
    ).rejects.toThrow(/Invalid machines:create payload/);

    expect(readHomeConfig()).toEqual({});
  });

  it('updates fields through IPC and bumps updated_at', async () => {
    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
    })) as RemoteMachineRecord;

    const updated = (await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: created.id,
      patch: { port: 2200, label: 'Build server 2' },
    })) as RemoteMachineRecord;

    expect(updated).toMatchObject({ port: 2200, label: 'Build server 2' });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updated_at).getTime(),
    );
    const home = readHomeConfig();
    expect((home['machines'] as RemoteMachineRecord[])[0]).toMatchObject({
      port: 2200,
      label: 'Build server 2',
    });
  });

  it('invalidates the pinned known-hosts when host, user, or port changes', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });
    const hostsPath = knownHostsPath('build-1');
    fs.mkdirSync(path.dirname(hostsPath), { recursive: true });
    const rePin = (): void => {
      fs.writeFileSync(hostsPath, `${ED25519_LINE}\n`);
    };
    rePin();
    expect(getMachineHostKeyFlow().pinned('build-1')).toBe(true);

    // Every destination change re-arms the TOFU scan/confirm gate.
    for (const patch of [{ host: 'v2.example.com' }, { port: 2222 }, { user: 'deploy' }]) {
      rePin();
      await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'build-1', patch });
      expect(fs.existsSync(hostsPath), `update ${JSON.stringify(patch)} must unpin`).toBe(false);
      expect(
        getMachineHostKeyFlow().pinned('build-1'),
        `update ${JSON.stringify(patch)} must re-arm TOFU`,
      ).toBe(false);
    }

    // A destination-neutral edit keeps the pin.
    rePin();
    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: 'build-1',
      patch: { label: 'Build server 2' },
    });
    expect(fs.existsSync(hostsPath)).toBe(true);
    expect(getMachineHostKeyFlow().pinned('build-1')).toBe(true);
  });

  it('rejects updating and deleting the local machine', async () => {
    await expect(
      handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'local', patch: { label: 'x' } }),
    ).rejects.toThrow(/Invalid machines:update payload[\s\S]*reserved/);
    await expect(
      handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: 'local' }),
    ).rejects.toThrow(/Invalid machines:delete payload[\s\S]*reserved/);
  });

  it('rejects malformed update payloads', async () => {
    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
    })) as RemoteMachineRecord;

    await expect(
      handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: created.id, patch: { port: 0 } }),
    ).rejects.toThrow(/Invalid machines:update payload/);
    await expect(
      handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: created.id, patch: { nope: 1 } }),
    ).rejects.toThrow(/Invalid machines:update payload/);
    await expect(handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {})).rejects.toThrow(
      /Invalid machines:update payload/,
    );
  });

  it('deletes a machine through IPC and reports not_found for unknown ids', async () => {
    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
    })) as RemoteMachineRecord;

    await expect(handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: created.id })).resolves.toEqual(
      { status: 'deleted', machine: created },
    );
    expect(readHomeConfig()['machines']).toEqual([]);
    await expect(handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: created.id })).resolves.toEqual(
      { status: 'not_found' },
    );
  });

  it('broadcasts machines:changed to every window after each mutation', async () => {
    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
    })) as RemoteMachineRecord;

    expect(broadcastCount()).toBe(mocks.windows.length);
    for (const win of mocks.windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.MACHINES_CHANGED, {
        machines: [
          expect.objectContaining({ id: 'local', kind: 'local' }),
          expect.objectContaining({ id: created.id, kind: 'ssh' }),
        ],
      });
    }

    for (const win of mocks.windows) win.webContents.send.mockClear();

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: created.id,
      patch: { label: 'Renamed' },
    });
    expect(broadcastCount()).toBe(mocks.windows.length);

    for (const win of mocks.windows) win.webContents.send.mockClear();

    await handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: created.id });
    expect(broadcastCount()).toBe(mocks.windows.length);

    for (const win of mocks.windows) win.webContents.send.mockClear();

    // A no-op delete is not a registry change.
    await handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: created.id });
    expect(broadcastCount()).toBe(0);
  });

  it('broadcast payloads keep the local machine first and remotes label-sorted', async () => {
    await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      id: 'zeta',
      label: 'Workstation',
      host: 'zeta.example.com',
    });
    await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      id: 'beta',
      label: 'Build server',
      host: 'beta.example.com',
    });

    const payload = mocks.windows[0]?.webContents.send.mock.calls.at(-1)?.[1] as {
      machines: Array<{ id: string }>;
    };
    expect(payload.machines.map((machine) => machine.id)).toEqual(['local', 'beta', 'zeta']);
  });
});

// ── Password auth (machine-secrets wiring) ──────────────────────────────────

describe('machines password auth', () => {
  beforeEach(() => {
    addWindow();
    registerMachinesIPC();
  });

  function passwordsPath(): string {
    return path.join(homeDir, 'machine-passwords.json');
  }

  it('stores the create password encrypted and never echoes it back', async () => {
    writeHomeConfig({});

    const created = (await handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
      label: 'Build server',
      host: 'build.example.com',
      authMethod: 'password',
      password: 'hunter2!',
    })) as RemoteMachineRecord;

    expect(created.authMethod).toBe('password');
    expect(JSON.stringify(created)).not.toContain('hunter2!');
    const stored = fs.readFileSync(passwordsPath(), 'utf8');
    expect(stored).not.toContain('hunter2!');
    expect(stored).toContain(created.id);

    const auth = (await handler(IPC_CHANNELS.MACHINES_AUTH_STATUS)(null)) as {
      machines: Array<{ machineId: string; hasStoredPassword: boolean }>;
    };
    expect(auth.machines.find((entry) => entry.machineId === created.id)).toMatchObject({
      authMethod: 'password',
      hasStoredPassword: true,
    });
    // The local machine never carries a secret.
    expect(auth.machines.find((entry) => entry.machineId === 'local')).toMatchObject({
      authMethod: 'key',
      hasStoredPassword: false,
    });
  });

  it('rolls back the created record when the password cannot be stored', async () => {
    writeHomeConfig({});
    mocks.safeStorage.isEncryptionAvailable.mockReturnValue(false);

    await expect(
      handler(IPC_CHANNELS.MACHINES_CREATE)(null, {
        label: 'Build server',
        host: 'build.example.com',
        authMethod: 'password',
        password: 'hunter2!',
      }),
    ).rejects.toThrow(/unavailable/i);

    // The record was rolled back — only an empty machines section remains.
    expect(readHomeConfig()['machines']).toEqual([]);
    expect(fs.existsSync(passwordsPath())).toBe(false);
  });

  it('stores, replaces, and clears the password through machines:update', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server', { authMethod: 'password' })] });

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: 'build-1',
      patch: { password: 'first' },
    });
    expect(fs.readFileSync(passwordsPath(), 'utf8')).not.toContain('first');

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: 'build-1',
      patch: { password: 'second' },
    });
    const auth = (await handler(IPC_CHANNELS.MACHINES_AUTH_STATUS)(null)) as {
      machines: Array<{ machineId: string; hasStoredPassword: boolean }>;
    };
    expect(auth.machines.find((entry) => entry.machineId === 'build-1')?.hasStoredPassword).toBe(true);

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, {
      id: 'build-1',
      patch: { password: '' },
    });
    const cleared = (await handler(IPC_CHANNELS.MACHINES_AUTH_STATUS)(null)) as {
      machines: Array<{ machineId: string; hasStoredPassword: boolean }>;
    };
    expect(cleared.machines.find((entry) => entry.machineId === 'build-1')?.hasStoredPassword).toBe(
      false,
    );
  });

  it('drops the stored password when auth switches to key and on delete', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server', { authMethod: 'password' })] });
    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'build-1', patch: { password: 'pw' } });

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'build-1', patch: { authMethod: 'key' } });
    let auth = (await handler(IPC_CHANNELS.MACHINES_AUTH_STATUS)(null)) as {
      machines: Array<{ machineId: string; hasStoredPassword: boolean }>;
    };
    expect(auth.machines.find((entry) => entry.machineId === 'build-1')?.hasStoredPassword).toBe(false);

    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'build-1', patch: { authMethod: 'password' } });
    await handler(IPC_CHANNELS.MACHINES_UPDATE)(null, { id: 'build-1', patch: { password: 'pw' } });
    await handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: 'build-1' });
    auth = (await handler(IPC_CHANNELS.MACHINES_AUTH_STATUS)(null)) as {
      machines: Array<{ machineId: string; hasStoredPassword: boolean }>;
    };
    expect(auth.machines.find((entry) => entry.machineId === 'build-1')).toBeUndefined();
  });
});

// ── Payload schemas ─────────────────────────────────────────────────────────

describe('machines payload schemas', () => {
  it('accepts a minimal create payload and rejects malformed ones', () => {
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h' }).success).toBe(true);
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h', port: 22 }).success).toBe(true);
    expect(machinesCreateSchema.safeParse({ label: 'x' }).success).toBe(false);
    expect(machinesCreateSchema.safeParse({ host: 'h' }).success).toBe(false);
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h', port: '22' }).success).toBe(
      false,
    );
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h', id: 'local' }).success).toBe(
      false,
    );
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h', extra: 1 }).success).toBe(false);
  });

  it('accepts plain agentCommand tokens and rejects shell metacharacters', () => {
    expect(machinesCreateSchema.safeParse({ label: 'x', host: 'h' }).success).toBe(true);
    expect(
      machinesCreateSchema.safeParse({ label: 'x', host: 'h', agentCommand: 'orchid-agent' })
        .success,
    ).toBe(true);
    expect(
      machinesCreateSchema.safeParse({
        label: 'x',
        host: 'h',
        agentCommand: 'orchid-agent --verbose --socket ~/daemon.sock',
      }).success,
    ).toBe(true);
    const injected = [
      'orchid-agent; rm -rf /',
      'orchid-agent && echo pwned',
      'orchid-agent | sh',
      'orchid-agent $(whoami)',
      'orchid-agent `whoami`',
      'echo "orchid-agent"',
      'orchid-agent\\; ls',
      'orchid-agent > /etc/passwd',
    ];
    for (const agentCommand of injected) {
      expect(
        machinesCreateSchema.safeParse({ label: 'x', host: 'h', agentCommand }).success,
        `agentCommand '${agentCommand}' must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects ssh option injection through host and user at the payload boundary', () => {
    const injected = [
      { host: '-oProxyCommand=evil' },
      { host: '-oProxyCommand=evil', user: 'deploy' },
      { host: 'h', user: '-oX=Y' },
      { host: 'h', user: 'a@b' },
      { host: 'h', user: 'a b' },
      { host: 'h', user: 'a#b' },
    ];
    for (const payload of injected) {
      expect(
        machinesCreateSchema.safeParse({ label: 'x', host: 'h', ...payload }).success,
        `create ${JSON.stringify(payload)} must be rejected`,
      ).toBe(false);
      expect(
        machinesUpdateSchema.safeParse({ id: 'a', patch: payload }).success,
        `update ${JSON.stringify(payload)} must be rejected`,
      ).toBe(false);
    }

    // Legit destinations keep working.
    expect(machinesCreateSchema.safeParse({ label: 'x', host: '2001:db8::1', user: 'deploy' }).success).toBe(
      true,
    );
    expect(machinesUpdateSchema.safeParse({ id: 'a', patch: { host: 'new.example.com' } }).success).toBe(
      true,
    );
  });

  it('accepts a partial update payload and rejects id or kind edits', () => {
    expect(machinesUpdateSchema.safeParse({ id: 'a', patch: { port: 2222 } }).success).toBe(true);
    expect(machinesUpdateSchema.safeParse({ id: 'a', patch: {} }).success).toBe(true);
    expect(machinesUpdateSchema.safeParse({ id: 'local', patch: {} }).success).toBe(false);
    expect(
      machinesUpdateSchema.safeParse({ id: 'a', patch: { kind: 'local' } }).success,
    ).toBe(false);
    expect(
      machinesUpdateSchema.safeParse({ id: 'a', patch: { created_at: T1 } }).success,
    ).toBe(false);
    expect(machinesUpdateSchema.safeParse({ id: 'a' }).success).toBe(false);
  });

  it('rejects malformed delete payloads', () => {
    expect(machinesDeleteSchema.safeParse({ id: 'a' }).success).toBe(true);
    expect(machinesDeleteSchema.safeParse({}).success).toBe(false);
    expect(machinesDeleteSchema.safeParse({ id: 'local' }).success).toBe(false);
    expect(machinesDeleteSchema.safeParse('a').success).toBe(false);
  });
});
