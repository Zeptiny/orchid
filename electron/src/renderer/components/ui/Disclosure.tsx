import type { DetailsHTMLAttributes, ReactNode } from 'react';

export interface DisclosureProps
  extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children' | 'title'> {
  summary: ReactNode;
  children: ReactNode;
  variant?: 'default' | 'section' | 'card';
  summaryClassName?: string;
  contentClassName?: string;
}

const VARIANT_CLASS = {
  default: '',
  section: 'rounded-none border-y border-base-300',
  card: 'rounded-md border border-base-300 bg-base-100',
} as const;

const VARIANT_SUMMARY_CLASS = {
  default: '',
  section: 'px-3 py-2 text-sm font-medium',
  card: '',
} as const;

const VARIANT_CONTENT_CLASS = {
  default: '',
  section: 'px-3 pb-3',
  card: '',
} as const;

/** Native, keyboard-accessible disclosure with collapse styling. */
export function Disclosure({
  summary,
  children,
  variant = 'default',
  className = '',
  summaryClassName = '',
  contentClassName = '',
  ...props
}: DisclosureProps) {
  return (
    <details
      className={`collapse collapse-arrow ${VARIANT_CLASS[variant]} ${className}`.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      <summary
        className={`collapse-title min-h-0 ${VARIANT_SUMMARY_CLASS[variant]} ${summaryClassName}`.trim().replace(/\s+/g, ' ')}
      >
        {summary}
      </summary>
      <div
        className={`collapse-content ${VARIANT_CONTENT_CLASS[variant]} ${contentClassName}`.trim().replace(/\s+/g, ' ')}
      >
        {children}
      </div>
    </details>
  );
}
