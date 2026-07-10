/**
 * ProvidersTab — list, edit, delete, and add LLM providers.
 *
 * Each provider has: id, base_url, litellm_provider, api_key / api_key_env,
 * and models (dict with optional per-model metadata overrides).
 *
 * Features:
 * - API key input (stored in OS keychain via config:save)
 * - API key env var reference (alternative to literal key)
 * - Test Connection button (uses discoverModels IPC → authenticated GET /models)
 * - Model discovery from provider endpoint
 * - Per-model metadata overrides (max_input_tokens, max_output_tokens,
 *   supports_vision, mode)
 * - Add individual model cards manually
 */
import { useState, useCallback } from 'react';
import type { ModelMetadata } from '../../../shared/types/ipc-boundary';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProviderEntry {
  id: string;
  base_url: string;
  litellm_provider: string;
  api_key?: string;
  api_key_env?: string;
  models: Record<string, Record<string, unknown>>;
}

export interface ProvidersTabProps {
  providers: Record<string, Record<string, unknown>>;
  onChange: (providers: Record<string, Record<string, unknown>>) => void;
  onRename: (from: string, to: string) => void;
}

interface ModelOverride {
  max_input_tokens: string;
  max_output_tokens: string;
  supports_vision: boolean;
  mode: 'chat' | 'embeddings';
}

interface EditingModel {
  id: string;
  enabled: boolean;
  name?: string;
  owned_by?: string;
  expanded: boolean;
  override: ModelOverride;
  /** When true, the model ID is editable (newly added model). */
  isNew: boolean;
}

interface EditingProvider {
  id: string;
  base_url: string;
  litellm_provider: string;
  api_key: string;
  api_key_env: string;
  /** Whether a key was redacted from config:get (existing key in keychain). */
  hasExistingKey: boolean;
  models: EditingModel[];
}

