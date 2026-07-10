/**
 * PersonalitiesTab — list / add / edit / delete personalities.
 *
 * Receives preloaded definitions data from ConfigView to avoid tab-switch flicker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DefinitionScope,
  DefinitionsListResult,
  ManagedPersonality,
} from '../../../shared/types/definitions';
import { DefinitionActions } from './DefinitionActions';
import { ScopeBadge, ScopeToggle, type ScopeFilter } from './ScopeToggle';

export interface PersonalitiesTabProps {
  data: DefinitionsListResult;
  onReload: () => Promise<void>;
}

interface PersonalityForm {
  name: string;
  content: string;
  scope: DefinitionScope;
  previousName?: string;
}

function toForm(p: ManagedPersonality): PersonalityForm {
  return {
    name: p.name,
    content: p.content,
    scope: p.scope,
    previousName: p.name,
  };
}

function emptyForm(scope: DefinitionScope): PersonalityForm {
  return {
    name: '',
    content: 'Tone and style guidance for the agent.\n',
    scope,
  };
}

export function PersonalitiesTab({ data, onReload }: PersonalitiesTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<PersonalityForm | null>(null);
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

  const items = data.personalities;
  const projectDir = data.projectDir;
  const projectAvailable = projectDir != null;

  const effectiveFilter: ScopeFilter =
    filter === 'project' && !projectAvailable ? 'all' : filter;

  const visible = useMemo(() => {
    if (effectiveFilter === 'all') return items;
    return items.filter((p) => p.scope === effectiveFilter);
  }, [items, effectiveFilter]);

  const entryKey = (p: ManagedPersonality) => `${p.scope}:${p.name}`;

  const startEdit = useCallback((p: ManagedPersonality) => {
    setIsAdding(false);
    setEditingKey(entryKey(p));
    setForm(toForm(p));
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
    if (!form || !window.orchid?.personality?.save) return;
    setSaving(true);
    setError(null);
    try {
      await window.orchid.personality.save({
        scope: form.scope,
        name: form.name.trim(),
        content: form.content,
        previousName: form.previousName,
      });
      cancel();
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save personality');
    } finally {
      setSaving(false);
    }
  }, [form, cancel, onReload]);

  const handleDelete = useCallback(
    async (p: ManagedPersonality) => {
      if (!window.orchid?.personality?.delete) return;
      const ok = window.confirm(
        `Delete personality "${p.name}" from ${p.scope} scope? This cannot be undone.`,
      );
      if (!ok) return;
      setError(null);
      try {
        await window.orchid.personality.delete({ scope: p.scope, name: p.name });
        if (editingKey === entryKey(p)) cancel();
        await onReload();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete personality');
      }
    },
    [editingKey, cancel, onReload],
  );

  const handleReveal = useCallback(async (p: ManagedPersonality) => {
    try {
      await window.orchid?.definitions?.reveal({ path: p.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal path');
    }
  }, []);

  const renderForm = (f: PersonalityForm, title: string) => (
    <div className="flex flex-col gap-4">
      {title && <div className="config-card-title text-primary">{title}</div>}
      <div className="config-form-grid">
        <div className="config-field">
          <label>Name</label>
          <input
            type="text"
            className="input config-control"
            value={f.name}
            onChange={(e) => setForm({ ...f, name: e.target.value })}
            placeholder="my-tone"
          />
          <span className="config-field-hint">
            File will be saved as {'{name}'}.md
          </span>
        </div>
        <div className="config-field">
          <label>Scope</label>
          <select
            className="select config-control"
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
            <option value="global">Global (~/.orchid/personalities)</option>
            <option value="project" disabled={!projectAvailable}>
              Project (.orchid/personalities)
            </option>
          </select>
        </div>
        <div className="config-field config-form-grid-full">
          <label>Personality prompt (markdown)</label>
          <textarea
            className="textarea config-textarea font-mono text-xs"
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
          disabled={saving || !f.name.trim() || !f.content.trim()}
        >
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save
        </button>
      </div>
    </div>
  );

  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">
          <span>Personalities</span>
          {!isAdding && !editingKey && (
            <button
              className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10"
              type="button"
              onClick={startAdd}
            >
              + Add Personality
            </button>
          )}
        </div>

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
          {visible.map((p) => (
            <div key={entryKey(p)} className="config-card">
              {editingKey === entryKey(p) && form ? (
                renderForm(form, '')
              ) : (
                <div className="config-card-row">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="config-card-title">{p.name}</div>
                      <ScopeBadge
                        scope={p.scope}
                        overriddenByProject={p.overriddenByProject}
                      />
                    </div>
                    <p className="config-card-desc line-clamp-3 whitespace-pre-wrap">
                      {p.content}
                    </p>
                  </div>
                  <DefinitionActions
                    onReveal={() => void handleReveal(p)}
                    onEdit={() => startEdit(p)}
                    onDelete={() => void handleDelete(p)}
                  />
                </div>
              )}
            </div>
          ))}

          {isAdding && form && (
            <div className="config-card border-primary/30 bg-primary/5">
              {renderForm(form, 'New Personality')}
            </div>
          )}

          {!isAdding && visible.length === 0 && (
            <p className="text-sm text-base-content/50 py-2">
              No personalities in this view. Add one or switch scope filter.
            </p>
          )}
        </div>

        <div className="config-note">
          Active personality is selected under General. Project personalities
          override global ones with the same name when a workspace is bound.
        </div>
      </section>
    </div>
  );
}
