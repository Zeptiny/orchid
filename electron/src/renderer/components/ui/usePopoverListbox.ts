import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

export type PopoverPlacement = 'top' | 'bottom';
export type PopoverAlign = 'start' | 'end';

export interface UsePopoverListboxResult {
  readonly pickerRef: RefObject<HTMLDivElement | null>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly menuId: string;
  readonly open: boolean;
  readonly query: string;
  readonly activeIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly toggleOpen: () => void;
  readonly closeAndRestoreFocus: () => void;
  readonly setQuery: (query: string) => void;
  readonly onSearchChange: (query: string) => void;
  /**
   * Keyboard handler for the search field. Pass the current filtered length and
   * an Enter handler so presentation layers (list/table) stay outside this hook.
   */
  readonly onSearchKeyDown: (
    event: KeyboardEvent<HTMLInputElement>,
    itemCount: number,
    onSelectActive?: (index: number) => void,
  ) => void;
  readonly dropdownClassName: (
    align: PopoverAlign,
    placement: PopoverPlacement,
    className?: string,
  ) => string;
}

/**
 * Shared open/focus/query/active-index geometry for searchable listbox popovers.
 * Presentation (list vs table) stays with the caller.
 */
export function usePopoverListbox(): UsePopoverListboxResult {
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const onSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    itemCount: number,
    onSelectActive?: (index: number) => void,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, Math.max(0, itemCount - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === 'Enter' && onSelectActive) {
      event.preventDefault();
      if (itemCount > 0) onSelectActive(activeIndex);
    }
  };

  const onSearchChange = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
  };

  const toggleOpen = () => setOpen((previous) => !previous);

  const dropdownClassName = (
    align: PopoverAlign,
    placement: PopoverPlacement,
    className = '',
  ) =>
    `dropdown ${align === 'start' ? 'dropdown-start' : 'dropdown-end'} ${
      placement === 'top' ? 'dropdown-top' : ''
    } ${open ? 'dropdown-open' : ''} ${className}`
      .trim()
      .replace(/\s+/g, ' ');

  return {
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
  };
}

/** Clamp active index when the filtered list shrinks. */
export function useClampActiveIndex(
  activeIndex: number,
  itemCount: number,
  setActiveIndex: (index: number) => void,
): void {
  useEffect(() => {
    if (activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1));
    }
  }, [activeIndex, itemCount, setActiveIndex]);
}
