/**
 * ProvidersTab — list, edit, delete, and add LLM providers.
 *
 * Each provider has: id, base_url, litellm_provider, models (dict).
 * Model discovery via GET /models endpoint (if available).
 */
import { useState, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProviderEntry {
  id: string;
  base_url: string;
  litellm_provider: string;
  models: Record<string, unknown>;
}

export interface ProvidersTabProps {
  providers: Record<string, Record<string, unknown>>;
  onChange: (providers: Record<string, Record<string, unknown>>) => void;
}

interface EditingProvider {
  id: string;
  base_url: string;
  litellm_provider: string;
  modelsText: string; // newline-separated model names for editing
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseProvider(id: string, data: Record<string, unknown>): ProviderEntry {
  return {
    id,
    base_url: (data.base_url as string) ?? '',
    litellm_provider: (data.litellm_provider as string) ?? 'openai',
    models: (data.models as Record<string, unknown>) ?? {},
  };
}

function providerToDict(p: ProviderEntry): Record<string, unknown> {
  return {
    base_url: p.base_url,
    litellm_provider: p.litellm_provider,
    models: p.models,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function ProvidersTab({ providers, onChange }: ProvidersTabProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditingProvider | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  // Parse providers dict into list
  const providerList = Object.entries(providers).map(([id, data]) =>
    parseProvider(id, data),
  );

  // ── Edit ─────────────────────────────────────────────────────────────────
  const startEdit = useCallback((p: ProviderEntry) => {
    setEditingId(p.id);
    setEditForm({
      id: p.id,
      base_url: p.base_url,
      litellm_provider: p.litellm_provider,
      modelsText: Object.keys(p.models).join('\n'),
    });
    setIsAdding(false);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editForm || !editingId) return;

    const models: Record<string, unknown> = {};
    for (const line of editForm.modelsText.split('\n')) {
      const name = line.trim();
      if (name) models[name] = {};
    }

    const updated = { ...providers };
    // If ID changed, remove old entry
    if (editingId !== editForm.id && editingId in updated) {
      delete updated[editingId];
    }
    updated[editForm.id] = providerToDict({
      id: editForm.id,
      base_url: editForm.base_url,
      litellm_provider: editForm.litellm_provider,
      models,
    });

    onChange(updated);
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
  }, [editForm, editingId, providers, onChange]);

  // ── Delete ───────────────────────────────────────────────────────────────
  const deleteProvider = useCallback(
    (id: string) => {
      const updated = { ...providers };
      delete updated[id];
      onChange(updated);
    },
    [providers, onChange],
  );

  // ── Add ──────────────────────────────────────────────────────────────────
  const startAdd = useCallback(() => {
    setEditingId(null);
    setEditForm({
      id: '',
      base_url: '',
      litellm_provider: 'openai',
      modelsText: '',
    });
    setIsAdding(true);
  }, []);

  // ── Model discovery ──────────────────────────────────────────────────────
  const handleDiscover = useCallback(async () => {
    if (!editForm?.base_url) return;
    setDiscovering(true);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${editForm.base_url}/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{ id: string }>;
        };
        const modelIds = (data.data ?? []).map((m) => m.id);
        if (modelIds.length > 0) {
          setEditForm((prev) =>
            prev ? { ...prev, modelsText: modelIds.join('\n') } : prev,
          );
        }
      }
    } catch {
      // Discovery failed — non-fatal
    } finally {
      setDiscovering(false);
    }
  }, [editForm?.base_url]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="config-form">
      <fieldset className="config-fieldset">
        <legend className="config-fieldset-legend">
          <span>Providers</span>
          {!isAdding && (
            <button
              className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10"
              onClick={startAdd}
              type="button"
            >
              + Add Provider
            </button>
          )}
        </legend>

        <div className="config-card-list">
          {providerList.map((p) => (
            <div key={p.id} className="config-card">
              {editingId === p.id && editForm ? (
                <div className="flex flex-col gap-4">
                  <div className="config-form-grid">
                    <div className="config-field">
                      <label>Provider ID</label>
                      <input
                        type="text"
                        value={editForm.id}
                        onChange={(e) => setEditForm({ ...editForm, id: e.target.value })}
                        className="input config-control"
                      />
                    </div>
                    <div className="config-field">
                      <label>Base URL</label>
                      <input
                        type="text"
                        value={editForm.base_url}
                        onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })}
                        className="input config-control"
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div className="config-field">
                      <label>Provider Type</label>
                      <select
                        value={editForm.litellm_provider}
                        onChange={(e) => setEditForm({ ...editForm, litellm_provider: e.target.value })}
                        className="select config-control"
                      >
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="ollama">Ollama</option>
                        <option value="gemini">Gemini</option>
                        <option value="groq">Groq</option>
                        <option value="mistral">Mistral</option>
                      </select>
                    </div>
                    <div className="config-field config-form-grid-full">
                      <label className="flex items-center justify-between gap-2">
                        <span>Models (one per line)</span>
                        <button
                          className="btn btn-ghost btn-xs h-6 min-h-6 px-2 text-[10px]"
                          onClick={handleDiscover}
                          disabled={discovering || !editForm.base_url}
                          title="Discover models from endpoint"
                          type="button"
                        >
                          {discovering ? '...' : 'Discover'}
                        </button>
                      </label>
                      <textarea
                        value={editForm.modelsText}
                        onChange={(e) => setEditForm({ ...editForm, modelsText: e.target.value })}
                        className="textarea config-textarea"
                        rows={4}
                        placeholder="gpt-4o&#10;gpt-4o-mini"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button className="btn btn-ghost btn-sm" onClick={cancelEdit} type="button">
                      Cancel
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={saveEdit} type="button">
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="config-card-row">
                  <div className="min-w-0">
                    <div className="config-card-title">{p.id}</div>
                    <p className="config-card-desc truncate">{p.base_url}</p>
                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                      <span className="rounded bg-base-300 px-1.5 py-0.5 text-base-content/70">
                        {p.litellm_provider}
                      </span>
                      <span className="text-base-content/45">
                        {Object.keys(p.models).length} model(s)
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => startEdit(p)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-xs text-error hover:bg-error/10"
                      onClick={() => deleteProvider(p.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isAdding && editForm && (
            <div className="config-card border-primary/30 bg-primary/5">
              <div className="config-card-title mb-3 text-primary">New Provider</div>
              <div className="config-form-grid">
                <div className="config-field">
                  <label>Provider ID</label>
                  <input
                    type="text"
                    value={editForm.id}
                    onChange={(e) => setEditForm({ ...editForm, id: e.target.value })}
                    className="input config-control"
                    placeholder="my-provider"
                  />
                </div>
                <div className="config-field">
                  <label>Base URL</label>
                  <input
                    type="text"
                    value={editForm.base_url}
                    onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })}
                    className="input config-control"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div className="config-field">
                  <label>Provider Type</label>
                  <select
                    value={editForm.litellm_provider}
                    onChange={(e) => setEditForm({ ...editForm, litellm_provider: e.target.value })}
                    className="select config-control"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Ollama</option>
                    <option value="gemini">Gemini</option>
                    <option value="groq">Groq</option>
                    <option value="mistral">Mistral</option>
                  </select>
                </div>
                <div className="config-field config-form-grid-full">
                  <label className="flex items-center justify-between gap-2">
                    <span>Models (one per line)</span>
                    <button
                      className="btn btn-ghost btn-xs h-6 min-h-6 px-2 text-[10px]"
                      onClick={handleDiscover}
                      disabled={discovering || !editForm.base_url}
                      type="button"
                    >
                      {discovering ? '...' : 'Discover'}
                    </button>
                  </label>
                  <textarea
                    value={editForm.modelsText}
                    onChange={(e) => setEditForm({ ...editForm, modelsText: e.target.value })}
                    className="textarea config-textarea"
                    rows={4}
                    placeholder="gpt-4o&#10;gpt-4o-mini"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} type="button">
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveEdit}
                  disabled={!editForm.id}
                  type="button"
                >
                  Add Provider
                </button>
              </div>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}
