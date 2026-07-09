/**
 * PreferencesWindow — modal overlay with 5 tabs for configuration.
 *
 * Tabs: Providers, MCP Servers, Tier Models, RAG, General
 *
 * Features:
 * - Ctrl+S saves
 * - Esc → unsaved-changes dialog if dirty
 * - MCP changes → restart prompt
 * - Unsaved changes indicator
 *
 * Opened via `/settings` command (U21) or `orchid:open-settings` event.
 * Classified as modal overlay (z-index layer).
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Config } from '../../../main/config/schema';
import { ProvidersTab } from './ProvidersTab';
import { MCPServersTab } from './MCPServersTab';
import { TierModelsTab } from './TierModelsTab';
import { RAGTab } from './RAGTab';
import { GeneralTab } from './GeneralTab';

// ── Types ────────────────────────────────────────────────────────────────────

type TabId = 'providers' | 'mcp-servers' | 'tier-models' | 'rag' | 'general';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: 'providers', label: 'Providers', icon: '\u{1F4E1}' },
  { id: 'mcp-servers', label: 'MCP Servers', icon: '\u{1F50C}' },
  { id: 'tier-models', label: 'Tier Models', icon: '\u{1F333}' },
  { id: 'rag', label: 'RAG', icon: '\u{1F50D}' },
  { id: 'general', label: 'General', icon: '\u2699' },
];

interface PreferencesWindowProps {
  isOpen: boolean;
  onClose: () => void;
}

// ── Dialog components ────────────────────────────────────────────────────────

function UnsavedDialog({
  onSave,
  onDiscard,
  onCancel,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pref-dialog-overlay" onClick={onCancel}>
      <div
        className="pref-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Unsaved changes"
      >
        <div className="pref-dialog-title">Unsaved Changes</div>
        <div className="pref-dialog-body">
          You have unsaved changes. What would you like to do?
        </div>
        <div className="pref-dialog-actions">
          <button className="btn btn-primary" onClick={onSave}>
            Save
          </button>
          <button className="btn btn-danger" onClick={onDiscard}>
            Discard
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function RestartDialog({
  onRestart,
  onLater,
}: {
  onRestart: () => void;
  onLater: () => void;
}) {
  return (
    <div className="pref-dialog-overlay" onClick={onLater}>
      <div
        className="pref-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Restart required"
      >
        <div className="pref-dialog-title">Restart Required</div>
        <div className="pref-dialog-body">
          MCP server changes require an application restart to take effect.
        </div>
        <div className="pref-dialog-actions">
          <button className="btn btn-primary" onClick={onRestart}>
            Restart Now
          </button>
          <button className="btn btn-ghost" onClick={onLater}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function PreferencesWindow({ isOpen, onClose }: PreferencesWindowProps) {
  const [activeTab, setActiveTab] = useState<TabId>('providers');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Original config from disk (for dirty checking)
  const [originalConfig, setOriginalConfig] = useState<Config | null>(null);

  // Personality names from ~/.orchid/personalities/
  const [personalities, setPersonalities] = useState<string[]>([]);

  // Working copy of config changes
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  // Dialog state
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);

  // Ref for focus trap
  const windowRef = useRef<HTMLDivElement>(null);

  // ── Dirty check ──────────────────────────────────────────────────────────

  const isDirty = useMemo(() => {
    return Object.keys(draft).length > 0;
  }, [draft]);

  const hasMCPChanges = useMemo(() => {
    return 'mcp_servers' in draft;
  }, [draft]);

  // ── Load config on open ──────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft({});
    setActiveTab('providers');

    async function loadConfig() {
      try {
        if (window.orchid?.config?.get) {
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
  }, [isOpen]);

  // ── Merge draft with original for current values ─────────────────────────

  const currentConfig = useMemo(() => {
    if (!originalConfig) return null;
    return { ...originalConfig, ...draft } as Config;
  }, [originalConfig, draft]);

  // ── Update draft ─────────────────────────────────────────────────────────

  const updateDraft = useCallback(
    (updates: Record<string, unknown>) => {
      setDraft((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!isDirty) return;

    setSaving(true);
    setError(null);

    try {
      if (window.orchid?.config?.save) {
        await window.orchid.config.save({ updates: draft as Partial<Config> });
      }
      // Refresh original to reflect saved state
      if (window.orchid?.config?.get) {
        const fresh = await window.orchid.config.get();
        setOriginalConfig(fresh);
      }
      setDraft({});
      setSaving(false);

      // If MCP changed, show restart prompt
      if (hasMCPChanges) {
        setShowRestartDialog(true);
      }
    } catch {
      setError('Failed to save configuration. Please try again.');
      setSaving(false);
    }
  }, [isDirty, draft, hasMCPChanges]);

  // ── Close handling ───────────────────────────────────────────────────────

  const requestClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      setPendingClose(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    setShowUnsavedDialog(false);
    setPendingClose(false);
    setDraft({});
    onClose();
  }, [onClose]);

  const handleSaveAndClose = useCallback(async () => {
    setShowUnsavedDialog(false);
    await handleSave();
    if (pendingClose) {
      setPendingClose(false);
      onClose();
    }
  }, [handleSave, pendingClose, onClose]);

  const handleCancelClose = useCallback(() => {
    setShowUnsavedDialog(false);
    setPendingClose(false);
  }, []);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S — save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }

      // Esc — close (with unsaved check)
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showUnsavedDialog) {
          handleCancelClose();
        } else if (showRestartDialog) {
          setShowRestartDialog(false);
        } else {
          requestClose();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleSave, requestClose, showUnsavedDialog, showRestartDialog, handleCancelClose]);

  // ── Focus trap ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen || !windowRef.current) return;

    const el = windowRef.current;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );

    if (focusable.length > 0) {
      focusable[0].focus();
    }
  }, [isOpen, activeTab]);

  // ── Don't render if not open ─────────────────────────────────────────────

  if (!isOpen) return null;

  // ── Render tab content ───────────────────────────────────────────────────

  function renderTabContent() {
    if (!currentConfig) return null;

    switch (activeTab) {
      case 'providers':
        return (
          <ProvidersTab
            providers={currentConfig.providers}
            onChange={(providers) => updateDraft({ providers })}
          />
        );
      case 'mcp-servers':
        return (
          <MCPServersTab
            mcpServers={currentConfig.mcp_servers}
            onChange={(mcp_servers) => updateDraft({ mcp_servers })}
          />
        );
      case 'tier-models':
        return (
          <TierModelsTab
            tierModels={currentConfig.tier_models}
            providers={currentConfig.providers}
            onChange={(tier_models) => updateDraft({ tier_models })}
          />
        );
      case 'rag':
        return (
          <RAGTab
            rag={currentConfig.rag}
            onChange={(rag) => updateDraft({ rag })}
          />
        );
      case 'general':
        return (
          <GeneralTab
            defaultModel={currentConfig.default_model}
            theme={currentConfig.theme}
            personality={currentConfig.personality}
            personalities={personalities}
            providers={currentConfig.providers as Record<string, Record<string, unknown>>}
            ignoredDirs={currentConfig.ignored_dirs}
            commandTimeout={currentConfig.command_timeout}
            readLineLimit={currentConfig.read_line_limit}
            grepMaxResults={currentConfig.grep_max_results}
            directoryTreeDepth={currentConfig.directory_tree_depth}
            astMaxFileSize={currentConfig.ast_max_file_size}
            llmStreamIdleTimeout={currentConfig.llm_stream_idle_timeout}
            llmStreamRetries={currentConfig.llm_stream_retries}
            backgroundCommandIdleTimeout={currentConfig.background_command_idle_timeout}
            onChange={updateDraft}
          />
        );
    }
  }

  // ── Main render ──────────────────────────────────────────────────────────

  return (
    <div
      className="pref-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Preferences"
    >
      <div className="pref-window" ref={windowRef}>
        {/* Header */}
        <div className="pref-header">
          <div className="pref-header-left">
            <h2 className="pref-title">Preferences</h2>
            {isDirty && <span className="pref-dirty-badge">Unsaved</span>}
          </div>
          <div className="pref-header-right">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={!isDirty || saving}
              title="Ctrl+S"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={requestClose}
              title="Esc"
            >
              Close
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="pref-error-banner">
            <span>{error}</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Content area */}
        <div className="pref-body">
          {/* Tab bar */}
          <div className="pref-tabs" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`pref-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`pref-tabpanel-${tab.id}`}
              >
                <span className="pref-tab-icon">{tab.icon}</span>
                <span className="pref-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Tab panel */}
          <div
            className="pref-tabpanel"
            id={`pref-tabpanel-${activeTab}`}
            role="tabpanel"
          >
            {loading ? (
              <div className="state-loading">
                <div className="spinner" />
                <span>Loading configuration...</span>
              </div>
            ) : (
              renderTabContent()
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pref-footer">
          <span className="pref-footer-hint">
            <kbd>Ctrl+S</kbd> save
          </span>
          <span className="pref-footer-hint">
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>

      {/* Unsaved changes dialog */}
      {showUnsavedDialog && (
        <UnsavedDialog
          onSave={handleSaveAndClose}
          onDiscard={handleDiscardAndClose}
          onCancel={handleCancelClose}
        />
      )}

      {/* Restart prompt */}
      {showRestartDialog && (
        <RestartDialog
          onRestart={() => {
            setShowRestartDialog(false);
            // In a real Electron app, this would call app.relaunch()
            onClose();
          }}
          onLater={() => {
            setShowRestartDialog(false);
            if (pendingClose) {
              setPendingClose(false);
              onClose();
            }
          }}
        />
      )}
    </div>
  );
}
