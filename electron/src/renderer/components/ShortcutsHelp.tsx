/**
 * Keyboard shortcuts help modal — content from the central registry.
 */
import { useRef } from 'react';
import { formatShortcut, groupShortcutsForHelp } from '../keyboard';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';
import { DialogSurface } from './ui/DialogSurface';
import { IconButton } from './ui/IconButton';

interface ShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ isOpen, onClose }: ShortcutsHelpProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  if (!isOpen) return null;

  const groups = groupShortcutsForHelp();

  return (
    <DialogSurface
      isOpen={isOpen}
      onClose={onClose}
      label="Keyboard shortcuts"
      initialFocusRef={closeRef}
      overlayClassName="shortcuts-help-overlay"
      panelClassName="shortcuts-help-dialog"
      variant="overlay"
    >
      <header className="shortcuts-help-header">
        <div className="shortcuts-help-title-block">
          <span className="shortcuts-help-icon-wrap" aria-hidden>
            <Icon name="command" size={15} />
          </span>
          <div className="shortcuts-help-title-text">
            <h2>Keyboard shortcuts</h2>
            <p>Navigate Orchid without leaving the keyboard</p>
          </div>
        </div>
        <IconButton
          ref={closeRef}
          label="Close"
          icon="x"
          size="sm"
          className="shortcuts-help-close"
          onClick={onClose}
          iconSize={14}
        />
      </header>

      <div className="shortcuts-help-body">
        {groups.map((g) => (
          <section key={g.group} className="shortcuts-help-section">
            <h3 className="shortcuts-help-section-title">{g.label}</h3>
            <ul className="shortcuts-help-list">
              {g.items.map((item) => (
                <li key={item.id} className="shortcuts-help-row">
                  <span className="shortcuts-help-label">{item.label}</span>
                  <Keycaps chord={item.chord} size="sm" />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="shortcuts-help-footer">
        <span className="shortcuts-help-footer-hint">
          <Keycaps chord="Esc" size="xs" />
          <span>close</span>
        </span>
        <span className="shortcuts-help-footer-dot" aria-hidden>
          ·
        </span>
        <span className="shortcuts-help-footer-hint">
          <Keycaps chord={formatShortcut('shortcuts.help')} size="xs" />
          <span>toggle anytime</span>
        </span>
      </footer>
    </DialogSurface>
  );
}
