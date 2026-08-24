/**
 * Daemon-ensure tests (issue #112, plan unit U10).
 *
 * Handshake-timeout path of the connection manager: an agent-missing failure
 * triggers exactly ONE one-shot
 * `ssh … <agentCommand> serve --socket ~/.orchid/daemon.sock --detached`
 * cycle per connect cycle, then retries the bridge handshake — connected when
 * the daemon answers, agent-missing with the install hint otherwise.
 *
 * The bridge transports are the hello-bridge.cjs fixtures (no network); the
 * ensure command runs the real `spawnDaemonEnsure`/`buildSshServeCommand`
 * against an injectable spawn (recorded argv + real node exit codes).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineConnectionManager } from '../../src/main/machines/connection-manager';
import { spawnSshTransport } from '../../src/main/machines/ssh-transport';
import {
  buildSshServeCommand,
  spawnDaemonEnsure,
  REMOTE_DAEMON_SOCKET_PATH,
} from '../../src/main/machines/ssh-transport';
import { writeKnownHosts } from '../../src/main/machines/host-key';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const FIXTURE = new URL('../fixtures/machines/hello-bridge.cjs', import.meta.url).pathname;

const T0 = '2026-08-23T00:00:00.000Z';

function sshMachine(): RemoteMachineRecord {
  return {
    id: 'build-1',
    label: 'Build server',
    kind: 'ssh',
    host: 'build.example.com',
    port: 2222,
    user: 'deploy',
    agentCommand: 'orchid-agent',
    created_at: T0,
    updated_at: T0,
  };
}

/** Recording spawn: logs argv, runs a real node child with the given exit code. */
function recordingSpawn(exitCode: number) {
  const argvs: string[][] = [];
  const spawnFn = (
    command: string,
    args: string[],
    _options: SpawnOptions,
  ): ChildProcess => {
    argvs.push([command, ...args]);
    return spawn(process.execPath, ['-e', `process.exit(${exitCode})`]);
  };
  return { argvs, spawnFn };
}

let homeDir: string;
let managers: MachineConnectionManager[];

function pinMachine(): void {
  writeKnownHosts(
    'build-1',
    ['build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPHhT8R1+f81M2hvSEhe/iCDDHV3m79vicl5uXQ0IZRM test-ed25519'],
    { homeDir, host: 'build.example.com', port: 2222 },
  );
}

