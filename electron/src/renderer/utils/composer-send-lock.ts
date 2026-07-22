import type { ChatStatus, InterruptState } from '../hooks/useChat';

/**
 * Whether InputArea should clear its double-send lock for the given parent
 * status. Held during streaming and first-phase cancel confirm so Esc cancel
 * cannot race a second Enter; released on idle, error, and later interrupt phases.
 */
export function shouldReleaseComposerSendLock(
  status: ChatStatus,
  interruptState: InterruptState,
): boolean {
  return status !== 'streaming' && interruptState !== 'confirmAgent';
}

export type ComposerSendGate =
  | { action: 'send' }
  | { action: 'ignore' }
  | { action: 'queue' }
  | { action: 'pick-project' }
  | { action: 'open-providers' }
  | { action: 'need-model' };

/**
 * Pure send admission for the composer. Mirrors handleSend early returns so
 * lock recovery and gate order can be unit-tested without mounting React.
 */
export function evaluateComposerSend(input: {
  trimmed: string;
  isStreaming: boolean;
  isSending: boolean;
  workspaceBound: boolean;
  providerAvailable: boolean;
  modelSelected: boolean;
}): ComposerSendGate {
  if (!input.trimmed || input.isSending) {
    return { action: 'ignore' };
  }
  if (input.isStreaming) {
    return { action: 'queue' };
  }
  const isSlash = input.trimmed.startsWith('/');
  if (!input.workspaceBound && !isSlash) {
    return { action: 'pick-project' };
  }
  if (!input.providerAvailable && !isSlash) {
    return { action: 'open-providers' };
  }
  if (!input.modelSelected && !isSlash) {
    return { action: 'need-model' };
  }
  return { action: 'send' };
}
