// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useSmartAutoScroll,
  type SmartAutoScrollResult,
} from '../../src/renderer/hooks/useSmartAutoScroll';

afterEach(cleanup);

function AutoScrollHarness({
  contentKey,
  onUpdate,
}: {
  contentKey: number;
  onUpdate: (value: SmartAutoScrollResult) => void;
}) {
  const scroll = useSmartAutoScroll({ contentKey });

  useEffect(() => {
    onUpdate(scroll);
  }, [onUpdate, scroll]);

  return <div data-testid="transcript" ref={scroll.containerRef} />;
}

function setScrollGeometry(
  element: HTMLDivElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperties(element, {
    scrollTop: { configurable: true, writable: true, value: geometry.scrollTop },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    clientHeight: { configurable: true, value: geometry.clientHeight },
  });
}

describe('useSmartAutoScroll', () => {
  it('suspends before a small upward scroll can be pulled back by streamed content', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    let latest: SmartAutoScrollResult | null = null;
    const onUpdate = (value: SmartAutoScrollResult) => {
      latest = value;
    };
    const view = render(
      <AutoScrollHarness contentKey={0} onUpdate={onUpdate} />,
    );
    const transcript = view.getByTestId('transcript') as HTMLDivElement;
    setScrollGeometry(transcript, {
      scrollTop: 600,
      scrollHeight: 1_000,
      clientHeight: 400,
    });
    const scrollTo = vi.fn();
    transcript.scrollTo = scrollTo;

    act(() => {
      fireEvent.wheel(transcript, { deltaY: -40 });
      transcript.scrollTop = 550;
      fireEvent.scroll(transcript);
    });
    expect(latest?.isUserScrolledUp).toBe(true);

    scrollTo.mockClear();
    view.rerender(
      <AutoScrollHarness contentKey={1} onUpdate={onUpdate} />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('resumes following after the user scrolls back toward the bottom', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    let latest: SmartAutoScrollResult | null = null;
    const onUpdate = (value: SmartAutoScrollResult) => {
      latest = value;
    };
    const view = render(
      <AutoScrollHarness contentKey={0} onUpdate={onUpdate} />,
    );
    const transcript = view.getByTestId('transcript') as HTMLDivElement;
    setScrollGeometry(transcript, {
      scrollTop: 600,
      scrollHeight: 1_000,
      clientHeight: 400,
    });
    const scrollTo = vi.fn();
    transcript.scrollTo = scrollTo;

    act(() => {
      fireEvent.wheel(transcript, { deltaY: -40 });
      transcript.scrollTop = 550;
      fireEvent.scroll(transcript);
    });
    expect(latest?.isUserScrolledUp).toBe(true);

    scrollTo.mockClear();
    act(() => {
      fireEvent.wheel(transcript, { deltaY: 40 });
      transcript.scrollTop = 575;
      fireEvent.scroll(transcript);
    });

    expect(latest?.isUserScrolledUp).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 1_000,
      behavior: 'instant',
    });
  });
});
