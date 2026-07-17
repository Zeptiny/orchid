import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type IconButtonSize = 'xs' | 'sm' | 'md';
export type IconButtonVariant = 'ghost' | 'primary' | 'error' | 'warning' | 'neutral';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name — required for icon-only buttons. */
  label: string;
  icon?: IconName;
  /** Optional visible label; when set, icon is decorative. */
  children?: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  loading?: boolean;
  /** Tooltip; defaults to `label` for icon-only controls. */
  tooltip?: string;
  iconSize?: number;
}

const SIZE_CLASS: Record<IconButtonSize, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
};

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  ghost: 'btn-ghost',
  primary: 'btn-primary',
  error: 'btn-error',
  warning: 'btn-warning',
  neutral: '',
};

const DEFAULT_ICON_SIZE: Record<IconButtonSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
};

/** Accessible icon (or icon+text) control with consistent DaisyUI button chrome. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    children,
    size = 'sm',
    variant = 'ghost',
    loading = false,
    tooltip,
    iconSize,
    className = '',
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  const isIconOnly = children == null || children === false;
  const resolvedTooltip = tooltip ?? (isIconOnly ? label : undefined);
  const resolvedIconSize = iconSize ?? DEFAULT_ICON_SIZE[size];
  const sizeClass = SIZE_CLASS[size];
  const variantClass = VARIANT_CLASS[variant];
  // Prefer explicit square/circle from className; default icon-only to circle.
  const hasShapeOverride = /\bbtn-(?:square|circle)\b/.test(className);
  const shapeClass = isIconOnly && !hasShapeOverride ? 'btn-circle' : '';

  return (
    <button
      ref={ref}
      type={type}
      className={`btn ${sizeClass} ${variantClass} ${shapeClass} ${className}`.trim().replace(/\s+/g, ' ')}
      aria-label={label}
      title={resolvedTooltip}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span className="loading loading-spinner loading-xs" aria-hidden />
      ) : (
        icon && <Icon name={icon} size={resolvedIconSize} className={isIconOnly ? undefined : 'shrink-0'} />
      )}
      {children}
    </button>
  );
});
