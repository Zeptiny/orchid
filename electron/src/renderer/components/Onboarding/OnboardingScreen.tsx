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

interface OnboardingScreenProps {
  isOpen: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingScreen({ isOpen, onComplete, onSkip }: OnboardingScreenProps) {
  const providers = useProviders();
  const [wizardOpen, setWizardOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <div className="onb-overlay" ref={containerRef}>
        <div className="onb-container">
          <div className="flex min-h-80 items-center justify-center">
            <div className="flex max-w-xl flex-col items-center gap-5 text-center">
              <img src={orchidIcon} alt="Orchid" width={72} height={72} />
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold">Welcome to Orchid</h1>
                <p className="text-base-content/70">
                  Start with local workspace tools, project browsing, history, settings, and on-device RAG.
                  Connect a provider when you want LLM-backed chat.
                </p>
              </div>
              {providers.error && !providers.overview && (
                <div role="alert" className="alert alert-warning text-left">
                  <span>{providers.error}</span>
                  <button type="button" className="btn btn-sm" onClick={() => void providers.refresh()}>
                    Retry
                  </button>
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  className="btn btn-primary"
                  onClick={() => setWizardOpen(true)}
                  type="button"
                  disabled={!providers.overview}
                >
                  {providers.isLoading && !providers.overview ? (
                    <>
                      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
                      Loading providers…
                    </>
                  ) : (
                    'Connect a provider'
                  )}
                </button>
                <button className="btn btn-ghost" onClick={onSkip} type="button">
                  Skip onboarding
                </button>
              </div>
            </div>
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

          onComplete={handleProviderComplete}
        />
      )}
    </>
  );
}
