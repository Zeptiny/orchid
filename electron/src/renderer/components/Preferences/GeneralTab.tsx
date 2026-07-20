/**
 * GeneralTab — general application settings.
 *
 * Organized into fieldsets: General, Tool Limits, MCP, Chat display, Streaming.
 */
import { useCallback } from 'react';
import type { ConfigPatch } from '../../../shared/types/ipc';
import { THEMES, THEME_NAMES, type ThemeName } from '../../themes';
import {
  configNumberPatch,
  parseConfigNumber,
  type NumericConfigKey,
} from '../../utils/config-draft';
import { Checkbox } from '../ui/Checkbox';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeneralTabProps {
  theme: string;
  personality: string;
  /** Personality names loaded from `~/.orchid/personalities/*.md`. */
  personalities?: readonly string[];
  ignoredDirs: string[];
  commandTimeout: number;
  readLineLimit: number;
  grepMaxResults: number;
  directoryTreeDepth: number;
  astMaxFileSize: number;
  mcpStartupTimeout: number;
  mcpPerServerTimeout: number;
  llmStreamIdleTimeout: number;
  llmStreamRetries: number;
  backgroundCommandIdleTimeout: number;
  /**
   * Max multi-step tool-loop iterations per LLM stream (AI SDK stopWhen).
   * Default 100.
   */
  maxToolSteps: number;
  /** When true, compact tool-activity groups start expanded. */
  alwaysExpandToolGroups: boolean;
  onChange: (updates: ConfigPatch) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function GeneralTab({
  theme,
  personality,
  personalities = [],
  ignoredDirs,
  commandTimeout,
  readLineLimit,
  grepMaxResults,
  directoryTreeDepth,
  astMaxFileSize,
  mcpStartupTimeout,
  mcpPerServerTimeout,
  llmStreamIdleTimeout,
  llmStreamRetries,
  backgroundCommandIdleTimeout,
  maxToolSteps,
  alwaysExpandToolGroups,
  onChange,
}: GeneralTabProps) {
  const personalityOptions =
    personality && !personalities.includes(personality)
      ? [personality, ...personalities]
      : [...personalities];

  const handleNumberChange = useCallback(
    (field: NumericConfigKey, value: string, min = 1) => {
      const num = parseConfigNumber(value, min);
      if (num !== null) {
        onChange(configNumberPatch(field, num));
      }
    },
    [onChange],
  );

  /** Integer config fields (schema `.int()`) — reject non-integers like 12.5. */
  const handleIntChange = useCallback(
    (field: NumericConfigKey, value: string, min = 1) => {
      const num = parseConfigNumber(value, min, { integer: true });
      if (num !== null) {
        onChange(configNumberPatch(field, num));
      }
    },
    [onChange],
  );

  const handleIgnoredDirsChange = useCallback(
    (value: string) => {
      const dirs = value
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      onChange({ ignored_dirs: dirs });
    },
    [onChange],
  );

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="General" />
        <div className="config-form-grid">
          <FormField label="Theme" htmlFor="general-theme" className="config-field">
            <Select
              id="general-theme"
              value={theme}
              onChange={(e) => onChange({ theme: e.target.value })}
              bordered
              className="w-full"
            >
              {THEME_NAMES.map((name) => (
                <option key={name} value={name}>
                  {THEMES[name as ThemeName]}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Personality" htmlFor="general-personality" className="config-field">
            <Select
              id="general-personality"
              value={personality}
              onChange={(e) => onChange({ personality: e.target.value })}
              bordered
              className="w-full"
            >
              {personalityOptions.length === 0 ? (
                <option value={personality || 'default'}>{personality || 'default'}</option>
              ) : (
                personalityOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </Select>
          </FormField>

          <FormField
            label="Ignored Directories (file ops, RAG, AST, glob)"
            htmlFor="general-ignored-dirs"
            hint="Comma-separated directory names to skip."
            className="config-field config-form-grid-full"
          >
            <textarea
              id="general-ignored-dirs"
              className="textarea textarea-bordered w-full"
              value={ignoredDirs.join(', ')}
              onChange={(e) => handleIgnoredDirsChange(e.target.value)}
              placeholder=".git, node_modules, __pycache__, .venv, dist, build"
              rows={3}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Tool Limits" />
        <div className="config-form-grid">
          <FormField label="Command Timeout (s)" htmlFor="general-command-timeout" className="config-field">
            <TextInput
              id="general-command-timeout"
              type="number"
              value={commandTimeout}
              onChange={(e) => handleNumberChange('command_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={300}
            />
          </FormField>
          <FormField label="Read Line Limit" htmlFor="general-read-line-limit" className="config-field">
            <TextInput
              id="general-read-line-limit"
              type="number"
              value={readLineLimit}
              onChange={(e) => handleNumberChange('read_line_limit', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={10000}
            />
          </FormField>
          <FormField label="Grep Max Results" htmlFor="general-grep-max" className="config-field">
            <TextInput
              id="general-grep-max"
              type="number"
              value={grepMaxResults}
              onChange={(e) => handleNumberChange('grep_max_results', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={1000}
            />
          </FormField>
          <FormField label="Directory Tree Depth" htmlFor="general-tree-depth" className="config-field">
            <TextInput
              id="general-tree-depth"
              type="number"
              value={directoryTreeDepth}
              onChange={(e) => handleNumberChange('directory_tree_depth', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={10}
            />
          </FormField>
          <FormField label="AST Max File Size (bytes)" htmlFor="general-ast-max" className="config-field">
            <TextInput
              id="general-ast-max"
              type="number"
              value={astMaxFileSize}
              onChange={(e) => handleNumberChange('ast_max_file_size', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="MCP" />
        <div className="config-form-grid">
          <FormField
            label="MCP Startup Timeout (s)"
            htmlFor="general-mcp-startup-timeout"
            hint="Overall budget for starting all MCP servers."
            className="config-field"
          >
            <TextInput
              id="general-mcp-startup-timeout"
              type="number"
              value={mcpStartupTimeout}
              onChange={(e) => handleNumberChange('mcp_startup_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField
            label="MCP Per-Server Timeout (s)"
            htmlFor="general-mcp-per-server-timeout"
            hint="Connect timeout applied to each MCP server."
            className="config-field"
          >
            <TextInput
              id="general-mcp-per-server-timeout"
              type="number"
              value={mcpPerServerTimeout}
              onChange={(e) => handleNumberChange('mcp_per_server_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Chat display" />
        <div className="config-form-grid">
          <div className="config-field config-form-grid-full flex flex-col gap-1">
            <label className="label cursor-pointer justify-start gap-3 py-0" htmlFor="general-expand-tool-groups">
              <Checkbox
                id="general-expand-tool-groups"
                size="sm"
                checked={alwaysExpandToolGroups}
                onChange={(e) =>
                  onChange({ always_expand_tool_groups: e.target.checked })
                }
              />
              <span className="label-text">Always expand tool groups</span>
            </label>
            <p className="label py-0 text-base-content/60">
              Show individual tool rows under explore summaries (Searched N · Read M)
              by default. When off, groups stay collapsed until you click them.
            </p>
          </div>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Streaming" />
        <div className="config-form-grid">
          <FormField label="Stream Idle Timeout (s)" htmlFor="general-stream-idle" className="config-field">
            <TextInput
              id="general-stream-idle"
              type="number"
              value={llmStreamIdleTimeout}
              onChange={(e) => handleNumberChange('llm_stream_idle_timeout', e.target.value, 10)}
              bordered
              className="w-full"
              min={10}
              max={600}
            />
          </FormField>
          <FormField
            label="Stream Retries"
            htmlFor="general-stream-retries"
            hint="Zero disables stream retries."
            className="config-field"
          >
            <TextInput
              id="general-stream-retries"
              type="number"
              value={llmStreamRetries}
              onChange={(e) => handleIntChange('llm_stream_retries', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={10}
            />
          </FormField>
          <FormField
            label="Max Tool Steps"
            htmlFor="general-max-tool-steps"
            hint="Max tool-loop iterations per agent turn (default 100). Higher values allow longer multi-step plans; lower values stop runaway loops sooner."
            className="config-field"
          >
            <TextInput
              id="general-max-tool-steps"
              type="number"
              value={maxToolSteps}
              onChange={(e) => handleIntChange('max_tool_steps', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={1000}
              step={1}
            />
          </FormField>
          <FormField label="BG Command Idle Timeout (s)" htmlFor="general-bg-idle" className="config-field">
            <TextInput
              id="general-bg-idle"
              type="number"
              value={backgroundCommandIdleTimeout}
              onChange={(e) => handleNumberChange('background_command_idle_timeout', e.target.value, 30)}
              bordered
              className="w-full"
              min={30}
              max={3600}
            />
          </FormField>
        </div>
      </Panel>
    </div>
  );
}
