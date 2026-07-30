import { useCallback } from 'react';
import type { SubagentsConfig } from '../../../shared/types/ipc-boundary';
import { parseConfigNumber } from '../../utils/config-draft';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { TextInput } from '../ui/TextInput';

export interface SubagentsTabProps {
  subagents: SubagentsConfig;
  onChange: (subagents: SubagentsConfig) => void;
}

export function SubagentsTab({ subagents, onChange }: SubagentsTabProps) {
  const updateField = useCallback(
    <K extends keyof SubagentsConfig>(field: K, value: SubagentsConfig[K]) => {
      onChange({ ...subagents, [field]: value });
    },
    [subagents, onChange],
  );

  const handleNumberChange = useCallback(
    (field: keyof SubagentsConfig, value: string, min = 1) => {
      const num = parseConfigNumber(value, min, { integer: true });
      if (num !== null) {
        updateField(field, num);
      }
    },
    [updateField],
  );

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Concurrency & Admission" />
        <div className="config-form-grid">
          <FormField
            label="Max Active (Global)"
            htmlFor="subagents-max-active-global"
            hint="Max concurrently running subagents across all sessions."
            className="config-field"
          >
            <TextInput
              id="subagents-max-active-global"
              type="number"
              value={subagents.max_active_global}
              onChange={(e) => handleNumberChange('max_active_global', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={256}
            />
          </FormField>

          <FormField
            label="Max Active (Per Session)"
            htmlFor="subagents-max-active-per-session"
            hint="Max concurrently running subagents within one session."
            className="config-field"
          >
            <TextInput
              id="subagents-max-active-per-session"
              type="number"
              value={subagents.max_active_per_session}
              onChange={(e) => handleNumberChange('max_active_per_session', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={256}
            />
          </FormField>

          <FormField
            label="Max Queued"
            htmlFor="subagents-max-queued"
            hint="Max queued subagents before new spawns are rejected."
            className="config-field"
          >
            <TextInput
              id="subagents-max-queued"
              type="number"
              value={subagents.max_queued}
              onChange={(e) => handleNumberChange('max_queued', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={1024}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Event Batching" />
        <div className="config-form-grid">
          <FormField label="Max Events Per Flush" htmlFor="subagents-event-max-per-flush" className="config-field">
            <TextInput
              id="subagents-event-max-per-flush"
              type="number"
              value={subagents.event_max_per_flush}
              onChange={(e) => handleNumberChange('event_max_per_flush', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={100000}
            />
          </FormField>

          <FormField label="Byte Budget (KB)" htmlFor="subagents-event-byte-budget-kb" className="config-field">
            <TextInput
              id="subagents-event-byte-budget-kb"
              type="number"
              value={subagents.event_byte_budget_kb}
              onChange={(e) => handleNumberChange('event_byte_budget_kb', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={65536}
            />
          </FormField>

          <FormField
            label="Usage Event Interval (ms)"
            htmlFor="subagents-usage-event-interval-ms"
            hint="Minimum interval between per-subagent usage deltas. 0 emits every usage event."
            className="config-field"
          >
            <TextInput
              id="subagents-usage-event-interval-ms"
              type="number"
              value={subagents.usage_event_interval_ms}
              onChange={(e) => handleNumberChange('usage_event_interval_ms', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={3600000}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Hydration & Persistence" />
        <div className="config-form-grid">
          <FormField label="Hydration Buffer (KB)" htmlFor="subagents-hydration-buffer-kb" className="config-field">
            <TextInput
              id="subagents-hydration-buffer-kb"
              type="number"
              value={subagents.hydration_buffer_kb}
              onChange={(e) => handleNumberChange('hydration_buffer_kb', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={65536}
            />
          </FormField>

          <FormField
            label="Terminal Wave (ms)"
            htmlFor="subagents-terminal-wave-ms"
            hint="Window batching near-simultaneous terminal persistence flushes."
            className="config-field"
          >
            <TextInput
              id="subagents-terminal-wave-ms"
              type="number"
              value={subagents.terminal_wave_ms}
              onChange={(e) => handleNumberChange('terminal_wave_ms', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={60000}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Prompt & Retention" />
        <div className="config-form-grid">
          <FormField
            label="Terminal Retention"
            htmlFor="subagents-terminal-retention"
            hint="Recent terminal summaries retained after runtime eviction."
            className="config-field"
          >
            <TextInput
              id="subagents-terminal-retention"
              type="number"
              value={subagents.terminal_retention}
              onChange={(e) => handleNumberChange('terminal_retention', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={1000}
            />
          </FormField>

          <FormField
            label="Prompt Recent Terminal"
            htmlFor="subagents-prompt-recent-terminal"
            hint="Recent terminal summaries included in the dynamic system prompt."
            className="config-field"
          >
            <TextInput
              id="subagents-prompt-recent-terminal"
              type="number"
              value={subagents.prompt_recent_terminal}
              onChange={(e) => handleNumberChange('prompt_recent_terminal', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={100}
            />
          </FormField>

          <FormField
            label="Prompt Task Max Chars"
            htmlFor="subagents-prompt-task-max-chars"
            hint="Task-text cap for terminal summaries rendered into the prompt."
            className="config-field"
          >
            <TextInput
              id="subagents-prompt-task-max-chars"
              type="number"
              value={subagents.prompt_task_max_chars}
              onChange={(e) => handleNumberChange('prompt_task_max_chars', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={100000}
            />
          </FormField>
        </div>
      </Panel>
    </div>
  );
}
