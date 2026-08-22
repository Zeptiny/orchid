import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';
import type {
  ConfigPatch,
  ConfigPatchMap,
  PermissionConfigScope,
  PermissionConfigScopes,
} from '../../shared/types/ipc';
import { LeftSidebar } from './LeftSidebar';
import { useProviders } from '../hooks/useProviders';
import { useSession } from '../hooks/useSession';
import type { UseSessionActivityReturn } from '../hooks/useSessionActivity';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import { applyConfigDraft, mergeConfigDraft } from '../utils/config-draft';
import {
  hasProjectPermissionDrafts,
  LatestRequestGuard,
  mergeProjectPermissionDraft,
  persistConfigSnapshot,
  reconcileConfigDraft,
  reconcileMapDraft,
  reconcileProjectPermissionDraft,
  SaveStartGuard,
  type ConfigSaveStage,
} from '../utils/config-save';
import { withMapDeletionTombstones } from '../utils/config-tombstones';
import { emitOrchidEvent } from '../utils/events';
import type { Notify } from '../utils/notify';
import { Keycaps } from './Keycaps';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { DialogSurface } from './ui/DialogSurface';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';
import { Tabs } from './ui/Tabs';

type LoadableComponent = ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface PreloadableLazyComponent<T extends LoadableComponent>
  extends LazyExoticComponent<T> {
  preload: () => Promise<{ default: T }>;
}

function lazyWithPreload<T extends LoadableComponent>(
  loadModule: () => Promise<{ default: T }>,
): PreloadableLazyComponent<T> {
  let promise: Promise<{ default: T }> | null = null;
  const load = () => {
    promise ??= loadModule();
    return promise;
  };
  return Object.assign(lazy(load), { preload: load });
}

const AgentsTab = lazyWithPreload(() => import('./Preferences/AgentsTab').then((module) => ({
  default: module.AgentsTab,
})));
const GeneralTab = lazyWithPreload(() => import('./Preferences/GeneralTab').then((module) => ({
  default: module.GeneralTab,
})));
const MCPServersTab = lazyWithPreload(() => import('./Preferences/MCPServersTab').then((module) => ({
  default: module.MCPServersTab,
})));
const PermissionsTab = lazyWithPreload(() => import('./Preferences/PermissionsTab').then((module) => ({
  default: module.PermissionsTab,
})));
const PersonalitiesTab = lazyWithPreload(() => import('./Preferences/PersonalitiesTab').then((module) => ({
  default: module.PersonalitiesTab,
})));
const ProvidersTab = lazyWithPreload(() => import('./Preferences/ProvidersTab').then((module) => ({
  default: module.ProvidersTab,
})));
const RAGTab = lazyWithPreload(() => import('./Preferences/RAGTab').then((module) => ({
  default: module.RAGTab,
})));
const SharedPromptsTab = lazyWithPreload(() => import('./Preferences/SharedPromptsTab').then((module) => ({
  default: module.SharedPromptsTab,
})));
const SkillsTab = lazyWithPreload(() => import('./Preferences/SkillsTab').then((module) => ({
  default: module.SkillsTab,
})));
const TierModelsTab = lazyWithPreload(() => import('./Preferences/TierModelsTab').then((module) => ({
  default: module.TierModelsTab,
})));
const SubagentsTab = lazyWithPreload(() => import('./Preferences/SubagentsTab').then((module) => ({
  default: module.SubagentsTab,
})));
const AgentsMdTab = lazyWithPreload(() => import('./Preferences/AgentsMdTab').then((module) => ({
  default: module.AgentsMdTab,
})));
const TrustedProjectsTab = lazyWithPreload(() => import('./Preferences/TrustedProjectsTab').then((module) => ({
  default: module.TrustedProjectsTab,
})));
const CompactionTab = lazyWithPreload(() => import('./Preferences/CompactionTab').then((module) => ({
  default: module.CompactionTab,
})));

