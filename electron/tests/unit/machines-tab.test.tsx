// @vitest-environment jsdom
/**
 * MachinesTab component tests — list rows, the add-machine entry point, and
 * the inline editor covering label/host/port/user/agent command plus the
 * password-auth fields (stored-password presence, write-only password patch).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachinesTab } from '../../src/renderer/components/Preferences/MachinesTab';
import { __machinesCacheTest, type UseMachinesReturn } from '../../src/renderer/hooks/useMachines';
import type { MachineRecord, MachineStatusEntry, MachineAuthStatusEntry } from '../../src/shared/types/ipc';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const T0 = '2026-08-23T00:00:00.000Z';

const LOCAL: MachineRecord = { id: 'local', label: 'This PC (studio)', kind: 'local' };
const KEY_MACHINE: RemoteMachineRecord = {
  id: 'build-1',
  label: 'Build server',
  kind: 'ssh',
  host: 'build.example.com',
  port: 22,
  user: '',
  agentCommand: 'orchid-agent',
  authMethod: 'key',
  created_at: T0,
  updated_at: T0,
};
const PASSWORD_MACHINE: RemoteMachineRecord = {
  ...KEY_MACHINE,
  id: 'pw-1',
  label: 'Password host',
  host: 'pw.example.com',
  authMethod: 'password',
};

function statusEntry(machineId: string): MachineStatusEntry {
  return { machineId, state: 'offline', error: null, reconnectAttempts: 0 };
}

function authEntry(machineId: string, authMethod: 'key' | 'password', hasStoredPassword: boolean): MachineAuthStatusEntry {
  return { machineId, authMethod, hasStoredPassword };
}

function fakeMachines(overrides: {
  machines?: readonly MachineRecord[];
  authStatuses?: ReadonlyMap<string, MachineAuthStatusEntry>;
  updateMachine?: UseMachinesReturn['updateMachine'];
} = {}): UseMachinesReturn {
  const machines = overrides.machines ?? [LOCAL, KEY_MACHINE, PASSWORD_MACHINE];
  const statuses = new Map(machines.map((machine) => [machine.id, statusEntry(machine.id)]));
  const authStatuses =
    overrides.authStatuses ??
    new Map<string, MachineAuthStatusEntry>([
      ['local', authEntry('local', 'key', false)],
      ['build-1', authEntry('build-1', 'key', false)],
      ['pw-1', authEntry('pw-1', 'password', true)],
    ]);
  return {
    state: {
      status: 'ready',
      machines,
      statuses,
      authStatuses,
      activeMachineId: 'local',
      error: null,
      actionError: null,
    },
    machines,
    statuses,
    statusOf: (machineId) => statuses.get(machineId) ?? statusEntry(machineId),
    authStatusOf: (machineId) => authStatuses.get(machineId) ?? authEntry(machineId, 'key', false),
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
    switchTo: vi.fn(async () => ({ status: 'ok', machineId: 'local' })),
    connect: vi.fn(async () => ({ status: 'ok', machine: statusEntry('build-1') })),
    disconnect: vi.fn(async () => ({ status: 'ok' })),
    createMachine: vi.fn(async () => KEY_MACHINE),
    updateMachine: overrides.updateMachine ?? vi.fn(async () => KEY_MACHINE),
    deleteMachine: vi.fn(async () => ({ status: 'deleted', machine: KEY_MACHINE })),
    scanHostKey: vi.fn(async () => ({ status: 'scanned', fingerprints: [] })),
    confirmHostKey: vi.fn(async () => ({ status: 'pinned', fingerprints: [] })),
  };
}

function installWindowOrchid(): void {
  (window as unknown as { orchid: unknown }).orchid = {
    machines: {
      list: vi.fn(async () => ({ machines: [LOCAL] })),
      getStatus: vi.fn(async () => ({ machines: [statusEntry('local')] })),
      getActive: vi.fn(async () => ({ machineId: 'local' })),
      setActive: vi.fn(async () => ({ status: 'ok', machineId: 'local' })),
      connect: vi.fn(async () => ({ status: 'ok', machine: statusEntry('build-1') })),
      disconnect: vi.fn(async () => ({ status: 'ok' })),
      create: vi.fn(async () => KEY_MACHINE),
      update: vi.fn(async () => KEY_MACHINE),
      delete: vi.fn(async () => ({ status: 'deleted', machine: KEY_MACHINE })),
      scanHostKey: vi.fn(async () => ({ status: 'scanned', fingerprints: [] })),
      confirmHostKey: vi.fn(async () => ({ status: 'pinned', fingerprints: [] })),
      authStatus: vi.fn(async () => ({ machines: [authEntry('local', 'key', false)] })),
      onChanged: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
  };
}

const onNotify = vi.fn();

beforeEach(() => {
  installWindowOrchid();
  __machinesCacheTest.reset();
  onNotify.mockClear();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { orchid?: unknown }).orchid;
});

describe('MachinesTab', () => {
  it('lists machines with auth summaries and stored-password state', () => {
    render(<MachinesTab onNotify={onNotify} machines={fakeMachines()} />);

    expect(screen.getByText('This PC (studio)')).toBeTruthy();
    expect(screen.getByText(/Built-in · always connected/)).toBeTruthy();
    expect(screen.getByText('Build server')).toBeTruthy();
    expect(screen.getByText(/password saved/)).toBeTruthy();
  });

  it('flags a password machine with no stored password and blocks connect', () => {
    const machines = fakeMachines({
      authStatuses: new Map<string, MachineAuthStatusEntry>([
        ['local', authEntry('local', 'key', false)],
        ['build-1', authEntry('build-1', 'key', false)],
        ['pw-1', authEntry('pw-1', 'password', false)],
      ]),
    });
    render(<MachinesTab onNotify={onNotify} machines={machines} />);

    expect(screen.getByText(/no password saved/)).toBeTruthy();
    expect(screen.getByText(/no password is saved — Edit the machine/)).toBeTruthy();
    const connect = screen.getByTitle('Save the SSH password before connecting') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
  });

  it('opens the add-machine wizard from the header action', async () => {
    render(<MachinesTab onNotify={onNotify} machines={fakeMachines()} />);

    expect(screen.queryByText('Add remote machine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add machine…/ }));
    await waitFor(() => expect(screen.getByText('Add remote machine')).toBeTruthy());
  });

  it('edits every connection field and sends the password only when set', async () => {
    const updateMachine = vi.fn(async () => PASSWORD_MACHINE);
    render(
      <MachinesTab onNotify={onNotify} machines={fakeMachines({ updateMachine: updateMachine as UseMachinesReturn['updateMachine'] })} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);

    fireEvent.change(screen.getByLabelText('Machine host'), { target: { value: 'new.example.com' } });
    fireEvent.change(screen.getByLabelText('Machine port'), { target: { value: '2222' } });
    fireEvent.change(screen.getByLabelText('Machine user'), { target: { value: 'deploy' } });
    // A stored password exists: leaving the field blank keeps it.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMachine).toHaveBeenCalledOnce());
    expect(updateMachine).toHaveBeenCalledWith({
      id: 'pw-1',
      patch: expect.not.objectContaining({ password: expect.anything() }),
    });
    expect(updateMachine.mock.calls[0]![0].patch).toMatchObject({
      host: 'new.example.com',
      port: 2222,
      user: 'deploy',
      agentCommand: 'orchid-agent',
      authMethod: 'password',
    });
  });

  it('sends the password patch when a new password is entered', async () => {
    const updateMachine = vi.fn(async () => PASSWORD_MACHINE);
    render(
      <MachinesTab onNotify={onNotify} machines={fakeMachines({ updateMachine: updateMachine as UseMachinesReturn['updateMachine'] })} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    fireEvent.change(screen.getByLabelText('Machine SSH password'), { target: { value: 'hunter2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMachine).toHaveBeenCalledOnce());
    expect(updateMachine.mock.calls[0]![0].patch).toMatchObject({
      authMethod: 'password',
      password: 'hunter2!',
    });
  });

  it('reveals the password field only for password auth', () => {
    render(<MachinesTab onNotify={onNotify} machines={fakeMachines()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(screen.queryByLabelText('Machine SSH password')).toBeNull();

    fireEvent.change(screen.getByLabelText('Authentication method'), { target: { value: 'password' } });
    expect(screen.getByLabelText('Machine SSH password')).toBeTruthy();
    expect(screen.getByText(/\(required to connect\)/)).toBeTruthy();
  });
});
