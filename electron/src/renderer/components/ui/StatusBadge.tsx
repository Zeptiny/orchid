import type { HTMLAttributes, ReactNode } from 'react';

export type StatusBadgeTone = 'neutral' | 'ghost' | 'info' | 'success' | 'warning' | 'error' | 'primary';
export type StatusBadgeSize = 'xs' | 'sm' | 'md';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: StatusBadgeTone;
  size?: StatusBadgeSize;
  outline?: boolean;
  /** Soft status dot before the label (DaisyUI status). */
  withDot?: boolean;
}

const TONE_CLASS: Record<StatusBadgeTone, string> = {
  neutral: '',
  ghost: 'badge-ghost',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  primary: 'badge-primary',
};

const SIZE_CLASS: Record<StatusBadgeSize, string> = {
  xs: 'badge-xs',
  sm: 'badge-sm',
  md: '',
};

const DOT_TONE_CLASS: Record<StatusBadgeTone, string> = {
  neutral: 'status-neutral',
  ghost: 'status-neutral',
  info: 'status-info',
  success: 'status-success',
  warning: 'status-warning',
  error: 'status-error',
  primary: 'status-primary',
};

/** Compact status label using DaisyUI badge (+ optional status dot). */
export function StatusBadge({
  children,
  tone = 'neutral',
  size = 'sm',
  outline = false,
  withDot = false,
  className = '',
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={`badge ${SIZE_CLASS[size]} ${TONE_CLASS[tone]} ${outline ? 'badge-outline' : ''} ${className}`
        .trim()
        .replace(/\s+/g, ' ')}
      {...props}
    >
      {withDot && <span className={`status ${DOT_TONE_CLASS[tone]} status-xs`} aria-hidden />}
      {children}
    </span>
  );
}
