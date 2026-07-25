// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DeferredSurface } from '../../src/renderer/components/deferred-surface';

afterEach(cleanup);

describe('DeferredSurface', () => {
  it('freezes hidden children and catches up from the latest snapshot when shown', () => {
    let childRenderCount = 0;

    function Probe({ value }: { value: string }) {
      const [localCount, setLocalCount] = useState(0);
      childRenderCount += 1;
      return (
        <button type="button" onClick={() => setLocalCount((count) => count + 1)}>
          {value}:{localCount}
        </button>
      );
    }

    const { rerender } = render(
      <DeferredSurface isVisible>
        <Probe value="initial" />
      </DeferredSurface>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('initial:1');

    rerender(
      <DeferredSurface isVisible={false}>
        <Probe value="hidden" />
      </DeferredSurface>,
    );
    const renderCountAfterHide = childRenderCount;

    rerender(
      <DeferredSurface isVisible={false}>
        <Probe value="streamed" />
      </DeferredSurface>,
    );

    expect(childRenderCount).toBe(renderCountAfterHide);
    expect(screen.getByRole('button').textContent).toBe('hidden:1');

    rerender(
      <DeferredSurface isVisible>
        <Probe value="complete" />
      </DeferredSurface>,
    );

    expect(childRenderCount).toBe(renderCountAfterHide + 1);
    expect(screen.getByRole('button').textContent).toBe('complete:1');
  });
});
