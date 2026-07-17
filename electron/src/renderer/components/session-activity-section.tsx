import { useEffect, useMemo, useState } from 'react';
import type {
  SessionActivity,
  SessionSummary,
} from '../../shared/types/ipc-boundary';
import { truncatePathDisplay } from '../utils/session-workspace';
import { Icon } from './Icon';
import { StatusBadge } from './ui/StatusBadge';

interface SessionActivitySectionProps {
  activities: readonly SessionActivity[];
  sessions: readonly SessionSummary[];
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

const statusClass: Record<SessionActivity['state'], string> = {
  idle: 'status-neutral',
  working: 'status-warning',
  waiting: 'status-info',
  needs_attention: 'status-error',
};

function activityLabel(activity: SessionActivity): string {
  if (activity.state === 'needs_attention') return 'Needs attention';
  if (activity.state === 'working') return 'Working';
  if (activity.state === 'waiting') return 'Waiting';
  if (activity.unread) return 'Completed · unread';
  if (activity.backgroundProcessCount > 0) {
    return `Idle · ${activity.backgroundProcessCount} process${
      activity.backgroundProcessCount === 1 ? '' : 'es'
    }`;
  }
  return 'Idle';
}

function elapsedLabel(startedAt: number | null, now: number): string | null {
  if (startedAt == null) return null;
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Global list of work that continues even when another session is selected. */
export function SessionActivitySection({
  activities,
  sessions,
  onSelect,
  onStop,
}: SessionActivitySectionProps) {
  const [now, setNow] = useState(() => Date.now());
  const hasLiveElapsed = activities.some(
    (activity) =>
      activity.startedAt != null &&
      (activity.state === 'working' || activity.state === 'waiting'),
  );

  useEffect(() => {
    if (!hasLiveElapsed) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasLiveElapsed]);

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  if (activities.length === 0) return null;

  return (
    <section className="session-activity border-b border-base-300" aria-label="Session activity">
      <div className="session-activity-heading">
        <span>Activity</span>
        <StatusBadge tone="warning" size="xs">{activities.length}</StatusBadge>
      </div>
      <div className="session-activity-list" role="list">
        {activities.map((activity) => {
          const session = sessionsById.get(activity.sessionId);
          const projectPath = session?.cwd ?? activity.cwd;
          const elapsed = elapsedLabel(activity.startedAt, now);
          return (
            <div key={activity.sessionId} className="session-activity-row" role="listitem">
              <button
                className="session-activity-select"
                type="button"
                onClick={() => onSelect(activity.sessionId)}
                title={projectPath ?? session?.name ?? 'Session activity'}
              >
                <span className={`status status-xs ${statusClass[activity.state]}`} aria-hidden />
                <span className="session-activity-copy min-w-0">
                  <span className="session-activity-name truncate">
                    {session?.name ?? 'New session'}
                  </span>
                  <span className="session-activity-meta truncate">
                    {projectPath ? truncatePathDisplay(projectPath, 26) : 'Unknown project'}
                    {activity.detail ? ` · ${activity.detail}` : ''}
                  </span>
                </span>
                <span className="session-activity-status">
                  {elapsed && <span>{elapsed}</span>}
                  <span>{activityLabel(activity)}</span>
                </span>
              </button>
              {activity.canCancel && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square session-activity-stop"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStop(activity.sessionId);
                  }}
                  title={`Stop ${session?.name ?? 'session'}`}
                  aria-label={`Stop ${session?.name ?? 'session'}`}
                >
                  <Icon name="square" size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
