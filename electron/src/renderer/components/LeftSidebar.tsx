import {
  memo,
  useCallback,
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
  sessionActivityPresentation,
  sessionActivitySummaryPresentation,
} from '../utils/session-activity-presentation';
import {
  countProjectActivity,
  filterSessionsByQuery,
  groupSessionsByProject,
  normalizeWorkspaceKey,
  type ProjectDeleteTarget,
  previewProjectSessions,
  PROJECT_SESSION_PREVIEW_LIMIT,
  truncatePathDisplay,
} from '../utils/session-workspace';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { DialogSurface } from './ui/DialogSurface';
import { IconButton } from './ui/IconButton';
import { SectionHeader } from './ui/SectionHeader';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';
import { SessionActivitySection } from './session-activity-section';
import { SessionNameEditor } from './SessionNameEditor';

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

interface LeftSidebarProps {
  isCollapsed: boolean;
  isOverlay?: boolean;
  onToggle: () => void;
  sessionListState: SessionListState;
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onSessionCreate: () => void;
  onSessionDelete: (id: string) => void | Promise<unknown>;
  onSessionDeleteError?: (error: unknown) => void;
  deletingSessionIds?: ReadonlySet<string>;
  onSessionRename?: (id: string, name: string) => void | Promise<void>;
  onRefreshSessions: () => void;
  onOpenSettings: () => void;
  onOpenAnalytics?: () => void;
  /**
   * Which footer view is currently open, so its button renders in the
   * selected state (mirrors an active session row). null in chat mode.
   */
  activeView?: 'analytics' | 'settings' | null;
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
  /**
   * Delete every session in a project group. Receives the group label and all
   * session ids — the group itself is derived and disappears once empty.
   */
  onProjectDelete?: (project: ProjectDeleteTarget) => void | Promise<unknown>;
  /** A project pick starts a draft instead of moving the selected session. */
  projectPickerCreatesDraft?: boolean;
  /** Global work across every project/window. Optional for ConfigView reuse. */
  activities?: readonly SessionActivity[];
  /** Immediate targeted stop from an Activity row. */
  onStopSession?: (sessionId: string) => void;
  /** Open the trust dialog for the workspace (untrusted/changed badge click). */
  onTrustBadgeClick?: () => void;
}

/**
 * Left sessions rail — paddings match mock 012:
 * header 7px 10px / body 8px / footer 6px 8px
 * session rows min-height 30px, pad 5px 7px, gap 1px
 * No menu component (avoids horizontal dividers between items).
 *
 * Project groups are always visible, show recent work first, and expand
 * independently; search remains global and session titles never scroll.
 */
