import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface SearchableOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SearchableOptionPickerProps {
  readonly id?: string;
  readonly value: string;
  readonly options: readonly SearchableOption[];
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly title: string;
  readonly searchPlaceholder: string;
  readonly emptyMessage: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

/** Compact searchable list picker used for provider presets in setup flows. */
export function SearchableOptionPicker({
  id,
  value,
  options,
  onChange,
  label,
  title,
  searchPlaceholder,
  emptyMessage,
  className = '',
  disabled = false,
}: SearchableOptionPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized
      ? options.filter((option) =>
        `${option.label} ${option.value} ${option.description ?? ''}`
          .toLowerCase()
          .includes(normalized),
      )
      : [...options];
    if (selectedOption && !matches.some((option) => option.value === selectedOption.value)) {
      return [selectedOption, ...matches];
    }
    return matches;
  }, [options, query, selectedOption]);

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

  const selectOption = (option: SearchableOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setQuery('');
    setOpen(false);
  };

  return (
    <div
      ref={pickerRef}
      className={`dropdown dropdown-start w-full ${open ? 'dropdown-open' : ''} ${className}`.trim()}
    >
      <button
        id={id}
        type="button"
        className="btn btn-ghost model-picker-trigger w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={(selectedOption?.label ?? value) || label}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon name="globe" size={13} className="shrink-0 opacity-70" />
        <span className="model-picker-trigger-label">
          {(selectedOption?.label ?? value) || label}
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
          className="dropdown-content searchable-picker-menu z-50"
        >
          <div className="model-picker-heading">
            <div className="model-picker-title">{title}</div>
            <span className="model-picker-current">
              {(selectedOption?.label ?? value) || 'None selected'}
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
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </label>

          <ul className="searchable-picker-list" role="presentation">
            {filteredOptions.map((option) => {
              const selected = option.value === value;
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    className={`searchable-picker-option ${selected ? 'is-selected' : ''}`}
                    disabled={option.disabled}
                    onClick={() => selectOption(option)}
                  >
                    <span className="searchable-picker-option-copy">
                      <span className="searchable-picker-option-name">{option.label}</span>
                      {option.description && (
                        <span className="searchable-picker-option-desc">{option.description}</span>
                      )}
                    </span>
                    {selected && <Icon name="check" size={14} className="shrink-0 opacity-70" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {options.length === 0 && <div className="model-picker-empty">{emptyMessage}</div>}
          {options.length > 0 && filteredOptions.length === 0 && (
            <div className="model-picker-empty">No options match “{query}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
