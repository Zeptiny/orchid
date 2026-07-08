/**
 * OnboardingScreen — first-run onboarding flow.
 *
 * 6 steps:
 * 1. Welcome — app name, description, "Get Started"
 * 2. Provider detection — scan for Ollama, check env vars
 * 3. Provider confirmation — pre-filled config with detected providers
 * 4. Model selection — pick default model from detected providers
 * 5. Config seeding — show what will be created
 * 6. Done — "You're ready to go!" with "Start chatting"
 *
 * Features:
 * - Skip onboarding at any step
 * - Skipped steps use defaults
 * - Fullscreen overlay (first launch only)
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  detectProviders,
  buildProvidersConfig,
  type DetectedProvider,
  type DetectionResult,
} from './ProviderDetector';

// ── Types ────────────────────────────────────────────────────────────────────

type StepId = 'welcome' | 'detect' | 'confirm' | 'models' | 'seeding' | 'done';

interface StepDef {
  id: StepId;
  label: string;
}

const STEPS: StepDef[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'detect', label: 'Detect' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'models', label: 'Models' },
  { id: 'seeding', label: 'Seed' },
  { id: 'done', label: 'Done' },
];

interface OnboardingScreenProps {
  isOpen: boolean;
  onComplete: (config: Record<string, unknown>) => void;
  onSkip: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function OnboardingScreen({ isOpen, onComplete, onSkip }: OnboardingScreenProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [detectionResult, setDetectionResult] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [confirmedProviders, setConfirmedProviders] = useState<DetectedProvider[]>([]);
  const [selectedDefaultModel, setSelectedDefaultModel] = useState('');
  const [seedConfirmed, setSeedConfirmed] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const currentStep = STEPS[stepIndex];

  // ── Auto-detect on step 2 ────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen || currentStep.id !== 'detect') return;

    let cancelled = false;
    setDetecting(true);

    detectProviders().then((result) => {
      if (!cancelled) {
        setDetectionResult(result);
        // Auto-populate confirmed providers with detected ones
        const detected = result.providers.filter((p) => p.detected);
        setConfirmedProviders(detected);
        setDetecting(false);

        // Auto-select first model as default
        if (detected.length > 0 && detected[0].models.length > 0) {
          setSelectedDefaultModel(`${detected[0].id}/${detected[0].models[0]}`);
        }
      }
    });

    return () => { cancelled = true; };
  }, [isOpen, currentStep.id]);

  // ── Navigation ───────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    setStepIndex((prev) => Math.min(prev + 1, STEPS.length - 1));
  }, []);

  const goPrev = useCallback(() => {
    setStepIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  // ── Toggle provider in confirmed list ────────────────────────────────────

  const toggleProvider = useCallback(
    (provider: DetectedProvider) => {
      setConfirmedProviders((prev) => {
        const exists = prev.find((p) => p.id === provider.id);
        if (exists) {
          return prev.filter((p) => p.id !== provider.id);
        }
        return [...prev, provider];
      });
    },
    [],
  );

  // ── Complete onboarding ──────────────────────────────────────────────────

  const handleComplete = useCallback(() => {
    const config: Record<string, unknown> = {};

    // Build providers config from confirmed providers
    if (confirmedProviders.length > 0) {
      config.providers = buildProvidersConfig(confirmedProviders);
    }

    // Set default model if selected
    if (selectedDefaultModel) {
      config.default_model = selectedDefaultModel;
      config.tier_models = {
        seed: selectedDefaultModel,
        sprout: selectedDefaultModel,
        bloom: selectedDefaultModel,
        crown: selectedDefaultModel,
      };
    }

    onComplete(config);
  }, [confirmedProviders, selectedDefaultModel, onComplete]);

  // ── Skip with defaults ───────────────────────────────────────────────────

  const handleSkip = useCallback(() => {
    onSkip();
  }, [onSkip]);

  // ── Focus trap ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const el = containerRef.current;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length > 0) {
      focusable[0].focus();
    }
  }, [isOpen, stepIndex]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSkip();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleSkip]);

  // ── Don't render if not open ─────────────────────────────────────────────

  if (!isOpen) return null;

  // ── Collect all available models from confirmed providers ────────────────

  const availableModels: string[] = [];
  for (const provider of confirmedProviders) {
    for (const model of provider.models) {
      availableModels.push(`${provider.id}/${model}`);
    }
  }

  // ── Seed directories that will be created ────────────────────────────────

  const seedDirs = [
    '~/.orchid/',
    '~/.orchid/agents/',
    '~/.orchid/skills/',
    '~/.orchid/personalities/',
    '~/.orchid/config.json',
  ];

  // ── Render step content ──────────────────────────────────────────────────

  function renderStepContent() {
    switch (currentStep.id) {
      case 'welcome':
        return (
          <div className="onb-step onb-welcome">
            <div className="onb-welcome-icon">{'\u{1F33A}'}</div>
            <h1>Welcome to Orchid</h1>
            <p className="onb-welcome-subtitle">
              Your AI-powered coding assistant. Orchid helps you write, debug,
              and understand code through natural conversation.
            </p>
            <div className="onb-welcome-features">
              <div className="onb-feature">
                <span className="onb-feature-icon">{'\u{1F4AC}'}</span>
                <span>Natural language coding</span>
              </div>
              <div className="onb-feature">
                <span className="onb-feature-icon">{'\u{1F527}'}</span>
                <span>27 built-in tools</span>
              </div>
              <div className="onb-feature">
                <span className="onb-feature-icon">{'\u{1F9E9}'}</span>
                <span>MCP server integration</span>
              </div>
            </div>
            <div className="onb-step-actions">
              <button className="btn btn-primary" onClick={goNext}>
                Get Started
              </button>
              <button className="btn btn-ghost" onClick={handleSkip}>
                Skip Setup
              </button>
            </div>
          </div>
        );

      case 'detect':
        return (
          <div className="onb-step onb-detect">
            <h2>Detecting Providers</h2>
            <p className="onb-step-description">
              Scanning your system for available LLM providers...
            </p>

            {detecting ? (
              <div className="state-loading">
                <div className="spinner" />
                <span>Scanning...</span>
              </div>
            ) : detectionResult ? (
              <div className="onb-detect-results">
                {detectionResult.providers.map((p) => (
                  <div
                    key={p.id}
                    className={`onb-detect-item ${p.detected ? 'detected' : 'not-detected'}`}
                  >
                    <span className="onb-detect-icon">
                      {p.detected ? '\u2705' : '\u274C'}
                    </span>
                    <span className="onb-detect-name">{p.name}</span>
                    <span className="onb-detect-method">
                      {p.method === 'ollama-endpoint'
                        ? 'localhost:11434'
                        : p.maskedKey ?? 'not found'}
                    </span>
                    {p.detected && (
                      <span className="onb-detect-models">
                        {p.models.length} model(s)
                      </span>
                    )}
                  </div>
                ))}

                {detectionResult.providers.filter((p) => p.detected).length === 0 && (
                  <div className="onb-detect-none">
                    <p>No providers detected. You can:</p>
                    <ul>
                      <li>Install Ollama: <code>curl -fsSL https://ollama.com/install.sh | sh</code></li>
                      <li>Set an API key: <code>export OPENAI_API_KEY=sk-...</code></li>
                      <li>Configure manually in the next step</li>
                    </ul>
                  </div>
                )}
              </div>
            ) : null}

            <div className="onb-step-actions">
              <button className="btn btn-ghost" onClick={goPrev}>
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={goNext}
                disabled={detecting}
              >
                Continue
              </button>
              <button className="btn btn-ghost" onClick={handleSkip}>
                Skip Setup
              </button>
            </div>
          </div>
        );

      case 'confirm':
        return (
          <div className="onb-step onb-confirm">
            <h2>Confirm Providers</h2>
            <p className="onb-step-description">
              Select which providers to enable. You can add more later in Preferences.
            </p>

            {detectionResult && (
              <div className="onb-confirm-list">
                {detectionResult.providers
                  .filter((p) => p.detected)
                  .map((p) => {
                    const isConfirmed = confirmedProviders.some(
                      (cp) => cp.id === p.id,
                    );
                    return (
                      <div
                        key={p.id}
                        className={`onb-confirm-item ${isConfirmed ? 'selected' : ''}`}
                        onClick={() => toggleProvider(p)}
                      >
                        <input
                          type="checkbox"
                          checked={isConfirmed}
                          onChange={() => toggleProvider(p)}
                          className="onb-confirm-checkbox"
                        />
                        <div className="onb-confirm-info">
                          <span className="onb-confirm-name">{p.name}</span>
                          <span className="onb-confirm-detail">
                            {p.models.length} model(s) available
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {confirmedProviders.length === 0 && (
              <div className="onb-confirm-empty">
                No providers selected. You can configure providers later in Preferences.
              </div>
            )}

            <div className="onb-step-actions">
              <button className="btn btn-ghost" onClick={goPrev}>
                Back
              </button>
              <button className="btn btn-primary" onClick={goNext}>
                Continue
              </button>
              <button className="btn btn-ghost" onClick={handleSkip}>
                Skip Setup
              </button>
            </div>
          </div>
        );

      case 'models':
        return (
          <div className="onb-step onb-models">
            <h2>Select Default Model</h2>
            <p className="onb-step-description">
              Choose the default model for new sessions. You can change this per-session later.
            </p>

            {availableModels.length > 0 ? (
              <div className="onb-models-picker">
                {availableModels.map((model) => (
                  <div
                    key={model}
                    className={`onb-model-item ${selectedDefaultModel === model ? 'selected' : ''}`}
                    onClick={() => setSelectedDefaultModel(model)}
                  >
                    <input
                      type="radio"
                      name="default-model"
                      checked={selectedDefaultModel === model}
                      onChange={() => setSelectedDefaultModel(model)}
                      className="onb-model-radio"
                    />
                    <span className="onb-model-name">{model}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="onb-models-empty">
                <p>No models available from detected providers.</p>
                <p>You can configure providers and models later in Preferences.</p>
              </div>
            )}

            <div className="onb-step-actions">
              <button className="btn btn-ghost" onClick={goPrev}>
                Back
              </button>
              <button className="btn btn-primary" onClick={goNext}>
                Continue
              </button>
              <button className="btn btn-ghost" onClick={handleSkip}>
                Skip Setup
              </button>
            </div>
          </div>
        );

      case 'seeding':
        return (
          <div className="onb-step onb-seeding">
            <h2>Configuration Preview</h2>
            <p className="onb-step-description">
              The following configuration will be created:
            </p>

            <div className="onb-seed-preview">
              <div className="onb-seed-section">
                <h4>Directories</h4>
                <ul className="onb-seed-list">
                  {seedDirs.map((dir) => (
                    <li key={dir} className="onb-seed-item">
                      <span className="onb-seed-icon">{'\u{1F4C1}'}</span>
                      <code>{dir}</code>
                    </li>
                  ))}
                </ul>
              </div>

              {confirmedProviders.length > 0 && (
                <div className="onb-seed-section">
                  <h4>Providers</h4>
                  <ul className="onb-seed-list">
                    {confirmedProviders.map((p) => (
                      <li key={p.id} className="onb-seed-item">
                        <span className="onb-seed-icon">{'\u{1F4E1}'}</span>
                        <span>{p.name}</span>
                        <span className="onb-seed-detail">
                          {p.models.length} model(s)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedDefaultModel && (
                <div className="onb-seed-section">
                  <h4>Default Model</h4>
                  <div className="onb-seed-item">
                    <span className="onb-seed-icon">{'\u{1F916}'}</span>
                    <code>{selectedDefaultModel}</code>
                  </div>
                </div>
              )}
            </div>

            <label className="onb-seed-confirm">
              <input
                type="checkbox"
                checked={seedConfirmed}
                onChange={(e) => setSeedConfirmed(e.target.checked)}
              />
              <span>I understand and want to create this configuration</span>
            </label>

            <div className="onb-step-actions">
              <button className="btn btn-ghost" onClick={goPrev}>
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={handleComplete}
                disabled={!seedConfirmed}
              >
                Create Configuration
              </button>
              <button className="btn btn-ghost" onClick={handleSkip}>
                Skip Setup
              </button>
            </div>
          </div>
        );

      case 'done':
        return (
          <div className="onb-step onb-done">
            <div className="onb-done-icon">{'\u{1F389}'}</div>
            <h2>You're Ready to Go!</h2>
            <p className="onb-done-subtitle">
              Your configuration has been created. You can always change these
              settings later via <code>/settings</code>.
            </p>
            <div className="onb-step-actions">
              <button className="btn btn-primary" onClick={handleComplete}>
                Start Chatting
              </button>
            </div>
          </div>
        );
    }
  }

  // ── Main render ──────────────────────────────────────────────────────────

  return (
    <div className="onb-overlay" ref={containerRef}>
      <div className="onb-container">
        {/* Progress bar */}
        <div className="onb-progress">
          {STEPS.map((step, i) => (
            <div
              key={step.id}
              className={`onb-progress-step ${
                i === stepIndex
                  ? 'active'
                  : i < stepIndex
                    ? 'completed'
                    : ''
              }`}
            >
              <div className="onb-progress-dot" />
              <span className="onb-progress-label">{step.label}</span>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="onb-content">
          {renderStepContent()}
        </div>

        {/* Skip link */}
        <div className="onb-skip-footer">
          <button className="btn btn-ghost btn-sm" onClick={handleSkip}>
            Skip onboarding and use defaults
          </button>
        </div>
      </div>
    </div>
  );
}
