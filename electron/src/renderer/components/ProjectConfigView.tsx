import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config, PermissionRule, RAGConfig } from '../../shared/types/ipc-boundary';
import type { ConfigPatch, ConfigPatchMap } from '../../shared/types/ipc';
import { useGlobalShortcuts } from '../keyboard';
import { THEMES, THEME_NAMES, type ThemeName } from '../themes';
import { parseConfigNumber } from '../utils/config-draft';
import { AgentsTab } from './Preferences/AgentsTab';
import { PermissionsTab } from './Preferences/PermissionsTab';
import { PersonalitiesTab } from './Preferences/PersonalitiesTab';
import { SkillsTab } from './Preferences/SkillsTab';
import { Keycaps } from './Keycaps';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Panel } from './ui/Panel';
import { SectionHeader } from './ui/SectionHeader';
import { Select } from './ui/Select';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';
import { Tabs } from './ui/Tabs';
import { TextInput } from './ui/TextInput';

/** Props for {@link ProjectConfigView}. */
export interface ProjectConfigViewProps {
  /** Absolute directory of the project whose config is being edited. */
  projectDir: string;
  /** Called to start a new chat bound to the given project directory. */
  onNewChat: (projectDir: string) => void;
  /** Called to dismiss the config view. */
  onClose: () => void;
}

type ProjectTab =
  | 'general'
  | 'permissions'
  | 'mcp'
  | 'tiers'
  | 'rag'
  | 'skills'
  | 'agents'
  | 'personalities'
  | 'compaction';

interface ProjectTabDef {
  id: ProjectTab;
  label: string;
}

const PROJECT_TABS: ProjectTabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'tiers', label: 'Tier Models' },
  { id: 'rag', label: 'RAG' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'personalities', label: 'Personalities' },
];

type ProjectFieldKind =
  | 'number'
  | 'integer'
  | 'text'
  | 'string-list'
  | 'boolean'
  | 'theme'
  | 'personality'
  | 'select';

interface ProjectFieldSpec {
  key: string;
  label: string;
  kind: ProjectFieldKind;
  min?: number;
  max?: number;
  step?: number;
  fullWidth?: boolean;
  hint?: string;
  options?: string[];
}

interface ProjectConfigSection {
  title: string;
  fields: ProjectFieldSpec[];
}

const COMPACTION_HYSTERESIS_HINT =
  'Hysteresis prevents thrashing. After compaction, usage must drop below threshold - delta (re-arm line) before re-firing. Or, growth of min_compactable_tokens since post-compaction baseline re-arms even while above threshold. 0.1 = 10% buffer. Higher = less frequent.';

const TAB_SECTIONS: Partial<Record<ProjectTab, ProjectConfigSection[]>> = {
  general: [
    {
      title: 'General',
      fields: [
        { key: 'theme', label: 'Theme', kind: 'theme' },
        { key: 'personality', label: 'Personality', kind: 'personality' },
        { key: 'ignored_dirs', label: 'Ignored Directories', kind: 'string-list', fullWidth: true },
        { key: 'always_expand_tool_groups', label: 'Always Expand Tool Groups', kind: 'boolean' },
      ],
    },
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
  ],
  mcp: [
    {
      title: 'MCP',
      fields: [
        { key: 'mcp_startup_timeout', label: 'MCP Startup Timeout (s)', kind: 'number', min: 1 },
        { key: 'mcp_per_server_timeout', label: 'MCP Per-Server Timeout (s)', kind: 'number', min: 1 },
        { key: 'mcp_result_max_bytes', label: 'MCP Result Max (bytes)', kind: 'integer', min: 1 },
      ],
    },
  ],
  rag: [
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
  ],
  compaction: [
    {
      title: 'Main Scope',
      fields: [
        { key: 'compaction.main.mode', label: 'Mode (main)', kind: 'select', options: ['simple', 'selective'] },
        { key: 'compaction.main.threshold', label: 'Threshold (main)', kind: 'number', min: 0.1, max: 0.95, step: 0.05 },
        { key: 'compaction.main.keep_recent_chains', label: 'Keep Recent Chains (main)', kind: 'integer', min: 0, max: 100 },
        { key: 'compaction.main.min_compactable_tokens', label: 'Min Compactable Tokens (main)', kind: 'integer', min: 0, max: 1_000_000 },
        { key: 'compaction.main.mechanical_reclaim', label: 'Mechanical Reclaim (main)', kind: 'boolean' },
        { key: 'compaction.main.hysteresis_delta', label: 'Hysteresis Delta (main)', kind: 'number', min: 0, max: 0.5, step: 0.05, hint: COMPACTION_HYSTERESIS_HINT },
      ],
    },
    {
      title: 'Subagents Scope',
      fields: [
        { key: 'compaction.subagents.mode', label: 'Mode (subagents)', kind: 'select', options: ['simple', 'selective'] },
        { key: 'compaction.subagents.threshold', label: 'Threshold (subagents)', kind: 'number', min: 0.1, max: 0.95, step: 0.05 },
        { key: 'compaction.subagents.keep_recent_chains', label: 'Keep Recent Chains (subagents)', kind: 'integer', min: 0, max: 100 },
        { key: 'compaction.subagents.min_compactable_tokens', label: 'Min Compactable Tokens (subagents)', kind: 'integer', min: 0, max: 1_000_000 },
        { key: 'compaction.subagents.mechanical_reclaim', label: 'Mechanical Reclaim (subagents)', kind: 'boolean' },
        { key: 'compaction.subagents.hysteresis_delta', label: 'Hysteresis Delta (subagents)', kind: 'number', min: 0, max: 0.5, step: 0.05, hint: COMPACTION_HYSTERESIS_HINT },
      ],
    },
  ],
};

