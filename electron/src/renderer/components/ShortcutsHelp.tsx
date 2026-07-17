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
      overlayClassName="shortcuts-help-overlay orchid-shortcuts-help-overlay fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[10vh] px-4 pb-6"
      panelClassName="shortcuts-help-dialog orchid-shortcuts-help-dialog flex max-h-[min(40rem,82vh)] w-full max-w-lg flex-col overflow-hidden rounded-box border border-base-300 bg-base-200 shadow-2xl"
      variant="overlay"
    >
      <header className="shortcuts-help-header orchid-shortcuts-help-header flex items-start justify-between gap-3 border-b border-base-300 px-4 py-4">
        <div className="shortcuts-help-title-block flex min-w-0 items-start gap-3">
          <span
            className="shortcuts-help-icon-wrap inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary"
            aria-hidden
          >
            <Icon name="command" size={15} />
          </span>
          <div className="shortcuts-help-title-text min-w-0">
            <h2 className="m-0 text-sm font-semibold leading-tight">Keyboard shortcuts</h2>
            <p className="mt-1 text-xs text-base-content/60">
              Navigate Orchid without leaving the keyboard
            </p>
          </div>
        </div>
        <IconButton
          ref={closeRef}
          label="Close"
          icon="x"
          size="sm"
          className="shortcuts-help-close -mr-1 -mt-0.5"
          onClick={onClose}
          iconSize={14}
        />
      </header>

      <div className="shortcuts-help-body orchid-shortcuts-help-body flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        {groups.map((g) => (
          <section
            key={g.group}
            className="shortcuts-help-section orchid-shortcuts-help-section rounded-lg border border-base-300 bg-base-100/50 p-2.5"
          >
            <h3 className="shortcuts-help-section-title mb-2 border-b border-base-300 px-1 pb-1.5 text-xs font-semibold uppercase tracking-wider text-base-content/60">
              {g.label}
            </h3>
            <ul className="shortcuts-help-list m-0 flex list-none flex-col gap-0.5 p-0">
              {g.items.map((item) => (
                <li
                  key={item.id}
                  className="shortcuts-help-row flex min-h-8 items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-primary/10"
                >
                  <span className="shortcuts-help-label min-w-0 text-xs leading-snug">
                    {item.label}
                  </span>
                  <Keycaps chord={item.chord} size="sm" />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="shortcuts-help-footer orchid-shortcuts-help-footer flex flex-wrap items-center gap-2 border-t border-base-300 px-4 py-2.5 text-xs text-base-content/60">
        <span className="shortcuts-help-footer-hint inline-flex items-center gap-1.5">
          <Keycaps chord="Esc" size="xs" />
          <span>close</span>
        </span>
        <span className="shortcuts-help-footer-dot opacity-40" aria-hidden>
          ·
        </span>
        <span className="shortcuts-help-footer-hint inline-flex items-center gap-1.5">
          <Keycaps chord={formatShortcut('shortcuts.help')} size="xs" />
          <span>toggle anytime</span>
        </span>
      </footer>
    </DialogSurface>
  );
}
