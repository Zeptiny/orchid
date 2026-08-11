/** Unified model listing for connection setup and editing: catalog, live-discovered, and custom rows share one list with identical affordances and a provenance badge. */
import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderDiscoverModelsResult,
  ProviderModelOption,
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
import { Select } from '../ui/Select';
import { StatusBadge, type StatusBadgeTone } from '../ui/StatusBadge';
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
  /** Per-model service tier selections (R20); only rendered for tier-capable rows. */
  readonly tierSelections?: Record<string, string>;
  readonly disabled?: boolean;
  /** Unified listing rows from the main process (edit mode); locally composed when absent. */
  readonly unifiedModels?: readonly ProviderModelOption[] | null;
  readonly discoveryAvailable?: boolean;
  readonly discovering?: boolean;
  readonly onDiscoverModels?: () => Promise<ProviderDiscoverModelsResult>;
  readonly onSelectedModelIdsChange: (modelIds: readonly string[]) => void;
  readonly onCustomModelsChange: (models: readonly CustomConnectionModel[]) => void;
  readonly onReasoningConfigChange: (config: Record<string, ReasoningModelConfig>) => void;
  readonly onTierSelectionsChange?: (selections: Record<string, string>) => void;
  readonly onEditingChange?: (editing: boolean) => void;
}

