// @vitest-environment jsdom
/**
 * ContextRadialButton — the shared context ring + dropup breakdown extracted
 * from the chat footer and reused per-subagent in the subagent view (issue 168).
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextRadialButton } from '../../src/renderer/components/ContextRadialButton';
import type { Usage } from '../../src/shared/types/message';

const CONTEXT_USAGE: Usage = {
  prompt_tokens: 900,
  completion_tokens: 100,
  total_tokens: 1_000,
  cached_tokens: 0,
  context: {
    input_tokens: 800,
    output_tokens: 200,
    used_tokens: 500,
    system_tokens: 100,
    tools_tokens: 50,
    tool_use_tokens: 100,
    user_tokens: 150,
    assistant_tokens: 100,
  },
};

afterEach(cleanup);

/** The panel is portaled to document.body — not inside the render container. */
function queryPanel(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

describe('ContextRadialButton', () => {
  it('renders the percent of the resolved window without opening the panel', () => {
    const { container } = render(
      <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} />,
    );
    const radial = container.querySelector('.orchid-footer-context-radial');
    expect(radial).not.toBeNull();
    expect(radial?.getAttribute('aria-valuenow')).toBe('50');
    expect(container.querySelector('.footer-context-value')?.textContent).toBe('50');
    expect(queryPanel()).toBeNull();
  });

  it('shows the em dash while the window is unknown but tokens were used', () => {
    const { container } = render(
      <ContextRadialButton usage={CONTEXT_USAGE} maxContext={null} />,
    );
    expect(container.querySelector('.footer-context-value')?.textContent).toBe('—');
    expect(container.querySelector('.orchid-footer-context-radial')?.getAttribute('aria-label'))
      .toContain('context window loading');
  });

  it('opens the fixed-position breakdown panel on click and closes it on Escape', () => {
    const { container } = render(
      <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} messages={[]} />,
    );
    fireEvent.click(container.querySelector('button')!);
    const panel = queryPanel();
    expect(panel).not.toBeNull();
    // Portal: the panel escapes any ancestor containment (container-type,
    // transforms) that would skew fixed-position coordinates.
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.getAttribute('aria-label')).toBe('Context breakdown');
    expect(panel?.textContent).toContain('System');
    expect(panel?.textContent).toContain('1.0k window');
    expect(panel?.getAttribute('style')).toContain('position: fixed');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryPanel()).toBeNull();
  });

  it('closes the panel on an outside mousedown', () => {
    const { container } = render(
      <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} />,
    );
    fireEvent.click(container.querySelector('button')!);
    expect(queryPanel()).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(queryPanel()).toBeNull();
  });

  it('keeps the panel open for clicks inside the portaled panel', () => {
    const { container } = render(
      <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} messages={[]} />,
    );
    fireEvent.click(container.querySelector('button')!);
    fireEvent.mouseDown(queryPanel()!);
    expect(queryPanel()).not.toBeNull();
  });

  it('opens downward with a clamped max-height when the trigger is near the top', () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 100, bottom: 130, right: 900 } as DOMRect);
    try {
      const { container } = render(
        <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} />,
      );
      fireEvent.click(container.querySelector('button')!);
      const style = queryPanel()?.getAttribute('style') ?? '';
      expect(style).toContain(`top: ${130 + 4}px`);
      expect(style).not.toContain('bottom:');
      expect(style).toContain('max-height:');
      expect(style).toContain('overflow-y: auto');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('opens upward (footer parity) when the trigger is near the bottom', () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 700, bottom: 730, right: 900 } as DOMRect);
    try {
      const { container } = render(
        <ContextRadialButton usage={CONTEXT_USAGE} maxContext={1_000} />,
      );
      fireEvent.click(container.querySelector('button')!);
      const style = queryPanel()?.getAttribute('style') ?? '';
      expect(style).toContain(`bottom: ${768 - 700 + 4}px`);
      expect(style).not.toContain('top:');
      expect(style).toContain('max-height:');
    } finally {
      rectSpy.mockRestore();
    }
  });
});
