/**
 * TierModelsTab — map agent tiers to models.
 *
 * 4 tiers: seed, sprout, bloom, crown.
 * Each tier uses the same model dropdown listing as Default Model (General).
 */
import { useMemo } from 'react';
import { collectModelsFromProviders } from '../../utils/models';
import { ModelPicker } from '../ModelPicker';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TierModelsTabProps {
  tierModels: Record<string, string>;
  providers: Record<string, Record<string, unknown>>;
  onChange: (tierModels: Record<string, string>) => void;
}

interface TierInfo {
  id: string;
  label: string;
  description: string;
}

// ── Tier definitions ─────────────────────────────────────────────────────────

const TIERS: TierInfo[] = [
  {
    id: 'seed',
    label: 'Seed',
    description: 'Lightweight tasks — quick answers, simple lookups.',
  },
  {
    id: 'sprout',
    label: 'Sprout',
    description: 'Standard tasks — everyday coding, moderate reasoning.',
  },
  {
    id: 'bloom',
    label: 'Bloom',
    description: 'Complex tasks — deep reasoning, multi-step planning.',
  },
  {
    id: 'crown',
    label: 'Crown',
    description: 'Critical tasks — highest quality, architecture decisions.',
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export function TierModelsTab({ tierModels, providers, onChange }: TierModelsTabProps) {
  const availableModels = useMemo(
    () => collectModelsFromProviders(providers),
    [providers],
  );

  return (
    <div className="config-form">
      <fieldset className="config-fieldset">
        <legend className="config-fieldset-legend">Tier Models</legend>

        <div className="config-card-list">
          {TIERS.map((tier) => {
            const currentModel = tierModels[tier.id] ?? '';
            return (
              <div key={tier.id} className="config-card config-card-row">
                <div className="min-w-0">
                  <div className="config-card-title">{tier.label}</div>
                  <p className="config-card-desc">{tier.description}</p>
                </div>
                <div className="flex shrink-0 items-center">
                  <ModelPicker
                    value={currentModel}
                    options={availableModels}
                    onChange={(value) => onChange({ ...tierModels, [tier.id]: value })}
                    label={`${tier.label} model`}
                    className="config-model-picker"
                    emptyMessage="Add providers first"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {availableModels.length === 0 && (
        <div className="config-note">
          No models available. Add providers in the Providers tab first.
        </div>
      )}
    </div>
  );
}
