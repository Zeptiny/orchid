/**
 * Index auto-refresh broadcast — wires the refresh coordinator's lifecycle
 * sink to the `index:auto_refresh` push event.
 *
 * The coordinator (indexing layer) owns flush lifecycle knowledge; this module
 * (IPC layer) owns window routing: only windows bound to the flushed project
 * receive the event, mirroring the rag/ast progress broadcasts. `started` and
 * `settled` are forwarded as-is (live busy state); `landed` is expanded into a
 * fresh post-flush status snapshot per refreshed index so renderer consumers
 * can replace their cached statuses outright.
 */
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { IndexAutoRefreshEvent } from '../../shared/types/ipc-boundary';
import { setIndexAutoRefreshNotifier } from '../indexing/refresh-coordinator';
import { getStatus } from '../rag/indexer';
import { ASTStore } from '../ast/store';
import { withDisposable } from '../utils/with-disposable';
import { getWorkspaceWatcherState } from '../indexing/watcher';
import { resolveBoundProjectPath } from './session';

export function registerIndexAutoRefreshBroadcast(): void {
  setIndexAutoRefreshNotifier((projectPath, event) => {
    let payload: IndexAutoRefreshEvent;
    if (event.phase === 'landed') {
      payload = { phase: 'landed' };
      if (event.rag) {
        const status = getStatus(projectPath);
        // Watcher introspection is additive and must never fail the broadcast.
        try {
          payload.rag = {
            ...status,
            watcher: { watching: getWorkspaceWatcherState(projectPath).watching },
          };
        } catch {
          payload.rag = status;
        }
      }
      if (event.ast) {
        payload.ast = withDisposable(
          new ASTStore(projectPath),
          (store) => store.status(),
        );
      }
    } else {
      payload = event;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (resolveBoundProjectPath(String(win.webContents.id)) !== projectPath) continue;
      win.webContents.send(IPC_CHANNELS.INDEX_AUTO_REFRESH, payload);
    }
  });
}

export function unregisterIndexAutoRefreshBroadcast(): void {
  setIndexAutoRefreshNotifier(null);
}
