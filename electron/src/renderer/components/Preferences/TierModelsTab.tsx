/** Typed connection-scoped tier assignments. Uses shared model catalog. */
import { useEffect, useMemo } from 'react';
import type { ModelSelection } from '../../../shared/types/provider';
import { useProviders } from '../../hooks/useProviders';
import { onOrchidEvent } from '../../utils/events';
import { isTextGenerationModel } from '../../utils/models';
import { ModelAssignments } from './ModelAssignments';

export interface TierModelsTabProps {
  readonly defaultModel: ModelSelection | null;
  readonly tierModels: Record<string, ModelSelection | null>;
  readonly tierReasoningEffort: Record<string, string | number | null>;
  readonly onDefaultModelChange: (defaultModel: ModelSelection | null) => void;
  readonly onChange: (tierModels: Record<string, ModelSelection | null>) => void;
  readonly onTierReasoningEffortChange: (
    tierReasoningEffort: Record<string, string | number | null>,
  ) => void;
}

export function TierModelsTab({
  defaultModel,
  tierModels,
  tierReasoningEffort,
  onDefaultModelChange,
  onChange,
  onTierReasoningEffortChange,
}: TierModelsTabProps) {
  const providers = useProviders();

  // ConfigView only mounts this tab after ensureModelList; keep catalog warm.
  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:providers-updated', () => {
      void providers.refresh().then(() => providers.ensureModelList());
    });
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
        connections={providers.overview?.connections ?? []}
        defaultModel={defaultModel}
        tierModels={tierModels}
        tierReasoningEffort={tierReasoningEffort}
        onDefaultModelChange={onDefaultModelChange}
        onTierModelsChange={onChange}
        onTierReasoningEffortChange={onTierReasoningEffortChange}
      />
    </div>
  );
}
