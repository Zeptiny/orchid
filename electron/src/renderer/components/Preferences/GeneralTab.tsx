/**
 * GeneralTab — general application settings.
 *
 * Organized into fieldsets: General, Tool Limits, MCP, Chat display, Streaming.
 */
import { useCallback, type ReactNode } from 'react';
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
import { ScopeBadge } from './ScopeToggle';

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
  commandMaxOutputBytes: number;
  toolOutputInlineThreshold: number;
  grepPerFileTimeout: number;
  webFetchTimeout: number;
  webFetchMaxBodyBytes: number;
  webFetchUserAgent: string;
  llmRetryBackoffBase: number;
  llmRetryMaxDelay: number;
  maxBackgroundProcesses: number;
  approvalTimeout: number;
  subagentWaitTimeout: number;
  bgPromptMaxEntries: number;
  bgPromptTailLines: number;
  bgPromptTailChars: number;
  bgOutputHeadBytes: number;
  bgOutputTailBytes: number;
  readOutputLongPollMax: number;
  mcpResultMaxBytes: number;
  /** Raw `.orchid.json` overrides of the bound project, for per-field indicators. */
  projectOverrides?: Record<string, unknown> | null;
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
  commandMaxOutputBytes,
  toolOutputInlineThreshold,
  grepPerFileTimeout,
  webFetchTimeout,
  webFetchMaxBodyBytes,
  webFetchUserAgent,
  llmRetryBackoffBase,
  llmRetryMaxDelay,
  maxBackgroundProcesses,
  approvalTimeout,
  subagentWaitTimeout,
  bgPromptMaxEntries,
  bgPromptTailLines,
  bgPromptTailChars,
  bgOutputHeadBytes,
  bgOutputTailBytes,
  readOutputLongPollMax,
  mcpResultMaxBytes,
  projectOverrides = null,
  onChange,
}: GeneralTabProps) {
  const personalityOptions =
    personality && !personalities.includes(personality)
      ? [personality, ...personalities]
      : [...personalities];

  const fieldLabel = useCallback(
    (text: string, key: string): ReactNode => {
      if (!projectOverrides || !(key in projectOverrides)) return text;
      return (
        <span className="inline-flex items-center gap-1.5">
          {text}
          <ScopeBadge scope="project" />
        </span>
      );
    },
    [projectOverrides],
  );

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
          <FormField label={fieldLabel('Theme', 'theme')} htmlFor="general-theme" className="config-field">
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

          <FormField label={fieldLabel('Personality', 'personality')} htmlFor="general-personality" className="config-field">
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
            label={fieldLabel('Ignored Directories (file ops, RAG, AST, glob)', 'ignored_dirs')}
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
          <FormField label={fieldLabel('Command Timeout (s)', 'command_timeout')} htmlFor="general-command-timeout" className="config-field">
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
          <FormField label={fieldLabel('Read Line Limit', 'read_line_limit')} htmlFor="general-read-line-limit" className="config-field">
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
          <FormField label={fieldLabel('Grep Max Results', 'grep_max_results')} htmlFor="general-grep-max" className="config-field">
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
          <FormField label={fieldLabel('Directory Tree Depth', 'directory_tree_depth')} htmlFor="general-tree-depth" className="config-field">
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
          <FormField label={fieldLabel('AST Max File Size (bytes)', 'ast_max_file_size')} htmlFor="general-ast-max" className="config-field">
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
          <FormField label={fieldLabel('Command Max Output (bytes)', 'command_max_output_bytes')} htmlFor="general-cmd-max-output" className="config-field">
            <TextInput
              id="general-cmd-max-output"
              type="number"
              value={commandMaxOutputBytes}
              onChange={(e) => handleIntChange('command_max_output_bytes', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Tool Output Inline Threshold (chars)', 'tool_output_inline_threshold')} htmlFor="general-tool-inline" className="config-field">
            <TextInput
              id="general-tool-inline"
              type="number"
              value={toolOutputInlineThreshold}
              onChange={(e) => handleIntChange('tool_output_inline_threshold', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Grep Per-File Timeout (s)', 'grep_per_file_timeout')} htmlFor="general-grep-timeout" className="config-field">
            <TextInput
              id="general-grep-timeout"
              type="number"
              value={grepPerFileTimeout}
              onChange={(e) => handleNumberChange('grep_per_file_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Web Fetch" />
        <div className="config-form-grid">
          <FormField label={fieldLabel('Web Fetch Timeout (s)', 'web_fetch_timeout')} htmlFor="general-web-timeout" className="config-field">
            <TextInput
              id="general-web-timeout"
              type="number"
              value={webFetchTimeout}
              onChange={(e) => handleNumberChange('web_fetch_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Web Fetch Max Body (bytes)', 'web_fetch_max_body_bytes')} htmlFor="general-web-max-body" className="config-field">
            <TextInput
              id="general-web-max-body"
              type="number"
              value={webFetchMaxBodyBytes}
              onChange={(e) => handleIntChange('web_fetch_max_body_bytes', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Web Fetch User-Agent', 'web_fetch_user_agent')} htmlFor="general-web-ua" className="config-field config-form-grid-full">
            <TextInput
              id="general-web-ua"
              type="text"
              value={webFetchUserAgent}
              onChange={(e) => onChange({ web_fetch_user_agent: e.target.value })}
              bordered
              className="w-full"
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="MCP" />
        <div className="config-form-grid">
          <FormField
            label={fieldLabel('MCP Startup Timeout (s)', 'mcp_startup_timeout')}
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
            label={fieldLabel('MCP Per-Server Timeout (s)', 'mcp_per_server_timeout')}
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
          <FormField label={fieldLabel('MCP Result Max (bytes)', 'mcp_result_max_bytes')} htmlFor="general-mcp-result-max" className="config-field">
            <TextInput
              id="general-mcp-result-max"
              type="number"
              value={mcpResultMaxBytes}
              onChange={(e) => handleIntChange('mcp_result_max_bytes', e.target.value)}
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
              <span className="label-text">
                {fieldLabel('Always expand tool groups', 'always_expand_tool_groups')}
              </span>
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
          <FormField label={fieldLabel('Stream Idle Timeout (s)', 'llm_stream_idle_timeout')} htmlFor="general-stream-idle" className="config-field">
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
            label={fieldLabel('Stream Retries', 'llm_stream_retries')}
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
            label={fieldLabel('Max Tool Steps', 'max_tool_steps')}
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
          <FormField label={fieldLabel('BG Command Idle Timeout (s)', 'background_command_idle_timeout')} htmlFor="general-bg-idle" className="config-field">
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
          <FormField label={fieldLabel('Retry Backoff Base (s)', 'llm_retry_backoff_base')} htmlFor="general-retry-base" className="config-field">
            <TextInput
              id="general-retry-base"
              type="number"
              value={llmRetryBackoffBase}
              onChange={(e) => handleNumberChange('llm_retry_backoff_base', e.target.value, 0.01)}
              bordered
              className="w-full"
              min={0.01}
              step={0.01}
            />
          </FormField>
          <FormField label={fieldLabel('Retry Max Delay (s)', 'llm_retry_max_delay')} htmlFor="general-retry-max-delay" className="config-field">
            <TextInput
              id="general-retry-max-delay"
              type="number"
              value={llmRetryMaxDelay}
              onChange={(e) => handleNumberChange('llm_retry_max_delay', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Max Background Processes', 'max_background_processes')} htmlFor="general-max-bg-procs" className="config-field">
            <TextInput
              id="general-max-bg-procs"
              type="number"
              value={maxBackgroundProcesses}
              onChange={(e) => handleIntChange('max_background_processes', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={256}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Permissions & Agents" />
        <div className="config-form-grid">
          <FormField label={fieldLabel('Approval Timeout (s)', 'approval_timeout')} htmlFor="general-approval-timeout" className="config-field">
            <TextInput
              id="general-approval-timeout"
              type="number"
              value={approvalTimeout}
              onChange={(e) => handleNumberChange('approval_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Subagent Wait Timeout (s)', 'subagent_wait_timeout')} htmlFor="general-subagent-wait" className="config-field">
            <TextInput
              id="general-subagent-wait"
              type="number"
              value={subagentWaitTimeout}
              onChange={(e) => handleNumberChange('subagent_wait_timeout', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Background Commands" />
        <div className="config-form-grid">
          <FormField label={fieldLabel('BG Prompt Max Entries', 'bg_prompt_max_entries')} htmlFor="general-bg-max-entries" className="config-field">
            <TextInput
              id="general-bg-max-entries"
              type="number"
              value={bgPromptMaxEntries}
              onChange={(e) => handleIntChange('bg_prompt_max_entries', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={50}
            />
          </FormField>
          <FormField label={fieldLabel('BG Prompt Tail Lines', 'bg_prompt_tail_lines')} htmlFor="general-bg-tail-lines" className="config-field">
            <TextInput
              id="general-bg-tail-lines"
              type="number"
              value={bgPromptTailLines}
              onChange={(e) => handleIntChange('bg_prompt_tail_lines', e.target.value)}
              bordered
              className="w-full"
              min={1}
              max={100}
            />
          </FormField>
          <FormField label={fieldLabel('BG Prompt Tail Chars', 'bg_prompt_tail_chars')} htmlFor="general-bg-tail-chars" className="config-field">
            <TextInput
              id="general-bg-tail-chars"
              type="number"
              value={bgPromptTailChars}
              onChange={(e) => handleIntChange('bg_prompt_tail_chars', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('BG Output Head (bytes)', 'bg_output_head_bytes')} htmlFor="general-bg-head" className="config-field">
            <TextInput
              id="general-bg-head"
              type="number"
              value={bgOutputHeadBytes}
              onChange={(e) => handleIntChange('bg_output_head_bytes', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('BG Output Tail (bytes)', 'bg_output_tail_bytes')} htmlFor="general-bg-tail" className="config-field">
            <TextInput
              id="general-bg-tail"
              type="number"
              value={bgOutputTailBytes}
              onChange={(e) => handleIntChange('bg_output_tail_bytes', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
          <FormField label={fieldLabel('Read Output Long Poll Max (s)', 'read_output_long_poll_max')} htmlFor="general-bg-long-poll" className="config-field">
            <TextInput
              id="general-bg-long-poll"
              type="number"
              value={readOutputLongPollMax}
              onChange={(e) => handleNumberChange('read_output_long_poll_max', e.target.value)}
              bordered
              className="w-full"
              min={1}
            />
          </FormField>
        </div>
      </Panel>
    </div>
  );
}
