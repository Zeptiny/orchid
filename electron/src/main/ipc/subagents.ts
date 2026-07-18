/** Session-affine subagent snapshot and live projection IPC. */
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SubagentEvent, SubagentSnapshot } from '../../shared/types/ipc';
import type { SubagentRecord as DomainSubagentRecord, SubagentLiveChange } from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { getSessionManager } from './session';
import { subagentSnapshotSchema } from './payload-schemas';
import { runtimeToDomain } from '../agents/manager';

export function mergeSubagentRecords(stored: readonly DomainSubagentRecord[], runtime: readonly DomainSubagentRecord[]) {
  const merged = new Map(stored.map((record) => [record.id, record]));
  for (const record of runtime) merged.set(record.id, record);
  return [...merged.values()];
}

export function createSubagentSnapshot(sessionId: string): SubagentSnapshot {
  const manager = getSubagentManager();
  const session = getSessionManager().getSession(sessionId);
  const runtime = manager.allRecords()
    .filter((record) => record.sessionId === sessionId)
    .map((record) => runtimeToDomain(record, { includeLiveTail: false }));
  const records = mergeSubagentRecords(session?.subagentChains ?? [], runtime);
  return {
    sessionId,
    records,
    live: manager.getLiveProjections(sessionId),
  };
}

export function isEligibleSubagentRecipient(contents: WebContents, sessionId: string): boolean {
  if (contents.isDestroyed()) return false;
  return getSessionManager().getActive(String(contents.id))?.id === sessionId;
}

export function deliverSubagentChange(
  change: SubagentLiveChange,
  windows: readonly BrowserWindow[] = BrowserWindow.getAllWindows(),
): void {
  if (!change.sessionId) return;
  const event: SubagentEvent = {
    sessionId: change.sessionId,
    subagentId: change.subagentId,
    runId: change.runId,
    sequence: change.sequence,
    type: 'projection',
    projection: change.projection,
    record: (() => {
      const record = getSubagentManager().getRecord(change.subagentId);
      return record ? runtimeToDomain(record, { includeLiveTail: false }) : undefined;
    })(),
  };
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && isEligibleSubagentRecipient(win.webContents, change.sessionId)) {
        win.webContents.send(IPC_CHANNELS.SUBAGENTS_EVENT, event);
      }
    } catch { /* window closed between targeting and send */ }
  }
}

export interface EventTimerApi {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createSubagentEventCoalescer(
  deliver: (change: SubagentLiveChange) => void,
  timers: EventTimerApi = { setTimeout, clearTimeout },
) {
  let pending = new Map<string, SubagentLiveChange>();
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (frameTimer) timers.clearTimeout(frameTimer);
    if (maxTimer) timers.clearTimeout(maxTimer);
    frameTimer = maxTimer = null;
    const changes = [...pending.values()];
    pending = new Map();
    for (const change of changes) deliver(change);
  };
  return {
    queue(change: SubagentLiveChange): void {
      pending.set(`${change.sessionId}:${change.subagentId}`, change);
      if (!frameTimer) frameTimer = timers.setTimeout(flush, 16);
      if (!maxTimer) maxTimer = timers.setTimeout(flush, 50);
    },
    flush,
  };
}

let wired = false;
const eventCoalescer = createSubagentEventCoalescer((change) => deliverSubagentChange(change));
export function queueSubagentEvent(change: SubagentLiveChange): void { eventCoalescer.queue(change); }

export function registerSubagentIPC(): void {
  if (wired) return;
  wired = true;
  ipcMain.handle(IPC_CHANNELS.SUBAGENTS_SNAPSHOT, (_event, raw: unknown) => {
    const parsed = subagentSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid subagent snapshot request: ${parsed.error.message}`);
    return createSubagentSnapshot(parsed.data.sessionId);
  });
}

export function unregisterSubagentIPC(): void {
  if (!wired) return;
  wired = false;
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_SNAPSHOT);
  eventCoalescer.flush();
}

export function flushSubagentEvents(): void { eventCoalescer.flush(); }
