/**
 * Wire production subagent runtime: stream runner + session persistence + UI notify.
 *
 * Call once after tools are registered and the Electron app is ready.
 */
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SubagentDeltaEvent } from '../../shared/types/subagent';
import { getConfig } from '../config/loader';
import { getSubagentManager } from '../tools';
import { clearSessionSubagentHydration } from '../tools/subagent/hydrate';
import { createSubagentStreamRunner } from './subagent-runner';
import {
  createSubagentPersistenceScheduler,
  persistSubagentChains,
  type SubagentPersistenceFlushInfo,
} from './persist-subagent-chains';
import {
  recoverSubagentPersistence as recoverSubagentPersistenceForManager,
  setSubagentPersistenceRecoveryScheduler,
} from './subagent-persistence-recovery';
import {
  flushSubagentDeltas,
  isEligibleSubagentRecipient,
  queueSubagentDelta,
  type SubagentDeliveryWindow,
} from './subagent-events';
import { isTerminalSubagentState } from './manager';
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
  scheduleTerminalWave: (sessionId: string) => void;
  clearToolCallHistory: (sessionId: string, agentScopeId: string) => void;
  queueDelta: (event: SubagentDeltaEvent) => void;
  flushDeltas: () => void;
}

/**
 * Route the manager's delta stream: every delta dirties its session for the
 * next persistence checkpoint and rides the batcher; a terminal delta
 * additionally drops the run's permission history, flushes delivery
 * immediately, and schedules a short terminal wave so near-simultaneous
 * completions batch into one persistence flush (R8).
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
      deps.scheduleTerminalWave(event.sessionId);
    }
  };
}

/**
 * Persistence write callback: the terminal delta already carries the
 * authoritative durable record, so ordinary checkpoints and terminal waves
 * never broadcast; only recovery flushes invalidate renderer snapshots (R8).
 */
export function createSubagentPersistenceWriteCallback(
  persist: (sessionId: string, info: SubagentPersistenceFlushInfo) => void,
  broadcast: (sessionId: string) => void,
): (sessionId: string, info: SubagentPersistenceFlushInfo) => void {
  return (sessionId, info) => {
    persist(sessionId, info);
    if (info.recovery) broadcast(sessionId);
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
  persistenceScheduler = createSubagentPersistenceScheduler(
    createSubagentPersistenceWriteCallback(
      (sessionId, info) =>
        persistSubagentChains(manager, sessionId, { recovery: info.recovery }),
      (sessionId) => subagentsChangedBroadcast(sessionId),
    ),
  );
  setSubagentPersistenceRecoveryScheduler(persistenceScheduler);
  removeSessionDeletionCleanup = onSessionDeleted((sessionId) => {
    manager.discardSession(sessionId);
    clearSessionSubagentHydration(manager, sessionId);
    persistenceScheduler?.clear(sessionId);
  });
  removeStorageRecoveryListener = onSessionStorageRecovered(() => {
    persistenceScheduler?.recoverAll(manager.trackedPersistenceSessions());
  });

  manager.setOnDelta(createSubagentDeltaHandler({
    markDirty: (sessionId) => persistenceScheduler?.markDirty(sessionId),
    scheduleTerminalWave: (sessionId) =>
      persistenceScheduler?.scheduleWave(sessionId, getConfig().subagents.terminal_wave_ms),
    clearToolCallHistory: clearToolCallHistoryForAgentScope,
    queueDelta: queueSubagentDelta,
    flushDeltas: flushSubagentDeltas,
  }));

  manager.setOnChange((records) => {
    for (const sessionId of new Set(records
      .filter((record) => !isTerminalSubagentState(record.state))
      .map((record) => record.sessionId).filter(Boolean) as string[])) {
      persistenceScheduler?.markDirty(sessionId);
    }
  });
}

/** Explicit orderly-shutdown hook; terminal writes are synchronous by design. */
export function flushSubagentPersistence(): void {
  flushSubagentDeltas();
  const manager = getSubagentManager();
  if (persistenceScheduler) persistenceScheduler.flushAll();
  else persistSubagentChains(manager);
}

/** Explicit recovery for a user retry or an external storage recovery signal. */
export function recoverSubagentPersistence(sessionId?: string): void {
  recoverSubagentPersistenceForManager(getSubagentManager(), sessionId);
}

/** Release retry timers and lifecycle hooks after the final shutdown flush. */
export function disposeSubagentPersistence(): void {
  persistenceScheduler?.dispose();
  persistenceScheduler = null;
  setSubagentPersistenceRecoveryScheduler(null);
  removeSessionDeletionCleanup?.();
  removeSessionDeletionCleanup = null;
  removeStorageRecoveryListener?.();
  removeStorageRecoveryListener = null;
}

export function broadcastSubagentsChanged(
  sessionId: string,
  windows: readonly SubagentDeliveryWindow[] = [],
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

/**
 * Injected SESSION_SUBAGENTS_CHANGED broadcast used by persistence recovery
 * flushes. Default no-op; the Electron shell installs the window broadcast.
 */
export type SubagentsChangedBroadcast = (sessionId: string) => void;

let subagentsChangedBroadcast: SubagentsChangedBroadcast = () => {};

/** Install the subagents-changed broadcast (window broadcast under Electron). */
export function setSubagentsChangedBroadcast(broadcast: SubagentsChangedBroadcast | null): void {
  subagentsChangedBroadcast = broadcast ?? (() => {});
}
