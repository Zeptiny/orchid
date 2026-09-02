/** Runtime height writes for the composer textarea (a CSS size exception). */

/** Single-line composer height — keep in sync with `.orchid-composer-textarea` CSS. */
export const TEXTAREA_MIN_HEIGHT_PX = 36;
const TEXTAREA_MAX_HEIGHT_PX = 160;

/**
 * Grow the element to its content, then clamp. `readScrollHeight` must be
 * called only after the fixed height is released, so the caller supplies the
 * measurement instead of this function reading a stale box.
 */
export function resizeComposerTextarea(
  el: HTMLTextAreaElement,
  readScrollHeight: () => number,
): void {
  // Empty: fixed single-line height with centered text (line-height = height).
  if (!el.value) {
    el.style.height = `${TEXTAREA_MIN_HEIGHT_PX}px`;
    el.style.lineHeight = `${TEXTAREA_MIN_HEIGHT_PX}px`;
    el.style.paddingTop = '0';
    el.style.paddingBottom = '0';
    el.style.overflowY = 'hidden';
    return;
  }
  // Multi-line: normal leading + vertical padding; overflow only at max height.
  el.style.lineHeight = '1.4';
  el.style.paddingTop = '8px';
  el.style.paddingBottom = '8px';
  el.style.height = 'auto';
  const next = Math.min(
    Math.max(readScrollHeight(), TEXTAREA_MIN_HEIGHT_PX),
    TEXTAREA_MAX_HEIGHT_PX,
  );
  el.style.height = `${next}px`;
  el.style.overflowY = next >= TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden';
}
