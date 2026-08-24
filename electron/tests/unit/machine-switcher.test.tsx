// @vitest-environment jsdom
/**
 * MachineSwitcher component tests (issue #112, unit U8).
 *
 * Interaction contract: renders the current machine with its status dot, lists
 * machines local-first with disconnected remotes unswitchable but connectable,
 * and opens the add-machine wizard from the menu.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineSwitcher } from '../../src/renderer/components/Machines/MachineSwitcher';
import { useMachines, __machinesCacheTest, type UseMachinesReturn } from '../../src/renderer/hooks/useMachines';
import type { MachineRecord, MachineStatusEntry } from '../../src/shared/types/ipc';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const T0 = '2026-08-23T00:00:00.000Z';

const LOCAL: MachineRecord = { id: 'local', label: 'This PC (studio)', kind: 'local' };
const BUILD: RemoteMachineRecord = {
  id: 'build-1',
  label: 'Build server',
  kind: 'ssh',
  host: 'build.example.com',
  port: 22,
  user: '',
  agentCommand: 'orchid-agent',
  created_at: T0,
  updated_at: T0,
};
const ZETA: RemoteMachineRecord = {
  id: 'zeta',
  label: 'Workstation',
  kind: 'ssh',
  host: 'zeta.example.com',
  port: 2222,
  user: 'deploy',
  agentCommand: 'orchid-agent',
  created_at: T0,
  updated_at: T0,
};

function statusEntry(
  machineId: string,
  state: MachineStatusEntry['state'],
): MachineStatusEntry {
  return { machineId, state, error: null, reconnectAttempts: 0 };
}

function fakeMachines(overrides: Partial<UseMachinesReturn> = {}): UseMachinesReturn {
  const machines: readonly MachineRecord[] = [LOCAL, BUILD, ZETA];
  const statuses = new Map<string, MachineStatusEntry>([
    ['local', statusEntry('local', 'connected')],
    ['build-1', statusEntry('build-1', 'offline')],
    ['zeta', statusEntry('zeta', 'connected')],
  ]);
  return {
    state: {
      status: 'ready',
      machines,
      statuses,
      activeMachineId: 'local',
      error: null,
      actionError: null,
    },
    machines,
    statuses,
    statusOf: (machineId: string) => statuses.get(machineId) ?? statusEntry(machineId, 'offline'),
    activeMachineId: 'local',
    activeMachine: LOCAL,
    activeMachineLabel: 'This PC (studio)',
    isActiveMachineLocal: true,
    isLoading: false,
    error: null,
    actionError: null,
    refresh: vi.fn(async () => {}),
    refreshActive: vi.fn(async () => {}),
    clearActionError: vi.fn(),
    switchTo: vi.fn(async () => ({ status: 'ok', machineId: 'zeta' })),
    connect: vi.fn(async () => ({
      status: 'ok',
      machine: statusEntry('build-1', 'connected'),
    })),
    disconnect: vi.fn(async () => ({ status: 'ok' })),
    createMachine: vi.fn(async () => BUILD),
    updateMachine: vi.fn(async () => BUILD),
    deleteMachine: vi.fn(async () => ({ status: 'deleted', machine: BUILD })),
    scanHostKey: vi.fn(async () => ({
      status: 'scanned',
      fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
    })),
    confirmHostKey: vi.fn(async () => ({
      status: 'pinned',
      fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
    })),
    ...overrides,
  } as UseMachinesReturn;
}

function installWindowOrchid(): void {
  (window as unknown as { orchid: unknown }).orchid = {
    machines: {
      list: vi.fn(async () => ({ machines: [LOCAL, BUILD, ZETA] })),
      getStatus: vi.fn(async () => ({
        machines: [
          statusEntry('local', 'connected'),
          statusEntry('build-1', 'offline'),
          statusEntry('zeta', 'connected'),
        ],
      })),
      getActive: vi.fn(async () => ({ machineId: 'local' })),
      setActive: vi.fn(async () => ({ status: 'ok', machineId: 'local' })),
      connect: vi.fn(async () => ({ status: 'ok', machine: statusEntry('build-1', 'connected') })),
      disconnect: vi.fn(async () => ({ status: 'ok' })),
      create: vi.fn(async () => BUILD),
      update: vi.fn(async () => BUILD),
      delete: vi.fn(async () => ({ status: 'deleted', machine: BUILD })),
      scanHostKey: vi.fn(async () => ({
        status: 'scanned',
        fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
      })),
      confirmHostKey: vi.fn(async () => ({
        status: 'pinned',
        fingerprints: [{ algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:test' }],
      })),
      onChanged: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
  };
}

beforeEach(() => {
  installWindowOrchid();
  __machinesCacheTest.reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { orchid?: unknown }).orchid;
});

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: /machine: this pc/i }));
}

describe('MachineSwitcher', () => {
  it('renders the active machine label with the connected status dot', () => {
    const machines = fakeMachines();
    render(<MachineSwitcher machines={machines} />);

    expect(screen.getByText('This PC (studio)')).toBeTruthy();
    const trigger = screen.getByRole('button', { name: /machine: this pc/i });
    expect(trigger.querySelector('.status-success')).toBeTruthy();
  });

  it('opens the dropdown with machines local-first and per-state dots', () => {
    render(<MachineSwitcher machines={fakeMachines()} />);
    openMenu();

    const menu = screen.getByRole('menu', { name: 'Machines' });
    expect(menu.querySelector('.status-success')).toBeTruthy();
    expect(menu.querySelector('.status-neutral')).toBeTruthy();

    // Local pinned first, remotes after it in registry order.
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.getAttribute('aria-label')).toBe('Switch to This PC (studio)');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('This PC (studio)'),
      expect.stringContaining('Build server'),
      expect.stringContaining('Workstation'),
      expect.stringContaining('Add machine'),
    ]);
  });

  it('disables switching to a disconnected remote but offers connect', () => {
    const machines = fakeMachines();
    render(<MachineSwitcher machines={machines} />);
    openMenu();

    const offline = screen.getByRole('menuitem', {
      name: /Connect Build server before switching/,
    });
    expect((offline as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTitle('Connect Build server'));
    expect(machines.connect).toHaveBeenCalledWith('build-1');
    expect(machines.switchTo).not.toHaveBeenCalled();
  });

  it('switches the window to a connected remote on row click', () => {
    const machines = fakeMachines();
    render(<MachineSwitcher machines={machines} />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /Switch to Workstation/ }));
    expect(machines.switchTo).toHaveBeenCalledWith('zeta');
    // The menu closes after a selection.
    expect(screen.queryByRole('menu', { name: 'Machines' })).toBeNull();
  });

  it('shows the connecting state on the connect action while a remote connects', () => {
    const machines = fakeMachines({
      statusOf: (machineId: string) =>
        machineId === 'build-1' ? statusEntry('build-1', 'connecting') : statusEntry(machineId, 'connected'),
    });
    render(<MachineSwitcher machines={machines} />);
    openMenu();

    const connectButton = screen.getByTitle('Connect Build server') as HTMLButtonElement;
    expect(connectButton.querySelector('.loading-spinner')).toBeTruthy();
    expect(connectButton.getAttribute('aria-busy')).toBe('true');
  });

  it('opens the add-machine wizard from the menu entry point', async () => {
    render(<MachineSwitcher machines={fakeMachines()} />);
    openMenu();

    expect(screen.queryByText('Add remote machine')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Add machine/ }));
    await waitFor(() => expect(screen.getByText('Add remote machine')).toBeTruthy());
    // The wizard starts on the form step with the host field present.
    expect(screen.getByLabelText(/Host/)).toBeTruthy();
  });
});
