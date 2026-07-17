import { type HTMLAttributes, type ReactNode } from 'react';

export type TabsVariant = 'boxed' | 'bordered' | 'lift' | 'pill';

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  items: readonly TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  variant?: TabsVariant;
  className?: string;
}

const VARIANT_CLASS: Record<TabsVariant, string> = {
  boxed: 'tabs-boxed',
  bordered: 'tabs-bordered',
  lift: 'tabs-lift',
  pill: 'tabs-pill',
};

/** Controlled tab switcher using DaisyUI tabs / tab / tab-active. */
export function Tabs({
  items,
  value,
  onValueChange,
  variant = 'boxed',
  className = '',
  ...props
}: TabsProps) {
  return (
    <div
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
          className={`tab ${item.id === value ? 'tab-active' : ''}`.trim().replace(/\s+/g, ' ')}
          onClick={() => onValueChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
