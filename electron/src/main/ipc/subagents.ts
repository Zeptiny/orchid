/** Session-affine subagent snapshot and live projection IPC. */
import { ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type SubagentDetailResult,
  type SubagentSnapshot,
} from '../../shared/types/ipc';
import type {
  SubagentRecord as DomainSubagentRecord,
  SubagentSummary,
} from '../../shared/types/subagent';
import { summarizeSubagentRecord } from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { getSessionManager } from '../session/singleton';
import { subagentDetailSchema, subagentSnapshotSchema } from './payload-schemas';
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

export function mergeSubagentSummaries(
  stored: readonly SubagentSummary[],
  runtime: readonly SubagentSummary[],
): SubagentSummary[] {
  const merged = new Map(stored.map((record) => [record.id, record]));
  for (const record of runtime) merged.set(record.id, record);
  return [...merged.values()];
}

export function selectSubagentDetailRecord(
  subagentId: string,
  stored: readonly DomainSubagentRecord[],
  runtime: DomainSubagentRecord | null,
): DomainSubagentRecord | null {
  return (runtime?.id === subagentId ? runtime : null)
    ?? stored.find((record) => record.id === subagentId)
    ?? null;
}

export function createSubagentSnapshot(sessionId: string): SubagentSnapshot {
  const manager = getSubagentManager();
  const stored = getSessionManager().getSubagentSummaries(sessionId);
  const runtime = manager.recordsForSession(sessionId)
    // Evicted terminal summaries are lean shadows of rows already confirmed
    // persisted. Exclude those shadows so the independently persisted summary
    // (including its precomputed usage) remains authoritative.
    .filter((record) => !manager.isSummary(record.id))
    .map((record) => summarizeSubagentRecord(
      manager.toDomainRecord(record, { includeLiveTail: false }),
    ));
  const records = mergeSubagentSummaries(stored, runtime);
  return {
    sessionId,
    sessionRevision: manager.getSessionRevision(sessionId),
    records,
    live: manager.getLiveProjections(sessionId),
  };
}

/** Materialize only the transcript explicitly selected in the renderer. */
export function createSubagentDetail(
  sessionId: string,
  subagentId: string,
): SubagentDetailResult {
  const manager = getSubagentManager();
  const candidate = manager.getRecord(subagentId);
  const runtime = candidate?.sessionId === sessionId && !manager.isSummary(candidate.id)
    ? manager.toDomainRecord(candidate, { includeLiveTail: true })
    : null;
  const stored = getSessionManager().getSubagentRecord(sessionId, subagentId);
  const record = runtime ?? stored;
  return { sessionId, subagentId, record };
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
  ipcMain.handle(IPC_CHANNELS.SUBAGENTS_DETAIL, (_event, raw: unknown) => {
    const parsed = subagentDetailSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid subagent detail request: ${parsed.error.message}`);
    return createSubagentDetail(parsed.data.sessionId, parsed.data.subagentId);
  });
}

export function unregisterSubagentIPC(): void {
  if (!wired) return;
  wired = false;
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.SUBAGENTS_DETAIL);
  flushSubagentDeltas();
}
