import { useCallback } from 'react';
import type { CompactionConfig, CompactionScopeConfig, CompactionMode } from '../../../shared/types/ipc-boundary';
import { parseConfigNumber } from '../../utils/config-draft';
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

export function CompactionTab({ compaction, onChange }: CompactionTabProps) {
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
      // Enforce upper bounds per schema
      if (field === 'threshold' && num > 0.95) return;
      if (field === 'hysteresis_delta' && num > 0.5) return;
      if (field === 'keep_recent_chains' && num > 100) return;
      if (field === 'min_compactable_tokens' && num > 1_000_000) return;
      updateField(scope, field, num as CompactionScopeConfig[typeof field]);
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

  const handleModelConnectionChange = useCallback(
    (scope: Scope, value: string) => {
      const currentModelId = compaction[scope].model?.modelId ?? '';
      const connTrim = value.trim();
      const modelTrim = currentModelId.trim();
      if (!connTrim && !modelTrim) {
        updateField(scope, 'model', null);
      } else {
        updateField(scope, 'model', { connectionId: connTrim, modelId: modelTrim });
      }
    },
    [compaction, updateField],
  );

  const handleModelIdChange = useCallback(
    (scope: Scope, value: string) => {
      const currentConnectionId = compaction[scope].model?.connectionId ?? '';
      const connTrim = currentConnectionId.trim();
      const modelTrim = value.trim();
      if (!connTrim && !modelTrim) {
        updateField(scope, 'model', null);
      } else {
        updateField(scope, 'model', { connectionId: connTrim, modelId: modelTrim });
      }
    },
    [compaction, updateField],
  );

  const renderScope = (scope: Scope) => {
    const cfg = compaction[scope];
    const prefix = `compaction-${scope}`;
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
            label="Agent Name"
            htmlFor={`${prefix}-agent-name`}
            hint="Internal agent used to summarize. Must match an internal compactor agent definition."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-agent-name`}
              type="text"
              value={cfg.agent_name}
              onChange={(e) => updateField(scope, 'agent_name', e.target.value)}
              bordered
              className="w-full"
              placeholder={scope === 'main' ? 'compactor' : 'compactor-subagent'}
            />
          </FormField>

          <FormField
            label="Keep Recent Chains"
            htmlFor={`${prefix}-keep-recent`}
            hint="Preserve window — recent completed chains kept verbatim and never compacted."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-keep-recent`}
              type="number"
              value={cfg.keep_recent_chains}
              onChange={(e) => handleNumberChange(scope, 'keep_recent_chains', e.target.value, 0, { integer: true })}
              bordered
              className="w-full"
              min={0}
              max={100}
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
            hint="Usage must drop this far below threshold before compaction can re-fire (0–0.5). Prevents rapid re-triggering."
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
            label="Model Connection ID"
            htmlFor={`${prefix}-model-connection`}
            hint="Optional compactor model override — connection ID. Leave both model fields empty to clear override and use fallback chain."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-model-connection`}
              type="text"
              value={cfg.model?.connectionId ?? ''}
              onChange={(e) => handleModelConnectionChange(scope, e.target.value)}
              bordered
              className="w-full"
              placeholder="connectionId or empty for fallback"
            />
          </FormField>

          <FormField
            label="Model ID"
            htmlFor={`${prefix}-model-id`}
            hint="Optional compactor model override — model ID. Leave both empty for fallback (tier → current)."
            className="config-field"
          >
            <TextInput
              id={`${prefix}-model-id`}
              type="text"
              value={cfg.model?.modelId ?? ''}
              onChange={(e) => handleModelIdChange(scope, e.target.value)}
              bordered
              className="w-full"
              placeholder="modelId or empty for fallback"
            />
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