export const LeftSidebar = memo(function LeftSidebar({
  isCollapsed,
  isOverlay = false,
  onToggle,
  sessionListState,
  activeSessionId,
  onSessionSelect,
  onSessionCreate,
  onSessionDelete,
  onSessionDeleteError,
  deletingSessionIds = EMPTY_SESSION_IDS,
  onSessionRename,
  onRefreshSessions,
  onOpenSettings,
  onOpenAnalytics,
  activeView = null,
  workspace = null,
  selectedProjectPath = null,
  onProjectSelect,
  onPickProjectDir,
  onProjectSessionCreate,
  onProjectDelete,
  projectPickerCreatesDraft = false,
  activities = [],
  onStopSession,
  onTrustBadgeClick,
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
  const activitySummary = sessionActivitySummaryPresentation(activities);

  if (isCollapsed) {
    return (
      <aside
        className="left-panel left-panel-collapsed bg-base-200"
        aria-label="Sessions"
      >
        <IconButton
          label={`Expand sessions rail (${formatShortcut('sessionsRail.toggle')})`}
          icon="chevronRight"
          size="sm"
          onClick={onToggle}
          aria-expanded={false}
          aria-controls="left-sidebar-body"
        />
        {onPickProjectDir && (
          <IconButton
            label={
              currentWorkspace
                ? `Workspace: ${currentWorkspace}`
                : 'Open project folder'
            }
            icon="folder"
            size="sm"
            onClick={onPickProjectDir}
          />
        )}
        {activitySummary && (
          <Button
            variant="ghost"
            size="sm"
            shape="circle"
            className="left-panel-activity-count"
            onClick={onToggle}
            title={activitySummary.label}
            aria-label={activitySummary.label}
          >
            <span
              className={`status status-xs ${activitySummary.statusClass}`}
              aria-hidden
            />
          </Button>
        )}
        <div className="left-panel-collapsed-spacer" />
        {onOpenAnalytics && (
          <IconButton
            label="Analytics"
            icon="barChart"
            size="sm"
            iconSize={18}
            onClick={onOpenAnalytics}
            className={activeView === 'analytics' ? 'session-item-active' : ''}
            aria-current={activeView === 'analytics' ? 'page' : undefined}
          />
        )}
        <IconButton
          label="Settings"
          icon="settings"
          size="sm"
          iconSize={18}
          onClick={onOpenSettings}
          className={activeView === 'settings' ? 'session-item-active' : ''}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        />
      </aside>
    );
  }

  return (
    <aside
      className={isOverlay ? 'left-panel left-panel-overlay orchid-view-enter bg-base-200' : 'left-panel bg-base-200'}
      aria-label="Sessions"
    >
      <SectionHeader
        className="panel-header"
        title={<h1 className="title truncate">Orchid</h1>}
        actions={
          <div className="panel-header-actions">
            <IconButton
              label={`Collapse sessions rail (${formatShortcut('sessionsRail.toggle')})`}
              icon="chevronLeft"
              size="sm"
              onClick={onToggle}
              aria-expanded
              aria-controls="left-sidebar-body"
            />
          </div>
        }
      />

      <SessionActivitySection
        activities={activities}
        sessions={sessions}
        onSelect={onSessionSelect}
        onStop={onStopSession ?? (() => {})}
      />

      <div id="left-sidebar-body" className="panel-body">
        <WorkspaceChip
          workspace={workspace}
          isUnbound={isUnbound}
          onPickProjectDir={onPickProjectDir}
          onNewChatInProject={onSessionCreate}
          projectPickerCreatesDraft={projectPickerCreatesDraft}
          onTrustBadgeClick={onTrustBadgeClick}
        />

        <div className="session-search">
          <Icon name="search" size={12} className="session-search-icon" />
          <input
            className="session-search-input w-full"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions..."
            type="search"
            aria-label="Search sessions"
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
            onDeleteError={onSessionDeleteError}
            deletingSessionIds={deletingSessionIds}
            onRename={onSessionRename}
            onRefresh={onRefreshSessions}
            onSelect={onSessionSelect}
            onProjectSelect={onProjectSelect}
            isUnbound={isUnbound}
            onPickProjectDir={onPickProjectDir}
            onProjectSessionCreate={onProjectSessionCreate}
            onProjectDelete={onProjectDelete}
            isSearching={query.trim().length > 0}
          />
        )}
      </div>

      <div className="panel-footer">
        {onOpenAnalytics && (
          <Button
            variant="ghost"
            size="md"
            className={`session-analytics-btn ${activeView === 'analytics' ? 'session-item-active' : ''}`}
            onClick={onOpenAnalytics}
            aria-current={activeView === 'analytics' ? 'page' : undefined}
          >
            <Icon name="barChart" size={18} />
            <span>Analytics</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="md"
          className={`session-settings-btn ${activeView === 'settings' ? 'session-item-active' : ''}`}
          onClick={onOpenSettings}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" size={18} />
          <span>Settings</span>
        </Button>
      </div>
    </aside>
  );
});

// ── Workspace chip ───────────────────────────────────────────────────────────

function WorkspaceChip({
  workspace,
  isUnbound,
  onPickProjectDir,
  onNewChatInProject,
  projectPickerCreatesDraft,
  onTrustBadgeClick,
}: {
  workspace: WorkspaceInfo | null;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
  /** New chat in the current project (no directory dialog). */
  onNewChatInProject?: () => void;
  projectPickerCreatesDraft: boolean;
  /** Open the trust dialog for this workspace. */
  onTrustBadgeClick?: () => void;
}) {
  const cwd = workspace?.cwd ?? null;
  const trust = workspace?.trust ?? 'trusted';
  const trustGated = !isUnbound && (trust === 'untrusted' || trust === 'changed');
  const label = isUnbound
    ? 'No project folder'
    : cwd
      ? truncatePathDisplay(cwd, 28)
      : 'No project folder';
  const title = isUnbound
    ? 'Choose a project folder to scope sessions and tools'
    : trustGated && trust === 'changed'
      ? `${cwd ?? ''} — project changed since it was trusted; review the updated surface`
      : trustGated
        ? `${cwd ?? ''} — not trusted; review the project surface to continue`
        : (cwd ?? undefined);

  // On a non-empty session the chip offers "New chat" in *this* project.
  // Folder picking is only for unbound / explicit project change.
  const showNewChat =
    projectPickerCreatesDraft && Boolean(onNewChatInProject) && !isUnbound && Boolean(cwd);
  const showPick = Boolean(onPickProjectDir) && !showNewChat;

  return (
    <div className="workspace-chip border border-base-300 bg-base-100" title={title}>
      <Icon name="folder" size={12} className="workspace-chip-icon shrink-0 opacity-70" />
      <span className="workspace-chip-path mono truncate">{label}</span>
      {trustGated && (
        <button
          type="button"
          className="shrink-0"
          onClick={onTrustBadgeClick}
          title={trust === 'changed' ? 'Review the changed project surface' : 'Review the project surface to grant trust'}
        >
          <StatusBadge tone={trust === 'changed' ? 'error' : 'warning'} size="xs" withDot>
            {trust === 'changed' ? 'Changed' : 'Not trusted'}
          </StatusBadge>
        </button>
      )}
      {showNewChat && (
        <Button
          variant="ghost"
          size="xs"
          className="workspace-chip-change"
          onClick={onNewChatInProject}
          title="Start a new chat in this project"
        >
          New chat
        </Button>
      )}
      {showPick && (
        <Button
          variant="ghost"
          size="xs"
          className="workspace-chip-change"
          onClick={onPickProjectDir}
          title={isUnbound ? 'Open folder' : 'Choose project folder'}
        >
          {isUnbound ? 'Open' : 'Choose'}
        </Button>
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
      <StateMessage
        kind="empty"
        className="workspace-unbound-empty py-6"
        title="Choose a project folder to start chatting."
        action={
          onPickProjectDir ? (
            <Button
              variant="primary"
              size="xs"
              onClick={onPickProjectDir}
            >
              <Icon name="folder" size={12} />
              Open folder
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

// ── Always-visible project groups ───────────────────────────────────────────

// Collapsed project groups persist across restarts via localStorage. The set
// lives in a module-level store shared by every mounted ProjectSessionList
// (ChatView stays mounted under Config/Analytics overlays, which render their
// own sidebars) so two instances can never clobber each other's writes.
const COLLAPSED_PROJECTS_KEY = 'orchid-sidebar-collapsed-projects';

function loadCollapsedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((key): key is string => typeof key === 'string'));
    }
  } catch {
    // Missing or corrupted storage — start with nothing collapsed.
  }
  return new Set();
}

function saveCollapsedProjects(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...keys]));
  } catch {
    // Non-fatal
  }
}

