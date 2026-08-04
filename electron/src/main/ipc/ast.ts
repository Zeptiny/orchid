/**
 * AST IPC handlers — ast:status, ast:index, ast:index_state, ast:progress.
 *
 * Full indexes run in a worker thread; progress is broadcast to all windows so
 * late UI subscribers (tab switches / remounts) keep seeing updates.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ASTIndexProgress } from '../../shared/types/ipc-boundary';
import {
  indexProject,
  isIndexing,
  getIndexState,
} from '../ast/indexer';
import { ASTStore } from '../ast/store';
import { withDisposable } from '../utils/with-disposable';
import { resolveBoundProjectPath } from './session';
import { getProjectTrustState } from '../project/trust';
import { astIndexSchema } from './payload-schemas';

function broadcastProgress(projectPath: string, progress: ASTIndexProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    if (resolveBoundProjectPath(String(win.webContents.id)) !== projectPath) continue;
    win.webContents.send(IPC_CHANNELS.AST_PROGRESS, progress);
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerASTIPC(): void {
  // ast:status — return AST store status
  ipcMain.handle(IPC_CHANNELS.AST_STATUS, async (event) => {
    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    if (projectPath == null || getProjectTrustState(projectPath) !== 'trusted') {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        lastIndexed: null,
        lastIndexDuration: null,
      };
    }
    return withDisposable(
      new ASTStore(projectPath),
      (store) => store.status(),
    );
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

    const { force } = parsed.data;

    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    if (!projectPath) {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        symbolsExtracted: 0,
        errors: ['No project folder selected'],
        durationSeconds: 0,
      };
    }

    if (getProjectTrustState(projectPath) !== 'trusted') {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        symbolsExtracted: 0,
        errors: ['Project folder is not trusted'],
        durationSeconds: 0,
      };
    }

    if (isIndexing(projectPath)) {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        symbolsExtracted: 0,
        errors: ['Indexing already in progress'],
        durationSeconds: 0,
      };
    }

    return indexProject({
      force,
      projectPath,
      progressCallback: (progress) => broadcastProgress(projectPath, progress),
    });
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
