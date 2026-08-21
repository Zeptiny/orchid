import { describe, expect, it } from 'vitest';
import { SessionActivityStore } from '../../src/main/session/activity';
import { orderedSessionActivities } from '../../src/renderer/utils/session-activity-state';
import type {
  SessionActivity,
  SessionExecutionState,
} from '../../src/shared/types/ipc-boundary';

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

  it('keeps two working sessions in stable order while one streams detail updates', () => {
    const store = new SessionActivityStore();
    const earlier = '11111111-1111-4111-8111-111111111111';
    const later = '22222222-2222-4222-8222-222222222222';
    store.update(earlier, { state: 'working', startedAt: 100 }, 100);
    store.update(later, { state: 'working', startedAt: 200 }, 200);

    for (let now = 300; now <= 900; now += 100) {
      store.update(later, { detail: `Streaming detail ${now}` }, now);
      expect(store.list().map((item) => item.sessionId)).toEqual([earlier, later]);
    }
  });

  it('orders working and waiting rows by oldest turn start with unknown starts last', () => {
    const store = new SessionActivityStore();
    store.update('working-newest-start', { state: 'working', startedAt: 300 }, 500);
    store.update('working-oldest-start', { state: 'working', startedAt: 100 }, 100);
    store.update('working-unknown-start', { state: 'working', startedAt: null }, 700);
    store.update('waiting-newest-start', { state: 'waiting', startedAt: 400 }, 400);
    store.update('waiting-oldest-start', { state: 'waiting', startedAt: 200 }, 600);

    // Oldest-start-first is a deliberate queue-position choice: the row that
    // has been running longest keeps the top of its bucket, and newly started
    // work enters below instead of displacing rows mid-turn.
    expect(store.list().map((item) => item.sessionId)).toEqual([
      'working-oldest-start',
      'working-newest-start',
      'working-unknown-start',
      'waiting-oldest-start',
      'waiting-newest-start',
    ]);
  });

  it('keeps idle rows ordered unread-first then by recency', () => {
    const store = new SessionActivityStore();
    store.update('idle-stale-unread', { state: 'idle', unread: true }, 100);
    store.update('idle-fresh-seen', {
      state: 'idle', unread: false, backgroundProcessCount: 1,
    }, 900);
    store.update('idle-fresh-unread', { state: 'idle', unread: true }, 500);

    expect(store.list().map((item) => item.sessionId)).toEqual([
      'idle-fresh-unread',
      'idle-stale-unread',
      'idle-fresh-seen',
    ]);
  });

  it('orders needs_attention rows unread-first before recency', () => {
    const store = new SessionActivityStore();
    // The unread row is older, so pure recency would place it second.
    store.update('attention-stale-unread', {
      state: 'needs_attention', unread: true,
    }, 100);
    store.update('attention-fresh-seen', { state: 'needs_attention' }, 900);

    expect(store.list().map((item) => item.sessionId)).toEqual([
      'attention-stale-unread',
      'attention-fresh-seen',
    ]);
  });
});

describe('session activity ordering parity', () => {
  it('orders identical fixtures identically through list() and orderedSessionActivities()', () => {
    const store = new SessionActivityStore();
    // Insertion order deliberately differs from display order, and no two
    // visible rows tie under the comparator, so each surface's output is
    // fully determined by the shared comparator rather than sort stability.
    const fixtures: Array<
      Partial<SessionActivity> & {
        sessionId: string;
        state: SessionExecutionState;
        updatedAt: number;
      }
    > = [
      { sessionId: 'idle-invisible', state: 'idle', updatedAt: 950 },
      {
        sessionId: 'bg-only-fresh', state: 'idle',
        updatedAt: 900, backgroundProcessCount: 2,
      },
      { sessionId: 'idle-stale-unread', state: 'idle', updatedAt: 100, unread: true },
      { sessionId: 'idle-fresh-unread', state: 'idle', updatedAt: 500, unread: true },
      {
        sessionId: 'waiting-newest-start', state: 'waiting',
        startedAt: 400, updatedAt: 400,
      },
      {
        sessionId: 'waiting-oldest-start', state: 'waiting',
        startedAt: 200, updatedAt: 600,
      },
      {
        sessionId: 'working-equal-start-a', state: 'working',
        startedAt: 250, updatedAt: 300,
      },
      {
        sessionId: 'working-equal-start-b', state: 'working',
        startedAt: 250, updatedAt: 800,
      },
      {
        sessionId: 'working-unknown-start', state: 'working',
        startedAt: null, updatedAt: 700,
      },
      {
        sessionId: 'working-newest-start', state: 'working',
        startedAt: 300, updatedAt: 500,
      },
      {
        sessionId: 'working-oldest-start', state: 'working',
        startedAt: 100, updatedAt: 100,
      },
      {
        sessionId: 'attention-stale-unread', state: 'needs_attention',
        updatedAt: 100, unread: true,
      },
      { sessionId: 'attention-fresh-seen', state: 'needs_attention', updatedAt: 900 },
    ];

    for (const fixture of fixtures) {
      store.update(fixture.sessionId, {
        state: fixture.state,
        startedAt: fixture.startedAt ?? null,
        unread: fixture.unread ?? false,
        backgroundProcessCount: fixture.backgroundProcessCount ?? 0,
      }, fixture.updatedAt);
    }

    // Feed the exact stored objects through the renderer projection so both
    // surfaces see identical activity records.
    const rendererState = new Map(
      fixtures.map((fixture) => {
        const stored = store.get(fixture.sessionId);
        if (!stored) throw new Error(`missing stored activity: ${fixture.sessionId}`);
        return [stored.sessionId, stored];
      }),
    );

    const storeOrder = store.list().map((item) => item.sessionId);
    // Both surfaces drop the invisible idle row and apply the same comparator.
    expect(storeOrder).toEqual([
      'attention-stale-unread',
      'attention-fresh-seen',
      'working-oldest-start',
      'working-equal-start-b',
      'working-equal-start-a',
      'working-newest-start',
      'working-unknown-start',
      'waiting-oldest-start',
      'waiting-newest-start',
      'idle-fresh-unread',
      'idle-stale-unread',
      'bg-only-fresh',
    ]);
    expect(orderedSessionActivities(rendererState).map((item) => item.sessionId))
      .toEqual(storeOrder);
  });
});
