import { useCallback, useEffect, useRef, type RefObject } from 'react';

export interface ComposerAutoResize {
  /** Bind to the composer textarea. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Restore the single-line height on the next frame. */
  resetComposerHeight: () => void;
  /** Restore the single-line height on the next frame, then focus the field. */
  resetComposerHeightAndFocus: () => void;
}

/**
 * Height plumbing for the composer textarea: the element ref plus a deferred
 * single-line reset that replaces a pending frame and is cancelled on unmount.
 */
export function useComposerAutoResize(singleLineHeightPx: number): ComposerAutoResize {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Tracks pending requestAnimationFrame so we can cancel on unmount. */
  const rafRef = useRef<number | null>(null);

  const scheduleHeightReset = useCallback((focus: boolean) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.style.height = `${singleLineHeightPx}px`;
      }
      if (focus) textareaRef.current?.focus();
    });
  }, [singleLineHeightPx]);

  const resetComposerHeight = useCallback(
    () => scheduleHeightReset(false),
    [scheduleHeightReset],
  );

  const resetComposerHeightAndFocus = useCallback(
    () => scheduleHeightReset(true),
    [scheduleHeightReset],
  );

  // Cancel pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return { textareaRef, resetComposerHeight, resetComposerHeightAndFocus };
}
