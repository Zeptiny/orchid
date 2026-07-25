import { forwardRef, type InputHTMLAttributes } from 'react';

export type TextInputSize = 'xs' | 'sm' | 'md';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: TextInputSize;
  bordered?: boolean;
  invalid?: boolean;
}

const SIZE_CLASS: Record<TextInputSize, string> = {
  xs: 'input-xs',
  sm: 'input-sm',
  md: '',
};

/** Orchid text input with size, border, and validation support. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { size = 'md', bordered = true, invalid = false, className = '', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`input ${SIZE_CLASS[size]} ${bordered ? 'input-bordered' : ''} ${invalid ? 'input-error' : ''} ${className}`
        .trim()
        .replace(/\s+/g, ' ')}
      {...props}
    />
  );
});
