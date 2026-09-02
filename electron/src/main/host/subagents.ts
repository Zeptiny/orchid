/**
 * Session-affine subagent snapshot/detail builders — electron-free core
 * shared by the subagents IPC boundary (ipc/subagents.ts) and the host
 * protocol (host/server.ts).
 */
import type {
  SubagentDetailResult,
  SubagentSnapshot,
} from '../../shared/types/ipc';
import type {
  SubagentRecord as DomainSubagentRecord,
  SubagentSummary,
} from '../../shared/types/subagent';
import { summarizeSubagentRecord } from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { getSessionManager } from '../session/singleton';

export function mergeSubagentRecords(stored: readonly DomainSubagentRecord[], runtime: readonly DomainSubagentRecord[]) {
  const merged = new Map(stored.map((record) => [record.id, record]));
  for (const record of runtime) merged.set(record.id, record);
  return [...merged.values()];
}

/** Merge stored summaries with runtime state, giving live records precedence. */
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
