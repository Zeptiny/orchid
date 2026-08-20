import { useCallback, useEffect, useMemo } from 'react';
import type { CompactionConfig, CompactionScopeConfig, CompactionMode } from '../../../shared/types/ipc-boundary';
import { useProviders } from '../../hooks/useProviders';
import { parseConfigNumber } from '../../utils/config-draft';
import { onOrchidEvent } from '../../utils/events';
import { isTextGenerationModel } from '../../utils/models';
import { providerModelOptionContextLabel } from '../../utils/provider-selection';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';

export interface CompactionTabProps {
  compaction: CompactionConfig;
  onChange: (compaction: CompactionConfig) => void;
}

type Scope = 'main' | 'subagents';

const SCOPE_LABEL: Record<Scope, string> = {
  main: 'Main',
  subagents: 'Subagents',
};

const HYSTERESIS_HINT =
  'Hysteresis prevents thrashing. After compaction, usage must drop below threshold - delta (re-arm line) before re-firing. Or, growth of min_compactable_tokens since post-compaction baseline re-arms even while above threshold. 0.1 = 10% buffer. Higher = less frequent.';

export function CompactionTab({ compaction, onChange }: CompactionTabProps) {
  const providers = useProviders();

  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:providers-updated', () => {
      void providers.refresh().then(() => providers.ensureModelList());
    });
  }, [providers.refresh, providers.ensureModelList]);

  const filteredOptions = useMemo(
    () => (providers.modelOptions ?? []).filter((option) => option.available && isTextGenerationModel(option.model)),
    [providers.modelOptions],
  );

  const updateField = useCallback(
    <K extends keyof CompactionScopeConfig>(scope: Scope, field: K, value: CompactionScopeConfig[K]) => {
      onChange({
        ...compaction,
        [scope]: {
          ...compaction[scope],
          [field]: value,
        },
      });
    },
    [compaction, onChange],
  );

  const handleNumberChange = useCallback(
    (
      scope: Scope,
      field: keyof CompactionScopeConfig,
      value: string,
      min = 0,
      opts?: { integer?: boolean },
    ) => {
      const num = parseConfigNumber(value, min, opts);
      if (num === null) return;
      // Clamp values to the schema maximum instead of rejecting the edit
      let clamped = num;
      if (field === 'threshold') clamped = Math.min(clamped, 0.95);
      if (field === 'hysteresis_delta') clamped = Math.min(clamped, 0.5);
      if (field === 'preserve_percent') clamped = Math.min(clamped, 0.9);
      if (field === 'min_compactable_tokens') clamped = Math.min(clamped, 1_000_000);
      if (field === 'keep_last_user_messages') clamped = Math.min(clamped, 1000);
      updateField(scope, field, clamped as CompactionScopeConfig[typeof field]);
    },
    [updateField],
  );

  const handleNullableNumberChange = useCallback(
    (
      scope: Scope,
      field: 'keep_last_user_messages',
      value: string,
      min: number,
      opts?: { integer?: boolean; max?: number },
    ) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        updateField(scope, field, null);
        return;
      }
      const num = parseConfigNumber(trimmed, min, opts);
      if (num === null) return;
      updateField(scope, field, num);
    },
    [updateField],
  );

  const handleModeChange = useCallback(
    (scope: Scope, value: string) => {
      if (value === 'simple' || value === 'selective') {
        updateField(scope, 'mode', value as CompactionMode);
      }
    },
    [updateField],
  );

  const handleMechanicalReclaimChange = useCallback(
    (scope: Scope, value: string) => {
      updateField(scope, 'mechanical_reclaim', value === 'enabled');
    },
    [updateField],
  );

  const handlePinFirstUserMessageChange = useCallback(
    (scope: Scope, value: string) => {
      updateField(scope, 'pin_first_user_message', value === 'enabled');
    },
    [updateField],
  );

  const handleModelChange = useCallback(
    (scope: Scope, value: string) => {
      if (!value) {
        updateField(scope, 'model', null);
        return;
      }
      const idx = value.indexOf(':');
      if (idx === -1) {
        updateField(scope, 'model', null);
        return;
      }
      const connectionId = value.slice(0, idx);
      const modelId = value.slice(idx + 1);
      if (!connectionId || !modelId) {
        updateField(scope, 'model', null);
      } else {
        updateField(scope, 'model', { connectionId, modelId });
      }
    },
    [updateField],
  );

  const renderScope = (scope: Scope) => {
    const cfg = compaction[scope];
    const prefix = `compaction-${scope}`;
    const modelValue = cfg.model ? `${cfg.model.connectionId}:${cfg.model.modelId}` : '';
    const filteredKeys = new Set(filteredOptions.map((option) => `${option.selection.connectionId}:${option.selection.modelId}`));
    const hasCurrent = !cfg.model || filteredKeys.has(modelValue);
    return (
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title={SCOPE_LABEL[scope]}
          description={
            scope === 'main'
              ? 'Compaction for the main session history.'
              : 'Compaction for subagent runs (uses subagent model limits and task-focused prompt).'
          }
        />
        <div className="config-form-grid">
          <FormField
            label="Mode"
            htmlFor={`${prefix}-mode`}
            hint="Compaction strategy. Simple replaces history with a summary; selective uses ID-referenced reconstruction."
            className="config-field"
          >
            <Select
              id={`${prefix}-mode`}
              value={cfg.mode}
              onChange={(e) => handleModeChange(scope, e.target.value)}
              bordered
              className="w-full"
            >
              <option value="simple">simple</option>
              <option value="selective">selective</option>
            </Select>
          </FormField>

          <FormField
            label="Threshold"
            htmlFor={`${prefix}-threshold`}
            hint="Context window fraction that triggers compaction (0.1–0.95). Higher values delay compaction until the window is fuller."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-threshold`}
              type="number"
              value={cfg.threshold}
              onChange={(e) => handleNumberChange(scope, 'threshold', e.target.value, 0.1)}
              bordered
              className="w-full"
              min={0.1}
              max={0.95}
              step={0.05}
            />
          </FormField>

          <FormField
            label="Preserve Percent"
            htmlFor={`${prefix}-preserve-percent`}
            hint="Fraction of the context window kept verbatim (never compacted). The newest messages fill this budget from the end; everything older is summarized. 0.25 = keep the most recent 25%."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-preserve-percent`}
              type="number"
              value={cfg.preserve_percent}
              onChange={(e) => handleNumberChange(scope, 'preserve_percent', e.target.value, 0.05)}
              bordered
              className="w-full"
              min={0.05}
              max={0.9}
              step={0.05}
            />
          </FormField>

          <FormField
            label="Min Compactable Tokens"
            htmlFor={`${prefix}-min-tokens`}
            hint="Minimum tokens in the compactable range before compaction fires. Prevents costly summaries for little gain."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-min-tokens`}
              type="number"
              value={cfg.min_compactable_tokens}
              onChange={(e) => handleNumberChange(scope, 'min_compactable_tokens', e.target.value, 0, { integer: true })}
              bordered
              className="w-full"
              min={0}
              max={1_000_000}
            />
          </FormField>

          <FormField
            label="Mechanical Reclaim"
            htmlFor={`${prefix}-mechanical`}
            hint="When enabled, exact-duplicate tool outputs are reclaimed deterministically before the summarizer LLM call."
            className="config-field"
          >
            <Select
              id={`${prefix}-mechanical`}
              value={cfg.mechanical_reclaim ? 'enabled' : 'disabled'}
              onChange={(e) => handleMechanicalReclaimChange(scope, e.target.value)}
              bordered
              className="w-full"
            >
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </Select>
          </FormField>

          <FormField
            label="Hysteresis Delta"
            htmlFor={`${prefix}-hysteresis`}
            hint={HYSTERESIS_HINT}
            className="config-field"
          >
            <TextInput
              id={`${prefix}-hysteresis`}
              type="number"
              value={cfg.hysteresis_delta}
              onChange={(e) => handleNumberChange(scope, 'hysteresis_delta', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={0.5}
              step={0.05}
            />
          </FormField>

          <FormField
            label="Keep Last User Messages"
            htmlFor={`${prefix}-keep-last-user`}
            hint="Number of most-recent user messages kept in the model view across compaction. Empty = all (subagent default). Main default 10."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-keep-last-user`}
              type="number"
              value={cfg.keep_last_user_messages ?? ''}
              onChange={(e) => handleNullableNumberChange(scope, 'keep_last_user_messages', e.target.value, 1, { integer: true, max: 1000 })}
              bordered
              className="w-full"
              min={1}
              max={1000}
              step={1}
              placeholder={scope === 'subagents' ? 'all' : ''}
            />
          </FormField>

          <FormField
            label="Pin First User Message"
            htmlFor={`${prefix}-pin-first-user`}
            hint="When enabled, the session's first user message always stays in the model view (never summarized away)."
            className="config-field"
          >
            <Select
              id={`${prefix}-pin-first-user`}
              value={cfg.pin_first_user_message ? 'enabled' : 'disabled'}
              onChange={(e) => handlePinFirstUserMessageChange(scope, e.target.value)}
              bordered
              className="w-full"
            >
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </Select>
          </FormField>

          <FormField
            label="Model"
            htmlFor={`${prefix}-model`}
            hint="Optional compactor model override. Inherit uses the fallback chain (tier → current)."
            className="config-field"
          >
            <Select
              id={`${prefix}-model`}
              value={modelValue}
              onChange={(e) => handleModelChange(scope, e.target.value)}
              bordered
              className="w-full"
            >
              <option value="">Inherit (fallback chain)</option>
              {filteredOptions.map((option) => {
                const key = `${option.selection.connectionId}:${option.selection.modelId}`;
                const label = `${option.model.displayName} · ${providerModelOptionContextLabel(option)}`;
                return (
                  <option key={key} value={key}>
                    {label}
                  </option>
                );
              })}
              {!hasCurrent && cfg.model && (
                <option value={modelValue}>
                  {`${cfg.model.modelId} · unavailable (${cfg.model.connectionId})`}
                </option>
              )}
            </Select>
          </FormField>
        </div>
      </Panel>
    );
  };

  return (
    <div className="config-form flex flex-col gap-4">
      {renderScope('main')}
      {renderScope('subagents')}
    </div>
  );
}
