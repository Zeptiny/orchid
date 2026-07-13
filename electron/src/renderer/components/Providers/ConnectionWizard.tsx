/**
 * Provider connection wizard.
 *
 * The wizard collects only renderer-safe connection intent. API keys exist in
 * component state for the one submit invocation and are cleared as soon as
 * that invocation settles; credential handles never enter this component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProviderConnectionCreateMessage,
  ProviderConnectionIdMessage,
  ProviderConnectionUpdateMessage,
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderModelOption,
  ProviderModelView,
  ProviderMutationResult,
  ProviderOverview,
  ProviderSubmitApiKeyMessage,
} from '../../../shared/types/ipc';
import type {
  CustomConnectionModel,
  ModelSelection,
  ProviderAuthMethod,
  ProviderProtocol,
} from '../../../shared/types/provider';
import { useFocusTrap } from '../../keyboard';
import { isTextGenerationModel } from '../../utils/models';
import { Icon } from '../Icon';
import { ModelPicker } from '../ModelPicker';
import { SearchableOptionPicker, type SearchableOption } from '../SearchableOptionPicker';

const CUSTOM_MODEL_VALUE = '__custom_model__';

export interface ProviderConnectionCompletion {
  readonly connection: ProviderConnectionView;
  readonly selection: ModelSelection | null;
}

export interface ConnectionWizardProps {
  readonly isOpen: boolean;
  readonly definitions: readonly ProviderDefinitionView[];
  readonly secureStorage: ProviderOverview['secureStorage'];
  readonly onClose: () => void;
  readonly onCreate: (message: ProviderConnectionCreateMessage) => Promise<ProviderMutationResult>;
  /** Present when repairing an existing connection instead of creating another account. */
  readonly existingConnection?: ProviderConnectionView | null;
  readonly onUpdate?: (message: ProviderConnectionUpdateMessage) => Promise<ProviderMutationResult>;
  readonly onSubmitApiKey: (
    message: ProviderSubmitApiKeyMessage,
  ) => Promise<ProviderMutationResult>;
  readonly onValidate: (message: ProviderConnectionIdMessage) => Promise<ProviderMutationResult>;
  readonly onComplete?: (result: ProviderConnectionCompletion) => void | Promise<void>;
}

function modelAvailable(model: ProviderModelView): boolean {
  return model.lifecycle !== 'disabled' && model.lifecycle !== 'retired';
}

function defaultProtocol(definition: ProviderDefinitionView | undefined): ProviderProtocol {
  return definition?.supportedProtocols[0] ?? 'openai-compatible';
}

function defaultAuthMethod(definition: ProviderDefinitionView | undefined): ProviderAuthMethod {
  return definition?.supportedAuthMethods[0] ?? 'api-key';
}

function firstModelId(
  definition: ProviderDefinitionView | undefined,
  protocol: ProviderProtocol,
): string {
  const model = definition?.models.find(
    (candidate) => candidate.protocol === protocol
      && modelAvailable(candidate)
      && isTextGenerationModel(candidate),
  );
  if (model) return model.id;
  return definition?.allowsCustomModels ? CUSTOM_MODEL_VALUE : '';
}

function parseOptionalLimit(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Provider setup could not be completed.';
}

/**
 * A keyboard-first modal that creates one connection and guides valid
 * authentication. It intentionally does not offer credential-handle editing.
 */
