import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';

export interface CollapsibleRegionProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  children: ReactNode;
  contentClassName?: string;
  /** Defer the initial child mount until this region is first opened. */
  lazyMount?: boolean;
}

/**
 * Keeps disclosure content mounted while animating its visible height.
 * Lazy regions defer their children until first opened, then retain them.
 * Presentational only — the owning control supplies aria-expanded/controls.
 */
export function CollapsibleRegion({
  open,
  children,
  className = '',
  contentClassName = '',
  lazyMount = false,
  ...props
}: CollapsibleRegionProps) {
  const [hasOpened, setHasOpened] = useState(open);

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

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
      <div className={contentClasses}>{(!lazyMount || open || hasOpened) ? children : null}</div>
    </div>
  );
}
