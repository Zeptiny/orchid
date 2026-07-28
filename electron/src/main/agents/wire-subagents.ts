/**
 * Wire production subagent runtime: stream runner + session persistence + UI notify.
 *
 * Call once after tools are registered and the Electron app is ready.
 */
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SubagentDeltaEvent } from '../../shared/types/subagent';
import { getSubagentManager } from '../tools';
import { createSubagentStreamRunner } from './subagent-runner';
import { createSubagentPersistenceScheduler, persistSubagentChains } from './persist-subagent-chains';
import {
  flushSubagentEvents,
  isEligibleSubagentRecipient,
  queueSubagentDelta,
} from '../ipc/subagents';
import { SubagentState } from './manager';
import { clearToolCallHistoryForAgentScope } from '../permissions/history';
import { onSessionDeleted } from '../session/manager';
import { onSessionStorageRecovered } from '../session/storage';

let wired = false;
let persistenceScheduler: ReturnType<typeof createSubagentPersistenceScheduler> | null = null;
let removeSessionDeletionCleanup: (() => void) | null = null;
let removeStorageRecoveryListener: (() => void) | null = null;

// Re-export for callers that previously imported from this module.
export { persistSubagentChains } from './persist-subagent-chains';

export interface SubagentDeltaHandlerDeps {
  markDirty: (sessionId: string) => void;
  flushPersistence: (sessionId: string) => void;
  clearToolCallHistory: (sessionId: string, agentScopeId: string) => void;
  queueDelta: (event: SubagentDeltaEvent) => void;
  flushDeltas: () => void;
}

/**
 * Route the manager's delta stream: every delta dirties its session for the
 * next persistence checkpoint and rides the batcher; a terminal delta
 * additionally drops the run's permission history and flushes delivery and
 * persistence immediately so the durable handoff lands without a debounce.
 */
export function createSubagentDeltaHandler(
  deps: SubagentDeltaHandlerDeps,
): (event: SubagentDeltaEvent) => void {
  return (event) => {
    if (event.sessionId) deps.markDirty(event.sessionId);
    deps.queueDelta(event);
    if (event.type === 'terminal' && event.sessionId) {
      deps.clearToolCallHistory(event.sessionId, event.subagentId);
      deps.flushDeltas();
      deps.flushPersistence(event.sessionId);
    }
  };
}

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
  removeSessionDeletionCleanup = onSessionDeleted((sessionId) => {
    persistenceScheduler?.clear(sessionId);
  });
  removeStorageRecoveryListener = onSessionStorageRecovered(() => {
    persistenceScheduler?.recoverAll();
  });

  manager.setOnDelta(createSubagentDeltaHandler({
    markDirty: (sessionId) => persistenceScheduler?.markDirty(sessionId),
    flushPersistence: (sessionId) => persistenceScheduler?.flush(sessionId),
    clearToolCallHistory: clearToolCallHistoryForAgentScope,
    queueDelta: queueSubagentDelta,
    flushDeltas: flushSubagentEvents,
  }));

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

/** Explicit recovery for a user retry or an external storage recovery signal. */
export function recoverSubagentPersistence(sessionId?: string): void {
  if (persistenceScheduler) {
    if (sessionId) persistenceScheduler.recover(sessionId);
    else persistenceScheduler.recoverAll();
    return;
  }
  persistSubagentChains(getSubagentManager(), sessionId);
}

/** Release retry timers and lifecycle hooks after the final shutdown flush. */
export function disposeSubagentPersistence(): void {
  persistenceScheduler?.dispose();
  persistenceScheduler = null;
  removeSessionDeletionCleanup?.();
  removeSessionDeletionCleanup = null;
  removeStorageRecoveryListener?.();
  removeStorageRecoveryListener = null;
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
