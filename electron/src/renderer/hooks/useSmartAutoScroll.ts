import { useCallback, useEffect, useState, type RefCallback } from 'react';

export const AUTO_SCROLL_THRESHOLD_PX = 100;

export function isUserScrolledAwayFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx: number = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight > thresholdPx;
}

export function shouldAutoScroll(isUserScrolledUp: boolean): boolean {
  return !isUserScrolledUp;
}

export interface ScrollContainerTarget {
  readonly scrollHeight: number;
  scrollTo(options: ScrollToOptions): void;
}

/** Scroll the owned transcript viewport without moving document ancestors. */
export function scrollContainerToLatest(
  container: ScrollContainerTarget | null,
  behavior: ScrollBehavior = 'smooth',
): void {
  container?.scrollTo({ top: container.scrollHeight, behavior });
}

export interface SmartAutoScrollOptions {
  /** Changing this identity clears suspension and anchors the new transcript. */
  resetKey?: string | null;
  /** A stable representation of content changes that should follow when pinned. */
  contentKey?: string | number;
  enabled?: boolean;
}

/** State and commands for an owned transcript viewport. */
export interface SmartAutoScrollResult {
  containerRef: RefCallback<HTMLDivElement>;
  isUserScrolledUp: boolean;
  /** Follow the latest content immediately without clearing scroll-away state. */
  followLatest: () => void;
  jumpToLatest: () => void;
}

/**
 * Keep a visible transcript pinned while preserving a reader's scroll-away
 * choice. `followLatest` performs an immediate container-only scroll.
 */
export function useSmartAutoScroll({
  resetKey = null,
  contentKey,
  enabled = true,
}: SmartAutoScrollOptions = {}): SmartAutoScrollResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setContainer((previous) => previous === node ? previous : node);
  }, []);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (!container) return;
    const handleScroll = () => {
      setIsUserScrolledUp(
        isUserScrolledAwayFromBottom(
          container.scrollTop,
          container.scrollHeight,
          container.clientHeight,
        ),
      );
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [container, enabled]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    scrollContainerToLatest(container, behavior);
  }, [container]);

  const followLatest = useCallback(() => {
    scrollToLatest('auto');
  }, [scrollToLatest]);

  useEffect(() => {
    setIsUserScrolledUp(false);
  }, [resetKey]);

  useEffect(() => {
    if (enabled && shouldAutoScroll(isUserScrolledUp)) scrollToLatest('auto');
  }, [contentKey, enabled, isUserScrolledUp, scrollToLatest]);

  const jumpToLatest = useCallback(() => {
    setIsUserScrolledUp(false);
    scrollToLatest();
  }, [scrollToLatest]);

  return { containerRef, isUserScrolledUp, followLatest, jumpToLatest };
}
