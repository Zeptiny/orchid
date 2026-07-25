/**
 * RAG IPC handlers — rag:status, rag:index, rag:clear, rag:index_state, rag:progress.
 *
 * Full indexes run in a worker thread; progress is broadcast to all windows so
 * late UI subscribers (tab switches / remounts) keep seeing updates.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { RAGIndexProgress } from '../../shared/types/ipc-boundary';
import {
  indexProject,
  getStatus,
  clearIndex,
  isIndexing,
  getIndexState,
} from '../rag/indexer';
import { resolveBoundProjectPath } from './session';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { ragIndexSchema } from './payload-schemas';

function broadcastProgress(projectPath: string, progress: RAGIndexProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    if (resolveBoundProjectPath(String(win.webContents.id)) !== projectPath) continue;
    win.webContents.send(IPC_CHANNELS.RAG_PROGRESS, progress);
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerRAGIPC(): void {
  // rag:status — return RAG store status
  ipcMain.handle(IPC_CHANNELS.RAG_STATUS, async (event) => {
    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    if (!projectPath) {
      return {
        totalChunks: 0,
        totalFiles: 0,
        lastIndexed: null,
        lastIndexDuration: null,
      };
    }
    return getStatus(projectPath);
  });

  // rag:index_state — in-flight run snapshot for remounting UIs
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_STATE, async (event) => {
    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    return getIndexState(projectPath ?? undefined);
  });

  // rag:index — trigger RAG indexing in a worker; stream progress to all windows
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX, async (event, payload: unknown) => {
    const parsed = ragIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid rag:index payload: ${parsed.error.message}`);
    }

    const { force } = parsed.data;

    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    if (!projectPath) {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        chunksCreated: 0,
        errors: ['No project folder selected'],
        durationSeconds: 0,
      };
    }

    if (isIndexing(projectPath)) {
      return {
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesDeleted: 0,
        chunksCreated: 0,
        errors: ['Indexing already in progress'],
        durationSeconds: 0,
      };
    }

    return indexProject(
      projectPath,
      undefined,
      force,
      undefined,
      (progress) => broadcastProgress(projectPath, progress),
      {
        config: getProjectRuntimeRegistry().get(projectPath).config,
      },
    );
  });

  // rag:clear — clear the RAG index
  ipcMain.handle(IPC_CHANNELS.RAG_CLEAR, async (event) => {
    const projectPath = resolveBoundProjectPath(String(event.sender.id));
    if (projectPath) {
      clearIndex(projectPath);
    }
    return { status: 'cleared' };
  });
}

/**
 * Unregister RAG IPC handlers (for cleanup/testing).
 */
export function unregisterRAGIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.RAG_STATUS);
  ipcMain.removeHandler(IPC_CHANNELS.RAG_INDEX);
  ipcMain.removeHandler(IPC_CHANNELS.RAG_CLEAR);
  ipcMain.removeHandler(IPC_CHANNELS.RAG_INDEX_STATE);
}