type TabId =
  | 'general'
  | 'permissions'
  | 'trusted-projects'
  | 'providers'
  | 'mcp'
  | 'tier-models'
  | 'rag'
  | 'agents-md'
  | 'subagents'
  | 'compaction'
  | 'skills'
  | 'agents'
  | 'personalities'
  | 'shared-prompts';

const TAB_COMPONENTS = {
  general: GeneralTab,
  permissions: PermissionsTab,
  'trusted-projects': TrustedProjectsTab,
  providers: ProvidersTab,
  mcp: MCPServersTab,
  'tier-models': TierModelsTab,
  rag: RAGTab,
  'agents-md': AgentsMdTab,
  subagents: SubagentsTab,
  compaction: CompactionTab,
  skills: SkillsTab,
  agents: AgentsTab,
  personalities: PersonalitiesTab,
  'shared-prompts': SharedPromptsTab,
} satisfies Record<TabId, { preload: () => Promise<unknown> }>;

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'trusted-projects', label: 'Trusted Projects' },
  { id: 'providers', label: 'Providers' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tier-models', label: 'Tier Models' },
  { id: 'rag', label: 'RAG' },
  { id: 'agents-md', label: 'AGENTS.md' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'personalities', label: 'Personalities' },
  { id: 'shared-prompts', label: 'Shared Prompts' },
];

interface ConfigViewProps {
  onClose: () => void;
  initialTab?: TabId;
  onNotify: Notify;
  onOpenAnalytics?: () => void;
  activity: UseSessionActivityReturn;
}

interface PermissionTabContext {
  config: Config;
  scope: PermissionConfigScope;
  projectDir: string | null;
  inheritedPermissions: Record<string, PermissionRule>;
  projectLoading: boolean;
  onScopeChange: (scope: PermissionConfigScope) => void;
  updateDraft: (updates: ConfigPatch) => void;
}

