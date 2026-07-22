/**
 * useQueueAutoFire — watches chat status transitions and fires queued messages.
 *
 * When the agent goes idle and the queue has eligible messages, consumes the
 * next batch and sends it via the provided send function. Guards against
 * double-fire with a ref. Re-triggers when editing ends while already idle.
 */
import { useEffect, useRef } from 'react';
import type { ChatStatus } from './useChat';

/** Pure transition check: should the queue fire on this status change? */
export function shouldAutoFire(
  prevStatus: ChatStatus,
  nextStatus: ChatStatus,
  editingId: string | null,
  isFiring: boolean,
): boolean {
  return nextStatus === 'idle' && prevStatus === 'streaming' && !isFiring && editingId === null;
}

/**
 * Watches status transitions and auto-fires queued messages.
 *
 * @param status - Current chat status from useChat
 * @param consumeNext - Returns joined text of the next eligible batch, or null if held
 * @param editingId - Currently editing message ID (null when not editing)
 * @param sendFn - Sends a message via the chat (same signature as ChatView.handleSend)
 */
export function useQueueAutoFire(
  status: ChatStatus,
  consumeNext: () => string | null,
  editingId: string | null,
  sendFn: (message: string) => Promise<void>,
): void {
  const prevStatusRef = useRef<ChatStatus>(status);
  const isFiringRef = useRef(false);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (!shouldAutoFire(prev, status, editingId, isFiringRef.current)) return;

    const text = consumeNext();
    if (!text) return;

    isFiringRef.current = true;
    sendFn(text)
      .catch(() => {
        // Send failed — consumed messages are lost. Surface via console;
        // the queue is ephemeral and the user can re-type.
        console.warn('Queue auto-fire: send failed, consumed messages were not delivered.');
      })
      .finally(() => {
        isFiringRef.current = false;
      });
  }, [status, editingId, consumeNext, sendFn]);
}
