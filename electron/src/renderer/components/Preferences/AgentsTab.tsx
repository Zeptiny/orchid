/**
 * AgentsTab — list / add / edit / delete agents at global or project scope.
 *
 * Internal agents are listed first — editable in place, not deletable/renamable.
 * New agents are always type=subagent; type is not user-editable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentTier,
  AgentType,
} from '../../../shared/types/agent';
import type {
  DefinitionScope,
  DefinitionsListResult,
  ManagedAgent,
} from '../../../shared/types/definitions';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { reasoningConfigForSelection } from '../../utils/provider-selection';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { ConfigCard } from '../ui/ConfigCard';
import { DefinitionActions } from './DefinitionActions';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';
import { TextInput } from '../ui/TextInput';
import { MultiSelectList } from './MultiSelectList';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { ScopeBadge, ScopeToggle, type ScopeFilter } from './ScopeToggle';
import { TierPicker } from './TierPicker';

export interface AgentsTabProps {
  data: DefinitionsListResult;
  /** Tier → model assignments used to derive each agent's reasoning levels. */
  tierModels: Record<string, ModelSelection | null>;
  /** Re-fetch after mutations (parent owns cache). */
  onReload: () => Promise<void>;
}

interface AgentForm {
  name: string;
  type: AgentType;
  tier: AgentTier;
  description: string;
  system_prompt: string;
  allowedTools: string[];
  allowedSkills: string[];
  reasoning_effort?: string | number;
  scope: DefinitionScope;
  previousName?: string;
}

const DEFAULT_TOOLS = [
  'read',
  'read_directory',
  'glob',
  'grep',
  'edit',
  'write',
  'execute_command',
];

function toForm(a: ManagedAgent): AgentForm {
  return {
    name: a.name,
    type: a.type,
    tier: a.tier,
    description: a.description,
    system_prompt: a.system_prompt,
    allowedTools: [...a.allowed_tools],
    allowedSkills: [...a.allowed_skills],
    reasoning_effort: a.reasoning_effort,
    scope: a.scope,
    previousName: a.name,
  };
}

function emptyForm(scope: DefinitionScope, availableTools: readonly string[]): AgentForm {
  const defaults = DEFAULT_TOOLS.filter((t) => availableTools.includes(t));
  return {
    name: '',
    type: AgentType.SUBAGENT,
    tier: AgentTier.BLOOM,
    description: '',
    system_prompt: 'You are a specialized subagent.\n',
    allowedTools: defaults.length > 0 ? defaults : [...availableTools.slice(0, 8)],
    allowedSkills: ['*'],
    reasoning_effort: undefined,
    scope,
  };
}

