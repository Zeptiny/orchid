/**
 * Focus trap for modal / full-screen overlays with restore on close.
 * Nested traps form a stack: only the innermost (last enabled) trap handles Tab.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && isVisible(el),
  );
}

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

export interface UseFocusTrapOptions {
  /** When false, trap is inactive. */
  enabled: boolean;
  /** Root element that confines Tab focus. */
  containerRef: RefObject<HTMLElement | null>;
  /** Optional element to focus on activate; else first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * When set, used as restore target instead of document.activeElement at open.
   * Useful when the opener already blurred.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Prefer restoring to composer if restore target is gone. */
  restoreSelector?: string;
}

type TrapEntry = {
  id: number;
  onKeyDown: (event: KeyboardEvent) => void;
};

/** Module stack so nested traps do not both handle the same Tab. */
const trapStack: TrapEntry[] = [];
let nextTrapId = 0;
let documentListenerAttached = false;

/** Dispatch Tab (or any key) to the innermost active trap only. */
export function dispatchActiveFocusTrap(event: KeyboardEvent): void {
  const top = trapStack[trapStack.length - 1];
  top?.onKeyDown(event);
}

function attachDocumentListener(): void {
  if (documentListenerAttached || typeof document === 'undefined') return;
  document.addEventListener('keydown', dispatchActiveFocusTrap, true);
  documentListenerAttached = true;
}

function detachDocumentListenerIfIdle(): void {
  if (trapStack.length > 0 || !documentListenerAttached || typeof document === 'undefined') {
    return;
  }
  document.removeEventListener('keydown', dispatchActiveFocusTrap, true);
  documentListenerAttached = false;
}

/**
 * Cycle Tab within container. Pure helper for tests and trap handlers.
 * @returns true if the event was handled (preventDefault applied).
 */
export function cycleFocusOnTab(
  container: HTMLElement,
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>,
  active: HTMLElement | null = typeof document !== 'undefined'
    ? (document.activeElement as HTMLElement | null)
    : null,
): boolean {
  if (event.key !== 'Tab') return false;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey) {
    if (!active || active === first || !container.contains(active)) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
      return true;
    }
  } else if (!active || active === last || !container.contains(active)) {
    event.preventDefault();
    event.stopPropagation();
    first.focus();
    return true;
  }

  return false;
}

/** How many traps are currently stacked. */
export function getActiveFocusTrapCount(): number {
  return trapStack.length;
}

/** @internal Test-only: push a trap handler onto the stack. */
export function __testOnly_pushFocusTrap(onKeyDown: (event: KeyboardEvent) => void): number {
  const entry: TrapEntry = { id: nextTrapId++, onKeyDown };
  trapStack.push(entry);
  attachDocumentListener();
  return entry.id;
}

/** @internal Test-only: remove a trap by id. */
export function __testOnly_removeFocusTrap(id: number): void {
  const index = trapStack.findIndex((t) => t.id === id);
  if (index >= 0) trapStack.splice(index, 1);
  detachDocumentListenerIfIdle();
}

/** @internal Test-only: clear the entire trap stack. */
export function __testOnly_clearFocusTrapStack(): void {
  trapStack.length = 0;
  detachDocumentListenerIfIdle();
}

/**
 * Traps Tab within container while enabled; restores focus on disable/unmount.
 * When multiple traps are enabled, only the most recently enabled trap handles Tab.
 */
export function useFocusTrap({
  enabled,
  containerRef,
  initialFocusRef,
  restoreFocusRef,
  restoreSelector = '[data-orchid-composer]',
}: UseFocusTrapOptions): void {
  useEffect(() => {
    if (!enabled) return;

    const previouslyFocused =
      restoreFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    const focusInitial = () => {
      const container = containerRef.current;
      if (!container) return;
      const initial = initialFocusRef?.current;
      if (initial && container.contains(initial)) {
        initial.focus();
        return;
      }
      const focusable = getFocusableElements(container);
      focusable[0]?.focus();
    };

    // Double rAF: wait for dialog content paint (e.g. autoFocus peers).
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(focusInitial);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      cycleFocusOnTab(container, event);
    };

    const entry: TrapEntry = { id: nextTrapId++, onKeyDown };
    trapStack.push(entry);
    attachDocumentListener();

    return () => {
      cancelAnimationFrame(raf);
      const index = trapStack.findIndex((t) => t.id === entry.id);
      if (index >= 0) trapStack.splice(index, 1);
      detachDocumentListenerIfIdle();

      const restore =
        previouslyFocused && document.contains(previouslyFocused)
          ? previouslyFocused
          : (document.querySelector(restoreSelector) as HTMLElement | null);

      if (restore && typeof restore.focus === 'function') {
        restore.focus();
      }
    };
  }, [enabled, containerRef, initialFocusRef, restoreFocusRef, restoreSelector]);
}
