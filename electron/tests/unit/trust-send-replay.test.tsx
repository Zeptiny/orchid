// @vitest-environment jsdom
/**
 * Trust-gated send replay — GitHub issue #148.
 *
 * A send rejected by the main-process trust gate must not lose the typed
 * message: ChatView stashes the failed send, replays it after a trust grant
 * (only while the stashed session still owns the view), and restores it to
 * the composer on decline. Hook-level payload coverage lives in
 * use-trust-prompt.test.ts; this file covers the composer-restore behavior
 * and the ChatView wiring contract.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InputArea } from '../../src/renderer/components/InputArea';

const RENDERER = path.resolve(__dirname, '../../src/renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

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

describe('ChatView trust send replay wiring (#148)', () => {
  it('stashes the failed send before opening the trust prompt', () => {
    const src = read('components/ChatView.tsx');
    const start = src.indexOf('onUntrustedProject: (failure) =>');
    const handler = src.slice(start, start + 400);
    expect(handler).toContain('pendingTrustSendRef.current = failure;');
    expect(handler.indexOf('pendingTrustSendRef.current = failure;'))
      .toBeLessThan(handler.indexOf('trustPrompt.openFor(cwd)'));
  });

  it('replays the stash on grant: cleared first, dropped when the session moved', () => {
    const src = read('components/ChatView.tsx');
    const start = src.indexOf('onGranted: () =>');
    const granted = src.slice(start, start + 1200);
    // Double-grant guard: the stash is cleared before the replay fires.
    expect(granted.indexOf('pendingTrustSendRef.current = null;'))
      .toBeLessThan(granted.indexOf('handleSendRef.current'));
    // Superseded guard: replay only while the stashed session still owns the view.
    expect(granted).toMatch(
      /pending\.options\.sessionId \?\? null\)[\s\S]*!==[\s\S]*session\.activeSession\?\.id \?\? null/,
    );
    expect(granted).toContain('handleSendRef.current?.(pending.message)');
    // A gated replay restores the message to the composer instead of losing it.
    expect(granted).toMatch(/if \(!sent\) setRestoreDraft\(\{ text: pending\.message \}\)/);
  });

  it('restores the stash to the composer on decline instead of losing it', () => {
    const src = read('components/ChatView.tsx');
    const declineStart = src.indexOf('const handleTrustDecline = useCallback');
    const decline = src.slice(
      declineStart,
      src.indexOf('const handleFocusSectionConsumed', declineStart),
    );
    expect(decline).toContain('pendingTrustSendRef.current = null;');
    expect(decline).toContain('setRestoreDraft({ text: pending.message })');
    expect(decline).toContain('trustPrompt.decline()');
    // The dialog routes declines through the restore wrapper, and the
    // composer receives the one-shot draft restore.
    expect(src).toContain('onDecline={handleTrustDecline}');
    expect(src).toContain('draftRestore={draftRestore}');
    // handleSend is defined after the grant callback; the ref closes the gap.
    expect(src).toContain('handleSendRef.current = handleSend;');
  });
});
