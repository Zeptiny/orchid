/**
 * First-run provider onboarding.
 *
 * Provider connections are created through the same wizard used by Settings.
 * Once one or more connections are ready, onboarding lets the user assign the
 * default and tier models before returning to chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { useFocusTrap } from '../../keyboard';
import { isTextGenerationModel } from '../../utils/models';
import {
  ConnectionWizard,
  type ProviderConnectionCompletion,
} from '../Providers/ConnectionWizard';
import {
  MODEL_ASSIGNMENT_TIERS,
  ModelAssignments,
} from '../Preferences/ModelAssignments';
import { Icon } from '../Icon';
import orchidIcon from '../../assets/orchid-icon.svg';

type OnboardingStep = 'providers' | 'models';

const EMPTY_TIER_MODELS: Record<string, ModelSelection | null> = Object.fromEntries(
  MODEL_ASSIGNMENT_TIERS.map((tier) => [tier.id, null]),
);

interface OnboardingScreenProps {
  isOpen: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

function copySelection(selection: ModelSelection): ModelSelection {
  return { connectionId: selection.connectionId, modelId: selection.modelId };
}

export function OnboardingScreen({ isOpen, onComplete, onSkip }: OnboardingScreenProps) {
  const providers = useProviders();
  const [step, setStep] = useState<OnboardingStep>('providers');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null>(null);
  const [tierModels, setTierModels] = useState<Record<string, ModelSelection | null>>(
    EMPTY_TIER_MODELS,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const modelSeededRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    setModelsLoading(false);
    setModelError(null);
    setDefaultModel(null);
    setTierModels(EMPTY_TIER_MODELS);
    setSaving(false);
    setSaveError(null);
    modelSeededRef.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || step !== 'models' || !providers.overview) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelError(null);
    void providers.modelList().then((options) => {
      if (cancelled) return;
      setModelOptions(options.filter(
        (option) => option.available && isTextGenerationModel(option.model),
      ));
    }).catch((error: unknown) => {
      if (!cancelled) {
        setModelOptions([]);
        setModelError(error instanceof Error ? error.message : 'Models could not be loaded.');
      }
    }).finally(() => {
      if (!cancelled) setModelsLoading(false);
    });
    return () => { cancelled = true; };
  }, [connectionSignature, isOpen, providers.modelList, providers.overview, step]);

  useEffect(() => {
    if (!isOpen || step !== 'models' || modelSeededRef.current || modelOptions.length === 0) return;
    const firstSelection = copySelection(modelOptions[0].selection);
    setDefaultModel(firstSelection);
    setTierModels(Object.fromEntries(
      MODEL_ASSIGNMENT_TIERS.map((tier) => [tier.id, copySelection(firstSelection)]),
    ));
    modelSeededRef.current = true;
  }, [isOpen, modelOptions, step]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onSkip]);

  const handleProviderComplete = useCallback(async (_result: ProviderConnectionCompletion) => {
    await providers.refresh();
    setWizardOpen(false);
    setSaveError(null);
  }, [providers.refresh]);

  const finishOnboarding = useCallback(async () => {
    if (!defaultModel) {
      setSaveError('Choose a default model before finishing onboarding.');
      return;
    }
    if (!window.orchid?.config?.save) {
      setSaveError('Configuration saving is unavailable in this build.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const updates = { default_model: defaultModel, tier_models: tierModels };
      await window.orchid.config.save({ updates });
      window.dispatchEvent(new CustomEvent('orchid:config-updated', { detail: updates }));
      window.dispatchEvent(new CustomEvent<{ selection: ModelSelection }>(
        'orchid:provider-selection-created',
        { detail: { selection: defaultModel } },
      ));
      onComplete();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Onboarding could not be completed.');
    } finally {
      setSaving(false);
    }
  }, [defaultModel, onComplete, tierModels]);

  if (!isOpen) return null;

  return (
    <>
      <div className="onb-overlay" ref={containerRef}>
        <div className="onb-container">
          <ul className="steps steps-horizontal w-full" aria-label="Onboarding progress">
            <li className="step step-primary">Add providers</li>
            <li className={`step ${step === 'models' ? 'step-primary' : ''}`}>Choose models</li>
          </ul>

          {step === 'providers' ? (
            <div className="onb-step text-left">
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
                <div role="alert" className="alert alert-warning">
                  <span>{providers.error}</span>
                  <button type="button" className="btn btn-sm" onClick={() => void providers.refresh()}>
                    Retry
                  </button>
                </div>
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
                        <span className={connection.health === 'ready'
                          ? 'badge badge-success badge-soft'
                          : 'badge badge-warning badge-soft'}>
                          {connection.health === 'ready' ? 'Ready' : 'Needs attention'}
                        </span>
                      </div>
                      <p className="mt-3 text-xs text-base-content/70">
                        {connection.modelIds.length} model{connection.modelIds.length === 1 ? '' : 's'} selected
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <div role="status" className="alert alert-info">
                  <Icon name="cpu" size={16} />
                  <span>Add a provider to unlock model selection and chat.</span>
                </div>
              )}

              {saveError && (
                <div role="alert" className="alert alert-error">
                  <Icon name="alertCircle" size={16} />
                  <span>{saveError}</span>
                </div>
              )}

              <div className="onb-step-actions">
                <button className="btn btn-ghost" onClick={onSkip} type="button">
                  Skip onboarding
                </button>
                <button
                  className="btn"
                  onClick={() => setWizardOpen(true)}
                  type="button"
                  disabled={!providers.overview}
                >
                  <Icon name="plus" size={15} />
                  {connections.length > 0 ? 'Add another provider' : 'Add a provider'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setSaveError(null);
                    setStep('models');
                  }}
                  type="button"
                  disabled={readyConnections.length === 0}
                >
                  Next: choose models
                </button>
              </div>
            </div>
          ) : (
            <div className="onb-step text-left">
              <div>
                <h1 className="text-3xl font-semibold">Choose your models</h1>
                <p className="onb-step-description mt-2">
                  Pick the model for new chats and the model each agent tier should use.
                </p>
              </div>

              {modelsLoading ? (
                <div role="status" className="alert alert-info">
                  <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                  <span>Loading models…</span>
                </div>
              ) : (
                <ModelAssignments
                  options={modelOptions}
                  defaultModel={defaultModel}
                  tierModels={tierModels}
                  onDefaultModelChange={setDefaultModel}
                  onTierModelsChange={setTierModels}
                  disabled={saving}
                />
              )}

              {(modelError || saveError) && (
                <div role="alert" className="alert alert-error">
                  <Icon name="alertCircle" size={16} />
                  <span>{modelError ?? saveError}</span>
                </div>
              )}

              <div className="onb-step-actions">
                <button className="btn btn-ghost" onClick={() => setStep('providers')} type="button" disabled={saving}>
                  Back to providers
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void finishOnboarding()}
                  type="button"
                  disabled={saving || modelsLoading || modelOptions.length === 0 || !defaultModel}
                >
                  {saving ? 'Finishing…' : 'Finish onboarding'}
                </button>
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
    </>
  );
}
