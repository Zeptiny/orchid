// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSmartAutoScroll } from '../../src/renderer/hooks/useSmartAutoScroll';

function scrollableContainer(): HTMLDivElement {
  const container = document.createElement('div');
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 },
  });
  container.scrollTo = vi.fn();
  return container;
}

describe('useSmartAutoScroll', () => {
  it('preserves a reader scrolled away from the bottom while hidden and shown again', () => {
    const container = scrollableContainer();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSmartAutoScroll({
        resetKey: 'session-a',
        contentKey: '1:0',
        enabled,
      }),
      { initialProps: { enabled: true } },
    );

    act(() => {
      result.current.containerRef(container);
    });
    vi.mocked(container.scrollTo).mockClear();

    act(() => {
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isUserScrolledUp).toBe(true);

    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(result.current.isUserScrolledUp).toBe(true);
    expect(container.scrollTo).not.toHaveBeenCalled();
  });
});
