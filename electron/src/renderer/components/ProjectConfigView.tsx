import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Config, RAGConfig } from '../../shared/types/ipc-boundary';
import { useGlobalShortcuts } from '../keyboard';
import { parseConfigNumber } from '../utils/config-draft';
import { Keycaps } from './Keycaps';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Panel } from './ui/Panel';
import { SectionHeader } from './ui/SectionHeader';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';
import { TextInput } from './ui/TextInput';

export interface ProjectConfigViewProps {
  projectDir: string;
  onNewChat: (projectDir: string) => void;
  onClose: () => void;
}

type ProjectFieldKind = 'number' | 'integer' | 'text';

interface ProjectFieldSpec {
  key: string;
  label: string;
  kind: ProjectFieldKind;
  min?: number;
  max?: number;
  step?: number;
  fullWidth?: boolean;
}

interface ProjectConfigSection {
  title: string;
  fields: ProjectFieldSpec[];
}

const SECTIONS: ProjectConfigSection[] = [
  {
    title: 'Tool Limits',
    fields: [
      { key: 'command_timeout', label: 'Command Timeout (s)', kind: 'integer', min: 1, max: 300 },
      { key: 'command_max_output_bytes', label: 'Command Max Output (bytes)', kind: 'integer', min: 1 },
      { key: 'read_line_limit', label: 'Read Line Limit', kind: 'integer', min: 1, max: 10000 },
      { key: 'grep_max_results', label: 'Grep Max Results', kind: 'integer', min: 1, max: 1000 },
      { key: 'grep_per_file_timeout', label: 'Grep Per-File Timeout (s)', kind: 'number', min: 1 },
      { key: 'directory_tree_depth', label: 'Directory Tree Depth', kind: 'integer', min: 1, max: 10 },
      { key: 'ast_max_file_size', label: 'AST Max File Size (bytes)', kind: 'integer', min: 1 },
      { key: 'tool_output_inline_threshold', label: 'Tool Output Inline Threshold (chars)', kind: 'integer', min: 1 },
    ],
  },
  {
    title: 'Web Fetch',
    fields: [
      { key: 'web_fetch_timeout', label: 'Web Fetch Timeout (s)', kind: 'number', min: 1 },
      { key: 'web_fetch_max_body_bytes', label: 'Web Fetch Max Body (bytes)', kind: 'integer', min: 1 },
      { key: 'web_fetch_user_agent', label: 'Web Fetch User-Agent', kind: 'text', fullWidth: true },
    ],
  },
  {
    title: 'LLM / Streaming',
    fields: [
      { key: 'llm_stream_idle_timeout', label: 'Stream Idle Timeout (s)', kind: 'number', min: 10, max: 600 },
      { key: 'llm_stream_retries', label: 'Stream Retries', kind: 'integer', min: 0, max: 10 },
      { key: 'llm_retry_backoff_base', label: 'Retry Backoff Base (s)', kind: 'number', min: 0.01, step: 0.01 },
      { key: 'llm_retry_max_delay', label: 'Retry Max Delay (s)', kind: 'number', min: 1 },
      { key: 'max_tool_steps', label: 'Max Tool Steps', kind: 'integer', min: 1, max: 1000 },
      { key: 'background_command_idle_timeout', label: 'BG Command Idle Timeout (s)', kind: 'number', min: 30, max: 3600 },
    ],
  },
  {
    title: 'Permissions & Agents',
    fields: [
      { key: 'approval_timeout', label: 'Approval Timeout (s)', kind: 'number', min: 1 },
      { key: 'subagent_wait_timeout', label: 'Subagent Wait Timeout (s)', kind: 'number', min: 1 },
      { key: 'permission_history_size', label: 'Permission History Size', kind: 'integer', min: 0, max: 50 },
    ],
  },
  {
    title: 'Background Commands',
    fields: [
      { key: 'max_background_processes', label: 'Max Background Processes', kind: 'integer', min: 1, max: 256 },
      { key: 'bg_prompt_max_entries', label: 'BG Prompt Max Entries', kind: 'integer', min: 1, max: 50 },
      { key: 'bg_prompt_tail_lines', label: 'BG Prompt Tail Lines', kind: 'integer', min: 1, max: 100 },
      { key: 'bg_prompt_tail_chars', label: 'BG Prompt Tail Chars', kind: 'integer', min: 1 },
      { key: 'bg_output_head_bytes', label: 'BG Output Head (bytes)', kind: 'integer', min: 1 },
      { key: 'bg_output_tail_bytes', label: 'BG Output Tail (bytes)', kind: 'integer', min: 1 },
      { key: 'read_output_long_poll_max', label: 'Read Output Long Poll Max (s)', kind: 'number', min: 1 },
    ],
  },
  {
    title: 'MCP',
    fields: [
      { key: 'mcp_startup_timeout', label: 'MCP Startup Timeout (s)', kind: 'number', min: 1 },
      { key: 'mcp_per_server_timeout', label: 'MCP Per-Server Timeout (s)', kind: 'number', min: 1 },
      { key: 'mcp_result_max_bytes', label: 'MCP Result Max (bytes)', kind: 'integer', min: 1 },
    ],
  },
  {
    title: 'RAG',
    fields: [
      { key: 'rag.chunk_size', label: 'Chunk Size (tokens)', kind: 'integer', min: 100, max: 10000 },
      { key: 'rag.chunk_overlap', label: 'Chunk Overlap (tokens)', kind: 'integer', min: 0, max: 2000 },
      { key: 'rag.top_k', label: 'Top K Results', kind: 'integer', min: 1, max: 50 },
      { key: 'rag.max_file_size', label: 'Max File Size (bytes)', kind: 'integer', min: 1024 },
      { key: 'rag.embedding_threads', label: 'Embedding Threads', kind: 'integer', min: 1, max: 64 },
      { key: 'rag.embedding_batch_size', label: 'Embedding Batch Size', kind: 'integer', min: 1, max: 256 },
      { key: 'rag.embedding_api_timeout', label: 'Embedding API Timeout (s)', kind: 'number', min: 1 },
      { key: 'rag.embedding_api_retries', label: 'Embedding API Retries', kind: 'integer', min: 0, max: 10 },
    ],
  },
];

