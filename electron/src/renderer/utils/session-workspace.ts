/**
 * Pure helpers for project-scoped session list (U6).
 *
 * Path comparison uses a normalized absolute key (trailing-slash stripped,
 * separators folded). Exact-path membership only (R10) — no parent/child.
 */
import type {
  SessionActivity,
  SessionSummary,
} from '../../shared/types/ipc-boundary';

/** Normalize a cwd for equality comparison; null/empty → null (unknown). */
export function normalizeWorkspaceKey(
  cwd: string | null | undefined,
): string | null {
  if (cwd == null) return null;
  let s = cwd.trim();
  if (!s) return null;

  // Strip trailing separators (keep filesystem root and drive roots).
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) {
    s = s.slice(0, -1);
  }
  // Windows drive letter case-fold for stable compare.
  if (/^[A-Za-z]:[\\/]/.test(s) || /^[A-Za-z]:$/.test(s)) {
    s = s[0]!.toLowerCase() + s.slice(1);
  }
  return s.replace(/\\/g, '/');
}

export function pathsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = normalizeWorkspaceKey(a);
  const kb = normalizeWorkspaceKey(b);
  if (ka === null || kb === null) return false;
  return ka === kb;
}

export interface PartitionedSessions {
  inProject: SessionSummary[];
  other: SessionSummary[];
}

/**
 * Split sessions into current workspace vs everything else.
 * Null/missing session cwd always lands in `other` (R9).
 * When `currentWorkspace` is unbound, every session is `other`.
 */
export function partitionSessionsByWorkspace(
  sessions: readonly SessionSummary[],
  currentWorkspace: string | null | undefined,
): PartitionedSessions {
  const key = normalizeWorkspaceKey(currentWorkspace);
  const inProject: SessionSummary[] = [];
  const other: SessionSummary[] = [];

  for (const session of sessions) {
    const sk = normalizeWorkspaceKey(session.cwd);
    if (key !== null && sk !== null && sk === key) {
      inProject.push(session);
    } else {
      other.push(session);
    }
  }

  return { inProject, other };
}

/** Filter sessions by name / display-only model label / cwd path (search is global). */
export function filterSessionsByQuery(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sessions];
  return sessions.filter((session) => {
    return (
      session.name.toLowerCase().includes(q) ||
      (session.modelLabel ?? '').toLowerCase().includes(q) ||
      (session.cwd ?? '').toLowerCase().includes(q)
    );
  });
}

export interface DateGroup {
  label: string;
  sessions: SessionSummary[];
}

/** Date buckets: Today / Yesterday / This week / Earlier. */
export function groupSessionsByDate(
  sessions: readonly SessionSummary[],
  now: Date = new Date(),
): DateGroup[] {
  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekAgo = today - 7 * 24 * 60 * 60 * 1000;
  const groups = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const updated = startOfDay(new Date(session.updatedAt)).getTime();
    let label = 'Earlier';
    if (updated >= today) label = 'Today';
    else if (updated >= yesterday) label = 'Yesterday';
    else if (updated >= weekAgo) label = 'This week';
    const bucket = groups.get(label) ?? [];
    bucket.push(session);
    groups.set(label, bucket);
  }

  return (['Today', 'Yesterday', 'This week', 'Earlier'] as const)
    .map((label) => ({ label, sessions: groups.get(label) ?? [] }))
    .filter((group) => group.sessions.length > 0);
}

export interface ProjectGroup {
  /** Normalized key; empty string means unknown/null cwd. */
  key: string;
  /** Display label (basename or "Other / Unknown"). */
  label: string;
  /** Full path for title tooltip (null when unknown). */
  path: string | null;
  sessions: SessionSummary[];
}

export interface ProjectActivityCounts {
  working: number;
  attention: number;
  unread: number;
}

/** Number of recent sessions visible before a project group is expanded. */
export const PROJECT_SESSION_PREVIEW_LIMIT = 5;

/**
 * Return the newest project sessions for a compact sidebar group, or every
 * session after the user explicitly expands that project.
 */
