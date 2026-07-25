/**
 * Keyboard event matching and editable-target detection.
 */
import type { KeyChord } from './types';

type ElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
};

/** True when the event target is a text-entry control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (tag === 'INPUT') {
      const type = (el.type ?? 'text').toLowerCase();
      // Non-textual inputs should not block global shortcuts.
      if (
        type === 'button' ||
        type === 'checkbox' ||
        type === 'radio' ||
        type === 'submit' ||
        type === 'reset' ||
        type === 'file' ||
        type === 'range' ||
        type === 'color'
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Returns true if the KeyboardEvent matches the chord.
 * For `mod: true`, either ctrlKey or metaKey must be set (and the other need not).
 * Shift/Alt must match exactly when required; when not required, extra Shift is rejected
 * so Mod+K does not fire on Mod+Shift+K unless shift is on the chord.
 */
export function eventMatchesChord(event: KeyboardEvent, chord: KeyChord): boolean {
  const eventKey = normalizeKey(event.key);
  const chordKey = normalizeKey(chord.key);

  if (eventKey !== chordKey) {
    // Digit keys: event.key is "1"; also accept event.code Digit1 for hardened layouts.
    if (!(chordKey >= '1' && chordKey <= '9' && event.code === `Digit${chordKey}`)) {
      // Backslash: some layouts report different key values.
      if (!(chordKey === '\\' && (event.key === '\\' || event.code === 'Backslash'))) {
        return false;
      }
    }
  }

  const wantMod = Boolean(chord.mod);
  const hasMod = event.ctrlKey || event.metaKey;
  if (wantMod !== hasMod) return false;

  const wantShift = Boolean(chord.shift);
  if (wantShift !== event.shiftKey) return false;

  const wantAlt = Boolean(chord.alt);
  if (wantAlt !== event.altKey) return false;

  return true;
}

/** Format a chord for UI: "Ctrl K" / "Ctrl Shift B" (always Ctrl label for cross-platform UI). */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');

  let keyLabel = chord.key;
  if (keyLabel === ' ') keyLabel = 'Space';
  else if (keyLabel === 'Escape') keyLabel = 'Esc';
  else if (keyLabel === 'ArrowUp') keyLabel = '↑';
  else if (keyLabel === 'ArrowDown') keyLabel = '↓';
  else if (keyLabel === 'ArrowLeft') keyLabel = '←';
  else if (keyLabel === 'ArrowRight') keyLabel = '→';
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  parts.push(keyLabel);
  return parts.join(' ');
}
