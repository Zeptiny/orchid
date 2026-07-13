import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelMetadata } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import { withCurrentModelOption } from '../utils/models';
import { Icon } from './Icon';

interface ModelPickerProps {
  id?: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label?: string;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  /** Optional renderer-owned labels for opaque selection keys. */
  optionLabels?: Readonly<Record<string, string>>;
  /** Optional typed metadata for connection-scoped options. */
  optionDetails?: Readonly<Record<string, ProviderModelOption>>;
  /** Optional non-catalog actions, such as the custom-model entry in setup. */
  additionalOptions?: readonly ModelPickerAdditionalOption[];
}

export interface ModelPickerAdditionalOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/** Shared searchable model picker used by chat and configuration. */
export function ModelPicker({
  id,
  value,
  options,
  onChange,
  label = 'Select model',
  placement = 'bottom',
  align = 'end',
  className = '',
  disabled = false,
  emptyMessage = 'No models configured',
  optionLabels,
  optionDetails,
  additionalOptions = [],
}: ModelPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [metadata, setMetadata] = useState<Record<string, ModelMetadata | null>>({});
  const additionalOptionsByValue = useMemo(
    () => new Map(additionalOptions.map((option) => [option.value, option])),
    [additionalOptions],
  );

  const modelOptions = useMemo(
    () => withCurrentModelOption(
      [...options, ...additionalOptions.map((option) => option.value)],
      value,
    ),
    [additionalOptions, options, value],
  );
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return modelOptions;
    return modelOptions.filter((model) => {
      const option = additionalOptionsByValue.get(model);
      return `${optionLabels?.[model] ?? option?.label ?? model} ${model} ${option?.description ?? ''}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [additionalOptionsByValue, modelOptions, optionLabels, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    // Connection-scoped provider options carry their own catalog metadata.
    // Legacy/local string options retain the old compatibility lookup.
    if (!open || optionLabels || optionDetails || !window.orchid?.config?.modelMetadata) return;
    let cancelled = false;
    // Always refresh when opened so overrides saved in Preferences appear
    // without requiring an app restart (main-process cache is cleared on save).
    Promise.all(
      modelOptions.map(async (model) => {
        try {
          return [model, await window.orchid.config.modelMetadata(model)] as const;
        } catch {
          return [model, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setMetadata(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [modelOptions, open, optionLabels, optionDetails]);

  const selectModel = (model: string) => {
    if (additionalOptionsByValue.get(model)?.disabled) return;
    onChange(model);
    setQuery('');
    setOpen(false);
  };

  return (
    <div
      ref={pickerRef}
      className={`dropdown ${align === 'start' ? 'dropdown-start' : 'dropdown-end'} ${placement === 'top' ? 'dropdown-top' : ''} ${open ? 'dropdown-open' : ''} ${className} model-picker-align-${align}`.trim()}
    >
      <button
        id={id}
        type="button"
        className="btn btn-ghost model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={(optionLabels?.[value] ?? additionalOptionsByValue.get(value)?.label ?? value) || label}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon name="cpu" size={13} className="shrink-0 opacity-70" />
        <span className="model-picker-trigger-label">
          {optionLabels?.[value] ?? additionalOptionsByValue.get(value)?.label ?? displayModelId(value)}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label={label}
          className="dropdown-content model-picker-menu z-50"
        >
          <div className="model-picker-heading">
            <div>
              <div className="model-picker-title">Models</div>
            </div>
            <span className="model-picker-current">
              {(optionLabels?.[value] ?? additionalOptionsByValue.get(value)?.label ?? value) || 'None selected'}
            </span>
          </div>

          <label className="input input-sm model-picker-search">
            <Icon name="search" size={14} className="shrink-0 opacity-50" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder="Search models..."
              aria-label="Search models"
            />
          </label>

          <div className="model-picker-table-wrap">
            <table className="table table-sm model-picker-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Vision</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map((model) => {
                  const modelMetadata = metadata[model];
                  const detail = optionDetails?.[model];
                  const additionalOption = additionalOptionsByValue.get(model);
                  const displayName = optionLabels?.[model] ?? additionalOption?.label ?? displayModelId(model);
                  const contextLimit = detail
                    ? detail.model.limits?.contextTokens ?? null
                    : modelMetadata?.max_input_tokens ?? null;
                  const outputLimit = detail
                    ? detail.model.limits?.outputTokens ?? null
                    : modelMetadata?.max_output_tokens ?? null;
                  const supportsVision = detail
                    ? detail.model.capabilities?.inputModalities.includes('image') ?? null
                    : modelMetadata?.supports_vision ?? null;
                  const selected = model === value;
                  const unavailable = detail?.available === false || additionalOption?.disabled === true;
                  const description = additionalOption?.description
                    ?? (detail
                      ? unavailable
                        ? detail.unavailableReason ?? 'Unavailable'
                        : detail.providerDisplayName ?? detail.providerId
                      : null);
                  return (
                    <tr
                      key={model}
                      role="option"
                      tabIndex={0}
                      aria-selected={selected}
                      className={`${selected ? 'model-picker-row is-selected' : 'model-picker-row'}${unavailable ? ' opacity-60' : ''}`}
                      aria-disabled={unavailable || undefined}
                      onClick={() => selectModel(model)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectModel(model);
                        }
                      }}
                    >
                      <td>
                        <div className="model-picker-model-name" title={model}>
                          {displayName}
                        </div>
                        {description && (
                          <div className="text-xs text-base-content/60">
                            {description}
                          </div>
                        )}
                      </td>
                      <td>{contextLimit === null ? (detail ? '—' : '…') : formatTokenLimit(contextLimit)}</td>
                      <td>{outputLimit === null ? (detail ? '—' : '…') : formatTokenLimit(outputLimit)}</td>
                      <td>
                        {supportsVision !== null ? (
                          <span className={supportsVision ? 'text-success' : 'opacity-50'}>
                            {supportsVision ? 'Yes' : 'No'}
                          </span>
                        ) : (
                          '…'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {modelOptions.length === 0 && <div className="model-picker-empty">{emptyMessage}</div>}
            {modelOptions.length > 0 && filteredModels.length === 0 && (
              <div className="model-picker-empty">No models match “{query}”.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Model IDs are opaque provider-owned strings and may themselves contain '/'. */
function displayModelId(model: string): string {
  return model || 'Model';
}

function formatTokenLimit(value: number | null): string {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString();
}
