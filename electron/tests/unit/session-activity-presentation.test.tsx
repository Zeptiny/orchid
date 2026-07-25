import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LeftSidebar } from '../../src/renderer/components/LeftSidebar';
import { SessionTabBar } from '../../src/renderer/components/SessionTabBar';
import { SessionActivitySection } from '../../src/renderer/components/session-activity-section';
import {
  captureSessionActivityBaseline,
  mergeSessionActivity,
  orderedSessionActivities,
  reconcileSessionActivitySnapshot,
} from '../../src/renderer/utils/session-activity-state';
import {
  sessionActivityPresentation,
  sessionActivitySummaryPresentation,
} from '../../src/renderer/utils/session-activity-presentation';
import type {
  SessionActivity,
  SessionSummary,
} from '../../src/shared/types/ipc-boundary';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function activity(
  partial: Partial<SessionActivity> = {},
): SessionActivity {
  return {
    sessionId: SESSION_ID,
    cwd: '/project/orchid',
    state: 'idle',
    phase: null,
    detail: null,
    startedAt: null,
    updatedAt: 1,
    completedAt: null,
    unread: false,
    backgroundProcessCount: 0,
    canCancel: false,
    ...partial,
  };
}

const session: SessionSummary = {
  id: SESSION_ID,
  name: 'Status synchronization',
  modelLabel: 'test/model',
  cwd: '/project/orchid',
  chainCount: 1,
  updatedAt: 1,
};

describe('session activity presentation', () => {
  it.each([
    ['working', activity({ state: 'working' }), 'Working', 'status-warning'],
    ['waiting', activity({ state: 'waiting' }), 'Waiting', 'status-info'],
    [
      'needs attention',
      activity({ state: 'needs_attention' }),
      'Needs attention',
      'status-error',
    ],
    [
      'completed unread',
      activity({ state: 'idle', unread: true }),
      'Completed · unread',
      'status-success',
    ],
    [
      'background process',
      activity({ state: 'idle', backgroundProcessCount: 2 }),
      'Idle · 2 processes',
      'status-neutral',
    ],
    ['idle', activity(), 'Idle', 'status-neutral'],
  ])('derives one canonical %s label and tone', (_name, input, label, statusClass) => {
    expect(sessionActivityPresentation(input)).toMatchObject({
      label,
      statusClass,
    });
  });

  it('uses the highest-priority visible activity for a collapsed summary', () => {
    expect(sessionActivitySummaryPresentation([
      activity({ state: 'waiting' }),
      activity({ state: 'needs_attention', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      activity({ unread: true, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ])).toMatchObject({
      label: '3 sessions with activity',
      statusClass: 'status-error',
    });
  });

  it('renders completed unread consistently in tabs, Activity, and session rows', () => {
    const completed = activity({ unread: true });
    const tabHtml = renderToStaticMarkup(createElement(SessionTabBar, {
      openSessionIds: [SESSION_ID],
      focusedSessionId: null,
      sessions: [session],
      activities: [completed],
      showDraft: false,
      draftLabel: 'New chat',
      draftProjectName: null,
      onSelect: () => {},
      onSelectDraft: () => {},
      onClose: () => {},
      onCloseDraft: () => {},
    }));
    const activityHtml = renderToStaticMarkup(createElement(SessionActivitySection, {
      activities: [completed],
      sessions: [session],
      onSelect: () => {},
      onStop: () => {},
    }));
    const sidebarHtml = renderToStaticMarkup(createElement(LeftSidebar, {
      isCollapsed: false,
      onToggle: () => {},
      sessionListState: { status: 'ready', sessions: [session] },
      activeSessionId: null,
      onSessionSelect: () => {},
      onSessionCreate: () => {},
      onSessionDelete: () => {},
      onRefreshSessions: () => {},
      onOpenSettings: () => {},
      activities: [completed],
    }));

    expect(tabHtml).toContain('status-success');
    expect(activityHtml).toContain('status-success');
    expect(activityHtml).toContain('Completed · unread');
    expect(sidebarHtml.match(/status-success/g)).toHaveLength(2);
  });
});

describe('session activity reconciliation', () => {
  it('keeps a terminal tombstone so an older working snapshot cannot return', () => {
    let current = mergeSessionActivity(new Map(), activity({
      state: 'working',
      updatedAt: 100,
    }));
    current = mergeSessionActivity(current, activity({
      state: 'idle',
      updatedAt: 200,
    }));
    current = mergeSessionActivity(current, activity({
      state: 'working',
      updatedAt: 100,
    }));

    expect(orderedSessionActivities(current)).toEqual([]);
  });

  it('prunes snapshot omissions that were unchanged while refresh was in flight', () => {
    const current = mergeSessionActivity(new Map(), activity({
      state: 'working',
      updatedAt: 100,
    }));
    const baseline = captureSessionActivityBaseline(current);
    const reconciled = reconcileSessionActivitySnapshot(current, [], baseline);

    expect(orderedSessionActivities(reconciled)).toEqual([]);
    expect(orderedSessionActivities(mergeSessionActivity(
      reconciled,
      activity({ state: 'working', updatedAt: 100 }),
    ))).toEqual([]);
  });

  it('preserves a newer broadcast when an older snapshot omits the session', () => {
    const initial = mergeSessionActivity(new Map(), activity({
      state: 'working',
      updatedAt: 100,
    }));
    const baseline = captureSessionActivityBaseline(initial);
    const withNewerBroadcast = mergeSessionActivity(initial, activity({
      state: 'waiting',
      updatedAt: 200,
    }));
    const reconciled = reconcileSessionActivitySnapshot(
      withNewerBroadcast,
      [],
      baseline,
    );

    expect(orderedSessionActivities(reconciled)).toEqual([
      expect.objectContaining({ state: 'waiting', updatedAt: 200 }),
    ]);
  });
});
