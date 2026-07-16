/**
 * GeneralTab — general application settings.
 *
 * Organized into fieldsets matching the Iteration 012 mock:
 * General (theme, personality, ignored dirs), Tool Limits, Streaming.
 *
 * Dropdowns use the shared daisyUI `select config-control` pattern (same as
 * Tier Models / RAG embedding model).
 */
import { useCallback } from 'react';
import { THEMES, THEME_NAMES, type ThemeName } from '../../themes';

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
  onChange: (updates: Record<string, unknown>) => void;
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
  // Ensure the currently selected value is always in the list (e.g. if file was removed)
  const personalityOptions =
    personality && !personalities.includes(personality)
      ? [personality, ...personalities]
      : [...personalities];

  const handleNumberChange = useCallback(
    (field: string, value: string, min = 1) => {
      const num = parseFloat(value);
      if (!Number.isNaN(num) && num >= min) {
        onChange({ [field]: num });
      }
    },
    [onChange],
  );

  /** Integer config fields (schema `.int()`) — reject non-integers like 12.5. */
  const handleIntChange = useCallback(
    (field: string, value: string) => {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return;
      const num = Number(trimmed);
      if (num > 0) {
        onChange({ [field]: num });
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
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">General</div>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="general-theme">Theme</label>
            <select
              id="general-theme"
              value={theme}
              onChange={(e) => onChange({ theme: e.target.value })}
              className="select config-control"
            >
              {THEME_NAMES.map((name) => (
                <option key={name} value={name}>
                  {THEMES[name as ThemeName]}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor="general-personality">Personality</label>
            <select
              id="general-personality"
              value={personality}
              onChange={(e) => onChange({ personality: e.target.value })}
              className="select config-control"
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
            </select>
          </div>

          <div className="config-field config-form-grid-full">
            <label htmlFor="general-ignored-dirs">
              Ignored Directories (file ops, RAG, AST, glob)
            </label>
            <textarea
              id="general-ignored-dirs"
              className="textarea config-textarea"
              value={ignoredDirs.join(', ')}
              onChange={(e) => handleIgnoredDirsChange(e.target.value)}
              placeholder=".git, node_modules, __pycache__, .venv, dist, build"
              rows={3}
            />
            <span className="config-field-hint">Comma-separated directory names to skip.</span>
          </div>
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">Tool Limits</div>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="general-command-timeout">Command Timeout (s)</label>
            <input
              id="general-command-timeout"
              type="number"
              value={commandTimeout}
              onChange={(e) => handleNumberChange('command_timeout', e.target.value)}
              className="input config-control"
              min={1}
              max={300}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-read-line-limit">Read Line Limit</label>
            <input
              id="general-read-line-limit"
              type="number"
              value={readLineLimit}
              onChange={(e) => handleNumberChange('read_line_limit', e.target.value)}
              className="input config-control"
              min={1}
              max={10000}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-grep-max">Grep Max Results</label>
            <input
              id="general-grep-max"
              type="number"
              value={grepMaxResults}
              onChange={(e) => handleNumberChange('grep_max_results', e.target.value)}
              className="input config-control"
              min={1}
              max={1000}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-tree-depth">Directory Tree Depth</label>
            <input
              id="general-tree-depth"
              type="number"
              value={directoryTreeDepth}
              onChange={(e) => handleNumberChange('directory_tree_depth', e.target.value)}
              className="input config-control"
              min={1}
              max={10}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-ast-max">AST Max File Size (bytes)</label>
            <input
              id="general-ast-max"
              type="number"
              value={astMaxFileSize}
              onChange={(e) => handleNumberChange('ast_max_file_size', e.target.value)}
              className="input config-control"
              min={1}
            />
          </div>
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">MCP</div>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="general-mcp-startup-timeout">MCP Startup Timeout (s)</label>
            <input
              id="general-mcp-startup-timeout"
              type="number"
              value={mcpStartupTimeout}
              onChange={(e) => handleNumberChange('mcp_startup_timeout', e.target.value)}
              className="input config-control"
              min={1}
            />
            <span className="config-field-hint">Overall budget for starting all MCP servers.</span>
          </div>
          <div className="config-field">
            <label htmlFor="general-mcp-per-server-timeout">MCP Per-Server Timeout (s)</label>
            <input
              id="general-mcp-per-server-timeout"
              type="number"
              value={mcpPerServerTimeout}
              onChange={(e) => handleNumberChange('mcp_per_server_timeout', e.target.value)}
              className="input config-control"
              min={1}
            />
            <span className="config-field-hint">Connect timeout applied to each MCP server.</span>
          </div>
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">Chat display</div>
        <div className="config-form-grid">
          <div className="config-field config-form-grid-full">
            <label className="config-checkbox-label" htmlFor="general-expand-tool-groups">
              <input
                id="general-expand-tool-groups"
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={alwaysExpandToolGroups}
                onChange={(e) =>
                  onChange({ always_expand_tool_groups: e.target.checked })
                }
              />
              <span>Always expand tool groups</span>
            </label>
            <span className="config-field-hint">
              Show individual tool rows under explore summaries (Searched N · Read M)
              by default. When off, groups stay collapsed until you click them.
            </span>
          </div>
        </div>
      </section>

      <section className="config-fieldset">
        <div className="config-fieldset-legend">Streaming</div>
        <div className="config-form-grid">
          <div className="config-field">
            <label htmlFor="general-stream-idle">Stream Idle Timeout (s)</label>
            <input
              id="general-stream-idle"
              type="number"
              value={llmStreamIdleTimeout}
              onChange={(e) => handleNumberChange('llm_stream_idle_timeout', e.target.value)}
              className="input config-control"
              min={10}
              max={600}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-stream-retries">Stream Retries</label>
            <input
              id="general-stream-retries"
              type="number"
              value={llmStreamRetries}
              onChange={(e) => handleNumberChange('llm_stream_retries', e.target.value, 0)}
              className="input config-control"
              min={0}
              max={10}
            />
          </div>
          <div className="config-field">
            <label htmlFor="general-max-tool-steps">Max Tool Steps</label>
            <input
              id="general-max-tool-steps"
              type="number"
              value={maxToolSteps}
              onChange={(e) => handleIntChange('max_tool_steps', e.target.value)}
              className="input config-control"
              min={1}
              max={1000}
              step={1}
            />
            <span className="config-field-hint">
              Max tool-loop iterations per agent turn (default 100). Higher values
              allow longer multi-step plans; lower values stop runaway loops sooner.
            </span>
          </div>
          <div className="config-field">
            <label htmlFor="general-bg-idle">BG Command Idle Timeout (s)</label>
            <input
              id="general-bg-idle"
              type="number"
              value={backgroundCommandIdleTimeout}
              onChange={(e) => handleNumberChange('background_command_idle_timeout', e.target.value)}
              className="input config-control"
              min={30}
              max={3600}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
