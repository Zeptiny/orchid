// @vitest-environment jsdom
/**
 * Trust-gated send replay — GitHub issue #148.
 *
 * A send rejected by the main-process trust gate must not lose the typed
 * message: useTrustSendReplay stashes the failed send, replays it after a
 * trust grant (only while the stashed session still owns the view), restores
 * it to the composer on decline, and resolves the stash immediately when the
 * trust dialog never opens (already-trusted / lookup-failed). Hook-level
 * payload coverage lives in use-trust-prompt.test.ts; this file covers the
 * orchestration behavior and the composer-restore wiring.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../src/renderer/components/InputArea';
import { useTrustSendReplay, type UseTrustSendReplayReturn } from '../../src/renderer/hooks/useTrustSendReplay';
import type { UntrustedProjectSendFailure } from '../../src/renderer/hooks/useChat';
import type { QueuedMessage } from '../../src/renderer/hooks/useMessageQueue';
import type { TrustPromptOpenCallbacks } from '../../src/renderer/hooks/useTrustPrompt';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderComposer(draftRestore?: { text: string; consumed: () => void } | null) {
  const onSend = vi.fn(async () => {});
  render(
    <InputArea
      sessionId={null}
      status="idle"
      model=""
      onSend={onSend}
      onCancel={vi.fn(async () => {})}
      draftRestore={draftRestore ?? null}
    />,
  );
  return { onSend };
}

describe('InputArea draft restore (trust decline)', () => {
  it('applies the stashed text once and reports consumption', () => {
    const consumed = vi.fn();
    renderComposer({ text: 'gated message', consumed });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('gated message');
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('leaves the restored text editable and sendable', () => {
    const consumed = vi.fn();
    const { onSend } = renderComposer({ text: 'gated message', consumed });

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'gated message, edited' } });
    expect(textarea.value).toBe('gated message, edited');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('gated message, edited');
  });

  it('keeps the composer untouched when no restore is pending', () => {
    renderComposer(null);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
  });
});

// ── useTrustSendReplay orchestration ─────────────────────────────────────────

function failure(message: string, sessionId?: string): UntrustedProjectSendFailure {
  return { message, options: sessionId ? { sessionId } : {} };
}

function queued(id: string, text: string): QueuedMessage {
  return { id, text, trigger: 'next-request', createdAt: 1 };
}

interface HarnessOptions {
  cwd?: string | null;
  activeSessionId?: string | null;
  sendResult?: boolean;
}

function renderTrustSendReplay(options: HarnessOptions = {}) {
  const send = vi.fn(async () => options.sendResult ?? true);
  const openFor = vi.fn();
  const decline = vi.fn();
  const restoreBatch = vi.fn();
  const initial = { cwd: options.cwd ?? '/proj', activeSessionId: options.activeSessionId ?? 'session-a' };
  const { result, rerender } = renderHook(
    (props: { cwd: string | null; activeSessionId: string | null }) =>
      useTrustSendReplay({
        openFor,
        decline,
        restoreBatch,
        cwd: props.cwd,
        activeSessionId: props.activeSessionId,
      }),
    { initialProps: initial },
  );
  // Late-bind the send bridge the way ChatView binds handleSend.
  result.current.sendRef.current = send;
  const rerenderWith = (overrides: Partial<{ cwd: string | null; activeSessionId: string | null }>) => {
    rerender({ ...initial, ...overrides });
    result.current.sendRef.current = send;
  };
  return { result: result as { current: UseTrustSendReplayReturn }, rerenderWith, send, openFor, decline, restoreBatch };
}

/** Stash a gated send and resolve openFor with the given outcome. */
function stash(result: { current: UseTrustSendReplayReturn }, openFor: ReturnType<typeof vi.fn>, options?: {
  message?: string;
  sessionId?: string;
  outcome?: 'opened' | 'already-trusted' | 'lookup-failed';
}) {
  const message = options?.message ?? 'gated message';
  act(() => {
    result.current.onUntrustedProject(failure(message, options?.sessionId ?? 'session-a'));
  });
  expect(openFor).toHaveBeenCalledTimes(1);
  const callbacks = openFor.mock.calls[0]?.[1] as TrustPromptOpenCallbacks | undefined;
  expect(callbacks?.onOutcome).toBeInstanceOf(Function);
  act(() => {
    callbacks?.onOutcome?.(options?.outcome ?? 'opened');
  });
}

