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

export interface UseMessageQueueReturn {
  queue: readonly QueuedMessage[];
  editingId: string | null;
  addToQueue: (text: string, trigger?: QueueTrigger) => void;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  startEditing: (id: string) => void;
  updateEditingText: (id: string, text: string) => void;
  finishEditing: (id: string) => void;
  cancelEditing: (id: string) => void;
  changeTrigger: (id: string, trigger: QueueTrigger) => void;
  clearQueue: () => void;
  /** Consume the next batch of messages eligible to fire. Returns null if held. */
  consumeNext: () => { messages: QueuedMessage[]; text: string } | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;
function generateId(): string {
  return `qm-${nextId++}-${Date.now()}`;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editSnapshotRef = useRef<string>('');

  const addToQueue = useCallback((text: string, trigger: QueueTrigger = 'next-request') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQueue((prev) => [
      ...prev,
      { id: generateId(), text: trimmed, trigger, createdAt: Date.now() },
    ]);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    setQueue((prev) => prev.filter((m) => m.id !== id));
    setEditingId((prev) => (prev === id ? null : prev));
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => {
      if (
        fromIndex < 0 || fromIndex >= prev.length ||
        toIndex < 0 || toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const startEditing = useCallback((id: string) => {
    setQueue((prev) => {
      const msg = prev.find((m) => m.id === id);
      if (msg) editSnapshotRef.current = msg.text;
      return prev;
    });
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

  const consumeNext = useCallback((): { messages: QueuedMessage[]; text: string } | null => {
    let result: { messages: QueuedMessage[]; text: string } | null = null;

    setQueue((prev) => {
      if (prev.length === 0) return prev;

      const front = prev[0];
      if (front.id === editingId) return prev;

      const batch: QueuedMessage[] = [front];
      let i = 1;
      if (front.trigger === 'next-request') {
        while (i < prev.length && prev[i].trigger === 'next-request' && prev[i].id !== editingId) {
          batch.push(prev[i]);
          i++;
        }
      }

      result = { messages: batch, text: batch.map((m) => m.text).join('\n\n') };
      return prev.slice(i);
    });

    return result;
  }, [editingId]);

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
  };
}
