/**
 * Remote-machine status strip above the transcript: either the reconnect alert
 * for a machine that is down, or the indicator for a live turn that survived a
 * reconnect gap. The two states are mutually exclusive.
 */
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { MachineLiveTurnIndicator } from '../Machines/MachineLiveTurnIndicator';
import type { MachineStatusEntry } from '../../../shared/types/ipc';

export interface MachineConnectionBannerProps {
  /** Label of the machine this window drives. */
  machineLabel: string;
  /** Status of the active remote machine, or null while on the local machine. */
  status: MachineStatusEntry | null;
  /** The remote dropped (or never came back) and work is unreachable. */
  disconnected: boolean;
  /** Epoch ms of a turn that started before the machine reconnected. */
  liveTurnStartedAt: number | null;
  /** A reconnect request from this banner is in flight. */
  reconnecting: boolean;
  onReconnect: () => void;
}

/** Whether the machine has stopped reporting at all (vs. never configured). */
function isConnectionLost(status: MachineStatusEntry | null): boolean {
  return status?.state === 'lost';
}

export function MachineConnectionBanner({
  machineLabel,
  status,
  disconnected,
  liveTurnStartedAt,
  reconnecting,
  onReconnect,
}: MachineConnectionBannerProps) {
  const showsReconnectAlert = disconnected && status != null;
  if (!showsReconnectAlert) {
    return (
      <MachineLiveTurnIndicator
        machineLabel={machineLabel}
        startedAt={liveTurnStartedAt}
      />
    );
  }
  const connectionLost = isConnectionLost(status);
  return (
    <Alert
      tone="warning"
      icon="alert"
      className="rounded-none border-x-0 border-t-0 py-2 text-sm"
      title={`${machineLabel} — ${connectionLost ? 'connection lost / reconnecting…' : 'disconnected'}`}
      action={
        <Button
          variant="primary"
          size="xs"
          onClick={onReconnect}
          loading={reconnecting || status.state === 'connecting'}
        >
          Reconnect
        </Button>
      }
    >
      {status.error?.hint
        ?? 'Work keeps running on the remote machine; reconnect to resume the session view.'}
    </Alert>
  );
}
