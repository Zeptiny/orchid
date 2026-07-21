import { useMemo } from 'react';
import { PopoverList, type PopoverListOption } from '../ui/PopoverList';
import type { PopoverAlign } from '../ui/usePopoverListbox';

export interface ReasoningEffortPickerProps {
  /** Configured reasoning levels for the selected model (never hardcoded). */
  readonly levels: readonly string[];
  /** Current effort; null/undefined inherits the connection default. */
  readonly value: string | number | null | undefined;
  readonly onChange: (value: string | number | null) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly align?: PopoverAlign;
  readonly className?: string;
}

const INHERIT_VALUE = '';

/**
 * Model-picker style dropdown of a model's configured reasoning levels. The
 * "Default" entry inherits the connection default; levels are supplied by the
 * caller from the selected model's connection reasoningConfig.
 */
export function ReasoningEffortPicker({
  levels,
  value,
  onChange,
  disabled = false,
  label = 'Reasoning effort',
  align = 'start',
  className = '',
}: ReasoningEffortPickerProps) {
  const current = value == null ? INHERIT_VALUE : String(value);
  // A numeric value that is not one of the configured levels is shown as a
  // synthesized "Custom token budget" entry; selecting it must forward the
  // original number, not its display string.
  const customNumeric = typeof value === 'number' && !levels.includes(current) ? value : null;

  const options = useMemo<readonly PopoverListOption[]>(() => {
    const list: PopoverListOption[] = [
      {
        value: INHERIT_VALUE,
        label: 'Default',
        description: 'Use the connection default effort',
      },
      ...levels.map((level) => ({ value: level, label: level })),
    ];
    if (current !== INHERIT_VALUE && !levels.includes(current)) {
      list.push({ value: current, label: current, description: 'Custom token budget' });
    }
    return list;
  }, [current, levels]);

  return (
    <PopoverList
      value={current}
      options={options}
      onChange={(next) => {
        if (next === INHERIT_VALUE) onChange(null);
        else if (next === current && customNumeric !== null) onChange(customNumeric);
        else onChange(next);
      }}
      label={label}
      title="Reasoning effort"
      searchPlaceholder="Search levels…"
      emptyMessage="No reasoning levels configured"
      disabled={disabled}
      align={align}
      className={className}
      menuClassName="tier-picker-menu searchable-picker-menu"
      triggerIcon="zap"
    />
  );
}
