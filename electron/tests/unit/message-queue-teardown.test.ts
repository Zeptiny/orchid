// @vitest-environment jsdom
/**
 * Message-queue teardown behavior (CODE-REVIEW F8.2 / E7).
 *
 * Queued messages belong to the session they were queued against. On forced
 * teardown (session delete, workspace rebind, session switch) the queue must
 * be discarded — never fired into a brand-new session and never silently
 * dropped mid-flight without a restore attempt:
 *
 * - owner change to null/another session clears a non-empty queue proactively
 * - restoreBatch drops batches whose owner was torn down during the send
 * - draft-owned queues (owner null) survive draft→session promotion
 * - autofire restores consumed batches when the send resolves false or throws
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { useMessageQueue } from '../../src/renderer/hooks/useMessageQueue';
import { useQueueAutoFire } from '../../src/renderer/hooks/useQueueAutoFire';
import type { ChatStatus } from '../../src/renderer/hooks/useChat';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  cleanup();
});

/** Combined queue + autofire harness with scripted send outcomes. */
function useHarness(initialOwner: string | null) {
  const [ownerKey, setOwnerKey] = useState<string | null>(initialOwner);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const queue = useMessageQueue(ownerKey);
  /** Scripted outcomes, resolved lazily so rejections are never unhandled. */
  const scripted = useRef<Array<boolean | Error>>([]);
  const calls = useRef<string[]>([]);
  const sendFnRef = useRef<((message: string) => Promise<boolean>) | null>(null);
  if (sendFnRef.current === null) {
    sendFnRef.current = (message: string) => {
      calls.current.push(message);
      const outcome = scripted.current.shift();
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome ?? true);
    };
  }
  useQueueAutoFire(status, queue.consumeNext, queue.restoreBatch, queue.editingId, sendFnRef.current);
  return { queue, setOwnerKey, setStatus, calls, scripted };
}

