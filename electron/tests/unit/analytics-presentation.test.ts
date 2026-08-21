// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTimeRange } from '../../src/renderer/hooks/useTimeRange';
import {
  formatCost,
  formatCostAmount,
  formatDate,
  formatTps,
  formatTtft,
  dateSortValue,
  maxCostAmount,
  netInputTokens,
  netOutputTokens,
  tokenStackTooltipRows,
} from '../../src/renderer/components/analytics/shared';

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

describe('stacked-token netting helpers', () => {
  it('nets input and output tokens, clamping at zero', () => {
    expect(netInputTokens(1200, 300)).toBe(900);
    expect(netInputTokens(300, 1200)).toBe(0);
    expect(netOutputTokens(900, 200)).toBe(700);
    expect(netOutputTokens(200, 900)).toBe(0);
  });

  it('builds stacked-token tooltip rows in the shared order with exact names', () => {
    expect(tokenStackTooltipRows(1200, 300, 900, 200)).toEqual([
      { name: 'Input (net of cache)', value: 900 },
      { name: 'Cache Read', value: 300 },
      { name: 'Output (net of reasoning)', value: 700 },
      { name: 'Reasoning', value: 200 },
      { name: 'Input (raw)', value: 1200 },
      { name: 'Output (raw)', value: 900 },
    ]);
  });

  it('formats throughput and time-to-first-token', () => {
    expect(formatTps(null)).toBe('—');
    expect(formatTps(12.34)).toBe('12.3 tok/s');
    expect(formatTtft(null)).toBe('—');
    expect(formatTtft(0)).toBe('—');
    expect(formatTtft(450)).toBe('450ms');
    expect(formatTtft(2345)).toBe('2.3s');
  });
});

describe('analytics table sort helpers', () => {
  it('maxCostAmount returns the largest cost across currencies, empty → 0', () => {
    expect(maxCostAmount([])).toBe(0);
    expect(maxCostAmount([{ currency: 'USD', amount: '1.25' }])).toBe(1.25);
    expect(maxCostAmount([
      { currency: 'EUR', amount: '1.5' },
      { currency: 'USD', amount: '3.75' },
      { currency: 'JPY', amount: '2' },
    ])).toBe(3.75);
  });

  it('maxCostAmount clamps negatives so they never lead a descending sort', () => {
    expect(maxCostAmount([{ currency: 'USD', amount: '-2' }])).toBe(0);
    expect(maxCostAmount([
      { currency: 'USD', amount: '-2' },
      { currency: 'EUR', amount: '0.5' },
    ])).toBe(0.5);
  });

  it('dateSortValue maps null and unparseable strings to 0 and valid ISO to positive ms', () => {
    expect(dateSortValue(null)).toBe(0);
    expect(dateSortValue('not-a-date')).toBe(0);
    expect(dateSortValue('2026-01-01T00:30:00.000Z')).toBe(Date.parse('2026-01-01T00:30:00.000Z'));
    expect(dateSortValue('2026-01-01T00:30:00.000Z')).toBeGreaterThan(0);
  });

  it('dateSortValue orders ISO-8601 stamps chronologically, matching lexicographic order', () => {
    const stamps = [
      '2026-01-02T00:00:00.000Z',
      '2025-12-31T23:59:59.999Z',
      '2026-06-15T10:20:30.400Z',
      '2026-01-02T00:00:00.100Z',
    ];
    const byLexicographic = [...stamps].sort();
    const byDateSortValue = [...stamps].sort((a, b) => dateSortValue(a) - dateSortValue(b));
    expect(byDateSortValue).toEqual(byLexicographic);

    // null sorts as 0 — below any post-epoch timestamp.
    expect(dateSortValue(null)).toBeLessThan(dateSortValue(stamps[1]));
  });
});
