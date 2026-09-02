/**
 * Modal confirmation shown when a tab whose session is still working is asked
 * to close. The shell owns which session is pending; this renders the ask.
 */
import { Button } from '../ui/Button';
import type { RefObject } from 'react';

export interface SessionCloseConfirmDialogProps {
  containerRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

export function SessionCloseConfirmDialog({
  containerRef,
  initialFocusRef,
  onCancel,
  onConfirm,
}: SessionCloseConfirmDialogProps) {
  return (
    <div
      ref={containerRef}
      className="session-tab-confirm orchid-overlay-enter"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-tab-confirm-title"
      aria-describedby="session-tab-confirm-desc"
    >
      <div className="session-tab-confirm-card orchid-dialog-enter border border-base-300 bg-base-100 shadow-lg">
        <p id="session-tab-confirm-title" className="session-tab-confirm-text font-semibold">
          Close running session tab?
        </p>
        <p id="session-tab-confirm-desc" className="session-tab-confirm-text session-tab-confirm-desc text-base-content/80">
          This session is still running. Close the tab and keep the agent working in the background?
        </p>
        <div className="session-tab-confirm-actions">
          <Button
            ref={initialFocusRef}
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
          >
            Close tab
          </Button>
        </div>
      </div>
    </div>
  );
}
