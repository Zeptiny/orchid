/** Configure catalog selections and user-defined models during connection setup or editing. */
import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderModelView,
} from '../../../shared/types/ipc';
import type {
  CustomConnectionModel,
  ProviderProtocol,
  ReasoningModelConfig,
} from '../../../shared/types/provider';
import {
  CONNECTION_MODEL_MODALITIES,
  connectionModelCapabilities,
  type ConnectionModelModality,
} from '../../utils/models';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StatusBadge } from '../ui/StatusBadge';
import { TextInput } from '../ui/TextInput';
import { ReasoningFields } from './ReasoningConfigEditor';

const NEW_CUSTOM_MODEL = '__new_custom_model__';

interface CustomModelForm {
  readonly id: string;
  readonly displayName: string;
  readonly inputModalities: readonly ConnectionModelModality[];
  readonly outputModalities: readonly ConnectionModelModality[];
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly contextTokens: string;
  readonly outputTokens: string;
}

const EMPTY_CUSTOM_MODEL: CustomModelForm = {
  id: '',
  displayName: '',
  inputModalities: ['text'],
  outputModalities: ['text'],
  tools: true,
  reasoning: true,
  contextTokens: '',
  outputTokens: '',
};

const EMPTY_REASONING_CONFIG: ReasoningModelConfig = { levels: [], default: null };

export interface ConnectionModelsEditorProps {
  readonly protocol: ProviderProtocol;
  readonly definition: ProviderDefinitionView;
  readonly selectedModelIds: readonly string[];
  readonly customModels: readonly CustomConnectionModel[];
  readonly reasoningConfig: Record<string, ReasoningModelConfig>;
  readonly disabled?: boolean;
  readonly onSelectedModelIdsChange: (modelIds: readonly string[]) => void;
  readonly onCustomModelsChange: (models: readonly CustomConnectionModel[]) => void;
  readonly onReasoningConfigChange: (config: Record<string, ReasoningModelConfig>) => void;
  readonly onEditingChange?: (editing: boolean) => void;
}

function modelAvailable(model: ProviderModelView): boolean {
  return model.lifecycle !== 'disabled' && model.lifecycle !== 'retired';
}

