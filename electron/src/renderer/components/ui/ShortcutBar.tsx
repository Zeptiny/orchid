import type { HTMLAttributes, ReactNode } from 'react';
import type { KeyChord } from '../../keyboard';
import { Keycaps } from '../Keycaps';

export interface ShortcutBarItem {
  readonly chord: KeyChord | string | ReadonlyArray<KeyChord | string>;
  readonly label: ReactNode;
}

export interface ShortcutBarProps extends HTMLAttributes<HTMLElement> {
  items: readonly ShortcutBarItem[];
  trailing?: ReactNode;
  size?: 'xs' | 'sm' | 'md';
  as?: 'footer' | 'div' | 'nav';
}

/** Compact footer/hint bar of keycap + label pairs. */
export function ShortcutBar({
  items,
  trailing,
  size = 'xs',
  as: Tag = 'div',
  className = '',
  ...props
}: ShortcutBarProps) {
  return (
    <Tag className={`orchid-shortcut-bar ${className}`.trim()} {...props}>
      {items.map((item, index) => {
        const chords = Array.isArray(item.chord) ? item.chord : [item.chord];
        return (
          <span key={index} className="orchid-shortcut-bar-item">
            {chords.map((chord, chordIndex) => (
              <Keycaps key={`${index}-${chordIndex}`} chord={chord} size={size} />
            ))}
            <span>{item.label}</span>
          </span>
        );
      })}
      {trailing != null && trailing !== false && trailing}
    </Tag>
  );
}
