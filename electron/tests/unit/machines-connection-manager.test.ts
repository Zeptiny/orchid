/**
 * Machine connection manager tests (issue #112, plan unit U7).
 *
 * Spawns real fixture bridge children (no network): an injectable transport
 * factory wraps spawnSshTransport with a commandFactory pointing at
 * `hello-bridge.cjs`, and an injectable sleep makes the reconnect backoff
 * manually controllable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MachineConnectionError,
  MachineConnectionManager,
  type MachineConnectionState,
  type MachineTransport,
  type MachineTransportFactory,
} from '../../src/main/machines/connection-manager';
import { spawnSshTransport } from '../../src/main/machines/ssh-transport';
import { writeKnownHosts } from '../../src/main/machines/host-key';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const FIXTURE = new URL('../fixtures/machines/hello-bridge.cjs', import.meta.url).pathname;

const T0 = '2026-08-23T00:00:00.000Z';

function sshMachine(id = 'build-1'): RemoteMachineRecord {
  return {
    id,
    label: 'Build server',
    kind: 'ssh',
    host: 'build.example.com',
    port: 22,
    user: '',
    agentCommand: 'orchid-agent',
    created_at: T0,
    updated_at: T0,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Injectable sleep harness: records delays and resolves them manually. */
function manualSleep() {
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return new Promise((resolve) => {
      pending.push({ ms, resolve });
    });
  };
  const flushAll = async (): Promise<void> => {
    while (pending.length > 0) {
      pending.shift()?.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { sleep, delays, flushAll };
}

interface Harness {
  manager: MachineConnectionManager;
  spawns: { created: number; closed: number };
  setMode: (mode: string) => void;
}

let homeDir: string;
let harnesses: Harness[];

function makeManager(
  options: {
    mode?: string;
    handshakeTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    backoff?: { initialMs?: number; maxMs?: number; maxAttempts?: number; resetAfterMs?: number };
    /** Daemon-ensure fake (U10); default resolves false without spawning ssh. */
    ensureDaemon?: (machine: RemoteMachineRecord, hostsPath: string) => Promise<boolean>;
    ensureSettleMs?: number;
  } = {},
): Harness {
  let mode = options.mode ?? 'stable';
  const spawns = { created: 0, closed: 0 };
  const factory: MachineTransportFactory = (machine) => {
    spawns.created += 1;
    const transport = spawnSshTransport(machine, {
      spawnFn: spawn,
      commandFactory: () => [process.execPath, FIXTURE, mode],
    });
    transport.onClose(() => {
      spawns.closed += 1;
    });
    return transport;
  };
  const manager = new MachineConnectionManager({
    homeDir,
    transportFactory: factory,
    sleep: options.sleep,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 4000,
    backoff: options.backoff,
    ensureDaemon: options.ensureDaemon ?? (async () => false),
    ensureSettleMs: options.ensureSettleMs ?? 0,
  });
  const harness: Harness = {
    manager,
    spawns,
    setMode: (next: string) => {
      mode = next;
    },
  };
  harnesses.push(harness);
  return harness;
}

function pinMachine(id = 'build-1'): void {
  writeKnownHosts(
    id,
    ['build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPHhT8R1+f81M2hvSEhe/iCDDHV3m79vicl5uXQ0IZRM test-ed25519'],
    { homeDir, host: 'build.example.com', port: 22 },
  );
}

async function statesOf(harness: Harness): Promise<MachineConnectionState[]> {
  const states: MachineConnectionState[] = [];
  harness.manager.subscribe('build-1', (status) => {
    states.push(status.state);
  });
  return states;
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-conn-'));
  harnesses = [];
});

