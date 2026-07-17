import type { HTMLAttributes, ReactNode } from 'react';

export type PanelTone = 'default' | 'raised' | 'muted';

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  tone?: PanelTone;
  /** Render as a semantic section when the panel is a labeled landmark. */
  as?: 'div' | 'section' | 'aside' | 'article';
  padded?: boolean;
}

const TONE_CLASS: Record<PanelTone, string> = {
  default: 'bg-base-100 border border-base-300',
  raised: 'bg-base-200 border border-base-300',
  muted: 'bg-base-200/60 border border-base-300/80',
};

/** Presentational surface for sidebar/settings regions. */
export function Panel({
  children,
  tone = 'default',
  as: Tag = 'div',
  padded = true,
  className = '',
  ...props
}: PanelProps) {
  return (
    <Tag
      className={`orchid-panel rounded-box ${TONE_CLASS[tone]} ${padded ? 'p-3' : ''} ${className}`.trim().replace(/\s+/g, ' ')}
      {...props}
    >
      {children}
    </Tag>
  );
}
