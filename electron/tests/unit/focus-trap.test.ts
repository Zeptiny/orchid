/**
 * Unit tests for focus trap helpers and nested trap stack.
 * Uses minimal DOM stubs so Vitest can run in Node without jsdom.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveFocusTrapCount,
  getFocusableElements,
} from '../../src/renderer/keyboard';
import {
  __testOnly_clearFocusTrapStack,
  __testOnly_pushFocusTrap,
  __testOnly_removeFocusTrap,
  cycleFocusOnTab,
  dispatchActiveFocusTrap,
} from '../../src/renderer/keyboard/useFocusTrap';

describe('getFocusableElements', () => {
  it('collects enabled buttons and inputs from a container', () => {
    const button = {
      tagName: 'BUTTON',
      disabled: false,
      tabIndex: 0,
      hasAttribute: (n: string) => n === 'disabled' && false,
      offsetWidth: 10,
      offsetHeight: 10,
      getClientRects: () => [{ width: 10 }],
    };
    const disabledBtn = {
      tagName: 'BUTTON',
      disabled: true,
      tabIndex: 0,
      hasAttribute: (n: string) => n === 'disabled',
      offsetWidth: 10,
      offsetHeight: 10,
      getClientRects: () => [{ width: 10 }],
    };
    const input = {
      tagName: 'INPUT',
      type: 'text',
      disabled: false,
      tabIndex: 0,
      hasAttribute: () => false,
      offsetWidth: 10,
      offsetHeight: 10,
      getClientRects: () => [{ width: 10 }],
    };
    const hidden = {
      tagName: 'INPUT',
      type: 'hidden',
      disabled: false,
      tabIndex: 0,
      hasAttribute: () => false,
      offsetWidth: 0,
      offsetHeight: 0,
      getClientRects: () => [],
    };

    const root = {
      querySelectorAll: vi.fn(() => [button, disabledBtn, input, hidden]),
    } as unknown as HTMLElement;

    const focusable = getFocusableElements(root);
    expect(focusable).toContain(button);
    expect(focusable).toContain(input);
    expect(focusable).not.toContain(disabledBtn);
    expect(focusable).not.toContain(hidden);
  });
});

describe('cycleFocusOnTab', () => {
  function makeEl(id: string) {
    return {
      id,
      focus: vi.fn(),
      tabIndex: 0,
      hasAttribute: () => false,
      offsetWidth: 10,
      offsetHeight: 10,
      getClientRects: () => [{ width: 10 }],
    };
  }

  it('wraps Tab from last focusable to first', () => {
    const first = makeEl('first');
    const last = makeEl('last');
    const container = {
      querySelectorAll: () => [first, last],
      contains: (el: unknown) => el === first || el === last,
    } as unknown as HTMLElement;

    const event = {
      key: 'Tab',
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    cycleFocusOnTab(
      container,
      event as unknown as KeyboardEvent,
      last as unknown as HTMLElement,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();
    expect(last.focus).not.toHaveBeenCalled();
  });

  it('wraps Shift+Tab from first focusable to last', () => {
    const first = makeEl('first');
    const last = makeEl('last');
    const container = {
      querySelectorAll: () => [first, last],
      contains: (el: unknown) => el === first || el === last,
    } as unknown as HTMLElement;

    const event = {
      key: 'Tab',
      shiftKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    cycleFocusOnTab(
      container,
      event as unknown as KeyboardEvent,
      first as unknown as HTMLElement,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(last.focus).toHaveBeenCalled();
  });

  it('pulls focus into container when active is outside', () => {
    const first = makeEl('first');
    const last = makeEl('last');
    const outside = makeEl('outside');
    const container = {
      querySelectorAll: () => [first, last],
      contains: (el: unknown) => el === first || el === last,
    } as unknown as HTMLElement;

    const event = {
      key: 'Tab',
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    cycleFocusOnTab(
      container,
      event as unknown as KeyboardEvent,
      outside as unknown as HTMLElement,
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();
  });

  it('does not intervene for mid-list Tab', () => {
    const first = makeEl('first');
    const mid = makeEl('mid');
    const last = makeEl('last');
    const container = {
      querySelectorAll: () => [first, mid, last],
      contains: (el: unknown) => el === first || el === mid || el === last,
    } as unknown as HTMLElement;

    const event = {
      key: 'Tab',
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    const handled = cycleFocusOnTab(
      container,
      event as unknown as KeyboardEvent,
      mid as unknown as HTMLElement,
    );

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('nested focus trap stack', () => {
  afterEach(() => {
    __testOnly_clearFocusTrapStack();
  });

  function tabEvent(): KeyboardEvent {
    return {
      key: 'Tab',
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
  }

  it('only the innermost trap handles Tab when nested', () => {
    const calls: string[] = [];
    __testOnly_pushFocusTrap(() => {
      calls.push('outer');
    });
    __testOnly_pushFocusTrap(() => {
      calls.push('inner');
    });
    expect(getActiveFocusTrapCount()).toBe(2);

    dispatchActiveFocusTrap(tabEvent());
    expect(calls).toEqual(['inner']);
  });

  it('pops to outer trap after inner is removed', () => {
    const calls: string[] = [];
    __testOnly_pushFocusTrap(() => {
      calls.push('outer');
    });
    const innerId = __testOnly_pushFocusTrap(() => {
      calls.push('inner');
    });

    dispatchActiveFocusTrap(tabEvent());
    expect(calls).toEqual(['inner']);

    calls.length = 0;
    __testOnly_removeFocusTrap(innerId);
    expect(getActiveFocusTrapCount()).toBe(1);

    dispatchActiveFocusTrap(tabEvent());
    expect(calls).toEqual(['outer']);
  });

  it('clears stack completely', () => {
    __testOnly_pushFocusTrap(() => {});
    __testOnly_pushFocusTrap(() => {});
    expect(getActiveFocusTrapCount()).toBe(2);
    __testOnly_clearFocusTrapStack();
    expect(getActiveFocusTrapCount()).toBe(0);
  });
});
