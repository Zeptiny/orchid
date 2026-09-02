/**
 * Machine connection/status IPC tests (issue #112, unit U8).
 *
 * Mirrors machines-ipc.test.ts's harness (fake ipcMain/BrowserWindow + temp
 * home config) and injects a fake connection manager plus a scripted
 * ssh-keyscan, so the connect flow — TOFU gate, client registration in
 * routing, status broadcasts, delete teardown — is exercised without network
 * access. The HostClient itself is real, driven over an in-test transport.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { defaults } from '../../src/main/config/schema';
import { PROTOCOL_VERSION } from '../../src/shared/host/protocol';
import type { HostTransport } from '../../src/main/host/transport';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  type FakeWindow = {
    isDestroyed: () => boolean;
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  };
  type FakeStatus = {
    machineId: string;
    state: 'offline' | 'connecting' | 'connected' | 'lost';
    error: unknown;
    reconnectAttempts: number;
  };
  type Listener = (status: FakeStatus) => void;

  class FakeMachineConnectionManager {
    readonly statuses = new Map<string, FakeStatus>();
    readonly transports = new Map<string, HostTransport>();
    readonly connectCalls: string[] = [];
    readonly disconnectCalls: string[] = [];
    private readonly listeners = new Map<string, Set<Listener>>();
    private connectImpl: ((machine: { id: string }) => Promise<FakeStatus>) | null = null;

    private entry(machineId: string): FakeStatus {
      return (
        this.statuses.get(machineId) ?? {
          machineId,
          state: 'offline',
          error: null,
          reconnectAttempts: 0,
        }
      );
    }

    private notify(machineId: string): void {
      const status = this.entry(machineId);
      for (const listener of this.listeners.get(machineId) ?? []) listener(status);
      for (const listener of this.listeners.get('*') ?? []) listener(status);
    }

    setStateForTest(machineId: string, state: FakeStatus['state'], error: unknown = null): void {
      this.statuses.set(machineId, { ...this.entry(machineId), state, error });
      this.notify(machineId);
    }

    getStatus(machineId: string): FakeStatus {
      return this.entry(machineId);
    }

    getTransport(machineId: string): HostTransport | null {
      return this.entry(machineId).state === 'connected'
        ? this.transports.get(machineId) ?? null
        : null;
    }

    subscribe(machineId: string, listener: Listener): () => void {
      let set = this.listeners.get(machineId);
      if (!set) {
        set = new Set();
        this.listeners.set(machineId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    }

    /** Replace the connect behavior (failure-injection tests). */
    failConnectWith(error: unknown): void {
      this.connectImpl = async () => {
        throw error;
      };
    }

    async connect(machine: { id: string }): Promise<FakeStatus> {
      if (this.connectImpl) return this.connectImpl(machine);
      this.connectCalls.push(machine.id);
      this.setStateForTest(machine.id, 'connecting');
      this.transports.set(machine.id, makeFakeTransport());
      this.setStateForTest(machine.id, 'connected');
      return this.getStatus(machine.id);
    }

    disconnect(machineId: string): void {
      this.disconnectCalls.push(machineId);
      this.transports.delete(machineId);
      if (this.statuses.has(machineId)) this.setStateForTest(machineId, 'offline');
    }

    disconnectAll(): void {
      mocks.teardownOrder.push('disconnectAll');
      for (const machineId of [...this.statuses.keys()]) this.disconnect(machineId);
    }
  }

  /** Minimal HostTransport answering the HostClient's host.hello handshake. */
  function makeFakeTransport(): HostTransport & { written: string[] } {
    const closeCallbacks: Array<() => void> = [];
    let dataCb: ((line: string) => void) | null = null;
    const transport: HostTransport & { written: string[] } = {
      written: [],
      write(line: string): void {
        transport.written.push(line);
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method === 'host.hello' && dataCb) {
          dataCb(
            JSON.stringify({
              id: message.id,
              ok: true,
              result: { protocolVersion: PROTOCOL_VERSION },
            }),
          );
        }
      },
      onData(cb: (line: string) => void): void {
        dataCb = cb;
      },
      onClose(cb: () => void): void {
        closeCallbacks.push(cb);
      },
      close(): void {
        for (const cb of closeCallbacks.splice(0)) cb();
      },
    };
    return transport;
  }

  class MachineConnectionError extends Error {
    readonly kind: string;
    readonly hint: string;

    constructor(kind: string, message: string, hint = '') {
      super(message);
      this.name = 'MachineConnectionError';
      this.kind = kind;
      this.hint = hint;
    }
  }

  let manager: FakeMachineConnectionManager | null = null;

  return {
    handlers,
    windows: [] as FakeWindow[],
    homeConfigPath: '',
    configState: {} as Record<string, unknown>,
    /** Ordered teardown events (unregisterMachinesIPC ordering assertions). */
    teardownOrder: [] as string[],
    makeFakeTransport,
    MachineConnectionError,
    localClientListener: null as ((client: unknown, clientId: string) => void) | null,
    localClientSweep: null as (() => void) | null,
    manager: () => {
      manager ??= new FakeMachineConnectionManager();
      return manager;
    },
    resetManager: () => {
      manager = null;
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    BrowserWindow: {
      getAllWindows: vi.fn((): FakeWindow[] => mocks.windows),
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

// Routing's local-machine branch must not start the embedded host here. The
// listener/sweep seams are captured so the window-broadcast wiring (#13) can
// be exercised without a real HostClient over the embedded host.
vi.mock('../../src/main/host/local-host', () => ({
  getLocalHostClient: (windowId: string) => ({ clientId: windowId, local: true }),
  closeLocalHostClient: vi.fn(),
  setLocalClientListener: (listener: unknown) => {
    mocks.localClientListener = listener as ((client: unknown, clientId: string) => void) | null;
  },
  setLocalClientSweep: (sweep: unknown) => {
    mocks.localClientSweep = sweep as (() => void) | null;
  },
}));

// The resync seam is spied, not faked away from its contract: the connect flow
// must invoke it exactly once per (re)connect, through the manager subscription.
vi.mock('../../src/main/machines/resync', () => ({
  resyncRemoteMachine: vi.fn(async () => ({
    sessionIds: [],
    activeSessionId: null,
    liveTurn: null,
    liveSubagentCount: 0,
    hasBackgroundCommands: false,
    approvals: [],
    questions: [],
  })),
}));

vi.mock('../../src/main/machines/connection-manager', async () => ({
  MachineConnectionError: mocks.MachineConnectionError,
  getMachineConnectionManager: () => mocks.manager(),
  _resetMachineConnectionManagerForTests: () => mocks.resetManager(),
}));

vi.mock('../../src/main/machines/host-key', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/machines/host-key')>();
  return {
    ...actual,
    scanHostKeys: vi.fn(),
  };
});

// Teardown ordering (quit path): the client teardown must be observable
// relative to the manager's disconnect-all while still running for real.
vi.mock('../../src/main/machines/remote-clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/machines/remote-clients')>();
  return {
    ...actual,
    detachAllRemoteMachineClients: vi.fn(() => {
      mocks.teardownOrder.push('detachAll');
      actual.detachAllRemoteMachineClients();
    }),
  };
});

