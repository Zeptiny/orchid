/**
 * Persist in-memory subagent records onto their owning sessions.
 *
 * Extracted so tools (wait) and wire-subagents can share the logic without a
 * circular import through tools ↔ wire-subagents.
 */
import type { SubagentRecord as DomainSubagentRecord } from '../../shared/types/subagent';
import { getSessionManager } from '../ipc/session';
import type { SubagentManager } from './manager';
import { runtimeToDomain } from './manager';

/**
 * Group runtime records by `sessionId` and call `syncSubagentChains` per owner.
 *
 * A debounced flush after session switch must not write prior-session chains
 * into `getActive()`. Records without a sessionId fall back to the active
 * session (tests / edge cases).
 */
export function persistSubagentChains(manager: SubagentManager): void {
  const bySession = new Map<string, DomainSubagentRecord[]>();
  const unscoped: DomainSubagentRecord[] = [];

  for (const record of manager.allRecords()) {
    const domain = runtimeToDomain(record);
    if (record.sessionId) {
      const list = bySession.get(record.sessionId) ?? [];
      list.push(domain);
      bySession.set(record.sessionId, list);
    } else {
      unscoped.push(domain);
    }
  }

  const sessionManager = getSessionManager();

  for (const [sessionId, records] of bySession) {
    try {
      sessionManager.syncSubagentChains(records, sessionId);
    } catch (err) {
      console.debug(
        `Failed to persist subagent chains for session ${sessionId} (non-fatal):`,
        err,
      );
    }
  }

  if (unscoped.length > 0) {
    try {
      sessionManager.syncSubagentChains(unscoped);
    } catch (err) {
      console.debug('Failed to persist unscoped subagent chains (non-fatal):', err);
    }
  }
}
