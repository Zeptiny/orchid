import { useEffect, useMemo, useState } from 'react';
import type { ModelMetadata } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import { withCurrentModelOption } from '../utils/models';
import { providerModelOptionContextLabel } from '../utils/provider-selection';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import {
  useClampActiveIndex,
  usePopoverListbox,
  type PopoverAlign,
  type PopoverPlacement,
} from './ui/usePopoverListbox';

interface ModelPickerProps {
  id?: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label?: string;
  placement?: PopoverPlacement;
  align?: PopoverAlign;
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  /** Whether the selected trigger should show provider/connection context. */
  showSelectedContext?: boolean;
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
  showSelectedContext = true,
  optionLabels,
  optionDetails,
  additionalOptions = [],
}: ModelPickerProps) {
  const {
    pickerRef,
    triggerRef,
    searchRef,
    menuId,
    open,
    query,
    activeIndex,
    setActiveIndex,
    toggleOpen,
    closeAndRestoreFocus,
    setQuery,
    onSearchChange,
    onSearchKeyDown,
    dropdownClassName,
  } = usePopoverListbox();

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
      const detail = optionDetails?.[model];
      const providerContext = detail ? providerModelOptionContextLabel(detail) : '';
      return `${optionLabels?.[model] ?? option?.label ?? model} ${model} ${option?.description ?? ''} ${providerContext}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [additionalOptionsByValue, modelOptions, optionDetails, optionLabels, query]);

  useClampActiveIndex(activeIndex, filteredModels.length, setActiveIndex);

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
    closeAndRestoreFocus();
  };

  const selectedAdditionalOption = additionalOptionsByValue.get(value);
  const selectedDetail = optionDetails?.[value];
  const selectedDisplayName = optionLabels?.[value]
    ?? selectedAdditionalOption?.label
    ?? selectedDetail?.model.displayName
    ?? (value ? displayModelId(value) : '');
  const selectedSubLabel = selectedDetail ? providerModelOptionContextLabel(selectedDetail) : null;
  const selectedTriggerSubLabel = showSelectedContext ? selectedSubLabel : null;

  return (
    <div
      ref={pickerRef}
      className={dropdownClassName(
        align,
        placement,
        `${className} model-picker-align-${align} orchid-model-picker`,
      )}
    >
      <Button
        ref={triggerRef}
        id={id}
        variant="ghost"
        className={`orchid-model-picker-trigger orchid-model-picker-trigger${selectedTriggerSubLabel ? ' model-picker-trigger-with-sub-label' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={selectedTriggerSubLabel ? `${selectedDisplayName} · ${selectedTriggerSubLabel}` : selectedDisplayName || label}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <Icon name="cpu" size={13} className="shrink-0 opacity-70" />
        <span className="orchid-model-picker-trigger-copy min-w-0 flex-1 flex flex-col items-start overflow-hidden">
          <span className="model-picker-trigger-label truncate">{selectedDisplayName || displayModelId(value)}</span>
          {selectedTriggerSubLabel && (
            <span className="model-picker-trigger-sub-label truncate text-xs font-normal text-base-content/60">
              {selectedTriggerSubLabel}
            </span>
          )}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </Button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label={label}
          className="dropdown-content orchid-model-picker-menu z-50"
        >
          <div className="orchid-model-picker-heading flex items-start justify-between gap-3.5 border-b border-base-content/10 px-3.5 py-3">
            <div>
              <div className="model-picker-title text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Models
              </div>
            </div>
            <span className="model-picker-current flex min-w-0 flex-col items-end gap-0.5">
              <span className="model-picker-current-name truncate text-xs font-medium">
                {selectedDisplayName || 'None selected'}
              </span>
              {selectedSubLabel && (
                <span className="model-picker-current-sub-label truncate text-xs text-base-content/60">
                  {selectedSubLabel}
                </span>
              )}
            </span>
          </div>

          <label className="input input-sm orchid-model-picker-search mx-2 my-2">
            <Icon name="search" size={14} className="shrink-0 opacity-50" />
            {/* NOTE (known deferred case): raw <input> instead of <TextInput> because the
                parent <label> already uses the "input" compound class; adding
                TextInput would double-up the "input" class. */}
            <input
              ref={searchRef}
              className="orchid-model-picker-search-input grow"
              type="search"
              value={query}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) =>
                onSearchKeyDown(event, filteredModels.length, (index) => {
                  const model = filteredModels[index];
                  if (model) selectModel(model);
                })
              }
              placeholder="Search models..."
              aria-label="Search models"
              aria-controls={menuId}
              aria-activedescendant={
                filteredModels[activeIndex]
                  ? `${menuId}-option-${filteredModels[activeIndex]}`
                  : undefined
              }
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
                {filteredModels.map((model, index) => {
                  const modelMetadata = metadata[model];
                  const detail = optionDetails?.[model];
                  const additionalOption = additionalOptionsByValue.get(model);
                  const displayName = optionLabels?.[model]
                    ?? additionalOption?.label
                    ?? detail?.model.displayName
                    ?? displayModelId(model);
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
                        : providerModelOptionContextLabel(detail)
                      : null);
                  const active = index === activeIndex;
                  return (
                    <tr
                      key={model}
                      id={`${menuId}-option-${model}`}
                      role="option"
                      tabIndex={0}
                      aria-selected={selected}
                      className={`${selected ? 'model-picker-row is-selected' : 'model-picker-row'}${active ? ' is-active' : ''}${unavailable ? ' opacity-60' : ''}`}
                      aria-disabled={unavailable || undefined}
                      onClick={() => selectModel(model)}
                      onMouseEnter={() => setActiveIndex(index)}
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
