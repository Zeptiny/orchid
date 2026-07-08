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
    <div className="pref-tab-content">
      <div className="pref-tab-header">
        <h3>Providers</h3>
        <p className="pref-tab-description">
          Configure LLM providers. Each provider needs a base URL, provider type, and at least one model.
        </p>
      </div>

      {/* Provider list */}
      <div className="pref-provider-list">
        {providerList.map((p) => (
          <div key={p.id} className="pref-provider-item">
            {editingId === p.id && editForm ? (
              /* Edit form */
              <div className="pref-provider-edit">
                <div className="pref-form-row">
                  <label>Provider ID</label>
                  <input
                    type="text"
                    value={editForm.id}
                    onChange={(e) =>
                      setEditForm({ ...editForm, id: e.target.value })
                    }
                    className="pref-input"
                  />
                </div>
                <div className="pref-form-row">
                  <label>Base URL</label>
                  <input
                    type="text"
                    value={editForm.base_url}
                    onChange={(e) =>
                      setEditForm({ ...editForm, base_url: e.target.value })
                    }
                    className="pref-input"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div className="pref-form-row">
                  <label>Provider Type</label>
                  <select
                    value={editForm.litellm_provider}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        litellm_provider: e.target.value,
                      })
                    }
                    className="pref-select"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Ollama</option>
                    <option value="gemini">Gemini</option>
                    <option value="groq">Groq</option>
                    <option value="mistral">Mistral</option>
                  </select>
                </div>
                <div className="pref-form-row">
                  <label>
                    Models (one per line)
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleDiscover}
                      disabled={discovering || !editForm.base_url}
                      title="Discover models from endpoint"
                    >
                      {discovering ? '...' : 'Discover'}
                    </button>
                  </label>
                  <textarea
                    value={editForm.modelsText}
                    onChange={(e) =>
                      setEditForm({ ...editForm, modelsText: e.target.value })
                    }
                    className="pref-textarea"
                    rows={4}
                    placeholder="gpt-4o&#10;gpt-4o-mini"
                  />
                </div>
                <div className="pref-form-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Display card */
              <div className="pref-provider-card">
                <div className="pref-provider-info">
                  <span className="pref-provider-name">{p.id}</span>
                  <span className="pref-provider-url">{p.base_url}</span>
                  <span className="pref-provider-type">{p.litellm_provider}</span>
                </div>
                <div className="pref-provider-models">
                  {Object.keys(p.models).length} model(s):{' '}
                  {Object.keys(p.models).slice(0, 3).join(', ')}
                  {Object.keys(p.models).length > 3 && '...'}
                </div>
                <div className="pref-provider-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => startEdit(p)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => deleteProvider(p.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add form (inline) */}
      {isAdding && editForm && (
        <div className="pref-provider-add">
          <h4>Add Provider</h4>
          <div className="pref-form-row">
            <label>Provider ID</label>
            <input
              type="text"
              value={editForm.id}
              onChange={(e) =>
                setEditForm({ ...editForm, id: e.target.value })
              }
              className="pref-input"
              placeholder="my-provider"
            />
          </div>
          <div className="pref-form-row">
            <label>Base URL</label>
            <input
              type="text"
              value={editForm.base_url}
              onChange={(e) =>
                setEditForm({ ...editForm, base_url: e.target.value })
              }
              className="pref-input"
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="pref-form-row">
            <label>Provider Type</label>
            <select
              value={editForm.litellm_provider}
              onChange={(e) =>
                setEditForm({
                  ...editForm,
                  litellm_provider: e.target.value,
                })
              }
              className="pref-select"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="ollama">Ollama</option>
              <option value="gemini">Gemini</option>
              <option value="groq">Groq</option>
              <option value="mistral">Mistral</option>
            </select>
          </div>
          <div className="pref-form-row">
            <label>
              Models (one per line)
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleDiscover}
                disabled={discovering || !editForm.base_url}
              >
                {discovering ? '...' : 'Discover'}
              </button>
            </label>
            <textarea
              value={editForm.modelsText}
              onChange={(e) =>
                setEditForm({ ...editForm, modelsText: e.target.value })
              }
              className="pref-textarea"
              rows={4}
              placeholder="gpt-4o&#10;gpt-4o-mini"
            />
          </div>
          <div className="pref-form-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={saveEdit}
              disabled={!editForm.id}
            >
              Add Provider
            </button>
            <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add button */}
      {!isAdding && (
        <button className="btn btn-secondary" onClick={startAdd}>
          + Add Provider
        </button>
      )}
    </div>
  );
}
