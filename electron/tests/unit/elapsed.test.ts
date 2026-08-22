// @vitest-environment jsdom
/**
 * Unit tests for the shared elapsed-timer hook (issues #139/#140).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { formatDurationMs, useElapsedMs } from '../../src/renderer/utils/elapsed';

describe('formatDurationMs', () => {
  it('formats sub-second, seconds, and minutes', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(210)).toBe('210ms');
    expect(formatDurationMs(1500)).toBe('1.5s');
    expect(formatDurationMs(59_999)).toBe('60.0s');
    expect(formatDurationMs(65_000)).toBe('1m 05s');
    expect(formatDurationMs(3_723_000)).toBe('62m 03s');
  });

  it('clamps negative values', () => {
    expect(formatDurationMs(-40)).toBe('0ms');
  });
});

describe('useElapsedMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null without a start stamp (no invented duration)', () => {
    const { result } = renderHook(() => useElapsedMs({ startedAt: null, endedAt: null }));
    expect(result.current).toBeNull();
  });

  it('freezes at endedAt - startedAt once settled', () => {
    const startedAt = new Date(Date.parse('2026-08-21T11:59:50.000Z')).toISOString();
    const endedAt = new Date(Date.parse('2026-08-21T11:59:52.000Z')).toISOString();
    const { result } = renderHook(() => useElapsedMs({ startedAt, endedAt }));
    expect(result.current).toBe(2000);
  });

  it('ticks while live and freezes on settle', () => {
    const startedAt = new Date(Date.parse('2026-08-21T11:59:59.500Z')).toISOString();
    const initial = renderHook(
      ({ endedAt }) => useElapsedMs({ startedAt, endedAt }),
      { initialProps: { endedAt: null as string | null } },
    );
    expect(initial.result.current).toBe(500);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(initial.result.current).toBe(800);

    const endedAt = new Date(Date.parse('2026-08-21T11:59:59.900Z')).toISOString();
    initial.rerender({ endedAt });
    expect(initial.result.current).toBe(400);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(initial.result.current).toBe(400);
  });
});