// ── Imports under test ──────────────────────────────────────────────────────

import { registerMachinesIPC, unregisterMachinesIPC } from '../../src/main/ipc/machines';
import { resyncRemoteMachine } from '../../src/main/machines/resync';
import { _resetMachineRegistryForTests } from '../../src/main/machines/registry';
import {
  _resetMachineConnectionManagerForTests,
  MachineConnectionError,
} from '../../src/main/machines/connection-manager';
import { scanHostKeys, HostKeyScanError } from '../../src/main/machines/host-key';
import {
  machineConnectResultSchema,
  machineConfirmHostKeyResultSchema,
  machineScanHostKeyResultSchema,
} from '../../src/shared/types/ipc-schemas';
import { _resetMachineHostKeyFlowForTests } from '../../src/main/machines/host-key-flow';
import {
  activeMachineFor,
  clearActiveMachine,
  registeredMachines,
  setActiveMachine,
} from '../../src/main/host/routing';
import { wireLocalHostWindowBroadcast, unwireLocalHostWindowBroadcast } from '../../src/main/ipc/host-broadcast';
import { MACHINE_ID_LOCAL } from '../../src/shared/types/machine';
import { _resetConfigSaveChainForTests } from '../../src/main/config/write-lock';

const T0 = '2026-08-23T00:00:00.000Z';
const WINDOW_ID = '7';

