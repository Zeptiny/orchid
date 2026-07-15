import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  SessionActivity,
  SessionSummary,
} from '../../shared/types/ipc-boundary';
import type { WorkspaceInfo } from '../../shared/types/ipc';
import type { SessionListState } from '../hooks/useSession';
import { formatShortcut, useRovingListIndex } from '../keyboard';
import {
  countProjectActivity,
  filterSessionsByQuery,
  groupSessionsByProject,
  normalizeWorkspaceKey,
  previewProjectSessions,
  PROJECT_SESSION_PREVIEW_LIMIT,
  truncatePathDisplay,
} from '../utils/session-workspace';
import { Icon } from './Icon';
import { SessionActivitySection } from './session-activity-section';
import { SessionNameEditor } from './SessionNameEditor';

interface LeftSidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  sessionListState: SessionListState;
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: (id: string) => void;
  onSessionRename?: (id: string, name: string) => void | Promise<void>;
  onRefreshSessions: () => void;
  onOpenSettings: () => void;
  /** Current workspace (draft → session → sticky → unbound). */
  workspace?: WorkspaceInfo | null;
  /**
   * Project path selected when no conversation is open (draft / project focus).
   * When set and activeSessionId is null, the matching project group is highlighted
   * instead of the first session row.
   */
  selectedProjectPath?: string | null;
  /** Select a project group (clears conversation selection; keeps draft bound). */
  onProjectSelect?: (projectDir: string) => void;
  /** Open folder picker (binds workspace + sticky default). */
  onPickProjectDir?: () => void;
  /** Start a new draft explicitly bound to one visible project group. */
  onProjectSessionCreate?: (projectDir: string) => void;
  /** A project pick starts a draft instead of moving the selected session. */
  projectPickerCreatesDraft?: boolean;
  /** Global work across every project/window. Optional for ConfigView reuse. */
  activities?: readonly SessionActivity[];
  /** Immediate targeted stop from an Activity row. */
  onStopSession?: (sessionId: string) => void;
}

/**
 * Left sessions rail — paddings match mock 012:
 * header 7px 10px / body 8px / footer 6px 8px
 * session rows min-height 30px, pad 5px 7px, gap 1px
 * No daisyUI menu (avoids horizontal dividers between items).
 *
 * Project groups are always visible, show recent work first, and expand
 * independently; search remains global and session titles never scroll.
 */
