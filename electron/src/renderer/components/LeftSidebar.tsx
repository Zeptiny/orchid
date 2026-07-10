import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { WorkspaceInfo } from '../../shared/types/ipc';
import type { SessionListState } from '../hooks/useSession';
import { formatShortcut, useRovingListIndex } from '../keyboard';
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
 * U6: defaults to current-workspace sessions; other projects expand,
 * then each project directory is its own dropdown; search is global;
 * workspace chip is always visible. Session titles ellipsize (no x-scroll).
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
  /** Expanded other-project directory keys (collapsed by default). */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleProjectExpanded = (key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
          title={`Expand sessions rail (${formatShortcut('sessionsRail.toggle')})`}
          type="button"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-circle"
          onClick={onSessionCreate}
          title={`New session (${formatShortcut('session.new')})`}
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
            title={`New session (${formatShortcut('session.new')})`}
            type="button"
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onToggle}
            title={`Collapse sessions rail (${formatShortcut('sessionsRail.toggle')})`}
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
            expandedProjects={expandedProjects}
            onToggleProject={toggleProjectExpanded}
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
  expandedProjects: Set<string>;
  onToggleProject: (key: string) => void;
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
  expandedProjects,
  onToggleProject,
  isSearching,
  otherIds,
  activeSessionId,
  onSelect,
  onDelete,
  onRefresh,
  isUnbound,
  onPickProjectDir,
}: SessionListProps) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const flatSessions = useMemo(() => {
    const items: SessionSummary[] = [];
    for (const group of groupedSessions) {
      items.push(...group.sessions);
    }
    if (!isSearching && showOtherProjects) {
      for (const project of otherProjectGroups) {
        // Only keyboard-navigate sessions inside expanded project dropdowns.
        if (expandedProjects.has(project.key)) {
          items.push(...project.sessions);
        }
      }
    }
    return items;
  }, [
    groupedSessions,
    isSearching,
    showOtherProjects,
    otherProjectGroups,
    expandedProjects,
  ]);

  const preferredIndex = useMemo(() => {
    if (!activeSessionId) return 0;
    const idx = flatSessions.findIndex((s) => s.id === activeSessionId);
    return idx >= 0 ? idx : 0;
  }, [flatSessions, activeSessionId]);

  const { activeIndex, setActiveIndex, onListKeyDown } = useRovingListIndex({
    length: flatSessions.length,
    preferredIndex,
  });

  // Keep the highlighted row visible when moving with arrows.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-session-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

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

  const activeOptionId =
    flatSessions[activeIndex] != null
      ? `${listId}-opt-${flatSessions[activeIndex].id}`
      : undefined;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onListKeyDown(event);
    if (event.defaultPrevented) return;

    const current = flatSessions[activeIndex];
    if (!current) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(current.id);
      return;
    }
    // Delete only (not Backspace) to avoid surprising edits while focusing the list.
    if (event.key === 'Delete') {
      event.preventDefault();
      onDelete(current.id);
    }
  };

  let sessionIndex = 0;

  return (
    <div
      ref={listRef}
      className="session-list"
      role="listbox"
      aria-label="Sessions"
      aria-activedescendant={activeOptionId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {!hasPrimary && !isSearching && (
        <div className="session-list-empty">
          {isUnbound
            ? 'No project selected — showing other projects below.'
            : 'No sessions in this project'}
        </div>
      )}

      {groupedSessions.map((group) => (
        <div key={group.label} className="session-group" role="group" aria-label={group.label}>
          <div className="session-group-title">{group.label}</div>
          {group.sessions.map((session) => {
            const index = sessionIndex++;
            return (
              <SessionRow
                key={session.id}
                optionId={`${listId}-opt-${session.id}`}
                sessionIndex={index}
                session={session}
                isActive={session.id === activeSessionId}
                isKeyboardActive={index === activeIndex}
                showPathHint={isSearching && otherIds.has(session.id)}
                onSelect={(id) => {
                  setActiveIndex(index);
                  onSelect(id);
                }}
                onDelete={onDelete}
              />
            );
          })}
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
            otherProjectGroups.map((project) => {
              const isExpanded = expandedProjects.has(project.key);
              const count = project.sessions.length;
              return (
                <div
                  key={project.key}
                  className="session-group session-project-group"
                  role="group"
                  aria-label={project.label}
                >
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs session-project-toggle"
                    onClick={() => onToggleProject(project.key)}
                    aria-expanded={isExpanded}
                    title={project.path ?? project.label}
                  >
                    <Icon
                      name={isExpanded ? 'chevronDown' : 'chevronRight'}
                      size={12}
                      className="session-project-chevron"
                    />
                    <span className="session-project-label truncate">
                      {project.label}
                    </span>
                    <span className="session-project-count">{count}</span>
                  </button>
                  {isExpanded &&
                    groupSessionsByDate(project.sessions).map((dateGroup) => (
                      <div key={`${project.key}-${dateGroup.label}`}>
                        {project.sessions.length > 3 && (
                          <div className="session-group-title session-date-sub">
                            {dateGroup.label}
                          </div>
                        )}
                        {dateGroup.sessions.map((session) => {
                          const index = sessionIndex++;
                          return (
                            <SessionRow
                              key={session.id}
                              optionId={`${listId}-opt-${session.id}`}
                              sessionIndex={index}
                              session={session}
                              isActive={session.id === activeSessionId}
                              isKeyboardActive={index === activeIndex}
                              showPathHint={Boolean(session.cwd)}
                              onSelect={(id) => {
                                setActiveIndex(index);
                                onSelect(id);
                              }}
                              onDelete={onDelete}
                            />
                          );
                        })}
                      </div>
                    ))}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  optionId,
  sessionIndex,
  isActive,
  isKeyboardActive,
  showPathHint,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  optionId: string;
  sessionIndex: number;
  isActive: boolean;
  isKeyboardActive: boolean;
  showPathHint: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const pathHint = session.cwd
    ? truncatePathDisplay(session.cwd, 24)
    : 'Unknown path';

  return (
    <div
      className={`session-row group ${isKeyboardActive ? 'session-row-keyboard' : ''}`}
      data-session-index={sessionIndex}
    >
      <button
        id={optionId}
        type="button"
        role="option"
        aria-selected={isActive}
        tabIndex={-1}
        className={`session-item ${isActive ? 'session-item-active' : ''} ${
          isKeyboardActive ? 'session-item-keyboard' : ''
        }`}
        onClick={() => onSelect(session.id)}
        title={session.cwd ?? session.name}
      >
        <span className="session-item-main min-w-0">
          <span className="session-item-name truncate" title={session.name}>
            {session.name}
          </span>
          {showPathHint && (
            <span className="session-item-path mono truncate">{pathHint}</span>
          )}
        </span>
        {isActive && <span className="badge badge-xs badge-success">active</span>}
      </button>
      <button
        className="btn btn-ghost btn-xs btn-square session-item-delete"
        tabIndex={-1}
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
