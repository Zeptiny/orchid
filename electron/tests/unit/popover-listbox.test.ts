/**
 * Behavioral tests for PopoverList / usePopoverListbox pure logic.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPopoverListboxKey,
  buildDropdownClassName,
  canSelectPopoverOption,
  clampPopoverActiveIndex,
  defaultPopoverFilter,
  filterPopoverOptions,
  isOutsidePopoverRoot,
  popoverEmptyMessage,
} from '../../src/renderer/components/ui/popover-listbox-logic';

const OPTIONS = [
  { value: 'alpha', label: 'Alpha', description: 'First' },
  { value: 'beta', label: 'Beta', description: 'Second', disabled: true },
  { value: 'gamma', label: 'Gamma', description: 'Third' },
] as const;

describe('filter / query', () => {
  it('filters by label, value, and description', () => {
    expect(defaultPopoverFilter(OPTIONS[0], 'alp')).toBe(true);
    expect(defaultPopoverFilter(OPTIONS[0], 'First')).toBe(true);
    expect(defaultPopoverFilter(OPTIONS[0], 'zzz')).toBe(false);
    expect(defaultPopoverFilter(OPTIONS[0], '  ')).toBe(true);
  });

  it('keeps selected option visible when it no longer matches the query', () => {
    const filtered = filterPopoverOptions([...OPTIONS], 'gam', 'alpha');
    expect(filtered.map((o) => o.value)).toEqual(['alpha', 'gamma']);
  });

  it('returns only matches when selected already matches', () => {
    const filtered = filterPopoverOptions([...OPTIONS], 'gam', 'gamma');
    expect(filtered.map((o) => o.value)).toEqual(['gamma']);
  });
});

describe('keyboard arrows + Enter', () => {
  it('moves active index with ArrowDown / ArrowUp and clamps at ends', () => {
    expect(applyPopoverListboxKey('ArrowDown', 0, 3, true)).toEqual({
      kind: 'move',
      activeIndex: 1,
    });
    expect(applyPopoverListboxKey('ArrowDown', 2, 3, true)).toEqual({
      kind: 'move',
      activeIndex: 2,
    });
    expect(applyPopoverListboxKey('ArrowUp', 0, 3, true)).toEqual({
      kind: 'move',
      activeIndex: 0,
    });
    expect(applyPopoverListboxKey('ArrowUp', 2, 3, true)).toEqual({
      kind: 'move',
      activeIndex: 1,
    });
  });

  it('clamps when itemCount is zero', () => {
    expect(applyPopoverListboxKey('ArrowDown', 0, 0, true)).toEqual({
      kind: 'move',
      activeIndex: 0,
    });
  });

  it('selects active index on Enter when allowed and list non-empty', () => {
    expect(applyPopoverListboxKey('Enter', 1, 3, true)).toEqual({
      kind: 'select',
      index: 1,
    });
    expect(applyPopoverListboxKey('Enter', 0, 0, true)).toEqual({ kind: 'none' });
    expect(applyPopoverListboxKey('Enter', 0, 3, false)).toEqual({ kind: 'none' });
  });

  it('closes on Escape', () => {
    expect(applyPopoverListboxKey('Escape', 1, 3, true)).toEqual({ kind: 'close' });
  });
});

describe('disabled options + empty state', () => {
  it('refuses selection of disabled or missing options', () => {
    expect(canSelectPopoverOption(OPTIONS[1])).toBe(false);
    expect(canSelectPopoverOption(OPTIONS[0])).toBe(true);
    expect(canSelectPopoverOption(undefined)).toBe(false);
  });

  it('clamps active index when filtered list shrinks', () => {
    expect(clampPopoverActiveIndex(4, 2)).toBe(1);
    expect(clampPopoverActiveIndex(0, 0)).toBe(0);
    expect(clampPopoverActiveIndex(1, 3)).toBe(1);
  });

  it('surfaces empty and no-match messages', () => {
    expect(
      popoverEmptyMessage({
        optionsLength: 0,
        filteredLength: 0,
        query: '',
        emptyMessage: 'No options',
        noMatchMessage: (q) => `No match ${q}`,
      }),
    ).toBe('No options');

    expect(
      popoverEmptyMessage({
        optionsLength: 3,
        filteredLength: 0,
        query: 'zzz',
        emptyMessage: 'No options',
        noMatchMessage: (q) => `No match ${q}`,
      }),
    ).toBe('No match zzz');

    expect(
      popoverEmptyMessage({
        optionsLength: 3,
        filteredLength: 1,
        query: 'a',
        emptyMessage: 'No options',
        noMatchMessage: (q) => `No match ${q}`,
      }),
    ).toBeNull();
  });
});

describe('Escape / outside close restores focus (logic-level)', () => {
  it('treats null root or outside target as outside', () => {
    const root = {
      contains: (node: Node | null) => node === ('inside' as unknown as Node),
    };
    expect(isOutsidePopoverRoot(null, null)).toBe(true);
    expect(isOutsidePopoverRoot(root, 'outside' as unknown as Node)).toBe(true);
    expect(isOutsidePopoverRoot(root, 'inside' as unknown as Node)).toBe(false);
  });

  it('Escape yields close so callers restore trigger focus', () => {
    // Production closeAndRestoreFocus: setOpen(false) + rAF → trigger.focus().
    expect(applyPopoverListboxKey('Escape', 0, 2, true).kind).toBe('close');
  });

  it('builds dropdown open/align/placement classes', () => {
    expect(buildDropdownClassName(true, 'end', 'top', 'extra')).toBe(
      'dropdown dropdown-end dropdown-top dropdown-open extra',
    );
    expect(buildDropdownClassName(false, 'start', 'bottom')).toBe(
      'dropdown dropdown-start',
    );
  });
});
