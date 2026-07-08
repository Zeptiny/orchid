/**
 * RAG IPC handlers — rag:status, rag:index, rag:clear.
 *
 * Wraps RAG indexer from U16 with zod-validated payloads.
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

// ── Zod validation schemas ───────────────────────────────────────────────────

const ragIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerRAGIPC(): void {
  // rag:status — return RAG store status
  ipcMain.handle(IPC_CHANNELS.RAG_STATUS, async () => {
    return getStatus();
  });

  // rag:index — trigger RAG indexing
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX, async (_event, payload: unknown) => {
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

    return indexProject(undefined, undefined, force);
  });

  // rag:clear — clear the RAG index
  ipcMain.handle(IPC_CHANNELS.RAG_CLEAR, async () => {
    clearIndex();
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
