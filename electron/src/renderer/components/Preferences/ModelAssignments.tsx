import { useMemo } from 'react';
import type { ProviderConnectionView, ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { ModelPicker } from '../ModelPicker';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  reasoningConfigForSelection,
  selectionKey,
} from '../../utils/provider-selection';
import { Alert } from '../ui/Alert';
import { ConfigCard } from '../ui/ConfigCard';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';

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
  /** Connections carrying per-model reasoningConfig; needed to derive levels. */
  readonly connections?: readonly ProviderConnectionView[];
  readonly tierReasoningEffort?: Record<string, string | number | null>;
  readonly onTierReasoningEffortChange?: (
    tierReasoningEffort: Record<string, string | number | null>,
  ) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  /**
   * Project-scope mode: the maps hold explicit project overrides only, the
   * empty picker entry means "inherit the global (home) assignment", and tier
   * overrides are reset through {@link onTierReset} rather than null entries.
   */
  readonly projectScope?: boolean;
  /** Home-layer values shown as inherit targets (project scope only). */
  readonly inheritedDefaultModel?: ModelSelection | null;
  readonly inheritedTierModels?: Record<string, ModelSelection | null>;
  /** Remove one tier's project override — revert to the home assignment. */
  readonly onTierReset?: (tierId: string) => void;
  /** Remove the project default-model override — revert to the home default. */
  readonly onDefaultModelReset?: () => void;
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
  connections = [],
  tierReasoningEffort,
  onTierReasoningEffortChange,
  disabled = false,
  className = '',
  projectScope = false,
  inheritedDefaultModel = null,
  inheritedTierModels = {},
  onTierReset,
  onDefaultModelReset,
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

  // Human label for a selection, falling back to its raw ids.
  const selectionLabel = (selection: ModelSelection | null | undefined): string => {
    if (!selection) return '';
    return optionLabels[selectionKey(selection)]
      ?? `${selection.connectionId} · ${selection.modelId}`;
  };
  const inheritLabel = (selection: ModelSelection | null | undefined, fallback: string): string => {
    const label = selectionLabel(selection);
    return label ? `Inherit global (${label})` : `Inherit global (${fallback})`;
  };

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
          description={projectScope
            ? 'Project default for chats in this workspace. Inherits the global default when unset.'
            : 'This model is selected for new chats. Each tier can override it for agent work.'}
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
          additionalOptions={[{
            value: '',
            label: projectScope
              ? inheritLabel(inheritedDefaultModel, 'not configured')
              : 'Not configured',
          }]}
          label="Default model"
          align="start"
          className="w-full"
          disabled={disabled || options.length === 0}
          emptyMessage="No ready chat models available"
          onChange={(value) => {
            if (projectScope && value === '') {
              onDefaultModelReset?.();
              return;
            }
            updateSelection(value, onDefaultModelChange);
          }}
        />
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Tier Models"
          description={projectScope
            ? 'Project tier assignments override the global ones for this workspace. Unset tiers inherit the global assignment.'
            : 'Assign a model to each tier. A tier left unconfigured falls back to the default model.'}
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
            const overridden = projectScope && tier.id in tierModels;
            const inheritedSelection = inheritedTierModels[tier.id] ?? null;
            const reasoningSelection = projectScope
              ? (selected ?? inheritedSelection)
              : selected;
            const reasoning = reasoningConfigForSelection(reasoningSelection, connections, options);
            const showReasoning = onTierReasoningEffortChange !== undefined
              && reasoning.supportsReasoning
              && reasoning.levels.length > 0;
            return (
              <ConfigCard key={tier.id} variant={overridden ? 'active' : undefined}>
                <ConfigCard.Body variant="row">
                  <div className="min-w-0 flex-1">
                    <div className="config-card-title font-semibold">{tier.label}</div>
                    <p className="config-card-desc text-sm text-base-content/70">{tier.description}</p>
                    {projectScope && !overridden && (
                      <p className="config-card-desc mt-1 text-xs text-base-content/60">
                        {inheritLabel(inheritedSelection, 'default model')}
                      </p>
                    )}
                    {!currentAvailable && (
                      <p className="mt-1 text-xs text-warning">
                        Current selection is unavailable; choose a ready connection.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <ModelPicker
                      value={currentAvailable ? currentKey : ''}
                      options={options.map(providerModelOptionKey)}
                      optionLabels={optionLabels}
                      optionDetails={optionDetails}
                      additionalOptions={[{
                        value: '',
                        label: projectScope
                          ? inheritLabel(inheritedSelection, 'default model')
                          : 'Use default model',
                      }]}
                      label={`${tier.label} tier model`}
                      align="end"
                      className="tier-model-picker"
                      disabled={disabled || options.length === 0}
                      emptyMessage="No ready chat models available"
                      onChange={(value) => {
                        if (projectScope && value === '') {
                          onTierReset?.(tier.id);
                          return;
                        }
                        const next = { ...tierModels };
                        const option = byKey.get(value);
                        next[tier.id] = option ? optionSelection(option) : null;
                        onTierModelsChange(next);
                        if (onTierReasoningEffortChange) {
                          onTierReasoningEffortChange({
                            ...(tierReasoningEffort ?? {}),
                            [tier.id]: null,
                          });
                        }
                      }}
                    />
                    {showReasoning && (
                      <ReasoningEffortPicker
                        levels={reasoning.levels}
                        value={tierReasoningEffort?.[tier.id] ?? null}
                        onChange={(value) => {
                          const next = { ...(tierReasoningEffort ?? {}) };
                          next[tier.id] = value;
                          onTierReasoningEffortChange?.(next);
                        }}
                        disabled={disabled}
                        label={`${tier.label} tier reasoning effort`}
                        align="end"
                        className="tier-model-picker"
                      />
                    )}
                  </div>
                </ConfigCard.Body>
              </ConfigCard>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
