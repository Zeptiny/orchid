/** Typed connection-scoped tier assignments. */
import { useEffect, useState } from 'react';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { isTextGenerationModel } from '../../utils/models';
import { ModelAssignments } from './ModelAssignments';

export interface TierModelsTabProps {
  readonly defaultModel: ModelSelection | null;
  readonly tierModels: Record<string, ModelSelection | null>;
  readonly onDefaultModelChange: (defaultModel: ModelSelection | null) => void;
  readonly onChange: (tierModels: Record<string, ModelSelection | null>) => void;
}

export function TierModelsTab({
  defaultModel,
  tierModels,
  onDefaultModelChange,
  onChange,
}: TierModelsTabProps) {
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
      if (!cancelled) setOptions(next.filter((option) => option.available && isTextGenerationModel(option.model)));
    }).catch(() => {
      if (!cancelled) setOptions([]);
    });
    return () => { cancelled = true; };
  }, [providers.modelList, providers.overview]);

  return (
    <div className="config-form">
      <ModelAssignments
        options={options}
        defaultModel={defaultModel}
        tierModels={tierModels}
        onDefaultModelChange={onDefaultModelChange}
        onTierModelsChange={onChange}
      />
    </div>
  );
}