describe('useTrustSendReplay — gated-send stash (#148)', () => {
  it('stashes the failed send and opens the trust prompt for the workspace cwd', () => {
    const harness = renderTrustSendReplay();
    act(() => {
      harness.result.current.onUntrustedProject(failure('hello', 'session-a'));
    });
    expect(harness.openFor).toHaveBeenCalledTimes(1);
    expect(harness.openFor).toHaveBeenCalledWith('/proj', expect.objectContaining({ onOutcome: expect.any(Function) }));
    // While the dialog is resolving the flow, the composer stays untouched.
    expect(harness.result.current.draftRestore).toBeNull();
  });

  it('keeps the stash parked when the dialog opened', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello' });
    expect(harness.result.current.draftRestore).toBeNull();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('restores the message immediately when no cwd can be resolved', () => {
    const harness = renderTrustSendReplay();
    harness.rerenderWith({ cwd: null });
    act(() => {
      harness.result.current.onUntrustedProject(failure('hello', 'session-a'));
    });
    expect(harness.openFor).not.toHaveBeenCalled();
    expect(harness.result.current.draftRestore?.text).toBe('hello');
  });

  it.each(['already-trusted', 'lookup-failed'] as const)(
    'drops the stash and restores the composer when openFor resolves %s',
    (outcome) => {
      const harness = renderTrustSendReplay();
      stash(harness.result, harness.openFor, { message: 'hello', outcome });
      // Not parked invisibly: the text is back in the composer…
      expect(harness.result.current.draftRestore?.text).toBe('hello');
      // …and a later unrelated grant has nothing to replay.
      act(() => {
        harness.result.current.onGranted();
      });
      expect(harness.send).not.toHaveBeenCalled();
    },
  );
});

describe('useTrustSendReplay — grant replay', () => {
  it('replays the stashed message into the same session', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello' });
    act(() => {
      harness.result.current.onGranted();
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith('hello');
    expect(harness.result.current.draftRestore).toBeNull();
  });

  it('drops the stash when the active session changed before the grant', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello', sessionId: 'session-a' });
    harness.rerenderWith({ activeSessionId: 'session-b' });
    act(() => {
      harness.result.current.onGranted();
    });
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.result.current.draftRestore).toBeNull();
  });

  it('does not double-send on a double grant', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello' });
    act(() => {
      harness.result.current.onGranted();
    });
    act(() => {
      harness.result.current.onGranted();
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('restores the composer text once when the replay is gated again', async () => {
    const harness = renderTrustSendReplay({ sendResult: false });
    stash(harness.result, harness.openFor, { message: 'hello' });
    await act(async () => {
      harness.result.current.onGranted();
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    const restore = harness.result.current.draftRestore;
    expect(restore?.text).toBe('hello');
    expect(typeof restore?.consumed).toBe('function');
    // One-shot: consuming clears it and a repeat does not re-arm.
    act(() => {
      restore?.consumed();
    });
    expect(harness.result.current.draftRestore).toBeNull();
    act(() => {
      harness.result.current.onGranted();
    });
    expect(harness.result.current.draftRestore).toBeNull();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});

describe('useTrustSendReplay — decline restore', () => {
  it('restores the text once when the stashed session still owns the view', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello', sessionId: 'session-a' });
    act(() => {
      harness.result.current.onDecline();
    });
    expect(harness.decline).toHaveBeenCalledTimes(1);
    expect(harness.result.current.draftRestore?.text).toBe('hello');
    // Stash is spent: a second decline does not re-arm the composer restore.
    act(() => {
      harness.result.current.draftRestore?.consumed();
      harness.result.current.onDecline();
    });
    expect(harness.result.current.draftRestore).toBeNull();
    expect(harness.decline).toHaveBeenCalledTimes(2);
  });

  it('drops the stash silently when the active session changed before the decline', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'hello', sessionId: 'session-a' });
    harness.rerenderWith({ activeSessionId: 'session-b' });
    act(() => {
      harness.result.current.onDecline();
    });
    expect(harness.result.current.draftRestore).toBeNull();
    // The dialog itself still closes.
    expect(harness.decline).toHaveBeenCalledTimes(1);
  });
});

describe('useTrustSendReplay — queue restore wrapper (double-send guard)', () => {
  it('skips the restore when the pending stash owns the batch message', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'queued message' });
    act(() => {
      harness.result.current.restoreQueueBatch([queued('qm-1', 'queued message')], 'session-a');
    });
    expect(harness.restoreBatch).not.toHaveBeenCalled();
  });

  it('matches multi-message batches by their joined send text', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'first\n\nsecond' });
    act(() => {
      harness.result.current.restoreQueueBatch(
        [queued('qm-1', 'first'), queued('qm-2', 'second')],
        'session-a',
      );
    });
    expect(harness.restoreBatch).not.toHaveBeenCalled();
  });

  it('still restores batches the stash does not own', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'stashed' });
    const other = [queued('qm-1', 'different message')];
    act(() => {
      harness.result.current.restoreQueueBatch(other, 'session-a');
    });
    expect(harness.restoreBatch).toHaveBeenCalledWith(other, 'session-a');
  });

  it('restores normally once the stash is resolved', () => {
    const harness = renderTrustSendReplay();
    stash(harness.result, harness.openFor, { message: 'queued message' });
    act(() => {
      harness.result.current.onDecline();
    });
    const batch = [queued('qm-1', 'queued message')];
    act(() => {
      harness.result.current.restoreQueueBatch(batch, 'session-a');
    });
    expect(harness.restoreBatch).toHaveBeenCalledWith(batch, 'session-a');
  });

  it('restores normally when no stash exists', () => {
    const harness = renderTrustSendReplay();
    const batch = [queued('qm-1', 'any message')];
    act(() => {
      harness.result.current.restoreQueueBatch(batch);
    });
    expect(harness.restoreBatch).toHaveBeenCalledWith(batch, undefined);
  });
});
