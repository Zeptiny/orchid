// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useSessionDeletionReconciliation,
  __resetDeletionReconciliation,
} from '../../src/renderer/hooks/useSessionDeletionReconciliation';
import type { SessionDeletionNotice } from '../../src/renderer/hooks/useSession';
import type { WorkingSetSnapshot } from '../../src/shared/types/ipc';

afterEach(() => {
  cleanup();
  __resetDeletionReconciliation();
});

describe('useSessionDeletionReconciliation', () => {
  it('follows the deleted active session window focus exactly once', async () => {
    const workingSet = {
      openSessionIds: ['session-b'],
      focusedSessionId: 'session-b',
      mruSessionIds: ['session-b'],
    };
    const notice: SessionDeletionNotice = {
      id: 'session-a',
      workingSet,
      wasActive: true,
      sequence: 1,
    };
    const applySnapshot = vi.fn((snapshot: WorkingSetSnapshot) => snapshot);
    const clearQueue = vi.fn();
    const clearMessages = vi.fn();
    const focusAfterWorkingSet = vi.fn(async () => undefined);

    const { rerender, unmount } = renderHook(
      ({ current }: { current: SessionDeletionNotice | null }) =>
        useSessionDeletionReconciliation(current, {
          applySnapshot,
          clearQueue,
          clearMessages,
          focusAfterWorkingSet,
        }),
      { initialProps: { current: notice as SessionDeletionNotice | null } },
    );

    await waitFor(() => expect(focusAfterWorkingSet).toHaveBeenCalledOnce());
    expect(applySnapshot).toHaveBeenCalledWith(workingSet);
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(clearMessages).toHaveBeenCalledOnce();

    await act(async () => {
      rerender({ current: { ...notice } });
      await Promise.resolve();
    });
    expect(focusAfterWorkingSet).toHaveBeenCalledOnce();

    unmount();
    renderHook(
      ({ current }: { current: SessionDeletionNotice | null }) =>
        useSessionDeletionReconciliation(current, {
          applySnapshot,
          clearQueue,
          clearMessages,
          focusAfterWorkingSet,
        }),
      { initialProps: { current: notice as SessionDeletionNotice | null } },
    );
    await act(async () => { await Promise.resolve(); });
    expect(focusAfterWorkingSet).toHaveBeenCalledOnce();
    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it('updates tabs without navigating when another session was deleted', async () => {
    const workingSet = {
      openSessionIds: ['session-active'],
      focusedSessionId: 'session-active',
      mruSessionIds: ['session-active'],
    };
    const applySnapshot = vi.fn((snapshot: WorkingSetSnapshot) => snapshot);
    const clearQueue = vi.fn();
    const clearMessages = vi.fn();
    const focusAfterWorkingSet = vi.fn(async () => undefined);

    renderHook(() => useSessionDeletionReconciliation({
      id: 'session-background',
      workingSet,
      wasActive: false,
      sequence: 1,
    }, {
      applySnapshot,
      clearQueue,
      clearMessages,
      focusAfterWorkingSet,
    }));

    await waitFor(() => expect(applySnapshot).toHaveBeenCalledOnce());
    expect(clearQueue).not.toHaveBeenCalled();
    expect(clearMessages).not.toHaveBeenCalled();
    expect(focusAfterWorkingSet).not.toHaveBeenCalled();
  });
});
