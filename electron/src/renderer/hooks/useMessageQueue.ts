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
  /** Consume the next batch of messages eligible to fire. Returns joined text or null if held. */
  consumeNext: () => string | null;
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
  const queueRef = useRef<QueuedMessage[]>([]);
  const editingIdRef = useRef<string | null>(null);
  queueRef.current = queue;
  editingIdRef.current = editingId;

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

  const consumeNext = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;

    const front = current[0];
    if (front.id === editingIdRef.current) return null;

    const batch: QueuedMessage[] = [front];
    let i = 1;
    if (front.trigger === 'next-request') {
      while (i < current.length && current[i].trigger === 'next-request' && current[i].id !== editingIdRef.current) {
        batch.push(current[i]);
        i++;
      }
    }

    const text = batch.map((m) => m.text).join('\n\n');
    setQueue(current.slice(i));
    return text;
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
  };
}
