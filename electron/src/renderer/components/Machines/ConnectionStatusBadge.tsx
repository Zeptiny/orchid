import type { MachineConnectionStateView } from '../../../shared/types/ipc';

interface ConnectionStatusTone {
  readonly dot: string;
  readonly label: string;
}

const STATE_TONE: Record<MachineConnectionStateView, ConnectionStatusTone> = {
  connected: { dot: 'status-success', label: 'Connected' },
  connecting: { dot: 'status-warning', label: 'Connecting' },
  lost: { dot: 'status-error', label: 'Connection lost' },
  offline: { dot: 'status-neutral', label: 'Offline' },
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
 * switcher, the add-machine wizard, and the Machines settings tab.
 */
export function ConnectionStatusBadge({
  state,
  withLabel = true,
  className = '',
}: ConnectionStatusBadgeProps) {
  const tone = connectionStatusTone(state);
  return (
    <span
      className={`machine-status-badge inline-flex shrink-0 items-center gap-1.5 ${className}`.trim()}
      title={tone.label}
    >
      <span className={`status status-xs ${tone.dot}`} aria-hidden />
      {withLabel && <span className="text-xs text-base-content/70">{tone.label}</span>}
    </span>
  );
}
