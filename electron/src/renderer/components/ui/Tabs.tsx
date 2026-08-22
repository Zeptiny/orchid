import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

export type TabsVariant = 'boxed' | 'bordered' | 'lift' | 'pill';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** When true, sets aria-busy on this tab to indicate pending content. */
  ariaBusy?: boolean;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  items: readonly TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  variant?: TabsVariant;
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
}

const VARIANT_CLASS: Record<TabsVariant, string> = {
  boxed: 'tabs-boxed',
  bordered: 'tabs-bordered',
  lift: 'tabs-lift',
  pill: 'tabs-pill',
};

/** Controlled tab switcher using tabs / tab / tab-active. */
export function Tabs({
  items,
  value,
  onValueChange,
  variant = 'boxed',
  className = '',
  itemClassName = '',
  activeItemClassName = '',
  ...props
}: TabsProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (e.deltaY === 0 || root.scrollWidth <= root.clientWidth) return;
      e.preventDefault();
      root.scrollLeft += e.deltaX || e.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div
      ref={rootRef}
      role="tablist"
      className={`tabs ${VARIANT_CLASS[variant]} ${className}`.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          aria-busy={item.ariaBusy || undefined}
          className={`tab ${itemClassName} ${item.id === value ? `tab-active ${activeItemClassName}` : ''}`.trim().replace(/\s+/g, ' ')}
          onClick={() => onValueChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
