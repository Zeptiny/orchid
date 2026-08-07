// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBackgroundCommands } from '../../src/renderer/hooks/useBackgroundCommands';
import type { BgCommandListItem } from '../../src/shared/types/ipc';

function listItem(overrides: Partial<BgCommandListItem> = {}): BgCommandListItem {
  return {
    id: 1,
    command: 'sleep 100',
    description: 'long sleeper',
    interactive: false,
    owner: 'AGENT',
    agentScopeId: 'main',
    scopeName: 'main',
    running: true,
    exitCode: null,
    createdAt: 1_000,
    lastOutputAt: 2_000,
    ...overrides,
  };
}

type ChangedCallback = (event: { sessionId: string }) => void;

function installBgCmd(listImpl?: () => Promise<BgCommandListItem[]>) {
  const callbacks = new Set<ChangedCallback>();
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  const list = vi.fn(listImpl ?? (async () => [] as BgCommandListItem[]));
  const onChanged = vi.fn((callback: ChangedCallback) => {
    callbacks.add(callback);
    const unsubscribe = vi.fn(() => {
      callbacks.delete(callback);
    });
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  window.orchid = { bgCmd: { list, onChanged } } as never;
  return { list, onChanged, callbacks, unsubscribes };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useBackgroundCommands', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the fleet on mount and reports ready with running-first items', async () => {
    const items = [listItem(), listItem({ id: 2, scopeName: 'Researcher', agentScopeId: 'sub-1' })];
    const bgCmd = installBgCmd(async () => items);

    const { result } = renderHook(() => useBackgroundCommands('sess-1'));
    expect(result.current.state.status).toBe('loading');

    await flush();

    expect(bgCmd.list).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(result.current.state).toEqual({ status: 'ready', commands: items });
  });

  it('reports empty when the session has no background commands', async () => {
    installBgCmd(async () => []);

    const { result } = renderHook(() => useBackgroundCommands('sess-1'));
    await flush();

    expect(result.current.state.status).toBe('empty');
  });

  it('yields empty without IPC when there is no active session', async () => {
    const bgCmd = installBgCmd();

    const { result } = renderHook(() => useBackgroundCommands(null));
    await flush();

    expect(result.current.state.status).toBe('empty');
    expect(bgCmd.list).not.toHaveBeenCalled();
    expect(bgCmd.onChanged).not.toHaveBeenCalled();
  });

  it('refetches when a bgcmd:changed event matches the active session', async () => {
    const bgCmd = installBgCmd(async () => [listItem()]);
    const { result } = renderHook(() => useBackgroundCommands('sess-1'));
    await flush();
    expect(bgCmd.list).toHaveBeenCalledTimes(1);

    bgCmd.list.mockResolvedValue([listItem(), listItem({ id: 2 })]);
    await act(async () => {
      for (const callback of bgCmd.callbacks) callback({ sessionId: 'sess-1' });
      await Promise.resolve();
    });

    expect(bgCmd.list).toHaveBeenCalledTimes(2);
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.commands).toHaveLength(2);
  });

  it('ignores bgcmd:changed events for other sessions', async () => {
    const bgCmd = installBgCmd(async () => [listItem()]);
    renderHook(() => useBackgroundCommands('sess-1'));
    await flush();
    expect(bgCmd.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const callback of bgCmd.callbacks) callback({ sessionId: 'sess-other' });
      await Promise.resolve();
    });

    expect(bgCmd.list).toHaveBeenCalledTimes(1);
  });

  it('refetches and resubscribes when the session switches', async () => {
    const bgCmd = installBgCmd(async () => [listItem()]);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useBackgroundCommands(sessionId),
      { initialProps: { sessionId: 'sess-a' as string | null } },
    );
    await flush();
    expect(bgCmd.list).toHaveBeenLastCalledWith({ sessionId: 'sess-a' });
    expect(bgCmd.callbacks.size).toBe(1);

    rerender({ sessionId: 'sess-b' });
    expect(result.current.state.status).toBe('loading');
    await flush();

    expect(bgCmd.list).toHaveBeenLastCalledWith({ sessionId: 'sess-b' });
    expect(bgCmd.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(bgCmd.callbacks.size).toBe(1);

    // Events follow the new session only.
    await act(async () => {
      for (const callback of bgCmd.callbacks) callback({ sessionId: 'sess-a' });
      await Promise.resolve();
    });
    expect(bgCmd.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      for (const callback of bgCmd.callbacks) callback({ sessionId: 'sess-b' });
      await Promise.resolve();
    });
    expect(bgCmd.list).toHaveBeenCalledTimes(3);
  });

  it('drops to empty and unsubscribes when the session clears', async () => {
    const bgCmd = installBgCmd(async () => [listItem()]);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useBackgroundCommands(sessionId),
      { initialProps: { sessionId: 'sess-a' as string | null } },
    );
    await flush();
    expect(result.current.state.status).toBe('ready');

    rerender({ sessionId: null });
    await flush();

    expect(result.current.state.status).toBe('empty');
    expect(bgCmd.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(bgCmd.callbacks.size).toBe(0);
  });

  it('discards stale list results that land after a session switch', async () => {
    let resolveFirst!: (items: BgCommandListItem[]) => void;
    const bgCmd = installBgCmd();
    bgCmd.list
      .mockImplementationOnce(() => new Promise<BgCommandListItem[]>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ sessionId }) => useBackgroundCommands(sessionId),
      { initialProps: { sessionId: 'sess-a' as string | null } },
    );
    await flush();

    rerender({ sessionId: 'sess-b' });
    await flush();
    expect(result.current.state.status).toBe('empty');

    await act(async () => {
      resolveFirst([listItem()]);
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe('empty');
  });

  it('cleans up the subscription on unmount and guards late results', async () => {
    let resolveList!: (items: BgCommandListItem[]) => void;
    const bgCmd = installBgCmd(() => new Promise<BgCommandListItem[]>((resolve) => {
      resolveList = resolve;
    }));

    const { unmount } = renderHook(() => useBackgroundCommands('sess-1'));
    expect(bgCmd.callbacks.size).toBe(1);

    unmount();
    expect(bgCmd.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(bgCmd.callbacks.size).toBe(0);

    // The in-flight list promise resolving after unmount must not throw.
    await act(async () => {
      resolveList([listItem()]);
      await Promise.resolve();
    });
  });

  it('reports error when the list fails and recovers via refresh()', async () => {
    const bgCmd = installBgCmd(() => Promise.reject(new Error('fleet unavailable')));

    const { result } = renderHook(() => useBackgroundCommands('sess-1'));
    await flush();

    expect(result.current.state).toEqual({ status: 'error', error: 'fleet unavailable' });

    bgCmd.list.mockResolvedValue([listItem()]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.state.status).toBe('ready');
  });

  it('treats a missing bgCmd bridge as empty without throwing', async () => {
    window.orchid = {} as never;

    const { result } = renderHook(() => useBackgroundCommands('sess-1'));
    await flush();

    expect(result.current.state.status).toBe('empty');
  });
});
