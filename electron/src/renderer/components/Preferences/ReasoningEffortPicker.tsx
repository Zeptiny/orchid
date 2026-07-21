import { Select } from '../ui/Select';

export interface ReasoningEffortPickerProps {
  /** Configured reasoning levels for the selected model (never hardcoded). */
  readonly levels: readonly string[];
  /** Current effort; null/undefined inherits the connection default. */
  readonly value: string | number | null | undefined;
  readonly onChange: (value: string | null) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly className?: string;
}

/**
 * Dropdown of a model's configured reasoning levels. The empty value inherits
 * the connection default; levels are supplied by the caller from the selected
 * model's connection reasoningConfig.
 */
export function ReasoningEffortPicker({
  levels,
  value,
  onChange,
  disabled = false,
  label = 'Reasoning effort',
  className = '',
}: ReasoningEffortPickerProps) {
  return (
    <Select
      aria-label={label}
      size="sm"
      bordered
      className={className}
      value={value == null ? '' : String(value)}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === '' ? null : raw);
      }}
    >
      <option value="">Default</option>
      {levels.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </Select>
  );
}
