/**
 * useMessageQueue — ephemeral per-session message queue for deferred sends.
 *
 * Manages an ordered list of queued messages with two trigger types:
 * - 'next-request': fires at the next idle boundary (batched)
 * - 'chain-end': fires when the chain terminates for any reason
 *
 * Strict FIFO: the front message must fire before subsequent messages are eligible.
 * Editing the front message holds the entire queue.
 *
 * Ownership: the queue records the session key it was queued against
 * (`ownerKey` param — active session id, or null in draft). When that owner
 * disappears or changes (session delete, workspace rebind, session switch),
 * the queue is stale: it is discarded rather than fired into another session
 * or a lazily-created new one. Draft-owned queues (owner null) never go stale
 * so follow-ups queued during a draft's first turn survive its promotion.
 */
import { useEffect, useState, useCallback, useRef } from 'react';

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
  /** Owner session key captured at consume time (null = draft-owned). */
  owner: string | null;
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
  /**
   * Restore a previously consumed batch to the front of the queue (FIFO).
   * `owner` is the batch's owner at consume time; when the current owner no
   * longer matches (session deleted / rebound in the meantime), the batch is
   * dropped instead of resurrected.
   */
  restoreBatch: (batch: readonly QueuedMessage[], owner?: string | null) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;
function generateId(): string {
  return `qm-${nextId++}-${Date.now()}`;
}

/**
 * A queue is stale when it was queued against a concrete session (`owner`)
 * and the current context (`current`) no longer matches it. Draft-owned
 * queues (owner null) are never stale — draft promotion must not clear
 * follow-ups queued during the first turn.
 */
export function isStaleQueueOwner(owner: string | null, current: string | null): boolean {
  return owner != null && owner !== current;
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

export function useMessageQueue(ownerKey: string | null): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editSnapshotRef = useRef<string>('');
  const queueRef = useRef<QueuedMessage[]>([]);
  const editingIdRef = useRef<string | null>(null);
  /** Owner key captured when the queue filled (null = draft-owned). */
  const ownerRef = useRef<string | null>(null);
  const ownerKeyRef = useRef<string | null>(ownerKey);
  queueRef.current = queue;
  editingIdRef.current = editingId;
  ownerKeyRef.current = ownerKey;

  const addToQueue = useCallback(
    (text: string, trigger: QueueTrigger = 'next-request'): QueueTrigger | null => {
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (queueRef.current.length === 0) {
        ownerRef.current = ownerKeyRef.current;
      }
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

  // Intentionally keeps ownerRef: the next addToQueue into an empty queue
  // recaptures the current owner, and a same-commit teardown (owner change +
  // idle edge landing together) still lets consumeNext's stale check see the
  // vanished owner instead of a null that would read as draft-owned.
  const clearQueue = useCallback(() => {
    setQueue([]);
    setEditingId(null);
  }, []);

  // Forced teardown (delete / rebind / switch) changes the owner key. A
  // non-empty queue owned by the vanished session must never fire into
  // whatever surface appears next — drop it proactively.
  useEffect(() => {
    if (queueRef.current.length > 0 && isStaleQueueOwner(ownerRef.current, ownerKey)) {
      clearQueue();
    }
  }, [ownerKey, clearQueue]);

  const consumeNext = useCallback((): ConsumedBatch | null => {
    // Belt-and-suspenders stale check: teardown can land between the idle
    // transition and this call (e.g. terminal event for a deleted session).
    if (queueRef.current.length > 0 && isStaleQueueOwner(ownerRef.current, ownerKeyRef.current)) {
      clearQueue();
      return null;
    }
    const result = selectBatch(queueRef.current, editingIdRef.current);
    if (!result) return null;
    setQueue(result.remainder);
    return { text: result.text, batch: result.batch, owner: ownerRef.current };
  }, [clearQueue]);

  const restoreBatch = useCallback((batch: readonly QueuedMessage[], owner: string | null = null) => {
    if (batch.length === 0) return;
    // The send attempt raced a teardown: the batch's session is gone. Do not
    // resurrect messages that no longer have a session to fire into.
    if (isStaleQueueOwner(owner, ownerKeyRef.current)) return;
    if (queueRef.current.length === 0) {
      ownerRef.current = owner;
    }
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
