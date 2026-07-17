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
import { DefinitionActions } from './DefinitionActions';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';
import { MultiSelectList } from './MultiSelectList';
import { ScopeBadge, ScopeToggle, type ScopeFilter } from './ScopeToggle';
import { TierPicker } from './TierPicker';

export interface AgentsTabProps {
  data: DefinitionsListResult;
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

export function AgentsTab({ data, onReload }: AgentsTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const renderForm = (f: AgentForm, title: string) => (
    <div className="flex flex-col gap-4">
      {title && <div className="config-card-title text-primary">{title}</div>}
      <div className="config-form-grid">
        <div className="config-field">
          <label>Name</label>
          <input
            type="text"
            className="input input-bordered w-full"
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
          <select
            className="select select-bordered w-full"
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
          </select>
        </div>
        <div className="config-field">
          <label>Type</label>
          <input
            type="text"
            className="input input-bordered w-full opacity-80"
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
            onChange={(tier) => setForm({ ...f, tier })}
          />
        </div>
        <div className="config-field config-form-grid-full">
          <label>Description</label>
          <input
            type="text"
            className="input input-bordered w-full"
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
        <button className="btn btn-ghost btn-sm" type="button" onClick={cancel}>
          Cancel
        </button>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={() => void handleSave()}
          disabled={
            saving ||
            !f.name.trim() ||
            !f.description.trim() ||
            f.allowedTools.length === 0
          }
        >
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save
        </button>
      </div>
    </div>
  );

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Agents"
          actions={
            !isAdding && !editingKey ? (
              <button
                className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10"
                type="button"
                onClick={startAdd}
              >
                + Add Agent
              </button>
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
          <div className="alert alert-error py-2 text-sm mb-3">
            <span>{error}</span>
            <button className="btn btn-ghost btn-xs" type="button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="config-card-list">
          {visible.map((a) => {
            const isInternal = a.type === AgentType.INTERNAL;
            return (
              <div key={entryKey(a)} className="config-card card bg-base-100 border border-base-300">
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
              </div>
            );
          })}

          {isAdding && form && (
            <div className="config-card card border border-primary/30 bg-primary/5">
              {renderForm(form, 'New Agent')}
            </div>
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
