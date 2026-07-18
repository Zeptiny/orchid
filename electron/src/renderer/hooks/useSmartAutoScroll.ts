import { useCallback, useEffect, useRef, useState, type RefCallback, type RefObject } from 'react';

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

export interface SmartAutoScrollOptions {
  /** Changing this identity clears suspension and anchors the new transcript. */
  resetKey?: string | null;
  /** A stable representation of content changes that should follow when pinned. */
  contentKey?: string | number;
  enabled?: boolean;
}

export interface SmartAutoScrollResult {
  containerRef: RefCallback<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  isUserScrolledUp: boolean;
  jumpToLatest: () => void;
}

export function useSmartAutoScroll({
  resetKey = null,
  contentKey,
  enabled = true,
}: SmartAutoScrollOptions = {}): SmartAutoScrollResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setContainer((previous) => previous === node ? previous : node);
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    setIsUserScrolledUp(false);
    if (enabled) scrollToLatest('auto');
  }, [enabled, resetKey, scrollToLatest]);

  useEffect(() => {
    if (enabled && shouldAutoScroll(isUserScrolledUp)) scrollToLatest();
  }, [contentKey, enabled, isUserScrolledUp, scrollToLatest]);

  const jumpToLatest = useCallback(() => {
    setIsUserScrolledUp(false);
    scrollToLatest();
  }, [scrollToLatest]);

  return { containerRef, messagesEndRef, isUserScrolledUp, jumpToLatest };
}
