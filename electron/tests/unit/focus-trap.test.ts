/**
 * Unit tests for focus trap focusable query helper.
 * Uses a minimal DOM stub so Vitest can run in Node without jsdom.
 */
import { describe, expect, it, vi } from 'vitest';
import { getFocusableElements } from '../../src/renderer/keyboard';

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

    // querySelectorAll returns NodeList-like; our helper only needs Array.from + fields.
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
