/**
 * AST IPC handlers — ast:status, ast:index, ast:index_state, ast:progress.
 *
 * Full indexes run in a worker thread; progress is broadcast to all windows so
 * late UI subscribers (tab switches / remounts) keep seeing updates.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import {
  getIndexState,
} from '../ast/indexer';
import { resolveBoundProjectPath } from './session';
import { astIndexSchema } from './payload-schemas';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerASTIPC(): void {
  // ast:status — return AST store status
  ipcMain.handle(IPC_CHANNELS.AST_STATUS, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.AST_STATUS);
  });

  // ast:index_state — in-flight run snapshot for remounting UIs
  ipcMain.handle(IPC_CHANNELS.AST_INDEX_STATE, async (event) => {
    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    return getIndexState(projectPath ?? undefined);
  });

  // ast:index — trigger AST indexing in a worker; stream progress to all windows
  ipcMain.handle(IPC_CHANNELS.AST_INDEX, async (event, payload: unknown) => {
    const parsed = astIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid ast:index payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.AST_INDEX, parsed.data);
  });
}

/**
 * Unregister AST IPC handlers (for cleanup/testing).
 */
export function unregisterASTIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.AST_STATUS);
  ipcMain.removeHandler(IPC_CHANNELS.AST_INDEX);
  ipcMain.removeHandler(IPC_CHANNELS.AST_INDEX_STATE);
}
