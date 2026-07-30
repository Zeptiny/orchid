import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SessionActivity } from '../../shared/types/ipc-boundary';
import {
  sessionActivityStore,
  type SessionActivityUpdate,
} from '../session/activity';
import { hasLiveMainTurn } from './chat/state';
import { getSubagentManager } from '../tools';
import { SubagentState } from '../agents/types';
import {
  getBackgroundStore,
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';

const markSeenSchema = z.object({ id: z.string().uuid() });

function backgroundProcessCount(sessionId: string): number {
  try {
    return getBackgroundStore()
      .list()
      .filter((entry) => entry.sessionId === sessionId && entry.exitCode === null)
      .length;
  } catch {
    return 0;
  }
}

function liveSubagentCounts(sessionId: string): { queued: number; active: number } {
  try {
    let queued = 0;
    let active = 0;
    for (const { state } of getSubagentManager().getStates(sessionId)) {
      if (state === SubagentState.QUEUED) queued += 1;
      if (state === SubagentState.PENDING || state === SubagentState.RUNNING) active += 1;
    }
    return { queued, active };
  } catch {
    return { queued: 0, active: 0 };
  }
}

function subagentDetail({ queued, active }: { queued: number; active: number }): string {
  const total = queued + active;
  const noun = total === 1 ? 'subagent' : 'subagents';
  if (active > 0 && queued > 0) return `${active} running · ${queued} queued ${noun}`;
  if (active > 0) return `${active} ${noun} running`;
  return `${queued} ${noun} queued`;
}

function completeActivity(
  sessionId: string,
  unread: boolean,
  backgroundProcessCount: number,
): SessionActivity {
  sessionActivityStore.complete(sessionId, unread);
  return sessionActivityStore.update(sessionId, { backgroundProcessCount });
}

/**
 * Fold session-owned asynchronous work into the persisted activity row.
 * The renderer consumes this one canonical snapshot; it does not need to
 * independently infer whether subagents or commands keep a session alive.
 */
function reconcileSessionActivity(
  sessionId: string,
  options: { completing?: boolean; unread?: boolean } = {},
): SessionActivity | null {
  const subagents = liveSubagentCounts(sessionId);
  const backgroundCount = backgroundProcessCount(sessionId);
  const hasSubagents = subagents.queued + subagents.active > 0;
  const hasBackgroundProcesses = backgroundCount > 0;
  const current = sessionActivityStore.get(sessionId);

  if (!current && !hasSubagents && !hasBackgroundProcesses) return null;
  const base = current ?? sessionActivityStore.update(sessionId, {});

  if (hasSubagents) {
    // A terminal main turn must not overwrite work delegated to this session.
    // Preserve an explicit error state, but keep its Stop affordance live.
    if (base.state === 'needs_attention' && !options.completing) {
      return sessionActivityStore.update(sessionId, {
        backgroundProcessCount: backgroundCount,
        canCancel: true,
      });
    }
    return sessionActivityStore.update(sessionId, {
      state: subagents.active > 0 ? 'working' : 'waiting',
      phase: 'subagent',
      detail: subagentDetail(subagents),
      startedAt: base.startedAt ?? Date.now(),
      completedAt: null,
      unread: false,
      backgroundProcessCount: backgroundCount,
      canCancel: true,
    });
  }

  if (hasBackgroundProcesses) {
    // While the main turn remains active, retain its more specific state.
    if (
      !options.completing &&
      (base.state === 'working' || base.state === 'waiting') &&
      base.phase !== 'subagent'
    ) {
      return sessionActivityStore.update(sessionId, { backgroundProcessCount: backgroundCount });
    }
    if (base.state === 'needs_attention' && !options.completing) {
      return sessionActivityStore.update(sessionId, {
        backgroundProcessCount: backgroundCount,
        canCancel: true,
      });
    }
    return sessionActivityStore.update(sessionId, {
      state: 'idle',
      phase: 'command',
      detail: null,
      startedAt: base.startedAt ?? Date.now(),
      completedAt: null,
      unread: false,
      backgroundProcessCount: backgroundCount,
      canCancel: true,
    });
  }

  if (options.completing) {
    return completeActivity(sessionId, options.unread ?? false, backgroundCount);
  }

  // Subagent activity temporarily replaces the parent's display phase. Once
  // the child exits, recover the still-live main turn from its authoritative
  // registry rather than treating the former auxiliary phase as terminal.
  if (hasLiveMainTurn(sessionId)) {
    return sessionActivityStore.update(sessionId, {
      state: 'working',
      phase: 'agent',
      detail: 'Generating response',
      startedAt: base.startedAt ?? Date.now(),
      completedAt: null,
      unread: false,
      backgroundProcessCount: backgroundCount,
      canCancel: true,
    });
  }

  // An auxiliary-work row becomes a normal completion only after its final
  // subagent/process exits. Do not disturb an independently active main turn.
  if (base.phase === 'subagent' || base.phase === 'command') {
    return completeActivity(sessionId, options.unread ?? true, backgroundCount);
  }
  return sessionActivityStore.update(sessionId, {
    backgroundProcessCount: 0,
    canCancel: base.state === 'working' || base.state === 'waiting' ? base.canCancel : false,
  });
}

function broadcast(activity: SessionActivity): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, { activity });
  }
}

