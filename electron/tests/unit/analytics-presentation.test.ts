// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTimeRange } from '../../src/renderer/hooks/useTimeRange';
import { formatCost, formatCostAmount, formatDate } from '../../src/renderer/components/analytics/shared';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('analytics presentation semantics', () => {
  it('formats costs with their actual currency instead of a hard-coded dollar sign', () => {
    expect(formatCost([])).toBe('—');
    expect(formatCostAmount('1.25', 'EUR')).toBe('EUR 1.2500');
    expect(formatCost([
      { currency: 'EUR', amount: '1.25' },
      { currency: 'USD', amount: '2' },
    ])).toBe('EUR 1.2500, USD 2.0000');
  });

  it('formats persisted timestamps in UTC', () => {
    expect(formatDate('2026-01-01T00:30:00.000Z')).toBe('2026-01-01 00:30 UTC');
  });

  it('resolves date presets to inclusive UTC boundaries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'));
    const { result } = renderHook(() => useTimeRange());

    act(() => result.current.setPreset('1d'));

    expect(result.current.startDate).toBe('2026-01-01');
    expect(result.current.endDate).toBe('2026-01-01');
    expect(result.current.resolved).toEqual({
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-01T23:59:59.999Z',
    });
  });
});
