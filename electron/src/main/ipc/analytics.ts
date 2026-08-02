import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { z } from 'zod';
import {
  getOverview,
  getSessions,
  getSessionDetail,
  getModels,
  getTools,
  getSubagents,
  getContext,
} from '../providers/accounting/analytics-queries';

const sessionsParamsSchema = z.object({
  limit: z.number().int().positive().max(10000).optional(),
}).optional();

const sessionDetailParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const contextParamsSchema = z.object({
  sessionId: z.string().uuid().optional(),
}).optional();

export function registerAnalyticsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_OVERVIEW, async () => {
    try {
      return getOverview();
    } catch (error) {
      console.error('[analytics] Overview query failed', { error });
      throw new Error(`Analytics overview query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSIONS, async (_event, payload?: unknown) => {
    const parsed = sessionsParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:sessions payload');
    const limit = parsed.data?.limit;
    try {
      return getSessions(limit);
    } catch (error) {
      console.error('[analytics] Sessions query failed', { error });
      throw new Error(`Analytics sessions query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SESSION_DETAIL, async (_event, payload: unknown) => {
    const parsed = sessionDetailParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:session_detail payload');
    try {
      return getSessionDetail(parsed.data.sessionId);
    } catch (error) {
      console.error('[analytics] Session detail query failed', { error });
      throw new Error(`Analytics session detail query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_MODELS, async () => {
    try {
      return getModels();
    } catch (error) {
      console.error('[analytics] Models query failed', { error });
      throw new Error(`Analytics models query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TOOLS, async () => {
    try {
      return getTools();
    } catch (error) {
      console.error('[analytics] Tools query failed', { error });
      throw new Error(`Analytics tools query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SUBAGENTS, async () => {
    try {
      return getSubagents();
    } catch (error) {
      console.error('[analytics] Subagents query failed', { error });
      throw new Error(`Analytics subagents query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_CONTEXT, async (_event, payload?: unknown) => {
    const parsed = contextParamsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid analytics:context payload');
    const sessionId = parsed.data?.sessionId;
    try {
      return getContext(sessionId);
    } catch (error) {
      console.error('[analytics] Context query failed', { error });
      throw new Error(`Analytics context query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function unregisterAnalyticsIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_OVERVIEW);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SESSIONS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SESSION_DETAIL);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_MODELS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_TOOLS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_SUBAGENTS);
  ipcMain.removeHandler(IPC_CHANNELS.ANALYTICS_CONTEXT);
}
