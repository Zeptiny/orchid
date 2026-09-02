/**
 * Pure predicates behind the ChatView shell — the multi-part conditions the
 * view asks of session-list, activity, and workspace state.
 */
import type { SessionActivity, SessionSummary } from '../../../shared/types/ipc-boundary';
import type { Session } from '../../../shared/types/session';
import type { SessionListState } from '../../hooks/useSession';

/** A settled session list can restore the durable tab strip (or an empty draft). */
export function hasSettledSessionList(listState: SessionListState): boolean {
  return (
    listState.status === 'ready'
    || listState.status === 'partial'
    || listState.status === 'empty'
  );
}

/** Summaries safe to hand the rail, tab strip, palette, and composer. */
export function visibleSessionSummaries(listState: SessionListState): SessionSummary[] {
  return listState.status === 'ready' || listState.status === 'partial'
    ? listState.sessions
    : [];
}

/** An activity row that means the session still has work in flight. */
export function marksLiveSessionActivity(activity: SessionActivity | undefined): boolean {
  if (!activity) return false;
  const reportsProgress = activity.state === 'working'
    || activity.state === 'waiting'
    || activity.state === 'needs_attention';
  return reportsProgress || activity.canCancel;
}

/** A session with durable chains starts a new chat instead of continuing in place. */
export function hasPersistedChains(session: Session | null): boolean {
  return Boolean(session?.chains.length);
}

/** Project row of the draft tab: last path segment of the bound workspace. */
export function workspaceProjectName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? null;
}
