import { describe, expect, it } from 'vitest';
import { SessionActivityStore } from '../../src/main/session/activity';

describe('SessionActivityStore', () => {
  it('tracks independent execution state and unread completion per session', () => {
    const store = new SessionActivityStore();
    store.update('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      cwd: '/project/a',
      state: 'working',
      phase: 'agent',
      detail: 'Generating response',
      startedAt: 10,
      canCancel: true,
    });
    store.update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      cwd: '/project/b',
      state: 'needs_attention',
      phase: 'tool',
      detail: 'Command failed',
      startedAt: 20,
      canCancel: false,
    });

    store.complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true, 30);

    expect(store.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toMatchObject({
      state: 'idle',
      unread: true,
      completedAt: 30,
      canCancel: false,
    });
    expect(store.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toMatchObject({
      state: 'needs_attention',
      unread: false,
    });
  });

  it('orders attention before working, waiting, unread, and background-only rows', () => {
    const store = new SessionActivityStore();
    store.update('11111111-1111-4111-8111-111111111111', {
      state: 'idle', unread: false, backgroundProcessCount: 1,
    });
    store.update('22222222-2222-4222-8222-222222222222', {
      state: 'idle', unread: true,
    });
    store.update('33333333-3333-4333-8333-333333333333', {
      state: 'waiting', detail: 'Waiting for subagent',
    });
    store.update('44444444-4444-4444-8444-444444444444', {
      state: 'working', detail: 'Running tool',
    });
    store.update('55555555-5555-4555-8555-555555555555', {
      state: 'needs_attention', detail: 'Authentication failed',
    });

    expect(store.list().map((item) => item.sessionId)).toEqual([
      '55555555-5555-4555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('marks a viewed completion seen without changing another session', () => {
    const store = new SessionActivityStore();
    store.update('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      state: 'idle', unread: true,
    });
    store.update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      state: 'idle', unread: true,
    });

    store.markSeen('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(store.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')?.unread).toBe(false);
    expect(store.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')?.unread).toBe(true);
  });

  it('assigns strictly increasing timestamps to same-millisecond updates', () => {
    const store = new SessionActivityStore();
    const first = store.update(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { state: 'working' },
      100,
    );
    const second = store.update(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { state: 'waiting' },
      100,
    );

    expect(first.updatedAt).toBe(100);
    expect(second.updatedAt).toBe(101);
  });
});
