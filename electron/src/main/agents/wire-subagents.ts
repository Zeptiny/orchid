/**
 * Wire production subagent runtime: stream runner + session persistence + UI notify.
 *
 * Call once after tools are registered and the Electron app is ready.
 */
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getSubagentManager } from '../tools';
import { createSubagentStreamRunner } from './subagent-runner';
import { persistSubagentChains } from './persist-subagent-chains';

let wired = false;

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

  // Throttle disk writes / IPC spam while tokens stream in
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingNotify = false;

  const flush = () => {
    persistTimer = null;
    try {
      persistSubagentChains(manager);
    } catch (err) {
      console.debug('Failed to persist subagent chains (non-fatal):', err);
    }
    if (pendingNotify) {
      pendingNotify = false;
      broadcastSubagentsChanged();
    }
  };

  manager.setOnChange(() => {
    pendingNotify = true;
    // Immediate persist on terminal-ish cadence: short debounce for mid-run
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flush, 250);
  });
}

function broadcastSubagentsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED);
      }
    } catch {
      // window gone
    }
  }
}
