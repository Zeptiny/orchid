// @vitest-environment jsdom
/**
 * useMachines hook tests (issue #112, unit U8).
 *
 * Mirrors the useSessionTabs/useSubagents harness style: renderHook against a
 * faked `window.orchid.machines` API, driving list/status/active state
 * transitions, the add-machine wizard action sequence (create → scan →
 * confirm → connect), and typed error surfacing.
 *
 * U10 additions: the useMachineResync reconnect trigger (lost→connected fires
 * the machine-scoped refresh exactly once; switches/mounts never fire) and the
 * MachineLiveTurnIndicator rendering (streaming → present, idle → absent).
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMachines, __machinesCacheTest } from '../../src/renderer/hooks/useMachines';
import {
  isMachineReconnectTransition,
  useMachineResync,
} from '../../src/renderer/hooks/useMachineResync';
import {
  MachineLiveTurnIndicator,
} from '../../src/renderer/components/Machines/MachineLiveTurnIndicator';
import type {
  MachineListResult,
  MachineStatusResult,
} from '../../src/shared/types/ipc';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const T0 = '2026-08-23T00:00:00.000Z';

function remote(id: string, label: string): RemoteMachineRecord {
  return {
    id,
    label,
    kind: 'ssh',
    host: `${id}.example.com`,
    port: 22,
    user: '',
    agentCommand: 'orchid-agent',
    created_at: T0,
    updated_at: T0,
  };
}

const LOCAL = { id: 'local', label: 'This PC (studio)', kind: 'local' as const };
const BUILD = remote('build-1', 'Build server');

function statusResult(
  entries: Array<{ machineId: string; state: 'offline' | 'connecting' | 'connected' | 'lost' }>,
): MachineStatusResult {
  return {
    machines: entries.map((entry) => ({
      machineId: entry.machineId,
      state: entry.state,
      error: null,
      reconnectAttempts: 0,
    })),
  };
}

let changedListener: ((event: MachineListResult) => void) | null = null;
let statusListener: ((event: MachineStatusResult) => void) | null = null;

type MachinesApi = NonNullable<NonNullable<typeof window.orchid>['machines']>;

function fakeMachinesApi(): { api: MachinesApi; calls: string[] } {
  const calls: string[] = [];
  const api = {
    list: vi.fn(async (): MachineListResult => {
      calls.push('list');
      return { machines: [LOCAL, BUILD] };
    }),
    getStatus: vi.fn(async (): Promise<MachineStatusResult> => {
      calls.push('getStatus');
      return statusResult([
        { machineId: 'local', state: 'connected' },
        { machineId: 'build-1', state: 'offline' },
      ]);
    }),
    getActive: vi.fn(async () => {
      calls.push('getActive');
      return { machineId: 'local' };
    }),
    setActive: vi.fn(async () => {
      calls.push('setActive');
      return { status: 'ok' as const, machineId: 'build-1' };
    }),
    connect: vi.fn(async () => {
      calls.push('connect');
      return {
        status: 'ok' as const,
        machine: { machineId: 'build-1', state: 'connected' as const, error: null, reconnectAttempts: 0 },
      };
    }),
    disconnect: vi.fn(async () => {
      calls.push('disconnect');
      return { status: 'ok' as const };
    }),
    create: vi.fn(async () => {
      calls.push('create');
      return BUILD;
    }),
    update: vi.fn(async () => {
      calls.push('update');
      return BUILD;
    }),
    delete: vi.fn(async () => {
      calls.push('delete');
      return { status: 'deleted' as const, machine: BUILD };
    }),
    scanHostKey: vi.fn(async () => {
      calls.push('scanHostKey');
      return {
        status: 'scanned' as const,
        fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
      };
    }),
    confirmHostKey: vi.fn(async () => {
      calls.push('confirmHostKey');
      return {
        status: 'pinned' as const,
        fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
      };
    }),
    onChanged: vi.fn((callback: (event: MachineListResult) => void) => {
      changedListener = callback;
      return () => {
        changedListener = null;
      };
    }),
    onStatusChanged: vi.fn((callback: (event: MachineStatusResult) => void) => {
      statusListener = callback;
      return () => {
        statusListener = null;
      };
    }),
  };
  return { api: api as unknown as MachinesApi, calls };
}

beforeEach(() => {
  changedListener = null;
  statusListener = null;
  __machinesCacheTest.reset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { orchid?: unknown }).orchid;
});

function installApi(): { calls: string[] } {
  const { api, calls } = fakeMachinesApi();
  (window as unknown as { orchid: unknown }).orchid = { machines: api };
  return { calls };
}

describe('useMachines bootstrap and live state', () => {
  it('loads machines, statuses, and the window active machine once', async () => {
    installApi();

    const { result } = renderHook(() => useMachines());

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.machines.map((machine) => machine.id)).toEqual(['local', 'build-1']);
    expect(result.current.statusOf('local').state).toBe('connected');
    expect(result.current.statusOf('build-1').state).toBe('offline');
    expect(result.current.activeMachineId).toBe('local');
    expect(result.current.isActiveMachineLocal).toBe(true);
    expect(result.current.activeMachineLabel).toBe('This PC (studio)');
  });

  it('falls back to a safe default status for unknown machines', async () => {
    installApi();

    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    expect(result.current.statusOf('ghost').state).toBe('offline');
  });

  it('applies status broadcasts and registry changes live', async () => {
    installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      statusListener?.(statusResult([
        { machineId: 'local', state: 'connected' },
        { machineId: 'build-1', state: 'connecting' },
      ]));
    });
    expect(result.current.statusOf('build-1').state).toBe('connecting');

    const renamed = { ...BUILD, label: 'Build server 2' };
    act(() => {
      changedListener?.({ machines: [LOCAL, renamed] });
    });
    expect(result.current.machines[1]?.label).toBe('Build server 2');
    expect(result.current.activeMachineId).toBe('local');
  });

  it('revalidates the active machine when the registry drops it', async () => {
    const { calls } = installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    calls.length = 0;
    act(() => {
      changedListener?.({ machines: [LOCAL] });
    });
    await waitFor(() => expect(calls).toContain('getActive'));
  });
});

describe('useMachines actions', () => {
  it('switches machines and keeps state on typed failure', async () => {
    installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    await act(async () => {
      await result.current.switchTo('build-1');
    });
    expect(result.current.activeMachineId).toBe('build-1');
    expect(result.current.isActiveMachineLocal).toBe(false);

    const api = (window as unknown as { orchid: { machines: MachinesApi } }).orchid.machines;
    api.setActive = vi.fn(async () => ({
      status: 'error' as const,
      error: { kind: 'not-connected', message: 'Machine is offline', hint: 'Connect first.' },
    }));
    await act(async () => {
      await result.current.switchTo('build-1');
    });
    // The previous switch survives; the typed failure is surfaced.
    expect(result.current.activeMachineId).toBe('build-1');
    expect(result.current.actionError).toMatchObject({ kind: 'not-connected' });
    expect(result.current.actionError?.hint).toBe('Connect first.');
  });

  it('runs the add-machine wizard sequence: create → scan → confirm → connect', async () => {
    const { calls } = installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    calls.length = 0;

    let machine: RemoteMachineRecord | null = null;
    await act(async () => {
      machine = await result.current.createMachine({ label: 'Build server', host: 'build.example.com' });
    });
    expect(machine?.id).toBe('build-1');

    let scan: Awaited<ReturnType<typeof result.current.scanHostKey>> | null = null;
    await act(async () => {
      scan = await result.current.scanHostKey('build-1');
    });
    expect(scan).toMatchObject({ status: 'scanned' });

    let confirm: Awaited<ReturnType<typeof result.current.confirmHostKey>> | null = null;
    await act(async () => {
      confirm = await result.current.confirmHostKey('build-1');
    });
    expect(confirm).toMatchObject({ status: 'pinned' });

    let connect: Awaited<ReturnType<typeof result.current.connect>> | null = null;
    await act(async () => {
      connect = await result.current.connect('build-1');
    });
    expect(connect).toMatchObject({ status: 'ok' });

    expect(calls).toEqual(['create', 'scanHostKey', 'confirmHostKey', 'connect']);
    expect(result.current.actionError).toBeNull();
  });

  it('surfaces connect failures with the typed error payload', async () => {
    installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const api = (window as unknown as { orchid: { machines: MachinesApi } }).orchid.machines;
    api.connect = vi.fn(async () => ({
      status: 'error' as const,
      error: {
        kind: 'agent-missing',
        message: 'No host.hello response.',
        hint: 'Install orchid-agent on the remote.',
      },
    }));

    let outcome: Awaited<ReturnType<typeof result.current.connect>> | null = null;
    await act(async () => {
      outcome = await result.current.connect('build-1');
    });
    expect(outcome?.status).toBe('error');
    expect(result.current.actionError).toMatchObject({
      kind: 'agent-missing',
      hint: 'Install orchid-agent on the remote.',
    });
    expect(result.current.actionError?.message).toBe('No host.hello response.');
  });

  it('wraps thrown IPC failures as typed unknown errors', async () => {
    installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const api = (window as unknown as { orchid: { machines: MachinesApi } }).orchid.machines;
    api.scanHostKey = vi.fn(async () => {
      throw new Error('IPC exploded');
    });

    let outcome: Awaited<ReturnType<typeof result.current.scanHostKey>> | null = null;
    await act(async () => {
      outcome = await result.current.scanHostKey('build-1');
    });
    expect(outcome).toMatchObject({ status: 'error', error: { kind: 'unknown' } });
    expect(result.current.actionError?.message).toBe('IPC exploded');
  });

  it('clears the surfaced action error on demand', async () => {
    installApi();
    const { result } = renderHook(() => useMachines());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const api = (window as unknown as { orchid: { machines: MachinesApi } }).orchid.machines;
    api.connect = vi.fn(async () => ({
      status: 'error' as const,
      error: { kind: 'agent-missing', message: 'nope', hint: '' },
    }));
    await act(async () => {
      await result.current.connect('build-1');
    });
    expect(result.current.actionError).not.toBeNull();

    act(() => {
      result.current.clearActionError();
    });
    expect(result.current.actionError).toBeNull();
  });
});

// ── U10: reconnect resync trigger + live-turn indicator ──────────────────────

describe('useMachineResync (U10 lost→connected refresh trigger)', () => {
  type State = 'offline' | 'connecting' | 'connected' | 'lost';

  function renderResync(initial: { machineId: string; state: State }) {
    const onReconnect = vi.fn();
    const utils = renderHook(
      ({ machineId, state }) => useMachineResync({ machineId, state, onReconnect }),
      { initialProps: initial },
    );
    return { ...utils, onReconnect };
  }

  it('detects reconnect transitions and only those', () => {
    expect(isMachineReconnectTransition('lost', 'connected')).toBe(true);
    expect(isMachineReconnectTransition('offline', 'connected')).toBe(true);
    expect(isMachineReconnectTransition('connecting', 'connected')).toBe(true);
    expect(isMachineReconnectTransition('connected', 'connected')).toBe(false);
    expect(isMachineReconnectTransition('lost', 'connecting')).toBe(false);
    expect(isMachineReconnectTransition('connected', 'lost')).toBe(false);
  });

  it('fires once on lost→connected and exposes the reconnect timestamp', async () => {
    const { rerender, result, onReconnect } = renderResync({ machineId: 'build-1', state: 'lost' });
    expect(onReconnect).not.toHaveBeenCalled();
    expect(result.current.reconnectedAt).toBeNull();

    rerender({ machineId: 'build-1', state: 'connecting' });
    rerender({ machineId: 'build-1', state: 'connected' });

    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(result.current.reconnectedAt).not.toBeNull();

    // Staying connected never re-fires.
    rerender({ machineId: 'build-1', state: 'connected' });
    rerender({ machineId: 'build-1', state: 'connected' });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('never fires on mount or on a machine switch', async () => {
    const { rerender, onReconnect } = renderResync({ machineId: 'build-1', state: 'connected' });
    expect(onReconnect).not.toHaveBeenCalled();

    // Switching to another already-connected machine is the switch path's job.
    rerender({ machineId: 'zeta', state: 'connected' });
    expect(onReconnect).not.toHaveBeenCalled();

    // After the switch is recorded, a genuine drop and recovery of the NEW
    // machine fires exactly once.
    rerender({ machineId: 'zeta', state: 'lost' });
    rerender({ machineId: 'zeta', state: 'connected' });
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
  });
});

describe('MachineLiveTurnIndicator (U10 live-turn UX)', () => {
  it('renders "running since HH:MM" when a resumed turn is streaming', () => {
    const startedAt = new Date('2026-08-23T14:05:00').getTime();
    render(createElement(MachineLiveTurnIndicator, { machineLabel: 'Build server', startedAt }));
    expect(screen.getByText(/Build server kept working while disconnected/)).toBeTruthy();
    expect(screen.getByText(/running \(since/)).toBeTruthy();
  });

  it('renders nothing when no turn was resumed across the reconnect', () => {
    const { container } = render(createElement(MachineLiveTurnIndicator, { machineLabel: 'Build server', startedAt: null }));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