const SCAN_LINES = [
  'build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEd25519.test.key.one',
  'build.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDtest.key.two',
];

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

function manager(): ReturnType<typeof mocks.manager> {
  return mocks.manager();
}

let homeDir: string;

function writeHomeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(mocks.homeConfigPath), { recursive: true });
  fs.writeFileSync(mocks.homeConfigPath, JSON.stringify(value, null, 2), 'utf-8');
}

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`${channel} handler not registered`);
  return registered;
}

function senderEvent(id = WINDOW_ID): { sender: { id: number } } {
  return { sender: { id: Number(id) } };
}

function addWindow(id: number): void {
  mocks.windows.push({
    isDestroyed: () => false,
    webContents: { id, isDestroyed: () => false, send: vi.fn() },
  });
}

function statusBroadcasts(): unknown[] {
  const payloads: unknown[] = [];
  for (const win of mocks.windows) {
    for (const call of win.webContents.send.mock.calls) {
      if (call[0] === IPC_CHANNELS.MACHINES_STATUS_CHANGED) payloads.push(call[1]);
    }
  }
  return payloads;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.windows.length = 0;
  mocks.teardownOrder.length = 0;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-status-'));
  mocks.homeConfigPath = path.join(homeDir, 'config.json');
  mocks.configState = defaults() as unknown as Record<string, unknown>;
  _resetConfigSaveChainForTests();
  _resetMachineRegistryForTests();
  _resetMachineConnectionManagerForTests();
  _resetMachineHostKeyFlowForTests();
  vi.mocked(scanHostKeys).mockReset();
  vi.mocked(scanHostKeys).mockResolvedValue(SCAN_LINES);
  vi.mocked(resyncRemoteMachine).mockClear();
  addWindow(7);
  registerMachinesIPC();
});

afterEach(() => {
  unregisterMachinesIPC();
  clearActiveMachine(WINDOW_ID);
  clearActiveMachine('8');
  fs.rmSync(homeDir, { recursive: true, force: true });
  vi.mocked(scanHostKeys).mockReset();
});

// ── machines:get_status ─────────────────────────────────────────────────────

describe('machines:get_status', () => {
  it('reports the local machine as connected and remotes with manager state', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });

    const result = (await handler(IPC_CHANNELS.MACHINES_GET_STATUS)()) as {
      machines: Array<{
        machineId: string;
        state: string;
        error: { kind: string } | null;
        reconnectAttempts: number;
      }>;
    };

    expect(result.machines.map((entry) => [entry.machineId, entry.state])).toEqual([
      ['local', 'connected'],
      ['build-1', 'offline'],
    ]);
    expect(result.machines[0]?.error).toBeNull();
    expect(result.machines[1]?.reconnectAttempts).toBe(0);

    manager().setStateForTest(
      'build-1',
      'lost',
      new MachineConnectionError('agent-missing', 'No host.hello response', 'Install orchid-agent.'),
    );
    const failed = (await handler(IPC_CHANNELS.MACHINES_GET_STATUS)()) as {
      machines: Array<{ machineId: string; error: { kind: string; hint: string } | null }>;
    };
    expect(failed.machines[1]?.error).toEqual({
      kind: 'agent-missing',
      message: 'No host.hello response',
      hint: 'Install orchid-agent.',
    });
  });

  it('broadcasts machines:status_changed on every manager transition', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });

    manager().setStateForTest('build-1', 'connecting');
    await vi.waitFor(() => expect(statusBroadcasts().length).toBeGreaterThan(0));
    const latest = statusBroadcasts().at(-1) as { machines: Array<{ machineId: string; state: string }> };
    expect(latest.machines.find((entry) => entry.machineId === 'build-1')?.state).toBe('connecting');
  });
});

// ── machines:set_active / get_active ────────────────────────────────────────