describe('useMessageQueue teardown ownership', () => {
  it('captures the owner when the queue fills and reports it on consume', () => {
    const { result } = renderHook(() => useMessageQueue('session-a'));

    act(() => {
      result.current.addToQueue('first');
      result.current.addToQueue('second');
    });
    expect(result.current.queue).toHaveLength(2);

    let consumed: ReturnType<typeof result.current.consumeNext> = null;
    act(() => {
      consumed = result.current.consumeNext();
    });
    expect(consumed?.text).toBe('first\n\nsecond');
    expect(consumed?.owner).toBe('session-a');
    expect(result.current.queue).toHaveLength(0);
  });

  it('clears a non-empty queue when the owner session disappears (delete / rebind)', () => {
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string | null }) => useMessageQueue(owner),
      { initialProps: { owner: 'session-a' as string | null } },
    );

    act(() => {
      result.current.addToQueue('queued follow-up');
    });
    expect(result.current.queue).toHaveLength(1);

    // Session deleted or workspace rebound: activeSession becomes null.
    act(() => {
      rerender({ owner: null });
    });
    expect(result.current.queue).toHaveLength(0);
    expect(result.current.consumeNext()).toBeNull();
  });

  it('clears a non-empty queue when switching to another session', () => {
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string | null }) => useMessageQueue(owner),
      { initialProps: { owner: 'session-a' as string | null } },
    );

    act(() => {
      result.current.addToQueue('for session a');
    });

    act(() => {
      rerender({ owner: 'session-b' });
    });
    expect(result.current.queue).toHaveLength(0);
  });

  it('keeps a draft-owned queue across draft→session promotion', () => {
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string | null }) => useMessageQueue(owner),
      { initialProps: { owner: null as string | null } },
    );

    act(() => {
      result.current.addToQueue('queued during first draft turn');
    });

    // SESSION_CREATED promotes the draft mid-turn; follow-ups must survive.
    act(() => {
      rerender({ owner: 'session-new' });
    });
    expect(result.current.queue).toHaveLength(1);

    let consumed: ReturnType<typeof result.current.consumeNext> = null;
    act(() => {
      consumed = result.current.consumeNext();
    });
    expect(consumed?.text).toBe('queued during first draft turn');
  });

  it('restoreBatch drops a batch whose owner was torn down during the send', () => {
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string | null }) => useMessageQueue(owner),
      { initialProps: { owner: 'session-a' as string | null } },
    );

    act(() => {
      result.current.addToQueue('doomed message');
    });
    let consumed: ReturnType<typeof result.current.consumeNext> = null;
    act(() => {
      consumed = result.current.consumeNext();
    });
    expect(consumed).not.toBeNull();

    // Teardown lands while the send attempt is in flight.
    act(() => {
      rerender({ owner: null });
    });

    act(() => {
      result.current.restoreBatch(consumed!.batch, consumed!.owner);
    });
    expect(result.current.queue).toHaveLength(0);
  });

  it('restoreBatch returns a batch to the front of the queue when the owner is unchanged', () => {
    const { result } = renderHook(() => useMessageQueue('session-a'));

    act(() => {
      result.current.addToQueue('first');
      result.current.addToQueue('second');
    });
    let consumed: ReturnType<typeof result.current.consumeNext> = null;
    act(() => {
      consumed = result.current.consumeNext();
    });
    act(() => {
      result.current.addToQueue('third');
    });

    act(() => {
      result.current.restoreBatch(consumed!.batch, consumed!.owner);
    });
    expect(result.current.queue.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('useQueueAutoFire teardown behavior', () => {
  it('fires the queued batch on a normal streaming→idle transition', async () => {
    const { result } = renderHook(() => useHarness('session-a'));

    act(() => {
      result.current.queue.addToQueue('follow-up one');
      result.current.queue.addToQueue('follow-up two');
    });
    await act(async () => {
      result.current.setStatus('streaming');
    });
    await act(async () => {
      result.current.setStatus('idle');
    });

    expect(result.current.calls.current).toEqual(['follow-up one\n\nfollow-up two']);
    expect(result.current.queue.queue).toHaveLength(0);
  });

  it('restores the batch when the send is gated (resolves false)', async () => {
    const { result } = renderHook(() => useHarness('session-a'));
    result.current.scripted.current.push(false);

    act(() => {
      result.current.queue.addToQueue('kept message');
    });
    await act(async () => {
      result.current.setStatus('streaming');
    });
    await act(async () => {
      result.current.setStatus('idle');
    });

    expect(result.current.calls.current).toEqual(['kept message']);
    expect(result.current.queue.queue.map((m) => m.text)).toEqual(['kept message']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('restores the batch when the send rejects', async () => {
    const { result } = renderHook(() => useHarness('session-a'));
    result.current.scripted.current.push(new Error('boom'));

    act(() => {
      result.current.queue.addToQueue('kept message');
    });
    await act(async () => {
      result.current.setStatus('streaming');
    });
    await act(async () => {
      result.current.setStatus('idle');
    });

    expect(result.current.queue.queue.map((m) => m.text)).toEqual(['kept message']);
  });

  it('deleting a session via an external surface never fires or keeps the queue', async () => {
    // Analytics/Config delete paths skip ChatView's explicit clearQueue. The
    // terminal CHAT_DONE for the force-stopped session still produces the
    // idle edge while activeSession still names the deleted session; the send
    // then fails with session_not_found (resolved, not thrown), and the
    // restored batch must be dropped once the deletion lands.
    const { result } = renderHook(() => useHarness('session-a'));
    result.current.scripted.current.push(false);

    act(() => {
      result.current.queue.addToQueue('queued before delete');
    });
    await act(async () => {
      result.current.setStatus('streaming');
    });
    // Terminal event for the force-stopped session flips status while the
    // delete invoke is still in flight (activeSession still 'session-a').
    await act(async () => {
      result.current.setStatus('idle');
    });
    expect(result.current.calls.current).toEqual(['queued before delete']);

    // deleteSession resolves → activeSession becomes null. The restored batch
    // belongs to the deleted session and must be discarded, not kept.
    await act(async () => {
      result.current.setOwnerKey(null);
    });
    expect(result.current.queue.queue).toHaveLength(0);

    // A later idle boundary must not re-send the discarded messages.
    await act(async () => {
      result.current.setStatus('streaming');
    });
    await act(async () => {
      result.current.setStatus('idle');
    });
    expect(result.current.calls.current).toEqual(['queued before delete']);
  });

  it('workspace rebind discards the queue before the synthetic idle edge fires', async () => {
    // pickProjectDir nulls activeSession before the pane reset; the queue's
    // owner is gone, so nothing may fire into the new draft.
    const { result } = renderHook(() => useHarness('session-a'));

    act(() => {
      result.current.queue.addToQueue('rebind victim');
    });
    await act(async () => {
      result.current.setStatus('streaming');
    });
    await act(async () => {
      result.current.setOwnerKey(null);
      result.current.setStatus('idle');
    });

    expect(result.current.calls.current).toEqual([]);
    expect(result.current.queue.queue).toHaveLength(0);
  });

  it('draft follow-ups fire into the promoted session, not a new one', async () => {
    const { result } = renderHook(() => useHarness(null));

    await act(async () => {
      result.current.setStatus('streaming');
    });
    act(() => {
      result.current.queue.addToQueue('draft follow-up');
    });
    // Draft promoted mid-turn (SESSION_CREATED).
    act(() => {
      result.current.setOwnerKey('session-new');
    });
    await act(async () => {
      result.current.setStatus('idle');
    });

    expect(result.current.calls.current).toEqual(['draft follow-up']);
    expect(result.current.queue.queue).toHaveLength(0);
  });
});
