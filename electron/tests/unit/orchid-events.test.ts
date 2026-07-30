// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emitOrchidEvent, onOrchidEvent } from '../../src/renderer/utils/events';

describe('emitOrchidEvent', () => {
  it('dispatches a CustomEvent on window with the correct detail', () => {
    const handler = vi.fn();
    window.addEventListener('orchid:select-session', handler);
    emitOrchidEvent('orchid:select-session', { id: 'sess-1' });
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ id: 'sess-1' });
    window.removeEventListener('orchid:select-session', handler);
  });

  it('dispatches with undefined detail for void events', () => {
    const handler = vi.fn();
    window.addEventListener('orchid:providers-updated', handler);
    emitOrchidEvent('orchid:providers-updated');
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toBeNull();
    window.removeEventListener('orchid:providers-updated', handler);
  });

  it('dispatches config-updated with a record payload', () => {
    const handler = vi.fn();
    window.addEventListener('orchid:config-updated', handler);
    emitOrchidEvent('orchid:config-updated', { theme: 'bluey' });
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ theme: 'bluey' });
    window.removeEventListener('orchid:config-updated', handler);
  });
});

describe('onOrchidEvent', () => {
  it('receives the typed detail payload', () => {
    const received: Array<{ tab?: string } | undefined> = [];
    const unsub = onOrchidEvent('orchid:open-settings', (detail) => {
      received.push(detail);
    });
    emitOrchidEvent('orchid:open-settings', { tab: 'providers' });
    expect(received).toEqual([{ tab: 'providers' }]);
    unsub();
  });

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn();
    const unsub = onOrchidEvent('orchid:providers-updated', handler);
    emitOrchidEvent('orchid:providers-updated');
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    emitOrchidEvent('orchid:providers-updated');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers each receive the event', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = onOrchidEvent('orchid:definitions-workspace-changed', a);
    const unsubB = onOrchidEvent('orchid:definitions-workspace-changed', b);
    emitOrchidEvent('orchid:definitions-workspace-changed');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it('delivers navigate detail correctly', () => {
    const handler = vi.fn();
    const unsub = onOrchidEvent('orchid:navigate', handler);
    emitOrchidEvent('orchid:navigate', { section: 'sessions' });
    expect(handler).toHaveBeenCalledWith({ section: 'sessions' });
    unsub();
  });
});
