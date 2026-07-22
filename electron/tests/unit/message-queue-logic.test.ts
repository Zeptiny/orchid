import { describe, expect, it } from 'vitest';
import {
  selectBatch,
  reorderItems,
  type QueuedMessage,
  type QueueTrigger,
} from '../../src/renderer/hooks/useMessageQueue';
import { shouldAutoFire } from '../../src/renderer/hooks/useQueueAutoFire';

function msg(id: string, text: string, trigger: QueueTrigger = 'next-request'): QueuedMessage {
  return { id, text, trigger, createdAt: Date.now() };
}

// ── selectBatch ──────────────────────────────────────────────────────────────

describe('selectBatch', () => {
  it('returns null for empty queue', () => {
    expect(selectBatch([], null)).toBeNull();
  });

  it('returns null when front message is being edited', () => {
    const queue = [msg('a', 'hello'), msg('b', 'world')];
    expect(selectBatch(queue, 'a')).toBeNull();
  });

  it('fires single chain-end message without batching', () => {
    const queue = [msg('a', 'hello', 'chain-end'), msg('b', 'world', 'chain-end')];
    const result = selectBatch(queue, null);
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(1);
    expect(result!.batch[0].id).toBe('a');
    expect(result!.text).toBe('hello');
    expect(result!.remainder).toHaveLength(1);
    expect(result!.remainder[0].id).toBe('b');
  });

  it('batches consecutive next-request messages', () => {
    const queue = [msg('a', 'first'), msg('b', 'second'), msg('c', 'third')];
    const result = selectBatch(queue, null);
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(3);
    expect(result!.text).toBe('first\n\nsecond\n\nthird');
    expect(result!.remainder).toHaveLength(0);
  });

  it('stops batching at chain-end boundary', () => {
    const queue = [msg('a', 'first'), msg('b', 'second'), msg('c', 'third', 'chain-end')];
    const result = selectBatch(queue, null);
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(2);
    expect(result!.text).toBe('first\n\nsecond');
    expect(result!.remainder).toHaveLength(1);
    expect(result!.remainder[0].id).toBe('c');
  });

  it('stops batching when a message is being edited mid-batch', () => {
    const queue = [msg('a', 'first'), msg('b', 'second'), msg('c', 'third')];
    const result = selectBatch(queue, 'b');
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(1);
    expect(result!.text).toBe('first');
    expect(result!.remainder).toHaveLength(2);
  });

  it('fires single next-request when followed by chain-end', () => {
    const queue = [msg('a', 'hello'), msg('b', 'world', 'chain-end')];
    const result = selectBatch(queue, null);
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(1);
    expect(result!.text).toBe('hello');
    expect(result!.remainder).toHaveLength(1);
  });

  it('allows editing a non-front message without holding the queue', () => {
    const queue = [msg('a', 'first', 'chain-end'), msg('b', 'second')];
    const result = selectBatch(queue, 'b');
    expect(result).not.toBeNull();
    expect(result!.batch).toHaveLength(1);
    expect(result!.batch[0].id).toBe('a');
  });

  it('preserves FIFO order in batch', () => {
    const queue = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
    const result = selectBatch(queue, null);
    expect(result!.batch.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

// ── reorderItems ─────────────────────────────────────────────────────────────

describe('reorderItems', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('moves item forward', () => {
    expect(reorderItems(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves item backward', () => {
    expect(reorderItems(items, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns copy for same index', () => {
    const result = reorderItems(items, 1, 1);
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it('returns copy for negative fromIndex', () => {
    expect(reorderItems(items, -1, 2)).toEqual(items);
  });

  it('returns copy for out-of-bounds toIndex', () => {
    expect(reorderItems(items, 0, 10)).toEqual(items);
  });

  it('returns copy for negative toIndex', () => {
    expect(reorderItems(items, 0, -1)).toEqual(items);
  });

  it('handles single-element array', () => {
    expect(reorderItems(['x'], 0, 0)).toEqual(['x']);
  });

  it('handles empty array', () => {
    expect(reorderItems([], 0, 1)).toEqual([]);
  });

  it('does not mutate the original array', () => {
    const original = [...items];
    reorderItems(items, 0, 3);
    expect(items).toEqual(original);
  });
});

// ── shouldAutoFire ───────────────────────────────────────────────────────────

describe('shouldAutoFire', () => {
  it('fires on streaming → idle transition', () => {
    expect(shouldAutoFire('streaming', 'idle', null, null, false)).toBe(true);
  });

  it('does not fire without a transition (idle → idle)', () => {
    expect(shouldAutoFire('idle', 'idle', null, null, false)).toBe(false);
  });

  it('does not fire when transitioning to streaming', () => {
    expect(shouldAutoFire('idle', 'streaming', null, null, false)).toBe(false);
  });

  it('does not fire when transitioning to error', () => {
    expect(shouldAutoFire('streaming', 'error', null, null, false)).toBe(false);
  });

  it('does not fire while already firing (double-fire guard)', () => {
    expect(shouldAutoFire('streaming', 'idle', null, null, true)).toBe(false);
  });

  it('does not fire while editing', () => {
    expect(shouldAutoFire('streaming', 'idle', 'msg-1', 'msg-1', false)).toBe(false);
  });

  it('fires after editing ends (editingId null)', () => {
    expect(shouldAutoFire('streaming', 'idle', null, null, false)).toBe(true);
  });

  it('does not fire from error → idle (not a streaming transition)', () => {
    expect(shouldAutoFire('error', 'idle', null, null, false)).toBe(false);
  });

  it('fires when editing ends while idle', () => {
    expect(shouldAutoFire('idle', 'idle', null, 'msg-1', false)).toBe(true);
  });

  it('does not fire while still editing (idle)', () => {
    expect(shouldAutoFire('idle', 'idle', 'msg-1', 'msg-1', false)).toBe(false);
  });

  it('does not fire on editing-end if not idle (still streaming)', () => {
    expect(shouldAutoFire('streaming', 'streaming', null, 'msg-1', false)).toBe(false);
  });

  it('does not fire on editing-end while a fire is in flight', () => {
    expect(shouldAutoFire('idle', 'idle', null, 'msg-1', true)).toBe(false);
  });
});
