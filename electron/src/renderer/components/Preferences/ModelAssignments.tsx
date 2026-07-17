import { useMemo } from 'react';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { ModelPicker } from '../ModelPicker';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  selectionKey,
} from '../../utils/provider-selection';
import { Alert } from '../ui/Alert';
import { ConfigCard } from '../ui/ConfigCard';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';

export interface ModelAssignmentTier {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const MODEL_ASSIGNMENT_TIERS: readonly ModelAssignmentTier[] = [
  { id: 'seed', label: 'Seed', description: 'Lightweight tasks — quick answers, simple lookups.' },
  { id: 'sprout', label: 'Sprout', description: 'Standard tasks — everyday coding, moderate reasoning.' },
  { id: 'bloom', label: 'Bloom', description: 'Complex tasks — deep reasoning, multi-step planning.' },
  { id: 'crown', label: 'Crown', description: 'Critical tasks — highest quality, architecture decisions.' },
];

export interface ModelAssignmentsProps {
  readonly options: readonly ProviderModelOption[];
  readonly defaultModel: ModelSelection | null;
  readonly tierModels: Record<string, ModelSelection | null>;
  readonly onDefaultModelChange: (selection: ModelSelection | null) => void;
  readonly onTierModelsChange: (tierModels: Record<string, ModelSelection | null>) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

function optionSelection(option: ProviderModelOption): ModelSelection {
  return {
    connectionId: option.selection.connectionId,
    modelId: option.selection.modelId,
  };
}

export function ModelAssignments({
  options,
  defaultModel,
  tierModels,
  onDefaultModelChange,
  onTierModelsChange,
  disabled = false,
  className = '',
}: ModelAssignmentsProps) {
  const byKey = useMemo(
    () => new Map(options.map((option) => [providerModelOptionKey(option), option])),
    [options],
  );
  const optionLabels = useMemo(
    () => Object.fromEntries(options.map((option) => [
      providerModelOptionKey(option),
      providerModelOptionDisplayName(option),
    ])),
    [options],
  );
  const optionDetails = useMemo(
    () => Object.fromEntries(options.map((option) => [providerModelOptionKey(option), option])),
    [options],
  );

  const updateSelection = (
    value: string,
    onChange: (selection: ModelSelection | null) => void,
  ) => {
    const option = byKey.get(value);
    onChange(option ? optionSelection(option) : null);
  };

  const defaultKey = selectionKey(defaultModel);
  const defaultAvailable = !defaultModel || byKey.has(defaultKey);

  return (
    <div className={`grid gap-4 ${className}`.trim()}>
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Default model"
          description="This model is selected for new chats. Each tier can override it for agent work."
        />
        {!defaultAvailable && (
          <Alert tone="warning" className="text-sm">
            The current default is unavailable; choose a ready connection.
          </Alert>
        )}
        <ModelPicker
          value={defaultAvailable ? defaultKey : ''}
          options={options.map(providerModelOptionKey)}
          optionLabels={optionLabels}
          optionDetails={optionDetails}
          additionalOptions={[{ value: '', label: 'Not configured' }]}
          label="Default model"
          align="start"
          className="w-full"
          disabled={disabled || options.length === 0}
          emptyMessage="No ready chat models available"
          onChange={(value) => updateSelection(value, onDefaultModelChange)}
        />
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Tier Models"
          description="Assign a model to each tier. A tier left unconfigured falls back to the default model."
        />
        {options.length === 0 && (
          <StateMessage
            kind="info"
            title="Connect and validate a provider before assigning models."
            className="py-4"
          />
        )}

        <div className="config-card-list">
          {MODEL_ASSIGNMENT_TIERS.map((tier) => {
            const selected = tierModels[tier.id] ?? null;
            const currentKey = selectionKey(selected);
            const currentAvailable = !selected || byKey.has(currentKey);
            return (
              <ConfigCard key={tier.id}>
                <ConfigCard.Body variant="row">
                  <div className="min-w-0 flex-1">
                    <div className="config-card-title font-semibold">{tier.label}</div>
                    <p className="config-card-desc text-sm text-base-content/70">{tier.description}</p>
                    {!currentAvailable && (
                      <p className="mt-1 text-xs text-warning">
                        Current selection is unavailable; choose a ready connection.
                      </p>
                    )}
                  </div>
                  <ModelPicker
                    value={currentAvailable ? currentKey : ''}
                    options={options.map(providerModelOptionKey)}
                    optionLabels={optionLabels}
                    optionDetails={optionDetails}
                    additionalOptions={[{ value: '', label: 'Use default model' }]}
                    label={`${tier.label} tier model`}
                    align="end"
                    className="tier-model-picker"
                    disabled={disabled || options.length === 0}
                    emptyMessage="No ready chat models available"
                    onChange={(value) => {
                      const next = { ...tierModels };
                      const option = byKey.get(value);
                      next[tier.id] = option ? optionSelection(option) : null;
                      onTierModelsChange(next);
                    }}
                  />
                </ConfigCard.Body>
              </ConfigCard>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
