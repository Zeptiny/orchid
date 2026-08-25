// @vitest-environment jsdom
/**
 * AddMachineWizard component tests (issue #112, unit U8).
 *
 * The TOFU fingerprint-confirmation ceremony, driven through the injectable
 * `actions` seam: form → keyscan → explicit fingerprint confirmation →
 * connect, with the typed failure surfaces (scan error, agent-missing
 * connect error) and the reopen reset.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddMachineWizard, type AddMachineActions } from '../../src/renderer/components/Machines/AddMachineWizard';
import { __machinesCacheTest } from '../../src/renderer/hooks/useMachines';
import type {
  MachineConfirmHostKeyResult,
  MachineConnectResult,
  MachineScanHostKeyResult,
  MachineSetActiveResult,
  MachineStatusEntry,
} from '../../src/shared/types/ipc';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const T0 = '2026-08-23T00:00:00.000Z';

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

const FINGERPRINTS = [
  { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:ed25519fake' },
  { algorithm: 'ssh-rsa', fingerprintSha256: 'SHA256:rsafake' },
];

function statusEntry(machineId: string): MachineStatusEntry {
  return { machineId, state: 'connected', error: null, reconnectAttempts: 0 };
}

/**
 * Minimal actions seam: the wizard only needs the five machine actions, and
 * every one is a spy the test tailors via `overrides`.
 */
function fakeActions(overrides: Partial<AddMachineActions> = {}): AddMachineActions {
  return {
    createMachine: vi.fn(async () => BUILD),
    scanHostKey: vi.fn(async (): Promise<MachineScanHostKeyResult> => ({
      status: 'scanned',
      fingerprints: FINGERPRINTS,
    })),
    confirmHostKey: vi.fn(async (): Promise<MachineConfirmHostKeyResult> => ({
      status: 'pinned',
      fingerprints: FINGERPRINTS,
    })),
    connect: vi.fn(async (): Promise<MachineConnectResult> => ({
      status: 'ok',
      machine: statusEntry('build-1'),
    })),
    switchTo: vi.fn(async (): Promise<MachineSetActiveResult> => ({
      status: 'ok',
      machineId: 'build-1',
    })),
    ...overrides,
  };
}

function installWindowOrchid(): void {
  (window as unknown as { orchid: unknown }).orchid = {
    machines: {
      list: vi.fn(async () => ({ machines: [BUILD] })),
      getStatus: vi.fn(async () => ({ machines: [statusEntry('build-1')] })),
      getActive: vi.fn(async () => ({ machineId: 'local' })),
      setActive: vi.fn(async () => ({ status: 'ok', machineId: 'local' })),
      connect: vi.fn(async () => ({ status: 'ok', machine: statusEntry('build-1') })),
      disconnect: vi.fn(async () => ({ status: 'ok' })),
      create: vi.fn(async () => BUILD),
      update: vi.fn(async () => BUILD),
      delete: vi.fn(async () => ({ status: 'deleted', machine: BUILD })),
      scanHostKey: vi.fn(async () => ({ status: 'scanned', fingerprints: FINGERPRINTS })),
      confirmHostKey: vi.fn(async () => ({ status: 'pinned', fingerprints: FINGERPRINTS })),
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

/** Fill the form step and submit it, landing the wizard on the scan step. */
function submitForm(): void {
  fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'Build server' } });
  fireEvent.change(screen.getByLabelText(/Host/), { target: { value: 'build.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('AddMachineWizard', () => {
  it('walks form → scan → confirm → connect and renders the scanned fingerprints', async () => {
    const actions = fakeActions();
    const onClose = vi.fn();
    const onComplete = vi.fn();
    render(
      <AddMachineWizard open onClose={onClose} onComplete={onComplete} actions={actions} />,
    );

    submitForm();

    await waitFor(() => expect(actions.createMachine).toHaveBeenCalledOnce());
    expect(actions.createMachine).toHaveBeenCalledWith({
      label: 'Build server',
      host: 'build.example.com',
      port: 22,
      user: '',
      agentCommand: 'orchid-agent',
    });

    // The scan step runs the keyscan on entry and lists what it returned.
    await waitFor(() => expect(actions.scanHostKey).toHaveBeenCalledWith('build-1'));
    await waitFor(() => expect(screen.getByText('SHA256:ed25519fake')).toBeTruthy());
    expect(screen.getByText('SHA256:rsafake')).toBeTruthy();
    expect(screen.getByText('ssh-ed25519')).toBeTruthy();
    expect(screen.getByText('ssh-rsa')).toBeTruthy();

    // Trust pins exactly that scan, then the wizard connects and completes.
    fireEvent.click(screen.getByRole('button', { name: 'Trust and continue' }));
    await waitFor(() => expect(actions.confirmHostKey).toHaveBeenCalledWith('build-1'));
    await waitFor(() => expect(actions.connect).toHaveBeenCalledWith('build-1'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('build-1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the scan failure with its hint, retry enabled, and trust disabled', async () => {
    const actions = fakeActions({
      scanHostKey: vi.fn(async (): Promise<MachineScanHostKeyResult> => ({
        status: 'error',
        error: {
          kind: 'unreachable',
          message: 'Could not reach the remote host over SSH.',
          hint: 'Check the host and port.',
        },
      })),
    });
    render(<AddMachineWizard open onClose={vi.fn()} actions={actions} />);

    submitForm();

    await waitFor(() => expect(screen.getByText('Could not reach the remote host over SSH.')).toBeTruthy());
    expect(screen.getByText('Check the host and port.')).toBeTruthy();

    const retry = screen.getByRole('button', { name: 'Retry scan' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    const trust = screen.getByRole('button', { name: 'Trust and continue' }) as HTMLButtonElement;
    expect(trust.disabled).toBe(true);

    fireEvent.click(retry);
    expect(actions.scanHostKey).toHaveBeenCalledTimes(2);
  });

  it('surfaces the agent-missing connect error with the install hint and retry', async () => {
    const actions = fakeActions({
      connect: vi.fn(async (): Promise<MachineConnectResult> => ({
        status: 'error',
        error: {
          kind: 'agent-missing',
          message: 'The remote orchid-agent daemon is not running.',
          hint: 'Install orchid-agent on the remote and check the machine agent command.',
        },
      })),
    });
    const onClose = vi.fn();
    render(<AddMachineWizard open onClose={onClose} actions={actions} />);

    submitForm();
    await waitFor(() => expect(screen.getByText('SHA256:ed25519fake')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Trust and continue' }));

    await waitFor(() => expect(screen.getByText('The remote orchid-agent daemon is not running.')).toBeTruthy());
    expect(
      screen.getByText('Install orchid-agent on the remote and check the machine agent command.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry connect' })).toBeTruthy();
    // A failed connect never closes the wizard or reports completion.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets to a blank form when reopened after a failure', async () => {
    const actions = fakeActions({
      scanHostKey: vi.fn(async (): Promise<MachineScanHostKeyResult> => ({
        status: 'error',
        error: {
          kind: 'unreachable',
          message: 'Could not reach the remote host over SSH.',
          hint: 'Check the host and port.',
        },
      })),
    });
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <AddMachineWizard open={open} onClose={onClose} actions={actions} />
    );
    const { rerender } = render(view(true));

    submitForm();
    await waitFor(() => expect(screen.getByText('Could not reach the remote host over SSH.')).toBeTruthy());

    rerender(view(false));
    rerender(view(true));

    const host = screen.getByLabelText(/Host/) as HTMLInputElement;
    expect(host.value).toBe('');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Could not reach the remote host over SSH.')).toBeNull();
  });
});
