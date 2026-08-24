/** Session-affine subagent snapshot and live projection IPC. */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { subagentDetailSchema, subagentSnapshotSchema } from './payload-schemas';
import { flushSubagentDeltas } from '../agents/subagent-events';
import { hostRequest } from './host-request';

// Snapshot/detail builders relocated to host/subagents.ts (electron-free,
// shared with the headless host); re-exported for existing consumers.
export {
  createSubagentDetail,
  createSubagentSnapshot,
  mergeSubagentRecords,
  mergeSubagentSummaries,
  selectSubagentDetailRecord,
} from '../host/subagents';

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

let wired = false;

export function registerSubagentIPC(): void {
  if (wired) return;
  wired = true;
  ipcMain.handle(IPC_CHANNELS.SUBAGENTS_SNAPSHOT, (event, raw: unknown) => {
    const parsed = subagentSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid subagent snapshot request: ${parsed.error.message}`);
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SUBAGENTS_SNAPSHOT, parsed.data);
  });
  ipcMain.handle(IPC_CHANNELS.SUBAGENTS_DETAIL, (event, raw: unknown) => {
    const parsed = subagentDetailSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid subagent detail request: ${parsed.error.message}`);
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SUBAGENTS_DETAIL, parsed.data);
  });
}

export function unregisterSubagentIPC(): void {
  if (!wired) return;
  wired = false;
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_DETAIL);
  flushSubagentDeltas();
}
