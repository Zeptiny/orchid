import type { HTMLAttributes, ReactNode } from 'react';

export interface CollapsibleRegionProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  children: ReactNode;
  contentClassName?: string;
}

/**
 * Keeps disclosure content mounted while animating its visible height.
 * Presentational only — the owning control supplies aria-expanded/controls.
 */
export function CollapsibleRegion({
  open,
  children,
  className = '',
  contentClassName = '',
  ...props
}: CollapsibleRegionProps) {
  const regionClasses = `orchid-collapsible-region ${open ? 'is-open' : ''} ${className}`
    .trim()
    .replace(/\s+/g, ' ');
  const contentClasses = `orchid-collapsible-region-inner ${contentClassName}`
    .trim()
    .replace(/\s+/g, ' ');

  return (
    <div
      className={regionClasses}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      {...props}
    >
      <div className={contentClasses}>{children}</div>
    </div>
  );
}
