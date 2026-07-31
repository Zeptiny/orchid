/** Session-affine subagent snapshot and live projection IPC. */
import { ipcMain } from 'electron';
import { IPC_CHANNELS, type SubagentSnapshot } from '../../shared/types/ipc';
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { getSessionManager } from '../session/singleton';
import { subagentSnapshotSchema } from './payload-schemas';
import { runtimeToDomain } from '../agents/manager';
import { flushSubagentDeltas } from '../agents/subagent-events';

// Compatibility exports for existing IPC consumers. Event ownership lives in
// the agents runtime so the runtime never has to import IPC registration.
export {
  createSubagentDeltaBatcher,
  deliverSubagentDeltaEvent,
  flushSubagentDeltas,
  isEligibleSubagentRecipient,
  mergeAppendDeltas,
  queueSubagentDelta,
  resolveSubagentDeltaBudgets,
} from '../agents/subagent-events';
export type {
  EventTimerApi,
  SubagentDeltaBatcherOptions,
  SubagentDeltaBudgets,
} from '../agents/subagent-events';

export function mergeSubagentRecords(stored: readonly DomainSubagentRecord[], runtime: readonly DomainSubagentRecord[]) {
  const merged = new Map(stored.map((record) => [record.id, record]));
  for (const record of runtime) merged.set(record.id, record);
  return [...merged.values()];
}

export function createSubagentSnapshot(sessionId: string): SubagentSnapshot {
  const manager = getSubagentManager();
  const session = getSessionManager().getSession(sessionId);
  const runtime = manager.allRecords()
    // Evicted terminal summaries are lean shadows of rows already confirmed
    // persisted. Merge order gives runtime precedence over stored rows, so
    // exclude summaries here and let the full stored row (chain messages and
    // derived usage) win.
    .filter((record) => record.sessionId === sessionId && !record._evicted)
    .map((record) => runtimeToDomain(record, { includeLiveTail: false }));
  const records = mergeSubagentRecords(session?.subagentChains ?? [], runtime);
  return {
    sessionId,
    sessionRevision: manager.getSessionRevision(sessionId),
    records,
    live: manager.getLiveProjections(sessionId),
  };
}

let wired = false;

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
  flushSubagentDeltas();
}
