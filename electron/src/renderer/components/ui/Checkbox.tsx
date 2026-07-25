import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type CheckboxSize = 'xs' | 'sm' | 'md';
export type CheckboxTone = 'primary' | 'secondary' | 'accent' | 'neutral' | 'error' | 'success' | 'warning';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  size?: CheckboxSize;
  tone?: CheckboxTone;
  /** When provided, wraps the checkbox in a label row with this text. */
  label?: ReactNode;
  /** Controlled indeterminate state. */
  indeterminate?: boolean;
}

const SIZE_CLASS: Record<CheckboxSize, string> = {
  xs: 'checkbox-xs',
  sm: 'checkbox-sm',
  md: '',
};

const TONE_CLASS: Record<CheckboxTone, string> = {
  primary: 'checkbox-primary',
  secondary: 'checkbox-secondary',
  accent: 'checkbox-accent',
  neutral: '',
  error: 'checkbox-error',
  success: 'checkbox-success',
  warning: 'checkbox-warning',
};

/** Orchid checkbox with size, tone, optional label, and indeterminate support. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { size = 'md', tone = 'neutral', label, indeterminate = false, className = '', ...props },
  ref,
) {
  const internalRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (internalRef.current) {
      internalRef.current.indeterminate = indeterminate ?? false;
    }
  }, [indeterminate]);

  const setRef = (el: HTMLInputElement | null) => {
    internalRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const inputClassName = `checkbox ${SIZE_CLASS[size]} ${TONE_CLASS[tone]} ${className}`
    .trim()
    .replace(/\s+/g, ' ');

  const input = (
    <input ref={setRef} type="checkbox" className={inputClassName} {...props} />
  );

  if (label != null) {
    return (
      <label className="label cursor-pointer gap-2 justify-start">
        {input}
        <span className="label-text">{label}</span>
      </label>
    );
  }

  return input;
});
