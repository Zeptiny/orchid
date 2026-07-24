import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { useFocusTrap } from '../../keyboard';

const DEFAULT_OVERLAY =
  'fixed inset-0 z-50 flex items-start justify-center bg-black/55';
const DEFAULT_PANEL =
  'rounded-box border border-base-300 bg-base-200 shadow-2xl';
const MODAL_OVERLAY = 'modal modal-open';
const MODAL_PANEL = 'modal-box';

export interface DialogSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name when no visible title id is provided. */
  label?: string;
  /** id of visible title element. */
  labelledBy?: string;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /**
   * Backdrop classes. Defaults depend on `variant`.
   * Pass a full product class (e.g. shortcuts-help-overlay) to own layout/chrome.
   */
  overlayClassName?: string;
  /**
   * Dialog panel classes. Defaults depend on `variant`.
   * Pass a full product class (e.g. shortcuts-help-dialog) to own layout/chrome.
   */
  panelClassName?: string;
  /** Prefer modal-box chrome when using default classes. */
  variant?: 'overlay' | 'modal';
}

/**
 * Shared dialog shell: backdrop, focus trap, Escape, and click-through prevention.
 * Presentational only — no domain hooks or IPC.
 */
export function DialogSurface({
  isOpen,
  onClose,
  children,
  label,
  labelledBy,
  describedBy,
  initialFocusRef,
  restoreFocusRef,
  closeOnBackdrop = true,
  closeOnEscape = true,
  overlayClassName,
  panelClassName,
  variant = 'overlay',
  className = '',
  ...props
}: DialogSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap({
    enabled: isOpen,
    containerRef: panelRef,
    initialFocusRef,
    restoreFocusRef,
  });

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, closeOnEscape, onClose]);

  if (!isOpen) return null;

  const overlayClasses = `${overlayClassName ?? (variant === 'modal' ? MODAL_OVERLAY : DEFAULT_OVERLAY)} orchid-overlay-enter`
    .trim()
    .replace(/\s+/g, ' ');
  const panelClasses = [
    panelClassName ?? (variant === 'modal' ? MODAL_PANEL : DEFAULT_PANEL),
    'orchid-dialog-enter',
    className,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ');

  return (
    <div
      className={overlayClasses}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={panelClasses}
        onClick={(event) => event.stopPropagation()}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}
