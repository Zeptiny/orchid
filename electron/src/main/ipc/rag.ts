/**
 * RAG IPC handlers — rag:status, rag:index, rag:clear.
 *
 * Wraps RAG indexer from U16 with zod-validated payloads.
 * Uses active workspace cwd (session → sticky), not process.cwd().
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  indexProject,
  getStatus,
  clearIndex,
  isIndexing,
} from '../rag/indexer';
import { getConfig } from '../config/loader';
import { getSessionManager } from './session';
import {
  isWorkspaceBound,
  resolveWorkspace,
} from '../project/workspace';

// ── Zod validation schemas ───────────────────────────────────────────────────

const ragIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});

function resolveRagProjectPath(windowId?: string): string | null {
  try {
    const active = getSessionManager().getActive();
    const info = resolveWorkspace(windowId ?? '', {
      sessionCwd: active?.cwd ?? null,
      stickyDefault: getConfig().default_project_dir,
    });
    if (isWorkspaceBound(info) && info.cwd != null) {
      return info.cwd;
    }
    if (active?.cwd) return active.cwd;
  } catch {
    // ignore
  }
  return null;
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerRAGIPC(): void {
  // rag:status — return RAG store status
  ipcMain.handle(IPC_CHANNELS.RAG_STATUS, async (event) => {
    const projectPath = resolveRagProjectPath(String(event.sender.id));
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

  // rag:index — trigger RAG indexing
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX, async (event, payload: unknown) => {
    // Validate input with zod (payload is optional)
    const parsed = ragIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid rag:index payload: ${parsed.error.message}`);
    }

    const { force } = parsed.data;

    if (isIndexing()) {
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

    const projectPath = resolveRagProjectPath(String(event.sender.id));
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

    return indexProject(projectPath, undefined, force);
  });

  // rag:clear — clear the RAG index
  ipcMain.handle(IPC_CHANNELS.RAG_CLEAR, async (event) => {
    const projectPath = resolveRagProjectPath(String(event.sender.id));
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
}
