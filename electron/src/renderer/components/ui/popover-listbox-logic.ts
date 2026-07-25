import type { PopoverAlign, PopoverPlacement } from './usePopoverListbox';

export type PopoverListboxKey =
  | 'Escape'
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Enter'
  | string;

export type PopoverListboxKeyResult =
  | { kind: 'close' }
  | { kind: 'move'; activeIndex: number }
  | { kind: 'select'; index: number }
  | { kind: 'none' };

/**
 * Pure keyboard navigation for searchable listbox popovers.
 * Mirrors usePopoverListbox.onSearchKeyDown without React state.
 */
export function applyPopoverListboxKey(
  key: PopoverListboxKey,
  activeIndex: number,
  itemCount: number,
  canSelect: boolean,
): PopoverListboxKeyResult {
  if (key === 'Escape') {
    return { kind: 'close' };
  }
  if (key === 'ArrowDown') {
    return {
      kind: 'move',
      activeIndex: Math.min(activeIndex + 1, Math.max(0, itemCount - 1)),
    };
  }
  if (key === 'ArrowUp') {
    return {
      kind: 'move',
      activeIndex: Math.max(activeIndex - 1, 0),
    };
  }
  if (key === 'Enter' && canSelect) {
    if (itemCount > 0) return { kind: 'select', index: activeIndex };
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Clamp active index when the filtered list shrinks. */
export function clampPopoverActiveIndex(activeIndex: number, itemCount: number): number {
  if (activeIndex >= itemCount) {
    return Math.max(0, itemCount - 1);
  }
  return activeIndex;
}

export interface PopoverFilterOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/** Default substring filter for PopoverList options. */
export function defaultPopoverFilter(
  option: PopoverFilterOption,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${option.label} ${option.value} ${option.description ?? ''}`
    .toLowerCase()
    .includes(normalized);
}

/**
 * Filter options and keep the current selection visible even when it no longer
 * matches the query (matches PopoverList filteredOptions useMemo).
 */
export function filterPopoverOptions<T extends PopoverFilterOption>(
  options: readonly T[],
  query: string,
  selectedValue: string,
  filterOption: (option: T, query: string) => boolean = defaultPopoverFilter as (
    option: T,
    query: string,
  ) => boolean,
): T[] {
  const matches = options.filter((option) => filterOption(option, query));
  const selectedOption = options.find((option) => option.value === selectedValue);
  if (selectedOption && !matches.some((option) => option.value === selectedOption.value)) {
    return [selectedOption, ...matches];
  }
  return matches;
}

/** Whether Enter / click should apply an option. */
export function canSelectPopoverOption(option: { disabled?: boolean } | undefined): boolean {
  return Boolean(option) && !option?.disabled;
}

/** Empty / no-match copy for the list body. */
export function popoverEmptyMessage(input: {
  optionsLength: number;
  filteredLength: number;
  query: string;
  emptyMessage: string;
  noMatchMessage: (query: string) => string;
}): string | null {
  if (input.optionsLength === 0) return input.emptyMessage;
  if (input.filteredLength === 0) return input.noMatchMessage(input.query);
  return null;
}

export function buildDropdownClassName(
  open: boolean,
  align: PopoverAlign,
  placement: PopoverPlacement,
  className = '',
): string {
  return `dropdown ${align === 'start' ? 'dropdown-start' : 'dropdown-end'} ${
    placement === 'top' ? 'dropdown-top' : ''
  } ${open ? 'dropdown-open' : ''} ${className}`
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Outside-click / Escape close should restore focus to the trigger on the next
 * frame. Pure predicate for whether a pointer target is outside the picker root.
 */
export function isOutsidePopoverRoot(
  root: { contains: (node: Node | null) => boolean } | null,
  target: Node | null,
): boolean {
  if (!root) return true;
  return !root.contains(target);
}