const ALL_FIELD_KEYS = SECTIONS.flatMap((section) => section.fields.map((field) => field.key));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStoredOverride(overrides: Record<string, unknown>, key: string): unknown {
  if (key.startsWith('rag.')) {
    const rag = overrides['rag'];
    return isPlainRecord(rag) ? rag[key.slice(4)] : undefined;
  }
  return overrides[key];
}

function readGlobalValue(config: Config | null, key: string): unknown {
  if (!config) return undefined;
  if (key.startsWith('rag.')) {
    return config.rag[key.slice(4) as keyof RAGConfig];
  }
  return config[key as keyof Config];
}

function toInputValue(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  return String(value);
}

function fieldInputId(key: string): string {
  return `project-config-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

export function ProjectConfigView({ projectDir, onNewChat, onClose }: ProjectConfigViewProps) {
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [globalConfig, setGlobalConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = useMemo(
    () => projectDir.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? projectDir,
    [projectDir],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft({});
    async function load() {
      try {
        if (!window.orchid?.config?.readProject || !window.orchid?.config?.get) {
          throw new Error('Configuration API is not available.');
        }
        const [project, merged] = await Promise.all([
          window.orchid.config.readProject(projectDir),
          window.orchid.config.get(),
        ]);
        if (cancelled) return;
        setOverrides(isPlainRecord(project.overrides) ? project.overrides : {});
        setGlobalConfig(merged);
      } catch {
        if (!cancelled) setError('Failed to load project configuration.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const effectiveValue = useCallback(
    (key: string): unknown => (key in draft ? draft[key] : readStoredOverride(overrides, key)),
    [draft, overrides],
  );

  const dirty = useMemo(
    () => Object.entries(draft).some(([key, value]) => (
      (value ?? undefined) !== (readStoredOverride(overrides, key) ?? undefined)
    )),
    [draft, overrides],
  );

  const overrideCount = useMemo(
    () => ALL_FIELD_KEYS.filter((key) => effectiveValue(key) != null).length,
    [effectiveValue],
  );

  const handleFieldChange = useCallback((field: ProjectFieldSpec, raw: string) => {
    const trimmed = raw.trim();
    setDraft((previous) => {
      if (trimmed === '') return { ...previous, [field.key]: null };
      if (field.kind === 'text') return { ...previous, [field.key]: trimmed };
      const num = parseConfigNumber(
        trimmed,
        field.min ?? 0,
        field.kind === 'integer' ? { integer: true } : undefined,
      );
      if (num === null) return previous;
      return { ...previous, [field.key]: num };
    });
  }, []);

  const handleFieldReset = useCallback((key: string) => {
    setDraft((previous) => ({ ...previous, [key]: null }));
  }, []);

  const handleResetAll = useCallback(() => {
    setDraft((previous) => {
      const next = { ...previous };
      for (const key of ALL_FIELD_KEYS) next[key] = null;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    if (!window.orchid?.config?.saveProject || !window.orchid?.config?.readProject) {
      setError('Configuration API is not available.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updates: Record<string, unknown> = {};
      const ragUpdates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(draft)) {
        const stored = readStoredOverride(overrides, key);
        if ((value ?? undefined) === (stored ?? undefined)) continue;
        if (key.startsWith('rag.')) ragUpdates[key.slice(4)] = value;
        else updates[key] = value;
      }
      if (Object.keys(ragUpdates).length > 0) updates['rag'] = ragUpdates;
      await window.orchid.config.saveProject({ projectDir, updates });
      const result = await window.orchid.config.readProject(projectDir);
      setOverrides(isPlainRecord(result.overrides) ? result.overrides : {});
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project configuration.');
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, overrides, projectDir]);

  useGlobalShortcuts({
    handlers: {
      'config.save': () => {
        void handleSave();
      },
      'config.close': () => {
        onClose();
      },
    },
    isEnabled: () => document.documentElement.dataset.orchidSettingsOpen !== '1',
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base-100 text-base-content">
      <header className="config-main-header">
        <div className="config-main-header-text">
          <h1 className="truncate" title={projectName}>{projectName}</h1>
          <p className="truncate" title={projectDir}>Project overrides · {projectDir}</p>
        </div>
        <div className="config-main-header-actions">
          {dirty && (
            <StatusBadge tone="warning" size="sm" outline>
              Unsaved
            </StatusBadge>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            onClick={() => onNewChat(projectDir)}
          >
            New Chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResetAll}
            disabled={loading || (!dirty && overrideCount === 0)}
          >
            Reset All
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving}
            loading={saving}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onClose}>
            Back
          </Button>
        </div>
      </header>

      {error && (
        <Alert
          tone="error"
          className="rounded-none py-2.5 text-sm"
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

      <div className="config-body">
        {loading ? (
          <StateMessage kind="loading" title="Loading project configuration…" />
        ) : (
          <div className="config-form flex flex-col gap-4">
            {SECTIONS.map((section) => (
              <Panel key={section.title} as="section" className="config-fieldset flex flex-col gap-3">
                <SectionHeader title={section.title} />
                <div className="config-form-grid">
                  {section.fields.map((field) => {
                    const value = effectiveValue(field.key);
                    const globalValue = readGlobalValue(globalConfig, field.key);
                    const inputId = fieldInputId(field.key);
                    return (
                      <FormField
                        key={field.key}
                        label={field.label}
                        htmlFor={inputId}
                        className={`config-field${field.fullWidth ? ' config-form-grid-full' : ''}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <TextInput
                            id={inputId}
                            type={field.kind === 'text' ? 'text' : 'number'}
                            value={toInputValue(value)}
                            placeholder={globalValue == null ? '' : String(globalValue)}
                            onChange={(event) => handleFieldChange(field, event.target.value)}
                            bordered
                            className="w-full"
                            min={field.kind === 'text' ? undefined : field.min}
                            max={field.max}
                            step={field.step}
                          />
                          <Button
                            variant="ghost"
                            size="xs"
                            shape="circle"
                            icon="x"
                            iconSize={11}
                            iconOnly
                            aria-label={`Reset ${field.label} to global`}
                            title="Remove override (inherit global)"
                            className={`shrink-0${value != null ? '' : ' invisible'}`}
                            onClick={() => handleFieldReset(field.key)}
                          >
                            Reset
                          </Button>
                        </div>
                      </FormField>
                    );
                  })}
                </div>
              </Panel>
            ))}
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
          <span>back</span>
        </span>
        <span className="config-footer-meta">
          {overrideCount} override{overrideCount === 1 ? '' : 's'} · stored in .orchid.json
        </span>
      </footer>
    </div>
  );
}
