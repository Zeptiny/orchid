import type { HTMLAttributes, ReactNode } from 'react';

export type ConfigCardVariant = 'default' | 'active';
export type ConfigCardBodyVariant = 'stack' | 'row';

export interface ConfigCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: ConfigCardVariant;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface ConfigCardBodyProps extends HTMLAttributes<HTMLDivElement> {
  variant?: ConfigCardBodyVariant;
}

const VARIANT_CLASS: Record<ConfigCardVariant, string> = {
  default: 'bg-base-100 border border-base-300',
  active: 'border border-primary/30 bg-primary/5',
};

/** Config card chrome with title, description, and actions slot. */
function ConfigCardRoot({
  variant = 'default',
  title,
  description,
  actions,
  children,
  className = '',
  ...props
}: ConfigCardProps) {
  return (
    <div
      className={`config-card card ${VARIANT_CLASS[variant]} ${className}`.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      {title != null && (
        <div className="flex items-start justify-between gap-3 p-4 pb-0">
          <div className="min-w-0 flex-1">
            <div className="config-card-title text-sm font-semibold tracking-tight text-base-content">{title}</div>
            {description != null && (
              <div className="config-card-desc mt-1 text-sm text-base-content/70">{description}</div>
            )}
          </div>
          {actions != null && (
            <div className="config-card-actions flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** Body slot for ConfigCard content; supports stacked or row layout. */
function ConfigCardBody({
  variant = 'stack',
  className = '',
  ...props
}: ConfigCardBodyProps) {
  const bodyClass = variant === 'row'
    ? 'config-card-row card-body p-4 flex-row items-center gap-4'
    : 'card-body p-4';
  return (
    <div className={`${bodyClass} ${className}`.trim().replace(/\s+/g, ' ')} {...props} />
  );
}

/** Config card with header/title/actions and a body slot. */
export const ConfigCard = Object.assign(ConfigCardRoot, {
  Body: ConfigCardBody,
});
