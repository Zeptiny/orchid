/**
 * TierModelsTab — map agent tiers to models.
 *
 * 4 tiers: seed, bloom, crown, sprout.
 * Each tier picks a model from available providers.
 */
import { useState, useCallback } from 'react';

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all available model IDs from providers config.
 * Returns array of "provider/model" strings.
 */
function collectModels(providers: Record<string, Record<string, unknown>>): string[] {
  const models: string[] = [];
  for (const [providerId, providerData] of Object.entries(providers)) {
    const providerModels = providerData.models;
    if (providerModels && typeof providerModels === 'object') {
      for (const modelId of Object.keys(providerModels as Record<string, unknown>)) {
        models.push(`${providerId}/${modelId}`);
      }
    }
  }
  return models.sort();
}

// ── Component ────────────────────────────────────────────────────────────────

export function TierModelsTab({ tierModels, providers, onChange }: TierModelsTabProps) {
  const [editingTier, setEditingTier] = useState<string | null>(null);

  const availableModels = collectModels(providers);

  const handleSelect = useCallback(
    (tierId: string, model: string) => {
      onChange({ ...tierModels, [tierId]: model });
      setEditingTier(null);
    },
    [tierModels, onChange],
  );

  return (
    <div className="pref-tab-content">
      <div className="pref-tab-header">
        <h3>Tier Models</h3>
        <p className="pref-tab-description">
          Assign models to agent tiers. Higher tiers are used for more complex tasks.
          Models are picked from your configured providers.
        </p>
      </div>

      <div className="pref-tier-list">
        {TIERS.map((tier) => {
          const currentModel = tierModels[tier.id] ?? '';
          const isEditing = editingTier === tier.id;

          return (
            <div key={tier.id} className="pref-tier-item">
              <div className="pref-tier-info">
                <span className="pref-tier-label">{tier.label}</span>
                <span className="pref-tier-description">{tier.description}</span>
              </div>
              <div className="pref-tier-model">
                {isEditing ? (
                  <select
                    className="pref-select"
                    value={currentModel}
                    onChange={(e) => handleSelect(tier.id, e.target.value)}
                    onBlur={() => setEditingTier(null)}
                    autoFocus
                  >
                    <option value="">— Select model —</option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    className="pref-tier-model-btn"
                    onClick={() => setEditingTier(tier.id)}
                    title="Click to change model"
                  >
                    <span className="pref-tier-model-name">
                      {currentModel || 'Not set'}
                    </span>
                    <span className="pref-tier-model-edit">&#9998;</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {availableModels.length === 0 && (
        <div className="pref-empty-hint">
          No models available. Add providers in the Providers tab first.
        </div>
      )}
    </div>
  );
}
