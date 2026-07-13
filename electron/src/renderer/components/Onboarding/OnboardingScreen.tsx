/**
 * First-run, connection-centered provider onboarding.
 *
 * The renderer uses only redacted, intent-based provider IPC. It never
 * inspects environment values, creates legacy aliases, or parses model IDs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { useFocusTrap } from '../../keyboard';
import {
  ConnectionWizard,
  type ProviderConnectionCompletion,
} from '../Providers/ConnectionWizard';
import orchidIcon from '../../assets/orchid-icon.svg';

type StepId = 'welcome' | 'local' | 'done';

interface StepDef {
  id: StepId;
  label: string;
}

const STEPS: StepDef[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'local', label: 'Local workspace' },
  { id: 'done', label: 'Done' },
];

interface OnboardingScreenProps {
  isOpen: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingScreen({ isOpen, onComplete, onSkip }: OnboardingScreenProps) {
  const providers = useProviders();
  const [stepIndex, setStepIndex] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentStep = STEPS[stepIndex];

  const goNext = useCallback(() => {
    setStepIndex((previous) => Math.min(previous + 1, STEPS.length - 1));
  }, []);

  const goPrev = useCallback(() => {
    setStepIndex((previous) => Math.max(previous - 1, 0));
  }, []);

  const handleComplete = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const handleProviderComplete = useCallback(async (result: ProviderConnectionCompletion) => {
    if (result.selection) {
      window.dispatchEvent(new CustomEvent<{ selection: ModelSelection }>(
        'orchid:provider-selection-created',
        { detail: { selection: result.selection } },
      ));
    }
    await providers.refresh();
    onComplete();
  }, [onComplete, providers.refresh]);

  useFocusTrap({ enabled: isOpen, containerRef });

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

  if (!isOpen) return null;

  const stepContent = (() => {
    switch (currentStep.id) {
      case 'welcome':
        return (
          <div className="flex max-w-xl flex-col items-center gap-5 text-center">
            <img src={orchidIcon} alt="Orchid" width={72} height={72} />
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold">Welcome to Orchid</h1>
              <p className="text-base-content/70">
                Start with local workspace tools, project browsing, history, settings, and on-device RAG.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                className="btn btn-primary"
                onClick={() => setWizardOpen(true)}
                type="button"
                disabled={!providers.overview}
              >
                Connect a provider
              </button>
              <button className="btn btn-ghost" onClick={goNext} type="button">Use local features</button>
              <button className="btn btn-ghost" onClick={onSkip} type="button">Skip onboarding</button>
            </div>
          </div>
        );
      case 'local':
        return (
          <div className="flex max-w-xl flex-col gap-5">
            <div className="space-y-2 text-center">
              <h2 className="text-2xl font-semibold">Use Orchid locally</h2>
              <p className="text-base-content/70">
                You can work with local features now and add a provider connection later.
              </p>
            </div>
            <div role="alert" className="alert alert-info sm:alert-horizontal">
              <span>
                LLM-backed actions stay disabled until a provider connection and typed model selection are configured. Nothing will be inferred from environment variables or old configuration.
              </span>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <button className="btn btn-ghost" onClick={goPrev} type="button">Back</button>
              <button
                className="btn btn-primary"
                onClick={() => setWizardOpen(true)}
                type="button"
                disabled={!providers.overview}
              >
                Connect a provider
              </button>
              <button className="btn btn-primary" onClick={goNext} type="button">Continue</button>
              <button className="btn btn-ghost" onClick={onSkip} type="button">Skip onboarding</button>
            </div>
          </div>
        );
      case 'done':
        return (
          <div className="flex max-w-xl flex-col items-center gap-5 text-center">
            <div className="text-5xl" aria-hidden="true">🎉</div>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold">Your local workspace is ready</h2>
              <p className="text-base-content/70">
                Provider connections can be added later without recreating your workspace or history.
              </p>
            </div>
            <button className="btn btn-primary" onClick={handleComplete} type="button">Enter Orchid</button>
          </div>
        );
    }
  })();

  return (
    <>
      <div className="onb-overlay" ref={containerRef}>
        <div className="onb-container">
        <div className="flex items-center justify-center gap-5 pb-8 text-sm text-base-content/60">
          {STEPS.map((step, index) => (
            <span key={step.id} className={index === stepIndex ? 'font-semibold text-base-content' : ''}>
              {step.label}
            </span>
          ))}
        </div>
        <div className="flex min-h-80 items-center justify-center">{stepContent}</div>
          <div className="mt-6 text-center">
            <button className="btn btn-ghost btn-sm" onClick={onSkip} type="button">
              Skip onboarding and use local defaults
            </button>
          </div>
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
          onAuthStart={providers.authStart}
          onAuthComplete={providers.authComplete}
          onComplete={handleProviderComplete}
        />
      )}
    </>
  );
}
