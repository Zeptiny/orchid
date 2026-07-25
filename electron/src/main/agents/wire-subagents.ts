/**
 * Wire production subagent runtime: stream runner + session persistence + UI notify.
 *
 * Call once after tools are registered and the Electron app is ready.
 */
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getSubagentManager } from '../tools';
import { createSubagentStreamRunner } from './subagent-runner';
import { createSubagentPersistenceScheduler, persistSubagentChains } from './persist-subagent-chains';
import { flushSubagentEvents, isEligibleSubagentRecipient, queueSubagentEvent } from '../ipc/subagents';
import { SubagentState } from './manager';
import { clearToolCallHistoryForAgentScope } from '../permissions/history';

let wired = false;
let persistenceScheduler: ReturnType<typeof createSubagentPersistenceScheduler> | null = null;

// Re-export for callers that previously imported from this module.
export { persistSubagentChains } from './persist-subagent-chains';

/**
 * Attach the stream runner and onChange persistence to the shared SubagentManager.
 * Idempotent.
 */
export function wireSubagentRuntime(): void {
  if (wired) return;
  wired = true;

  const manager = getSubagentManager();
  manager.setRunner(createSubagentStreamRunner());
  persistenceScheduler = createSubagentPersistenceScheduler((sessionId) => {
    persistSubagentChains(manager, sessionId);
    broadcastSubagentsChanged(sessionId);
  });

  manager.setOnLiveChange((change) => {
    if (change.sessionId) persistenceScheduler?.markDirty(change.sessionId);
    queueSubagentEvent(change);
    if (change.sessionId &&
        (change.projection.state === SubagentState.COMPLETED ||
         change.projection.state === SubagentState.FAILED ||
         change.projection.state === SubagentState.INTERRUPTED)) {
      clearToolCallHistoryForAgentScope(change.sessionId, change.subagentId);
      flushSubagentEvents();
      persistenceScheduler?.flush(change.sessionId);
    } else {
      // Coalesced delivery handles ordinary live changes.
    }
  });

  manager.setOnChange((records) => {
    for (const sessionId of new Set(records
      .filter((record) => record.state !== SubagentState.COMPLETED &&
        record.state !== SubagentState.FAILED && record.state !== SubagentState.INTERRUPTED)
      .map((record) => record.sessionId).filter(Boolean) as string[])) {
      persistenceScheduler?.markDirty(sessionId);
    }
  });
}

/** Explicit orderly-shutdown hook; terminal writes are synchronous by design. */
export function flushSubagentPersistence(): void {
  flushSubagentEvents();
  const manager = getSubagentManager();
  if (persistenceScheduler) persistenceScheduler.flushAll();
  else persistSubagentChains(manager);
}

export function broadcastSubagentsChanged(
  sessionId: string,
  windows: readonly BrowserWindow[] = BrowserWindow.getAllWindows(),
): void {
  for (const win of windows) {
    try {
      if (!win.isDestroyed() && win.webContents && isEligibleSubagentRecipient(win.webContents, sessionId)) {
        win.webContents.send(IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED);
      }
    } catch {
      // window gone
    }
  }
}
