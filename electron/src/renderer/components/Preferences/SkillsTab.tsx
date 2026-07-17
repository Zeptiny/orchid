/**
 * SkillsTab — list / add / edit / delete skills at global or project scope.
 *
 * Saves immediately via IPC (not the JSON config draft).
 * Receives preloaded definitions data from ConfigView to avoid tab-switch flicker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DefinitionScope,
  DefinitionsListResult,
  ManagedSkill,
} from '../../../shared/types/definitions';
import { DefinitionActions } from './DefinitionActions';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { MultiSelectList } from './MultiSelectList';
import { ScopeBadge, ScopeToggle, type ScopeFilter } from './ScopeToggle';

export interface SkillsTabProps {
  data: DefinitionsListResult;
  onReload: () => Promise<void>;
}

interface SkillForm {
  name: string;
  description: string;
  requires: string[];
  content: string;
  scope: DefinitionScope;
  previousName?: string;
}

function toForm(s: ManagedSkill): SkillForm {
  return {
    name: s.name,
    description: s.description,
    requires: [...s.requires],
    content: s.content,
    scope: s.scope,
    previousName: s.name,
  };
}

function emptyForm(scope: DefinitionScope): SkillForm {
  return {
    name: '',
    description: '',
    requires: [],
    content: '# Skill workflow\n\nDescribe the multi-step workflow here.\n',
    scope,
  };
}

export function SkillsTab({ data, onReload }: SkillsTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<SkillForm | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const clear = () => {
      setEditingKey(null);
      setIsAdding(false);
      setForm(null);
    };
    window.addEventListener('orchid:definitions-workspace-changed', clear);
    return () => window.removeEventListener('orchid:definitions-workspace-changed', clear);
  }, []);

  const skills = data.skills;
  const projectDir = data.projectDir;
  const projectAvailable = projectDir != null;

  const effectiveFilter: ScopeFilter =
    filter === 'project' && !projectAvailable ? 'all' : filter;

  const visible = useMemo(() => {
    if (effectiveFilter === 'all') return skills;
    return skills.filter((s) => s.scope === effectiveFilter);
  }, [skills, effectiveFilter]);

  // Skill dependency options: unique names, excluding the skill being edited
  const skillNameOptions = useMemo(() => {
    const names = new Set(data.availableSkills);
    if (form?.previousName) names.delete(form.previousName);
    if (form?.name) names.delete(form.name.trim().toLowerCase());
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data.availableSkills, form?.previousName, form?.name]);

  const entryKey = (s: ManagedSkill) => `${s.scope}:${s.name}`;

  const startEdit = useCallback((s: ManagedSkill) => {
    setIsAdding(false);
    setEditingKey(entryKey(s));
    setForm(toForm(s));
  }, []);

  const startAdd = useCallback(() => {
    const scope: DefinitionScope =
      effectiveFilter === 'project' && projectAvailable ? 'project' : 'global';
    setEditingKey(null);
    setIsAdding(true);
    setForm(emptyForm(scope));
  }, [effectiveFilter, projectAvailable]);

  const cancel = useCallback(() => {
    setEditingKey(null);
    setIsAdding(false);
    setForm(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form || !window.orchid?.skill?.save) return;
    setSaving(true);
    setError(null);
    try {
      await window.orchid.skill.save({
        scope: form.scope,
        name: form.name.trim(),
        description: form.description.trim(),
        requires: form.requires,
        content: form.content,
        previousName: form.previousName,
      });
      cancel();
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  }, [form, cancel, onReload]);

  const handleDelete = useCallback(
    async (s: ManagedSkill) => {
      if (!window.orchid?.skill?.delete) return;
      const ok = window.confirm(
        `Delete skill "${s.name}" from ${s.scope} scope? This cannot be undone.`,
      );
      if (!ok) return;
      setError(null);
      try {
        await window.orchid.skill.delete({ scope: s.scope, name: s.name });
        if (editingKey === entryKey(s)) cancel();
        await onReload();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete skill');
      }
    },
    [editingKey, cancel, onReload],
  );

  const handleReveal = useCallback(async (s: ManagedSkill) => {
    try {
      await window.orchid?.definitions?.reveal({ path: s.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal path');
    }
  }, []);

  const renderForm = (f: SkillForm, title: string) => (
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
            placeholder="my-skill"
          />
          <span className="label py-0 text-base-content/60">
            Lowercase letters, digits, hyphens, underscores
          </span>
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
            <option value="global">Global (~/.orchid/skills)</option>
            <option value="project" disabled={!projectAvailable}>
              Project (.orchid/skills)
            </option>
          </select>
        </div>
        <div className="config-field config-form-grid-full">
          <label>Description</label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={f.description}
            onChange={(e) => setForm({ ...f, description: e.target.value })}
            placeholder="When to use this skill…"
          />
        </div>
        <div className="config-field config-form-grid-full">
          <label>Requires (dependency skills)</label>
          <MultiSelectList
            options={skillNameOptions}
            selected={f.requires}
            onChange={(requires) => setForm({ ...f, requires })}
            emptyLabel="No other skills available"
            maxHeightClass="max-h-36"
          />
        </div>
        <div className="config-field config-form-grid-full">
          <label>Skill body (markdown workflow)</label>
          <textarea
            className="textarea textarea-bordered w-full font-mono text-xs"
            rows={12}
            value={f.content}
            onChange={(e) => setForm({ ...f, content: e.target.value })}
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
          disabled={saving || !f.name.trim() || !f.description.trim()}
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
          title="Skills"
          actions={
            !isAdding && !editingKey ? (
              <button
                className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10"
                type="button"
                onClick={startAdd}
              >
                + Add Skill
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
          {visible.map((s) => (
            <div key={entryKey(s)} className="config-card card bg-base-100 border border-base-300">
              {editingKey === entryKey(s) && form ? (
                renderForm(form, '')
              ) : (
                <div className="config-card-row flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="config-card-title font-semibold">{s.name}</div>
                      <ScopeBadge
                        scope={s.scope}
                        overriddenByProject={s.overriddenByProject}
                      />
                    </div>
                    <p className="config-card-desc text-sm text-base-content/70 line-clamp-2">{s.description}</p>
                    {s.requires.length > 0 && (
                      <p className="config-card-desc text-sm text-base-content/70 mt-1">
                        requires: {s.requires.join(', ')}
                      </p>
                    )}
                    {s.resources.length > 0 && (
                      <p className="config-card-desc text-sm text-base-content/70 mt-1">
                        {s.resources.length} resource
                        {s.resources.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                  <DefinitionActions
                    onReveal={() => void handleReveal(s)}
                    onEdit={() => startEdit(s)}
                    onDelete={() => void handleDelete(s)}
                  />
                </div>
              )}
            </div>
          ))}

          {isAdding && form && (
            <div className="config-card card border border-primary/30 bg-primary/5">
              {renderForm(form, 'New Skill')}
            </div>
          )}

          {!isAdding && visible.length === 0 && (
            <StateMessage kind="empty" title="No skills in this view. Add one or switch scope filter." className="py-4" />
          )}
        </div>

        <div className="config-note text-xs text-base-content/60 mt-2">
          Project skills override global skills with the same name. Resource
          files (scripts/, references/, assets/) can be managed via Reveal →
          open folder.
        </div>
      </Panel>
    </div>
  );
}
