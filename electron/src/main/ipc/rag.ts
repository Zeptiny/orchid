/**
 * RAG IPC handlers — rag:status, rag:index, rag:clear, rag:index_state, rag:progress.
 *
 * Full indexes run in a worker thread; progress is broadcast to all windows so
 * late UI subscribers (tab switches / remounts) keep seeing updates. Every
 * read is host-routed (#14): the binding resolves the caller client's bound
 * project host-side, so remote-active windows see the remote machine's index
 * state instead of the local store.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import { ragIndexSchema } from './payload-schemas';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerRAGIPC(): void {
  // rag:status — return RAG store status
  ipcMain.handle(IPC_CHANNELS.RAG_STATUS, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.RAG_STATUS);
  });

  // rag:index_state — in-flight run snapshot for remounting UIs
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_STATE, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.RAG_INDEX_STATE);
  });

  // rag:index — trigger RAG indexing in a worker; stream progress to all windows
  ipcMain.handle(IPC_CHANNELS.RAG_INDEX, async (event, payload: unknown) => {
    const parsed = ragIndexSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid rag:index payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.RAG_INDEX, parsed.data);
  });

  // rag:clear — clear the RAG index
  ipcMain.handle(IPC_CHANNELS.RAG_CLEAR, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.RAG_CLEAR);
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