/** Update and broadcast one session's global activity state. */
export function publishSessionActivity(
  sessionId: string,
  patch: SessionActivityUpdate,
): SessionActivity {
  sessionActivityStore.update(sessionId, {
    ...patch,
    backgroundProcessCount: backgroundProcessCount(sessionId),
  });
  const activity = reconcileSessionActivity(sessionId) ?? sessionActivityStore.get(sessionId)!;
  broadcast(activity);
  return activity;
}

/** Mark a main turn terminal, unless session-owned work is still live. */
export function completeSessionActivity(
  sessionId: string,
  unread: boolean,
): SessionActivity {
  const activity = reconcileSessionActivity(sessionId, { completing: true, unread })
    ?? sessionActivityStore.complete(sessionId, unread);
  broadcast(activity);
  return activity;
}

/** Refresh one row after a subagent or background-command lifecycle change. */
export function refreshSessionActivity(sessionId: string): SessionActivity | null {
  const activity = reconcileSessionActivity(sessionId);
  if (activity) broadcast(activity);
  return activity;
}

let removeSubagentChangeListener: (() => void) | null = null;
let removeBackgroundProcessChangeListener: (() => void) | null = null;

export function removeSessionActivity(sessionId: string): void {
  const previous = sessionActivityStore.get(sessionId);
  if (!previous) return;
  // Tombstone: idle + seen + no bg so list filters out and renderers prune.
  const tombstone = sessionActivityStore.update(sessionId, {
    state: 'idle',
    phase: null,
    detail: null,
    unread: false,
    canCancel: false,
    backgroundProcessCount: 0,
    completedAt: Date.now(),
  });
  sessionActivityStore.remove(sessionId);
  broadcast(tombstone);
}

export function registerSessionActivityIPC(): void {
  removeSubagentChangeListener ??= getSubagentManager().addOnChangeListener((records) => {
    for (const sessionId of new Set(
      records.map((record) => record.sessionId).filter((id): id is string => id !== null),
    )) {
      refreshSessionActivity(sessionId);
    }
  });
  removeBackgroundProcessChangeListener ??= subscribeBackgroundProcessChanges((sessionId) => {
    if (sessionId) refreshSessionActivity(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_ACTIVITY_LIST, async () => {
    const sessionIds = new Set(sessionActivityStore.list().map((activity) => activity.sessionId));
    try {
      for (const record of getSubagentManager().allRecords()) {
        if (record.sessionId) sessionIds.add(record.sessionId);
      }
      for (const process of getBackgroundStore().list()) {
        if (process.sessionId && process.exitCode === null) sessionIds.add(process.sessionId);
      }
    } catch {
      // Activity remains usable before optional runtime services initialize.
    }
    for (const sessionId of sessionIds) {
      reconcileSessionActivity(sessionId);
    }
    return sessionActivityStore.list();
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
    async (_event, payload: unknown) => {
      const parsed = markSeenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid session:activity_mark_seen payload: ${parsed.error.message}`);
      }
      const activity = sessionActivityStore.markSeen(parsed.data.id);
      if (activity) broadcast(activity);
      return activity;
    },
  );
}

export function unregisterSessionActivityIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN);
  removeSubagentChangeListener?.();
  removeSubagentChangeListener = null;
  removeBackgroundProcessChangeListener?.();
  removeBackgroundProcessChangeListener = null;
  sessionActivityStore.clear();
}
