import type { HTMLAttributes } from 'react';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';
export type SpinnerVariant = 'spinner' | 'dots' | 'ring' | 'ball' | 'bars' | 'infinity';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
}

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: 'loading-xs',
  sm: 'loading-sm',
  md: '',
  lg: 'loading-lg',
};

/** DaisyUI loading spinner with configurable size and animation variant. */
export function Spinner({
  size = 'sm',
  variant = 'spinner',
  className = '',
  ...props
}: SpinnerProps) {
  const isDecorative = props['aria-hidden'] === true || props['aria-hidden'] === 'true';
  return (
    <span
      className={`loading loading-${variant} ${SIZE_CLASS[size]} ${className}`.trim().replace(/\s+/g, ' ')}
      role={!isDecorative ? 'status' : undefined}
      aria-label={!isDecorative ? 'Loading' : undefined}
      {...props}
    />
  );
}