export function ConfigView({ onClose, initialTab = 'general', onNotify, onOpenAnalytics, activity }: ConfigViewProps) {
  const session = useSession();
  const providers = useProviders();
  const rootRef = useRef<HTMLDivElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /** Tab currently painted — only advances after target tab data is ready. */
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<ConfigPatch>({});
  const [permissionScope, setPermissionScope] = useState<PermissionConfigScope>('global');
  const [permissionScopes, setPermissionScopes] = useState<PermissionConfigScopes | null>(null);
  const [projectScopeLoading, setProjectScopeLoading] = useState(true);
  const [projectPermissionDrafts, setProjectPermissionDrafts] = useState<
    Record<string, ConfigPatchMap<PermissionRule>>
  >({});
  const [personalities, setPersonalities] = useState<string[]>([]);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  /**
   * Cached skills/agents/personalities for definition tabs.
   * Loaded once when Config opens so tab switches never flash a spinner.
   */
  const [definitions, setDefinitions] = useState<DefinitionsListResult | null>(null);
  const [defsLoading, setDefsLoading] = useState(true);
  const tabSwitchGen = useRef(0);
  const permissionScopeRequests = useRef(new LatestRequestGuard());
  const saveStartGuard = useRef(new SaveStartGuard());
  const unsavedSaveRef = useRef<HTMLButtonElement>(null);
  const restartPrimaryRef = useRef<HTMLButtonElement>(null);

  useFocusTrap({
    enabled: true,
    containerRef: rootRef,
  });

  useEffect(() => {
    tabSwitchGen.current += 1;
    setActiveTab(initialTab);
    setPendingTab(null);
  }, [initialTab]);

  const isDirty = Object.keys(draft).length > 0 || hasProjectPermissionDrafts(
    projectPermissionDrafts,
  );

  const applyDefinitions = useCallback((result: DefinitionsListResult) => {
    setDefinitions(result);
    // Effective personality names for General dropdown (unique across scopes)
    const names = Array.from(
      new Set(result.personalities.map((p) => p.name)),
    ).sort((a, b) => a.localeCompare(b));
    setPersonalities(names);
  }, []);

  const refreshPermissionScopes = useCallback(async () => {
    const generation = permissionScopeRequests.current.begin();
    setProjectScopeLoading(true);
    setPermissionScope('global');
    try {
      const scopes = await window.orchid?.config?.permissionScopes?.();
      if (!permissionScopeRequests.current.isCurrent(generation) || !scopes) return false;
      setPermissionScopes(scopes);
      return true;
    } catch {
      if (permissionScopeRequests.current.isCurrent(generation)) {
        setError('Failed to refresh project permission settings.');
      }
      return false;
    } finally {
      if (permissionScopeRequests.current.isCurrent(generation)) setProjectScopeLoading(false);
    }
  }, []);

  const loadDefinitions = useCallback(async (opts?: { silent?: boolean }) => {
    if (!window.orchid?.definitions?.list) {
      setDefsLoading(false);
      return;
    }
    try {
      const result = await window.orchid.definitions.list();
      applyDefinitions(result);
    } catch (err) {
      // Keep previous cache; always surface the failure so silent refresh isn't invisible.
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to load skills, agents, and personalities.';
      setError(opts?.silent ? `Definitions refresh failed: ${msg}` : msg);
    } finally {
      setDefsLoading(false);
    }
  }, [applyDefinitions]);

  /**
   * Switch tabs only after the target surface's data is ready — keep painting
   * the previous tab (no spinner / empty intermediate state).
   */
  const requestTab = useCallback(async (tab: TabId) => {
    if (tab === activeTab && pendingTab == null) return;
    const gen = ++tabSwitchGen.current;
    setPendingTab(tab);

    const dataPrefetch = async () => {
      if (tab === 'providers') {
        if (!providers.overview) await providers.refresh();
      } else if (tab === 'tier-models' || tab === 'rag') {
        await providers.ensureModelList();
      } else if (
        tab === 'skills'
        || tab === 'agents'
        || tab === 'personalities'
        || tab === 'shared-prompts'
      ) {
        if (!definitions) await loadDefinitions({ silent: true });
      }
    };

    // Still switch after either failure — the tab will show its own error/empty content.
    await Promise.allSettled([
      TAB_COMPONENTS[tab].preload(),
      dataPrefetch(),
    ]);

    if (gen !== tabSwitchGen.current) return;
    setActiveTab(tab);
    setPendingTab(null);
  }, [
    activeTab,
    pendingTab,
    providers.overview,
    providers.refresh,
    providers.ensureModelList,
    definitions,
    loadDefinitions,
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft({});
    setProjectPermissionDrafts({});

    async function loadConfig() {
      try {
        if (!window.orchid?.config?.get) throw new Error('Configuration API is not available.');
        const [config] = await Promise.all([
          window.orchid.config.get(),
          // Warm provider + model caches so Providers / Tier Models tabs
          // can switch without an intermediate empty frame.
          providers.ensureModelList().catch(() => undefined),
        ]);
        if (!cancelled) {
          setOriginalConfig(config);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load configuration.');
          setLoading(false);
        }
      }
    }

    // Prefetch definitions in parallel with config so Skills/Agents/Personalities
    // are ready before the user switches tabs.
    void loadConfig();
    void refreshPermissionScopes();
    void loadDefinitions();
    return () => {
      cancelled = true;
      permissionScopeRequests.current.invalidate();
    };
  }, [loadDefinitions, providers.ensureModelList, refreshPermissionScopes]);

  // Refresh when workspace binding changes; drop in-progress definition edits.
  useEffect(() => {
    const unsub = window.orchid?.session?.onWorkspaceChanged?.(() => {
      emitOrchidEvent('orchid:definitions-workspace-changed');
      void loadDefinitions({ silent: true });
      void refreshPermissionScopes();
    });
    return () => {
      unsub?.();
    };
  }, [loadDefinitions, refreshPermissionScopes]);

  const tabItems = useMemo(
    () => TABS.map((tab) => ({ ...tab, ariaBusy: pendingTab === tab.id })),
    [pendingTab],
  );

  const currentConfig = useMemo(() => {
    if (!originalConfig) return null;
    return applyConfigDraft(originalConfig, draft);
  }, [originalConfig, draft]);

  const permissionConfig = useMemo(() => {
    if (!currentConfig || permissionScope === 'global') return currentConfig;
    const projectPermissions = permissionScopes?.project ?? {};
    const projectDir = permissionScopes?.projectDir;
    const projectPermissionDraft = projectDir == null
      ? {}
      : projectPermissionDrafts[projectDir] ?? {};
    return applyConfigDraft(
      { ...currentConfig, permissions: projectPermissions },
      { permissions: projectPermissionDraft },
    );
  }, [currentConfig, permissionScope, permissionScopes, projectPermissionDrafts]);

  const updateDraft = useCallback((updates: ConfigPatch) => {
    setDraft((prev) => mergeConfigDraft(prev, updates));
  }, []);

  const updateProjectPermissionDraft = useCallback((updates: ConfigPatch) => {
    const projectDir = permissionScopes?.projectDir;
    const permissionUpdates = updates.permissions;
    if (projectScopeLoading || !projectDir || !permissionUpdates) return;
    setProjectPermissionDrafts((current) => mergeProjectPermissionDraft(
      current,
      projectDir,
      permissionUpdates,
    ));
  }, [permissionScopes?.projectDir, projectScopeLoading]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    if (!saveStartGuard.current.tryStart()) return false;
    setSaving(true);
    setError(null);

    try {
      if (!window.orchid?.config?.save) throw new Error('Configuration API is not available.');
      if (!window.orchid.config.savePermissionScope) {
        throw new Error('Permission configuration API is not available.');
      }

      const draftSnapshot = draft;
      const updates = withMapDeletionTombstones(draftSnapshot, originalConfig);
      const { permissions: globalPermissionUpdates, ...ordinaryUpdates } = updates;
      const { permissions: globalDraftSnapshot, ...ordinaryDraftSnapshot } = draftSnapshot;
      const activeProjectDir = projectScopeLoading ? null : permissionScopes?.projectDir ?? null;
      const activeProjectDraft = activeProjectDir == null
        ? undefined
        : projectPermissionDrafts[activeProjectDir];
      const retainedProjectDirs = Object.entries(projectPermissionDrafts)
        .filter(([projectDir, projectDraft]) => (
          projectDir !== activeProjectDir && Object.keys(projectDraft).length > 0
        ))
        .map(([projectDir]) => projectDir);

      const result = await persistConfigSnapshot(
        {
          ordinary: ordinaryUpdates,
          globalPermissions: globalPermissionUpdates,
          project: activeProjectDir && activeProjectDraft && Object.keys(activeProjectDraft).length > 0
            ? { projectDir: activeProjectDir, updates: activeProjectDraft }
            : undefined,
          retainedProjectDirs,
        },
        {
          save: window.orchid.config.save,
          savePermissionScope: window.orchid.config.savePermissionScope,
        },
        (stage: ConfigSaveStage) => {
          if (stage === 'settings') {
            setOriginalConfig((current) => current
              ? applyConfigDraft(current, ordinaryUpdates)
              : current);
            setDraft((current) => reconcileConfigDraft(current, ordinaryDraftSnapshot));
            if (typeof ordinaryUpdates.theme === 'string') {
              emitOrchidEvent('orchid:set-theme', { theme: ordinaryUpdates.theme, persist: false });
            }
          } else if (stage === 'global permissions' && globalPermissionUpdates) {
            setOriginalConfig((current) => current
              ? applyConfigDraft(current, { permissions: globalPermissionUpdates })
              : current);
            setPermissionScopes((current) => current
              ? {
                  ...current,
                  global: applyPermissionPatch(current.global, globalPermissionUpdates),
                }
              : current);
            setDraft((current) => reconcilePermissionDraft(
              current,
              globalDraftSnapshot ?? globalPermissionUpdates,
            ));
          } else if (
            stage === 'project permissions' &&
            activeProjectDir &&
            activeProjectDraft
          ) {
            setPermissionScopes((current) => current?.projectDir === activeProjectDir
              ? {
                  ...current,
                  project: applyPermissionPatch(current.project, activeProjectDraft),
                }
              : current);
            setProjectPermissionDrafts((current) => reconcileProjectPermissionDraft(
              current,
              activeProjectDir,
              activeProjectDraft,
            ));
          }
        },
      );

      if (result.failedStage) {
        setError(result.completedStages.length > 0
          ? `Some changes were saved, but ${result.failedStage} could not be saved. Unsaved changes were retained.`
          : `Failed to save ${result.failedStage}. Unsaved changes were retained.`);
        return false;
      }
      if (!result.ok) {
        setError('Available changes were saved, but project drafts for other workspaces remain unsaved. Switch back to each project to save them.');
        return false;
      }

      let refreshFailed = false;
      if (window.orchid?.config?.get && result.completedStages.length > 0) {
        const refreshGeneration = permissionScopeRequests.current.begin();
        setProjectScopeLoading(true);
        try {
          const [fresh, scopes] = await Promise.all([
            window.orchid.config.get(),
            window.orchid.config.permissionScopes?.() ?? Promise.resolve(permissionScopes),
          ]);
          setOriginalConfig({ ...fresh, permissions: fresh.permissions });
          emitOrchidEvent('orchid:config-updated', fresh);
          if (permissionScopeRequests.current.isCurrent(refreshGeneration) && scopes) {
            setPermissionScopes(scopes);
          }
        } catch {
          refreshFailed = true;
        } finally {
          if (permissionScopeRequests.current.isCurrent(refreshGeneration)) {
            setProjectScopeLoading(false);
          }
        }
      }
      if (refreshFailed) {
        setError('Configuration was saved, but refreshed values could not be loaded.');
      }
      if ('mcp_servers' in ordinaryUpdates) setShowRestartDialog(true);
      return true;
    } catch {
      setError('Failed to save configuration. Please try again.');
      return false;
    } finally {
      saveStartGuard.current.finish();
      setSaving(false);
    }
  }, [
    draft,
    isDirty,
    originalConfig,
    permissionScopes,
    projectPermissionDrafts,
    projectScopeLoading,
  ]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  useGlobalShortcuts({
    handlers: {
      'config.save': () => {
        void handleSave();
      },
      'config.close': () => {
        if (showUnsavedDialog) setShowUnsavedDialog(false);
        else if (showRestartDialog) setShowRestartDialog(false);
        else requestClose();
      },
    },
  });

  const handleSessionSelect = useCallback(
    (id: string) => {
      emitOrchidEvent('orchid:select-session', { id });
      onClose();
    },
    [onClose],
  );

  const handleSessionCreate = useCallback(async () => {
    // Draft in the currently selected project — do not open a folder picker.
    const inheritCwd =
      session.activeSession?.cwd?.trim() ||
      (session.workspace?.status === 'valid' ? session.workspace.cwd : null);
    if (inheritCwd) {
      await session.setWorkspace(inheritCwd);
    }
    await session.enterDraft();
  }, [session]);

  const handleProjectSelect = useCallback(async (projectDir: string) => {
    await session.setWorkspace(projectDir);
    await session.enterDraft();
  }, [session]);

  const handleProjectSessionCreate = useCallback(async (projectDir: string) => {
    await session.setWorkspace(projectDir);
    await session.enterDraft();
  }, [session]);

  const handleStopSession = useCallback((sessionId: string) => {
    void window.orchid?.chat?.stop?.({ sessionId });
  }, []);

  const handleSessionDeleteError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    onNotify(`Delete failed: ${message}`, 'error');
  }, [onNotify]);

  return (
    <div
      ref={rootRef}
      className="config-shell grid h-screen min-h-0 overflow-hidden bg-base-100 text-base-content"
    >
      <LeftSidebar
        activeSessionId={session.activeSession?.id ?? null}
        selectedProjectPath={
          session.activeSession?.cwd ??
          (session.workspace?.status === 'valid' ? session.workspace.cwd : null)
        }
        isCollapsed={leftCollapsed}
        activeView="settings"
        onOpenSettings={() => {}}
        onOpenAnalytics={onOpenAnalytics}
        onPickProjectDir={() => {
          void session.pickProjectDir();
        }}
        onRefreshSessions={session.refresh}
        onSessionCreate={() => {
          void handleSessionCreate();
        }}
        onProjectSelect={(projectDir) => {
          void handleProjectSelect(projectDir);
        }}
        onProjectSessionCreate={(projectDir) => {
          void handleProjectSessionCreate(projectDir);
        }}
        onSessionDelete={session.deleteSession}
        onSessionDeleteError={handleSessionDeleteError}
        deletingSessionIds={session.pendingDeleteIds}
        onSessionSelect={handleSessionSelect}
        activities={activity.activities}
        onStopSession={handleStopSession}
        onToggle={() => setLeftCollapsed((prev) => !prev)}
        sessionListState={session.listState}
        workspace={session.workspace}
      />

      <main className="flex min-h-0 min-w-0 flex-col bg-base-100">
        <header className="config-main-header">
          <div className="config-main-header-text">
            <h1 className="truncate">Configuration</h1>
            <p className="truncate">
              Global app settings from merged defaults, home config, project config, and env overrides.
            </p>
          </div>
          <div className="config-main-header-actions">
            {isDirty && (
              <StatusBadge tone="warning" size="sm" outline>
                Unsaved
              </StatusBadge>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!isDirty || saving}
              loading={saving}
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={requestClose}>
              Close
            </Button>
          </div>
        </header>

        {error && (
          <Alert
            tone="error"
            className="orchid-state-enter rounded-none py-2.5 text-sm"
            icon="alert"
            iconSize={14}
            action={
              <Button variant="ghost" size="xs" onClick={() => setError(null)}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        <Tabs
          items={tabItems}
          value={activeTab}
          onValueChange={(id) => { void requestTab(id as TabId); }}
          variant="boxed"
          className="config-tabs bg-base-200"
          itemClassName="config-tab"
          activeItemClassName="config-tab-active"
          aria-label="Configuration sections"
        />

        <div className="config-body">
          <div key={activeTab} className="orchid-view-enter">
          {loading ? (
            <StateMessage kind="loading" title="Loading configuration…" />
          ) : currentConfig ? (
            <Suspense
              fallback={(
                <StateMessage
                  kind="loading"
                  title="Loading settings section…"
                  className="min-h-48"
                  role="status"
                  aria-live="polite"
                />
              )}
            >
              {renderTab(
                activeTab,
                currentConfig,
                updateDraft,
                personalities,
                definitions,
                defsLoading,
                loadDefinitions,
                {
                  config: permissionConfig ?? currentConfig,
                  scope: permissionScope,
                  projectDir: permissionScopes?.projectDir ?? null,
                  inheritedPermissions: permissionScopes?.global ?? {},
                  projectLoading: projectScopeLoading,
                  onScopeChange: setPermissionScope,
                  updateDraft: permissionScope === 'project'
                    ? updateProjectPermissionDraft
                    : updateDraft,
                },
                onNotify,
              )}
            </Suspense>
          ) : (
            <StateMessage kind="warning" title="Configuration could not be loaded." />
          )}
          </div>
        </div>

        <footer className="config-footer-bar orchid-shortcut-bar">
          <span className="orchid-shortcut-bar-item">
            <Keycaps chord={{ key: 's', mod: true }} size="xs" />
            <span>save</span>
          </span>
          <span className="orchid-shortcut-bar-item">
            <Keycaps chord="Esc" size="xs" />
            <span>close</span>
          </span>
          <span className="config-footer-meta">
            Config layers: defaults, home, project, env
          </span>
        </footer>
      </main>

      <DialogSurface
        isOpen={showUnsavedDialog}
        onClose={() => setShowUnsavedDialog(false)}
        labelledBy="config-unsaved-title"
        describedBy="config-unsaved-desc"
        initialFocusRef={unsavedSaveRef}
        variant="modal"
        closeOnBackdrop={false}
      >
        <h2 id="config-unsaved-title" className="text-lg font-semibold">
          Unsaved changes
        </h2>
        <p id="config-unsaved-desc" className="py-3 text-sm text-base-content/70">
          Save your configuration changes before returning to chat?
        </p>
        <div className="modal-action">
          <Button
            ref={unsavedSaveRef}
            variant="primary"
            onClick={async () => {
              if (await handleSave()) onClose();
            }}
          >
            Save
          </Button>
          <Button
            variant="error"
            onClick={() => {
              setDraft({});
              setProjectPermissionDrafts({});
              onClose();
            }}
          >
            Discard
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowUnsavedDialog(false)}
          >
            Cancel
          </Button>
        </div>
      </DialogSurface>

      <DialogSurface
        isOpen={showRestartDialog}
        onClose={() => setShowRestartDialog(false)}
        labelledBy="config-restart-title"
        describedBy="config-restart-desc"
        initialFocusRef={restartPrimaryRef}
        variant="modal"
        closeOnBackdrop={false}
      >
        <h2 id="config-restart-title" className="text-lg font-semibold">
          Restart required
        </h2>
        <p id="config-restart-desc" className="py-3 text-sm text-base-content/70">
          MCP server changes require an application restart to take effect.
        </p>
        <div className="modal-action">
          <Button
            ref={restartPrimaryRef}
            variant="primary"
            onClick={() => {
              setShowRestartDialog(false);
              onClose();
            }}
          >
            Return to chat
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowRestartDialog(false)}
          >
            Later
          </Button>
        </div>
      </DialogSurface>
    </div>
  );
}

function applyPermissionPatch(
  current: Record<string, PermissionRule>,
  patch: ConfigPatchMap<PermissionRule>,
): Record<string, PermissionRule> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function reconcilePermissionDraft(
  current: ConfigPatch,
  persisted: ConfigPatchMap<PermissionRule>,
): ConfigPatch {
  const remaining = reconcileMapDraft(current.permissions ?? {}, persisted);
  const next = { ...current };
  if (Object.keys(remaining).length === 0) delete next.permissions;
  else next.permissions = remaining;
  return next;
}
function renderTab(
  activeTab: TabId,
  config: Config,
  updateDraft: (updates: ConfigPatch) => void,
  personalities: readonly string[] = [],
  definitions: DefinitionsListResult | null = null,
  _defsLoading = false,
  reloadDefinitions: () => Promise<void> = async () => {},
  permission: PermissionTabContext = {
    config,
    scope: 'global',
    projectDir: null,
    inheritedPermissions: {},
    projectLoading: false,
    onScopeChange: () => {},
    updateDraft,
  },
  onNotify: Notify = () => {},
) {
  switch (activeTab) {
    case 'general':
      return (
        <GeneralTab
          astMaxFileSize={config.ast_max_file_size}
          backgroundCommandIdleTimeout={config.background_command_idle_timeout}
          commandTimeout={config.command_timeout}
          directoryTreeDepth={config.directory_tree_depth}
          grepMaxResults={config.grep_max_results}
          ignoredDirs={config.ignored_dirs}
          llmStreamIdleTimeout={config.llm_stream_idle_timeout}
          llmStreamRetries={config.llm_stream_retries}
          maxToolSteps={config.max_tool_steps}
          debugCaptureRequests={config.debug_capture_requests}
          mcpStartupTimeout={config.mcp_startup_timeout}
          mcpPerServerTimeout={config.mcp_per_server_timeout}
          personality={config.personality}
          personalities={personalities}
          readLineLimit={config.read_line_limit}
          theme={config.theme}
          alwaysExpandToolGroups={config.always_expand_tool_groups}
          commandMaxOutputBytes={config.command_max_output_bytes}
          toolOutputInlineThreshold={config.tool_output_inline_threshold}
          grepPerFileTimeout={config.grep_per_file_timeout}
          webFetchTimeout={config.web_fetch_timeout}
          webFetchMaxBodyBytes={config.web_fetch_max_body_bytes}
          webFetchUserAgent={config.web_fetch_user_agent}
          llmRetryBackoffBase={config.llm_retry_backoff_base}
          llmRetryMaxDelay={config.llm_retry_max_delay}
          maxBackgroundProcesses={config.max_background_processes}
          approvalTimeout={config.approval_timeout}
          subagentWaitTimeout={config.subagent_wait_timeout}
          bgPromptMaxEntries={config.bg_prompt_max_entries}
          bgPromptTailLines={config.bg_prompt_tail_lines}
          bgPromptTailChars={config.bg_prompt_tail_chars}
          bgOutputHeadBytes={config.bg_output_head_bytes}
          bgOutputTailBytes={config.bg_output_tail_bytes}
          readOutputLongPollMax={config.read_output_long_poll_max}
          mcpResultMaxBytes={config.mcp_result_max_bytes}
          toolWorkerPoolSize={config.tool_worker_pool_size}
          toolWorkerPoolMainAgentReserved={config.tool_worker_pool_main_agent_reserved}
          sessionTitleMaxWaitSeconds={config.session_title_max_wait_seconds}
          onChange={updateDraft}
        />
      );
    case 'permissions':
      return (
        <PermissionsTab
          config={permission.config}
          updateDraft={permission.updateDraft}
          scope={permission.scope}
          lockedScope="global"
          projectDir={permission.projectDir}
          inheritedPermissions={permission.scope === 'project'
            ? permission.inheritedPermissions
            : {}}
          projectLoading={permission.projectLoading}
          onScopeChange={permission.onScopeChange}
        />
      );
    case 'trusted-projects':
      return <TrustedProjectsTab onNotify={onNotify} />;
    case 'providers':
      return <ProvidersTab onNotify={onNotify} />;
    case 'mcp':
      return (
        <MCPServersTab
          mcpServers={config.mcp_servers}
          onChange={(mcp_servers) => updateDraft({ mcp_servers })}
        />
      );
    case 'tier-models':
      return (
        <TierModelsTab
          defaultModel={config.default_model}
          tierModels={config.tier_models}
          tierReasoningEffort={config.tier_reasoning_effort}
          onDefaultModelChange={(default_model) => updateDraft({ default_model })}
          onChange={(tier_models) => updateDraft({ tier_models })}
          onTierReasoningEffortChange={(tier_reasoning_effort) =>
            updateDraft({ tier_reasoning_effort })}
        />
      );
    case 'rag':
      return (
        <RAGTab
          rag={config.rag}
          onChange={(rag) => updateDraft({ rag })}
          indexRefresh={config.index_refresh}
          onIndexRefreshChange={(index_refresh) => updateDraft({ index_refresh })}
        />
      );
    case 'agents-md':
      return (
        <AgentsMdTab
          agentsMd={config.agents_md}
          onChange={(agents_md) => updateDraft({ agents_md })}
        />
      );
    case 'subagents':
      return (
        <SubagentsTab
          subagents={config.subagents}
          onChange={(subagents) => updateDraft({ subagents })}
        />
      );
    case 'compaction':
      return (
        <CompactionTab
          compaction={config.compaction}
          onChange={(compaction) => updateDraft({ compaction })}
        />
      );
    case 'skills':
      // requestTab gates until definitions are loaded — only show error if failed.
      if (!definitions) {
        return <StateMessage kind="warning" title="Skills could not be loaded." />;
      }
      return <SkillsTab data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
    case 'agents':
      if (!definitions) {
        return <StateMessage kind="warning" title="Agents could not be loaded." />;
      }
      return (
        <AgentsTab
          data={definitions}
          tierModels={config.tier_models}
          onReload={reloadDefinitions}
          lockedScope="global"
        />
      );
    case 'personalities':
      if (!definitions) {
        return <StateMessage kind="warning" title="Personalities could not be loaded." />;
      }
      return <PersonalitiesTab data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
    case 'shared-prompts':
      if (!definitions) {
        return <StateMessage kind="warning" title="Shared prompts could not be loaded." />;
      }
      return <SharedPromptsTab data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
  }
}