/** One row of the unified listing, regardless of the model's origin. */
interface EditorModelRow {
  readonly view: ProviderModelView;
  readonly source: 'catalog' | 'provider' | 'user';
  readonly customized: boolean;
  readonly discoveredAt: string | null;
  /** User-defined with no catalog/discovered layer beneath it. */
  readonly removable: boolean;
  /** Tier selector data when the driver declares a tier mechanism (R20). */
  readonly tierOptions?: ProviderModelOption['tierOptions'];
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

function sourceLabel(source: EditorModelRow['source']): string {
  switch (source) {
    case 'catalog':
      return 'Catalog';
    case 'provider':
      return 'Discovered';
    case 'user':
      return 'Custom';
  }
}

function sourceTone(source: EditorModelRow['source']): StatusBadgeTone {
  switch (source) {
    case 'catalog':
      return 'ghost';
    case 'provider':
      return 'info';
    case 'user':
      return 'primary';
  }
}

function describeDiscoveryError(error: unknown): string {
  return error instanceof Error ? error.message : 'Live model discovery could not be completed.';
}

export function ConnectionModelsEditor({
  protocol,
  definition,
  selectedModelIds,
  customModels,
  reasoningConfig,
  tierSelections = {},
  disabled = false,
  unifiedModels = null,
  discoveryAvailable = false,
  discovering = false,
  onDiscoverModels,
  onSelectedModelIdsChange,
  onCustomModelsChange,
  onReasoningConfigChange,
  onTierSelectionsChange,
  onEditingChange,
}: ConnectionModelsEditorProps) {
  const [editingCustomModelId, setEditingCustomModelId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState<CustomModelForm>(EMPTY_CUSTOM_MODEL);
  const [reasoningDraft, setReasoningDraft] = useState<ReasoningModelConfig>(EMPTY_REASONING_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const rows = useMemo<readonly EditorModelRow[]>(() => {
    const overrideView = (
      view: ProviderModelView,
      override: CustomConnectionModel | undefined,
    ): ProviderModelView => override
      ? {
        ...view,
        displayName: override.displayName,
        capabilities: { ...override.capabilities },
        limits: { ...override.limits },
      }
      : view;
    if (unifiedModels) {
      const unified: EditorModelRow[] = unifiedModels.map((option) => {
        const override = customModels.find((candidate) => candidate.id === option.model.id);
        const layered = option.model.source !== 'user' || option.discoveredAt !== null;
        // Local drafts initialize from the saved connection, so they track
        // override add/reset immediately without waiting on a refetch.
        const customized = override !== undefined && layered;
        return {
          view: overrideView(option.model, override),
          source: option.model.source,
          customized,
          discoveredAt: option.discoveredAt,
          removable: option.model.source === 'user' && !customized,
          tierOptions: option.tierOptions,
        };
      });
      // Custom drafts saved locally but not yet persisted never wait for a refresh.
      for (const model of customModels) {
        if (unified.some((row) => row.view.id === model.id)) continue;
        unified.push({
          view: {
            id: model.id,
            displayName: model.displayName,
            protocol: model.protocol,
            lifecycle: null,
            source: 'user',
            capabilities: { ...model.capabilities },
            limits: { ...model.limits },
          },
          source: 'user',
          customized: false,
          discoveredAt: null,
          removable: true,
        });
      }
      return unified;
    }
    const local: EditorModelRow[] = catalogModels.map((model) => {
      const override = customModels.find((candidate) => candidate.id === model.id);
      return {
        view: overrideView(model, override),
        source: 'catalog',
        customized: override !== undefined,
        discoveredAt: null,
        removable: false,
      };
    });
    for (const model of customModels) {
      if (catalogModelIds.has(model.id)) continue;
      local.push({
        view: {
          id: model.id,
          displayName: model.displayName,
          protocol: model.protocol,
          lifecycle: null,
          source: 'user',
          capabilities: { ...model.capabilities },
          limits: { ...model.limits },
        },
        source: 'user',
        customized: false,
        discoveredAt: null,
        removable: true,
      });
    }
    return local;
  }, [unifiedModels, catalogModels, catalogModelIds, customModels]);

  const selectableModelIds = useMemo(
    () => rows.map((row) => row.view.id),
    [rows],
  );
  const discoveredRowIds = useMemo(
    () => new Set(rows.filter((row) => row.discoveredAt !== null).map((row) => row.view.id)),
    [rows],
  );
  const allModelsSelected = selectableModelIds.length > 0
    && selectableModelIds.every((modelId) => selectedModelIds.includes(modelId));
  const orphanModelIds = selectedModelIds.filter(
    (modelId) => !selectableModelIds.includes(modelId),
  );

  useEffect(() => {
    onEditingChange?.(editingCustomModelId !== null);
  }, [editingCustomModelId, onEditingChange]);

  const toggleModel = (modelId: string) => {
    onSelectedModelIdsChange(selectedModelIds.includes(modelId)
      ? selectedModelIds.filter((candidate) => candidate !== modelId)
      : [...selectedModelIds, modelId]);
  };

  const selectTier = (modelId: string, tierId: string) => {
    if (!onTierSelectionsChange) return;
    const next = { ...tierSelections };
    if (tierId === '') delete next[modelId];
    else next[modelId] = tierId;
    onTierSelectionsChange(next);
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

  const startEditingRow = (row: EditorModelRow) => {
    const override = customModels.find((candidate) => candidate.id === row.view.id);
    const editable = override ?? editableCustomModel(row.view, protocol);
    setEditingCustomModelId(row.view.id);
    setCustomForm(formForCustomModel(editable));
    setReasoningDraft(reasoningConfig[row.view.id] ?? EMPTY_REASONING_CONFIG);
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
    const fixedId = editingCustomModelId !== NEW_CUSTOM_MODEL
      && (catalogModelIds.has(editingCustomModelId) || discoveredRowIds.has(editingCustomModelId));
    const catalogModel = catalogModels.find((model) => model.id === editingCustomModelId);
    const id = fixedId ? editingCustomModelId : customForm.id.trim();
    if (!id) {
      setError('Enter the model ID supplied by this provider.');
      return;
    }
    const duplicateCustomModel = customModels.some(
      (model) => model.id === id && model.id !== editingCustomModelId,
    );
    const createsCatalogCollision = catalogModelIds.has(id) && !catalogModel && !fixedId;
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
    if (!existing && !fixedId) {
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

  const resetModelOverride = (modelId: string) => {
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

  const discoverModels = async () => {
    if (!onDiscoverModels) return;
    setNotice(null);
    setError(null);
    try {
      const result = await onDiscoverModels();
      setNotice(result.message);
    } catch (discoverError) {
      // Discovery failures are non-blocking: existing rows stay authoritative.
      setNotice(describeDiscoveryError(discoverError));
    }
  };

  const editingHeading = editingCustomModelId === NEW_CUSTOM_MODEL
    ? 'Add custom model'
    : editingCustomModelId !== null && catalogModelIds.has(editingCustomModelId)
      ? 'Customize catalog model'
      : editingCustomModelId !== null && discoveredRowIds.has(editingCustomModelId)
        ? 'Customize discovered model'
        : 'Edit custom model';

  return (
    <>
            <Panel as="section" className="config-fieldset flex flex-col gap-3">
              <SectionHeader
                title="Models"
                actions={
                  <>
                    <StatusBadge tone="ghost" size="sm" className="whitespace-nowrap">
                      {selectedModelIds.length} selected
                    </StatusBadge>
                    {discoveryAvailable && onDiscoverModels && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void discoverModels()}
                        disabled={disabled || discovering || editingCustomModelId !== null}
                      >
                        <Icon name="refresh" size={14} />
                        {discovering ? 'Fetching…' : 'Fetch models'}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleAllModels}
                      disabled={disabled || editingCustomModelId !== null || selectableModelIds.length === 0}
                      aria-pressed={allModelsSelected}
                    >
                      {allModelsSelected ? 'Deselect all models' : 'Select all models'}
                    </Button>
                    {definition.allowsCustomModels && editingCustomModelId === null && (
                      <Button
                        size="sm"
                        onClick={startAddingCustomModel}
                        disabled={disabled}
                      >
                        <Icon name="plus" size={14} />
                        Add custom model
                      </Button>
                    )}
                  </>
                }
              />
              <p className="label">
                Selected models become available to chat, tier assignment, or RAG according to
                their declared capabilities. Discovered models come from the provider&apos;s live
                endpoint; custom metadata is explicit connection configuration.
              </p>
              {notice && (
                <Alert tone="info" role="status" icon="alertCircle" aria-live="polite">{notice}</Alert>
              )}
              {rows.length === 0 ? (
                <Alert tone="info" role="status" icon="cpu">
                  No models are available for this connection protocol.
                </Alert>
              ) : (
                <ul className="list max-h-96 overflow-y-auto rounded-box border border-base-300 bg-base-100">
                  {rows.map((row) => {
                    const selected = selectedModelIds.includes(row.view.id);
                    return (
                      <li
                        key={row.view.id}
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
                            onChange={() => toggleModel(row.view.id)}
                            aria-label={`Use ${row.view.displayName}`}
                            disabled={disabled || editingCustomModelId !== null}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium break-words">{row.view.displayName}</span>
                              <StatusBadge
                                size="sm"
                                tone={sourceTone(row.source)}
                                title={row.discoveredAt ? `Discovered ${row.discoveredAt}` : undefined}
                              >
                                {sourceLabel(row.source)}
                              </StatusBadge>
                              {row.customized && <StatusBadge size="sm">Customized</StatusBadge>}
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-base-content/60">{row.view.id}</div>
                            {row.view.capabilities && (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <StatusBadge tone="ghost" size="sm">
                                  {modelCapabilityLabel('Input', customModalities(row.view.capabilities.inputModalities))}
                                </StatusBadge>
                                <StatusBadge tone="ghost" size="sm">
                                  {modelCapabilityLabel('Output', customModalities(row.view.capabilities.outputModalities))}
                                </StatusBadge>
                                {row.view.capabilities.tools && <StatusBadge tone="ghost" size="sm">Tools</StatusBadge>}
                                {row.view.capabilities.reasoning && <StatusBadge tone="ghost" size="sm">Reasoning</StatusBadge>}
                              </div>
                            )}
                            {row.tierOptions && row.tierOptions.tiers.length > 0 && (
                              <div className="mt-2 flex items-center gap-2">
                                <label
                                  className="text-xs text-base-content/60"
                                  htmlFor={`tier-select-${row.view.id}`}
                                >
                                  Service tier
                                </label>
                                <Select
                                  id={`tier-select-${row.view.id}`}
                                  size="xs"
                                  className="rounded-md"
                                  value={tierSelections[row.view.id] ?? row.tierOptions.selected ?? ''}
                                  disabled={disabled || editingCustomModelId !== null}
                                  onChange={(event) => selectTier(row.view.id, event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <option value="">Standard</option>
                                  {row.tierOptions.tiers.map((tier) => (
                                    <option key={tier.id} value={tier.id}>
                                      {tier.displayName ?? tier.id}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                            )}
                          </div>
                        </label>
                        <div className="flex shrink-0 flex-wrap items-start justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            onClick={() => startEditingRow(row)}
                            aria-label={`Edit ${row.view.displayName}`}
                            title={`Edit ${row.view.displayName}`}
                            disabled={disabled || editingCustomModelId !== null}
                          >
                            <Icon name="edit" size={14} />
                          </Button>
                          {row.customized && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => resetModelOverride(row.view.id)}
                              title="Reset to the underlying metadata"
                              disabled={disabled || editingCustomModelId !== null}
                            >
                              Reset
                            </Button>
                          )}
                          {row.removable && (
                            <Button
                              variant="ghost"
                              size="sm"
                              shape="square"
                              className="text-error"
                              onClick={() => removeCustomModel(row.view.id)}
                              aria-label={`Remove ${row.view.displayName}`}
                              title={`Remove ${row.view.displayName}`}
                              disabled={disabled || editingCustomModelId !== null}
                            >
                              <Icon name="trash" size={14} />
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!definition.allowsCustomModels && (
                <p className="label">This provider accepts catalog models only.</p>
              )}

              {editingCustomModelId !== null && (
                <div className="rounded-box border border-base-300 bg-base-200/40 p-4">
                  <h3 className="text-sm font-semibold">{editingHeading}</h3>
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
                        disabled={disabled || catalogModelIds.has(editingCustomModelId) || discoveredRowIds.has(editingCustomModelId)}
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
                These saved model IDs no longer have catalog, discovered, or custom metadata: {' '}
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
