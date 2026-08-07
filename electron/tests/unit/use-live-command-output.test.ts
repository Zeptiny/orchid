// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useLiveCommandOutput,
  type LiveCommandTarget,
} from '../../src/renderer/hooks/useLiveCommandOutput';
import type { BgCommandSnapshotFound } from '../../src/shared/types/ipc';

function foundSnapshot(overrides: Partial<BgCommandSnapshotFound> = {}): BgCommandSnapshotFound {
  return {
    found: true,
    tail: '',
    exitCode: null,
    running: true,
    interactive: false,
    owner: 'AGENT',
    command: 'demo',
    agentScopeId: 'main',
    ...overrides,
  };
}

describe('useLiveCommandOutput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops polling a persisted command after the first unavailable snapshot', async () => {
    const snapshot = vi.fn().mockResolvedValue({ found: false });
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 42 }, 'sess-1', true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isAvailable).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning).toBe(false);
  });

  it('keeps polling a foreground target whose mirror has not registered yet', async () => {
    // The foreground mirror registers only once the tool starts executing —
    // after the permission gate — so early snapshots report not-found. The
    // widget must keep polling instead of freezing at "unavailable".
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValue(foundSnapshot({ tail: 'server ready\n' }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ toolCallId: 'call-1' }, null, true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    // First miss does not freeze: still running, still polling.
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning).toBe(true);
    expect(result.current.isAvailable).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(snapshot.mock.calls.length).toBeGreaterThan(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(snapshot.mock.calls.length).toBeGreaterThan(2);
    expect(result.current).toMatchObject({
      output: 'server ready\n',
      isRunning: true,
      isAvailable: true,
    });
  });

  it('freezes a background target when the snapshot createdAt mismatches the persisted spawn time', async () => {
    // Restart aliasing: the background store restarts commandIds at 1, so a
    // replayed widget must reject a process whose spawn time differs from the
    // persisted spawn fact.
    const snapshot = vi.fn().mockResolvedValue(foundSnapshot({ createdAt: 2000 }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 42 }, 'sess-1', true, true, 1000),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isAvailable).toBe(false);
    expect(result.current.isRunning).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('stays live when the snapshot createdAt matches the persisted spawn time', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValue(foundSnapshot({ tail: 'up\n', createdAt: 1000 }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 42 }, 'sess-1', true, true, 1000),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      output: 'up\n',
      isRunning: true,
      isAvailable: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(snapshot.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.isAvailable).toBe(true);
  });

  it('freezes when no persisted spawn time exists and the snapshot has a createdAt value', async () => {
    // Legacy facts without createdAt must not alias onto a new live process
    // that does have a createdAt — the widget freezes as unavailable so a
    // restarted integer commandId cannot show an unrelated tail (P1 #6).
    const snapshot = vi
      .fn()
      .mockResolvedValue(foundSnapshot({ tail: 'ok\n', createdAt: 2000 }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 42 }, 'sess-1', true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isAvailable).toBe(false);
    expect(result.current.isRunning).toBe(false);
  });

  it('keeps polling a found running command and stops after it completes', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(foundSnapshot({ tail: 'building\n' }))
      .mockResolvedValueOnce(foundSnapshot({ tail: 'building\ndone\n', exitCode: 0 }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 43 }, null, true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      output: 'building\n',
      exitCode: null,
      isRunning: true,
      isAvailable: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      output: 'building\ndone\n',
      exitCode: 0,
      isRunning: false,
      isAvailable: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('sends the explicit sessionId when provided and omits it when null', async () => {
    const snapshot = vi.fn().mockResolvedValue(foundSnapshot());
    window.orchid = { bgCmd: { snapshot } } as never;

    const scoped = renderHook(() =>
      useLiveCommandOutput({ commandId: 7 }, 'sess-9', true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshot).toHaveBeenLastCalledWith({
      commandId: 7,
      lastN: 50,
      includeTail: true,
      sessionId: 'sess-9',
    });
    scoped.unmount();

    renderHook(() => useLiveCommandOutput({ commandId: 8 }, null, true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshot).toHaveBeenLastCalledWith({ commandId: 8, lastN: 50, includeTail: true });
  });

  it('targets foreground snapshots by toolCallId instead of commandId', async () => {
    const snapshot = vi.fn().mockResolvedValue(foundSnapshot({ tail: 'fg\n' }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ toolCallId: 'call-1' }, null, true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshot).toHaveBeenCalledWith({ toolCallId: 'call-1', lastN: 50, includeTail: true });
    expect(result.current.output).toBe('fg\n');
  });

  it('exposes snapshot metadata, with owner null before the first found snapshot', async () => {
    const snapshot = vi.fn().mockResolvedValue(
      foundSnapshot({
        tail: 'out\n',
        interactive: true,
        owner: 'USER',
        command: 'npm run dev',
        description: 'dev server',
        agentScopeId: 'sub-3',
      }),
    );
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 9 }, 'sess-1', true),
    );

    expect(result.current.owner).toBeNull();
    expect(result.current.interactive).toBe(false);
    expect(result.current.command).toBe('');

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      interactive: true,
      owner: 'USER',
      command: 'npm run dev',
      description: 'dev server',
      agentScopeId: 'sub-3',
    });
  });

  it('keeps status current while output refresh is disabled and catches up when re-enabled', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(foundSnapshot({ tail: 'building\n' }))
      .mockResolvedValueOnce(foundSnapshot({ tail: 'building\ndone\n', exitCode: 0 }))
      .mockResolvedValueOnce(foundSnapshot({ tail: 'building\ndone\n', exitCode: 0 }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result, rerender } = renderHook(
      ({ refreshOutput }) =>
        useLiveCommandOutput({ commandId: 44 }, null, true, refreshOutput),
      { initialProps: { refreshOutput: true } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      output: 'building\n',
      exitCode: null,
      isRunning: true,
      isAvailable: true,
    });
    expect(snapshot).toHaveBeenNthCalledWith(1, { commandId: 44, lastN: 50, includeTail: true });

    rerender({ refreshOutput: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current).toMatchObject({
      output: 'building\n',
      exitCode: 0,
      isRunning: false,
      isAvailable: true,
    });
    expect(snapshot).toHaveBeenNthCalledWith(2, { commandId: 44, lastN: 50, includeTail: false });

    rerender({ refreshOutput: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.output).toBe('building\ndone\n');
    expect(snapshot).toHaveBeenNthCalledWith(3, { commandId: 44, lastN: 50, includeTail: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('refresh() triggers an immediate poll outside the interval', async () => {
    const snapshot = vi.fn().mockResolvedValue(foundSnapshot({ tail: 'out\n' }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() =>
      useLiveCommandOutput({ commandId: 45 }, null, true),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('resets accumulated state when the target changes', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(foundSnapshot({ tail: 'first\n' }))
      .mockResolvedValueOnce(foundSnapshot({ tail: 'second\n' }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result, rerender } = renderHook(
      ({ target }) => useLiveCommandOutput(target, null, true),
      { initialProps: { target: { commandId: 1 } as LiveCommandTarget } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.output).toBe('first\n');

    rerender({ target: { commandId: 2 } });
    expect(result.current.output).toBe('');
    expect(result.current.exitCode).toBeNull();
    expect(result.current.isAvailable).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshot).toHaveBeenLastCalledWith({ commandId: 2, lastN: 50, includeTail: true });
    expect(result.current.output).toBe('second\n');
  });

  it('resets accumulated state when the owning session changes', async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(foundSnapshot({ tail: 'one\n' }))
      .mockResolvedValueOnce(foundSnapshot({ tail: 'two\n' }));
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result, rerender } = renderHook(
      ({ sessionId }) => useLiveCommandOutput({ commandId: 5 }, sessionId, true),
      { initialProps: { sessionId: 'sess-a' as string | null } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.output).toBe('one\n');

    rerender({ sessionId: 'sess-b' });
    expect(result.current.output).toBe('');

    await act(async () => {
      await Promise.resolve();
    });

    expect(snapshot).toHaveBeenLastCalledWith({
      commandId: 5,
      lastN: 50,
      includeTail: true,
      sessionId: 'sess-b',
    });
    expect(result.current.output).toBe('two\n');
  });

  it('treats a null target as disabled and never polls', async () => {
    const snapshot = vi.fn();
    window.orchid = { bgCmd: { snapshot } } as never;

    renderHook(() => useLiveCommandOutput(null, null, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).not.toHaveBeenCalled();
  });
});
