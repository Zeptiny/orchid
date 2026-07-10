import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelMetadata } from '../../shared/types/ipc-boundary';
import { withCurrentModelOption } from '../utils/models';
import { Icon } from './Icon';

interface ModelPickerProps {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label?: string;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
}

/** Shared searchable model picker used by chat and configuration. */
export function ModelPicker({
  value,
  options,
  onChange,
  label = 'Select model',
  placement = 'bottom',
  align = 'end',
  className = '',
  disabled = false,
  emptyMessage = 'No models configured',
}: ModelPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [metadata, setMetadata] = useState<Record<string, ModelMetadata | null>>({});

  const modelOptions = useMemo(
    () => withCurrentModelOption(options, value),
    [options, value],
  );
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return modelOptions;
    return modelOptions.filter((model) => model.toLowerCase().includes(normalized));
  }, [modelOptions, query]);

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
    if (!open || !window.orchid?.config?.modelMetadata) return;
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
  }, [modelOptions, open]);

  const selectModel = (model: string) => {
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
        type="button"
        className="btn btn-ghost model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={value || label}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon name="cpu" size={13} className="shrink-0 opacity-70" />
        <span className="model-picker-trigger-label">{splitModelId(value).name}</span>
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
            <span className="model-picker-current">{value || 'None selected'}</span>
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
                  const modelParts = splitModelId(model);
                  const modelMetadata = metadata[model];
                  const selected = model === value;
                  return (
                    <tr
                      key={model}
                      role="option"
                      tabIndex={0}
                      aria-selected={selected}
                      className={selected ? 'model-picker-row is-selected' : 'model-picker-row'}
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
                          {modelParts.name}
                        </div>
                        {modelParts.provider && (
                          <div className="model-picker-provider">{modelParts.provider}</div>
                        )}
                      </td>
                      <td>{modelMetadata ? formatTokenLimit(modelMetadata.max_input_tokens) : '…'}</td>
                      <td>{modelMetadata ? formatTokenLimit(modelMetadata.max_output_tokens) : '…'}</td>
                      <td>
                        {modelMetadata ? (
                          <span className={modelMetadata.supports_vision ? 'text-success' : 'opacity-50'}>
                            {modelMetadata.supports_vision ? 'Yes' : 'No'}
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

function splitModelId(model: string): { provider: string | null; name: string } {
  if (!model) return { provider: null, name: 'Model' };
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1) {
    return { provider: model.slice(0, slash), name: model.slice(slash + 1) };
  }
  return { provider: null, name: model };
}

function formatTokenLimit(value: number | null): string {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString();
}
