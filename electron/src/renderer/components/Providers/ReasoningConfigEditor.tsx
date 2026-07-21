import { useCallback, useState } from 'react';
import type { ReasoningModelConfig } from '../../../shared/types/provider';
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
}

export interface ReasoningConfigEditorProps {
  readonly models: readonly ReasoningModelEntry[];
  readonly reasoningConfig: Record<string, ReasoningModelConfig>;
  readonly disabled?: boolean;
  readonly onChange: (config: Record<string, ReasoningModelConfig>) => void;
}

interface ModelDraft {
  readonly levels: string[];
  readonly default: string | number | null;
  readonly newLevel: string;
  readonly numericDefault: string;
  readonly useNumericDefault: boolean;
}

function draftFromConfig(config: ReasoningModelConfig | undefined): ModelDraft {
  const levels = config?.levels ?? [];
  const def = config?.default ?? null;
  const isNumeric = typeof def === 'number';
  return {
    levels: [...levels],
    default: def,
    newLevel: '',
    numericDefault: isNumeric ? String(def) : '',
    useNumericDefault: isNumeric,
  };
}

export function ReasoningConfigEditor({
  models,
  reasoningConfig,
  disabled = false,
  onChange,
}: ReasoningConfigEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, ModelDraft>>(() => {
    const initial: Record<string, ModelDraft> = {};
    for (const model of models) {
      initial[model.modelId] = draftFromConfig(reasoningConfig[model.modelId]);
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);

  const updateDraft = useCallback((modelId: string, updater: (draft: ModelDraft) => ModelDraft) => {
    setDrafts((prev) => ({
      ...prev,
      [modelId]: updater(prev[modelId] ?? draftFromConfig(undefined)),
    }));
  }, []);

  const addLevel = useCallback((modelId: string) => {
    updateDraft(modelId, (draft) => {
      const value = draft.newLevel.trim();
      if (!value || draft.levels.includes(value)) return { ...draft, newLevel: '' };
      return { ...draft, levels: [...draft.levels, value], newLevel: '' };
    });
  }, [updateDraft]);

  const removeLevel = useCallback((modelId: string, level: string) => {
    updateDraft(modelId, (draft) => {
      const levels = draft.levels.filter((l) => l !== level);
      const defaultCleared = draft.default === level ? null : draft.default;
      return { ...draft, levels, default: defaultCleared, useNumericDefault: defaultCleared === null ? draft.useNumericDefault : false };
    });
  }, [updateDraft]);

  const setDefault = useCallback((modelId: string, value: string) => {
    updateDraft(modelId, (draft) => {
      if (value === '__numeric__') {
        const num = draft.numericDefault.trim() ? Number(draft.numericDefault) : null;
        return { ...draft, useNumericDefault: true, default: num };
      }
      if (value === '__none__') {
        return { ...draft, useNumericDefault: false, default: null, numericDefault: '' };
      }
      return { ...draft, useNumericDefault: false, default: value };
    });
  }, [updateDraft]);

  const setNumericDefault = useCallback((modelId: string, value: string) => {
    updateDraft(modelId, (draft) => {
      const num = value.trim() ? Number(value) : null;
      return { ...draft, numericDefault: value, default: num };
    });
  }, [updateDraft]);

  const save = useCallback(() => {
    const result: Record<string, ReasoningModelConfig> = {};
    for (const model of models) {
      const draft = drafts[model.modelId];
      if (!draft) continue;
      if (draft.levels.length === 0) {
        setError(`"${model.displayName}" must have at least one reasoning level.`);
        return;
      }
      result[model.modelId] = {
        levels: draft.levels,
        default: draft.default,
      };
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
        const draft = drafts[model.modelId] ?? draftFromConfig(undefined);
        const selectValue = draft.useNumericDefault
          ? '__numeric__'
          : draft.default != null && typeof draft.default === 'string'
            ? draft.default
            : '__none__';

        return (
          <div
            key={model.modelId}
            className="rounded-box border border-base-300 bg-base-200/40 p-4"
            data-testid={`reasoning-config-${model.modelId}`}
          >
            <h3 className="text-sm font-semibold">{model.displayName}</h3>
            <p className="mt-0.5 break-all font-mono text-xs text-base-content/60">{model.modelId}</p>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-base-content/70">Levels</label>
              <div className="flex flex-wrap items-center gap-2">
                {draft.levels.map((level) => (
                  <span
                    key={level}
                    className="inline-flex items-center gap-1 rounded-md border border-base-300 bg-base-100 px-2 py-1 text-sm"
                  >
                    {level}
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-sm text-base-content/50 transition-colors hover:text-error"
                      onClick={() => removeLevel(model.modelId, level)}
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
                    value={draft.newLevel}
                    onChange={(event) => updateDraft(model.modelId, (d) => ({ ...d, newLevel: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addLevel(model.modelId);
                      }
                    }}
                    placeholder="Add level"
                    disabled={disabled}
                    aria-label={`New level for ${model.displayName}`}
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="square"
                    onClick={() => addLevel(model.modelId)}
                    disabled={disabled || !draft.newLevel.trim()}
                    aria-label={`Add level to ${model.displayName}`}
                  >
                    <Icon name="plus" size={12} />
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-base-content/70" htmlFor={`reasoning-default-${model.modelId}`}>
                Default effort
              </label>
              <div className="flex items-center gap-2">
                <Select
                  id={`reasoning-default-${model.modelId}`}
                  size="sm"
                  className="w-40"
                  value={selectValue}
                  onChange={(event) => setDefault(model.modelId, event.target.value)}
                  disabled={disabled}
                >
                  <option value="__none__">None</option>
                  {draft.levels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                  <option value="__numeric__">Numeric (token budget)</option>
                </Select>
                {draft.useNumericDefault && (
                  <TextInput
                    size="sm"
                    className="w-28"
                    inputMode="numeric"
                    value={draft.numericDefault}
                    onChange={(event) => setNumericDefault(model.modelId, event.target.value)}
                    placeholder="8192"
                    disabled={disabled}
                    aria-label={`Numeric default for ${model.displayName}`}
                  />
                )}
              </div>
            </div>
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
