/**
 * Styled keycap cluster for shortcut chords (e.g. Ctrl + K).
 */
import type { KeyChord } from '../keyboard';
import { formatChord } from '../keyboard';

type KeycapSize = 'xs' | 'sm' | 'md';

interface KeycapsProps {
  /** Chord object or preformatted string ("Ctrl K"). */
  chord: KeyChord | string;
  size?: KeycapSize;
  className?: string;
}

const SIZE_CLASS: Record<KeycapSize, string> = {
  xs: 'orchid-keycap-xs',
  sm: 'orchid-keycap-sm',
  md: 'orchid-keycap-md',
};

export function Keycaps({ chord, size = 'sm', className = '' }: KeycapsProps) {
  const label = typeof chord === 'string' ? chord : formatChord(chord);
  const parts = label.split(/\s+/).filter(Boolean);

  return (
    <span className={`orchid-keycaps ${SIZE_CLASS[size]} ${className}`.trim()}>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="orchid-keycaps-unit">
          {index > 0 && (
            <span className="orchid-keycaps-sep" aria-hidden>
              +
            </span>
          )}
          <kbd className="orchid-keycap">{part}</kbd>
        </span>
      ))}
    </span>
  );
}
