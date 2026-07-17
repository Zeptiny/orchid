import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config } from '../../shared/types/ipc-boundary';
import type { ConfigDiagnostic, ConfigPatch } from '../../shared/types/ipc';
import { AgentsTab } from './Preferences/AgentsTab';
import { GeneralTab } from './Preferences/GeneralTab';
import { MCPServersTab } from './Preferences/MCPServersTab';
import { PersonalitiesTab } from './Preferences/PersonalitiesTab';
import { ProvidersTab } from './Preferences/ProvidersTab';
import { RAGTab } from './Preferences/RAGTab';
import { SkillsTab } from './Preferences/SkillsTab';
import { TierModelsTab } from './Preferences/TierModelsTab';
import { LeftSidebar } from './LeftSidebar';
import { useProviders } from '../hooks/useProviders';
import { useSession } from '../hooks/useSession';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import { applyConfigDraft } from '../utils/config-draft';
import { withMapDeletionTombstones } from '../utils/config-tombstones';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';
import { DialogSurface } from './ui/DialogSurface';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';

type TabId =
  | 'general'
  | 'providers'
  | 'mcp'
  | 'tier-models'
  | 'rag'
  | 'skills'
  | 'agents'
  | 'personalities';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tier-models', label: 'Tier Models' },
  { id: 'rag', label: 'RAG' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'personalities', label: 'Personalities' },
];

interface ConfigViewProps {
  onClose: () => void;
  initialTab?: TabId;
}

