// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionTabs } from '../../src/renderer/hooks/useSessionTabs';

afterEach(() => {
  cleanup();
  delete (window as unknown as { orchid?: unknown }).orchid;
});

describe('useSessionTabs', () => {
  it('applies the delete response without another GET and rejects an older refresh result', async () => {
    let resolveInitial!: (value: unknown) => void;
    const getWorkingSet = vi.fn(() => new Promise((resolve) => {
      resolveInitial = resolve;
    }));
    const onWorkingSetChanged = vi.fn(() => () => {});
    (window as unknown as { orchid: unknown }).orchid = {
      session: {
        getWorkingSet,
        onWorkingSetChanged,
      },
    };

    const { result } = renderHook(() => useSessionTabs());
    await waitFor(() => expect(getWorkingSet).toHaveBeenCalledTimes(1));

    const deleted = {
      openSessionIds: ['session-b'],
      focusedSessionId: 'session-b',
      mruSessionIds: ['session-b'],
    };
    act(() => {
      result.current.applySnapshot(deleted);
    });
    expect(result.current.snapshot).toEqual(deleted);
    expect(getWorkingSet).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial({
        openSessionIds: ['session-a', 'session-b'],
        focusedSessionId: 'session-a',
        mruSessionIds: ['session-a', 'session-b'],
      });
      await Promise.resolve();
    });

    expect(result.current.snapshot).toEqual(deleted);
    expect(getWorkingSet).toHaveBeenCalledTimes(1);
  });
});
