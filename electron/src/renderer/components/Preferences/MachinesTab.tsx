/**
 * MachinesTab — connection list management (issue #112, plan unit U8).
 *
 * Self-contained like TrustedProjectsTab: reads through the shared useMachines
 * store, adds machines through the add-machine wizard, edits every connection
 * field inline (label/host/port/user/agent command/auth method + password),
 * and connects/disconnects/deletes remote machines. The local machine row is
 * informational and immutable.
 */
import { useCallback, useState } from 'react';
import type { MachineAuthMethod, MachineRecord, RemoteMachineRecord } from '../../../shared/types/machine';
import type { UseMachinesReturn } from '../../hooks/useMachines';
import { useMachines } from '../../hooks/useMachines';
import type { Notify } from '../../utils/notify';
import { AddMachineWizard } from '../Machines/AddMachineWizard';
import { ConnectionStatusBadge } from '../Machines/ConnectionStatusBadge';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { StateMessage } from '../ui/StateMessage';
import { TextInput } from '../ui/TextInput';

interface EditDraft {
  readonly label: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly agentCommand: string;
  readonly authMethod: MachineAuthMethod;
  /** Write-only: non-empty replaces the stored password; empty keeps it. */
  readonly password: string;
}

function emptyDraft(machine: RemoteMachineRecord): EditDraft {
  return {
    label: machine.label,
    host: machine.host,
    port: String(machine.port),
    user: machine.user,
    agentCommand: machine.agentCommand,
    authMethod: machine.authMethod,
    password: '',
  };
}

function remoteHostSummary(machine: RemoteMachineRecord): string {
  const user = machine.user !== '' ? `${machine.user}@` : '';
  const port = machine.port !== 22 ? `:${machine.port}` : '';
  const auth = machine.authMethod === 'password' ? ' · password' : '';
  return `${user}${machine.host}${port}${auth}`;
}

