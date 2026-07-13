/** Typed connection-scoped tier assignments. */
import { useEffect, useMemo, useState } from 'react';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import {
  providerModelOptionKey,
  providerModelOptionLabel,
  selectionKey,
} from '../../utils/provider-selection';

interface TierInfo {
  id: string;
  label: string;
  description: string;
}

const TIERS: TierInfo[] = [
  { id: 'seed', label: 'Seed', description: 'Lightweight tasks — quick answers, simple lookups.' },
  { id: 'sprout', label: 'Sprout', description: 'Standard tasks — everyday coding, moderate reasoning.' },
  { id: 'bloom', label: 'Bloom', description: 'Complex tasks — deep reasoning, multi-step planning.' },
  { id: 'crown', label: 'Crown', description: 'Critical tasks — highest quality, architecture decisions.' },
];

export interface TierModelsTabProps {
  readonly tierModels: Record<string, ModelSelection | null>;
  readonly onChange: (tierModels: Record<string, ModelSelection | null>) => void;
}

export function TierModelsTab({ tierModels, onChange }: TierModelsTabProps) {
  const providers = useProviders();
  const [options, setOptions] = useState<readonly ProviderModelOption[]>([]);

  useEffect(() => {
    const refresh = () => { void providers.refresh(); };
    window.addEventListener('orchid:providers-updated', refresh);
    return () => window.removeEventListener('orchid:providers-updated', refresh);
  }, [providers.refresh]);

  useEffect(() => {
    if (!providers.overview) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    void providers.modelList().then((next) => {
      if (!cancelled) setOptions(next.filter((option) => option.available));
    }).catch(() => {
      if (!cancelled) setOptions([]);
    });
    return () => { cancelled = true; };
  }, [providers.modelList, providers.overview]);

  const byKey = useMemo(
    () => new Map(options.map((option) => [providerModelOptionKey(option), option])),
    [options],
  );
  const hasReadyModels = options.length > 0;

  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">Tier Models</div>
        <p className="mb-4 text-sm text-base-content/70">
          Each tier keeps the selected connection identity as well as its model ID.
        </p>

        {!hasReadyModels && (
          <div role="status" className="alert alert-info mb-4">
            <span>Connect and validate a provider before assigning tier models.</span>
          </div>
        )}

        <div className="config-card-list">
          {TIERS.map((tier) => {
            const selected = tierModels[tier.id] ?? null;
            const currentKey = selectionKey(selected);
            const currentAvailable = !selected || byKey.has(currentKey);
            return (
              <div key={tier.id} className="config-card config-card-row">
                <div className="min-w-0">
                  <div className="config-card-title">{tier.label}</div>
                  <p className="config-card-desc">{tier.description}</p>
                  {!currentAvailable && (
                    <p className="mt-1 text-xs text-warning">Current selection is unavailable; choose a ready connection.</p>
                  )}
                </div>
                <select
                  className="select select-sm max-w-xs"
                  aria-label={`${tier.label} tier model`}
                  value={currentAvailable ? currentKey : ''}
                  disabled={!hasReadyModels}
                  onChange={(event) => {
                    const option = byKey.get(event.target.value);
                    onChange({
                      ...tierModels,
                      [tier.id]: option
                        ? { connectionId: option.selection.connectionId, modelId: option.selection.modelId }
                        : null,
                    });
                  }}
                >
                  <option value="">Not configured</option>
                  {options.map((option) => (
                    <option key={providerModelOptionKey(option)} value={providerModelOptionKey(option)}>
                      {providerModelOptionLabel(option)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
