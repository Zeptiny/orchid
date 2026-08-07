import { useState, useCallback, useMemo } from 'react';
import type { AnalyticsTimeRange } from '../../shared/types/analytics';

export type TimeRangePreset = '1d' | '7d' | '1m' | '6m' | '1y' | 'all';

export interface UseTimeRangeReturn {
  preset: TimeRangePreset | 'custom';
  startDate: string;
  endDate: string;
  setPreset: (preset: TimeRangePreset) => void;
  setStartDate: (date: string) => void;
  setEndDate: (date: string) => void;
  resolved: AnalyticsTimeRange;
}

export const TIME_RANGE_PRESETS: ReadonlyArray<{ id: TimeRangePreset; label: string }> = [
  { id: '1d', label: '1D' },
  { id: '7d', label: '7D' },
  { id: '1m', label: '1M' },
  { id: '6m', label: '6M' },
  { id: '1y', label: '1Y' },
  { id: 'all', label: 'All' },
];

function toDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function computePresetDates(preset: TimeRangePreset): { startDate: string; endDate: string } {
  if (preset === 'all') return { startDate: '', endDate: '' };

  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  switch (preset) {
    case '1d':
      break;
    case '7d':
      start.setUTCDate(start.getUTCDate() - 6);
      break;
    case '1m':
      start.setUTCMonth(start.getUTCMonth() - 1);
      break;
    case '6m':
      start.setUTCMonth(start.getUTCMonth() - 6);
      break;
    case '1y':
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      break;
  }

  return { startDate: toDateString(start), endDate: toDateString(end) };
}

function toIsoStart(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return `${dateStr}T00:00:00.000Z`;
}

function toIsoEnd(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return `${dateStr}T23:59:59.999Z`;
}

const EMPTY_RANGE: AnalyticsTimeRange = {};

export function useTimeRange(): UseTimeRangeReturn {
  const initial = computePresetDates('all');
  const [preset, setPresetState] = useState<TimeRangePreset | 'custom'>('all');
  const [startDate, setStartDateState] = useState(initial.startDate);
  const [endDate, setEndDateState] = useState(initial.endDate);

  const setPreset = useCallback((p: TimeRangePreset) => {
    const dates = computePresetDates(p);
    setPresetState(p);
    setStartDateState(dates.startDate);
    setEndDateState(dates.endDate);
  }, []);

  const setStartDate = useCallback((date: string) => {
    setPresetState('custom');
    setStartDateState(date);
  }, []);

  const setEndDate = useCallback((date: string) => {
    setPresetState('custom');
    setEndDateState(date);
  }, []);

  const resolved = useMemo((): AnalyticsTimeRange => {
    if (preset === 'all') return EMPTY_RANGE;
    return {
      startDate: toIsoStart(startDate),
      endDate: toIsoEnd(endDate),
    };
  }, [preset, startDate, endDate]);

  return { preset, startDate, endDate, setPreset, setStartDate, setEndDate, resolved };
}