const ALL_FIELD_KEYS = Object.values(TAB_SECTIONS).flatMap((sections) => (
  (sections ?? []).flatMap((section) => section.fields.map((field) => field.key))
));

/** Type guard for a non-null, non-array plain object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a stored project override by field key, resolving `rag.*` and `compaction.*` into nested maps. */
export function readStoredOverride(overrides: Record<string, unknown>, key: string): unknown {
  if (key === 'compaction') {
    return overrides['compaction'];
  }
  if (key.startsWith('compaction.')) {
    const parts = key.slice('compaction.'.length).split('.');
    let cur: unknown = overrides['compaction'];
    for (const part of parts) {
      if (!isPlainRecord(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
  if (key.startsWith('rag.')) {
    const rag = overrides['rag'];
    return isPlainRecord(rag) ? rag[key.slice(4)] : undefined;
  }
  return overrides[key];
}

/** Read a value from the global (home) config by field key, resolving `rag.*` and `compaction.*` into nested maps. */
export function readGlobalValue(config: Config | null, key: string): unknown {
  if (!config) return undefined;
  if (key === 'compaction') {
    return (config as unknown as Record<string, unknown>)['compaction'];
  }
  if (key.startsWith('compaction.')) {
    const parts = key.slice('compaction.'.length).split('.');
    let cur: unknown = (config as unknown as Record<string, unknown>)['compaction'];
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
  if (key.startsWith('rag.')) {
    return config.rag[key.slice(4) as keyof RAGConfig];
  }
  return config[key as keyof Config];
}

/** Coerce a config value into an editable form input value (arrays become comma-separated). */
export function toInputValue(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

/** Derive a stable, DOM-safe input element id from a config field key. */
export function fieldInputId(key: string): string {
  return `project-config-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function toPlaceholder(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
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

/** Project-scoped configuration editor: views and edits per-project config overrides. */
export function ProjectConfigView({ projectDir, onNewChat, onClose }: ProjectConfigViewProps) {
  const [activeTab, setActiveTab] = useState<ProjectTab>('general');
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [homeConfig, setHomeConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [permissionDraft, setPermissionDraft] = useState<ConfigPatchMap<PermissionRule>>({});
  const [definitions, setDefinitions] = useState<DefinitionsListResult | null>(null);
  const [defsLoading, setDefsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = useMemo(
    () => projectDir.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? projectDir,
    [projectDir],
  );

  const loadDefinitions = useCallback(async () => {
    if (!window.orchid?.definitions?.list) {
      setDefsLoading(false);
      return;
    }
    try {
      const result = await window.orchid.definitions.list();
      setDefinitions(result);
    } catch {
      setDefinitions(null);
    } finally {
      setDefsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft({});
    setPermissionDraft({});
    setDefsLoading(true);
    async function load() {
      try {
        if (!window.orchid?.config?.readProject || !window.orchid?.config?.getHome) {
          throw new Error('Configuration API is not available.');
        }
        const [project, home] = await Promise.all([
          window.orchid.config.readProject(projectDir),
          window.orchid.config.getHome(),
        ]);
        if (cancelled) return;
        setOverrides(isPlainRecord(project.overrides) ? project.overrides : {});
        setHomeConfig(home);
      } catch {
        if (!cancelled) setError('Failed to load project configuration.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    void loadDefinitions();
    return () => {
      cancelled = true;
    };
  }, [projectDir, loadDefinitions]);

  const effectiveValue = useCallback(
    (key: string): unknown => (key in draft ? draft[key] : readStoredOverride(overrides, key)),
    [draft, overrides],
  );

  const configDirty = useMemo(
    () => Object.entries(draft).some(([key, value]) => (
      (value ?? undefined) !== (readStoredOverride(overrides, key) ?? undefined)
    )),
    [draft, overrides],
  );

  const storedProjectPermissions = useMemo(() => {
    const raw = overrides['permissions'];
    return isPlainRecord(raw) ? (raw as Record<string, PermissionRule>) : {};
  }, [overrides]);

  const effectiveProjectPermissions = useMemo(
    () => applyPermissionPatch(storedProjectPermissions, permissionDraft),
    [storedProjectPermissions, permissionDraft],
  );

  const permissionDirty = useMemo(
    () => Object.entries(permissionDraft).some(([key, value]) => (
      (value ?? undefined) !== (storedProjectPermissions[key] ?? undefined)
    )),
    [permissionDraft, storedProjectPermissions],
  );

  const dirty = configDirty || permissionDirty;

  const overrideCount = useMemo(
    () => ALL_FIELD_KEYS.filter((key) => effectiveValue(key) != null).length,
    [effectiveValue],
  );

  const totalOverrideCount = overrideCount + Object.keys(effectiveProjectPermissions).length;

  const personalityNames = useMemo(() => {
    const names = new Set<string>();
    if (homeConfig?.personality) names.add(homeConfig.personality);
    for (const personality of definitions?.personalities ?? []) names.add(personality.name);
    const override = effectiveValue('personality');
    if (typeof override === 'string' && override) names.add(override);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [homeConfig, definitions, effectiveValue]);

  const permissionConfig = useMemo<Config | null>(() => {
    if (!homeConfig) return null;
    const historySize = effectiveValue('permission_history_size');
    return {
      ...homeConfig,
      permissions: effectiveProjectPermissions,
      permission_history_size:
        typeof historySize === 'number' ? historySize : homeConfig.permission_history_size,
    };
  }, [homeConfig, effectiveProjectPermissions, effectiveValue]);

  const handleFieldChange = useCallback((field: ProjectFieldSpec, raw: string) => {
    const trimmed = raw.trim();
    setDraft((previous) => {
      if (trimmed === '') return { ...previous, [field.key]: null };
      switch (field.kind) {
        case 'text':
        case 'theme':
        case 'personality':
        case 'select':
          return { ...previous, [field.key]: trimmed };
        case 'boolean':
          return { ...previous, [field.key]: trimmed === 'true' };
        case 'string-list': {
          const entries = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
          return { ...previous, [field.key]: entries.length > 0 ? entries : null };
        }
        default: {
          const num = parseConfigNumber(
            trimmed,
            field.min ?? 0,
            field.kind === 'integer' ? { integer: true } : undefined,
          );
          if (num === null) return previous;
          return { ...previous, [field.key]: num };
        }
      }
    });
  }, []);

  const handleFieldReset = useCallback((key: string) => {
    setDraft((previous) => ({ ...previous, [key]: null }));
  }, []);

  const handlePermissionDraft = useCallback((updates: ConfigPatch) => {
    const { permissions, permission_history_size: historySize } = updates;
    if (permissions) {
      setPermissionDraft((previous) => ({ ...previous, ...permissions }));
    }
    if (historySize !== undefined) {
      setDraft((previous) => ({ ...previous, permission_history_size: historySize }));
    }
  }, []);

  const handleResetAll = useCallback(() => {
    setDraft((previous) => {
      const next = { ...previous };
      for (const key of ALL_FIELD_KEYS) next[key] = null;
      return next;
    });
    setPermissionDraft(() => {
      const next: Record<string, PermissionRule | null> = {};
      for (const key of Object.keys(effectiveProjectPermissions)) next[key] = null;
      return next;
    });
  }, [effectiveProjectPermissions]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    if (
      !window.orchid?.config?.saveProject ||
      !window.orchid?.config?.readProject ||
      !window.orchid?.config?.savePermissionScope
    ) {
      setError('Configuration API is not available.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updates: Record<string, unknown> = {};
      const ragUpdates: Record<string, unknown> = {};
      const compactionUpdates: Record<string, Record<string, unknown>> = {};
      for (const [key, value] of Object.entries(draft)) {
        const stored = readStoredOverride(overrides, key);
        if ((value ?? undefined) === (stored ?? undefined)) continue;
        if (key.startsWith('rag.')) ragUpdates[key.slice(4)] = value;
        else if (key.startsWith('compaction.')) {
          const remainder = key.slice('compaction.'.length);
          const parts = remainder.split('.');
          if (parts.length === 2) {
            const [scope, field] = parts;
            if (!compactionUpdates[scope]) compactionUpdates[scope] = {};
            compactionUpdates[scope][field] = value;
          } else if (parts.length === 1) {
            // shallow compaction key (unlikely with current fields) — treat as direct nested key
            if (!compactionUpdates[parts[0]]) compactionUpdates[parts[0]] = {};
            // no field, skip; top-level compaction overrides are not field-level
          }
        }
        else updates[key] = value;
      }
      if (Object.keys(ragUpdates).length > 0) updates['rag'] = ragUpdates;
      if (Object.keys(compactionUpdates).length > 0) updates['compaction'] = compactionUpdates;

      const permissionUpdates: Record<string, PermissionRule | null> = {};
      for (const [key, value] of Object.entries(permissionDraft)) {
        const stored = storedProjectPermissions[key];
        if ((value ?? undefined) === (stored ?? undefined)) continue;
        permissionUpdates[key] = value;
      }

      if (Object.keys(updates).length > 0) {
        await window.orchid.config.saveProject({ projectDir, updates });
      }
      if (Object.keys(permissionUpdates).length > 0) {
        await window.orchid.config.savePermissionScope({
          scope: 'project',
          updates: permissionUpdates,
          expectedProjectDir: projectDir,
        });
      }

      const result = await window.orchid.config.readProject(projectDir);
      setOverrides(isPlainRecord(result.overrides) ? result.overrides : {});
      setDraft({});
      setPermissionDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project configuration.');
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, overrides, permissionDraft, storedProjectPermissions, projectDir]);

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

  const showDraftControls =
    activeTab === 'general' ||
    activeTab === 'permissions' ||
    activeTab === 'mcp' ||
    activeTab === 'rag' ||
    activeTab === 'compaction';

  const renderSelectOptions = (field: ProjectFieldSpec, homeValue: unknown) => {
    if (field.kind === 'select') {
      const opts = field.options ?? [];
      const homeLabel = toPlaceholder(homeValue);
      return (
        <>
          <option value="">{homeLabel ? `Inherit global (${homeLabel})` : 'Inherit global'}</option>
          {opts.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </>
      );
    }
    if (field.kind === 'theme') {
      const homeLabel =
        typeof homeValue === 'string' && homeValue in THEMES
          ? THEMES[homeValue as ThemeName]
          : toPlaceholder(homeValue);
      return (
        <>
          <option value="">{homeLabel ? `Inherit global (${homeLabel})` : 'Inherit global'}</option>
          {THEME_NAMES.map((name) => (
            <option key={name} value={name}>
              {THEMES[name]}
            </option>
          ))}
        </>
      );
    }
    if (field.kind === 'personality') {
      const homeLabel = toPlaceholder(homeValue);
      return (
        <>
          <option value="">{homeLabel ? `Inherit global (${homeLabel})` : 'Inherit global'}</option>
          {personalityNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </>
      );
    }
    const homeLabel = homeValue == null ? '' : homeValue ? 'enabled' : 'disabled';
    return (
      <>
        <option value="">{homeLabel ? `Inherit global (${homeLabel})` : 'Inherit global'}</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </>
    );
  };

  const renderField = (field: ProjectFieldSpec) => {
    const value = effectiveValue(field.key);
    const homeValue = readGlobalValue(homeConfig, field.key);
    const inputId = fieldInputId(field.key);
    const isSelect =
      field.kind === 'boolean' ||
      field.kind === 'theme' ||
      field.kind === 'personality' ||
      field.kind === 'select';
    return (
      <FormField
        key={field.key}
        label={field.label}
        htmlFor={inputId}
        hint={field.hint}
        className={`config-field${field.fullWidth ? ' config-form-grid-full' : ''}`}
      >
        <div className="flex items-center gap-1.5">
          {isSelect ? (
            <Select
              id={inputId}
              value={value == null ? '' : String(value)}
              onChange={(event) => handleFieldChange(field, event.target.value)}
              bordered
              className="w-full"
            >
              {renderSelectOptions(field, homeValue)}
            </Select>
          ) : (
            <TextInput
              id={inputId}
              type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
              value={toInputValue(value)}
              placeholder={toPlaceholder(homeValue)}
              onChange={(event) => handleFieldChange(field, event.target.value)}
              bordered
              className="w-full"
              min={field.kind === 'number' || field.kind === 'integer' ? field.min : undefined}
              max={field.max}
              step={field.step}
            />
          )}
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
  };

  const renderConfigTab = (tab: ProjectTab) => {
    const sections = TAB_SECTIONS[tab];
    if (!sections) return null;
    return (
      <div className="config-form flex flex-col gap-4">
        {sections.map((section) => (
          <Panel key={section.title} as="section" className="config-fieldset flex flex-col gap-3">
            <SectionHeader title={section.title} />
            <div className="config-form-grid">
              {section.fields.map(renderField)}
            </div>
          </Panel>
        ))}
      </div>
    );
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'general':
      case 'mcp':
      case 'rag':
      case 'compaction':
        return renderConfigTab(activeTab);
      case 'permissions':
        if (!permissionConfig) {
          return (
            <StateMessage kind="warning" title="Project permissions could not be loaded." />
          );
        }
        return (
          <PermissionsTab
            config={permissionConfig}
            updateDraft={handlePermissionDraft}
            lockedScope="project"
            projectDir={projectDir}
            inheritedPermissions={homeConfig?.permissions ?? {}}
          />
        );
      case 'tiers':
        return (
          <StateMessage kind="info" title="Tier models are configured globally">
            Model and reasoning effort assignments apply to every project. Open the global
            Configuration view to change them.
          </StateMessage>
        );
      case 'skills':
        if (!definitions) {
          return defsLoading ? (
            <StateMessage kind="loading" title="Loading skills…" />
          ) : (
            <StateMessage kind="warning" title="Skills could not be loaded." />
          );
        }
        return <SkillsTab data={definitions} onReload={loadDefinitions} lockedScope="project" />;
      case 'agents':
        if (!definitions) {
          return defsLoading ? (
            <StateMessage kind="loading" title="Loading agents…" />
          ) : (
            <StateMessage kind="warning" title="Agents could not be loaded." />
          );
        }
        return (
          <AgentsTab
            data={definitions}
            tierModels={homeConfig?.tier_models ?? {}}
            onReload={loadDefinitions}
            lockedScope="project"
          />
        );
      case 'personalities':
        if (!definitions) {
          return defsLoading ? (
            <StateMessage kind="loading" title="Loading personalities…" />
          ) : (
            <StateMessage kind="warning" title="Personalities could not be loaded." />
          );
        }
        return (
          <PersonalitiesTab data={definitions} onReload={loadDefinitions} lockedScope="project" />
        );
    }
  };

  return (
    <div className="orchid-view-enter flex min-h-0 min-w-0 flex-1 flex-col bg-base-100 text-base-content">
      <header className="config-main-header">
        <div className="config-main-header-text">
          <h1 className="truncate" title={projectName}>{projectName}</h1>
          <p className="truncate" title={projectDir}>Project overrides · {projectDir}</p>
        </div>
        <div className="config-main-header-actions">
          {showDraftControls && dirty && (
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
          {showDraftControls && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetAll}
              disabled={loading || (!dirty && totalOverrideCount === 0)}
            >
              Reset All
            </Button>
          )}
          {showDraftControls && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
              loading={saving}
            >
              Save
            </Button>
          )}
          <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onClose}>
            Back
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
        items={PROJECT_TABS}
        value={activeTab}
        onValueChange={(id) => setActiveTab(id as ProjectTab)}
        variant="boxed"
        className="config-tabs bg-base-200"
        itemClassName="config-tab"
        activeItemClassName="config-tab-active"
        aria-label="Project configuration sections"
      />

      <div className="config-body">
        <div key={activeTab} className="orchid-view-enter">
        {loading ? (
          <StateMessage kind="loading" title="Loading project configuration…" />
        ) : (
          renderTab()
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
          <span>back</span>
        </span>
        <span className="config-footer-meta">
          {totalOverrideCount} override{totalOverrideCount === 1 ? '' : 's'} · stored in .orchid.json
        </span>
      </footer>
    </div>
  );
}
