import { memo, useEffect, useMemo, useState } from 'react';
import type {
  SessionActivity,
  SessionSummary,
} from '../../shared/types/ipc-boundary';
import {
  sessionActivityPresentation,
  sessionActivitySummaryPresentation,
} from '../utils/session-activity-presentation';
import { truncatePathDisplay } from '../utils/session-workspace';
import { IconButton } from './ui/IconButton';
import { StatusBadge } from './ui/StatusBadge';

interface SessionActivitySectionProps {
  activities: readonly SessionActivity[];
  sessions: readonly SessionSummary[];
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

function elapsedLabel(startedAt: number | null, now: number): string | null {
  if (startedAt == null) return null;
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Global list of work that continues even when another session is selected. */
export const SessionActivitySection = memo(function SessionActivitySection({
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
  const summary = sessionActivitySummaryPresentation(activities);

  if (activities.length === 0) return null;

  return (
    <section className="session-activity border-b border-base-300" aria-label="Session activity">
      <div className="session-activity-heading">
        <span>Activity</span>
        <StatusBadge tone={summary?.tone ?? 'neutral'} size="xs">
          {activities.length}
        </StatusBadge>
      </div>
      <div className="session-activity-list" role="list">
        {activities.map((activity) => {
          const session = sessionsById.get(activity.sessionId);
          const projectPath = session?.cwd ?? activity.cwd;
          const elapsed = elapsedLabel(activity.startedAt, now);
          const activityStatus = sessionActivityPresentation(activity);
          return (
            <div key={activity.sessionId} className="session-activity-row orchid-list-item-enter" role="listitem">
              <button
                className="session-activity-select"
                type="button"
                onClick={() => onSelect(activity.sessionId)}
                title={projectPath ?? session?.name ?? 'Session activity'}
              >
                <span
                  className={`status status-xs ${activityStatus.statusClass}`}
                  aria-hidden
                />
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
                  <span>{activityStatus.label}</span>
                </span>
              </button>
              {activity.canCancel && (
                <IconButton
                  label={`Stop ${session?.name ?? 'session'}`}
                  icon="square"
                  iconSize={11}
                  variant="ghost"
                  size="xs"
                  className="btn-square session-activity-stop"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStop(activity.sessionId);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
});
