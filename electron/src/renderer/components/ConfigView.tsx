import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Config } from '../../shared/types/ipc-boundary';
import { GeneralTab } from './Preferences/GeneralTab';
import { MCPServersTab } from './Preferences/MCPServersTab';
import { ProvidersTab } from './Preferences/ProvidersTab';
import { RAGTab } from './Preferences/RAGTab';
import { TierModelsTab } from './Preferences/TierModelsTab';
import { LeftSidebar } from './LeftSidebar';
import { useSession } from '../hooks/useSession';
import { Icon } from './Icon';

type TabId = 'general' | 'providers' | 'mcp' | 'tier-models' | 'rag';

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
];

interface ConfigViewProps {
  onClose: () => void;
}

export function ConfigView({ onClose }: ConfigViewProps) {
  const session = useSession();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [personalities, setPersonalities] = useState<string[]>([]);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);

  const isDirty = Object.keys(draft).length > 0;
  const hasMCPChanges = 'mcp_servers' in draft;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft({});

    async function loadConfig() {
      try {
        if (!window.orchid?.config?.get) throw new Error('Configuration API is not available.');
        const config = await window.orchid.config.get();
        let names: string[] = [];
        if (window.orchid?.config?.listPersonalities) {
          names = await window.orchid.config.listPersonalities();
        }
        if (!cancelled) {
          setOriginalConfig(config);
          setPersonalities(names);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load configuration.');
          setLoading(false);
        }
      }
    }

    loadConfig();
    return () => { cancelled = true; };
  }, []);

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
      await window.orchid.config.save({ updates: draft as Partial<Config> });
      if (window.orchid?.config?.get) {
        const fresh = await window.orchid.config.get();
        setOriginalConfig(fresh);
      }
      setDraft({});
      if (hasMCPChanges) setShowRestartDialog(true);
    } catch {
      setError('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, hasMCPChanges, isDirty]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        handleSave();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (showUnsavedDialog) setShowUnsavedDialog(false);
        else if (showRestartDialog) setShowRestartDialog(false);
        else requestClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, requestClose, showRestartDialog, showUnsavedDialog]);

  const handleSessionSelect = useCallback(
    async (id: string) => {
      await session.load(id);
    },
    [session],
  );

  const handleSessionCreate = useCallback(async () => {
    const newSession = await session.create();
    await session.load(newSession.id);
  }, [session]);

  return (
    <div className="grid h-screen min-h-0 grid-cols-[auto_minmax(460px,1fr)] overflow-hidden bg-[#080c12] text-base-content">
      <LeftSidebar
        activeSessionId={session.activeSession?.id ?? null}
        isCollapsed={leftCollapsed}
        onOpenSettings={() => {}}
        onRefreshSessions={session.refresh}
        onSessionCreate={handleSessionCreate}
        onSessionDelete={session.deleteSession}
        onSessionSelect={handleSessionSelect}
        onToggle={() => setLeftCollapsed((prev) => !prev)}
        sessionListState={session.listState}
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
            renderTab(activeTab, currentConfig, updateDraft, personalities)
          ) : (
            <div className="alert alert-warning">
              <Icon name="alert" />
              <span>Configuration could not be loaded.</span>
            </div>
          )}
        </div>

        <footer className="flex min-h-7 shrink-0 items-center gap-2.5 border-t border-base-300 bg-base-200 px-4 py-1.5 text-[10px] text-base-content/50">
          <span><kbd className="kbd kbd-xs">Ctrl S</kbd> save</span>
          <span>-</span>
          <span><kbd className="kbd kbd-xs">Esc</kbd> close</span>
          <span>-</span>
          <span>Config layers: defaults, home, project, env</span>
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

function renderTab(
  activeTab: TabId,
  config: Config,
  updateDraft: (updates: Record<string, unknown>) => void,
  personalities: readonly string[] = [],
) {
  switch (activeTab) {
    case 'general':
      return (
        <GeneralTab
          astMaxFileSize={config.ast_max_file_size}
          backgroundCommandIdleTimeout={config.background_command_idle_timeout}
          commandTimeout={config.command_timeout}
          defaultModel={config.default_model}
          directoryTreeDepth={config.directory_tree_depth}
          grepMaxResults={config.grep_max_results}
          ignoredDirs={config.ignored_dirs}
          llmStreamIdleTimeout={config.llm_stream_idle_timeout}
          llmStreamRetries={config.llm_stream_retries}
          personality={config.personality}
          personalities={personalities}
          providers={config.providers as Record<string, Record<string, unknown>>}
          readLineLimit={config.read_line_limit}
          theme={config.theme}
          onChange={updateDraft}
        />
      );
    case 'providers':
      return (
        <ProvidersTab
          providers={config.providers}
          onChange={(providers) => updateDraft({ providers })}
        />
      );
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
          providers={config.providers}
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
  }
}