afterEach(async () => {
  for (const harness of harnesses) {
    harness.manager.disconnectAll();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('MachineConnectionManager connect', () => {
  it('handshakes a fixture bridge and exposes the live transport', async () => {
    pinMachine();
    const harness = makeManager();
    const states = await statesOf(harness);

    const status = await harness.manager.connect(sshMachine());

    expect(status.state).toBe('connected');
    expect(harness.manager.getStatus('build-1').state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
    const transport = harness.manager.getTransport('build-1');
    expect(transport).not.toBeNull();
    const replies: string[] = [];
    (transport as MachineTransport).onData((line) => replies.push(line));
    (transport as MachineTransport).write(JSON.stringify({ id: 9, method: 'later.call' }));
    await waitFor(() => replies.length > 0);
    expect(JSON.parse(replies[0] as string)).toEqual({ id: 9, ok: true, result: { ack: true } });
  });

  it('shares one attempt between concurrent connects', async () => {
    pinMachine();
    const harness = makeManager();
    const [a, b] = await Promise.all([
      harness.manager.connect(sshMachine()),
      harness.manager.connect(sshMachine()),
    ]);
    expect(a.state).toBe('connected');
    expect(b.state).toBe('connected');
    expect(harness.spawns.created).toBe(1);
  });

  it('returns immediately when already connected', async () => {
    pinMachine();
    const harness = makeManager();
    await harness.manager.connect(sshMachine());
    const again = await harness.manager.connect(sshMachine());
    expect(again.state).toBe('connected');
    expect(harness.spawns.created).toBe(1);
  });

  it('shares an in-flight reconnect attempt with a concurrent manual connect', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({
      mode: 'die-after',
      sleep: sleep.sleep,
      backoff: { initialMs: 1000 },
    });

    await harness.manager.connect(sshMachine());
    await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    harness.setMode('stable');
    await sleep.flushAll();
    await waitFor(() => harness.manager.getStatus('build-1').state === 'connecting');

    const status = await harness.manager.connect(sshMachine());

    expect(status.state).toBe('connected');
    // Only the initial connect and the reconnect spawned — no racing third transport.
    expect(harness.spawns.created).toBe(2);
  });

  it('rejects the implicit local machine', async () => {
    const harness = makeManager();
    await expect(
      harness.manager.connect({ id: 'local', label: 'This PC', kind: 'local' }),
    ).rejects.toThrow(/local and connects in-process/);
    expect(harness.spawns.created).toBe(0);
  });
});

// ── Failure classification ───────────────────────────────────────────────────

describe('MachineConnectionManager failure classification', () => {
  it('fails closed with host-key-not-pinned before ever spawning a transport', async () => {
    const harness = makeManager();
    await expect(harness.manager.connect(sshMachine())).rejects.toThrow(MachineConnectionError);
    const status = harness.manager.getStatus('build-1');
    expect(status.state).toBe('lost');
    expect(status.error?.kind).toBe('host-key-not-pinned');
    expect(harness.spawns.created).toBe(0);
  });

  it('classifies a handshake timeout as agent-missing with the install hint', async () => {
    pinMachine();
    const harness = makeManager({ mode: 'silent', handshakeTimeoutMs: 150 });

    await expect(harness.manager.connect(sshMachine())).rejects.toThrow(MachineConnectionError);

    const status = harness.manager.getStatus('build-1');
    expect(status.state).toBe('lost');
    expect(status.error?.kind).toBe('agent-missing');
    expect(status.error?.hint).toContain('orchid-agent serve --socket');
    // The timed-out transport is killed, not leaked.
    await waitFor(() => harness.spawns.closed === harness.spawns.created);
  });

  it('classifies a remote command-not-found exit as agent-missing', async () => {
    pinMachine();
    const harness = makeManager({ mode: 'missing' });

    await expect(harness.manager.connect(sshMachine())).rejects.toThrow(MachineConnectionError);

    const status = harness.manager.getStatus('build-1');
    expect(status.state).toBe('lost');
    expect(status.error?.kind).toBe('agent-missing');
    expect(status.error?.message).toContain('bridge command was not found');
  });

  it('rejects a protocol version mismatch', async () => {
    pinMachine();
    const harness = makeManager({ mode: 'wrong-version' });

    await expect(harness.manager.connect(sshMachine())).rejects.toThrow(MachineConnectionError);

    const status = harness.manager.getStatus('build-1');
    expect(status.error?.kind).toBe('protocol-mismatch');
    expect(status.error?.message).toContain('Protocol version mismatch');
    await waitFor(() => harness.spawns.closed === harness.spawns.created);
  });
});

// ── Unexpected loss + reconnect ──────────────────────────────────────────────

describe('MachineConnectionManager reconnect', () => {
  it('reconnects with backoff after an unexpected loss', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({
      mode: 'die-after',
      sleep: sleep.sleep,
      backoff: { initialMs: 1000 },
    });
    const states = await statesOf(harness);

    await harness.manager.connect(sshMachine());
    await waitFor(() => states.includes('lost'));
    harness.setMode('stable');
    await sleep.flushAll();
    await waitFor(() => harness.manager.getStatus('build-1').state === 'connected');

    expect(states).toEqual(['connecting', 'connected', 'lost', 'connecting', 'connected']);
    expect(sleep.delays).toEqual([1000]);
    // First connection died (closed=1); the reconnect transport stays open.
    expect(harness.spawns.created).toBe(2);
    await waitFor(() => harness.spawns.closed === 1);
  });

  it('resets the attempt counter after a stable connection', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({
      mode: 'die-after',
      sleep: sleep.sleep,
      backoff: { initialMs: 1000, resetAfterMs: 50 },
    });

    await harness.manager.connect(sshMachine());
    harness.setMode('stable');
    await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    await sleep.flushAll();
    await waitFor(() => harness.manager.getStatus('build-1').state === 'connected');
    await waitFor(() => harness.manager.getStatus('build-1').reconnectAttempts === 0);
  });

  it('gives up after max attempts and stays lost without leaking transports', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({
      mode: 'die-after',
      sleep: sleep.sleep,
      backoff: { initialMs: 1000, maxMs: 30000, maxAttempts: 5 },
    });

    await harness.manager.connect(sshMachine());
    await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep.flushAll();
      await waitFor(
        () =>
          harness.manager.getStatus('build-1').reconnectAttempts >= attempt + 1 ||
          harness.manager.getStatus('build-1').state === 'connected',
      );
      await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    }
    await sleep.flushAll();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(harness.manager.getStatus('build-1').state).toBe('lost');
    expect(harness.manager.getStatus('build-1').reconnectAttempts).toBe(5);
    expect(sleep.delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    // Initial connect + 5 reconnects; every child closed — no leaks.
    expect(harness.spawns.created).toBe(6);
    await waitFor(() => harness.spawns.closed === 6);
    // Stays lost: no further spawns after the final failed attempt.
    await sleep.flushAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.spawns.created).toBe(6);
  });

  it('caps the backoff delay at maxMs', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({
      mode: 'die-after',
      sleep: sleep.sleep,
      backoff: { initialMs: 1000, maxMs: 3000, maxAttempts: 6 },
    });

    await harness.manager.connect(sshMachine());
    await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep.flushAll();
      await waitFor(() => harness.manager.getStatus('build-1').state === 'lost');
    }
    expect(sleep.delays).toEqual([1000, 2000, 3000, 3000, 3000, 3000]);
  });

  it('disconnect cancels a pending reconnect and goes offline', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({ mode: 'die-after', sleep: sleep.sleep });
    const states = await statesOf(harness);

    await harness.manager.connect(sshMachine());
    await waitFor(() => states.includes('lost'));
    // The reconnect attempt is now parked in the injected sleep.
    expect(sleep.delays).toEqual([1000]);

    harness.manager.disconnect('build-1');
    expect(harness.manager.getStatus('build-1').state).toBe('offline');
    expect(harness.manager.getTransport('build-1')).toBeNull();

    await sleep.flushAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.spawns.created).toBe(1); // no reconnect spawn after disconnect
    expect(states).toEqual(['connecting', 'connected', 'lost', 'offline']);
  });

  it('disconnect after connect produces offline with no reconnect', async () => {
    pinMachine();
    const sleep = manualSleep();
    const harness = makeManager({ mode: 'stable', sleep });
    const states = await statesOf(harness);

    await harness.manager.connect(sshMachine());
    harness.manager.disconnect('build-1');
    expect(harness.manager.getStatus('build-1').state).toBe('offline');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sleep.delays).toEqual([]);
    expect(states).toEqual(['connecting', 'connected', 'offline']);
    expect(harness.spawns.created).toBe(1);
    await waitFor(() => harness.spawns.closed === 1);
  });
});

// ── Subscriptions ────────────────────────────────────────────────────────────

describe('MachineConnectionManager subscriptions', () => {
  it('scopes per-machine listeners and notifies wildcard listeners', async () => {
    pinMachine('build-1');
    pinMachine('build-2');
    const harness = makeManager();
    const forBuild1: MachineConnectionState[] = [];
    const forBuild2: MachineConnectionState[] = [];
    const wildcard: MachineConnectionState[] = [];
    harness.manager.subscribe('build-1', (status) => forBuild1.push(status.state));
    harness.manager.subscribe('build-2', (status) => forBuild2.push(status.state));
    harness.manager.subscribe('*', (status) => wildcard.push(status.state));

    await harness.manager.connect(sshMachine('build-1'));

    expect(forBuild1).toEqual(['connecting', 'connected']);
    expect(forBuild2).toEqual([]);
    expect(wildcard).toEqual(['connecting', 'connected']);

    const unsubscribe = harness.manager.subscribe('build-1', () => {});
    unsubscribe();
    unsubscribe();
    expect(harness.manager.getStatus('ghost')).toEqual({
      machineId: 'ghost',
      state: 'offline',
      error: null,
      reconnectAttempts: 0,
    });
  });
});