describe('machines:set_active', () => {
  it('switches to the local machine', async () => {
    const result = await handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), {
      machineId: 'local',
    });
    expect(result).toEqual({ status: 'ok', machineId: 'local' });
    expect(activeMachineFor(WINDOW_ID)).toBe('local');
  });

  it('rejects an unknown machine with a typed error', async () => {
    const result = (await handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), {
      machineId: 'ghost',
    })) as { status: string; error: { kind: string } };
    expect(result.status).toBe('error');
    expect(result.error.kind).toBe('machine-not-found');
  });

  it('rejects an unconnected remote', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });

    const result = (await handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), {
      machineId: 'build-1',
    })) as { status: string; error: { kind: string; message: string } };
    expect(result.status).toBe('error');
    expect(result.error.kind).toBe('not-connected');
    expect(result.error.message).toMatch(/offline/);
    expect(activeMachineFor(WINDOW_ID)).toBe('local');
  });

  it('switches to a connected remote and reports it per window', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await manager().connect(machine);

    const result = await handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), {
      machineId: 'build-1',
    });
    expect(result).toEqual({ status: 'ok', machineId: 'build-1' });
    expect(activeMachineFor(WINDOW_ID)).toBe('build-1');

    const active = (await handler(IPC_CHANNELS.MACHINES_GET_ACTIVE)(senderEvent())) as {
      machineId: string;
    };
    expect(active).toEqual({ machineId: 'build-1' });

    // Another window stays on its own machine.
    const other = (await handler(IPC_CHANNELS.MACHINES_GET_ACTIVE)(senderEvent(8))) as {
      machineId: string;
    };
    expect(other).toEqual({ machineId: 'local' });
  });

  it('rejects malformed payloads', async () => {
    await expect(
      handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), {}),
    ).rejects.toThrow(/Invalid machines:set_active payload/);
  });
});

// ── machines:connect / disconnect ───────────────────────────────────────────

describe('machines:connect', () => {
  it('registers a host client in routing and broadcasts status on success', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });

    // Pin first (scan + confirm), then connect.
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });
    const result = (await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, {
      machineId: 'build-1',
    })) as { status: string; machine: { state: string } };

    expect(result.status).toBe('ok');
    expect(result.machine.state).toBe('connected');
    expect(registeredMachines()).toContain('build-1');
    await vi.waitFor(() => expect(statusBroadcasts().length).toBeGreaterThan(0));
  });

  it('resyncs exactly once per manual connect (the subscription is the single seam)', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });

    const result = await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, { machineId: 'build-1' });
    expect(result).toMatchObject({ status: 'ok' });

    // The manager's connected transition drives the one resync…
    await vi.waitFor(() => expect(resyncRemoteMachine).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resyncRemoteMachine)).toHaveBeenCalledWith('build-1', expect.objectContaining({
      clientId: 'machine:build-1',
    }));
    // …and the handler must not add a second one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resyncRemoteMachine).toHaveBeenCalledTimes(1);
  });

  it('answers unpinned machines with host-key-not-pinned plus the scan fingerprints', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });

    const result = (await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, {
      machineId: 'build-1',
    })) as {
      status: string;
      error: { kind: string; fingerprints?: Array<{ algorithm: string; fingerprintSha256: string }> };
    };

    expect(result.status).toBe('error');
    expect(result.error.kind).toBe('host-key-not-pinned');
    expect(result.error.fingerprints).toEqual([
      expect.objectContaining({ algorithm: 'ssh-ed25519' }),
      expect.objectContaining({ algorithm: 'ssh-rsa' }),
    ]);
    expect(result.error.fingerprints?.[0]?.fingerprintSha256).toMatch(/^SHA256:/);
    // The renderer-safe shape only: raw key material must never cross IPC
    // (machineConnectResultSchema is strict, like the preload's validation).
    expect(machineConnectResultSchema.safeParse(result).success).toBe(true);
    expect(registeredMachines()).not.toContain('build-1');
    // Nothing connected while unpinned.
    expect(manager().connectCalls).toEqual([]);
  });

  it('serializes manager connect failures as typed errors', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });

    manager().failConnectWith(
      new MachineConnectionError(
        'agent-missing',
        'No host.hello response within 20s.',
        'Install orchid-agent on the remote.',
      ),
    );

    const result = (await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, {
      machineId: 'build-1',
    })) as { status: string; error: { kind: string; hint: string } };
    expect(result.status).toBe('error');
    expect(result.error.kind).toBe('agent-missing');
    expect(result.error.hint).toBe('Install orchid-agent on the remote.');
    expect(registeredMachines()).not.toContain('build-1');
  });

  it('rejects the local machine and unknown ids with typed errors', async () => {
    const local = (await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, {
      machineId: 'local',
    })) as { status: string; error: { kind: string } };
    expect(local.error.kind).toBe('not-remote');

    const unknown = (await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, {
      machineId: 'ghost',
    })) as { status: string; error: { kind: string } };
    expect(unknown.error.kind).toBe('machine-not-found');
  });

  it('disconnect tears the client down and reports offline', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, { machineId: 'build-1' });
    expect(registeredMachines()).toContain('build-1');

    const result = await handler(IPC_CHANNELS.MACHINES_DISCONNECT)(null, {
      machineId: 'build-1',
    });
    expect(result).toEqual({ status: 'ok' });
    expect(registeredMachines()).not.toContain('build-1');
    expect(manager().getStatus('build-1').state).toBe('offline');

    const local = (await handler(IPC_CHANNELS.MACHINES_DISCONNECT)(null, {
      machineId: 'local',
    })) as { status: string; error: { kind: string } };
    expect(local.error.kind).toBe('not-remote');
  });
});

