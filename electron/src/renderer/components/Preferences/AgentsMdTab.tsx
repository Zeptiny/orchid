import { useCallback } from 'react';
import type { AgentsMdConfig, AgentsMdEnforcePolicy } from '../../../shared/types/ipc-boundary';
import { parseConfigNumber } from '../../utils/config-draft';
import { Checkbox } from '../ui/Checkbox';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';

const ENFORCE_POLICIES: readonly AgentsMdEnforcePolicy[] = ['block', 'inject', 'warn', 'off'];

export interface AgentsMdTabProps {
  agentsMd: AgentsMdConfig;
  onChange: (agentsMd: AgentsMdConfig) => void;
}

export function AgentsMdTab({ agentsMd, onChange }: AgentsMdTabProps) {
  const updateField = useCallback(
    <K extends keyof AgentsMdConfig>(field: K, value: AgentsMdConfig[K]) => {
      onChange({ ...agentsMd, [field]: value });
    },
    [agentsMd, onChange],
  );

  const handleNumberChange = useCallback(
    (field: 'max_file_bytes' | 'max_chain_depth', value: string, min = 1) => {
      const num = parseConfigNumber(value, min, { integer: true });
      if (num !== null) {
        updateField(field, num);
      }
    },
    [updateField],
  );

  const handleFilenamesChange = useCallback(
    (value: string) => {
      const filenames = value
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      updateField('filenames', filenames);
    },
    [updateField],
  );

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Discovery"
          description="Controls how instruction files (AGENTS.md and aliases) are found and loaded."
        />
        <div className="config-form-grid">
          <div className="config-field config-form-grid-full flex flex-col gap-1">
            <label className="flex cursor-pointer items-center gap-3" htmlFor="agentsmd-enabled">
              <Checkbox
                id="agentsmd-enabled"
                size="sm"
                checked={agentsMd.enabled}
                onChange={(e) => updateField('enabled', e.target.checked)}
              />
              <span>
                Enable AGENTS.md discovery
              </span>
            </label>
            <p className="text-base-content/60 text-sm">
              Master switch for instruction-file discovery, injection, and write enforcement.
            </p>
          </div>

          <FormField
            label="Filenames"
            htmlFor="agentsmd-filenames"
            hint="Comma-separated aliases, ordered by priority. First present per directory wins."
            className="config-field config-form-grid-full"
          >
            <TextInput
              id="agentsmd-filenames"
              value={agentsMd.filenames.join(', ')}
              onChange={(e) => handleFilenamesChange(e.target.value)}
              placeholder="AGENTS.md, CLAUDE.md"
              bordered
              className="w-full"
            />
          </FormField>

          <div className="config-field config-form-grid-full flex flex-col gap-1">
            <label className="flex cursor-pointer items-center gap-3" htmlFor="agentsmd-include-local">
              <Checkbox
                id="agentsmd-include-local"
                size="sm"
                checked={agentsMd.include_local}
                onChange={(e) => updateField('include_local', e.target.checked)}
              />
              <span>
                Include AGENTS.local.md
              </span>
            </label>
            <p className="text-base-content/60 text-sm">
              Also consider AGENTS.local.md as the lowest-precedence alias.
            </p>
          </div>

          <FormField
            label="Max File Size (bytes)"
            htmlFor="agentsmd-max-bytes"
            hint="Byte cap for injected instruction-file content."
            className="config-field"
          >
            <TextInput
              id="agentsmd-max-bytes"
              type="number"
              value={agentsMd.max_file_bytes}
              onChange={(e) => handleNumberChange('max_file_bytes', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={2097152}
            />
          </FormField>

          <FormField
            label="Max Chain Depth"
            htmlFor="agentsmd-chain-depth"
            hint="Max directories walked upward when resolving the governing chain."
            className="config-field"
          >
            <TextInput
              id="agentsmd-chain-depth"
              type="number"
              value={agentsMd.max_chain_depth}
              onChange={(e) => handleNumberChange('max_chain_depth', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={32}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="Injection & Enforcement"
          description="Controls when instruction files are surfaced to the agent and how writes are gated."
        />
        <div className="config-form-grid">
          <div className="config-field config-form-grid-full flex flex-col gap-1">
            <label className="flex cursor-pointer items-center gap-3" htmlFor="agentsmd-inject-on-read">
              <Checkbox
                id="agentsmd-inject-on-read"
                size="sm"
                checked={agentsMd.inject_on_read}
                onChange={(e) => updateField('inject_on_read', e.target.checked)}
              />
              <span>
                Inject on read
              </span>
            </label>
            <p className="text-base-content/60 text-sm">
              Append unseen governing files to single-path read-tool results.
            </p>
          </div>

          <FormField
            label="Enforce on Write"
            htmlFor="agentsmd-enforce"
            hint="Policy for mutations touching files with unseen governing instruction files."
            className="config-field"
          >
            <Select
              id="agentsmd-enforce"
              value={agentsMd.enforce_on_write}
              onChange={(e) => updateField('enforce_on_write', e.target.value as AgentsMdEnforcePolicy)}
              bordered
              className="w-full"
            >
              {ENFORCE_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Panel>
    </div>
  );
}
