/** Pure presentation for the composer's single trailing action control. */
import type { InterruptState } from '../../hooks/useChat';

export type ComposerActionKey = 'cancel' | 'command' | 'queue' | 'send';

export interface ComposerActionState {
  showCancel: boolean;
  showMenu: boolean;
  isStreaming: boolean;
  hasInput: boolean;
}

/**
 * Remount key for the action control. It changes only when the visible control
 * changes identity, so React re-creates the button on every swap.
 */
export function resolveComposerActionKey(state: ComposerActionState): ComposerActionKey {
  if (state.showCancel) return 'cancel';
  if (state.showMenu) return 'command';
  if (state.isStreaming && state.hasInput) return 'queue';
  return 'send';
}

/** Staged Esc / cancel-button label for the current interrupt phase. */
export function resolveCancelTitle(interruptState: InterruptState): string {
  if (interruptState === 'confirmSubagents') return 'Cancel subagents';
  if (interruptState === 'confirmAgent') return 'Cancel agent';
  return 'Interrupt';
}