// ── Host-key scan / confirm ─────────────────────────────────────────────────

describe('machines:scan_host_key / confirm_host_key', () => {
  it('scans, pins exactly the cached scan, and surfaces scan failures', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });

    const scanned = (await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, {
      machineId: 'build-1',
    })) as { status: string; fingerprints: Array<{ algorithm: string }> };
    expect(scanned.status).toBe('scanned');
    expect(scanned.fingerprints.map((fingerprint) => fingerprint.algorithm)).toEqual([
      'ssh-ed25519',
      'ssh-rsa',
    ]);
    // Renderer-safe projection: strict schema + no rawLine key.
    expect(machineScanHostKeyResultSchema.safeParse(scanned).success).toBe(true);
    for (const fingerprint of scanned.fingerprints) {
      expect(fingerprint).not.toHaveProperty('rawLine');
    }

    const confirmed = (await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, {
      machineId: 'build-1',
    })) as { status: string; fingerprints: Array<{ algorithm: string }> };
    expect(confirmed.status).toBe('pinned');
    expect(confirmed.fingerprints).toEqual(scanned.fingerprints);
    expect(machineConfirmHostKeyResultSchema.safeParse(confirmed).success).toBe(true);

    // The pin exists on disk under the app-managed known-hosts dir.
    const knownHosts = fs.readFileSync(
      path.join(homeDir, 'machines', 'build-1', 'known_hosts'),
      'utf-8',
    );
    expect(knownHosts).toContain('ssh-ed25519');

    // Scan failure surfaces as an actionable typed error.
    vi.mocked(scanHostKeys).mockRejectedValueOnce(
      new HostKeyScanError('unreachable', 'ssh-keyscan failed for build.example.com:22', 'no route to host'),
    );
    const failed = (await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, {
      machineId: 'build-1',
    })) as { status: string; error: { kind: string; hint: string } };
    expect(failed.status).toBe('error');
    expect(failed.error.kind).toBe('host-key-scan-failed');
    expect(failed.error.hint).toContain('no route to host');
  });

  it('refuses to confirm a machine that never scanned', async () => {
    writeHomeConfig({ machines: [remoteMachine('build-1', 'Build server')] });

    const result = (await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, {
      machineId: 'build-1',
    })) as { status: string; error: { kind: string } };
    expect(result.status).toBe('error');
    expect(result.error.kind).toBe('host-key-scan-missing');
  });
});

// ── Delete teardown ─────────────────────────────────────────────────────────

