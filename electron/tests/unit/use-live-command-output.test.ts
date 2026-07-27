// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveCommandOutput } from '../../src/renderer/hooks/useLiveCommandOutput';

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

    const { result } = renderHook(() => useLiveCommandOutput(42, true));

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

  it('keeps polling a found running command and stops after it completes', async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce({ found: true, tail: 'building\\n', exitCode: null })
      .mockResolvedValueOnce({ found: true, tail: 'building\\ndone\\n', exitCode: 0 });
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result } = renderHook(() => useLiveCommandOutput(43, true));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      output: 'building\\n',
      exitCode: null,
      isRunning: true,
      isAvailable: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      output: 'building\\ndone\\n',
      exitCode: 0,
      isRunning: false,
      isAvailable: true,
    });
  });

  it('keeps status current while output refresh is disabled and catches up when re-enabled', async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce({ found: true, tail: 'building\\n', exitCode: null })
      .mockResolvedValueOnce({ found: true, tail: 'building\\ndone\\n', exitCode: 0 })
      .mockResolvedValueOnce({ found: true, tail: 'building\\ndone\\n', exitCode: 0 });
    window.orchid = { bgCmd: { snapshot } } as never;

    const { result, rerender } = renderHook(
      ({ refreshOutput }) => useLiveCommandOutput(44, true, refreshOutput),
      { initialProps: { refreshOutput: true } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toMatchObject({
      output: 'building\\n',
      exitCode: null,
      isRunning: true,
      isAvailable: true,
    });
    expect(snapshot).toHaveBeenNthCalledWith(1, { commandId: 44, lastN: 50 });

    rerender({ refreshOutput: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current).toMatchObject({
      output: 'building\\n',
      exitCode: 0,
      isRunning: false,
      isAvailable: true,
    });

    rerender({ refreshOutput: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.output).toBe('building\\ndone\\n');
    expect(snapshot).toHaveBeenNthCalledWith(3, { commandId: 44, lastN: 50 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(snapshot).toHaveBeenCalledTimes(3);
  });
});
