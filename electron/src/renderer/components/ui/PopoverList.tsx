import { useMemo, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';
import {
  useClampActiveIndex,
  usePopoverListbox,
  type PopoverAlign,
  type PopoverPlacement,
} from './usePopoverListbox';

export interface PopoverListOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface PopoverListProps<T extends string = string> {
  readonly id?: string;
  readonly value: T;
  readonly options: readonly PopoverListOption<T>[];
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly title?: string;
  readonly searchPlaceholder?: string;
  readonly emptyMessage?: string;
  readonly noMatchMessage?: (query: string) => string;
  readonly className?: string;
  readonly menuClassName?: string;
  readonly disabled?: boolean;
  readonly triggerIcon?: IconName;
  readonly placement?: PopoverPlacement;
  readonly align?: PopoverAlign;
  /** When false, omit the current-selection chip in the menu heading. */
  readonly showCurrentInMenu?: boolean;
  readonly renderTriggerLabel?: (selected: PopoverListOption<T> | undefined, value: T) => ReactNode;
  readonly filterOption?: (option: PopoverListOption<T>, query: string) => boolean;
}

function defaultFilter<T extends string>(option: PopoverListOption<T>, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${option.label} ${option.value} ${option.description ?? ''}`
    .toLowerCase()
    .includes(normalized);
}

/**
 * Shared searchable listbox popover for compact option pickers.
 * Does not own command-palette multi-category behavior.
 */
export function PopoverList<T extends string = string>({
  id,
  value,
  options,
  onChange,
  label,
  title,
  searchPlaceholder = 'Search...',
  emptyMessage = 'No options',
  noMatchMessage = (query) => `No options match “${query}”.`,
  className = '',
  menuClassName = 'searchable-picker-menu',
  disabled = false,
  triggerIcon = 'globe',
  placement = 'bottom',
  align = 'start',
  showCurrentInMenu = true,
  renderTriggerLabel,
  filterOption = defaultFilter,
}: PopoverListProps<T>) {
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

  const selectedOption = options.find((option) => option.value === value);

  const filteredOptions = useMemo(() => {
    const matches = options.filter((option) => filterOption(option, query));
    if (selectedOption && !matches.some((option) => option.value === selectedOption.value)) {
      return [selectedOption, ...matches];
    }
    return matches;
  }, [filterOption, options, query, selectedOption]);

  useClampActiveIndex(activeIndex, filteredOptions.length, setActiveIndex);

  const selectOption = (option: PopoverListOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setQuery('');
    closeAndRestoreFocus();
  };

  const triggerLabel =
    renderTriggerLabel?.(selectedOption, value) ??
    ((selectedOption?.label ?? value) || label);

  return (
    <div
      ref={pickerRef}
      className={dropdownClassName(align, placement, `w-full ${className}`)}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="btn btn-ghost orchid-model-picker-trigger w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={(selectedOption?.label ?? value) || label}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <Icon name={triggerIcon} size={13} className="shrink-0 opacity-70" />
        <span className="model-picker-trigger-label">{triggerLabel}</span>
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
          className={`dropdown-content z-50 ${menuClassName}`.trim()}
        >
          {(title || showCurrentInMenu) && (
            <div className="orchid-model-picker-heading">
              {title && <div className="model-picker-title">{title}</div>}
              {showCurrentInMenu && (
                <span className="model-picker-current">
                  {(selectedOption?.label ?? value) || 'None selected'}
                </span>
              )}
            </div>
          )}

          <label className="input input-sm orchid-model-picker-search">
            <Icon name="search" size={14} className="shrink-0 opacity-50" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) =>
                onSearchKeyDown(event, filteredOptions.length, (index) => {
                  const option = filteredOptions[index];
                  if (option) selectOption(option);
                })
              }
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={menuId}
              aria-activedescendant={
                filteredOptions[activeIndex]
                  ? `${menuId}-option-${filteredOptions[activeIndex].value}`
                  : undefined
              }
            />
          </label>

          <ul className="searchable-picker-list" role="presentation">
            {filteredOptions.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <li key={option.value}>
                  <button
                    id={`${menuId}-option-${option.value}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    className={`searchable-picker-option ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}`
                      .trim()
                      .replace(/\s+/g, ' ')}
                    disabled={option.disabled}
                    onClick={() => selectOption(option)}
                    onMouseEnter={() => setActiveIndex(index)}
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
            <div className="model-picker-empty">{noMatchMessage(query)}</div>
          )}
        </div>
      )}
    </div>
  );
}
