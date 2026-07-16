/** Typed connection-scoped tier assignments. Uses shared model catalog. */
import { useEffect, useMemo } from 'react';
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

  // ConfigView only mounts this tab after ensureModelList; keep catalog warm.
  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  useEffect(() => {
    const refresh = () => { void providers.refresh().then(() => providers.ensureModelList()); };
    window.addEventListener('orchid:providers-updated', refresh);
    return () => window.removeEventListener('orchid:providers-updated', refresh);
  }, [providers.refresh, providers.ensureModelList]);

  const options = useMemo(
    () => (providers.modelOptions ?? []).filter(
      (option) => option.available && isTextGenerationModel(option.model),
    ),
    [providers.modelOptions],
  );

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
