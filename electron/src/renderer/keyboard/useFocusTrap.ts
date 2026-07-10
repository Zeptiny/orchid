/**
 * Focus trap for modal / full-screen overlays with restore on close.
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

/**
 * Traps Tab within container while enabled; restores focus on disable/unmount.
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
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);

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
