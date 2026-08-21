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
  toolWorkerPoolSize: number;
  toolWorkerPoolMainAgentReserved: number;
  /** Max seconds to wait mid-turn before auto-naming a default-named session. */
  sessionTitleMaxWaitSeconds: number;
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
  toolWorkerPoolSize,
  toolWorkerPoolMainAgentReserved,
  sessionTitleMaxWaitSeconds,
  onChange,
}: GeneralTabProps) {
  const personalityOptions =
    personality && !personalities.includes(personality)
      ? [personality, ...personalities]
      : [...personalities];

  const handleNumberChange = useCallback(
    (field: NumericConfigKey, value: string, min = 1, max?: number) => {
      const num = parseConfigNumber(value, min, { max });
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
          <FormField label="Command Max Output (bytes)" htmlFor="general-cmd-max-output" className="config-field">
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
          <FormField label="Tool Output Inline Threshold (chars)" htmlFor="general-tool-inline" className="config-field">
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
          <FormField label="Grep Per-File Timeout (s)" htmlFor="general-grep-timeout" className="config-field">
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
          <FormField
            label="Tool Worker Pool Size"
            htmlFor="general-worker-pool-size"
            hint="Concurrent tool execution slots shared by main agent and subagents."
            className="config-field"
          >
            <TextInput
              id="general-worker-pool-size"
              type="number"
              value={toolWorkerPoolSize}
              onChange={(e) => handleIntChange('tool_worker_pool_size', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={8}
            />
          </FormField>
          <FormField
            label="Main Agent Reserved Slots"
            htmlFor="general-worker-pool-reserved"
            hint="Worker slots guaranteed to the main agent so subagents cannot starve it."
            className="config-field"
          >
            <TextInput
              id="general-worker-pool-reserved"
              type="number"
              value={toolWorkerPoolMainAgentReserved}
              onChange={(e) => handleIntChange('tool_worker_pool_main_agent_reserved', e.target.value, 0)}
              bordered
              className="w-full"
              min={0}
              max={8}
            />
          </FormField>
          <FormField
            label="Session Title Max Wait (s)"
            htmlFor="general-session-title-wait"
            hint="Deadline after a turn starts before auto-naming a default-named session from the conversation. 0 disables the deadline."
            className="config-field"
          >
            <TextInput
              id="general-session-title-wait"
              type="number"
              value={sessionTitleMaxWaitSeconds}
              onChange={(e) => handleNumberChange('session_title_max_wait_seconds', e.target.value, 0, 3600)}
              bordered
              className="w-full"
              min={0}
              max={3600}
            />
          </FormField>
        </div>
      </Panel>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Web Fetch" />
        <div className="config-form-grid">
          <FormField label="Web Fetch Timeout (s)" htmlFor="general-web-timeout" className="config-field">
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
          <FormField label="Web Fetch Max Body (bytes)" htmlFor="general-web-max-body" className="config-field">
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
          <FormField label="Web Fetch User-Agent" htmlFor="general-web-ua" className="config-field config-form-grid-full">
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
          <FormField label="MCP Result Max (bytes)" htmlFor="general-mcp-result-max" className="config-field">
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
                Always expand tool groups
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
          <FormField label="Retry Backoff Base (s)" htmlFor="general-retry-base" className="config-field">
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
          <FormField label="Retry Max Delay (s)" htmlFor="general-retry-max-delay" className="config-field">
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
          <FormField label="Max Background Processes" htmlFor="general-max-bg-procs" className="config-field">
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
          <FormField label="Approval Timeout (s)" htmlFor="general-approval-timeout" className="config-field">
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
          <FormField label="Subagent Wait Timeout (s)" htmlFor="general-subagent-wait" className="config-field">
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
          <FormField label="BG Prompt Max Entries" htmlFor="general-bg-max-entries" className="config-field">
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
          <FormField label="BG Prompt Tail Lines" htmlFor="general-bg-tail-lines" className="config-field">
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
          <FormField label="BG Prompt Tail Chars" htmlFor="general-bg-tail-chars" className="config-field">
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
          <FormField label="BG Output Head (bytes)" htmlFor="general-bg-head" className="config-field">
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
          <FormField label="BG Output Tail (bytes)" htmlFor="general-bg-tail" className="config-field">
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
          <FormField label="Read Output Long Poll Max (s)" htmlFor="general-bg-long-poll" className="config-field">
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
