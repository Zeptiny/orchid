import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type StateMessageKind = 'empty' | 'loading' | 'error' | 'info' | 'warning';

export interface StateMessageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  kind?: StateMessageKind;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}

const KIND_DEFAULT_ICON: Record<StateMessageKind, IconName | null> = {
  empty: 'inbox',
  loading: 'loader',
  error: 'alertCircle',
  info: 'alert',
  warning: 'alert',
};

const KIND_CLASS: Record<StateMessageKind, string> = {
  empty: 'text-base-content/50',
  loading: 'text-base-content/60',
  error: 'text-error',
  info: 'text-base-content/70',
  warning: 'text-warning',
};

/** Centered empty / loading / error copy for lists and panels. */
export function StateMessage({
  kind = 'empty',
  title,
  children,
  action,
  icon,
  className = '',
  role,
  ...props
}: StateMessageProps) {
  const resolvedIcon = icon ?? KIND_DEFAULT_ICON[kind];
  const resolvedRole = role ?? (kind === 'error' || kind === 'warning' ? 'alert' : undefined);

  return (
    <div
      className={`orchid-state-message flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm ${KIND_CLASS[kind]} ${className}`
        .trim()
        .replace(/\s+/g, ' ')}
      role={resolvedRole}
      {...props}
    >
      {kind === 'loading' ? (
        <span className="loading loading-spinner" aria-hidden />
      ) : (
        resolvedIcon && <Icon name={resolvedIcon} size={20} className="opacity-70" />
      )}
      {title != null && title !== false && (
        <div className="font-medium text-base-content/80">{title}</div>
      )}
      {children != null && children !== false && <div className="max-w-sm text-xs opacity-90">{children}</div>}
      {action != null && action !== false && <div className="mt-1">{action}</div>}
    </div>
  );
}
