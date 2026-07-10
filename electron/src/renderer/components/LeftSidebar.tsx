import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { WorkspaceInfo } from '../../shared/types/ipc';
import type { SessionListState } from '../hooks/useSession';
import {
  buildPrimarySessions,
  groupSessionsByDate,
  groupSessionsByProject,
  truncatePathDisplay,
} from '../utils/session-workspace';
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
  /** Current workspace (draft → session → sticky → unbound). */
  workspace?: WorkspaceInfo | null;
  /** Open folder picker (binds workspace + sticky default). */
  onPickProjectDir?: () => void;
}

/**
 * Left sessions rail — paddings match mock 012:
 * header 7px 10px / body 8px / footer 6px 8px
 * session rows min-height 30px, pad 5px 7px, gap 1px
 * No daisyUI menu (avoids horizontal dividers between items).
 *
 * U6: defaults to current-workspace sessions; other projects expand;
 * search is global; workspace chip is always visible.
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
  workspace = null,
  onPickProjectDir,
}: LeftSidebarProps) {
  const [query, setQuery] = useState('');
  const [showOtherProjects, setShowOtherProjects] = useState(false);

  const sessions =
    sessionListState.status === 'ready' || sessionListState.status === 'partial'
      ? sessionListState.sessions
      : [];

  const currentWorkspace =
    workspace?.status === 'valid' ? workspace.cwd : null;
  // Only treat as unbound once workspace is known (null = still loading).
  const isUnbound =
    workspace != null &&
    (workspace.status === 'unbound' ||
      workspace.status === 'missing' ||
      workspace.cwd == null);

  const {
    primary,
    other,
    otherCount,
    isSearching,
    otherIds,
  } = useMemo(
    () =>
      buildPrimarySessions({
        sessions,
        currentWorkspace,
        query,
        activeSessionId,
      }),
    [sessions, currentWorkspace, query, activeSessionId],
  );

  const groupedPrimary = useMemo(
    () => groupSessionsByDate(primary),
    [primary],
  );

  const otherProjectGroups = useMemo(
    () => groupSessionsByProject(other),
    [other],
  );

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
        {onPickProjectDir && (
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onPickProjectDir}
            title={
              currentWorkspace
                ? `Workspace: ${currentWorkspace}`
                : 'Open project folder'
            }
            type="button"
          >
            <Icon name="folder" size={14} />
          </button>
        )}
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
        <WorkspaceChip
          workspace={workspace}
          isUnbound={isUnbound}
          onPickProjectDir={onPickProjectDir}
        />

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

        {isUnbound && sessions.length === 0 ? (
          <UnboundEmptyState onPickProjectDir={onPickProjectDir} />
        ) : (
          <SessionList
            state={sessionListState}
            groupedSessions={groupedPrimary}
            otherProjectGroups={
              !isSearching && showOtherProjects ? otherProjectGroups : []
            }
            otherCount={otherCount}
            showOtherProjects={showOtherProjects}
            onToggleOtherProjects={() => setShowOtherProjects((v) => !v)}
            isSearching={isSearching}
            otherIds={otherIds}
            activeSessionId={activeSessionId}
            onDelete={onSessionDelete}
            onRefresh={onRefreshSessions}
            onSelect={onSessionSelect}
            isUnbound={isUnbound}
            onPickProjectDir={onPickProjectDir}
          />
        )}
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

// ── Workspace chip ───────────────────────────────────────────────────────────

function WorkspaceChip({
  workspace,
  isUnbound,
  onPickProjectDir,
}: {
  workspace: WorkspaceInfo | null;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
}) {
  const cwd = workspace?.cwd ?? null;
  const label = isUnbound
    ? 'No project folder'
    : cwd
      ? truncatePathDisplay(cwd, 28)
      : 'No project folder';
  const title = isUnbound
    ? 'Choose a project folder to scope sessions and tools'
    : (cwd ?? undefined);

  return (
    <div className="workspace-chip" title={title}>
      <Icon name="folder" size={12} className="workspace-chip-icon" />
      <span className="workspace-chip-path mono truncate">{label}</span>
      {onPickProjectDir && (
        <button
          type="button"
          className="btn btn-ghost btn-xs workspace-chip-change"
          onClick={onPickProjectDir}
          title={isUnbound ? 'Open folder' : 'Change project folder'}
        >
          {isUnbound ? 'Open' : 'Change'}
        </button>
      )}
    </div>
  );
}

function UnboundEmptyState({
  onPickProjectDir,
}: {
  onPickProjectDir?: () => void;
}) {
  return (
    <div className="session-list">
      <div className="session-list-empty workspace-unbound-empty">
        <p>Choose a project folder to start chatting.</p>
        {onPickProjectDir && (
          <button
            type="button"
            className="btn btn-primary btn-xs mt-2"
            onClick={onPickProjectDir}
          >
            <Icon name="folder" size={12} />
            Open folder
          </button>
        )}
      </div>
    </div>
  );
}

// ── Session list ─────────────────────────────────────────────────────────────

interface SessionListProps {
  state: SessionListState;
  groupedSessions: Array<{ label: string; sessions: SessionSummary[] }>;
  otherProjectGroups: Array<{
    key: string;
    label: string;
    path: string | null;
    sessions: SessionSummary[];
  }>;
  otherCount: number;
  showOtherProjects: boolean;
  onToggleOtherProjects: () => void;
  isSearching: boolean;
  otherIds: Set<string>;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
}

function SessionList({
  state,
  groupedSessions,
  otherProjectGroups,
  otherCount,
  showOtherProjects,
  onToggleOtherProjects,
  isSearching,
  otherIds,
  activeSessionId,
  onSelect,
  onDelete,
  onRefresh,
  isUnbound,
  onPickProjectDir,
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

  const hasPrimary = groupedSessions.length > 0;
  const hasOther = otherCount > 0;

  if (!hasPrimary && !hasOther) {
    return (
      <div className="session-list">
        <div className="session-group-title">Sessions</div>
        <div className="session-list-empty">
          {isUnbound ? (
            <>
              <p>No sessions yet. Open a folder to begin.</p>
              {onPickProjectDir && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs mt-2"
                  onClick={onPickProjectDir}
                >
                  <Icon name="folder" size={12} />
                  Open folder
                </button>
              )}
            </>
          ) : (
            'No sessions yet'
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="session-list">
      {!hasPrimary && !isSearching && (
        <div className="session-list-empty">
          {isUnbound
            ? 'No project selected — showing other projects below.'
            : 'No sessions in this project'}
        </div>
      )}

      {groupedSessions.map((group) => (
        <div key={group.label} className="session-group">
          <div className="session-group-title">{group.label}</div>
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              showPathHint={isSearching && otherIds.has(session.id)}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </div>
      ))}

      {!isSearching && hasOther && (
        <div className="session-other-projects">
          <button
            type="button"
            className="btn btn-ghost btn-xs session-other-toggle"
            onClick={onToggleOtherProjects}
          >
            <Icon
              name={showOtherProjects ? 'chevronDown' : 'chevronRight'}
              size={12}
            />
            {showOtherProjects
              ? 'Hide other projects'
              : `Show other projects (${otherCount})`}
          </button>

          {showOtherProjects &&
            otherProjectGroups.map((project) => (
              <div key={project.key} className="session-group">
                <div
                  className="session-group-title session-project-title"
                  title={project.path ?? undefined}
                >
                  {project.label}
                </div>
                {groupSessionsByDate(project.sessions).map((dateGroup) => (
                  <div key={`${project.key}-${dateGroup.label}`}>
                    {project.sessions.length > 3 && (
                      <div className="session-group-title session-date-sub">
                        {dateGroup.label}
                      </div>
                    )}
                    {dateGroup.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        isActive={session.id === activeSessionId}
                        showPathHint={Boolean(session.cwd)}
                        onSelect={onSelect}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  isActive,
  showPathHint,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  isActive: boolean;
  showPathHint: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const pathHint = session.cwd
    ? truncatePathDisplay(session.cwd, 24)
    : 'Unknown path';

  return (
    <div className="session-row group">
      <button
        type="button"
        className={`session-item ${isActive ? 'session-item-active' : ''}`}
        onClick={() => onSelect(session.id)}
        title={session.cwd ?? session.name}
      >
        <span className="session-item-main min-w-0">
          <span className="session-item-name">{session.name}</span>
          {showPathHint && (
            <span className="session-item-path mono truncate">{pathHint}</span>
          )}
        </span>
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
}
