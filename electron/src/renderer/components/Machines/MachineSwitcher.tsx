/**
 * MachineSwitcher — the compact connection-list control in the chat header
 * (issue #112, plan unit U8).
 *
 * A chip like the workspace chip: current machine label + connection dot, a
 * dropdown with every machine (local pinned first), per-row connect for
 * disconnected remotes, and the add-machine entry point.
 */
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MachineRecord } from '../../../shared/types/machine';
import type { UseMachinesReturn } from '../../hooks/useMachines';
import { useMachines } from '../../hooks/useMachines';
import { Icon } from '../Icon';
import { Button } from '../ui/Button';
import { DropdownMenu } from '../ui/DropdownMenu';
import { AddMachineWizard } from './AddMachineWizard';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';

export interface MachineSwitcherProps {
  /** Machines state; defaults to the shared useMachines store. */
  readonly machines?: UseMachinesReturn;
  /** Called after this window switched to another machine. */
  readonly onMachineSwitched?: () => void;
}

function machineHostLabel(machine: MachineRecord): ReactNode {
  if (machine.kind === 'local') return 'This machine';
  const user = machine.user !== '' ? `${machine.user}@` : '';
  const port = machine.port !== 22 ? `:${machine.port}` : '';
  return `${user}${machine.host}${port}`;
}

export const MachineSwitcher = memo(function MachineSwitcher({
  machines: machinesProp,
  onMachineSwitched,
}: MachineSwitcherProps) {
  const store = useMachines();
  const machines = machinesProp ?? store;
  const [open, setOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  const activeStatus = machines.statusOf(machines.activeMachineId);

  const handleSelect = useCallback((machine: MachineRecord) => {
    if (machine.kind !== 'local' && machines.statusOf(machine.id).state !== 'connected') {
      return;
    }
    if (machine.id === machines.activeMachineId) {
      close();
      return;
    }
    void machines.switchTo(machine.id).then((result) => {
      if (result.status === 'ok') onMachineSwitched?.();
    });
    close();
  }, [machines, machines.activeMachineId, close, onMachineSwitched]);

  const handleConnect = useCallback((machine: MachineRecord) => {
    void machines.connect(machine.id);
  }, [machines]);

  const handleWizardComplete = useCallback((machineId: string) => {
    void machines.switchTo(machineId).then((result) => {
      if (result.status === 'ok') onMachineSwitched?.();
    });
  }, [machines, onMachineSwitched]);

  return (
    <>
      <DropdownMenu
        label="Machines"
        triggerLabel={`Machine: ${machines.activeMachineLabel} (${activeStatus.state})`}
        placement="bottom-end"
        align="end"
        open={open}
        onOpenChange={setOpen}
        triggerClassName="btn btn-ghost btn-xs orchid-machine-switcher-trigger min-w-0 gap-1.5 px-1.5"
        menuClassName="mt-1 w-72"
        trigger={
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            title={`${machines.activeMachineLabel} — ${activeStatus.state}`}
          >
            <Icon name="cpu" size={12} className="shrink-0 opacity-60" />
            <span className="max-w-xs truncate text-xs font-medium">
              {machines.activeMachineLabel}
            </span>
            <ConnectionStatusBadge state={activeStatus.state} withLabel={false} />
            <Icon
              name="chevronDown"
              size={12}
              className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </span>
        }
      >
        <ul className="m-0 flex flex-col gap-0.5 p-1" role="presentation">
          {machines.machines.map((machine) => {
            const status = machines.statusOf(machine.id);
            const isSelected = machine.id === machines.activeMachineId;
            const selectable = machine.kind === 'local' || status.state === 'connected';
            return (
              <li key={machine.id} role="presentation">
                <div
                  className={`searchable-picker-option flex items-center gap-2 ${isSelected ? 'is-selected' : ''}`}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={
                      selectable
                        ? `Switch to ${machine.label}`
                        : `Connect ${machine.label} before switching`
                    }
                    title={
                      selectable
                        ? `Switch to ${machine.label}`
                        : `Connect ${machine.label} before switching`
                    }
                    disabled={!selectable}
                    onClick={() => handleSelect(machine)}
                  >
                    <ConnectionStatusBadge state={status.state} withLabel={false} />
                    <span className="searchable-picker-option-copy">
                      <span className="searchable-picker-option-name truncate">
                        {machine.label}
                      </span>
                      <span className="searchable-picker-option-desc truncate">
                        {machineHostLabel(machine)}
                      </span>
                    </span>
                  </button>
                  {machine.kind === 'ssh' && status.state !== 'connected' && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      loading={status.state === 'connecting'}
                      onClick={() => handleConnect(machine)}
                      title={`Connect ${machine.label}`}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-base-300 p-1">
          <button
            type="button"
            role="menuitem"
            className="searchable-picker-option w-full"
            onClick={() => {
              close();
              setWizardOpen(true);
            }}
          >
            <Icon name="plus" size={14} className="shrink-0 opacity-70" />
            <span className="searchable-picker-option-name">Add machine…</span>
          </button>
        </div>
      </DropdownMenu>

      <AddMachineWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={handleWizardComplete}
      />
    </>
  );
});
