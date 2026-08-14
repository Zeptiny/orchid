import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReasoningModelConfig } from '../../../shared/types/provider';
import { parseReasoningNumeric } from '../../utils/reasoning';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';

export interface ReasoningModelEntry {
  readonly modelId: string;
  readonly displayName: string;
  /** False when the driver accepts only text effort levels (see ReasoningFieldsProps). */
  readonly numericBudgetSupported?: boolean;
}

const EMPTY_REASONING_CONFIG: ReasoningModelConfig = { levels: [], default: null };

export interface ReasoningFieldsProps {
  readonly modelId: string;
  readonly displayName: string;
  readonly levels: readonly string[];
  readonly default: string | number | null;
  readonly disabled?: boolean;
  /**
   * False when the provider driver accepts only text effort levels (for
   * example OpenAI); numeric token budgets are then silently dropped at
   * request time. Undefined means the driver is not known to reject them.
   */
  readonly numericBudgetSupported?: boolean;
  readonly onChange: (levels: readonly string[], def: string | number | null) => void;
}

/**
 * The per-model reasoning effort fields: an editable level list and a default
 * effort selector. Levels and default are controlled; the transient add-level
 * text and numeric budget text live here.
 */
export function ReasoningFields({
  modelId,
  displayName,
  levels,
  default: defaultValue,
  disabled = false,
  numericBudgetSupported,
  onChange,
}: ReasoningFieldsProps) {
  const [newLevel, setNewLevel] = useState('');
  const [numericDefault, setNumericDefault] = useState(() =>
    typeof defaultValue === 'number' ? String(defaultValue) : '',
  );
  const [numericError, setNumericError] = useState<string | null>(null);
  // Numeric mode is tracked independently of the committed default so choosing
  // "Numeric (token budget)" stays selected while the budget is still empty.
  const [numericMode, setNumericMode] = useState(() => typeof defaultValue === 'number');
  const lastCommitted = useRef(defaultValue);

  useEffect(() => {
    setNumericDefault(typeof defaultValue === 'number' ? String(defaultValue) : '');
    // Resync the mode only for external defaultValue changes; self-commits keep
    // lastCommitted in step so the user's explicit mode selection is preserved.
    if (defaultValue !== lastCommitted.current) {
      setNumericMode(typeof defaultValue === 'number');
      lastCommitted.current = defaultValue;
    }
  }, [defaultValue]);

  const selectValue = numericMode
    ? '__numeric__'
    : typeof defaultValue === 'string'
      ? defaultValue
      : '__none__';

  const addLevel = () => {
    const value = newLevel.trim();
    if (!value || levels.includes(value)) {
      setNewLevel('');
      return;
    }
    onChange([...levels, value], defaultValue);
    setNewLevel('');
  };

  const removeLevel = (level: string) => {
    onChange(
      levels.filter((candidate) => candidate !== level),
      defaultValue === level ? null : defaultValue,
    );
  };

  const selectDefault = (value: string) => {
    if (value === '__numeric__') {
      setNumericMode(true);
      const parsed = parseReasoningNumeric(numericDefault);
      lastCommitted.current = parsed;
      onChange(levels, parsed);
      return;
    }
    if (value === '__none__') {
      setNumericMode(false);
      setNumericError(null);
      lastCommitted.current = null;
      onChange(levels, null);
      return;
    }
    setNumericMode(false);
    lastCommitted.current = value;
    onChange(levels, value);
  };

  const editNumericDefault = (value: string) => {
    const parsed = parseReasoningNumeric(value);
    setNumericError(value.trim() !== '' && parsed === null
      ? 'Enter a positive whole number between 1 and 1,000,000.'
      : null);
    setNumericDefault(value);
    lastCommitted.current = parsed;
    onChange(levels, parsed);
  };

  return (
    <>
      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-base-content/70">Levels</label>
        <div className="flex flex-wrap items-center gap-2">
          {levels.map((level) => (
            <span
              key={level}
              className="inline-flex items-center gap-1 rounded-md border border-base-300 bg-base-100 px-2 py-1 text-sm"
            >
              {level}
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-sm text-base-content/50 transition-colors hover:text-error"
                onClick={() => removeLevel(level)}
                disabled={disabled}
                aria-label={`Remove level ${level}`}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1">
            <TextInput
              size="xs"
              className="w-28"
              value={newLevel}
              onChange={(event) => setNewLevel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addLevel();
                }
              }}
              placeholder="Add level"
              disabled={disabled}
              aria-label={`New level for ${displayName}`}
            />
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              onClick={addLevel}
              disabled={disabled || !newLevel.trim()}
              aria-label={`Add level to ${displayName}`}
            >
              <Icon name="plus" size={12} />
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-base-content/70" htmlFor={`reasoning-default-${modelId}`}>
          Default effort
        </label>
        <div className="flex items-center gap-2">
          <Select
            id={`reasoning-default-${modelId}`}
            size="sm"
            className="w-40"
            value={selectValue}
            onChange={(event) => selectDefault(event.target.value)}
            disabled={disabled}
          >
            <option value="__none__">None</option>
            {levels.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
            <option
              value="__numeric__"
              disabled={numericBudgetSupported === false}
            >
              Numeric (token budget)
            </option>
          </Select>
          {numericMode && (
            <TextInput
              size="sm"
              className="w-28"
              inputMode="numeric"
              value={numericDefault}
              onChange={(event) => editNumericDefault(event.target.value)}
              placeholder="8192"
              disabled={disabled}
              aria-label={`Numeric default for ${displayName}`}
            />
          )}
        </div>
        {numericBudgetSupported === false && (
          <p className="mt-1 text-xs text-warning" role="note">
            This provider driver sends text effort levels only; numeric token budgets are not applied.
          </p>
        )}
        {numericBudgetSupported === false && numericMode && (
          <p className="mt-1 text-xs text-warning" role="alert">
            A numeric budget is configured but will not be sent for this model. Choose a text level instead.
          </p>
        )}
        {numericError && numericMode && (
          <p className="mt-1 text-xs text-error" role="alert">{numericError}</p>
        )}
      </div>
    </>
  );
}

export interface ReasoningConfigEditorProps {
  readonly models: readonly ReasoningModelEntry[];
  readonly reasoningConfig: Record<string, ReasoningModelConfig>;
  readonly disabled?: boolean;
  readonly onChange: (config: Record<string, ReasoningModelConfig>) => void;
}

function buildDrafts(
  models: readonly ReasoningModelEntry[],
  reasoningConfig: Record<string, ReasoningModelConfig>,
): Record<string, ReasoningModelConfig> {
  const drafts: Record<string, ReasoningModelConfig> = {};
  for (const model of models) {
    drafts[model.modelId] = reasoningConfig[model.modelId] ?? EMPTY_REASONING_CONFIG;
  }
  return drafts;
}

export function ReasoningConfigEditor({
  models,
  reasoningConfig,
  disabled = false,
  onChange,
}: ReasoningConfigEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, ReasoningModelConfig>>(() =>
    buildDrafts(models, reasoningConfig),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(buildDrafts(models, reasoningConfig));
    setError(null);
  }, [models, reasoningConfig]);

  const updateDraft = useCallback((modelId: string, config: ReasoningModelConfig) => {
    setDrafts((prev) => ({ ...prev, [modelId]: config }));
  }, []);

  const save = useCallback(() => {
    const result: Record<string, ReasoningModelConfig> = {};
    for (const model of models) {
      const draft = drafts[model.modelId] ?? EMPTY_REASONING_CONFIG;
      if (draft.levels.length === 0) {
        setError(`"${model.displayName}" must have at least one reasoning level.`);
        return;
      }
      if (typeof draft.default === 'number' && !Number.isFinite(draft.default)) {
        setError(`"${model.displayName}" has an invalid numeric default.`);
        return;
      }
      if (typeof draft.default === 'number' && model.numericBudgetSupported === false) {
        setError(`"${model.displayName}" does not support numeric token budgets — choose a text level instead.`);
        return;
      }
      result[model.modelId] = { levels: draft.levels, default: draft.default };
    }
    setError(null);
    onChange(result);
  }, [drafts, models, onChange]);

  if (models.length === 0) return null;

  return (
    <Panel as="section" className="config-fieldset flex flex-col gap-3">
      <SectionHeader title="Reasoning effort" />
      <p className="text-sm text-base-content/70">
        Configure available reasoning levels and a default effort for each reasoning-capable model.
      </p>

      {models.map((model) => {
        const draft = drafts[model.modelId] ?? EMPTY_REASONING_CONFIG;
        return (
          <div
            key={model.modelId}
            className="rounded-box border border-base-300 bg-base-200/40 p-4"
            data-testid={`reasoning-config-${model.modelId}`}
          >
            <h3 className="text-sm font-semibold">{model.displayName}</h3>
            <p className="mt-0.5 break-all font-mono text-xs text-base-content/60">{model.modelId}</p>
            <ReasoningFields
              modelId={model.modelId}
              displayName={model.displayName}
              levels={draft.levels}
              default={draft.default}
              disabled={disabled}
              numericBudgetSupported={model.numericBudgetSupported}
              onChange={(levels, def) => updateDraft(model.modelId, { levels: [...levels], default: def })}
            />
          </div>
        );
      })}

      {error && (
        <Alert tone="error" icon="alertCircle" aria-live="assertive">{error}</Alert>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={disabled}>
          Save reasoning config
        </Button>
      </div>
    </Panel>
  );
}