describe('machines:delete with a connected machine', () => {
  it('disconnects, unregisters the client, and resets windows to local', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_SET_ACTIVE)(senderEvent(), { machineId: 'build-1' });
    expect(activeMachineFor(WINDOW_ID)).toBe('build-1');

    const result = await handler(IPC_CHANNELS.MACHINES_DELETE)(null, { id: 'build-1' });
    expect(result).toMatchObject({ status: 'deleted' });

    expect(manager().disconnectCalls).toContain('build-1');
    expect(registeredMachines()).not.toContain('build-1');
    expect(activeMachineFor(WINDOW_ID)).toBe('local');

    // The stale known-hosts scan cache cannot resurrect a pin for the deleted id.
    const reconfirm = (await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, {
      machineId: 'build-1',
    })) as { status: string };
    expect(reconfirm.status).toBe('error');
  });
});

// ── Quit teardown ordering ───────────────────────────────────────────────────

describe('unregisterMachinesIPC (quit teardown)', () => {
  it('disconnects every machine before detaching clients', async () => {
    const machine = remoteMachine('build-1', 'Build server');
    writeHomeConfig({ machines: [machine] });
    await handler(IPC_CHANNELS.MACHINES_SCAN_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONFIRM_HOST_KEY)(null, { machineId: 'build-1' });
    await handler(IPC_CHANNELS.MACHINES_CONNECT)(null, { machineId: 'build-1' });
    expect(registeredMachines()).toContain('build-1');
    expect(manager().getStatus('build-1').state).toBe('connected');

    mocks.teardownOrder.length = 0;
    unregisterMachinesIPC();

    // Offline FIRST (closing transports from the manager side suppresses the
    // unexpected-loss reconnect loop that would spawn ssh during the quit
    // drain), then the client teardown.
    expect(mocks.teardownOrder).toEqual(['disconnectAll', 'detachAll']);
    expect(manager().getStatus('build-1').state).toBe('offline');
    expect(registeredMachines()).not.toContain('build-1');
  });
});

// ── Local host event broadcast gating (#13) ──────────────────────────────────

describe('local host window broadcast gating (#13)', () => {
  /** Minimal HostClient stub whose subscriptions the test can fire by name. */
  function stubHostClient(): {
    client: { subscribe: (ev: string, handler: (params: unknown) => void) => () => void };
    handlers: Map<string, (params: unknown) => void>;
  } {
    const handlers = new Map<string, (params: unknown) => void>();
    return {
      handlers,
      client: {
        subscribe: (ev, handler) => {
          handlers.set(ev, handler);
          return () => handlers.delete(ev);
        },
      },
    };
  }

  beforeEach(() => {
    addWindow(8);
    wireLocalHostWindowBroadcast();
  });

  afterEach(() => {
    unwireLocalHostWindowBroadcast();
    clearActiveMachine('7');
    clearActiveMachine('8');
  });

  it('delivers local host events only to local-active windows — never to one switched to a remote', () => {
    expect(mocks.localClientListener).toBeTypeOf('function');
    const attach = mocks.localClientListener!;
    const local = stubHostClient();
    const switched = stubHostClient();
    attach(local.client as never, '8');
    attach(switched.client as never, '7');
    expect(local.handlers.size).toBeGreaterThan(0);
    expect(switched.handlers.size).toBe(local.handlers.size);

    setActiveMachine('7', 'build-1');
    const payload = { activity: { sessionId: '11111111-1111-4111-8111-111111111111', state: 'working' } };
    const window8 = mocks.windows.find((win) => win.webContents.id === 8)!;
    const window7 = mocks.windows.find((win) => win.webContents.id === 7)!;

    // The remote-active window's per-window local client keeps its
    // subscription, but the broadcast must not cross machines.
    switched.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED)!(payload);
    expect(window7.webContents.send).not.toHaveBeenCalled();

    // A local-active window still receives the same event.
    local.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED)!(payload);
    expect(window8.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      payload,
    );

    // Switching back resumes delivery for that window (suspension, not teardown).
    setActiveMachine('7', MACHINE_ID_LOCAL);
    switched.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_CHANGED)!(payload);
    expect(window7.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_WORKING_SET_CHANGED,
      payload,
    );
  });
});
