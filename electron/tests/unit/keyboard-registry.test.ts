/**
 * Unit tests for the renderer keyboard registry and match helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  eventMatchesChord,
  formatChord,
  formatShortcut,
  getShortcut,
  groupShortcutsForHelp,
  isEditableTarget,
  FOOTER_SHORTCUT_IDS,
} from '../../src/renderer/keyboard';

function fakeKeyEvent(
  partial: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent {
  return {
    key: partial.key,
    code: partial.code ?? '',
    ctrlKey: partial.ctrlKey ?? false,
    metaKey: partial.metaKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
    defaultPrevented: false,
    preventDefault() {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    target: partial.target ?? null,
  } as KeyboardEvent;
}

describe('keyboard registry', () => {
  it('has unique shortcut ids', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes footer shortcuts', () => {
    for (const id of FOOTER_SHORTCUT_IDS) {
      expect(getShortcut(id)).toBeDefined();
      expect(getShortcut(id)?.footerLabel).toBeTruthy();
    }
  });

  it('registers close-tab and open-tab switch shortcuts', () => {
    const close = getShortcut('session.tab.close');
    expect(close?.chord).toEqual({ key: 'w', mod: true });
    expect(close?.group).toBe('sessions');
    for (let n = 1; n <= 9; n++) {
      expect(getShortcut(`session.switch.${n}`)?.label).toMatch(/open tab/i);
    }
  });

  it('groups help entries without empty groups', () => {
    const groups = groupShortcutsForHelp();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it('formats known shortcuts', () => {
    expect(formatShortcut('palette.toggle')).toBe('Ctrl K');
    expect(formatShortcut('settings.open')).toBe('Ctrl ,');
    expect(formatShortcut('sessionsRail.toggle')).toBe('Ctrl \\');
    expect(formatShortcut('shortcuts.help')).toBe('Ctrl /');
  });
});

describe('eventMatchesChord', () => {
  it('matches Mod+K with Ctrl', () => {
    const e = fakeKeyEvent({ key: 'k', ctrlKey: true });
    expect(eventMatchesChord(e, { key: 'k', mod: true })).toBe(true);
  });

  it('matches Mod+K with Meta', () => {
    const e = fakeKeyEvent({ key: 'k', metaKey: true });
    expect(eventMatchesChord(e, { key: 'k', mod: true })).toBe(true);
  });

  it('rejects Mod+K when Shift is held', () => {
    const e = fakeKeyEvent({ key: 'k', ctrlKey: true, shiftKey: true });
    expect(eventMatchesChord(e, { key: 'k', mod: true })).toBe(false);
  });

  it('matches digit shortcuts via key', () => {
    const e = fakeKeyEvent({ key: '3', ctrlKey: true });
    expect(eventMatchesChord(e, { key: '3', mod: true })).toBe(true);
  });

  it('matches Escape without mod', () => {
    const e = fakeKeyEvent({ key: 'Escape' });
    expect(eventMatchesChord(e, { key: 'Escape' })).toBe(true);
  });

  it('matches backslash via event.code', () => {
    const e = fakeKeyEvent({ key: 'Process', code: 'Backslash', ctrlKey: true });
    expect(eventMatchesChord(e, { key: '\\', mod: true })).toBe(true);
  });
});

describe('formatChord', () => {
  it('joins modifiers and key', () => {
    expect(formatChord({ key: 's', mod: true })).toBe('Ctrl S');
    expect(formatChord({ key: 'Escape' })).toBe('Esc');
    expect(formatChord({ key: 'Enter', shift: true })).toBe('Shift Enter');
  });
});

describe('isEditableTarget', () => {
  it('detects textarea and text input', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(
      isEditableTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget),
    ).toBe(true);
  });

  it('ignores button inputs', () => {
    expect(
      isEditableTarget({ tagName: 'INPUT', type: 'button' } as unknown as EventTarget),
    ).toBe(false);
  });

  it('ignores plain div', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
  });
});
