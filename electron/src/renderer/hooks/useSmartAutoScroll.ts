import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';

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
  const isFollowingRef = useRef(true);
  const previousScrollTopRef = useRef(0);

  const setFollowing = useCallback((following: boolean) => {
    isFollowingRef.current = following;
    setIsUserScrolledUp(!following);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    scrollContainerToLatest(container, behavior);
  }, [container]);

  const followLatest = useCallback(() => {
    scrollToLatest('instant');
  }, [scrollToLatest]);

  useEffect(() => {
    if (!enabled) return;
    if (!container) return;
    previousScrollTopRef.current = container.scrollTop;
    let previousTouchY: number | null = null;

    const suspendFollowing = () => {
      previousScrollTopRef.current = container.scrollTop;
      setFollowing(false);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) suspendFollowing();
    };
    const handleTouchStart = (event: TouchEvent) => {
      previousTouchY = event.touches[0]?.clientY ?? null;
      previousScrollTopRef.current = container.scrollTop;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextTouchY = event.touches[0]?.clientY ?? null;
      if (
        previousTouchY != null &&
        nextTouchY != null &&
        nextTouchY > previousTouchY
      ) {
        suspendFollowing();
      }
      previousTouchY = nextTouchY;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey)
      ) {
        suspendFollowing();
      }
    };
    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const movedTowardBottom =
        currentScrollTop > previousScrollTopRef.current;
      const isAway = isUserScrolledAwayFromBottom(
        currentScrollTop,
        container.scrollHeight,
        container.clientHeight,
      );
      previousScrollTopRef.current = currentScrollTop;

      if (isAway) {
        setFollowing(false);
      } else if (!isFollowingRef.current && movedTowardBottom) {
        setFollowing(true);
        followLatest();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('keydown', handleKeyDown);
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('keydown', handleKeyDown);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [container, enabled, followLatest, setFollowing]);

  useEffect(() => {
    setFollowing(true);
    previousScrollTopRef.current = container?.scrollTop ?? 0;
  }, [container, resetKey, setFollowing]);

  useEffect(() => {
    if (enabled && isFollowingRef.current) scrollToLatest('instant');
  }, [contentKey, enabled, scrollToLatest]);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    scrollToLatest('smooth');
  }, [scrollToLatest, setFollowing]);

  return { containerRef, isUserScrolledUp, followLatest, jumpToLatest };
}
