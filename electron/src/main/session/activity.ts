import type {
  SessionActivity,
  SessionActivityPhase,
  SessionExecutionState,
} from '../../shared/types/ipc-boundary';

export type SessionActivityUpdate = Partial<
  Omit<SessionActivity, 'sessionId' | 'updatedAt'>
> & {
  state?: SessionExecutionState;
  phase?: SessionActivityPhase;
};

const PRIORITY: Record<SessionExecutionState, number> = {
  needs_attention: 0,
  working: 1,
  waiting: 2,
  idle: 3,
};

function emptyActivity(sessionId: string, now: number): SessionActivity {
  return {
    sessionId,
    cwd: null,
    state: 'idle',
    phase: null,
    detail: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    unread: false,
    backgroundProcessCount: 0,
    canCancel: false,
  };
}

/** In-memory execution directory used by IPC and every renderer window. */
export class SessionActivityStore {
  private readonly activities = new Map<string, SessionActivity>();

  get(sessionId: string): SessionActivity | null {
    return this.activities.get(sessionId) ?? null;
  }

  update(
    sessionId: string,
    patch: SessionActivityUpdate,
    now: number = Date.now(),
  ): SessionActivity {
    const existing = this.activities.get(sessionId);
    const previous = existing ?? emptyActivity(sessionId, now);
    const next: SessionActivity = Object.freeze({
      ...previous,
      ...patch,
      sessionId,
      updatedAt: existing ? Math.max(now, existing.updatedAt + 1) : now,
    });
    this.activities.set(sessionId, next);
    return next;
  }

  complete(
    sessionId: string,
    unread: boolean,
    now: number = Date.now(),
  ): SessionActivity {
    return this.update(sessionId, {
      state: 'idle',
      phase: null,
      detail: null,
      completedAt: now,
      unread,
      canCancel: false,
    }, now);
  }

  markSeen(sessionId: string, now: number = Date.now()): SessionActivity | null {
    const current = this.activities.get(sessionId);
    if (!current) return null;
    return this.update(sessionId, { unread: false }, now);
  }

  remove(sessionId: string): boolean {
    return this.activities.delete(sessionId);
  }

  list(): SessionActivity[] {
    return [...this.activities.values()]
      .filter((activity) =>
        activity.state !== 'idle' ||
        activity.unread ||
        activity.backgroundProcessCount > 0,
      )
      .sort((a, b) => {
        const priority = PRIORITY[a.state] - PRIORITY[b.state];
        if (priority !== 0) return priority;
        if (a.state === 'idle' && b.state === 'idle') {
          if (a.unread !== b.unread) return a.unread ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
  }

  clear(): void {
    this.activities.clear();
  }
}

export const sessionActivityStore = new SessionActivityStore();