type TestStatus = 'idle' | 'testing' | 'success' | 'fail';
interface TestResult {
  status: TestStatus;
  message: string;
  modelCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseProvider(id: string, data: Record<string, unknown>): ProviderEntry {
  return {
    id,
    base_url: (data.base_url as string) ?? '',
    litellm_provider: (data.litellm_provider as string) ?? 'openai',
    api_key: data.api_key as string | undefined,
    api_key_env: data.api_key_env as string | undefined,
    models: (data.models as Record<string, Record<string, unknown>>) ?? {},
  };
}

function defaultOverride(): ModelOverride {
  return {
    max_input_tokens: '',
    max_output_tokens: '',
    supports_vision: false,
    mode: 'chat',
  };
}

function parseOverride(modelData: Record<string, unknown> | undefined): ModelOverride {
  if (!modelData || typeof modelData !== 'object') return defaultOverride();
  return {
    max_input_tokens:
      modelData.max_input_tokens != null ? String(modelData.max_input_tokens) : '',
    max_output_tokens:
      modelData.max_output_tokens != null ? String(modelData.max_output_tokens) : '',
    supports_vision: modelData.supports_vision === true,
    mode: modelData.mode === 'embeddings' ? 'embeddings' : 'chat',
  };
}

function overrideToDict(o: ModelOverride): Record<string, unknown> {
  const dict: Record<string, unknown> = {};
  if (o.max_input_tokens !== '') {
    const n = parseInt(o.max_input_tokens, 10);
    if (!isNaN(n) && n > 0) dict.max_input_tokens = n;
  }
  if (o.max_output_tokens !== '') {
    const n = parseInt(o.max_output_tokens, 10);
    if (!isNaN(n) && n > 0) dict.max_output_tokens = n;
  }
  if (o.supports_vision) dict.supports_vision = true;
  if (o.mode === 'embeddings') dict.mode = 'embeddings';
  return dict;
}

function modelsToEditingModels(
  models: Record<string, Record<string, unknown>>,
): EditingModel[] {
  return Object.entries(models).map(([id, data]) => ({
    id,
    enabled: true,
    expanded: false,
    isNew: false,
    override: parseOverride(data),
  }));
}

function editingModelsToDict(models: EditingModel[]): Record<string, Record<string, unknown>> {
  const dict: Record<string, Record<string, unknown>> = {};
  for (const m of models) {
    if (!m.enabled || m.isNew) continue;
    const override = overrideToDict(m.override);
    if (Object.keys(override).length > 0) {
      dict[m.id] = override;
    } else {
      dict[m.id] = {};
    }
  }
  return dict;
}

function providerToDict(p: ProviderEntry): Record<string, unknown> {
  const dict: Record<string, unknown> = {
    base_url: p.base_url,
    litellm_provider: p.litellm_provider,
    models: p.models,
  };
  if (p.api_key) dict.api_key = p.api_key;
  if (p.api_key_env) dict.api_key_env = p.api_key_env;
  return dict;
}

function editingProviderToEntry(form: EditingProvider): ProviderEntry {
  const models = editingModelsToDict(form.models);
  return {
    id: form.id,
    base_url: form.base_url,
    litellm_provider: form.litellm_provider,
    api_key: form.api_key || undefined,
    api_key_env: form.api_key_env || undefined,
    models,
  };
}

/** Detect if a redacted api_key came from config:get (keychain-stored). */
function isRedactedKey(key: string | undefined): boolean {
  return typeof key === 'string' && (key === '****' || key.includes('...'));
}

// ── Component ────────────────────────────────────────────────────────────────

export function ProvidersTab({ providers, onChange, onRename }: ProvidersTabProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditingProvider | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>({
    status: 'idle',
    message: '',
    modelCount: 0,
  });

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
      api_key: '',
      api_key_env: p.api_key_env ?? '',
      hasExistingKey: isRedactedKey(p.api_key),
      models: modelsToEditingModels(p.models),
    });
    setIsAdding(false);
    setTestResult({ status: 'idle', message: '', modelCount: 0 });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
    setTestResult({ status: 'idle', message: '', modelCount: 0 });
  }, []);

  const saveEdit = useCallback(() => {
    if (!editForm) return;
    if (!isAdding && !editingId) return;

    const entry = editingProviderToEntry(editForm);
    const updated = { ...providers };
    // If editing an existing provider and the ID changed, remove old entry
    if (editingId && editingId !== editForm.id && editingId in updated) {
      delete updated[editingId];
      onRename(editingId, editForm.id);
    }
    updated[editForm.id] = providerToDict(entry);

    onChange(updated);
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
    setTestResult({ status: 'idle', message: '', modelCount: 0 });
  }, [editForm, editingId, isAdding, providers, onChange, onRename]);

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
      api_key: '',
      api_key_env: '',
      hasExistingKey: false,
      models: [],
    });
    setIsAdding(true);
    setTestResult({ status: 'idle', message: '', modelCount: 0 });
  }, []);

  // ── Test Connection / Discover Models ──────────────────────────────────────

  const handleTestConnection = useCallback(async () => {
    if (!editForm?.base_url || !editForm.id) return;

    const configAlias = editingId && editingId in providers ? editingId : null;
    if (!configAlias) {
      setTestResult({
        status: 'fail',
        message: 'Save the provider first to test connection',
        modelCount: 0,
      });
      return;
    }

    setTestResult({ status: 'testing', message: 'Connecting...', modelCount: 0 });

    try {
      if (window.orchid?.config?.discoverModels) {
        const models = await window.orchid.config.discoverModels(configAlias, true);

        if (models.length > 0) {
          setTestResult({
            status: 'success',
            message: `Connected — ${models.length} models found`,
            modelCount: models.length,
          });
          const existingIds = new Set(editForm.models.map((m) => m.id));
          const newModels: EditingModel[] = models.map((m) => ({
            id: m.id,
            enabled: true,
            name: m.name,
            owned_by: m.owned_by,
            expanded: false,
            isNew: false,
            override: defaultOverride(),
          }));
          const merged = editForm.models.filter(
            (m) => existingIds.has(m.id) && models.some((d) => d.id === m.id),
          );
          for (const nm of newModels) {
            if (!merged.some((m) => m.id === nm.id)) {
              merged.push(nm);
            }
          }
          setEditForm({ ...editForm, models: merged });
        } else {
          setTestResult({
            status: 'fail',
            message: 'No models returned — check API key and base URL',
            modelCount: 0,
          });
        }
      }
    } catch {
      setTestResult({
        status: 'fail',
        message: 'Connection failed — check base URL and network',
        modelCount: 0,
      });
    }
  }, [editForm, editingId, providers]);

  // ── Model list helpers ────────────────────────────────────────────────────

  const toggleModelEnabled = useCallback((modelId: string) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((m) =>
          m.id === modelId ? { ...m, enabled: !m.enabled } : m,
        ),
      };
    });
  }, []);

  const toggleModelExpanded = useCallback((modelId: string) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((m) =>
          m.id === modelId ? { ...m, expanded: !m.expanded } : m,
        ),
      };
    });
  }, []);

  const updateModelOverride = useCallback(
    (modelId: string, field: keyof ModelOverride, value: string | boolean) => {
      setEditForm((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          models: prev.models.map((m) => {
            if (m.id !== modelId) return m;
            return { ...m, override: { ...m.override, [field]: value } };
          }),
        };
      });
    },
    [],
  );

  const removeModel = useCallback((index: number) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.filter((_, i) => i !== index),
      };
    });
  }, []);

  const addModelCard = useCallback(() => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: [
          ...prev.models,
          {
            id: '',
            enabled: true,
            expanded: false,
            isNew: true,
            override: defaultOverride(),
          },
        ],
      };
    });
  }, []);

  const setModelId = useCallback((index: number, newId: string) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((m, i) =>
          i === index ? { ...m, id: newId } : m,
        ),
      };
    });
  }, []);

  const confirmModelId = useCallback((index: number) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((m, i) =>
          i === index && m.isNew && m.id.trim()
            ? { ...m, id: m.id.trim(), isNew: false }
            : m,
        ),
      };
    });
  }, []);

  // ── Resolved metadata lookup (built-in + override) ────────────────────────

  const [resolvedMetadataCache, setResolvedMetadataCache] = useState<
    Record<string, ModelMetadata | null>
  >({});

  const fetchResolvedMetadata = useCallback(async (modelId: string) => {
    if (modelId in resolvedMetadataCache) return;
    if (!window.orchid?.config?.modelMetadata) return;
    try {
      const meta = await window.orchid.config.modelMetadata(modelId);
      setResolvedMetadataCache((prev) => ({ ...prev, [modelId]: meta }));
    } catch {
      setResolvedMetadataCache((prev) => ({ ...prev, [modelId]: null }));
    }
  }, [resolvedMetadataCache]);

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderTestBadge() {
    if (testResult.status === 'idle') return null;
    const colorClass =
      testResult.status === 'success'
        ? 'text-success'
        : testResult.status === 'fail'
          ? 'text-error'
          : 'text-base-content/60';
    return (
      <span className={`text-[11px] ${colorClass}`}>
        {testResult.status === 'testing' ? '...' : testResult.message}
      </span>
    );
  }

  function renderModelList(form: EditingProvider) {
    return (
      <div className="flex flex-col gap-2">
        {form.models.length === 0 && (
          <span className="config-field-hint">
            No models configured. Click "Test &amp; Discover" to fetch from the
            provider, or "Add Model" to add one manually.
          </span>
        )}
        {form.models.map((m, idx) => (
          <div key={idx} className="config-card" style={{ padding: '10px 12px' }}>
            {m.isNew ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={m.id}
                  onChange={(e) => setModelId(idx, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmModelId(idx);
                  }}
                  onBlur={() => {
                    if (m.id.trim()) confirmModelId(idx);
                  }}
                  className="input config-control flex-1"
                  placeholder="model-id (e.g. gpt-4o)"
                  autoFocus
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => confirmModelId(idx)}
                  disabled={!m.id.trim()}
                  type="button"
                >
                  Confirm
                </button>
                <button
                  className="btn btn-ghost btn-sm text-error hover:bg-error/10"
                  onClick={() => removeModel(idx)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={() => toggleModelEnabled(m.id)}
                    className="checkbox checkbox-sm"
                  />
                  <span className="text-[12px] font-medium flex-1 min-w-0 truncate">
                    {m.id}
                  </span>
                  {m.name && (
                    <span className="text-[11px] text-base-content/50 truncate">
                      {m.name}
                    </span>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      toggleModelExpanded(m.id);
                      fetchResolvedMetadata(m.id);
                    }}
                    type="button"
                  >
                    {m.expanded ? 'Collapse' : 'Configure'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm text-error hover:bg-error/10"
                    onClick={() => removeModel(idx)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
                {m.expanded && (
                  <div className="config-form-grid mt-3" style={{ paddingLeft: '32px' }}>
                    {(() => {
                      const resolved = resolvedMetadataCache[m.id];
                      return (
                        <>
                          {resolved && resolved.max_input_tokens != null && (
                            <span className="config-field-hint config-form-grid-full">
                              Built-in: {resolved.max_input_tokens?.toLocaleString()} input /{' '}
                              {resolved.max_output_tokens?.toLocaleString()} output tokens
                              {resolved.supports_vision ? ' · vision' : ''}
                            </span>
                          )}
                          <div className="config-field">
                            <label>Max Input Tokens</label>
                            <input
                              type="number"
                              value={m.override.max_input_tokens}
                              onChange={(e) =>
                                updateModelOverride(m.id, 'max_input_tokens', e.target.value)
                              }
                              className="input config-control"
                              placeholder={
                                resolved?.max_input_tokens != null
                                  ? String(resolved.max_input_tokens)
                                  : 'auto'
                              }
                              min={1}
                            />
                          </div>
                          <div className="config-field">
                            <label>Max Output Tokens</label>
                            <input
                              type="number"
                              value={m.override.max_output_tokens}
                              onChange={(e) =>
                                updateModelOverride(m.id, 'max_output_tokens', e.target.value)
                              }
                              className="input config-control"
                              placeholder={
                                resolved?.max_output_tokens != null
                                  ? String(resolved.max_output_tokens)
                                  : 'auto'
                              }
                              min={1}
                            />
                          </div>
                          <div className="config-field">
                            <label>Vision Support</label>
                            <select
                              value={m.override.supports_vision ? 'yes' : 'no'}
                              onChange={(e) =>
                                updateModelOverride(
                                  m.id,
                                  'supports_vision',
                                  e.target.value === 'yes',
                                )
                              }
                              className="select config-control"
                            >
                              <option value="no">No</option>
                              <option value="yes">Yes</option>
                            </select>
                          </div>
                          <div className="config-field">
                            <label>Mode</label>
                            <select
                              value={m.override.mode}
                              onChange={(e) =>
                                updateModelOverride(
                                  m.id,
                                  'mode',
                                  e.target.value as 'chat' | 'embeddings',
                                )
                              }
                              className="select config-control"
                            >
                              <option value="chat">chat</option>
                              <option value="embeddings">embeddings</option>
                            </select>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {/* Add Model button */}
        <div className="mt-1">
          <button
            className="btn btn-ghost btn-sm text-primary hover:bg-primary/10"
            onClick={addModelCard}
            type="button"
          >
            + Add Model
          </button>
        </div>
      </div>
    );
  }

  function renderProviderForm(form: EditingProvider, isNew: boolean) {
    return (
      <div className="flex flex-col gap-4">
        <div className="config-form-grid">
          <div className="config-field">
            <label>Provider ID</label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => setEditForm({ ...form, id: e.target.value })}
              className="input config-control"
              placeholder={isNew ? 'my-provider' : ''}
            />
          </div>
          <div className="config-field">
            <label>Base URL</label>
            <input
              type="text"
              value={form.base_url}
              onChange={(e) => setEditForm({ ...form, base_url: e.target.value })}
              className="input config-control"
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="config-field">
            <label>Provider Type</label>
            <select
              value={form.litellm_provider}
              onChange={(e) =>
                setEditForm({ ...form, litellm_provider: e.target.value })
              }
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
          <div className="config-field">
            <label>API Key</label>
            <input
              type="password"
              value={form.api_key}
              onChange={(e) =>
                setEditForm({ ...form, api_key: e.target.value, hasExistingKey: false })
              }
              className="input config-control"
              placeholder={
                form.hasExistingKey
                  ? '•••••••• (stored in keychain — type to replace)'
                  : 'sk-...'
              }
            />
            {form.hasExistingKey && !form.api_key && (
              <span className="config-field-hint text-success">
                Key stored in OS keychain. Leave blank to keep existing.
              </span>
            )}
          </div>
          <div className="config-field">
            <label>API Key Env Var (alternative)</label>
            <input
              type="text"
              value={form.api_key_env}
              onChange={(e) => setEditForm({ ...form, api_key_env: e.target.value })}
              className="input config-control"
              placeholder="OPENAI_API_KEY"
            />
            <span className="config-field-hint">
              If set, reads the key from this env var at runtime instead.
            </span>
          </div>
        </div>

        {/* Test + Discover */}
        <div className="flex items-center gap-3">
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleTestConnection}
            disabled={
              testResult.status === 'testing' ||
              !form.base_url ||
              !form.id
            }
            type="button"
          >
            {testResult.status === 'testing' ? 'Testing...' : 'Test & Discover'}
          </button>
          {renderTestBadge()}
        </div>

        {/* Model list */}
        <div className="config-field config-form-grid-full">
          <label className="flex items-center justify-between gap-2">
            <span>Models ({form.models.filter((m) => !m.isNew).length})</span>
          </label>
          {renderModelList(form)}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={cancelEdit} type="button">
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={saveEdit}
            disabled={!form.id || (form.id !== editingId && form.id in providers)}
            type="button"
          >
            {isNew ? 'Add Provider' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">
          <span>Providers</span>
          {!isAdding && (
            <button
              className="btn btn-ghost btn-sm font-normal text-primary hover:bg-primary/10"
              onClick={startAdd}
              type="button"
            >
              + Add Provider
            </button>
          )}
        </div>

        <div className="config-card-list">
          {providerList.map((p) => (
            <div key={p.id} className="config-card">
              {editingId === p.id && editForm ? (
                renderProviderForm(editForm, false)
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
                      className="btn btn-ghost btn-sm"
                      onClick={() => startEdit(p)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm text-error hover:bg-error/10"
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
              {renderProviderForm(editForm, true)}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
