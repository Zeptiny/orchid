/**
 * Roving highlight index for keyboard-navigable lists (session rail, etc.).
 */
import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface UseRovingListIndexOptions {
  /** Number of items in the flat list. */
  length: number;
  /** When length/items change, optionally pin to this index (e.g. active session). */
  preferredIndex?: number;
  /** Disable arrow handling (e.g. when list not focused). */
  enabled?: boolean;
}

export function useRovingListIndex({
  length,
  preferredIndex,
  enabled = true,
}: UseRovingListIndexOptions) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Clamp when list shrinks; sync preferred when it changes and is valid.
  useEffect(() => {
    if (length <= 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((prev) => {
      if (preferredIndex != null && preferredIndex >= 0 && preferredIndex < length) {
        return preferredIndex;
      }
      return Math.min(prev, length - 1);
    });
  }, [length, preferredIndex]);

  const move = useCallback(
    (delta: number) => {
      if (!enabled || length <= 0) return;
      setActiveIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return 0;
        if (next >= length) return length - 1;
        return next;
      });
    },
    [enabled, length],
  );

  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!enabled || length <= 0) return;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          event.preventDefault();
          setActiveIndex(length - 1);
          break;
        default:
          break;
      }
    },
    [enabled, length, move],
  );

  return { activeIndex, setActiveIndex, move, onListKeyDown };
}
