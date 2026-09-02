/**
 * MachineLiveTurnIndicator — communicates a live turn resumed across a remote
 * machine reconnect (U10, R6).
 *
 * When the resync/open snapshot shows the session still streaming on the
 * remote host, the banner area reports that work continued while the window
 * was disconnected, anchored to the turn's own start time from the snapshot
 * (never a view-mount clock). Rendered only for turns that started BEFORE the
 * reconnect; a locally started turn already has the footer's Running state.
 */
import { Alert } from '../ui/Alert';

export interface MachineLiveTurnIndicatorProps {
  /** Label of the machine the resumed turn is running on. */
  readonly machineLabel: string;
  /** Epoch ms the resumed turn started (from the snapshot's startedAt). */
  readonly startedAt: number | null;
}

/** `HH:MM` (24h, locale-aware) for a start-time anchor. */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function MachineLiveTurnIndicator({
  machineLabel,
  startedAt,
}: MachineLiveTurnIndicatorProps) {
  if (startedAt == null) return null;
  return (
    <Alert
      tone="info"
      icon="clock"
      className="rounded-none border-x-0 border-t-0 py-1.5 text-sm"
      role="status"
    >
      {machineLabel} kept working while disconnected — agent still running (since{' '}
      {formatClockTime(startedAt)}).
    </Alert>
  );
}
