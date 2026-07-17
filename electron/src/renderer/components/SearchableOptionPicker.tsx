import { PopoverList } from './ui/PopoverList';

export interface SearchableOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SearchableOptionPickerProps {
  readonly id?: string;
  readonly value: string;
  readonly options: readonly SearchableOption[];
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly title: string;
  readonly searchPlaceholder: string;
  readonly emptyMessage: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

/** Compact searchable list picker used for provider presets in setup flows. */
export function SearchableOptionPicker({
  id,
  value,
  options,
  onChange,
  label,
  title,
  searchPlaceholder,
  emptyMessage,
  className = '',
  disabled = false,
}: SearchableOptionPickerProps) {
  return (
    <PopoverList
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      title={title}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      className={className}
      disabled={disabled}
      triggerIcon="globe"
      align="start"
      placement="bottom"
    />
  );
}
