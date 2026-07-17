import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';
export type AlertVariant = 'default' | 'block' | 'outline' | 'soft';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  variant?: AlertVariant;
  icon?: IconName;
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}

const TONE_CLASS: Record<AlertTone, string> = {
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  error: 'alert-error',
};

const VARIANT_CLASS: Record<AlertVariant, string> = {
  default: '',
  block: 'alert-block',
  outline: 'alert-outline',
  soft: 'alert-soft',
};

/** DaisyUI alert with optional icon, title, body, and action slot. */
export function Alert({
  tone = 'info',
  variant = 'default',
  icon,
  title,
  action,
  children,
  className = '',
  role = 'alert',
  ...props
}: AlertProps) {
  return (
    <div
      role={role}
      className={`alert ${TONE_CLASS[tone]} ${VARIANT_CLASS[variant]} ${className}`.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      {icon != null && <Icon name={icon} size={18} className="shrink-0" aria-hidden />}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        {title != null && <div className="font-medium text-sm">{title}</div>}
        {children}
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  );
}