export function LeftSidebar({
  isCollapsed,
  onToggle,
  sessionListState,
  activeSessionId,
  onSessionSelect,
  onSessionCreate,
  onSessionDelete,
  onSessionRename,
  onRefreshSessions,
  onOpenSettings,
  workspace = null,
  selectedProjectPath = null,
  onProjectSelect,
  onPickProjectDir,
  onProjectSessionCreate,
  projectPickerCreatesDraft = false,
  activities = [],
  onStopSession,
}: LeftSidebarProps) {
  const [query, setQuery] = useState('');

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

  const projectGroups = useMemo(
    () => groupSessionsByProject(filterSessionsByQuery(sessions, query)),
    [sessions, query],
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
        {activities.length > 0 && (
          <button
            className="btn btn-ghost btn-sm btn-circle left-panel-activity-count"
            onClick={onToggle}
            title={`${activities.length} session${activities.length === 1 ? '' : 's'} need attention or are running`}
            type="button"
          >
            <span className="status status-xs status-warning" />
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

      <SessionActivitySection
        activities={activities}
        sessions={sessions}
        onSelect={onSessionSelect}
        onStop={onStopSession ?? (() => {})}
      />

      <div className="panel-body">
        <WorkspaceChip
          workspace={workspace}
          isUnbound={isUnbound}
          onPickProjectDir={onPickProjectDir}
          onNewChatInProject={onSessionCreate}
          projectPickerCreatesDraft={projectPickerCreatesDraft}
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
          <ProjectSessionList
            state={sessionListState}
            projectGroups={projectGroups}
            activities={activities}
            activeSessionId={activeSessionId}
            selectedProjectPath={selectedProjectPath}
            onDelete={onSessionDelete}
            onRename={onSessionRename}
            onRefresh={onRefreshSessions}
            onSelect={onSessionSelect}
            onProjectSelect={onProjectSelect}
            isUnbound={isUnbound}
            onPickProjectDir={onPickProjectDir}
            onProjectSessionCreate={onProjectSessionCreate}
            isSearching={query.trim().length > 0}
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
  onNewChatInProject,
  projectPickerCreatesDraft,
}: {
  workspace: WorkspaceInfo | null;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
  /** New chat in the current project (no directory dialog). */
  onNewChatInProject?: () => void;
  projectPickerCreatesDraft: boolean;
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

  // On a non-empty session the chip offers "New chat" in *this* project.
  // Folder picking is only for unbound / explicit project change.
  const showNewChat =
    projectPickerCreatesDraft && Boolean(onNewChatInProject) && !isUnbound && Boolean(cwd);
  const showPick = Boolean(onPickProjectDir) && !showNewChat;

  return (
    <div className="workspace-chip" title={title}>
      <Icon name="folder" size={12} className="workspace-chip-icon" />
      <span className="workspace-chip-path mono truncate">{label}</span>
      {showNewChat && (
        <button
          type="button"
          className="btn btn-ghost btn-xs workspace-chip-change"
          onClick={onNewChatInProject}
          title="Start a new chat in this project"
        >
          New chat
        </button>
      )}
      {showPick && (
        <button
          type="button"
          className="btn btn-ghost btn-xs workspace-chip-change"
          onClick={onPickProjectDir}
          title={isUnbound ? 'Open folder' : 'Choose project folder'}
        >
          {isUnbound ? 'Open' : 'Choose'}
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

// ── Always-visible project groups ───────────────────────────────────────────

interface ProjectSessionListProps {
  state: SessionListState;
  projectGroups: Array<{
    key: string;
    label: string;
    path: string | null;
    sessions: SessionSummary[];
  }>;
  activities: readonly SessionActivity[];
  activeSessionId: string | null;
  selectedProjectPath: string | null;
  onSelect: (id: string) => void;
  onProjectSelect?: (projectDir: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void | Promise<void>;
  onRefresh: () => void;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
  onProjectSessionCreate?: (projectDir: string) => void;
  isSearching: boolean;
}

function ProjectSessionList({
  state,
  projectGroups,
  activities,
  activeSessionId,
  selectedProjectPath,
  onSelect,
  onProjectSelect,
  onDelete,
  onRename,
  onRefresh,
  isUnbound,
  onPickProjectDir,
  onProjectSessionCreate,
  isSearching,
}: ProjectSessionListProps) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const activityBySession = useMemo(
    () => new Map(activities.map((activity) => [activity.sessionId, activity])),
    [activities],
  );
  const selectedProjectKey = normalizeWorkspaceKey(selectedProjectPath);
  const projectOnlySelection = activeSessionId == null && selectedProjectKey != null;
  const visibleProjectGroups = useMemo(
    () => projectGroups.map((group) => {
      const isExpanded = isSearching || expandedProjects.has(group.key);
      // Search is global: it temporarily opens every group so a matching
      // session is never hidden behind a collapsed project.
      const isCollapsed = !isSearching && collapsedProjects.has(group.key);
      const previewSessions = previewProjectSessions(
        group.sessions,
        isExpanded,
        PROJECT_SESSION_PREVIEW_LIMIT,
        activeSessionId,
      );
      return {
        ...group,
        isExpanded,
        isCollapsed,
        previewSessions,
        visibleSessions: isCollapsed ? [] : previewSessions,
      };
    }),
    [activeSessionId, collapsedProjects, expandedProjects, isSearching, projectGroups],
  );
  const flatSessions = useMemo(
    () => visibleProjectGroups.flatMap((group) => group.visibleSessions),
    [visibleProjectGroups],
  );
  // Prefer the active session when present. When only a project is selected
  // (draft / settings), do not fall back to the first session row — that made
  // New Chat and Settings look like they auto-selected a conversation.
  const preferredIndex = useMemo(() => {
    if (!activeSessionId) return -1;
    return flatSessions.findIndex((session) => session.id === activeSessionId);
  }, [flatSessions, activeSessionId]);
  const { activeIndex, setActiveIndex, onListKeyDown } = useRovingListIndex({
    length: flatSessions.length,
    preferredIndex: preferredIndex >= 0 ? preferredIndex : 0,
  });
  const keyboardSessionActive = preferredIndex >= 0 || activeSessionId != null;

  useEffect(() => {
    if (!keyboardSessionActive || activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-session-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, keyboardSessionActive]);

  if (state.status === 'loading') {
    return <div className="session-list-state"><span className="loading loading-spinner loading-sm" /></div>;
  }
  if (state.status === 'error') {
    return (
      <div className="session-list-error">
        <div>{state.error}</div>
        <button className="btn btn-error btn-xs" onClick={onRefresh} type="button">Retry</button>
      </div>
    );
  }
  if (projectGroups.length === 0) {
    return (
      <div className="session-list">
        <div className="session-group-title">Projects</div>
        <div className="session-list-empty">
          {isUnbound ? (
            <>
              <p>No sessions yet. Open a folder to begin.</p>
              {onPickProjectDir && (
                <button type="button" className="btn btn-primary btn-xs mt-2" onClick={onPickProjectDir}>
                  <Icon name="folder" size={12} />
                  Open folder
                </button>
              )}
            </>
          ) : 'No sessions yet'}
        </div>
      </div>
    );
  }

  const activeOptionId =
    keyboardSessionActive && flatSessions[activeIndex]
      ? `${listId}-opt-${flatSessions[activeIndex]!.id}`
      : projectOnlySelection
        ? `${listId}-project-${selectedProjectKey}`
        : undefined;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onListKeyDown(event);
    if (event.defaultPrevented) return;
    const current = flatSessions[activeIndex];
    if (!current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(current.id);
    } else if (event.key === 'Delete') {
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
      aria-label="Sessions grouped by project"
      aria-activedescendant={activeOptionId}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="session-group-title">Projects</div>
      {visibleProjectGroups.map((project) => {
        const counts = countProjectActivity(project, activities);
        const hiddenCount = project.sessions.length - project.previewSessions.length;
        const projectKey = normalizeWorkspaceKey(project.path);
        const isProjectSelected =
          projectOnlySelection &&
          projectKey != null &&
          projectKey === selectedProjectKey;
        return (
          <div
            key={project.key}
            className={`session-group session-project-group ${
              isProjectSelected ? 'session-project-group-selected' : ''
            }`}
            role="group"
            aria-label={project.label}
          >
            <div className="session-project-header">
              <button
                type="button"
                id={
                  projectKey != null
                    ? `${listId}-project-${projectKey}`
                    : undefined
                }
                className={`btn btn-ghost btn-xs session-project-toggle ${
                  isProjectSelected ? 'session-project-toggle-selected' : ''
                }`}
                onClick={() => {
                  if (project.path && onProjectSelect) {
                    onProjectSelect(project.path);
                    return;
                  }
                  setCollapsedProjects((previous) => {
                    const next = new Set(previous);
                    if (next.has(project.key)) next.delete(project.key);
                    else next.add(project.key);
                    return next;
                  });
                }}
                aria-expanded={!project.isCollapsed}
                aria-selected={isProjectSelected}
                title={
                  project.path && onProjectSelect
                    ? `Select project ${project.label} (draft / new chat)`
                    : `${project.isCollapsed ? 'Show' : 'Hide'} sessions in ${project.path ?? project.label}`
                }
              >
                <span
                  className="session-project-chevron"
                  role="presentation"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsedProjects((previous) => {
                      const next = new Set(previous);
                      if (next.has(project.key)) next.delete(project.key);
                      else next.add(project.key);
                      return next;
                    });
                  }}
                >
                  <Icon
                    name={project.isCollapsed ? 'chevronRight' : 'chevronDown'}
                    size={12}
                  />
                </span>
                <Icon name="folder" size={12} className="session-project-folder" />
                <span className="session-project-label truncate">{project.label}</span>
                {counts.working > 0 && <span className="badge badge-xs badge-warning">{counts.working} working</span>}
                {counts.attention > 0 && <span className="badge badge-xs badge-error">{counts.attention}</span>}
                {counts.unread > 0 && <span className="badge badge-xs badge-success">{counts.unread}</span>}
                {isProjectSelected && (
                  <span className="badge badge-xs badge-ghost">project</span>
                )}
              </button>
              {project.path && onProjectSessionCreate && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square session-project-create"
                  onClick={() => onProjectSessionCreate(project.path!)}
                  title={`New chat in ${project.label}`}
                  aria-label={`New chat in ${project.label}`}
                >
                  <Icon name="plus" size={13} />
                </button>
              )}
            </div>
            {!project.isCollapsed && project.visibleSessions.map((session) => {
              const index = sessionIndex++;
              return (
                <SessionRow
                  key={session.id}
                  optionId={`${listId}-opt-${session.id}`}
                  sessionIndex={index}
                  session={session}
                  activity={activityBySession.get(session.id)}
                  isActive={session.id === activeSessionId}
                  isKeyboardActive={
                    keyboardSessionActive && index === activeIndex
                  }
                  showPathHint={false}
                  onSelect={(id) => {
                    setActiveIndex(index);
                    onSelect(id);
                  }}
                  onDelete={onDelete}
                  onRename={onRename}
                />
              );
            })}
            {!project.isCollapsed && !isSearching && project.sessions.length > PROJECT_SESSION_PREVIEW_LIMIT && (
              <button
                type="button"
                className="btn btn-ghost btn-xs session-project-expand"
                onClick={() => {
                  setExpandedProjects((previous) => {
                    const next = new Set(previous);
                    if (next.has(project.key)) next.delete(project.key);
                    else next.add(project.key);
                    return next;
                  });
                }}
              >
                <Icon
                  name={project.isExpanded ? 'chevronUp' : 'chevronDown'}
                  size={12}
                />
                {project.isExpanded
                  ? `Show recent ${PROJECT_SESSION_PREVIEW_LIMIT}`
                  : `View ${hiddenCount} more`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SessionRow({
  session,
  activity,
  optionId,
  sessionIndex,
  isActive,
  isKeyboardActive,
  showPathHint,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionSummary;
  activity?: SessionActivity;
  optionId: string;
  sessionIndex: number;
  isActive: boolean;
  isKeyboardActive: boolean;
  showPathHint: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void | Promise<void>;
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
        {activity && (
          <span
            className={`status status-xs ${
              activity.state === 'needs_attention'
                ? 'status-error'
                : activity.state === 'working'
                  ? 'status-warning'
                  : activity.state === 'waiting'
                    ? 'status-info'
                    : activity.unread
                      ? 'status-success'
                      : 'status-neutral'
            }`}
            title={
              activity.state === 'needs_attention'
                ? 'Needs attention'
                : activity.state === 'working'
                  ? 'Working'
                  : activity.state === 'waiting'
                    ? 'Waiting'
                    : activity.unread
                      ? 'Completed unread'
                      : 'Idle'
            }
          />
        )}
        <span className="session-item-main min-w-0">
          {onRename ? (
            <SessionNameEditor
              name={session.name}
              className="session-item-name truncate"
              title={`${session.name} (double-click to rename)`}
              onBeginEdit={() => onSelect(session.id)}
              onRename={(next) => onRename(session.id, next)}
            />
          ) : (
            <span className="session-item-name truncate" title={session.name}>
              {session.name}
            </span>
          )}
          {showPathHint && (
            <span className="session-item-path mono truncate">{pathHint}</span>
          )}
        </span>
        {isActive && <span className="badge badge-xs badge-ghost">selected</span>}
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
