import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { SessionListState } from '../hooks/useSession';
import { Icon } from './Icon';

interface LeftSidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  sessionListState: SessionListState;
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: (id: string) => void;
  onRefreshSessions: () => void;
  onOpenSettings: () => void;
}

/**
 * Left sessions rail — paddings match mock 012:
 * header 7px 10px / body 8px / footer 6px 8px
 * session rows min-height 30px, pad 5px 7px, gap 1px
 * No daisyUI menu (avoids horizontal dividers between items).
 */
export function LeftSidebar({
  isCollapsed,
  onToggle,
  sessionListState,
  activeSessionId,
  onSessionSelect,
  onSessionCreate,
  onSessionDelete,
  onRefreshSessions,
  onOpenSettings,
}: LeftSidebarProps) {
  const [query, setQuery] = useState('');

  const sessions =
    sessionListState.status === 'ready' || sessionListState.status === 'partial'
      ? sessionListState.sessions
      : [];

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) => {
      return (
        session.name.toLowerCase().includes(q) ||
        (session.model ?? '').toLowerCase().includes(q)
      );
    });
  }, [query, sessions]);

  const groupedSessions = useMemo(() => groupSessions(filteredSessions), [filteredSessions]);

  if (isCollapsed) {
    return (
      <aside className="left-panel left-panel-collapsed">
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onToggle}
          title="Expand sidebar"
          type="button"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onSessionCreate}
          title="New session"
          type="button"
        >
          <Icon name="plus" size={16} />
        </button>
        <div className="left-panel-collapsed-spacer" />
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onOpenSettings}
          title="Settings"
          type="button"
        >
          <Icon name="settings" size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="left-panel">
      <div className="panel-header">
        <h1 className="title truncate">Orchid</h1>
        <div className="panel-header-actions">
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onSessionCreate}
            title="New session"
            type="button"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onToggle}
            title="Collapse sidebar"
            type="button"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
        </div>
      </div>

      <div className="panel-body">
        <div className="session-search">
          <Icon name="search" size={12} className="session-search-icon" />
          <input
            className="input input-sm session-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions..."
            type="text"
          />
        </div>
        <SessionList
          activeSessionId={activeSessionId}
          groupedSessions={groupedSessions}
          onDelete={onSessionDelete}
          onRefresh={onRefreshSessions}
          onSelect={onSessionSelect}
          state={sessionListState}
        />
      </div>

      <div className="panel-footer">
        <button
          className="btn btn-ghost session-settings-btn"
          onClick={onOpenSettings}
          type="button"
        >
          <Icon name="settings" size={18} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

interface SessionListProps {
  state: SessionListState;
  groupedSessions: Array<{ label: string; sessions: SessionSummary[] }>;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function SessionList({
  state,
  groupedSessions,
  activeSessionId,
  onSelect,
  onDelete,
  onRefresh,
}: SessionListProps) {
  if (state.status === 'loading') {
    return (
      <div className="session-list-state">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="session-list-error">
        <div>{state.error}</div>
        <button className="btn btn-error btn-xs" onClick={onRefresh} type="button">
          Retry
        </button>
      </div>
    );
  }

  if (state.status === 'empty' || groupedSessions.length === 0) {
    return (
      <div className="session-list">
        <div className="session-group-title">Sessions</div>
        <div className="session-list-empty">No sessions yet</div>
      </div>
    );
  }

  return (
    <div className="session-list">
      {groupedSessions.map((group) => (
        <div key={group.label} className="session-group">
          <div className="session-group-title">{group.label}</div>
          {group.sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div key={session.id} className="session-row group">
                <button
                  type="button"
                  className={`session-item ${isActive ? 'session-item-active' : ''}`}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="session-item-name">{session.name}</span>
                  {isActive && <span className="badge badge-xs badge-success">active</span>}
                </button>
                <button
                  className="btn btn-ghost btn-xs btn-square session-item-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(session.id);
                  }}
                  title="Delete session"
                  type="button"
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function groupSessions(
  sessions: SessionSummary[],
): Array<{ label: string; sessions: SessionSummary[] }> {
  const now = new Date();
  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const groups = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const updated = startOfDay(new Date(session.updatedAt)).getTime();
    let label = 'Earlier';
    if (updated >= today) label = 'Today';
    else if (updated >= yesterday) label = 'Yesterday';
    else if (updated >= today - 7 * 24 * 60 * 60 * 1000) label = 'This week';
    const bucket = groups.get(label) ?? [];
    bucket.push(session);
    groups.set(label, bucket);
  }

  return ['Today', 'Yesterday', 'This week', 'Earlier']
    .map((label) => ({ label, sessions: groups.get(label) ?? [] }))
    .filter((group) => group.sessions.length > 0);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
