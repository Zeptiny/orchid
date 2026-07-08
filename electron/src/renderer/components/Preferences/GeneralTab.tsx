/**
 * GeneralTab — general application settings.
 *
 * Controls: default_model, theme, personality, and numeric configs
 * (timeouts, limits, etc.).
 */
import { useCallback } from 'react';
import { THEMES, THEME_NAMES, type ThemeName } from '../../themes';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeneralTabProps {
  defaultModel: string;
  theme: string;
  personality: string;
  commandTimeout: number;
  readLineLimit: number;
  grepMaxResults: number;
  directoryTreeDepth: number;
  llmStreamIdleTimeout: number;
  llmStreamRetries: number;
  backgroundCommandIdleTimeout: number;
  onChange: (updates: Record<string, unknown>) => void;
}

// ── Known personalities ──────────────────────────────────────────────────────

const PERSONALITIES = [
  { id: 'default', label: 'Default' },
  { id: 'concise', label: 'Concise' },
  { id: 'verbose', label: 'Verbose' },
  { id: 'creative', label: 'Creative' },
  { id: 'technical', label: 'Technical' },
  { id: 'friendly', label: 'Friendly' },
];

// ── Component ────────────────────────────────────────────────────────────────

export function GeneralTab({
  defaultModel,
  theme,
  personality,
  commandTimeout,
  readLineLimit,
  grepMaxResults,
  directoryTreeDepth,
  llmStreamIdleTimeout,
  llmStreamRetries,
  backgroundCommandIdleTimeout,
  onChange,
}: GeneralTabProps) {
  const handleNumberChange = useCallback(
    (field: string, value: string) => {
      const num = parseFloat(value);
      if (!isNaN(num) && num > 0) {
        onChange({ [field]: num });
      }
    },
    [onChange],
  );

  return (
    <div className="pref-tab-content">
      <div className="pref-tab-header">
        <h3>General</h3>
        <p className="pref-tab-description">
          Application-wide settings including default model, theme, and performance tuning.
        </p>
      </div>

      <div className="pref-form-grid">
        {/* Default model */}
        <div className="pref-form-row">
          <label htmlFor="general-default-model">Default Model</label>
          <input
            id="general-default-model"
            type="text"
            value={defaultModel}
            onChange={(e) => onChange({ default_model: e.target.value })}
            className="pref-input"
            placeholder="default/mimo-v2.5"
          />
          <span className="pref-form-hint">
            The default model for new sessions. Format: provider/model.
          </span>
        </div>

        {/* Theme */}
        <div className="pref-form-row">
          <label htmlFor="general-theme">Theme</label>
          <select
            id="general-theme"
            value={theme}
            onChange={(e) => onChange({ theme: e.target.value })}
            className="pref-select"
          >
            {THEME_NAMES.map((name) => (
              <option key={name} value={name}>
                {THEMES[name as ThemeName]}
              </option>
            ))}
          </select>
        </div>

        {/* Personality */}
        <div className="pref-form-row">
          <label htmlFor="general-personality">Personality</label>
          <select
            id="general-personality"
            value={personality}
            onChange={(e) => onChange({ personality: e.target.value })}
            className="pref-select"
          >
            {PERSONALITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="pref-form-hint">
            Controls the agent's communication style.
          </span>
        </div>

        {/* Separator */}
        <div className="pref-form-separator">
          <span>Performance</span>
        </div>

        {/* Command timeout */}
        <div className="pref-form-row">
          <label htmlFor="general-command-timeout">Command Timeout (seconds)</label>
          <input
            id="general-command-timeout"
            type="number"
            value={commandTimeout}
            onChange={(e) => handleNumberChange('command_timeout', e.target.value)}
            className="pref-input pref-input-number"
            min={1}
            max={300}
          />
          <span className="pref-form-hint">
            How long to wait for tool commands before timing out.
          </span>
        </div>

        {/* Read line limit */}
        <div className="pref-form-row">
          <label htmlFor="general-read-line-limit">Read Line Limit</label>
          <input
            id="general-read-line-limit"
            type="number"
            value={readLineLimit}
            onChange={(e) => handleNumberChange('read_line_limit', e.target.value)}
            className="pref-input pref-input-number"
            min={1}
            max={10000}
          />
          <span className="pref-form-hint">
            Maximum lines returned by the read tool.
          </span>
        </div>

        {/* Grep max results */}
        <div className="pref-form-row">
          <label htmlFor="general-grep-max">Grep Max Results</label>
          <input
            id="general-grep-max"
            type="number"
            value={grepMaxResults}
            onChange={(e) => handleNumberChange('grep_max_results', e.target.value)}
            className="pref-input pref-input-number"
            min={1}
            max={1000}
          />
          <span className="pref-form-hint">
            Maximum results returned by grep/search tools.
          </span>
        </div>

        {/* Directory tree depth */}
        <div className="pref-form-row">
          <label htmlFor="general-tree-depth">Directory Tree Depth</label>
          <input
            id="general-tree-depth"
            type="number"
            value={directoryTreeDepth}
            onChange={(e) => handleNumberChange('directory_tree_depth', e.target.value)}
            className="pref-input pref-input-number"
            min={1}
            max={10}
          />
          <span className="pref-form-hint">
            Depth for the directory tree tool.
          </span>
        </div>

        {/* Separator */}
        <div className="pref-form-separator">
          <span>Streaming</span>
        </div>

        {/* LLM stream idle timeout */}
        <div className="pref-form-row">
          <label htmlFor="general-stream-idle">Stream Idle Timeout (seconds)</label>
          <input
            id="general-stream-idle"
            type="number"
            value={llmStreamIdleTimeout}
            onChange={(e) => handleNumberChange('llm_stream_idle_timeout', e.target.value)}
            className="pref-input pref-input-number"
            min={10}
            max={600}
          />
          <span className="pref-form-hint">
            Cancel stream if no tokens received for this duration.
          </span>
        </div>

        {/* LLM stream retries */}
        <div className="pref-form-row">
          <label htmlFor="general-stream-retries">Stream Retries</label>
          <input
            id="general-stream-retries"
            type="number"
            value={llmStreamRetries}
            onChange={(e) => handleNumberChange('llm_stream_retries', e.target.value)}
            className="pref-input pref-input-number"
            min={0}
            max={10}
          />
          <span className="pref-form-hint">
            Number of retries on stream errors.
          </span>
        </div>

        {/* Background command idle timeout */}
        <div className="pref-form-row">
          <label htmlFor="general-bg-idle">Background Command Idle Timeout (seconds)</label>
          <input
            id="general-bg-idle"
            type="number"
            value={backgroundCommandIdleTimeout}
            onChange={(e) => handleNumberChange('background_command_idle_timeout', e.target.value)}
            className="pref-input pref-input-number"
            min={30}
            max={3600}
          />
          <span className="pref-form-hint">
            Kill background commands idle for this duration.
          </span>
        </div>
      </div>
    </div>
  );
}
