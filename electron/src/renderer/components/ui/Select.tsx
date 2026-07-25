import { forwardRef, type SelectHTMLAttributes } from 'react';

export type SelectSize = 'xs' | 'sm' | 'md';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: SelectSize;
  bordered?: boolean;
  invalid?: boolean;
}

const SIZE_CLASS: Record<SelectSize, string> = {
  xs: 'select-xs',
  sm: 'select-sm',
  md: '',
};

/** Orchid select with size, border, and validation support. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', bordered = true, invalid = false, className = '', children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`select ${SIZE_CLASS[size]} ${bordered ? 'select-bordered' : ''} ${invalid ? 'select-error' : ''} ${className}`
        .trim()
        .replace(/\s+/g, ' ')}
      {...props}
    >
      {children}
    </select>
  );
});