function parseOptionalLimit(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function customModalities(values: readonly string[] | undefined): ConnectionModelModality[] {
  const supported = (values ?? []).filter(
    (value): value is ConnectionModelModality =>
      CONNECTION_MODEL_MODALITIES.some((candidate) => candidate === value),
  );
  return supported.length > 0 ? supported : ['text'];
}

function editableCustomModel(
  model: ProviderModelView,
  protocol: ProviderProtocol,
): CustomConnectionModel {
  return {
    id: model.id,
    displayName: model.displayName,
    protocol,
    capabilities: {
      inputModalities: customModalities(model.capabilities?.inputModalities),
      outputModalities: customModalities(model.capabilities?.outputModalities),
      tools: model.capabilities?.tools ?? true,
      reasoning: model.capabilities?.reasoning ?? true,
    },
    limits: {
      contextTokens: model.limits?.contextTokens ?? null,
      outputTokens: model.limits?.outputTokens ?? null,
    },
  };
}

export function connectionCustomModelDrafts(
  connection: ProviderConnectionView,
): CustomConnectionModel[] {
  return connection.customModels.map((model) => editableCustomModel(model, connection.protocol));
}

function modalityLabel(modality: ConnectionModelModality): string {
  if (modality === 'pdf') return 'PDF';
  if (modality === 'embedding') return 'Embeddings';
  return `${modality[0].toUpperCase()}${modality.slice(1)}`;
}

function modelCapabilityLabel(
  direction: 'Input' | 'Output',
  modalities: readonly ConnectionModelModality[],
): string {
  return `${direction}: ${modalities.map(modalityLabel).join(', ')}`;
}

function formForCustomModel(model: CustomConnectionModel): CustomModelForm {
  return {
    id: model.id,
    displayName: model.displayName,
    inputModalities: customModalities(model.capabilities.inputModalities),
    outputModalities: customModalities(model.capabilities.outputModalities),
    tools: model.capabilities.tools,
    reasoning: model.capabilities.reasoning,
    contextTokens: model.limits.contextTokens?.toString() ?? '',
    outputTokens: model.limits.outputTokens?.toString() ?? '',
  };
}

export function ConnectionModelsEditor({
  protocol,
  definition,
  selectedModelIds,
  customModels,
  reasoningConfig,
  disabled = false,
  onSelectedModelIdsChange,
  onCustomModelsChange,
  onReasoningConfigChange,
  onEditingChange,
}: ConnectionModelsEditorProps) {
  const [editingCustomModelId, setEditingCustomModelId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState<CustomModelForm>(EMPTY_CUSTOM_MODEL);
  const [reasoningDraft, setReasoningDraft] = useState<ReasoningModelConfig>(EMPTY_REASONING_CONFIG);
  const [error, setError] = useState<string | null>(null);

  const catalogModels = useMemo(
    () => definition.models.filter(
      (model) => model.protocol === protocol && modelAvailable(model),
    ),
    [definition.models, protocol],
  );
  const catalogModelIds = useMemo(
    () => new Set(catalogModels.map((model) => model.id)),
    [catalogModels],
  );
  const customModelIds = useMemo(
    () => new Set(customModels.map((model) => model.id)),
    [customModels],
  );
  const selectableModelIds = useMemo(
    () => Array.from(new Set([...catalogModelIds, ...customModelIds])),
    [catalogModelIds, customModelIds],
  );
  const allModelsSelected = selectableModelIds.length > 0
    && selectableModelIds.every((modelId) => selectedModelIds.includes(modelId));
  const userDefinedModels = customModels.filter((model) => !catalogModelIds.has(model.id));
  const orphanModelIds = selectedModelIds.filter(
    (modelId) => !catalogModelIds.has(modelId) && !customModelIds.has(modelId),
  );

  useEffect(() => {
    onEditingChange?.(editingCustomModelId !== null);
  }, [editingCustomModelId, onEditingChange]);

  const toggleModel = (modelId: string) => {
    onSelectedModelIdsChange(selectedModelIds.includes(modelId)
      ? selectedModelIds.filter((candidate) => candidate !== modelId)
      : [...selectedModelIds, modelId]);
  };

  const toggleAllModels = () => {
    onSelectedModelIdsChange(allModelsSelected ? [] : selectableModelIds);
  };

  const startAddingCustomModel = () => {
    setEditingCustomModelId(NEW_CUSTOM_MODEL);
    setCustomForm(EMPTY_CUSTOM_MODEL);
    setReasoningDraft(EMPTY_REASONING_CONFIG);
    setError(null);
  };

  const startEditingCatalogModel = (model: ProviderModelView) => {
    const override = customModels.find((candidate) => candidate.id === model.id);
    const editable = override ?? editableCustomModel(model, protocol);
    setEditingCustomModelId(model.id);
    setCustomForm(formForCustomModel(editable));
    setReasoningDraft(reasoningConfig[model.id] ?? EMPTY_REASONING_CONFIG);
    setError(null);
  };

  const startEditingCustomModel = (model: CustomConnectionModel) => {
    setEditingCustomModelId(model.id);
    setCustomForm(formForCustomModel(model));
    setReasoningDraft(reasoningConfig[model.id] ?? EMPTY_REASONING_CONFIG);
    setError(null);
  };

  const cancelCustomModel = () => {
    setEditingCustomModelId(null);
    setCustomForm(EMPTY_CUSTOM_MODEL);
    setReasoningDraft(EMPTY_REASONING_CONFIG);
    setError(null);
  };

  const toggleModality = (
    direction: 'inputModalities' | 'outputModalities',
    modality: ConnectionModelModality,
  ) => {
    setCustomForm((current) => {
      const selected = current[direction];
      return {
        ...current,
        [direction]: selected.includes(modality)
          ? selected.filter((candidate) => candidate !== modality)
          : [...selected, modality],
      };
    });
  };

  const saveCustomModel = () => {
    if (!editingCustomModelId) return;
    const catalogModel = catalogModels.find((model) => model.id === editingCustomModelId);
    const id = catalogModel ? catalogModel.id : customForm.id.trim();
    if (!id) {
      setError('Enter the model ID supplied by this provider.');
      return;
    }
    const duplicateCustomModel = customModels.some(
      (model) => model.id === id && model.id !== editingCustomModelId,
    );
    const createsCatalogCollision = catalogModelIds.has(id) && !catalogModel;
    if (duplicateCustomModel || createsCatalogCollision) {
      setError(`A model named '${id}' already exists on this connection.`);
      return;
    }
    const contextTokens = parseOptionalLimit(customForm.contextTokens);
    const outputTokens = parseOptionalLimit(customForm.outputTokens);
    if (contextTokens === undefined || outputTokens === undefined) {
      setError('Model limits must be positive whole numbers or left blank.');
      return;
    }
    if (customForm.inputModalities.length === 0 || customForm.outputModalities.length === 0) {
      setError('Select at least one input capability and one output capability.');
      return;
    }
    if (customForm.reasoning && reasoningDraft.levels.length === 0) {
      setError('Add at least one reasoning level for this reasoning-capable model.');
      return;
    }
    if (
      customForm.reasoning
      && typeof reasoningDraft.default === 'number'
      && !Number.isFinite(reasoningDraft.default)
    ) {
      setError('The numeric reasoning default must be a finite whole number.');
      return;
    }

    const existing = customModels.find((model) => model.id === editingCustomModelId);
    const model: CustomConnectionModel = {
      id,
      displayName: customForm.displayName.trim() || id,
      protocol,
      capabilities: connectionModelCapabilities(
        customForm.inputModalities,
        customForm.outputModalities,
        customForm.tools,
        customForm.reasoning,
      ),
      limits: { contextTokens, outputTokens },
    };

    onCustomModelsChange(existing
      ? customModels.map((candidate) => candidate.id === existing.id ? model : candidate)
      : [...customModels, model]);
    if (!existing && !catalogModel) {
      onSelectedModelIdsChange(
        selectedModelIds.includes(id) ? selectedModelIds : [...selectedModelIds, id],
      );
    } else if (existing) {
      onSelectedModelIdsChange(
        selectedModelIds.map((modelId) => modelId === existing.id ? id : modelId),
      );
    }

    const nextReasoningConfig: Record<string, ReasoningModelConfig> = { ...reasoningConfig };
    if (existing && existing.id !== id) delete nextReasoningConfig[existing.id];
    if (customForm.reasoning) {
      nextReasoningConfig[id] = { levels: reasoningDraft.levels, default: reasoningDraft.default };
    } else {
      delete nextReasoningConfig[id];
    }
    onReasoningConfigChange(nextReasoningConfig);

    setEditingCustomModelId(null);
    setCustomForm(EMPTY_CUSTOM_MODEL);
    setReasoningDraft(EMPTY_REASONING_CONFIG);
    setError(null);
  };

  const resetCatalogModel = (modelId: string) => {
    onCustomModelsChange(customModels.filter((model) => model.id !== modelId));
    if (reasoningConfig[modelId]) {
      const nextReasoningConfig = { ...reasoningConfig };
      delete nextReasoningConfig[modelId];
      onReasoningConfigChange(nextReasoningConfig);
    }
    if (editingCustomModelId === modelId) cancelCustomModel();
  };

  const removeCustomModel = (modelId: string) => {
    onCustomModelsChange(customModels.filter((model) => model.id !== modelId));
    onSelectedModelIdsChange(selectedModelIds.filter((candidate) => candidate !== modelId));
    if (reasoningConfig[modelId]) {
      const nextReasoningConfig = { ...reasoningConfig };
      delete nextReasoningConfig[modelId];
      onReasoningConfigChange(nextReasoningConfig);
    }
    if (editingCustomModelId === modelId) cancelCustomModel();
  };

  return (
    <>
            <Panel as="section" className="config-fieldset flex flex-col gap-3">
              <SectionHeader
                title="Catalog models"
                actions={
                  <>
                    <StatusBadge tone="ghost" size="sm" className="whitespace-nowrap">
                      {selectedModelIds.length} selected
                    </StatusBadge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleAllModels}
                      disabled={disabled || editingCustomModelId !== null || selectableModelIds.length === 0}
                      aria-pressed={allModelsSelected}
                    >
                      {allModelsSelected ? 'Deselect all models' : 'Select all models'}
                    </Button>
                  </>
                }
              />
              <p className="label">
                Selected models become available to chat, tier assignment, or RAG according to
                their declared capabilities.
              </p>
              {catalogModels.length === 0 ? (
                <Alert tone="info" role="status" icon="cpu">
                  No catalog models match this connection protocol.
                </Alert>
              ) : (
                <ul className="list max-h-96 overflow-y-auto rounded-box border border-base-300 bg-base-100">
                  {catalogModels.map((model) => {
                    const override = customModels.find((candidate) => candidate.id === model.id);
                    const effective = override ?? editableCustomModel(model, protocol);
                    const selected = selectedModelIds.includes(model.id);
                    return (
                      <li
                        key={model.id}
                        className={[
                          'flex min-w-0 items-start justify-between gap-x-4 gap-y-2',
                          'rounded-md border-b border-base-300 p-3 !pl-6 transition-colors last:border-b-0',
                          selected ? 'bg-primary/10' : 'hover:bg-base-200/80',
                        ].join(' ')}
                      >
                        <label className="min-w-0 flex-1 cursor-pointer">
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={selected}
                            onChange={() => toggleModel(model.id)}
                            aria-label={`Use ${effective.displayName}`}
                            disabled={disabled || editingCustomModelId !== null}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium break-words">{effective.displayName}</span>
                              {override && <StatusBadge size="sm">Customized</StatusBadge>}
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-base-content/60">{model.id}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <StatusBadge tone="ghost" size="sm">
                                {modelCapabilityLabel('Input', effective.capabilities.inputModalities)}
                              </StatusBadge>
                              <StatusBadge tone="ghost" size="sm">
                                {modelCapabilityLabel('Output', effective.capabilities.outputModalities)}
                              </StatusBadge>
                              {effective.capabilities.tools && <StatusBadge tone="ghost" size="sm">Tools</StatusBadge>}
                              {effective.capabilities.reasoning && <StatusBadge tone="ghost" size="sm">Reasoning</StatusBadge>}
                            </div>
                          </div>
                        </label>
                        <div className="flex shrink-0 flex-wrap items-start justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            onClick={() => startEditingCatalogModel(model)}
                            aria-label={`Edit ${effective.displayName}`}
                            title={`Edit ${effective.displayName}`}
                            disabled={disabled || editingCustomModelId !== null}
                          >
                            <Icon name="edit" size={14} />
                          </Button>
                          {override && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => resetCatalogModel(model.id)}
                              title="Reset catalog metadata"
                              disabled={disabled || editingCustomModelId !== null}
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel as="section" className="config-fieldset flex flex-col gap-3">
              <SectionHeader
                title="Custom models"
                actions={
                  definition.allowsCustomModels && editingCustomModelId === null ? (
                    <Button
                      size="sm"
                      onClick={startAddingCustomModel}
                      disabled={disabled}
                    >
                      <Icon name="plus" size={14} />
                      Add custom model
                    </Button>
                  ) : undefined
                }
              />
              <p className="label">
                Custom metadata is explicit connection configuration; Orchid does not infer it
                from the model ID.
              </p>

              {userDefinedModels.length === 0 ? (
                <p className="py-2 text-sm text-base-content/60">
                  {definition.allowsCustomModels
                    ? 'No custom models have been added.'
                    : 'This provider accepts catalog models only.'}
                </p>
              ) : (
                <ul className="list rounded-box border border-base-300 bg-base-100">
                  {userDefinedModels.map((model) => (
                    <li
                      key={model.id}
                      className={[
                        'flex min-w-0 items-start justify-between gap-x-4 gap-y-2',
                        'rounded-md border-b border-base-300 p-3 !pl-6 transition-colors last:border-b-0',
                        selectedModelIds.includes(model.id) ? 'bg-primary/10' : 'hover:bg-base-200/80',
                      ].join(' ')}
                    >
                      <label className="min-w-0 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedModelIds.includes(model.id)}
                          onChange={() => toggleModel(model.id)}
                          aria-label={`Use ${model.displayName}`}
                          disabled={disabled || editingCustomModelId !== null}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium break-words">{model.displayName}</div>
                          <div className="mt-1 break-all font-mono text-xs text-base-content/60">{model.id}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <StatusBadge tone="ghost" size="sm">
                              {modelCapabilityLabel('Input', model.capabilities.inputModalities)}
                            </StatusBadge>
                            <StatusBadge tone="ghost" size="sm">
                              {modelCapabilityLabel('Output', model.capabilities.outputModalities)}
                            </StatusBadge>
                            {model.capabilities.tools && <StatusBadge tone="ghost" size="sm">Tools</StatusBadge>}
                            {model.capabilities.reasoning && <StatusBadge tone="ghost" size="sm">Reasoning</StatusBadge>}
                          </div>
                        </div>
                      </label>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          onClick={() => startEditingCustomModel(model)}
                          aria-label={`Edit ${model.displayName}`}
                          title={`Edit ${model.displayName}`}
                          disabled={disabled || editingCustomModelId !== null}
                        >
                          <Icon name="edit" size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          className="text-error"
                          onClick={() => removeCustomModel(model.id)}
                          aria-label={`Remove ${model.displayName}`}
                          title={`Remove ${model.displayName}`}
                          disabled={disabled || editingCustomModelId !== null}
                        >
                          <Icon name="trash" size={14} />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {editingCustomModelId !== null && (
                <div className="rounded-box border border-base-300 bg-base-200/40 p-4">
                  <h3 className="text-sm font-semibold">
                    {editingCustomModelId === NEW_CUSTOM_MODEL
                      ? 'Add custom model'
                      : catalogModelIds.has(editingCustomModelId)
                        ? 'Customize catalog model'
                        : 'Edit custom model'}
                  </h3>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="connection-model-editor-id">Model ID</label>
                      <TextInput
                        id="connection-model-editor-id"
                        bordered={false}
                        className="w-full"
                        value={customForm.id}
                        onChange={(event) => setCustomForm({ ...customForm, id: event.target.value })}
                        placeholder="provider/model-id"
                        disabled={disabled || catalogModelIds.has(editingCustomModelId)}
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="connection-model-editor-name">
                        Display name
                      </label>
                      <TextInput
                        id="connection-model-editor-name"
                        bordered={false}
                        className="w-full"
                        value={customForm.displayName}
                        onChange={(event) => setCustomForm({ ...customForm, displayName: event.target.value })}
                        placeholder="Optional friendly name"
                        disabled={disabled}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="connection-model-editor-context">
                        Context limit
                      </label>
                      <TextInput
                        id="connection-model-editor-context"
                        bordered={false}
                        className="w-full"
                        inputMode="numeric"
                        value={customForm.contextTokens}
                        onChange={(event) => setCustomForm({ ...customForm, contextTokens: event.target.value })}
                        placeholder="Unknown"
                        disabled={disabled}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="connection-model-editor-output">
                        Output limit
                      </label>
                      <TextInput
                        id="connection-model-editor-output"
                        bordered={false}
                        className="w-full"
                        inputMode="numeric"
                        value={customForm.outputTokens}
                        onChange={(event) => setCustomForm({ ...customForm, outputTokens: event.target.value })}
                        placeholder="Unknown"
                        disabled={disabled}
                      />
                    </div>
                    <div className="grid gap-4 md:col-span-2 md:grid-cols-2">
                      {(['inputModalities', 'outputModalities'] as const).map((direction) => (
                        <fieldset key={direction} className="min-w-0">
                          <legend className="mb-2 text-sm font-medium">
                            {direction === 'inputModalities'
                              ? 'Input capabilities'
                              : 'Output capabilities'}
                          </legend>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {CONNECTION_MODEL_MODALITIES.map((modality) => {
                              const selected = customForm[direction];
                              const checked = selected.includes(modality);
                              return (
                                <label
                                  key={modality}
                                  className={[
                                    'flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm transition-colors',
                                    checked
                                      ? 'border-primary/20 bg-primary/10'
                                      : 'border-base-300 hover:bg-base-200/80',
                                  ].join(' ')}
                                >
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={checked}
                                    onChange={() => toggleModality(direction, modality)}
                                    disabled={disabled || (checked && selected.length === 1)}
                                  />
                                  <span>{modalityLabel(modality)}</span>
                                </label>
                              );
                            })}
                          </div>
                        </fieldset>
                      ))}
                    </div>
                  </div>
                  <p className="label mt-2">
                    Choose every modality this connection model accepts and returns. At least one
                    capability is required in each direction.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <label
                      className={[
                        'flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm transition-colors',
                        customForm.tools
                          ? 'border-primary/20 bg-primary/10'
                          : 'border-base-300 hover:bg-base-200/80',
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={customForm.tools}
                        onChange={(event) => setCustomForm({ ...customForm, tools: event.target.checked })}
                        disabled={disabled}
                      />
                      <span>Supports tools</span>
                    </label>
                    <label
                      className={[
                        'flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm transition-colors',
                        customForm.reasoning
                          ? 'border-primary/20 bg-primary/10'
                          : 'border-base-300 hover:bg-base-200/80',
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={customForm.reasoning}
                        onChange={(event) => setCustomForm({ ...customForm, reasoning: event.target.checked })}
                        disabled={disabled}
                      />
                      <span>Supports reasoning</span>
                    </label>
                  </div>
                  {customForm.reasoning && (
                    <div className="mt-4 rounded-box border border-base-300 bg-base-100/60 p-4">
                      <h4 className="text-sm font-semibold">Reasoning effort</h4>
                      <p className="mt-0.5 text-xs text-base-content/60">
                        Define the effort levels this model accepts and a default effort.
                      </p>
                      <ReasoningFields
                        key={editingCustomModelId}
                        modelId={editingCustomModelId}
                        displayName={customForm.displayName.trim() || customForm.id.trim() || 'this model'}
                        levels={reasoningDraft.levels}
                        default={reasoningDraft.default}
                        disabled={disabled}
                        onChange={(levels, def) => setReasoningDraft({ levels: [...levels], default: def })}
                      />
                    </div>
                  )}
                  <div className="mt-4 flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={cancelCustomModel}
                      disabled={disabled}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveCustomModel}
                      disabled={disabled}
                    >
                      {editingCustomModelId === NEW_CUSTOM_MODEL ? 'Add model' : 'Save model'}
                    </Button>
                  </div>
                </div>
              )}
            </Panel>

            {orphanModelIds.length > 0 && (
              <Alert tone="warning" icon="alert">
                These saved model IDs no longer have catalog or custom metadata: {' '}
                {orphanModelIds.join(', ')}. Saving preserves them until you remove them.
              </Alert>
            )}

            {selectedModelIds.length === 0 && (
              <Alert tone="warning" role="status" icon="alert">
                This connection will have no selectable models.
              </Alert>
            )}
            {error && (
              <Alert tone="error" icon="alertCircle" aria-live="assertive">{error}</Alert>
            )}
    </>
  );
}