function MachinesTabRow({
  machine,
  machines,
  onNotify,
}: {
  machine: MachineRecord;
  machines: UseMachinesReturn;
  onNotify: Notify;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => ({
    label: '',
    host: '',
    port: '22',
    user: '',
    agentCommand: 'orchid-agent',
    authMethod: 'key',
    password: '',
  }));
  const [busy, setBusy] = useState(false);
  const status = machines.statusOf(machine.id);
  const authStatus = machines.authStatusOf(machine.id);

  const startEdit = useCallback(() => {
    if (machine.kind !== 'ssh') return;
    setDraft(emptyDraft(machine));
    setEditing(true);
  }, [machine]);

  const saveEdit = useCallback(async () => {
    if (machine.kind !== 'ssh') return;
    setBusy(true);
    try {
      const port = Number.parseInt(draft.port, 10);
      await machines.updateMachine({
        id: machine.id,
        patch: {
          label: draft.label.trim() || machine.label,
          host: draft.host.trim() || machine.host,
          port: Number.isFinite(port) && port > 0 ? port : machine.port,
          user: draft.user.trim(),
          agentCommand: draft.agentCommand.trim() || machine.agentCommand,
          authMethod: draft.authMethod,
          ...(draft.authMethod === 'password' && draft.password !== ''
            ? { password: draft.password }
            : {}),
        },
      });
      setEditing(false);
      onNotify(`Updated machine ${draft.label.trim() || machine.label}.`, 'info');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to update the machine.', 'error');
    } finally {
      setBusy(false);
    }
  }, [machine, machines, draft, onNotify]);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    const result = await machines.connect(machine.id);
    if (result.status === 'error') {
      onNotify(result.error.hint || result.error.message, 'warning');
    }
    setBusy(false);
  }, [machine.id, machines, onNotify]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    await machines.disconnect(machine.id);
    setBusy(false);
  }, [machine.id, machines]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await machines.deleteMachine(machine.id);
      onNotify(`Removed machine ${machine.label}.`, 'info');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to remove the machine.', 'error');
    } finally {
      setBusy(false);
    }
  }, [machine.id, machine.label, machines, onNotify]);

  if (machine.kind === 'local') {
    return (
      <li className="flex min-w-0 items-center gap-3 rounded-md border border-base-300 bg-base-100/60 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{machine.label}</span>
          <span className="text-xs text-base-content/60">Built-in · always connected</span>
        </div>
        <ConnectionStatusBadge state="connected" />
      </li>
    );
  }

  const passwordMissing = machine.authMethod === 'password' && !authStatus.hasStoredPassword;

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-md border border-base-300 bg-base-100/60 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={machine.label}>{machine.label}</span>
          <span className="mono truncate text-xs text-base-content/60" title={remoteHostSummary(machine)}>
            {remoteHostSummary(machine)}
            {machine.authMethod === 'password' && (
              <span className="text-base-content/50">
                {authStatus.hasStoredPassword ? ' · password saved' : ' · no password saved'}
              </span>
            )}
          </span>
        </div>
        <ConnectionStatusBadge state={status.state} />
        <div className="flex shrink-0 items-center gap-2">
          {status.state === 'connected' ? (
            <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()} disabled={busy}>
              Disconnect
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleConnect()}
              disabled={busy || passwordMissing}
              loading={busy}
              title={passwordMissing ? 'Save the SSH password before connecting' : undefined}
            >
              Connect
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={startEdit} disabled={busy || editing}>
            Edit
          </Button>
          <Button variant="error" size="sm" onClick={() => void handleDelete()} disabled={busy}>
            Delete
          </Button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 border-t border-base-300 pt-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/70">Label</span>
              <TextInput
                size="sm"
                value={draft.label}
                aria-label="Machine label"
                onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/70">Host</span>
              <TextInput
                size="sm"
                value={draft.host}
                aria-label="Machine host"
                onChange={(event) => setDraft((prev) => ({ ...prev, host: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/70">Port</span>
              <TextInput
                size="sm"
                inputMode="numeric"
                value={draft.port}
                aria-label="Machine port"
                onChange={(event) => setDraft((prev) => ({ ...prev, port: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/70">User</span>
              <TextInput
                size="sm"
                value={draft.user}
                aria-label="Machine user"
                onChange={(event) => setDraft((prev) => ({ ...prev, user: event.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-base-content/70">Agent command</span>
            <TextInput
              size="sm"
              className="mono"
              value={draft.agentCommand}
              aria-label="Agent command"
              onChange={(event) => setDraft((prev) => ({ ...prev, agentCommand: event.target.value }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/70">Authentication</span>
              <Select
                size="sm"
                value={draft.authMethod}
                aria-label="Authentication method"
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    authMethod: event.target.value === 'password' ? 'password' : 'key',
                  }))
                }
              >
                <option value="key">SSH key / agent</option>
                <option value="password">Password</option>
              </Select>
            </label>
            {draft.authMethod === 'password' && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-base-content/70">
                  Password{' '}
                  {authStatus.hasStoredPassword
                    ? '(saved — leave empty to keep)'
                    : '(required to connect)'}
                </span>
                <TextInput
                  size="sm"
                  type="password"
                  autoComplete="new-password"
                  placeholder={authStatus.hasStoredPassword ? '••••••••' : ''}
                  value={draft.password}
                  aria-label="Machine SSH password"
                  onChange={(event) => setDraft((prev) => ({ ...prev, password: event.target.value }))}
                />
              </label>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="primary" size="sm" onClick={() => void saveEdit()} disabled={busy} loading={busy}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {status.error && !editing && (
        <p className="m-0 text-xs text-base-content/70">
          <span className="mono">{status.error.kind}</span>
          {status.error.hint !== '' ? ` — ${status.error.hint}` : ` — ${status.error.message}`}
        </p>
      )}
      {passwordMissing && !editing && (
        <p className="m-0 text-xs text-base-content/70">
          Password auth is selected but no password is saved — Edit the machine to add one.
        </p>
      )}
    </li>
  );
}

export function MachinesTab({ onNotify, machines: machinesProp }: {
  readonly onNotify: Notify;
  /** Machines state; defaults to the shared useMachines store. */
  readonly machines?: UseMachinesReturn;
}) {
  const store = useMachines();
  const machines = machinesProp ?? store;
  const actionError = machines.actionError;
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <div className="config-form flex flex-col gap-4">
      {actionError && (
        <Alert
          tone="error"
          icon="alert"
          action={
            <Button variant="ghost" size="sm" type="button" onClick={machines.clearActionError}>
              Dismiss
            </Button>
          }
        >
          {actionError.hint !== '' ? `${actionError.message} ${actionError.hint}` : actionError.message}
        </Alert>
      )}

      <Panel as="section" aria-labelledby="machines-title" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title={<h2 id="machines-title" className="text-sm font-semibold">Machines</h2>}
          description="SSH remotes running orchid-agent. Each machine owns its own sessions, indexes, and provider connections."
          actions={
            <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
              Add machine…
            </Button>
          }
        />

        {machines.isLoading ? (
          <StateMessage kind="loading" title="Loading machines…" />
        ) : (
          <ul className="m-0 flex flex-col gap-2 p-0">
            {machines.machines.map((machine) => (
              <MachinesTabRow key={machine.id} machine={machine} machines={machines} onNotify={onNotify} />
            ))}
          </ul>
        )}
      </Panel>

      <AddMachineWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={(machineId) => {
          const label = machines.machines.find((machine) => machine.id === machineId)?.label ?? machineId;
          onNotify(`Added machine ${label}.`, 'info');
        }}
      />
    </div>
  );
}
