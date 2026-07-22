/**
 * useQueueAutoFire — watches chat status transitions and fires queued messages.
 *
 * When the agent goes idle and the queue has eligible messages, consumes the
 * next batch and sends it via the provided send function. Guards against
 * double-fire with a ref.
 */
import { useEffect, useRef } from 'react';
import type { ChatStatus } from './useChat';
import type { UseMessageQueueReturn } from './useMessageQueue';

export function useQueueAutoFire(
  status: ChatStatus,
  queue: UseMessageQueueReturn,
  sendFn: (message: string) => Promise<void>,
): void {
  const prevStatusRef = useRef<ChatStatus>(status);
  const isFiringRef = useRef(false);
  const consumeNextRef = useRef(queue.consumeNext);
  consumeNextRef.current = queue.consumeNext;

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === status) return;
    if (status !== 'idle') return;
    if (isFiringRef.current) return;

    const batch = consumeNextRef.current();
    if (!batch) return;

    isFiringRef.current = true;
    sendFn(batch.text)
      .catch(() => {})
      .finally(() => {
        isFiringRef.current = false;
      });
  }, [status, sendFn]);
}
