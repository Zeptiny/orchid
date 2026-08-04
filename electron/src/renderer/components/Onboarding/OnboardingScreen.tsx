/**
 * First-run onboarding wizard.
 *
 * Steps: providers → models → appearance → project → rag → mcp.
 * Finish and skip both set has_completed_onboarding so the wizard does not
 * auto-reopen; provider recovery after completion uses Settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigPatch, ProviderModelOption } from '../../../shared/types/ipc';
import type { Config } from '../../../shared/types/ipc-boundary';
import type { ModelSelection } from '../../../shared/types/provider';
import {
  RECOMMENDED_MCP_SERVERS,
  selectedRecommendedMcpServers,
} from '../../../shared/mcp/recommended-servers';
import { useProviders } from '../../hooks/useProviders';
import { useFocusTrap } from '../../keyboard';
import { emitOrchidEvent } from '../../utils/events';
import { isEmbeddingModel, isTextGenerationModel } from '../../utils/models';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  selectionKey,
} from '../../utils/provider-selection';
import {
  ConnectionWizard,
  type ProviderConnectionCompletion,
} from '../Providers/ConnectionWizard';
import {
  MODEL_ASSIGNMENT_TIERS,
  ModelAssignments,
} from '../Preferences/ModelAssignments';
import { ModelPicker } from '../ModelPicker';
import { TrustProjectDialog } from '../TrustProjectDialog';
import { useTrustPrompt } from '../../hooks/useTrustPrompt';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { FormField } from '../ui/FormField';
import { StatusBadge } from '../ui/StatusBadge';
import { THEMES, THEME_NAMES, type ThemeName } from '../../themes';
import orchidIcon from '../../assets/orchid-icon.svg';

type OnboardingStep =
  | 'providers'
  | 'models'
  | 'appearance'
  | 'project'
  | 'rag'
  | 'mcp';

const STEPS: readonly { id: OnboardingStep; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'project', label: 'Project' },
  { id: 'rag', label: 'RAG' },
  { id: 'mcp', label: 'MCP' },
];

const EMPTY_TIER_MODELS: Record<string, ModelSelection | null> = Object.fromEntries(
  MODEL_ASSIGNMENT_TIERS.map((tier) => [tier.id, null]),
);

const LOCAL_EMBEDDING_MODELS = [
  'fastembed/BAAI/bge-small-en-v1.5',
  'fastembed/BAAI/bge-base-en-v1.5',
  'fastembed/BAAI/bge-large-en-v1.5',
  'fastembed/sentence-transformers/all-MiniLM-L6-v2',
] as const;

const DEFAULT_EMBEDDING_MODEL = LOCAL_EMBEDDING_MODELS[0];

interface OnboardingScreenProps {
  isOpen: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

function copySelection(selection: ModelSelection): ModelSelection {
  return { connectionId: selection.connectionId, modelId: selection.modelId };
}

function stepIndex(step: OnboardingStep): number {
  return STEPS.findIndex((entry) => entry.id === step);
}

export function OnboardingScreen({ isOpen, onComplete, onSkip }: OnboardingScreenProps) {
  const providers = useProviders();
  const [step, setStep] = useState<OnboardingStep>('providers');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null>(null);
  const [tierModels, setTierModels] = useState<Record<string, ModelSelection | null>>(
    EMPTY_TIER_MODELS,
  );
  const [theme, setTheme] = useState<ThemeName>('default');
  const [personality, setPersonality] = useState('default');
  const [personalities, setPersonalities] = useState<readonly string[]>(['default']);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<string>(DEFAULT_EMBEDDING_MODEL);
  const [embeddingApiModel, setEmbeddingApiModel] = useState<ModelSelection | null>(null);
  const [embeddingOptions, setEmbeddingOptions] = useState<readonly ProviderModelOption[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [configTheme, setConfigTheme] = useState<ThemeName>('default');
  /** Inline guidance after declining trust for a picked project folder. */
  const [trustGuidance, setTrustGuidance] = useState<string | null>(null);
  const modelSeededRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Onboarding picks through the raw preload API (no useSession), so it owns
  // its own trust-prompt controller. projectPath advances only once trusted.
  const trustPrompt = useTrustPrompt({
    onGranted: (cwd) => {
      setProjectPath(cwd);
      setTrustGuidance(null);
    },
  });

  const connections = providers.overview?.connections ?? [];
  const readyConnections = useMemo(
    () => connections.filter((connection) => connection.health === 'ready'),
    [connections],
  );
  const connectionSignature = useMemo(
    () => connections
      .map((connection) => `${connection.id}:${connection.health}:${connection.modelIds.join(',')}`)
      .sort()
      .join('|'),
    [connections],
  );

  useFocusTrap({ enabled: isOpen, containerRef });

  useEffect(() => {
    if (isOpen) return;
    setStep('providers');
    setWizardOpen(false);
    setModelOptions([]);
    setModelError(null);
    setDefaultModel(null);
    setTierModels(EMPTY_TIER_MODELS);
    setTheme('default');
    setPersonality('default');
    setPersonalities(['default']);
    setProjectPath(null);
    setEmbeddingModel(DEFAULT_EMBEDDING_MODEL);
    setEmbeddingApiModel(null);
    setEmbeddingOptions([]);
    setSelectedMcpIds([]);
    setSaving(false);
    setSaveError(null);
    setTrustGuidance(null);
    modelSeededRef.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!window.orchid?.config?.get) return;
        const config = await window.orchid.config.get();
        if (cancelled) return;
        const savedTheme = config.theme as ThemeName;
        if (THEME_NAMES.includes(savedTheme)) {
          setTheme(savedTheme);
          setConfigTheme(savedTheme);
        }
        if (config.personality) setPersonality(config.personality);
        if (config.rag?.embedding_model) setEmbeddingModel(config.rag.embedding_model);
        if (config.rag?.embedding_api_model) {
          setEmbeddingApiModel(copySelection(config.rag.embedding_api_model));
        }
        if (typeof config.default_project_dir === 'string' && config.default_project_dir) {
          setProjectPath(config.default_project_dir);
        }
      } catch {
        // Keep onboarding defaults
      }
      try {
        if (!window.orchid?.config?.listPersonalities) return;
        const names = await window.orchid.config.listPersonalities();
        if (!cancelled && names.length > 0) setPersonalities(names);
      } catch {
        // Keep default personality list
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Keep local model options in sync with the shared catalog (already warm
  // after goNext from providers). Seed default + tiers atomically when first
  // options appear so pickers never flash "Not configured".
  useEffect(() => {
    if (!isOpen || providers.modelOptions == null) return;
    const chatOptions = providers.modelOptions.filter(
      (option) => option.available && isTextGenerationModel(option.model),
    );
    const embedOptions = providers.modelOptions.filter((option) => (
      option.available && option.embeddingSupported === true && isEmbeddingModel(option.model)
    ));
    setEmbeddingOptions(embedOptions);

    if (!modelSeededRef.current && chatOptions.length > 0) {
      const firstSelection = copySelection(chatOptions[0].selection);
      setModelOptions(chatOptions);
      setDefaultModel(firstSelection);
      setTierModels(Object.fromEntries(
        MODEL_ASSIGNMENT_TIERS.map((tier) => [tier.id, copySelection(firstSelection)]),
      ));
      modelSeededRef.current = true;
    } else {
      setModelOptions(chatOptions);
    }
  }, [isOpen, providers.modelOptions, connectionSignature]);

  const restoreConfigTheme = useCallback(() => {
    emitOrchidEvent('orchid:set-theme', { theme: configTheme, persist: false });
  }, [configTheme]);

  const markCompleteAndClose = useCallback(async (mode: 'skip' | 'finish') => {
    if (!window.orchid?.config?.save) {
      setSaveError('Configuration saving is unavailable in this build.');
      return;
    }

    if (mode === 'finish' && !defaultModel) {
      setSaveError('Choose a default model before finishing onboarding.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      if (mode === 'skip') {
        restoreConfigTheme();
        await window.orchid.config.save({ updates: { has_completed_onboarding: true } });
        emitOrchidEvent('orchid:config-updated', { has_completed_onboarding: true });
        onSkip();
        return;
      }

      const mcpServers = selectedRecommendedMcpServers(selectedMcpIds);
      const updates: ConfigPatch = {
        default_model: defaultModel,
        tier_models: tierModels,
        theme,
        personality,
        rag: {
          embedding_model: embeddingModel,
          embedding_api_model: embeddingApiModel,
        },
        has_completed_onboarding: true,
      };
      if (Object.keys(mcpServers).length > 0) {
        updates.mcp_servers = mcpServers;
      }

      await window.orchid.config.save({ updates });
      emitOrchidEvent('orchid:config-updated', updates as Partial<Config>);
      emitOrchidEvent('orchid:set-theme', { theme, persist: false });
      if (defaultModel) {
        emitOrchidEvent('orchid:provider-selection-created', { selection: defaultModel });
      }
      onComplete();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Onboarding could not be completed.');
    } finally {
      setSaving(false);
    }
  }, [
    defaultModel,
    embeddingApiModel,
    embeddingModel,
    onComplete,
    onSkip,
    personality,
    restoreConfigTheme,
    selectedMcpIds,
    theme,
    tierModels,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void markCompleteAndClose('skip');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, markCompleteAndClose]);

  const handleProviderComplete = useCallback(async (_result: ProviderConnectionCompletion) => {
    await providers.refresh();
    setWizardOpen(false);
    setSaveError(null);
  }, [providers.refresh]);

  const handleThemeChange = useCallback((name: ThemeName) => {
    setTheme(name);
    emitOrchidEvent('orchid:set-theme', { theme: name, persist: false });
  }, []);

  const handlePickProject = useCallback(async () => {
    if (!window.orchid?.session?.pickProjectDir) {
      setSaveError('Project folder picker is unavailable in this build.');
      return;
    }
    try {
      const info = await window.orchid.session.pickProjectDir();
      if (!info?.cwd) return;
      if (info.trust !== 'trusted') {
        // Untrusted/changed: the dialog decides; projectPath advances only on grant.
        trustPrompt.openFor(info.cwd);
        return;
      }
      setTrustGuidance(null);
      setProjectPath(info.cwd);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not open project folder.');
    }
  }, [trustPrompt.openFor]);

  const handleTrustDecline = useCallback(() => {
    trustPrompt.decline();
    setTrustGuidance(
      'That folder was not trusted, so your default project stayed unchanged. Choose it again to review and trust it, or pick a different folder.',
    );
  }, [trustPrompt.decline]);

  const personalityOptions = useMemo(() => {
    if (personality && !personalities.includes(personality)) {
      return [personality, ...personalities];
    }
    return [...personalities];
  }, [personalities, personality]);

  const activeEmbeddingValue = embeddingApiModel
    ? selectionKey(embeddingApiModel)
    : embeddingModel;

  const providerEmbeddingLabels = useMemo(
    () => Object.fromEntries(embeddingOptions.map((option) => [
      providerModelOptionKey(option),
      providerModelOptionDisplayName(option),
    ])),
    [embeddingOptions],
  );
  const providerEmbeddingDetails = useMemo(
    () => Object.fromEntries(embeddingOptions.map((option) => [
      providerModelOptionKey(option),
      option,
    ])),
    [embeddingOptions],
  );
  const localEmbeddingOptions = useMemo(
    () => LOCAL_EMBEDDING_MODELS.map((model) => ({
      value: model,
      label: model,
      description: 'Local ONNX model',
    })),
    [],
  );

  const handleEmbeddingChange = useCallback((value: string) => {
    const option = embeddingOptions.find((candidate) => providerModelOptionKey(candidate) === value);
    if (option) {
      setEmbeddingApiModel(copySelection(option.selection));
      return;
    }
    if ((LOCAL_EMBEDDING_MODELS as readonly string[]).includes(value)) {
      setEmbeddingApiModel(null);
      setEmbeddingModel(value);
    }
  }, [embeddingOptions]);

  const toggleMcp = useCallback((id: string) => {
    setSelectedMcpIds((current) => (
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id]
    ));
  }, []);

  const currentStepIndex = stepIndex(step);

  const goNext = useCallback(async () => {
    setSaveError(null);
    const next = STEPS[currentStepIndex + 1];
    if (!next) return;
    // Gate step change until target data is ready — keep painting current step.
    if (next.id === 'models' || next.id === 'rag') {
      setModelError(null);
      try {
        await providers.ensureModelList();
      } catch (error: unknown) {
        setModelError(error instanceof Error ? error.message : 'Models could not be loaded.');
        if (next.id === 'models') return;
      }
    }
    setStep(next.id);
  }, [currentStepIndex, providers.ensureModelList]);

  const goBack = useCallback(() => {
    setSaveError(null);
    const prev = STEPS[currentStepIndex - 1];
    if (prev) setStep(prev.id);
  }, [currentStepIndex]);

  if (!isOpen) return null;

  return (
    <>
      <div className="onb-overlay" ref={containerRef}>
        <div className="onb-container">
          <ul className="steps steps-horizontal w-full" aria-label="Onboarding progress">
            {STEPS.map((entry, index) => (
              <li
                key={entry.id}
                className={`step ${index <= currentStepIndex ? 'step-primary' : ''}`}
              >
                {entry.label}
              </li>
            ))}
          </ul>

          {step === 'providers' && (
            <div className="onb-step orchid-view-enter text-left">
              <div className="flex flex-col items-center gap-4 text-center">
                <img src={orchidIcon} alt="Orchid" width={72} height={72} />
                <div className="space-y-2">
                  <h1 className="text-3xl font-semibold">Connect your providers</h1>
                  <p className="onb-step-description">
                    Add one or more provider connections. You can use multiple accounts, endpoints,
                    or providers together.
                  </p>
                </div>
              </div>

              {providers.error && !providers.overview && (
                <Alert
                  tone="warning"
                  action={
                    <Button variant="neutral" size="sm" onClick={() => void providers.refresh()}>
                      Retry
                    </Button>
                  }
                >
                  {providers.error}
                </Alert>
              )}

              {connections.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2" aria-label="Added providers">
                  {connections.map((connection) => (
                    <article key={connection.id} className="config-card">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="config-card-title truncate">{connection.name}</h2>
                          <p className="config-card-desc truncate">
                            {connection.providerDisplayName ?? connection.providerId}
                          </p>
                        </div>
                        <StatusBadge
                          tone={connection.health === 'ready' ? 'success' : 'warning'}
                          size="sm"
                        >
                          {connection.health === 'ready' ? 'Ready' : 'Needs attention'}
                        </StatusBadge>
                      </div>
                      <p className="mt-3 text-xs text-base-content/70">
                        {connection.modelIds.length} model{connection.modelIds.length === 1 ? '' : 's'} selected
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <Alert tone="info" icon="cpu" role="status">
                  Add a provider to unlock model selection and chat.
                </Alert>
              )}

              {saveError && (
                <Alert tone="error" icon="alertCircle">
                  {saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => void markCompleteAndClose('skip')}
                  disabled={saving}
                >
                  Skip onboarding
                </Button>
                <Button
                  variant="neutral"
                  size="md"
                  onClick={() => setWizardOpen(true)}
                  disabled={!providers.overview}
                  icon="plus"
                  iconSize={15}
                >
                  {connections.length > 0 ? 'Add another provider' : 'Add a provider'}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { void goNext(); }}
                  disabled={readyConnections.length === 0}
                >
                  Next: models
                </Button>
              </div>
            </div>
          )}

          {step === 'models' && (
            <div className="onb-step orchid-view-enter text-left">
              <div>
                <h1 className="text-3xl font-semibold">Choose your models</h1>
                <p className="onb-step-description mt-2">
                  Pick the model for new chats and the model each agent tier should use.
                </p>
              </div>

              <ModelAssignments
                options={modelOptions}
                defaultModel={defaultModel}
                tierModels={tierModels}
                onDefaultModelChange={setDefaultModel}
                onTierModelsChange={setTierModels}
                disabled={saving}
              />

              {(modelError || saveError) && (
                <Alert tone="error" icon="alertCircle">
                  {modelError ?? saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button variant="ghost" size="md" onClick={goBack} disabled={saving}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { void goNext(); }}
                  disabled={saving || modelOptions.length === 0 || !defaultModel}
                >
                  Next: appearance
                </Button>
              </div>
            </div>
          )}

          {step === 'appearance' && (
            <div className="onb-step orchid-view-enter text-left">
              <div>
                <h1 className="text-3xl font-semibold">Appearance</h1>
                <p className="onb-step-description mt-2">
                  Choose a theme and agent personality. Theme previews live; both save when you finish.
                </p>
              </div>

              <div className="config-form flex flex-col gap-4">
                <div className="config-form-grid">
                  <FormField label="Theme" htmlFor="onb-theme" className="config-field">
                    <Select
                      id="onb-theme"
                      value={theme}
                      onChange={(e) => handleThemeChange(e.target.value as ThemeName)}
                      className="w-full"
                      disabled={saving}
                    >
                      {THEME_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {THEMES[name]}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="Personality" htmlFor="onb-personality" className="config-field">
                    <Select
                      id="onb-personality"
                      value={personality}
                      onChange={(e) => setPersonality(e.target.value)}
                      className="w-full"
                      disabled={saving}
                    >
                      {personalityOptions.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </Select>
                  </FormField>
                </div>
              </div>

              {saveError && (
                <Alert tone="error" icon="alertCircle">
                  {saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button variant="ghost" size="md" onClick={goBack} disabled={saving}>
                  Back
                </Button>
                <Button variant="primary" size="md" onClick={() => { void goNext(); }} disabled={saving}>
                  Next: project
                </Button>
              </div>
            </div>
          )}

          {step === 'project' && (
            <div className="onb-step orchid-view-enter text-left">
              <div>
                <h1 className="text-3xl font-semibold">Default project folder</h1>
                <p className="onb-step-description mt-2">
                  Optionally pick a project folder. This sets the sticky default for new sessions
                  (same as Open project folder). You can continue without one.
                </p>
              </div>

              {projectPath ? (
                <Alert tone="success" icon="folder" className="gap-3 px-4 py-3" role="status">
                  <span className="min-w-0 truncate">{projectPath}</span>
                </Alert>
              ) : (
                <Alert tone="info" icon="folder" className="gap-3 px-4 py-3" role="status">
                  <span className="min-w-0">No project folder selected yet.</span>
                </Alert>
              )}

              {trustGuidance && (
                <Alert tone="warning" icon="alert" role="status">
                  {trustGuidance}
                </Alert>
              )}

              {saveError && (
                <Alert tone="error" icon="alertCircle">
                  {saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button variant="ghost" size="md" onClick={goBack} disabled={saving}>
                  Back
                </Button>
                <Button
                  variant="neutral"
                  size="md"
                  onClick={() => void handlePickProject()}
                  disabled={saving}
                  icon="folder"
                  iconSize={15}
                >
                  {projectPath ? 'Change folder' : 'Choose folder'}
                </Button>
                <Button variant="primary" size="md" onClick={() => { void goNext(); }} disabled={saving}>
                  Next: RAG
                </Button>
              </div>
            </div>
          )}

          {step === 'rag' && (
            <div className="onb-step orchid-view-enter text-left">
              <div>
                <h1 className="text-3xl font-semibold">Embedding model</h1>
                <p className="onb-step-description mt-2">
                  Choose a local ONNX model or a provider embedding model for semantic search.
                  Chunking and other RAG knobs stay at defaults.
                </p>
              </div>

              <FormField label="Model" htmlFor="onb-embedding-model" className="config-field">
                <ModelPicker
                  id="onb-embedding-model"
                  value={activeEmbeddingValue}
                  options={embeddingOptions.map(providerModelOptionKey)}
                  optionLabels={providerEmbeddingLabels}
                  optionDetails={providerEmbeddingDetails}
                  additionalOptions={localEmbeddingOptions}
                  onChange={handleEmbeddingChange}
                  label="Select embedding model"
                  align="start"
                  placement="bottom"
                  className="config-model-picker w-full max-w-full"
                  emptyMessage="No embedding models available"
                  disabled={saving}
                />
              </FormField>

              {saveError && (
                <Alert tone="error" icon="alertCircle">
                  {saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button variant="ghost" size="md" onClick={goBack} disabled={saving}>
                  Back
                </Button>
                <Button variant="primary" size="md" onClick={() => { void goNext(); }} disabled={saving}>
                  Next: MCP
                </Button>
              </div>
            </div>
          )}

          {step === 'mcp' && (
            <div className="onb-step orchid-view-enter text-left">
              <div>
                <h1 className="text-3xl font-semibold">Recommended MCP servers</h1>
                <p className="onb-step-description mt-2">
                  Optionally enable recommended MCP servers. Nothing is installed by default —
                  you can add or edit servers later in Settings.
                </p>
              </div>

              <div className="grid gap-3" aria-label="Recommended MCP servers">
                {RECOMMENDED_MCP_SERVERS.map((server) => {
                  const checked = selectedMcpIds.includes(server.id);
                  return (
                    <label
                      key={server.id}
                      className={`config-card cursor-pointer ${checked ? 'ring-2 ring-primary' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          tone="primary"
                          className="mt-1"
                          checked={checked}
                          onChange={() => toggleMcp(server.id)}
                          disabled={saving}
                        />
                        <div className="min-w-0">
                          <div className="config-card-title flex items-center gap-3">
                            {server.title}
                            {server.id === 'context7' && (
                              <StatusBadge tone="primary" size="sm">Recommended</StatusBadge>
                            )}
                          </div>
                          <p className="config-card-desc mt-1">{server.description}</p>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {saveError && (
                <Alert tone="error" icon="alertCircle">
                  {saveError}
                </Alert>
              )}

              <div className="onb-step-actions">
                <Button variant="ghost" size="md" onClick={goBack} disabled={saving}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => void markCompleteAndClose('finish')}
                  disabled={saving || !defaultModel}
                >
                  {saving ? 'Finishing…' : 'Finish onboarding'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {providers.overview && (
        <ConnectionWizard
          isOpen={wizardOpen}
          definitions={providers.overview.definitions}
          secureStorage={providers.overview.secureStorage}
          onClose={() => setWizardOpen(false)}
          onCreate={providers.createConnection}
          onSubmitApiKey={providers.submitApiKey}
          onValidate={providers.validateConnection}
          onComplete={handleProviderComplete}
        />
      )}

      <TrustProjectDialog
        open={trustPrompt.pending != null}
        cwd={trustPrompt.pending?.cwd ?? ''}
        trustState={trustPrompt.pending?.info.state === 'changed' ? 'changed' : 'untrusted'}
        report={trustPrompt.pending?.info.report ?? null}
        busy={trustPrompt.busy}
        onGrant={() => void trustPrompt.grant()}
        onDecline={handleTrustDecline}
      />
    </>
  );
}
