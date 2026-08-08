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
  ReasoningModelConfig,
} from '../../../shared/types/provider';
import { isTextGenerationModel } from '../../utils/models';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { DialogSurface } from '../ui/DialogSurface';
import { FormField } from '../ui/FormField';
import { IconButton } from '../ui/IconButton';
import { Panel } from '../ui/Panel';
import { PopoverList, type PopoverListOption } from '../ui/PopoverList';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { StatusBadge } from '../ui/StatusBadge';
import { TextInput } from '../ui/TextInput';
import {
  ConnectionModelsEditor,
  connectionCustomModelDrafts,
} from './ConnectionModelsDialog';

export interface ProviderConnectionCompletion {
  readonly connection: ProviderConnectionView;
  readonly selection: ModelSelection | null;
  readonly message: string | null;
}

export interface ConnectionWizardProps {
  readonly isOpen: boolean;
  readonly definitions: readonly ProviderDefinitionView[];
  readonly secureStorage: ProviderOverview['secureStorage'];
  readonly onClose: () => void;
  readonly onCreate: (message: ProviderConnectionCreateMessage) => Promise<ProviderMutationResult>;
  /** Present when editing an existing connection instead of creating another account. */
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

function defaultModelIds(
  definition: ProviderDefinitionView | undefined,
  protocol: ProviderProtocol,
): readonly string[] {
  const model = definition?.models.find(
    (candidate) => candidate.protocol === protocol
      && modelAvailable(candidate)
      && isTextGenerationModel(candidate),
  );
  return model ? [model.id] : [];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Provider setup could not be completed.';
}

/**
 * A keyboard-first modal that creates or edits one complete connection.
 * It intentionally does not offer credential-handle editing.
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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const previousTargetIdRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const [providerId, setProviderId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-compatible');
  const [authMethod, setAuthMethod] = useState<ProviderAuthMethod>('api-key');
  const [connectionModelIds, setConnectionModelIds] = useState<readonly string[]>([]);
  const [connectionCustomModels, setConnectionCustomModels] = useState<readonly CustomConnectionModel[]>([]);
  const [reasoningConfig, setReasoningConfig] = useState<Record<string, ReasoningModelConfig>>({});
  const [modelsEditing, setModelsEditing] = useState(false);
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
  const providerPickerOptions = useMemo<readonly PopoverListOption[]>(
    () => definitions.map((definition) => ({
      value: definition.id,
      label: definition.displayName,
      disabled: !definition.available,
    })),
    [definitions],
  );
  const supportsCustomEndpoint =
    selectedDefinition?.allowsCustomModels === true &&
    (selectedDefinition.id === 'generic-openai-compatible' ||
      selectedDefinition.id === 'generic-anthropic-compatible');
  const apiKeyPersistenceAvailable = secureStorage.available;
  const endpointChanged = Boolean(
    existingConnection
      && supportsCustomEndpoint
      && endpoint.trim() !== (existingConnection.endpoint ?? ''),
  );
  const requiresNewApiKey = authMethod === 'api-key' && (
    !existingConnection
      || existingConnection.authMethod !== 'api-key'
      || endpointChanged
  );
  const metadataLocked = submitting || (pendingConnection !== null && !existingConnection);

  const resetForDefinition = useCallback((definition: ProviderDefinitionView | undefined) => {
    const nextProtocol = defaultProtocol(definition);
    setProviderId(definition?.id ?? '');
    setConnectionName(definition?.displayName ?? '');
    setProtocol(nextProtocol);
    setAuthMethod(defaultAuthMethod(definition));
    setConnectionModelIds(defaultModelIds(definition, nextProtocol));
    setConnectionCustomModels([]);
    setReasoningConfig({});
    setModelsEditing(false);
    setEndpoint('');
    setAllowInsecureHttp(false);
    setEnvironmentVariable('');
    setApiKey('');
    setPendingConnection(null);
    setFeedback(null);
    setError(null);
  }, []);

  const resetForExistingConnection = useCallback((connection: ProviderConnectionView) => {
    setProviderId(connection.providerId);
    setConnectionName(connection.name);
    setProtocol(connection.protocol);
    setAuthMethod(connection.authMethod);
    setConnectionModelIds([...connection.modelIds]);
    setConnectionCustomModels(connectionCustomModelDrafts(connection));
    setReasoningConfig(connection.reasoningConfig ?? {});
    setModelsEditing(false);
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
    setConnectionModelIds(defaultModelIds(selectedDefinition ?? undefined, nextProtocol));
    setConnectionCustomModels([]);
    setModelsEditing(false);
    setError(null);
  };

  const buildConnectionMessage = ():
    { message: ProviderConnectionCreateMessage; selectionModelId: string } | { error: string } => {
    if (!selectedDefinition || !selectedDefinition.available) {
      return { error: 'Choose an enabled provider preset.' };
    }
    const name = connectionName.trim();
    if (!name) return { error: 'Enter a name that identifies this account or endpoint.' };
    if (!existingConnection && connectionModelIds.length === 0) {
      return { error: 'Select at least one model for this connection.' };
    }
    if (supportsCustomEndpoint && !endpoint.trim()) {
      return { error: 'Enter the custom endpoint URL for this connection.' };
    }
    if (authMethod === 'environment' && !environmentVariable.trim()) {
      return { error: 'Enter the environment variable that holds this provider credential.' };
    }
    if (requiresNewApiKey && !apiKey.trim()) {
      return { error: 'Enter the API key once so Orchid can store it securely.' };
    }

    const modelIds = [...connectionModelIds];
    const customModels = [...connectionCustomModels];
    const selectionModelId = existingConnection ? '' : connectionModelIds[0] ?? '';

    return {
      selectionModelId,
      message: {
        providerId: selectedDefinition.id,
        name,
        protocol,
        authMethod,
        modelIds,
        customModels,
        ...(Object.keys(reasoningConfig).length > 0 ? { reasoningConfig } : {}),
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
    authMethod: message.authMethod,
    modelIds: message.modelIds,
    customModels: message.customModels ?? [],
    reasoningConfig,
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
      message: result.message,
    });
    close(true);
    return true;
  };

  const finishExistingUpdate = async (result: ProviderMutationResult): Promise<void> => {
    setPendingConnection(result.connection);
    await onComplete?.({ connection: result.connection, selection: null, message: result.message });
    close(true);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const built = buildConnectionMessage();
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
      let latestResult: ProviderMutationResult;
      if (existingConnection) {
        if (!onUpdate) throw new Error('Connection editing is unavailable in this build.');
        const updated = await onUpdate(updateMessageForExisting(existingConnection.id, built.message));
        latestResult = updated;
        connection = updated.connection;
        setPendingConnection(connection);
        if (updated.message) setFeedback(updated.message);
      } else if (!connection) {
        const created = await onCreate(built.message);
        latestResult = created;
        connection = created.connection;
        setPendingConnection(connection);
        if (created.message) setFeedback(created.message);
      } else {
        latestResult = { connection, message: null };
      }

      const apiKeyProvided = authMethod === 'api-key' && apiKey.trim().length > 0;
      if (apiKeyProvided) {
        let authenticated: ProviderMutationResult;
        try {
          authenticated = await onSubmitApiKey({ connectionId: connection.id, apiKey });
        } finally {
          // A pasted API key lives only until its one-shot IPC request settles.
          setApiKey('');
        }
        latestResult = authenticated;
      } else if (!existingConnection) {
        latestResult = await onValidate({ connectionId: connection.id });
      }

      const authenticationChanged = Boolean(existingConnection) && (
        authMethod !== existingConnection?.authMethod
          || apiKeyProvided
          || endpointChanged
          || (authMethod === 'environment'
            && environmentVariable.trim() !== (existingConnection?.environmentVariable ?? ''))
      );
      if (existingConnection && !authenticationChanged) {
        await finishExistingUpdate(latestResult);
        return;
      }
      await finishIfReady(latestResult, built.selectionModelId);
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <DialogSurface
      isOpen={isOpen}
      onClose={() => close()}
      labelledBy="provider-connection-wizard-title"
      initialFocusRef={nameInputRef}
      variant="modal"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      className="provider-connection-wizard"
      overlayClassName="modal modal-open provider-connection-wizard"
      panelClassName="modal-box"
    >
        <SectionHeader
          className="provider-wizard-header"
          title={
            <h2 id="provider-connection-wizard-title" className="text-base font-semibold tracking-tight">
              {existingConnection ? `Edit connection · ${existingConnection.name}` : 'Connect a provider'}
            </h2>
          }
          description={
            existingConnection
              ? 'Update connection details, authentication, and models in one place.'
              : 'Connections are independent accounts or endpoints. Orchid never chooses one automatically.'
          }
          actions={
            <IconButton
              label={existingConnection ? 'Close connection editor' : 'Close provider connection setup'}
              icon="x"
              size="sm"
              iconSize={16}
              onClick={() => close()}
              disabled={submitting}
            />
          }
        />

        {availableDefinitions.length === 0 ? (
          <div className="provider-wizard-body">
            <Alert tone="warning" icon="alert">
              No enabled provider presets are available in this build.
            </Alert>
          </div>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <div className="provider-wizard-body">
              <Panel as="section" className="config-fieldset flex flex-col gap-3">
                <SectionHeader
                  title={existingConnection ? 'Connection details' : 'Provider and connection'}
                />
                {existingConnection ? (
                  <div className="flex items-center justify-between gap-3 rounded-box bg-base-200 px-3 py-2">
                    <span className="text-sm text-base-content/70">Provider</span>
                    <StatusBadge tone="neutral" size="sm">
                      {selectedDefinition?.displayName ?? providerId}
                    </StatusBadge>
                  </div>
                ) : (
                  <>
                    <label className="label" htmlFor="provider-wizard-preset">
                      Provider preset
                    </label>
                    <PopoverList
                      id="provider-wizard-preset"
                      value={providerId}
                      options={providerPickerOptions}
                      onChange={selectDefinition}
                      label="Select provider preset"
                      title="Provider presets"
                      searchPlaceholder="Search providers..."
                      emptyMessage="No provider presets available"
                      disabled={metadataLocked}
                      triggerIcon="globe"
                      align="start"
                      placement="bottom"
                    />
                    {selectedDefinition?.unavailableReason && (
                      <p className="label text-warning">{selectedDefinition.unavailableReason}</p>
                    )}
                  </>
                )}

                <FormField
                  className="mt-3"
                  label="Connection name"
                  htmlFor="provider-wizard-name"
                  hint="This name distinguishes accounts for the same provider."
                  required
                >
                  <TextInput
                    ref={nameInputRef}
                    id="provider-wizard-name"
                    bordered={false}
                    className="w-full"
                    value={connectionName}
                    onChange={(event) => setConnectionName(event.target.value)}
                    placeholder="e.g. Work account"
                    disabled={metadataLocked}
                    required
                  />
                </FormField>
              </Panel>

              {!existingConnection && (
                <Panel as="section" className="config-fieldset flex flex-col gap-3">
                  <SectionHeader title="Protocol" />
                  <label className="label" htmlFor="provider-wizard-protocol">
                    Connection protocol
                  </label>
                  <Select
                    id="provider-wizard-protocol"
                    bordered={false}
                    className="w-full"
                    value={protocol}
                    onChange={(event) => selectProtocol(event.target.value as ProviderProtocol)}
                    disabled={metadataLocked}
                  >
                    {(selectedDefinition?.supportedProtocols ?? []).map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {protocolLabel(candidate)}
                      </option>
                    ))}
                  </Select>
                  <p className="label">
                    Protocol is fixed after creation. Configure every model for this connection
                    below before saving.
                  </p>
                </Panel>
              )}

              {supportsCustomEndpoint && (
                <Panel as="section" className="config-fieldset flex flex-col gap-3">
                  <SectionHeader title="Custom endpoint" />
                  <label className="label" htmlFor="provider-wizard-endpoint">
                    Base URL
                  </label>
                  <TextInput
                    id="provider-wizard-endpoint"
                    bordered={false}
                    className="w-full"
                    type="url"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://provider.example/v1"
                    disabled={metadataLocked}
                    required
                  />
                  <label className="label mt-2 cursor-pointer justify-start gap-2">
                    <Checkbox
                      size="sm"
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
                </Panel>
              )}

              <Panel as="section" className="config-fieldset flex flex-col gap-3">
                <SectionHeader title="Authentication" />
                <label className="label" htmlFor="provider-wizard-auth">
                  Method
                </label>
                <Select
                  id="provider-wizard-auth"
                  bordered={false}
                  className="w-full"
                  value={authMethod}
                  onChange={(event) => {
                    setAuthMethod(event.target.value as ProviderAuthMethod);
                    setApiKey('');
                    setEnvironmentVariable('');
                    setError(null);
                  }}
                  disabled={metadataLocked}
                >
                  {(selectedDefinition?.supportedAuthMethods ?? []).map((method) => (
                    <option key={method} value={method}>
                      {authMethodLabel(method)}
                    </option>
                  ))}
                </Select>

                {authMethod === 'api-key' && (
                  <>
                    {apiKeyPersistenceAvailable ? (
                      <>
                        <label className="label mt-3" htmlFor="provider-wizard-api-key">
                          API key
                        </label>
                        <TextInput
                          id="provider-wizard-api-key"
                          type="password"
                          autoComplete="off"
                          bordered={false}
                          className="w-full"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder={existingConnection
                            ? 'Leave blank to keep the current credential'
                            : 'Paste once; it is never shown again'}
                          disabled={submitting}
                          required={requiresNewApiKey}
                        />
                        <p className="label">
                          {existingConnection
                            ? 'Enter a new key only to replace the stored credential. It is never shown again.'
                            : 'Submitted once to secure storage, then immediately cleared from this form.'}
                        </p>
                      </>
                    ) : (
                      <Alert tone="warning" className="mt-3" icon="alert">
                        Secure credential storage is unavailable
                        {secureStorage.reason ? ` (${secureStorage.reason})` : ''}.
                        {selectedDefinition?.supportedAuthMethods.includes('environment')
                          ? ' Use an environment variable reference instead.'
                          : ' Choose an available authentication method or restore secure storage before continuing.'}
                      </Alert>
                    )}
                  </>
                )}

                {authMethod === 'environment' && (
                  <>
                    <label className="label mt-3" htmlFor="provider-wizard-environment">
                      Environment variable
                    </label>
                    <TextInput
                      id="provider-wizard-environment"
                      bordered={false}
                      className="w-full"
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

              </Panel>

              {selectedDefinition && (
                <ConnectionModelsEditor
                  key={existingConnection?.id ?? `${selectedDefinition.id}:${protocol}`}
                  protocol={protocol}
                  definition={selectedDefinition}
                  selectedModelIds={connectionModelIds}
                  customModels={connectionCustomModels}
                  reasoningConfig={reasoningConfig}
                  disabled={metadataLocked}
                  onSelectedModelIdsChange={setConnectionModelIds}
                  onCustomModelsChange={setConnectionCustomModels}
                  onReasoningConfigChange={setReasoningConfig}
                  onEditingChange={setModelsEditing}
                />
              )}

              {feedback && (
                <Alert tone="info" role="status" icon="alertCircle" aria-live="polite">{feedback}</Alert>
              )}
              {error && (
                <Alert tone="error" icon="alertCircle" aria-live="assertive">{error}</Alert>
              )}
            </div>

            <div className="provider-wizard-actions">
              <Button
                variant="ghost"
                onClick={() => close()}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || modelsEditing || (requiresNewApiKey && !apiKeyPersistenceAvailable)}
              >
                {submitting
                  ? existingConnection ? 'Saving…' : 'Connecting…'
                  : existingConnection
                    ? 'Save changes'
                    : pendingConnection
                      ? 'Continue setup'
                      : 'Create connection'}
              </Button>
            </div>
          </form>
        )}
    </DialogSurface>
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
    case 'openai-responses':
      return 'OpenAI Responses';
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
