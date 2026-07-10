/**
 * Keyboard shortcuts help modal — content from the central registry.
 */
import { useEffect, useRef } from 'react';
import { formatShortcut, groupShortcutsForHelp, useFocusTrap } from '../keyboard';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';

interface ShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ isOpen, onClose }: ShortcutsHelpProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useFocusTrap({
    enabled: isOpen,
    containerRef,
    initialFocusRef: closeRef,
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const groups = groupShortcutsForHelp();

  return (
    <div
      className="shortcuts-help-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={containerRef}
        className="shortcuts-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
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
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost btn-sm btn-circle shortcuts-help-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
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
      </div>
    </div>
  );
}
