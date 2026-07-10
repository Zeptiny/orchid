/**
 * GeneralTab — general application settings.
 *
 * Organized into fieldsets matching the Iteration 012 mock:
 * General (model, theme, personality, ignored dirs), Tool Limits, Streaming.
 *
 * Dropdowns use the shared daisyUI `select config-control` pattern (same as
 * Tier Models / RAG embedding model).
 */
import { useCallback, useMemo } from 'react';
import { THEMES, THEME_NAMES, type ThemeName } from '../../themes';
import { collectModelsFromProviders } from '../../utils/models';
import { ModelPicker } from '../ModelPicker';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeneralTabProps {
  defaultModel: string;
  theme: string;
  personality: string;
  /** Personality names loaded from `~/.orchid/personalities/*.md`. */
  personalities?: readonly string[];
  /** Providers config — used to populate the default model dropdown. */
  providers?: Record<string, Record<string, unknown>>;
  ignoredDirs: string[];
  commandTimeout: number;
  readLineLimit: number;
  grepMaxResults: number;
  directoryTreeDepth: number;
  astMaxFileSize: number;
  llmStreamIdleTimeout: number;
  llmStreamRetries: number;
  backgroundCommandIdleTimeout: number;
  /** When true, compact tool-activity groups start expanded. */
  alwaysExpandToolGroups: boolean;
  onChange: (updates: Record<string, unknown>) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function GeneralTab({
  defaultModel,
  theme,
  personality,
  personalities = [],
  providers = {},
  ignoredDirs,
  commandTimeout,
  readLineLimit,
  grepMaxResults,
  directoryTreeDepth,
  astMaxFileSize,
  llmStreamIdleTimeout,
  llmStreamRetries,
  backgroundCommandIdleTimeout,
  alwaysExpandToolGroups,
  onChange,
}: GeneralTabProps) {
  // Ensure the currently selected value is always in the list (e.g. if file was removed)
  const personalityOptions =
    personality && !personalities.includes(personality)
      ? [personality, ...personalities]
      : [...personalities];

  const modelOptions = useMemo(() => collectModelsFromProviders(providers), [providers]);

  const handleNumberChange = useCallback(
    (field: string, value: string) => {
      const num = parseFloat(value);
      if (!isNaN(num) && num > 0) {
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
            <label>Default Model</label>
            <ModelPicker
              value={defaultModel}
              options={modelOptions}
              onChange={(value) => onChange({ default_model: value })}
              label="Select default model"
              align="start"
              className="config-model-picker"
              emptyMessage="Add providers first"
            />
            {modelOptions.length === 0 && (
              <span className="config-field-hint">
                No models listed. Add providers (and their models) in the Providers tab.
              </span>
            )}
          </div>

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
              onChange={(e) => handleNumberChange('llm_stream_retries', e.target.value)}
              className="input config-control"
              min={0}
              max={10}
            />
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
