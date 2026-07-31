/**
 * Runtime-facing recovery seam for subagent persistence.
 *
 * Tools can request a recovery flush without importing the production wiring
 * module, which otherwise pulls the stream runner and tool registry back into
 * the tool graph.
 */
import type { SubagentManager } from './manager';
import {
  persistSubagentChains,
  trackedSubagentPersistenceSessions,
} from './persist-subagent-chains';

interface SubagentPersistenceRecoveryScheduler {
  recover: (sessionId: string) => void;
  recoverAll: (sessionIds?: Iterable<string>) => void;
}

let scheduler: SubagentPersistenceRecoveryScheduler | null = null;

export function setSubagentPersistenceRecoveryScheduler(
  nextScheduler: SubagentPersistenceRecoveryScheduler | null,
): void {
  scheduler = nextScheduler;
}

/** Explicit recovery for a user retry or an external storage recovery signal. */
export function recoverSubagentPersistence(
  manager: SubagentManager,
  sessionId?: string,
): void {
  if (scheduler) {
    if (sessionId) scheduler.recover(sessionId);
    else scheduler.recoverAll(trackedSubagentPersistenceSessions());
    return;
  }
  persistSubagentChains(manager, sessionId, { recovery: true });
}