function makeManager(options: {
  bridgeModes: string[];
  ensure: (machine: RemoteMachineRecord, hostsPath: string) => Promise<boolean>;
  handshakeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  backoff?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
}): { manager: MachineConnectionManager; spawns: { created: number; closed: number } } {
  let bridgeCall = 0;
  const spawns = { created: 0, closed: 0 };
  const manager = new MachineConnectionManager({
    homeDir,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 150,
    ensureSettleMs: 0,
    ensureDaemon: options.ensure,
    sleep: options.sleep,
    backoff: options.backoff,
    transportFactory: (machine) => {
      spawns.created += 1;
      const mode = options.bridgeModes[Math.min(bridgeCall, options.bridgeModes.length - 1)] ?? 'stable';
      bridgeCall += 1;
      const transport = spawnSshTransport(machine, {
        spawnFn: spawn,
        commandFactory: () => [process.execPath, FIXTURE, mode],
      });
      transport.onClose(() => {
        spawns.closed += 1;
      });
      return transport;
    },
  });
  managers.push(manager);
  return { manager, spawns };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-ensure-'));
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) manager.disconnectAll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('buildSshServeCommand (one-shot argv)', () => {
  it('builds serve --socket ~/.orchid/daemon.sock --detached via agentCommand', () => {
    pinMachine();
    const hostsPath = path.join(homeDir, 'machines', 'build-1', 'known_hosts');
    const argv = buildSshServeCommand(sshMachine(), hostsPath);
    expect(argv).toEqual([
      'ssh',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${hostsPath}`,
      '-o', 'ConnectTimeout=10',
      '-p', '2222',
      'deploy@build.example.com',
      '--',
      'orchid-agent',
      'serve',
      '--socket',
      REMOTE_DAEMON_SOCKET_PATH,
      '--detached',
    ]);
    expect(REMOTE_DAEMON_SOCKET_PATH).toBe('~/.orchid/daemon.sock');
  });

  it('splits a multi-token agentCommand into argv tokens', () => {
    const argv = buildSshServeCommand(
      { ...sshMachine(), agentCommand: '~/.local/bin/orchid-agent --verbose' },
      '/known/hosts',
    );
    expect(argv.slice(-6)).toEqual([
      '~/.local/bin/orchid-agent',
      '--verbose',
      'serve',
      '--socket',
      REMOTE_DAEMON_SOCKET_PATH,
      '--detached',
    ]);
  });
});

describe('spawnDaemonEnsure', () => {
  it('resolves true when the one-shot ssh command exits 0', async () => {
    const recorder = recordingSpawn(0);
    const ok = await spawnDaemonEnsure(sshMachine(), {
      spawnFn: recorder.spawnFn,
      knownHostsPath: '/known/hosts',
    });
    expect(ok).toBe(true);
    expect(recorder.argvs).toHaveLength(1);
    expect(recorder.argvs[0]?.slice(-3)).toEqual(['--socket', REMOTE_DAEMON_SOCKET_PATH, '--detached']);
  });

  it('resolves false when the one-shot ssh command fails', async () => {
    const recorder = recordingSpawn(255);
    await expect(spawnDaemonEnsure(sshMachine(), {
      spawnFn: recorder.spawnFn,
      knownHostsPath: '/known/hosts',
    })).resolves.toBe(false);
  });
});

describe('MachineConnectionManager daemon ensure', () => {
  it('runs one serve cycle on handshake timeout, then connects when the daemon answers', async () => {
    pinMachine();
    const recorder = recordingSpawn(0);
    const ensure = vi.fn(
      (machine: RemoteMachineRecord, hostsPath: string) =>
        spawnDaemonEnsure(machine, { spawnFn: recorder.spawnFn, knownHostsPath: hostsPath }),
    );
    // First bridge never answers (no daemon); after the ensure cycle the
    // freshly started daemon answers.
    const { manager, spawns } = makeManager({
      bridgeModes: ['silent', 'stable'],
      ensure,
      handshakeTimeoutMs: 150,
    });

    const status = await manager.connect(sshMachine());

    expect(status.state).toBe('connected');
    expect(manager.getStatus('build-1').state).toBe('connected');
    // Exactly one ensure spawn, with the documented serve args.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(recorder.argvs).toHaveLength(1);
    expect(recorder.argvs[0]?.slice(-4)).toEqual([
      'serve',
      '--socket',
      '~/.orchid/daemon.sock',
      '--detached',
    ]);
    // The timed-out transport was killed and replaced by the retry transport.
    expect(spawns.created).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawns.closed).toBe(1);
  });

  it('classifies agent-missing with the install hint when the ensure command fails', async () => {
    pinMachine();
    const recorder = recordingSpawn(255);
    const ensure = vi.fn(
      (machine: RemoteMachineRecord, hostsPath: string) =>
        spawnDaemonEnsure(machine, { spawnFn: recorder.spawnFn, knownHostsPath: hostsPath }),
    );
    const { manager, spawns } = makeManager({
      bridgeModes: ['silent'],
      ensure,
      handshakeTimeoutMs: 150,
    });

    await expect(manager.connect(sshMachine())).rejects.toThrow();

    const status = manager.getStatus('build-1');
    expect(status.state).toBe('lost');
    expect(status.error?.kind).toBe('agent-missing');
    expect(status.error?.hint).toContain('orchid-agent serve --socket');
    expect(ensure).toHaveBeenCalledTimes(1);
    // No retry transport when the ensure command itself failed.
    expect(spawns.created).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawns.closed).toBe(1);
  });

  it('wraps a still-silent retry as agent-missing, keeping real hello answers classified', async () => {
    pinMachine();
    const { manager } = makeManager({
      // The ensure succeeds but the daemon stays silent on the retry.
      bridgeModes: ['silent', 'silent'],
      ensure: async () => true,
      handshakeTimeoutMs: 150,
    });

    await expect(manager.connect(sshMachine())).rejects.toThrow();

    const status = manager.getStatus('build-1');
    expect(status.state).toBe('lost');
    expect(status.error?.kind).toBe('agent-missing');
    expect(status.error?.message).toContain('still did not answer');

    // A daemon that DOES answer with the wrong version keeps its own
    // classification — the daemon is running, ensure is not the problem.
    const mismatched = makeManager({
      bridgeModes: ['silent', 'wrong-version'],
      ensure: async () => true,
      handshakeTimeoutMs: 150,
    });
    await expect(mismatched.manager.connect(sshMachine())).rejects.toThrow();
    expect(mismatched.manager.getStatus('build-1').error?.kind).toBe('protocol-mismatch');
  });

  it('ensures at most once per connect cycle across backoff retries, re-arming on manual connect', async () => {
    pinMachine();
    const pending: Array<{ resolve: () => void }> = [];
    const sleep = (ms: number): Promise<void> => {
      void ms;
      return new Promise((resolve) => {
        pending.push({ resolve });
      });
    };
    // Poll-and-drain: parked sleeps resolve while the awaited condition
    // becomes true (the ensure-settle and backoff sleeps both park here).
    const drainUntil = async (test: () => boolean, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!test()) {
        if (Date.now() > deadline) throw new Error('drainUntil timed out');
        while (pending.length > 0) pending.shift()?.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const ensure = vi.fn(async () => true);

    const { manager, spawns } = makeManager({
      // Bridge 1 answers then dies (established loss → backoff); every later
      // bridge times out: the first timeout runs the ensure cycle, the
      // remaining backoff retries must not repeat it.
      bridgeModes: ['die-after', 'silent'],
      ensure,
      handshakeTimeoutMs: 150,
      sleep,
      backoff: { initialMs: 1000, maxAttempts: 3 },
    });

    // Initial attempt: the bridge answers (die-after fixture) so the machine
    // connects, then the transport dies → backoff reconnects, each timing out.
    let connectedResolve: (() => void) | null = null;
    const connectedOnce = new Promise<void>((resolve) => {
      connectedResolve = resolve;
    });
    const unsubscribe = manager.subscribe('build-1', (status) => {
      if (status.state === 'connected') connectedResolve?.();
    });
    await expect(manager.connect(sshMachine())).resolves.toMatchObject({ state: 'connected' });
    await connectedOnce;
    unsubscribe();
    // The first connect answered the handshake: no ensure ran yet.
    expect(ensure).toHaveBeenCalledTimes(0);
    expect(spawns.created).toBe(1);
    await drainUntil(() => manager.getStatus('build-1').state === 'lost');

    // Three backoff retries; the FIRST timeout runs the ensure cycle (its own
    // retry bridge also times out), the remaining retries never re-run it.
    // attempts increments before each retry's bridge spawns, so also wait for
    // the expected bridge count: 1 (die-after) + 2 (timeout + ensure retry) +
    // one per remaining backoff retry.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await drainUntil(
        () => manager.getStatus('build-1').reconnectAttempts >= attempt
          && spawns.created >= attempt + 2,
      );
    }
    await drainUntil(
      () => manager.getStatus('build-1').reconnectAttempts === 3
        && manager.getStatus('build-1').state === 'lost',
    );
    expect(manager.getStatus('build-1').reconnectAttempts).toBe(3);
    expect(manager.getStatus('build-1').state).toBe('lost');
    // One ensure across the whole reconnect cycle.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(spawns.created).toBe(5);

    // A fresh manual connect starts a new cycle and re-arms the budget.
    let reconnectRejected = false;
    const reconnectAttempt = manager.connect(sshMachine());
    void reconnectAttempt.catch(() => {
      reconnectRejected = true;
    });
    await drainUntil(() => reconnectRejected);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(spawns.created).toBe(7);
  }, 20_000);
});