export function ConnectionWizard({
  isOpen,
  definitions,
  secureStorage,
  onClose,
  onCreate,
  existingConnection = null,
  onUpdate,
  onSubmitApiKey,
  onValidate,
  onComplete,
}: ConnectionWizardProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const previousTargetIdRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const [providerId, setProviderId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-compatible');
  const [authMethod, setAuthMethod] = useState<ProviderAuthMethod>('api-key');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customModelName, setCustomModelName] = useState('');
  const [customTools, setCustomTools] = useState(false);
  const [customReasoning, setCustomReasoning] = useState(false);
  const [customContextLimit, setCustomContextLimit] = useState('');
  const [customOutputLimit, setCustomOutputLimit] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [environmentVariable, setEnvironmentVariable] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pendingConnection, setPendingConnection] = useState<ProviderConnectionView | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const availableDefinitions = useMemo(
    () => definitions.filter((definition) => definition.available),
    [definitions],
  );
  const selectedDefinition = useMemo(
    () => definitions.find((definition) => definition.id === providerId) ?? null,
    [definitions, providerId],
  );
  const catalogModels = useMemo(
    () =>
      selectedDefinition?.models.filter(
        (model) => model.protocol === protocol && modelAvailable(model) && isTextGenerationModel(model),
      ) ?? [],
    [protocol, selectedDefinition],
  );
  const providerPickerOptions = useMemo<readonly SearchableOption[]>(
    () => definitions.map((definition) => ({
      value: definition.id,
      label: definition.displayName,
      disabled: !definition.available,
    })),
    [definitions],
  );
  const modelLabels = useMemo(
    () => Object.fromEntries(catalogModels.map((model) => [model.id, model.displayName])),
    [catalogModels],
  );
  const modelDetails = useMemo<Readonly<Record<string, ProviderModelOption>>>(
    () => Object.fromEntries(catalogModels.map((model) => [model.id, {
      selection: { connectionId: 'catalog', modelId: model.id },
      connectionName: '',
      providerId: selectedDefinition?.id ?? '',
      providerDisplayName: selectedDefinition?.displayName ?? null,
      model,
      available: true,
      unavailableReason: null,
    }])),
    [catalogModels, selectedDefinition],
  );
  const additionalModelOptions = useMemo(
    () => selectedDefinition?.allowsCustomModels
      ? [{ value: CUSTOM_MODEL_VALUE, label: 'Custom model…', description: 'Enter a model ID supplied by this endpoint.' }]
      : [],
    [selectedDefinition?.allowsCustomModels],
  );
  const supportsCustomEndpoint =
    selectedDefinition?.allowsCustomModels === true &&
    (selectedDefinition.id === 'generic-openai-compatible' ||
      selectedDefinition.id === 'generic-anthropic-compatible');
  const usesCustomModel = selectedModelId === CUSTOM_MODEL_VALUE;
  const apiKeyPersistenceAvailable = secureStorage.available;
  const metadataLocked = submitting || (pendingConnection !== null && !existingConnection);

  useFocusTrap({
    enabled: isOpen,
    containerRef: dialogRef,
    initialFocusRef: nameInputRef,
  });

  const resetForDefinition = useCallback((definition: ProviderDefinitionView | undefined) => {
    const nextProtocol = defaultProtocol(definition);
    setProviderId(definition?.id ?? '');
    setConnectionName(definition?.displayName ?? '');
    setProtocol(nextProtocol);
    setAuthMethod(defaultAuthMethod(definition));
    setSelectedModelId(firstModelId(definition, nextProtocol));
    setCustomModelId('');
    setCustomModelName('');
    setCustomTools(false);
    setCustomReasoning(false);
    setCustomContextLimit('');
    setCustomOutputLimit('');
    setEndpoint('');
    setAllowInsecureHttp(false);
    setEnvironmentVariable('');
    setApiKey('');
    setPendingConnection(null);
    setFeedback(null);
    setError(null);
  }, []);

  const resetForExistingConnection = useCallback((connection: ProviderConnectionView) => {
    const customModel = connection.customModels[0] ?? null;
    const selected = customModel
      ? CUSTOM_MODEL_VALUE
      : connection.modelIds[0] ?? '';
    setProviderId(connection.providerId);
    setConnectionName(connection.name);
    setProtocol(connection.protocol);
    setAuthMethod(connection.authMethod);
    setSelectedModelId(selected);
    setCustomModelId(customModel?.id ?? '');
    setCustomModelName(customModel?.displayName ?? '');
    setCustomTools(customModel?.capabilities?.tools ?? false);
    setCustomReasoning(customModel?.capabilities?.reasoning ?? false);
    setCustomContextLimit(customModel?.limits?.contextTokens?.toString() ?? '');
    setCustomOutputLimit(customModel?.limits?.outputTokens?.toString() ?? '');
    setEndpoint(connection.endpoint ?? '');
    setAllowInsecureHttp(connection.allowInsecureHttp);
    setEnvironmentVariable(connection.environmentVariable ?? '');
    setApiKey('');
    setPendingConnection(connection);
    setFeedback(connection.health === 'needs_attention'
      ? 'Reconnect this connection with its existing trusted provider settings.'
      : connection.health === 'disconnected'
        ? 'This connection is disconnected. Authenticate it again to reconnect.'
        : null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      previousTargetIdRef.current = null;
      setApiKey('');
      return;
    }
    const currentDefinition = availableDefinitions.find(
      (definition) => definition.id === providerId,
    );
    const targetId = existingConnection?.id ?? null;
    if (!wasOpenRef.current || previousTargetIdRef.current !== targetId || !currentDefinition) {
      if (existingConnection) {
        resetForExistingConnection(existingConnection);
      } else {
        resetForDefinition(currentDefinition ?? availableDefinitions[0]);
      }
    }
    wasOpenRef.current = true;
    previousTargetIdRef.current = targetId;
  }, [
    availableDefinitions,
    existingConnection,
    isOpen,
    providerId,
    resetForDefinition,
    resetForExistingConnection,
  ]);

  const close = useCallback(
    (force = false) => {
      if (submitting && !force) return;
      setApiKey('');
      onClose();
    },
    [onClose, submitting],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, isOpen]);

  const selectDefinition = (nextProviderId: string) => {
    const definition = availableDefinitions.find((candidate) => candidate.id === nextProviderId);
    if (definition) resetForDefinition(definition);
  };

  const selectProtocol = (nextProtocol: ProviderProtocol) => {
    setProtocol(nextProtocol);
    setSelectedModelId(firstModelId(selectedDefinition ?? undefined, nextProtocol));
    setError(null);
  };

  const buildCustomModel = (): { model: CustomConnectionModel } | { error: string } => {
    const id = customModelId.trim();
    if (!id) return { error: 'Enter the model ID supplied by this endpoint.' };
    const contextTokens = parseOptionalLimit(customContextLimit);
    const outputTokens = parseOptionalLimit(customOutputLimit);
    if (contextTokens === undefined || outputTokens === undefined) {
      return { error: 'Custom model limits must be positive whole numbers or left blank.' };
    }
    return {
      model: {
        id,
        displayName: customModelName.trim() || id,
        protocol,
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: customTools,
          reasoning: customReasoning,
        },
        limits: { contextTokens, outputTokens },
      },
    };
  };

  const buildCreateMessage = ():
    { message: ProviderConnectionCreateMessage; selectionModelId: string } | { error: string } => {
    if (!selectedDefinition || !selectedDefinition.available) {
      return { error: 'Choose an enabled provider preset.' };
    }
    const name = connectionName.trim();
    if (!name) return { error: 'Enter a name that identifies this account or endpoint.' };
    if (!selectedModelId) return { error: 'Choose an initial model for this connection.' };
    if (supportsCustomEndpoint && !endpoint.trim()) {
      return { error: 'Enter the custom endpoint URL for this connection.' };
    }
    if (authMethod === 'environment' && !environmentVariable.trim()) {
      return { error: 'Enter the environment variable that holds this provider credential.' };
    }
    if (authMethod === 'api-key' && !apiKey.trim()) {
      return { error: 'Enter the API key once so Orchid can store it securely.' };
    }

    let modelIds: readonly string[];
    let customModels: readonly CustomConnectionModel[] | undefined;
    let selectionModelId = selectedModelId;
    if (usesCustomModel) {
      const custom = buildCustomModel();
      if ('error' in custom) return custom;
      modelIds = [custom.model.id];
      customModels = [custom.model];
      selectionModelId = custom.model.id;
    } else {
      modelIds = [selectedModelId];
    }

    return {
      selectionModelId,
      message: {
        providerId: selectedDefinition.id,
        name,
        protocol,
        authMethod,
        modelIds,
        ...(customModels ? { customModels } : {}),
        ...(supportsCustomEndpoint ? { endpoint: endpoint.trim(), allowInsecureHttp } : {}),
        ...(authMethod === 'environment'
          ? { environmentVariable: environmentVariable.trim() }
          : {}),
      },
    };
  };

  const updateMessageForExisting = (
    connectionId: string,
    message: ProviderConnectionCreateMessage,
  ): ProviderConnectionUpdateMessage => ({
    connectionId,
    name: message.name,
    modelIds: message.modelIds,
    customModels: message.customModels ?? [],
    ...(message.endpoint === undefined ? {} : { endpoint: message.endpoint }),
    ...(message.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: message.allowInsecureHttp }),
    ...(message.environmentVariable === undefined
      ? {}
      : { environmentVariable: message.environmentVariable }),
  });

  const finishIfReady = async (
    result: ProviderMutationResult,
    selectionModelId: string,
  ): Promise<boolean> => {
    setPendingConnection(result.connection);
    if (result.connection.health !== 'ready') {
      setFeedback(result.message ?? 'Connection needs attention before it can be used.');
      return false;
    }
    await onComplete?.({
      connection: result.connection,
      selection: selectionModelId
        ? { connectionId: result.connection.id, modelId: selectionModelId }
        : null,
    });
    close(true);
    return true;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const built = buildCreateMessage();
    if ('error' in built) {
      setError(built.error);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      let connection = pendingConnection;
      if (existingConnection) {
        if (!onUpdate) throw new Error('Connection repair is unavailable in this build.');
        const updated = await onUpdate(updateMessageForExisting(existingConnection.id, built.message));
        connection = updated.connection;
        setPendingConnection(connection);
        if (updated.message) setFeedback(updated.message);
      } else if (!connection) {
        const created = await onCreate(built.message);
        connection = created.connection;
        setPendingConnection(connection);
        if (created.message) setFeedback(created.message);
      }

      if (authMethod === 'api-key') {
        let authenticated: ProviderMutationResult;
        try {
          authenticated = await onSubmitApiKey({ connectionId: connection.id, apiKey });
        } finally {
          // A pasted API key lives only until its one-shot IPC request settles.
          setApiKey('');
        }
        await finishIfReady(authenticated, built.selectionModelId);
        return;
      }

      const validated = await onValidate({ connectionId: connection.id });
      await finishIfReady(validated, built.selectionModelId);
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-open provider-connection-wizard"
      open
      aria-modal="true"
      aria-labelledby="provider-connection-wizard-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-box">
        <header className="provider-wizard-header">
          <div className="min-w-0">
            <h2 id="provider-connection-wizard-title" className="text-base font-semibold tracking-tight">
              {existingConnection ? `Reconnect ${existingConnection.name}` : 'Connect a provider'}
            </h2>
            <p className="mt-1 text-sm text-base-content/70">
              Connections are independent accounts or endpoints. Orchid never chooses one
              automatically.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            aria-label="Close provider connection setup"
            onClick={() => close()}
            disabled={submitting}
          >
            <Icon name="x" size={16} />
          </button>
        </header>

        {availableDefinitions.length === 0 ? (
          <div className="provider-wizard-body">
            <div role="alert" className="alert alert-warning">
              <Icon name="alert" size={16} />
              <span>No enabled provider presets are available in this build.</span>
            </div>
          </div>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <div className="provider-wizard-body">
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Provider and connection</legend>
                <label className="label" htmlFor="provider-wizard-preset">
                  Provider preset
                </label>
                <SearchableOptionPicker
                  id="provider-wizard-preset"
                  value={providerId}
                  options={providerPickerOptions}
                  onChange={selectDefinition}
                  label="Select provider preset"
                  title="Provider presets"
                  searchPlaceholder="Search providers..."
                  emptyMessage="No provider presets available"
                  disabled={submitting || pendingConnection !== null}
                />
                {selectedDefinition?.unavailableReason && (
                  <p className="label text-warning">{selectedDefinition.unavailableReason}</p>
                )}

                <label className="label mt-3" htmlFor="provider-wizard-name">
                  Connection name
                </label>
                <input
                  ref={nameInputRef}
                  id="provider-wizard-name"
                  className="input w-full"
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                  placeholder="e.g. Work account"
                  disabled={metadataLocked}
                  required
                />
                <p className="label">This name distinguishes accounts for the same provider.</p>
              </fieldset>

              <div className="grid gap-4 md:grid-cols-2">
                <fieldset className="fieldset">
                  <legend className="fieldset-legend">Protocol</legend>
                  <label className="label" htmlFor="provider-wizard-protocol">
                    Connection protocol
                  </label>
                  <select
                    id="provider-wizard-protocol"
                    className="select w-full"
                    value={protocol}
                    onChange={(event) => selectProtocol(event.target.value as ProviderProtocol)}
                    disabled={submitting || pendingConnection !== null}
                  >
                    {(selectedDefinition?.supportedProtocols ?? []).map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {protocolLabel(candidate)}
                      </option>
                    ))}
                  </select>
                </fieldset>

                <fieldset className="fieldset">
                  <legend className="fieldset-legend">Initial model</legend>
                  <label className="label" htmlFor="provider-wizard-model">
                    Model
                  </label>
                  <ModelPicker
                    key={`${selectedDefinition?.id ?? 'provider'}:${protocol}`}
                    id="provider-wizard-model"
                    value={selectedModelId}
                    options={catalogModels.map((model) => model.id)}
                    optionLabels={modelLabels}
                    optionDetails={modelDetails}
                    additionalOptions={additionalModelOptions}
                    onChange={setSelectedModelId}
                    label="Select initial model"
                    align="start"
                    className="provider-wizard-model-picker"
                    disabled={metadataLocked}
                    emptyMessage="No catalog models available"
                  />
                  <p className="label">The initial selection remains scoped to this connection.</p>
                </fieldset>
              </div>

              {usesCustomModel && (
                <fieldset className="fieldset">
                  <legend className="fieldset-legend">Custom model metadata</legend>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="provider-wizard-custom-model-id">
                        Model ID
                      </label>
                      <input
                        id="provider-wizard-custom-model-id"
                        className="input w-full"
                        value={customModelId}
                        onChange={(event) => setCustomModelId(event.target.value)}
                        placeholder="provider/model-id"
                        disabled={metadataLocked}
                        required
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="provider-wizard-custom-model-name">
                        Display name
                      </label>
                      <input
                        id="provider-wizard-custom-model-name"
                        className="input w-full"
                        value={customModelName}
                        onChange={(event) => setCustomModelName(event.target.value)}
                        placeholder="Optional friendly name"
                        disabled={metadataLocked}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="provider-wizard-context-limit">
                        Context limit
                      </label>
                      <input
                        id="provider-wizard-context-limit"
                        className="input w-full"
                        inputMode="numeric"
                        value={customContextLimit}
                        onChange={(event) => setCustomContextLimit(event.target.value)}
                        placeholder="Unknown"
                        disabled={metadataLocked}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="provider-wizard-output-limit">
                        Output limit
                      </label>
                      <input
                        id="provider-wizard-output-limit"
                        className="input w-full"
                        inputMode="numeric"
                        value={customOutputLimit}
                        onChange={(event) => setCustomOutputLimit(event.target.value)}
                        placeholder="Unknown"
                        disabled={metadataLocked}
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-4">
                    <label className="label cursor-pointer gap-2">
                      <input
                        className="checkbox checkbox-sm"
                        type="checkbox"
                        checked={customTools}
                        onChange={(event) => setCustomTools(event.target.checked)}
                        disabled={metadataLocked}
                      />
                      <span>Supports tools</span>
                    </label>
                    <label className="label cursor-pointer gap-2">
                      <input
                        className="checkbox checkbox-sm"
                        type="checkbox"
                        checked={customReasoning}
                        onChange={(event) => setCustomReasoning(event.target.checked)}
                        disabled={metadataLocked}
                      />
                      <span>Supports reasoning</span>
                    </label>
                  </div>
                  <p className="label">
                    This metadata is explicitly user-provided; Orchid does not infer it from an
                    endpoint.
                  </p>
                </fieldset>
              )}

              {supportsCustomEndpoint && (
                <fieldset className="fieldset">
                  <legend className="fieldset-legend">Custom endpoint</legend>
                  <label className="label" htmlFor="provider-wizard-endpoint">
                    Base URL
                  </label>
                  <input
                    id="provider-wizard-endpoint"
                    className="input w-full"
                    type="url"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://provider.example/v1"
                    disabled={metadataLocked}
                    required
                  />
                  <label className="label mt-2 cursor-pointer justify-start gap-2">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={allowInsecureHttp}
                      onChange={(event) => setAllowInsecureHttp(event.target.checked)}
                      disabled={metadataLocked}
                    />
                    <span>Allow this non-loopback HTTP endpoint</span>
                  </label>
                  <p className="label">
                    Use HTTPS whenever possible. Orchid validates the endpoint before binding any
                    credential.
                  </p>
                </fieldset>
              )}

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Authentication</legend>
                <label className="label" htmlFor="provider-wizard-auth">
                  Method
                </label>
                <select
                  id="provider-wizard-auth"
                  className="select w-full"
                  value={authMethod}
                  onChange={(event) => {
                    setAuthMethod(event.target.value as ProviderAuthMethod);
                    setApiKey('');
                    setEnvironmentVariable('');
                    setError(null);
                  }}
                  disabled={submitting || pendingConnection !== null}
                >
                  {(selectedDefinition?.supportedAuthMethods ?? []).map((method) => (
                    <option key={method} value={method}>
                      {authMethodLabel(method)}
                    </option>
                  ))}
                </select>

                {authMethod === 'api-key' && (
                  <>
                    {apiKeyPersistenceAvailable ? (
                      <>
                        <label className="label mt-3" htmlFor="provider-wizard-api-key">
                          API key
                        </label>
                        <input
                          id="provider-wizard-api-key"
                          type="password"
                          autoComplete="off"
                          className="input w-full"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder="Paste once; it is never shown again"
                          disabled={submitting}
                          required={!pendingConnection}
                        />
                        <p className="label">
                          Submitted once to secure storage, then immediately cleared from this form.
                        </p>
                      </>
                    ) : (
                      <div role="alert" className="alert alert-warning mt-3">
                        <Icon name="alert" size={16} />
                        <span>
                          Secure credential storage is unavailable
                          {secureStorage.reason ? ` (${secureStorage.reason})` : ''}.
                          {selectedDefinition?.supportedAuthMethods.includes('environment')
                            ? ' Use an environment variable reference instead.'
                            : ' Choose an available authentication method or restore secure storage before continuing.'}
                        </span>
                      </div>
                    )}
                  </>
                )}

                {authMethod === 'environment' && (
                  <>
                    <label className="label mt-3" htmlFor="provider-wizard-environment">
                      Environment variable
                    </label>
                    <input
                      id="provider-wizard-environment"
                      className="input w-full"
                      value={environmentVariable}
                      onChange={(event) => setEnvironmentVariable(event.target.value.toUpperCase())}
                      placeholder="PROVIDER_API_KEY"
                      autoCapitalize="characters"
                      autoComplete="off"
                      disabled={metadataLocked}
                      required
                    />
                    <p className="label">
                      Orchid resolves the variable in the main process; its value never enters
                      renderer state.
                    </p>
                  </>
                )}

              </fieldset>

              {feedback && (
                <div role="status" aria-live="polite" className="alert alert-info">
                  <Icon name="alertCircle" size={16} />
                  <span>{feedback}</span>
                </div>
              )}
              {error && (
                <div role="alert" aria-live="assertive" className="alert alert-error">
                  <Icon name="alertCircle" size={16} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <div className="provider-wizard-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => close()}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || (authMethod === 'api-key' && !apiKeyPersistenceAvailable)}
              >
                {submitting
                  ? 'Connecting…'
                  : existingConnection
                    ? 'Reconnect connection'
                    : pendingConnection
                      ? 'Continue setup'
                      : 'Create connection'}
              </button>
            </div>
          </form>
        )}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button
          type="button"
          aria-label="Close provider connection setup"
          onClick={() => close()}
          disabled={submitting}
        >
          close
        </button>
      </form>
    </dialog>
  );
}

function protocolLabel(protocol: ProviderProtocol): string {
  switch (protocol) {
    case 'anthropic-messages':
      return 'Anthropic Messages';
    case 'google-generative-ai':
      return 'Google Generative AI';
    case 'openai-compatible':
      return 'OpenAI-compatible';
    case 'xai':
      return 'xAI';
  }
}

function authMethodLabel(method: ProviderAuthMethod): string {
  switch (method) {
    case 'api-key':
      return 'API key';
    case 'environment':
      return 'Environment variable';
    case 'none':
      return 'No credential';
  }
}