export function ConfigView({ onClose, initialTab = 'general' }: ConfigViewProps) {
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
  const [diagnostics, setDiagnostics] = useState<ConfigDiagnostic[]>([]);
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<ConfigPatch>({});
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

  const isDirty = Object.keys(draft).length > 0;
  const hasMCPChanges = 'mcp_servers' in draft;

  const applyDefinitions = useCallback((result: DefinitionsListResult) => {
    setDefinitions(result);
    // Effective personality names for General dropdown (unique across scopes)
    const names = Array.from(
      new Set(result.personalities.map((p) => p.name)),
    ).sort((a, b) => a.localeCompare(b));
    setPersonalities(names);
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

    try {
      if (tab === 'providers') {
        if (!providers.overview) await providers.refresh();
      } else if (tab === 'tier-models' || tab === 'rag') {
        await providers.ensureModelList();
      } else if (tab === 'skills' || tab === 'agents' || tab === 'personalities') {
        if (!definitions) await loadDefinitions({ silent: true });
      }
    } catch {
      // Still switch — tab will show its own error/empty content.
    }

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
    setDiagnostics([]);

    async function loadConfig() {
      try {
        if (!window.orchid?.config?.get) throw new Error('Configuration API is not available.');
        const [config, diagnostics] = await Promise.all([
          window.orchid.config.get(),
          window.orchid.config.diagnostics
            ? window.orchid.config.diagnostics()
            : Promise.resolve([]),
          // Warm provider + model caches so Providers / Tier Models tabs
          // can switch without an intermediate empty frame.
          providers.ensureModelList().catch(() => undefined),
        ]);
        if (!cancelled) {
          setOriginalConfig(config);
          setDiagnostics(diagnostics);
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
    void loadDefinitions();
    return () => { cancelled = true; };
  }, [loadDefinitions, providers.ensureModelList]);

  // Refresh when workspace binding changes; drop in-progress definition edits.
  useEffect(() => {
    const unsub = window.orchid?.session?.onWorkspaceChanged?.(() => {
      window.dispatchEvent(new CustomEvent('orchid:definitions-workspace-changed'));
      void loadDefinitions({ silent: true });
    });
    return () => {
      unsub?.();
    };
  }, [loadDefinitions]);

  const currentConfig = useMemo(() => {
    if (!originalConfig) return null;
    return applyConfigDraft(originalConfig, draft);
  }, [originalConfig, draft]);

  const updateDraft = useCallback((updates: ConfigPatch) => {
    setDraft((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setError(null);

    try {
      if (!window.orchid?.config?.save) throw new Error('Configuration API is not available.');
      // Deep-merge on the main process preserves nested fields/aliases.
      // Convert omitted provider/MCP aliases into null tombstones so deletes
      // still apply under PATCH-style merge.
      const updates = withMapDeletionTombstones(draft, originalConfig);
      await window.orchid.config.save({
        updates,
      });
      if (typeof updates.theme === 'string') {
        window.dispatchEvent(new CustomEvent('orchid:set-theme', {
          detail: { theme: updates.theme, persist: false },
        }));
      }
      if (window.orchid?.config?.get) {
        const [fresh, diagnostics] = await Promise.all([
          window.orchid.config.get(),
          window.orchid.config.diagnostics
            ? window.orchid.config.diagnostics()
            : Promise.resolve([]),
        ]);
        setOriginalConfig(fresh);
        setDiagnostics(diagnostics);
        window.dispatchEvent(
          new CustomEvent('orchid:config-updated', { detail: fresh }),
        );
      }
      setDraft({});
      if (hasMCPChanges) setShowRestartDialog(true);
    } catch {
      setError('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, hasMCPChanges, isDirty, originalConfig]);

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
    async (id: string) => {
      await session.load(id);
      onClose();
    },
    [onClose, session],
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
        onOpenSettings={() => {}}
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
        onSessionSelect={handleSessionSelect}
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
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={!isDirty || saving}
              type="button"
            >
              {saving && <span className="loading loading-spinner loading-xs" />}
              Save
            </button>
            <button className="btn btn-ghost btn-sm" onClick={requestClose} type="button">
              Close
            </button>
          </div>
        </header>

        {error && (
          <div className="alert alert-error rounded-none py-2.5 text-sm" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
            <button className="btn btn-ghost btn-xs" onClick={() => setError(null)} type="button">
              Dismiss
            </button>
          </div>
        )}

        {diagnostics.map((diagnostic) => (
          <div key={diagnostic.code} role="alert" className="alert alert-warning rounded-none py-2.5 text-sm">
            <Icon name="alert" size={14} />
            <span>{diagnostic.message}</span>
          </div>
        ))}

        <div className="config-tabs tabs tabs-boxed bg-base-200" role="tablist" aria-label="Configuration sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`config-tab tab ${activeTab === tab.id ? 'config-tab-active tab-active' : ''}`}
              onClick={() => { void requestTab(tab.id); }}
              type="button"
              aria-busy={pendingTab === tab.id || undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="config-body">
          {loading ? (
            <StateMessage kind="loading" title="Loading configuration…" />
          ) : currentConfig ? (
            renderTab(
              activeTab,
              currentConfig,
              updateDraft,
              personalities,
              definitions,
              defsLoading,
              loadDefinitions,
            )
          ) : (
            <StateMessage kind="warning" title="Configuration could not be loaded." />
          )}
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
          <button
            ref={unsavedSaveRef}
            className="btn btn-primary"
            type="button"
            onClick={async () => {
              await handleSave();
              onClose();
            }}
          >
            Save
          </button>
          <button
            className="btn btn-error"
            type="button"
            onClick={() => {
              setDraft({});
              onClose();
            }}
          >
            Discard
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setShowUnsavedDialog(false)}
          >
            Cancel
          </button>
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
          <button
            ref={restartPrimaryRef}
            className="btn btn-primary"
            type="button"
            onClick={() => {
              setShowRestartDialog(false);
              onClose();
            }}
          >
            Return to chat
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setShowRestartDialog(false)}
          >
            Later
          </button>
        </div>
      </DialogSurface>
    </div>
  );
}

function renderTab(
  activeTab: TabId,
  config: Config,
  updateDraft: (updates: ConfigPatch) => void,
  personalities: readonly string[] = [],
  definitions: DefinitionsListResult | null = null,
  _defsLoading = false,
  reloadDefinitions: () => Promise<void> = async () => {},
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
          mcpStartupTimeout={config.mcp_startup_timeout}
          mcpPerServerTimeout={config.mcp_per_server_timeout}
          personality={config.personality}
          personalities={personalities}
          readLineLimit={config.read_line_limit}
          theme={config.theme}
          alwaysExpandToolGroups={config.always_expand_tool_groups}
          onChange={updateDraft}
        />
      );
    case 'providers':
      return <ProvidersTab />;
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
          onDefaultModelChange={(default_model) => updateDraft({ default_model })}
          onChange={(tier_models) => updateDraft({ tier_models })}
        />
      );
    case 'rag':
      return (
        <RAGTab
          rag={config.rag}
          onChange={(rag) => updateDraft({ rag })}
        />
      );
    case 'skills':
      // requestTab gates until definitions are loaded — only show error if failed.
      if (!definitions) {
        return <StateMessage kind="warning" title="Skills could not be loaded." />;
      }
      return <SkillsTab data={definitions} onReload={reloadDefinitions} />;
    case 'agents':
      if (!definitions) {
        return <StateMessage kind="warning" title="Agents could not be loaded." />;
      }
      return <AgentsTab data={definitions} onReload={reloadDefinitions} />;
    case 'personalities':
      if (!definitions) {
        return <StateMessage kind="warning" title="Personalities could not be loaded." />;
      }
      return <PersonalitiesTab data={definitions} onReload={reloadDefinitions} />;
  }
}
