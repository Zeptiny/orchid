import type { MachineConnectionStateView } from '../../../shared/types/ipc';
import { StatusBadge, type StatusBadgeTone } from '../ui/StatusBadge';

interface ConnectionStatusTone {
  readonly tone: StatusBadgeTone;
  readonly label: string;
}

const STATE_TONE: Record<MachineConnectionStateView, ConnectionStatusTone> = {
  connected: { tone: 'success', label: 'Connected' },
  connecting: { tone: 'warning', label: 'Connecting' },
  lost: { tone: 'error', label: 'Connection lost' },
  offline: { tone: 'neutral', label: 'Offline' },
};

export function connectionStatusTone(state: MachineConnectionStateView): ConnectionStatusTone {
  return STATE_TONE[state];
}

export interface ConnectionStatusBadgeProps {
  readonly state: MachineConnectionStateView;
  /** Whether to render the text label beside the dot (default true). */
  readonly withLabel?: boolean;
  readonly className?: string;
}

/**
 * Status dot + label for one machine's connection state; shared by the machine
 * switcher, the add-machine wizard, and the Machines settings tab. Built on
 * the ui/ StatusBadge primitive (dot-only mode keeps the label for screen
 * readers).
 */
export function ConnectionStatusBadge({
  state,
  withLabel = true,
  className = '',
}: ConnectionStatusBadgeProps) {
  const tone = connectionStatusTone(state);
  return (
    <StatusBadge
      tone={tone.tone}
      size="xs"
      withDot
      title={tone.label}
      className={`machine-status-badge ${className}`.trim()}
    >
      {withLabel ? tone.label : <span className="sr-only">{tone.label}</span>}
    </StatusBadge>
  );
}
