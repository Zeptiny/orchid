/**
 * useQueueAutoFire — watches chat status transitions and fires queued messages.
 *
 * When the agent goes idle and the queue has eligible messages, consumes the
 * next batch and sends it via the provided send function. Guards against
 * double-fire with a ref. Re-triggers when editing ends while already idle.
 */
import { useEffect, useRef } from 'react';
import type { ChatStatus } from './useChat';
import type { ConsumedBatch, QueuedMessage } from './useMessageQueue';

/**
 * Pure transition check: should the queue fire on this status change?
 *
 * @param prevEditingId - editing-id observed on the previous run
 */
export function shouldAutoFire(
  prevStatus: ChatStatus,
  nextStatus: ChatStatus,
  editingId: string | null,
  prevEditingId: string | null,
  isFiring: boolean,
): boolean {
  if (isFiring || editingId !== null || nextStatus !== 'idle') return false;
  return prevStatus === 'streaming' || prevEditingId !== null;
}

/**
 * Watches status transitions and auto-fires queued messages.
 *
 * @param status - Current chat status from useChat
 * @param consumeNext - Returns the next eligible batch (text + messages), or null if held
 * @param restoreBatch - Restores a consumed batch to the front of the queue on send failure
 * @param editingId - Currently editing message ID (null when not editing)
 * @param sendFn - Sends a message via the chat (same signature as ChatView.handleSend)
 */
export function useQueueAutoFire(
  status: ChatStatus,
  consumeNext: () => ConsumedBatch | null,
  restoreBatch: (batch: readonly QueuedMessage[]) => void,
  editingId: string | null,
  sendFn: (message: string) => Promise<void>,
): void {
  const prevStatusRef = useRef<ChatStatus>(status);
  const prevEditingRef = useRef<string | null>(editingId);
  const isFiringRef = useRef(false);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const prevEditing = prevEditingRef.current;
    prevStatusRef.current = status;
    prevEditingRef.current = editingId;

    if (!shouldAutoFire(prev, status, editingId, prevEditing, isFiringRef.current)) return;

    const consumed = consumeNext();
    if (!consumed) return;

    isFiringRef.current = true;
    sendFn(consumed.text)
      .catch(() => {
        // Send failed — restore the consumed batch to its FIFO position so the
        // messages are not permanently lost; they fire on the next transition.
        restoreBatch(consumed.batch);
        console.warn('Queue auto-fire: send failed, consumed messages restored to the queue.');
      })
      .finally(() => {
        isFiringRef.current = false;
      });
  }, [status, editingId, consumeNext, restoreBatch, sendFn]);
}
