import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { TIME_RANGE_PRESETS, type UseTimeRangeReturn } from '../../hooks/useTimeRange';

interface TimeRangeSelectorProps {
  timeRange: UseTimeRangeReturn;
}

export function TimeRangeSelector({ timeRange }: TimeRangeSelectorProps) {
  const { preset, startDate, endDate, setPreset, setStartDate, setEndDate } = timeRange;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-200/50 px-4 py-2">
      <div className="flex items-center gap-1">
        {TIME_RANGE_PRESETS.map((p) => (
          <Button
            key={p.id}
            size="xs"
            variant={preset === p.id ? 'primary' : 'ghost'}
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="mx-1 h-4 w-px bg-base-300" />

      <div className="flex items-center gap-1.5">
        <TextInput
          type="date"
          size="xs"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          max={endDate || undefined}
        />
        <span className="text-xs text-base-content/50">→</span>
        <TextInput
          type="date"
          size="xs"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          min={startDate || undefined}
        />
      </div>

      {preset === 'custom' && (
        <span className="text-xs text-base-content/40">Custom range</span>
      )}
      <span className="ml-auto text-xs font-medium text-base-content/40">UTC</span>
    </div>
  );
}
