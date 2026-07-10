/**
 * AST IPC handlers — ast:status, ast:index, ast:index_state, ast:progress.
 *
 * Full indexes run in a worker thread; progress is broadcast to all windows so
 * late UI subscribers (tab switches / remounts) keep seeing updates.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { ASTIndexProgress } from '../../shared/types/ipc-boundary';
import {
  indexProject,
  isIndexing,
  getIndexState,
} from '../ast/indexer';
import { ASTStore } from '../ast/store';
import { resolveWindowWorkspace } from './session';
import { isWorkspaceBound } from '../project/workspace';

// ── Zod validation schemas ───────────────────────────────────────────────────

const astIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});

/**
 * Resolve project path for AST IPC from active workspace
 * (draft → session → sticky via resolveWindowWorkspace).
 * Only returns a path when isWorkspaceBound — no raw session.cwd fallback.
 */
function resolveAstProjectPath(windowId?: string): string | null {
  try {
    const info = resolveWindowWorkspace(windowId ?? '');
    if (isWorkspaceBound(info) && info.cwd != null) {
      return info.cwd;
    }
  } catch {
    // ignore
  }
  return null;
}

function broadcastProgress(progress: ASTIndexProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.AST_PROGRESS, progress);
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerASTIPC(): void {
  // ast:status — return AST store status
  ipcMain.handle(IPC_CHANNELS.AST_STATUS, async (event) => {
    const projectPath = resolveAstProjectPath(String(event.sender.id));
    if (!projectPath) {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        lastIndexed: null,
        lastIndexDuration: null,
      };
    }
    const store = new ASTStore(projectPath);
    return store.status();
  });

  // ast:index_state — in-flight run snapshot for remounting UIs
  ipcMain.handle(IPC_CHANNELS.AST_INDEX_STATE, async () => getIndexState());

  // ast:index — trigger AST indexing in a worker; stream progress to all windows
  ipcMain.handle(IPC_CHANNELS.AST_INDEX, async (event, payload: unknown) => {
    const parsed = astIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid ast:index payload: ${parsed.error.message}`);
    }

    const { force } = parsed.data;

    if (isIndexing()) {
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

    const projectPath = resolveAstProjectPath(String(event.sender.id));
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

    return indexProject({
      force,
      projectPath,
      progressCallback: broadcastProgress,
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
