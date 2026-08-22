/**
 * Debug IPC — per-session raw provider request/response captures (issue 146).
 *
 * Read-only queries over the capture store. Captures exist only while the
 * `debug_capture_requests` config gate is enabled; the handlers themselves
 * are always registered so the renderer can show an empty state.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  DEBUG_CAPTURE_LIST_DEFAULT_LIMIT,
  DEBUG_CAPTURE_LIST_MAX_LIMIT,
  getProviderAttemptCaptureStore,
} from '../providers/accounting/capture-store';

const sessionRequestsParamsSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().positive().max(DEBUG_CAPTURE_LIST_MAX_LIMIT).optional(),
}).strict();

const requestCaptureParamsSchema = z.object({
  attemptId: z.string().min(1),
}).strict();

export function registerDebugIPC(): void {
  ipcMain.handle(IPC_CHANNELS.DEBUG_SESSION_REQUESTS, async (_event, payload: unknown) => {
    const parsed = sessionRequestsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid debug:session_requests payload');
    try {
      const store = getProviderAttemptCaptureStore();
      if (!store) return { requests: [], total: 0 };
      return store.listForSession(parsed.data.sessionId, parsed.data.limit ?? DEBUG_CAPTURE_LIST_DEFAULT_LIMIT);
    } catch (error) {
      console.error('[debug] Session requests query failed', { error });
      throw new Error(`Debug session requests query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEBUG_REQUEST_CAPTURE, async (_event, payload: unknown) => {
    const parsed = requestCaptureParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid debug:request_capture payload');
    try {
      const store = getProviderAttemptCaptureStore();
      return { capture: store ? store.getCapture(parsed.data.attemptId) : null };
    } catch (error) {
      console.error('[debug] Request capture query failed', { error });
      throw new Error(`Debug request capture query failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
}

export function unregisterDebugIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.DEBUG_SESSION_REQUESTS);
  ipcMain.removeHandler(IPC_CHANNELS.DEBUG_REQUEST_CAPTURE);
}
