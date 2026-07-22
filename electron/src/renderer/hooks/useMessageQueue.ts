/**
 * useMessageQueue — ephemeral per-session message queue for deferred sends.
 *
 * Manages an ordered list of queued messages with two trigger types:
 * - 'next-request': fires at the next idle boundary (batched)
 * - 'chain-end': fires when the chain terminates for any reason
 *
 * Strict FIFO: the front message must fire before subsequent messages are eligible.
 * Editing the front message holds the entire queue.
 */
import { useState, useCallback, useRef } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export type QueueTrigger = 'next-request' | 'chain-end';

export interface QueuedMessage {
  readonly id: string;
  text: string;
  trigger: QueueTrigger;
  readonly createdAt: number;
}

/** A consumed batch: the joined text plus the original messages (for restore on failure). */
export interface ConsumedBatch {
  text: string;
  batch: QueuedMessage[];
}

export interface UseMessageQueueReturn {
  queue: readonly QueuedMessage[];
  editingId: string | null;
  addToQueue: (text: string, trigger?: QueueTrigger) => QueueTrigger | null;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  startEditing: (id: string) => void;
  updateEditingText: (id: string, text: string) => void;
  finishEditing: (id: string) => void;
  cancelEditing: (id: string) => void;
  changeTrigger: (id: string, trigger: QueueTrigger) => void;
  clearQueue: () => void;
  /** Consume the next batch of messages eligible to fire. Returns text + batch, or null if held. */
  consumeNext: () => ConsumedBatch | null;
  /** Restore a previously consumed batch to the front of the queue (FIFO). */
  restoreBatch: (batch: readonly QueuedMessage[]) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;
function generateId(): string {
  return `qm-${nextId++}-${Date.now()}`;
}

/** Pure FIFO batch selection: pick the front message plus consecutive next-request messages. */
export function selectBatch(
  queue: readonly QueuedMessage[],
  editingId: string | null,
): { batch: QueuedMessage[]; remainder: QueuedMessage[]; text: string } | null {
  if (queue.length === 0) return null;

  const front = queue[0];
  if (front.id === editingId) return null;

  const batch: QueuedMessage[] = [front];
  let i = 1;
  if (front.trigger === 'next-request') {
    while (i < queue.length && queue[i].trigger === 'next-request' && queue[i].id !== editingId) {
      batch.push(queue[i]);
      i++;
    }
  }

  return {
    batch,
    remainder: queue.slice(i),
    text: batch.map((m) => m.text).join('\n\n'),
  };
}

/** Pure reorder: move item at fromIndex to toIndex. Returns copy if invalid. */
export function reorderItems<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 || fromIndex >= items.length ||
    toIndex < 0 || toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editSnapshotRef = useRef<string>('');
  const queueRef = useRef<QueuedMessage[]>([]);
  const editingIdRef = useRef<string | null>(null);
  queueRef.current = queue;
  editingIdRef.current = editingId;

  const addToQueue = useCallback(
    (text: string, trigger: QueueTrigger = 'next-request'): QueueTrigger | null => {
      const trimmed = text.trim();
      if (!trimmed) return null;
      setQueue((prev) => [
        ...prev,
        { id: generateId(), text: trimmed, trigger, createdAt: Date.now() },
      ]);
      return trigger;
    },
    [],
  );

  const removeFromQueue = useCallback((id: string) => {
    setQueue((prev) => prev.filter((m) => m.id !== id));
    setEditingId((prev) => (prev === id ? null : prev));
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => reorderItems(prev, fromIndex, toIndex));
  }, []);

  const startEditing = useCallback((id: string) => {
    const msg = queueRef.current.find((m) => m.id === id);
    if (msg) editSnapshotRef.current = msg.text;
    setEditingId(id);
  }, []);

  const updateEditingText = useCallback((id: string, text: string) => {
    setQueue((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text } : m)),
    );
  }, []);

  const finishEditing = useCallback((id: string) => {
    setQueue((prev) => {
      const msg = prev.find((m) => m.id === id);
      if (msg && !msg.text.trim()) {
        return prev.filter((m) => m.id !== id);
      }
      return prev;
    });
    setEditingId(null);
  }, []);

  const cancelEditing = useCallback((id: string) => {
    setQueue((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, text: editSnapshotRef.current } : m,
      ),
    );
    setEditingId(null);
  }, []);

  const changeTrigger = useCallback((id: string, trigger: QueueTrigger) => {
    setQueue((prev) =>
      prev.map((m) => (m.id === id ? { ...m, trigger } : m)),
    );
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setEditingId(null);
  }, []);

  const consumeNext = useCallback((): ConsumedBatch | null => {
    const result = selectBatch(queueRef.current, editingIdRef.current);
    if (!result) return null;
    setQueue(result.remainder);
    return { text: result.text, batch: result.batch };
  }, []);

  const restoreBatch = useCallback((batch: readonly QueuedMessage[]) => {
    if (batch.length === 0) return;
    setQueue((prev) => [...batch, ...prev]);
  }, []);

  return {
    queue,
    editingId,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    startEditing,
    updateEditingText,
    finishEditing,
    cancelEditing,
    changeTrigger,
    clearQueue,
    consumeNext,
    restoreBatch,
  };
}
