import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config } from '../../shared/types/ipc-boundary';
import type { ConfigDiagnostic } from '../../shared/types/ipc';
import { AgentsTab } from './Preferences/AgentsTab';
import { GeneralTab } from './Preferences/GeneralTab';
import { MCPServersTab } from './Preferences/MCPServersTab';
import { PersonalitiesTab } from './Preferences/PersonalitiesTab';
import { ProvidersTab } from './Preferences/ProvidersTab';
import { RAGTab } from './Preferences/RAGTab';
import { SkillsTab } from './Preferences/SkillsTab';
import { TierModelsTab } from './Preferences/TierModelsTab';
import { LeftSidebar } from './LeftSidebar';
import { useSession } from '../hooks/useSession';
import { useFocusTrap, useGlobalShortcuts } from '../keyboard';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';
import { withMapDeletionTombstones } from '../utils/config-tombstones';

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
  const rootRef = useRef<HTMLDivElement>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ConfigDiagnostic[]>([]);
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [personalities, setPersonalities] = useState<string[]>([]);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  /**
   * Cached skills/agents/personalities for definition tabs.
   * Loaded once when Config opens so tab switches never flash a spinner.
   */
  const [definitions, setDefinitions] = useState<DefinitionsListResult | null>(null);
  const [defsLoading, setDefsLoading] = useState(true);

  useFocusTrap({
    enabled: true,
    containerRef: rootRef,
  });

  useEffect(() => {
    setActiveTab(initialTab);
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
  }, [loadDefinitions]);

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
    return { ...originalConfig, ...draft } as Config;
  }, [originalConfig, draft]);

  const updateDraft = useCallback((updates: Record<string, unknown>) => {
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
        updates: updates as Partial<Config>,
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
      className="grid h-screen min-h-0 grid-cols-[auto_minmax(460px,1fr)] overflow-hidden bg-base-100 text-base-content"
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
              <span className="badge badge-sm badge-warning badge-outline">Unsaved</span>
            )}
            <button
              className="btn btn-primary btn-sm h-8 min-h-8"
              onClick={handleSave}
              disabled={!isDirty || saving}
              type="button"
            >
              {saving && <span className="loading loading-spinner loading-xs" />}
              Save
            </button>
            <button className="btn btn-ghost btn-sm h-8 min-h-8" onClick={requestClose} type="button">
              Close
            </button>
          </div>
        </header>

        {error && (
          <div className="alert alert-error rounded-none py-2.5 text-sm">
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

        <div className="config-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`config-tab ${activeTab === tab.id ? 'config-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="config-body">
          {loading ? (
            <div className="flex items-center gap-3 py-6 text-base-content/60">
              <span className="loading loading-spinner loading-sm" />
              <span>Loading configuration...</span>
            </div>
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
            <div className="alert alert-warning">
              <Icon name="alert" />
              <span>Configuration could not be loaded.</span>
            </div>
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

      {showUnsavedDialog && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h2 className="text-lg font-semibold">Unsaved changes</h2>
            <p className="py-3 text-sm text-base-content/70">Save your configuration changes before returning to chat?</p>
            <div className="modal-action">
              <button className="btn btn-primary" onClick={async () => { await handleSave(); onClose(); }}>
                Save
              </button>
              <button className="btn btn-error" onClick={() => { setDraft({}); onClose(); }}>
                Discard
              </button>
              <button className="btn btn-ghost" onClick={() => setShowUnsavedDialog(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showRestartDialog && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h2 className="text-lg font-semibold">Restart required</h2>
            <p className="py-3 text-sm text-base-content/70">MCP server changes require an application restart to take effect.</p>
            <div className="modal-action">
              <button className="btn btn-primary" onClick={() => { setShowRestartDialog(false); onClose(); }}>
                Return to chat
              </button>
              <button className="btn btn-ghost" onClick={() => setShowRestartDialog(false)}>
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DefinitionsLoading() {
  return (
    <div className="flex items-center gap-3 py-6 text-base-content/60">
      <span className="loading loading-spinner loading-sm" />
      <span>Loading definitions…</span>
    </div>
  );
}

function renderTab(
  activeTab: TabId,
  config: Config,
  updateDraft: (updates: Record<string, unknown>) => void,
  personalities: readonly string[] = [],
  definitions: DefinitionsListResult | null = null,
  defsLoading = false,
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
          tierModels={config.tier_models}
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
      if (!definitions) {
        return defsLoading ? <DefinitionsLoading /> : (
          <div className="alert alert-warning">
            <span>Skills could not be loaded.</span>
          </div>
        );
      }
      return <SkillsTab data={definitions} onReload={reloadDefinitions} />;
    case 'agents':
      if (!definitions) {
        return defsLoading ? <DefinitionsLoading /> : (
          <div className="alert alert-warning">
            <span>Agents could not be loaded.</span>
          </div>
        );
      }
      return <AgentsTab data={definitions} onReload={reloadDefinitions} />;
    case 'personalities':
      if (!definitions) {
        return defsLoading ? <DefinitionsLoading /> : (
          <div className="alert alert-warning">
            <span>Personalities could not be loaded.</span>
          </div>
        );
      }
      return <PersonalitiesTab data={definitions} onReload={reloadDefinitions} />;
  }
}
