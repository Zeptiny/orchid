import type { HTMLAttributes, ReactNode } from 'react';

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'header' | 'div';
}

/** Title row with optional description and trailing actions. */
export function SectionHeader({
  title,
  description,
  actions,
  as: Tag = 'header',
  className = '',
  ...props
}: SectionHeaderProps) {
  const titleNode =
    typeof title === 'string' || typeof title === 'number' ? (
      <div className="text-sm font-semibold tracking-tight text-base-content">{title}</div>
    ) : (
      title
    );

  return (
    <Tag
      className={`orchid-section-header flex items-start justify-between gap-3 ${className}`.trim()}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <div className="orchid-section-title">{titleNode}</div>
        {description != null && description !== false && (
          <div className="orchid-section-description mt-1 text-sm text-base-content/70">
            {description}
          </div>
        )}
      </div>
      {actions != null && actions !== false && (
        <div className="orchid-section-actions flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </Tag>
  );
}