const collapsedProjectsStoreListeners = new Set<(next: ReadonlySet<string>) => void>();
const collapsedProjectsStore = {
  current: loadCollapsedProjects(),
  subscribe(listener: (next: ReadonlySet<string>) => void): () => void {
    collapsedProjectsStoreListeners.add(listener);
    return () => collapsedProjectsStoreListeners.delete(listener);
  },
  update(next: Set<string>): void {
    collapsedProjectsStore.current = next;
    saveCollapsedProjects(next);
    for (const listener of collapsedProjectsStoreListeners) listener(next);
  },
};

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
  onDelete: (id: string) => void | Promise<unknown>;
  onDeleteError?: (error: unknown) => void;
  deletingSessionIds: ReadonlySet<string>;
  onRename?: (id: string, name: string) => void | Promise<void>;
  onRefresh: () => void;
  isUnbound: boolean;
  onPickProjectDir?: () => void;
  onProjectSessionCreate?: (projectDir: string) => void;
  onProjectDelete?: (project: ProjectDeleteTarget) => void | Promise<unknown>;
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
  onDeleteError,
  deletingSessionIds,
  onRename,
  onRefresh,
  isUnbound,
  onPickProjectDir,
  onProjectSessionCreate,
  onProjectDelete,
  isSearching,
}: ProjectSessionListProps) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(
    () => collapsedProjectsStore.current,
  );
  useEffect(
    () => collapsedProjectsStore.subscribe(setCollapsedProjects),
    [],
  );
  const toggleCollapsed = useCallback((key: string) => {
    const next = new Set(collapsedProjectsStore.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedProjectsStore.update(next);
  }, []);
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
    return (
      <StateMessage kind="loading" className="session-list-state py-6" title="Loading sessions…" />
    );
  }
  if (state.status === 'error') {
    return (
      <StateMessage
        kind="error"
        className="session-list-error py-4"
        title={state.error}
        action={
          <Button variant="error" size="xs" onClick={onRefresh}>
            Retry
          </Button>
        }
      />
    );
  }
  if (projectGroups.length === 0) {
    return (
      <div className="session-list">
        <div className="session-group-title">Projects</div>
        <StateMessage
          kind="empty"
          className="session-list-empty py-6"
          title={isUnbound ? 'No sessions yet. Open a folder to begin.' : 'No sessions yet'}
          action={
            isUnbound && onPickProjectDir ? (
              <Button variant="primary" size="xs" onClick={onPickProjectDir}>
                <Icon name="folder" size={12} />
                Open folder
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const activeOptionId =
    keyboardSessionActive && flatSessions[activeIndex]
      ? `${listId}-opt-${flatSessions[activeIndex]!.id}`
      : projectOnlySelection
        ? `${listId}-project-${selectedProjectKey}`
        : undefined;
  const deleteConfirmProject = deleteConfirmKey == null
    ? null
    : projectGroups.find((group) => group.key === deleteConfirmKey) ?? null;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Portaled overlays (delete-confirm dialog) still bubble through the React
    // tree to this handler; keys typed inside them must not drive the listbox.
    if (deleteConfirmProject != null) return;
    if (!listRef.current?.contains(event.target as Node)) return;
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
              <Button
                variant="ghost"
                size="xs"
                id={
                  projectKey != null
                    ? `${listId}-project-${projectKey}`
                    : undefined
                }
                className={`session-project-toggle ${
                  isProjectSelected ? 'session-project-toggle-selected' : ''
                }`}
                onClick={() => {
                  if (project.path && onProjectSelect) {
                    onProjectSelect(project.path);
                    return;
                  }
                  toggleCollapsed(project.key);
                }}
                aria-expanded={!project.isCollapsed}
                aria-controls={`${listId}-sessions-${project.key}`}
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
                    toggleCollapsed(project.key);
                  }}
                >
                  <Icon
                    name={project.isCollapsed ? 'chevronRight' : 'chevronDown'}
                    size={12}
                  />
                </span>
                <Icon name="folder" size={12} className="session-project-folder" />
                <span className="session-project-label truncate">{project.label}</span>
                {counts.working > 0 && (
                  <StatusBadge tone="warning" size="xs">{counts.working} working</StatusBadge>
                )}
                {counts.attention > 0 && (
                  <StatusBadge tone="error" size="xs">{counts.attention}</StatusBadge>
                )}
                {counts.unread > 0 && (
                  <StatusBadge tone="success" size="xs">{counts.unread}</StatusBadge>
                )}
              </Button>
              {project.path && onProjectSessionCreate && (
                <Button
                  variant="ghost"
                  size="xs"
                  shape="square"
                  className="session-project-create"
                  onClick={() => onProjectSessionCreate(project.path!)}
                  title={`New chat in ${project.label}`}
                  aria-label={`New chat in ${project.label}`}
                >
                  <Icon name="plus" size={13} />
                </Button>
              )}
              {onProjectDelete && (
                <IconButton
                  label={`Delete all sessions in ${project.label}`}
                  icon="trash"
                  size="xs"
                  iconSize={13}
                  className="session-project-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteConfirmKey(project.key);
                  }}
                />
              )}
            </div>
            <div
              id={`${listId}-sessions-${project.key}`}
              className="session-project-sessions"
              role="group"
              hidden={project.isCollapsed}
            >
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
                    onActivate={setActiveIndex}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onDeleteError={onDeleteError}
                    isDeleting={deletingSessionIds.has(session.id)}
                    onRename={onRename}
                  />
                );
              })}
              {!project.isCollapsed && !isSearching && project.sessions.length > PROJECT_SESSION_PREVIEW_LIMIT && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="session-project-expand"
                  aria-expanded={project.isExpanded}
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
                </Button>
              )}
            </div>
          </div>
        );
      })}

      <DialogSurface
        isOpen={deleteConfirmProject != null}
        onClose={() => setDeleteConfirmKey(null)}
        labelledBy={`${listId}-project-delete-title`}
        describedBy={`${listId}-project-delete-desc`}
        variant="modal"
      >
        {deleteConfirmProject && (
          <div className="flex flex-col gap-3">
            <h2
              id={`${listId}-project-delete-title`}
              className="text-lg font-semibold"
            >
              Delete {deleteConfirmProject.sessions.length} session
              {deleteConfirmProject.sessions.length === 1 ? '' : 's'} in{' '}
              {deleteConfirmProject.label}?
            </h2>
            <p
              id={`${listId}-project-delete-desc`}
              className="text-sm text-base-content/70"
            >
              Every session in this project is permanently deleted, including
              history, todos, and subagent chains. Running sessions are stopped
              first.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setDeleteConfirmKey(null)}>
                Cancel
              </Button>
              <Button
                variant="error"
                size="sm"
                onClick={() => {
                  const target = deleteConfirmProject;
                  setDeleteConfirmKey(null);
                  void onProjectDelete?.({
                    label: target.label,
                    sessionIds: target.sessions.map((session) => session.id),
                  });
                }}
              >
                Delete project sessions
              </Button>
            </div>
          </div>
        )}
      </DialogSurface>
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  activity,
  optionId,
  sessionIndex,
  isActive,
  isKeyboardActive,
  showPathHint,
  onActivate,
  onSelect,
  onDelete,
  onDeleteError,
  isDeleting,
  onRename,
}: {
  session: SessionSummary;
  activity?: SessionActivity;
  optionId: string;
  sessionIndex: number;
  isActive: boolean;
  isKeyboardActive: boolean;
  showPathHint: boolean;
  onActivate: (index: number) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void | Promise<unknown>;
  onDeleteError?: (error: unknown) => void;
  isDeleting: boolean;
  onRename?: (id: string, name: string) => void | Promise<void>;
}) {
  const pathHint = session.cwd
    ? truncatePathDisplay(session.cwd, 24)
    : 'Unknown path';
  const activityStatus = activity
    ? sessionActivityPresentation(activity)
    : null;

  const handleSelect = useCallback(() => {
    if (isDeleting) return;
    onActivate(sessionIndex);
    onSelect(session.id);
  }, [isDeleting, onActivate, onSelect, sessionIndex, session.id]);

  return (
    <div
      className={`session-row group ${isKeyboardActive ? 'session-row-keyboard' : ''}`}
      data-session-index={sessionIndex}
    >
      <div
        id={optionId}
        role="option"
        aria-selected={isActive}
        aria-disabled={isDeleting || undefined}
        tabIndex={-1}
        className={`session-item ${isActive ? 'session-item-active' : ''} ${
          isKeyboardActive ? 'session-item-keyboard' : ''
        }`}
        title={session.cwd ?? session.name}
        onClick={handleSelect}
      >
        {activityStatus?.visible && (
          <span
            className={`status status-xs ${activityStatus.statusClass}`}
            title={activityStatus.label}
          />
        )}
        <span className="session-item-main min-w-0">
          {onRename && !isDeleting ? (
            <SessionNameEditor
              name={session.name}
              className="session-item-name truncate"
              title={`${session.name} (double-click or F2 to rename)`}
              onSelect={handleSelect}
              onBeginEdit={handleSelect}
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
      </div>
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        className="session-item-delete"
        tabIndex={-1}
        loading={isDeleting}
        onClick={(event) => {
          event.stopPropagation();
          if (isDeleting) return;
          try {
            void Promise.resolve(onDelete(session.id)).catch((error) => {
              if (onDeleteError) onDeleteError(error);
              else console.error('Failed to delete session:', error);
            });
          } catch (error) {
            if (onDeleteError) onDeleteError(error);
            else console.error('Failed to delete session:', error);
          }
        }}
        title={isDeleting ? 'Deleting session' : 'Delete session'}
        aria-label={isDeleting ? 'Deleting session' : 'Delete session'}
      >
        {!isDeleting && <Icon name="trash" size={12} />}
      </Button>
    </div>
  );
});