export function previewProjectSessions(
  sessions: readonly SessionSummary[],
  expanded: boolean,
  limit = PROJECT_SESSION_PREVIEW_LIMIT,
  selectedSessionId?: string | null,
): SessionSummary[] {
  const newestFirst = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if (expanded) return newestFirst;

  const preview = newestFirst.slice(0, limit);
  const selected = selectedSessionId
    ? newestFirst.find((session) => session.id === selectedSessionId)
    : undefined;
  if (!selected || preview.some((session) => session.id === selected.id)) {
    return preview;
  }

  // Keep the bounded list while retaining the session the center pane shows.
  return [...preview.slice(0, Math.max(0, limit - 1)), selected];
}

/** Aggregate execution indicators for a project group without using selection. */
export function countProjectActivity(
  group: Pick<ProjectGroup, 'path' | 'sessions'>,
  activities: readonly SessionActivity[],
): ProjectActivityCounts {
  const ids = new Set(group.sessions.map((session) => session.id));
  const projectKey = normalizeWorkspaceKey(group.path);
  const counts: ProjectActivityCounts = { working: 0, attention: 0, unread: 0 };

  for (const activity of activities) {
    const belongsBySession = ids.has(activity.sessionId);
    const belongsByProject =
      !belongsBySession &&
      projectKey != null &&
      normalizeWorkspaceKey(activity.cwd) === projectKey;
    if (!belongsBySession && !belongsByProject) continue;
    if (activity.state === 'working' || activity.state === 'waiting') {
      counts.working += 1;
    }
    if (activity.state === 'needs_attention') counts.attention += 1;
    if (activity.unread) counts.unread += 1;
  }
  return counts;
}

/**
 * Group sessions by their cwd directory. Null cwd → "Other / Unknown".
 * Groups ordered by most-recent session within the group.
 */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
): ProjectGroup[] {
  const map = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const key = normalizeWorkspaceKey(session.cwd) ?? '';
    const bucket = map.get(key) ?? [];
    bucket.push(session);
    map.set(key, bucket);
  }

  const groups: ProjectGroup[] = [];
  for (const [key, list] of map) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    const path = key === '' ? null : (list[0]?.cwd ?? null);
    groups.push({
      key: key === '' ? '__unknown__' : key,
      label: path ? basenamelike(path) : 'Other / Unknown',
      path,
      sessions: list,
    });
  }

  groups.sort((a, b) => {
    const aMax = Math.max(...a.sessions.map((s) => s.updatedAt));
    const bMax = Math.max(...b.sessions.map((s) => s.updatedAt));
    return bMax - aMax;
  });

  return groups;
}

/**
 * Build the list of sessions shown in the primary (date-grouped) section.
 * - Search non-empty → all matching sessions (global).
 * - Default → in-project only, plus active session if it would be filtered out.
 */
export function buildPrimarySessions(options: {
  sessions: readonly SessionSummary[];
  currentWorkspace: string | null | undefined;
  query: string;
  activeSessionId: string | null;
}): {
  primary: SessionSummary[];
  other: SessionSummary[];
  otherCount: number;
  isSearching: boolean;
  /** Session ids that are outside the current workspace (for path hints). */
  otherIds: Set<string>;
} {
  const { sessions, currentWorkspace, query, activeSessionId } = options;
  const isSearching = query.trim().length > 0;
  const { inProject, other } = partitionSessionsByWorkspace(
    sessions,
    currentWorkspace,
  );
  const otherIds = new Set(other.map((s) => s.id));

  if (isSearching) {
    const matched = filterSessionsByQuery(sessions, query);
    return {
      primary: matched,
      other,
      otherCount: other.length,
      isSearching: true,
      otherIds,
    };
  }

  // Pin active session when it sits outside the project filter.
  let primary = [...inProject];
  if (activeSessionId) {
    const already = primary.some((s) => s.id === activeSessionId);
    if (!already) {
      const active = sessions.find((s) => s.id === activeSessionId);
      if (active) {
        primary = [active, ...primary];
      }
    }
  }

  return {
    primary,
    other,
    otherCount: other.length,
    isSearching: false,
    otherIds,
  };
}

/** Truncate a path for chrome (prefer trailing segment visibility). */
export function truncatePathDisplay(cwd: string, maxLen = 32): string {
  const normalized = cwd.replace(/\\/g, '/');
  if (normalized.length <= maxLen) return normalized;
  const slice = normalized.slice(-(maxLen - 1));
  const slash = slice.indexOf('/');
  const tail = slash >= 0 ? slice.slice(slash + 1) : slice;
  return `…/${tail}`;
}

function basenamelike(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
