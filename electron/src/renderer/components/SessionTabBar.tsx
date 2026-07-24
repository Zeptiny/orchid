import { memo, useEffect, useMemo, useRef } from 'react';
import type { SessionActivity, SessionSummary } from '../../shared/types/ipc-boundary';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { SessionNameEditor } from './SessionNameEditor';

export interface SessionTabBarProps {
  openSessionIds: readonly string[];
  focusedSessionId: string | null;
  sessions: readonly SessionSummary[];
  activities: readonly SessionActivity[];
  showDraft: boolean;
  draftLabel: string;
  draftProjectName: string | null;
  onSelect: (sessionId: string) => void;
  onSelectDraft: () => void;
  onClose: (sessionId: string) => void;
  onCloseDraft: () => void;
  onRename?: (sessionId: string, name: string) => void | Promise<void>;
}

const statusClass: Record<SessionActivity['state'], string> = {
  idle: '',
  working: 'status-warning',
  waiting: 'status-info',
  needs_attention: 'status-error',
};

function projectBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export const SessionTabBar = memo(function SessionTabBar({
  openSessionIds,
  focusedSessionId,
  sessions,
  activities,
  showDraft,
  draftLabel,
  draftProjectName,
  onSelect,
  onSelectDraft,
  onClose,
  onCloseDraft,
  onRename,
}: SessionTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionsById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );
  const activityById = useMemo(
    () => new Map(activities.map((a) => [a.sessionId, a])),
    [activities],
  );

  const multiProject = useMemo(() => {
    const names = new Set<string>();
    for (const id of openSessionIds) {
      const name = projectBasename(sessionsById.get(id)?.cwd);
      if (name) names.add(name);
    }
    if (showDraft && draftProjectName) names.add(draftProjectName);
    return names.size > 1;
  }, [openSessionIds, sessionsById, showDraft, draftProjectName]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>('[data-tab-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusedSessionId, showDraft, openSessionIds]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (e.deltaY === 0 || root.scrollWidth <= root.clientWidth) return;
      e.preventDefault();
      root.scrollLeft += e.deltaX || e.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      className="session-tab-bar border-b border-base-300 bg-base-200/55"
      role="tablist"
      aria-label="Open sessions"
    >
      <div className="session-tab-bar-scroll" ref={scrollRef}>
        {openSessionIds.map((id) => {
          const session = sessionsById.get(id);
          const activity = activityById.get(id);
          const active = !showDraft && focusedSessionId === id;
          const project = projectBasename(session?.cwd);
          const title = session?.name ?? id.slice(0, 8);
          const showDot =
            activity &&
            (activity.state !== 'idle' ||
              activity.unread ||
              activity.backgroundProcessCount > 0);
          const dotClass = activity
            ? statusClass[activity.state] || (activity.unread ? 'status-warning' : 'status-neutral')
            : '';

          return (
            <div
              key={id}
              className={`session-tab ${active ? 'session-tab-active' : ''}`}
              role="tab"
              aria-selected={active}
              id={`session-tab-${id}`}
              data-tab-active={active ? 'true' : 'false'}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(id);
                }
              }}
            >
              <div
                className="session-tab-select"
                role="button"
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(id)}
                title={
                  multiProject && project
                    ? `${project} / ${title}`
                    : title
                }
              >
                {showDot ? (
                  <span className={`status status-xs ${dotClass}`} aria-hidden />
                ) : null}
                {multiProject && project ? (
                  <span className="session-tab-project truncate" aria-hidden>
                    {project}
                    <span className="session-tab-project-sep"> / </span>
                  </span>
                ) : null}
                {onRename ? (
                  <SessionNameEditor
                    name={title}
                    className="session-tab-label truncate"
                    title={`${title} (double-click or F2 to rename)`}
                    onBeginEdit={() => onSelect(id)}
                    onRename={(next) => onRename(id, next)}
                  />
                ) : (
                  <span className="session-tab-label truncate">{title}</span>
                )}
              </div>
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                className="session-tab-close"
                aria-label={`Close ${title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
              >
                <Icon name="x" size={12} />
              </Button>
            </div>
          );
        })}

        {showDraft ? (
          <div
            className="session-tab session-tab-active session-tab-draft"
            role="tab"
            aria-selected
            id="session-tab-draft"
            data-tab-active="true"
          >
            <button
              type="button"
              className="session-tab-select"
              onClick={onSelectDraft}
              title={draftLabel}
            >
              <span className="session-tab-label truncate">
                {multiProject && draftProjectName
                  ? `${draftProjectName} / ${draftLabel}`
                  : draftLabel}
              </span>
            </button>
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              className="session-tab-close"
              aria-label="Close draft"
              onClick={(e) => {
                e.stopPropagation();
                onCloseDraft();
              }}
            >
              <Icon name="x" size={12} />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
