// @vitest-environment jsdom
/**
 * Project-scoped session sidebar helpers — U6.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionActivity, SessionSummary } from '../../src/shared/types/ipc-boundary';
import { LeftSidebar } from '../../src/renderer/components/LeftSidebar';
import {
  normalizeWorkspaceKey,
  pathsEqual,
  partitionSessionsByWorkspace,
  filterSessionsByQuery,
  groupSessionsByProject,
  buildPrimarySessions,
  countProjectActivity,
  previewProjectSessions,
  truncatePathDisplay,
} from '../../src/renderer/utils/session-workspace';

function summary(
  partial: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'name'>,
): SessionSummary {
  return {
    id: partial.id,
    name: partial.name,
    model: partial.model ?? 'test/model',
    cwd: partial.cwd ?? null,
    chainCount: partial.chainCount ?? 1,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

describe('normalizeWorkspaceKey', () => {
  it('returns null for null/empty/whitespace', () => {
    expect(normalizeWorkspaceKey(null)).toBeNull();
    expect(normalizeWorkspaceKey(undefined)).toBeNull();
    expect(normalizeWorkspaceKey('')).toBeNull();
    expect(normalizeWorkspaceKey('   ')).toBeNull();
  });

  it('strips trailing slashes and folds separators', () => {
    expect(normalizeWorkspaceKey('/home/user/proj/')).toBe('/home/user/proj');
    expect(normalizeWorkspaceKey('/home/user/proj')).toBe('/home/user/proj');
    expect(normalizeWorkspaceKey('C:\\Users\\me\\proj\\')).toBe('c:/Users/me/proj');
  });
});

describe('pathsEqual', () => {
  it('matches equivalent paths', () => {
    expect(pathsEqual('/a/b', '/a/b/')).toBe(true);
    expect(pathsEqual('/a/b', '/a/c')).toBe(false);
    expect(pathsEqual(null, '/a')).toBe(false);
    expect(pathsEqual(null, null)).toBe(false);
  });
});

describe('partitionSessionsByWorkspace', () => {
  const sessions = [
    summary({ id: '1', name: 'A', cwd: '/proj/alpha' }),
    summary({ id: '2', name: 'B', cwd: '/proj/alpha/' }),
    summary({ id: '3', name: 'C', cwd: '/proj/beta' }),
    summary({ id: '4', name: 'Legacy', cwd: null }),
  ];

  it('keeps only exact-path matches in project (happy path)', () => {
    const { inProject, other } = partitionSessionsByWorkspace(
      sessions,
      '/proj/alpha',
    );
    expect(inProject.map((s) => s.id).sort()).toEqual(['1', '2']);
    expect(other.map((s) => s.id).sort()).toEqual(['3', '4']);
  });

  it('puts everything in other when workspace unbound', () => {
    const { inProject, other } = partitionSessionsByWorkspace(sessions, null);
    expect(inProject).toHaveLength(0);
    expect(other).toHaveLength(4);
  });

  it('puts legacy null cwd only in other/unknown', () => {
    const { inProject, other } = partitionSessionsByWorkspace(
      [summary({ id: 'x', name: 'X', cwd: null })],
      '/proj/alpha',
    );
    expect(inProject).toHaveLength(0);
    expect(other).toHaveLength(1);
  });
});

describe('filterSessionsByQuery', () => {
  const sessions = [
    summary({ id: '1', name: 'Auth work', cwd: '/proj/alpha' }),
    summary({ id: '2', name: 'Beta notes', cwd: '/proj/beta' }),
  ];

  it('matches name and path', () => {
    expect(filterSessionsByQuery(sessions, 'auth').map((s) => s.id)).toEqual(['1']);
    expect(filterSessionsByQuery(sessions, 'beta').map((s) => s.id)).toEqual(['2']);
    expect(filterSessionsByQuery(sessions, '/proj/alpha').map((s) => s.id)).toEqual([
      '1',
    ]);
  });
});

describe('groupSessionsByProject', () => {
  it('groups by directory and labels unknown', () => {
    const sessions = [
      summary({ id: '1', name: 'A', cwd: '/proj/alpha', updatedAt: 3 }),
      summary({ id: '2', name: 'B', cwd: '/proj/beta', updatedAt: 2 }),
      summary({ id: '3', name: 'C', cwd: null, updatedAt: 1 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0]?.label).toBe('alpha');
    expect(groups.find((g) => g.label === 'Other / Unknown')?.sessions).toHaveLength(1);
  });
});

describe('previewProjectSessions', () => {
  const sessions = [
    summary({ id: 'old', name: 'Old', updatedAt: 1 }),
    summary({ id: 'new', name: 'New', updatedAt: 3 }),
    summary({ id: 'middle', name: 'Middle', updatedAt: 2 }),
  ];

  it('shows the most recent bounded preview until a project is expanded', () => {
    expect(previewProjectSessions(sessions, false, 2).map((session) => session.id))
      .toEqual(['new', 'middle']);
    expect(previewProjectSessions(sessions, true, 2).map((session) => session.id))
      .toEqual(['new', 'middle', 'old']);
  });

  it('keeps an older selected session in the bounded preview', () => {
    expect(previewProjectSessions(sessions, false, 2, 'old').map((session) => session.id))
      .toEqual(['new', 'old']);
  });
});

describe('countProjectActivity', () => {
  it('aggregates work, attention, and unread state without using selected workspace', () => {
    const group = {
      path: '/proj/alpha',
      sessions: [summary({ id: 'a', name: 'A', cwd: '/proj/alpha' })],
    };
    const activity = (partial: Partial<SessionActivity> & Pick<SessionActivity, 'sessionId'>): SessionActivity => ({
      sessionId: partial.sessionId,
      cwd: partial.cwd ?? null,
      state: partial.state ?? 'idle',
      phase: partial.phase ?? null,
      detail: partial.detail ?? null,
      startedAt: partial.startedAt ?? null,
      updatedAt: partial.updatedAt ?? 1,
      completedAt: partial.completedAt ?? null,
      unread: partial.unread ?? false,
      backgroundProcessCount: partial.backgroundProcessCount ?? 0,
      canCancel: partial.canCancel ?? false,
    });

    expect(countProjectActivity(group, [
      activity({ sessionId: 'a', state: 'working' }),
      activity({ sessionId: 'unknown', cwd: '/proj/alpha/', state: 'needs_attention', unread: true }),
      activity({ sessionId: 'other', cwd: '/proj/beta', state: 'working', unread: true }),
    ])).toEqual({ working: 1, attention: 1, unread: 1 });
  });
});

describe('buildPrimarySessions', () => {
  const sessions = [
    summary({ id: 'a', name: 'Alpha chat', cwd: '/proj/alpha', updatedAt: 3 }),
    summary({ id: 'b', name: 'Beta chat', cwd: '/proj/beta', updatedAt: 2 }),
    summary({ id: 'c', name: 'Legacy', cwd: null, updatedAt: 1 }),
  ];

  it('defaults to in-project only', () => {
    const result = buildPrimarySessions({
      sessions,
      currentWorkspace: '/proj/alpha',
      query: '',
      activeSessionId: null,
    });
    expect(result.primary.map((s) => s.id)).toEqual(['a']);
    expect(result.otherCount).toBe(2);
    expect(result.isSearching).toBe(false);
  });

  it('search includes other-project sessions', () => {
    const result = buildPrimarySessions({
      sessions,
      currentWorkspace: '/proj/alpha',
      query: 'Beta',
      activeSessionId: null,
    });
    expect(result.primary.map((s) => s.id)).toEqual(['b']);
    expect(result.isSearching).toBe(true);
    expect(result.otherIds.has('b')).toBe(true);
  });

  it('pins active session when outside filter', () => {
    const result = buildPrimarySessions({
      sessions,
      currentWorkspace: '/proj/alpha',
      query: '',
      activeSessionId: 'b',
    });
    expect(result.primary.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('truncatePathDisplay', () => {
  it('keeps short paths intact and ellipsizes long ones', () => {
    expect(truncatePathDisplay('/short')).toBe('/short');
    const long = '/home/user/very/long/path/to/project';
    const out = truncatePathDisplay(long, 20);
    expect(out.startsWith('…/')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});

// ── Collapsed-project persistence (issue #163) ───────────────────────────────

describe('collapsed project persistence', () => {
  const storageKey = 'orchid-sidebar-collapsed-projects';

  function renderSidebar(sessions: SessionSummary[]) {
    return render(
      createElement(LeftSidebar, {
        isCollapsed: false,
        onToggle: () => {},
        sessionListState: { status: 'ready', sessions },
        activeSessionId: null,
        onSessionSelect: () => {},
        onSessionCreate: () => {},
        onSessionDelete: () => {},
        onRefreshSessions: () => {},
        onOpenSettings: () => {},
      }),
    );
  }

  function projectToggle(label: string): HTMLElement {
    return screen.getByRole('button', { name: new RegExp(label) });
  }

  const sessions = [
    summary({ id: 'a1', name: 'Alpha chat', cwd: '/proj/alpha', updatedAt: 2 }),
    summary({ id: 'b1', name: 'Beta chat', cwd: '/proj/beta', updatedAt: 1 }),
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('keeps a collapsed group collapsed across a remount (restart)', () => {
    renderSidebar(sessions);
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(projectToggle('beta').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(projectToggle('alpha'));
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Alpha chat')).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(['/proj/alpha']));

    // Unmount + remount simulates an app restart: state rehydrates from storage.
    cleanup();
    renderSidebar(sessions);
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Alpha chat')).toBeNull();
    expect(projectToggle('beta').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Beta chat')).toBeTruthy();

    // The restored group can still be expanded again (write-through updates).
    fireEvent.click(projectToggle('alpha'));
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Alpha chat')).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify([]));
  });

  it('starts fully expanded when storage is missing or corrupted', () => {
    localStorage.setItem(storageKey, '{not-json');
    renderSidebar(sessions);
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(projectToggle('beta').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Alpha chat')).toBeTruthy();
  });
});

// ── Project delete (issue #158) ──────────────────────────────────────────────

describe('project delete', () => {
  const deleteSessions = [
    summary({ id: 'a1', name: 'Alpha one', cwd: '/proj/alpha', updatedAt: 2 }),
    summary({ id: 'a2', name: 'Alpha two', cwd: '/proj/alpha', updatedAt: 1 }),
    summary({ id: 'b1', name: 'Beta chat', cwd: '/proj/beta', updatedAt: 3 }),
  ];

  function renderWithDelete(onProjectDelete: (project: {
    label: string;
    sessionIds: readonly string[];
  }) => void) {
    return render(
      createElement(LeftSidebar, {
        isCollapsed: false,
        onToggle: () => {},
        sessionListState: { status: 'ready', sessions: deleteSessions },
        activeSessionId: null,
        onSessionSelect: () => {},
        onSessionCreate: () => {},
        onSessionDelete: () => {},
        onRefreshSessions: () => {},
        onOpenSettings: () => {},
        onProjectDelete,
      }),
    );
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('confirms and reports every session id in the group', () => {
    const deleted: Array<readonly string[]> = [];
    renderWithDelete((project) => {
      deleted.push(project.sessionIds);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete all sessions in alpha' }));
    expect(screen.getByText(/Delete 2 sessions in alpha\?/)).toBeTruthy();

    // Cancel first — nothing deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleted).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete all sessions in alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project sessions' }));
    expect(deleted).toHaveLength(1);
    expect([...deleted[0]!].sort()).toEqual(['a1', 'a2']);
  });

  it('uses singular copy for a one-session group', () => {
    const deleted: Array<readonly string[]> = [];
    render(
      createElement(LeftSidebar, {
        isCollapsed: false,
        onToggle: () => {},
        sessionListState: { status: 'ready', sessions: [deleteSessions[2]!] },
        activeSessionId: null,
        onSessionSelect: () => {},
        onSessionCreate: () => {},
        onSessionDelete: () => {},
        onRefreshSessions: () => {},
        onOpenSettings: () => {},
        onProjectDelete: (project) => {
          deleted.push(project.sessionIds);
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete all sessions in beta' }));
    expect(screen.getByText(/Delete 1 session in beta\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete project sessions' }));
    expect(deleted).toHaveLength(1);
    expect([...deleted[0]!]).toEqual(['b1']);
  });

  it('does not render delete controls without a handler', () => {
    render(
      createElement(LeftSidebar, {
        isCollapsed: false,
        onToggle: () => {},
        sessionListState: { status: 'ready', sessions: deleteSessions },
        activeSessionId: null,
        onSessionSelect: () => {},
        onSessionCreate: () => {},
        onSessionDelete: () => {},
        onRefreshSessions: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(screen.queryByRole('button', { name: 'Delete all sessions in alpha' })).toBeNull();
  });
});