function sortAgents(list: readonly ManagedAgent[]): ManagedAgent[] {
  return [...list].sort((a, b) => {
    // Internal first, then subagents
    if (a.type !== b.type) {
      return a.type === AgentType.INTERNAL ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function AgentsTab({ data, tierModels, onReload }: AgentsTabProps) {
  const providers = useProviders();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // Warm the shared model catalog so tier reasoning levels can be derived.
  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  // Cancel open forms when workspace rebinds (project path would otherwise drift).
  useEffect(() => {
    const clear = () => {
      setEditingKey(null);
      setIsAdding(false);
      setForm(null);
    };
    window.addEventListener('orchid:definitions-workspace-changed', clear);
    return () => window.removeEventListener('orchid:definitions-workspace-changed', clear);
  }, []);

  const agents = data.agents;
  const projectDir = data.projectDir;
  const projectAvailable = projectDir != null;
  const availableTools = data.availableTools;
  const availableSkills = data.availableSkills;

  const effectiveFilter: ScopeFilter =
    filter === 'project' && !projectAvailable ? 'all' : filter;

  const visible = useMemo(() => {
    const filtered =
      effectiveFilter === 'all'
        ? agents
        : agents.filter((a) => a.scope === effectiveFilter);
    return sortAgents(filtered);
  }, [agents, effectiveFilter]);

  const entryKey = (a: ManagedAgent) => `${a.scope}:${a.name}`;

  const startEdit = useCallback((a: ManagedAgent) => {
    setIsAdding(false);
    setEditingKey(entryKey(a));
    setForm(toForm(a));
  }, []);

  const startAdd = useCallback(() => {
    const scope: DefinitionScope =
      effectiveFilter === 'project' && projectAvailable ? 'project' : 'global';
    setEditingKey(null);
    setIsAdding(true);
    setForm(emptyForm(scope, availableTools));
  }, [effectiveFilter, projectAvailable, availableTools]);

  const cancel = useCallback(() => {
    setEditingKey(null);
    setIsAdding(false);
    setForm(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form || !window.orchid?.agent?.save) return;
    // Preserve type when editing; new agents are always subagents.
    // Type is never user-selectable — internal stays internal on save.
    const type =
      form.previousName && form.type === AgentType.INTERNAL
        ? AgentType.INTERNAL
        : AgentType.SUBAGENT;
    setSaving(true);
    setError(null);
    try {
      await window.orchid.agent.save({
        scope: form.scope,
        name: form.name.trim(),
        type,
        tier: form.tier,
        description: form.description.trim(),
        system_prompt: form.system_prompt,
        allowed_tools: form.allowedTools,
        allowed_skills: form.allowedSkills,
        ...(form.reasoning_effort !== undefined
          ? { reasoning_effort: form.reasoning_effort }
          : {}),
        previousName: form.previousName,
      });
      cancel();
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }, [form, cancel, onReload]);

  const handleDelete = useCallback(
    async (a: ManagedAgent) => {
      if (a.type === AgentType.INTERNAL) {
        setError('Internal agents cannot be deleted.');
        return;
      }
      if (!window.orchid?.agent?.delete) return;
      const ok = window.confirm(
        `Delete agent "${a.name}" from ${a.scope} scope? This cannot be undone.`,
      );
      if (!ok) return;
      setError(null);
      try {
        await window.orchid.agent.delete({ scope: a.scope, name: a.name });
        if (editingKey === entryKey(a)) cancel();
        await onReload();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete agent');
      }
    },
    [editingKey, cancel, onReload],
  );

  const handleReveal = useCallback(async (a: ManagedAgent) => {
    try {
      await window.orchid?.definitions?.reveal({ path: a.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal path');
    }
  }, []);

  const renderForm = (f: AgentForm, title: string) => {
    const reasoning = reasoningConfigForSelection(
      tierModels[f.tier] ?? null,
      providers.overview?.connections ?? [],
      providers.modelOptions ?? [],
    );
    const showReasoning = reasoning.supportsReasoning && reasoning.levels.length > 0;
    return (
    <div className="flex flex-col gap-4">
      {title && <div className="config-card-title text-primary">{title}</div>}
      <div className="config-form-grid">
        <div className="config-field">
          <label>Name</label>
          <TextInput
            type="text"
            bordered
            className="w-full"
            value={f.name}
            onChange={(e) => setForm({ ...f, name: e.target.value })}
            placeholder="my-agent"
            disabled={f.type === AgentType.INTERNAL && Boolean(f.previousName)}
            title={
              f.type === AgentType.INTERNAL && f.previousName
                ? 'Internal agent names cannot be changed'
                : undefined
            }
          />
        </div>
        <div className="config-field">
          <label>Scope</label>
          <Select
            bordered
            className="w-full"
            value={f.scope}
            onChange={(e) =>
              setForm({ ...f, scope: e.target.value as DefinitionScope })
            }
            disabled={Boolean(f.previousName)}
            title={
              f.previousName
                ? 'Scope is fixed when editing; use Add to create in another scope'
                : undefined
            }
          >
            <option value="global">Global (~/.orchid/agents)</option>
            <option value="project" disabled={!projectAvailable}>
              Project (.orchid/agents)
            </option>
          </Select>
        </div>
        <div className="config-field">
          <label>Type</label>
          <TextInput
            type="text"
            bordered
            className="w-full opacity-80"
            value={f.type}
            disabled
            readOnly
            title={
              f.type === AgentType.INTERNAL
                ? 'Internal type is fixed. Internal agents can be edited but not deleted.'
                : 'New agents are always subagents. Type is not user-editable.'
            }
          />
          <span className="label py-0 text-base-content/60">
            {f.type === AgentType.INTERNAL
              ? 'Internal — editable, not deletable'
              : 'Subagent — type is fixed'}
          </span>
        </div>
        <div className="config-field">
          <label>Tier</label>
          <TierPicker
            value={f.tier}
            onChange={(tier) => setForm({ ...f, tier, reasoning_effort: undefined })}
          />
        </div>
        {showReasoning && (
          <div className="config-field">
            <label>Reasoning effort</label>
            <ReasoningEffortPicker
              levels={reasoning.levels}
              value={f.reasoning_effort ?? null}
              onChange={(value) =>
                setForm({ ...f, reasoning_effort: value ?? undefined })
              }
              label="Agent reasoning effort"
              className="w-full"
            />
          </div>
        )}
        <div className="config-field config-form-grid-full">
          <label>Description</label>
          <TextInput
            type="text"
            bordered
            className="w-full"
            value={f.description}
            onChange={(e) => setForm({ ...f, description: e.target.value })}
            placeholder="When to use this agent…"
          />
        </div>
        <div className="config-field config-form-grid-full">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="config-field">
              <label>Allowed tools</label>
              <MultiSelectList
                options={availableTools}
                selected={f.allowedTools}
                onChange={(allowedTools) => setForm({ ...f, allowedTools })}
                emptyLabel="No tools registered yet"
                maxHeightClass="max-h-80"
              />
            </div>
            <div className="config-field">
              <label>Allowed skills</label>
              <MultiSelectList
                options={availableSkills}
                selected={f.allowedSkills}
                onChange={(allowedSkills) => setForm({ ...f, allowedSkills })}
                leadingOptions={['*']}
                optionLabels={{ '*': '* (all skills)' }}
                emptyLabel="No skills available"
                maxHeightClass="max-h-80"
              />
            </div>
          </div>
        </div>
        <div className="config-field config-form-grid-full">
          <label>System prompt</label>
          <textarea
            className="textarea textarea-bordered w-full font-mono text-xs"
            rows={10}
            value={f.system_prompt}
            onChange={(e) => setForm({ ...f, system_prompt: e.target.value })}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={() => void handleSave()}
          loading={saving}
          disabled={
            !f.name.trim() ||
            !f.description.trim() ||
            f.allowedTools.length === 0
          }
          >
            Save
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Agents"
          actions={
            !isAdding && !editingKey ? (
              <Button
                variant="ghost"
                size="xs"
                className="font-normal text-primary hover:bg-primary/10"
                type="button"
                onClick={startAdd}
              >
                + Add Agent
              </Button>
            ) : undefined
          }
        />

        <div className="config-scope-bar">
          <ScopeToggle
            value={effectiveFilter}
            onChange={setFilter}
            projectAvailable={projectAvailable}
            projectDir={projectDir}
          />
        </div>

        {error && (
          <Alert tone="error" className="py-2 text-sm mb-3" action={
            <Button variant="ghost" size="xs" type="button" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }>
            {error}
          </Alert>
        )}

        <div className="config-card-list">
          {visible.map((a) => {
            const isInternal = a.type === AgentType.INTERNAL;
            return (
              <ConfigCard key={entryKey(a)}>
                {editingKey === entryKey(a) && form ? (
                  renderForm(form, '')
                ) : (
                  <div className="config-card-row flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="config-card-title font-semibold">{a.name}</div>
                        <ScopeBadge
                          scope={a.scope}
                          overriddenByProject={a.overriddenByProject}
                        />
                        <StatusBadge tone="neutral" size="xs" outline>{a.type}</StatusBadge>
                        <StatusBadge tone="neutral" size="xs" outline>{a.tier}</StatusBadge>
                        {isInternal && (
                          <StatusBadge
                            tone="neutral"
                            size="xs"
                            outline
                            className="opacity-70"
                            title="Internal agents can be edited but not deleted"
                          >
                            no delete
                          </StatusBadge>
                        )}
                      </div>
                      <p className="config-card-desc text-sm text-base-content/70 line-clamp-2">{a.description}</p>
                      <p className="config-card-desc text-sm text-base-content/70 mt-1">
                        {a.allowed_tools.length} tools · {a.allowed_skills.join(', ') || '—'} skills
                      </p>
                    </div>
                    <DefinitionActions
                      onReveal={() => void handleReveal(a)}
                      onEdit={() => startEdit(a)}
                      onDelete={
                        isInternal ? undefined : () => void handleDelete(a)
                      }
                    />
                  </div>
                )}
              </ConfigCard>
            );
          })}

          {isAdding && form && (
            <ConfigCard variant="active">
              {renderForm(form, 'New Agent')}
            </ConfigCard>
          )}

          {!isAdding && visible.length === 0 && (
            <StateMessage kind="empty" title="No agents in this view. Add one or switch scope filter." className="py-4" />
          )}
        </div>

        <div className="config-note text-xs text-base-content/60 mt-2">
          Internal agents are listed first — they can be edited but not deleted.
          New agents are always subagents. Project agents override global ones with
          the same name.
        </div>
      </Panel>
    </div>
  );
}
