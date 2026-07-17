import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type ButtonVariant = 'primary' | 'ghost' | 'error' | 'warning' | 'neutral' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
export type ButtonShape = 'default' | 'square' | 'circle';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode;
  icon?: IconName;
  iconRight?: IconName;
  size?: ButtonSize;
  variant?: ButtonVariant;
  shape?: ButtonShape;
  loading?: boolean;
  /** When true, collapses the label visually for icon-only patterns (kept in DOM for a11y). */
  iconOnly?: boolean;
  iconSize?: number;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  error: 'btn-error',
  warning: 'btn-warning',
  neutral: '',
  link: 'btn-link',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
};

const SHAPE_CLASS: Record<ButtonShape, string> = {
  default: '',
  square: 'btn-square',
  circle: 'btn-circle',
};

const DEFAULT_ICON_SIZE: Record<ButtonSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
};

/** DaisyUI button primitive supporting variants, sizes, shapes, loading state, and icon slots. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    icon,
    iconRight,
    size = 'sm',
    variant = 'ghost',
    shape = 'default',
    loading = false,
    iconOnly = false,
    iconSize,
    className = '',
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  const resolvedIconSize = iconSize ?? DEFAULT_ICON_SIZE[size];
  const sizeClass = SIZE_CLASS[size];
  const variantClass = VARIANT_CLASS[variant];
  const shapeClass = SHAPE_CLASS[shape];

  return (
    <button
      ref={ref}
      type={type}
      className={`btn ${sizeClass} ${variantClass} ${shapeClass} ${className}`
        .trim()
        .replace(/\s+/g, ' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span className="loading loading-spinner loading-xs" aria-hidden />
      ) : (
        icon && <Icon name={icon} size={resolvedIconSize} className="shrink-0" />
      )}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
      {iconRight && !loading && <Icon name={iconRight} size={resolvedIconSize} className="shrink-0" />}
    </button>
  );
});
