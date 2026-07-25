import type { SessionActivity } from '../../shared/types/ipc-boundary';

export type SessionActivityDisplayState =
  | 'needs_attention'
  | 'working'
  | 'waiting'
  | 'completed_unread'
  | 'idle_background'
  | 'idle';

export type SessionActivityTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'error';

export interface SessionActivityPresentation {
  readonly state: SessionActivityDisplayState;
  readonly label: string;
  readonly tone: SessionActivityTone;
  readonly statusClass: string;
  readonly visible: boolean;
}

const STATUS_CLASS: Record<SessionActivityTone, string> = {
  neutral: 'status-neutral',
  info: 'status-info',
  success: 'status-success',
  warning: 'status-warning',
  error: 'status-error',
};

const SUMMARY_PRIORITY: Record<SessionActivityDisplayState, number> = {
  needs_attention: 0,
  working: 1,
  waiting: 2,
  completed_unread: 3,
  idle_background: 4,
  idle: 5,
};

function presentation(
  state: SessionActivityDisplayState,
  label: string,
  tone: SessionActivityTone,
  visible = true,
): SessionActivityPresentation {
  return {
    state,
    label,
    tone,
    statusClass: STATUS_CLASS[tone],
    visible,
  };
}

/** Derive one user-facing status from the activity's orthogonal runtime fields. */
export function sessionActivityPresentation(
  activity: SessionActivity,
): SessionActivityPresentation {
  if (activity.state === 'needs_attention') {
    return presentation('needs_attention', 'Needs attention', 'error');
  }
  if (activity.state === 'working') {
    return presentation('working', 'Working', 'warning');
  }
  if (activity.state === 'waiting') {
    return presentation('waiting', 'Waiting', 'info');
  }
  if (activity.unread) {
    return presentation('completed_unread', 'Completed · unread', 'success');
  }
  if (activity.backgroundProcessCount > 0) {
    const suffix = activity.backgroundProcessCount === 1 ? 'process' : 'processes';
    return presentation(
      'idle_background',
      `Idle · ${activity.backgroundProcessCount} ${suffix}`,
      'neutral',
    );
  }
  return presentation('idle', 'Idle', 'neutral', false);
}

/** Highest-priority visible status for compact aggregate activity affordances. */
export function sessionActivitySummaryPresentation(
  activities: readonly SessionActivity[],
): (Pick<SessionActivityPresentation, 'tone' | 'statusClass'> & {
  readonly label: string;
}) | null {
  const visible = activities
    .map(sessionActivityPresentation)
    .filter((item) => item.visible)
    .sort((a, b) => SUMMARY_PRIORITY[a.state] - SUMMARY_PRIORITY[b.state]);
  const highest = visible[0];
  if (!highest) return null;
  return {
    label: `${visible.length} session${visible.length === 1 ? '' : 's'} with activity`,
    tone: highest.tone,
    statusClass: highest.statusClass,
  };
}
